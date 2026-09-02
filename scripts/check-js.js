#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createBaselineSynchronousNodeChildEnvironment } from './baseline-synchronous-node-child.js';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', 'reports', 'data']);

export function createSyntaxCheckChildEnvironment(sourceEnv = process.env, repositoryRoot = ROOT) {
  // The coordinator is already an identity-registered, serialized lock child.
  // `spawnSync` keeps it alive until each parser-only child exits, and Windows
  // inherits the coordinator's Idle priority and one-core affinity. Re-importing
  // the lock bootstrap in hundreds of `node --check` processes adds no
  // concurrency protection and makes every parse depend on multiple short-lived
  // PowerShell identity probes. Keep the egress guard and V8 limit, but do not
  // recursively bootstrap these non-executing parser children.
  return createBaselineSynchronousNodeChildEnvironment(sourceEnv, repositoryRoot);
}

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

export function runSyntaxChecks(repositoryRoot = ROOT, sourceEnv = process.env) {
  const files = walk(repositoryRoot).sort();
  let failed = false;
  const syntaxCheckEnvironment = createSyntaxCheckChildEnvironment(sourceEnv, repositoryRoot);

  for (const file of files) {
    const rel = path.relative(repositoryRoot, file);
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: repositoryRoot,
      env: syntaxCheckEnvironment,
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
    return 1;
  }

  process.stdout.write(`check-js: ok (${files.length} files checked)\n`);
  return 0;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = runSyntaxChecks();
}
