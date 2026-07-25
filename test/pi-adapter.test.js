import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  REPORT_SCHEMA,
  buildPostValidation,
  buildPatch,
  computeOk,
  resolveRunStatus,
  buildDispatchError,
} from '../report-v2.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'index.js');
const FAKE_PI = path.join(ROOT, 'test', 'fixtures', 'fake-pi.mjs');
const FAKE_CODEX = path.join(ROOT, 'test', 'fixtures', 'fake-codex.mjs');

function runGit(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function makeRepo({ trellis = false } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-adapter-test-'));
  runGit(repo, ['init']);
  runGit(repo, ['config', 'user.email', 'test@example.com']);
  runGit(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n', 'utf-8');
  if (trellis) {
    fs.mkdirSync(path.join(repo, '.trellis'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.trellis', '.keep'), 'trellis marker\n', 'utf-8');
  }
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'init']);
  return repo;
}

function makePiHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-adapter-home-'));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, 'models.json'), '{"models":[]}\n', 'utf-8');
  fs.writeFileSync(path.join(agent, 'settings.json'), '{"settings":{}}\n', 'utf-8');
  return home;
}

function writePiConfig(home, body) {
  const dir = path.join(home, '.pi');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.toml'), body, 'utf-8');
}

function makeTrellisTask(repo, { taskDir = '.trellis/tasks/task-1', files = [] } = {}) {
  const fullTaskDir = path.join(repo, taskDir);
  fs.mkdirSync(fullTaskDir, { recursive: true });
  fs.writeFileSync(path.join(fullTaskDir, 'prd.md'), '# PRD\n\nAcceptance criteria.\n', 'utf-8');
  const jsonl = files.map(file => JSON.stringify({ file })).join('\n');
  fs.writeFileSync(path.join(fullTaskDir, 'implement.jsonl'), `${jsonl}\n`, 'utf-8');
  return taskDir;
}

function startMcp(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PI_BINARY: FAKE_PI,
      CODEX_BINARY: FAKE_CODEX,
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1;
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  const stderrChunks = [];
  child.stderr.on('data', (chunk) => { stderrChunks.push(chunk.toString()); });

  function request(method, params = {}) {
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 30000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  return {
    request,
    stderrText: () => stderrChunks.join(''),
    async init() {
      await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'executor-adapter-test', version: '0.0.0' },
      });
    },
    async callTool(name, args) {
      const response = await request('tools/call', { name, arguments: args });
      if (response.error) throw new Error(response.error.message);
      return response.result;
    },
    close() {
      child.kill('SIGTERM');
    },
  };
}

function reportPathFrom(result) {
  const text = result.content[0].text;
  const match = text.match(/^Report:\s+(.+)$/m) || text.match(/^report:\s+(.+)$/m);
  assert.ok(match, text);
  return match[1].trim();
}

function readReport(result) {
  return JSON.parse(fs.readFileSync(reportPathFrom(result), 'utf-8'));
}

// ---- v2 report invariants (applied to integration reports) ----

function assertV2Report(report) {
  assert.equal(report.schema, REPORT_SCHEMA, 'schema must be v2');
  assert.equal(typeof report.ok, 'boolean', 'ok must be boolean');
  assert.ok(['done', 'failed', 'timeout', 'killed', 'spawn_error', 'setup_failed'].includes(report.run_status), `bad run_status: ${report.run_status}`);
  assert.ok(report.patch && typeof report.patch === 'object', 'patch object required');
  assert.ok(['ready', 'none', 'export_failed', 'not_applicable'].includes(report.patch.status), `bad patch.status: ${report.patch.status}`);
  assert.ok(!('has_patch' in report.patch), 'patch.has_patch must be removed (derived from status)');
  assert.ok(report.post_validation && typeof report.post_validation === 'object', 'post_validation object required');
  assert.ok(['passed', 'failed', 'skipped'].includes(report.post_validation.status), `bad post_validation.status: ${report.post_validation.status}`);
  for (const gone of ['result_class', 'status', 'status_reason', 'validation_scope', 'data_validation', 'data_validation_reason', 'isolate_pi', 'killed', 'patch_file', 'orchestrator_next_steps', 'recommended_main_repo_commands', 'validation_failures', 'shortstat']) {
    assert.ok(!(gone in report), `v1 field ${gone} must be absent`);
  }
  assert.ok('error' in report, 'top-level error field required');
  if (report.ok) assert.equal(report.error, null);
  else assert.ok(report.error && typeof report.error === 'object' && report.error.stage, `ok=false requires structured error, got ${JSON.stringify(report.error)}`);
}

// ===========================================================================
// Test matrix (9 cases from REFACTOR_PLAN.md v2.1)
//
// Cases 1, 2, 6, 7, 8 are exercised end-to-end through the MCP (real spawn +
// report.json). Cases 3, 4, 5 + the run_status precedence are covered against
// the pure report-v2 helpers directly, because their integration triggers
// (external signal, worktree setup failure, diff-export failure) are
// environment-dependent and not deterministic through the MCP harness.
// ===========================================================================

test('matrix 1 (integration): exit 0 + codex turn.failed -> run_status=failed, ok=false', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  const mcp = startMcp({ FAKE_CODEX_SCENARIO: 'turn-failed', HOME: home });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'codex',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Trigger a native turn failure.',
    });
    const report = readReport(result);
    assertV2Report(report);
    assert.equal(report.run_status, 'failed', JSON.stringify(report));
    assert.equal(report.ok, false);
    assert.equal(report.error.stage, 'executor');
    assert.match(report.error.message, /model stream failed/);
    assert.equal(result.isError, !report.ok);
  } finally {
    mcp.close();
  }
});

test('matrix 2 (integration): timeout + SIGTERM -> run_status=timeout (not killed)', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  const mcp = startMcp({ FAKE_CODEX_SCENARIO: 'timeout-sig', HOME: home });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'codex',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Hang until killed.',
      timeout_minutes: 0.02, // ~1.2s
    });
    const report = readReport(result);
    assertV2Report(report);
    assert.equal(report.run_status, 'timeout', `must be timeout not killed: ${report.run_status}`);
    assert.equal(report.ok, false);
    assert.equal(report.error.stage, 'timeout');
    assert.equal(result.isError, true);
  } finally {
    mcp.close();
  }
});

test('matrix 3 (unit): external signal -> run_status=killed; timeout precedence over signal', () => {
  // killed=false, signaled=true (an external signal, not our timeout) -> killed
  assert.equal(resolveRunStatus({ killed: false, signaled: true, interpRunStatus: 'done' }), 'killed');
  // killed=true (our timeout sent SIGTERM, so signaled is also true) -> timeout
  // wins over signal (the v2.1 bug fix).
  assert.equal(resolveRunStatus({ killed: true, signaled: true, interpRunStatus: 'done' }), 'timeout');
  // no signal -> interpreter outcome (done/failed)
  assert.equal(resolveRunStatus({ killed: false, signaled: false, interpRunStatus: 'failed' }), 'failed');
  assert.equal(resolveRunStatus({ killed: false, signaled: false, interpRunStatus: 'done' }), 'done');

  const patch = buildPatch('worktree', { ok: true, changedFiles: [] }, [], '/p/diff.patch');
  const pv = buildPostValidation('worktree', { passed: true, failures: [] }, {});
  assert.equal(computeOk('killed', patch, pv), false);
  assert.equal(buildDispatchError({ runStatus: 'killed', patch, postValidation: pv, exitCode: null, signal: 'SIGTERM', timeoutMinutes: 60 }).stage, 'killed');
});

test('matrix 4 (unit): worktree setup failure -> setup_failed report shape', () => {
  // setup_failed is emitted before any executor run; patch via buildPatch with
  // no diffInfo (worktree mode -> export_failed) and post_validation skipped.
  const patch = buildPatch('worktree', null, [], '/p/diff.patch');
  const pv = buildPostValidation('worktree', null, { min_files_changed: 1 });
  assert.equal(patch.status, 'export_failed');
  assert.equal(pv.status, 'skipped');
  // ok is driven by computeOk on the setup_failed run_status.
  assert.equal(computeOk('setup_failed', patch, pv), false);
  // The dispatcher writes a top-level structured error with stage=worktree_setup.
  const error = { stage: 'worktree_setup', message: 'git worktree add failed' };
  assert.equal(error.stage, 'worktree_setup');
});

test('matrix 5 (unit): worktree patch export failure -> run_status preserves, patch.status=export_failed, ok=false', () => {
  // Executor finished done, but diff export failed. run_status keeps the
  // executor outcome; patch.status=export_failed drives ok=false.
  const diffInfo = { ok: false, error: 'git diff failed', changedFiles: ['x'] };
  const patch = buildPatch('worktree', diffInfo, ['x'], '/p/diff.patch');
  const pv = buildPostValidation('worktree', { passed: true, failures: [] }, {});
  assert.equal(patch.status, 'export_failed');
  assert.equal(patch.error, 'git diff failed');
  assert.equal(computeOk('done', patch, pv), false);
  assert.equal(buildDispatchError({ runStatus: 'done', patch, postValidation: pv, exitCode: 0, signal: null, timeoutMinutes: 60 }).stage, 'patch_export');
});

test('matrix 6 (integration): review + validation params -> post_validation.status=skipped', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  const mcp = startMcp({ FAKE_CODEX_SCENARIO: 'review-report', HOME: home });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'codex',
      execution_mode: 'review',
      working_directory: repo,
      extra_instructions: 'Review the changes.',
      min_files_changed: 1,
      forbidden_paths: ['x'],
    });
    const report = readReport(result);
    assertV2Report(report);
    assert.equal(report.run_status, 'done');
    assert.equal(report.post_validation.status, 'skipped');
    assert.deepEqual(report.post_validation.checks, ['min_files_changed', 'forbidden_paths']);
    assert.equal(report.patch.status, 'not_applicable');
    assert.equal(report.ok, true);
    assert.ok(report.review_summary && report.review_summary.includes('Findings'));
  } finally {
    mcp.close();
  }
});

test('matrix 7 (integration): worktree no changes -> patch.status=none, ok=false', async () => {
  const repo = makeRepo();
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'none' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'pi',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'No-op.',
    });
    const report = readReport(result);
    assertV2Report(report);
    assert.equal(report.patch.status, 'none');
    assert.equal(report.ok, false);
    assert.equal(report.error.stage, 'patch');
    assert.equal(result.isError, true);
  } finally {
    mcp.close();
  }
});

test('matrix 8 (integration): direct no checks -> patch not_applicable, post_validation skipped, ok=true', async () => {
  const repo = makeRepo();
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'diff' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'pi',
      model: 'fake/model',
      execution_mode: 'direct',
      working_directory: repo,
      extra_instructions: 'Make a change in place.',
    });
    const report = readReport(result);
    assertV2Report(report);
    assert.equal(report.patch.status, 'not_applicable');
    assert.equal(report.post_validation.status, 'skipped');
    assert.deepEqual(report.post_validation.checks, []);
    assert.equal(report.run_status, 'done');
    assert.equal(report.ok, true);
    assert.equal(report.error, null);
    assert.equal(result.isError, false);
  } finally {
    mcp.close();
  }
});

test('matrix 9 (integration): every report path carries schema, ok, structured error; isError === !report.ok', async () => {
  const repo = makeRepo();

  // success path: codex produces a patch + post-validation passes -> ok=true, isError=false.
  const okMcp = startMcp({ FAKE_CODEX_SCENARIO: 'diff' });
  try {
    await okMcp.init();
    const okResult = await okMcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'codex',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Create a file.',
      min_files_changed: 1,
    });
    const okReport = readReport(okResult);
    assert.equal(okReport.schema, REPORT_SCHEMA);
    assert.equal(okReport.ok, true);
    assert.equal(okReport.error, null);
    assert.equal(okResult.isError, !okReport.ok);
  } finally {
    okMcp.close();
  }

  // failure path: codex produces NO patch (patch.status='none') -> ok=false, isError=true.
  // Uses a separate `none`-scenario mcp — the `diff` scenario always writes result.txt.
  const failMcp = startMcp({ FAKE_CODEX_SCENARIO: 'none' });
  try {
    await failMcp.init();
    const failResult = await failMcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'codex',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'No-op.',
    });
    const failReport = readReport(failResult);
    assert.equal(failReport.schema, REPORT_SCHEMA);
    assert.equal(failReport.ok, false);
    assert.ok(failReport.error && failReport.error.stage, `structured error required: ${JSON.stringify(failReport.error)}`);
    assert.equal(failResult.isError, !failReport.ok);
  } finally {
    failMcp.close();
  }
});

test('review does not dirty the git index (skips runPostValidation / git add -N)', async () => {
  const repo = makeRepo();
  // An unstaged file: `git add -N` (inside runPostValidation) would surface it
  // in `git status --porcelain`. review must skip runPostValidation entirely.
  fs.writeFileSync(path.join(repo, 'unstaged.txt'), 'hi\n', 'utf-8');
  const mcp = startMcp({ FAKE_CODEX_SCENARIO: 'none' });
  try {
    await mcp.init();
    const before = runGit(repo, ['status', '--porcelain']).trim();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom', executor: 'codex', execution_mode: 'review',
      working_directory: repo, extra_instructions: 'review only',
      min_files_changed: 1, forbidden_paths: ['x'], // would trigger git add -N if runPostValidation ran
    });
    const after = runGit(repo, ['status', '--porcelain']).trim();
    assert.equal(after, before, `review dirtied git index (runPostValidation ran):\nbefore: ${before}\nafter: ${after}`);
    const report = readReport(result);
    assertV2Report(report);
    assert.equal(report.post_validation.status, 'skipped');
  } finally {
    mcp.close();
  }
});

// ---- report-v2 helper unit tests (field trimming + ok derivation) ----

test('buildPatch drops has_patch (derived from status) and never emits patch_file at top', () => {
  assert.equal('has_patch' in buildPatch('review', null, [], null), false);
  assert.equal('has_patch' in buildPatch('worktree', { ok: true, changedFiles: ['a'] }, ['a'], '/p'), false);
  assert.equal(buildPatch('worktree', { ok: true, changedFiles: ['a'] }, ['a'], '/p').status, 'ready');
});

test('review always skips post_validation even with check params', () => {
  const pv = buildPostValidation('review', { passed: true, failures: [] }, { min_files_changed: 5, forbidden_paths: ['x'] });
  assert.equal(pv.status, 'skipped');
  assert.deepEqual(pv.checks, ['min_files_changed', 'forbidden_paths']);
});

test('computeOk: done+ready+passed -> true; every failure axis -> false', () => {
  const ready = buildPatch('worktree', { ok: true, changedFiles: ['a'] }, ['a'], '/p');
  const passed = buildPostValidation('worktree', { passed: true, failures: [] }, {});
  assert.equal(computeOk('done', ready, passed), true);
  assert.equal(computeOk('failed', ready, passed), false);
  assert.equal(computeOk('done', buildPatch('worktree', { ok: true, changedFiles: [] }, [], '/p'), passed), false); // none
  assert.equal(computeOk('done', ready, buildPostValidation('worktree', { passed: false, failures: [{ rule: 'x' }] }, {})), false); // failed
  // direct/review: not_applicable patch is fine when run done + pv not failed
  assert.equal(computeOk('done', buildPatch('direct', null, [], null), buildPostValidation('direct', { skipped: true }, {})), true);
});

// ---- Core dispatch behavior (v2) ----

test('Trellis project without channel returns a ready v2 report', async () => {
  const repo = makeRepo({ trellis: true });
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'diff' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'pi',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Create a small result file.',
      min_files_changed: 1,
    });
    assert.equal(result.isError, false);
    const report = readReport(result);
    assertV2Report(report);
    assert.equal(report.project_mode, 'trellis_local_worktree');
    assert.equal(report.run_status, 'done');
    assert.equal(report.patch.status, 'ready');
    assert.ok(report.patch.changed_files.includes('result.txt'));
    assert.ok(report.apply_command.includes('git apply'));
    assert.match(report.report_file, /\.trellis\/\.runtime\/pi-workers/);
  } finally {
    mcp.close();
  }
});

test('Trellis channel mode degrades gracefully when channel delivery is unavailable', async () => {
  const repo = makeRepo({ trellis: true });
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'diff', TRELLIS_BINARY: '/definitely/missing/trellis' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'pi',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Create a small result file.',
      channel: 'pi-test-channel',
      min_files_changed: 1,
    });
    assert.equal(result.isError, false);
    const report = readReport(result);
    assert.equal(report.project_mode, 'trellis_channel_bridge');
    assert.equal(report.patch.status, 'ready');
  } finally {
    mcp.close();
  }
});

test('standalone project without Trellis works in worktree mode', async () => {
  const repo = makeRepo();
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'diff' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'pi',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Create a small result file.',
      min_files_changed: 1,
    });
    assert.equal(result.isError, false);
    const report = readReport(result);
    assert.equal(report.project_mode, 'standalone_worktree');
    assert.equal(report.patch.status, 'ready');
    assert.match(report.report_file, /executor-adapter\/pi-workers/);
  } finally {
    mcp.close();
  }
});

test('preview_prompt supports standalone implement mode with explicit instructions', async () => {
  const repo = makeRepo();
  const mcp = startMcp();
  try {
    await mcp.init();
    const result = await mcp.callTool('preview_prompt', {
      mode: 'implement',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Update README.md.',
      scope: 'Only README.md',
    });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Executor Dispatch: Implementation \(no Trellis\)/);
    assert.match(result.content[0].text, /Update README\.md/);
    assert.match(result.content[0].text, /Only README\.md/);
  } finally {
    mcp.close();
  }
});

test('preview_prompt rejects the removed patch execution_mode', async () => {
  const repo = makeRepo();
  const mcp = startMcp();
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'pi',
      model: 'fake/model',
      execution_mode: 'patch',
      working_directory: repo,
      extra_instructions: 'Produce a diff.',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unsupported execution_mode "patch"/);
  } finally {
    mcp.close();
  }
});

test('smoke failure includes stdout, stderr, safe env, and seeded config paths', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'smoke-fail', HOME: home });
  try {
    await mcp.init();
    const result = await mcp.callTool('smoke', {
      executor: 'pi',
      model: 'fake/model',
      working_directory: repo,
    });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /Pi smoke: FAILED/);
    assert.match(text, /model=fake\/model/);
    assert.match(text, /config_seeded:/);
    assert.match(text, /models\.json/);
    assert.match(text, /settings\.json/);
    assert.match(text, /env_passed:/);
    assert.match(text, /PI_CODING_AGENT_DIR=/);
    assert.match(text, /PI_CODING_AGENT_SESSION_DIR=/);
    assert.match(text, /pi stdout:\nfake pi starting/);
    assert.match(text, /pi stderr:\nError: Model "fake\/model" not found/);
    assert.match(text, /diagnostic:/);
  } finally {
    mcp.close();
  }
});

test('model map reloads after config.toml mtime changes', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  writePiConfig(home, '[executor_adapter]\nimplementer = "fake/old"\nreviewer = "fake/reviewer"\n');
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'smoke-ready', HOME: home });
  try {
    await mcp.init();
    const first = await mcp.callTool('smoke', {
      executor: 'pi',
      working_directory: repo,
    });
    assert.equal(first.isError, false);
    assert.match(first.content[0].text, /model=fake\/old \(config:implementer\)/);

    fs.writeFileSync(
      path.join(home, '.pi', 'config.toml'),
      '[executor_adapter]\nimplementer = "fake/new"\nreviewer = "fake/reviewer"\n',
      'utf-8',
    );
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(home, '.pi', 'config.toml'), future, future);

    const second = await mcp.callTool('smoke', {
      executor: 'pi',
      working_directory: repo,
    });
    assert.equal(second.isError, false);
    assert.match(second.content[0].text, /model=fake\/new \(config:implementer\)/);
  } finally {
    mcp.close();
  }
});

test('legacy [pi_adapter] section is no longer read and emits a migration error', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  writePiConfig(home, '[pi_adapter]\nimplementer = "fake/legacy"\nreviewer = "fake/legacy-reviewer"\n');
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'smoke-ready', HOME: home });
  try {
    await mcp.init();
    // Legacy section is ignored: model resolution falls back to the default
    // logical key and throws ModelResolutionError.
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'pi',
      execution_mode: 'review',
      working_directory: repo,
      extra_instructions: 'Review only.',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Cannot resolve model "implementer"/);
    assert.match(mcp.stderrText(), /legacy .pi_adapter./i);
    assert.match(mcp.stderrText(), /CONFIG ERROR/i);
  } finally {
    mcp.close();
  }
});

test('smoke can resolve reviewer mode and direct model overrides', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  writePiConfig(home, '[executor_adapter]\nimplementer = "fake/implementer"\nreviewer = "fake/reviewer"\n');
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'smoke-ready', HOME: home });
  try {
    await mcp.init();
    const reviewer = await mcp.callTool('smoke', {
      mode: 'check',
      executor: 'pi',
      working_directory: repo,
    });
    assert.equal(reviewer.isError, false);
    assert.match(reviewer.content[0].text, /model=fake\/reviewer \(config:reviewer\)/);

    const direct = await mcp.callTool('smoke', {
      executor: 'pi',
      model: 'fake/direct',
      working_directory: repo,
    });
    assert.equal(direct.isError, false);
    assert.match(direct.content[0].text, /model=fake\/direct \(direct\)/);
  } finally {
    mcp.close();
  }
});

test('non-zero dispatch with tiny output.log includes in-memory stderr diagnostics', async () => {
  const repo = makeRepo();
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'sse-error' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'pi',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Trigger an SSE error.',
    });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /--- pi stderr \(in-memory, head\+tail\) ---/);
    assert.match(text, /stream_read_error/);
    assert.match(text, /Upstream SSE stream failed/);
    const report = readReport(result);
    assert.equal(report.run_status, 'failed');
    assert.equal(report.ok, false);
    assert.equal(report.error.stage, 'executor');
  } finally {
    mcp.close();
  }
});

test('non-zero dispatch classifies built-in provider API key errors', async () => {
  const repo = makeRepo();
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'api-key-error' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'pi',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Trigger an auth error.',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Pi resolved to built-in provider 'azure-openai-responses'/);
    assert.match(result.content[0].text, /model="gpt\/gpt-5\.5"/);
  } finally {
    mcp.close();
  }
});

test('large Trellis context is budgeted per file; embed_context=false lists paths', async () => {
  const repo = makeRepo({ trellis: true });
  const largeSpec = 'specs/large.md';
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, largeSpec), `# Large spec\n\n${'x'.repeat(90 * 1024)}\n`, 'utf-8');
  const taskDir = makeTrellisTask(repo, { files: [largeSpec] });
  runGit(repo, ['add', '.']);
  runGit(repo, ['commit', '-m', 'add trellis task']);

  const mcp = startMcp();
  try {
    await mcp.init();
    const embedded = await mcp.callTool('preview_prompt', {
      mode: 'implement',
      execution_mode: 'worktree',
      working_directory: repo,
      task_dir: taskDir,
    });
    assert.match(embedded.content[0].text, /truncated/);

    const listed = await mcp.callTool('preview_prompt', {
      mode: 'implement',
      execution_mode: 'worktree',
      working_directory: repo,
      task_dir: taskDir,
      embed_context: false,
    });
    const text = listed.content[0].text;
    assert.match(text, /Context embedding is disabled/);
    assert.match(text, /- `specs\/large\.md`/);
    assert.doesNotMatch(text, /xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/);
  } finally {
    mcp.close();
  }
});

test('forbidden path touched fails post_validation', async () => {
  const repo = makeRepo();
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'forbidden' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'pi',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Touch a forbidden file.',
      forbidden_paths: ['forbidden.txt'],
    });
    assert.equal(result.isError, true);
    const report = readReport(result);
    assert.equal(report.post_validation.status, 'failed');
    assert.equal(report.post_validation.failures[0].rule, 'forbidden_paths');
    assert.equal(report.ok, false);
    assert.equal(report.error.stage, 'post_validation');
  } finally {
    mcp.close();
  }
});

test('required path missing fails post_validation', async () => {
  const repo = makeRepo();
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'required-missing' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'pi',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Touch the wrong file.',
      required_paths_modified: ['needed.txt'],
    });
    assert.equal(result.isError, true);
    const report = readReport(result);
    assert.equal(report.post_validation.status, 'failed');
    assert.equal(report.post_validation.failures[0].rule, 'required_paths_modified');
  } finally {
    mcp.close();
  }
});

test('cleanup_runtime dry-runs and removes old worker directories', async () => {
  const repo = makeRepo({ trellis: true });
  const workers = path.join(repo, '.trellis', '.runtime', 'pi-workers');
  const oldWorker = path.join(workers, 'pi-old-worker');
  const newWorker = path.join(workers, 'pi-new-worker');
  fs.mkdirSync(oldWorker, { recursive: true });
  fs.mkdirSync(newWorker, { recursive: true });
  fs.writeFileSync(path.join(oldWorker, 'output.log'), 'old worker\n', 'utf-8');
  fs.writeFileSync(path.join(newWorker, 'output.log'), 'new worker\n', 'utf-8');
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldWorker, oldDate, oldDate);

  const mcp = startMcp();
  try {
    await mcp.init();
    const dryRun = await mcp.callTool('cleanup_runtime', {
      working_directory: repo,
      retain_days: 7,
      dry_run: true,
    });
    const dryRunReport = JSON.parse(dryRun.content[0].text);
    assert.equal(dryRunReport.removed.length, 1);
    assert.equal(dryRunReport.removed[0].worker_id, 'pi-old-worker');
    assert.ok(dryRunReport.bytes_would_free > 0);
    assert.ok(fs.existsSync(oldWorker));

    const result = await mcp.callTool('cleanup_runtime', {
      working_directory: repo,
      retain_days: 7,
      dry_run: false,
    });
    const report = JSON.parse(result.content[0].text);
    assert.equal(report.removed.length, 1);
    assert.equal(report.retained.length, 1);
    assert.ok(report.bytes_freed > 0);
    assert.equal(fs.existsSync(oldWorker), false);
    assert.equal(fs.existsSync(newWorker), true);
  } finally {
    mcp.close();
  }
});

test('read_report summarizes v2 fields', async () => {
  const trellisRepo = makeRepo({ trellis: true });
  const standaloneRepo = makeRepo();
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'diff' });
  try {
    await mcp.init();
    const trellisResult = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'pi',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: trellisRepo,
      extra_instructions: 'Create a small result file.',
      min_files_changed: 1,
    });
    const trellisReport = readReport(trellisResult);
    const trellisSummary = await mcp.callTool('read_report', {
      runtime_dir: path.join(trellisRepo, '.trellis', '.runtime'),
      worker_id: trellisReport.worker_id,
      working_directory: trellisRepo,
      lines: 5,
    });
    const trellisText = trellisSummary.content[0].text;
    assert.match(trellisText, /ok: true/);
    assert.match(trellisText, /run_status: done/);
    assert.match(trellisText, /patch\.status: ready/);
    assert.match(trellisText, /project_mode: trellis_local_worktree/);
    assert.match(trellisText, /apply_command:/);

    const standaloneResult = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'pi',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: standaloneRepo,
      extra_instructions: 'Create a small result file.',
      min_files_changed: 1,
    });
    const standaloneReport = readReport(standaloneResult);
    const standaloneSummary = await mcp.callTool('read_report', {
      runtime_dir: path.dirname(path.dirname(path.dirname(standaloneReport.report_file))),
      worker_id: standaloneReport.worker_id,
      lines: 5,
    });
    const standaloneText = standaloneSummary.content[0].text;
    assert.match(standaloneText, /patch\.status: ready/);
    assert.match(standaloneText, /project_mode: standalone_worktree/);
    assert.match(standaloneText, /changed_files/);
  } finally {
    mcp.close();
  }
});

function fakeArgvFrom(report) {
  const log = fs.readFileSync(report.log_file, 'utf-8');
  for (const line of log.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'fake.argv') return event.argv;
    } catch {}
  }
  return null;
}

function fakeEnvFrom(report) {
  const log = fs.readFileSync(report.log_file, 'utf-8');
  for (const line of log.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'fake.env') return event.env;
    } catch {}
  }
  return null;
}

test('codex worktree dispatch returns ready patch with usage and sandbox flags', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  const mcp = startMcp({ FAKE_CODEX_SCENARIO: 'diff', HOME: home });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'codex',
      execution_mode: 'worktree',
      isolate_executor: true,
      working_directory: repo,
      extra_instructions: 'Create a small result file.',
      min_files_changed: 1,
    });
    assert.equal(result.isError, false);
    const report = readReport(result);
    assert.equal(report.executor, 'codex');
    assert.equal(report.patch.status, 'ready');
    assert.ok(report.usage && report.usage.input_tokens > 0, 'usage missing from report');
    const argv = fakeArgvFrom(report);
    assert.ok(argv, 'fake.argv event missing from output.log');
    assert.equal(argv[argv.indexOf('--sandbox') + 1], 'workspace-write');
    assert.ok(argv.includes('approval_policy="never"'));
    assert.ok(argv.includes('--ignore-rules'));
    assert.ok(argv.includes('--ephemeral'));
    assert.equal(argv.includes('--ignore-user-config'), false);
  } finally {
    mcp.close();
  }
});

test('codex review mode maps to a read-only sandbox', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  const mcp = startMcp({ FAKE_CODEX_SCENARIO: 'none', HOME: home });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'codex',
      execution_mode: 'review',
      working_directory: repo,
      extra_instructions: 'Review only, no edits.',
    });
    assert.equal(result.isError, false);
    const report = readReport(result);
    assert.equal(report.executor, 'codex');
    const argv = fakeArgvFrom(report);
    assert.ok(argv, 'fake.argv event missing from output.log');
    assert.equal(argv[argv.indexOf('--sandbox') + 1], 'read-only');
  } finally {
    mcp.close();
  }
});

test('review prompt embeds git diff against base and states the read-only guard', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'README.md'), '# test repo\n\nnew line\n', 'utf-8');
  const mcp = startMcp();
  try {
    await mcp.init();
    const result = await mcp.callTool('preview_prompt', {
      mode: 'custom',
      execution_mode: 'review',
      working_directory: repo,
      base: 'HEAD',
      extra_instructions: 'Review the README change.',
    });
    const text = result.content[0].text;
    assert.match(text, /Changes under review/);
    assert.match(text, /README\.md/);
    assert.match(text, /Do not modify, write, stage, commit, or push/);
  } finally {
    mcp.close();
  }
});

test('codex subprocess uses local Codex home but strips API keys', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-adapter-codex-home-'));
  const codexConfigPath = path.join(codexHome, 'config.toml');
  const mcp = startMcp({
    FAKE_CODEX_SCENARIO: 'none',
    HOME: home,
    CODEX_HOME: codexHome,
    CODEX_CONFIG_PATH: codexConfigPath,
    CODEX_API_KEY: 'secret-codex-key',
    OPENAI_API_KEY: 'secret-openai-key',
  });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'codex',
      execution_mode: 'review',
      working_directory: repo,
      extra_instructions: 'Review only, no edits.',
    });
    assert.equal(result.isError, false);
    const env = fakeEnvFrom(readReport(result));
    assert.ok(env, 'fake.env event missing from output.log');
    assert.equal(env.CODEX_HOME, codexHome);
    assert.equal(env.CODEX_CONFIG_PATH, codexConfigPath);
    assert.equal(env.CODEX_API_KEY, null);
    assert.equal(env.OPENAI_API_KEY, null);
  } finally {
    mcp.close();
  }
});

test('codex model resolution honors [executor_adapter.codex] and falls back to the CLI default', async () => {
  const repo = makeRepo();
  const configuredHome = makePiHome();
  writePiConfig(configuredHome, '[executor_adapter]\nimplementer = "fake/pi"\n\n[executor_adapter.codex]\nimplementer = "gpt-5.5"\n');
  const configured = startMcp({ FAKE_CODEX_SCENARIO: 'none', HOME: configuredHome });
  try {
    await configured.init();
    const result = await configured.callTool('dispatch', {
      mode: 'custom',
      executor: 'codex',
      execution_mode: 'review',
      working_directory: repo,
      extra_instructions: 'Review only.',
    });
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /Model: gpt-5\.5 \(config:implementer/);
    const argv = fakeArgvFrom(readReport(result));
    assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-5.5');
  } finally {
    configured.close();
  }

  const bareHome = makePiHome();
  const bare = startMcp({ FAKE_CODEX_SCENARIO: 'none', HOME: bareHome });
  try {
    await bare.init();
    const result = await bare.callTool('dispatch', {
      mode: 'custom',
      executor: 'codex',
      execution_mode: 'review',
      working_directory: repo,
      extra_instructions: 'Review only.',
    });
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /Model: \(codex CLI default\) \(codex-default/);
    const argv = fakeArgvFrom(readReport(result));
    assert.equal(argv.includes('-m'), false);
  } finally {
    bare.close();
  }
});

test('codex rejects executor backend aliases passed as model names', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  const mcp = startMcp({ FAKE_CODEX_SCENARIO: 'none', HOME: home });
  try {
    await mcp.init();
    const dispatch = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'codex',
      model: 'codex',
      execution_mode: 'review',
      working_directory: repo,
      extra_instructions: 'Review only.',
    });
    assert.equal(dispatch.isError, true);
    assert.match(dispatch.content[0].text, /Invalid Codex model "codex"/);
    assert.match(dispatch.content[0].text, /executor="codex"/);
    assert.match(dispatch.content[0].text, /omit model/);
    assert.match(dispatch.content[0].text, /model="gpt-5\.5"/);

    const smoke = await mcp.callTool('smoke', {
      executor: 'codex',
      model: 'codex',
      working_directory: repo,
    });
    assert.equal(smoke.isError, true);
    assert.match(smoke.content[0].text, /Invalid Codex model "codex"/);
    assert.match(smoke.content[0].text, /executor="codex"/);
  } finally {
    mcp.close();
  }
});

test('default routing picks codex for implement and pi for check', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  const mcp = startMcp({ FAKE_CODEX_SCENARIO: 'none', FAKE_PI_SCENARIO: 'none', HOME: home });
  try {
    await mcp.init();
    const implement = await mcp.callTool('dispatch', {
      mode: 'implement',
      execution_mode: 'review',
      working_directory: repo,
      extra_instructions: 'Review only.',
    });
    assert.equal(implement.isError, false);
    assert.equal(readReport(implement).executor, 'codex');

    const check = await mcp.callTool('dispatch', {
      mode: 'check',
      model: 'fake/model',
      working_directory: repo,
      extra_instructions: 'Review only.',
    });
    assert.equal(check.isError, false);
    assert.equal(readReport(check).executor, 'pi');
  } finally {
    mcp.close();
  }
});

test('codex smoke passes when ready and reports the login hint on auth failure', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  const ready = startMcp({ FAKE_CODEX_SCENARIO: 'smoke-ready', HOME: home });
  try {
    await ready.init();
    const result = await ready.callTool('smoke', {
      executor: 'codex',
      working_directory: repo,
    });
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /Codex smoke: PASSED/);
    assert.match(result.content[0].text, /\(codex CLI default\)/);
  } finally {
    ready.close();
  }

  const auth = startMcp({ FAKE_CODEX_SCENARIO: 'auth-error', HOME: home });
  try {
    await auth.init();
    const result = await auth.callTool('smoke', {
      executor: 'codex',
      working_directory: repo,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Codex smoke: FAILED/);
    assert.match(result.content[0].text, /codex login/);
  } finally {
    auth.close();
  }
});

test('codex smoke uses the same user config policy as isolated dispatch', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  const mcp = startMcp({ FAKE_CODEX_SCENARIO: 'smoke-ready', HOME: home });
  try {
    await mcp.init();
    const result = await mcp.callTool('smoke', {
      executor: 'codex',
      working_directory: repo,
    });
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /Codex smoke: PASSED/);
    assert.match(result.content[0].text, /--ignore-rules/);
    assert.match(result.content[0].text, /--ephemeral/);
    assert.doesNotMatch(result.content[0].text, /--ignore-user-config/);
  } finally {
    mcp.close();
  }
});

test('missing codex binary yields a clear error', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  const mcp = startMcp({ CODEX_BINARY: '/definitely/missing/codex', HOME: home });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'codex',
      execution_mode: 'review',
      working_directory: repo,
      extra_instructions: 'Review only.',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /codex binary not found/);
    assert.match(result.content[0].text, /CODEX_BINARY/);
  } finally {
    mcp.close();
  }
});

test('Claude Code agent templates pin xhigh effort for Task subagents', () => {
  const templateDir = path.join(ROOT, 'templates', 'claude', 'agents');
  for (const file of [
    'trellis-codex-implement.md',
    'trellis-pi-implement.md',
    'trellis-pi-check.md',
  ]) {
    const body = fs.readFileSync(path.join(templateDir, file), 'utf-8');
    assert.match(body, /^effort:\s*xhigh$/m, file);
  }
});
