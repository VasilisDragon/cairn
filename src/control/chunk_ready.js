import log from '../logger.js';

const DEFAULT_FALLBACK_MS = 1500;
const DEFAULT_WAIT_TIMEOUT_MS = 30000;

export function installChunkReadyGate(bot, opts = {}) {
  const logger = opts.logger || log.bot;
  const fallbackMs = opts.fallbackMs ?? DEFAULT_FALLBACK_MS;
  const waitTimeoutMs = opts.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  let generation = 0;
  let currentPromise = null;
  const pendingResolves = new Set();

  function createGate() {
    let resolveGate;
    const promise = new Promise((resolve) => {
      resolveGate = resolve;
    });
    pendingResolves.add(resolveGate);
    return promise;
  }

  currentPromise = createGate();
  const propertyInstalled = installChunksReadyProperty(bot, () => currentPromise, logger);

  async function refresh(reason) {
    const myGeneration = ++generation;
    currentPromise = createGate();
    try {
      if (typeof bot.waitForChunksToLoad === 'function') {
        await withTimeout(
          bot.waitForChunksToLoad(),
          waitTimeoutMs,
          `waitForChunksToLoad timed out after ${waitTimeoutMs}ms`,
        );
      } else {
        await sleep(fallbackMs);
      }
    } catch (err) {
      if (err?.code === 'ETIMEDOUT') {
        logger.warn('chunksReady.wait-timeout', { reason, generation: myGeneration, timeoutMs: waitTimeoutMs, err: err.message });
      } else {
        logger.warn('chunksReady.wait-error', { reason, generation: myGeneration, err: err?.message || String(err) });
      }
    }
    if (myGeneration !== generation) return;
    logger.info('chunksReady', { reason, generation: myGeneration });
    resolvePending();
  }

  addBotListener(bot, 'spawn', () => {
    void refresh('spawn');
  }, logger);
  addBotListener(bot, 'respawn', () => {
    void refresh('respawn');
  }, logger);

  return {
    current: () => currentPromise,
    generation: () => generation,
    propertyInstalled: () => propertyInstalled,
  };

  function resolvePending() {
    const resolves = Array.from(pendingResolves);
    pendingResolves.clear();
    for (const resolveGate of resolves) resolveGate();
  }
}

export function awaitChunksReady(chunksReady, signal, reason = 'reactive preempt waiting for chunksReady', opts = {}) {
  if (signal?.aborted) return Promise.resolve({ preempted: true, reason });
  let then;
  try {
    then = chunksReady?.then;
  } catch (err) {
    return Promise.resolve({ ok: false, error: err });
  }
  if (typeof then !== 'function') return Promise.resolve({ ok: true });

  return new Promise((resolve) => {
    const logger = opts.logger || log.bot;
    let done = false;
    let abortListenerInstalled = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (abortListenerInstalled) {
        removeAbortListener(signal, onAbort, logger);
      }
      resolve(value);
    };
    const onAbort = () => finish({ preempted: true, reason });
    try {
      signal?.addEventListener?.('abort', onAbort, { once: true });
      abortListenerInstalled = typeof signal?.addEventListener === 'function';
    } catch (err) {
      finish({ ok: false, error: err });
      return;
    }
    try {
      then.call(
        chunksReady,
        () => finish({ ok: true }),
        (err) => finish({ ok: false, error: err }),
      );
    } catch (err) {
      finish({ ok: false, error: err });
    }
  });
}

export function awaitBotChunksReady(bot, signal, reason = 'reactive preempt waiting for chunksReady', opts = {}) {
  let chunksReady;
  try {
    chunksReady = bot?.chunksReady;
  } catch (err) {
    return Promise.resolve({ ok: false, error: err });
  }
  return awaitChunksReady(chunksReady, signal, reason, opts);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function installChunksReadyProperty(bot, getCurrentPromise, logger) {
  try {
    Object.defineProperty(bot, 'chunksReady', {
      configurable: true,
      enumerable: true,
      get() {
        return getCurrentPromise();
      },
    });
    return true;
  } catch (err) {
    logger?.warn?.('chunksReady.install-error', { err: err?.message || String(err) });
    return false;
  }
}

function addBotListener(bot, eventName, listener, logger) {
  try {
    bot.on(eventName, listener);
    return true;
  } catch (err) {
    logger?.warn?.('chunksReady.listener-error', {
      event: eventName,
      err: err?.message || String(err),
    });
    return false;
  }
}

function removeAbortListener(signal, listener, logger) {
  try {
    signal?.removeEventListener?.('abort', listener);
  } catch (err) {
    logger?.warn?.('chunksReady.abort-listener-remove-error', { err: err?.message || String(err) });
  }
}
