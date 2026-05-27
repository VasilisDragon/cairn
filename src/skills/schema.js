// Frozen skill vocabulary. This file is the single source of truth for:
//   - what skills exist
//   - their parameter shapes
//   - validation
//   - the advisor system prompt (rendered from this schema)
//
// Changing a skill = update this file + update the advisor system prompt
// (which is derived from skillSchemaForPrompt() below). Nothing else.

export const SKILLS = {
  observe: {
    description: 'Refresh and return the world-state snapshot. No params.',
    advisorCallable: true,
    params: {},
  },

  goto: {
    description:
      'Pathfind to a target. Provide exactly one of {x,y,z} OR {block, maxDistance} OR {entity}.',
    advisorCallable: true,
    params: {
      x: { type: 'number', optional: true },
      y: { type: 'number', optional: true },
      z: { type: 'number', optional: true },
      block: { type: 'string', optional: true, description: 'A block name like "oak_log".' },
      entity: { type: 'string', optional: true, description: 'An entity name like "villager".' },
      maxDistance: { type: 'number', optional: true, default: 64, min: 1 },
      range: { type: 'number', optional: true, default: 1, min: 0, description: 'How close to get (blocks).' },
    },
    oneOf: [['x', 'y', 'z'], ['block'], ['entity']],
  },

  collect: {
    description:
      'Mine N of a block or item type (oak_log, cobblestone, raw_iron, diamond, ...). Handles pathing, tool selection, and pickup. The collect skill can gather items that are not themselves naturally generated blocks: cobblestone is mined from stone, raw_iron from iron_ore, raw_copper from copper_ore, diamond from diamond_ore, redstone from redstone_ore, and coal from coal_ore. Specify the item you want and the skill will find an appropriate source block to mine. Item-chain prerequisites: wood-tier blocks such as oak_log can be collected with bare hands; stone-tier blocks/items such as cobblestone, stone, granite, andesite, diorite, and coal require a wooden_pickaxe or better; iron-tier blocks/items such as iron_ore and raw_iron require a stone_pickaxe or better; diamond-tier blocks/items such as diamond_ore, redstone_ore, gold_ore, diamond, and redstone require an iron_pickaxe or better. Plan craft-and-equip steps before collect/mine steps for higher tiers.',
    advisorCallable: true,
    params: {
      block: { type: 'string', required: true, description: 'Block name to collect.' },
      count: { type: 'number', required: true, integer: true, min: 1, description: 'How many to collect.' },
      maxDistance: { type: 'number', optional: true, default: 64, min: 1, description: 'Search radius for blocks.' },
    },
  },

  deposit: {
    description:
      'Deposit items into the nearest chest. Items names must match Minecraft IDs.',
    advisorCallable: true,
    params: {
      items: {
        type: 'array',
        required: true,
        minItems: 1,
        items: {
          type: 'object',
          fields: {
            name: { type: 'string', required: true },
            count: { type: 'number', optional: true, integer: true, min: 1 },
          },
          noUnknown: true,
        },
        description: 'Array of {name, count?} — count omitted means "all of that item".',
      },
      maxDistance: { type: 'number', optional: true, default: 32, min: 1, description: 'Search radius for chests.' },
    },
  },

  craft: {
    description:
      'Craft an item by recipe name and recipe-execution count. Uses a crafting table if needed. For craft, count means recipe executions, not desired output items: each oak_planks recipe takes 1 oak_log and yields 4 planks, so to get 12 planks request count: 3.',
    advisorCallable: true,
    params: {
      item: { type: 'string', required: true },
      count: { type: 'number', optional: true, default: 1, integer: true, min: 1 },
    },
  },

  equip: {
    description: 'Equip an item into a slot.',
    advisorCallable: true,
    params: {
      item: { type: 'string', required: true, description: 'Item name to equip.' },
      destination: {
        type: 'string',
        optional: true,
        default: 'hand',
        enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'],
      },
    },
  },

  consume: {
    description:
      'Equip and consume one supported item. Potions and enchanted golden apples require explicit opt-in flags.',
    advisorCallable: true,
    params: {
      item: { type: 'string', required: true, description: 'Consumable item name such as cooked_beef, golden_apple, enchanted_golden_apple, or potion.' },
      effect: {
        type: 'string',
        optional: true,
        enum: ['fire_resistance', 'instant_health', 'regeneration', 'speed', 'strength'],
        description: 'Optional drinkable potion effect filter.',
      },
      minLevel: { type: 'number', optional: true, integer: true, min: 1, description: 'Optional minimum potion effect level.' },
      allowPotions: { type: 'boolean', optional: true, default: false },
      allowEnchantedGoldenApples: { type: 'boolean', optional: true, default: false },
    },
  },

  fish_until: {
    description:
      'Use an equipped or inventory fishing rod at the current position until a catch count or duration target is met. Deposit separately.',
    advisorCallable: true,
    params: {
      catches: { type: 'number', optional: true, integer: true, min: 1, description: 'Number of successful catch inventory deltas to wait for.' },
      durationMs: { type: 'number', optional: true, integer: true, min: 1, description: 'Maximum fishing duration when catch count is not used.' },
      maxAttempts: { type: 'number', optional: true, integer: true, min: 1 },
      attemptTimeoutMs: { type: 'number', optional: true, integer: true, min: 1 },
      bobberSpawnTimeoutMs: { type: 'number', optional: true, integer: true, min: 1 },
      pickupTimeoutMs: { type: 'number', optional: true, integer: true, min: 1 },
      waterSafetyPollMs: { type: 'number', optional: true, integer: true, min: 1 },
    },
    oneOf: [['catches'], ['durationMs']],
  },

  fish_and_deposit: {
    description:
      'At the current fishing stand, fish until a catch count or duration target is met, then deposit the caught item deltas into a specific chest.',
    advisorCallable: true,
    params: {
      catches: { type: 'number', optional: true, integer: true, min: 1, description: 'Number of successful catch inventory deltas to wait for.' },
      durationMs: { type: 'number', optional: true, integer: true, min: 1, description: 'Maximum fishing duration when catch count is not used.' },
      maxAttempts: { type: 'number', optional: true, integer: true, min: 1 },
      attemptTimeoutMs: { type: 'number', optional: true, integer: true, min: 1 },
      bobberSpawnTimeoutMs: { type: 'number', optional: true, integer: true, min: 1 },
      pickupTimeoutMs: { type: 'number', optional: true, integer: true, min: 1 },
      waterSafetyPollMs: { type: 'number', optional: true, integer: true, min: 1 },
      depositChest: { type: 'object', required: true, shape: 'position', description: 'Chest position {x,y,z} to receive caught items.' },
      depositRod: { type: 'boolean', optional: true, default: false, description: 'Also deposit one fishing_rod after the fishing work.' },
      depositMaxDistance: { type: 'number', optional: true, default: 32, min: 1 },
    },
    oneOf: [['catches'], ['durationMs']],
  },

  mine_until: {
    description:
      'Mine visible ore-like blocks near the current position until a target count, duration, max attempts, or visible-target exhaustion. Does not explore caves or return/deposit.',
    advisorCallable: true,
    params: {
      ores: {
        type: 'array',
        optional: true,
        minItems: 1,
        items: { type: 'string' },
        description: 'Ore block names in priority order, such as coal_ore, iron_ore, diamond_ore.',
      },
      count: { type: 'number', optional: true, integer: true, min: 1, description: 'Number of visible ore targets to mine.' },
      durationMs: { type: 'number', optional: true, integer: true, min: 1, description: 'Maximum mining duration when count is not used.' },
      maxAttempts: { type: 'number', optional: true, integer: true, min: 1, description: 'Maximum collect attempts across target ores.' },
      maxDistance: { type: 'number', optional: true, default: 64, min: 1, description: 'Search radius for visible ores.' },
    },
    oneOf: [['count'], ['durationMs']],
  },

  mine_and_return: {
    description:
      'Mine visible ore-like blocks near the current position, reserve time for return on duration missions, then return to a specific chest and deposit mined deltas. Does not explore caves.',
    advisorCallable: true,
    params: {
      ores: {
        type: 'array',
        optional: true,
        minItems: 1,
        items: { type: 'string' },
        description: 'Ore block names in priority order, such as coal_ore, iron_ore, diamond_ore.',
      },
      count: { type: 'number', optional: true, integer: true, min: 1, description: 'Number of visible ore targets to mine before returning.' },
      durationMs: { type: 'number', optional: true, integer: true, min: 1, description: 'Total mission duration budget; returnReserveMs is subtracted from mining time.' },
      maxAttempts: { type: 'number', optional: true, integer: true, min: 1 },
      maxDistance: { type: 'number', optional: true, default: 64, min: 1 },
      returnChest: { type: 'object', required: true, shape: 'position', description: 'Chest/base position {x,y,z} to return to.' },
      returnReserveMs: { type: 'number', optional: true, integer: true, min: 0, description: 'Duration budget reserved for returning/depositing.' },
      returnRange: { type: 'number', optional: true, default: 2, min: 0 },
      returnMaxDistance: { type: 'number', optional: true, default: 64, min: 1 },
      depositMaxDistance: { type: 'number', optional: true, default: 64, min: 1 },
      depositMinedItems: { type: 'boolean', optional: true, default: true },
    },
    oneOf: [['count'], ['durationMs']],
  },

  smelt: {
    description:
      'Runtime-only furnace operation for deterministic progression missions. Smelts an input item into an expected output with inventory fuel.',
    advisorCallable: false,
    runtimeOnlyReason: 'scheduled only by deterministic progression missions until furnace execution is live-verified and advisor-safe',
    params: {
      input: { type: 'string', required: true, description: 'Input item name such as raw_iron.' },
      output: { type: 'string', required: true, description: 'Expected output item name such as iron_ingot.' },
      count: { type: 'number', required: true, integer: true, min: 1 },
      fuel: { type: 'string', optional: true, description: 'Optional fuel item name; omitted selects deterministic inventory fuel.' },
      furnace: { type: 'object', optional: true, shape: 'position', description: 'Optional locked furnace position {x,y,z}.' },
      maxDistance: { type: 'number', optional: true, default: 16, min: 1 },
      waitTimeoutMs: { type: 'number', optional: true, integer: true, min: 1 },
    },
  },

  mine_with_progression: {
    description:
      'Runtime-only mining mission wrapper. Mines prerequisites, smelts/crafts needed tools, then resumes requested ore mining.',
    advisorCallable: false,
    runtimeOnlyReason: 'scheduled only by deterministic progression missions until live-proven and advisor-safe',
    params: {
      ores: {
        type: 'array',
        required: true,
        minItems: 1,
        items: { type: 'string' },
        description: 'Ore block names in final mining priority order.',
      },
      count: { type: 'number', optional: true, integer: true, min: 1 },
      durationMs: { type: 'number', optional: true, integer: true, min: 1 },
      maxAttempts: { type: 'number', optional: true, integer: true, min: 1 },
      maxDistance: { type: 'number', optional: true, default: 64, min: 1 },
      prepMaxAttempts: { type: 'number', optional: true, integer: true, min: 1 },
      prepMaxDistance: { type: 'number', optional: true, min: 1 },
      woodBlock: { type: 'string', optional: true, default: 'oak_log' },
      smeltFuel: { type: 'string', optional: true },
      furnace: { type: 'object', optional: true, shape: 'position' },
      furnaceMaxDistance: { type: 'number', optional: true, min: 1 },
      optionalCrafts: { type: 'array', optional: true, items: { type: 'string' } },
      equipCraftedTools: { type: 'boolean', optional: true, default: true },
      requireSelfContainedFieldKit: { type: 'boolean', optional: true, default: false },
      returnChest: { type: 'object', optional: true, shape: 'position' },
      returnReserveMs: { type: 'number', optional: true, integer: true, min: 0 },
      returnRange: { type: 'number', optional: true, default: 2, min: 0 },
      returnMaxDistance: { type: 'number', optional: true, default: 64, min: 1 },
      depositMaxDistance: { type: 'number', optional: true, default: 64, min: 1 },
      depositMinedItems: { type: 'boolean', optional: true, default: true },
    },
    oneOf: [['count'], ['durationMs']],
  },

  place_workstation: {
    description:
      'Runtime-only workstation lifecycle helper. Places or recovers a portable crafting_table/furnace for deterministic progression missions.',
    advisorCallable: false,
    runtimeOnlyReason: 'scheduled only by deterministic progression missions until live-proven and advisor-safe',
    params: {
      workstation: { type: 'string', required: true, enum: ['crafting_table', 'furnace'] },
      action: { type: 'string', required: true, enum: ['place', 'break_and_carry'] },
      x: { type: 'number', optional: true },
      y: { type: 'number', optional: true },
      z: { type: 'number', optional: true },
      searchRadius: { type: 'number', optional: true, integer: true, min: 0 },
      verticalRadius: { type: 'number', optional: true, integer: true, min: 0 },
    },
  },

  excavate_shaft: {
    description:
      'Staircase shaft excavation primitive. Opens a 1x2 staircase descent from the current position to a target Y level, scanning for hazards (lava, water, voids) ahead of each dig. Use excavate_shaft when collect fails with shaft_mining_required or when a desired ore is not reachable at the surface. Approximate ore Y ranges for typical Overworld terrain: coal_ore is common Y 0-200; iron_ore is reachable at Y 15-64 with best density near Y 15; gold_ore peaks near Y -16; redstone_ore and diamond_ore peak near Y -59. Prefer stopOnExposedBlock for target ore shafts only, for example ["iron_ore","deepslate_iron_ore"], so descent halts with stoppedOnExposedBlock: true and exposedBlock name/position as soon as target ore is visible instead of digging past it. Do not use stopOnExposedBlock for common terrain or supply blocks such as stone, cobblestone, dirt, grass_block, or logs; that causes premature shaft stops and does not solve furnace material collection. After descending, retry collect for the desired buried resource from the shaft/cave with allowBuriedTargets: true; if stopOnExposedBlock fires, follow with collect for the target item or ore from the shaft/cave using allowBuriedTargets: true. After collecting, call excavate_shaft again with returnToSurface: true to retrace the recorded escape trail without further digging; returnToSurface only works after a successful excavate_shaft recorded an escapeTrail in the current runtime context. Always equip a sufficient-tier pickaxe before excavating (wooden for stone, stone for iron-tier digging).',
    advisorCallable: true,
    params: {
      targetY: { type: 'number', required: true, integer: true, description: 'Y level to descend to.' },
      direction: {
        type: 'string',
        optional: true,
        default: 'north',
        enum: ['north', 'south', 'east', 'west'],
        description: 'Descent direction, which way the staircase opens.',
      },
      maxDepth: { type: 'number', optional: true, integer: true, min: 1, default: 64, description: 'Maximum blocks of descent before bailing.' },
      hazardScanDepth: { type: 'number', optional: true, integer: true, min: 1, default: 3, description: 'Blocks ahead to scan for lava, water, or voids.' },
      stopOnExposedBlock: { type: 'array', optional: true, items: { type: 'string' }, description: 'Block names that halt descent early when newly visible adjacent to the shaft.' },
      returnToSurface: { type: 'boolean', optional: true, default: false, description: 'Walk back up the recorded escape trail instead of digging farther.' },
    },
  },

  flee: {
    description: 'Move away from a position or entity name for a given distance.',
    advisorCallable: true,
    params: {
      from: { type: 'string|object', required: true, shape: 'position', description: '"nearest_hostile" OR {x,y,z}.' },
      distance: { type: 'number', optional: true, default: 16, min: 1 },
    },
  },

  logout: {
    description: 'Cleanly disconnect from the server.',
    advisorCallable: true,
    params: {
      reason: { type: 'string', optional: true, default: 'advisor-requested' },
    },
  },

  recover_drops: {
    description:
      'Return once to a death/drop location and wait briefly for automatic item pickup. Use only from deterministic death recovery.',
    advisorCallable: false,
    runtimeOnlyReason: 'scheduled only by deterministic death recovery after a recoverable respawn',
    params: {
      x: { type: 'number', required: true },
      y: { type: 'number', required: true },
      z: { type: 'number', required: true },
      dimension: { type: 'string', optional: true },
      range: { type: 'number', optional: true, default: 0.4, min: 0 },
      waitMs: { type: 'number', optional: true, default: 6000, integer: true, min: 0 },
      settleMs: { type: 'number', optional: true, default: 1500, integer: true, min: 0 },
    },
  },

  build_from_schematic: {
    description:
      'Dry-run-only build scaffold. Does not place blocks. Use only for deterministic BOM/placement validation.',
    advisorCallable: true,
    advisorMode: 'dry-run-only',
    params: {
      schematic: { type: 'string|object', optional: true, shape: 'schematic', description: 'Inline {blocks:[...]}, a JSON file, or a Sponge .schem file under schematics/ for dry-run; .litematic parsing is not implemented yet.' },
      blocks: { type: 'array', optional: true, items: { type: 'object', schematicBlock: true }, description: 'Inline dry-run blocks: {name|block|blockState, offset|position|x,y,z}.' },
      anchor: { type: 'object', required: true, shape: 'position', description: '{x,y,z} of the build origin.' },
      dryRun: { type: 'boolean', required: true, enum: [true], description: 'Must be true. Live placement is not implemented.' },
    },
    oneOf: [['schematic'], ['blocks']],
  },
};

export const SKILL_NAMES = Object.freeze(Object.keys(SKILLS));
export const ADVISOR_SKILL_NAMES = Object.freeze(
  SKILL_NAMES.filter((name) => SKILLS[name].advisorCallable !== false),
);
export const RUNTIME_ONLY_SKILL_NAMES = Object.freeze(
  SKILL_NAMES.filter((name) => SKILLS[name].advisorCallable === false),
);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a single skill call. Returns { ok: true } or { ok: false, reason }.
 * A skill call looks like: { skill: 'collect', params: { block: 'oak_log', count: 10 } }
 */
export function validateSkillCall(call) {
  if (!call || typeof call !== 'object') return { ok: false, reason: 'call must be an object' };
  const { skill, params } = call;
  if (!skill || typeof skill !== 'string') return { ok: false, reason: 'missing "skill" string' };
  const def = SKILLS[skill];
  if (!def) return { ok: false, reason: `unknown skill "${skill}"` };
  const p = params || {};
  if (typeof p !== 'object' || Array.isArray(p)) return { ok: false, reason: '"params" must be an object' };
  const jsonParams = validateJsonCompatible(p, 'params');
  if (!jsonParams.ok) return { ok: false, reason: `${skill}: params must be JSON-compatible (${jsonParams.reason})` };
  for (const key of Object.keys(p)) {
    if (!Object.hasOwn(def.params, key)) {
      return { ok: false, reason: `${skill}: unknown param "${key}"` };
    }
  }

  // Required fields
  for (const [key, spec] of Object.entries(def.params)) {
    if (spec.required && p[key] === undefined) {
      return { ok: false, reason: `${skill}: missing required param "${key}"` };
    }
    if (p[key] !== undefined && spec.type && !paramMatchesType(p[key], spec.type)) {
      return { ok: false, reason: `${skill}: "${key}" must be ${spec.type}` };
    }
    if (p[key] !== undefined && spec.integer && !Number.isInteger(p[key])) {
      return { ok: false, reason: `${skill}: "${key}" must be an integer` };
    }
    if (p[key] !== undefined && spec.min !== undefined && p[key] < spec.min) {
      return { ok: false, reason: `${skill}: "${key}" must be >= ${spec.min}` };
    }
    if (spec.enum && p[key] !== undefined && !spec.enum.includes(p[key])) {
      return { ok: false, reason: `${skill}: "${key}" must be one of ${spec.enum.join('|')}` };
    }
    if (p[key] !== undefined) {
      const nested = validateNestedParam(skill, key, p[key], spec);
      if (!nested.ok) return nested;
    }
  }

  // oneOf groups (for skills like goto where the target form is mutually exclusive)
  if (def.oneOf) {
    const present = def.oneOf.filter((group) => group.every((k) => p[k] !== undefined));
    if (present.length === 0) {
      const opts = def.oneOf.map((g) => `{${g.join(',')}}`).join(' OR ');
      return { ok: false, reason: `${skill}: must provide one of ${opts}` };
    }
    if (present.length > 1) {
      const opts = def.oneOf.map((g) => `{${g.join(',')}}`).join(' OR ');
      return { ok: false, reason: `${skill}: must provide exactly one of ${opts}` };
    }
  }

  return { ok: true };
}

function validateNestedParam(skill, key, value, spec) {
  if (spec.minItems !== undefined && Array.isArray(value) && value.length < spec.minItems) {
    return { ok: false, reason: `${skill}: "${key}" must contain at least ${spec.minItems} item` };
  }

  if (spec.shape === 'position' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const position = validatePositionShape(value, `${skill}: "${key}`);
    if (!position.ok) return position;
  }

  if (spec.shape === 'schematic' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (!Array.isArray(value.blocks)) {
      return { ok: false, reason: `${skill}: "${key}.blocks" must be array` };
    }
    for (let i = 0; i < value.blocks.length; i++) {
      const block = validateSchematicBlock(value.blocks[i], `${skill}: "${key}.blocks[${i}]"`);
      if (!block.ok) return block;
    }
  }

  if (spec.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = validateNestedValue(value[i], spec.items, `${skill}: "${key}[${i}]"`);
      if (!item.ok) return item;
    }
  }

  return { ok: true };
}

function validateNestedValue(value, spec, label) {
  if (spec.type && !paramMatchesType(value, spec.type)) {
    return { ok: false, reason: `${label} must be ${spec.type}` };
  }
  if (spec.integer && !Number.isInteger(value)) {
    return { ok: false, reason: `${label} must be an integer` };
  }
  if (spec.min !== undefined && value < spec.min) {
    return { ok: false, reason: `${label} must be >= ${spec.min}` };
  }
  if (spec.fields && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (spec.noUnknown) {
      for (const field of Object.keys(value)) {
        if (!Object.hasOwn(spec.fields, field)) {
          return { ok: false, reason: `${label} unknown field "${field}"` };
        }
      }
    }
    for (const [field, fieldSpec] of Object.entries(spec.fields)) {
      const fieldLabel = label.replace(/"$/, `.${field}"`);
      if (fieldSpec.required && value[field] === undefined) {
        return { ok: false, reason: `${fieldLabel} is required` };
      }
      if (value[field] !== undefined) {
        const fieldResult = validateNestedValue(value[field], fieldSpec, fieldLabel);
        if (!fieldResult.ok) return fieldResult;
      }
    }
  }
  if (spec.schematicBlock && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const block = validateSchematicBlock(value, label);
    if (!block.ok) return block;
  }
  return { ok: true };
}

export function validateSchematicBlock(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: `${label} must be object` };
  }

  const allowed = new Set(['name', 'block', 'blockState', 'block_state', 'offset', 'position', 'x', 'y', 'z']);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) return { ok: false, reason: `${label} unknown field "${field}"` };
  }

  const nameFields = ['name', 'block', 'blockState', 'block_state'].filter((field) => value[field] !== undefined);
  if (nameFields.length === 0) {
    return { ok: false, reason: `${label} must include one of name|block|blockState|block_state` };
  }
  for (const field of nameFields) {
    if (typeof value[field] !== 'string') {
      return { ok: false, reason: `${label.replace(/"$/, `.${field}"`)} must be string` };
    }
  }

  const coordinateForms = [
    value.offset !== undefined ? 'offset' : null,
    value.position !== undefined ? 'position' : null,
    ['x', 'y', 'z'].every((axis) => value[axis] !== undefined) ? '{x,y,z}' : null,
  ].filter(Boolean);
  if (coordinateForms.length === 0) {
    return { ok: false, reason: `${label} must include one of offset|position|{x,y,z}` };
  }
  if (coordinateForms.length > 1) {
    return { ok: false, reason: `${label} must include exactly one of offset|position|{x,y,z}` };
  }

  if (value.offset !== undefined) return validatePositionShape(value.offset, label.replace(/"$/, '.offset'));
  if (value.position !== undefined) return validatePositionShape(value.position, label.replace(/"$/, '.position'));
  for (const axis of ['x', 'y', 'z']) {
    const axisLabel = label.replace(/"$/, `.${axis}"`);
    if (typeof value[axis] !== 'number' || !Number.isFinite(value[axis])) {
      return { ok: false, reason: `${axisLabel} must be number` };
    }
  }
  return { ok: true };
}

function validatePositionShape(value, labelPrefix) {
  for (const axis of ['x', 'y', 'z']) {
    const label = `${labelPrefix}.${axis}"`;
    if (value[axis] === undefined) return { ok: false, reason: `${label} is required` };
    if (typeof value[axis] !== 'number' || !Number.isFinite(value[axis])) {
      return { ok: false, reason: `${label} must be number` };
    }
  }
  return { ok: true };
}

function paramMatchesType(value, typeSpec) {
  return typeSpec.split('|').some((type) => {
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === type;
  });
}

function validateJsonCompatible(value, path, seen = new WeakSet()) {
  if (value === null) return { ok: true };
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return { ok: true };
  if (type === 'number') {
    return Number.isFinite(value)
      ? { ok: true }
      : { ok: false, reason: `non-finite number at ${path}` };
  }
  if (type === 'bigint' || type === 'function' || type === 'symbol' || type === 'undefined') {
    return { ok: false, reason: `${type} at ${path}` };
  }
  if (type !== 'object') return { ok: false, reason: `${type} at ${path}` };
  if (seen.has(value)) return { ok: false, reason: `circular reference at ${path}` };
  seen.add(value);
  const entries = Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : Object.entries(value);
  for (const [key, item] of entries) {
    const childPath = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
    const child = validateJsonCompatible(item, childPath, seen);
    if (!child.ok) return child;
  }
  seen.delete(value);
  return { ok: true };
}

/** Validate an array of skill calls. Returns { ok, reason, badIndex? }. */
export function validatePlan(plan) {
  if (!Array.isArray(plan)) return { ok: false, reason: 'plan must be an array of skill calls' };
  for (let i = 0; i < plan.length; i++) {
    const r = validateSkillCall(plan[i]);
    if (!r.ok) return { ok: false, reason: r.reason, badIndex: i };
  }
  return { ok: true };
}

/** Validate a plan emitted by the advisor/LLM boundary. Runtime-only skills remain executor-valid but planner-forbidden. */
export function validateAdvisorPlan(plan) {
  const base = validatePlan(plan);
  if (!base.ok) return base;
  for (let i = 0; i < plan.length; i++) {
    const skill = plan[i]?.skill;
    if (SKILLS[skill]?.advisorCallable === false) {
      const reason = SKILLS[skill].runtimeOnlyReason || 'runtime-only skill';
      return {
        ok: false,
        reason: `${skill}: not advisor-callable (${reason})`,
        badIndex: i,
      };
    }
  }
  return { ok: true };
}

/**
 * Render the skill schema as compact text for the advisor system prompt.
 * Keep this terse — every token costs latency and money in the advisor loop.
 */
export function skillSchemaForPrompt(opts = {}) {
  const includeRuntimeOnly = opts.includeRuntimeOnly === true;
  const lines = [];
  for (const [name, def] of Object.entries(SKILLS)) {
    if (!includeRuntimeOnly && def.advisorCallable === false) continue;
    const paramsTxt = Object.entries(def.params)
      .map(([k, s]) => {
        const flags = [];
        if (s.required) flags.push('REQUIRED');
        if (s.optional) flags.push('optional');
        if (s.default !== undefined) flags.push(`default=${JSON.stringify(s.default)}`);
        if (s.integer) flags.push('integer');
        if (s.min !== undefined) flags.push(`min=${s.min}`);
        if (s.enum) flags.push(`one of ${s.enum.join('|')}`);
        const f = flags.length ? ` (${flags.join(', ')})` : '';
        return `    - ${k}: ${s.type}${f}`;
      })
      .join('\n');
    const mode = def.advisorMode ? `\n  advisorMode: ${def.advisorMode}` : '';
    lines.push(`- ${name}: ${def.description}${mode}\n  params:\n${paramsTxt || '    (none)'}`);
  }
  return lines.join('\n\n');
}

export function advisorSkillContract() {
  return {
    version: 1,
    output: 'JSON object with exactly one key "plan"; plan is an array of {skill, params}',
    plannerSkillNames: [...ADVISOR_SKILL_NAMES],
    runtimeOnlySkillNames: [...RUNTIME_ONLY_SKILL_NAMES],
    runtimeOnlyReasons: Object.fromEntries(
      RUNTIME_ONLY_SKILL_NAMES.map((name) => [name, SKILLS[name].runtimeOnlyReason || 'runtime-only skill']),
    ),
    skillModes: Object.fromEntries(
      ADVISOR_SKILL_NAMES
        .filter((name) => SKILLS[name].advisorMode)
        .map((name) => [name, SKILLS[name].advisorMode]),
    ),
    safety: {
      survivalLayerPriority: 'reactive survival outranks advisor plans',
      plannerRestriction: 'advisor may emit only plannerSkillNames; executor/runtime may schedule runtimeOnlySkillNames internally',
      noRawControl: 'advisor must never call Mineflayer, pathfinder, server admin commands, or arbitrary code directly',
    },
  };
}

export default SKILLS;
