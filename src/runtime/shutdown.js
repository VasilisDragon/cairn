import process from 'node:process';

import log from '../logger.js';

export function shutdownRuntime({
  bot,
  executor,
  reason,
  logger = log.startup,
  exit = process.exit,
  setTimeoutFn = setTimeout,
  exitDelayMs = 500,
} = {}) {
  logger.warn('shutdown', { reason });

  try {
    executor?.dispose?.();
  } catch (err) {
    logger.error('shutdown.dispose-error', { reason, err: errorMessage(err) });
  }

  try {
    bot?.quit?.(reason);
  } catch (err) {
    logger.error('shutdown.quit-error', { reason, err: errorMessage(err) });
  }

  return setTimeoutFn(() => exit(0), exitDelayMs);
}

export function createGracefulShutdown({
  bot,
  executor,
  getExecutor,
  logger = log.startup,
  exit = process.exit,
  setTimeoutFn = setTimeout,
  exitDelayMs = 500,
} = {}) {
  let shuttingDown = false;
  return (reason) => {
    if (shuttingDown) {
      logger.warn('shutdown.duplicate', { reason });
      return null;
    }
    shuttingDown = true;
    return shutdownRuntime({
      bot,
      executor: typeof getExecutor === 'function' ? getExecutor() : executor,
      reason,
      logger,
      exit,
      setTimeoutFn,
      exitDelayMs,
    });
  };
}

function errorMessage(err) {
  return err?.message || String(err);
}
