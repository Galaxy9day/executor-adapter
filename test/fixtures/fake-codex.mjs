#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';

const scenario = process.env.FAKE_CODEX_SCENARIO || 'diff';
const argv = process.argv.slice(2);

if (argv[0] !== 'exec' || !argv.includes('--json')) {
  console.error(`fake-codex expects "exec ... --json", got: ${argv.join(' ')}`);
  process.exit(2);
}

// Surface the received argv as a JSONL event so tests can assert on flags
// via output.log; the adapter ignores unknown event types.
function emit(event) {
  console.log(JSON.stringify(event));
}
emit({ type: 'fake.argv', argv });
emit({
  type: 'fake.env',
  env: {
    CODEX_HOME: process.env.CODEX_HOME || null,
    CODEX_SQLITE_HOME: process.env.CODEX_SQLITE_HOME || null,
    CODEX_API_KEY: process.env.CODEX_API_KEY || null,
    CODEX_CONFIG_PATH: process.env.CODEX_CONFIG_PATH || null,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || null,
  },
});

// '-' prompt sentinel: drain stdin like the real CLI would.
if (argv[argv.length - 1] === '-') {
  try { fs.readFileSync(0, 'utf-8'); } catch {}
}

const outIdx = argv.indexOf('-o');
const lastMessagePath = outIdx !== -1 ? argv[outIdx + 1] : null;

function write(rel, content) {
  const target = path.join(process.cwd(), rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');
}

function finishTurn(message) {
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: message } });
  emit({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 10, output_tokens: 30 } });
  if (lastMessagePath) {
    try { fs.writeFileSync(lastMessagePath, `${message}\n`, 'utf-8'); } catch {}
  }
}

emit({ type: 'thread.started', thread_id: 'fake-thread-1' });

if (scenario === 'diff') {
  write('result.txt', 'fake codex change\n');
  finishTurn('Files modified: result.txt');
} else if (scenario === 'none') {
  finishTurn('No changes needed.');
} else if (scenario === 'review-report') {
  finishTurn('## Findings\n\nThe auth flow cannot land as-is: approval from the owner is required before merge, and two issues were found in the token refresh path.\n\n## Verdict\n\nRequest changes.');
} else if (scenario === 'turn-failed') {
  emit({ type: 'error', message: 'model stream failed' });
  emit({ type: 'turn.failed', error: { message: 'model stream failed' } });
  process.exit(1);
} else if (scenario === 'smoke-ready') {
  finishTurn('CODEX READY');
} else if (scenario === 'auth-error') {
  console.error('Error: not logged in. Run codex login.');
  process.exit(1);
} else {
  console.error(`Unknown FAKE_CODEX_SCENARIO: ${scenario}`);
  process.exit(2);
}
