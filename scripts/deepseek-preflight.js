#!/usr/bin/env node
import process from 'node:process';
import {
  deepseekPreflight,
  formatDeepseekPreflight,
} from '../src/advisor/deepseek_preflight.js';

const opts = parseArgs(process.argv.slice(2));
const status = deepseekPreflight(process.env, opts);
process.stdout.write(formatDeepseekPreflight(status) + '\n');
process.exit(status.ok ? 0 : 1);

function parseArgs(args) {
  const opts = {
    entrypoint: 'main',
    requiresLiveTests: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--live') {
      opts.requiresLiveTests = true;
    } else if (arg === '--entrypoint') {
      const value = args[i + 1];
      if (value) {
        opts.entrypoint = value;
        i += 1;
      }
    } else if (arg.startsWith('--entrypoint=')) {
      opts.entrypoint = arg.slice('--entrypoint='.length) || opts.entrypoint;
    }
  }
  return opts;
}
