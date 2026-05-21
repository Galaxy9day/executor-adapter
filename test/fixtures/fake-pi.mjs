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
} else if (scenario === 'limited') {
  write('result.txt', 'fake pi limited validation change\n');
  console.log('static/auto validation passed');
  console.log('sample data validation skipped because derived data missing in isolated worktree');
  console.log('data validation must run in main repo');
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
} else {
  console.error(`Unknown FAKE_PI_SCENARIO: ${scenario}`);
  process.exit(2);
}
