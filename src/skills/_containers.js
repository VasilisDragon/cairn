import config from '../config.js';
import log from '../logger.js';
import { authorizeStorageAccess } from '../state/world_action_authorization.js';
import { runBoundedOperation } from './_operations.js';

export async function openContainer(bot, block, fields = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? config.executor?.containerOpenTimeoutMs ?? 10000;
  const authorize = typeof opts.authorize === 'function'
    ? opts.authorize
    : () => authorizeStorageAccess(
      bot,
      opts.context || bot?.runtimeContext || {},
      block?.position,
      { blockName: block?.name },
    );
  try {
    return await runBoundedOperation(
      () => {
        assertWorldActionAuthorized(authorize, 'container access denied immediately before open', { required: true });
        return bot.openContainer(block);
      },
      {
        timeoutMs,
        timeoutCode: 'CONTAINER_OPEN_TIMEOUT',
        timeoutMessage: `container open timed out after ${timeoutMs}ms`,
        signal: opts.signal,
        abortCode: 'CONTAINER_OPEN_ABORTED',
        abortMessage: 'container open aborted',
      },
    );
  } catch (err) {
    if (err?.code === 'CONTAINER_OPEN_TIMEOUT') {
      log.executor.warn('container.open-timeout', {
        ...fields,
        timeoutMs,
        err: err.message,
      });
    }
    throw err;
  }
}

function assertWorldActionAuthorized(authorize, prefix, { required = false } = {}) {
  if (typeof authorize !== 'function') {
    if (!required) return;
    const error = new Error(`${prefix}: authorization callback unavailable`);
    error.code = 'WORLD_ACTION_DENIED';
    throw error;
  }
  const decision = authorize();
  if (decision?.ok === true) return;
  const error = new Error(`${prefix}: ${decision.reason || 'world action denied'}`);
  error.code = 'WORLD_ACTION_DENIED';
  throw error;
}

export async function depositContainer(container, type, metadata, count, fields = {}, opts = {}) {
  return transferContainer(container, 'deposit', () => container.deposit(type, metadata, count), fields, opts);
}

export async function withdrawContainer(container, type, metadata, count, fields = {}, opts = {}) {
  return transferContainer(container, 'withdraw', () => container.withdraw(type, metadata, count), fields, opts);
}

export async function closeContainer(container, fields = {}, opts = {}) {
  if (typeof container?.close !== 'function') return false;
  const timeoutMs = opts.timeoutMs ?? config.executor?.containerCloseTimeoutMs ?? 5000;
  try {
    await runBoundedOperation(
      () => container.close(),
      {
        timeoutMs,
        timeoutCode: 'CONTAINER_CLOSE_TIMEOUT',
        timeoutMessage: `container close timed out after ${timeoutMs}ms`,
      },
    );
    return true;
  } catch (err) {
    if (err?.code === 'CONTAINER_CLOSE_TIMEOUT') {
      log.executor.warn('container.close-timeout', {
        ...fields,
        timeoutMs,
        err: err.message,
      });
    } else {
      log.executor.warn('container.close-error', {
        ...fields,
        err: err?.message || String(err),
      });
    }
    return false;
  }
}

async function transferContainer(container, operation, fn, fields = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? config.executor?.containerTransferTimeoutMs ?? 10000;
  try {
    return await runBoundedOperation(
      () => {
        assertWorldActionAuthorized(
          opts.authorize,
          `container ${operation} denied immediately before transfer`,
          { required: true },
        );
        return fn();
      },
      {
        timeoutMs,
        timeoutCode: `CONTAINER_${operation.toUpperCase()}_TIMEOUT`,
        timeoutMessage: `container ${operation} timed out after ${timeoutMs}ms`,
        signal: opts.signal,
        abortCode: `CONTAINER_${operation.toUpperCase()}_ABORTED`,
        abortMessage: `container ${operation} aborted`,
      },
    );
  } catch (err) {
    if (err?.code === `CONTAINER_${operation.toUpperCase()}_TIMEOUT`) {
      log.executor.warn(`container.${operation}-timeout`, {
        ...fields,
        timeoutMs,
        err: err.message,
      });
    }
    throw err;
  }
}
