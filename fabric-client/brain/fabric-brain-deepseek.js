#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDeepseekBrainServer } from './deepseek-adapter.js';

function sanitizeLifecycleError(error) {
  return String(error?.message || error || 'unknown')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
}

/**
 * Install the paid brain process lifecycle around an already-created runtime.
 * Kept injectable so shutdown ordering is behaviorally testable without
 * delivering real OS signals or launching a provider.
 */
export function installDeepseekBrainProcessLifecycle(runtime, opts = {}) {
  if (!runtime?.server) throw new Error('deepseek brain runtime server required');
  const processRef = opts.processRef || process;
  const logger = opts.logger || console;
  let shutdownPromise = null;
  let resolveObserved;
  const whenShutdown = new Promise((resolve) => {
    resolveObserved = resolve;
  });

  const shutdown = (signal = 'requested') => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (runtime.server.listening) {
        await new Promise((resolve, reject) => {
          runtime.server.close((error) => (error ? reject(error) : resolve()));
          runtime.server.closeIdleConnections?.();
        });
      }
      // Await this explicitly even though the adapter's server-close listener
      // also initiates it. The runtime method is idempotent and this prevents
      // the process from exiting before strategy/world-memory drains finish.
      await runtime.shutdownMissionRuntime?.();
      processRef.exitCode = 0;
      resolveObserved({ ok: true, signal });
      return { ok: true, signal };
    })().catch((error) => {
      logger.error?.(JSON.stringify({
        evt: 'fabric.deepseek.shutdown_failed',
        signal,
        error: sanitizeLifecycleError(error),
      }));
      processRef.exitCode = 1;
      resolveObserved({ ok: false, signal, error });
      throw error;
    });
    // Signal callbacks cannot be awaited by Node's EventEmitter. Attach a
    // rejection handler here so a failed drain is reported without becoming
    // an unhandled rejection; callers can still await `whenShutdown`.
    void shutdownPromise.catch(() => {});
    return shutdownPromise;
  };

  processRef.once('SIGINT', () => { void shutdown('SIGINT'); });
  processRef.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  return Object.freeze({ shutdown, whenShutdown });
}

export function runDeepseekBrainEntrypoint(opts = {}) {
  const runtime = (opts.start || startDeepseekBrainServer)(opts.serverOptions || {});
  const lifecycle = installDeepseekBrainProcessLifecycle(runtime, opts);
  return Object.freeze({ runtime, lifecycle });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  try {
    runDeepseekBrainEntrypoint();
  } catch (err) {
    console.error(JSON.stringify({
      evt: 'fabric.deepseek.start_failed',
      error: sanitizeLifecycleError(err),
    }));
    process.exit(1);
  }
}
