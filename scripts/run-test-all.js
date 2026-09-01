#!/usr/bin/env node
// Compatibility entrypoint. The historical test:all name now has exactly the
// same offline-only, fail-closed behavior as test:baseline.
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { parseBaselineArgs, runBaseline } from './baseline-runner.js';

try {
  const argv = process.argv.slice(2);
  const hasOutputRoot = argv.some((arg) => arg === '--output-root' || arg.startsWith('--output-root='));
  const options = parseBaselineArgs(hasOutputRoot
    ? argv
    : [...argv, '--output-root', path.join(os.tmpdir(), 'cairn-baseline')]);
  options.invocation = {
    entrypoint: 'test:all',
    argv: [process.execPath, ...process.argv.slice(1)],
  };
  process.exitCode = await runBaseline(options);
} catch (error) {
  process.stderr.write(`test:all: ${String(error?.message || error)}\n`);
  process.exitCode = 1;
}
