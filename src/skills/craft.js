// craft — by recipe name and count. Locked target per decision (C): the
// crafting_table (if needed) is captured on first call and reused across
// preempt/resume cycles.
//
// callState shape:
//   {
//     lockedTablePos: Vec3 | null,   // null = inventory crafting only
//     walked:         boolean,
//   }

import pkgPathfinder from 'mineflayer-pathfinder';
import config from '../config.js';
import log from '../logger.js';
import buildSnapshot from '../state/snapshot.js';
import { awaitBotChunksReady } from '../control/chunk_ready.js';
import {
  missingItems,
  planMaterialFulfillment,
  readBotInventoryCounts,
  recipeOutput,
  recipeRequirements,
} from '../state/materials.js';
import { blockModificationPolicy, filterAccessibleStorage } from '../state/world_model.js';
import {
  awaitGoalReached,
  configurePathingMovements,
  pathingFailureReason,
  worldModelFromContext,
} from './_pathing.js';
import { acquirePathfinder, releasePathfinder, setPathfinderGoal } from './_ownership.js';
import { runBoundedOperation } from './_operations.js';
import { withdrawFromKnownStorage } from './_storage.js';

const { goals: pfGoals } = pkgPathfinder;

export async function run(bot, params, ctx) {
  const itemName = params.item;
  const count = params.count ?? 1;
  const mcData = bot.registry;
  const item = mcData?.itemsByName?.[itemName];
  if (!item) return { ok: false, reason: `unknown item "${itemName}"`, state: buildSnapshot(bot, ctx) };

  const chunks = await awaitBotChunksReady(bot, ctx.signal, 'reactive preempt waiting for craft chunk readiness');
  if (chunks.preempted) return { preempted: true, reason: chunks.reason, state: buildSnapshot(bot, ctx) };
  if (chunks.error) return { ok: false, reason: `chunk data unavailable during craft: ${errorMessage(chunks.error)}`, state: buildSnapshot(bot, ctx) };

  const s = ctx.callState;
  let worldModel = null;
  if (s.lockedTablePos === undefined) {
    // First call: figure out whether we need a crafting_table.
    const inventoryRecipes = lookupRecipesFor(bot, item.id, 1, null, 'craft inventory recipe lookup');
    if (!inventoryRecipes.ok) return { ...inventoryRecipes, state: buildSnapshot(bot, ctx) };
    let inventoryRecipeOptions = inventoryRecipes.recipes;
    if (inventoryRecipeOptions.length === 0) {
      const allInventoryRecipes = lookupRecipesAll(bot, item.id, null, 'craft inventory recipe fallback');
      if (!allInventoryRecipes.ok) return { ...allInventoryRecipes, state: buildSnapshot(bot, ctx) };
      inventoryRecipeOptions = allInventoryRecipes.recipes;
    }
    if (inventoryRecipeOptions.length > 0) {
      s.lockedTablePos = null; // explicitly: no table needed
      s.walked = true;
    } else {
      const worldModelResult = worldModelFromContext(ctx);
      if (worldModelResult.error) {
        return {
          ok: false,
          reason: `world-model policy unavailable during craft: ${worldModelResult.error.message}`,
          state: buildSnapshot(bot, { ...ctx, worldModelStore: null }),
        };
      }
      worldModel = worldModelResult.model;
      const tableSearch = findCraftingTable(bot, 16, { worldModel, signal: ctx.signal });
      if (tableSearch.preempted) {
        return { preempted: true, reason: tableSearch.reason, state: buildSnapshot(bot, ctx) };
      }
      if (tableSearch.error) {
        return {
          ok: false,
          reason: `world query failed during craft table scan: ${errorMessage(tableSearch.error)}`,
          state: buildSnapshot(bot, ctx),
        };
      }
      const table = tableSearch.block;
      if (!table) {
        const protectedReason = tableSearch.protected > 0 ? ` (protected ${tableSearch.protected})` : '';
        return {
          ok: false,
          reason: `no recipe for "${itemName}" — need ingredients OR a crafting_table within 16 blocks${protectedReason}`,
          state: buildSnapshot(bot, ctx),
        };
      }
      s.lockedTablePos = table.position.clone();
      s.walked = false;
    }
  }

  if (ctx.signal?.aborted) return { preempted: true, reason: 'pre-aborted', state: buildSnapshot(bot, ctx) };

  // Resolve the table block (if any).
  let table = null;
  if (s.lockedTablePos) {
    if (worldModel === null) {
      const worldModelResult = worldModelFromContext(ctx);
      if (worldModelResult.error) {
        return {
          ok: false,
          reason: `world-model policy unavailable during craft: ${worldModelResult.error.message}`,
          state: buildSnapshot(bot, { ...ctx, worldModelStore: null }),
        };
      }
      worldModel = worldModelResult.model;
    }
    const lockedPolicy = craftTargetPolicy(s.lockedTablePos, { worldModel });
    if (!lockedPolicy.ok) {
      return {
        ok: false,
        reason: `locked crafting_table is inside do-not-touch region ${lockedPolicy.region?.id || 'unknown'}`,
        state: buildSnapshot(bot, ctx),
      };
    }
    try {
      table = bot.blockAt(s.lockedTablePos);
    } catch (err) {
      if (ctx.signal?.aborted) {
        return { preempted: true, reason: 'reactive preempt checking crafting_table', state: buildSnapshot(bot, ctx) };
      }
      return {
        ok: false,
        reason: `world query failed checking crafting_table: ${errorMessage(err)}`,
        state: buildSnapshot(bot, ctx),
      };
    }
    if (!table || table.name !== 'crafting_table') {
      return { ok: false, reason: 'locked crafting_table no longer present', state: buildSnapshot(bot, ctx) };
    }
  }

  // Walk to the table if we haven't yet.
  if (!s.walked && s.lockedTablePos) {
    const acquired = acquirePathfinder(bot, 'craft.walk', { skill: 'craft', phase: 'walk' });
    if (!acquired.ok) {
      return { ok: false, reason: `pathfinder acquire failed during craft walk: ${acquired.message}`, state: buildSnapshot(bot, ctx) };
    }
    const acq = acquired.acq;
    if (!acq) return { preempted: true, reason: 'reactive holds pathfinder', state: buildSnapshot(bot, ctx) };
    try {
      const movementConfig = configurePathingMovements(bot, ctx, {
        phase: 'craft',
        allowParkour: false,
        worldModel,
      });
      if (!movementConfig.ok) {
        const stateCtx = movementConfig.worldModelError ? { ...ctx, worldModelStore: null } : ctx;
        return {
          ok: false,
          reason: `${movementConfig.reason}: ${errorMessage(movementConfig.error)}`,
          state: buildSnapshot(bot, stateCtx),
        };
      }
      const goal = new pfGoals.GoalNear(s.lockedTablePos.x, s.lockedTablePos.y, s.lockedTablePos.z, 2);
      const installed = setPathfinderGoal(bot, acq.token, goal, { movements: movementConfig.movements }, { skill: 'craft', phase: 'walk' });
      if (!installed.ok) {
        const reason = installed.denied
          ? 'pathfinder setGoal denied'
          : `pathfinder setGoal failed during craft walk: ${installed.message}`;
        return { ok: false, reason, state: buildSnapshot(bot, ctx) };
      }
      const r = await awaitGoalReached(bot, ctx.signal, 60000, { ownerToken: acq.token });
      if (r.kind === 'preempted') return { preempted: true, reason: 'reactive preempt walking to craft', state: buildSnapshot(bot, ctx) };
      if (r.kind !== 'reached') return { ok: false, reason: `walk to crafting_table: ${pathingFailureReason(r)}`, state: buildSnapshot(bot, ctx) };
      s.walked = true;
    } finally {
      releasePathfinder(acq, { skill: 'craft', phase: 'walk' });
    }
  }

  // Craft.
  if (ctx.signal?.aborted) return { preempted: true, reason: 'pre-aborted before craft', state: buildSnapshot(bot, ctx) };

  let recipeLookup = lookupRecipesFor(bot, item.id, 1, table, 'craft recipe lookup');
  if (!recipeLookup.ok) return { ...recipeLookup, state: buildSnapshot(bot, ctx) };
  let recipes = recipeLookup.recipes;
  if (recipes.length > 0) {
    const staged = await stageRecipeIngredients(bot, recipes[0], item.name, count, table, ctx, worldModel);
    if (staged?.preempted) return { ...staged, state: buildSnapshot(bot, ctx) };
    if (staged && !staged.ok) return { ...staged, state: buildSnapshot(bot, ctx) };
    if (staged?.staged) {
      recipeLookup = lookupRecipesFor(bot, item.id, 1, table, 'craft recipe refresh');
      if (!recipeLookup.ok) return { ...recipeLookup, state: buildSnapshot(bot, ctx) };
      recipes = recipeLookup.recipes;
    }
  }
  if (recipes.length === 0) {
    const staged = await stageMissingIngredients(bot, item, count, table, ctx, worldModel);
    if (staged?.preempted) return { ...staged, state: buildSnapshot(bot, ctx) };
    if (staged && !staged.ok) return { ...staged, state: buildSnapshot(bot, ctx) };
    if (staged?.staged) {
      recipeLookup = lookupRecipesFor(bot, item.id, 1, table, 'craft recipe refresh');
      if (!recipeLookup.ok) return { ...recipeLookup, state: buildSnapshot(bot, ctx) };
      recipes = recipeLookup.recipes;
    }
  }
  if (recipes.length === 0) {
    return {
      ok: false,
      reason: `no recipe for "${itemName}" with current ingredients`,
      state: buildSnapshot(bot, ctx),
    };
  }
  try {
    await craftRecipe(bot, recipes[0], count, table || undefined, {
      item: itemName,
      phase: 'final',
    }, { signal: ctx.signal });
  } catch (err) {
    if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt during craft', state: buildSnapshot(bot, ctx) };
    return { ok: false, reason: `craft failed: ${errorMessage(err)}`, state: buildSnapshot(bot, ctx) };
  }
  return { ok: true, reason: `crafted ${count} ${itemName}`, state: buildSnapshot(bot, ctx) };
}

async function stageMissingIngredients(bot, item, craftCount, table, ctx, worldModel) {
  const allRecipes = lookupRecipesAll(bot, item.id, table, 'craft missing-ingredient planning');
  if (!allRecipes.ok) return allRecipes;
  if (allRecipes.recipes.length === 0) return { ok: true, staged: false };

  return stageRecipeIngredients(bot, allRecipes.recipes[0], item.name, craftCount, table, ctx, worldModel);
}

async function stageRecipeIngredients(bot, recipe, rootName, craftCount, table, ctx, worldModel) {
  const requirements = multiplyCounts(recipeRequirements(recipe, bot.registry), craftCount);
  const inventory = readBotInventoryCounts(bot);
  if (!inventory.ok) {
    return { ok: false, reason: `inventory unavailable during craft dependency staging: ${inventory.error}` };
  }
  if (Object.keys(missingItems(requirements, inventory.inventory)).length === 0) {
    return { ok: true, staged: false };
  }

  const loadedWorldModel = worldModel ? { model: worldModel } : loadWorldModelForCraft(ctx);
  if (loadedWorldModel.error) {
    return {
      ok: false,
      reason: `world-model policy unavailable during craft storage withdrawal: ${loadedWorldModel.error.message}`,
    };
  }

  return ensureRecipeInputs(bot, recipe, craftCount, table, ctx, loadedWorldModel.model, {
    rootName,
    stack: [rootName],
  });
}

async function ensureRecipeInputs(bot, recipe, craftCount, table, ctx, worldModel, opts) {
  const requirements = multiplyCounts(recipeRequirements(recipe, bot.registry), craftCount);
  let staged = false;

  for (const [name, required] of Object.entries(requirements)) {
    while (true) {
      if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt during craft dependency staging' };
      const inventory = readBotInventoryCounts(bot);
      if (!inventory.ok) {
        return { ok: false, reason: `inventory unavailable during craft dependency staging: ${inventory.error}` };
      }
      const have = inventory.inventory[name] || 0;
      if (have >= required) break;
      const deficit = required - have;

      const accessibleStorage = filterAccessibleStorage(worldModel);
      const withdrawn = await withdrawIngredient(bot, name, required, ctx, worldModel, accessibleStorage, inventory.inventory);
      if (withdrawn.preempted) return withdrawn;
      if (withdrawn.ok && withdrawn.staged) {
        staged = true;
        continue;
      }
      if (!withdrawn.ok && withdrawn.kind !== 'missing') return withdrawn;

      const item = bot.registry?.itemsByName?.[name];
      const dependencyRecipes = item && !opts.stack.includes(name)
        ? lookupRecipesAll(bot, item.id, table, `craft dependency ${name}`)
        : { ok: true, recipes: [] };
      if (!dependencyRecipes.ok) return dependencyRecipes;
      const dependencyRecipe = dependencyRecipes.recipes[0] || null;
      if (!dependencyRecipe) {
        return {
          ok: false,
          reason: missingIngredientReason(opts.rootName, withdrawn.missing || { [name]: deficit }, withdrawn.protected),
        };
      }

      const output = recipeOutput(dependencyRecipe, bot.registry) || { name, count: 1 };
      const outputCount = output.name === name ? output.count || 1 : 1;
      const times = Math.ceil(deficit / outputCount);
      const dependencies = await ensureRecipeInputs(bot, dependencyRecipe, times, table, ctx, worldModel, {
        rootName: opts.rootName,
        stack: [...opts.stack, name],
      });
      if (dependencies.preempted || !dependencies.ok) return dependencies;
      if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt during craft dependency staging' };

      const craftableLookup = lookupRecipesFor(bot, item.id, deficit, table, `craft dependency ${name}`);
      if (!craftableLookup.ok) return craftableLookup;
      const craftable = craftableLookup.recipes;
      if (craftable.length === 0) {
        return {
          ok: false,
          reason: missingIngredientReason(opts.rootName, { [name]: deficit }, null),
        };
      }
      try {
        await craftRecipe(bot, craftable[0], times, table || undefined, {
          item: name,
          root: opts.rootName,
          phase: 'dependency',
        }, { signal: ctx.signal });
      } catch (err) {
        if (ctx.signal?.aborted) return { preempted: true, reason: `reactive preempt during craft dependency ${name}` };
        return { ok: false, reason: `craft dependency ${name} failed: ${errorMessage(err)}` };
      }
      staged = true;
    }
  }

  return { ok: true, staged };
}

async function withdrawIngredient(bot, name, required, ctx, worldModel, accessibleStorage, inventory) {
  const materialPlan = planMaterialFulfillment({
    requirements: { [name]: required },
    inventory,
    storages: accessibleStorage?.storages || worldModel?.storageSightings || [],
    from: bot.entity?.position || null,
  });
  if (!materialPlan.ok) {
    return {
      ok: false,
      kind: 'missing',
      missing: materialPlan.stillMissing,
      protected: accessibleStorage?.protected || [],
    };
  }
  if (materialPlan.withdrawals.length === 0) return { ok: true, staged: false };

  const result = await withdrawFromKnownStorage(
    bot,
    materialPlan.withdrawals.map((withdrawal) => ({ ...withdrawal })),
    ctx,
    { ...(ctx.storageWithdrawalOptions || {}), worldModel }
  );
  if (result.preempted || !result.ok) return result;
  return { ok: true, staged: result.withdrawn.length > 0, withdrawn: result.withdrawn };
}

function loadWorldModelForCraft(ctx) {
  const result = worldModelFromContext(ctx);
  if (result.error) return result;
  return { model: result.model };
}

async function craftRecipe(bot, recipe, count, table, fields = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? config.executor?.craftOperationTimeoutMs ?? 30000;
  try {
    return await runBoundedOperation(
      () => bot.craft(recipe, count, table),
      {
        timeoutMs,
        timeoutCode: 'CRAFT_OPERATION_TIMEOUT',
        timeoutMessage: `craft operation timed out after ${timeoutMs}ms`,
        signal: opts.signal,
        abortCode: 'CRAFT_OPERATION_ABORTED',
        abortMessage: 'craft operation aborted',
      },
    );
  } catch (err) {
    if (err?.code === 'CRAFT_OPERATION_TIMEOUT') {
      log.executor.warn('craft.operation-timeout', {
        ...fields,
        count,
        timeoutMs,
        err: err.message,
      });
    }
    throw err;
  }
}

function findCraftingTable(bot, maxDistance, opts = {}) {
  const tableId = bot.registry?.blocksByName?.crafting_table?.id;
  if (tableId == null) return { block: null, protected: 0 };

  if (!bot.findBlocks) {
    let block;
    try {
      block = bot.findBlock?.({ matching: tableId, maxDistance }) || null;
    } catch (err) {
      return craftTableScanFailure(opts, err);
    }
    if (!block) return { block: null, protected: 0 };
    const policy = craftTargetPolicy(block.position, opts);
    return policy.ok ? { block, protected: 0 } : { block: null, protected: 1 };
  }

  let positions;
  try {
    positions = bot.findBlocks({ matching: tableId, maxDistance, count: 32 });
  } catch (err) {
    return craftTableScanFailure(opts, err);
  }
  let protectedCount = 0;
  for (const position of positions) {
    let block;
    try {
      block = bot.blockAt(position);
    } catch (err) {
      return craftTableScanFailure(opts, err);
    }
    if (!block || block.name !== 'crafting_table') continue;
    const policy = craftTargetPolicy(block.position, opts);
    if (!policy.ok) {
      protectedCount += 1;
      continue;
    }
    return { block, protected: protectedCount };
  }
  return { block: null, protected: protectedCount };
}

function craftTargetPolicy(position, opts = {}) {
  if (!opts.worldModel) return { ok: true, action: 'allow', reason: 'no world model' };
  return blockModificationPolicy(opts.worldModel, position, { margin: opts.doNotTouchMargin ?? 0 });
}

function craftTableScanFailure(opts, err) {
  if (opts.signal?.aborted) return { preempted: true, reason: 'reactive preempt during craft table scan' };
  return { error: err };
}

function lookupRecipesFor(bot, itemId, count, table, phase) {
  if (typeof bot.recipesFor !== 'function') {
    return { ok: false, reason: `recipe lookup failed during ${phase}: bot.recipesFor unavailable` };
  }
  try {
    const recipes = bot.recipesFor(itemId, null, count, table);
    return { ok: true, recipes: Array.isArray(recipes) ? recipes : [] };
  } catch (err) {
    return { ok: false, reason: `recipe lookup failed during ${phase}: ${errorMessage(err)}` };
  }
}

function lookupRecipesAll(bot, itemId, table, phase) {
  if (typeof bot.recipesAll !== 'function') return { ok: true, recipes: [] };
  try {
    const recipes = bot.recipesAll(itemId, null, table);
    return { ok: true, recipes: Array.isArray(recipes) ? recipes : [] };
  } catch (err) {
    return { ok: false, reason: `recipe lookup failed during ${phase}: ${errorMessage(err)}` };
  }
}

function multiplyCounts(counts, times) {
  const out = {};
  const n = Number(times ?? 1);
  const multiplier = Number.isFinite(n) && n > 0 ? n : 1;
  for (const [name, count] of Object.entries(counts || {})) out[name] = count * multiplier;
  return out;
}

function formatCounts(counts) {
  return Object.entries(counts || {})
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => `${count} ${name}`)
    .join(', ');
}

function missingIngredientReason(rootName, missing, protectedStorage) {
  const protectedCount = protectedStorage?.length || 0;
  const suffix = protectedCount > 0 ? ` (protected storage skipped: ${protectedCount})` : '';
  return `missing ingredients for "${rootName}": ${formatCounts(missing)}${suffix}`;
}

function errorMessage(err) {
  return err?.message || String(err);
}
