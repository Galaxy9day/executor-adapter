import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

test('Trellis project without channel returns patch-ready report', async () => {
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
    assert.equal(report.result_class, 'patch_ready');
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
  writePiConfig(home, '[pi_adapter]\nimplementer = "fake/old"\nreviewer = "fake/reviewer"\n');
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
      '[pi_adapter]\nimplementer = "fake/new"\nreviewer = "fake/reviewer"\n',
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

test('executor_adapter config section takes priority over legacy pi_adapter', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  writePiConfig(home, '[pi_adapter]\nimplementer = "fake/legacy"\nreviewer = "fake/legacy-reviewer"\n\n[executor_adapter]\nimplementer = "fake/current"\nreviewer = "fake/current-reviewer"\n');
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'smoke-ready', HOME: home });
  try {
    await mcp.init();
    const result = await mcp.callTool('smoke', {
      executor: 'pi',
      working_directory: repo,
    });
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /model=fake\/current \(config:implementer\)/);
  } finally {
    mcp.close();
  }
});

test('smoke can resolve reviewer mode and direct model overrides', async () => {
  const repo = makeRepo();
  const home = makePiHome();
  writePiConfig(home, '[pi_adapter]\nimplementer = "fake/implementer"\nreviewer = "fake/reviewer"\n');
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

test('patch-ready limited validation is not reported as blocked', async () => {
  const repo = makeRepo({ trellis: true });
  const mcp = startMcp({ FAKE_PI_SCENARIO: 'limited' });
  try {
    await mcp.init();
    const result = await mcp.callTool('dispatch', {
      mode: 'custom',
      executor: 'pi',
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
      executor: 'pi',
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
    // Default embed_context=true: the 90 KB spec is truncated to the per-file
    // Trellis context budget instead of being inlined whole.
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

test('forbidden path touched fails validation', async () => {
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
      executor: 'pi',
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
    assert.match(trellisSummary.content[0].text, /result_class: patch_ready/);
    assert.match(trellisSummary.content[0].text, /project_mode: trellis_local_worktree/);
    assert.match(trellisSummary.content[0].text, /apply_command:/);

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
    assert.match(standaloneSummary.content[0].text, /result_class: patch_ready/);
    assert.match(standaloneSummary.content[0].text, /project_mode: standalone_worktree/);
    assert.match(standaloneSummary.content[0].text, /changed_files/);
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

test('codex worktree dispatch returns patch_ready with usage and sandbox flags', async () => {
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
    assert.equal(report.result_class, 'patch_ready');
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

test('review mode with approval-flavored prose is review_completed, not blocked', async () => {
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
      extra_instructions: 'Review the auth flow changes.',
    });
    assert.equal(result.isError, false);
    const report = readReport(result);
    assert.equal(report.status, 'done');
    assert.equal(report.result_class, 'review_completed');
    assert.equal(report.data_validation, 'not_applicable');
    assert.match(report.status_reason, /Read-only review finished successfully/);
    assert.ok(report.review_summary && report.review_summary.includes('Findings'));
    const steps = report.orchestrator_next_steps.join('\n');
    assert.match(steps, /review_summary/);
    assert.doesNotMatch(steps, /Apply patch/);
    assert.doesNotMatch(steps, /Run full validation/);
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
