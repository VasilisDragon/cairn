// Simulated early-game Minecraft world for proving the mission closed loop WITHOUT the MC client.
//
// `applyAction(state, action)` models the inventory effect of each low-level action the real Fabric
// client executes (action ids verified against BrainLink.java / the Craft*RecipePlanner allow-list).
// Effects are coarse but consistent with the mission-planner thresholds, so the planner's objective
// postconditions trigger correctly. `runMissionInSim` loops an orchestrator against this world.
//
// Used by mission-orchestrator.test.mjs (mock brain, $0) and mission-sim.smoke.mjs (real DeepSeek).
// Batches are deliberately generous so the canonical chain converges without resource-starvation
// thrash; recovery is exercised explicitly via the `mutate` hook (inject a shortfall mid-mission).

const ARMOR_PIECES = {
  craft_iron_helmet: { cost: 5, slot: 'equippedHelmetItem', item: 'iron_helmet' },
  craft_iron_chestplate: { cost: 8, slot: 'equippedChestplateItem', item: 'iron_chestplate' },
  craft_iron_leggings: { cost: 7, slot: 'equippedLeggingsItem', item: 'iron_leggings' },
  craft_iron_boots: { cost: 4, slot: 'equippedBootsItem', item: 'iron_boots' },
};

export function createInitialState(overrides = {}) {
  return {
    logs: 0, planks: 0, sticks: 0, craftingTables: 0, woodenPickaxes: 0,
    cobblestone: 0, stonePickaxes: 0, stoneSwords: 0, furnaces: 0, fuel: 0,
    rawIron: 0, ironIngots: 0, ironPickaxes: 0, equippedArmorPieces: 0,
    foodLevel: 20, hasFood: true, atIronDepth: false,
    // sim-internal placement / depth progress (not planner-visible inventory)
    tablePlaced: false, furnacePlaced: false, depthSteps: 0,
    ...overrides,
  };
}

// Returns { state, progressed, note }. progressed=false => the action had no effect (precondition
// unmet); the orchestrator uses an unchanged world as its stall signal.
export function applyAction(state, action) {
  const s = { ...state };
  const before = JSON.stringify(s);
  let note = '';
  switch (action) {
    case 'gather_log':
    case 'gather_tree':
      s.logs += 2; break;
    case 'craft_planks':
      if (s.logs >= 1) { s.logs -= 1; s.planks += 16; } else note = 'no_logs'; break;
    case 'craft_sticks':
      if (s.planks >= 2) { s.planks -= 2; s.sticks += 12; } else note = 'no_planks'; break;
    case 'craft_table':
      if (s.planks >= 4) { s.planks -= 4; s.craftingTables += 1; } else note = 'no_planks'; break;
    case 'place_table':
      if (s.tablePlaced) { note = 'already_placed'; } else if (s.craftingTables >= 1) { s.craftingTables -= 1; s.tablePlaced = true; } else { note = 'no_table'; } break;
    case 'craft_pickaxe': // wooden
      if (s.planks >= 3 && s.sticks >= 2 && s.tablePlaced) { s.planks -= 3; s.sticks -= 2; s.woodenPickaxes += 1; } else note = 'missing_inputs'; break;
    case 'mine_stone':
    case 'mine_nearby_stone':
    case 'r2_mine_stone_return':
      if (s.woodenPickaxes >= 1 || s.stonePickaxes >= 1 || s.ironPickaxes >= 1) { s.cobblestone += 4; } else note = 'no_pickaxe'; break;
    case 'craft_stone_pickaxe':
      if (s.cobblestone >= 3 && s.sticks >= 2 && s.tablePlaced) { s.cobblestone -= 3; s.sticks -= 2; s.stonePickaxes += 1; } else note = 'missing_inputs'; break;
    case 'craft_stone_sword':
      if (s.cobblestone >= 1 && s.sticks >= 1 && s.tablePlaced) { s.cobblestone -= 1; s.sticks -= 1; s.stoneSwords += 1; } else note = 'missing_inputs'; break;
    case 'craft_furnace':
      if (s.cobblestone >= 8 && s.tablePlaced) { s.cobblestone -= 8; s.furnaces += 1; } else note = 'missing_inputs'; break;
    case 'place_furnace':
      if (s.furnacePlaced) { note = 'already_placed'; } else if (s.furnaces >= 1) { s.furnaces -= 1; s.furnacePlaced = true; } else { note = 'no_furnace'; } break;
    case 'descend_staircase':
      if (s.stonePickaxes >= 1 || s.ironPickaxes >= 1) { s.depthSteps += 1; if (s.depthSteps >= 2) s.atIronDepth = true; } else note = 'no_pickaxe'; break;
    case 'mine_nearby_iron':
    case 'r5_iron_chain':
      if ((s.stonePickaxes >= 1 || s.ironPickaxes >= 1) && s.atIronDepth) { s.rawIron += 8; s.fuel += 8; } else note = 'not_ready'; break;
    case 'smelt_raw_iron':
    case 'smelt_charcoal': {
      if (s.furnacePlaced && s.fuel >= 1 && s.rawIron >= 1) {
        const batch = Math.min(8, s.rawIron, s.fuel);
        s.rawIron -= batch; s.fuel -= batch; s.ironIngots += batch;
      } else note = 'cannot_smelt';
      break;
    }
    case 'craft_iron_pickaxe':
      if (s.ironIngots >= 3 && s.sticks >= 2 && s.tablePlaced) { s.ironIngots -= 3; s.sticks -= 2; s.ironPickaxes += 1; } else note = 'missing_inputs'; break;
    case 'craft_iron_helmet':
    case 'craft_iron_chestplate':
    case 'craft_iron_leggings':
    case 'craft_iron_boots': {
      const piece = ARMOR_PIECES[action];
      if (s.ironIngots >= piece.cost && s[piece.slot] !== piece.item) {
        s.ironIngots -= piece.cost;
        s[piece.slot] = piece.item; // sets equipped<Slot>Item, matching the live ClientSnapshot field
        s.equippedArmorPieces += 1;
      } else {
        note = 'missing_inputs';
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
  let llmCalls = 0;
  let mutated = false;

  for (let i = 0; i < maxSteps; i += 1) {
    const out = await orchestrator.step(state);
    for (const sig of out.signals) signals.push(sig);
    if (out.replanned) llmCalls += 1;
    if (out.objective) objectiveTrace.push(out.objective);
    if (out.done) {
      return { done: true, steps: i + 1, state, signals, objectiveTrace, llmCalls, mutated };
    }
    if (mutate && !mutated) {
      const m = mutate(state, i);
      if (m) { state = m; mutated = true; }
    }
    state = applyAction(state, out.intent.action).state;
  }
  return { done: false, steps: maxSteps, state, signals, objectiveTrace, llmCalls, mutated };
}
