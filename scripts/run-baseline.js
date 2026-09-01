#!/usr/bin/env node
import process from 'node:process';

import { parseBaselineArgs, runBaseline } from './baseline-runner.js';

try {
  const options = parseBaselineArgs(process.argv.slice(2));
  options.invocation = {
    entrypoint: process.env.npm_lifecycle_event === 'test:baseline' ? 'test:baseline' : 'direct',
    argv: [process.execPath, ...process.argv.slice(1)],
  };
  process.exitCode = await runBaseline(options);
} catch (error) {
  process.stderr.write(`baseline: ${String(error?.message || error)}\n`);
  process.exitCode = 1;
}
