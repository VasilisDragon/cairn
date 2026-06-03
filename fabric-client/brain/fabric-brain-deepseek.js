#!/usr/bin/env node

import { startDeepseekBrainServer } from './deepseek-adapter.js';

try {
  startDeepseekBrainServer();
} catch (err) {
  console.error(JSON.stringify({
    evt: 'fabric.deepseek.start_failed',
    error: String(err?.message || err || 'unknown').replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]'),
  }));
  process.exit(1);
}

