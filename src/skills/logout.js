import buildSnapshot from '../state/snapshot.js';

export async function run(bot, params, ctx) {
  if (ctx.signal?.aborted) return { preempted: true, reason: 'pre-aborted', state: buildSnapshot(bot, ctx) };
  const reason = params.reason || 'advisor-requested';
  const state = buildSnapshot(bot, ctx);

  if (typeof bot.quit !== 'function') {
    return { ok: false, reason: 'logout failed: bot.quit unavailable', state };
  }

  try {
    bot.quit(reason);
  } catch (err) {
    if (ctx.signal?.aborted) {
      return { preempted: true, reason: 'reactive preempt during logout', state };
    }
    return { ok: false, reason: `logout failed: ${err.message || String(err)}`, state };
  }

  return { ok: true, reason: `logout (${reason})`, state };
}
