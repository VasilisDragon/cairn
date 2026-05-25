// goto — pathfind to a coordinate, an entity, or a named block.
//
// Target locking per decision (C):
//   - {x,y,z} / {entity}  — single locked target. Preempts resume on the SAME
//     target; only escalates to advisor on real failure (noPath / timeout).
//   - {block: ...}        — fungible scannable target. Per-target retry up to
//     config.reactive.maxInterruptionsPerTarget (default 3), then exclude and
//     pick a new one. Escalates only when no candidates remain.

import pkgPathfinder from 'mineflayer-pathfinder';
import config from '../config.js';
import log from '../logger.js';
import buildSnapshot from '../state/snapshot.js';
import { blockModificationPolicy } from '../state/world_model.js';
import { awaitBotChunksReady } from '../control/chunk_ready.js';
import {
  awaitGoalReached,
  configurePathingMovements,
  pathingFailureReason,
  posKey,
  worldModelFromContext,
} from './_pathing.js';
import { acquirePathfinder, releasePathfinder, setPathfinderGoal } from './_ownership.js';

const { goals: pfGoals } = pkgPathfinder;

export async function run(bot, params, ctx) {
  const range = params.range ?? 1;
  const threshold = config.reactive?.maxInterruptionsPerTarget ?? 3;
  let blockType = null;

  if (params.block) {
    blockType = bot.registry?.blocksByName?.[params.block] || null;
    if (!blockType) return { ok: false, reason: `unknown block "${params.block}"`, state: buildSnapshot(bot, ctx) };
  } else if (
    !(params.x !== undefined && params.y !== undefined && params.z !== undefined) &&
    !params.entity
  ) {
    return { ok: false, reason: 'goto requires {x,y,z} OR {block} OR {entity}', state: buildSnapshot(bot, ctx) };
  }

  const chunks = await awaitBotChunksReady(bot, ctx.signal, 'reactive preempt waiting for goto chunk readiness');
  if (chunks.preempted) return { preempted: true, reason: chunks.reason, state: buildSnapshot(bot, ctx) };
  if (chunks.error) return { ok: false, reason: `chunk data unavailable during goto: ${errorMessage(chunks.error)}`, state: buildSnapshot(bot, ctx) };

  // Three target forms — only {block} uses the exclude-and-rotate path.
  if (params.x !== undefined && params.y !== undefined && params.z !== undefined) {
    return runLockedXyz(bot, params, ctx, range);
  }
  if (params.entity) {
    return runLockedEntity(bot, params, ctx, range);
  }
  if (params.block) {
    return runScannedBlock(bot, params, ctx, range, threshold, blockType);
  }
  return { ok: false, reason: 'goto requires {x,y,z} OR {block} OR {entity}', state: buildSnapshot(bot, ctx) };
}

function configureMovements(bot, ctx, reason) {
  return configurePathingMovements(bot, ctx, {
    phase: reason,
    allowParkour: false,
    allowSprinting: true,
  });
}

async function runLockedXyz(bot, params, ctx, range) {
  if (ctx.signal?.aborted) return { preempted: true, reason: 'pre-aborted', state: buildSnapshot(bot, ctx) };

  const acquired = acquirePathfinder(bot, 'goto(xyz)', { skill: 'goto', mode: 'xyz' });
  if (!acquired.ok) return pathfinderAcquireFailure(bot, ctx, 'goto', acquired);
  const acq = acquired.acq;
  if (!acq) return { preempted: true, reason: 'reactive holds pathfinder', state: buildSnapshot(bot, ctx) };

  try {
    const goal = new pfGoals.GoalNear(params.x, params.y, params.z, range);
    const movementConfig = configureMovements(bot, ctx, 'goto');
    if (!movementConfig.ok) return movementConfigError(bot, ctx, movementConfig);
    const installed = setPathfinderGoal(bot, acq.token, goal, { movements: movementConfig.movements }, { skill: 'goto', mode: 'xyz' });
    if (!installed.ok) return pathfinderSetGoalFailure(bot, ctx, 'goto', installed);
    const r = await awaitGoalReached(bot, ctx.signal, 60000, { ownerToken: acq.token });
    if (r.kind === 'preempted') return { preempted: true, reason: 'reactive preempt during goto', state: buildSnapshot(bot, ctx) };
    if (r.kind === 'reached') return { ok: true, reason: 'reached', state: buildSnapshot(bot, ctx) };
    return { ok: false, reason: pathingFailureReason(r), state: buildSnapshot(bot, ctx) };
  } finally {
    releasePathfinder(acq, { skill: 'goto', mode: 'xyz' });
  }
}

async function runLockedEntity(bot, params, ctx, range) {
  if (ctx.signal?.aborted) return { preempted: true, reason: 'pre-aborted', state: buildSnapshot(bot, ctx) };
  let target = null;
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (e?.name === params.entity || e?.displayName === params.entity) { target = e; break; }
  }
  if (!target) return { ok: false, reason: `no entity "${params.entity}" in view`, state: buildSnapshot(bot, ctx) };

  const acquired = acquirePathfinder(bot, 'goto(entity)', { skill: 'goto', mode: 'entity' });
  if (!acquired.ok) return pathfinderAcquireFailure(bot, ctx, 'goto', acquired);
  const acq = acquired.acq;
  if (!acq) return { preempted: true, reason: 'reactive holds pathfinder', state: buildSnapshot(bot, ctx) };
  try {
    const movementConfig = configureMovements(bot, ctx, 'goto');
    if (!movementConfig.ok) return movementConfigError(bot, ctx, movementConfig);
    const installed = setPathfinderGoal(bot, acq.token, new pfGoals.GoalFollow(target, range), { movements: movementConfig.movements }, { skill: 'goto', mode: 'entity' });
    if (!installed.ok) return pathfinderSetGoalFailure(bot, ctx, 'goto', installed);
    const r = await awaitGoalReached(bot, ctx.signal, 60000, { ownerToken: acq.token });
    if (r.kind === 'preempted') return { preempted: true, reason: 'reactive preempt during goto', state: buildSnapshot(bot, ctx) };
    if (r.kind === 'reached') return { ok: true, reason: 'reached', state: buildSnapshot(bot, ctx) };
    return { ok: false, reason: pathingFailureReason(r), state: buildSnapshot(bot, ctx) };
  } finally {
    releasePathfinder(acq, { skill: 'goto', mode: 'entity' });
  }
}

async function runScannedBlock(bot, params, ctx, range, threshold, blockType = null) {
  const s = ctx.callState;
  if (!s.excluded) s.excluded = new Set();
  if (s.currentTarget === undefined) s.currentTarget = null;
  if (s.interruptsOnCurrent === undefined) s.interruptsOnCurrent = 0;

  if (ctx.signal?.aborted) return { preempted: true, reason: 'pre-aborted', state: buildSnapshot(bot, ctx) };

  const block = blockType || bot.registry?.blocksByName?.[params.block];
  if (!block) return { ok: false, reason: `unknown block "${params.block}"`, state: buildSnapshot(bot, ctx) };
  const worldModelResult = worldModelFromContext(ctx);
  if (worldModelResult.error) {
    return {
      ok: false,
      reason: `world-model policy unavailable during goto: ${worldModelResult.error.message}`,
      state: buildSnapshot(bot, { ...ctx, worldModelStore: null }),
    };
  }
  const worldModel = worldModelResult.model;

  // Reuse currentTarget if still valid; else scan.
  let candidate = s.currentTarget;
  if (candidate) {
    let b;
    try {
      b = bot.blockAt(candidate);
    } catch (err) {
      return worldQueryFailure(bot, ctx, 'goto block target validation', err);
    }
    const policy = gotoTargetPolicy(candidate, { worldModel });
    if (!b || b.name !== params.block || s.excluded.has(posKey(candidate)) || !policy.ok) {
      if (b && b.name === params.block && !policy.ok) {
        log.executor.warn('goto.protected-target', {
          pos: candidate,
          reason: policy.reason,
          region: policy.region?.id,
        });
      }
      candidate = null;
      s.currentTarget = null;
      s.interruptsOnCurrent = 0;
    }
  }
  if (!candidate) {
    let positions;
    try {
      positions = bot.findBlocks({
        matching: block.id,
        maxDistance: params.maxDistance ?? 64,
        count: 32,
      });
    } catch (err) {
      return worldQueryFailure(bot, ctx, 'goto block scan', err);
    }
    candidate = chooseGotoBlockCandidate(positions, { excluded: s.excluded, worldModel });
    if (!candidate) {
      const stats = gotoCandidateStats(positions, { excluded: s.excluded, worldModel });
      const protectedReason = stats.protected > 0 ? `, protected ${stats.protected}` : '';
      return {
        ok: false,
        reason: `no ${params.block} within ${params.maxDistance ?? 64} blocks (excluded ${s.excluded.size}${protectedReason})`,
        state: buildSnapshot(bot, ctx),
      };
    }
    s.currentTarget = candidate;
    s.interruptsOnCurrent = 0;
  }

  const acquired = acquirePathfinder(bot, 'goto(block)', { skill: 'goto', mode: 'block' });
  if (!acquired.ok) return pathfinderAcquireFailure(bot, ctx, 'goto', acquired);
  const acq = acquired.acq;
  if (!acq) return { preempted: true, reason: 'reactive holds pathfinder', state: buildSnapshot(bot, ctx) };

  try {
    const goal = new pfGoals.GoalNear(candidate.x, candidate.y, candidate.z, range);
    const movementConfig = configureMovements(bot, ctx, 'goto');
    if (!movementConfig.ok) return movementConfigError(bot, ctx, movementConfig);
    const installed = setPathfinderGoal(bot, acq.token, goal, { movements: movementConfig.movements }, { skill: 'goto', mode: 'block' });
    if (!installed.ok) return pathfinderSetGoalFailure(bot, ctx, 'goto', installed);
    const r = await awaitGoalReached(bot, ctx.signal, 60000, { ownerToken: acq.token });
    if (r.kind === 'preempted') {
      s.interruptsOnCurrent += 1;
      if (s.interruptsOnCurrent >= threshold) {
        log.executor.warn('goto.exclude-target', { pos: s.currentTarget, interrupts: s.interruptsOnCurrent });
        s.excluded.add(posKey(s.currentTarget));
        s.currentTarget = null;
        s.interruptsOnCurrent = 0;
      }
      return { preempted: true, reason: 'reactive preempt during goto', state: buildSnapshot(bot, ctx) };
    }
    if (r.kind === 'reached') {
      s.currentTarget = null;
      s.interruptsOnCurrent = 0;
      return { ok: true, reason: 'reached', state: buildSnapshot(bot, ctx) };
    }
    // noPath / timeout — this candidate is unreachable from here. Exclude it
    // and let the advisor decide whether to retry the skill.
    s.excluded.add(posKey(s.currentTarget));
    s.currentTarget = null;
    return { ok: false, reason: pathingFailureReason(r), state: buildSnapshot(bot, ctx) };
  } finally {
    releasePathfinder(acq, { skill: 'goto', mode: 'block' });
  }
}

export function chooseGotoBlockCandidate(positions, opts = {}) {
  const excluded = opts.excluded || new Set();
  return positions.find((p) => !excluded.has(posKey(p)) && gotoTargetPolicy(p, opts).ok) || null;
}

function gotoCandidateStats(positions, opts = {}) {
  const excluded = opts.excluded || new Set();
  let protectedCount = 0;
  for (const p of positions) {
    if (excluded.has(posKey(p))) continue;
    if (!gotoTargetPolicy(p, opts).ok) protectedCount++;
  }
  return { protected: protectedCount };
}

function gotoTargetPolicy(position, opts = {}) {
  if (!opts.worldModel) return { ok: true, action: 'allow', reason: 'no world model' };
  return blockModificationPolicy(opts.worldModel, position, { margin: opts.doNotTouchMargin ?? 0 });
}

function movementConfigError(bot, ctx, config) {
  const stateCtx = config.worldModelError ? { ...ctx, worldModelStore: null } : ctx;
  return {
    ok: false,
    reason: `${config.reason}: ${errorMessage(config.error)}`,
    state: buildSnapshot(bot, stateCtx),
  };
}

function pathfinderAcquireFailure(bot, ctx, phase, acquired) {
  return {
    ok: false,
    reason: `pathfinder acquire failed during ${phase}: ${acquired.message}`,
    state: buildSnapshot(bot, ctx),
  };
}

function pathfinderSetGoalFailure(bot, ctx, phase, installed) {
  return {
    ok: false,
    reason: installed.denied
      ? 'pathfinder setGoal denied'
      : `pathfinder setGoal failed during ${phase}: ${installed.message}`,
    state: buildSnapshot(bot, ctx),
  };
}

function worldQueryFailure(bot, ctx, phase, err) {
  if (ctx.signal?.aborted) {
    return { preempted: true, reason: `reactive preempt during ${phase}`, state: buildSnapshot(bot, ctx) };
  }
  return {
    ok: false,
    reason: `world query failed during ${phase}: ${errorMessage(err)}`,
    state: buildSnapshot(bot, ctx),
  };
}

function errorMessage(err) {
  return err?.message || String(err);
}
