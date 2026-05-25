// mine_with_progression -- runtime-only mining mission wrapper.
//
// This composes deterministic primitives for the stone-tools-to-iron upgrade
// path without exposing smelt/progression orchestration directly to the
// advisor prompt. The skill plans once from starting inventory and stores the
// compiled step list in callState so reactive preempts resume the same mission.

import buildSnapshot from '../state/snapshot.js';
import {
  planMiningToolProgression,
  readBotInventoryCounts,
} from '../state/materials.js';
import { validateSkillCall } from './schema.js';
import { run as runCollect } from './collect.js';
import { run as runCraft } from './craft.js';
import { run as runEquip } from './equip.js';
import { run as runMineAndReturn } from './mine_and_return.js';
import { run as runMineUntil } from './mine_until.js';
import { run as runSmelt } from './smelt.js';

const DEFAULT_OPTIONAL_CRAFTS = Object.freeze(['iron_sword']);
const DEFAULT_WOOD_BLOCK = 'oak_log';
const DEFAULT_PREP_ATTEMPT_MULTIPLIER = 4;

const DEFAULT_RUNNERS = Object.freeze({
  collect: runCollect,
  craft: runCraft,
  equip: runEquip,
  mine_and_return: runMineAndReturn,
  mine_until: runMineUntil,
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

  const progression = planMiningToolProgression({
    oreTargets: normalized.ores,
    inventory: inventory.inventory,
    registry: bot.registry,
    optionalCrafts: params.optionalCrafts ?? DEFAULT_OPTIONAL_CRAFTS,
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
  const compiled = compilePreparationCalls(progression.steps || [], params);
  if (!compiled.ok) return compiled;
  const finalCall = compileFinalCall(params, normalized);
  const finalValid = validateSkillCall(finalCall);
  if (!finalValid.ok) return { ok: false, reason: `invalid generated final mining call: ${finalValid.reason}` };

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
      finalCall,
      finalState: {},
      finalResult: null,
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
    });
    if (result?.preempted) return result;
    state.prepResults[index] = compactResult(result);
    if (!result?.ok) {
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

async function runCompiledCall(bot, call, params, ctx, opts) {
  const valid = validateSkillCall(call);
  if (!valid.ok) return { ok: false, reason: `invalid generated ${call.skill} call: ${valid.reason}` };
  const runner = ctx.skillRunners?.[call.skill] || DEFAULT_RUNNERS[call.skill];
  if (!runner) return { ok: false, reason: `missing runner for generated ${call.skill} call` };
  return runner(bot, call.params || {}, {
    ...ctx,
    callState: opts.stepState,
    currentSubtask: opts.subtask,
    miningProgressionTargets: params.ores,
    miningProgressionOptionalCrafts: params.optionalCrafts,
  });
}

function compilePreparationCalls(steps, params) {
  const calls = [];
  for (const step of steps) {
    const compiled = compilePreparationStep(step, params);
    if (!compiled.ok) return compiled;
    for (const call of compiled.calls) {
      const valid = validateSkillCall(call);
      if (!valid.ok) return { ok: false, reason: `invalid generated prep call for ${step.action}: ${valid.reason}` };
      calls.push(call);
    }
  }
  return { ok: true, calls };
}

function compilePreparationStep(step, params) {
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
        }),
      }],
    };
  }

  if (step.action === 'smelt') {
    return {
      ok: true,
      calls: [{
        skill: 'smelt',
        params: compactParams({
          input: step.input,
          output: step.output,
          count: positiveCount(step.count, 1),
          fuel: params.smeltFuel,
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

function compactParams(params) {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
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
      for (const key of ['block', 'item', 'input', 'output', 'reason']) {
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
    blockers.push(`missing portable supply ${item}:${count}`);
  }
  return blockers;
}

function preparationSummary(state) {
  return {
    plannedCalls: (state.prepCalls || []).map(compactCall),
    completed: state.prepStepIndex || 0,
    total: (state.prepCalls || []).length,
    results: (state.prepResults || []).filter(Boolean),
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
