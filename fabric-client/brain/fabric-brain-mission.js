#!/usr/bin/env node

import { startProviderFreeMissionBrainServer } from './deepseek-adapter.js';

try {
  const runtime = startProviderFreeMissionBrainServer();
  let shutdownStarted = false;
  const shutdown = async (signal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try {
      if (runtime.server.listening) {
        await new Promise((resolve, reject) => {
          runtime.server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await runtime.shutdownOpportunityShadow?.();
      process.exitCode = 0;
    } catch (error) {
      console.error(JSON.stringify({
        evt: 'fabric.mission.shutdown_failed',
        signal,
        error: String(error?.message || error || 'unknown').replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]'),
      }));
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
} catch (err) {
  console.error(JSON.stringify({
    evt: 'fabric.mission.start_failed',
    error: String(err?.message || err || 'unknown').replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]'),
  }));
  process.exit(1);
}
