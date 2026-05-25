export async function runBoundedOperation(fn, opts = {}) {
  const {
    timeoutMs = 0,
    timeoutCode = 'OPERATION_TIMEOUT',
    timeoutMessage = `operation timed out after ${timeoutMs}ms`,
    signal = null,
    abortCode = 'OPERATION_ABORTED',
    abortMessage = 'operation aborted',
  } = opts;

  if (!(timeoutMs > 0) && !signal) return Promise.resolve().then(fn);
  if (signal?.aborted) throw operationError(abortCode, abortMessage);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let abortListenerInstalled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (abortListenerInstalled) {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {}
      }
    };
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
    };
    const onAbort = () => finish(operationError(abortCode, abortMessage));

    try {
      signal?.addEventListener?.('abort', onAbort, { once: true });
      abortListenerInstalled = typeof signal?.addEventListener === 'function';
    } catch (err) {
      finish(err);
      return;
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => finish(operationError(timeoutCode, timeoutMessage)), timeoutMs);
    }

    Promise.resolve()
      .then(fn)
      .then((value) => finish(null, value), (err) => finish(err));
  });
}

function operationError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
