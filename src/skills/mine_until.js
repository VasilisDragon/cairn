import buildSnapshot from '../state/snapshot.js';
import { countItems, planToolForBlock, readBotInventoryCounts } from '../state/materials.js';
import { run as runCollect } from './collect.js';

const DEFAULT_MAX_DISTANCE = 64;
const DEFAULT_MAX_ATTEMPTS = 32;
const DEFAULT_ORES = Object.freeze([
  'diamond_ore',
  'deepslate_diamond_ore',
  'iron_ore',
  'deepslate_iron_ore',
  'coal_ore',
  'deepslate_coal_ore',
]);

const ORE_PROGRESS_ITEMS = Object.freeze({
  coal_ore: Object.freeze(['coal', 'coal_ore']),
  deepslate_coal_ore: Object.freeze(['coal', 'deepslate_coal_ore']),
  iron_ore: Object.freeze(['raw_iron', 'iron_ore']),
  deepslate_iron_ore: Object.freeze(['raw_iron', 'deepslate_iron_ore']),
  copper_ore: Object.freeze(['raw_copper', 'copper_ore']),
  deepslate_copper_ore: Object.freeze(['raw_copper', 'deepslate_copper_ore']),
  gold_ore: Object.freeze(['raw_gold', 'gold_ore']),
  deepslate_gold_ore: Object.freeze(['raw_gold', 'deepslate_gold_ore']),
  diamond_ore: Object.freeze(['diamond', 'diamond_ore']),
  deepslate_diamond_ore: Object.freeze(['diamond', 'deepslate_diamond_ore']),
  emerald_ore: Object.freeze(['emerald', 'emerald_ore']),
  deepslate_emerald_ore: Object.freeze(['emerald', 'deepslate_emerald_ore']),
  lapis_ore: Object.freeze(['lapis_lazuli', 'lapis_ore']),
  deepslate_lapis_ore: Object.freeze(['lapis_lazuli', 'deepslate_lapis_ore']),
  redstone_ore: Object.freeze(['redstone', 'redstone_ore']),
  deepslate_redstone_ore: Object.freeze(['redstone', 'deepslate_redstone_ore']),
  nether_quartz_ore: Object.freeze(['quartz', 'nether_quartz_ore']),
  nether_gold_ore: Object.freeze(['gold_nugget', 'nether_gold_ore']),
  ancient_debris: Object.freeze(['ancient_debris']),
});

export async function run(bot, params = {}, ctx = {}) {
  if (ctx.signal?.aborted) return preempted(bot, ctx, 'pre-aborted');

  const target = normalizeTarget(params);
  if (!target.ok) return failed(bot, ctx, target.reason);

  const ores = normalizeOreTargets(bot, params.ores);
  if (!ores.ok) return failed(bot, ctx, ores.reason);

  const state = ctx.callState || {};
  if (!state.startedAtMs) state.startedAtMs = Date.now();
  if (!state.attempts) state.attempts = 0;
  if (!state.minedTargetCount) state.minedTargetCount = 0;
  if (!state.minedCounts) state.minedCounts = {};
  if (!state.minedBlocks) state.minedBlocks = {};
  if (!state.toolBlockedTargets) state.toolBlockedTargets = {};
  if (!state.collectStates) state.collectStates = {};

  const deadlineAtMs = target.durationMs ? state.startedAtMs + target.durationMs : Infinity;
  let stopReason = null;

  while (shouldContinue(state, target, deadlineAtMs)) {
    if (ctx.signal?.aborted) return preempted(bot, ctx, 'reactive preempt during mine_until');
    const round = await collectOneVisibleOre(bot, ores.targets, {
      ctx,
      state,
      maxDistance: params.maxDistance ?? DEFAULT_MAX_DISTANCE,
      maxAttempts: target.maxAttempts,
      deadlineAtMs,
    });

    if (round?.preempted) return round;
    if (!round.ok) {
      if (round.noVisibleTargets) {
        stopReason = round.blockedByTool ? 'no-harvestable-visible-targets' : 'no-visible-targets';
        break;
      }
      return failed(bot, ctx, round.reason, mineSummary(state));
    }

    mergeCounts(state.minedCounts, round.inventoryDelta);
    state.minedBlocks[round.block] = (state.minedBlocks[round.block] || 0) + 1;
    state.minedTargetCount += 1;
  }

  if (!stopReason) {
    if (target.count && state.minedTargetCount >= target.count) stopReason = 'target-count-reached';
    else if (Date.now() >= deadlineAtMs) stopReason = 'duration-elapsed';
    else if (state.attempts >= target.maxAttempts) stopReason = 'max-attempts-reached';
    else stopReason = 'loop-stopped';
  }

  const summary = mineSummary(state);
  if (target.count && state.minedTargetCount < target.count) {
    return failed(
      bot,
      ctx,
      `mine_until mined ${state.minedTargetCount}/${target.count} visible ore targets before ${stopReason}`,
      summary,
    );
  }

  if (!target.count && state.minedTargetCount <= 0) {
    return failed(bot, ctx, `mine_until found no visible ore targets before ${stopReason}`, summary);
  }

  return {
    ok: true,
    reason: `mine_until mined ${state.minedTargetCount} visible ore target${state.minedTargetCount === 1 ? '' : 's'} before ${stopReason}`,
    ...summary,
    state: buildSnapshot(bot, ctx),
  };
}

async function collectOneVisibleOre(bot, targets, opts) {
  const { ctx, state, maxDistance, maxAttempts, deadlineAtMs } = opts;
  const noMoreReasons = {};

  for (const target of targets) {
    if (ctx.signal?.aborted) return preempted(bot, ctx, 'reactive preempt during mine_until');
    if (Date.now() >= deadlineAtMs) break;
    if (state.attempts >= maxAttempts) break;

    const before = readBotInventoryCounts(bot);
    if (!before.ok) {
      return { ok: false, reason: `inventory unavailable during mine_until: ${before.error}` };
    }
    const toolPlan = planToolForBlock(target.block, before.inventory, bot.registry);
    if (!toolPlan.ok) {
      const blocked = compactToolBlockedTarget(target.block, toolPlan);
      state.toolBlockedTargets[target.block] = blocked;
      noMoreReasons[target.block] = toolBlockedReason(blocked);
      continue;
    }

    state.attempts += 1;
    const collectState = state.collectStates[target.block] || (state.collectStates[target.block] = {});
    const result = await runCollect(bot, {
      block: target.block,
      count: 1,
      maxDistance,
      progressItems: target.progressItems,
      finishTree: false,
    }, {
      ...ctx,
      callState: collectState,
      currentSubtask: `mine_until.collect-${target.block}`,
    });

    if (result?.preempted) return result;
    if (result?.ok) {
      const after = readBotInventoryCounts(bot);
      if (!after.ok) {
        return { ok: false, reason: `inventory unavailable during mine_until: ${after.error}` };
      }
      state.collectStates[target.block] = {};
      return {
        ok: true,
        block: target.block,
        collectReason: result.reason,
        inventoryDelta: positiveDelta(before.inventory, after.inventory, target.progressItems),
      };
    }

    const reason = String(result?.reason || 'collect failed');
    if (reason.startsWith(`no more ${target.block}`)) {
      noMoreReasons[target.block] = reason;
      continue;
    }
    return { ok: false, reason: `mine_until ${target.block} failed: ${reason}` };
  }

  return {
    ok: false,
    blockedByTool: Object.keys(state.toolBlockedTargets || {}).length > 0,
    noVisibleTargets: true,
    reason: `mine_until found no visible ore targets (${Object.values(noMoreReasons).join('; ') || 'no targets scanned'})`,
  };
}

function normalizeTarget(params) {
  const hasCount = Number.isFinite(params.count);
  const hasDuration = Number.isFinite(params.durationMs);
  if (!hasCount && !hasDuration) return { ok: false, reason: 'mine_until requires count or durationMs' };
  if (hasCount && params.count < 1) return { ok: false, reason: 'mine_until count must be >= 1' };
  if (hasDuration && params.durationMs < 1) return { ok: false, reason: 'mine_until durationMs must be >= 1' };
  const maxAttempts = Number.isFinite(params.maxAttempts) ? params.maxAttempts : DEFAULT_MAX_ATTEMPTS;
  if (maxAttempts < 1) return { ok: false, reason: 'mine_until maxAttempts must be >= 1' };
  return {
    ok: true,
    count: hasCount ? params.count : null,
    durationMs: hasDuration ? params.durationMs : null,
    maxAttempts,
  };
}

function normalizeOreTargets(bot, ores) {
  const names = [...new Set((Array.isArray(ores) && ores.length > 0 ? ores : DEFAULT_ORES)
    .map((name) => String(name || '').trim())
    .filter(Boolean))];
  if (names.length === 0) return { ok: false, reason: 'mine_until ores must include at least one block name' };
  const unknown = names.filter((name) => !bot.registry?.blocksByName?.[name]);
  if (unknown.length > 0) return { ok: false, reason: `unknown ore block "${unknown[0]}"` };
  const unsupported = names.filter((name) => !isOreLike(name));
  if (unsupported.length > 0) return { ok: false, reason: `mine_until target "${unsupported[0]}" is not an ore-like block` };
  return {
    ok: true,
    targets: names.map((block) => ({
      block,
      progressItems: ORE_PROGRESS_ITEMS[block] || [block],
    })),
  };
}

function shouldContinue(state, target, deadlineAtMs) {
  if (state.attempts >= target.maxAttempts) return false;
  if (target.count && state.minedTargetCount >= target.count) return false;
  if (Date.now() >= deadlineAtMs) return false;
  return true;
}

function mineSummary(state) {
  return {
    attempts: state.attempts,
    minedTargetCount: state.minedTargetCount,
    minedCounts: countItems(Object.entries(state.minedCounts || {}).map(([name, count]) => ({ name, count }))),
    minedBlocks: countItems(Object.entries(state.minedBlocks || {}).map(([name, count]) => ({ name, count }))),
    toolBlockedTargets: sortToolBlockedTargets(state.toolBlockedTargets),
  };
}

function compactToolBlockedTarget(block, plan) {
  const missingTools = [...(plan.missingTools || plan.requirements?.harvestTools || [])];
  return {
    block,
    toolKind: plan.toolKind || plan.requirements?.toolKind || null,
    selectedTool: plan.selectedTool || null,
    missingTools,
    reason: plan.reason || (
      missingTools.length > 0
        ? `requires one of ${missingTools.join(', ')}`
        : 'requires an unavailable harvest tool'
    ),
  };
}

function toolBlockedReason(blocked) {
  return `tool-blocked ${blocked.block}: ${blocked.reason}`;
}

function sortToolBlockedTargets(targets) {
  return Object.fromEntries(
    Object.entries(targets || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, target]) => [name, {
        ...target,
        missingTools: [...(target.missingTools || [])],
      }])
  );
}

function positiveDelta(before, after, names) {
  const out = {};
  for (const name of names) {
    const delta = (after?.[name] || 0) - (before?.[name] || 0);
    if (delta > 0) out[name] = delta;
  }
  return countItems(Object.entries(out).map(([name, count]) => ({ name, count })));
}

function mergeCounts(target, counts) {
  for (const [name, count] of Object.entries(counts || {})) {
    target[name] = (target[name] || 0) + count;
  }
  return target;
}

function isOreLike(name) {
  return String(name || '').endsWith('_ore') || name === 'ancient_debris';
}

function failed(bot, ctx, reason, extra = {}) {
  return { ok: false, reason, ...extra, state: buildSnapshot(bot, ctx) };
}

function preempted(bot, ctx, reason) {
  return { preempted: true, reason, state: buildSnapshot(bot, ctx) };
}
