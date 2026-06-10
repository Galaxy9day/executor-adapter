/**
 * Executor backends for pi-adapter.
 *
 * Each executor describes how to discover its binary, scrub the child
 * environment, resolve models from ~/.pi/config.toml, build spawn argv,
 * and interpret subprocess output into the adapter's shared result model.
 * Everything downstream (worktree, diff export, post-validation,
 * result_class, channel events) is executor-agnostic and lives in index.js.
 */

import TOML from '@iarna/toml';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const SERVER_NAME = 'pi-adapter';

function logErr(msg) {
  process.stderr.write(`[${SERVER_NAME}] ${msg}\n`);
}

// ---- Adapter config (single source of truth for models + executor routing) ----

let _configCache = null;
export function loadAdapterConfig() {
  const cfgPath = path.join(os.homedir(), '.pi', 'config.toml');
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(cfgPath).mtimeMs;
  } catch {}
  if (
    _configCache &&
    _configCache.cfgPath === cfgPath &&
    _configCache.mtimeMs === mtimeMs
  ) {
    return _configCache.config;
  }

  let raw = null;
  try {
    if (mtimeMs !== null) raw = fs.readFileSync(cfgPath, 'utf-8');
  } catch {}
  const config = { pi: {}, codex: {}, defaultExecutor: null };
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
          if (k === 'default_executor') {
            if (config.defaultExecutor === null) config.defaultExecutor = v;
            continue;
          }
          if (!(k in config.pi)) {
            config.pi[k] = v;
            if (section === parsed.trellis_pi_adapter) legacyUsed = true;
          }
        }
        const codexSection = section.codex;
        if (codexSection && typeof codexSection === 'object' && !Array.isArray(codexSection)) {
          for (const [k, v] of Object.entries(codexSection)) {
            if (typeof v !== 'string') continue;
            if (!(k in config.codex)) config.codex[k] = v;
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
  logErr(`reloaded model map from ${cfgPath} mtime=${mtimeMs === null ? 'missing' : mtimeMs}`);
  _configCache = { cfgPath, mtimeMs, config };
  return config;
}

export class ModelResolutionError extends Error {
  constructor(logicalKey) {
    super(`Cannot resolve model "${logicalKey}". Configure ~/.pi/config.toml:\n\n  [pi_adapter]\n  implementer = "<your-pi-routable-model>"   # required for mode=implement|custom\n  reviewer    = "<your-pi-routable-model>"   # required for mode=check / cross-model review\n\nOr pass a fully qualified route directly, e.g. model="anthropic/claude-opus-4-7".`);
    this.code = 'MODEL_NOT_RESOLVED';
    this.logicalKey = logicalKey;
  }
}

// ---- Shared subprocess helpers ----

// Explicit env override is authoritative: a configured-but-missing path is an
// error, not a trigger for silent PATH fallback.
function makeBinaryFinder(envVar, command) {
  let cached;
  return function findBinary() {
    if (cached !== undefined) return cached;
    const fromEnv = process.env[envVar];
    if (fromEnv) {
      cached = fs.existsSync(fromEnv) ? fromEnv : null;
      return cached;
    }
    try { cached = execSync(`which ${command}`, { encoding: 'utf-8' }).trim() || null; }
    catch { cached = null; }
    return cached;
  };
}

const SENSITIVE = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE.?KEY|API.?KEY|_KEY$|_AUTH$|_BEARER$|_COOKIE$|^ANTHROPIC_|^OPENAI_|^CLAUDE_|^CCG_|^AWS_(ACCESS|SECRET)|^GH_TOKEN$|^GITHUB_TOKEN$|^OP_|^DOCKER_PASS/i;

function scrubEnv(parentEnv, keepPattern) {
  const out = {};
  const stripped = [];
  for (const [k, v] of Object.entries(parentEnv)) {
    if (keepPattern.test(k)) { out[k] = v; continue; }
    if (SENSITIVE.test(k)) { stripped.push(k); continue; }
    out[k] = v;
  }
  return { env: out, stripped };
}

function approvalBlocked(text) {
  const t = text || '';
  return /approval|approve|permission|confirm|non[- ]interactive|no ui|stdin|tty/i.test(t) &&
    /blocked|required|waiting|denied|refused|unavailable|cannot|can't|failed/i.test(t);
}

function codexSandbox(executionMode) {
  return (executionMode === 'review' || executionMode === 'patch') ? 'read-only' : 'workspace-write';
}

// ---- Executor: pi ----

const pi = {
  name: 'pi',
  label: 'Pi',
  binaryEnvVar: 'PI_BINARY',
  findBinary: makeBinaryFinder('PI_BINARY', 'pi'),

  buildEnv(parentEnv) {
    return scrubEnv(parentEnv, /^(PI_|NEWAPI_)/);
  },

  resolveModel(input, mode) {
    const defaultKey = mode === 'check' ? 'reviewer' : 'implementer';
    const logicalKey = input || defaultKey;
    const map = loadAdapterConfig().pi;
    if (map[logicalKey]) return { resolved: map[logicalKey], from: 'config', key: logicalKey };
    // Fully qualified route (contains '/') — pass through.
    if (logicalKey.includes('/')) return { resolved: logicalKey, from: 'direct', key: null };
    // Unresolved: throw. No silent fallback — that would leak whichever
    // model name was vendored into the source onto users of the package.
    throw new ModelResolutionError(logicalKey);
  },

  buildSpawnSpec({ model, tools, thinking, isolate, promptPath, worker }) {
    return {
      argv: [
        '--model', model,
        '--tools', tools,
        '--thinking', thinking,
        ...(isolate ? [
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-context-files',
          '--no-session',
        ] : []),
        `@${promptPath}`,
        '-p', 'Follow the instructions in the attached file. Read the listed files in order before writing any code.',
      ],
      env: {
        PI_CODING_AGENT_DIR: worker.piHome,
        PI_CODING_AGENT_SESSION_DIR: worker.sessionDir,
        PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1',
      },
      // Pi's -p mode blocks on stdin EOF if stdin is a live pipe.
      stdinFd: null,
    };
  },

  interpretOutput({ exitCode, killed, stdout, stderr }) {
    let output = '';
    if (String(stdout || '').trim()) output += stdout.trim();
    if (String(stderr || '').trim()) output += (output ? '\n\n--- stderr ---\n' : '') + stderr.trim();
    let runStatus;
    if (killed) runStatus = 'timeout';
    else if (approvalBlocked(output)) runStatus = 'blocked';
    else runStatus = exitCode === 0 ? 'done' : 'failed';
    return { runStatus, output, usage: null };
  },

  failureHint(stderr, stdout) {
    const combined = `${stderr || ''}\n${stdout || ''}`;
    const noKey = combined.match(/No API key found for\s+([^\s"'`.,;]+)/i);
    if (noKey) {
      const provider = noKey[1];
      return `Pi resolved to built-in provider '${provider}'. If you intended a custom provider, pass \`model="gpt/gpt-5.5"\` (fully qualified) or restart the MCP after editing ~/.pi/config.toml.`;
    }
    if (/stream_read_error|Stream ended/i.test(combined)) {
      return 'Upstream SSE stream failed. Common causes: very large prompt, network reset, provider rate limit. Try reducing implement.jsonl manifest size or switching to openai-completions-compatible provider.';
    }
    return '';
  },

  smokeSpec(model) {
    return {
      argv: [
        '--model', model,
        '--tools', 'read',
        '-p', 'Respond with exactly the string: PI READY. No other words.',
      ],
      readyText: 'PI READY',
    };
  },
};

// ---- Executor: codex ----

const codex = {
  name: 'codex',
  label: 'Codex',
  binaryEnvVar: 'CODEX_BINARY',
  findBinary: makeBinaryFinder('CODEX_BINARY', 'codex'),
  sandboxFor: codexSandbox,

  buildEnv(parentEnv) {
    // Codex authenticates via ~/.codex/auth.json (saved `codex login`);
    // API keys are deliberately not forwarded. Keep only Codex state-location
    // variables so users can point the subprocess at a dedicated auth home.
    return scrubEnv(parentEnv, /^CODEX_(HOME|SQLITE_HOME)$/);
  },

  resolveModel(input, mode) {
    const defaultKey = mode === 'check' ? 'reviewer' : 'implementer';
    const map = loadAdapterConfig().codex;
    const logicalKey = input || defaultKey;
    if (map[logicalKey]) return { resolved: map[logicalKey], from: 'config', key: logicalKey };
    if (input) return { resolved: input, from: 'direct', key: null };
    // No config and no explicit model: defer to the codex CLI's own
    // configured default model. Not an error.
    return { resolved: null, from: 'codex-default', key: null };
  },

  buildSpawnSpec({ model, thinking, isolate, executionMode, promptPath, worker }) {
    const sandbox = codexSandbox(executionMode);
    return {
      argv: [
        'exec', '--json',
        '-c', 'approval_policy="never"',
        '--sandbox', sandbox,
        ...(model ? ['-m', model] : []),
        ...(thinking ? ['-c', `model_reasoning_effort="${thinking}"`] : []),
        ...(isolate ? ['--ignore-user-config', '--ignore-rules', '--ephemeral'] : []),
        '-o', worker.lastMessagePath,
        '-',
      ],
      env: {},
      // '-' makes codex read the prompt from stdin; the caller wires this fd
      // as stdio[0] and closes it after spawn.
      stdinFd: fs.openSync(promptPath, 'r'),
      sandbox,
    };
  },

  interpretOutput({ exitCode, killed, stdout, stderr, worker }) {
    let lastMessage = '';
    let usage = null;
    const errors = [];
    for (const line of String(stdout || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try { event = JSON.parse(trimmed); } catch { continue; }
      if (!event || typeof event !== 'object') continue;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        lastMessage = event.item.text;
      } else if (event.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
        usage = event.usage;
      } else if (event.type === 'turn.failed' || event.type === 'error') {
        const msg = event.message || event.error?.message || JSON.stringify(event);
        errors.push(`${event.type}: ${msg}`);
      }
      // Unknown event types are ignored on purpose (forward compatibility).
    }
    if (worker?.lastMessagePath) {
      try {
        const fromFile = fs.readFileSync(worker.lastMessagePath, 'utf-8').trim();
        if (fromFile) lastMessage = fromFile;
      } catch {}
    }
    let output = lastMessage;
    if (errors.length > 0) output += (output ? '\n\n' : '') + errors.join('\n');
    if (String(stderr || '').trim()) output += (output ? '\n\n--- stderr ---\n' : '') + stderr.trim();
    let runStatus;
    if (killed) runStatus = 'timeout';
    else if (approvalBlocked(output)) runStatus = 'blocked';
    else if (errors.length > 0 || exitCode !== 0) runStatus = 'failed';
    else runStatus = 'done';
    return { runStatus, output, usage };
  },

  failureHint(stderr, stdout) {
    const combined = `${stderr || ''}\n${stdout || ''}`;
    if (/not logged in|login required|run codex login/i.test(combined)) {
      return 'Codex is not authenticated. Run `codex login` once (auth is read from ~/.codex/auth.json; API keys are not forwarded to the subprocess).';
    }
    if (/model .*(not found|not supported)|unknown model/i.test(combined)) {
      return 'Codex rejected the model name. Check the `-m` value or the [pi_adapter.codex] section in ~/.pi/config.toml; omit model to use the codex CLI default.';
    }
    if (/sandbox|seatbelt|landlock|permission denied/i.test(combined)) {
      return 'The codex OS sandbox blocked an operation. Check whether the execution_mode→sandbox mapping (review/patch=read-only, worktree/direct=workspace-write) matches what the task needs.';
    }
    return '';
  },

  smokeSpec(model) {
    return {
      argv: [
        'exec', '--json',
        '--sandbox', 'read-only',
        '-c', 'approval_policy="never"',
        ...(model ? ['-m', model] : []),
        'Respond with exactly the string: CODEX READY. No other words.',
      ],
      readyText: 'CODEX READY',
    };
  },
};

export const EXECUTORS = { pi, codex };

// Routing: explicit param > config default_executor > mode-based default.
// implement/custom default to codex (native GPT harness + OS sandbox);
// check defaults to pi (cross-model review needs Pi's provider routing).
export function resolveExecutor(explicit, mode) {
  const pick = explicit || loadAdapterConfig().defaultExecutor;
  if (pick) {
    if (!EXECUTORS[pick]) {
      throw new Error(`Unknown executor "${pick}". Use "pi" or "codex" (dispatch param or [pi_adapter] default_executor in ~/.pi/config.toml).`);
    }
    return pick;
  }
  return mode === 'check' ? 'pi' : 'codex';
}
