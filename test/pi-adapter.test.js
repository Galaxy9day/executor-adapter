import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'index.js');
const FAKE_PI = path.join(ROOT, 'test', 'fixtures', 'fake-pi.mjs');

function runGit(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function makeRepo({ trellis = false } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-adapter-test-'));
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-adapter-home-'));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, 'models.json'), '{"models":[]}\n', 'utf-8');
  fs.writeFileSync(path.join(agent, 'settings.json'), '{"settings":{}}\n', 'utf-8');
  return home;
}

function startMcp(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PI_BINARY: FAKE_PI,
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
  child.stderr.on('data', () => {});

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
    async init() {
      await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'pi-adapter-test', version: '0.0.0' },
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

test('Trellis project without channel returns patch-ready report', async () => {
  const repo = makeRepo({ trellis: true });
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'diff' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Create a small result file.',
      min_files_changed: 1,
    });
    assert.equal(result.isError, false);
    const report = readReport(result);
    assert.equal(report.project_mode, 'trellis_local_worktree');
    assert.equal(report.result_class, 'patch_ready');
    assert.equal(report.status, 'done');
    assert.match(report.report_file, /\.trellis\/\.runtime\/pi-workers/);
    assert.ok(report.apply_command.includes('git apply'));
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
    assert.equal(report.result_class, 'patch_ready');
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
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Create a small result file.',
      min_files_changed: 1,
    });
    assert.equal(result.isError, false);
    const report = readReport(result);
    assert.equal(report.project_mode, 'standalone_worktree');
    assert.equal(report.result_class, 'patch_ready');
    assert.match(report.report_file, /pi-adapter\/pi-workers/);
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
    assert.match(result.content[0].text, /Pi Dispatch: Implementation \(no Trellis\)/);
    assert.match(result.content[0].text, /Update README\.md/);
    assert.match(result.content[0].text, /Only README\.md/);
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

test('patch-ready limited validation is not reported as blocked', async () => {
  const repo = makeRepo({ trellis: true });
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'limited' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Create a patch but data validation is unavailable.',
      min_files_changed: 1,
    });
    assert.equal(result.isError, false);
    const report = readReport(result);
    assert.equal(report.status, 'patch_ready_limited_validation');
    assert.equal(report.result_class, 'patch_ready_limited_validation');
    assert.equal(report.data_validation, 'not_attempted');
    assert.match(report.validation_scope, /data validation must run in main repo/);
  } finally {
    mcp.close();
  }
});

test('exit zero with no diff is no_usable_patch', async () => {
  const repo = makeRepo();
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'none' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'No-op.',
    });
    assert.equal(result.isError, true);
    const report = readReport(result);
    assert.equal(report.status, 'no_patch');
    assert.equal(report.result_class, 'no_usable_patch');
  } finally {
    mcp.close();
  }
});

test('forbidden path touched fails validation', async () => {
  const repo = makeRepo();
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'forbidden' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Touch a forbidden file.',
      forbidden_paths: ['forbidden.txt'],
    });
    assert.equal(result.isError, true);
    const report = readReport(result);
    assert.equal(report.result_class, 'validation_failed');
    assert.equal(report.validation_failures[0].rule, 'forbidden_paths');
  } finally {
    mcp.close();
  }
});

test('required path missing fails validation', async () => {
  const repo = makeRepo();
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'required-missing' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      model: 'fake/model',
      execution_mode: 'worktree',
      working_directory: repo,
      extra_instructions: 'Touch the wrong file.',
      required_paths_modified: ['needed.txt'],
    });
    assert.equal(result.isError, true);
    const report = readReport(result);
    assert.equal(report.result_class, 'validation_failed');
    assert.equal(report.validation_failures[0].rule, 'required_paths_modified');
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

test('read_report summarizes Trellis and standalone runtime reports', async () => {
  const trellisRepo = makeRepo({ trellis: true });
  const standaloneRepo = makeRepo();
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'diff' });
  try {
    await mcp.init();
    const trellisResult = await mcp.callTool('dispatch', {
      mode: 'custom',
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
    assert.match(trellisSummary.content[0].text, /result_class: patch_ready/);
    assert.match(trellisSummary.content[0].text, /project_mode: trellis_local_worktree/);
    assert.match(trellisSummary.content[0].text, /apply_command:/);

    const standaloneResult = await mcp.callTool('dispatch', {
      mode: 'custom',
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
    assert.match(standaloneSummary.content[0].text, /result_class: patch_ready/);
    assert.match(standaloneSummary.content[0].text, /project_mode: standalone_worktree/);
    assert.match(standaloneSummary.content[0].text, /changed_files/);
  } finally {
    mcp.close();
  }
});
