import pkgPathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

import buildSnapshot from '../state/snapshot.js';
import { awaitBotChunksReady } from '../control/chunk_ready.js';
import { clonePositionPlain, toVec3 } from '../state/positions.js';
import {
  awaitCollectBlock,
  awaitGoalReached,
  configurePathingMovements,
  pathingFailureReason,
  stabilizeVerticalPosition,
} from './_pathing.js';
import { acquirePathfinder, releasePathfinder, setPathfinderGoal } from './_ownership.js';

const { goals: pfGoals = {} } = pkgPathfinder;

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_DIRECTION = 'north';
const DEFAULT_HAZARD_SCAN_DEPTH = 3;
const DEFAULT_DIG_TIMEOUT_MS = 30000;
const DEFAULT_WALK_TIMEOUT_MS = 45000;
const DEFAULT_STAGE_WALK_TIMEOUT_MS = 12000;
const SHAFT_START_SEARCH_RADIUS = 7;
const SHAFT_START_FORWARD_CLEARANCE = 3;
const SHAFT_START_DROP_SCAN_DEPTH = 2;
const DIG_GROUND_WAIT_MS = 1500;
const DIG_STABLE_GROUND_MS = 0;
const PASSABLE_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const AIR_GAP_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const WORKSTATION_BLOCKS = new Set(['crafting_table', 'furnace']);
const HAZARD_BLOCK_CLASSES = new Map([
  ['lava', 'lava'],
  ['flowing_lava', 'lava'],
  ['water', 'water'],
  ['flowing_water', 'water'],
]);
const DIRECTIONS = Object.freeze({
  north: Object.freeze({ dx: 0, dz: -1 }),
  south: Object.freeze({ dx: 0, dz: 1 }),
  east: Object.freeze({ dx: 1, dz: 0 }),
  west: Object.freeze({ dx: -1, dz: 0 }),
});

export async function run(bot, params = {}, ctx = {}) {
  const targetY = Number(params.targetY);
  if (!Number.isInteger(targetY)) return failed(bot, ctx, 'excavate_shaft requires integer targetY');
  const maxDepth = positiveInteger(params.maxDepth, DEFAULT_MAX_DEPTH);
  const hazardScanDepth = positiveInteger(params.hazardScanDepth, DEFAULT_HAZARD_SCAN_DEPTH);
  const requestedDirection = params.direction || DEFAULT_DIRECTION;
  const direction = DIRECTIONS[requestedDirection];
  if (!direction) return failed(bot, ctx, `unsupported shaft direction "${requestedDirection}"`);
  const stopOnExposedBlock = normalizeStopOnExposedBlock(params.stopOnExposedBlock);

  const chunks = await awaitBotChunksReady(bot, ctx.signal, 'reactive preempt waiting for excavate_shaft chunk readiness');
  if (chunks.preempted) return preempted(bot, ctx, chunks.reason);
  if (chunks.error) return failed(bot, ctx, `chunk data unavailable during excavate_shaft: ${errorMessage(chunks.error)}`);

  const s = ctx.callState || {};
  const wantsReturnToSurface = params.returnToSurface === true;
  if (wantsReturnToSurface && stopOnExposedBlock.size > 0) {
    return failed(bot, ctx, 'stopOnExposedBlock is only supported while descending, not with returnToSurface');
  }
  if (wantsReturnToSurface) {
    const prepared = prepareReturnState(s);
    if (!prepared.ok) return failed(bot, ctx, prepared.reason);
  }

  const ownerMode = typeof bot?.pathfinderOwner?.acquire === 'function';
  const acquired = ownerMode ? acquirePathfinder(bot, 'excavate_shaft', { skill: 'excavate_shaft' }) : { ok: true, acq: null };
  if (!acquired.ok) return failed(bot, ctx, `pathfinder acquire failed during excavate_shaft: ${acquired.message}`);
  const acq = acquired.acq;
  if (ownerMode && !acq) return preempted(bot, ctx, 'reactive holds pathfinder');

  try {
    if (wantsReturnToSurface) {
      return await returnToSurface(bot, ctx, s, acq?.token);
    }

    const wasFreshStart = !s.initialized || !inspectExcavationContinuity(s, currentFeet(bot)).ok;
    if (shouldStabilizeBeforeDescent(bot, s)) {
      const stabilized = await stabilizeVerticalPosition(bot, ctx, {
        reason: 'excavate_shaft.start',
        direction,
        ownerToken: acq?.token,
        maxSteps: 4,
        scanRadius: 5,
        maxScanDown: 12,
        checkHeadClearance: false,
        enablePillarUp: false,
        enableStepUp: false,
      });
      if (stabilized.preempted) return preempted(bot, ctx, stabilized.reason);
      if (!stabilized.ok) {
        return {
          ok: false,
          reason: `vertical stabilization failed before shaft start: ${stabilized.reason}`,
          state: buildSnapshot(bot, ctx),
          verticalStabilization: stabilized,
        };
      }
      s.startStabilization = stabilized;
    }

    const needsFreshStart = wasFreshStart || !s.initialized || !inspectExcavationContinuity(s, currentFeet(bot)).ok;
    if (needsFreshStart) {
      const staged = await stageToSafeShaftStart(bot, ctx, direction, acq?.token);
      if (staged.preempted) return preempted(bot, ctx, staged.reason);
      if (!staged.ok) {
        return {
          ok: false,
          reason: staged.reason,
          code: staged.code,
          state: buildSnapshot(bot, ctx),
          shaftStartStaging: staged,
        };
      }
      s.startStaging = staged;
    }

    initializeState(bot, s, requestedDirection, targetY, maxDepth, hazardScanDepth);

    while (currentFeet(bot).y > targetY) {
      if (s.steps >= s.maxDepth) {
        return {
          ok: false,
          reason: `maxDepth ${s.maxDepth} reached before targetY ${targetY}`,
          state: buildSnapshot(bot, ctx),
          escapeEntryPosition: s.entryPosition,
          steps: s.steps,
        };
      }

      ensureCurrentStep(bot, s, direction);
      const step = s.currentStep;
      const hazardScan = ensureStepHazardChecked(bot, ctx, s, direction);
      if (!hazardScan.ok) return hazardScan;

      if (s.phase === 'digHead') {
        const dug = await digBlock(bot, ctx, step.head, 'head', acq?.token, false);
        if (dug.preempted || !dug.ok) return dug;
        s.phase = 'digFeet';
      }

      if (s.phase === 'digFeet') {
        const dug = await digBlock(bot, ctx, step.feet, 'feet', acq?.token, false);
        if (dug.preempted || !dug.ok) return dug;
        s.phase = 'digDown';
      }

      if (s.phase === 'walkForward') {
        s.phase = 'digDown';
      }

      if (s.phase === 'digDown') {
        const positioned = await moveOffStepDownTarget(bot, ctx, step, acq?.token);
        if (positioned.preempted || !positioned.ok) return positioned;
        const dug = await digBlock(bot, ctx, step.down, 'step-down', acq?.token, false);
        if (dug.preempted || !dug.ok) return dug;
        s.phase = 'descend';
      }

      if (s.phase === 'descend') {
        const descended = await walkTo(bot, ctx, step.descend, acq?.token);
        if (descended.preempted || !descended.ok) return descended;
        s.steps += 1;
        const exit = currentFeet(bot);
        s.escapeTrail.push(exit);
        const exposed = scanAdjacentForExposedBlock(bot, exit, direction, stopOnExposedBlock);
        if (exposed) {
          const escapeTrail = [...s.escapeTrail];
          publishEscapeTrailProtection(ctx, escapeTrail);
          return {
            ok: true,
            reason: `exposed target block ${exposed.name} at (${formatHazardPosition(exposed.position)})`,
            state: buildSnapshot(bot, ctx),
            stoppedOnExposedBlock: true,
            exposedBlock: exposed,
            entryPosition: s.entryPosition,
            exitPosition: exit,
            steps: s.steps,
            escapeTrail,
          };
        }
        s.currentStep = null;
        s.phase = 'digHead';
      }
    }

    const exitPosition = currentFeet(bot);
    const escapeTrail = [...s.escapeTrail];
    publishEscapeTrailProtection(ctx, escapeTrail);
    return {
      ok: true,
      reason: `excavated staircase shaft to y=${exitPosition.y}`,
      state: buildSnapshot(bot, ctx),
      entryPosition: s.entryPosition,
      exitPosition,
      steps: s.steps,
      escapeTrail,
      startStabilization: s.startStabilization,
      startStaging: s.startStaging,
    };
  } finally {
    if (acq) releasePathfinder(acq, { skill: 'excavate_shaft' });
  }
}

function shouldStabilizeBeforeDescent(bot, s) {
  if (!s.initialized) return true;
  const continuity = inspectExcavationContinuity(s, currentFeet(bot));
  return !continuity.ok;
}

function prepareReturnState(s) {
  if (!Array.isArray(s.escapeTrail) || s.escapeTrail.length === 0) {
    return { ok: false, reason: 'returnToSurface requires a recorded escapeTrail' };
  }
  if (!s.entryPosition) s.entryPosition = clonePositionPlain(s.escapeTrail[0]);
  if (!Number.isInteger(s.steps)) s.steps = Math.max(0, s.escapeTrail.length - 1);
  s.initialized = true;
  return { ok: true };
}

function initializeState(bot, s, direction, targetY, maxDepth, hazardScanDepth) {
  const entry = currentFeet(bot);
  if (s.initialized) {
    const continuity = inspectExcavationContinuity(s, entry);
    if (!continuity.ok) {
      resetExcavationState(s, entry, direction, targetY, maxDepth, hazardScanDepth);
      return;
    }
    const samePlan = s.targetY === targetY && sameDirection(s.direction, direction);
    if (s.currentStep && !continuity.currentStepMatches) {
      s.currentStep = null;
      s.phase = 'digHead';
    }
    if (!s.phase || s.phase === 'returned') s.phase = 'digHead';
    if (!Number.isInteger(s.steps)) s.steps = Math.max(0, normalizeTrail(s.escapeTrail).length - 1);
    s.direction = direction;
    s.targetY = targetY;
    s.maxDepth = samePlan ? (s.maxDepth ?? maxDepth) : Math.max(s.steps + maxDepth, maxDepth);
    s.hazardScanDepth = hazardScanDepth;
    return;
  }

  resetExcavationState(s, entry, direction, targetY, maxDepth, hazardScanDepth);
}

function resetExcavationState(s, entry, direction, targetY, maxDepth, hazardScanDepth) {
  s.initialized = true;
  s.entryPosition = entry;
  s.escapeTrail = [entry];
  s.steps = 0;
  s.phase = 'digHead';
  s.direction = direction;
  s.targetY = targetY;
  s.maxDepth = maxDepth;
  s.hazardScanDepth = hazardScanDepth;
  s.currentStep = null;
  s.returnedToSurface = false;
}

function inspectExcavationContinuity(s, current) {
  if (s.returnedToSurface === true) return { ok: false, reason: 'already_returned' };
  const trail = normalizeTrail(s.escapeTrail);
  if (trail.length === 0) return { ok: false, reason: 'missing_escape_trail' };

  const currentStepMatches = s.currentStep ? currentMatchesStepResumePosition(current, s.currentStep) : false;
  if (trail.some((entry) => positionsEqual(entry, current)) || currentStepMatches) {
    return { ok: true, currentStepMatches };
  }

  return { ok: false, reason: 'current_position_not_on_excavation' };
}

function currentMatchesStepResumePosition(current, step) {
  return [
    step?.start,
    blockFeetPosition(step?.forward),
    blockFeetPosition(step?.descend),
  ].some((position) => positionsEqual(current, position));
}

function sameDirection(a, b) {
  return Boolean(a && b && a.dx === b.dx && a.dz === b.dz);
}

async function moveOffStepDownTarget(bot, ctx, step, ownerToken) {
  const support = supportUnderPosition(bot.entity?.position);
  if (!positionsEqual(step?.down, support)) return { ok: true, moved: false };

  const walked = await walkTo(bot, ctx, centerPosition(step.start), ownerToken, {
    phase: 'excavate_shaft.step-down-staging',
  });
  if (walked.preempted || !walked.ok) return walked;

  const nextSupport = supportUnderPosition(bot.entity?.position);
  if (positionsEqual(step?.down, nextSupport)) {
    return failed(bot, ctx, `shaft step-down dig refused while standing on target support at ${formatBlock(step.down)}`);
  }
  return { ok: true, moved: true };
}

async function stageToSafeShaftStart(bot, ctx, direction, ownerToken) {
  const origin = currentFeet(bot);
  const current = inspectShaftStart(bot, origin, direction, { currentFeet: origin });
  if (current.ok) {
    return {
      ok: true,
      moved: false,
      origin,
      position: origin,
      reason: 'current shaft start is safe',
      inspected: 1,
      inspection: current,
    };
  }
  if (shouldDeferStartFailureToShaftHazardScan(current)) {
    return {
      ok: true,
      moved: false,
      origin,
      position: origin,
      reason: 'current shaft start has a physical hazard; deferring to shaft hazard scan',
      inspected: 1,
      deferredToHazardScan: true,
      inspection: current,
    };
  }

  const candidates = findShaftStartCandidates(bot, origin, direction);
  const walkFailures = [];
  for (const candidate of candidates) {
    const walked = await walkTo(bot, ctx, centerPosition(candidate.position), ownerToken, {
      timeoutMs: DEFAULT_STAGE_WALK_TIMEOUT_MS,
      phase: 'excavate_shaft.staging',
    });
    if (walked.preempted) return walked;
    if (!walked.ok) {
      walkFailures.push({
        position: candidate.position,
        reason: walked.reason,
      });
      continue;
    }

    const arrived = currentFeet(bot);
    const arrivedInspection = inspectShaftStart(bot, arrived, direction, { currentFeet: arrived });
    if (!arrivedInspection.ok) {
      walkFailures.push({
        position: candidate.position,
        arrived,
        reason: `arrival failed shaft start inspection: ${arrivedInspection.reason}`,
      });
      continue;
    }

    return {
      ok: true,
      moved: true,
      origin,
      position: arrived,
      selectedCandidate: candidate.position,
      reason: `staged to safe shaft start at ${formatBlock(arrived)}`,
      inspected: candidates.length + 1,
      originalInspection: current,
      inspection: arrivedInspection,
      walkFailures,
    };
  }

  return {
    ok: false,
    code: 'no_safe_shaft_start_within_radius',
    reason: `no_safe_shaft_start_within_radius: no reachable safe staircase start within ${SHAFT_START_SEARCH_RADIUS} blocks of ${formatBlock(origin)}`,
    origin,
    radius: SHAFT_START_SEARCH_RADIUS,
    originalInspection: current,
    candidateCount: candidates.length,
    walkFailures,
  };
}

function findShaftStartCandidates(bot, origin, direction) {
  const candidates = [];
  for (let dx = -SHAFT_START_SEARCH_RADIUS; dx <= SHAFT_START_SEARCH_RADIUS; dx += 1) {
    for (let dz = -SHAFT_START_SEARCH_RADIUS; dz <= SHAFT_START_SEARCH_RADIUS; dz += 1) {
      if (dx === 0 && dz === 0) continue;
      const distance = Math.abs(dx) + Math.abs(dz);
      if (distance > SHAFT_START_SEARCH_RADIUS) continue;
      const position = { x: origin.x + dx, y: origin.y, z: origin.z + dz };
      const inspection = inspectShaftStart(bot, position, direction, { currentFeet: origin });
      if (!inspection.ok) continue;
      candidates.push({
        position,
        inspection,
        distance,
        forwardClearance: inspection.forwardClearance,
      });
    }
  }
  candidates.sort((a, b) => (
    a.distance - b.distance
    || b.forwardClearance - a.forwardClearance
    || a.position.x - b.position.x
    || a.position.z - b.position.z
  ));
  return candidates;
}

function shouldDeferStartFailureToShaftHazardScan(inspection) {
  return typeof inspection?.reason === 'string' && inspection.reason.includes('_hazard:');
}

function inspectShaftStart(bot, feet, direction, options = {}) {
  const position = blockFeetPosition(feet);
  if (!position) return { ok: false, reason: 'invalid_start_position' };
  const currentFeetOption = blockFeetPosition(options.currentFeet);
  const isCurrent = positionsEqual(position, currentFeetOption);

  const support = queryBlock(bot, { x: position.x, y: position.y - 1, z: position.z });
  if (!support.ok) return { ok: false, reason: `support query failed: ${support.reason}` };
  if (!isSolidSupport(support.block)) {
    return {
      ok: false,
      reason: `unsafe_start_support:${normalizeBlockName(support.block?.name) || 'unknown'}`,
      support: blockSummary(support.block),
    };
  }

  if (!isCurrent) {
    for (let dy = 0; dy <= 1; dy += 1) {
      const body = queryBlock(bot, { x: position.x, y: position.y + dy, z: position.z });
      if (!body.ok) return { ok: false, reason: `body query failed: ${body.reason}` };
      if (!isPassable(body.block)) {
        return {
          ok: false,
          reason: `candidate_body_blocked:${normalizeBlockName(body.block?.name) || 'unknown'}`,
          blockedAt: { x: position.x, y: position.y + dy, z: position.z },
        };
      }
    }
  }

  for (let dy = isCurrent ? 1 : 0; dy <= 1; dy += 1) {
    const body = queryBlock(bot, { x: position.x, y: position.y + dy, z: position.z });
    if (!body.ok) return { ok: false, reason: `body query failed: ${body.reason}` };
    const unsafe = unsafeShaftStartBlock(body.block);
    if (unsafe) {
      return {
        ok: false,
        reason: `unsafe_body_${unsafe}:${normalizeBlockName(body.block?.name) || 'unknown'}`,
        blockedAt: { x: position.x, y: position.y + dy, z: position.z },
      };
    }
  }

  const forward = inspectForwardCorridor(bot, position, direction);
  if (!forward.ok) return forward;

  const drop = inspectAdjacentDropRisk(bot, position, direction);
  if (!drop.ok) return drop;

  const firstStep = scanAheadForHazard(bot, position, direction, 1);
  if (!firstStep.ok) {
    return {
      ok: false,
      reason: `unsafe_initial_shaft_step:${firstStep.reason}`,
      hazardClass: firstStep.hazardClass,
      blockName: firstStep.blockName,
      blockedAt: firstStep.position,
      role: firstStep.role,
    };
  }

  return {
    ok: true,
    reason: 'safe_shaft_start',
    position,
    support: blockSummary(support.block),
    forwardClearance: forward.clearance,
  };
}

function inspectForwardCorridor(bot, position, direction) {
  let clearance = 0;
  for (let depth = 1; depth <= SHAFT_START_FORWARD_CLEARANCE; depth += 1) {
    const x = position.x + (direction.dx * depth);
    const z = position.z + (direction.dz * depth);
    for (let dy = 0; dy <= 1; dy += 1) {
      const probe = { x, y: position.y + dy, z };
      const result = queryBlock(bot, probe);
      if (!result.ok) return { ok: false, reason: `forward query failed: ${result.reason}` };
      const unsafe = unsafeShaftStartBlock(result.block);
      if (unsafe) {
        return {
          ok: false,
          reason: `unsafe_forward_${unsafe}:${normalizeBlockName(result.block?.name) || 'unknown'}`,
          blockedAt: probe,
          depth,
        };
      }
    }
    clearance = depth;
  }
  return { ok: true, clearance };
}

function inspectAdjacentDropRisk(bot, position, direction) {
  const checks = [
    { x: -direction.dz, z: direction.dx },
    { x: direction.dz, z: -direction.dx },
    { x: -direction.dx, z: -direction.dz },
  ];
  for (const offset of checks) {
    const adjacent = { x: position.x + offset.x, y: position.y, z: position.z + offset.z };
    const foot = queryBlock(bot, adjacent);
    if (!foot.ok) return { ok: false, reason: `drop query failed: ${foot.reason}` };
    if (!isPassable(foot.block)) continue;

    let passableBelow = 0;
    for (let depth = 1; depth <= SHAFT_START_DROP_SCAN_DEPTH; depth += 1) {
      const below = queryBlock(bot, { x: adjacent.x, y: adjacent.y - depth, z: adjacent.z });
      if (!below.ok) return { ok: false, reason: `drop query failed: ${below.reason}` };
      if (!isPassable(below.block)) break;
      passableBelow += 1;
    }
    if (passableBelow >= SHAFT_START_DROP_SCAN_DEPTH) {
      return {
        ok: false,
        reason: 'unsafe_adjacent_drop',
        adjacent,
        depth: passableBelow,
      };
    }
  }
  return { ok: true };
}

function blockFeetPosition(position) {
  if (!position) return null;
  return {
    x: Math.floor(Number(position.x)),
    y: Math.floor(Number(position.y)),
    z: Math.floor(Number(position.z)),
  };
}

function supportUnderPosition(position) {
  const feet = blockFeetPosition(position);
  if (!feet) return null;
  return { x: feet.x, y: feet.y - 1, z: feet.z };
}

function ensureCurrentStep(bot, s, direction) {
  if (s.currentStep) return;
  const start = currentFeet(bot);
  const ahead = { x: start.x + direction.dx, y: start.y, z: start.z + direction.dz };
  s.currentStep = {
    start,
    head: { x: ahead.x, y: ahead.y + 1, z: ahead.z },
    feet: ahead,
    forward: centerPosition(ahead),
    down: { x: ahead.x, y: ahead.y - 1, z: ahead.z },
    descend: centerPosition({ x: ahead.x, y: ahead.y - 1, z: ahead.z }),
  };
}

async function returnToSurface(bot, ctx, s, ownerToken) {
  const trail = normalizeTrail(s.escapeTrail);
  const current = currentFeet(bot);
  let index = trail.length - 1;
  if (positionsEqual(current, trail[index])) index -= 1;

  let returnSteps = 0;
  for (; index >= 0; index -= 1) {
    const walked = await walkTo(bot, ctx, centerPosition(trail[index]), ownerToken);
    if (walked.preempted || !walked.ok) return walked;
    returnSteps += 1;
  }

  s.phase = 'returned';
  s.returnedToSurface = true;
  const exitPosition = currentFeet(bot);
  clearEscapeTrailProtection(ctx);
  return {
    ok: true,
    reason: `returned to shaft entry at ${formatBlock(exitPosition)}`,
    state: buildSnapshot(bot, ctx),
    entryPosition: clonePositionPlain(s.entryPosition || trail[0]),
    exitPosition,
    steps: s.steps,
    returnSteps,
    escapeTrail: trail,
  };
}

function ensureStepHazardChecked(bot, ctx, s, direction) {
  if (s.currentStep?.hazardScanChecked) return { ok: true };
  const hazard = scanAheadForHazard(bot, s.currentStep.start, direction, s.hazardScanDepth);
  if (!hazard.ok) return hazardFailure(bot, ctx, hazard);
  s.currentStep.hazardScanChecked = true;
  return { ok: true };
}

function scanAdjacentForExposedBlock(bot, feetPosition, direction, stopBlockNames) {
  if (!(stopBlockNames instanceof Set) || stopBlockNames.size === 0) return null;

  const anchors = [
    clonePositionPlain(feetPosition),
    { x: feetPosition.x, y: feetPosition.y + 1, z: feetPosition.z },
  ].filter(Boolean);
  const offsets = adjacentScanOffsets(direction);
  const seen = new Set();

  for (const anchor of anchors) {
    for (const offset of offsets) {
      const position = {
        x: anchor.x + offset.x,
        y: anchor.y + offset.y,
        z: anchor.z + offset.z,
      };
      const key = formatHazardPosition(position);
      if (seen.has(key)) continue;
      seen.add(key);

      let block;
      try {
        block = bot.blockAt(toVec3(position));
      } catch {
        continue;
      }
      const name = normalizeBlockName(block?.name);
      if (!stopBlockNames.has(name)) continue;
      return {
        name,
        position: clonePositionPlain(position),
      };
    }
  }

  return null;
}

function adjacentScanOffsets(direction) {
  const forward = { x: direction.dx, y: 0, z: direction.dz };
  const right = { x: -direction.dz, y: 0, z: direction.dx };
  const left = { x: direction.dz, y: 0, z: -direction.dx };
  const backward = { x: -direction.dx, y: 0, z: -direction.dz };
  return [
    forward,
    right,
    left,
    backward,
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
  ];
}

function scanAheadForHazard(bot, start, direction, scanDepth) {
  for (let depth = 1; depth <= scanDepth; depth += 1) {
    const footY = start.y - (depth - 1);
    const x = start.x + (direction.dx * depth);
    const z = start.z + (direction.dz * depth);
    const probes = [
      { role: 'head', position: { x, y: footY + 1, z }, airUnsafe: false },
      { role: 'feet', position: { x, y: footY, z }, airUnsafe: true },
      { role: 'step-down', position: { x, y: footY - 1, z }, airUnsafe: true },
      { role: 'support', position: { x, y: footY - 2, z }, airUnsafe: true },
    ];

    for (const probe of probes) {
      let block;
      try {
        block = bot.blockAt(toVec3(probe.position));
      } catch (err) {
        return {
          ok: false,
          reason: `hazard scan query failed at (${formatHazardPosition(probe.position)}): ${errorMessage(err)}`,
          hazardClass: 'unknown',
          blockName: null,
          position: probe.position,
          role: probe.role,
          depth,
        };
      }
      const hazardClass = classifyHazardBlock(block, probe);
      if (hazardClass) {
        return {
          ok: false,
          reason: `hazard ahead: ${block.name} at (${formatHazardPosition(probe.position)})`,
          hazardClass,
          blockName: block.name,
          position: probe.position,
          role: probe.role,
          depth,
        };
      }
    }
  }
  return { ok: true };
}

function classifyHazardBlock(block, probe) {
  if (!block?.name) return 'unknown';
  const physicalHazard = HAZARD_BLOCK_CLASSES.get(block.name);
  if (physicalHazard) return physicalHazard;
  if (probe.airUnsafe && block.name === 'air' && probe.role === 'feet') return null;
  if (probe.airUnsafe && AIR_GAP_BLOCKS.has(block.name)) return 'void_air';
  return null;
}

async function digBlock(bot, ctx, position, label, ownerToken, allowStraightDownDig) {
  let block;
  try {
    block = bot.blockAt(toVec3(position));
  } catch (err) {
    return failed(bot, ctx, `world query failed for shaft ${label} block at ${formatBlock(position)}: ${errorMessage(err)}`);
  }
  if (!block || PASSABLE_BLOCKS.has(block.name) || block.boundingBox === 'empty') {
    return { ok: true, skipped: true };
  }

  const result = await awaitCollectBlock(bot, block, ctx.signal, {
    ownerToken,
    allowStraightDownDig,
    targetTimeoutMs: DEFAULT_DIG_TIMEOUT_MS,
    fastDigGroundWaitMs: DIG_GROUND_WAIT_MS,
    fastDigStableGroundMs: DIG_STABLE_GROUND_MS,
    airborneDigGroundWaitMs: DIG_GROUND_WAIT_MS,
    airborneDigStableGroundMs: DIG_STABLE_GROUND_MS,
  });
  if (result.kind === 'completed') return { ok: true, result };
  if (result.kind === 'preempted') return preempted(bot, ctx, `reactive preempt during shaft ${label} dig`);
  return failed(bot, ctx, `shaft ${label} dig failed at ${formatBlock(position)}: ${pathingFailureReason(result)}`);
}

async function walkTo(bot, ctx, position, ownerToken, options = {}) {
  if (ctx.signal?.aborted) return preempted(bot, ctx, 'pre-aborted');
  if (typeof pfGoals.GoalNear !== 'function') return failed(bot, ctx, 'pathfinder GoalNear unavailable during excavate_shaft');
  const goal = new pfGoals.GoalNear(position.x, position.y, position.z, 0.25);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_WALK_TIMEOUT_MS);
  const phase = options.phase || 'excavate_shaft';

  if (ownerToken && typeof bot.pathfinderOwner?.setGoal === 'function') {
    const movementConfig = configurePathingMovements(bot, ctx, {
      phase,
      allowParkour: false,
      allowSprinting: false,
    });
    if (!movementConfig.ok) return failed(bot, ctx, `${movementConfig.reason}: ${errorMessage(movementConfig.error)}`);
    const installed = setPathfinderGoal(bot, ownerToken, goal, { movements: movementConfig.movements }, { skill: 'excavate_shaft' });
    if (!installed.ok) return failed(bot, ctx, `pathfinder setGoal failed during excavate_shaft: ${installed.message}`);
    const reached = await awaitGoalReached(bot, ctx.signal, timeoutMs, { ownerToken });
    if (reached.kind === 'reached') return { ok: true };
    if (reached.kind === 'preempted') return preempted(bot, ctx, 'reactive preempt during shaft walk');
    return failed(bot, ctx, `shaft walk failed: ${pathingFailureReason(reached)}`);
  }

  if (typeof bot.pathfinder?.goto === 'function') {
    try {
      await bot.pathfinder.goto(goal);
      return { ok: true };
    } catch (err) {
      if (err?.name === 'PathStopped') return preempted(bot, ctx, 'reactive preempt during shaft walk');
      return failed(bot, ctx, `shaft walk failed: ${errorMessage(err)}`);
    }
  }

  return failed(bot, ctx, 'pathfinder unavailable during excavate_shaft');
}

function currentFeet(bot) {
  const position = bot.entity?.position || new Vec3(0, 0, 0);
  return {
    x: Math.floor(Number(position.x)),
    y: Math.floor(Number(position.y)),
    z: Math.floor(Number(position.z)),
  };
}

function centerPosition(position) {
  return {
    x: Number(position.x) + 0.5,
    y: Number(position.y),
    z: Number(position.z) + 0.5,
  };
}

function normalizeTrail(trail) {
  return (Array.isArray(trail) ? trail : []).map((entry) => clonePositionPlain(entry)).filter(Boolean);
}

function queryBlock(bot, position) {
  try {
    const block = bot.blockAt(toVec3(position));
    return { ok: true, block };
  } catch (err) {
    return {
      ok: false,
      reason: `world query failed at ${formatBlock(position)}: ${errorMessage(err)}`,
    };
  }
}

function isPassable(block) {
  return !block || PASSABLE_BLOCKS.has(block.name) || block.boundingBox === 'empty';
}

function isSolidSupport(block) {
  if (!block || isPassable(block)) return false;
  const name = normalizeBlockName(block.name);
  if (isHazardBlockName(name) || isTreeClutterBlockName(name) || isWorkstationBlockName(name)) return false;
  return true;
}

function unsafeShaftStartBlock(block) {
  const name = normalizeBlockName(block?.name);
  if (!name) return 'unknown';
  if (isHazardBlockName(name)) return 'hazard';
  if (isTreeClutterBlockName(name)) return 'tree_clutter';
  if (isWorkstationBlockName(name)) return 'workstation';
  return null;
}

function isHazardBlockName(name) {
  return Boolean(name && (
    HAZARD_BLOCK_CLASSES.has(name)
    || name === 'fire'
    || name === 'soul_fire'
    || name === 'cactus'
    || name === 'magma_block'
  ));
}

function isTreeClutterBlockName(name) {
  return Boolean(name && (
    name.endsWith('_leaves')
    || name.endsWith('_log')
    || name.endsWith('_wood')
    || name.endsWith('_stem')
    || name.endsWith('_hyphae')
    || name.endsWith('_wart_block')
    || name === 'mangrove_roots'
    || name === 'mushroom_stem'
  ));
}

function isWorkstationBlockName(name) {
  return WORKSTATION_BLOCKS.has(name);
}

function blockSummary(block) {
  return {
    name: normalizeBlockName(block?.name),
    position: clonePositionPlain(block?.position),
  };
}

export function protectedPositionsForEscapeTrail(escapeTrail = []) {
  const protectedPositions = new Set();
  for (const entry of Array.isArray(escapeTrail) ? escapeTrail : []) {
    const x = Math.floor(Number(entry?.x));
    const y = Math.floor(Number(entry?.y));
    const z = Math.floor(Number(entry?.z));
    if (![x, y, z].every(Number.isFinite)) continue;
    protectedPositions.add(`${x},${y},${z}`);
    protectedPositions.add(`${x},${y - 1},${z}`);
  }
  return protectedPositions;
}

function publishEscapeTrailProtection(ctx, escapeTrail) {
  if (!ctx?.runtimeContext || typeof ctx.runtimeContext !== 'object') return;
  ctx.runtimeContext.collectProtectedPositions = protectedPositionsForEscapeTrail(escapeTrail);
}

function clearEscapeTrailProtection(ctx) {
  if (!ctx?.runtimeContext || typeof ctx.runtimeContext !== 'object') return;
  delete ctx.runtimeContext.collectProtectedPositions;
}

function positionsEqual(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.z === b.z);
}

function failed(bot, ctx, reason) {
  return { ok: false, reason, state: buildSnapshot(bot, ctx) };
}

function hazardFailure(bot, ctx, hazard) {
  return {
    ok: false,
    reason: hazard.reason,
    state: buildSnapshot(bot, ctx),
    hazardClass: hazard.hazardClass,
    hazardBlock: hazard.blockName,
    hazardPosition: clonePositionPlain(hazard.position),
    hazardRole: hazard.role,
    hazardScanDepth: hazard.depth,
  };
}

function preempted(bot, ctx, reason) {
  return { preempted: true, reason, state: buildSnapshot(bot, ctx) };
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeStopOnExposedBlock(value) {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .map((entry) => normalizeBlockName(entry))
      .filter(Boolean),
  );
}

function normalizeBlockName(name) {
  if (typeof name !== 'string') return null;
  return name.startsWith('minecraft:') ? name.slice('minecraft:'.length) : name;
}

function formatBlock(position) {
  const p = clonePositionPlain(position);
  return p ? `${p.x},${p.y},${p.z}` : 'unknown';
}

function formatHazardPosition(position) {
  const p = clonePositionPlain(position);
  return p ? `${p.x},${p.y},${p.z}` : 'unknown';
}

function errorMessage(err) {
  return err?.message || String(err);
}
