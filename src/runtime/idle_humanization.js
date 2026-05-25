import log from '../logger.js';

export function installIdleHumanization(bot, opts = {}) {
  const loop = createIdleHumanizationLoop(bot, opts);
  if (!loop.installed) return loop;
  loop.start();
  bot.humanizationIdleLoop = loop;
  return loop;
}

export function createIdleHumanizationLoop(bot, opts = {}) {
  const humanizer = bot?.humanizer;
  const logger = opts.logger || log.bot;
  if (!humanizer?.enabled || humanizer.options?.idleMicroBehaviorEnabled !== true) {
    return {
      installed: false,
      reason: 'humanization idle loop disabled',
      start: () => false,
      stop: () => false,
      tick: async () => false,
    };
  }

  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const shouldRun = opts.shouldRun || defaultShouldRunIdleBehavior;
  let stopped = false;
  let running = false;
  let timer = null;
  const controller = new AbortController();

  const schedule = () => {
    if (stopped) return false;
    const delayMs = humanizer.nextIdleDelayMs?.();
    if (!Number.isFinite(delayMs) || delayMs < 0) return false;
    timer = setTimeoutFn(tick, delayMs);
    timer?.unref?.();
    logger.debug?.('humanize.idle-scheduled', { delayMs });
    return true;
  };

  const tick = async () => {
    timer = null;
    if (stopped || running) return false;
    running = true;
    try {
      if (!shouldRun(bot)) {
        logger.debug?.('humanize.idle-skip', idleSkipFields(bot));
        return false;
      }
      await humanizer.performIdleMicroBehavior(bot, {
        reason: 'idle.loop',
        signal: controller.signal,
      });
      return true;
    } catch (err) {
      if (!controller.signal.aborted) {
        logger.warn?.('humanize.idle-error', { err: err?.message || String(err) });
      }
      return false;
    } finally {
      running = false;
      if (!stopped) schedule();
    }
  };

  const start = () => {
    if (stopped || timer || running) return false;
    logger.info?.('humanize.idle-loop-start', {
      minMs: humanizer.options.idleMinMs,
      maxMs: humanizer.options.idleMaxMs,
      mood: humanizer.options.mood,
    });
    return schedule();
  };

  const stop = (reason = 'idle loop stopped') => {
    if (stopped) return false;
    stopped = true;
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
    try {
      controller.abort(reason);
    } catch {}
    logger.info?.('humanize.idle-loop-stop', { reason });
    return true;
  };

  return {
    installed: true,
    start,
    stop,
    tick,
    isRunning: () => running,
    isStopped: () => stopped,
  };
}

function defaultShouldRunIdleBehavior(bot) {
  if (bot?.usingHeldItem === true) return false;
  if (bot?.autoEat?.isEating === true) return false;
  if (bot?.pathfinderOwner && typeof bot.pathfinderOwner.isIdle === 'function' && !bot.pathfinderOwner.isIdle()) {
    return false;
  }
  const executor = bot?.skillExecutor;
  if (executor) {
    if (executor.running === true) return false;
    if (executor.currentCall) return false;
    if (Array.isArray(executor.queue) && executor.queue.length > 0) return false;
  }
  return true;
}

function idleSkipFields(bot) {
  const executor = bot?.skillExecutor;
  return {
    usingHeldItem: bot?.usingHeldItem === true,
    autoEating: bot?.autoEat?.isEating === true,
    pathfinderIdle: bot?.pathfinderOwner?.isIdle?.() ?? null,
    executorRunning: executor?.running === true,
    queueLength: Array.isArray(executor?.queue) ? executor.queue.length : null,
  };
}
