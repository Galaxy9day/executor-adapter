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
import { spawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// ---- Constants ----

const SERVER_NAME = 'pi-adapter';
const SERVER_VERSION = '0.1.0';  // keep in sync with package.json
const TMP_RUNTIME_DIR = path.join(os.tmpdir(), SERVER_NAME);
const CHANNEL_ENV_ALIASES = ['TRELLIS_CHANNEL', 'TRELLIS_CHANNEL_NAME'];
const TRELLIS_BIN_ENV = 'TRELLIS_BINARY';
const PI_BIN_ENV = 'PI_BINARY';

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

function resolveRuntimeDir(workDir) {
  if (fs.existsSync(path.join(workDir, '.trellis'))) {
    return path.join(workDir, '.trellis', '.runtime');
  }
  return TMP_RUNTIME_DIR;
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

  const sendMessage = await getTrellisCoreSendMessage();
  if (sendMessage) {
    try {
      await sendMessage({
        channel: channelName,
        cwd: workDir,
        by: SERVER_NAME,
        text: `${SERVER_NAME}: ${eventName}`,
        tag: `pi:${eventName}`,
        meta: payload,
      });
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
      '--text', `${SERVER_NAME}: ${eventName}`,
      '--tag', `pi:${eventName}`,
      '--json', JSON.stringify(payload),
    ], { cwd: workDir, stdio: 'ignore', detached: true });
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

// ---- Dispatch lock (only used when no channel is active) ----

const _activeLocks = new Set();

function dispatchLockPath(runtimeDir, taskDir, scope, extraInstructions) {
  const fp = crypto
    .createHash('sha256')
    .update(`${taskDir || ''}|${scope || ''}|${extraInstructions || ''}`)
    .digest('hex')
    .slice(0, 12);
  return path.join(runtimeDir, `${SERVER_NAME}.${fp}.lock`);
}

function acquireDispatchLock(lockPath) {
  if (fs.existsSync(lockPath)) {
    try {
      const content = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      const pid = content.pid;
      if (pid) {
        try { process.kill(pid, 0); return { acquired: false, holder: content }; }
        catch { /* stale, fall through */ }
      }
    } catch { /* malformed, fall through */ }
  }
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }));
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

process.on('exit', cleanupAllLocks);
process.on('SIGINT',  () => { cleanupAllLocks(); process.exit(130); });
process.on('SIGTERM', () => { cleanupAllLocks(); process.exit(143); });

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

function resolveActiveTask(repoRoot) {
  if (!fs.existsSync(path.join(repoRoot, '.trellis'))) return null;
  try {
    const result = execSync(
      `python3 ./.trellis/scripts/task.py current --source`,
      { encoding: 'utf-8', cwd: repoRoot, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
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

function buildDispatchPrompt(args) {
  const { taskDir, artifacts, manifest, manifestFile, mode } = args;
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

  if (scopeConstraint)        p += `\n## Scope Constraint\n\n${scopeConstraint}\n\n`;
  if (extraInstructions)      p += `\n## Additional Instructions\n\n${extraInstructions}\n\n`;
  if (validationCommands.length > 0) {
    p += `\n## Verification Commands\n\nRun these before reporting done:\n\n`;
    for (const cmd of validationCommands) p += `\`\`\`bash\n${cmd}\n\`\`\`\n\n`;
  }
  p += `## Reporting\n\nWhen done, print:\n\n1. List of files created / modified (path only).\n2. Test/lint output (summary line per package).\n3. Any TODO comments left, with file:line.\n4. Any decisions made that weren't covered in spec or PRD.\n`;
  return p;
}

function buildNoTrellisPrompt(mode, extraInstructions, scope, validationCommands) {
  const modeLabel = mode === 'check' ? 'Quality Check' : 'Implementation';
  let p = `# Pi Dispatch: ${modeLabel} (no Trellis)\n\n`;
  if (mode === 'implement') {
    p += `You are the implementation executor. The main Agent will review your output.\n\n**Guards**:\n- Do NOT git commit.\n- Do NOT spawn other agents.\n\n`;
  } else if (mode === 'check') {
    p += `You are the quality check executor. Review all code changes. Fix issues directly.\n\n**Guards**:\n- Do NOT git commit.\n- Do NOT spawn other agents.\n\n`;
  }
  p += `## Task\n\n${extraInstructions}\n\n`;
  if (scope) p += `## Scope Constraint\n\n${scope}\n\n`;
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

// ---- Tool implementations ----

async function dispatch(args) {
  const {
    mode = 'implement',
    task_dir: explicitTaskDir,
    working_directory: cwd,
    model: modelInput,
    thinking = 'high',
    tools = 'read,bash,edit,write,grep,find,ls',
    timeout_minutes: timeoutInput = 60,
    dry_run = false,
    extra_instructions,
    scope,
    validation_commands = [],
    min_files_changed,
    required_paths_modified,
    forbidden_paths,
    min_diff_lines,
  } = args;

  const timeout_minutes = Math.min(timeoutInput, 120);
  const workDir = cwd || process.cwd();
  const channelName = detectChannel(args, process.env);
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
    taskDir = resolveActiveTask(workDir);
  }

  let context = null;
  let promptBody = '';
  if (taskDir) {
    context = assembleTrellisContext(workDir, taskDir, mode);
    promptBody = buildDispatchPrompt({ ...context, mode, extra_instructions, scope, validation_commands });
  } else if (mode === 'custom') {
    if (!extra_instructions) return { content: [{ type: 'text', text: 'Error: custom mode requires extra_instructions.' }], isError: true };
    promptBody = extra_instructions;
  } else {
    if (!extra_instructions) {
      return {
        content: [{ type: 'text', text: 'No active Trellis task found. Either:\n1. Use a Trellis project with an active task\n2. Provide task_dir explicitly\n3. Use mode="custom" with extra_instructions\n4. Provide extra_instructions to describe the task.' }],
        isError: true,
      };
    }
    promptBody = buildNoTrellisPrompt(mode, extra_instructions, scope, validation_commands);
  }

  const runtimeDir = resolveRuntimeDir(workDir);
  fs.mkdirSync(runtimeDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const promptPath = path.join(runtimeDir, `pi-${mode}-${ts}-prompt.md`);
  const logPath = path.join(runtimeDir, `pi-${mode}-${ts}-output.log`);
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
  metaResponse += `Model: ${model} (${modelFrom}${modelKey ? `:${modelKey}` : ''}, thinking: ${thinking})\n`;
  metaResponse += `Timeout: ${timeout_minutes} min\n`;
  metaResponse += `Channel: ${channelName || '(none, local mode)'}\n`;

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
  if (!channelName) {
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
  }

  await emitChannelEvent(channelName, 'dispatch_start', {
    mode, task: taskDir, scope: scope || null, model,
    prompt_file: promptPath, log_file: logPath,
    started_at: new Date().toISOString(),
  }, workDir);

  return new Promise((resolve) => {
    const piArgs = [
      '--model', model,
      '--tools', tools,
      '--thinking', thinking,
      `@${promptPath}`,
      '-p', 'Follow the instructions in the attached file. Read the listed files in order before writing any code.',
    ];

    const timeout = timeout_minutes * 60 * 1000;
    let killed = false;
    const stdoutBuf = makeHeadTailBuffer();
    const stderrBuf = makeHeadTailBuffer(2 * 1024, 8 * 1024);

    const proc = spawn(piBin, piArgs, {
      cwd: workDir,
      env: piEnv,
      // Pi's -p mode blocks on stdin EOF if stdin is a live pipe.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (d) => stdoutBuf.push(d.toString()));
    proc.stderr.on('data', (d) => stderrBuf.push(d.toString()));

    const logStream = fs.createWriteStream(logPath, { flags: 'w' });
    proc.stdout.pipe(logStream);
    proc.stderr.pipe(logStream);

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeout);

    proc.on('close', async (code) => {
      clearTimeout(timer);
      logStream.close();
      if (lockPath) releaseDispatchLock(lockPath);

      const exitCode = code || 0;
      const validation = runPostValidation(workDir, {
        min_files_changed, required_paths_modified, forbidden_paths, min_diff_lines,
      });

      const ok = exitCode === 0 && validation.passed && !killed;
      await emitChannelEvent(channelName, ok ? 'dispatch_done' : 'dispatch_failed', {
        mode, task: taskDir,
        exit_code: exitCode, killed,
        validation: validation.skipped ? 'skipped' : (validation.passed ? 'passed' : 'failed'),
        validation_failures: validation.failures || [],
        changed_files: validation.changedFiles || [],
        finished_at: new Date().toISOString(),
      }, workDir);

      const stdout = stdoutBuf.finalize();
      const stderr = stderrBuf.finalize();
      let output = '';
      if (stdout.trim()) output += stdout.trim();
      if (stderr.trim()) output += (output ? '\n\n--- stderr ---\n' : '') + stderr.trim();
      if (killed) output += `\n\n[PROCESS KILLED: exceeded ${timeout_minutes} minute timeout]`;

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

      const isError = (exitCode !== 0 && !killed) || (!validation.skipped && !validation.passed);
      resolve({
        content: [{
          type: 'text',
          text: `${metaResponse}\nPi exited with code ${exitCode}.\n${validationBlock}\n--- output (head + tail) ---\n\n${output}`,
        }],
        isError,
      });
    });

    proc.on('error', async (err) => {
      clearTimeout(timer);
      logStream.close();
      if (lockPath) releaseDispatchLock(lockPath);
      await emitChannelEvent(channelName, 'spawn_error', {
        mode, task: taskDir, error: err.message, finished_at: new Date().toISOString(),
      }, workDir);
      resolve({
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

  return new Promise((resolve) => {
    const proc = spawn(piBin, [
      '--model', model,
      '--tools', 'read',
      '-p', 'Respond with exactly the string: PI READY. No other words.',
    ], { cwd: working_directory || process.cwd(), env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGTERM'), 60000);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const ready = stdout.includes('PI READY');
      resolve({
        content: [{
          type: 'text',
          text: `Pi smoke: ${ready ? 'PASSED' : 'FAILED'} | model=${model} (${modelFrom}${modelKey ? `:${modelKey}` : ''}) | exit=${code}\nOutput: ${(stdout || stderr).trim().slice(0, 500)}`,
        }],
        isError: !ready,
      });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
    });
  });
}

function readReport(args) {
  const { log_file, working_directory, lines = 200 } = args;
  if (!log_file) return { content: [{ type: 'text', text: 'Error: log_file is required.' }], isError: true };
  const resolved = resolvePath(log_file, working_directory);
  if (!fs.existsSync(resolved)) return { content: [{ type: 'text', text: `Log not found: ${resolved}` }], isError: true };
  try {
    const content = execSync(`tail -${lines} "${resolved}"`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    return { content: [{ type: 'text', text: `--- ${resolved} (last ${lines} lines) ---\n\n${content}` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
}

function previewPrompt(args) {
  const {
    mode = 'implement',
    task_dir: explicitTaskDir,
    working_directory: cwd,
    extra_instructions,
    scope,
    validation_commands = [],
  } = args;
  const workDir = cwd || process.cwd();
  let taskDir = explicitTaskDir || resolveActiveTask(workDir);
  if (!taskDir && mode !== 'custom') return { content: [{ type: 'text', text: 'No active Trellis task found.' }], isError: true };

  let body;
  if (taskDir) {
    const context = assembleTrellisContext(workDir, taskDir, mode);
    body = buildDispatchPrompt({ ...context, mode, extra_instructions, scope, validation_commands });
  } else {
    body = buildNoTrellisPrompt(mode, extra_instructions, scope, validation_commands);
  }
  return { content: [{ type: 'text', text: body }] };
}

// ---- Tool schemas ----

const TOOLS = [
  {
    name: 'dispatch',
    description: 'Dispatch an implementation or check task to Pi. With an active Trellis task, reads implement.jsonl/check.jsonl + prd.md + design.md + implement.md to assemble Pi\'s prompt. When TRELLIS_CHANNEL (or channel param) is set, emits message events into the channel and skips the local dispatch lock. Optional post-validation params catch "exit 0 + no work" failures.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['implement', 'check', 'custom'], default: 'implement' },
        task_dir: { type: 'string', description: 'Explicit Trellis task directory (relative to repo root). Omit to auto-resolve.' },
        working_directory: { type: 'string', description: 'Repo root. Defaults to cwd.' },
        model: { type: 'string', description: 'Logical name (implementer / reviewer / custom key from ~/.pi/config.toml [pi_adapter]) or fully qualified Pi route. Omit to use the default for the mode.' },
        thinking: { type: 'string', default: 'high' },
        tools: { type: 'string', default: 'read,bash,edit,write,grep,find,ls' },
        timeout_minutes: { type: 'number', default: 60, description: 'Capped at 120.' },
        dry_run: { type: 'boolean', default: false, description: 'Build prompt without launching Pi.' },
        extra_instructions: { type: 'string' },
        scope: { type: 'string', description: 'File/path constraints stated to Pi.' },
        validation_commands: { type: 'array', items: { type: 'string' }, description: 'Commands Pi runs before reporting done.' },
        channel: { type: 'string', description: 'Trellis channel name. Overrides TRELLIS_CHANNEL / TRELLIS_CHANNEL_NAME env. When set, lock is skipped and message events are emitted.' },
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
        extra_instructions: { type: 'string' },
        scope: { type: 'string' },
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
    description: 'Read Pi\'s completion report from an output log file.',
    inputSchema: {
      type: 'object',
      properties: {
        log_file: { type: 'string', description: 'Path to Pi output log' },
        lines: { type: 'number', default: 200 },
        working_directory: { type: 'string' },
      },
      required: ['log_file'],
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
    default: throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
