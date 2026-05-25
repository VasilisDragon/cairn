#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', 'reports', 'data']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) out.push(path.join(dir, entry.name));
  }
  return out;
}

const files = walk(ROOT).sort();
let failed = false;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`node --check failed: ${rel}\n`);
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}

if (failed) {
  process.stderr.write(`check-js: failed (${files.length} files checked)\n`);
  process.exit(1);
}

process.stdout.write(`check-js: ok (${files.length} files checked)\n`);
