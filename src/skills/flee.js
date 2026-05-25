// flee — advisor-driven flee (distinct from the reactive layer's own flee).
// Locked target per decision (C): the from-vector is captured on first call
// and reused across preempt/resume cycles.

import pkgPathfinder from 'mineflayer-pathfinder';
import buildSnapshot from '../state/snapshot.js';
import { awaitGoalReached, configurePathingMovements, pathingFailureReason } from './_pathing.js';
import { acquirePathfinder, releasePathfinder, setPathfinderGoal } from './_ownership.js';

const { goals: pfGoals } = pkgPathfinder;

const HOSTILE = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch',
  'pillager', 'vindicator', 'evoker', 'ravager', 'husk', 'stray',
  'drowned', 'phantom', 'piglin', 'piglin_brute', 'magma_cube', 'slime',
  'blaze', 'guardian', 'silverfish',
]);

export async function run(bot, params, ctx) {
  const me = bot.entity?.position;
  if (!me) return { ok: false, reason: 'no bot position', state: buildSnapshot(bot, ctx) };

  const s = ctx.callState;
  if (!s.target) {
    // Compute and lock the target goal once.
    let fromPos;
    if (params.from === 'nearest_hostile') {
      const e = nearestHostile(bot);
      if (!e) return { ok: true, reason: 'no hostile in view', state: buildSnapshot(bot, ctx) };
      fromPos = e.position;
    } else if (typeof params.from === 'object' && params.from) {
      fromPos = { x: params.from.x, y: params.from.y, z: params.from.z };
    } else {
      return { ok: false, reason: 'flee.from must be "nearest_hostile" or {x,y,z}', state: buildSnapshot(bot, ctx) };
    }
    const dist = params.distance ?? 16;
    const dx = me.x - fromPos.x;
    const dz = me.z - fromPos.z;
    const mag = Math.hypot(dx, dz) || 1;
    s.target = { x: me.x + (dx / mag) * dist, y: me.y, z: me.z + (dz / mag) * dist };
  }

  if (ctx.signal?.aborted) return { preempted: true, reason: 'pre-aborted', state: buildSnapshot(bot, ctx) };

  const acquired = acquirePathfinder(bot, 'flee', { skill: 'flee' });
  if (!acquired.ok) {
    return { ok: false, reason: `pathfinder acquire failed during flee: ${acquired.message}`, state: buildSnapshot(bot, ctx) };
  }
  const acq = acquired.acq;
  if (!acq) return { preempted: true, reason: 'reactive holds pathfinder', state: buildSnapshot(bot, ctx) };
  try {
    const movementConfig = configurePathingMovements(bot, ctx, {
      phase: 'flee',
      allowSprinting: true,
    });
    if (!movementConfig.ok) {
      const stateCtx = movementConfig.worldModelError ? { ...ctx, worldModelStore: null } : ctx;
      return {
        ok: false,
        reason: `${movementConfig.reason}: ${errorMessage(movementConfig.error)}`,
        state: buildSnapshot(bot, stateCtx),
      };
    }
    const installed = setPathfinderGoal(bot, acq.token, new pfGoals.GoalNear(s.target.x, s.target.y, s.target.z, 1), { movements: movementConfig.movements }, { skill: 'flee' });
    if (!installed.ok) {
      const reason = installed.denied
        ? 'pathfinder setGoal denied'
        : `pathfinder setGoal failed during flee: ${installed.message}`;
      return { ok: false, reason, state: buildSnapshot(bot, ctx) };
    }
    const r = await awaitGoalReached(bot, ctx.signal, 15000, { ownerToken: acq.token });
    if (r.kind === 'preempted') return { preempted: true, reason: 'reactive preempt during flee', state: buildSnapshot(bot, ctx) };
    if (r.kind === 'reached') return { ok: true, reason: 'reached safe distance', state: buildSnapshot(bot, ctx) };
    return { ok: false, reason: `flee pathing failed: ${pathingFailureReason(r)}`, state: buildSnapshot(bot, ctx) };
  } finally {
    releasePathfinder(acq, { skill: 'flee' });
  }
}

function errorMessage(err) {
  return err?.message || String(err);
}

function nearestHostile(bot) {
  const me = bot.entity.position;
  let best = null;
  let bestD = Infinity;
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e?.position || !HOSTILE.has(e.name)) continue;
    const d = me.distanceTo(e.position);
    if (d < bestD) { best = e; bestD = d; }
  }
  return best;
}
