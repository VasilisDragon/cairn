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
import { Vec3 } from 'vec3';
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
import { filterAccessibleStorage } from '../state/world_model.js';
import {
  authorizeWorkstationAccess,
  filterAuthorizedAnchors,
  WORLD_ANCHOR_KIND,
} from '../state/world_action_authorization.js';
import {
  awaitGoalReached,
  configurePathingMovements,
  pathingFailureReason,
  worldModelFromContext,
} from './_pathing.js';
import { acquirePathfinder, releasePathfinder, setPathfinderGoal } from './_ownership.js';
import { runBoundedOperation } from './_operations.js';
import { run as runPlace } from './place.js';
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
      const tableSearch = findCraftingTable(bot, 16, { ctx, worldModel, signal: ctx.signal });
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
        if (tableSearch.protected > 0) {
          return {
            ok: false,
            reason: `no recipe for "${itemName}" — need ingredients OR a crafting_table within 16 blocks${protectedReason}`,
            state: buildSnapshot(bot, ctx),
          };
        }
        const portable = await ensurePortableCraftingTable(bot, ctx, worldModel, { itemName });
        if (portable.preempted) return { ...portable, state: buildSnapshot(bot, ctx) };
        if (!portable.ok) {
          return {
            ok: false,
            reason: `no recipe for "${itemName}" — need ingredients OR a crafting_table within 16 blocks${protectedReason}; portable crafting_table failed: ${portable.reason}`,
            state: buildSnapshot(bot, ctx),
          };
        }
        s.lockedTablePos = portable.position.clone();
        s.walked = true;
        log.executor.info('craft.portable-table.ready', {
          item: itemName,
          position: positionRecord(portable.position),
          crafted: portable.crafted,
        });
      } else {
        s.lockedTablePos = table.position.clone();
        s.walked = false;
      }
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
    const lockedPolicy = craftTargetPolicy(bot, s.lockedTablePos, { ctx, worldModel, blockName: 'crafting_table' });
    if (!lockedPolicy.ok) {
      return {
        ok: false,
        reason: `locked crafting_table access denied: ${lockedPolicy.reason}`,
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
    const recipe = selectRecipeForCurrentInventory(bot, recipes, count);
    const staged = await stageRecipeIngredients(bot, recipe, item.name, count, table, ctx, worldModel);
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
    const recipe = selectRecipeForCurrentInventory(bot, recipes, count);
    if (table) {
      const finalPolicy = craftTargetPolicy(bot, table.position, { ctx, worldModel, blockName: table.name });
      if (!finalPolicy.ok) {
        return { ok: false, reason: `locked crafting_table access denied: ${finalPolicy.reason}`, state: buildSnapshot(bot, ctx) };
      }
    }
    await craftRecipe(bot, recipe, count, table || undefined, {
      item: itemName,
      phase: 'final',
    }, {
      signal: ctx.signal,
      authorize: table
        ? () => craftTargetPolicy(bot, table.position, { ctx, worldModel, blockName: table.name })
        : null,
    });
  } catch (err) {
    if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt during craft', state: buildSnapshot(bot, ctx) };
    return { ok: false, reason: `craft failed: ${errorMessage(err)}`, state: buildSnapshot(bot, ctx) };
  }
  return { ok: true, reason: `crafted ${count} ${itemName}`, state: buildSnapshot(bot, ctx) };
}

async function ensurePortableCraftingTable(bot, ctx, worldModel, opts = {}) {
  if (ctx.portableCraftingTableInProgress === true) {
    return { ok: false, reason: 'recursive portable crafting_table setup refused' };
  }
  if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt before portable crafting_table setup' };

  const before = readBotInventoryCounts(bot);
  if (!before.ok) return { ok: false, reason: `inventory unavailable during portable crafting_table setup: ${before.error}` };
  let crafted = false;
  if ((before.inventory.crafting_table || 0) < 1) {
    log.executor.info('craft.portable-table.craft-start', { item: opts.itemName || null });
    const craftedTable = await run(bot, { item: 'crafting_table', count: 1 }, {
      ...ctx,
      callState: {},
      worldModel,
      portableCraftingTableInProgress: true,
    });
    if (craftedTable.preempted) return craftedTable;
    if (!craftedTable.ok) return { ok: false, reason: `crafting_table craft failed: ${craftedTable.reason}` };
    crafted = true;
    log.executor.info('craft.portable-table.craft-done', { item: opts.itemName || null });
  }

  if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt before portable crafting_table placement' };
  log.executor.info('craft.portable-table.place-start', { item: opts.itemName || null });
  const placed = await runPlace(bot, { block: 'crafting_table' }, {
    ...ctx,
    callState: {},
    worldModel,
  });
  if (placed.preempted) return placed;
  if (!placed.ok) return { ok: false, reason: `crafting_table placement failed: ${placed.reason}` };
  const placedAt = placed.state?.placedAt;
  if (!finitePosition(placedAt)) return { ok: false, reason: 'crafting_table placement did not report placedAt' };
  const position = vec3Like(placedAt);
  log.executor.info('craft.portable-table.place-done', {
    item: opts.itemName || null,
    position: positionRecord(position),
  });
  return { ok: true, position, crafted };
}

async function stageMissingIngredients(bot, item, craftCount, table, ctx, worldModel) {
  const allRecipes = lookupRecipesAll(bot, item.id, table, 'craft missing-ingredient planning');
  if (!allRecipes.ok) return allRecipes;
  if (allRecipes.recipes.length === 0) return { ok: true, staged: false };

  return stageRecipeIngredients(
    bot,
    selectRecipeForCurrentInventory(bot, allRecipes.recipes, craftCount),
    item.name,
    craftCount,
    table,
    ctx,
    worldModel,
  );
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

      const accessibleStorage = authorizedStorageForCraft(bot, ctx, worldModel);
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
      const dependencyRecipe = selectRecipeForInventory(dependencyRecipes.recipes, bot.registry, inventory.inventory, 1);
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
      const craftableInventory = readBotInventoryCounts(bot);
      if (!craftableInventory.ok) {
        return { ok: false, reason: `inventory unavailable during craft dependency ${name}: ${craftableInventory.error}` };
      }
      const craftableRecipe = selectRecipeForInventory(craftable, bot.registry, craftableInventory.inventory, times) || craftable[0];
      try {
        if (table) {
          const finalPolicy = craftTargetPolicy(bot, table.position, { ctx, worldModel, blockName: table.name });
          if (!finalPolicy.ok) {
            return { ok: false, reason: `locked crafting_table access denied: ${finalPolicy.reason}` };
          }
        }
        await craftRecipe(bot, craftableRecipe, times, table || undefined, {
          item: name,
          root: opts.rootName,
          phase: 'dependency',
        }, {
          signal: ctx.signal,
          authorize: table
            ? () => craftTargetPolicy(bot, table.position, { ctx, worldModel, blockName: table.name })
            : null,
        });
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
      () => {
        if (typeof opts.authorize === 'function') {
          const policy = opts.authorize();
          if (!policy.ok) {
            const error = new Error(`crafting_table access denied immediately before craft: ${policy.reason}`);
            error.code = 'WORLD_ACTION_DENIED';
            throw error;
          }
        }
        return bot.craft(recipe, count, table);
      },
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
    const policy = craftTargetPolicy(bot, block.position, { ...opts, blockName: block.name });
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
    const policy = craftTargetPolicy(bot, block.position, { ...opts, blockName: block.name });
    if (!policy.ok) {
      protectedCount += 1;
      continue;
    }
    return { block, protected: protectedCount };
  }
  return { block: null, protected: protectedCount };
}

function craftTargetPolicy(bot, position, opts = {}) {
  return authorizeWorkstationAccess(bot, opts.ctx || {}, position, opts);
}

function authorizedStorageForCraft(bot, ctx, worldModel) {
  const regionFiltered = filterAccessibleStorage(worldModel);
  const authorized = filterAuthorizedAnchors(
    bot,
    ctx,
    regionFiltered.storages,
    WORLD_ANCHOR_KIND.STORAGE,
    { worldModel },
  );
  return {
    storages: authorized.accessible,
    protected: [
      ...(regionFiltered.protected || []),
      ...authorized.denied.map(({ candidate, policy }) => ({ storage: candidate, policy })),
    ],
  };
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

function selectRecipeForCurrentInventory(bot, recipes, craftCount) {
  const inventory = readBotInventoryCounts(bot);
  if (!inventory.ok) return recipes?.[0] || null;
  return selectRecipeForInventory(recipes, bot.registry, inventory.inventory, craftCount) || recipes?.[0] || null;
}

function selectRecipeForInventory(recipes, registry, inventory, craftCount = 1) {
  if (!Array.isArray(recipes) || recipes.length === 0) return null;
  const count = Number(craftCount ?? 1);
  const multiplier = Number.isFinite(count) && count > 0 ? count : 1;
  return [...recipes].sort((a, b) => compareRecipeFit(
    recipeFitScore(a, registry, inventory, multiplier),
    recipeFitScore(b, registry, inventory, multiplier),
  ))[0] || null;
}

function compareRecipeFit(a, b) {
  return a.unmet - b.unmet
    || a.directMissing - b.directMissing
    || b.directAvailable - a.directAvailable
    || a.derivedMissing - b.derivedMissing
    || a.key.localeCompare(b.key);
}

function recipeFitScore(recipe, registry, inventory = {}, craftCount = 1) {
  const requirements = multiplyCounts(recipeRequirements(recipe, registry), craftCount);
  let unmet = 0;
  let directMissing = 0;
  let derivedMissing = 0;
  let directAvailable = 0;
  for (const [name, required] of Object.entries(requirements)) {
    const have = Math.max(0, Number(inventory[name] || 0));
    directAvailable += Math.min(required, have);
    const deficit = Math.max(0, required - have);
    directMissing += deficit;
    if (deficit <= 0) continue;
    const derived = Math.min(deficit, derivedIngredientSupport(name, inventory));
    derivedMissing += Math.max(0, deficit - derived);
    unmet += Math.max(0, deficit - derived);
  }
  return {
    unmet,
    directMissing,
    derivedMissing,
    directAvailable,
    key: recipeKey(recipe, registry),
  };
}

function derivedIngredientSupport(name, inventory = {}) {
  if (!isWoodPlanksName(name)) return 0;
  return woodSourcesForPlanks(name)
    .reduce((sum, source) => sum + Math.max(0, Number(inventory[source] || 0)) * 4, 0);
}

function isWoodPlanksName(name) {
  return String(name || '').endsWith('_planks');
}

function woodSourcesForPlanks(name) {
  const text = String(name || '');
  if (!text.endsWith('_planks')) return [];
  const base = text.slice(0, -'_planks'.length);
  if (base === 'crimson' || base === 'warped') return [`${base}_stem`, `${base}_hyphae`];
  return [`${base}_log`, `${base}_wood`];
}

function recipeKey(recipe, registry) {
  const output = recipeOutput(recipe, registry);
  return String(recipe?.id || recipe?.name || `${output?.name || 'unknown'}:${JSON.stringify(recipeRequirements(recipe, registry))}`);
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

function finitePosition(value) {
  return Number.isFinite(Number(value?.x))
    && Number.isFinite(Number(value?.y))
    && Number.isFinite(Number(value?.z));
}

function vec3Like(position) {
  if (typeof position?.clone === 'function') return position;
  return new Vec3(Number(position.x), Number(position.y), Number(position.z));
}

function positionRecord(position) {
  if (!position) return null;
  return { x: position.x, y: position.y, z: position.z };
}

function missingIngredientReason(rootName, missing, protectedStorage) {
  const protectedCount = protectedStorage?.length || 0;
  const suffix = protectedCount > 0 ? ` (protected storage skipped: ${protectedCount})` : '';
  return `missing ingredients for "${rootName}": ${formatCounts(missing)}${suffix}`;
}

function errorMessage(err) {
  return err?.message || String(err);
}
