#!/usr/bin/env node

/**
 * pi-adapter MCP server
 *
 * Pi executor adapter for Trellis Phase 2.1 and standalone use.
 *
 * Postures:
 * - With Trellis: reads task artifacts, assembles Pi prompts. Never modifies
 *   workflow, hooks, task.py, or artifacts.
 * - With `trellis channel`: emits message events into the channel so the
 *   audit trail belongs to Trellis core (worker_guard and event log are
 *   Trellis's, not ours).
 * - Standalone: the main Agent invokes this MCP directly; runtime files
 *   live under `/tmp/pi-adapter/`.
 *
 * Forward compatibility:
 * - `@mindfoldhq/trellis-core/channel` is loaded via dynamic import in a
 *   try/catch so an absent or breaking-changed package degrades the MCP
 *   to CLI fallback (or event-drop), never module-load failure.
 * - The CLI fallback uses async spawn (fire-and-forget) so a missing
 *   `trellis` binary or a renamed subcommand also degrades gracefully.
 * - Channel names are detected from a list of env var aliases so a future
 *   Trellis rename keeps working.
 *
 * Protocol: MCP over stdio.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import TOML from '@iarna/toml';
import { spawn, execSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// ---- Constants ----

const SERVER_NAME = 'pi-adapter';
const SERVER_VERSION = '0.8.1';  // keep in sync with package.json
const TMP_RUNTIME_DIR = path.join(os.tmpdir(), SERVER_NAME);
const CHANNEL_ENV_ALIASES = ['TRELLIS_CHANNEL', 'TRELLIS_CHANNEL_NAME'];
const TRELLIS_BIN_ENV = 'TRELLIS_BINARY';
const PI_BIN_ENV = 'PI_BINARY';
const DEFAULT_WRITE_TOOLS = 'read,bash,edit,write,grep,find,ls';
const DEFAULT_READ_TOOLS = 'read,grep,find,ls';
const DEFAULT_PATCH_TOOLS = 'read,bash,grep,find,ls';

// ---- Small utilities ----

function readFile(filePath) {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
  } catch {}
  return null;
}

function resolvePath(p, cwd) {
  if (path.isAbsolute(p)) return p;
  return path.resolve(cwd || process.cwd(), p);
}

function logErr(msg) {
  process.stderr.write(`[${SERVER_NAME}] ${msg}\n`);
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label || 'operation'} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function resolveRuntimeDir(workDir) {
  if (fs.existsSync(path.join(workDir, '.trellis'))) {
    return path.join(workDir, '.trellis', '.runtime');
  }
  return TMP_RUNTIME_DIR;
}

function detectProjectMode(workDir, channelName, executionMode) {
  if (fs.existsSync(path.join(workDir, '.trellis'))) {
    return channelName ? 'trellis_channel_bridge' : 'trellis_local_worktree';
  }
  return executionMode === 'worktree' ? 'standalone_worktree' : 'standalone';
}

function isGitRepo(workDir) {
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workDir,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// ---- Binary discovery (cached) ----

let _piBin = undefined;
function findPiBinary() {
  if (_piBin !== undefined) return _piBin;
  const fromEnv = process.env[PI_BIN_ENV];
  if (fromEnv && fs.existsSync(fromEnv)) { _piBin = fromEnv; return _piBin; }
  try { _piBin = execSync('which pi', { encoding: 'utf-8' }).trim() || null; }
  catch { _piBin = null; }
  return _piBin;
}

let _trellisBin = undefined;
function findTrellisBinary() {
  if (_trellisBin !== undefined) return _trellisBin;
  const fromEnv = process.env[TRELLIS_BIN_ENV];
  if (fromEnv && fs.existsSync(fromEnv)) { _trellisBin = fromEnv; return _trellisBin; }
  try { _trellisBin = execSync('which trellis', { encoding: 'utf-8' }).trim() || null; }
  catch { _trellisBin = null; }
  return _trellisBin;
}

// ---- trellis-core lazy loader (forward-compatible) ----

// undefined = unloaded, null = unavailable, fn = loaded
let _trellisCoreCache = undefined;
async function getTrellisCoreSendMessage() {
  if (_trellisCoreCache !== undefined) return _trellisCoreCache;
  try {
    const mod = await import('@mindfoldhq/trellis-core/channel');
    if (typeof mod.sendMessage === 'function') {
      _trellisCoreCache = mod.sendMessage;
    } else {
      logErr('trellis-core/channel loaded but sendMessage missing — using CLI fallback');
      _trellisCoreCache = null;
    }
  } catch (e) {
    logErr(`trellis-core/channel unavailable (${e.message}) — using CLI fallback`);
    _trellisCoreCache = null;
  }
  return _trellisCoreCache;
}

// ---- Channel detection + emission ----

function detectChannel(args, env) {
  if (args && args.channel) return args.channel;
  for (const key of CHANNEL_ENV_ALIASES) {
    if (env[key]) return env[key];
  }
  return null;
}

// Emit a message event into the channel. Three-tier strategy:
//   1. Try trellis-core sendMessage (in-process, structured)
//   2. Fall back to `trellis channel send` (async spawn, fire-and-forget)
//   3. Drop with stderr note
// Channel emission is best-effort observability; it must never block dispatch.
async function emitChannelEvent(channelName, eventName, payload, workDir) {
  if (!channelName) return { ok: true, reason: 'no-channel' };

  const meta = { schema: 'pi-adapter.dispatch.v1', ...payload };

  const sendMessage = await getTrellisCoreSendMessage();
  if (sendMessage) {
    try {
      await withTimeout(sendMessage({
        channel: channelName,
        cwd: workDir,
        by: SERVER_NAME,
        text: `${SERVER_NAME}: ${eventName}`,
        tag: `pi:${eventName}`,
        meta,
      }), 2000, 'trellis-core sendMessage');
      return { ok: true, via: 'trellis-core' };
    } catch (e) {
      logErr(`trellis-core sendMessage failed (${e.message}) — falling back to CLI`);
    }
  }

  const trellis = findTrellisBinary();
  if (!trellis) {
    logErr(`channel event "${eventName}" dropped: trellis CLI not found`);
    return { ok: false, reason: 'no-fallback' };
  }
  try {
    const child = spawn(trellis, [
      'channel', 'send', channelName,
      '--as', SERVER_NAME,
      '--stdin',
    ], { cwd: workDir, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    child.on('error', (e) => logErr(`trellis CLI fallback spawn failed: ${e.message}`));
    child.stdin.on('error', (e) => logErr(`trellis CLI fallback stdin failed: ${e.message}`));
    try {
      child.stdin.end(`${SERVER_NAME}: ${eventName}\n\n${JSON.stringify(meta, null, 2)}\n`);
    } catch (e) {
      logErr(`trellis CLI fallback stdin write failed: ${e.message}`);
    }
    child.unref();
    return { ok: true, via: 'cli' };
  } catch (e) {
    logErr(`channel event "${eventName}" CLI fallback errored: ${e.message}`);
    return { ok: false, reason: 'cli-exception', error: e.message };
  }
}

// ---- Subprocess hardening ----

function buildPiEnv(parentEnv) {
  const SENSITIVE = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE.?KEY|API.?KEY|_KEY$|_AUTH$|_BEARER$|_COOKIE$|^ANTHROPIC_|^OPENAI_|^CLAUDE_|^CCG_|^AWS_(ACCESS|SECRET)|^GH_TOKEN$|^GITHUB_TOKEN$|^OP_|^DOCKER_PASS/i;
  const PI_KEEP = /^(PI_|NEWAPI_)/;
  const out = {};
  const stripped = [];
  for (const [k, v] of Object.entries(parentEnv)) {
    if (PI_KEEP.test(k)) { out[k] = v; continue; }
    if (SENSITIVE.test(k)) { stripped.push(k); continue; }
    out[k] = v;
  }
  return { env: out, stripped };
}

// ---- Dispatch lock (always acquired; Trellis channel does not own Pi worker lifecycle) ----

const _activeLocks = new Set();
const _activeChildren = new Set();

function dispatchLockPath(runtimeDir, taskDir, scope, extraInstructions) {
  const fp = crypto
    .createHash('sha256')
    .update(`${taskDir || ''}|${scope || ''}|${extraInstructions || ''}`)
    .digest('hex')
    .slice(0, 12);
  return path.join(runtimeDir, `${SERVER_NAME}.${fp}.lock`);
}

function acquireDispatchLock(lockPath) {
  // Stale-lock detection: if a lock file exists, check if the holder is alive.
  if (fs.existsSync(lockPath)) {
    try {
      const content = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      const pid = content.pid;
      if (pid) {
        try { process.kill(pid, 0); return { acquired: false, holder: content }; }
        catch { /* stale — holder dead, fall through to overwrite */ }
      }
    } catch { /* malformed lock file, fall through */ }
  }
  // Atomic exclusive create to prevent TOCTOU races between the check above
  // and the write. O_CREAT|O_EXCL (flag 'wx') fails if another process
  // created the file in the window.
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
  } catch (e) {
    if (e.code === 'EEXIST') {
      // Race lost — re-read to report who holds it
      try {
        const content = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
        return { acquired: false, holder: content };
      } catch { /* give up, report generic */ }
      return { acquired: false, holder: { pid: null, startedAt: null } };
    }
    throw e;
  }
  _activeLocks.add(lockPath);
  return { acquired: true };
}

function releaseDispatchLock(lockPath) {
  _activeLocks.delete(lockPath);
  try { fs.unlinkSync(lockPath); } catch {}
}

function cleanupAllLocks() {
  for (const p of _activeLocks) {
    try { fs.unlinkSync(p); } catch {}
  }
  _activeLocks.clear();
}

function trackChild(proc) {
  _activeChildren.add(proc);
  const done = () => _activeChildren.delete(proc);
  proc.once('close', done);
  proc.once('error', done);
  return proc;
}

function shutdownWithChildren(exitCode) {
  for (const child of _activeChildren) {
    try { child.kill('SIGTERM'); } catch {}
  }
  if (_activeChildren.size === 0) {
    cleanupAllLocks();
    process.exit(exitCode);
  }
  setTimeout(() => {
    for (const child of _activeChildren) {
      try { child.kill('SIGKILL'); } catch {}
    }
    cleanupAllLocks();
    process.exit(exitCode);
  }, 5000);
}

process.on('exit', cleanupAllLocks);
process.on('SIGINT',  () => shutdownWithChildren(130));
process.on('SIGTERM', () => shutdownWithChildren(143));

// ---- Model resolution (TOML, no hard-codes) ----

let _modelMapCache = null;
function loadModelMap() {
  if (_modelMapCache !== null) return _modelMapCache;
  const cfgPath = path.join(os.homedir(), '.pi', 'config.toml');
  const raw = readFile(cfgPath);
  let map = {};
  if (raw) {
    try {
      const parsed = TOML.parse(raw);
      // Preferred section name + legacy alias (skill was previously named
      // trellis-pi-adapter). New keys win when both exist.
      const sections = [parsed.pi_adapter, parsed.trellis_pi_adapter];
      let legacyUsed = false;
      for (const section of sections) {
        if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
        for (const [k, v] of Object.entries(section)) {
          if (typeof v !== 'string') continue;
          if (!(k in map)) {
            map[k] = v;
            if (section === parsed.trellis_pi_adapter) legacyUsed = true;
          }
        }
      }
      if (legacyUsed) {
        logErr('reading legacy [trellis_pi_adapter] TOML section — rename to [pi_adapter] when convenient.');
      }
    } catch (e) {
      logErr(`TOML parse error in ${cfgPath}: ${e.message}`);
    }
  }
  _modelMapCache = map;
  return map;
}

class ModelResolutionError extends Error {
  constructor(logicalKey) {
    super(`Cannot resolve model "${logicalKey}". Configure ~/.pi/config.toml:\n\n  [pi_adapter]\n  implementer = "<your-pi-routable-model>"   # required for mode=implement|custom\n  reviewer    = "<your-pi-routable-model>"   # required for mode=check / cross-model review\n\nOr pass a fully qualified route directly, e.g. model="anthropic/claude-opus-4-7".`);
    this.code = 'MODEL_NOT_RESOLVED';
    this.logicalKey = logicalKey;
  }
}

function resolveModel(input, mode) {
  const defaultKey = mode === 'check' ? 'reviewer' : 'implementer';
  const logicalKey = input || defaultKey;
  const map = loadModelMap();
  if (map[logicalKey]) return { resolved: map[logicalKey], from: 'config', key: logicalKey };
  // Fully qualified route (contains '/') — pass through.
  if (logicalKey.includes('/')) return { resolved: logicalKey, from: 'direct', key: null };
  // Unresolved: throw. No silent fallback — that would leak whichever
  // model name was vendored into the source onto users of the package.
  throw new ModelResolutionError(logicalKey);
}

// ---- Trellis context assembly ----

function readJsonlManifest(repoRoot, jsonlPath) {
  const result = { entries: [], files: [], missing: [] };
  const full = path.join(repoRoot, jsonlPath);
  if (!fs.existsSync(full)) return result;

  const lines = readFile(full).split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      const filePath = item.file || item.path;
      if (!filePath) continue;
      result.entries.push(item);

      const resolved = path.join(repoRoot, filePath);
      if (fs.existsSync(resolved)) {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          const mds = fs.readdirSync(resolved)
            .filter(f => f.endsWith('.md') && fs.statSync(path.join(resolved, f)).isFile())
            .sort();
          for (const md of mds) {
            const content = readFile(path.join(resolved, md));
            if (content) result.files.push({ path: path.join(filePath, md), content });
          }
        } else {
          const content = readFile(resolved);
          if (content) result.files.push({ path: filePath, content });
        }
      } else {
        result.missing.push(filePath);
      }
    } catch {}
  }
  return result;
}

function resolveActiveTask(repoRoot, trellisContextId) {
  if (!fs.existsSync(path.join(repoRoot, '.trellis'))) return null;
  try {
    const env = trellisContextId
      ? { ...process.env, TRELLIS_CONTEXT_ID: trellisContextId }
      : process.env;
    const result = execSync(
      `python3 ./.trellis/scripts/task.py current --source`,
      { encoding: 'utf-8', cwd: repoRoot, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], env },
    ).trim();
    const match = result.match(/^(\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function assembleTrellisContext(repoRoot, taskDir, mode) {
  const manifestFile = mode === 'check' ? 'check.jsonl' : 'implement.jsonl';
  const manifest = readJsonlManifest(repoRoot, path.join(taskDir, manifestFile));
  const artifacts = {};
  for (const name of ['prd.md', 'design.md', 'implement.md']) {
    const content = readFile(path.join(repoRoot, taskDir, name));
    if (content) artifacts[name] = content;
  }
  return { taskDir, artifacts, manifest, manifestFile };
}

// ---- Prompt builders ----

function fencedContent(label, content) {
  return `### ${label}\n\n~~~text\n${String(content || '')}\n~~~\n\n`;
}

function readContextFiles(repoRoot, contextFiles) {
  const files = [];
  if (!Array.isArray(contextFiles)) return files;
  for (const filePath of contextFiles) {
    if (typeof filePath !== 'string' || !filePath.trim()) continue;
    const rel = filePath.trim();
    const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    const content = readFile(abs);
    if (content !== null) files.push({ path: rel, content });
  }
  return files;
}

function appendContextFilesPrompt(prompt, contextFiles) {
  if (!Array.isArray(contextFiles) || contextFiles.length === 0) return prompt;
  let p = prompt;
  p += `\n## Additional Context Files\n\n`;
  for (const f of contextFiles) p += fencedContent(f.path, f.content);
  return p;
}

function buildDispatchPrompt(args) {
  const { taskDir, artifacts, manifest, manifestFile, mode } = args;
  const executionMode = args.execution_mode || defaultExecutionMode(mode);
  const extraInstructions = args.extra_instructions || '';
  const scopeConstraint = args.scope || '';
  const validationCommands = args.validation_commands || [];
  const modeLabel = mode === 'check' ? 'Quality Check' : mode === 'implement' ? 'Implementation' : 'Custom';

  let p = `# Pi Dispatch: ${modeLabel}\n\nActive task: \`${taskDir}\`\n\n`;

  if (mode === 'implement') {
    p += `You are the implementation executor for this Trellis task. The orchestrator (Claude Code / Codex / main Agent) will review your output.\n\n**Guards**:\n- Do NOT spawn other agents.\n- Do NOT modify task scope or mark the Trellis task complete.\n- Do NOT git commit.\n\n`;
  } else if (mode === 'check') {
    p += `You are the quality check executor for this Trellis task. Review all code changes against specs and task artifacts. Fix issues directly.\n\n**Guards**:\n- Do NOT spawn other agents.\n- Do NOT modify task scope or mark the Trellis task complete.\n- Do NOT git commit.\n\n`;
  }

  p += `## Read in this order before writing any code\n\n`;

  let idx = 1;
  if (manifest.files.length > 0) {
    p += `### Context from ${manifestFile}\n\n`;
    for (const f of manifest.files) { p += `${idx}. \`${f.path}\`\n`; idx++; }
    p += '\n';
  }
  if (artifacts['prd.md'])       p += `${idx++}. \`${taskDir}/prd.md\` — source of truth for scope and acceptance criteria.\n`;
  if (artifacts['design.md'])    p += `${idx++}. \`${taskDir}/design.md\` — technical design.\n`;
  if (artifacts['implement.md']) p += `${idx++}. \`${taskDir}/implement.md\` — execution plan.\n`;

  if (manifest.files.length > 0 || Object.keys(artifacts).length > 0) {
    p += `\n## Embedded Trellis Context\n\n`;
    p += `These are embedded so isolated Pi workers can run from a clean worktree without depending on uncommitted task files.\n\n`;
    for (const f of manifest.files) p += fencedContent(f.path, f.content);
    for (const [name, content] of Object.entries(artifacts)) p += fencedContent(`${taskDir}/${name}`, content);
  }

  p = appendContextFilesPrompt(p, args.context_files);
  if (scopeConstraint)        p += `\n## Scope Constraint\n\n${scopeConstraint}\n\n`;
  if (extraInstructions)      p += `\n## Additional Instructions\n\n${extraInstructions}\n\n`;
  if (executionMode === 'worktree') {
    p += `\n## Execution Environment\n\nYou are running inside an isolated git worktree. Modify files there normally. The orchestrator will export your changes as a patch, review it, and decide whether to apply it to the main repository. Do not commit.\n\n`;
  } else if (executionMode === 'patch') {
    p += `\n## Execution Environment\n\nDo not edit files directly. Produce a unified diff in your final answer that the orchestrator can review and apply.\n\n`;
  } else if (executionMode === 'review') {
    p += `\n## Execution Environment\n\nRead-only review mode. Do not modify files. Report findings and recommended fixes only.\n\n`;
  }
  if (validationCommands.length > 0) {
    p += `\n## Verification Commands\n\nRun these before reporting done:\n\n`;
    for (const cmd of validationCommands) p += `\`\`\`bash\n${cmd}\n\`\`\`\n\n`;
  }
  p += `## Reporting\n\nWhen done, print:\n\n1. List of files created / modified (path only).\n2. Test/lint output (summary line per package).\n3. Any TODO comments left, with file:line.\n4. Any decisions made that weren't covered in spec or PRD.\n`;
  return p;
}

function buildNoTrellisPrompt(mode, extraInstructions, scope, validationCommands, executionMode = defaultExecutionMode(mode), contextFiles = []) {
  const modeLabel = mode === 'check' ? 'Quality Check' : mode === 'custom' ? 'Custom' : 'Implementation';
  let p = `# Pi Dispatch: ${modeLabel} (no Trellis)\n\n`;
  if (mode === 'implement') {
    p += `You are the implementation executor. The main Agent will review your output.\n\n**Guards**:\n- Do NOT git commit.\n- Do NOT spawn other agents.\n\n`;
  } else if (mode === 'check') {
    p += `You are the quality check executor. Review all code changes. Fix issues directly.\n\n**Guards**:\n- Do NOT git commit.\n- Do NOT spawn other agents.\n\n`;
  } else if (mode === 'custom') {
    p += `You are a Pi worker. The orchestrator will review your output.\n\n**Guards**:\n- Do NOT git commit.\n- Do NOT spawn other agents.\n\n`;
  }
  p += `## Task\n\n${extraInstructions}\n\n`;
  p = appendContextFilesPrompt(p, contextFiles);
  if (scope) p += `## Scope Constraint\n\n${scope}\n\n`;
  if (executionMode === 'worktree') {
    p += `## Execution Environment\n\nYou are running inside an isolated git worktree. Modify files there normally. The orchestrator will export your changes as a patch, review it, and decide whether to apply it to the main repository. Do not commit.\n\n`;
  } else if (executionMode === 'patch') {
    p += `## Execution Environment\n\nDo not edit files directly. Produce a unified diff in your final answer that the orchestrator can review and apply.\n\n`;
  } else if (executionMode === 'review') {
    p += `## Execution Environment\n\nRead-only review mode. Do not modify files. Report findings and recommended fixes only.\n\n`;
  }
  if (validationCommands && validationCommands.length > 0) {
    p += `## Verification Commands\n\n`;
    for (const cmd of validationCommands) p += `\`\`\`bash\n${cmd}\n\`\`\`\n\n`;
  }
  p += `## Reporting\n\nWhen done, print:\n\n1. List of files created / modified (path only).\n2. Test/lint output.\n3. Any TODO comments left, with file:line.\n4. Any decisions made that weren't in the task description.\n`;
  return p;
}

// ---- Auto-validation (post-execution post-conditions) ----

function runPostValidation(workDir, params) {
  const failures = [];
  const {
    min_files_changed,
    required_paths_modified,
    forbidden_paths,
    min_diff_lines,
  } = params;

  const hasAnyCheck =
    typeof min_files_changed === 'number' ||
    (Array.isArray(required_paths_modified) && required_paths_modified.length > 0) ||
    (Array.isArray(forbidden_paths) && forbidden_paths.length > 0) ||
    typeof min_diff_lines === 'number';

  if (!hasAnyCheck) return { passed: true, failures: [], skipped: true };

  let changedFiles = [];
  let shortstat = '';
  try {
    // Intent-to-add makes newly created files appear in `git diff` without
    // staging content in the repository. This keeps validation consistent
    // between direct/patch/review modes and worktree diff export.
    try {
      execFileSync('git', ['add', '-N', '.'], {
        cwd: workDir,
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {}
    const out = execSync('git diff --name-only HEAD', { cwd: workDir, encoding: 'utf-8', timeout: 10000 }).trim();
    changedFiles = out ? out.split('\n') : [];
    shortstat = execSync('git diff --shortstat HEAD', { cwd: workDir, encoding: 'utf-8', timeout: 10000 }).trim();
  } catch (e) {
    return { passed: false, failures: [{ rule: 'git-state', detail: `git diff failed: ${e.message}` }], skipped: false };
  }

  if (typeof min_files_changed === 'number' && changedFiles.length < min_files_changed) {
    failures.push({ rule: 'min_files_changed', detail: `expected ≥ ${min_files_changed}, got ${changedFiles.length}`, changedFiles });
  }
  if (Array.isArray(required_paths_modified)) {
    const missing = required_paths_modified.filter(p => !changedFiles.includes(p));
    if (missing.length > 0) failures.push({ rule: 'required_paths_modified', detail: `not touched: ${missing.join(', ')}`, changedFiles });
  }
  if (Array.isArray(forbidden_paths)) {
    const violated = forbidden_paths.filter(p =>
      changedFiles.some(c => c === p || c.startsWith(p.endsWith('/') ? p : p + '/')),
    );
    if (violated.length > 0) failures.push({ rule: 'forbidden_paths', detail: `modified despite ban: ${violated.join(', ')}`, changedFiles });
  }
  if (typeof min_diff_lines === 'number') {
    const m = shortstat.match(/(\d+) insertion/);
    const n = shortstat.match(/(\d+) deletion/);
    const total = (m ? parseInt(m[1], 10) : 0) + (n ? parseInt(n[1], 10) : 0);
    if (total < min_diff_lines) failures.push({ rule: 'min_diff_lines', detail: `expected ≥ ${min_diff_lines} lines (ins+del), got ${total}`, shortstat });
  }

  return { passed: failures.length === 0, failures, shortstat, changedFiles };
}

// ---- stdout head/tail buffer ----

function makeHeadTailBuffer(headCap = 10 * 1024, tailCap = 40 * 1024) {
  let head = '';
  let tail = '';
  let droppedMiddle = false;
  return {
    push(s) {
      if (head.length < headCap) {
        const room = headCap - head.length;
        head += s.slice(0, room);
        if (s.length > room) tail += s.slice(room);
      } else {
        tail += s;
      }
      if (tail.length > tailCap * 2) {
        tail = tail.slice(-tailCap);
        droppedMiddle = true;
      }
    },
    finalize() {
      if (!tail) return head;
      return droppedMiddle
        ? `${head}\n\n...[middle of output truncated]...\n\n${tail}`
        : head + tail;
    },
  };
}

function defaultExecutionMode(mode) {
  return mode === 'check' ? 'review' : 'worktree';
}

function defaultToolsForExecution(executionMode) {
  if (executionMode === 'review') return DEFAULT_READ_TOOLS;
  if (executionMode === 'patch') return DEFAULT_PATCH_TOOLS;
  return DEFAULT_WRITE_TOOLS;
}

function makeWorkerId(mode, taskDir, scope, extraInstructions) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fp = crypto
    .createHash('sha256')
    .update(`${mode}|${taskDir || ''}|${scope || ''}|${extraInstructions || ''}|${process.pid}|${Date.now()}`)
    .digest('hex')
    .slice(0, 8);
  return `pi-${mode}-${ts}-${fp}`;
}

function seedPiAgentConfig(targetPiHome) {
  const srcDir = path.join(os.homedir(), '.pi', 'agent');
  const required = ['models.json', 'settings.json'];
  const copied = [];
  for (const f of required) {
    const src = path.join(srcDir, f);
    if (fs.existsSync(src)) {
      fs.mkdirSync(targetPiHome, { recursive: true });
      const dest = path.join(targetPiHome, f);
      fs.copyFileSync(src, dest);
      copied.push({ source: src, destination: dest });
    }
  }
  return { count: copied.length, files: copied };
}

function createWorkerRuntime(runtimeDir, workerId) {
  const workerDir = path.join(runtimeDir, 'pi-workers', workerId);
  const repoDir = path.join(workerDir, 'repo');
  const piHome = path.join(workerDir, 'pi-home');
  const sessionDir = path.join(workerDir, 'sessions');
  fs.mkdirSync(piHome, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const seed = seedPiAgentConfig(piHome);
  if (seed.count === 0) {
    console.error(`[${SERVER_NAME}] WARNING: no Pi agent config files found in ~/.pi/agent/; Pi subprocess may fail with "Model not found"`);
  }
  return { workerId, workerDir, repoDir, piHome, sessionDir, configFiles: seed.count, configFilePaths: seed.files };
}

function createWorktree(sourceDir, repoDir) {
  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', repoDir, 'HEAD'], {
    cwd: sourceDir,
    encoding: 'utf-8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function prepareWorkerDiff(repoDir, patchFile) {
  let changedFiles = [];
  let shortstat = '';
  let patch = '';
  try {
    // Intent-to-add makes newly created files appear in `git diff` without
    // permanently staging content in the main repository.
    execFileSync('git', ['add', '-N', '.'], {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {}

  try {
    const names = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
    changedFiles = names ? names.split('\n') : [];
    shortstat = execFileSync('git', ['diff', '--shortstat', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
    patch = execFileSync('git', ['diff', '--binary', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 100 * 1024 * 1024,
    });
    fs.writeFileSync(patchFile, patch, 'utf-8');
  } catch (e) {
    return { ok: false, error: e.message, changedFiles, shortstat, patchFile };
  }
  return { ok: true, changedFiles, shortstat, patchFile, bytes: Buffer.byteLength(patch) };
}

function classifyRunStatus(exitCode, killed, output) {
  if (killed) return 'timeout';
  const text = output || '';
  const approvalBlocked =
    /approval|approve|permission|confirm|non[- ]interactive|no ui|stdin|tty/i.test(text) &&
    /blocked|required|waiting|denied|refused|unavailable|cannot|can't|failed/i.test(text);
  if (approvalBlocked) return 'blocked';
  return exitCode === 0 ? 'done' : 'failed';
}

function hasUsablePatch(executionMode, diffInfo, changedFiles) {
  if (executionMode !== 'worktree') return false;
  return Boolean(diffInfo && diffInfo.ok && Array.isArray(changedFiles) && changedFiles.length > 0);
}

function detectsDataValidationUnavailable(output) {
  const text = output || '';
  return [
    /(derived|generated|sample|full|fixture|data).{0,100}(missing|unavailable|not available|not found|cannot|can't|unable|skipped|not attempted)/i,
    /(cannot|can't|unable|skipped|not attempted).{0,100}(sample|full|data|validation|derived|generated)/i,
    /data validation.{0,100}(must|needs?).{0,60}main repo/i,
  ].some((re) => re.test(text));
}

function validationScopeText(validation, limitedDataValidation) {
  if (!validation || validation.skipped) {
    return limitedDataValidation
      ? 'auto validation skipped; data validation must run in main repo'
      : 'auto validation skipped; orchestrator validation required';
  }
  if (validation.passed) {
    return limitedDataValidation
      ? 'static/auto validation passed; data validation must run in main repo'
      : 'static/auto validation passed; orchestrator validation required';
  }
  return 'auto validation failed';
}

function classifyResult({ executionMode, status, finalStatus, exitCode, validation, diffInfo, changedFiles, output }) {
  const usablePatch = hasUsablePatch(executionMode, diffInfo, changedFiles);
  const limitedDataValidation = usablePatch && validation?.passed && exitCode === 0 && detectsDataValidationUnavailable(output);

  if (limitedDataValidation && (status === 'done' || status === 'blocked')) {
    return {
      status: 'patch_ready_limited_validation',
      result_class: 'patch_ready_limited_validation',
      status_reason: 'Pi produced a non-empty patch and static/auto validation passed, but data validation was not available in the isolated worktree.',
      data_validation: 'not_attempted',
      data_validation_reason: 'Derived/generated data was unavailable in the isolated worker; run data validation in the main repository after applying the patch.',
    };
  }

  if (executionMode === 'worktree' && diffInfo?.ok && changedFiles.length === 0) {
    return {
      status: 'no_patch',
      result_class: 'no_usable_patch',
      status_reason: 'Pi exited without producing changes in diff.patch.',
      data_validation: 'not_attempted',
      data_validation_reason: 'No patch was produced, so main-repository data validation is not applicable yet.',
    };
  }

  if (!validation?.passed) {
    return {
      status: 'validation_failed',
      result_class: 'validation_failed',
      status_reason: 'Post-execution validation failed.',
      data_validation: 'not_attempted',
      data_validation_reason: 'Main-repository data validation should wait until post-validation failures are resolved.',
    };
  }

  if (executionMode === 'worktree' && usablePatch && finalStatus === 'done') {
    return {
      status: 'done',
      result_class: 'patch_ready',
      status_reason: 'Pi produced a non-empty patch and post-validation passed.',
      data_validation: 'not_attempted',
      data_validation_reason: 'Worktree dispatch does not prove main-repository data validation; run it after applying the patch.',
    };
  }

  if (finalStatus === 'done') {
    return {
      status: 'done',
      result_class: 'completed',
      status_reason: 'Pi completed and post-validation passed.',
      data_validation: 'not_attempted',
      data_validation_reason: 'No adapter-level data validation result was captured.',
    };
  }

  return {
    status: finalStatus,
    result_class: finalStatus === 'blocked' ? 'blocked' : 'failed',
    status_reason: finalStatus === 'blocked'
      ? 'Pi could not continue and did not produce an apply-ready patch.'
      : 'Pi did not complete successfully.',
    data_validation: 'not_attempted',
    data_validation_reason: 'Main-repository data validation should wait until dispatch succeeds.',
  };
}

function buildOrchestratorNextSteps({ resultClass, projectMode, applyCommand, validationCommands = [] }) {
  if (resultClass === 'no_usable_patch') {
    return ['Inspect report/log', 'Tighten scope or instructions', 'Re-dispatch or fix manually'];
  }
  if (resultClass === 'validation_failed') {
    return ['Inspect report/diff', 'Resolve post-validation failures', 'Re-run cheap validation before apply'];
  }
  if (resultClass === 'blocked' || resultClass === 'failed') {
    return ['Inspect report/log', 'Fix the blocker', 'Re-dispatch when the task can continue'];
  }

  const checkStep = projectMode.startsWith('trellis_')
    ? 'Run independent check/trellis-check'
    : 'Run independent review/check';
  const steps = [
    'Inspect report.json and diff.patch',
    applyCommand ? `Apply patch: ${applyCommand}` : 'Apply accepted changes',
    'Run cheap validation',
    'Run sample/small validation',
    checkStep,
    'If check changes code, re-run sample/small validation',
    'Run expensive full validation',
    'Commit only from the orchestrator after validation passes',
  ];
  if (validationCommands.length > 0) {
    steps.splice(3, 0, 'Run requested validation_commands in the main repository');
  }
  return steps;
}

function buildRecommendedCommands({ applyCommand, validationCommands = [] }) {
  const commands = [];
  if (applyCommand) commands.push(applyCommand);
  commands.push('git status --short', 'git diff --stat');
  for (const cmd of validationCommands) {
    if (typeof cmd === 'string' && cmd.trim()) commands.push(cmd.trim());
  }
  return [...new Set(commands)];
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function formatBlock(label, value, maxLen = 4000) {
  const text = String(value || '').trim();
  if (!text) return `${label}: (empty)`;
  const truncated = text.length > maxLen ? `${text.slice(0, maxLen)}\n...[truncated ${text.length - maxLen} chars]` : text;
  return `${label}:\n${truncated}`;
}

function formatSeededConfig(seed) {
  if (!seed || !Array.isArray(seed.files) || seed.files.length === 0) return 'config_seeded: none';
  const lines = ['config_seeded:'];
  for (const file of seed.files) {
    lines.push(`  - ${file.destination} (from ${file.source})`);
  }
  return lines.join('\n');
}

function safeSmokeEnv(env) {
  const keys = [
    'PI_CODING_AGENT_DIR',
    'PI_CODING_AGENT_SESSION_DIR',
    'PI_OFFLINE',
    'PI_SKIP_VERSION_CHECK',
    'PI_BINARY',
  ];
  const out = {};
  for (const key of keys) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}

function formatSmokeEnv(env) {
  const entries = Object.entries(env);
  if (entries.length === 0) return 'env_passed: (none)';
  return `env_passed:\n${entries.map(([k, v]) => `  ${k}=${v}`).join('\n')}`;
}

function smokeDiagnostic(stdout, stderr, seed) {
  const combined = `${stdout || ''}\n${stderr || ''}`;
  if (/model .*not found|unknown model|no model/i.test(combined)) {
    if (!seed || seed.count === 0) {
      return 'diagnostic: no Pi agent config files were seeded; check ~/.pi/agent/models.json and ~/.pi/agent/settings.json.';
    }
    return 'diagnostic: model routing failed despite seeded Pi agent config; check the configured model route and Pi model registry.';
  }
  if (/permission|denied|approval|tty|stdin/i.test(combined)) {
    return 'diagnostic: Pi appears blocked by non-interactive execution or permissions.';
  }
  return 'diagnostic: inspect pi stderr/stdout above and run the same model with the pi CLI if needed.';
}

function dirSizeBytes(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSizeBytes(full);
      else if (entry.isFile() || entry.isSymbolicLink()) total += fs.lstatSync(full).size;
    } catch {}
  }
  return total;
}

function runtimeWorkersDir(runtimeDir) {
  const base = path.basename(runtimeDir);
  if (base.startsWith('pi-') && fs.existsSync(path.join(runtimeDir, 'report.json'))) return path.dirname(runtimeDir);
  if (base === 'pi-workers') return runtimeDir;
  return path.join(runtimeDir, 'pi-workers');
}

function removeWorkerRuntime(workerDir, workDir) {
  const repoDir = path.join(workerDir, 'repo');
  if (fs.existsSync(repoDir)) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', repoDir], {
        cwd: workDir,
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {}
  }
  fs.rmSync(workerDir, { recursive: true, force: true });
}

// ---- Tool implementations ----

async function dispatch(args) {
  const {
    mode = 'implement',
    task_dir: explicitTaskDir,
    working_directory: cwd,
    model: modelInput,
    thinking = 'high',
    tools: toolsInput,
    execution_mode: executionModeInput,
    isolate_pi = true,
    timeout_minutes: timeoutInput = 60,
    dry_run = false,
    extra_instructions,
    scope,
    context_files,
    trellis_context_id,
    validation_commands = [],
    min_files_changed,
    required_paths_modified,
    forbidden_paths,
    min_diff_lines,
  } = args;

  const timeout_minutes = Math.min(timeoutInput, 120);
  const workDir = cwd || process.cwd();
  const executionMode = executionModeInput || defaultExecutionMode(mode);
  const tools = toolsInput || defaultToolsForExecution(executionMode);
  if (!['review', 'patch', 'worktree', 'direct'].includes(executionMode)) {
    return { content: [{ type: 'text', text: `Error: unsupported execution_mode "${executionMode}". Use review, patch, worktree, or direct.` }], isError: true };
  }
  if (executionMode === 'worktree' && !isGitRepo(workDir)) {
    return { content: [{ type: 'text', text: `Error: execution_mode=worktree requires a git repository: ${workDir}` }], isError: true };
  }
  const channelName = detectChannel(args, process.env);
  const projectMode = detectProjectMode(workDir, channelName, executionMode);
  let model, modelFrom, modelKey;
  try {
    ({ resolved: model, from: modelFrom, key: modelKey } = resolveModel(modelInput, mode));
  } catch (e) {
    return { content: [{ type: 'text', text: e.message }], isError: true };
  }

  let taskDir = explicitTaskDir || null;
  if (taskDir) {
    // Explicit task_dir: validate existence so callers get a clear error
    // instead of a confusing missing-manifest report later.
    const taskAbs = path.isAbsolute(taskDir) ? taskDir : path.join(workDir, taskDir);
    if (!fs.existsSync(taskAbs)) {
      return {
        content: [{ type: 'text', text: `Error: task_dir "${taskDir}" does not exist (resolved: ${taskAbs}).` }],
        isError: true,
      };
    }
  } else {
    taskDir = resolveActiveTask(workDir, trellis_context_id);
  }

  let context = null;
  let promptBody = '';
  if (taskDir) {
    context = assembleTrellisContext(workDir, taskDir, mode);
    promptBody = buildDispatchPrompt({ ...context, mode, execution_mode: executionMode, extra_instructions, scope, validation_commands, context_files: readContextFiles(workDir, context_files) });
  } else if (mode === 'custom') {
    if (!extra_instructions) return { content: [{ type: 'text', text: 'Error: custom mode requires extra_instructions.' }], isError: true };
    promptBody = buildNoTrellisPrompt(mode, extra_instructions, scope, validation_commands, executionMode, readContextFiles(workDir, context_files));
  } else {
    if (!extra_instructions) {
      return {
        content: [{ type: 'text', text: 'No active Trellis task found. Either:\n1. Use a Trellis project with an active task and inherited TRELLIS_CONTEXT_ID\n2. Provide trellis_context_id explicitly\n3. Provide task_dir explicitly\n4. Use mode="custom" with extra_instructions\n5. Provide extra_instructions to describe the task.' }],
        isError: true,
      };
    }
    promptBody = buildNoTrellisPrompt(mode, extra_instructions, scope, validation_commands, executionMode, readContextFiles(workDir, context_files));
  }

  const runtimeDir = resolveRuntimeDir(workDir);
  fs.mkdirSync(runtimeDir, { recursive: true });

  const workerId = makeWorkerId(mode, taskDir, scope, extra_instructions);
  const worker = createWorkerRuntime(runtimeDir, workerId);
  const promptPath = path.join(worker.workerDir, 'prompt.md');
  const logPath = path.join(worker.workerDir, 'output.log');
  const reportPath = path.join(worker.workerDir, 'report.json');
  const patchPath = path.join(worker.workerDir, 'diff.patch');
  fs.writeFileSync(promptPath, promptBody, 'utf-8');

  let metaResponse = `Resolved task: ${taskDir || '(custom mode)'}\n`;
  if (context) {
    metaResponse += `Manifest: ${context.manifestFile} (${context.manifest.entries.length} entries, ${context.manifest.files.length} files resolved)\n`;
    metaResponse += `Artifacts: ${Object.keys(context.artifacts).join(', ') || 'none'}\n`;
    if (context.manifest.missing && context.manifest.missing.length > 0) {
      const m = context.manifest.missing;
      metaResponse += `Missing manifest files: ${m.length} (${m.slice(0, 5).join(', ')}${m.length > 5 ? `, +${m.length - 5} more` : ''})\n`;
    }
  }
  metaResponse += `Prompt: ${promptPath}\n`;
  metaResponse += `Log: ${logPath}\n`;
  metaResponse += `Report: ${reportPath}\n`;
  metaResponse += `Worker: ${workerId} (${executionMode})\n`;
  metaResponse += `Project mode: ${projectMode}\n`;
  if (executionMode === 'worktree') {
    metaResponse += `Worker repo: ${worker.repoDir}\n`;
    metaResponse += `Patch: ${patchPath}\n`;
  }
  metaResponse += `Model: ${model} (${modelFrom}${modelKey ? `:${modelKey}` : ''}, thinking: ${thinking})\n`;
  metaResponse += `Tools: ${tools}\n`;
  metaResponse += `Timeout: ${timeout_minutes} min\n`;
  metaResponse += `Channel: ${channelName || '(none, local mode)'}\n`;
  metaResponse += `Pi config: seeded ${worker.configFiles || 0} agent file(s) into isolated piHome\n`;

  const { env: piEnv, stripped: strippedEnv } = buildPiEnv(process.env);
  if (strippedEnv.length > 0) {
    metaResponse += `Env: scrubbed ${strippedEnv.length} sensitive var${strippedEnv.length === 1 ? '' : 's'} from Pi subprocess\n`;
  }

  if (dry_run) {
    return {
      content: [{
        type: 'text',
        text: `[DRY RUN] No Pi process started.\n\n${metaResponse}\n--- Generated prompt (first 4000 chars) ---\n\n${promptBody.slice(0, 4000)}${promptBody.length > 4000 ? '\n... (truncated)' : ''}`,
      }],
    };
  }

  const piBin = findPiBinary();
  if (!piBin) return { content: [{ type: 'text', text: `Error: pi binary not found in PATH (or ${PI_BIN_ENV} env).\n\n${metaResponse}` }], isError: true };

  let lockPath = null;
  lockPath = dispatchLockPath(runtimeDir, taskDir, scope, extra_instructions);
  const lr = acquireDispatchLock(lockPath);
  if (!lr.acquired) {
    return {
      content: [{
        type: 'text',
        text: `Error: another dispatch with identical (task, scope, extra_instructions) is already running.\n  Holder PID: ${lr.holder?.pid}\n  Started:    ${lr.holder?.startedAt}\n  Lock file:  ${lockPath}\n\nIf the holder is actually dead, remove the lock file manually.\n\n${metaResponse}`,
      }],
      isError: true,
    };
  }

  let piWorkDir = workDir;
  if (executionMode === 'worktree') {
    try {
      createWorktree(workDir, worker.repoDir);
      piWorkDir = worker.repoDir;
    } catch (e) {
      if (lockPath) releaseDispatchLock(lockPath);
      const message = `${metaResponse}\nError creating isolated git worktree: ${e.message}`;
      writeJsonFile(reportPath, {
        worker_id: workerId,
        status: 'spawn_error',
        result_class: 'failed',
        status_reason: 'Could not create isolated git worktree.',
        validation_scope: 'not run',
        data_validation: 'not_attempted',
        data_validation_reason: 'Dispatch did not start.',
        orchestrator_next_steps: ['Inspect error', 'Fix worktree setup', 'Re-dispatch'],
        recommended_main_repo_commands: ['git status --short'],
        project_mode: projectMode,
        error: e.message,
        execution_mode: executionMode,
        prompt_file: promptPath,
        log_file: logPath,
        report_file: reportPath,
        patch_file: null,
        finished_at: new Date().toISOString(),
      });
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  }

  await emitChannelEvent(channelName, 'dispatch_start', {
    mode, task: taskDir, scope: scope || null, model,
    worker_id: workerId, execution_mode: executionMode,
    prompt_file: promptPath, log_file: logPath,
    report_file: reportPath, patch_file: executionMode === 'worktree' ? patchPath : null,
    started_at: new Date().toISOString(),
  }, workDir);

  return new Promise((resolve) => {
    const piArgs = [
      '--model', model,
      '--tools', tools,
      '--thinking', thinking,
      ...(isolate_pi ? [
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--no-session',
      ] : []),
      `@${promptPath}`,
      '-p', 'Follow the instructions in the attached file. Read the listed files in order before writing any code.',
    ];

    const timeout = timeout_minutes * 60 * 1000;
    let killed = false;
    const stdoutBuf = makeHeadTailBuffer();
    const stderrBuf = makeHeadTailBuffer(2 * 1024, 8 * 1024);

    const proc = trackChild(spawn(piBin, piArgs, {
      cwd: piWorkDir,
      env: {
        ...piEnv,
        PI_CODING_AGENT_DIR: worker.piHome,
        PI_CODING_AGENT_SESSION_DIR: worker.sessionDir,
        PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1',
      },
      // Pi's -p mode blocks on stdin EOF if stdin is a live pipe.
      stdio: ['ignore', 'pipe', 'pipe'],
    }));

    proc.stdout.on('data', (d) => stdoutBuf.push(d.toString()));
    proc.stderr.on('data', (d) => stderrBuf.push(d.toString()));

    const logStream = fs.createWriteStream(logPath, { flags: 'w' });
    proc.stdout.pipe(logStream);
    proc.stderr.pipe(logStream);

    let killTimer = null;
    let settled = false;
    let spawnErrored = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (lockPath) releaseDispatchLock(lockPath);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeout);

    proc.on('close', async (code, signal) => {
      if (spawnErrored || settled) return;
      logStream.close();

      const exitCode = code;
      const signaled = Boolean(signal);
      let diffInfo = null;
      if (executionMode === 'worktree') {
        diffInfo = prepareWorkerDiff(worker.repoDir, patchPath);
      }

      const validation = runPostValidation(piWorkDir, {
        min_files_changed, required_paths_modified, forbidden_paths, min_diff_lines,
      });

      const stdout = stdoutBuf.finalize();
      const stderr = stderrBuf.finalize();
      let output = '';
      if (stdout.trim()) output += stdout.trim();
      if (stderr.trim()) output += (output ? '\n\n--- stderr ---\n' : '') + stderr.trim();
      if (killed) output += `\n\n[PROCESS KILLED: exceeded ${timeout_minutes} minute timeout]`;
      if (signaled && !killed) output += `\n\n[PROCESS EXITED BY SIGNAL: ${signal}]`;

      const runStatus = signaled ? 'killed' : classifyRunStatus(exitCode, killed, output);
      const changedFiles = validation.changedFiles || diffInfo?.changedFiles || [];
      const ok = runStatus === 'done' && validation.passed && (!diffInfo || diffInfo.ok) && !(executionMode === 'worktree' && diffInfo?.ok && changedFiles.length === 0);
      const finalStatus = ok
        ? 'done'
        : (!validation.passed ? 'validation_failed' : (diffInfo && !diffInfo.ok ? 'diff_failed' : runStatus));
      const result = classifyResult({
        executionMode,
        status: runStatus,
        finalStatus,
        exitCode,
        validation,
        diffInfo,
        changedFiles,
        output,
      });
      const applyCommand = executionMode === 'worktree' ? `git apply "${patchPath}"` : null;
      const recommendedCommands = buildRecommendedCommands({ applyCommand, validationCommands: validation_commands });
      const orchestratorNextSteps = buildOrchestratorNextSteps({
        resultClass: result.result_class,
        projectMode,
        applyCommand,
        validationCommands: validation_commands,
      });
      const report = {
        worker_id: workerId,
        status: result.status,
        run_status: runStatus,
        result_class: result.result_class,
        status_reason: result.status_reason,
        validation_scope: validationScopeText(validation, result.result_class === 'patch_ready_limited_validation'),
        data_validation: result.data_validation,
        data_validation_reason: result.data_validation_reason,
        orchestrator_next_steps: orchestratorNextSteps,
        recommended_main_repo_commands: recommendedCommands,
        project_mode: projectMode,
        execution_mode: executionMode,
        task: taskDir || null,
        model,
        model_source: modelFrom,
        model_key: modelKey,
        tools,
        isolate_pi,
        exit_code: exitCode,
        signal: signal || null,
        killed: killed || signaled,
        validation: validation.skipped ? 'skipped' : (validation.passed ? 'passed' : 'failed'),
        validation_failures: validation.failures || [],
        changed_files: changedFiles,
        shortstat: validation.shortstat || diffInfo?.shortstat || '',
        prompt_file: promptPath,
        log_file: logPath,
        report_file: reportPath,
        patch_file: executionMode === 'worktree' ? patchPath : null,
        apply_command: applyCommand,
        worker_repo: executionMode === 'worktree' ? worker.repoDir : null,
        diff: diffInfo,
        finished_at: new Date().toISOString(),
      };
      writeJsonFile(reportPath, report);

      await emitChannelEvent(channelName, ok ? 'dispatch_done' : 'dispatch_failed', {
        mode, task: taskDir,
        worker_id: workerId, execution_mode: executionMode,
        status: report.status,
        result_class: report.result_class,
        status_reason: report.status_reason,
        validation_scope: report.validation_scope,
        exit_code: exitCode, signal: signal || null, killed: killed || signaled,
        validation: report.validation,
        validation_failures: validation.failures || [],
        changed_files: changedFiles,
        report_file: reportPath,
        patch_file: report.patch_file,
        apply_command: report.apply_command,
        finished_at: report.finished_at,
      }, workDir);

      let validationBlock = '';
      if (!validation.skipped) {
        validationBlock = `\n--- post-validation ---\nstatus: ${validation.passed ? 'passed' : 'FAILED'}\n`;
        if (validation.shortstat) validationBlock += `git: ${validation.shortstat}\n`;
        if (validation.changedFiles && validation.changedFiles.length > 0) {
          validationBlock += `changed files (${validation.changedFiles.length}):\n`;
          for (const f of validation.changedFiles.slice(0, 30)) validationBlock += `  ${f}\n`;
          if (validation.changedFiles.length > 30) validationBlock += `  ... +${validation.changedFiles.length - 30} more\n`;
        }
        if (validation.failures.length > 0) {
          validationBlock += `failures:\n`;
          for (const f of validation.failures) validationBlock += `  - ${f.rule}: ${f.detail}\n`;
        }
        validationBlock += '\n';
      }
      let artifactBlock = `\n--- artifacts ---\nstatus: ${report.status}\nresult_class: ${report.result_class}\nreason: ${report.status_reason}\nvalidation_scope: ${report.validation_scope}\nreport: ${reportPath}\n`;
      if (executionMode === 'worktree') {
        artifactBlock += `worker_repo: ${worker.repoDir}\npatch: ${patchPath}\napply: ${report.apply_command}\n`;
        if (diffInfo && !diffInfo.ok) artifactBlock += `diff_error: ${diffInfo.error}\n`;
      }
      if (orchestratorNextSteps.length > 0) {
        artifactBlock += `next_steps:\n`;
        for (const step of orchestratorNextSteps) artifactBlock += `  - ${step}\n`;
      }

      const isError = !['done', 'patch_ready_limited_validation'].includes(report.status);
      finish({
        content: [{
          type: 'text',
          text: `${metaResponse}\nPi exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}.\n${artifactBlock}${validationBlock}\nOutput captured in: ${logPath}\nUse read_report for the structured summary and optional log tail.`,
        }],
        isError,
      });
    });

    proc.on('error', async (err) => {
      if (settled) return;
      spawnErrored = true;
      logStream.close();
      writeJsonFile(reportPath, {
        worker_id: workerId,
        status: 'spawn_error',
        result_class: 'failed',
        status_reason: 'Could not spawn Pi subprocess.',
        validation_scope: 'not run',
        data_validation: 'not_attempted',
        data_validation_reason: 'Dispatch did not start.',
        orchestrator_next_steps: ['Inspect error', 'Fix Pi binary/config', 'Re-dispatch'],
        recommended_main_repo_commands: ['git status --short'],
        project_mode: projectMode,
        execution_mode: executionMode,
        task: taskDir || null,
        error: err.message,
        prompt_file: promptPath,
        log_file: logPath,
        report_file: reportPath,
        patch_file: executionMode === 'worktree' ? patchPath : null,
        worker_repo: executionMode === 'worktree' ? worker.repoDir : null,
        finished_at: new Date().toISOString(),
      });
      await emitChannelEvent(channelName, 'spawn_error', {
        mode, task: taskDir,
        worker_id: workerId, execution_mode: executionMode,
        error: err.message, report_file: reportPath,
        finished_at: new Date().toISOString(),
      }, workDir);
      finish({
        content: [{ type: 'text', text: `${metaResponse}\nError spawning pi: ${err.message}` }],
        isError: true,
      });
    });
  });
}

function smoke(args) {
  const { model: modelInput, working_directory } = args;
  let model, modelFrom, modelKey;
  try {
    ({ resolved: model, from: modelFrom, key: modelKey } = resolveModel(modelInput, 'implement'));
  } catch (e) {
    return { content: [{ type: 'text', text: e.message }], isError: true };
  }
  const piBin = findPiBinary();
  if (!piBin) return { content: [{ type: 'text', text: 'Error: pi binary not found in PATH.' }], isError: true };

  // Use the same env scrub + isolation as dispatch so smoke catches config issues.
  const { env: piEnv } = buildPiEnv(process.env);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-smoke-'));
  const isolatedHome = path.join(tmpDir, 'pi-home');
  const sessionDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(isolatedHome, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const seed = seedPiAgentConfig(isolatedHome);
  const childEnv = {
    ...piEnv,
    PI_CODING_AGENT_DIR: isolatedHome,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
  };
  const safeEnv = safeSmokeEnv(childEnv);

  return new Promise((resolve) => {
    const proc = trackChild(spawn(piBin, [
      '--model', model,
      '--tools', 'read',
      '-p', 'Respond with exactly the string: PI READY. No other words.',
    ], {
      cwd: working_directory || process.cwd(),
      env: childEnv,
      // Pi's -p mode blocks on stdin EOF if stdin is a live pipe.
      stdio: ['ignore', 'pipe', 'pipe'],
    }));

    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;
    let killTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, 60000);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code, signal) => {
      const ready = stdout.includes('PI READY');
      let text = `Pi smoke: ${ready ? 'PASSED' : 'FAILED'} | model=${model} (${modelFrom}${modelKey ? `:${modelKey}` : ''}) | exit=${code} | signal=${signal || 'none'} | killed=${killed}`;
      text += `\n${formatSeededConfig(seed)}`;
      text += `\n${formatSmokeEnv(safeEnv)}`;
      text += `\n${formatBlock('pi stdout', stdout)}`;
      text += `\n${formatBlock('pi stderr', stderr)}`;
      if (!ready) text += `\n${smokeDiagnostic(stdout, stderr, seed)}`;
      finish({
        content: [{ type: 'text', text }],
        isError: !ready,
      });
    });
    proc.on('error', (err) => {
      let text = `Pi smoke: FAILED | model=${model} (${modelFrom}${modelKey ? `:${modelKey}` : ''}) | spawn_error=${err.message}`;
      text += `\n${formatSeededConfig(seed)}`;
      text += `\n${formatSmokeEnv(safeEnv)}`;
      finish({ content: [{ type: 'text', text }], isError: true });
    });
  });
}

function candidateWorkerDirs(args) {
  const { runtime_dir, worker_id, working_directory } = args;
  const dirs = [];
  if (runtime_dir) {
    const resolvedRuntime = resolvePath(runtime_dir, working_directory);
    if (worker_id) {
      dirs.push(path.join(resolvedRuntime, 'pi-workers', worker_id));
      dirs.push(path.join(resolvedRuntime, worker_id));
    }
    dirs.push(resolvedRuntime);
  }
  if (worker_id) {
    const base = working_directory ? resolveRuntimeDir(resolvePath(working_directory)) : TMP_RUNTIME_DIR;
    dirs.push(path.join(base, 'pi-workers', worker_id));
  }
  return [...new Set(dirs)];
}

function resolveReportInputs(args) {
  const { log_file, report_file, working_directory } = args;
  if (report_file) {
    const reportPath = resolvePath(report_file, working_directory);
    return { reportPath, logPath: null };
  }
  if (log_file) {
    const logPath = resolvePath(log_file, working_directory);
    return { reportPath: path.join(path.dirname(logPath), 'report.json'), logPath };
  }
  for (const dir of candidateWorkerDirs(args)) {
    const reportPath = path.join(dir, 'report.json');
    if (fs.existsSync(reportPath)) return { reportPath, logPath: path.join(dir, 'output.log') };
  }
  return { reportPath: null, logPath: null };
}

function summarizeReport(report, reportPath) {
  const changed = Array.isArray(report.changed_files) ? report.changed_files : [];
  const steps = Array.isArray(report.orchestrator_next_steps) ? report.orchestrator_next_steps : [];
  const commands = Array.isArray(report.recommended_main_repo_commands) ? report.recommended_main_repo_commands : [];
  let text = `--- report summary ---\n`;
  text += `report: ${reportPath}\n`;
  text += `status: ${report.status || '(unknown)'}\n`;
  text += `result_class: ${report.result_class || '(missing)'}\n`;
  text += `project_mode: ${report.project_mode || '(unknown)'}\n`;
  if (report.status_reason) text += `status_reason: ${report.status_reason}\n`;
  if (report.validation_scope) text += `validation_scope: ${report.validation_scope}\n`;
  if (report.data_validation) text += `data_validation: ${report.data_validation}\n`;
  if (report.data_validation_reason) text += `data_validation_reason: ${report.data_validation_reason}\n`;
  if (report.apply_command) text += `apply_command: ${report.apply_command}\n`;
  if (changed.length > 0) {
    text += `changed_files (${changed.length}):\n`;
    for (const f of changed.slice(0, 30)) text += `  ${f}\n`;
    if (changed.length > 30) text += `  ... +${changed.length - 30} more\n`;
  } else {
    text += `changed_files: none\n`;
  }
  if (steps.length > 0) {
    text += `orchestrator_next_steps:\n`;
    for (const step of steps) text += `  - ${step}\n`;
  }
  if (commands.length > 0) {
    text += `recommended_main_repo_commands:\n`;
    for (const cmd of commands) text += `  ${cmd}\n`;
  }
  return text;
}

function readReport(args) {
  const { lines = 200 } = args;
  const { reportPath, logPath } = resolveReportInputs(args);
  if (!reportPath && !logPath) {
    return { content: [{ type: 'text', text: 'Error: provide log_file, report_file, or runtime_dir plus worker_id.' }], isError: true };
  }
  try {
    const n = Number.isFinite(Number(lines)) ? Math.max(1, Math.min(10000, Math.floor(Number(lines)))) : 200;
    let text = '';
    if (reportPath && fs.existsSync(reportPath)) {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      text += summarizeReport(report, reportPath);
    } else if (reportPath) {
      text += `report not found: ${reportPath}\n`;
    }
    const resolvedLog = logPath || (reportPath ? path.join(path.dirname(reportPath), 'output.log') : null);
    if (resolvedLog && fs.existsSync(resolvedLog)) {
      const raw = fs.readFileSync(resolvedLog, 'utf-8');
      const parts = raw.split('\n');
      const content = parts.slice(Math.max(0, parts.length - n - 1)).join('\n');
      text += `\n--- ${resolvedLog} (last ${n} lines) ---\n\n${content}`;
    }
    if (!text.trim()) return { content: [{ type: 'text', text: `No report/log found for provided arguments.` }], isError: true };
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
}

function cleanupRuntime(args) {
  const {
    working_directory,
    retain_days = 7,
    dry_run = false,
  } = args;
  const workDir = working_directory || process.cwd();
  const runtimeDir = resolveRuntimeDir(workDir);
  const workersDir = runtimeWorkersDir(runtimeDir);
  const retainMs = Math.max(0, Number(retain_days) || 0) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retainMs;

  if (!fs.existsSync(workersDir)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ runtime_dir: runtimeDir, workers_dir: workersDir, dry_run, removed: [], retained: [], bytes_freed: 0 }, null, 2),
      }],
    };
  }

  const removed = [];
  const retained = [];
  let bytesFreed = 0;
  const entries = fs.readdirSync(workersDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('pi-'));

  for (const entry of entries) {
    const dir = path.join(workersDir, entry.name);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    const bytes = dirSizeBytes(dir);
    const item = {
      worker_id: entry.name,
      path: dir,
      mtime: stat.mtime.toISOString(),
      bytes,
    };
    if (stat.mtimeMs < cutoff) {
      removed.push(item);
      bytesFreed += bytes;
      if (!dry_run) removeWorkerRuntime(dir, workDir);
    } else {
      retained.push(item);
    }
  }

  const result = {
    runtime_dir: runtimeDir,
    workers_dir: workersDir,
    retain_days: Number(retain_days),
    dry_run: Boolean(dry_run),
    removed,
    retained,
    bytes_freed: dry_run ? 0 : bytesFreed,
    bytes_would_free: dry_run ? bytesFreed : undefined,
  };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function previewPrompt(args) {
  const {
    mode = 'implement',
    task_dir: explicitTaskDir,
    working_directory: cwd,
    execution_mode: executionModeInput,
    extra_instructions,
    scope,
    context_files,
    trellis_context_id,
    validation_commands = [],
  } = args;
  const workDir = cwd || process.cwd();
  const executionMode = executionModeInput || defaultExecutionMode(mode);
  let taskDir = explicitTaskDir || resolveActiveTask(workDir, trellis_context_id);
  if (!taskDir && mode !== 'custom' && !extra_instructions) {
    return { content: [{ type: 'text', text: 'No active Trellis task found. Provide task_dir, trellis_context_id, use custom mode, or provide extra_instructions for standalone preview.' }], isError: true };
  }

  let body;
  if (taskDir) {
    const context = assembleTrellisContext(workDir, taskDir, mode);
    body = buildDispatchPrompt({ ...context, mode, execution_mode: executionMode, extra_instructions, scope, validation_commands, context_files: readContextFiles(workDir, context_files) });
  } else {
    body = buildNoTrellisPrompt(mode, extra_instructions, scope, validation_commands, executionMode, readContextFiles(workDir, context_files));
  }
  return { content: [{ type: 'text', text: body }] };
}

// ---- Tool schemas ----

const TOOLS = [
  {
    name: 'dispatch',
    description: 'Dispatch an implementation or check task to Pi. With an active Trellis task, reads implement.jsonl/check.jsonl + prd.md + design.md + implement.md to assemble Pi\'s prompt. Defaults to isolated worktree execution for implement/custom and read-only review for check. Emits Trellis channel events when TRELLIS_CHANNEL (or channel param) is set. Optional post-validation params catch "exit 0 + no work" failures.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['implement', 'check', 'custom'], default: 'implement' },
        task_dir: { type: 'string', description: 'Explicit Trellis task directory (relative to repo root). Omit to auto-resolve.' },
        working_directory: { type: 'string', description: 'Repo root. Defaults to cwd.' },
        model: { type: 'string', description: 'Logical name (implementer / reviewer / custom key from ~/.pi/config.toml [pi_adapter]) or fully qualified Pi route. Omit to use the default for the mode.' },
        thinking: { type: 'string', default: 'high' },
        execution_mode: { type: 'string', enum: ['review', 'patch', 'worktree', 'direct'], description: 'review=read-only report, patch=final-answer diff, worktree=isolated git worktree + exported diff.patch, direct=legacy in-place execution. Defaults to worktree for implement/custom and review for check.' },
        isolate_pi: { type: 'boolean', default: true, description: 'When true, disables Pi extensions/skills/context files/session persistence and uses a per-worker PI_CODING_AGENT_DIR.' },
        tools: { type: 'string', description: 'Comma-separated Pi tools. Defaults by execution_mode: review=read,grep,find,ls; patch=read,bash,grep,find,ls; worktree/direct=read,bash,edit,write,grep,find,ls.' },
        timeout_minutes: { type: 'number', default: 60, description: 'Capped at 120.' },
        dry_run: { type: 'boolean', default: false, description: 'Build prompt without launching Pi.' },
        extra_instructions: { type: 'string' },
        scope: { type: 'string', description: 'File/path constraints stated to Pi.' },
        context_files: { type: 'array', items: { type: 'string' }, description: 'Optional additional files to embed into the prompt. Contents are included only when explicitly requested.' },
        trellis_context_id: { type: 'string', description: 'Optional Trellis session/context id. Passed as TRELLIS_CONTEXT_ID when auto-resolving the active task via task.py current.' },
        validation_commands: { type: 'array', items: { type: 'string' }, description: 'Commands Pi runs before reporting done.' },
        channel: { type: 'string', description: 'Trellis channel name. Overrides TRELLIS_CHANNEL / TRELLIS_CHANNEL_NAME env. When set, message events are emitted into the channel for audit.' },
        min_files_changed: { type: 'number', description: 'Fail if fewer files are modified after Pi exits.' },
        required_paths_modified: { type: 'array', items: { type: 'string' }, description: 'Fail if any path NOT in the diff.' },
        forbidden_paths: { type: 'array', items: { type: 'string' }, description: 'Fail if any path IS in the diff. Trailing / matches directory prefix.' },
        min_diff_lines: { type: 'number', description: 'Fail if total ins+del < N.' },
      },
    },
  },
  {
    name: 'preview_prompt',
    description: 'Preview the prompt that dispatch() would generate, without running Pi.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['implement', 'check', 'custom'], default: 'implement' },
        task_dir: { type: 'string' },
        working_directory: { type: 'string' },
        execution_mode: { type: 'string', enum: ['review', 'patch', 'worktree', 'direct'] },
        extra_instructions: { type: 'string' },
        scope: { type: 'string' },
        context_files: { type: 'array', items: { type: 'string' } },
        trellis_context_id: { type: 'string' },
        validation_commands: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'smoke',
    description: 'Quick smoke test: verify Pi binary and the resolved model are reachable.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Logical name or fully qualified Pi route.' },
        working_directory: { type: 'string' },
      },
    },
  },
  {
    name: 'read_report',
    description: 'Read Pi\'s completion report from report.json/log files or a Trellis/standalone runtime directory.',
    inputSchema: {
      type: 'object',
      properties: {
        log_file: { type: 'string', description: 'Path to Pi output log. report.json is read from the same directory when present.' },
        report_file: { type: 'string', description: 'Path to report.json.' },
        runtime_dir: { type: 'string', description: 'Runtime dir or worker dir. Supports .trellis/.runtime and standalone /tmp/pi-adapter layouts.' },
        worker_id: { type: 'string', description: 'Worker id under <runtime_dir>/pi-workers/<worker-id>.' },
        lines: { type: 'number', default: 200 },
        working_directory: { type: 'string' },
      },
    },
  },
  {
    name: 'cleanup_runtime',
    description: 'Prune old Pi worker runtime directories under .trellis/.runtime/pi-workers or /tmp/pi-adapter/pi-workers.',
    inputSchema: {
      type: 'object',
      properties: {
        working_directory: { type: 'string', description: 'Repo root. Defaults to cwd. Trellis repos use .trellis/.runtime; standalone repos use /tmp/pi-adapter.' },
        retain_days: { type: 'number', default: 7, description: 'Remove worker directories older than this many days. Default 7.' },
        dry_run: { type: 'boolean', default: false, description: 'When true, only reports what would be removed.' },
      },
    },
  },
];

// ---- MCP server ----

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params?.name;
  const args = req.params?.arguments || {};
  switch (name) {
    case 'dispatch':       return await dispatch(args);
    case 'preview_prompt': return previewPrompt(args);
    case 'smoke':          return await smoke(args);
    case 'read_report':    return readReport(args);
    case 'cleanup_runtime': return cleanupRuntime(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
