// mine_with_progression -- advisor-callable composer for item-chain goals.
//
// Composes deterministic primitives for the wood-tools through iron-tier
// progression chain from an arbitrary starting inventory. Plans once from the
// snapshot and stores the compiled step list in callState so reactive
// preempts resume the same mission without replanning. Diamond-tier descent
// past Y=15 shares the same composer; iron-tier is the live-proven boundary
// for the public verifier today.

import buildSnapshot from '../state/snapshot.js';
import {
  planMiningToolProgression,
  readBotInventoryCounts,
} from '../state/materials.js';
import { validateSkillCall } from './schema.js';
import { run as runCollect } from './collect.js';
import { run as runCraft } from './craft.js';
import { run as runEquip } from './equip.js';
import { run as runExcavateShaft } from './excavate_shaft.js';
import { run as runGoto } from './goto.js';
import { run as runMineAndReturn } from './mine_and_return.js';
import { run as runMineUntil } from './mine_until.js';
import { run as runPlaceWorkstation } from './place_workstation.js';
import { run as runSmelt } from './smelt.js';

const DEFAULT_OPTIONAL_CRAFTS = Object.freeze(['iron_sword']);
const DEFAULT_WOOD_BLOCK = 'oak_log';
const DEFAULT_PREP_ATTEMPT_MULTIPLIER = 4;
const BOOTSTRAP_WOOD_MAX_Y_DELTA = 2;
const SHALLOW_COBBLESTONE_SHAFT_DELTA = 3;
const SHALLOW_COBBLESTONE_MAX_DEPTH = 8;
const SHALLOW_COBBLESTONE_HAZARD_SCAN_DEPTH = 2;
const SHALLOW_COBBLESTONE_SHAFT_DIRECTION = 'west';
const BOOTSTRAP_CRAFTING_TABLE_PAD = Object.freeze({ dx: -3, dz: 3 });
const WORKSTATION_PLACEMENT_SEARCH_RADIUS = 4;
const WORKSTATION_PLACEMENT_VERTICAL_RADIUS = 2;
const BOOTSTRAP_WORKSTATION_VERTICAL_RADIUS = 2;
const WORKSTATION_START_PROTECTION_RADIUS = 1;
const RETURN_TO_START_RANGE = 0.75;
const DIAMOND_SHAFT_TARGET_Y = -58;
const DIAMOND_SHAFT_MAX_DEPTH_PAD = 8;
const DIAMOND_SHAFT_DIRECTION = 'west';
const DIAMOND_SHAFT_DIRECTIONS = Object.freeze(['west', 'north', 'south', 'east']);
const DIAMOND_SHAFT_STOP_TARGETS = Object.freeze(['diamond_ore', 'deepslate_diamond_ore']);
const FINAL_ORE_PRIMARY_DROPS = Object.freeze({
  diamond_ore: 'diamond',
  deepslate_diamond_ore: 'diamond',
});
const FINAL_DROP_CRAFT_DEMAND = Object.freeze({
  diamond_pickaxe: Object.freeze({ diamond: 3 }),
});

const DEFAULT_RUNNERS = Object.freeze({
  collect: runCollect,
  craft: runCraft,
  equip: runEquip,
  excavate_shaft: runExcavateShaft,
  goto: runGoto,
  mine_and_return: runMineAndReturn,
  mine_until: runMineUntil,
  place_workstation: runPlaceWorkstation,
  smelt: runSmelt,
});

export async function run(bot, params = {}, ctx = {}) {
  if (ctx.signal?.aborted) return preempted(bot, ctx, 'pre-aborted');

  const normalized = normalizeParams(bot, params);
  if (!normalized.ok) return failed(bot, ctx, normalized.reason, params);

  const state = ctx.callState || {};
  if (!state.phase) {
    const planned = initializeMission(bot, params, normalized);
    if (!planned.ok) return failed(bot, ctx, planned.reason, params);
    Object.assign(state, planned.state);
  }

  if (state.phase === 'prep') {
    const prep = await runPreparationSteps(bot, params, ctx, state);
    if (prep?.preempted) return prep;
    if (!prep.ok) return failed(bot, ctx, prep.reason, params, prep.extra);
    state.phase = 'mine';
  }

  if (state.phase === 'mine') {
    const finalResult = await runCompiledCall(bot, state.finalCall, params, ctx, {
      stepState: state.finalState || (state.finalState = {}),
      subtask: `mine_with_progression.${state.finalCall.skill}`,
    });
    if (finalResult?.preempted) return finalResult;
    state.finalResult = compactResult(finalResult);
    if (!finalResult?.ok) {
      return failed(bot, ctx, `mine_with_progression final mining failed: ${finalResult?.reason || 'unknown'}`, params, {
        finalResult: state.finalResult,
        preparation: preparationSummary(state),
      });
    }
    state.phase = (state.postCalls || []).length > 0 ? 'post' : 'done';
  }

  if (state.phase === 'post') {
    const post = await runPostMiningSteps(bot, params, ctx, state);
    if (post?.preempted) return post;
    if (!post.ok) return failed(bot, ctx, post.reason, params, post.extra);
    state.phase = 'done';
  }

  return {
    ok: true,
    reason: `mine_with_progression completed: ${state.finalResult?.reason || 'final mining done'}`,
    preparation: preparationSummary(state),
    finalResult: state.finalResult || null,
    state: snapshot(bot, ctx, params),
  };
}

function initializeMission(bot, params, normalized) {
  const inventory = readBotInventoryCounts(bot);
  if (!inventory.ok) return { ok: false, reason: `inventory unavailable during progression planning: ${inventory.error}` };
  const explicitCrafts = params.optionalCrafts === undefined ? [] : normalizeCraftList(params.optionalCrafts);
  const craftSplit = splitCraftsAroundFinalMining(explicitCrafts, normalized.ores);
  const missionTargets = adjustFinalMiningCountForPostCrafts(normalized, craftSplit.postMiningCrafts, normalized.ores);

  const progression = planMiningToolProgression({
    oreTargets: missionTargets.ores,
    inventory: inventory.inventory,
    registry: bot.registry,
    optionalCrafts: params.optionalCrafts === undefined ? DEFAULT_OPTIONAL_CRAFTS : [],
    requiredCrafts: params.optionalCrafts === undefined ? [] : craftSplit.preMiningCrafts,
    furnaceAccess: Boolean(params.furnace),
  });
  if (params.requireSelfContainedFieldKit === true && progression.fieldKit?.execution?.selfContainedInFieldReady !== true) {
    return {
      ok: false,
      reason: `self-contained mining field kit unavailable: ${fieldKitBlockers(progression.fieldKit).join('; ') || 'field kit is not ready'}`,
      state: {
        phase: 'blocked',
        initialInventory: inventory.inventory,
        progression: compactProgression(progression),
      },
    };
  }
  const compiled = compilePreparationCalls(progression.steps || [], params, {
    startPosition: missionStartPosition(bot),
    finalOres: missionTargets.ores,
  });
  if (!compiled.ok) return compiled;
  const finalCall = compileFinalCall(params, missionTargets);
  const finalValid = validateSkillCall(finalCall);
  if (!finalValid.ok) return { ok: false, reason: `invalid generated final mining call: ${finalValid.reason}` };
  const postCalls = compilePostMiningCalls(craftSplit.postMiningCrafts, {
    finalDepthCallIndex: compiled.finalDepthCallIndex,
  });
  const postValid = validatePostMiningCalls(postCalls);
  if (!postValid.ok) return postValid;

  return {
    ok: true,
    state: {
      phase: compiled.calls.length > 0 ? 'prep' : 'mine',
      initialInventory: inventory.inventory,
      progression: compactProgression(progression),
      prepCalls: compiled.calls,
      prepStepIndex: 0,
      prepStepStates: {},
      prepResults: [],
      missionStartPosition: compiled.missionStartPosition || null,
      finalCall,
      finalState: {},
      finalResult: null,
      finalDepthPrepCallIndex: compiled.finalDepthCallIndex,
      postCalls,
      postStepIndex: 0,
      postStepStates: {},
      postResults: [],
      postMiningCrafts: craftSplit.postMiningCrafts,
    },
  };
}

async function runPreparationSteps(bot, params, ctx, state) {
  while (state.prepStepIndex < state.prepCalls.length) {
    if (ctx.signal?.aborted) return preempted(bot, ctx, 'reactive preempt during mine_with_progression prep');
    const index = state.prepStepIndex;
    const call = state.prepCalls[index];
    const result = await runCompiledCall(bot, call, params, ctx, {
      stepState: state.prepStepStates[index] || (state.prepStepStates[index] = {}),
      subtask: `mine_with_progression.prep.${index + 1}.${call.skill}`,
      missionStartPosition: state.missionStartPosition,
    });
    if (result?.preempted) return result;
    state.prepResults[index] = compactResult(result);
    if (!result?.ok) {
      if (maybeRotateFinalDepthShaftAfterRecoverableFailure(state, index, call, result)) {
        continue;
      }
      return {
        ok: false,
        reason: `mine_with_progression prep step ${index + 1}/${state.prepCalls.length} failed (${call.skill}): ${result?.reason || 'unknown'}`,
        extra: { failedCall: compactCall(call), preparation: preparationSummary(state) },
      };
    }
    state.prepStepIndex += 1;
  }
  return { ok: true };
}

async function runPostMiningSteps(bot, params, ctx, state) {
  while (state.postStepIndex < (state.postCalls || []).length) {
    if (ctx.signal?.aborted) return preempted(bot, ctx, 'reactive preempt during mine_with_progression post-mining');
    const index = state.postStepIndex;
    const entry = state.postCalls[index];
    const call = plannedCall(entry);
    const result = await runCompiledCall(bot, call, params, ctx, {
      stepState: postStepState(state, index, entry),
      subtask: `mine_with_progression.post.${index + 1}.${call.skill}`,
    });
    if (result?.preempted) return result;
    state.postResults[index] = compactResult(result);
    if (!result?.ok) {
      return {
        ok: false,
        reason: `mine_with_progression post step ${index + 1}/${state.postCalls.length} failed (${call.skill}): ${result?.reason || 'unknown'}`,
        extra: { failedCall: compactCall(call), preparation: preparationSummary(state) },
      };
    }
    state.postStepIndex += 1;
  }
  return { ok: true };
}

async function runCompiledCall(bot, call, params, ctx, opts) {
  const valid = validateSkillCall(call);
  if (!valid.ok) return { ok: false, reason: `invalid generated ${call.skill} call: ${valid.reason}` };
  const runner = ctx.skillRunners?.[call.skill] || DEFAULT_RUNNERS[call.skill];
  if (!runner) return { ok: false, reason: `missing runner for generated ${call.skill} call` };
  const callCtx = {
    ...ctx,
    callState: opts.stepState,
    currentSubtask: opts.subtask,
    miningProgressionTargets: params.ores,
    miningProgressionOptionalCrafts: params.optionalCrafts,
  };
  if (call.skill === 'place_workstation') {
    const protectedPositions = mergeProtectedPositions(
      ctx,
      workstationStartProtectedPositions(opts.missionStartPosition),
    );
    if (protectedPositions) callCtx.protectedPositions = protectedPositions;
  }
  return runner(bot, call.params || {}, callCtx);
}

function compilePreparationCalls(steps, params, mission = {}) {
  const calls = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const compiled = compilePreparationStep(step, params, mission);
    if (!compiled.ok) return compiled;
    for (const call of compiled.calls) {
      const valid = validateSkillCall(call);
      if (!valid.ok) return { ok: false, reason: `invalid generated prep call for ${step.action}: ${valid.reason}` };
      calls.push(call);
    }
    if (isBootstrapWoodStep(step) && !isBootstrapWoodStep(steps[index + 1])) {
      const returnCall = compileReturnToStartCall(mission);
      if (returnCall) calls.push(returnCall);
    }
  }
  const finalDepthCall = compileFinalOreDepthShaftCall(mission);
  let finalDepthCallIndex = null;
  if (finalDepthCall) {
    finalDepthCallIndex = calls.length;
    calls.push(finalDepthCall);
  }
  return { ok: true, calls, missionStartPosition: mission.startPosition || null, finalDepthCallIndex };
}

function compilePostMiningCalls(crafts = [], opts = {}) {
  const calls = [];
  if ((crafts || []).length > 0 && Number.isInteger(opts.finalDepthCallIndex)) {
    calls.push({
      call: { skill: 'excavate_shaft', params: { targetY: DIAMOND_SHAFT_TARGET_Y, returnToSurface: true } },
      stateRef: 'finalDepthShaft',
    });
  }
  for (const item of crafts || []) {
    calls.push({ call: { skill: 'craft', params: { item, count: 1 } } });
    if (isPickaxe(item)) calls.push({ call: { skill: 'equip', params: { item, destination: 'hand' } } });
  }
  return calls;
}

function validatePostMiningCalls(entries = []) {
  for (const entry of entries || []) {
    const call = plannedCall(entry);
    const valid = validateSkillCall(call);
    if (!valid.ok) return { ok: false, reason: `invalid generated post-mining call for ${call?.skill || 'unknown'}: ${valid.reason}` };
  }
  return { ok: true };
}

function compilePreparationStep(step, params, mission = {}) {
  if (step.action === 'mine') {
    return {
      ok: true,
      calls: [{
        skill: 'mine_until',
        params: compactParams({
          ores: [step.block],
          count: positiveCount(step.count, 1),
          maxDistance: params.prepMaxDistance ?? params.maxDistance,
          maxAttempts: params.prepMaxAttempts ?? Math.max(positiveCount(step.count, 1), positiveCount(step.count, 1) * DEFAULT_PREP_ATTEMPT_MULTIPLIER),
        }),
      }],
    };
  }

  if (step.action === 'carry_or_collect') {
    if (step.item !== 'wood_log') {
      return { ok: false, reason: `unsupported progression carry_or_collect item "${step.item}"` };
    }
    return {
      ok: true,
      calls: [{
        skill: 'collect',
        params: compactParams({
          block: params.woodBlock || DEFAULT_WOOD_BLOCK,
          count: positiveCount(step.count, 1),
          maxDistance: params.prepMaxDistance ?? params.maxDistance,
          maxTargetY: bootstrapWoodMaxTargetY(mission),
          finishTree: false,
        }),
      }],
    };
  }

  if (step.action === 'collect') {
    const collectParams = compactParams({
      block: step.block || step.item,
      count: positiveCount(step.count, 1),
      maxDistance: params.prepMaxDistance ?? params.maxDistance,
      allowBuriedTargets: step.allowBuriedTargets,
    });
    if (isCobblestonePrepStep(step)) {
      const shaft = compileShallowCobblestoneShaftCall(mission);
      if (shaft) {
        const returnCall = compileReturnToStartCall(mission);
        return {
          ok: true,
          calls: [
            ...(returnCall ? [returnCall] : []),
            shaft,
            {
              skill: 'collect',
              params: {
                ...collectParams,
                allowBuriedTargets: true,
              },
            },
          ],
        };
      }
    }
    return {
      ok: true,
      calls: [{
        skill: 'collect',
        params: collectParams,
      }],
    };
  }

  if (step.action === 'smelt') {
    const fuel = params.smeltFuel ?? plannedSmeltFuel(step);
    return {
      ok: true,
      calls: [{
        skill: 'smelt',
        params: compactParams({
          input: step.input,
          output: step.output,
          count: positiveCount(step.count, 1),
          fuel,
          furnace: params.furnace,
          maxDistance: params.furnaceMaxDistance,
        }),
      }],
    };
  }

  if (step.action === 'craft') {
    const calls = [{
      skill: 'craft',
      params: compactParams({
        item: step.item,
        count: positiveCount(step.count, 1),
      }),
    }];
    if (params.equipCraftedTools !== false && isPickaxe(step.item)) {
      calls.push({
        skill: 'equip',
        params: { item: step.item, destination: 'hand' },
      });
    }
    return { ok: true, calls };
  }

  if (step.action === 'place_workstation') {
    const workstation = step.workstation || step.item;
    const action = step.workstationAction || step.actionType || 'place';
    const placement = workstationPlacementParams(workstation, action, step, mission);
    return {
      ok: true,
      calls: [{
        skill: 'place_workstation',
        params: compactParams(placement),
      }],
    };
  }

  return { ok: false, reason: `unsupported progression action "${step.action}"` };
}

function compileFinalCall(params, normalized) {
  const skill = params.returnChest ? 'mine_and_return' : 'mine_until';
  return {
    skill,
    params: compactParams({
      ores: normalized.ores,
      count: normalized.count,
      durationMs: normalized.durationMs,
      maxAttempts: params.maxAttempts,
      maxDistance: params.maxDistance,
      returnChest: params.returnChest,
      returnReserveMs: params.returnReserveMs,
      returnRange: params.returnRange,
      returnMaxDistance: params.returnMaxDistance,
      depositMaxDistance: params.depositMaxDistance,
      depositMinedItems: params.depositMinedItems,
    }),
  };
}

function plannedSmeltFuel(step = {}) {
  const fuel = Array.isArray(step.fuelPlan) ? step.fuelPlan[0] : null;
  return fuel?.item || undefined;
}

function normalizeParams(bot, params) {
  const ores = Array.isArray(params.ores)
    ? [...new Set(params.ores.map((name) => String(name || '').trim()).filter(Boolean))]
    : [];
  if (ores.length === 0) return { ok: false, reason: 'mine_with_progression requires ores' };
  const unknown = ores.filter((name) => !bot.registry?.blocksByName?.[name]);
  if (unknown.length > 0) return { ok: false, reason: `unknown ore block "${unknown[0]}"` };
  const unsupported = ores.filter((name) => !isOreLike(name));
  if (unsupported.length > 0) return { ok: false, reason: `mine_with_progression target "${unsupported[0]}" is not an ore-like block` };

  const hasCount = Number.isFinite(params.count);
  const hasDuration = Number.isFinite(params.durationMs);
  if (!hasCount && !hasDuration) return { ok: false, reason: 'mine_with_progression requires count or durationMs' };
  if (hasCount && hasDuration) return { ok: false, reason: 'mine_with_progression requires exactly one of count or durationMs' };
  if (hasCount && (!Number.isInteger(params.count) || params.count < 1)) return { ok: false, reason: 'mine_with_progression count must be an integer >= 1' };
  if (hasDuration && (!Number.isInteger(params.durationMs) || params.durationMs < 1)) return { ok: false, reason: 'mine_with_progression durationMs must be an integer >= 1' };

  return {
    ok: true,
    ores,
    count: hasCount ? params.count : undefined,
    durationMs: hasDuration ? params.durationMs : undefined,
  };
}

function normalizeCraftList(crafts = []) {
  return [...new Set((Array.isArray(crafts) ? crafts : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))];
}

function splitCraftsAroundFinalMining(crafts = [], ores = []) {
  const finalDrops = finalOreDrops(ores);
  const preMiningCrafts = [];
  const postMiningCrafts = [];
  for (const item of normalizeCraftList(crafts)) {
    if (craftConsumesAnyFinalDrop(item, finalDrops)) postMiningCrafts.push(item);
    else preMiningCrafts.push(item);
  }
  return { preMiningCrafts, postMiningCrafts };
}

function finalOreDrops(ores = []) {
  return new Set((ores || [])
    .map((ore) => FINAL_ORE_PRIMARY_DROPS[ore])
    .filter(Boolean));
}

function craftConsumesAnyFinalDrop(item, finalDrops) {
  const demand = FINAL_DROP_CRAFT_DEMAND[item] || {};
  return Object.keys(demand).some((name) => finalDrops.has(name));
}

function adjustFinalMiningCountForPostCrafts(normalized, crafts = [], ores = []) {
  if (!Number.isFinite(normalized.count)) return normalized;
  const finalDrops = finalOreDrops(ores);
  let count = normalized.count;
  for (const item of crafts || []) {
    const demand = FINAL_DROP_CRAFT_DEMAND[item] || {};
    for (const [name, needed] of Object.entries(demand)) {
      if (finalDrops.has(name)) count = Math.max(count, positiveCount(needed, 1));
    }
  }
  return count === normalized.count ? normalized : { ...normalized, count };
}

function plannedCall(entry) {
  return entry?.call || entry;
}

function postStepState(state, index, entry = {}) {
  if (entry.stateRef === 'finalDepthShaft' && Number.isInteger(state.finalDepthPrepCallIndex)) {
    return state.prepStepStates[state.finalDepthPrepCallIndex] || (state.prepStepStates[state.finalDepthPrepCallIndex] = {});
  }
  return state.postStepStates[index] || (state.postStepStates[index] = {});
}

function compactParams(params) {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

function isBootstrapWoodStep(step = {}) {
  return step.action === 'carry_or_collect' && step.item === 'wood_log';
}

function compileReturnToStartCall(mission = {}) {
  const position = mission.startPosition;
  if (!position) return null;
  return {
    skill: 'goto',
    params: {
      x: position.x,
      y: position.y,
      z: position.z,
      range: RETURN_TO_START_RANGE,
    },
  };
}

function bootstrapWoodMaxTargetY(mission = {}) {
  const y = mission.startPosition?.y;
  return Number.isFinite(y) ? y + BOOTSTRAP_WOOD_MAX_Y_DELTA : undefined;
}

function compileShallowCobblestoneShaftCall(mission = {}) {
  const y = mission.startPosition?.y;
  if (!Number.isFinite(y)) return null;
  return {
    skill: 'excavate_shaft',
    params: {
      targetY: y - SHALLOW_COBBLESTONE_SHAFT_DELTA,
      maxDepth: SHALLOW_COBBLESTONE_MAX_DEPTH,
      hazardScanDepth: SHALLOW_COBBLESTONE_HAZARD_SCAN_DEPTH,
      direction: SHALLOW_COBBLESTONE_SHAFT_DIRECTION,
    },
  };
}

function compileFinalOreDepthShaftCall(mission = {}) {
  const targets = Array.isArray(mission.finalOres) ? mission.finalOres : [];
  if (!targets.some((name) => DIAMOND_SHAFT_STOP_TARGETS.includes(name))) return null;
  const startY = mission.startPosition?.y;
  const depth = Number.isFinite(startY) && startY > DIAMOND_SHAFT_TARGET_Y
    ? Math.ceil(startY - DIAMOND_SHAFT_TARGET_Y) + DIAMOND_SHAFT_MAX_DEPTH_PAD
    : DIAMOND_SHAFT_MAX_DEPTH_PAD;
  return {
    skill: 'excavate_shaft',
    params: {
      targetY: DIAMOND_SHAFT_TARGET_Y,
      maxDepth: depth,
      direction: DIAMOND_SHAFT_DIRECTIONS[0] || DIAMOND_SHAFT_DIRECTION,
      stopOnExposedBlock: DIAMOND_SHAFT_STOP_TARGETS,
    },
  };
}

function maybeRotateFinalDepthShaftAfterRecoverableFailure(state, index, call, result) {
  if (!isFinalDepthShaftCall(state, index, call)) return false;
  if (!isRecoverableFinalDepthShaftFailure(result)) return false;

  const currentDirection = call.params.direction || DIAMOND_SHAFT_DIRECTION;
  const attempts = state.finalDepthShaftAttempts || (state.finalDepthShaftAttempts = []);
  if (!attempts.some((entry) => entry.direction === currentDirection)) {
    attempts.push({
      direction: currentDirection,
      reason: result.reason || 'unknown shaft hazard',
      ...(result.hazardClass ? { hazardClass: result.hazardClass } : {}),
      ...(result.hazardBlock ? { hazardBlock: result.hazardBlock } : {}),
      ...(result.hazardPosition ? { hazardPosition: result.hazardPosition } : {}),
      ...(result.code ? { code: result.code } : {}),
      ...(result.shaftStartStaging ? { shaftStartStaging: compactShaftStartStaging(result.shaftStartStaging) } : {}),
    });
  }

  const tried = new Set(attempts.map((entry) => entry.direction));
  const nextDirection = DIAMOND_SHAFT_DIRECTIONS.find((direction) => !tried.has(direction));
  if (!nextDirection) return false;

  call.params.direction = nextDirection;
  const stepState = state.prepStepStates[index] || (state.prepStepStates[index] = {});
  stepState.currentStep = null;
  stepState.phase = 'digHead';
  stepState.finalDepthShaftRecovery = {
    fromDirection: currentDirection,
    toDirection: nextDirection,
    reason: result.reason || 'unknown shaft failure',
    attempts: attempts.length,
  };
  return true;
}

function isFinalDepthShaftCall(state, index, call) {
  return index === state.finalDepthPrepCallIndex
    && call?.skill === 'excavate_shaft'
    && call.params?.targetY === DIAMOND_SHAFT_TARGET_Y
    && Array.isArray(call.params?.stopOnExposedBlock);
}

function isRecoverableFinalDepthShaftFailure(result) {
  if (!result || result.ok !== false) return false;
  if (result.hazardClass) return true;
  if (result.code === 'no_safe_shaft_start_within_radius') return true;
  if (typeof result.reason !== 'string') return false;
  return result.reason.startsWith('hazard ahead:')
    || result.reason.includes('no_safe_shaft_start_within_radius');
}

function compactShaftStartStaging(staging = {}) {
  return {
    ...(staging.code ? { code: staging.code } : {}),
    ...(staging.reason ? { reason: staging.reason } : {}),
    ...(staging.origin ? { origin: staging.origin } : {}),
    ...(Number.isFinite(staging.radius) ? { radius: staging.radius } : {}),
    ...(Number.isFinite(staging.candidateCount) ? { candidateCount: staging.candidateCount } : {}),
    ...(staging.originalInspection?.reason ? { originalInspectionReason: staging.originalInspection.reason } : {}),
    ...(Array.isArray(staging.walkFailures) ? { walkFailureCount: staging.walkFailures.length } : {}),
  };
}

function workstationPlacementParams(workstation, action, step = {}, mission = {}) {
  const isBootstrapCraftingTable = action === 'place' && workstation === 'crafting_table' && !explicitPosition(step);
  const search = workstationSearchParams(action, { bootstrapCraftingTable: isBootstrapCraftingTable });
  const explicit = explicitPosition(step);
  if (explicit) {
    return {
      workstation,
      action,
      ...explicit,
      ...search,
    };
  }
  if (action === 'place' && workstation === 'crafting_table') {
    const pad = bootstrapCraftingTablePad(mission);
    if (pad) {
      return {
        workstation,
        action,
        ...pad,
        ...search,
      };
    }
  }
  return { workstation, action, ...search };
}

function workstationSearchParams(action, opts = {}) {
  if (action !== 'place') return {};
  return {
    searchRadius: WORKSTATION_PLACEMENT_SEARCH_RADIUS,
    verticalRadius: opts.bootstrapCraftingTable
      ? BOOTSTRAP_WORKSTATION_VERTICAL_RADIUS
      : WORKSTATION_PLACEMENT_VERTICAL_RADIUS,
  };
}

function workstationStartProtectedPositions(start) {
  if (!start || ![start.x, start.y, start.z].every(Number.isFinite)) return null;
  const out = new Set();
  for (let dx = -WORKSTATION_START_PROTECTION_RADIUS; dx <= WORKSTATION_START_PROTECTION_RADIUS; dx += 1) {
    for (let dz = -WORKSTATION_START_PROTECTION_RADIUS; dz <= WORKSTATION_START_PROTECTION_RADIUS; dz += 1) {
      for (let dy = -1; dy <= 2; dy += 1) {
        out.add(`${Math.floor(start.x + dx)},${Math.floor(start.y + dy)},${Math.floor(start.z + dz)}`);
      }
    }
  }
  return out;
}

function mergeProtectedPositions(ctx = {}, extra = null) {
  const out = new Set();
  for (const source of [
    ctx.protectedPositions,
    ctx.collectProtectedPositions,
    ctx.runtimeContext?.protectedPositions,
    ctx.runtimeContext?.collectProtectedPositions,
    extra,
  ]) {
    if (!source) continue;
    if (source instanceof Set) {
      for (const value of source) out.add(String(value));
    } else if (Array.isArray(source)) {
      for (const position of source) {
        if (typeof position === 'string') out.add(position);
        else if (position) out.add(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`);
      }
    }
  }
  return out.size > 0 ? out : null;
}

function explicitPosition(step = {}) {
  const values = ['x', 'y', 'z'].map((axis) => step[axis]);
  if (values.every((value) => Number.isFinite(value))) {
    return {
      x: Math.floor(step.x),
      y: Math.floor(step.y),
      z: Math.floor(step.z),
    };
  }
  return null;
}

function bootstrapCraftingTablePad(mission = {}) {
  const start = mission.startPosition;
  if (!start || ![start.x, start.y, start.z].every(Number.isFinite)) return null;
  return {
    x: start.x + BOOTSTRAP_CRAFTING_TABLE_PAD.dx,
    y: start.y,
    z: start.z + BOOTSTRAP_CRAFTING_TABLE_PAD.dz,
  };
}

function isCobblestonePrepStep(step = {}) {
  return step.action === 'collect' && (step.block === 'cobblestone' || step.item === 'cobblestone');
}

function missionStartPosition(bot) {
  const position = bot.entity?.position;
  if (!position) return null;
  const x = numericFloor(position.x);
  const y = numericFloor(position.y);
  const z = numericFloor(position.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

function numericFloor(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

function compactCall(call) {
  return { skill: call.skill, params: call.params || {} };
}

function compactResult(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    ...(typeof result.ok === 'boolean' ? { ok: result.ok } : {}),
    ...(result.preempted === true ? { preempted: true } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(Number.isFinite(result.minedTargetCount) ? { minedTargetCount: result.minedTargetCount } : {}),
    ...(result.minedCounts ? { minedCounts: result.minedCounts } : {}),
    ...(result.minedBlocks ? { minedBlocks: result.minedBlocks } : {}),
  };
}

function compactProgression(plan) {
  return {
    targets: {
      harvestable: (plan.targets?.harvestable || []).map((target) => target.block),
      blocked: (plan.targets?.blocked || []).map((target) => ({
        block: target.block,
        missingTools: [...(target.missingTools || [])],
      })),
    },
    requiredTools: [...(plan.requiredTools || [])],
    steps: (plan.steps || []).map((step) => {
      const out = { action: step.action };
      for (const key of ['block', 'item', 'input', 'output', 'workstation', 'workstationAction', 'reason']) {
        if (step[key]) out[key] = step[key];
      }
      if (Number.isFinite(step.count)) out.count = step.count;
      if (step.optional === true) out.optional = true;
      return out;
    }),
    optionalToolPlans: (plan.optionalToolPlans || []).map((entry) => ({
      item: entry.item,
      resourceReady: entry.resourceReady === true,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.missing ? { missing: entry.missing } : {}),
    })),
    ...(plan.fieldKit ? { fieldKit: compactFieldKit(plan.fieldKit) } : {}),
  };
}

function compactFieldKit(fieldKit) {
  return {
    required: fieldKit.required === true,
    needsCraftingTable: fieldKit.needsCraftingTable === true,
    needsFurnace: fieldKit.needsFurnace === true,
    recommendedCarry: fieldKit.recommendedCarry || {},
    missingPortableSupplies: fieldKit.missingPortableSupplies || {},
    selfContainedInFieldReady: fieldKit.execution?.selfContainedInFieldReady === true,
    blockers: fieldKitBlockers(fieldKit),
    reasoning: fieldKit.reasoning || [],
  };
}

function fieldKitBlockers(fieldKit) {
  const blockers = [...(fieldKit?.execution?.blockers || [])];
  const missing = fieldKit?.missingPortableSupplies || {};
  for (const [item, count] of Object.entries(missing)) {
    const reason = `missing portable supply ${item}:${count}`;
    if (!blockers.includes(reason)) blockers.push(reason);
  }
  return blockers;
}

function preparationSummary(state) {
  return {
    plannedCalls: (state.prepCalls || []).map(compactCall),
    completed: state.prepStepIndex || 0,
    total: (state.prepCalls || []).length,
    results: (state.prepResults || []).filter(Boolean),
    postMiningCalls: (state.postCalls || []).map((entry) => compactCall(plannedCall(entry))),
    postMiningCompleted: state.postStepIndex || 0,
    postMiningTotal: (state.postCalls || []).length,
    postMiningResults: (state.postResults || []).filter(Boolean),
    finalDepthShaftAttempts: state.finalDepthShaftAttempts || [],
    progression: state.progression || null,
  };
}

function positiveCount(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : fallback;
}

function isPickaxe(name) {
  return String(name || '').endsWith('_pickaxe');
}

function isOreLike(name) {
  return String(name || '').endsWith('_ore') || name === 'ancient_debris';
}

function snapshot(bot, ctx, params) {
  return buildSnapshot(bot, {
    ...ctx,
    miningProgressionTargets: params.ores,
    miningProgressionOptionalCrafts: params.optionalCrafts,
  });
}

function failed(bot, ctx, reason, params = {}, extra = {}) {
  return { ok: false, reason, ...extra, state: snapshot(bot, ctx, params) };
}

function preempted(bot, ctx, reason) {
  return { preempted: true, reason, state: buildSnapshot(bot, ctx) };
}
