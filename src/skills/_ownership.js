import log from '../logger.js';

export function acquirePathfinder(bot, reason, fields = {}) {
  try {
    return {
      ok: true,
      acq: bot.pathfinderOwner?.acquire?.('skill', { reason }),
    };
  } catch (err) {
    const message = err?.message || String(err);
    log.executor.warn('pathfinder.acquire-error', {
      ...fields,
      reason,
      err: message,
    });
    return { ok: false, error: err, message };
  }
}

export function setPathfinderGoal(bot, token, goal, opts = {}, fields = {}) {
  try {
    if (typeof bot.pathfinderOwner?.setGoal !== 'function') {
      return { ok: false, message: 'pathfinder setGoal unavailable' };
    }
    if (bot.pathfinderOwner.setGoal(token, goal, opts)) return { ok: true };
    return { ok: false, denied: true, message: 'pathfinder setGoal denied' };
  } catch (err) {
    const message = err?.message || String(err);
    log.executor.warn('pathfinder.setGoal-error', {
      ...fields,
      err: message,
    });
    return { ok: false, error: err, message };
  }
}

export function releasePathfinder(acq, fields = {}) {
  if (typeof acq?.release !== 'function') return false;
  try {
    acq.release();
    return true;
  } catch (err) {
    log.executor.warn('pathfinder.release-error', {
      ...fields,
      err: err?.message || String(err),
    });
    return false;
  }
}
