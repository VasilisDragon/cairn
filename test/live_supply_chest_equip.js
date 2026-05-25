import log from '../src/logger.js';
import {
  chooseAvailableItem,
  closeLoggedChest,
  envPositiveInteger,
  equipmentSummary,
  inventoryCounts,
  openAuthorizedSupplyChest,
  runLiveScenario,
  waitForLiveChunks,
  withdrawLogged,
  equipLogged,
} from './live_helpers.js';

const ID = 'live_supply_chest_equip';
const FOOD_COUNT = envPositiveInteger('MCBOT_SUPPLY_FOOD_COUNT', 4);
const SAFE_FOOD_CANDIDATES = [
  process.env.MCBOT_SUPPLY_FOOD_ITEM,
  'cooked_beef',
  'bread',
  'cooked_porkchop',
  'cooked_chicken',
  'baked_potato',
  'apple',
].filter(Boolean);
const TOOL_CANDIDATES = [
  process.env.MCBOT_SUPPLY_TOOL_ITEM,
  'netherite_pickaxe',
  'netherite_axe',
  'netherite_shovel',
  'diamond_pickaxe',
  'diamond_axe',
].filter(Boolean);

runLiveScenario(ID, async ({ bot, controller, finish }) => {
  const ctx = {
    signal: controller.signal,
    callState: {},
    remainingQueue: [],
    currentSubtask: `${ID}.equip`,
  };

  await waitForLiveChunks(bot, ID);
  const beforeInventory = inventoryCounts(bot);
  const beforeEquipment = equipmentSummary(bot);
  log.test.info(`${ID}.before`, { inventory: beforeInventory, equipment: beforeEquipment });

  let container = null;
  let closed = false;
  try {
    ({ container } = await openAuthorizedSupplyChest(bot, ctx, ID));
    const food = chooseAvailableItem(container, SAFE_FOOD_CANDIDATES, { minCount: 1 });
    const chestTool = chooseAvailableItem(container, TOOL_CANDIDATES, { minCount: 1 });
    const inventoryTool = chooseInventoryItem(bot, TOOL_CANDIDATES);
    if (!food) {
      throw new Error(`no safe food candidate found in fixture chest; looked for ${SAFE_FOOD_CANDIDATES.join(', ')}`);
    }
    if (!chestTool && !inventoryTool) {
      throw new Error(`no deterministic tool candidate found in fixture chest or bot inventory; looked for ${TOOL_CANDIDATES.join(', ')}`);
    }
    const tool = chestTool
      ? { name: chestTool.name, count: 1, source: 'chest' }
      : { name: inventoryTool.name, count: 0, source: 'inventory' };

    const foodCount = Math.min(FOOD_COUNT, food.available);
    log.test.info(`${ID}.controlled-subset`, {
      food: { name: food.name, count: foodCount },
      tool,
      forbidden: ['enchanted_golden_apple', 'potion', 'splash_potion', 'lingering_potion'],
    });
    await withdrawLogged(bot, container, food.name, foodCount, ID);
    if (tool.source === 'chest') {
      await withdrawLogged(bot, container, tool.name, 1, ID);
    } else {
      log.test.info(`${ID}.withdraw.skipped`, {
        item: tool.name,
        reason: 'tool already available in bot inventory',
        inventory: inventoryCounts(bot),
      });
    }
    await closeLoggedChest(container, ID);
    closed = true;
    await equipLogged(bot, tool.name, 'hand', ID);
  } finally {
    if (container && !closed) await closeLoggedChest(container, ID);
  }

  finish(0, `${ID}.done`, {
    beforeInventory,
    afterInventory: inventoryCounts(bot),
    beforeEquipment,
    afterEquipment: equipmentSummary(bot),
  });
});

function chooseInventoryItem(bot, candidates) {
  const counts = inventoryCounts(bot);
  for (const name of candidates.filter(Boolean)) {
    if ((counts[name] || 0) > 0) return { name, available: counts[name] };
  }
  return null;
}
