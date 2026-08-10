// Simulated early-game Minecraft world for proving the mission closed loop WITHOUT the MC client.
//
// `applyAction(state, action)` models the inventory effect of each low-level action the real Fabric
// client executes (action ids verified against BrainLink.java / the Craft*RecipePlanner allow-list).
// Effects are coarse but consistent with the mission-planner thresholds, so the planner's objective
// postconditions trigger correctly. `runMissionInSim` loops an orchestrator against this world.
//
// Used by mission-orchestrator.test.mjs (mock brain, $0) and mission-sim.smoke.mjs (real DeepSeek).
// Recipe outputs match the live Fabric planners so the long-mission proof does not hide scale
// pressure in wood, stick, table, and furnace loops. Recovery is exercised explicitly via the
// `mutate` hook (inject a shortfall mid-mission).

const ARMOR_PIECES = {
  craft_iron_helmet: { cost: 5, slot: 'equippedHelmetItem', count: 'ironHelmets', item: 'iron_helmet' },
  craft_iron_chestplate: { cost: 8, slot: 'equippedChestplateItem', count: 'ironChestplates', item: 'iron_chestplate' },
  craft_iron_leggings: { cost: 7, slot: 'equippedLeggingsItem', count: 'ironLeggings', item: 'iron_leggings' },
  craft_iron_boots: { cost: 4, slot: 'equippedBootsItem', count: 'ironBoots', item: 'iron_boots' },
};

const ARMOR_EQUIP_ORDER = Object.values(ARMOR_PIECES);
const LIVE_PLANKS_PER_LOG = 4;
const LIVE_STICKS_PER_CRAFT = 4;
const LIVE_MINE_NEARBY_IRON_RAW_DELTA = 3;
const LIVE_SMELT_RAW_IRON_BATCH_MAX = 3;

function desiredWoodFuelItemCount(inputCount) {
  const count = Math.max(1, inputCount);
  return Math.max(1, Math.floor((count * 2 + 2) / 3));
}

function availableSmeltCapacity(s) {
  const efficientFuelItems = Math.max(0, s.fuel || 0);
  const woodFuelItems = Math.max(0, (s.logs || 0) + (s.planks || 0));
  return (efficientFuelItems * 8) + Math.floor((woodFuelItems * 3) / 2);
}

function consumeSmeltFuel(s, inputCount) {
  if ((s.fuel || 0) > 0) {
    const needed = Math.max(1, Math.ceil(Math.max(1, inputCount) / 8));
    s.fuel -= Math.min(s.fuel, needed);
    return;
  }
  let neededWood = desiredWoodFuelItemCount(inputCount);
  const logsToUse = Math.min(s.logs || 0, neededWood);
  s.logs -= logsToUse;
  neededWood -= logsToUse;
  const planksToUse = Math.min(s.planks || 0, neededWood);
  s.planks -= planksToUse;
}

export function createInitialState(overrides = {}) {
  return {
    logs: 0, planks: 0, sticks: 0, craftingTables: 0, woodenPickaxes: 0,
    cobblestone: 0, stonePickaxes: 0, stoneSwords: 0, furnaces: 0, fuel: 0,
    rawIron: 0, ironIngots: 0, ironPickaxes: 0, diamonds: 0, diamondPickaxes: 0, equippedArmorPieces: 0,
    ironHelmets: 0, ironChestplates: 0, ironLeggings: 0, ironBoots: 0,
    foodLevel: 20, hasFood: true, atIronDepth: false, atDiamondDepth: false, targetDiamondTier: false,
    inventoryFull: false,
    // sim-internal placement / depth progress (not planner-visible inventory)
    tablePlaced: false, furnacePlaced: false, depthSteps: 0,
    // Coarse position so the orchestrator's surface anchor works in sims (y drops on descend,
    // restores on return_staircase; x/z static).
    x: 0, y: 70, z: 0, onGround: true, touchingWater: false,
    ...overrides,
  };
}

// Returns { state, progressed, note }. progressed=false => the action had no effect (precondition
// unmet); the orchestrator uses an unchanged world as its stall signal.
export function applyAction(state, action) {
  const s = { ...state };
  delete s.currentCommandCompleted;
  delete s.currentCommandCompletionReason;
  delete s.currentCommandId;
  const before = JSON.stringify(s);
  let note = '';
  switch (action) {
    case 'gather_log':
    case 'gather_tree':
      if (!s.inventoryFull) { s.logs += 2; } else note = 'inventory_full'; break;
    case 'craft_planks':
      if (s.logs >= 1) { s.logs -= 1; s.planks += LIVE_PLANKS_PER_LOG; } else note = 'no_logs'; break;
    case 'craft_sticks':
      if (s.planks >= 2) { s.planks -= 2; s.sticks += LIVE_STICKS_PER_CRAFT; } else note = 'no_planks'; break;
    case 'craft_table':
      if (s.planks >= 4) { s.planks -= 4; s.craftingTables += 1; } else note = 'no_planks'; break;
    case 'place_table':
      if (s.tablePlaced) { note = 'already_placed'; } else if (s.craftingTables >= 1) { s.craftingTables -= 1; s.tablePlaced = true; } else { note = 'no_table'; } break;
    case 'retrieve_table':
      if (s.tablePlaced) { s.tablePlaced = false; s.craftingTables += 1; } else { note = 'no_placed_table'; } break;
    case 'craft_pickaxe': // wooden
      if (s.planks >= 3 && s.sticks >= 2 && s.tablePlaced) { s.planks -= 3; s.sticks -= 2; s.woodenPickaxes += 1; } else note = 'missing_inputs'; break;
    case 'mine_stone':
    case 'mine_nearby_stone':
    case 'r2_mine_stone_return':
      if (s.inventoryFull) { note = 'inventory_full'; }
      else if (s.woodenPickaxes >= 1 || s.stonePickaxes >= 1 || s.ironPickaxes >= 1) { s.cobblestone += 4; }
      else note = 'no_pickaxe';
      break;
    case 'craft_stone_pickaxe':
      if (s.cobblestone >= 3 && s.sticks >= 2 && s.tablePlaced) { s.cobblestone -= 3; s.sticks -= 2; s.stonePickaxes += 1; } else note = 'missing_inputs'; break;
    case 'craft_stone_sword':
      if (s.cobblestone >= 2 && s.sticks >= 1 && s.tablePlaced) { s.cobblestone -= 2; s.sticks -= 1; s.stoneSwords += 1; } else note = 'missing_inputs'; break;
    case 'craft_furnace':
      if (s.cobblestone >= 8 && s.tablePlaced) { s.cobblestone -= 8; s.furnaces += 1; } else note = 'missing_inputs'; break;
    case 'place_furnace':
      if (s.furnacePlaced) { note = 'already_placed'; } else if (s.furnaces >= 1) { s.furnaces -= 1; s.furnacePlaced = true; } else { note = 'no_furnace'; } break;
    case 'descend_staircase':
      if (s.stonePickaxes >= 1 || s.ironPickaxes >= 1) {
        s.depthSteps += 1;
        if (s.depthSteps >= 2) s.atIronDepth = true;
        if (s.targetDiamondTier && s.ironPickaxes >= 1 && s.depthSteps >= 8) s.atDiamondDepth = true;
        s.y = Math.max(10, (Number.isFinite(s.y) ? s.y : 70) - 30);
      } else note = 'no_pickaxe'; break;
    case 'return_staircase':
      // Depth-aware GATHER_WOOD support: climb back to the surface.
      if (s.atIronDepth || s.atDiamondDepth || s.depthSteps > 0) {
        s.atIronDepth = false;
        s.atDiamondDepth = false;
        s.depthSteps = 0;
        s.y = 70;
        s.currentCommandCompleted = true;
        s.currentCommandCompletionReason = 'return_staircase_complete:surface_reached';
      } else note = 'not_at_depth';
      break;
    case 'mine_nearby_iron':
    case 'r5_iron_chain':
      if (s.inventoryFull) { note = 'inventory_full'; }
      else if ((s.stonePickaxes >= 1 || s.ironPickaxes >= 1) && s.atIronDepth) {
        s.rawIron += LIVE_MINE_NEARBY_IRON_RAW_DELTA;
      }
      else note = 'not_ready';
      break;
    case 'mine_nearby_diamond':
      if (s.inventoryFull) { note = 'inventory_full'; }
      else if (s.ironPickaxes >= 1 && s.atDiamondDepth) { s.diamonds += 3; }
      else note = 'not_ready';
      break;
    case 'mine_nearby_coal':
      // Fuel v2: first-class coal goal (delta 8, mirrors the client NEARBY_COAL_TARGET_COAL).
      if (s.inventoryFull) { note = 'inventory_full'; }
      else if ((s.stonePickaxes >= 1 || s.ironPickaxes >= 1) && s.atIronDepth) { s.fuel += 8; }
      else note = 'not_ready';
      break;
    case 'smelt_raw_iron':
    case 'smelt_charcoal': {
      const fuelCapacity = availableSmeltCapacity(s);
      if (s.furnacePlaced && fuelCapacity >= 1 && s.rawIron >= 1) {
        const batch = Math.min(LIVE_SMELT_RAW_IRON_BATCH_MAX, s.rawIron, fuelCapacity);
        consumeSmeltFuel(s, batch);
        s.rawIron -= batch; s.ironIngots += batch;
      } else note = 'cannot_smelt';
      break;
    }
    case 'craft_iron_pickaxe':
      if (s.ironIngots >= 3 && s.sticks >= 2 && s.tablePlaced) { s.ironIngots -= 3; s.sticks -= 2; s.ironPickaxes += 1; } else note = 'missing_inputs'; break;
    case 'craft_diamond_pickaxe':
      if (s.diamonds >= 3 && s.sticks >= 2 && s.tablePlaced) { s.diamonds -= 3; s.sticks -= 2; s.diamondPickaxes += 1; } else note = 'missing_inputs'; break;
    case 'craft_iron_helmet':
    case 'craft_iron_chestplate':
    case 'craft_iron_leggings':
    case 'craft_iron_boots': {
      const piece = ARMOR_PIECES[action];
      if (s.ironIngots >= piece.cost && s[piece.slot] !== piece.item) {
        s.ironIngots -= piece.cost;
        s[piece.count] = (s[piece.count] || 0) + 1;
      } else {
        note = 'missing_inputs';
      }
      break;
    }
    case 'equip_armor': {
      const piece = ARMOR_EQUIP_ORDER.find((candidate) => s[candidate.slot] !== candidate.item && (s[candidate.count] || 0) > 0);
      if (piece) {
        s[piece.count] -= 1;
        s[piece.slot] = piece.item; // sets equipped<Slot>Item, matching the live ClientSnapshot field
        s.equippedArmorPieces += 1;
      } else {
        note = 'no_spare_armor';
      }
      break;
    }
    case 'eat':
      s.foodLevel = 20; break;
    case 'stop':
    case 'idle':
    case '':
      note = 'idle'; break;
    default:
      note = `unknown_action:${action}`; break;
  }
  return { state: s, progressed: JSON.stringify(s) !== before, note };
}

// Drive an orchestrator against the simulated world until the mission completes or maxSteps.
// opts.mutate(state, stepIndex) -> state|undefined lets a test inject a mid-mission shortfall.
export async function runMissionInSim(orchestrator, initialOverrides = {}, opts = {}) {
  const maxSteps = opts.maxSteps ?? 200;
  const mutate = opts.mutate;
  let state = createInitialState(initialOverrides);
  const signals = [];
  const objectiveTrace = [];
  const actionTrace = [];
  let llmCalls = 0;
  let mutated = false;

  for (let i = 0; i < maxSteps; i += 1) {
    const out = await orchestrator.step(state);
    for (const sig of out.signals) signals.push(sig);
    if (out.source === 'llm') llmCalls += 1;
    if (out.objective) objectiveTrace.push(out.objective);
    if (out.done) {
      return { done: true, steps: i + 1, state, signals, objectiveTrace, actionTrace, llmCalls, mutated };
    }
    actionTrace.push(out.intent.action);
    if (mutate && !mutated) {
      const m = mutate(state, i);
      if (m) { state = m; mutated = true; }
    }
    const apply = typeof opts.applyAction === 'function' ? opts.applyAction : applyAction;
    state = apply(state, out.intent.action, { stepIndex: i, out }).state;
  }
  return { done: false, steps: maxSteps, state, signals, objectiveTrace, actionTrace, llmCalls, mutated };
}
