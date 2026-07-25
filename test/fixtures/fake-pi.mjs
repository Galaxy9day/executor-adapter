#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';

const scenario = process.env.FAKE_PI_SCENARIO || 'diff';

function write(rel, content) {
  const target = path.join(process.cwd(), rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');
}

if (scenario === 'diff') {
  write('result.txt', 'fake pi change\n');
  console.log('Files modified: result.txt');
} else if (scenario === 'none') {
  console.log('No changes needed.');
} else if (scenario === 'forbidden') {
  write('forbidden.txt', 'forbidden change\n');
  console.log('Files modified: forbidden.txt');
} else if (scenario === 'required-missing') {
  write('actual.txt', 'actual change\n');
  console.log('Files modified: actual.txt');
} else if (scenario === 'smoke-fail') {
  console.log('fake pi starting');
  console.error('Error: Model "fake/model" not found. Use --list-models to see available models.');
  process.exit(1);
} else if (scenario === 'smoke-ready') {
  console.log('PI READY');
} else if (scenario === 'sse-error') {
  console.error('stream_read_error');
  process.exit(1);
} else if (scenario === 'api-key-error') {
  console.error('No API key found for azure-openai-responses');
  process.exit(1);
} else {
  console.error(`Unknown FAKE_PI_SCENARIO: ${scenario}`);
  process.exit(2);
}
