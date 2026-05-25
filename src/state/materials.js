export function countItems(items = []) {
  const out = {};
  for (const item of items || []) {
    if (!item?.name) continue;
    const count = Number(item.count ?? 1);
    if (!Number.isFinite(count) || count <= 0) continue;
    out[item.name] = (out[item.name] || 0) + count;
  }
  return sortCounts(out);
}

export function countBotInventory(bot) {
  return countItems(bot?.inventory?.items?.() || []);
}

export function readBotInventoryItems(bot) {
  try {
    return { ok: true, items: bot?.inventory?.items?.() || [] };
  } catch (err) {
    return { ok: false, items: [], error: errorMessage(err) };
  }
}

export function readBotInventoryCounts(bot) {
  const result = readBotInventoryItems(bot);
  if (!result.ok) return { ok: false, inventory: {}, error: result.error };
  return { ok: true, inventory: countItems(result.items) };
}

export function normalizeCounts(input = {}) {
  if (Array.isArray(input)) return countItems(input);
  if (input instanceof Map) return normalizeCounts(Object.fromEntries(input.entries()));
  const out = {};
  for (const [name, rawCount] of Object.entries(input || {})) {
    const count = Number(rawCount);
    if (!name || !Number.isFinite(count) || count <= 0) continue;
    out[name] = (out[name] || 0) + count;
  }
  return sortCounts(out);
}

export function mergeCounts(...inputs) {
  const out = {};
  for (const input of inputs) {
    const counts = normalizeCounts(input);
    for (const [name, count] of Object.entries(counts)) out[name] = (out[name] || 0) + count;
  }
  return sortCounts(out);
}

export function missingItems(requirements, available) {
  const required = normalizeCounts(requirements);
  const have = normalizeCounts(available);
  const missing = {};
  for (const [name, count] of Object.entries(required)) {
    const short = count - (have[name] || 0);
    if (short > 0) missing[name] = short;
  }
  return sortCounts(missing);
}

export function canSatisfy(requirements, available) {
  const required = normalizeCounts(requirements);
  const have = normalizeCounts(available);
  const missing = missingItems(required, have);
  return {
    ok: Object.keys(missing).length === 0,
    required,
    available: have,
    missing,
  };
}

export function findNearestStorageWithItem(storages, itemName, from, opts = {}) {
  if (!itemName || !from) return null;
  const maxDistance = opts.maxDistance ?? Infinity;
  return (storages || [])
    .map((storage, index) => storageHit(storage, itemName, from, index))
    .filter((hit) => hit && hit.count > 0 && hit.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || a.storageId.localeCompare(b.storageId))[0] || null;
}

export function planMaterialFulfillment({ requirements, inventory = {}, storages = [], from = null } = {}) {
  const required = normalizeCounts(requirements);
  const inventoryCounts = normalizeCounts(inventory);
  const missingAfterInventory = missingItems(required, inventoryCounts);
  const withdrawals = [];
  const stillMissing = {};

  for (const [name, needed] of Object.entries(missingAfterInventory)) {
    let remaining = needed;
    const hits = (storages || [])
      .map((storage, index) => storageHit(storage, name, from, index))
      .filter((hit) => hit && hit.count > 0)
      .sort((a, b) => a.distance - b.distance || a.storageId.localeCompare(b.storageId));

    for (const hit of hits) {
      if (remaining <= 0) break;
      const count = Math.min(remaining, hit.count);
      withdrawals.push({
        storageId: hit.storageId,
        item: name,
        count,
        position: hit.position,
        distance: hit.distance,
      });
      remaining -= count;
    }
    if (remaining > 0) stillMissing[name] = remaining;
  }

  return {
    ok: Object.keys(stillMissing).length === 0,
    required,
    inventory: inventoryCounts,
    missingAfterInventory,
    withdrawals,
    stillMissing: sortCounts(stillMissing),
  };
}

export function recipeOutput(recipe, registry = null) {
  const result = recipe?.result || recipe?.out || recipe?.output;
  if (!result) return null;
  const parsed = parseIngredient(result, registry, { allowNegative: false });
  return parsed[0] || null;
}

export function recipeRequirements(recipe, registry = null) {
  const ingredients = [];
  if (Array.isArray(recipe?.ingredients)) ingredients.push(...recipe.ingredients);
  if (Array.isArray(recipe?.inShape)) ingredients.push(...recipe.inShape.flat(2));
  if (Array.isArray(recipe?.delta)) {
    for (const entry of recipe.delta) {
      if (Number(entry?.count ?? 0) >= 0) continue;
      const parsed = parseIngredient(entry, registry, { allowNegative: true });
      for (const item of parsed) if (item.count > 0) ingredients.push(item);
    }
  }

  const counts = {};
  for (const ingredient of ingredients) {
    const parsed = parseIngredient(ingredient, registry, { allowNegative: false });
    for (const item of parsed) counts[item.name] = (counts[item.name] || 0) + item.count;
  }
  return sortCounts(counts);
}

export function buildRecipeBook(recipes, registry = null) {
  const book = {};
  for (const recipe of recipes || []) {
    const out = recipeOutput(recipe, registry);
    if (!out?.name) continue;
    if (!book[out.name]) book[out.name] = [];
    book[out.name].push(recipe);
  }
  for (const name of Object.keys(book)) {
    book[name].sort((a, b) => recipeSortKey(a, registry).localeCompare(recipeSortKey(b, registry)));
  }
  return book;
}

export function expandCraftingPlan(target, opts = {}) {
  const inventory = normalizeCounts(opts.inventory);
  const recipeBook = opts.recipeBook || buildRecipeBook(opts.recipes || [], opts.registry);
  const registry = opts.registry || null;
  const maxDepth = opts.maxDepth ?? 8;
  const available = { ...inventory };
  const missing = {};
  const craftPlan = [];

  needItem(target.name, target.count ?? 1, 0, []);

  return {
    ok: Object.keys(missing).length === 0,
    target: { name: target.name, count: target.count ?? 1 },
    inventory,
    craftPlan,
    missing: sortCounts(missing),
    remaining: sortCounts(available),
  };

  function needItem(name, count, depth, stack) {
    const have = available[name] || 0;
    if (have >= count) {
      available[name] = have - count;
      return;
    }

    const deficit = count - have;
    available[name] = 0;
    const recipes = recipeBook[name] || [];
    if (depth >= maxDepth || recipes.length === 0 || stack.includes(name)) {
      missing[name] = (missing[name] || 0) + deficit;
      return;
    }

    const recipe = recipes[0];
    const output = recipeOutput(recipe, registry) || { name, count: 1 };
    const outputCount = output.count || 1;
    const times = Math.ceil(deficit / outputCount);
    const requires = multiplyCounts(recipeRequirements(recipe, registry), times);

    for (const [reqName, reqCount] of Object.entries(requires)) {
      needItem(reqName, reqCount, depth + 1, [...stack, name]);
    }
    const produced = outputCount * times;
    if (produced > deficit) available[name] = (available[name] || 0) + (produced - deficit);
    craftPlan.push({
      item: name,
      count: produced,
      times,
      requires,
      recipe: recipeSortKey(recipe, registry),
    });
  }
}

const TOOL_TIERS = Object.freeze({
  wooden: 1,
  gold: 1.5,
  golden: 1.5,
  stone: 2,
  iron: 3,
  diamond: 4,
  netherite: 5,
});

const TOOL_KINDS = Object.freeze(['pickaxe', 'axe', 'shovel', 'hoe', 'sword', 'shears']);

export const DEFAULT_FUEL_TICKS = Object.freeze({
  coal: 1600,
  charcoal: 1600,
  coal_block: 16000,
  blaze_rod: 2400,
  dried_kelp_block: 4000,
  lava_bucket: 20000,
  stick: 100,
  bamboo: 50,
  scaffolding: 50,
  bowl: 100,
});

const FUEL_SUFFIX_TICKS = Object.freeze([
  ['_planks', 300],
  ['_log', 300],
  ['_wood', 300],
  ['_stem', 300],
  ['_hyphae', 300],
  ['_sapling', 100],
  ['_boat', 1200],
  ['_chest_boat', 1200],
]);

export function toolRequirementsForBlock(blockName, registry = null) {
  const block = typeof blockName === 'string' ? registry?.blocksByName?.[blockName] : blockName;
  if (!block?.name) {
    return { ok: false, reason: `unknown block "${String(blockName)}"` };
  }
  const harvestTools = Object.keys(block.harvestTools || {})
    .map((id) => itemNameForId(registry, Number(id)))
    .filter(Boolean)
    .sort(toolNameCompare);
  const toolKind = inferToolKind(block, harvestTools);

  return {
    ok: true,
    block: block.name,
    material: block.material || null,
    hardness: block.hardness ?? null,
    toolKind,
    requiresTool: harvestTools.length > 0,
    harvestTools,
  };
}

export function planToolForBlock(blockName, available = {}, registry = null) {
  const requirements = toolRequirementsForBlock(blockName, registry);
  if (!requirements.ok) return { ok: false, reason: requirements.reason, requirements };
  const inventory = normalizeCounts(available);
  const usableTools = requirements.harvestTools.filter((name) => (inventory[name] || 0) > 0);
  const selectedTool = usableTools.slice().sort(toolNameCompare).at(-1) || null;
  const canHarvest = !requirements.requiresTool || usableTools.length > 0;

  return {
    ok: canHarvest,
    canHarvest,
    block: requirements.block,
    toolKind: requirements.toolKind,
    selectedTool,
    usableTools,
    missingTools: canHarvest ? [] : requirements.harvestTools,
    requirements,
    inventory,
  };
}

export function fuelTicksForItem(name, fuelTicks = DEFAULT_FUEL_TICKS) {
  if (!name) return 0;
  if (fuelTicks[name]) return fuelTicks[name];
  for (const [suffix, ticks] of FUEL_SUFFIX_TICKS) {
    if (name.endsWith(suffix)) return ticks;
  }
  return 0;
}

export function planSmeltingFuel({ itemCount, inventory = {}, fuelTicks = DEFAULT_FUEL_TICKS } = {}) {
  const count = Math.max(0, Math.ceil(Number(itemCount) || 0));
  const requiredTicks = count * 200;
  const inventoryCounts = normalizeCounts(inventory);
  const fuelOptions = Object.entries(inventoryCounts)
    .map(([name, available]) => ({ name, available, burnTicks: fuelTicksForItem(name, fuelTicks) }))
    .filter((fuel) => fuel.available > 0 && fuel.burnTicks > 0)
    .sort((a, b) => a.burnTicks - b.burnTicks || a.name.localeCompare(b.name));

  if (requiredTicks === 0) {
    return { ok: true, itemCount: count, requiredTicks, totalTicks: 0, excessTicks: 0, plan: [], missingTicks: 0 };
  }

  const maxBurn = Math.max(0, ...fuelOptions.map((fuel) => fuel.burnTicks));
  const capTicks = requiredTicks + maxBurn;
  let states = new Map([[0, { counts: {}, totalCount: 0 }]]);

  for (const fuel of fuelOptions) {
    const cappedCount = Math.min(fuel.available, Math.ceil(capTicks / fuel.burnTicks));
    for (let i = 0; i < cappedCount; i++) {
      const next = new Map(states);
      for (const [ticks, plan] of states.entries()) {
        const nextTicks = ticks + fuel.burnTicks;
        if (nextTicks > capTicks) continue;
        const candidate = {
          counts: { ...plan.counts, [fuel.name]: (plan.counts[fuel.name] || 0) + 1 },
          totalCount: plan.totalCount + 1,
        };
        const existing = next.get(nextTicks);
        if (!existing || compareFuelPlan(candidate, existing) < 0) next.set(nextTicks, candidate);
      }
      states = next;
    }
  }

  const viable = [...states.entries()]
    .filter(([ticks]) => ticks >= requiredTicks)
    .sort(([ticksA, planA], [ticksB, planB]) => (
      (ticksA - requiredTicks) - (ticksB - requiredTicks) ||
      planA.totalCount - planB.totalCount ||
      fuelPlanKey(planA).localeCompare(fuelPlanKey(planB))
    ))[0];

  if (!viable) {
    const totalTicks = fuelOptions.reduce((sum, fuel) => sum + fuel.available * fuel.burnTicks, 0);
    return {
      ok: false,
      itemCount: count,
      requiredTicks,
      totalTicks,
      excessTicks: 0,
      plan: fuelPlanRows(Object.fromEntries(fuelOptions.map((fuel) => [fuel.name, fuel.available])), fuelOptions),
      missingTicks: Math.max(0, requiredTicks - totalTicks),
    };
  }

  const [totalTicks, selected] = viable;
  return {
    ok: true,
    itemCount: count,
    requiredTicks,
    totalTicks,
    excessTicks: totalTicks - requiredTicks,
    plan: fuelPlanRows(selected.counts, fuelOptions),
    missingTicks: 0,
  };
}

export function planSmeltingJob({ input, output = null, count = 1, inventory = {}, fuelTicks = DEFAULT_FUEL_TICKS } = {}) {
  const itemCount = Math.max(0, Math.ceil(Number(count) || 0));
  const inventoryCounts = normalizeCounts(inventory);
  const inputRequirements = input ? { [input]: itemCount } : {};
  const missingInputs = missingItems(inputRequirements, inventoryCounts);
  const fuelPlan = planSmeltingFuel({ itemCount, inventory: inventoryCounts, fuelTicks });

  return {
    ok: Object.keys(missingInputs).length === 0 && fuelPlan.ok,
    input,
    output,
    count: itemCount,
    missingInputs,
    fuelPlan,
  };
}

export function planMiningToolProgression({
  oreTargets = [],
  inventory = {},
  registry = null,
  recipes = null,
  recipeBook = null,
  optionalCrafts = ['iron_sword'],
  fuelTicks = DEFAULT_FUEL_TICKS,
} = {}) {
  const inventoryCounts = normalizeCounts(inventory);
  const book = recipeBook || buildRecipeBook(recipes || recipeListFromRegistry(registry), registry);
  const normalizedTargets = [...new Set((oreTargets || []).map((name) => String(name || '').trim()).filter(Boolean))];
  const targetPlans = normalizedTargets.map((block) => planToolForBlock(block, inventoryCounts, registry));
  const harvestableTargets = targetPlans
    .filter((plan) => plan.ok)
    .map((plan) => ({
      block: plan.block,
      selectedTool: plan.selectedTool,
      toolKind: plan.toolKind,
    }));
  const blockedTargets = targetPlans
    .filter((plan) => !plan.ok)
    .map((plan) => ({
      block: plan.block || plan.requirements?.block || null,
      reason: plan.reason || (
        plan.missingTools?.length
          ? `requires one of ${plan.missingTools.join(', ')}`
          : 'requires an unavailable harvest tool'
      ),
      toolKind: plan.toolKind || plan.requirements?.toolKind || null,
      missingTools: [...(plan.missingTools || plan.requirements?.harvestTools || [])],
    }));

  const requiredTools = firstRequiredTools(blockedTargets);
  const toolPlans = [];
  const steps = [];
  let simulatedInventory = { ...inventoryCounts };

  for (const tool of requiredTools) {
    const planned = planToolCrafting(tool, {
      inventory: simulatedInventory,
      recipeBook: book,
      registry,
      fuelTicks,
      optional: false,
    });
    toolPlans.push(planned);
    steps.push(...planned.steps);
    simulatedInventory = planned.projectedInventory;
  }

  const optionalPlans = [];
  for (const item of optionalCrafts || []) {
    const planned = planToolCrafting(item, {
      inventory: simulatedInventory,
      recipeBook: book,
      registry,
      fuelTicks,
      optional: true,
    });
    if (planned.ok && planned.resourceReady) {
      optionalPlans.push(planned);
      steps.push(...planned.steps);
      simulatedInventory = planned.projectedInventory;
    } else {
      optionalPlans.push({
        item,
        ok: false,
        optional: true,
        reason: planned.reason,
        missing: planned.missing,
      });
    }
  }

  return {
    ok: true,
    inventory: inventoryCounts,
    targets: {
      requested: normalizedTargets,
      harvestable: harvestableTargets,
      blocked: blockedTargets,
    },
    requiredTools,
    requiredToolPlans: toolPlans,
    optionalToolPlans: optionalPlans,
    steps,
    projectedInventory: sortCounts(simulatedInventory),
    fieldKit: planMiningFieldKit({
      steps,
      inventory: inventoryCounts,
    }),
  };
}

export function planMiningFieldKit({ steps = [], inventory = {} } = {}) {
  const inventoryCounts = normalizeCounts(inventory);
  const craftSteps = (steps || []).filter((step) => step?.action === 'craft');
  const smeltSteps = (steps || []).filter((step) => step?.action === 'smelt');
  const needsCraftingTable = craftSteps.length > 0 || smeltSteps.length > 0;
  const needsFurnace = smeltSteps.length > 0;
  const stickDemand = craftSteps.reduce((sum, step) => sum + Number(step.requires?.stick || 0), 0);
  const missingSticks = Math.max(0, stickDemand - (inventoryCounts.stick || 0));
  const plankDemand = Math.ceil(missingSticks / 4) * 2 + (
    needsCraftingTable && !inventoryCounts.crafting_table ? 4 : 0
  );
  const availablePlanks = woodPlankCount(inventoryCounts) + woodLogCount(inventoryCounts) * 4;
  const missingPlanks = Math.max(0, plankDemand - availablePlanks);
  const missingWoodLogs = Math.ceil(missingPlanks / 4);
  const cobblestoneDemand = needsFurnace && !inventoryCounts.furnace ? 8 : 0;
  const missingCobblestone = Math.max(0, cobblestoneDemand - (inventoryCounts.cobblestone || 0));
  const missingPortableSupplies = {};
  if (missingWoodLogs > 0) missingPortableSupplies.wood_log = missingWoodLogs;
  if (missingCobblestone > 0) missingPortableSupplies.cobblestone = missingCobblestone;

  const recommendedCarry = {};
  if (plankDemand > 0) recommendedCarry.wood_log = Math.ceil(plankDemand / 4);
  if (cobblestoneDemand > 0) recommendedCarry.cobblestone = cobblestoneDemand;

  const blockers = [];
  if (needsCraftingTable) blockers.push('portable crafting_table requires a future place-workstation skill or a known nearby crafting table');
  if (needsFurnace) blockers.push('portable furnace requires a future place-workstation skill or a known/provided furnace');

  return {
    required: needsCraftingTable || needsFurnace,
    needsCraftingTable,
    needsFurnace,
    stickDemand,
    plankDemand,
    cobblestoneDemand,
    recommendedCarry: sortCounts(recommendedCarry),
    missingPortableSupplies: sortCounts(missingPortableSupplies),
    execution: {
      selfContainedInFieldReady: blockers.length === 0,
      blockers,
    },
    reasoning: miningFieldKitReasoning({
      needsCraftingTable,
      needsFurnace,
      stickDemand,
      plankDemand,
      cobblestoneDemand,
      missingPortableSupplies,
    }),
  };
}

function storageHit(storage, itemName, from, index) {
  const counts = normalizeCounts(storage?.items || storage?.contents || {});
  const count = counts[itemName] || 0;
  if (count <= 0) return null;
  const position = storage.position || null;
  const distance = position && from ? roundDistance(position, from) : 0;
  return {
    storage,
    storageId: String(storage.id || storage.key || `storage_${index + 1}`),
    position,
    count,
    distance,
  };
}

function miningFieldKitReasoning(plan) {
  const thoughts = [];
  if (plan.needsCraftingTable) {
    thoughts.push('mission has crafting steps, so it needs crafting-table access or portable crafting-table support');
  }
  if (plan.needsFurnace) {
    thoughts.push('mission has smelting steps, so it needs furnace access, fuel, and enough cobblestone for a portable furnace if no furnace is already available');
  }
  if (plan.stickDemand > 0) {
    thoughts.push(`tool crafting needs ${plan.stickDemand} stick, so reserve wood/planks instead of spending all wood as fuel`);
  }
  if (plan.plankDemand > 0) {
    thoughts.push(`carry or collect enough wood for ${plan.plankDemand} plank-equivalent crafting demand`);
  }
  if (plan.cobblestoneDemand > 0) {
    thoughts.push(`carry or collect ${plan.cobblestoneDemand} cobblestone for a portable furnace option`);
  }
  if (Object.keys(plan.missingPortableSupplies || {}).length > 0) {
    thoughts.push('portable field kit is not fully stocked from current inventory');
  }
  return thoughts;
}

function inferToolKind(block, harvestTools) {
  for (const name of harvestTools) {
    const kind = toolKindFromItemName(name);
    if (kind) return kind;
  }
  const tags = String(block.material || '').split(';');
  for (const tag of tags) {
    const match = tag.match(/mineable\/(.+)$/);
    if (match) return match[1];
  }
  return null;
}

function toolKindFromItemName(name) {
  for (const kind of TOOL_KINDS) {
    if (name === kind || name.endsWith(`_${kind}`)) return kind;
  }
  return null;
}

function toolTier(name) {
  const prefix = String(name || '').split('_')[0];
  return TOOL_TIERS[prefix] || 0;
}

function toolNameCompare(a, b) {
  return toolKindFromItemName(a)?.localeCompare(toolKindFromItemName(b) || '') ||
    toolTier(a) - toolTier(b) ||
    String(a).localeCompare(String(b));
}

function compareFuelPlan(a, b) {
  return a.totalCount - b.totalCount || fuelPlanKey(a).localeCompare(fuelPlanKey(b));
}

function fuelPlanKey(plan) {
  return Object.entries(plan.counts || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}:${count}`)
    .join('|');
}

function fuelPlanRows(counts, fuelOptions) {
  return Object.entries(counts || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([item, count]) => {
      const burnTicks = fuelOptions.find((fuel) => fuel.name === item)?.burnTicks || fuelTicksForItem(item);
      return { item, count, burnTicks, totalTicks: count * burnTicks };
    });
}

function parseIngredient(entry, registry, opts = {}) {
  if (!entry) return [];
  if (Array.isArray(entry)) return entry.flatMap((part) => parseIngredient(part, registry, opts));
  if (typeof entry === 'number') {
    const name = itemNameForId(registry, entry);
    return name ? [{ name, count: 1 }] : [];
  }

  const rawCount = Number(entry.count ?? 1);
  const count = opts.allowNegative && rawCount < 0 ? Math.abs(rawCount) : rawCount;
  if (!Number.isFinite(count) || count <= 0) return [];
  const name = entry.name || itemNameForId(registry, entry.id ?? entry.type);
  return name ? [{ name, count }] : [];
}

function itemNameForId(registry, id) {
  if (id === undefined || id === null) return null;
  return registry?.items?.[id]?.name || registry?.itemsByName?.[id]?.name || null;
}

function multiplyCounts(counts, times) {
  const out = {};
  for (const [name, count] of Object.entries(normalizeCounts(counts))) out[name] = count * times;
  return sortCounts(out);
}

function recipeSortKey(recipe, registry) {
  const output = recipeOutput(recipe, registry);
  return String(recipe?.id || recipe?.name || `${output?.name || 'unknown'}:${JSON.stringify(recipeRequirements(recipe, registry))}`);
}

function roundDistance(a, b) {
  const distance = Math.sqrt(
    (a.x - b.x) ** 2 +
    (a.y - b.y) ** 2 +
    (a.z - b.z) ** 2
  );
  return Math.round(distance * 10) / 10;
}

function firstRequiredTools(blockedTargets) {
  const seen = new Set();
  const out = [];
  for (const target of blockedTargets || []) {
    const tool = target?.missingTools?.[0];
    if (!tool || seen.has(tool)) continue;
    seen.add(tool);
    out.push(tool);
  }
  return out;
}

function planToolCrafting(item, opts) {
  const inventory = normalizeCounts(opts.inventory);
  const recipe = firstRecipeForItem(item, opts.recipeBook);
  if (!recipe) {
    return {
      item,
      ok: false,
      optional: opts.optional === true,
      reason: `no recipe for ${item}`,
      missing: { [item]: 1 },
      steps: [],
      projectedInventory: inventory,
    };
  }

  const requirements = recipeRequirements(recipe, opts.registry);
  const ironDemand = requirements.iron_ingot || 0;
  const stickDemand = requirements.stick || 0;
  const allowGathering = opts.optional !== true;
  const iron = planIronIngredientDemand(ironDemand, inventory, opts.fuelTicks, { allowGathering, reservedSticks: stickDemand });
  const wood = planStickSupport(stickDemand, inventory);
  const missing = mergeCounts(iron.missing, wood.missing, missingItems(nonIronNonStickRequirements(requirements), inventory));
  const resourceReady = Object.keys(missing).length === 0;
  const projected = { ...inventory };
  const steps = [];

  if (!allowGathering && !resourceReady) {
    return {
      item,
      ok: true,
      optional: true,
      resourceReady: false,
      reason: `skip optional ${item}; missing materials`,
      requires: requirements,
      missing,
      steps: [],
      projectedInventory: inventory,
    };
  }

  if (iron.collectRawIron > 0) {
    steps.push({
      action: 'mine',
      block: 'iron_ore',
      item: 'raw_iron',
      count: iron.collectRawIron,
      reason: `${item} requires ${ironDemand} iron_ingot`,
    });
    projected.raw_iron = (projected.raw_iron || 0) + iron.collectRawIron;
  }
  if (iron.collectFuelCoal > 0) {
    steps.push({
      action: 'mine',
      block: 'coal_ore',
      item: 'coal',
      count: iron.collectFuelCoal,
      reason: `fuel for smelting ${iron.smeltCount} raw_iron`,
    });
    projected.coal = (projected.coal || 0) + iron.collectFuelCoal;
  }
  if (wood.collectLogs > 0) {
    steps.push({
      action: 'carry_or_collect',
      item: 'wood_log',
      count: wood.collectLogs,
      reason: `${item} requires ${stickDemand} stick`,
    });
    projected.oak_log = (projected.oak_log || 0) + wood.collectLogs;
  }
  if (iron.smeltCount > 0) {
    const fuelPlan = planSmeltingFuel({
      itemCount: iron.smeltCount,
      inventory: reserveStickSupportForFuel(projected, stickDemand),
      fuelTicks: opts.fuelTicks,
    });
    const effectiveSmeltCount = Math.max(
      iron.smeltCount,
      Math.min(projected.raw_iron || 0, Math.floor((fuelPlan.totalTicks || 0) / 200))
    );
    steps.push({
      action: 'smelt',
      input: 'raw_iron',
      output: 'iron_ingot',
      count: effectiveSmeltCount,
      fuelPlan: fuelPlan.plan,
    });
    projected.raw_iron = Math.max(0, (projected.raw_iron || 0) - effectiveSmeltCount);
    projected.iron_ingot = (projected.iron_ingot || 0) + effectiveSmeltCount;
    for (const fuel of fuelPlan.plan || []) {
      projected[fuel.item] = Math.max(0, (projected[fuel.item] || 0) - fuel.count);
    }
  }

  steps.push({
    action: 'craft',
    item,
    count: 1,
    requires: requirements,
    optional: opts.optional === true,
  });
  consumeCraftRequirements(projected, requirements);
  projected[item] = (projected[item] || 0) + 1;

  return {
    item,
    ok: true,
    optional: opts.optional === true,
    resourceReady,
    reason: resourceReady ? `craft ${item}` : `craft ${item} after gathering missing materials`,
    requires: requirements,
    missing,
    steps,
    projectedInventory: sortCounts(projected),
  };
}

function planIronIngredientDemand(ingotCount, inventory, fuelTicks, opts = {}) {
  const allowGathering = opts.allowGathering !== false;
  const demand = Math.max(0, Math.ceil(Number(ingotCount) || 0));
  const haveIngots = inventory.iron_ingot || 0;
  const ingotsToCreate = Math.max(0, demand - haveIngots);
  const haveRaw = inventory.raw_iron || 0;
  const missingRawIron = Math.max(0, ingotsToCreate - haveRaw);
  const collectRawIron = allowGathering ? missingRawIron : 0;
  const smeltCount = ingotsToCreate;
  const fuelInventory = reserveStickSupportForFuel(inventory, opts.reservedSticks);
  if (collectRawIron > 0) fuelInventory.raw_iron = (fuelInventory.raw_iron || 0) + collectRawIron;
  const fuel = planSmeltingFuel({ itemCount: smeltCount, inventory: fuelInventory, fuelTicks });
  const missingFuelTicks = fuel.ok ? 0 : (fuel.missingTicks || 0);
  const collectFuelCoal = allowGathering ? Math.ceil(missingFuelTicks / fuelTicksForItem('coal', fuelTicks)) : 0;
  const missing = {
    ...(allowGathering ? {} : { raw_iron: missingRawIron }),
    ...(allowGathering ? {} : { fuel_ticks: missingFuelTicks }),
  };
  return {
    smeltCount,
    collectRawIron,
    collectFuelCoal,
    missing: sortCounts(missing),
  };
}

function reserveStickSupportForFuel(inventory, stickCount) {
  const fuelInventory = normalizeCounts(inventory);
  consumeStickSupport(fuelInventory, stickCount);
  delete fuelInventory.stick;
  for (const name of Object.keys(fuelInventory)) {
    if (isWoodLog(name) || isWoodPlanks(name)) delete fuelInventory[name];
  }
  return fuelInventory;
}

function planStickSupport(stickCount, inventory) {
  const demand = Math.max(0, Math.ceil(Number(stickCount) || 0));
  const plankStickCapacity = Math.floor(woodPlankCount(inventory) / 2) * 4;
  const available = (inventory.stick || 0) + plankStickCapacity + woodLogCount(inventory) * 8;
  const missingSticks = Math.max(0, demand - available);
  const collectLogs = missingSticks > 0 ? Math.ceil(missingSticks / 8) : 0;
  return {
    collectLogs,
    missing: collectLogs > 0 ? { wood_log: collectLogs } : {},
  };
}

function woodLogCount(inventory) {
  return Object.entries(inventory || {})
    .filter(([name]) => isWoodLog(name))
    .reduce((sum, [, count]) => sum + count, 0);
}

function woodPlankCount(inventory) {
  return Object.entries(inventory || {})
    .filter(([name]) => isWoodPlanks(name))
    .reduce((sum, [, count]) => sum + count, 0);
}

function isWoodLog(name) {
  return /_(log|wood|stem|hyphae)$/.test(String(name || ''));
}

function isWoodPlanks(name) {
  return String(name || '').endsWith('_planks');
}

function nonIronNonStickRequirements(requirements) {
  return Object.fromEntries(
    Object.entries(requirements || {}).filter(([name]) => name !== 'iron_ingot' && name !== 'stick')
  );
}

function consumeCraftRequirements(inventory, requirements) {
  for (const [name, count] of Object.entries(requirements || {})) {
    if (name === 'stick') {
      consumeStickSupport(inventory, count);
      continue;
    }
    inventory[name] = Math.max(0, (inventory[name] || 0) - count);
  }
}

function consumeStickSupport(inventory, count) {
  let remaining = Math.max(0, Math.ceil(Number(count) || 0));
  const direct = Math.min(remaining, inventory.stick || 0);
  inventory.stick = Math.max(0, (inventory.stick || 0) - direct);
  remaining -= direct;
  if (remaining <= 0) return;

  for (const name of Object.keys(inventory).filter(isWoodPlanks).sort()) {
    if (remaining <= 0) break;
    const planksNeeded = Math.ceil(remaining / 4) * 2;
    const planks = Math.min(planksNeeded, Math.floor((inventory[name] || 0) / 2) * 2);
    if (planks <= 0) continue;
    inventory[name] = Math.max(0, (inventory[name] || 0) - planks);
    const sticksFromPlanks = Math.floor(planks / 2) * 4;
    const used = Math.min(remaining, sticksFromPlanks);
    remaining = Math.max(0, remaining - used);
    const surplus = sticksFromPlanks - used;
    if (surplus > 0) inventory.stick = (inventory.stick || 0) + surplus;
  }
  if (remaining <= 0) return;

  for (const name of Object.keys(inventory).filter(isWoodLog).sort()) {
    if (remaining <= 0) break;
    const logsNeeded = Math.ceil(remaining / 8);
    const logs = Math.min(logsNeeded, inventory[name] || 0);
    inventory[name] = Math.max(0, (inventory[name] || 0) - logs);
    const sticksFromLogs = logs * 8;
    const used = Math.min(remaining, sticksFromLogs);
    remaining = Math.max(0, remaining - used);
    const surplus = sticksFromLogs - used;
    if (surplus > 0) inventory.stick = (inventory.stick || 0) + surplus;
  }
}

function firstRecipeForItem(item, recipeBook) {
  return (recipeBook?.[item] || [])[0] || null;
}

function recipeListFromRegistry(registry) {
  const recipes = registry?.recipes;
  if (!recipes) return [];
  if (Array.isArray(recipes)) return recipes;
  return Object.values(recipes).flatMap((entry) => Array.isArray(entry) ? entry : [entry]).filter(Boolean);
}

function sortCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts || {})
      .filter(([, count]) => count > 0)
      .sort((a, b) => a[0].localeCompare(b[0]))
  );
}

function errorMessage(err) {
  return err?.message || String(err);
}
