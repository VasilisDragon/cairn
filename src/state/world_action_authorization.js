import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  WORLD_MODEL_STORE_LIVE_SNAPSHOT,
  blockModificationPolicy,
} from './world_model.js';

export const WORLD_ACTION_MODE = Object.freeze({
  OWNED_ONLY: 'owned_only',
  DISPOSABLE_SINGLE_PLAYER: 'disposable_single_player',
});

export const WORLD_ANCHOR_KIND = Object.freeze({
  STORAGE: 'storage',
  WORKSTATION: 'workstation',
});

const STORAGE_BLOCKS = new Set([
  'chest', 'trapped_chest', 'barrel', 'ender_chest',
  'hopper', 'dropper', 'dispenser', 'shulker_box',
  'bookshelf', 'chiseled_bookshelf', 'decorated_pot', 'flower_pot',
  // A crafted beehive is an inventory-bearing player anchor. Natural bee_nest
  // blocks remain ordinary resource targets unless doNotTouch protects them.
  'jukebox', 'campfire', 'soul_campfire', 'beehive',
]);
const WORKSTATION_BLOCKS = new Set([
  'crafting_table', 'furnace', 'blast_furnace', 'smoker',
  'smithing_table', 'cartography_table', 'fletching_table', 'stonecutter',
  'grindstone', 'loom', 'brewing_stand', 'cauldron', 'composter', 'lectern', 'enchanting_table',
  'water_cauldron', 'lava_cauldron', 'powder_snow_cauldron',
  'anvil', 'chipped_anvil', 'damaged_anvil', 'crafter', 'beacon',
]);
const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker']);
const AUTONOMOUS_OUTPUT_CONTAINERS = new Set(['hopper', 'dropper', 'dispenser', 'crafter']);
const CONTAINER_MUTATION_DEPENDENCIES = new Set([
  'hopper', 'comparator', 'observer', 'redstone_wire', 'redstone_torch',
  'redstone_wall_torch', 'repeater', 'lever', 'tripwire', 'tripwire_hook',
  'sculk_sensor', 'calibrated_sculk_sensor', 'daylight_detector', 'target',
  'lightning_rod', 'redstone_block', 'redstone_lamp', 'copper_bulb',
  'piston', 'sticky_piston', 'piston_head', 'moving_piston',
  'rail', 'powered_rail', 'detector_rail', 'activator_rail',
  'note_block', 'lectern', 'chiseled_bookshelf',
]);
const GRAVITY_DEPENDENCY_BLOCKS = new Set([
  'sand', 'red_sand', 'gravel', 'anvil', 'chipped_anvil', 'damaged_anvil',
  'dragon_egg', 'pointed_dripstone', 'scaffolding',
]);
const STATE_PROPAGATION_DEPENDENCIES = new Set([
  'bamboo', 'bamboo_sapling', 'sugar_cane', 'cactus',
  'chorus_plant', 'chorus_flower',
  'kelp', 'kelp_plant',
  'vine', 'weeping_vines', 'weeping_vines_plant',
  'twisting_vines', 'twisting_vines_plant', 'cave_vines', 'cave_vines_plant',
  'big_dripleaf', 'big_dripleaf_stem', 'small_dripleaf',
  'fire', 'soul_fire',
]);
const VIBRATION_SENSOR_BLOCKS = new Set(['sculk_sensor', 'calibrated_sculk_sensor']);
const MAX_VANILLA_VIBRATION_RADIUS = 16;
const INTENTIONAL_MUTATION_DEPENDENCY_RADIUS = 2;
const INTENTIONAL_MUTATION_DEPENDENCY_OFFSETS = Object.freeze(
  mutationDependencyOffsets(INTENTIONAL_MUTATION_DEPENDENCY_RADIUS),
);
// Phase 1 permits placement only when every directly affected cell is modeled
// and the block has no autonomous, explosive, actuator, summoning, gravity, or
// fluid effect. This intentionally small list supports baseline survival
// fixtures; additions require a placement-effect model and regression tests.
const MODELED_INERT_SINGLE_CELL_PLACEMENTS = new Set([
  'stone', 'cobblestone', 'mossy_cobblestone', 'deepslate', 'cobbled_deepslate',
  'granite', 'diorite', 'andesite', 'calcite', 'tuff',
  'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol',
  'mud', 'packed_mud', 'clay', 'terracotta',
  'netherrack', 'nether_bricks', 'red_nether_bricks', 'blackstone', 'basalt',
  'smooth_basalt', 'end_stone', 'end_stone_bricks', 'obsidian', 'crying_obsidian',
  'bricks', 'stone_bricks', 'deepslate_bricks', 'deepslate_tiles',
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'mangrove_log', 'cherry_log', 'crimson_stem', 'warped_stem', 'bamboo_block',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'crimson_planks',
  'warped_planks', 'bamboo_planks',
  'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'barrel', 'ender_chest',
  'chest',
]);
const DOUBLE_HEIGHT_PLANTS = new Set([
  'sunflower', 'lilac', 'rose_bush', 'peony', 'tall_grass', 'large_fern',
  'tall_seagrass', 'small_dripleaf', 'pitcher_plant',
]);
const PITCHER_CROP_BLOCK = 'pitcher_crop';
const CARDINAL_OFFSETS = Object.freeze({
  north: Object.freeze({ x: 0, y: 0, z: -1 }),
  south: Object.freeze({ x: 0, y: 0, z: 1 }),
  west: Object.freeze({ x: -1, y: 0, z: 0 }),
  east: Object.freeze({ x: 1, y: 0, z: 0 }),
});
const WORLD_MUTATING_BUCKET_SUFFIX = '_bucket';
const POLICY_VERSION = 1;
const WORLD_ACTION_BOUNDARY = Symbol.for('mcbot.worldActionBoundary.v1');
const WORLD_ACTION_PACKET_BOUNDARY = Symbol.for('mcbot.worldActionPacketBoundary.v1');
const AUTHORIZED_WINDOW_TRANSFER_BOUNDARY = Symbol.for('mcbot.authorizedWindowTransferBoundary.v1');
const OBSERVED_WORLD_IDENTITY = Symbol('mcbot.observedWorldIdentity.v1');
const WORLD_ACTION_INVOCATION = new AsyncLocalStorage();
const AUTHORIZED_WINDOW_OPEN_TIMEOUT_MS = 15_000;
const WINDOW_OPEN_METHODS = new Set(['openBlock', 'openContainer', 'openFurnace', 'craft']);
const WINDOW_MUTATION_PACKETS = new Set([
  'window_click',
  'close_window',
  'enchant_item',
  'name_item',
  'select_trade',
  'set_beacon_effect',
  'set_slot_state',
  'craft_recipe_request',
  'custom_click_action',
]);
const SAFE_CUSTOM_PAYLOAD_CHANNELS = new Set([
  'minecraft:brand',
  'minecraft:register',
  'minecraft:unregister',
  'MC|Brand',
  'REGISTER',
  'UNREGISTER',
]);
// This list is intentionally explicit. Adding a protocol or plugin packet must
// include a security classification here instead of inheriting an allow-by-
// default raw write path.
const NON_MUTATING_OUTBOUND_PACKETS = new Set([
  // Status/login/configuration transport.
  'ping_start', 'ping', 'set_protocol', 'login_start', 'encryption_begin',
  'login_plugin_response', 'login_acknowledged', 'configuration_acknowledged',
  'select_known_packs', 'accept_code_of_conduct', 'finish_configuration',
  'bundle_delimiter', 'keep_alive', 'pong', 'message_acknowledgement',
  'chat_session_update', 'chat_preview', 'cookie_response',
  // Observation, acknowledgement, movement, and client preference packets.
  'teleport_confirm', 'query_block_nbt', 'query_entity_nbt',
  'chunk_batch_received', 'tick_end', 'settings', 'tab_complete',
  'debug_subscription_request', 'ping_request',
  'player_loaded',
  'resource_pack_receive', 'arm_animation',
  // Player-local UI/item state which cannot mutate a block, external
  // container, workstation, entity container, or server rule.
  'transaction', 'edit_book', 'select_bundle_item',
  'recipe_book', 'displayed_recipe', 'advancement_tab',
]);
const PASSIVE_RAW_USE_ITEMS = new Set([
  'apple', 'baked_potato', 'beetroot', 'beetroot_soup', 'bread', 'carrot',
  'cooked_beef', 'cooked_chicken', 'cooked_cod',
  'cooked_mutton', 'cooked_porkchop', 'cooked_rabbit', 'cooked_salmon',
  'cookie', 'dried_kelp', 'enchanted_golden_apple', 'golden_apple',
  'golden_carrot', 'honey_bottle', 'melon_slice', 'mushroom_stew',
  'poisonous_potato', 'potato', 'pufferfish', 'pumpkin_pie', 'rabbit_stew',
  'raw_beef', 'raw_chicken', 'raw_cod', 'raw_mutton', 'raw_porkchop',
  'raw_rabbit', 'raw_salmon', 'rotten_flesh', 'spider_eye',
  'suspicious_stew', 'sweet_berries', 'glow_berries', 'tropical_fish',
  'milk_bucket', 'potion', 'shield', 'spyglass', 'goat_horn',
]);
const STABLE_PASSIVE_USE_ITEMS = new Set(['shield', 'spyglass', 'goat_horn']);
// Entity attacks are intentionally limited to ordinary hostile mobs whose
// destruction cannot expose an inventory or directly trigger an explosion.
// Expanding this set requires a typed authority model for the entity and every
// affected block/entity; names absent from the set fail closed.
const DIRECT_ATTACKABLE_HOSTILE_MOBS = new Set([
  'blaze', 'bogged', 'breeze', 'cave_spider', 'drowned', 'elder_guardian',
  'enderman', 'endermite', 'evoker', 'guardian', 'hoglin',
  'husk', 'magma_cube', 'phantom', 'piglin_brute', 'pillager', 'ravager',
  'shulker', 'skeleton', 'slime', 'spider', 'stray', 'vex',
  'vindicator', 'warden', 'witch', 'wither_skeleton', 'zoglin', 'zombie',
  'zombie_villager', 'zombified_piglin',
]);
const REFERENCE_ONLY_BLOCK_USE_ITEMS = new Set([
  'shears', 'honeycomb', 'glass_bottle',
  'brush', 'lead', 'name_tag',
]);
const CLIENT_POSITION_EPSILON = 1e-7;
const CLIENT_ROTATION_EPSILON = 1e-3;
const MOVEMENT_CONTROLS = new Set([
  'forward', 'back', 'left', 'right', 'jump', 'sprint',
]);

/**
 * Construct the mutable, runtime-owned authorization state for world actions.
 * A generated session identity scopes runtime state, but cannot prove that a
 * locally observed placement was performed by this process. Fresh disposable-
 * world trust also requires an explicit sessionIdentity and world evidence.
 */
export function createWorldActionAuthorization(opts = {}) {
  const explicitSessionIdentity = cleanIdentity(opts.sessionIdentity);
  const worldIdentity = cleanIdentity(opts.worldIdentity);
  const state = {
    version: POLICY_VERSION,
    mode: opts.mode === WORLD_ACTION_MODE.DISPOSABLE_SINGLE_PLAYER
      ? WORLD_ACTION_MODE.DISPOSABLE_SINGLE_PLAYER
      : WORLD_ACTION_MODE.OWNED_ONLY,
    sessionIdentity: explicitSessionIdentity || randomUUID(),
    sessionIdentityExplicit: Boolean(explicitSessionIdentity),
    worldIdentity,
    // A configured worldIdentity may scope explicit/operator anchors, but it is
    // not independent evidence of which world the connection actually joined.
    freshWorldIdentity: cleanIdentity(opts.freshWorldIdentity),
    createdFreshWorld: opts.createdFreshWorld === true,
    singlePlayer: opts.singlePlayer === true,
    disposableTrustRevoked: opts.disposableTrustRevoked === true,
    revocationReason: opts.revocationReason || null,
    anchors: [],
  };

  installRuntimeFields(state);
  for (const anchor of opts.operatorAnchors || []) {
    registerAnchor(state, {
      ...anchor,
      provenance: 'operator_configured',
      sessionIdentity: null,
    });
  }
  return state;
}

export function worldActionAuthorizationFromContext(ctx = {}, opts = {}) {
  const runtime = runtimeContext(ctx);
  let state = runtime?.worldActionAuthorization
    || runtime?.worldActionPolicy
    || ctx.worldActionAuthorization
    || ctx.worldActionPolicy
    || null;

  if (state && state.version !== POLICY_VERSION) {
    state = normalizeExistingState(state);
    assignState(runtime || ctx, state);
  } else if (state) {
    installRuntimeFields(state);
  }

  if (!state && opts.create === true && (runtime || ctx)) {
    state = createWorldActionAuthorization(opts.defaults || {});
    assignState(runtime || ctx, state);
  }
  return state;
}

/**
 * Install the last authorization boundary around Mineflayer's physical world
 * methods. This also covers pathfinder and plugin code which legitimately owns
 * movement planning but otherwise bypasses skill-level checks.
 *
 * Reinstalling is safe: the existing wrappers are retained and pointed at the
 * latest runtime context.
 */
export function installWorldActionBoundary(bot, ctx = {}) {
  if (!bot || (typeof bot !== 'object' && typeof bot !== 'function')) {
    throw new TypeError('world-action boundary requires a bot');
  }

  let boundary = bot[WORLD_ACTION_BOUNDARY];
  if (!boundary) {
    boundary = {
      context: ctx,
      methods: new Map(),
      disposableTrustRevoked: false,
      revocationReason: null,
      windowAccess: null,
      pendingWindowAccess: null,
      windowLifecycleBound: false,
      worldIdentityLifecycleClient: null,
      worldIdentityLifecycleListeners: null,
      containerProvenanceEpoch: 0,
      containerProvenanceTainted: false,
      clientState: initialAuthoritativeClientState(bot),
      itemMutationEpoch: 0,
      itemStateCoherent: true,
      pendingItemMutation: null,
      unconfirmedHotbarSlots: new Map(),
      latestInventoryStateId: null,
      clientStateLifecycleClient: null,
      clientStateLifecycleListeners: null,
      activeWindowTransferToken: null,
      closingDeniedWindow: false,
      movementProtection: null,
      movementProtectionGeneration: 0,
      movementProtectionUnsubscribe: null,
    };
    Object.defineProperty(bot, WORLD_ACTION_BOUNDARY, {
      value: boundary,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  } else {
    if (!(boundary.methods instanceof Map)) boundary.methods = new Map();
    if (!Number.isSafeInteger(boundary.containerProvenanceEpoch)) {
      boundary.containerProvenanceEpoch = 0;
    }
    if (typeof boundary.containerProvenanceTainted !== 'boolean') {
      boundary.containerProvenanceTainted = false;
    }
    if (!boundary.clientState || typeof boundary.clientState !== 'object') {
      boundary.clientState = initialAuthoritativeClientState(bot);
    }
    if (!Number.isSafeInteger(boundary.itemMutationEpoch)) boundary.itemMutationEpoch = 0;
    if (typeof boundary.itemStateCoherent !== 'boolean') boundary.itemStateCoherent = false;
    if (!(boundary.unconfirmedHotbarSlots instanceof Map)) {
      boundary.unconfirmedHotbarSlots = new Map();
    }
    if (typeof boundary.closingDeniedWindow !== 'boolean') {
      boundary.closingDeniedWindow = false;
    }
    if (!Number.isSafeInteger(boundary.movementProtectionGeneration)) {
      boundary.movementProtectionGeneration = 0;
    }
  }
  replaceBoundaryContext(bot, boundary, ctx);
  const installedState = stateForBoundaryContext(ctx);
  if (installedState) observeWorldActionSession(bot, ctx, installedState);
  installWorldActionPacketBoundary(bot, boundary);
  bindObservedWorldIdentityLifecycle(bot, boundary);
  bindAuthoritativeClientStateLifecycle(bot, boundary);
  bindAuthorizedWindowLifecycle(bot, boundary);

  wrapWorldActionMethod(bot, boundary, 'dig', async (original, receiver, args, invocation) => {
    requireNoUnboundedDigProtectionRisk(boundary.context, 'dig');
    const current = requireCurrentActionBlock(bot, args[0], 'dig');
    requireSafeDigNeighborhood(bot, current, 'dig');
    requireNoNearbyEntityDigEffects(bot, current.position, 'dig');
    requireWorldAction(authorizeBlockBreak(bot, boundary.context, current.block), 'dig');
    const result = await original.apply(receiver, [current.block, ...args.slice(1)]);
    if (invocation.delegatedToBoundary !== true) {
      revokeWorldActionAnchor(bot, boundary.context, current.name, current.position);
    }
    return result;
  });

  const place = async (original, receiver, args, invocation) => {
    if (boundary.itemStateCoherent !== true) {
      throw worldActionDenied('held-item state lacks authoritative readback', 'place');
    }
    requireNoUnboundedBlockMutationProtectionRisk(boundary.context, 'place');
    const current = requireCurrentActionBlock(bot, args[0], 'place');
    const faceVector = args[1];
    const target = placementTarget(current.position, faceVector);
    if (!target) throw worldActionDenied('placement target is unavailable', 'place');
    requireWorldAction(authorizePlacementWithCurrentReference(bot, boundary.context, target, {
      referencePosition: current.position,
      referenceBlockName: current.name,
    }, current), 'place');
    // Placement remains usable, but Phase 1 does not promote the result to an
    // owned anchor. Mineflayer's generic placement path has no authoritative
    // actor-bound completion receipt, so a same-block multiplayer race cannot
    // be distinguished safely from the bot's own placement.
    return original.apply(receiver, [current.block, ...args.slice(1)]);
  };
  wrapWorldActionMethod(bot, boundary, 'placeBlock', place);
  wrapWorldActionMethod(bot, boundary, '_placeBlockWithOptions', place);
  wrapWorldActionMethod(bot, boundary, '_genericPlace', place);

  wrapWorldActionMethod(bot, boundary, 'activateBlock', async (original, receiver, args, invocation) => {
    if (boundary.itemStateCoherent !== true) {
      throw worldActionDenied('held-item state lacks authoritative readback', 'activate block');
    }
    const current = requireCurrentActionBlock(bot, args[0], 'activate block');
    requireWorldAction(authorizeBlockBreak(bot, boundary.context, current.block), 'activate block');
    const itemName = authoritativeActivatedItemName(bot, boundary, false);
    const heldBlockName = heldPlaceableBlockName(bot, boundary);
    if (heldBlockName === undefined) {
      throw worldActionDenied('held-item placement capability is unavailable', 'activate block');
    }
    const nestedWindowOpen = activeWindowOpenInvocations(invocation.parent).length > 0;
    if (!nestedWindowOpen) {
      requireNoUnboundedBlockMutationProtectionRisk(boundary.context, 'activate block');
    }
    const effectClass = nestedWindowOpen
      ? 'window_open'
      : blockUseEffectClass(itemName, heldBlockName);
    if (!nestedWindowOpen && isUnmodeledExplosiveActivation(current.name)) {
      throw worldActionDenied(
        'block activation has an unbounded dimension-dependent explosion effect',
        'activate block',
      );
    }
    if (!nestedWindowOpen && effectClass === 'passive') {
      throw worldActionDenied(
        'clicked-block activation effect is not explicitly modeled',
        'activate block',
      );
    }
    if (!nestedWindowOpen && effectClass === 'adjacent_placement') {
      throw worldActionDenied(
        'block placement must use the typed placement boundary',
        'activate block',
      );
    }
    if (!nestedWindowOpen && effectClass === 'reference_only'
      && !modeledReferenceOnlyBlockUse(itemName, current.name)) {
      throw worldActionDenied(
        'held tool does not have a modeled effect on the clicked block',
        'activate block',
      );
    }
    if (effectClass === 'unsupported') {
      throw worldActionDenied(
        'held item lacks a typed block-use mutation capability',
        'activate block',
      );
    }
    if (heldBlockName) {
      const faceVector = args[1] || { x: 0, y: 1, z: 0 };
      const target = placementTarget(current.position, faceVector);
      if (!target) throw worldActionDenied('activation placement target is unavailable', 'activate block');
      requireWorldAction(authorizePlacementWithCurrentReference(bot, boundary.context, target, {
        referencePosition: current.position,
        referenceBlockName: current.name,
      }, current), 'activate block placement');
    }
    invocation.blockUseCapability = Object.freeze({
      position: positionRecord(current.position),
      blockName: current.name,
      itemName,
      effectClass,
    });
    return original.apply(receiver, [current.block, ...args.slice(1)]);
  });

  wrapWorldActionMethod(bot, boundary, 'activateItem', async (original, receiver, args, invocation) => {
    const offHand = args[0];
    if (offHand !== undefined && typeof offHand !== 'boolean') {
      throw worldActionDenied('offHand must be a boolean when supplied', 'activate item');
    }
    const normalizedOffHand = offHand === true;
    const itemName = authoritativeActivatedItemName(bot, boundary, normalizedOffHand);
    if (!itemName) {
      throw worldActionDenied('activated item identity is unavailable', 'activate item');
    }
    let worldAction = null;
    if (isWorldMutatingBucket(itemName)) {
      worldAction = requireBucketWorldActionRequest(args[1]?.worldAction, itemName, 'activate item');
      const current = requireCurrentBucketUseCorrelation(bot, worldAction, 'activate item');
      authorizeBucketWorldAction(bot, boundary.context, worldAction, current, 'activate item');
    }
    invocation.itemUseCapability = Object.freeze({
      hand: normalizedOffHand ? 1 : 0,
      offHand: normalizedOffHand,
      itemName,
      worldAction,
    });
    return original.apply(receiver, args.length > 0 ? [args[0]] : []);
  });

  wrapWorldActionMethod(bot, boundary, 'attack', (original, receiver, args, invocation) => {
    if (boundary.itemStateCoherent !== true) {
      throw worldActionDenied('held-item state lacks authoritative readback', 'attack');
    }
    requireNoUnboundedBlockMutationProtectionRisk(
      boundary.context,
      'attack',
      'combat/environment mutation',
    );
    const target = requireAttackableEntity(bot, boundary.context, args[0], 'attack');
    const itemName = authoritativeActivatedItemName(bot, boundary, false);
    if (itemName.endsWith('_sword') || itemName === 'mace') {
      throw worldActionDenied(
        'held weapon has an unmodeled collateral attack footprint',
        'attack',
      );
    }
    invocation.entityAttackCapability = {
      entity: target,
      id: target.id,
      name: normalizedEntityName(target),
      type: normalizeEntityType(target.type),
      position: positionRecord(target.position),
      itemName,
      used: false,
    };
    return original.apply(receiver, [target, ...args.slice(1)]);
  });

  wrapWorldActionMethod(bot, boundary, 'updateSign', async (original, receiver, args, invocation) => {
    requireNoUnboundedBlockMutationProtectionRisk(boundary.context, 'update sign');
    const current = requireCurrentActionBlock(bot, args[0], 'update sign');
    if (!isSignBlock(current.name)) {
      throw worldActionDenied('current block is not a sign', 'update sign');
    }
    requireCurrentBlockInteraction(bot, boundary.context, current, 'update sign');
    invocation.worldPacketCapability = Object.freeze({
      type: 'update_sign',
      position: positionRecord(current.position),
      blockName: current.name,
    });
    return original.apply(receiver, [current.block, ...args.slice(1)]);
  });

  wrapWorldActionMethod(bot, boundary, 'openBlock', async (original, receiver, args, invocation) => {
    const current = requireCurrentActionBlock(bot, args[0], 'open block');
    const access = requireCurrentAnchorFootprint(bot, boundary.context, current, 'open block');
    prepareWindowOpenInvocation(boundary, invocation, access, bot);
    let completed = false;
    try {
      const window = await original.apply(receiver, [current.block, ...args.slice(1)]);
      requireEventBoundWindow(boundary, bot, window, invocation, 'open block');
      completed = true;
      return window;
    } finally {
      finishWindowOpenInvocation(boundary, bot, invocation.windowOpenToken, completed);
    }
  });

  wrapWorldActionMethod(bot, boundary, 'openEntity', async () => {
    throw worldActionDenied(
      'entity-container ownership cannot be proven',
      'open entity',
    );
  });

  wrapWorldActionMethod(bot, boundary, 'openContainer', async (original, receiver, args, invocation) => {
    if (isEntityContainerTarget(args[0])) {
      throw worldActionDenied(
        'entity-container ownership cannot be proven',
        'open container',
      );
    }
    const current = requireCurrentActionBlock(bot, args[0], 'open container');
    const access = requireCurrentAnchorFootprint(bot, boundary.context, current, 'open container');
    prepareWindowOpenInvocation(boundary, invocation, access, bot);
    let completed = false;
    try {
      const window = await original.apply(receiver, [current.block, ...args.slice(1)]);
      requireEventBoundWindow(boundary, bot, window, invocation, 'open container');
      completed = true;
      return window;
    } finally {
      finishWindowOpenInvocation(boundary, bot, invocation.windowOpenToken, completed);
    }
  });

  wrapWorldActionMethod(bot, boundary, 'openFurnace', async (original, receiver, args, invocation) => {
    const current = requireCurrentActionBlock(bot, args[0], 'open furnace');
    if (!FURNACE_BLOCKS.has(current.name)) {
      throw worldActionDenied('current block is not a supported furnace', 'open furnace');
    }
    const access = requireCurrentAnchorFootprint(
      bot,
      boundary.context,
      current,
      'open furnace',
      { kind: WORLD_ANCHOR_KIND.WORKSTATION, blockName: current.name },
    );
    prepareWindowOpenInvocation(boundary, invocation, access, bot);
    let completed = false;
    try {
      const window = await original.apply(receiver, [current.block, ...args.slice(1)]);
      requireEventBoundWindow(boundary, bot, window, invocation, 'open furnace');
      completed = true;
      return window;
    } finally {
      finishWindowOpenInvocation(boundary, bot, invocation.windowOpenToken, completed);
    }
  });

  wrapWorldActionMethod(bot, boundary, 'craft', async (original, receiver, args, invocation) => {
    const table = args[2];
    if (table) {
      const current = requireCurrentActionBlock(bot, table, 'craft');
      if (current.name !== 'crafting_table') {
        throw worldActionDenied('current block is not a crafting_table', 'craft');
      }
      const access = requireCurrentAnchorFootprint(
        bot,
        boundary.context,
        current,
        'craft',
        { kind: WORLD_ANCHOR_KIND.WORKSTATION, blockName: current.name },
      );
      prepareWindowOpenInvocation(boundary, invocation, access, bot);
      let completed = false;
      try {
        const result = await original.apply(
          receiver,
          [args[0], args[1], current.block, ...args.slice(3)],
        );
        completed = true;
        return result;
      } finally {
        finishWindowOpenInvocation(boundary, bot, invocation.windowOpenToken, completed);
      }
    }
    return original.apply(receiver, args);
  });

  wrapWorldActionMethod(bot, boundary, 'setQuickBarSlot', (original, receiver, args, invocation) => {
    const slot = Number(args[0]);
    if (!isQuickBarSlot(slot)) {
      throw worldActionDenied('quick-bar slot is malformed', 'set quick-bar slot');
    }
    if (boundary.unconfirmedHotbarSlots.has(slot)) {
      throw worldActionDenied(
        'quick-bar slot has an unconfirmed inventory mutation',
        'set quick-bar slot',
      );
    }
    invocation.clientStateCapability = { type: 'held_item_slot', slot, used: false };
    return original.apply(receiver, [slot, ...args.slice(1)]);
  });

  wrapWorldActionMethod(bot, boundary, 'setControlState', (original, receiver, args, invocation) => {
    const [control, enabled] = args;
    if (typeof control !== 'string' || typeof enabled !== 'boolean') {
      throw worldActionDenied('control-state transition is malformed', 'set control state');
    }
    if (enabled && MOVEMENT_CONTROLS.has(control)) {
      requireCachedMovementProtection(
        boundary,
        'set control state',
        'movement/collision/redstone mutation',
      );
    }
    invocation.clientStateCapability = {
      type: 'control_state',
      control,
      enabled,
      used: false,
    };
    return original.apply(receiver, args);
  });

  for (const name of ['wake', 'elytraFly']) {
    wrapWorldActionMethod(bot, boundary, name, (original, receiver, args, invocation) => {
      invocation.clientStateCapability = { type: name, used: false };
      return original.apply(receiver, args);
    });
  }

  wrapWorldActionMethod(bot, boundary, 'clickWindow', async (original, receiver, args, invocation) => {
    try {
      const [slot, mouseButton, mode] = args.map(Number);
      const window = bot.currentWindow || bot.inventory;
      const id = Number(window?.id);
      if (!window || !Number.isInteger(id) || !Number.isInteger(slot)
        || !Array.isArray(window.slots)
        || slot < 0 || slot >= window.slots.length
        || (mouseButton !== 0 && mouseButton !== 1)
        || mode !== 0) {
        throw worldActionDenied('window-click capability is malformed', 'click window');
      }
      invocation.windowClickCapability = {
        window,
        id,
        slot,
        mouseButton,
        mode,
        slotsBefore: snapshotWindowSlots(window),
        used: false,
        mutationEpoch: null,
      };
      return await original.apply(receiver, [slot, mouseButton, mode, ...args.slice(3)]);
    } catch (error) {
      if (invocation.windowClickCapability) {
        taintInventoryAuthority(boundary);
      }
      closeDeniedWindow(bot, boundary);
      throw error;
    }
  });

  for (const name of ['transfer', 'putAway', 'moveSlotItem']) {
    wrapWorldActionMethod(bot, boundary, name, async (original, receiver, args, invocation) => {
      const window = name === 'transfer'
        ? (args[0]?.window || bot.currentWindow || bot.inventory)
        : (bot.currentWindow || bot.inventory);
      const operation = `inventory ${name}`;
      const token = beginAuthorizedWindowTransfer(bot, boundary, window, operation);
      invocation.windowTransferCapability = token.capability;
      try {
        return await original.apply(receiver, args);
      } finally {
        finishAuthorizedWindowTransfer(boundary, token);
      }
    });
  }

  wrapWorldActionMethod(bot, boundary, 'closeWindow', (original, receiver, args, invocation) => {
    const window = args[0];
    const id = Number(window?.id);
    if (!window || !Number.isInteger(id)) {
      throw worldActionDenied('close-window identity is unavailable', 'close window');
    }
    invocation.windowCloseCapability = { window, id, used: false };
    return original.apply(receiver, [window, ...args.slice(1)]);
  });

  return boundary;
}

/**
 * Derive an opaque, non-secret world identity from the server-supplied hashed
 * seed in a login/respawn packet. Configuration values are deliberately not
 * accepted here: disposable-world trust must be bound to connection evidence.
 */
export function deriveServerWorldIdentity(packet) {
  const source = packet?.worldState && typeof packet.worldState === 'object'
    ? packet.worldState
    : packet;
  const canonical = canonicalServerHashedSeed(source?.hashedSeed);
  if (!canonical) return null;
  const digest = createHash('sha256')
    .update('mcbot-server-world-identity-v1\0', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
  return `server-hashed-seed-v1:${digest}`;
}

/**
 * Record a server packet observation. This is exported for deterministic
 * protocol fixtures; production reaches it only through the raw client
 * login/respawn listeners installed by installWorldActionBoundary().
 */
export function observeServerWorldIdentity(bot, ctx = {}, packet, eventName = 'login') {
  const record = observedWorldIdentityRecord(bot, true);
  const boundary = bot?.[WORLD_ACTION_BOUNDARY] || null;
  const state = stateForBoundaryContext(ctx) || stateForBoundaryContext(boundary?.context);
  const identity = deriveServerWorldIdentity(packet);
  if (!record) {
    if (state) revokeDisposableTrust(state, 'server world identity storage is unavailable', bot);
    return { ok: false, identity: null, reason: 'server world identity storage is unavailable' };
  }

  if (!identity) {
    revokeObservedWorldIdentity(
      bot,
      state,
      boundary,
      record,
      `${eventName} packet omitted a valid server hashed-seed identity`,
    );
    return { ok: false, identity: null, reason: record.reason };
  }
  if (record.identity && record.identity !== identity) {
    revokeObservedWorldIdentity(
      bot,
      state,
      boundary,
      record,
      `server world identity changed during the connection (${eventName})`,
    );
    return { ok: false, identity, reason: record.reason };
  }
  if (record.revoked) return { ok: false, identity, reason: record.reason };

  record.identity = identity;
  record.source = eventName;
  if (state) bindObservedIdentityToState(bot, state, boundary, record);
  return record.revoked
    ? { ok: false, identity, reason: record.reason }
    : { ok: true, identity, reason: null };
}

function isEntityContainerTarget(target) {
  return target?.constructor?.name === 'Entity'
    || (
      Number.isInteger(target?.id)
      && Array.isArray(target?.metadata)
      && Array.isArray(target?.equipment)
    );
}

export function registerBotPlacedAnchor() {
  // Compatibility-only fail-closed shim. Callers cannot assert ownership from
  // a local observation; use an authenticated operator anchor, or wait for a
  // future actor-bound server placement receipt implementation.
  return null;
}

export function revokeWorldActionAnchor(bot, ctx, blockName, position) {
  const kind = anchorKindForBlock(blockName);
  const state = worldActionAuthorizationFromContext(ctx);
  if (!kind || !state || !finitePosition(position)) return 0;
  observeWorldActionSession(bot, ctx, state);
  const dimension = currentDimension(bot);
  const worldIdentity = currentAnchorScopeIdentity(bot, ctx, state);
  const before = state.anchors.length;
  state.anchors = state.anchors.filter((anchor) => !(
    anchor.kind === kind
    && samePosition(anchor.position, position)
    && dimensionMatches(anchor.dimension, dimension)
    && anchor.worldIdentity === worldIdentity
    && (anchor.provenance !== 'bot_placed_current_session' || anchor.sessionIdentity === state.sessionIdentity)
  ));
  return before - state.anchors.length;
}

export function authorizeStorageAccess(bot, ctx, position, opts = {}) {
  return authorizeAnchoredWorldAction(bot, ctx, WORLD_ANCHOR_KIND.STORAGE, position, opts);
}

export function authorizeWorkstationAccess(bot, ctx, position, opts = {}) {
  return authorizeAnchoredWorldAction(bot, ctx, WORLD_ANCHOR_KIND.WORKSTATION, position, opts);
}

/**
 * Breaking an interactive anchor is access to it, not ordinary resource
 * excavation. Every other natural block keeps the excavation policy.
 */
export function authorizeBlockBreak(bot, ctx, blockOrPosition, opts = {}) {
  const position = blockOrPosition?.position || blockOrPosition;
  const blockName = normalizeBlockName(opts.blockName || blockOrPosition?.name);
  const kind = anchorKindForBlock(blockName);
  if (kind === WORLD_ANCHOR_KIND.STORAGE) {
    return authorizeStorageAccess(bot, ctx, position, { ...opts, blockName });
  }
  if (kind === WORLD_ANCHOR_KIND.WORKSTATION) {
    return authorizeWorkstationAccess(bot, ctx, position, { ...opts, blockName });
  }
  return authorizeExcavation(bot, ctx, position, opts);
}

/**
 * Natural-resource excavation remains allowed. The security boundary for digs
 * is the exact, final do-not-touch check at the destructive sink.
 */
export function authorizeExcavation(bot, ctx, position, opts = {}) {
  if (!finitePosition(position)) {
    return { ok: false, action: 'deny', reason: 'excavation target is unavailable' };
  }
  const protectedResult = doNotTouchDecision(ctx, position, opts);
  if (!protectedResult.ok) return protectedResult;
  return {
    ok: true,
    action: 'allow',
    reason: 'unprotected excavation target',
    position: positionRecord(position),
  };
}

export function authorizePlacement(bot, ctx, position, opts = {}) {
  return authorizePlacementWithCurrentReference(bot, ctx, position, opts);
}

function authorizePlacementWithCurrentReference(bot, ctx, position, opts = {}, suppliedReference = null) {
  if (!finitePosition(position)) {
    return { ok: false, action: 'deny', reason: 'placement target is unavailable' };
  }
  const protectedResult = doNotTouchDecision(ctx, position, opts);
  if (!protectedResult.ok) return protectedResult;
  if (opts.referencePosition) {
    const referenceResult = doNotTouchDecision(ctx, opts.referencePosition, opts);
    if (!referenceResult.ok) {
      return {
        ...referenceResult,
        reason: `placement reference is protected: ${referenceResult.reason}`,
      };
    }
    const referenceBlock = suppliedReference || readCurrentReferenceBlock(bot, opts.referencePosition);
    if (referenceBlock.error) {
      return {
        ok: false,
        action: 'deny',
        reason: `placement reference could not be verified: ${referenceBlock.error.message || String(referenceBlock.error)}`,
      };
    }
    if (!samePosition(referenceBlock.position || opts.referencePosition, opts.referencePosition)) {
      return {
        ok: false,
        action: 'deny',
        reason: 'placement reference does not match the verified live block',
      };
    }
    const referenceKind = anchorKindForBlock(referenceBlock.name);
    if (referenceKind) {
      const referenceAccess = authorizeAnchoredWorldAction(
        bot,
        ctx,
        referenceKind,
        opts.referencePosition,
        { ...opts, blockName: referenceBlock.name },
      );
      if (!referenceAccess.ok) {
        return {
          ...referenceAccess,
          reason: `placement reference access denied: ${referenceAccess.reason}`,
        };
      }
    }
  }
  return {
    ok: true,
    action: 'allow',
    reason: 'unprotected placement target',
    position: positionRecord(position),
  };
}

function readCurrentReferenceBlock(bot, position) {
  const current = currentActionBlock(bot, position);
  if (current.error) return { error: current.error };
  return current;
}

function requireCurrentActionBlock(bot, blockOrPosition, operation) {
  const current = currentActionBlock(bot, blockOrPosition);
  if (current.error) {
    throw worldActionDenied(
      `current block could not be verified: ${current.error.message || String(current.error)}`,
      operation,
    );
  }
  return current;
}

function currentActionBlock(bot, blockOrPosition) {
  const requestedPosition = blockOrPosition?.position || blockOrPosition;
  if (!finitePosition(requestedPosition)) {
    return { error: new Error('target position is unavailable') };
  }
  if (typeof bot?.blockAt !== 'function') {
    return { error: new Error('live block query is unavailable') };
  }

  let block;
  try {
    block = bot.blockAt(requestedPosition);
  } catch (error) {
    return { error };
  }
  if (!block) return { error: new Error('target block is unavailable or unloaded') };
  if (!finitePosition(block.position)) {
    return { error: new Error('live block position is unavailable') };
  }
  if (!samePosition(block.position, requestedPosition)) {
    return { error: new Error('live block position does not match the requested target') };
  }
  const name = normalizeBlockName(block.name);
  if (!name) return { error: new Error('live block type is unavailable') };
  return {
    block,
    name,
    position: positionRecord(block.position),
  };
}

function requireCurrentAnchorFootprint(bot, ctx, current, operation, expected = {}) {
  const kind = anchorKindForBlock(current.name);
  if (!kind) throw worldActionDenied('container type is unavailable or unsupported', operation);
  if (expected.kind && kind !== expected.kind) {
    throw worldActionDenied(`current block is not the expected ${expected.kind}`, operation);
  }
  if (expected.blockName && current.name !== expected.blockName) {
    throw worldActionDenied('current anchor type changed after opening', operation);
  }

  const footprint = chestAnchorFootprint(bot, current, operation);
  for (const member of footprint) {
    const decision = kind === WORLD_ANCHOR_KIND.WORKSTATION
      ? authorizeWorkstationAccess(bot, ctx, member.position, { blockName: member.name })
      : authorizeStorageAccess(bot, ctx, member.position, { blockName: member.name });
    requireWorldAction(decision, operation);
  }
  return {
    kind,
    position: current.position,
    blockName: current.name,
    footprint: footprint.map((member) => ({
      position: positionRecord(member.position),
      blockName: member.name,
    })),
  };
}

function chestAnchorFootprint(bot, current, operation) {
  if (current.name !== 'chest' && current.name !== 'trapped_chest') return [current];
  const properties = currentBlockProperties(current.block);
  if (properties.error) {
    throw worldActionDenied(`chest properties could not be verified: ${properties.error.message}`, operation);
  }
  const type = normalizeBlockName(properties.value.type);
  const facing = normalizeBlockName(properties.value.facing);
  if (!['single', 'left', 'right'].includes(type) || !['north', 'south', 'east', 'west'].includes(facing)) {
    throw worldActionDenied('chest type or facing is malformed', operation);
  }
  if (type === 'single') return [current];

  const partnerPosition = adjacentChestPosition(current.position, facing, type);
  if (!partnerPosition) throw worldActionDenied('double-chest partner position is unavailable', operation);
  const partner = requireCurrentActionBlock(bot, partnerPosition, operation);
  if (partner.name !== current.name) {
    throw worldActionDenied('double-chest partner type does not match', operation);
  }
  const partnerProperties = currentBlockProperties(partner.block);
  if (partnerProperties.error) {
    throw worldActionDenied(`double-chest partner properties could not be verified: ${partnerProperties.error.message}`, operation);
  }
  const partnerType = normalizeBlockName(partnerProperties.value.type);
  const partnerFacing = normalizeBlockName(partnerProperties.value.facing);
  const expectedPartnerType = type === 'left' ? 'right' : 'left';
  if (partnerType !== expectedPartnerType || partnerFacing !== facing) {
    throw worldActionDenied('double-chest partner state does not match', operation);
  }
  return [current, partner];
}

function currentBlockProperties(block) {
  if (typeof block?.getProperties !== 'function') {
    return { error: new Error('block property query is unavailable') };
  }
  try {
    const value = block.getProperties();
    if (!value || typeof value !== 'object') {
      return { error: new Error('block properties are unavailable') };
    }
    return { value };
  } catch (error) {
    return { error };
  }
}

function adjacentChestPosition(position, facing, type) {
  const right = {
    north: { x: 1, z: 0 },
    south: { x: -1, z: 0 },
    west: { x: 0, z: -1 },
    east: { x: 0, z: 1 },
  }[facing];
  if (!right) return null;
  const scale = type === 'left' ? 1 : -1;
  return {
    x: Number(position.x) + right.x * scale,
    y: Number(position.y),
    z: Number(position.z) + right.z * scale,
  };
}

function prepareWindowOpenInvocation(boundary, invocation, access, bot) {
  if (boundary.containerProvenanceTainted) {
    throw worldActionDenied(
      'container provenance is tainted until the connection is reset',
      invocation.entry.name,
    );
  }
  const parent = activeWindowOpenInvocations(invocation.parent)[0] || null;
  requireNoUnboundedBlockMutationProtectionRisk(
    boundary.context,
    invocation.entry.name,
    'container open/redstone mutation',
  );
  if ((access?.footprint || []).some(
    (member) => normalizeBlockName(member?.blockName) === 'trapped_chest',
  )) {
    throw worldActionDenied(
      'trapped-chest open effects cannot be bounded in Phase 1',
      invocation.entry.name,
    );
  }
  requireSafeContainerMutationNeighborhood(bot, access, invocation.entry.name);
  if ((access?.footprint || []).some(
    (member) => AUTONOMOUS_OUTPUT_CONTAINERS.has(normalizeBlockName(member?.blockName)),
  )) {
    throw worldActionDenied(
      'autonomous container input/output provenance cannot be proven in Phase 1',
      invocation.entry.name,
    );
  }
  invocation.windowOpenToken = parent?.windowOpenToken || Object.freeze({});
  invocation.windowProvenanceEpoch = boundary.containerProvenanceEpoch;
  invocation.windowExpectedAccess = access;
  invocation.windowUseCapability = requireSafeWindowOpenUseCapability(
    bot,
    boundary,
    invocation.entry.name,
  );
}

function bindAuthorizedWindow(boundary, bot, window, pending) {
  const id = Number(window?.id);
  if (!window || (typeof window !== 'object' && typeof window !== 'function') || !Number.isInteger(id) || id <= 0) {
    throw worldActionDenied('opened block window identity is unavailable', 'open window');
  }
  if (typeof window.type !== 'string' || !window.type.trim()) {
    closeDeniedWindow(bot, boundary);
    throw worldActionDenied('opened block window type is unavailable', 'open window');
  }
  if (!pending?.token
    || !Number.isSafeInteger(pending.provenanceEpoch)
    || pending.provenanceEpoch !== boundary.containerProvenanceEpoch) {
    closeDeniedWindow(bot, boundary);
    throw worldActionDenied(
      'window provenance changed during the block-open attempt',
      'open window',
    );
  }
  if (isEntityBackedWindow(window)) {
    closeDeniedWindow(bot, boundary);
    throw worldActionDenied(
      'entity-backed window cannot inherit block-open authorization',
      'open window',
    );
  }
  if (!Number.isFinite(pending.expiresAt) || Date.now() > pending.expiresAt) {
    taintContainerProvenance(boundary);
    closeDeniedWindow(bot, boundary);
    throw worldActionDenied('block-open authorization expired before the window opened', 'open window');
  }
  if (bot.currentWindow !== window) {
    closeDeniedWindow(bot, boundary);
    throw worldActionDenied('opened block window is not the current window', 'open window');
  }
  boundary.windowAccess = {
    window,
    id,
    provenance: 'block',
    access: pending.access,
    token: pending.token,
    provenanceEpoch: pending.provenanceEpoch,
  };
}

function requireEventBoundWindow(boundary, bot, window, invocation, operation) {
  const binding = boundary.windowAccess;
  if (!invocation.windowOpenToken
    || invocation.windowProvenanceEpoch !== boundary.containerProvenanceEpoch
    || binding?.token !== invocation.windowOpenToken
    || binding.provenanceEpoch !== invocation.windowProvenanceEpoch
    || binding.window !== window
    || binding.id !== Number(window?.id)
    || bot.currentWindow !== window
    || !sameWindowAccessTarget(binding.access, invocation.windowExpectedAccess)) {
    taintContainerProvenance(boundary);
    closeDeniedWindow(bot, boundary);
    throw worldActionDenied(
      'returned window was not bound by this packet-authorized windowOpen transition',
      operation,
    );
  }
  bindAuthorizedWindowTransferMethods(bot, boundary, window);
}

/**
 * Mineflayer 4.37.1 implements window.withdraw/deposit through a lexical
 * transfer() helper which in turn calls a lexical clickWindow(). Those clicks
 * never enter bot.clickWindow, so the raw packet boundary needs a capability
 * issued by the exact event-bound window method rather than an unsafe blanket
 * exception for transfer packets.
 */
function bindAuthorizedWindowTransferMethods(bot, boundary, window) {
  if (!window || (typeof window !== 'object' && typeof window !== 'function')) return;
  let transferBoundary = window[AUTHORIZED_WINDOW_TRANSFER_BOUNDARY];
  if (!transferBoundary) {
    transferBoundary = { methods: new Map() };
    Object.defineProperty(window, AUTHORIZED_WINDOW_TRANSFER_BOUNDARY, {
      value: transferBoundary,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }

  for (const name of ['withdraw', 'deposit']) {
    const current = window[name];
    const installed = transferBoundary.methods.get(name);
    if (installed?.wrapper === current) continue;
    if (typeof current !== 'function') continue;

    const entry = installed || { name, delegate: null, wrapper: null };
    entry.delegate = current;
    if (!entry.wrapper) {
      entry.wrapper = async function authorizedWindowTransfer(...args) {
        const liveWindow = this;
        const operation = `window ${entry.name}`;
        if (liveWindow !== window) {
          throw worldActionDenied('window-transfer identity is unavailable', operation);
        }
        const itemType = Number(args[0]);
        const requestedCount = args[2] == null ? 1 : Number(args[2]);
        if (!Number.isInteger(itemType)
          || !Number.isSafeInteger(requestedCount)
          || requestedCount <= 0
          || !Number.isInteger(liveWindow.inventoryStart)
          || !Number.isInteger(liveWindow.inventoryEnd)
          || liveWindow.inventoryStart < 0
          || liveWindow.inventoryEnd <= liveWindow.inventoryStart
          || !Array.isArray(liveWindow.slots)
          || liveWindow.inventoryEnd > liveWindow.slots.length) {
          throw worldActionDenied('window-transfer parameters are malformed', operation);
        }

        const parent = WORLD_ACTION_INVOCATION.getStore() || null;
        const token = beginAuthorizedWindowTransfer(bot, boundary, liveWindow, operation);
        token.capability.method = entry.name;
        const frame = {
          entry: { name: `window.${entry.name}`, family: 'window_transfer' },
          delegate: { fn: entry.delegate, previous: null },
          args,
          parent,
          delegatedToBoundary: false,
          windowTransferCapability: token.capability,
        };
        try {
          return await WORLD_ACTION_INVOCATION.run(
            frame,
            () => entry.delegate.apply(liveWindow, args),
          );
        } finally {
          finishAuthorizedWindowTransfer(boundary, token);
        }
      };
    }
    transferBoundary.methods.set(name, entry);
    window[name] = entry.wrapper;
  }

  // Mineflayer's event-bound window.close uses a lexical closeWindow helper,
  // so it does not enter the wrapped bot.closeWindow method. Bind that exact
  // window method to the same one-use capability instead of granting raw
  // close_window packets globally.
  const currentClose = window.close;
  const installedClose = transferBoundary.methods.get('close');
  if (installedClose?.wrapper !== currentClose && typeof currentClose === 'function') {
    const entry = installedClose || { name: 'close', delegate: null, wrapper: null };
    entry.delegate = currentClose;
    if (!entry.wrapper) {
      entry.wrapper = function authorizedEventBoundWindowClose(...args) {
        const liveWindow = this;
        if (liveWindow !== window
          || liveWindow !== bot.currentWindow
          || Number(liveWindow?.id) !== Number(boundary.windowAccess?.id)) {
          throw worldActionDenied('event-bound window close identity is stale', 'close window');
        }
        const parent = WORLD_ACTION_INVOCATION.getStore() || null;
        const frame = {
          entry: { name: 'closeWindow', family: 'window_close' },
          delegate: { fn: entry.delegate, previous: null },
          args: [liveWindow, ...args],
          parent,
          delegatedToBoundary: false,
          windowCloseCapability: {
            window: liveWindow,
            id: Number(liveWindow.id),
            used: false,
          },
        };
        return WORLD_ACTION_INVOCATION.run(
          frame,
          () => entry.delegate.apply(liveWindow, args),
        );
      };
    }
    transferBoundary.methods.set('close', entry);
    window.close = entry.wrapper;
  }
}

function beginAuthorizedWindowTransfer(bot, boundary, window, operation) {
  const id = Number(window?.id);
  if (!window
    || !Number.isInteger(id)
    || !Array.isArray(window.slots)
    || boundary.activeWindowTransferToken) {
    throw worldActionDenied(
      boundary.activeWindowTransferToken
        ? 'concurrent window transfers are not authorized'
        : 'window-transfer identity or slot state is unavailable',
      operation,
    );
  }
  if (id === 0) {
    if (bot.currentWindow || window !== bot.inventory) {
      throw worldActionDenied('player-inventory transfer identity is stale', operation);
    }
  } else {
    requireNoUnboundedBlockMutationProtectionRisk(
      boundary.context,
      operation,
      'container mutation',
    );
    requireAuthorizedCurrentBlockWindow(
      bot,
      boundary,
      { windowId: id },
      { operation, windowIdKeys: ['windowId'] },
      id,
    );
  }
  const token = {
    capability: {
      window,
      id,
      method: operation,
      slotsBefore: snapshotWindowSlots(window),
      clickCount: 0,
    },
  };
  boundary.activeWindowTransferToken = token;
  return token;
}

function finishAuthorizedWindowTransfer(boundary, token) {
  if (boundary.activeWindowTransferToken === token) {
    boundary.activeWindowTransferToken = null;
  }
}

function finishWindowOpenInvocation(boundary, bot, token, completed) {
  if (token && boundary.pendingWindowAccess?.token === token) {
    taintContainerProvenance(boundary);
    closeDeniedWindow(bot, boundary);
    return;
  }
  if (!completed && token && boundary.windowAccess?.token === token) {
    closeDeniedWindow(bot, boundary);
  }
}

function sameWindowAccessTarget(actual, expected) {
  if (!actual || !expected
    || actual.kind !== expected.kind
    || normalizeBlockName(actual.blockName) !== normalizeBlockName(expected.blockName)
    || !samePosition(actual.position, expected.position)) {
    return false;
  }
  if (Array.isArray(actual.footprint) || Array.isArray(expected.footprint)) {
    return sameAnchorFootprint(actual.footprint, expected.footprint);
  }
  return true;
}

function activeWindowOpenInvocations(frame) {
  const invocations = [];
  for (let current = frame; current; current = current.parent) {
    if (WINDOW_OPEN_METHODS.has(current.entry.name)
      && (current.entry.name !== 'craft' || Boolean(current.args?.[2]))) {
      invocations.push(current);
    }
  }
  return invocations;
}

function bindAuthorizedWindowLifecycle(bot, boundary) {
  if (boundary.windowLifecycleBound || typeof bot?.on !== 'function') return;
  boundary.windowLifecycleBound = true;
  bot.on('windowOpen', (window) => {
    const pending = boundary.pendingWindowAccess;
    boundary.pendingWindowAccess = null;
    if (!pending) {
      // Spontaneous and entity-backed windows have no block anchor or code-owned
      // ownership proof. Close them before any click can be attempted, including
      // HorseWindow events.
      closeDeniedWindow(bot, boundary);
      return;
    }
    try {
      bindAuthorizedWindow(boundary, bot, window, pending);
    } catch {
      taintContainerProvenance(boundary);
      closeDeniedWindow(bot, boundary);
    }
  });
  bot.on('windowClose', (window) => {
    if (boundary.windowAccess?.window === window) boundary.windowAccess = null;
    if (boundary.pendingWindowAccess) {
      taintContainerProvenance(boundary);
    }
  });
  bot.on('end', () => {
    resetContainerProvenance(boundary);
    releaseMovementProtectionTracking(boundary, 'world connection ended');
  });
  bot.on('kicked', () => {
    resetContainerProvenance(boundary);
    releaseMovementProtectionTracking(boundary, 'world connection kicked');
  });
}

function bindObservedWorldIdentityLifecycle(bot, boundary) {
  const client = bot?._client;
  if (!client || (typeof client.on !== 'function' && typeof client.prependListener !== 'function')) return;
  if (boundary.worldIdentityLifecycleClient === client) return;

  const previousClient = boundary.worldIdentityLifecycleClient;
  const previousListeners = boundary.worldIdentityLifecycleListeners;
  if (previousClient && previousClient !== client) {
    previousClient.removeListener?.('login', previousListeners?.login);
    previousClient.removeListener?.('respawn', previousListeners?.respawn);
    const record = observedWorldIdentityRecord(bot, true);
    const state = stateForBoundaryContext(boundary.context);
    if (record) {
      revokeObservedWorldIdentity(
        bot,
        state,
        boundary,
        record,
        'raw protocol client changed during the world-action session',
      );
    } else if (state) {
      revokeDisposableTrust(state, 'raw protocol client changed during the world-action session', bot);
    }
  }

  const listeners = {
    login: (packet) => observeServerWorldIdentity(bot, boundary.context, packet, 'login'),
    respawn: (packet) => observeServerWorldIdentity(bot, boundary.context, packet, 'respawn'),
  };
  const add = typeof client.prependListener === 'function'
    ? client.prependListener.bind(client)
    : client.on.bind(client);
  add('login', listeners.login);
  add('respawn', listeners.respawn);
  boundary.worldIdentityLifecycleClient = client;
  boundary.worldIdentityLifecycleListeners = listeners;
}

function bindAuthoritativeClientStateLifecycle(bot, boundary) {
  const client = bot?._client;
  if (!client || (typeof client.on !== 'function' && typeof client.prependListener !== 'function')) return;
  if (boundary.clientStateLifecycleClient === client) return;

  const previousClient = boundary.clientStateLifecycleClient;
  const previousListeners = boundary.clientStateLifecycleListeners;
  if (previousClient && previousClient !== client) {
    for (const [event, listener] of Object.entries(previousListeners || {})) {
      previousClient.removeListener?.(event, listener);
    }
    boundary.clientState = initialAuthoritativeClientState(bot, { failClosed: true });
    boundary.itemStateCoherent = false;
    boundary.pendingItemMutation = null;
  }

  const noteInventoryReadback = (event, packet) => {
    if (packet?.accepted === false) return;
    const incomingStateId = Number(packet?.stateId);
    if (Number.isInteger(incomingStateId)
      && (!Number.isInteger(boundary.latestInventoryStateId)
        || incomingStateId > boundary.latestInventoryStateId)) {
      boundary.latestInventoryStateId = incomingStateId;
    }
    observeConfirmedHotbarReadback(bot, boundary, event, packet, incomingStateId);
    const pending = boundary.pendingItemMutation;
    if (!pending) {
      if (event === 'window_items'
        && Number(packet?.windowId) === 0
        && Array.isArray(packet?.items)) {
        const observedEpoch = boundary.itemMutationEpoch;
        queueMicrotask(() => {
          if (boundary.itemMutationEpoch === observedEpoch && !boundary.pendingItemMutation) {
            boundary.itemStateCoherent = true;
          }
        });
      }
      return;
    }
    if (event === 'set_slot') {
      if (Number.isInteger(pending.afterStateId)
        && (!Number.isInteger(incomingStateId) || incomingStateId <= pending.afterStateId)) return;
      if (!(pending.requiredLocations instanceof Set)) return;
      const windowId = Number(packet?.windowId ?? packet?.window_id);
      const location = Number(packet?.slot);
      const sameWindow = windowId === pending.windowId
        || (pending.windowId === 0 && windowId === -2);
      if (!sameWindow || !pending.requiredLocations.has(location)) return;
      pending.requiredLocations.delete(location);
      if (pending.requiredLocations.size > 0) return;
    } else if (event === 'transaction') {
      const windowId = Number(packet?.windowId);
      const action = Number(packet?.action);
      if (windowId !== pending.windowId
        || packet?.accepted !== true
        || !Number.isInteger(pending.expectedAction)
        || action !== pending.expectedAction) return;
    } else if (event === 'window_items') {
      if (Number.isInteger(pending.afterStateId)
        && (!Number.isInteger(incomingStateId) || incomingStateId <= pending.afterStateId)) return;
      const windowId = Number(packet?.windowId);
      const items = packet?.items;
      if (windowId !== pending.windowId || !Array.isArray(items)) return;
      if (pending.requiredLocations instanceof Set
        && [...pending.requiredLocations].some((location) => location < 0 || location >= items.length)) return;
    } else {
      return;
    }
    queueMicrotask(() => {
      if (boundary.pendingItemMutation !== pending
        || pending.epoch !== boundary.itemMutationEpoch) return;
      boundary.itemStateCoherent = true;
      boundary.pendingItemMutation = null;
    });
  };
  const listeners = {
    held_item_slot: (packet) => {
      const slot = Number(packet?.slot ?? packet?.slotId);
      if (isQuickBarSlot(slot)) boundary.clientState.selectedHotbarSlot = slot;
      else boundary.clientState.selectedHotbarSlot = null;
    },
    set_slot: (packet) => noteInventoryReadback('set_slot', packet),
    window_items: (packet) => noteInventoryReadback('window_items', packet),
    transaction: (packet) => noteInventoryReadback('transaction', packet),
    position: () => queueMicrotask(() => {
      const observed = initialAuthoritativeClientState(bot);
      if (observed.pose) boundary.clientState.pose = observed.pose;
    }),
    player_rotation: () => queueMicrotask(() => {
      const observed = initialAuthoritativeClientState(bot);
      if (observed.pose) boundary.clientState.pose = observed.pose;
    }),
  };
  const add = typeof client.prependListener === 'function'
    ? client.prependListener.bind(client)
    : client.on.bind(client);
  for (const [event, listener] of Object.entries(listeners)) add(event, listener);
  boundary.clientStateLifecycleClient = client;
  boundary.clientStateLifecycleListeners = listeners;
}

function isEntityBackedWindow(window) {
  const type = typeof window?.type === 'string'
    ? window.type.trim().toLowerCase()
    : '';
  return type === 'horsewindow'
    || type === 'horse'
    || type === 'entityhorse'
    || type.endsWith(':horse')
    || type === 'minecraft:merchant'
    || type === 'minecraft:villager';
}

function installWorldActionPacketBoundary(bot, boundary) {
  const client = bot?._client;
  if (!client || typeof client.write !== 'function') return;
  let entry = client[WORLD_ACTION_PACKET_BOUNDARY];
  if (!entry) {
    entry = {
      bot,
      boundary,
      delegate: client.write,
      wrapper: null,
      rawDelegate: typeof client.writeRaw === 'function' ? client.writeRaw : null,
      rawWrapper: null,
      authorizedRawWriteDepth: 0,
      authorizedRawWriteRemaining: 0,
    };
    entry.wrapper = function authorizedPacketWrite(name, packet, ...rest) {
      let outcome;
      try {
        outcome = authorizeOutboundWorldPacket(entry.bot, entry.boundary, name, packet);
      } catch (error) {
        if (WINDOW_MUTATION_PACKETS.has(name)) {
          if (name === 'window_click') taintInventoryAuthority(entry.boundary);
          closeDeniedWindow(entry.bot, entry.boundary);
        }
        throw error;
      }
      if (outcome?.suppress === true) return undefined;
      entry.authorizedRawWriteDepth += 1;
      entry.authorizedRawWriteRemaining = 1;
      try {
        const result = entry.delegate.call(this, name, packet, ...rest);
        outcome?.afterWrite?.();
        return result;
      } catch (error) {
        // Mineflayer applies clickWindow's optimistic local slot mutation
        // before writing the packet. Any rejected/failed physical write leaves
        // the client inventory potentially divergent from the server, so no
        // held-item or later window authority may survive until readback.
        if (name === 'window_click') {
          taintInventoryAuthority(entry.boundary);
          closeDeniedWindow(entry.bot, entry.boundary);
        }
        throw error;
      } finally {
        entry.authorizedRawWriteDepth -= 1;
        entry.authorizedRawWriteRemaining = 0;
      }
    };
    entry.rawWrapper = function authorizedRawPacketWrite(buffer, ...rest) {
      // In pinned minecraft-protocol 1.54.x, Client.write serializes through
      // its serializer stream and never calls writeRaw. Keep a one-shot token
      // for a future synchronous internal handoff, but direct/plugin writeRaw
      // calls never receive authority and therefore fail closed.
      if (entry.authorizedRawWriteDepth <= 0
        || entry.authorizedRawWriteRemaining !== 1
        || !Buffer.isBuffer(buffer)
        || typeof entry.rawDelegate !== 'function') {
        closeDeniedWindow(entry.bot, entry.boundary);
        throw worldActionDenied(
          'raw framed packet bytes lack an active authorized typed-packet handoff',
          'raw packet bytes',
        );
      }
      entry.authorizedRawWriteRemaining = 0;
      return entry.rawDelegate.call(this, buffer, ...rest);
    };
    Object.defineProperty(client, WORLD_ACTION_PACKET_BOUNDARY, {
      value: entry,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    client.write = entry.wrapper;
    if (entry.rawDelegate) client.writeRaw = entry.rawWrapper;
    return;
  }

  entry.bot = bot;
  entry.boundary = boundary;
  if (client.write !== entry.wrapper && typeof client.write === 'function') {
    entry.delegate = client.write;
    client.write = entry.wrapper;
  }
  if (entry.rawWrapper && client.writeRaw !== entry.rawWrapper) {
    // Never adopt a later raw-byte writer as trusted. The initially captured
    // minecraft-protocol sink is the only possible delegate.
    client.writeRaw = entry.rawWrapper;
  }
}

function closeDeniedWindow(bot, boundary) {
  const window = bot?.currentWindow || boundary.windowAccess?.window || null;
  const windowWasCurrent = bot?.currentWindow === window;
  if (boundary.pendingWindowAccess) {
    // Once the interaction packet has been sent, clearing its pending token is
    // an abandonment. A delayed, positionless open_window response must never
    // be eligible for a later logical open on this connection.
    taintContainerProvenance(boundary);
  }
  boundary.windowAccess = null;
  boundary.pendingWindowAccess = null;
  if (!window) return;
  if (boundary.closingDeniedWindow) {
    if (bot.currentWindow === window) bot.currentWindow = null;
    return;
  }
  boundary.closingDeniedWindow = true;
  let closeHandledSynchronously = false;
  try {
    // A physical close with a cursor item can drop that item into the world.
    // Quarantine the server-side window and perform only local cleanup instead.
    if (window.selectedItem) {
      taintContainerProvenance(boundary);
    } else if (typeof bot?.closeWindow === 'function') {
      const closeResult = bot.closeWindow(window);
      if (closeResult && typeof closeResult.then === 'function') {
        // Cleanup is deliberately synchronous and bounded. Attach a terminal
        // rejection handler immediately, but never await an unknown decorator.
        // Until the connection resets, an asynchronous close is not accepted
        // as proof that the server-side window actually closed.
        taintContainerProvenance(boundary);
        void Promise.resolve(closeResult).catch(() => {});
      } else if (windowWasCurrent && bot.currentWindow !== window) {
        // Mineflayer's synchronous close path already cleared and emitted.
        closeHandledSynchronously = true;
      } else {
        // A synchronous return without the expected local transition is not a
        // receipt that the server accepted the close.
        taintContainerProvenance(boundary);
      }
    } else {
      taintContainerProvenance(boundary);
    }
  } catch {
    // The server-side window may still be open. Quarantine its provenance and
    // fall through to the minimal local cleanup below.
    taintContainerProvenance(boundary);
  } finally {
    boundary.closingDeniedWindow = false;
  }
  if (closeHandledSynchronously) return;
  if (bot.currentWindow === window) bot.currentWindow = null;
  try {
    window.emit?.('close');
  } catch {
    // Best-effort cleanup must not mask the authorization denial.
  }
  try {
    bot.emit?.('windowClose', window);
  } catch {
    // Best-effort cleanup must not mask the authorization denial.
  }
}

function advanceContainerProvenanceEpoch(boundary) {
  const current = Number.isSafeInteger(boundary.containerProvenanceEpoch)
    ? boundary.containerProvenanceEpoch
    : 0;
  boundary.containerProvenanceEpoch = nextSafeEpoch(current);
}

function nextSafeEpoch(value) {
  const current = Number.isSafeInteger(value) ? value : 0;
  return current >= Number.MAX_SAFE_INTEGER ? 0 : current + 1;
}

function taintContainerProvenance(boundary) {
  advanceContainerProvenanceEpoch(boundary);
  boundary.containerProvenanceTainted = true;
  boundary.windowAccess = null;
  boundary.pendingWindowAccess = null;
}

function taintInventoryAuthority(boundary) {
  boundary.itemMutationEpoch = nextSafeEpoch(boundary.itemMutationEpoch);
  boundary.itemStateCoherent = false;
  boundary.pendingItemMutation = null;
  if (!(boundary.unconfirmedHotbarSlots instanceof Map)) {
    boundary.unconfirmedHotbarSlots = new Map();
  }
  for (let slot = 0; slot < 9; slot += 1) {
    boundary.unconfirmedHotbarSlots.set(slot, null);
  }
}

function resetContainerProvenance(boundary) {
  advanceContainerProvenanceEpoch(boundary);
  boundary.containerProvenanceTainted = false;
  boundary.windowAccess = null;
  boundary.pendingWindowAccess = null;
}

function authorizeOutboundWorldPacket(bot, boundary, name, packet) {
  if (typeof name !== 'string' || !name) {
    throw worldActionDenied('outbound packet name is unavailable', 'raw packet write');
  }
  if (name === 'block_dig') return authorizeOutboundDigPacket(bot, boundary, packet);
  if (name === 'block_place') return authorizeOutboundBlockPlacePacket(bot, boundary, packet);
  if (name === 'use_item') return authorizeOutboundUseItem(bot, boundary, packet);
  if (name === 'use_entity') return authorizeOutboundEntityUse(bot, boundary, packet);
  if (name === 'window_click') return authorizeOutboundWindowClick(bot, boundary, packet);
  if (name === 'close_window') return authorizeOutboundCloseWindow(bot, boundary, packet);
  if (name === 'held_item_slot') return authorizeOutboundHeldItemSlot(bot, boundary, packet);
  if (name === 'entity_action') return authorizeOutboundEntityAction(bot, boundary, packet);
  if (name === 'player_input') return authorizeOutboundPlayerInput(bot, boundary, packet);
  if (name === 'position' || name === 'position_look' || name === 'look' || name === 'flying') {
    return authorizeOutboundPosePacket(bot, boundary, name, packet);
  }
  if (name === 'vehicle_move' || name === 'spectate') {
    throw worldActionDenied('raw teleporting pose transition lacks a capability', 'pose packet');
  }
  if (name === 'enchant_item') {
    return authorizeOutboundAnchoredWindowControl(bot, boundary, packet, {
      operation: 'enchant item packet',
      windowIdKeys: ['windowId'],
      windowType: (type) => type.startsWith('minecraft:enchant'),
      blockNames: new Set(['enchanting_table']),
    });
  }
  if (name === 'name_item') {
    return authorizeOutboundAnchoredWindowControl(bot, boundary, packet, {
      operation: 'name item packet',
      windowType: (type) => /^minecraft:(?:chipped_|damaged_)?anvil$/.test(type),
      blockNames: new Set(['anvil', 'chipped_anvil', 'damaged_anvil']),
    });
  }
  if (name === 'set_beacon_effect') {
    return authorizeOutboundAnchoredWindowControl(bot, boundary, packet, {
      operation: 'beacon effect packet',
      windowType: (type) => type.startsWith('minecraft:beacon'),
      blockNames: new Set(['beacon']),
    });
  }
  if (name === 'craft_recipe_request') {
    const craftFrame = findActiveInvocation(
      WORLD_ACTION_INVOCATION.getStore() || null,
      (candidate) => candidate.entry.name === 'craft',
    );
    if (!craftFrame) {
      throw worldActionDenied('recipe placement lacks an active craft capability', 'craft recipe packet');
    }
    authorizeOutboundPlayerOrAnchoredWindowControl(bot, boundary, packet, {
      operation: 'craft recipe packet',
      windowIdKeys: ['windowId'],
      windowType: (type) => type.startsWith('minecraft:crafting'),
      blockNames: new Set(['crafting_table']),
    });
    return unknownInventoryMutationOutcome(boundary, Number(packet?.windowId));
  }
  if (name === 'set_slot_state') {
    throw worldActionDenied('slot-state mutation lacks a supported capability', 'slot-state packet');
  }
  if (name === 'update_sign') return authorizeOutboundSignUpdate(bot, boundary, packet);
  if (name === 'custom_payload') return authorizeOutboundCustomPayload(packet);
  if (name === 'chat' || name === 'chat_message') return authorizeOutboundChat(packet);
  if (name === 'chat_command' || name === 'chat_command_signed') {
    throw worldActionDenied('raw server commands require a separate authenticated capability', 'chat command packet');
  }
  if (name === 'select_trade') {
    throw worldActionDenied('entity-container ownership cannot be proven', 'select trade packet');
  }
  if (NON_MUTATING_OUTBOUND_PACKETS.has(name)) return null;
  throw worldActionDenied(
    'outbound packet has no explicit non-mutating classification or world-action capability',
    'raw packet write',
  );
}

function unknownInventoryMutationOutcome(boundary, windowId) {
  return {
    afterWrite: () => {
      boundary.itemMutationEpoch = nextSafeEpoch(boundary.itemMutationEpoch);
      boundary.itemStateCoherent = false;
      boundary.pendingItemMutation = {
        epoch: boundary.itemMutationEpoch,
        windowId,
        requiredLocations: null,
        expectedAction: null,
        afterStateId: Number.isInteger(boundary.latestInventoryStateId)
          ? boundary.latestInventoryStateId
          : null,
      };
    },
  };
}

function authorizeOutboundCloseWindow(bot, boundary, packet) {
  const id = Number(packet?.windowId);
  const frame = WORLD_ACTION_INVOCATION.getStore() || null;
  const invocation = findActiveInvocation(
    frame,
    (candidate) => candidate.entry.name === 'closeWindow'
      && candidate.windowCloseCapability?.used !== true,
  );
  const capability = invocation?.windowCloseCapability;
  if (!Number.isInteger(id)
    || !capability
    || capability.id !== id
    || capability.window !== (bot.currentWindow || boundary.windowAccess?.window)) {
    throw worldActionDenied('window close lacks an exact active capability', 'close window packet');
  }
  if (capability.window?.selectedItem) {
    throw worldActionDenied(
      'closing with a cursor item can drop it into the world',
      'close window packet',
    );
  }
  if (id > 0) {
    requireNoUnboundedBlockMutationProtectionRisk(
      boundary.context,
      'close window packet',
      'container close/redstone mutation',
    );
    requireAuthorizedCurrentBlockWindow(
      bot,
      boundary,
      packet,
      { operation: 'close window packet', windowIdKeys: ['windowId'] },
      id,
    );
  }
  capability.used = true;
  boundary.windowAccess = null;
  boundary.pendingWindowAccess = null;
  return null;
}

function authorizeOutboundHeldItemSlot(bot, boundary, packet) {
  if (!Object.hasOwn(packet || {}, 'slotId') && !Object.hasOwn(packet || {}, 'slot')) {
    throw worldActionDenied('held-item selection is unavailable', 'held item slot packet');
  }
  const slot = Number(packet?.slotId ?? packet?.slot);
  const frame = WORLD_ACTION_INVOCATION.getStore() || null;
  const invocation = findActiveInvocation(
    frame,
    (candidate) => candidate.entry.name === 'setQuickBarSlot',
  );
  const capability = invocation?.clientStateCapability;
  if (!isQuickBarSlot(slot)
    || boundary.unconfirmedHotbarSlots.has(slot)
    || capability?.type !== 'held_item_slot'
    || capability.used
    || capability.slot !== slot) {
    throw worldActionDenied(
      'held-item selection lacks an exact active transition capability',
      'held item slot packet',
    );
  }
  capability.used = true;
  return {
    afterWrite: () => {
      boundary.clientState.selectedHotbarSlot = slot;
    },
  };
}

function authorizeOutboundEntityAction(bot, boundary, packet) {
  if (!Number.isInteger(Number(packet?.entityId))
    || Number(packet.entityId) !== Number(bot?.entity?.id)) {
    throw worldActionDenied('entity-action identity does not match the bot', 'entity action packet');
  }
  const action = normalizeEntityAction(packet?.actionId);
  const frame = WORLD_ACTION_INVOCATION.getStore() || null;
  const invocation = findActiveInvocation(frame, (candidate) => {
    const capability = candidate.clientStateCapability;
    if (!capability || capability.used) return false;
    if (action === 'start_sneaking' || action === 'stop_sneaking') {
      return candidate.entry.name === 'setControlState'
        && capability.type === 'control_state'
        && capability.control === 'sneak'
        && capability.enabled === (action === 'start_sneaking');
    }
    if (action === 'start_sprinting' || action === 'stop_sprinting') {
      return candidate.entry.name === 'setControlState'
        && capability.type === 'control_state'
        && capability.control === 'sprint'
        && capability.enabled === (action === 'start_sprinting');
    }
    if (action === 'leave_bed') return candidate.entry.name === 'wake' && capability.type === 'wake';
    if (action === 'start_elytra_flying') {
      return candidate.entry.name === 'elytraFly' && capability.type === 'elytraFly';
    }
    return false;
  });
  if (!action || !invocation) {
    throw worldActionDenied(
      'entity action lacks an exact active state-transition capability',
      'entity action packet',
    );
  }
  if (action === 'start_sprinting' || action === 'start_elytra_flying') {
    requireCachedMovementProtection(
      boundary,
      'entity action packet',
      'movement/environment mutation',
    );
  }
  if (action === 'leave_bed') {
    requireNoUnboundedBlockMutationProtectionRisk(
      boundary.context,
      'entity action packet',
      'bed/environment mutation',
    );
  }
  if (action === 'leave_bed') {
    requireNoRemoteVibrationSensors(
      bot,
      [bot?.entity?.position],
      'entity action packet',
    );
  }
  invocation.clientStateCapability.used = true;
  const sneaking = action === 'start_sneaking'
    ? true
    : (action === 'stop_sneaking' ? false : null);
  return sneaking === null
    ? null
    : { afterWrite: () => { boundary.clientState.sneaking = sneaking; } };
}

function authorizeOutboundPlayerInput(bot, boundary, packet) {
  const inputs = packet?.inputs;
  if (!inputs || typeof inputs !== 'object' || typeof inputs.shift !== 'boolean') {
    throw worldActionDenied('player-input sneak transition is malformed', 'player input packet');
  }
  const unexpected = Object.entries(inputs).some(([key, value]) => key !== 'shift' && Boolean(value));
  const frame = WORLD_ACTION_INVOCATION.getStore() || null;
  const invocation = findActiveInvocation(
    frame,
    (candidate) => candidate.entry.name === 'setControlState'
      && candidate.clientStateCapability?.type === 'control_state'
      && candidate.clientStateCapability.control === 'sneak'
      && candidate.clientStateCapability.enabled === inputs.shift
      && candidate.clientStateCapability.used !== true,
  );
  if (unexpected || !invocation) {
    throw worldActionDenied(
      'player input lacks an exact active sneak-transition capability',
      'player input packet',
    );
  }
  invocation.clientStateCapability.used = true;
  return { afterWrite: () => { boundary.clientState.sneaking = inputs.shift; } };
}

function authorizeOutboundPosePacket(bot, boundary, name, packet) {
  // Phase 1 treats ambient locomotion vibrations around otherwise unmarked,
  // DNT-free automation as outside CAND-014/015/016. Scanning a 16-block
  // volume on every movement packet would create a continuous CPU spike. DNT
  // presence still denies movement globally, and intentional block, item,
  // combat, and window events use the bounded sensor scan below.
  if (name !== 'look') {
    requireCachedMovementProtection(
      boundary,
      'pose packet',
      'movement/collision/redstone mutation',
    );
  }
  const entity = bot?.entity;
  if (!entity || !finitePosition(entity.position) || typeof entity.onGround !== 'boolean') {
    throw worldActionDenied('authoritative local pose is unavailable', 'pose packet');
  }
  if (name !== 'look') requireNoNearbyMovementEntityEffects(bot, entity.position, 'pose packet');
  if (!packetOnGroundMatches(packet, entity.onGround)) {
    throw worldActionDenied('pose packet ground state does not match local physics', 'pose packet');
  }
  const next = { ...boundary.clientState.pose };
  if (name === 'position' || name === 'position_look') {
    if (!samePrecisePosition(packet, entity.position)) {
      throw worldActionDenied('pose packet position does not match local physics', 'pose packet');
    }
    next.x = Number(packet.x);
    next.y = Number(packet.y);
    next.z = Number(packet.z);
  }
  if (name === 'look' || name === 'position_look') {
    const yaw = Number(packet?.yaw);
    const pitch = Number(packet?.pitch);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)
      || !rotationMovesTowardLocal(boundary.clientState.pose, entity, yaw, pitch)) {
      throw worldActionDenied('pose packet look does not converge on local physics', 'pose packet');
    }
    next.yaw = yaw;
    next.pitch = pitch;
  }
  next.onGround = entity.onGround;
  return { afterWrite: () => { boundary.clientState.pose = next; } };
}

function requireNoNearbyMovementEntityEffects(bot, position, operation) {
  if (!bot?.entities || typeof bot.entities !== 'object') return;
  const selfId = Number(bot?.entity?.id);
  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity || Number(entity.id) === selfId) continue;
    if (!finitePosition(entity.position)) {
      throw worldActionDenied('movement-adjacent entity position is unavailable', operation);
    }
    if (Math.abs(Number(entity.position.x) - Number(position.x)) <= 3
      && Math.abs(Number(entity.position.y) - Number(position.y)) <= 3
      && Math.abs(Number(entity.position.z) - Number(position.z)) <= 3) {
      throw worldActionDenied(
        'movement may push or mutate an unowned nearby entity',
        operation,
      );
    }
  }
}

function normalizeEntityAction(value) {
  const byNumber = new Map([
    [0, 'start_sneaking'],
    [1, 'stop_sneaking'],
    [2, 'leave_bed'],
    [3, 'start_sprinting'],
    [4, 'stop_sprinting'],
    [8, 'start_elytra_flying'],
  ]);
  if (typeof value === 'number' && Number.isInteger(value)) return byNumber.get(value) || null;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return new Set(byNumber.values()).has(normalized) ? normalized : null;
}

function authorizeOutboundUseItem(bot, boundary, packet) {
  requireNoUnboundedBlockMutationProtectionRisk(
    boundary.context,
    'use item packet',
    'item-use vibration/teleport/environment mutation',
  );
  requireNoRemoteVibrationSensors(
    bot,
    [bot?.entity?.position],
    'use item packet',
  );
  if (packet?.hand !== 0 && packet?.hand !== 1) {
    throw worldActionDenied('use-item packet hand is malformed', 'use item packet');
  }
  const offHand = packet.hand === 1;
  const itemName = authoritativeActivatedItemName(bot, boundary, offHand);
  if (!itemName) {
    throw worldActionDenied('use-item packet held item is unavailable', 'use item packet');
  }

  const frame = WORLD_ACTION_INVOCATION.getStore() || null;
  const invocation = findActiveInvocation(frame, (candidate) => candidate.entry.name === 'activateItem');
  if (!invocation) {
    if (PASSIVE_RAW_USE_ITEMS.has(itemName)) {
      return STABLE_PASSIVE_USE_ITEMS.has(itemName)
        ? null
        : heldItemMutationOutcome(bot, boundary, packet.hand);
    }
    throw worldActionDenied(
      'raw use-item packet lacks an active item-use capability',
      'use item packet',
    );
  }
  const capability = invocation.itemUseCapability;
  if (!capability
    || capability.hand !== packet.hand
    || capability.offHand !== offHand
    || capability.itemName !== itemName) {
    throw worldActionDenied(
      'use-item packet does not match the active hand and item capability',
      'use item packet',
    );
  }
  if (isWorldMutatingBucket(itemName)) {
    requirePacketAdjacentBucketPose(bot, boundary, packet, 'use item packet');
    const request = requireBucketWorldActionRequest(capability.worldAction, itemName, 'use item packet');
    const current = requireCurrentBucketUseCorrelation(bot, request, 'use item packet');
    authorizeBucketWorldAction(bot, boundary.context, request, current, 'use item packet');
  } else if (!PASSIVE_RAW_USE_ITEMS.has(itemName)) {
    throw worldActionDenied(
      'held item lacks a typed item-use mutation capability',
      'use item packet',
    );
  }
  return STABLE_PASSIVE_USE_ITEMS.has(itemName)
    ? null
    : heldItemMutationOutcome(bot, boundary, packet.hand);
}

function heldItemMutationOutcome(bot, boundary, hand = 0) {
  if (!authoritativeActivatedItemName(bot, boundary, hand === 1)) return null;
  const location = hand === 1
    ? offhandInventorySlot(bot)
    : selectedInventorySlot(bot, boundary);
  return {
    afterWrite: () => {
      boundary.itemMutationEpoch = nextSafeEpoch(boundary.itemMutationEpoch);
      boundary.itemStateCoherent = false;
      boundary.pendingItemMutation = {
        epoch: boundary.itemMutationEpoch,
        windowId: 0,
        requiredLocations: Number.isInteger(location) ? new Set([location]) : null,
        expectedAction: null,
        afterStateId: Number.isInteger(boundary.latestInventoryStateId)
          ? boundary.latestInventoryStateId
          : null,
      };
    },
  };
}

function selectedInventorySlot(bot, boundary) {
  const selected = boundary?.clientState?.selectedHotbarSlot;
  const start = Number.isInteger(bot?.QUICK_BAR_START)
    ? bot.QUICK_BAR_START
    : Number(bot?.inventory?.hotbarStart);
  return Number.isInteger(start) && isQuickBarSlot(selected) ? start + selected : null;
}

function offhandInventorySlot(bot) {
  try {
    const resolved = bot?.getEquipmentDestSlot?.('off-hand');
    if (Number.isInteger(resolved)) return resolved;
  } catch {
    // The standard inventory slot remains the conservative fallback.
  }
  return 45;
}

function requireBucketWorldActionRequest(request, itemName, operation) {
  if (!request || !finitePosition(request.target)) {
    throw worldActionDenied('bucket world-action target is unavailable', operation);
  }
  if (request.kind !== 'placement' && request.kind !== 'excavation') {
    throw worldActionDenied('bucket world-action kind is unsupported', operation);
  }
  const expectedKind = itemName === 'bucket' ? 'excavation' : 'placement';
  if (request.kind !== expectedKind) {
    const article = expectedKind === 'excavation' ? 'an' : 'a';
    throw worldActionDenied(
      `${itemName} requires ${article} ${expectedKind} world-action capability`,
      operation,
    );
  }
  const normalized = {
    kind: request.kind,
    target: Object.freeze(positionRecord(request.target)),
  };
  if (request.kind === 'placement') {
    const referenceBlockName = normalizeBlockName(request.referenceBlockName);
    if (!finitePosition(request.referencePosition) || !referenceBlockName) {
      throw worldActionDenied('bucket placement reference is unavailable', operation);
    }
    normalized.referencePosition = Object.freeze(positionRecord(request.referencePosition));
    normalized.referenceBlockName = referenceBlockName;
  }
  return Object.freeze(normalized);
}

function requireCurrentBucketUseCorrelation(bot, request, operation) {
  if (typeof bot?.blockAtCursor !== 'function') {
    throw worldActionDenied('live item-use raycast is unavailable', operation);
  }
  let cursor;
  try {
    cursor = bot.blockAtCursor(6);
  } catch {
    throw worldActionDenied('live item-use raycast failed', operation);
  }
  const expectedPosition = request.kind === 'placement'
    ? request.referencePosition
    : request.target;
  if (!cursor || !samePosition(cursor.position, expectedPosition)) {
    throw worldActionDenied('live item-use raycast does not match the authorized target', operation);
  }
  const current = requireCurrentActionBlock(bot, expectedPosition, operation);
  if (request.kind === 'placement') {
    if (current.name !== request.referenceBlockName) {
      throw worldActionDenied('bucket placement reference type changed', operation);
    }
    const faceVector = blockFaceVector(cursor.face);
    const liveTarget = faceVector && placementTarget(current.position, faceVector);
    if (!liveTarget || !samePosition(liveTarget, request.target)) {
      throw worldActionDenied('live item-use face does not match the authorized placement target', operation);
    }
  }
  return current;
}

function authorizeBucketWorldAction(bot, ctx, request, current, operation) {
  // Water/lava/powder-snow flow, source pickup, cauldron mutation, fire
  // extinguishing, and entity displacement are not bounded by one raycast
  // cell. Phase 1 therefore denies every world-mutating bucket action. Milk
  // remains a separately classified passive item-use operation.
  void bot;
  void ctx;
  void request;
  void current;
  throw worldActionDenied(
    'world-mutating bucket flow/source effects are not modeled in Phase 1',
    operation,
  );
}

function requireNoUnboundedDigProtectionRisk(ctx, operation) {
  requireNoUnboundedBlockMutationProtectionRisk(ctx, operation, 'dig');
}

function requireNoUnboundedBlockMutationProtectionRisk(ctx, operation, effect = 'block mutation') {
  const loaded = loadWorldModelForFinalDecision(ctx);
  if (loaded.error) {
    throw worldActionDenied(
      `world-model policy unavailable: ${loaded.error.message || String(loaded.error)}`,
      operation,
    );
  }
  if ((loaded.model?.doNotTouchRegions || []).length > 0) {
    throw worldActionDenied(
      `${effect} support, gravity, fluid, attachment, and redstone effects cannot be bounded while do-not-touch regions exist`,
      operation,
    );
  }
}

function requireCachedMovementProtection(boundary, operation, effect) {
  const snapshot = movementProtectionSnapshotForDecision(boundary);
  if (snapshot.error) {
    throw worldActionDenied(
      `cached world-model movement policy unavailable: ${snapshot.error.message || String(snapshot.error)}`,
      operation,
    );
  }
  if (snapshot.stickyDnt === true) {
    throw worldActionDenied(
      `${effect} support, collision, and redstone effects cannot be bounded while do-not-touch regions exist`,
      operation,
    );
  }
}

function movementProtectionSnapshotForDecision(boundary) {
  const { store, model } = worldModelSourceFromContext(boundary?.context);
  if (store) {
    const snapshot = boundary?.movementProtection;
    if (!snapshot
      || snapshot.source !== 'tracked_store'
      || snapshot.store !== store
      || snapshot.generation !== boundary.movementProtectionGeneration
      || snapshot.known !== true) {
      return {
        error: new Error('world-model store lacks a current subscribed movement snapshot'),
        stickyDnt: snapshot?.stickyDnt === true,
      };
    }
    return snapshot;
  }

  // In-memory contexts are re-evaluated directly without I/O so replacing or
  // mutating ctx.worldModel is visible on the next movement transition. Once a
  // DNT region is observed, movement remains denied for this bot connection.
  return updateMovementProtectionSnapshot(boundary, {
    source: 'memory',
    model,
    generation: boundary.movementProtectionGeneration,
  });
}

function updateMovementProtectionSnapshot(boundary, update) {
  const previous = boundary?.movementProtection;
  const stickyDnt = previous?.stickyDnt === true;
  if (!boundary || update.generation !== boundary.movementProtectionGeneration) {
    return {
      error: new Error('world-model movement snapshot generation is stale'),
      stickyDnt,
    };
  }
  if (update.error) {
    boundary.movementProtection = {
      source: update.source,
      store: update.store || null,
      generation: update.generation,
      revision: update.revision ?? null,
      known: false,
      stickyDnt,
      error: update.error,
    };
    return boundary.movementProtection;
  }

  const model = update.model;
  const invalidTrackedUpdate = update.source === 'tracked_store'
    && (!Number.isSafeInteger(update.revision)
      || update.revision < 1
      || !model
      || typeof model !== 'object');
  if (invalidTrackedUpdate
    || (model !== null && model !== undefined && !Array.isArray(model.doNotTouchRegions))) {
    boundary.movementProtection = {
      source: update.source,
      store: update.store || null,
      generation: update.generation,
      revision: update.revision ?? null,
      known: false,
      stickyDnt,
      error: new Error('world-model snapshot or doNotTouchRegions is malformed'),
    };
    return boundary.movementProtection;
  }

  boundary.movementProtection = {
    source: update.source,
    store: update.store || null,
    generation: update.generation,
    revision: update.revision ?? null,
    known: true,
    stickyDnt: stickyDnt || (model?.doNotTouchRegions?.length || 0) > 0,
    error: null,
  };
  return boundary.movementProtection;
}

function refreshMovementProtectionTracking(boundary, nextContext) {
  const stickyDnt = boundary.movementProtection?.stickyDnt === true;
  boundary.movementProtectionGeneration = nextSafeEpoch(boundary.movementProtectionGeneration);
  const generation = boundary.movementProtectionGeneration;
  try {
    boundary.movementProtectionUnsubscribe?.();
  } catch {
    // A stale listener is generation-bound and cannot update the new snapshot.
  }
  boundary.movementProtectionUnsubscribe = null;

  const { store, model: inMemoryModel } = worldModelSourceFromContext(nextContext);
  if (!store) {
    boundary.movementProtection = {
      source: 'memory',
      store: null,
      generation,
      revision: null,
      known: true,
      stickyDnt,
      error: null,
    };
    updateMovementProtectionSnapshot(boundary, {
      source: 'memory',
      model: inMemoryModel,
      generation,
    });
    return;
  }

  boundary.movementProtection = {
    source: 'untracked_store',
    store,
    generation,
    revision: null,
    known: false,
    stickyDnt,
    error: new Error('movement requires the subscribed repository WorldModelStore'),
  };
  // Movement never polls a custom store: without a synchronous subscription,
  // it cannot prove that a permissive cache is current. The branded repository
  // store is the exclusive supported runtime writer for this policy snapshot.
  if (store[WORLD_MODEL_STORE_LIVE_SNAPSHOT] !== true
    || typeof store.subscribe !== 'function'
    || typeof store.load !== 'function') return;

  const listener = (event = {}) => {
    updateMovementProtectionSnapshot(boundary, {
      source: 'tracked_store',
      store,
      model: event.model,
      error: event.error || null,
      revision: event.revision ?? null,
      generation,
    });
  };
  try {
    const unsubscribe = store.subscribe(listener);
    if (typeof unsubscribe !== 'function') {
      throw new TypeError('world-model subscription did not return an unsubscribe function');
    }
    boundary.movementProtectionUnsubscribe = unsubscribe;
    store.load();
    const published = boundary.movementProtection;
    if (published?.source !== 'tracked_store'
      || published.store !== store
      || published.generation !== generation
      || published.known !== true
      || !Number.isSafeInteger(published.revision)) {
      throw new Error('world-model store did not publish its initial subscribed snapshot');
    }
  } catch (error) {
    updateMovementProtectionSnapshot(boundary, {
      source: 'tracked_store',
      store,
      error,
      generation,
    });
  }
}

function worldModelSourceFromContext(ctx) {
  const runtime = runtimeContext(ctx) || {};
  return {
    store: runtime.worldModelStore || ctx?.worldModelStore || null,
    model: runtime.worldModel || ctx?.worldModel || null,
  };
}

function authorizeOutboundAnchoredWindowControl(bot, boundary, packet, opts) {
  requireNoUnboundedBlockMutationProtectionRisk(
    boundary.context,
    opts.operation,
    'workstation mutation',
  );
  requireAuthorizedCurrentBlockWindow(bot, boundary, packet, opts);
  return null;
}

function authorizeOutboundPlayerOrAnchoredWindowControl(bot, boundary, packet, opts) {
  const windowId = packetWindowId(packet, opts.windowIdKeys);
  if (!Number.isInteger(windowId)) {
    throw worldActionDenied('window identity is unavailable', opts.operation);
  }
  if (windowId === 0) return null;
  requireNoUnboundedBlockMutationProtectionRisk(
    boundary.context,
    opts.operation,
    'workstation mutation',
  );
  requireAuthorizedCurrentBlockWindow(bot, boundary, packet, opts, windowId);
  return null;
}

function requireAuthorizedCurrentBlockWindow(bot, boundary, packet, opts, suppliedWindowId = null) {
  const operation = opts.operation || 'window control packet';
  const binding = boundary.windowAccess;
  if (!binding) {
    throw worldActionDenied('non-inventory window has no authorized provenance', operation);
  }
  if (boundary.containerProvenanceTainted
    || binding.provenanceEpoch !== boundary.containerProvenanceEpoch
    || !binding.token) {
    throw worldActionDenied('authorized window provenance is no longer current', operation);
  }
  const windowId = suppliedWindowId ?? (
    opts.windowIdKeys?.length ? packetWindowId(packet, opts.windowIdKeys) : binding.id
  );
  if (!Number.isInteger(windowId) || windowId <= 0 || windowId !== binding.id) {
    throw worldActionDenied('window packet does not match the authorized current window', operation);
  }
  if (bot.currentWindow !== binding.window || Number(bot.currentWindow?.id) !== binding.id) {
    throw worldActionDenied('authorized block window identity changed', operation);
  }
  const type = typeof binding.window?.type === 'string'
    ? binding.window.type.trim().toLowerCase()
    : '';
  if (!type || (opts.windowType && !opts.windowType(type))) {
    throw worldActionDenied('current window type does not match the requested operation', operation);
  }
  if (!binding.access) {
    throw worldActionDenied('block window authorization did not complete', operation);
  }
  if (opts.blockNames && !opts.blockNames.has(normalizeBlockName(binding.access.blockName))) {
    throw worldActionDenied('current block anchor does not support the requested operation', operation);
  }
  const current = requireCurrentActionBlock(bot, binding.access.position, operation);
  const freshAccess = requireCurrentAnchorFootprint(bot, boundary.context, current, operation, {
    kind: binding.access.kind,
    blockName: binding.access.blockName,
  });
  if (!sameAnchorFootprint(freshAccess.footprint, binding.access.footprint)) {
    throw worldActionDenied('block window anchor footprint changed after opening', operation);
  }
  requireSafeContainerMutationNeighborhood(bot, freshAccess, operation);
  return binding;
}

function requireSafeContainerMutationNeighborhood(bot, access, operation) {
  requireNoRemoteVibrationSensors(
    bot,
    (access?.footprint || []).map((member) => member.position),
    operation,
  );
  for (const member of access?.footprint || []) {
    for (const offset of [
      ...Object.values(CARDINAL_OFFSETS),
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
    ]) {
      const adjacentPosition = offsetPosition(member.position, offset);
      const adjacent = requireCurrentActionBlock(bot, adjacentPosition, operation);
      const adjacentName = adjacent.name;
      if (isContainerMutationDependency(adjacentName)
        || AUTONOMOUS_OUTPUT_CONTAINERS.has(adjacentName)) {
        throw worldActionDenied(
          'adjacent container transfer/redstone provenance cannot be proven',
          operation,
        );
      }
    }
  }
  if (!bot?.entities || typeof bot.entities !== 'object') return;
  const selfId = Number(bot?.entity?.id);
  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity || Number(entity.id) === selfId) continue;
    if (!finitePosition(entity.position)) {
      throw worldActionDenied('container-adjacent entity dependency is unavailable', operation);
    }
    if ((access?.footprint || []).some((member) => (
      Math.abs(Number(entity.position.x) - Number(member.position.x)) <= 2
      && Math.abs(Number(entity.position.y) - Number(member.position.y)) <= 2
      && Math.abs(Number(entity.position.z) - Number(member.position.z)) <= 2
    ))) {
      throw worldActionDenied(
        'nearby moving entity-container/redstone provenance cannot be proven',
        operation,
      );
    }
  }
}

function packetWindowId(packet, keys = ['windowId']) {
  for (const key of keys || []) {
    if (Object.hasOwn(packet || {}, key)) return Number(packet[key]);
  }
  return NaN;
}

function authorizeOutboundSignUpdate(bot, boundary, packet) {
  requireNoUnboundedBlockMutationProtectionRisk(boundary.context, 'update sign packet');
  const frame = WORLD_ACTION_INVOCATION.getStore() || null;
  const invocation = findActiveInvocation(frame, (candidate) => candidate.entry.name === 'updateSign');
  const capability = invocation?.worldPacketCapability;
  if (!capability
    || capability.type !== 'update_sign'
    || !samePosition(capability.position, packet?.location)) {
    throw worldActionDenied('sign packet lacks a matching active sign capability', 'update sign packet');
  }
  const current = requireCurrentActionBlock(bot, capability.position, 'update sign packet');
  if (!isSignBlock(current.name) || current.name !== capability.blockName) {
    throw worldActionDenied('sign target changed before packet emission', 'update sign packet');
  }
  requireSafeDigNeighborhood(bot, current, 'update sign packet');
  requireCurrentBlockInteraction(bot, boundary.context, current, 'update sign packet');
  return null;
}

function authorizeOutboundCustomPayload(packet) {
  const channel = typeof packet?.channel === 'string' ? packet.channel : '';
  if (!SAFE_CUSTOM_PAYLOAD_CHANNELS.has(channel)) {
    throw worldActionDenied('custom payload channel lacks an explicit safe classification', 'custom payload packet');
  }
  return null;
}

function authorizeOutboundChat(packet) {
  if (typeof packet?.message !== 'string') {
    throw worldActionDenied('chat packet message is unavailable', 'chat packet');
  }
  if (packet.message.trimStart().startsWith('/')) {
    throw worldActionDenied('slash commands require a separate authenticated capability', 'chat packet');
  }
  return null;
}

function authorizeOutboundDigPacket(bot, boundary, packet) {
  const status = Number(packet?.status);
  // Protocol block_dig also carries inventory-affecting actions. Only the
  // block-break cancellation status is safe without a block capability.
  // Status 5 releases an actively used item (for example a bow or trident),
  // while dropping/swapping items and unknown future statuses also mutate
  // state; all of those fail closed until they have typed capabilities.
  if (status === 1) return null;
  if (status === 3 || status === 4 || status === 5 || status === 6
    || (status !== 0 && status !== 2)) {
    throw worldActionDenied(
      'block-dig status lacks an authorized world-action capability',
      'block dig packet',
    );
  }
  try {
    requireNoUnboundedDigProtectionRisk(boundary.context, 'block dig packet');
    const current = requireCurrentActionBlock(bot, packet?.location, 'block dig packet');
    requireSafeDigNeighborhood(bot, current, 'block dig packet');
    requireNoNearbyEntityDigEffects(bot, current.position, 'block dig packet');
    requireDestructiveAffectedFootprint(bot, boundary.context, current, 'block dig packet');
  } catch (error) {
    if (status === 2 && safelyAbortDeniedDig(bot, packet?.location)) {
      return { suppress: true };
    }
    throw error;
  }
  return status === 2 ? heldItemMutationOutcome(bot, boundary, 0) : null;
}

function authorizeOutboundBlockPlacePacket(bot, boundary, packet) {
  if (isNonWorldBlockPlacePacket(packet)) {
    return authorizeOutboundUseItem(bot, boundary, { hand: 0 });
  }
  const faceVector = blockFaceVector(packet?.direction);
  if (!faceVector) throw worldActionDenied('block-place direction is unavailable', 'block place packet');
  const current = requireCurrentActionBlock(bot, packet?.location, 'block place packet');
  const frame = WORLD_ACTION_INVOCATION.getStore() || null;
  const windowInvocations = activeWindowOpenInvocations(frame);
  const placementInvocation = findActiveInvocation(
    frame,
    (candidate) => candidate.entry.family === 'placement',
  );
  const blockUseInvocation = findActiveInvocation(
    frame,
    (candidate) => candidate.entry.name === 'activateBlock',
  );
  if (windowInvocations.length === 0 && !placementInvocation && !blockUseInvocation) {
    throw worldActionDenied(
      'raw block-place packet lacks an active typed block-use capability',
      'block place packet',
    );
  }
  requireNoUnboundedBlockMutationProtectionRisk(
    boundary.context,
    'block place packet',
    windowInvocations.length > 0
      ? 'container open/redstone mutation'
      : 'block mutation',
  );
  if (windowInvocations.length > 0
    && windowInvocations.some((invocation) => !windowOpenUseCapabilityIsCurrent(bot, invocation.windowUseCapability))) {
    throw worldActionDenied(
      'window-open hand or sneak state changed before packet emission',
      'block place packet',
    );
  }
  if (windowInvocations.length === 0) {
    // activateBlock also serializes reference-only transforms (strip, till,
    // flatten, wax/scrape). Those mutate the clicked block and can update an
    // adjacent observer/control just as a placement or dig can.
    requireSafeDigNeighborhood(bot, current, 'block place packet');
  }

  if (findActiveInvocation(frame, (candidate) => candidate.entry.name === 'craft')) {
    if (current.name !== 'crafting_table') {
      throw worldActionDenied('current block is not a crafting_table', 'block place packet');
    }
  }
  if (findActiveInvocation(frame, (candidate) => candidate.entry.name === 'openFurnace')) {
    if (!FURNACE_BLOCKS.has(current.name)) {
      throw worldActionDenied('current block is not a supported furnace', 'block place packet');
    }
  }
  if (findActiveInvocation(frame, (candidate) => candidate.entry.name === 'openContainer')) {
    if (!anchorKindForBlock(current.name)) {
      throw worldActionDenied('current block is not a supported container', 'block place packet');
    }
  }

  const access = requireBlockPlaceReferenceFootprint(bot, boundary.context, current, 'block place packet');
  if (windowInvocations.length > 0) {
    requireSafeContainerMutationNeighborhood(bot, access, 'block place packet');
  }
  const packetItem = currentPacketPlacementItem(bot, boundary, packet, placementInvocation, frame);
  if (packetItem.error) {
    throw worldActionDenied(packetItem.error, 'block place packet');
  }
  if (windowInvocations.length > 0 && (
    packetItem.offHand
    || windowInvocations.some((invocation) => (
      invocation.windowUseCapability?.itemName !== packetItem.itemName
    ))
  )) {
    throw worldActionDenied(
      'window-open packet does not match the authorized main-hand item',
      'block place packet',
    );
  }
  if (blockUseInvocation && windowInvocations.length === 0) {
    const capability = blockUseInvocation.blockUseCapability;
    if (!capability
      || !samePosition(capability.position, current.position)
      || capability.blockName !== current.name
      || capability.itemName !== packetItem.itemName
      || (Object.hasOwn(packet || {}, 'hand') && packet.hand !== 0)) {
      throw worldActionDenied(
        'block-place packet does not match the active block-use capability',
        'block place packet',
      );
    }
  }
  const placementMutatesAdjacent = Boolean(packetItem.blockName)
    || isWorldMutatingBucket(packetItem.itemName);
  if (placementInvocation && !placementMutatesAdjacent) {
    throw worldActionDenied('placement item geometry is unavailable or unsupported', 'block place packet');
  }
  const blockUseMutatesAdjacent = blockUseInvocation?.blockUseCapability?.effectClass === 'adjacent_placement';
  if (windowInvocations.length === 0 && (placementInvocation || blockUseMutatesAdjacent)) {
    requirePlacementAffectedFootprint(
      bot,
      boundary,
      boundary.context,
      current,
      faceVector,
      packetItem,
      'block place packet',
    );
  }
  if (windowInvocations.length > 0) {
    if (boundary.containerProvenanceTainted) {
      throw worldActionDenied(
        'container provenance is tainted until the connection is reset',
        'block place packet',
      );
    }
    const token = windowInvocations[0].windowOpenToken;
    const provenanceEpoch = windowInvocations[0].windowProvenanceEpoch;
    if (!token
      || !Number.isSafeInteger(provenanceEpoch)
      || provenanceEpoch !== boundary.containerProvenanceEpoch
      || windowInvocations.some((invocation) => (
        invocation.windowOpenToken !== token
        || invocation.windowProvenanceEpoch !== provenanceEpoch
        || !sameWindowAccessTarget(access, invocation.windowExpectedAccess)
      ))) {
      throw worldActionDenied(
        'block interaction does not match the active window-open invocation',
        'block place packet',
      );
    }

    const now = Date.now();
    const existing = boundary.pendingWindowAccess;
    if (existing && (!Number.isFinite(existing.expiresAt) || now > existing.expiresAt)) {
      taintContainerProvenance(boundary);
      throw worldActionDenied(
        'an earlier block-open authorization expired without a window transition',
        'block place packet',
      );
    }
    if (existing && existing.token !== token) {
      throw worldActionDenied(
        'another block-open authorization is already pending',
        'block place packet',
      );
    }
    if (boundary.windowAccess && boundary.windowAccess.token !== token) {
      throw worldActionDenied(
        'another authorized block window is still open',
        'block place packet',
      );
    }
    boundary.pendingWindowAccess = {
      access,
      token,
      provenanceEpoch,
      expiresAt: existing?.token === token
        ? existing.expiresAt
        : now + AUTHORIZED_WINDOW_OPEN_TIMEOUT_MS,
    };
  }
  return windowInvocations.length > 0
    ? null
    : heldItemMutationOutcome(bot, boundary, packetItem.offHand ? 1 : 0);
}

function authorizeOutboundEntityUse(bot, boundary, packet) {
  const action = Number(packet?.mouse);
  if (action === 1) {
    requireNoUnboundedBlockMutationProtectionRisk(
      boundary.context,
      'entity attack packet',
      'combat/environment mutation',
    );
    const targetId = Number(packet?.target);
    const frame = WORLD_ACTION_INVOCATION.getStore() || null;
    const attackFrame = findActiveInvocation(
      frame,
      (candidate) => candidate.entry.name === 'attack'
        && candidate.entityAttackCapability?.used !== true,
    );
    const capability = attackFrame?.entityAttackCapability;
    const liveTarget = Number.isSafeInteger(targetId) ? bot?.entities?.[targetId] : null;
    if (!capability
      || !Number.isSafeInteger(targetId)
      || capability.id !== targetId
      || capability.entity !== liveTarget
      || capability.name !== normalizedEntityName(liveTarget)
      || capability.type !== normalizeEntityType(liveTarget?.type)
      || !samePosition(capability.position, liveTarget?.position)
      || capability.itemName !== authoritativeActivatedItemName(bot, boundary, false)
      || typeof packet?.sneaking !== 'boolean'
      || packet.sneaking !== boundary.clientState?.sneaking) {
      throw worldActionDenied(
        'entity attack does not match an exact active target capability',
        'entity attack packet',
      );
    }
    requireAttackableEntity(bot, boundary.context, liveTarget, 'entity attack packet');
    requireNoRemoteVibrationSensors(
      bot,
      [bot?.entity?.position, liveTarget.position],
      'entity attack packet',
    );
    capability.used = true;
    return heldItemMutationOutcome(bot, boundary, 0);
  }

  if (boundary.pendingWindowAccess) {
    taintContainerProvenance(boundary);
  } else {
    advanceContainerProvenanceEpoch(boundary);
  }
  closeDeniedWindow(bot, boundary);
  throw worldActionDenied(
    'non-attack entity interaction lacks an owned-entity capability',
    'entity interaction packet',
  );
}

function authorizeOutboundWindowClick(bot, boundary, packet) {
  const windowId = Number(packet?.windowId);
  if (!Number.isInteger(windowId)) {
    throw worldActionDenied('window identity is unavailable', 'window click packet');
  }

  const frame = WORLD_ACTION_INVOCATION.getStore() || null;
  const clickFrame = findActiveInvocation(
    frame,
    (candidate) => candidate.entry.name === 'clickWindow'
      && candidate.windowClickCapability?.used !== true,
  );
  const clickCapability = clickFrame?.windowClickCapability;
  const transferFrame = findActiveInvocation(
    frame,
    (candidate) => candidate.windowTransferCapability,
  );
  const transferCapability = transferFrame?.windowTransferCapability;
  const craftFrame = findActiveInvocation(frame, (candidate) => candidate.entry.name === 'craft');
  if (!clickCapability && transferCapability) {
    return authorizeOutboundWindowTransferClick(
      bot,
      boundary,
      packet,
      transferCapability,
    );
  }
  if (!clickCapability
    || clickCapability.window !== (bot.currentWindow || bot.inventory)
    || clickCapability.id !== windowId
    || clickCapability.slot !== Number(packet?.slot)
    || clickCapability.mouseButton !== Number(packet?.mouseButton)
    || clickCapability.mode !== Number(packet?.mode)
    || clickCapability.slot < 0
    || clickCapability.slot >= clickCapability.window.slots.length
    || (clickCapability.mouseButton !== 0 && clickCapability.mouseButton !== 1)
    || clickCapability.mode !== 0) {
    throw worldActionDenied(
      'window click lacks an exact active transition capability',
      'window click packet',
    );
  }
  const localChangedLocations = changedWindowSlotLocations(
    clickCapability.slotsBefore,
    clickCapability.window,
  );
  const declaredChangedLocations = Array.isArray(packet?.changedSlots)
    ? packet.changedSlots.map((entry) => Number(entry?.location)).filter(Number.isInteger)
    : null;
  if (!declaredChangedLocations
    || !sameNumberSet(localChangedLocations, declaredChangedLocations)) {
    throw worldActionDenied(
      'window-click packet does not match the locally applied transition',
      'window click packet',
    );
  }
  clickCapability.changedLocations = localChangedLocations;
  if (craftFrame?.args?.[2]) {
    requireNoUnboundedBlockMutationProtectionRisk(
      boundary.context,
      'craft window click',
      'workstation mutation',
    );
    bindOrRequireCraftWindow(bot, boundary, craftFrame, windowId);
    const current = requireCurrentActionBlock(bot, craftFrame.args[2], 'craft window click');
    if (current.name !== 'crafting_table') {
      throw worldActionDenied('current block is not a crafting_table', 'craft window click');
    }
    requireCurrentAnchorFootprint(
      bot,
      boundary.context,
      current,
      'craft window click',
      { kind: WORLD_ANCHOR_KIND.WORKSTATION, blockName: 'crafting_table' },
    );
    return authorizeWindowClickTransition(bot, boundary, packet, clickCapability, bot.currentWindow);
  }
  if (windowId === 0) {
    if (bot.currentWindow || clickCapability?.window !== bot.inventory) {
      throw worldActionDenied('player-inventory window identity is stale', 'window click packet');
    }
  } else {
    requireNoUnboundedBlockMutationProtectionRisk(
      boundary.context,
      'window click packet',
      'container mutation',
    );
    requireAuthorizedCurrentBlockWindow(bot, boundary, packet, {
      operation: 'window click packet',
      windowIdKeys: ['windowId'],
    }, windowId);
  }
  return authorizeWindowClickTransition(
    bot,
    boundary,
    packet,
    clickCapability,
    clickCapability?.window,
  );
}

function authorizeOutboundWindowTransferClick(bot, boundary, packet, capability) {
  const windowId = Number(packet?.windowId);
  const slot = Number(packet?.slot);
  const mouseButton = Number(packet?.mouseButton);
  const mode = Number(packet?.mode);
  if (capability.window !== bot.currentWindow
    || capability.id !== windowId
    || !Number.isInteger(slot)
    || slot < 0
    || !Number.isInteger(capability.window?.inventoryEnd)
    || slot >= capability.window.inventoryEnd
    || (mouseButton !== 0 && mouseButton !== 1)
    || mode !== 0) {
    throw worldActionDenied(
      'window transfer click does not match the supported Mineflayer transfer shape',
      'window transfer packet',
    );
  }
  if (windowId === 0) {
    if (bot.currentWindow || capability.window !== bot.inventory) {
      throw worldActionDenied(
        'player-inventory transfer identity is stale',
        'window transfer packet',
      );
    }
  } else {
    requireNoUnboundedBlockMutationProtectionRisk(
      boundary.context,
      'window transfer packet',
      'container mutation',
    );
    requireAuthorizedCurrentBlockWindow(
      bot,
      boundary,
      packet,
      { operation: 'window transfer packet', windowIdKeys: ['windowId'] },
      windowId,
    );
  }
  const localChangedLocations = changedWindowSlotLocations(
    capability.slotsBefore,
    capability.window,
  );
  const declaredChangedLocations = Array.isArray(packet?.changedSlots)
    ? packet.changedSlots.map((entry) => Number(entry?.location)).filter(Number.isInteger)
    : null;
  if (localChangedLocations.length === 0
    || !declaredChangedLocations
    || !sameNumberSet(localChangedLocations, declaredChangedLocations)) {
    throw worldActionDenied(
      'window-transfer packet does not match the locally applied transition',
      'window transfer packet',
    );
  }
  const clickCapability = {
    window: capability.window,
    id: capability.id,
    slot,
    mouseButton,
    mode,
    slotsBefore: capability.slotsBefore,
    changedLocations: localChangedLocations,
    used: false,
  };
  const outcome = authorizeWindowClickTransition(
    bot,
    boundary,
    packet,
    clickCapability,
    capability.window,
  );
  const afterWrite = outcome?.afterWrite;
  return {
    afterWrite: () => {
      afterWrite?.();
      capability.slotsBefore = snapshotWindowSlots(capability.window);
      capability.clickCount += 1;
    },
  };
}

function authorizeWindowClickTransition(bot, boundary, packet, capability, window) {
  if (capability) capability.used = true;
  const sensitiveLocations = heldSensitiveWindowLocations(bot, boundary, window);
  const changed = Array.isArray(capability?.changedLocations)
    ? new Set(capability.changedLocations)
    : null;
  const changedHotbarSlots = changed
    ? hotbarSlotsForWindowLocations(bot, window, [...changed])
    : Array.from({ length: 9 }, (_unused, slot) => slot);
  const requiredLocations = changed
    ? sensitiveLocations.filter((location) => changed.has(location))
    : null;
  const afterStateId = Number.isInteger(Number(packet?.stateId))
    ? Number(packet.stateId)
    : (Number.isInteger(boundary.latestInventoryStateId)
      ? boundary.latestInventoryStateId
      : null);
  return {
    afterWrite: () => {
      for (const slot of changedHotbarSlots) {
        boundary.unconfirmedHotbarSlots.set(slot, afterStateId);
      }
      if (Array.isArray(requiredLocations) && requiredLocations.length === 0) return;
      boundary.itemMutationEpoch = nextSafeEpoch(boundary.itemMutationEpoch);
      boundary.itemStateCoherent = false;
      boundary.pendingItemMutation = {
        epoch: boundary.itemMutationEpoch,
        windowId: Number(packet.windowId),
        requiredLocations: requiredLocations ? new Set(requiredLocations) : null,
        expectedAction: Object.hasOwn(packet || {}, 'action')
          && Number.isInteger(Number(packet.action))
          ? Number(packet.action)
          : null,
        afterStateId,
      };
    },
  };
}

function snapshotWindowSlots(window) {
  if (!Array.isArray(window?.slots)) return null;
  return Array.from(window.slots, inventoryItemFingerprint);
}

function changedWindowSlotLocations(before, window) {
  if (!Array.isArray(before) || !Array.isArray(window?.slots) || before.length !== window.slots.length) {
    throw worldActionDenied('window slot snapshot is unavailable', 'window click packet');
  }
  const changed = [];
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== inventoryItemFingerprint(window.slots[index])) changed.push(index);
  }
  return changed;
}

function inventoryItemFingerprint(item) {
  if (!item) return 'empty';
  let nbt = '';
  try {
    nbt = JSON.stringify(item.nbt ?? null);
  } catch {
    nbt = 'unserializable';
  }
  return [item.name, item.type, item.metadata, item.count, item.stackSize, nbt]
    .map((value) => String(value ?? ''))
    .join('\0');
}

function sameNumberSet(left, right) {
  const a = [...new Set(left)].sort((x, y) => x - y);
  const b = [...new Set(right)].sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function heldSensitiveWindowLocations(bot, boundary, window) {
  const locations = [];
  const id = Number(window?.id);
  const selected = boundary?.clientState?.selectedHotbarSlot;
  if (id === 0) {
    const start = Number.isInteger(bot?.QUICK_BAR_START)
      ? bot.QUICK_BAR_START
      : Number(bot?.inventory?.hotbarStart);
    if (Number.isInteger(start) && isQuickBarSlot(selected)) locations.push(start + selected);
    let offhand = 45;
    try {
      const resolved = bot?.getEquipmentDestSlot?.('off-hand');
      if (Number.isInteger(resolved)) offhand = resolved;
    } catch {
      // The standard inventory slot remains the conservative fallback.
    }
    locations.push(offhand);
    return [...new Set(locations)];
  }
  const hotbarStart = Number.isInteger(window?.hotbarStart)
    ? window.hotbarStart
    : (Number.isInteger(window?.inventoryEnd) ? window.inventoryEnd - 9 : null);
  if (Number.isInteger(hotbarStart) && isQuickBarSlot(selected)) {
    locations.push(hotbarStart + selected);
  }
  return locations;
}

function hotbarSlotsForWindowLocations(bot, window, locations) {
  const id = Number(window?.id);
  const hotbarStart = id === 0
    ? (Number.isInteger(bot?.QUICK_BAR_START)
      ? bot.QUICK_BAR_START
      : Number(bot?.inventory?.hotbarStart))
    : (Number.isInteger(window?.hotbarStart)
      ? window.hotbarStart
      : (Number.isInteger(window?.inventoryEnd) ? window.inventoryEnd - 9 : null));
  if (!Number.isInteger(hotbarStart)) return [];
  return [...new Set((locations || [])
    .map((location) => Number(location) - hotbarStart)
    .filter(isQuickBarSlot))];
}

function observeConfirmedHotbarReadback(bot, boundary, event, packet, incomingStateId) {
  if (!(boundary.unconfirmedHotbarSlots instanceof Map)
    || boundary.unconfirmedHotbarSlots.size === 0) return;
  const packetWindowId = Number(packet?.windowId ?? packet?.window_id);
  let window = null;
  if (packetWindowId === 0 || packetWindowId === -2) {
    window = bot.inventory;
  } else if (Number(bot.currentWindow?.id) === packetWindowId) {
    window = bot.currentWindow;
  }
  if (!window) return;

  let candidates = [];
  if (event === 'set_slot') {
    candidates = hotbarSlotsForWindowLocations(bot, window, [Number(packet?.slot)]);
  } else if (event === 'window_items' && Array.isArray(packet?.items)) {
    const hotbarStart = Number(window?.id) === 0
      ? (Number.isInteger(bot?.QUICK_BAR_START)
        ? bot.QUICK_BAR_START
        : Number(bot?.inventory?.hotbarStart))
      : (Number.isInteger(window?.hotbarStart)
        ? window.hotbarStart
        : (Number.isInteger(window?.inventoryEnd) ? window.inventoryEnd - 9 : null));
    if (!Number.isInteger(hotbarStart) || packet.items.length < hotbarStart + 9) return;
    candidates = Array.from({ length: 9 }, (_unused, slot) => slot);
  } else {
    return;
  }
  for (const slot of candidates) {
    const afterStateId = boundary.unconfirmedHotbarSlots.get(slot);
    const newer = Number.isInteger(incomingStateId)
      ? (!Number.isInteger(afterStateId) || incomingStateId > afterStateId)
      : !Number.isInteger(afterStateId);
    if (newer) boundary.unconfirmedHotbarSlots.delete(slot);
  }
}

function sameAnchorFootprint(left, right) {
  const canonical = (footprint) => (footprint || [])
    .map((member) => {
      const position = positionRecord(member.position);
      return `${normalizeBlockName(member.blockName)}@${position.x},${position.y},${position.z}`;
    })
    .sort();
  const leftCanonical = canonical(left);
  const rightCanonical = canonical(right);
  return leftCanonical.length === rightCanonical.length
    && leftCanonical.every((value, index) => value === rightCanonical[index]);
}

function bindOrRequireCraftWindow(bot, boundary, craftFrame, windowId) {
  if (!Number.isSafeInteger(craftFrame.windowProvenanceEpoch)
    || craftFrame.windowProvenanceEpoch !== boundary.containerProvenanceEpoch) {
    throw worldActionDenied(
      'crafting window provenance changed during the table interaction',
      'craft window click',
    );
  }
  const binding = boundary.windowAccess;
  if (!craftFrame.windowOpenToken
    || binding?.token !== craftFrame.windowOpenToken
    || binding.provenanceEpoch !== craftFrame.windowProvenanceEpoch
    || !sameWindowAccessTarget(binding.access, craftFrame.windowExpectedAccess)) {
    throw worldActionDenied(
      'crafting window was not bound by this packet-authorized windowOpen transition',
      'craft window click',
    );
  }
  const window = bot?.currentWindow;
  if (!window || (typeof window !== 'object' && typeof window !== 'function')) {
    throw worldActionDenied('crafting window identity is unavailable', 'craft window click');
  }
  const currentId = Number(window.id);
  if (!Number.isInteger(currentId) || currentId <= 0 || currentId !== windowId) {
    throw worldActionDenied('crafting window does not match the outbound packet', 'craft window click');
  }
  if (typeof window.type !== 'string' || !window.type.startsWith('minecraft:crafting')) {
    throw worldActionDenied('current window is not a crafting window', 'craft window click');
  }
  if (binding.window !== window || binding.id !== currentId) {
    throw worldActionDenied('crafting window does not match its authorized binding', 'craft window click');
  }
  if (!craftFrame.windowAccess) {
    craftFrame.windowAccess = { window, id: currentId };
    return;
  }
  if (craftFrame.windowAccess.window !== window || craftFrame.windowAccess.id !== windowId) {
    throw worldActionDenied('crafting window identity changed during craft', 'craft window click');
  }
}

function requireCurrentBlockInteraction(bot, ctx, current, operation) {
  if (anchorKindForBlock(current.name)) {
    return requireCurrentAnchorFootprint(bot, ctx, current, operation);
  }
  requireWorldAction(authorizeExcavation(bot, ctx, current.position), operation);
  return {
    kind: null,
    position: current.position,
    blockName: current.name,
    footprint: [{ position: current.position, blockName: current.name }],
  };
}

function requireDestructiveAffectedFootprint(bot, ctx, current, operation) {
  const footprint = pairedBlockFootprint(bot, current, operation);
  for (const member of footprint) {
    requireSafeDigNeighborhood(bot, member, operation);
    requireCurrentBlockInteraction(bot, ctx, member, operation);
  }
  return footprint;
}

function requireSafeDigNeighborhood(bot, current, operation) {
  requireNoRemoteVibrationSensors(bot, [current.position], operation);
  if (isUnboundedBlockMutationDependency(current.name)
    || currentBlockMayReleaseFluid(current.block)) {
    throw worldActionDenied(
      'direct block-state dependency effects may mutate an unowned anchor',
      operation,
    );
  }
  // Phase 1 proves current/paired cells, known propagation-state blocks, and a
  // bounded two-hop face-neighbourhood (for example stone -> connected fence
  // -> observer). It does not claim noninterference for arbitrary unmarked
  // vanilla circuits beyond this radius; DNT remains a global deny boundary.
  for (const offset of INTENTIONAL_MUTATION_DEPENDENCY_OFFSETS) {
    const position = offsetPosition(current.position, offset);
    const adjacent = requireCurrentActionBlock(bot, position, operation);
    const name = adjacent.name;
    if (anchorKindForBlock(name)
      || isUnboundedBlockMutationDependency(name)
      || currentBlockMayReleaseFluid(adjacent.block)) {
      throw worldActionDenied(
        'block support/drop/fluid/state effects may reach an unowned anchor or dependency',
        operation,
      );
    }
  }
}

function mutationDependencyOffsets(radius) {
  const offsets = [];
  for (let x = -radius; x <= radius; x += 1) {
    for (let y = -radius; y <= radius; y += 1) {
      for (let z = -radius; z <= radius; z += 1) {
        const distance = Math.abs(x) + Math.abs(y) + Math.abs(z);
        if (distance < 1 || distance > radius) continue;
        offsets.push(Object.freeze({ x, y, z }));
      }
    }
  }
  return offsets;
}

function requireNoRemoteVibrationSensors(bot, positions, operation) {
  // Mineflayer's pinned findBlocks implementation rejects whole sections from
  // their palettes before inspecting individual blocks. Proving all intersecting
  // columns loaded first avoids its normal missing-column skip becoming a
  // fail-open result, without a 33^3 scan on every intentional action.
  if (typeof bot?.findBlocks !== 'function'
    || typeof bot?.world?.getColumn !== 'function') {
    throw worldActionDenied(
      'loaded vibration-sensor topology is unavailable',
      operation,
    );
  }
  const uniqueRequested = new Map();
  for (const requestedPosition of positions || []) {
    if (!finitePosition(requestedPosition)) {
      throw worldActionDenied('vibration event position is unavailable', operation);
    }
    uniqueRequested.set(positionKey(requestedPosition), requestedPosition);
  }
  for (const requestedPosition of uniqueRequested.values()) {
    const flooredPosition = {
      x: Math.floor(Number(requestedPosition.x)),
      y: Math.floor(Number(requestedPosition.y)),
      z: Math.floor(Number(requestedPosition.z)),
    };
    const center = typeof requestedPosition?.floored === 'function'
      ? requestedPosition
      : requireCurrentActionBlock(bot, flooredPosition, operation).block.position;
    const minChunkX = Math.floor((Number(center.x) - MAX_VANILLA_VIBRATION_RADIUS) / 16);
    const maxChunkX = Math.floor((Number(center.x) + MAX_VANILLA_VIBRATION_RADIUS) / 16);
    const minChunkZ = Math.floor((Number(center.z) - MAX_VANILLA_VIBRATION_RADIUS) / 16);
    const maxChunkZ = Math.floor((Number(center.z) + MAX_VANILLA_VIBRATION_RADIUS) / 16);
    for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX += 1) {
      for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ += 1) {
        let column;
        try {
          column = bot.world.getColumn(chunkX, chunkZ);
        } catch {
          column = null;
        }
        if (!column) {
          throw worldActionDenied(
            'vibration-sensor scan intersects an unreadable chunk column',
            operation,
          );
        }
      }
    }

    let matches;
    try {
      matches = bot.findBlocks({
        matching: (block) => VIBRATION_SENSOR_BLOCKS.has(normalizeBlockName(block?.name)),
        point: center,
        maxDistance: MAX_VANILLA_VIBRATION_RADIUS,
        count: 1,
        useExtraInfo: false,
      });
    } catch {
      matches = null;
    }
    if (!Array.isArray(matches)) {
      throw worldActionDenied('vibration-sensor scan failed', operation);
    }
    if (matches.length > 0) {
      const sensor = requireCurrentActionBlock(bot, matches[0], operation);
      if (!VIBRATION_SENSOR_BLOCKS.has(sensor.name)) {
        throw worldActionDenied('vibration-sensor scan changed before authorization', operation);
      }
      throw worldActionDenied(
        'remote vibration sensor can trigger unowned automation',
        operation,
      );
    }
  }
}

function isUnboundedBlockMutationDependency(name) {
  const normalized = normalizeBlockName(name);
  return isContainerMutationDependency(normalized)
    || AUTONOMOUS_OUTPUT_CONTAINERS.has(normalized)
    || GRAVITY_DEPENDENCY_BLOCKS.has(normalized)
    || STATE_PROPAGATION_DEPENDENCIES.has(normalized)
    || normalized.endsWith('_leaves')
    || normalized.endsWith('_concrete_powder')
    || normalized === 'water'
    || normalized === 'lava'
    || normalized === 'bubble_column'
    || normalized === 'ice'
    || normalized === 'frosted_ice';
}

function currentBlockMayReleaseFluid(block) {
  if (typeof block?.getProperties !== 'function') return true;
  try {
    const properties = block.getProperties();
    return properties?.waterlogged === true || properties?.waterlogged === 'true';
  } catch {
    // An unreadable property set cannot prove that replacement is dry.
    return true;
  }
}

function isContainerMutationDependency(name) {
  const normalized = normalizeBlockName(name);
  return CONTAINER_MUTATION_DEPENDENCIES.has(normalized)
    || normalized.endsWith('_button')
    || normalized.endsWith('_pressure_plate')
    || normalized.endsWith('_copper_bulb')
    || normalized === 'tnt'
    || normalized === 'bell'
    || normalized === 'sculk_shrieker'
    || normalized === 'command_block'
    || normalized === 'chain_command_block'
    || normalized === 'repeating_command_block';
}

function requireNoNearbyEntityDigEffects(bot, position, operation) {
  if (!bot?.entities || typeof bot.entities !== 'object') return;
  const selfId = Number(bot?.entity?.id);
  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity === bot.entity || Number(entity.id) === selfId) continue;
    throw worldActionDenied(
      'dig cascade may detach, move, damage, or spill an observed unowned entity',
      operation,
    );
  }
}

function requireBlockPlaceReferenceFootprint(bot, ctx, current, operation) {
  const access = requireCurrentBlockInteraction(bot, ctx, current, operation);
  const footprint = pairedBlockFootprint(bot, current, operation);
  for (const member of footprint.slice(1)) {
    requireCurrentBlockInteraction(bot, ctx, member, operation);
  }
  return access;
}

function pairedBlockFootprint(bot, current, operation) {
  if (isBedBlock(current.name)) return bedFootprint(bot, current, operation);
  if (isDoorBlock(current.name)) return verticalPairFootprint(bot, current, operation, 'door');
  if (current.name === PITCHER_CROP_BLOCK) return pitcherCropFootprint(bot, current, operation);
  if (DOUBLE_HEIGHT_PLANTS.has(current.name)) {
    return verticalPairFootprint(bot, current, operation, 'double-height plant');
  }
  return [current];
}

function bedFootprint(bot, current, operation) {
  const properties = requireBlockProperties(current.block, 'bed', operation);
  const part = normalizeBlockName(properties.part);
  const facing = normalizeBlockName(properties.facing);
  const facingOffset = CARDINAL_OFFSETS[facing];
  if (!['head', 'foot'].includes(part) || !facingOffset) {
    throw worldActionDenied('bed part or facing is malformed', operation);
  }
  const scale = part === 'foot' ? 1 : -1;
  const partnerPosition = offsetPosition(current.position, facingOffset, scale);
  const partner = requireCurrentActionBlock(bot, partnerPosition, operation);
  if (partner.name !== current.name) {
    throw worldActionDenied('bed partner type does not match', operation);
  }
  const partnerProperties = requireBlockProperties(partner.block, 'bed partner', operation);
  if (
    normalizeBlockName(partnerProperties.part) !== (part === 'foot' ? 'head' : 'foot')
    || normalizeBlockName(partnerProperties.facing) !== facing
  ) {
    throw worldActionDenied('bed partner state does not match', operation);
  }
  return [current, partner];
}

function pitcherCropFootprint(bot, current, operation) {
  const properties = requireBlockProperties(current.block, 'pitcher crop', operation);
  const age = Number(properties.age);
  const half = normalizeBlockName(properties.half);
  if (!Number.isInteger(age) || age < 0 || age > 4 || !['lower', 'upper'].includes(half)) {
    throw worldActionDenied('pitcher-crop age or half is malformed', operation);
  }
  if (age < 3) {
    if (half !== 'lower') throw worldActionDenied('young pitcher crop has an invalid upper half', operation);
    return [current];
  }
  const footprint = verticalPairFootprint(bot, current, operation, 'pitcher crop');
  const partnerProperties = requireBlockProperties(footprint[1].block, 'pitcher-crop partner', operation);
  if (Number(partnerProperties.age) !== age) {
    throw worldActionDenied('pitcher-crop partner age does not match', operation);
  }
  return footprint;
}

function verticalPairFootprint(bot, current, operation, label) {
  const properties = requireBlockProperties(current.block, label, operation);
  const half = normalizeBlockName(properties.half);
  if (!['lower', 'upper'].includes(half)) {
    throw worldActionDenied(`${label} half is malformed`, operation);
  }
  if (label === 'door') {
    const facing = normalizeBlockName(properties.facing);
    const hinge = normalizeBlockName(properties.hinge);
    if (!CARDINAL_OFFSETS[facing] || !['left', 'right'].includes(hinge)) {
      throw worldActionDenied('door facing or hinge is malformed', operation);
    }
  }
  if (current.name === 'small_dripleaf' && !CARDINAL_OFFSETS[normalizeBlockName(properties.facing)]) {
    throw worldActionDenied('small-dripleaf facing is malformed', operation);
  }

  const partnerPosition = offsetPosition(current.position, { x: 0, y: 1, z: 0 }, half === 'lower' ? 1 : -1);
  const partner = requireCurrentActionBlock(bot, partnerPosition, operation);
  if (partner.name !== current.name) {
    throw worldActionDenied(`${label} partner type does not match`, operation);
  }
  const partnerProperties = requireBlockProperties(partner.block, `${label} partner`, operation);
  if (normalizeBlockName(partnerProperties.half) !== (half === 'lower' ? 'upper' : 'lower')) {
    throw worldActionDenied(`${label} partner half does not match`, operation);
  }
  if (label === 'door') {
    if (
      normalizeBlockName(partnerProperties.facing) !== normalizeBlockName(properties.facing)
      || normalizeBlockName(partnerProperties.hinge) !== normalizeBlockName(properties.hinge)
    ) {
      throw worldActionDenied('door partner geometry does not match', operation);
    }
  }
  if (
    current.name === 'small_dripleaf'
    && normalizeBlockName(partnerProperties.facing) !== normalizeBlockName(properties.facing)
  ) {
    throw worldActionDenied('small-dripleaf partner geometry does not match', operation);
  }
  return [current, partner];
}

function requireBlockProperties(block, label, operation) {
  const properties = currentBlockProperties(block);
  if (properties.error) {
    throw worldActionDenied(`${label} properties could not be verified: ${properties.error.message}`, operation);
  }
  return properties.value;
}

function requirePlacementAffectedFootprint(bot, boundary, ctx, reference, faceVector, packetItem, operation) {
  const adjacentTarget = placementTarget(reference.position, faceVector);
  if (!adjacentTarget) throw worldActionDenied('placement target is unavailable', operation);
  const primaryPositions = [adjacentTarget];
  if (isPairedPlantBlock(reference.name)) primaryPositions.push(reference.position);

  const plannedPositions = [];
  for (const primary of uniquePositions(primaryPositions)) {
    plannedPositions.push(...placementGeometryPositions(bot, boundary, primary, packetItem, operation));
  }

  const affected = new Map();
  for (const position of uniquePositions(plannedPositions)) {
    const live = requireCurrentActionBlock(bot, position, operation);
    affected.set(positionKey(live.position), live);
    if (isPairedPlantBlock(live.name)) {
      for (const member of pairedBlockFootprint(bot, live, operation)) {
        affected.set(positionKey(member.position), member);
      }
    }
  }

  for (const member of affected.values()) {
    requireSafeDigNeighborhood(bot, member, operation);
    requireWorldAction(authorizePlacementWithCurrentReference(bot, ctx, member.position, {
      referencePosition: reference.position,
      referenceBlockName: reference.name,
    }, reference), operation);
    requireCurrentBlockInteraction(bot, ctx, member, operation);
  }
  if (AUTONOMOUS_OUTPUT_CONTAINERS.has(packetItem.blockName)) {
    // Even a clear block footprint cannot prove future effects: an unowned
    // inventory-bearing minecart can move over a hopper, while a later redstone
    // pulse can make a dropper/dispenser transfer or mutate outside the guarded
    // action. Until output provenance is tracked, placement fails closed.
    throw worldActionDenied('autonomous container output provenance cannot be proven', operation);
  }
  return [...affected.values()];
}

function placementGeometryPositions(bot, boundary, primary, packetItem, operation) {
  const positions = [positionRecord(primary)];
  const blockName = packetItem.blockName;
  if (!blockName || isWorldMutatingBucket(packetItem.itemName)) return positions;
  if (!modeledPlacementBlock(blockName)) {
    throw worldActionDenied('block placement effect is not explicitly modeled', operation);
  }
  if (isDoorBlock(blockName) || DOUBLE_HEIGHT_PLANTS.has(blockName)) {
    positions.push(offsetPosition(primary, { x: 0, y: 1, z: 0 }));
    return positions;
  }
  if (blockName === 'chest' || blockName === 'trapped_chest') {
    for (const offset of Object.values(CARDINAL_OFFSETS)) {
      positions.push(offsetPosition(primary, offset));
    }
    return positions;
  }
  if (AUTONOMOUS_OUTPUT_CONTAINERS.has(blockName)) {
    // Hoppers can pull from above/output in several directions; droppers and
    // dispensers can face any direction. The packet does not expose enough
    // placement state to prove one exact face, so authorize all six neighbours.
    for (const offset of [
      ...Object.values(CARDINAL_OFFSETS),
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
    ]) {
      positions.push(offsetPosition(primary, offset));
    }
    return positions;
  }
  if (isBedBlock(blockName)) {
    const facing = horizontalFacingFromNotchYaw(boundary?.clientState?.pose?.yaw);
    if (!facing) throw worldActionDenied('server-correlated bed placement facing is unavailable', operation);
    positions.push(offsetPosition(primary, CARDINAL_OFFSETS[facing]));
  }
  return positions;
}

function currentPacketPlacementItem(bot, boundary, packet, placementInvocation, frame) {
  const hasHand = Object.hasOwn(packet || {}, 'hand');
  let offHand = false;
  if (hasHand) {
    if (packet.hand !== 0 && packet.hand !== 1) {
      return { error: 'block-place packet hand is malformed' };
    }
    offHand = packet.hand === 1;
  }
  const genericPlacement = findActiveInvocation(frame, (candidate) => candidate.entry.name === '_genericPlace');
  const expectedOffHand = genericPlacement?.args?.[2]?.offhand === true;
  if (placementInvocation && expectedOffHand !== offHand) {
    return { error: 'block-place packet hand does not match placement options' };
  }
  if (placementInvocation && expectedOffHand && !hasHand) {
    return { error: 'offhand placement packet does not identify its hand' };
  }

  const itemName = authoritativeActivatedItemName(bot, boundary, offHand);
  if (!itemName) return { itemName: '', blockName: null, offHand };
  const blocksByName = bot?.registry?.blocksByName;
  if (!blocksByName || typeof blocksByName !== 'object') {
    return { error: 'placement item registry is unavailable' };
  }
  return {
    itemName,
    blockName: blocksByName[itemName] ? itemName : null,
    offHand,
  };
}

function isBedBlock(name) {
  return name === 'bed' || name.endsWith('_bed');
}

function modeledPlacementBlock(name) {
  return MODELED_INERT_SINGLE_CELL_PLACEMENTS.has(name)
    || AUTONOMOUS_OUTPUT_CONTAINERS.has(name)
    || isDoorBlock(name)
    || isBedBlock(name)
    || DOUBLE_HEIGHT_PLANTS.has(name);
}

function isUnmodeledExplosiveActivation(name) {
  return name === 'respawn_anchor' || isBedBlock(name);
}

function isDoorBlock(name) {
  return name === 'door' || name.endsWith('_door');
}

function isPairedPlantBlock(name) {
  return name === PITCHER_CROP_BLOCK || DOUBLE_HEIGHT_PLANTS.has(name);
}

function offsetPosition(position, offset, scale = 1) {
  return {
    x: Number(position.x) + Number(offset.x) * scale,
    y: Number(position.y) + Number(offset.y) * scale,
    z: Number(position.z) + Number(offset.z) * scale,
  };
}

function uniquePositions(positions) {
  const unique = new Map();
  for (const position of positions) {
    if (!finitePosition(position)) continue;
    unique.set(positionKey(position), positionRecord(position));
  }
  return [...unique.values()];
}

function positionKey(position) {
  const normalized = positionRecord(position);
  return `${normalized.x},${normalized.y},${normalized.z}`;
}

function horizontalFacingFromNotchYaw(yaw) {
  if (!Number.isFinite(Number(yaw))) return null;
  const notchDegrees = ((Number(yaw) % 360) + 360) % 360;
  return ['south', 'west', 'north', 'east'][Math.round(notchDegrees / 90) % 4];
}

function findActiveInvocation(frame, predicate) {
  for (let current = frame; current; current = current.parent) {
    if (predicate(current)) return current;
  }
  return null;
}

function isNonWorldBlockPlacePacket(packet) {
  return Number(packet?.direction) === -1
    && Number(packet?.location?.x) === -1
    && Number(packet?.location?.y) === 255
    && Number(packet?.location?.z) === -1;
}

function blockFaceVector(direction) {
  return {
    0: { x: 0, y: -1, z: 0 },
    1: { x: 0, y: 1, z: 0 },
    2: { x: 0, y: 0, z: -1 },
    3: { x: 0, y: 0, z: 1 },
    4: { x: -1, y: 0, z: 0 },
    5: { x: 1, y: 0, z: 0 },
  }[Number(direction)] || null;
}

function safelyAbortDeniedDig(bot, position) {
  const frame = WORLD_ACTION_INVOCATION.getStore() || null;
  if (!findActiveInvocation(frame, (candidate) => candidate.entry.name === 'dig')) return false;
  if (!samePosition(bot?.targetDigBlock?.position, position) || typeof bot?.stopDigging !== 'function') return false;
  const restoreUpdate = suppressNextLocalDigCompletion(bot, position);
  try {
    bot.stopDigging();
    queueMicrotask(restoreUpdate);
    return true;
  } catch {
    restoreUpdate();
    return false;
  }
}

function suppressNextLocalDigCompletion(bot, position) {
  const original = bot?._updateBlockState;
  if (typeof original !== 'function') return () => {};
  let active = true;
  const wrapper = function authorizedDigStateUpdate(updatePosition, ...args) {
    if (active && samePosition(updatePosition, position)) {
      active = false;
      if (bot._updateBlockState === wrapper) bot._updateBlockState = original;
      return undefined;
    }
    return original.call(this, updatePosition, ...args);
  };
  bot._updateBlockState = wrapper;
  return () => {
    active = false;
    if (bot._updateBlockState === wrapper) bot._updateBlockState = original;
  };
}

export function filterAuthorizedAnchors(bot, ctx, candidates, kind, opts = {}) {
  const accessible = [];
  const denied = [];
  for (const candidate of candidates || []) {
    const position = candidate?.position;
    const decision = kind === WORLD_ANCHOR_KIND.WORKSTATION
      ? authorizeWorkstationAccess(bot, ctx, position, { ...opts, blockName: candidate?.name || opts.blockName })
      : authorizeStorageAccess(bot, ctx, position, { ...opts, blockName: candidate?.name || opts.blockName });
    if (decision.ok) accessible.push(candidate);
    else denied.push({ candidate, policy: decision });
  }
  return { accessible, denied };
}

export function observeWorldActionSession(bot, ctx = {}, suppliedState = null) {
  const state = suppliedState || worldActionAuthorizationFromContext(ctx);
  if (!state) return { known: false, exclusive: false, others: [] };
  installRuntimeFields(state);
  synchronizeBoundaryRevocation(bot, state);
  bindWorldActionLifecycle(bot, ctx, state);

  const players = bot?.players;
  if (!players || typeof players !== 'object') {
    return { known: false, exclusive: false, others: [] };
  }
  const selfNames = botSelfNames(bot);
  const names = Object.entries(players)
    .map(([key, value]) => cleanIdentity(value?.username) || cleanIdentity(key))
    .filter(Boolean);
  const selfPresent = names.some((name) => selfNames.has(name));
  const others = names.filter((name) => !selfNames.has(name));
  if (others.length > 0) revokeDisposableTrust(state, `another player observed: ${others.sort()[0]}`, bot);
  return {
    known: selfPresent,
    exclusive: selfPresent && others.length === 0,
    others: [...new Set(others)].sort(),
  };
}

function authorizeAnchoredWorldAction(bot, ctx, kind, position, opts) {
  if (!finitePosition(position)) {
    return { ok: false, action: 'deny', reason: `${kind} position is unavailable` };
  }
  const protectedResult = doNotTouchDecision(ctx, position, opts);
  if (!protectedResult.ok) return protectedResult;

  const state = worldActionAuthorizationFromContext(ctx);
  if (!state) {
    return { ok: false, action: 'deny', reason: `${kind} access requires explicit world-action authorization` };
  }
  const identityRecord = observedWorldIdentityRecord(bot, false);
  if (identityRecord) {
    bindObservedIdentityToState(bot, state, bot?.[WORLD_ACTION_BOUNDARY] || null, identityRecord);
  }
  const exclusivity = observeWorldActionSession(bot, ctx, state);
  const identity = currentWorldIdentity(bot, ctx, state);
  const anchorIdentity = currentAnchorScopeIdentity(bot, ctx, state);
  const dimension = currentDimension(bot);
  const blockName = normalizeBlockName(opts.blockName);
  const anchor = state.anchors.find((candidate) => anchorMatches(candidate, {
    kind,
    position,
    blockName,
    dimension,
    worldIdentity: anchorIdentity,
    sessionIdentity: state.sessionIdentity,
  }));
  if (anchor) {
    return {
      ok: true,
      action: 'allow',
      reason: `trusted ${anchor.provenance} ${kind} anchor`,
      anchor,
    };
  }

  if (disposableNaturalTrustAllowed(state, identity, exclusivity)) {
    return {
      ok: true,
      action: 'allow',
      reason: 'trusted natural anchor in fresh disposable single-player session',
      disposableSession: true,
    };
  }

  const reason = state.disposableTrustRevoked
    ? `unowned ${kind} denied after disposable-world trust revocation`
    : `unowned ${kind} denied by owned-only policy`;
  return { ok: false, action: 'deny', reason };
}

function disposableNaturalTrustAllowed(state, identity, exclusivity) {
  const expectedWorldIdentity = cleanIdentity(state.freshWorldIdentity)
    || cleanIdentity(state._initialObservedWorldIdentity);
  return state.mode === WORLD_ACTION_MODE.DISPOSABLE_SINGLE_PLAYER
    && state.createdFreshWorld === true
    && state.singlePlayer === true
    && state.sessionIdentityExplicit === true
    && Boolean(expectedWorldIdentity)
    && identity === expectedWorldIdentity
    && state.disposableTrustRevoked !== true
    && exclusivity.known === true
    && exclusivity.exclusive === true;
}

function doNotTouchDecision(ctx, position, opts) {
  const loaded = loadWorldModelForFinalDecision(ctx, opts.worldModel);
  if (loaded.error) {
    return {
      ok: false,
      action: 'deny',
      reason: `world-model policy unavailable: ${loaded.error.message || String(loaded.error)}`,
    };
  }
  const model = loaded.model;
  if (!model) return { ok: true };
  const policy = blockModificationPolicy(model, position, { margin: opts.doNotTouchMargin ?? 0 });
  if (policy.ok) return { ok: true };
  return {
    ...policy,
    ok: false,
    action: 'deny',
    reason: policy.reason,
  };
}

function loadWorldModelForFinalDecision(ctx = {}, suppliedModel = null) {
  const source = worldModelSourceFromContext(ctx);
  if (source.store?.load) {
    try {
      return { model: source.store.load() };
    } catch (error) {
      return { error };
    }
  }
  return { model: source.model || suppliedModel || null };
}

function currentWorldIdentity(bot, ctx) {
  const record = observedWorldIdentityRecord(bot, false);
  return record && record.revoked !== true ? cleanIdentity(record.identity) : null;
}

function currentAnchorScopeIdentity(bot, ctx, state) {
  const observed = currentWorldIdentity(bot, ctx, state);
  if (observed) return observed;
  // An operator-configured identity may scope explicit anchors, but it is not
  // independent observation and is never used by disposableNaturalTrustAllowed.
  const configured = cleanIdentity(bot?.worldIdentity)
    || cleanIdentity(ctx?.worldIdentity)
    || cleanIdentity(ctx?.runtimeContext?.worldIdentity)
    || cleanIdentity(state?.worldIdentity);
  if (configured) return configured;
  if (!bot || (typeof bot !== 'object' && typeof bot !== 'function')) {
    return `opaque-session:${state.sessionIdentity}`;
  }
  let scope = state._botScopes.get(bot);
  if (!scope) {
    scope = randomUUID();
    state._botScopes.set(bot, scope);
  }
  return `opaque-connection:${scope}`;
}

function currentDimension(bot) {
  return cleanIdentity(bot?.game?.dimension || bot?.game?.dimensionType || bot?.dimension) || 'unknown';
}

function anchorMatches(anchor, wanted) {
  if (anchor.kind !== wanted.kind || !samePosition(anchor.position, wanted.position)) return false;
  if (anchor.blockName && wanted.blockName && anchor.blockName !== wanted.blockName) return false;
  if (!dimensionMatches(anchor.dimension, wanted.dimension)) return false;
  if (anchor.worldIdentity && anchor.worldIdentity !== wanted.worldIdentity) return false;
  if (anchor.provenance === 'bot_placed_current_session' && anchor.sessionIdentity !== wanted.sessionIdentity) return false;
  return true;
}

function registerAnchor(state, anchor) {
  const normalized = normalizeAnchor(anchor, state);
  if (!normalized) return null;
  state.anchors = state.anchors.filter((candidate) => !(
    candidate.kind === normalized.kind
    && samePosition(candidate.position, normalized.position)
    && dimensionMatches(candidate.dimension, normalized.dimension)
  ));
  state.anchors.push(normalized);
  return normalized;
}

function normalizeAnchor(anchor, state) {
  const kind = normalizeAnchorKind(anchor?.kind, anchor?.blockName || anchor?.name);
  if (!kind || !finitePosition(anchor?.position)) return null;
  const provenance = anchor.provenance === 'bot_placed_current_session'
    ? 'bot_placed_current_session'
    : 'operator_configured';
  const worldIdentity = cleanIdentity(anchor.worldIdentity);
  if (provenance === 'operator_configured' && !worldIdentity) return null;
  return {
    kind,
    blockName: normalizeBlockName(anchor.blockName || anchor.name) || null,
    position: positionRecord(anchor.position),
    dimension: cleanIdentity(anchor.dimension) || 'unknown',
    worldIdentity,
    sessionIdentity: provenance === 'bot_placed_current_session'
      ? cleanIdentity(anchor.sessionIdentity) || state.sessionIdentity
      : null,
    provenance,
  };
}

function normalizeExistingState(input) {
  return createWorldActionAuthorization({
    ...input,
    operatorAnchors: (input.anchors || []).filter((anchor) => anchor?.provenance !== 'bot_placed_current_session'),
  });
}

function assignState(target, state) {
  target.worldActionAuthorization = state;
}

function installRuntimeFields(state) {
  if (!Array.isArray(state.anchors)) state.anchors = [];
  if (!Object.hasOwn(state, '_boundBots')) {
    Object.defineProperty(state, '_boundBots', {
      value: new WeakSet(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  if (!Object.hasOwn(state, '_botScopes')) {
    Object.defineProperty(state, '_botScopes', {
      value: new WeakMap(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  if (!Object.hasOwn(state, '_initialObservedWorldIdentity')) {
    Object.defineProperty(state, '_initialObservedWorldIdentity', {
      value: null,
      enumerable: false,
      configurable: false,
      writable: true,
    });
  }
}

function bindWorldActionLifecycle(bot, ctx, state) {
  if (!bot || typeof bot.on !== 'function' || state._boundBots.has(bot)) return;
  state._boundBots.add(bot);
  bot.on('playerJoined', (player) => {
    const name = cleanIdentity(player?.username || player?.name);
    if (!name) {
      revokeDisposableTrust(state, 'unidentified player joined', bot);
      return;
    }
    if (botSelfNames(bot).has(name)) return;
    revokeDisposableTrust(state, `another player joined: ${name}`, bot);
  });
  bot.on('blockUpdate', (oldBlock, newBlock) => {
    const position = oldBlock?.position || newBlock?.position;
    if (!finitePosition(position)) return;
    const replacementName = normalizeBlockName(newBlock?.name);
    const dimension = currentDimension(bot);
    const worldIdentity = currentAnchorScopeIdentity(bot, ctx, state);
    state.anchors = state.anchors.filter((anchor) => !(
      anchor.provenance === 'bot_placed_current_session'
      && samePosition(anchor.position, position)
      && dimensionMatches(anchor.dimension, dimension)
      && anchor.worldIdentity === worldIdentity
      && anchor.sessionIdentity === state.sessionIdentity
      && anchor.blockName !== replacementName
    ));
  });
  const closeSession = (reason) => {
    state.anchors = state.anchors.filter((anchor) => anchor.provenance !== 'bot_placed_current_session');
    revokeDisposableTrust(state, reason, bot);
  };
  bot.once?.('end', () => closeSession('world connection ended'));
  bot.once?.('kicked', () => closeSession('world connection kicked'));
}

function revokeDisposableTrust(state, reason, bot = null) {
  revokeStateTrust(state, reason);
  const boundary = bot?.[WORLD_ACTION_BOUNDARY];
  if (!boundary) return;

  rememberBoundaryRevocation(boundary, state.revocationReason || reason);
  const currentState = stateForBoundaryContext(boundary.context);
  if (currentState && currentState !== state) {
    revokeStateTrust(currentState, boundary.revocationReason);
  }
}

function botSelfNames(bot) {
  return new Set([
    cleanIdentity(bot?.username),
    cleanIdentity(bot?.player?.username),
  ].filter(Boolean));
}

function runtimeContext(ctx) {
  return ctx?.runtimeContext && typeof ctx.runtimeContext === 'object'
    ? ctx.runtimeContext
    : (ctx && typeof ctx === 'object' ? ctx : null);
}

function normalizeAnchorKind(kind, blockName) {
  if (kind === WORLD_ANCHOR_KIND.STORAGE || kind === WORLD_ANCHOR_KIND.WORKSTATION) return kind;
  return anchorKindForBlock(blockName);
}

function anchorKindForBlock(blockName) {
  const normalized = normalizeBlockName(blockName);
  if (
    STORAGE_BLOCKS.has(normalized)
    || normalized.endsWith('_shulker_box')
    || normalized === 'copper_chest'
    || normalized.endsWith('_copper_chest')
    || normalized.endsWith('_shelf')
    || normalized.startsWith('potted_')
  ) return WORLD_ANCHOR_KIND.STORAGE;
  if (WORKSTATION_BLOCKS.has(normalized)) return WORLD_ANCHOR_KIND.WORKSTATION;
  return null;
}

function normalizeBlockName(value) {
  return typeof value === 'string' ? value.replace(/^minecraft:/, '').trim() : '';
}

function normalizeEntityType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizedEntityName(entity) {
  return normalizeBlockName(entity?.name).toLowerCase().replace(/[\s-]+/g, '_');
}

function requireAttackableEntity(bot, ctx, target, operation) {
  const id = Number(target?.id);
  const name = normalizedEntityName(target);
  const type = normalizeEntityType(target?.type);
  if (!target
    || target === bot?.entity
    || !Number.isSafeInteger(id)
    || id < 0
    || bot?.entities?.[id] !== target
    || type !== 'mob'
    || !DIRECT_ATTACKABLE_HOSTILE_MOBS.has(name)
    || !finitePosition(target.position)) {
    throw worldActionDenied(
      'target is not an exact live non-container, non-explosive hostile mob',
      operation,
    );
  }
  requireWorldAction(doNotTouchDecision(ctx, positionRecord(target.position), {}), operation);
  return target;
}

function canonicalServerHashedSeed(value) {
  if (typeof value === 'bigint') return `bigint:${value.toString(10)}`;
  if (Number.isSafeInteger(value)) return `integer:${value}`;
  if (Array.isArray(value)
    && value.length === 2
    && value.every((part) => Number.isInteger(part) && part >= -0x80000000 && part <= 0xffffffff)) {
    return `i32-pair:${value[0]}:${value[1]}`;
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return bytes.byteLength === 8
      ? `bytes:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
      : null;
  }
  if (value && typeof value === 'object') {
    const high = value.high;
    const low = value.low;
    if (Number.isInteger(high) && Number.isInteger(low)) return `high-low:${high}:${low}`;
  }
  return null;
}

function observedWorldIdentityRecord(bot, create) {
  if (!bot || (typeof bot !== 'object' && typeof bot !== 'function')) return null;
  const existing = bot[OBSERVED_WORLD_IDENTITY];
  if (existing && typeof existing === 'object') return existing;
  if (!create) return null;
  const record = {
    identity: null,
    source: null,
    revoked: false,
    reason: null,
  };
  try {
    Object.defineProperty(bot, OBSERVED_WORLD_IDENTITY, {
      value: record,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return record;
  } catch {
    return null;
  }
}

function bindObservedIdentityToState(bot, state, boundary, record) {
  installRuntimeFields(state);
  if (record.revoked || !record.identity) {
    revokeDisposableTrust(
      state,
      record.reason || 'server world identity evidence is unavailable',
      bot,
    );
    return;
  }
  const configuredExpected = cleanIdentity(state.freshWorldIdentity);
  if (configuredExpected && configuredExpected !== record.identity) {
    revokeObservedWorldIdentity(
      bot,
      state,
      boundary,
      record,
      'observed server world identity does not match the expected fresh world',
    );
    return;
  }
  if (state._initialObservedWorldIdentity
    && state._initialObservedWorldIdentity !== record.identity) {
    revokeObservedWorldIdentity(
      bot,
      state,
      boundary,
      record,
      'observed server world identity changed after initial binding',
    );
    return;
  }
  if (!state._initialObservedWorldIdentity) {
    state._initialObservedWorldIdentity = record.identity;
  }
}

function revokeObservedWorldIdentity(bot, state, boundary, record, reason) {
  record.revoked = true;
  record.reason = record.reason || reason || 'server world identity evidence was revoked';
  if (boundary) rememberBoundaryRevocation(boundary, record.reason);
  if (state) revokeDisposableTrust(state, record.reason, bot);
}

function cleanIdentity(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finitePosition(position) {
  return ['x', 'y', 'z'].every((axis) => Number.isFinite(Number(position?.[axis])));
}

function positionRecord(position) {
  return {
    x: Math.floor(Number(position.x)),
    y: Math.floor(Number(position.y)),
    z: Math.floor(Number(position.z)),
  };
}

function samePosition(a, b) {
  if (!finitePosition(a) || !finitePosition(b)) return false;
  const left = positionRecord(a);
  const right = positionRecord(b);
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function dimensionMatches(a, b) {
  return (a || 'unknown') === (b || 'unknown');
}

function wrapWorldActionMethod(bot, boundary, name, invoke) {
  const current = bot[name];
  const installed = boundary.methods.get(name);
  if (installed) {
    installed.invoke = invoke;
    if (current === installed.wrapper || typeof current !== 'function') return;

    // Keep one stable exposed wrapper. A decorator may have captured that
    // wrapper before replacing the method, so retain the prior delegate as the
    // next link instead of wrapping wrappers or recursing back into the new
    // decorator. The async invocation context selects the prior link when the
    // decorator calls the captured wrapper, even after an await.
    const retained = findWorldActionDelegate(installed.delegate, current);
    installed.delegate = retained || { fn: current, previous: installed.delegate };
    bot[name] = installed.wrapper;
    return;
  }
  if (typeof current !== 'function') return;

  const entry = {
    name,
    family: worldActionMethodFamily(name),
    invoke,
    delegate: { fn: current, previous: null },
    wrapper: null,
  };
  entry.wrapper = function authorizedWorldAction(...args) {
    return invokeWorldActionEntry(entry, this, args);
  };
  boundary.methods.set(name, entry);
  bot[name] = entry.wrapper;
}

function invokeWorldActionEntry(entry, receiver, args) {
  const parent = WORLD_ACTION_INVOCATION.getStore() || null;
  const active = activeInvocationForEntry(parent, entry);
  const activeFamily = activeInvocationForFamily(parent, entry.family);
  const delegate = active ? active.delegate.previous : entry.delegate;
  if (!delegate || typeof delegate.fn !== 'function') {
    throw worldActionDenied('recursive world-action replacement exhausted its original method', entry.name);
  }
  const effectiveArgs = inheritWorldActionMetadata(entry.name, args, active?.args);
  // Re-authorize at each decorator-to-boundary handoff because the decorator
  // may have changed its arguments or the authoritative doNotTouch model.
  // Only the innermost physical call runs the placement/break post-hook.
  if (activeFamily) activeFamily.delegatedToBoundary = true;
  const frame = {
    entry,
    delegate,
    args: effectiveArgs,
    parent,
    delegatedToBoundary: false,
  };
  return WORLD_ACTION_INVOCATION.run(
    frame,
    () => entry.invoke(delegate.fn, receiver, effectiveArgs, frame),
  );
}

function findWorldActionDelegate(delegate, candidate) {
  for (let current = delegate; current; current = current.previous) {
    if (current.fn === candidate) return current;
  }
  return null;
}

function activeInvocationForEntry(frame, entry) {
  for (let current = frame; current; current = current.parent) {
    if (current.entry === entry) return current;
  }
  return null;
}

function activeInvocationForFamily(frame, family) {
  for (let current = frame; current; current = current.parent) {
    if (current.entry.family === family) return current;
  }
  return null;
}

function worldActionMethodFamily(name) {
  if (name === 'placeBlock' || name === '_placeBlockWithOptions' || name === '_genericPlace') {
    return 'placement';
  }
  return name;
}

function inheritWorldActionMetadata(name, args, inheritedArgs) {
  if (name !== 'activateItem' || args[1]?.worldAction || !inheritedArgs?.[1]?.worldAction) {
    return args;
  }
  const options = args[1] && typeof args[1] === 'object' ? args[1] : {};
  return [args[0], { ...options, worldAction: inheritedArgs[1].worldAction }];
}

function replaceBoundaryContext(bot, boundary, nextContext) {
  const previousState = stateForBoundaryContext(boundary.context);
  synchronizeBoundaryRevocation(bot, previousState, boundary);
  boundary.context = nextContext;
  refreshMovementProtectionTracking(boundary, nextContext);
  const nextState = stateForBoundaryContext(nextContext);
  synchronizeBoundaryRevocation(bot, nextState, boundary);
  const identityRecord = observedWorldIdentityRecord(bot, false);
  if (nextState && identityRecord) {
    bindObservedIdentityToState(bot, nextState, boundary, identityRecord);
  }
}

function releaseMovementProtectionTracking(boundary, reason) {
  const stickyDnt = boundary.movementProtection?.stickyDnt === true;
  boundary.movementProtectionGeneration = nextSafeEpoch(boundary.movementProtectionGeneration);
  try {
    boundary.movementProtectionUnsubscribe?.();
  } catch {
    // The generation advance still makes a retained listener harmless.
  }
  boundary.movementProtectionUnsubscribe = null;
  boundary.movementProtection = {
    source: 'closed',
    store: null,
    generation: boundary.movementProtectionGeneration,
    revision: null,
    known: false,
    stickyDnt,
    error: new Error(reason || 'world connection is closed'),
  };
}

function synchronizeBoundaryRevocation(bot, state, suppliedBoundary = null) {
  if (!state) return;
  const boundary = suppliedBoundary || bot?.[WORLD_ACTION_BOUNDARY];
  if (!boundary) return;
  if (state.disposableTrustRevoked === true) {
    rememberBoundaryRevocation(boundary, state.revocationReason);
  }
  if (boundary.disposableTrustRevoked === true) {
    revokeStateTrust(state, boundary.revocationReason);
    const currentState = stateForBoundaryContext(boundary.context);
    if (currentState && currentState !== state) {
      revokeStateTrust(currentState, boundary.revocationReason);
    }
  }
}

function rememberBoundaryRevocation(boundary, reason) {
  if (boundary.disposableTrustRevoked === true) return;
  boundary.disposableTrustRevoked = true;
  boundary.revocationReason = reason || 'disposable-world trust revoked for this connection';
}

function revokeStateTrust(state, reason) {
  if (!state || state.disposableTrustRevoked === true) return;
  state.disposableTrustRevoked = true;
  state.revocationReason = reason || 'disposable-world trust revoked';
}

function stateForBoundaryContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  return worldActionAuthorizationFromContext(ctx);
}

function requireWorldAction(decision, operation) {
  if (decision?.ok) return decision;
  throw worldActionDenied(decision?.reason || `${operation} denied`, operation, decision);
}

function worldActionDenied(reason, operation, decision = null) {
  const error = new Error(`World action denied (${operation}): ${reason}`);
  error.code = 'WORLD_ACTION_DENIED';
  error.policy = decision;
  return error;
}

function placementTarget(referencePosition, faceVector) {
  if (!finitePosition(referencePosition) || !finitePosition(faceVector)) return null;
  return {
    x: Number(referencePosition.x) + Number(faceVector.x),
    y: Number(referencePosition.y) + Number(faceVector.y),
    z: Number(referencePosition.z) + Number(faceVector.z),
  };
}

function heldPlaceableBlockName(bot, boundary) {
  const name = authoritativeActivatedItemName(bot, boundary, false);
  if (!name) return null;
  const blocksByName = bot?.registry?.blocksByName;
  if (!blocksByName || typeof blocksByName !== 'object') return undefined;
  return blocksByName[name] ? name : null;
}

function authoritativeActivatedItemName(bot, boundary, offHand) {
  if (boundary?.itemStateCoherent !== true) return '';
  if (!offHand) {
    const slot = boundary?.clientState?.selectedHotbarSlot;
    if (!isQuickBarSlot(slot)) return '';
    const hotbarStart = Number.isInteger(bot?.QUICK_BAR_START)
      ? bot.QUICK_BAR_START
      : Number(bot?.inventory?.hotbarStart);
    if (!Number.isInteger(hotbarStart)) return '';
    return normalizeBlockName(bot?.inventory?.slots?.[hotbarStart + slot]?.name);
  }
  let slot = 45;
  try {
    const resolved = bot?.getEquipmentDestSlot?.('off-hand');
    if (Number.isInteger(resolved)) slot = resolved;
  } catch {
    // The standard player-inventory off-hand slot remains the safe fallback.
  }
  return normalizeBlockName(bot?.inventory?.slots?.[slot]?.name);
}

function isQuickBarSlot(value) {
  return Number.isInteger(value) && value >= 0 && value < 9;
}

function initialAuthoritativeClientState(bot, opts = {}) {
  const selectedHotbarSlot = opts.failClosed === true
    ? null
    : (isQuickBarSlot(bot?.quickBarSlot) ? bot.quickBarSlot : null);
  const sneaking = opts.failClosed === true ? null : localSneakingState(bot);
  const position = bot?.entity?.position;
  const pose = opts.failClosed === true || !finitePosition(position)
    ? null
    : {
      x: Number(position.x),
      y: Number(position.y),
      z: Number(position.z),
      yaw: Number.isFinite(Number(bot.entity.yaw)) ? toNotchianYaw(Number(bot.entity.yaw)) : null,
      pitch: Number.isFinite(Number(bot.entity.pitch)) ? toNotchianPitch(Number(bot.entity.pitch)) : null,
      onGround: typeof bot.entity.onGround === 'boolean' ? bot.entity.onGround : null,
    };
  return { selectedHotbarSlot, sneaking, pose };
}

function samePrecisePosition(packet, position) {
  return ['x', 'y', 'z'].every((axis) => (
    Number.isFinite(Number(packet?.[axis]))
    && Math.abs(Number(packet[axis]) - Number(position[axis])) <= CLIENT_POSITION_EPSILON
  ));
}

function packetOnGroundMatches(packet, expected) {
  const supplied = typeof packet?.onGround === 'boolean'
    ? packet.onGround
    : packet?.flags?.onGround;
  return typeof supplied === 'boolean' && supplied === expected;
}

function rotationMovesTowardLocal(previousPose, entity, nextYaw, nextPitch) {
  const wantedYaw = toNotchianYaw(Number(entity?.yaw));
  const wantedPitch = toNotchianPitch(Number(entity?.pitch));
  if (!Number.isFinite(wantedYaw) || !Number.isFinite(wantedPitch)) return false;
  const previousYaw = Number(previousPose?.yaw);
  const previousPitch = Number(previousPose?.pitch);
  if (!Number.isFinite(previousYaw) || !Number.isFinite(previousPitch)) {
    // The first physical look becomes the server-pose shadow. Downstream
    // orientation-sensitive footprints (notably beds) use this shadow rather
    // than the potentially newer local target orientation.
    return true;
  }
  return angularDistanceDegrees(nextYaw, wantedYaw)
      <= angularDistanceDegrees(previousYaw, wantedYaw) + CLIENT_ROTATION_EPSILON
    && Math.abs(nextPitch - wantedPitch)
      <= Math.abs(previousPitch - wantedPitch) + CLIENT_ROTATION_EPSILON;
}

function angularDistanceDegrees(left, right) {
  const delta = ((Number(left) - Number(right) + 540) % 360) - 180;
  return Math.abs(delta);
}

function approximatelyEqualAngle(left, right) {
  return angularDistanceDegrees(left, right) <= CLIENT_ROTATION_EPSILON;
}

function toNotchianYaw(yaw) {
  return (Math.PI - yaw) * (180 / Math.PI);
}

function toNotchianPitch(pitch) {
  return -pitch * (180 / Math.PI);
}

function requirePacketAdjacentBucketPose(bot, boundary, packet, operation) {
  const pose = boundary?.clientState?.pose;
  const local = bot?.entity;
  if (!pose || !finitePosition(local?.position)
    || !samePrecisePosition(pose, local.position)) {
    throw worldActionDenied('server-correlated item-use position is unavailable', operation);
  }
  const rotation = packet?.rotation;
  const expectedYaw = toNotchianYaw(Number(local?.yaw));
  const expectedPitch = toNotchianPitch(Number(local?.pitch));
  if (!rotation || !Number.isFinite(Number(rotation.x)) || !Number.isFinite(Number(rotation.y))
    || !Number.isFinite(expectedYaw) || !Number.isFinite(expectedPitch)
    || !approximatelyEqualAngle(Number(rotation.x), expectedYaw)
    || Math.abs(Number(rotation.y) - expectedPitch) > CLIENT_ROTATION_EPSILON) {
    throw worldActionDenied('use-item rotation does not match the authorized live raycast', operation);
  }
}

function isWorldMutatingBucket(itemName) {
  return itemName === 'bucket'
    || (itemName.endsWith(WORLD_MUTATING_BUCKET_SUFFIX) && itemName !== 'milk_bucket');
}

function blockUseEffectClass(itemName, heldBlockName) {
  if (heldBlockName) return 'adjacent_placement';
  if (isWorldMutatingBucket(itemName)) return 'unsupported';
  if (!itemName || PASSIVE_RAW_USE_ITEMS.has(itemName)) return 'passive';
  if (REFERENCE_ONLY_BLOCK_USE_ITEMS.has(itemName)
    || itemName.endsWith('_axe')
    || itemName.endsWith('_hoe')
    || itemName.endsWith('_shovel')
    || itemName.endsWith('_pickaxe')
    || itemName.endsWith('_sword')) {
    return 'reference_only';
  }
  return 'unsupported';
}

function modeledReferenceOnlyBlockUse(itemName, blockName) {
  if (itemName.endsWith('_axe')) {
    return blockName.endsWith('_log')
      || blockName.endsWith('_wood')
      || blockName.endsWith('_stem')
      || blockName.endsWith('_hyphae');
  }
  if (itemName.endsWith('_hoe') || itemName.endsWith('_shovel')) {
    return new Set([
      'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
    ]).has(blockName);
  }
  return false;
}

function requireSafeWindowOpenUseCapability(bot, boundary, operation) {
  if (boundary?.itemStateCoherent !== true) {
    throw worldActionDenied('held-item state lacks authoritative readback', operation);
  }
  const localSneaking = localSneakingState(bot);
  if (localSneaking !== false || boundary?.clientState?.sneaking !== false) {
    throw worldActionDenied('window opening requires authoritative non-sneaking state', operation);
  }
  const itemName = authoritativeActivatedItemName(bot, boundary, false);
  const heldBlockName = heldPlaceableBlockName(bot, boundary);
  if (heldBlockName === undefined) {
    throw worldActionDenied('window-open held-item classification is unavailable', operation);
  }
  const effectClass = blockUseEffectClass(itemName, heldBlockName);
  if (effectClass !== 'passive') {
    throw worldActionDenied(
      'window opening requires an empty or explicitly passive held item',
      operation,
    );
  }
  return Object.freeze({ itemName, effectClass, nonSneaking: true });
}

function windowOpenUseCapabilityIsCurrent(bot, capability) {
  return capability?.nonSneaking === true
    && localSneakingState(bot) === false
    && authoritativeActivatedItemName(bot, bot?.[WORLD_ACTION_BOUNDARY], false) === capability.itemName
    && bot?.[WORLD_ACTION_BOUNDARY]?.clientState?.sneaking === false;
}

function localSneakingState(bot) {
  try {
    const value = bot?.getControlState?.('sneak');
    if (typeof value === 'boolean') return value;
  } catch {
    return null;
  }
  const value = bot?.controlState?.sneak;
  return typeof value === 'boolean' ? value : null;
}

function isSignBlock(itemName) {
  return itemName === 'sign'
    || itemName.endsWith('_sign')
    || itemName.endsWith('_hanging_sign');
}
