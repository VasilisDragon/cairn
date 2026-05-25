import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('generated public markdown reports do not contain malformed table rows', () => {
  const reportDir = path.join(ROOT, 'reports');
  const reportFiles = fs.readdirSync(reportDir)
    .filter((name) => name.endsWith('.md'))
    .sort();
  const failures = [];

  for (const fileName of reportFiles) {
    const filePath = path.join(reportDir, fileName);
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const row of malformedTableRows(lines)) {
      failures.push(`${fileName}:${row.lineNumber}: ${row.line}`);
    }
  }

  assert.deepEqual(failures, []);
});

function malformedTableRows(lines) {
  const failures = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !isMarkdownSeparator(line) || !String(lines[i - 1] || '').startsWith('|')) {
      continue;
    }

    for (let j = i + 1; j < lines.length; j++) {
      const row = lines[j];
      if (row.startsWith('```')) break;
      if (row.trim() === '') break;
      if (row.startsWith('#') || row.startsWith('- ') || /^\d+\.\s/.test(row)) break;
      if (!row.startsWith('|')) {
        failures.push({ lineNumber: j + 1, line: row });
      }
    }
  }

  return failures;
}

function isMarkdownSeparator(line) {
  return /^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line);
}
