import http from 'node:http';
import path from 'node:path';
import { completeWithMetrics } from '../../src/advisor/deepseek.js';
import { createAdvisorCostGuard } from '../../src/advisor/cost_guard.js';
import config from '../../src/config.js';
import { createMissionBrainHandler } from './mission-brain.js';
import {
  createOpportunityShadowCoordinator,
  resolveFabricOpportunityConfig,
} from './opportunity-shadow-coordinator.js';

const DEFAULT_TTL_MS = 250;
const DEFAULT_MAX_TTL_MS = 500;
const DEFAULT_ARRIVE_EPSILON = 0.8;
const DEFAULT_TARGET_DISTANCE_BLOCKS = 4;
const DEFAULT_MAX_TARGET_DISTANCE_BLOCKS = 24;
const DEFAULT_EXHAUSTION_BACKOFF_MS = 5000;
const DEFAULT_TASK = 'navigate';
const SETUP_COMMAND_LIMIT = 64;

export function parseBrainRequest(body) {
  const text = String(body || '');
  const newline = text.indexOf('\n');
  if (newline < 0) throw new Error('missing first-line instance id');
  const firstLine = text.slice(0, newline).trim();
  const match = /^instanceId:(.+)$/.exec(firstLine);
  if (!match) throw new Error('first line must be instanceId:<id>');
  const jsonText = text.slice(newline + 1).trim() || '{}';
  return { instanceId: match[1], snapshot: JSON.parse(jsonText) };
}

export function readRequestBody(req, opts = {}) {
  const maxBytes = opts.maxBytes ?? 128 * 1024;
  return new Promise((resolve, reject) => {
    let body = '';
    let bodyBytes = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      bodyBytes += Buffer.byteLength(chunk, 'utf8');
      if (bodyBytes > maxBytes) {
        reject(new Error('request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function writeText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(text);
}

export function compactSnapshot(snapshot = {}) {
  const terrain = snapshot.terrainProbe || {};
  return {
    x: round(snapshot.x),
    y: round(snapshot.y),
    z: round(snapshot.z),
    yaw: round(snapshot.yaw),
    pitch: round(snapshot.pitch),
    onGround: Boolean(snapshot.onGround),
    touchingWater: Boolean(snapshot.touchingWater),
    health: round(snapshot.health),
    inventory: {
      logCount: finiteNumber(snapshot.inventoryLogCount, 0),
      logsByItem: compactCountMap(snapshot.inventoryLogsByItem),
      plankCount: finiteNumber(snapshot.inventoryPlankCount, 0),
      planksByItem: compactCountMap(snapshot.inventoryPlanksByItem),
      stickCount: finiteNumber(snapshot.inventoryStickCount, 0),
      sticksByItem: compactCountMap(snapshot.inventorySticksByItem),
      craftingTableCount: finiteNumber(snapshot.inventoryCraftingTableCount, 0),
      craftingTablesByItem: compactCountMap(snapshot.inventoryCraftingTablesByItem),
      woodenPickaxeCount: finiteNumber(snapshot.inventoryWoodenPickaxeCount, 0),
      woodenPickaxesByItem: compactCountMap(snapshot.inventoryWoodenPickaxesByItem),
      cobblestoneCount: finiteNumber(snapshot.inventoryCobblestoneCount, 0),
      cobblestoneByItem: compactCountMap(snapshot.inventoryCobblestoneByItem),
      stonePickaxeCount: finiteNumber(snapshot.inventoryStonePickaxeCount, 0),
      stonePickaxesByItem: compactCountMap(snapshot.inventoryStonePickaxesByItem),
      stoneAxeCount: finiteNumber(snapshot.inventoryStoneAxeCount, 0),
      stoneAxesByItem: compactCountMap(snapshot.inventoryStoneAxesByItem),
      stoneSwordCount: finiteNumber(snapshot.inventoryStoneSwordCount, 0),
      stoneSwordsByItem: compactCountMap(snapshot.inventoryStoneSwordsByItem),
      furnaceCount: finiteNumber(snapshot.inventoryFurnaceCount, 0),
      furnacesByItem: compactCountMap(snapshot.inventoryFurnacesByItem),
      charcoalCount: finiteNumber(snapshot.inventoryCharcoalCount, 0),
      charcoalByItem: compactCountMap(snapshot.inventoryCharcoalByItem),
      coalCount: finiteNumber(snapshot.inventoryCoalCount, 0),
      coalByItem: compactCountMap(snapshot.inventoryCoalByItem),
      rawIronCount: finiteNumber(snapshot.inventoryRawIronCount, 0),
      rawIronByItem: compactCountMap(snapshot.inventoryRawIronByItem),
      ironIngotCount: finiteNumber(snapshot.inventoryIronIngotCount, 0),
      ironIngotsByItem: compactCountMap(snapshot.inventoryIronIngotsByItem),
      ironPickaxeCount: finiteNumber(snapshot.inventoryIronPickaxeCount, 0),
      ironPickaxesByItem: compactCountMap(snapshot.inventoryIronPickaxesByItem),
    },
    nearbyLogs: compactNearbyLogs(snapshot.nearbyLogs),
    input: {
      forward: Boolean(snapshot.inputForward),
      back: Boolean(snapshot.inputBack),
      left: Boolean(snapshot.inputLeft),
      right: Boolean(snapshot.inputRight),
      jump: Boolean(snapshot.inputJump),
      sneak: Boolean(snapshot.inputSneak),
    },
    activeNavigationCommandId: nonEmptyString(snapshot.activeNavigationCommandId) || '',
    navigation: {
      routeComputed: Boolean(snapshot.navigationRouteComputed),
      routeLength: finiteNumber(snapshot.navigationRouteLength, 0),
      waypointIndex: finiteNumber(snapshot.navigationWaypointIndex, 0),
      waypointX: finiteNumberOrNull(snapshot.navigationWaypointX),
      waypointZ: finiteNumberOrNull(snapshot.navigationWaypointZ),
      waypointDistance: finiteNumberOrNull(snapshot.navigationWaypointDistance),
    },
    terrain: {
      currentCellX: finiteNumberOrNull(terrain.currentCellX),
      currentCellZ: finiteNumberOrNull(terrain.currentCellZ),
      currentSurfaceY: finiteNumberOrNull(terrain.currentSurfaceY),
      currentFeetSolid: Boolean(terrain.currentFeetSolid),
      currentHeadSolid: Boolean(terrain.currentHeadSolid),
      currentHazard: Boolean(terrain.currentHazard),
      aheadCellX: finiteNumberOrNull(terrain.aheadCellX),
      aheadCellZ: finiteNumberOrNull(terrain.aheadCellZ),
      aheadDirection: nonEmptyString(terrain.aheadDirection) || '',
      aheadSurfaceY: finiteNumberOrNull(terrain.aheadSurfaceY),
      aheadStepDelta: finiteNumberOrNull(terrain.aheadStepDelta),
      aheadWalkable: terrain.perceptionAheadWalkable === true,
      aheadIssue: nonEmptyString(terrain.perceptionAheadIssue) || '',
    },
  };
}

export function buildPromptMessages(snapshot, opts = {}) {
  const requestIndex = positiveInteger(opts.requestIndex) ?? 1;
  const task = normalizeTask(opts.task);
  const directionSequence = parseDirectionSequence(opts.directionSequence);
  const directionHint = directionForRequest(requestIndex, directionSequence);
  const maxTargetDistanceBlocks = positiveInteger(opts.maxTargetDistanceBlocks) ?? DEFAULT_MAX_TARGET_DISTANCE_BLOCKS;
  const targetDistanceBlocks = clamp(
    positiveInteger(opts.targetDistanceBlocks) ?? DEFAULT_TARGET_DISTANCE_BLOCKS,
    1,
    maxTargetDistanceBlocks,
  );
  const responseTtlMs = clamp(
    positiveInteger(opts.ttlMs) ?? DEFAULT_TTL_MS,
    1,
    positiveInteger(opts.maxTtlMs) ?? DEFAULT_MAX_TTL_MS,
  );
  const maxR2Depth = positiveInteger(opts.maxR2Depth) ?? 12;
  const r2Depth = clamp(positiveInteger(opts.r2Depth) ?? 6, 1, maxR2Depth);
  if (task === 'gather_log' || task === 'gather_tree') {
    const action = task === 'gather_tree' ? 'gather_tree' : 'gather_log';
    const taskLine = task === 'gather_tree'
      ? 'The Java loop owns selecting connected reachable logs from the seed, nav, face, break, collect, and verify. You only pick one seed log for a tree.'
      : 'The Java loop owns nav, face, break, collect, and verify. You only pick one log target.';
    const chooseLine = task === 'gather_tree'
      ? 'If snapshot.inventory.logCount is 0 and snapshot.nearbyLogs has entries, choose one listed low seed log likely to belong to a tree with several connected logs.'
      : 'If snapshot.inventory.logCount is 0 and snapshot.nearbyLogs has entries, choose one listed log.';
    return [
      {
        role: 'system',
        content: [
          'You emit one compact JSON object for a Minecraft Fabric bot integration test.',
          'No prose. No markdown. No code fence. No extra keys. No arrays.',
          taskLine,
          chooseLine,
          'Prefer the nearest low log. Copy targetX,targetY,targetZ exactly from nearbyLogs.',
          'Return exactly one of:',
          `{"action":"${action}","targetX":0,"targetY":64,"targetZ":0,"ttlMs":${responseTtlMs},"reason":"log"}`,
          `{"action":"stop","ttlMs":${responseTtlMs},"reason":"no_log"}`,
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          requestIndex,
          task,
          ttlMs: responseTtlMs,
          responseRules: {
            jsonObjectOnly: true,
            noProse: true,
            reasonMaxWords: 4,
          },
          snapshot: compactSnapshot(snapshot),
        }),
      },
    ];
  }
  if (isCraftTask(task) || task === 'craft_stone_tools') {
    const craft = craftTaskConfig(task);
    return [
      {
        role: 'system',
        content: [
          'You emit one compact JSON object for a Minecraft Fabric bot integration test.',
          'No prose. No markdown. No code fence. No extra keys. No arrays.',
          craft.executorLine,
          craft.decisionLine,
          'Return exactly one of:',
          `{"action":"${craft.action}","ttlMs":${responseTtlMs},"reason":"${craft.reason}"}`,
          `{"action":"stop","ttlMs":${responseTtlMs},"reason":"${craft.stopReason}"}`,
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          requestIndex,
          task,
          ttlMs: responseTtlMs,
          responseRules: {
            jsonObjectOnly: true,
            noProse: true,
            reasonMaxWords: 4,
          },
          snapshot: compactSnapshot(snapshot),
        }),
      },
    ];
  }
  if (task === 'place_table' || task === 'place_furnace') {
    const action = task === 'place_furnace' ? 'place_furnace' : 'place_table';
    const item = task === 'place_furnace' ? 'furnace' : 'crafting_table';
    const stopReason = task === 'place_furnace' ? 'no_furnace' : 'no_table';
    return [
      {
        role: 'system',
        content: [
          'You emit one compact JSON object for a Minecraft Fabric bot integration test.',
          'No prose. No markdown. No code fence. No extra keys. No arrays.',
          `The Java loop owns selecting the ${item}, looking at ground, raycast-gated interactBlock, sneak-if-adjacent handling, and world verification.`,
          `You only decide whether a ${item} item is present and request isolated placement.`,
          'Return exactly one of:',
          `{"action":"${action}","ttlMs":${responseTtlMs},"reason":"place"}`,
          `{"action":"stop","ttlMs":${responseTtlMs},"reason":"${stopReason}"}`,
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          requestIndex,
          task,
          ttlMs: responseTtlMs,
          responseRules: {
            jsonObjectOnly: true,
            noProse: true,
            reasonMaxWords: 4,
          },
          snapshot: compactSnapshot(snapshot),
        }),
      },
    ];
  }
  if (task === 'smelt_charcoal') {
    return [
      {
        role: 'system',
        content: [
          'You emit one compact JSON object for a Minecraft Fabric bot integration test.',
          'No prose. No markdown. No code fence. No extra keys. No arrays.',
          'The Java loop owns opening the furnace GUI, loading one log input, loading one plank/log fuel, waiting for the real smelt, taking output, and typed charcoal verification.',
          'You only decide whether log input and fuel are present and request charcoal smelting.',
          'Return exactly one of:',
          `{"action":"smelt_charcoal","ttlMs":${responseTtlMs},"reason":"charcoal"}`,
          `{"action":"stop","ttlMs":${responseTtlMs},"reason":"no_materials"}`,
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          requestIndex,
          task,
          ttlMs: responseTtlMs,
          responseRules: {
            jsonObjectOnly: true,
            noProse: true,
            reasonMaxWords: 4,
          },
          snapshot: compactSnapshot(snapshot),
        }),
      },
    ];
  }
  if (task === 'make_charcoal') {
    return [
      {
        role: 'system',
        content: [
          'Return one compact JSON object only.',
          'No prose. No markdown. No code fence. No extra keys. No arrays. Do not explain.',
          'The Java loop owns the full make-charcoal composite: open crafting table, craft furnace, place furnace, open furnace GUI, load input/fuel, wait for smelt, take output, and typed charcoal verification.',
          'The adapter already verified the required cobblestone, log input, and fuel before this model call.',
          'Request the composite now. Return exactly:',
          `{"action":"make_charcoal","ttlMs":${responseTtlMs},"reason":"make_charcoal"}`,
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          requestIndex,
          task,
          ttlMs: responseTtlMs,
          responseRules: {
            jsonObjectOnly: true,
            noProse: true,
            reasonMaxWords: 4,
          },
          preconditionsVerified: true,
          expectedAction: 'make_charcoal',
          snapshot: compactSnapshot(snapshot),
        }),
      },
    ];
  }
  if (task === 'r2_mine_stone_return') {
    return [
      {
        role: 'system',
        content: [
          'You emit one compact JSON object for a Minecraft Fabric bot integration test.',
          'No prose. No markdown. No code fence. No extra keys. No arrays.',
          'The Java fast loop owns safe staircase descent, raycast-gated stone mining, cobblestone pickup, and return to the starting surface.',
          'You only decide whether to start the composite cobblestone task and choose a cardinal descent direction.',
          'Do not request teleport, coordinate-addressed digging, combat, or direct movement.',
          'Return exactly one of:',
          `{"action":"r2_mine_stone_return","direction":"east|west|north|south","depth":${r2Depth},"ttlMs":${responseTtlMs},"reason":"cobble"}`,
          `{"action":"stop","ttlMs":${responseTtlMs},"reason":"unsafe"}`,
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          requestIndex,
          task,
          directionHint,
          r2Depth,
          maxR2Depth,
          ttlMs: responseTtlMs,
          responseRules: {
            jsonObjectOnly: true,
            noProse: true,
            reasonMaxWords: 4,
          },
          snapshot: compactSnapshot(snapshot),
        }),
      },
    ];
  }
  if (task === 'r5_iron_chain') {
    return [
      {
        role: 'system',
        content: [
          'Return one compact JSON object only.',
          'No prose. No markdown. No code fence. No extra keys. No arrays. Do not explain.',
          'The Java fast loop owns the full R5 iron-chain verifier: safe staircase descent, raycast-gated placed-ore mining, return to surface, real furnace smelting of raw iron, and real 3x3 iron_pickaxe craft.',
          'You only decide whether to start the composite and choose a cardinal descent direction. Do not request direct item grants, teleport, combat, or raw coordinate digging.',
          'The adapter already verified the starting kit and that raw iron, iron ingots, and iron pickaxes are absent.',
          'Return exactly one of:',
          `{"action":"r5_iron_chain","direction":"east|west|north|south","depth":${r2Depth},"ttlMs":${responseTtlMs},"reason":"iron_chain"}`,
          `{"action":"stop","ttlMs":${responseTtlMs},"reason":"unsafe"}`,
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          requestIndex,
          task,
          directionHint,
          r2Depth,
          maxR2Depth,
          ttlMs: responseTtlMs,
          responseRules: {
            jsonObjectOnly: true,
            noProse: true,
            reasonMaxWords: 4,
          },
          preconditionsVerified: true,
          expectedAction: 'r5_iron_chain',
          snapshot: compactSnapshot(snapshot),
        }),
      },
    ];
  }
  return [
    {
      role: 'system',
      content: [
        'You emit one compact JSON object for a Minecraft Fabric bot integration test.',
        'No prose. No markdown. No code fence. No extra keys. No arrays.',
        'Keep the full response under 180 characters.',
        'Pick one nearby cardinal target. This is not a reasoning test.',
        'Prefer the directionHint unless the compact snapshot shows an obvious hazard or the active route length is 0.',
        'Return exactly one of these shapes:',
        `{"direction":"east|west|north|south","blocks":1-${maxTargetDistanceBlocks},"ttlMs":${responseTtlMs},"reason":"short"}`,
        `{"action":"navigate_to_point","targetX":0,"targetZ":0,"ttlMs":${responseTtlMs},"reason":"short"}`,
        `{"action":"stop","ttlMs":${responseTtlMs},"reason":"unsafe"}`,
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        requestIndex,
        task,
        directionHint,
        ttlMs: responseTtlMs,
        targetDistanceBlocks,
        maxTargetDistanceBlocks,
        responseRules: {
          jsonObjectOnly: true,
          noProse: true,
          maxChars: 180,
          reasonMaxWords: 4,
        },
        snapshot: compactSnapshot(snapshot),
      }),
    },
  ];
}

export function parseDeepseekIntentReply(content, snapshot = {}, opts = {}) {
  const parsed = parseJsonObjectWithRepair(content);
  emitParseEvent(opts, parsed.ok
    ? { stage: parsed.repairMethod ? 'repair' : 'strict', repairMethod: parsed.repairMethod || null }
    : { stage: 'fail', reason: parsed.reason });
  if (!parsed.ok) {
    return stopIntent('adapter_parse_error', opts);
  }
  const root = parsed.value;

  const candidate = isObject(root.intent) ? root.intent : root;
  const maxTtlMs = positiveInteger(opts.maxTtlMs) ?? DEFAULT_MAX_TTL_MS;
  const ttlMs = clamp(
    positiveInteger(candidate.ttlMs) ?? positiveInteger(opts.ttlMs) ?? DEFAULT_TTL_MS,
    1,
    maxTtlMs,
  );
  const reason = nonEmptyString(candidate.reason) || 'deepseek_nav_target';
  const action = nonEmptyString(candidate.action) || 'navigate_to_point';
  const commandPrefix = action === 'gather_log'
      ? (opts.gatherCommandPrefix || 'deepseek-gather')
      : action === 'gather_tree'
        ? (opts.gatherTreeCommandPrefix || 'deepseek-tree')
      : isCraftAction(action)
        ? (opts.craftCommandPrefix || 'deepseek-craft')
        : action === 'place_table' || action === 'place_furnace'
          ? (opts.placeCommandPrefix || 'deepseek-place')
        : action === 'smelt_charcoal'
          ? (opts.smeltCommandPrefix || 'deepseek-smelt')
        : action === 'make_charcoal'
          ? (opts.makeCommandPrefix || 'deepseek-make')
        : action === 'r2_mine_stone_return'
          ? (opts.r2CommandPrefix || 'deepseek-r2')
        : action === 'r5_iron_chain'
          ? (opts.r5CommandPrefix || 'deepseek-r5-chain')
        : (opts.commandPrefix || 'deepseek-nav');
  const commandId = nonEmptyString(candidate.commandId)
    || `${commandPrefix}-${positiveInteger(opts.requestIndex) ?? Date.now()}`;

  if (action === 'stop') {
    return stopIntent(reason, { ...opts, ttlMs, commandId });
  }

  if (action === 'gather_log' || action === 'gather_tree') {
    const gatherTarget = parseGatherTarget(candidate, snapshot);
    if (!gatherTarget.ok) {
      emitParseEvent(opts, { stage: 'target_rejected', reason: gatherTarget.reason });
      return stopIntent(gatherTarget.reason, { ...opts, ttlMs, commandId });
    }
    return {
      action,
      targetX: gatherTarget.target.x,
      targetY: gatherTarget.target.y,
      targetZ: gatherTarget.target.z,
      ttlMs,
      reason,
      commandId,
    };
  }

  if (isCraftAction(action)) {
    const validation = validateCraftInventory(action, snapshot);
    if (!validation.ok) {
      emitParseEvent(opts, { stage: 'target_rejected', reason: validation.reason });
      return stopIntent(validation.reason, { ...opts, ttlMs, commandId });
    }
    return {
      action,
      ttlMs,
      reason,
      commandId,
    };
  }

  if (action === 'place_table') {
    if (compactSnapshot(snapshot).inventory.craftingTableCount < 1) {
      emitParseEvent(opts, { stage: 'target_rejected', reason: 'place_table_no_table' });
      return stopIntent('place_table_no_table', { ...opts, ttlMs, commandId });
    }
    return {
      action: 'place_table',
      ttlMs,
      reason,
      commandId,
    };
  }

  if (action === 'place_furnace') {
    if (compactSnapshot(snapshot).inventory.furnaceCount < 1) {
      emitParseEvent(opts, { stage: 'target_rejected', reason: 'place_furnace_no_furnace' });
      return stopIntent('place_furnace_no_furnace', { ...opts, ttlMs, commandId });
    }
    return {
      action: 'place_furnace',
      ttlMs,
      reason,
      commandId,
    };
  }

  if (action === 'smelt_charcoal') {
    const validation = validateSmeltCharcoalInventory(snapshot);
    if (!validation.ok) {
      emitParseEvent(opts, { stage: 'target_rejected', reason: validation.reason });
      return stopIntent(validation.reason, { ...opts, ttlMs, commandId });
    }
    return {
      action: 'smelt_charcoal',
      ttlMs,
      reason,
      commandId,
    };
  }

  if (action === 'make_charcoal') {
    const validation = validateMakeCharcoalInventory(snapshot);
    if (!validation.ok) {
      emitParseEvent(opts, { stage: 'target_rejected', reason: validation.reason });
      return stopIntent(validation.reason, { ...opts, ttlMs, commandId });
    }
    return {
      action: 'make_charcoal',
      ttlMs,
      reason,
      commandId,
    };
  }

  if (action === 'r2_mine_stone_return') {
    const startX = Math.floor(finiteNumber(snapshot.x, 0));
    const startY = Math.floor(finiteNumber(snapshot.y, 64));
    const startZ = Math.floor(finiteNumber(snapshot.z, 0));
    const maxDepth = positiveInteger(opts.maxR2Depth) ?? 12;
    const depth = clamp(positiveInteger(opts.r2Depth) ?? positiveInteger(candidate.depth) ?? 6, 1, maxDepth);
    const explicitX = finiteNumberOrNull(candidate.targetX);
    const explicitY = finiteNumberOrNull(candidate.targetY);
    const explicitZ = finiteNumberOrNull(candidate.targetZ);
    let target = null;
    if (explicitX !== null && explicitY !== null && explicitZ !== null) {
      target = { x: Math.floor(explicitX), y: Math.floor(explicitY), z: Math.floor(explicitZ) };
    } else {
      const directionTarget = targetFromDirection({ ...candidate, blocks: depth }, snapshot, {
        targetDistanceBlocks: depth,
        maxTargetDistanceBlocks: maxDepth,
      });
      if (directionTarget) {
        target = {
          x: Math.floor(directionTarget.x),
          y: startY - depth,
          z: Math.floor(directionTarget.z),
        };
      }
    }
    if (!target) {
      emitParseEvent(opts, { stage: 'target_rejected', reason: 'adapter_no_valid_r2_target' });
      return stopIntent('adapter_no_valid_r2_target', { ...opts, ttlMs, commandId });
    }
    if (target.y >= startY) {
      emitParseEvent(opts, { stage: 'target_rejected', reason: 'adapter_r2_target_not_below_start' });
      return stopIntent('adapter_r2_target_not_below_start', { ...opts, ttlMs, commandId });
    }
    return {
      action: 'r2_mine_stone_return',
      targetX: target.x,
      targetY: target.y,
      targetZ: target.z,
      ttlMs,
      reason,
      commandId,
    };
  }

  if (action === 'r5_iron_chain') {
    const validation = validateR5IronChainInventory(snapshot);
    if (!validation.ok) {
      emitParseEvent(opts, { stage: 'target_rejected', reason: validation.reason });
      return stopIntent(validation.reason, { ...opts, ttlMs, commandId });
    }
    const startX = Math.floor(finiteNumber(snapshot.x, 0));
    const startY = Math.floor(finiteNumber(snapshot.y, 64));
    const startZ = Math.floor(finiteNumber(snapshot.z, 0));
    const maxDepth = positiveInteger(opts.maxR2Depth) ?? 96;
    const depth = clamp(positiveInteger(opts.r2Depth) ?? positiveInteger(candidate.depth) ?? 64, 1, maxDepth);
    const explicitX = finiteNumberOrNull(candidate.targetX);
    const explicitY = finiteNumberOrNull(candidate.targetY);
    const explicitZ = finiteNumberOrNull(candidate.targetZ);
    let target = null;
    if (explicitX !== null && explicitY !== null && explicitZ !== null) {
      target = { x: Math.floor(explicitX), y: Math.floor(explicitY), z: Math.floor(explicitZ) };
    } else {
      const forcedDirection = normalizeCardinalDirection(opts.r5Direction);
      const directionTarget = targetFromDirection({ ...candidate, direction: forcedDirection || candidate.direction, blocks: depth }, snapshot, {
        targetDistanceBlocks: depth,
        maxTargetDistanceBlocks: maxDepth,
      });
      if (directionTarget) {
        target = {
          x: Math.floor(directionTarget.x),
          y: startY - depth,
          z: Math.floor(directionTarget.z),
        };
      }
    }
    if (!target) {
      emitParseEvent(opts, { stage: 'target_rejected', reason: 'adapter_no_valid_r5_target' });
      return stopIntent('adapter_no_valid_r5_target', { ...opts, ttlMs, commandId });
    }
    if (target.y >= startY) {
      emitParseEvent(opts, { stage: 'target_rejected', reason: 'adapter_r5_target_not_below_start' });
      return stopIntent('adapter_r5_target_not_below_start', { ...opts, ttlMs, commandId });
    }
    return {
      action: 'r5_iron_chain',
      targetX: target.x,
      targetY: target.y,
      targetZ: target.z,
      ttlMs,
      reason,
      commandId,
    };
  }

  const explicitTarget = parseExplicitTarget(candidate);
  const target = explicitTarget || targetFromDirection(candidate, snapshot, opts);
  if (!target) {
    emitParseEvent(opts, { stage: 'target_rejected', reason: 'adapter_no_valid_target' });
    return stopIntent('adapter_no_valid_target', { ...opts, ttlMs, commandId });
  }

  return {
    action: 'navigate_to_point',
    targetX: target.x,
    targetZ: target.z,
    arriveEpsilon: clampNumber(candidate.arriveEpsilon, 0.2, 2.0, DEFAULT_ARRIVE_EPSILON),
    ttlMs,
    reason,
    commandId,
  };
}

export function stopIntent(reason = 'stop', opts = {}) {
  return {
    action: 'stop',
    forward: false,
    ttlMs: clamp(positiveInteger(opts.ttlMs) ?? DEFAULT_TTL_MS, 1, positiveInteger(opts.maxTtlMs) ?? DEFAULT_MAX_TTL_MS),
    reason,
    commandId: nonEmptyString(opts.commandId) || '',
  };
}

export function withAdapterExpiry(intent, nowMs) {
  const ttlMs = positiveInteger(intent?.ttlMs) ?? 0;
  return { ...intent, expiresAtMs: nowMs + ttlMs };
}

export function stalenessDecision(intent, nowMs) {
  if (!intent || intent.action === 'stop') {
    return { state: 'safe_stop', intent: stopIntent(intent?.reason || 'stop') };
  }
  const expiresAtMs = finiteNumberOrNull(intent.expiresAtMs);
  if (expiresAtMs !== null && expiresAtMs <= nowMs) {
    return {
      state: 'safe_stop',
      intent: stopIntent('intent_expired', { commandId: intent.commandId, ttlMs: 1 }),
    };
  }
  return { state: 'apply', intent };
}

export function createMetrics() {
  return {
    startedAt: new Date().toISOString(),
    requestCount: 0,
    providerAttemptCount: 0,
    providerUnknownCostBlocked: false,
    providerUnknownCostReason: null,
    providerUnknownCostPermanent: false,
    providerAccountingPendingCount: 0,
    providerAbortOrTimeoutCount: 0,
    providerAccountingSettlementCount: 0,
    gracefulShutdownRequestedCount: 0,
    gracefulShutdownCompletedCount: 0,
    gracefulShutdownFailedCount: 0,
    missionProviderAuthorityViolationCount: 0,
    deepseekCallCount: 0,
    refusedCount: 0,
    parseErrorCount: 0,
    lastRoundTripMs: null,
    roundTripMs: [],
    responses: [],
    cost: null,
    lastError: null,
    parse: {
      firstTry: 0,
      repaired: 0,
      failed: 0,
      targetRejected: 0,
      repairMethods: {},
    },
    exhaustion: {
      backoffMs: 0,
      quietResponses: 0,
      delayedResponses: 0,
      totalDelayMs: 0,
    },
    gather: {
      contextWaits: 0,
      startRejected: 0,
    },
  };
}

function initializeProviderAccountingMetrics(metrics) {
  if (!Number.isInteger(metrics.providerAttemptCount) || metrics.providerAttemptCount < 0) {
    metrics.providerAttemptCount = 0;
  }
  if (metrics.providerUnknownCostBlocked !== true) metrics.providerUnknownCostBlocked = false;
  if (typeof metrics.providerUnknownCostReason !== 'string') metrics.providerUnknownCostReason = null;
  if (metrics.providerUnknownCostPermanent !== true) metrics.providerUnknownCostPermanent = false;
  if (!Number.isInteger(metrics.providerAccountingPendingCount)
      || metrics.providerAccountingPendingCount < 0) {
    metrics.providerAccountingPendingCount = 0;
  }
  if (!Number.isInteger(metrics.providerAbortOrTimeoutCount)
      || metrics.providerAbortOrTimeoutCount < 0) {
    metrics.providerAbortOrTimeoutCount = 0;
  }
  if (!Number.isInteger(metrics.providerAccountingSettlementCount)
      || metrics.providerAccountingSettlementCount < 0) {
    metrics.providerAccountingSettlementCount = 0;
  }
  syncProviderAccountingConfig(metrics);
}

function recordProviderAttempt(metrics) {
  initializeProviderAccountingMetrics(metrics);
  metrics.providerAttemptCount += 1;
  syncProviderAccountingConfig(metrics);
}

function blockProviderForUnknownCost(metrics, reason, { permanent = true } = {}) {
  initializeProviderAccountingMetrics(metrics);
  metrics.providerUnknownCostBlocked = true;
  if (!metrics.providerUnknownCostPermanent || permanent) {
    metrics.providerUnknownCostReason = reason;
  }
  if (permanent) metrics.providerUnknownCostPermanent = true;
  syncProviderAccountingConfig(metrics);
}

function beginProviderAccountingQuarantine(metrics, reason) {
  initializeProviderAccountingMetrics(metrics);
  metrics.providerAccountingPendingCount += 1;
  metrics.providerAbortOrTimeoutCount += 1;
  blockProviderForUnknownCost(metrics, reason, { permanent: false });
}

function settleProviderAccountingQuarantine(metrics, accounted) {
  initializeProviderAccountingMetrics(metrics);
  if (metrics.providerAccountingPendingCount > 0) {
    metrics.providerAccountingPendingCount -= 1;
  }
  metrics.providerAccountingSettlementCount += 1;
  if (accounted
      && metrics.providerAccountingPendingCount === 0
      && !metrics.providerUnknownCostPermanent) {
    metrics.providerUnknownCostBlocked = false;
    metrics.providerUnknownCostReason = null;
  }
  syncProviderAccountingConfig(metrics);
}

function syncProviderAccountingConfig(metrics) {
  if (!metrics.config || typeof metrics.config !== 'object') return;
  metrics.config.providerAttemptCount = metrics.providerAttemptCount;
  metrics.config.providerUnknownCostBlocked = metrics.providerUnknownCostBlocked;
  metrics.config.providerUnknownCostReason = metrics.providerUnknownCostReason;
  metrics.config.providerAccountingPendingCount = metrics.providerAccountingPendingCount;
  metrics.config.providerAbortOrTimeoutCount = metrics.providerAbortOrTimeoutCount;
  metrics.config.providerAccountingSettlementCount = metrics.providerAccountingSettlementCount;
}

function hasUsableProviderAccounting(responseMetrics = {}) {
  if (Number.isFinite(responseMetrics.totalTokens) && responseMetrics.totalTokens > 0) return true;
  const completeSplit = Number.isFinite(responseMetrics.promptTokens)
    && responseMetrics.promptTokens >= 0
    && Number.isFinite(responseMetrics.completionTokens)
    && responseMetrics.completionTokens >= 0;
  return completeSplit && responseMetrics.promptTokens + responseMetrics.completionTokens > 0;
}

function isLoopbackHost(value) {
  let host = String(value || '').trim().toLowerCase();
  if (!host) return false;
  try {
    if (host.includes('://')) host = new URL(host).hostname.toLowerCase();
    else if (host.startsWith('[') && host.includes(']:')) {
      host = new URL(`http://${host}`).hostname.toLowerCase();
    } else if (host.includes(':') && !host.startsWith('[') && host.split(':').length === 2) {
      host = new URL(`http://${host}`).hostname.toLowerCase();
    }
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length);
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return Boolean(ipv4
    && Number(ipv4[1]) === 127
    && ipv4.slice(2).every((part) => Number(part) >= 0 && Number(part) <= 255));
}

export function createTrackedCompletionGateway(opts = {}) {
  const metrics = opts.metrics || createMetrics();
  const costGuard = opts.costGuard || createAdvisorCostGuard(config.advisor || {});
  const complete = opts.complete || completeWithMetrics;
  const maxCalls = positiveInteger(opts.maxCalls) ?? 8;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  let requestSequence = 0;
  initializeProviderAccountingMetrics(metrics);

  return async function trackedCompletion(messages, callOpts = {}) {
    const context = callOpts.trackedContext || {};
    if (metrics.providerUnknownCostBlocked) {
      metrics.refusedCount += 1;
      const error = new Error('deepseek provider cost is unknown; refusing later calls');
      error.code = 'DEEPSEEK_COST_UNKNOWN';
      throw error;
    }
    if (metrics.providerAttemptCount >= maxCalls) {
      metrics.refusedCount += 1;
      const error = new Error('deepseek max calls reached');
      error.code = 'DEEPSEEK_MAX_CALLS';
      throw error;
    }
    const beforeCost = costGuard.beforeCall();
    if (!beforeCost.ok) {
      metrics.refusedCount += 1;
      metrics.cost = costGuard.snapshot();
      const error = new Error(beforeCost.reason || 'deepseek cost refused');
      error.code = 'DEEPSEEK_COST_REFUSED';
      throw error;
    }

    requestSequence += 1;
    const requestId = `fabric-ds-${now()}-${requestSequence}`;
    const startedAtMs = now();
    const signal = callOpts.signal;
    const timeoutMs = positiveInteger(callOpts.timeoutMs);
    let accountingQuarantined = false;
    let abortListener = null;
    let timeoutHandle = null;
    const quarantineAccounting = (reason) => {
      if (accountingQuarantined) return;
      accountingQuarantined = true;
      beginProviderAccountingQuarantine(metrics, reason);
    };
    const clearAccountingWatch = () => {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      if (abortListener && signal?.removeEventListener) {
        signal.removeEventListener('abort', abortListener);
      }
    };
    try {
      const { trackedContext: _trackedContext, ...providerOpts } = callOpts;
      recordProviderAttempt(metrics);
      abortListener = () => quarantineAccounting('provider_abort_accounting_pending');
      if (signal?.aborted) abortListener();
      else if (signal?.addEventListener) signal.addEventListener('abort', abortListener, { once: true });
      if (timeoutMs !== null) {
        timeoutHandle = setTimeout(
          () => quarantineAccounting('provider_timeout_accounting_pending'),
          timeoutMs,
        );
        timeoutHandle.unref?.();
      }
      const rawResult = await complete(messages, { ...providerOpts, costGuard });
      clearAccountingWatch();
      const result = typeof rawResult === 'string'
        ? { content: rawResult, responseMetrics: {} }
        : { content: String(rawResult?.content || ''), responseMetrics: rawResult?.responseMetrics || {} };
      const hasUsableAccounting = hasUsableProviderAccounting(result.responseMetrics);
      let cost = costGuard.snapshot();
      if (cost.callCount === beforeCost.callCount) cost = costGuard.recordCall(result.responseMetrics);
      result.responseMetrics = {
        ...result.responseMetrics,
        callCostUsd: result.responseMetrics.callCostUsd ?? cost.callCostUsd ?? 0,
        sessionCostUsd: result.responseMetrics.sessionCostUsd ?? cost.sessionCostUsd,
        costCeilingUsd: result.responseMetrics.costCeilingUsd ?? cost.maxUsd,
        costCeilingStatus: result.responseMetrics.costCeilingStatus ?? cost.status,
      };
      metrics.deepseekCallCount += 1;
      if (accountingQuarantined) {
        settleProviderAccountingQuarantine(metrics, hasUsableAccounting);
      }
      if (!hasUsableAccounting) {
        blockProviderForUnknownCost(metrics, 'successful_response_missing_cost_or_token_metrics');
      }
      metrics.cost = costGuard.snapshot();
      const roundTripMs = Math.max(0, now() - startedAtMs);
      metrics.lastRoundTripMs = roundTripMs;
      metrics.roundTripMs.push(roundTripMs);
      if (metrics.roundTripMs.length > 50) metrics.roundTripMs.shift();
      metrics.responses.push({
        requestId,
        instanceId: context.instanceId || null,
        purpose: context.purpose || 'mission',
        junctionKey: context.junctionKey || null,
        roundTripMs,
        responseMetrics: publicResponseMetrics(result.responseMetrics),
        at: new Date(now()).toISOString(),
      });
      if (metrics.responses.length > 50) metrics.responses.shift();
      return result;
    } catch (error) {
      clearAccountingWatch();
      if (accountingQuarantined) settleProviderAccountingQuarantine(metrics, false);
      blockProviderForUnknownCost(metrics, 'provider_failure_or_timeout');
      metrics.cost = costGuard.snapshot();
      metrics.lastError = sanitizeError(error);
      throw error;
    }
  };
}

export function createDeepseekBrainHandler(opts = {}) {
  const env = opts.env || process.env;
  const metrics = opts.metrics || createMetrics();
  const costCeilingUsd = positiveNumber(env.MCBOT_FABRIC_DEEPSEEK_COST_USD_MAX)
    ?? positiveNumber(env.MCBOT_ADVISOR_COST_USD_MAX)
    ?? 1;
  const costCeilingSource = positiveNumber(env.MCBOT_FABRIC_DEEPSEEK_COST_USD_MAX) !== null
    ? 'MCBOT_FABRIC_DEEPSEEK_COST_USD_MAX'
    : positiveNumber(env.MCBOT_ADVISOR_COST_USD_MAX) !== null
      ? 'MCBOT_ADVISOR_COST_USD_MAX'
      : 'default';
  const costGuard = opts.costGuard || createAdvisorCostGuard({
    ...(config.advisor || {}),
    costUsdMax: costCeilingUsd,
  });
  const model = env.MCBOT_FABRIC_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL || config.deepseek.model;
  const modelSource = env.MCBOT_FABRIC_DEEPSEEK_MODEL
    ? 'MCBOT_FABRIC_DEEPSEEK_MODEL'
    : env.DEEPSEEK_MODEL
      ? 'DEEPSEEK_MODEL'
      : 'config.deepseek.model';
  const maxTokens = positiveInteger(env.MCBOT_FABRIC_DEEPSEEK_MAX_TOKENS) ?? 4096;
  const temperature = finiteNumber(env.MCBOT_FABRIC_DEEPSEEK_TEMPERATURE, 0);
  const maxCalls = positiveInteger(env.MCBOT_FABRIC_DEEPSEEK_MAX_CALLS) ?? 8;
  const exhaustionBackoffMs = positiveInteger(env.MCBOT_FABRIC_DEEPSEEK_EXHAUSTION_BACKOFF_MS)
    ?? DEFAULT_EXHAUSTION_BACKOFF_MS;
  const injectDelayMs = positiveInteger(env.MCBOT_FABRIC_DEEPSEEK_INJECT_DELAY_MS) ?? 0;
  const ttlMs = positiveInteger(env.MCBOT_FABRIC_DEEPSEEK_TTL_MS) ?? DEFAULT_TTL_MS;
  const maxTtlMs = positiveInteger(env.MCBOT_FABRIC_DEEPSEEK_MAX_TTL_MS) ?? DEFAULT_MAX_TTL_MS;
  const maxTargetDistanceBlocks = positiveInteger(env.MCBOT_FABRIC_DEEPSEEK_MAX_TARGET_DISTANCE_BLOCKS)
    ?? DEFAULT_MAX_TARGET_DISTANCE_BLOCKS;
  const targetDistanceBlocks = clamp(
    positiveInteger(env.MCBOT_FABRIC_DEEPSEEK_TARGET_DISTANCE_BLOCKS) ?? DEFAULT_TARGET_DISTANCE_BLOCKS,
    1,
    maxTargetDistanceBlocks,
  );
  const maxR2Depth = positiveInteger(env.MCBOT_FABRIC_R2_MAX_DEPTH) ?? 20;
  const r2Depth = clamp(positiveInteger(env.MCBOT_FABRIC_R2_DEPTH) ?? 6, 1, maxR2Depth);
  const directionSequence = parseDirectionSequence(env.MCBOT_FABRIC_DEEPSEEK_DIRECTION_SEQUENCE);
  const task = normalizeTask(env.MCBOT_FABRIC_DEEPSEEK_TASK);
  const complete = opts.complete || completeWithMetrics;
  const exhaustionState = opts.exhaustionState || {};
  const setupCommands = parseSetupCommands(env.MCBOT_FABRIC_DEEPSEEK_SETUP_COMMANDS_JSON || env.MCBOT_FABRIC_DEEPSEEK_SETUP_COMMANDS);
  const setupKind = nonEmptyString(env.MCBOT_FABRIC_DEEPSEEK_SETUP_KIND)?.toLowerCase() || '';
  const r5Direction = normalizeCardinalDirection(env.MCBOT_FABRIC_R5_DIRECTION) || 'west';
  const setupSettleMs = clamp(Math.floor(finiteNumber(env.MCBOT_FABRIC_DEEPSEEK_SETUP_SETTLE_MS, 750)), 0, 60000);
  const setupState = { sent: false, settleUntilMs: 0 };

  initializeProviderAccountingMetrics(metrics);
  metrics.cost = costGuard.snapshot();
  metrics.config = {
    model,
    maxTokens,
    temperature,
    maxCalls,
    exhaustionBackoffMs,
    injectDelayMs,
    ttlMs,
    maxTtlMs,
    targetDistanceBlocks,
    maxTargetDistanceBlocks,
    r2Depth,
    maxR2Depth,
    directionSequence,
    task,
    costCeilingUsd,
    costCeilingSource,
    modelSource,
    providerAttemptCount: metrics.providerAttemptCount,
    providerUnknownCostBlocked: metrics.providerUnknownCostBlocked,
    providerUnknownCostReason: metrics.providerUnknownCostReason,
    setupCommandCount: setupCommands.length,
    setupKind,
    r5Direction,
    setupSettleMs,
  };

  return async function handleDeepseekIntent(instanceId, snapshot) {
    metrics.requestCount += 1;
    const requestIndex = metrics.requestCount;
    const requestId = `fabric-ds-${Date.now()}-${requestIndex}`;
    const startedAtMs = Date.now();

    if ((setupCommands.length || setupKind === 'r5_iron_chain') && !setupState.sent) {
      setupState.sent = true;
      const dynamicSetupCommands = setupCommands.length
        ? setupCommands
        : buildR5IronChainSetupCommands(snapshot, { depth: r2Depth, direction: r5Direction });
      metrics.config.setupCommandCount = dynamicSetupCommands.length;
      setupState.settleUntilMs = Date.now() + setupSettleMs;
      return markQuiet({
        action: 'setup_commands',
        serverCommands: dynamicSetupCommands,
        ttlMs,
        reason: 'setup_commands',
        commandId: `${requestId}-setup`,
      });
    }
    if (setupState.settleUntilMs > Date.now()) {
      return markQuiet(stopIntent('setup_settle', { ttlMs, maxTtlMs, commandId: `${requestId}-settle` }));
    }

    if (task === 'gather_log' || task === 'gather_tree') {
      const compact = compactSnapshot(snapshot);
      if (compact.inventory.logCount > 0) {
        metrics.gather.startRejected += 1;
        const reason = task === 'gather_log' ? 'gather_start_logs_not_zero' : 'gather_tree_start_logs_not_zero';
        return markQuiet(stopIntent(reason, { ttlMs, maxTtlMs, commandId: requestId }));
      }
      if (compact.nearbyLogs.length === 0) {
        metrics.gather.contextWaits += 1;
        return markQuiet(stopIntent('waiting_for_nearby_logs', { ttlMs, maxTtlMs, commandId: requestId }));
      }
    }
    if (isCraftTask(task) || task === 'craft_stone_tools') {
      const validation = validateCraftInventory(craftTaskConfig(task).action, snapshot);
      if (!validation.ok) {
        const waitReason = validation.reason.replace('_no_', '_waiting_for_');
        return markQuiet(stopIntent(waitReason, { ttlMs, maxTtlMs, commandId: requestId }));
      }
    }
    if (task === 'place_table' || task === 'place_furnace') {
      const compact = compactSnapshot(snapshot);
      if (task === 'place_table' && compact.inventory.craftingTableCount < 1) {
        return markQuiet(stopIntent('place_table_waiting_for_table', { ttlMs, maxTtlMs, commandId: requestId }));
      }
      if (task === 'place_furnace' && compact.inventory.furnaceCount < 1) {
        return markQuiet(stopIntent('place_furnace_waiting_for_furnace', { ttlMs, maxTtlMs, commandId: requestId }));
      }
    }
    if (task === 'smelt_charcoal') {
      const validation = validateSmeltCharcoalInventory(snapshot);
      if (!validation.ok) {
        const waitReason = validation.reason.replace('_no_', '_waiting_for_');
        return markQuiet(stopIntent(waitReason, { ttlMs, maxTtlMs, commandId: requestId }));
      }
    }
    if (task === 'make_charcoal') {
      const validation = validateMakeCharcoalInventory(snapshot);
      if (!validation.ok) {
        const waitReason = validation.reason.replace('_no_', '_waiting_for_');
        return markQuiet(stopIntent(waitReason, { ttlMs, maxTtlMs, commandId: requestId }));
      }
    }
    if (task === 'r5_iron_chain') {
      const validation = validateR5IronChainInventory(snapshot);
      if (!validation.ok) {
        const waitReason = validation.reason.replace('_no_', '_waiting_for_');
        return markQuiet(stopIntent(waitReason, { ttlMs, maxTtlMs, commandId: requestId }));
      }
    }

    if (metrics.providerUnknownCostBlocked) {
      metrics.refusedCount += 1;
      return stopIntent('deepseek_cost_unknown', { ttlMs, maxTtlMs, commandId: requestId });
    }

    if (metrics.providerAttemptCount >= maxCalls) {
      metrics.refusedCount += 1;
      const decision = exhaustionBackoffDecision(exhaustionState, Date.now(), { backoffMs: exhaustionBackoffMs });
      metrics.exhaustion.backoffMs = exhaustionBackoffMs;
      if (decision.delayMs > 0) {
        metrics.exhaustion.delayedResponses += 1;
        metrics.exhaustion.totalDelayMs += decision.delayMs;
        await sleep(decision.delayMs);
      }
      const intent = stopIntent('deepseek_max_calls_reached', { ttlMs, maxTtlMs, commandId: requestId });
      if (decision.quiet) {
        metrics.exhaustion.quietResponses += 1;
        markQuiet(intent);
      }
      return intent;
    }

    const beforeCost = costGuard.beforeCall();
    if (!beforeCost.ok) {
      metrics.refusedCount += 1;
      metrics.cost = costGuard.snapshot();
      return stopIntent('deepseek_cost_refused', { ttlMs, maxTtlMs, commandId: requestId });
    }

    // Reserve the paid attempt before the first await. Concurrent HTTP
    // requests must not both pass maxCalls while one is sitting in the
    // deterministic injection delay.
    recordProviderAttempt(metrics);

    if (injectDelayMs > 0) {
      await sleep(injectDelayMs);
    }

    const messages = buildPromptMessages(snapshot, {
      requestIndex,
      ttlMs,
      maxTtlMs,
      targetDistanceBlocks,
      maxTargetDistanceBlocks,
      r2Depth,
      maxR2Depth,
      directionSequence,
      task,
    });
    let result;
    try {
      result = await complete(messages, {
        costGuard,
        model,
        temperature,
        maxTokens,
        responseFormatJson: true,
        metricsSource: 'fabric_deepseek_brain',
      });
    } catch (error) {
      blockProviderForUnknownCost(metrics, 'provider_failure_or_timeout');
      metrics.cost = costGuard.snapshot();
      metrics.lastError = sanitizeError(error);
      throw error;
    }
    metrics.deepseekCallCount += 1;
    if (!hasUsableProviderAccounting(result?.responseMetrics)) {
      blockProviderForUnknownCost(metrics, 'successful_response_missing_cost_or_token_metrics');
    }
    metrics.cost = costGuard.snapshot();

    const roundTripMs = Date.now() - startedAtMs;
    metrics.lastRoundTripMs = roundTripMs;
    metrics.roundTripMs.push(roundTripMs);
    if (metrics.roundTripMs.length > 50) metrics.roundTripMs.shift();
    const parseEvents = [];
    const intent = parseDeepseekIntentReply(result.content, snapshot, {
      requestIndex,
      commandPrefix: 'deepseek-nav',
      ttlMs,
      maxTtlMs,
      targetDistanceBlocks,
      maxTargetDistanceBlocks,
      r2Depth,
      maxR2Depth,
      r5Direction,
      gatherCommandPrefix: 'deepseek-gather',
      gatherTreeCommandPrefix: 'deepseek-tree',
      craftCommandPrefix: 'deepseek-craft',
      placeCommandPrefix: 'deepseek-place',
      r5CommandPrefix: 'deepseek-r5-chain',
      onParseEvent: (event) => parseEvents.push(event),
    });
    recordParseEvents(metrics, parseEvents);
    if (intent.reason === 'adapter_parse_error' || intent.reason === 'adapter_no_valid_target') {
      metrics.parseErrorCount += 1;
    }
    logParseEvents(instanceId, requestIndex, intent.commandId, parseEvents);
    metrics.responses.push({
      requestId,
      instanceId,
      requestIndex,
      roundTripMs,
      responseMetrics: publicResponseMetrics(result.responseMetrics),
      parse: summarizeParseEvents(parseEvents, intent),
      at: new Date().toISOString(),
    });
    if (metrics.responses.length > 50) metrics.responses.shift();
    return intent;
  };
}

export function createDeepseekBrainServer(opts = {}) {
  const env = opts.env || process.env;
  const port = Number(opts.port || env.MCBOT_FABRIC_BRAIN_PORT || 8765);
  const metrics = opts.metrics || createMetrics();
  const missionMode = envFlag(env.MCBOT_FABRIC_MISSION);
  let handleDeepseekIntent = opts.handleDeepseekIntent;
  let managedStrategyCoordinator = null;
  let managedOpportunityCoordinator = null;
  let managedMissionRuntime = false;
  const emitRuntimeEvent = typeof opts.emit === 'function'
    ? opts.emit
    : (event) => console.log(JSON.stringify(event));
  if (!handleDeepseekIntent && missionMode) {
    const costCeilingUsd = positiveNumber(env.MCBOT_FABRIC_DEEPSEEK_COST_USD_MAX)
      ?? positiveNumber(env.MCBOT_ADVISOR_COST_USD_MAX)
      ?? (config.advisor?.costUsdMax ?? 1);
    const costGuard = opts.costGuard || createAdvisorCostGuard({
      ...(config.advisor || {}),
      costUsdMax: costCeilingUsd,
    });
    const model = env.MCBOT_FABRIC_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL || config.deepseek.model;
    const modelSource = env.MCBOT_FABRIC_DEEPSEEK_MODEL
      ? 'MCBOT_FABRIC_DEEPSEEK_MODEL'
      : env.DEEPSEEK_MODEL
        ? 'DEEPSEEK_MODEL'
        : 'config.deepseek.model';
    const maxCalls = positiveInteger(env.MCBOT_FABRIC_DEEPSEEK_MAX_CALLS) ?? 8;
    const maxTokens = positiveInteger(env.MCBOT_FABRIC_DEEPSEEK_MAX_TOKENS) ?? 4096;
    const trackedComplete = createTrackedCompletionGateway({
      metrics,
      costGuard,
      maxCalls,
      complete: opts.completeWithMetrics || opts.complete || completeWithMetrics,
    });
    metrics.cost = costGuard.snapshot();
    metrics.config = {
      model,
      modelSource,
      maxCalls,
      maxTokens,
      costCeilingUsd,
      providerEnabled: true,
      providerPurpose: 'mission',
      oraclePrimary: true,
      missionProviderEnabled: true,
      providerAttemptCount: metrics.providerAttemptCount,
      providerUnknownCostBlocked: metrics.providerUnknownCostBlocked,
      providerUnknownCostReason: metrics.providerUnknownCostReason,
    };
    const missionHandlerFactory = typeof opts.createMissionHandler === 'function'
      ? opts.createMissionHandler
      : createMissionBrainHandler;
    handleDeepseekIntent = missionHandlerFactory({
      complete: async (messages, callOpts) => (await trackedComplete(messages, {
        ...callOpts,
        trackedContext: { purpose: 'mission' },
      })).content,
      model,
      maxTokens,
      ttlMs: positiveInteger(env.MCBOT_FABRIC_DEEPSEEK_TTL_MS) ?? undefined,
      costGuard,
      setupCommands: parseSetupCommands(env.MCBOT_FABRIC_DEEPSEEK_SETUP_COMMANDS_JSON || env.MCBOT_FABRIC_DEEPSEEK_SETUP_COMMANDS),
      setupSettleMs: clamp(Math.floor(finiteNumber(env.MCBOT_FABRIC_DEEPSEEK_SETUP_SETTLE_MS, 1000)), 0, 60000),
      targetHints: parseMissionTargetHints(env.MCBOT_FABRIC_MISSION_TARGET_HINTS_JSON || env.MCBOT_FABRIC_MISSION_TARGET_HINTS),
      missionGoal: env.MCBOT_FABRIC_MISSION_GOAL || '',
      exploreEnabled: envFlagDefaultOn(env.MCBOT_FABRIC_EXPLORE),
      exploreLegBlocks: positiveNumber(env.MCBOT_FABRIC_EXPLORE_LEG_BLOCKS) ?? undefined,
      exploreLegLimit: positiveInteger(env.MCBOT_FABRIC_EXPLORE_LEG_LIMIT) ?? undefined,
      exploreArriveDist: positiveNumber(env.MCBOT_FABRIC_EXPLORE_ARRIVE_DIST) ?? undefined,
      exploreHopBlocks: positiveNumber(env.MCBOT_FABRIC_EXPLORE_HOP_BLOCKS) ?? undefined,
      opportunityScheduler: opts.opportunityScheduler,
      oraclePrimary: true,
      emit: emitRuntimeEvent,
      now: opts.now,
    });
  }
  if (!handleDeepseekIntent) handleDeepseekIntent = createDeepseekBrainHandler({ ...opts, env, metrics });
  let requestGracefulServerShutdown = null;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        writeText(res, 200, 'ok\n');
        return;
      }
      if (req.method === 'GET' && req.url === '/metrics') {
        writeText(res, 200, JSON.stringify(metrics, null, 2) + '\n', 'application/json; charset=utf-8');
        return;
      }
      if (req.method === 'POST' && req.url === '/shutdown') {
        if (!managedMissionRuntime) {
          writeText(res, 404, 'not found\n');
          return;
        }
        if (!isLoopbackHost(req.socket?.remoteAddress)) {
          writeText(res, 403, 'loopback required\n');
          return;
        }
        if (typeof requestGracefulServerShutdown !== 'function') {
          writeText(res, 503, 'shutdown unavailable\n');
          return;
        }
        writeText(res, 202, 'draining\n');
        setImmediate(() => {
          void requestGracefulServerShutdown('loopback_http').catch(() => {});
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/intent') {
        const { instanceId, snapshot } = parseBrainRequest(await readRequestBody(req));
        const startedAtMs = Date.now();
        try {
          const intent = await handleDeepseekIntent(instanceId, snapshot);
          const roundTripMs = Date.now() - startedAtMs;
          if (!isQuiet(intent)) {
            const event = {
              evt: 'fabric.deepseek.intent',
              instanceId,
              action: intent.action,
              reason: intent.reason,
              commandId: intent.commandId,
              ttlMs: intent.ttlMs,
              roundTripMs,
              providerAttemptCount: metrics.providerAttemptCount,
              providerUnknownCostBlocked: metrics.providerUnknownCostBlocked,
              deepseekCallCount: metrics.deepseekCallCount,
              sessionCostUsd: metrics.cost?.sessionCostUsd ?? 0,
            };
            for (const key of ['targetX', 'targetY', 'targetZ']) {
              if (Number.isFinite(intent[key])) event[key] = intent[key];
            }
            console.log(JSON.stringify(event));
          }
          writeText(res, 200, `instanceId:${instanceId}\n${JSON.stringify(intent)}\n`);
        } catch (err) {
          metrics.lastError = sanitizeError(err);
          console.error(JSON.stringify({ evt: 'fabric.deepseek.error', instanceId, error: metrics.lastError }));
          const intent = stopIntent('deepseek_error', { ttlMs: 100, commandId: 'deepseek-error' });
          writeText(res, 200, `instanceId:${instanceId}\n${JSON.stringify(intent)}\n`);
        }
        return;
      }
      writeText(res, 404, 'not found\n');
    } catch (err) {
      metrics.lastError = sanitizeError(err);
      writeText(res, 500, `error: ${metrics.lastError}\n`);
    }
  });

  let shutdownPromise = null;
  const shutdownMissionRuntime = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = managedMissionRuntime
      ? shutdownManagedMissionRuntime({
        handleDeepseekIntent,
        strategyCoordinator: managedStrategyCoordinator,
        opportunityCoordinator: managedOpportunityCoordinator,
      })
      : Promise.resolve();
    return shutdownPromise;
  };
  if (managedMissionRuntime) {
    server.once('close', () => {
      void shutdownMissionRuntime().catch((error) => {
        emitRuntimeEvent({
          evt: 'strategy.active_canary.shutdown_failed',
          reason: sanitizeError(error),
          behaviorApplied: false,
        });
      });
    });
  }
  let gracefulServerShutdownPromise = null;
  requestGracefulServerShutdown = (reason = 'runtime') => {
    if (gracefulServerShutdownPromise) return gracefulServerShutdownPromise;
    metrics.gracefulShutdownRequestedCount += 1;
    gracefulServerShutdownPromise = (async () => {
      if (server.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections?.();
        });
      }
      await shutdownMissionRuntime();
      metrics.gracefulShutdownCompletedCount += 1;
      emitRuntimeEvent({
        evt: 'strategy.active_canary.shutdown_completed',
        reason,
        providerAttemptCount: metrics.providerAttemptCount,
        providerMaxCalls: metrics.config?.maxCalls ?? null,
        deepseekCallCount: metrics.deepseekCallCount,
        providerAccountingPendingCount: metrics.providerAccountingPendingCount,
        providerAccountingSettlementCount: metrics.providerAccountingSettlementCount,
        providerUnknownCostBlocked: metrics.providerUnknownCostBlocked,
        providerUnknownCostPermanent: metrics.providerUnknownCostPermanent,
        providerUnknownCostReason: metrics.providerUnknownCostReason,
        sessionCostUsd: metrics.cost?.sessionCostUsd ?? 0,
        costCeilingUsd: metrics.config?.costCeilingUsd ?? null,
        costCeilingStatus: metrics.cost?.status ?? null,
        providerAuthorized: metrics.config?.providerAuthorized ?? null,
        gracefulShutdownRequestedCount: metrics.gracefulShutdownRequestedCount,
        gracefulShutdownCompletedCount: metrics.gracefulShutdownCompletedCount,
        gracefulShutdownFailedCount: metrics.gracefulShutdownFailedCount,
        behaviorApplied: false,
      });
    })().catch((error) => {
      metrics.gracefulShutdownFailedCount += 1;
      metrics.lastError = sanitizeError(error);
      emitRuntimeEvent({
        evt: 'strategy.active_canary.shutdown_failed',
        reason,
        error: metrics.lastError,
        providerAttemptCount: metrics.providerAttemptCount,
        deepseekCallCount: metrics.deepseekCallCount,
        providerAccountingPendingCount: metrics.providerAccountingPendingCount,
        providerUnknownCostBlocked: metrics.providerUnknownCostBlocked,
        gracefulShutdownFailedCount: metrics.gracefulShutdownFailedCount,
        behaviorApplied: false,
      });
      throw error;
    });
    return gracefulServerShutdownPromise;
  };
  return {
    server,
    metrics,
    port,
    shutdownMissionRuntime,
    requestGracefulServerShutdown,
  };
}

/**
 * A deliberately unusable provider gateway for the deterministic mission
 * server. The mission orchestrator still requires a `complete` function at
 * construction time, but the oracle-first shadow path must never call
 * a model. Count any attempted escape through that seam, then fail closed
 * without recording a DeepSeek call or response.
 */
export function createFailClosedProviderCompletion(metrics) {
  if (!metrics || typeof metrics !== 'object') {
    throw new Error('createFailClosedProviderCompletion requires metrics');
  }
  if (!Number.isInteger(metrics.providerAttemptCount)) metrics.providerAttemptCount = 0;
  return async function providerDisabledCompletion() {
    metrics.providerAttemptCount += 1;
    if (metrics.config && typeof metrics.config === 'object') {
      metrics.config.providerAttemptCount = metrics.providerAttemptCount;
    }
    const error = new Error('provider completion is disabled for opportunity shadow mission server');
    error.code = 'FABRIC_PROVIDER_DISABLED';
    throw error;
  };
}

/**
 * Mission planning remains deterministic even when the strategic canary is
 * provider-backed. Any attempted escape through the orchestrator completion
 * seam is an authority violation, not a provider attempt.
 */
export function createOracleOnlyMissionCompletion(metrics) {
  if (!metrics || typeof metrics !== 'object') {
    throw new Error('createOracleOnlyMissionCompletion requires metrics');
  }
  if (!Number.isInteger(metrics.missionProviderAuthorityViolationCount)) {
    metrics.missionProviderAuthorityViolationCount = 0;
  }
  return async function missionProviderForbidden() {
    metrics.missionProviderAuthorityViolationCount += 1;
    const error = new Error('provider completion is forbidden for oracle-primary mission planning');
    error.code = 'FABRIC_MISSION_PROVIDER_FORBIDDEN';
    throw error;
  };
}

async function shutdownManagedMissionRuntime(input = {}) {
  let firstError = null;
  const run = async (fn) => {
    if (typeof fn !== 'function') return;
    try {
      await fn();
    } catch (error) {
      if (!firstError) firstError = error;
    }
  };
  await run(input.handleDeepseekIntent?.closeOpportunityObservations?.bind(input.handleDeepseekIntent));
  await run(componentShutdown(input.strategyCoordinator));
  await run(componentShutdown(input.opportunityCoordinator));
  if (firstError) throw firstError;
}

function componentShutdown(component) {
  if (typeof component?.shutdown === 'function') return component.shutdown.bind(component);
  if (typeof component?.stop === 'function') return component.stop.bind(component);
  if (typeof component?.flush === 'function') return component.flush.bind(component);
  return null;
}

/**
 * Provider-free deterministic mission server. It reuses the normal HTTP shell
 * and mission handler while making the no-provider contract observable and
 * fail-closed for baseline, shadow, and deterministic-active qualification.
 */
export function createProviderFreeMissionBrainServer(opts = {}) {
  const env = opts.env || process.env;
  if (!envFlag(env.MCBOT_FABRIC_MISSION)) {
    throw new Error('MCBOT_FABRIC_MISSION=1 required for provider-free mission brain');
  }
  const requestedOpportunityMode = String(env.MCBOT_FABRIC_OPPORTUNITY_MODE || 'off').trim().toLowerCase() || 'off';
  if (!['off', 'shadow', 'active'].includes(requestedOpportunityMode)) {
    throw new Error('MCBOT_FABRIC_OPPORTUNITY_MODE=off|shadow|active required for provider-free mission brain');
  }
  const requestedStrategyMode = String(env.MCBOT_FABRIC_STRATEGY_MODE || 'off').trim().toLowerCase() || 'off';
  if (requestedStrategyMode !== 'off') {
    throw new Error('MCBOT_FABRIC_STRATEGY_MODE=off required for provider-free mission brain');
  }

  const configuredMemoryRoot = opts.opportunityMemoryRootDir || env.MCBOT_FABRIC_WORLD_MEMORY_ROOT;
  const absoluteMemoryRoot = typeof configuredMemoryRoot === 'string' && configuredMemoryRoot.trim()
    ? path.resolve(configuredMemoryRoot.trim())
    : undefined;
  const opportunityConfig = resolveFabricOpportunityConfig(env, {
    mode: requestedOpportunityMode,
    configuredWorldId: env.MCBOT_WORLD_ID,
    memoryRootDir: absoluteMemoryRoot,
  });
  const metrics = opts.metrics || createMetrics();
  metrics.providerAttemptCount = 0;
  metrics.providerUnknownCostBlocked = false;
  metrics.providerUnknownCostReason = null;
  metrics.deepseekCallCount = 0;
  metrics.responses = [];
  metrics.cost = null;
  metrics.config = {
    strategyMode: requestedStrategyMode,
    opportunityMode: opportunityConfig.mode,
    providerEnabled: false,
    providerAttemptCount: 0,
    providerUnknownCostBlocked: false,
    providerUnknownCostReason: null,
    behaviorApplied: requestedOpportunityMode === 'active',
    worldMemoryRoot: absoluteMemoryRoot || null,
    model: null,
    modelSource: 'provider_disabled',
    maxCalls: 0,
    maxTokens: 0,
    costCeilingUsd: 0,
  };

  const emit = typeof opts.emit === 'function' ? opts.emit : (event) => console.log(JSON.stringify(event));
  const opportunityCoordinator = opts.opportunityCoordinator || createOpportunityShadowCoordinator({
    env,
    config: opportunityConfig,
    emit,
    clock: opts.now,
    createMemoryStore: opts.createOpportunityMemoryStore,
  });
  const complete = createFailClosedProviderCompletion(metrics);
  const handleDeepseekIntent = createMissionBrainHandler({
    complete,
    ttlMs: positiveInteger(env.MCBOT_FABRIC_DEEPSEEK_TTL_MS) ?? undefined,
    setupCommands: parseSetupCommands(env.MCBOT_FABRIC_DEEPSEEK_SETUP_COMMANDS_JSON || env.MCBOT_FABRIC_DEEPSEEK_SETUP_COMMANDS),
    setupSettleMs: clamp(Math.floor(finiteNumber(env.MCBOT_FABRIC_DEEPSEEK_SETUP_SETTLE_MS, 1000)), 0, 60000),
    targetHints: parseMissionTargetHints(env.MCBOT_FABRIC_MISSION_TARGET_HINTS_JSON || env.MCBOT_FABRIC_MISSION_TARGET_HINTS),
    missionGoal: env.MCBOT_FABRIC_MISSION_GOAL || '',
    exploreEnabled: envFlagDefaultOn(env.MCBOT_FABRIC_EXPLORE),
    exploreLegBlocks: positiveNumber(env.MCBOT_FABRIC_EXPLORE_LEG_BLOCKS) ?? undefined,
    exploreLegLimit: positiveInteger(env.MCBOT_FABRIC_EXPLORE_LEG_LIMIT) ?? undefined,
    exploreArriveDist: positiveNumber(env.MCBOT_FABRIC_EXPLORE_ARRIVE_DIST) ?? undefined,
    exploreHopBlocks: positiveNumber(env.MCBOT_FABRIC_EXPLORE_HOP_BLOCKS) ?? undefined,
    opportunityCoordinator,
    opportunityScheduler: opts.opportunityScheduler,
    emit,
    now: opts.now,
  });
  const runtime = createDeepseekBrainServer({
    ...opts,
    env,
    metrics,
    handleDeepseekIntent,
  });
  let shutdownPromise = null;
  const shutdownOpportunityShadow = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      // Stop admission and drain the handler first: the final observation may
      // still update world memory that the coordinator then needs to flush.
      await handleDeepseekIntent.closeOpportunityObservations?.();
      if (typeof opportunityCoordinator.shutdown === 'function') {
        return opportunityCoordinator.shutdown();
      }
      if (typeof opportunityCoordinator.stop === 'function') {
        return opportunityCoordinator.stop();
      }
      if (typeof opportunityCoordinator.flush === 'function') {
        return opportunityCoordinator.flush();
      }
      return undefined;
    })();
    return shutdownPromise;
  };
  runtime.server.once('close', () => {
    void shutdownOpportunityShadow().catch((error) => {
      emit({
        evt: 'opportunity.shadow.shutdown_failed',
        reason: sanitizeError(error),
        behaviorApplied: false,
      });
    });
  });
  return { ...runtime, shutdownOpportunityShadow };
}

export function startProviderFreeMissionBrainServer(opts = {}) {
  const runtime = createProviderFreeMissionBrainServer(opts);
  const { server, metrics, port } = runtime;
  server.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({
      evt: 'fabric.mission.ready',
      port,
      strategyMode: metrics.config?.strategyMode,
      opportunityMode: metrics.config?.opportunityMode,
      providerEnabled: metrics.config?.providerEnabled,
      providerAttemptCount: metrics.providerAttemptCount,
      deepseekCallCount: metrics.deepseekCallCount,
      behaviorApplied: metrics.config?.behaviorApplied,
      worldMemoryRoot: metrics.config?.worldMemoryRoot,
    }));
    console.log(`[brain] Deterministic mission server with provider-free opportunity ${metrics.config?.opportunityMode}`);
  });
  return runtime;
}

export function startDeepseekBrainServer(opts = {}) {
  const env = opts.env || process.env;
  const apiKey = nonEmptyString(opts.apiKey)
    || nonEmptyString(env.DEEPSEEK_API_KEY)
    || nonEmptyString(config.deepseek?.apiKey);
  if (!envFlag(env.MCBOT_ALLOW_DEEPSEEK)) {
    throw new Error('MCBOT_ALLOW_DEEPSEEK=1 required for fabric DeepSeek brain');
  }
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY missing');
  }
  const runtime = createDeepseekBrainServer({ ...opts, env, apiKey });
  const { server, metrics, port } = runtime;
  server.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({
      evt: 'fabric.deepseek.ready',
      port,
      model: metrics.config?.model,
      maxCalls: metrics.config?.maxCalls,
      costCeilingUsd: metrics.config?.costCeilingUsd,
      injectDelayMs: metrics.config?.injectDelayMs,
      maxTokens: metrics.config?.maxTokens,
      exhaustionBackoffMs: metrics.config?.exhaustionBackoffMs,
      ttlMs: metrics.config?.ttlMs,
      maxTtlMs: metrics.config?.maxTtlMs,
      modelSource: metrics.config?.modelSource,
      targetDistanceBlocks: metrics.config?.targetDistanceBlocks,
      maxTargetDistanceBlocks: metrics.config?.maxTargetDistanceBlocks,
      r2Depth: metrics.config?.r2Depth,
      maxR2Depth: metrics.config?.maxR2Depth,
      directionSequence: metrics.config?.directionSequence,
      task: metrics.config?.task,
      setupCommandCount: metrics.config?.setupCommandCount,
      strategyMode: metrics.config?.strategyMode,
      strategyModel: metrics.config?.strategyModel,
      opportunityMode: metrics.config?.opportunityMode,
      providerEnabled: metrics.config?.providerEnabled,
      providerPurpose: metrics.config?.providerPurpose,
      providerAuthorized: metrics.config?.providerAuthorized,
      providerAttemptCount: metrics.providerAttemptCount,
      providerUnknownCostBlocked: metrics.providerUnknownCostBlocked,
      deepseekCallCount: metrics.deepseekCallCount,
      missionProviderAuthorityViolationCount: metrics.missionProviderAuthorityViolationCount,
    }));
    console.log(`[brain] DeepSeek model ${metrics.config?.model} (${metrics.config?.modelSource})`);
    console.log(`[brain] DeepSeek ceiling $${formatUsd(metrics.config?.costCeilingUsd)} (${metrics.config?.costCeilingSource})`);
  });
  return runtime;
}

export function parseJsonObjectWithRepair(content) {
  const text = String(content || '').trim();
  if (!text) return { ok: false, reason: 'empty model response' };
  const strict = tryParseJsonObject(text);
  if (strict.ok) return { ok: true, value: strict.value, repairMethod: null };
  for (const candidate of repairJsonCandidates(text)) {
    const parsed = tryParseJsonObject(candidate.text);
    if (parsed.ok) {
      return { ok: true, value: parsed.value, repairMethod: candidate.method };
    }
  }
  return { ok: false, reason: strict.reason };
}

export function exhaustionBackoffDecision(state = {}, nowMs = Date.now(), opts = {}) {
  const backoffMs = positiveInteger(opts.backoffMs) ?? DEFAULT_EXHAUSTION_BACKOFF_MS;
  const nextAllowedAtMs = finiteNumber(state.nextAllowedAtMs, 0);
  if (nowMs >= nextAllowedAtMs) {
    state.nextAllowedAtMs = nowMs + backoffMs;
    return { quiet: false, delayMs: 0, nextAllowedAtMs: state.nextAllowedAtMs };
  }
  return { quiet: true, delayMs: nextAllowedAtMs - nowMs, nextAllowedAtMs };
}

function tryParseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (!isObject(parsed)) return { ok: false, reason: 'model response must be a JSON object' };
    return { ok: true, value: parsed };
  } catch (err) {
    return { ok: false, reason: `JSON parse: ${err.message}` };
  }
}

function repairJsonCandidates(text) {
  const candidates = [];
  const seen = new Set();
  const add = (method, value) => {
    const candidate = nonEmptyString(value);
    if (!candidate || candidate === text || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push({ method, text: candidate });
  };

  const fenced = stripJsonFence(text);
  add('strip_code_fence', fenced);

  const balanced = extractBalancedJsonObject(text);
  add('extract_balanced_object', balanced);

  for (const [method, value] of [
    ['drop_trailing_commas', dropTrailingCommas(text)],
    ['strip_code_fence+drop_trailing_commas', dropTrailingCommas(fenced)],
    ['extract_balanced_object+drop_trailing_commas', dropTrailingCommas(balanced)],
  ]) {
    add(method, value);
  }

  for (const [baseMethod, value] of [
    ['truncation_close', text],
    ['strip_code_fence+truncation_close', fenced],
  ]) {
    const closed = closeTruncatedJsonObject(value);
    add(baseMethod, closed);
    add(`${baseMethod}+drop_trailing_commas`, dropTrailingCommas(closed));
  }

  return candidates;
}

function stripJsonFence(text) {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(String(text || '').trim());
  return match ? match[1].trim() : null;
}

function extractBalancedJsonObject(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth === 0) return source.slice(start, i + 1).trim();
  }
  return null;
}

function dropTrailingCommas(text) {
  const source = nonEmptyString(text);
  return source ? source.replace(/,\s*([}\]])/g, '$1') : null;
}

function closeTruncatedJsonObject(text) {
  const source = nonEmptyString(text);
  if (!source) return null;
  const start = source.indexOf('{');
  if (start < 0) return null;
  let out = source.slice(start).replace(/```\s*$/g, '').trimEnd();
  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    if (ch === '[') stack.push(']');
    if ((ch === '}' || ch === ']') && stack[stack.length - 1] === ch) stack.pop();
  }
  if (inString) out += '"';
  out = out.replace(/,\s*$/, '');
  while (stack.length > 0) {
    out += stack.pop();
  }
  return dropTrailingCommas(out);
}

function parseExplicitTarget(candidate) {
  const targetX = finiteNumberOrNull(candidate.targetX);
  const targetZ = finiteNumberOrNull(candidate.targetZ);
  if (targetX === null || targetZ === null) return null;
  return { x: targetX, z: targetZ };
}

function parseGatherTarget(candidate, snapshot = {}) {
  const targetX = finiteNumberOrNull(candidate.targetX);
  const targetY = finiteNumberOrNull(candidate.targetY);
  const targetZ = finiteNumberOrNull(candidate.targetZ);
  if (targetX === null || targetY === null || targetZ === null) {
    return { ok: false, reason: 'adapter_no_valid_log_target' };
  }
  const target = {
    x: Math.floor(targetX),
    y: Math.floor(targetY),
    z: Math.floor(targetZ),
  };
  const nearbyLogs = compactNearbyLogs(snapshot.nearbyLogs);
  if (!nearbyLogs.some((log) => log.x === target.x && log.y === target.y && log.z === target.z)) {
    return { ok: false, reason: 'adapter_log_target_not_visible' };
  }
  return { ok: true, target };
}

function targetFromDirection(candidate, snapshot, opts = {}) {
  const direction = nonEmptyString(candidate.direction)?.toLowerCase();
  if (!['north', 'south', 'east', 'west'].includes(direction)) return null;
  const maxBlocks = positiveInteger(opts.maxTargetDistanceBlocks) ?? DEFAULT_MAX_TARGET_DISTANCE_BLOCKS;
  const defaultBlocks = positiveInteger(opts.targetDistanceBlocks) ?? DEFAULT_TARGET_DISTANCE_BLOCKS;
  const blocks = clamp(positiveInteger(candidate.blocks) ?? defaultBlocks, 1, maxBlocks);
  const x = finiteNumber(snapshot.x, 0);
  const z = finiteNumber(snapshot.z, 0);
  if (direction === 'north') return { x, z: z - blocks };
  if (direction === 'south') return { x, z: z + blocks };
  if (direction === 'east') return { x: x + blocks, z };
  return { x: x - blocks, z };
}

function normalizeCardinalDirection(value) {
  const text = nonEmptyString(value)?.toLowerCase();
  return ['north', 'south', 'east', 'west'].includes(text) ? text : null;
}

function buildR5IronChainSetupCommands(snapshot = {}, opts = {}) {
  const depth = clamp(positiveInteger(opts.depth) ?? 64, 1, positiveInteger(opts.maxDepth) ?? 96);
  const direction = normalizeCardinalDirection(opts.direction) || 'west';
  const startX = Math.floor(finiteNumber(snapshot.x, 0));
  const startY = Math.floor(finiteNumber(snapshot.y, 64));
  const startZ = Math.floor(finiteNumber(snapshot.z, 0));
  const dx = direction === 'east' ? 1 : direction === 'west' ? -1 : 0;
  const dz = direction === 'south' ? 1 : direction === 'north' ? -1 : 0;
  const targetX = startX + dx * depth;
  const targetY = startY - depth;
  const targetZ = startZ + dz * depth;
  return [
    'clear @p',
    'effect give @p minecraft:night_vision 999999 0 true',
    'effect give @p minecraft:instant_health 1 20 true',
    'effect give @p minecraft:saturation 1 20 true',
    'difficulty peaceful',
    'give @p minecraft:stone_pickaxe 4',
    'give @p minecraft:stick 8',
    'give @p minecraft:crafting_table 1',
    'give @p minecraft:furnace 1',
    'give @p minecraft:charcoal 8',
    `setblock ${targetX} ${targetY} ${targetZ + 1} minecraft:iron_ore replace`,
    `setblock ${targetX} ${targetY + 1} ${targetZ + 1} minecraft:iron_ore replace`,
    `setblock ${targetX - 1} ${targetY} ${targetZ + 1} minecraft:iron_ore replace`,
    `setblock ${targetX - 1} ${targetY + 1} ${targetZ + 1} minecraft:iron_ore replace`,
    `setblock ${targetX} ${targetY} ${targetZ - 1} minecraft:iron_ore replace`,
    `setblock ${targetX} ${targetY + 1} ${targetZ - 1} minecraft:iron_ore replace`,
    `setblock ${targetX - 1} ${targetY} ${targetZ - 1} minecraft:iron_ore replace`,
    `setblock ${targetX - 1} ${targetY + 1} ${targetZ - 1} minecraft:iron_ore replace`,
  ];
}

function compactNearbyLogs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const x = finiteNumberOrNull(entry?.x);
      const y = finiteNumberOrNull(entry?.y);
      const z = finiteNumberOrNull(entry?.z);
      if (x === null || y === null || z === null) return null;
      return {
        block: nonEmptyString(entry.block) || 'log',
        x: Math.floor(x),
        y: Math.floor(y),
        z: Math.floor(z),
        distance: round(entry.distance),
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function compactCountMap(value) {
  if (!isObject(value)) return {};
  const out = {};
  for (const [key, rawCount] of Object.entries(value)) {
    const name = nonEmptyString(key);
    const count = finiteNumberOrNull(rawCount);
    if (!name || count === null || count <= 0) continue;
    out[name] = Math.floor(count);
  }
  return out;
}

function parseSetupCommands(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) {
      return parsed
        .map((command) => nonEmptyString(command))
        .filter(Boolean)
        .slice(0, SETUP_COMMAND_LIMIT);
    }
  } catch {
    // Fall through to delimiter parsing.
  }
  return String(value)
    .split(/\r?\n|;/)
    .map((command) => nonEmptyString(command))
    .filter(Boolean)
    .slice(0, SETUP_COMMAND_LIMIT);
}

function parseMissionTargetHints(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((hint) => {
        if (!isObject(hint)) return null;
        const x = finiteNumberOrNull(hint.x ?? hint.targetX);
        const y = finiteNumberOrNull(hint.y ?? hint.targetY);
        const z = finiteNumberOrNull(hint.z ?? hint.targetZ);
        if (x === null || y === null || z === null) return null;
        const action = nonEmptyString(hint.action)?.toLowerCase() || 'gather_log';
        return { action, x, y, z };
      })
      .filter(Boolean)
      .slice(0, 64);
  } catch {
    return [];
  }
}

function normalizeTask(value) {
  const text = nonEmptyString(value)?.toLowerCase();
  if (text === 'gather_log'
    || text === 'gather_tree'
    || isCraftTask(text)
    || text === 'craft_stone_tools'
    || text === 'place_table'
    || text === 'place_furnace'
    || text === 'smelt_charcoal'
    || text === 'make_charcoal'
    || text === 'r2_mine_stone_return'
    || text === 'r5_iron_chain') return text;
  return DEFAULT_TASK;
}

function isCraftTask(task) {
  return task === 'craft_planks'
    || task === 'craft_sticks'
    || task === 'craft_table'
    || task === 'craft_pickaxe'
    || task === 'craft_stone_pickaxe'
    || task === 'craft_stone_axe'
    || task === 'craft_stone_sword'
    || task === 'craft_furnace';
}

function isCraftAction(action) {
  return isCraftTask(nonEmptyString(action)?.toLowerCase());
}

function craftTaskConfig(task) {
  if (task === 'craft_sticks') {
    return {
      action: 'craft_sticks',
      reason: 'sticks',
      stopReason: 'no_planks',
      executorLine: 'The Java loop owns inventory slot clicks, 2x2 placement, result take, and inventory-delta verification.',
      decisionLine: 'You only decide whether at least 2 planks are present and request the sticks craft.',
    };
  }
  if (task === 'craft_table') {
    return {
      action: 'craft_table',
      reason: 'table',
      stopReason: 'no_planks',
      executorLine: 'The Java loop owns inventory slot clicks, 2x2 placement, result take, and inventory-delta verification.',
      decisionLine: 'You only decide whether at least 4 planks are present and request the crafting table craft.',
    };
  }
  if (task === 'craft_pickaxe') {
    return {
      action: 'craft_pickaxe',
      reason: 'pickaxe',
      stopReason: 'no_materials',
      executorLine: 'The Java loop owns opening the placed crafting table, 3x3 slot placement, result take, and typed wooden_pickaxe verification.',
      decisionLine: 'You only decide whether at least 3 planks and 2 sticks are present and request the wooden pickaxe craft.',
    };
  }
  if (task === 'craft_stone_tools' || task === 'craft_stone_pickaxe') {
    return {
      action: 'craft_stone_pickaxe',
      reason: 'stone_pickaxe',
      stopReason: 'no_materials',
      executorLine: 'The Java loop owns opening the placed crafting table, 3x3 slot placement, result take, and typed stone_pickaxe verification.',
      decisionLine: 'You only decide whether at least 3 cobblestone and 2 sticks are present and request the stone pickaxe craft.',
    };
  }
  if (task === 'craft_stone_axe') {
    return {
      action: 'craft_stone_axe',
      reason: 'stone_axe',
      stopReason: 'no_materials',
      executorLine: 'The Java loop owns opening the placed crafting table, 3x3 slot placement, result take, and typed stone_axe verification.',
      decisionLine: 'You only decide whether at least 3 cobblestone and 2 sticks are present and request the stone axe craft.',
    };
  }
  if (task === 'craft_stone_sword') {
    return {
      action: 'craft_stone_sword',
      reason: 'stone_sword',
      stopReason: 'no_materials',
      executorLine: 'The Java loop owns opening the placed crafting table, 3x3 slot placement, result take, and typed stone_sword verification.',
      decisionLine: 'You only decide whether at least 2 cobblestone and 1 stick are present and request the stone sword craft.',
    };
  }
  if (task === 'craft_furnace') {
    return {
      action: 'craft_furnace',
      reason: 'furnace',
      stopReason: 'no_materials',
      executorLine: 'The Java loop owns opening the placed crafting table, 3x3 slot placement, result take, and typed furnace verification.',
      decisionLine: 'You only decide whether at least 8 cobblestone are present and request the furnace craft.',
    };
  }
  return {
    action: 'craft_planks',
    reason: 'planks',
    stopReason: 'no_logs',
    executorLine: 'The Java loop owns inventory slot clicks, 2x2 placement, result take, and inventory-delta verification.',
    decisionLine: 'You only decide whether logs are present and request the planks craft.',
  };
}

function validateCraftInventory(action, snapshot = {}) {
  const compact = compactSnapshot(snapshot);
  if (action === 'craft_planks') {
    return compact.inventory.logCount >= 1
      ? { ok: true }
      : { ok: false, reason: 'craft_planks_no_logs' };
  }
  if (action === 'craft_sticks') {
    return compact.inventory.plankCount >= 2
      ? { ok: true }
      : { ok: false, reason: 'craft_sticks_no_planks' };
  }
  if (action === 'craft_table') {
    return compact.inventory.plankCount >= 4
      ? { ok: true }
      : { ok: false, reason: 'craft_table_no_planks' };
  }
  if (action === 'craft_pickaxe') {
    if (compact.inventory.plankCount < 3) return { ok: false, reason: 'craft_pickaxe_no_planks' };
    if (compact.inventory.stickCount < 2) return { ok: false, reason: 'craft_pickaxe_no_sticks' };
    return { ok: true };
  }
  if (action === 'craft_stone_pickaxe' || action === 'craft_stone_axe') {
    if (compact.inventory.cobblestoneCount < 3) return { ok: false, reason: `${action}_no_cobblestone` };
    if (compact.inventory.stickCount < 2) return { ok: false, reason: `${action}_no_sticks` };
    return { ok: true };
  }
  if (action === 'craft_stone_sword') {
    if (compact.inventory.cobblestoneCount < 2) return { ok: false, reason: 'craft_stone_sword_no_cobblestone' };
    if (compact.inventory.stickCount < 1) return { ok: false, reason: 'craft_stone_sword_no_sticks' };
    return { ok: true };
  }
  if (action === 'craft_furnace') {
    return compact.inventory.cobblestoneCount >= 8
      ? { ok: true }
      : { ok: false, reason: 'craft_furnace_no_cobblestone' };
  }
  return { ok: false, reason: 'craft_unknown_recipe' };
}

function validateSmeltCharcoalInventory(snapshot = {}) {
  const compact = compactSnapshot(snapshot);
  if (compact.inventory.logCount < 1) {
    return { ok: false, reason: 'smelt_charcoal_no_log_input' };
  }
  if (compact.inventory.plankCount < 1 && compact.inventory.logCount < 2) {
    return { ok: false, reason: 'smelt_charcoal_no_fuel' };
  }
  return { ok: true };
}

function validateMakeCharcoalInventory(snapshot = {}) {
  const compact = compactSnapshot(snapshot);
  if (compact.inventory.cobblestoneCount < 8) {
    return { ok: false, reason: 'make_charcoal_no_cobblestone' };
  }
  if (compact.inventory.logCount < 1) {
    return { ok: false, reason: 'make_charcoal_no_log_input' };
  }
  if (compact.inventory.plankCount < 1 && compact.inventory.logCount < 2) {
    return { ok: false, reason: 'make_charcoal_no_fuel' };
  }
  return { ok: true };
}

function validateR5IronChainInventory(snapshot = {}) {
  const compact = compactSnapshot(snapshot);
  if (compact.inventory.stonePickaxeCount < 4) {
    return { ok: false, reason: 'r5_iron_chain_no_stone_pickaxes' };
  }
  if (compact.inventory.craftingTableCount < 1) {
    return { ok: false, reason: 'r5_iron_chain_no_crafting_table' };
  }
  if (compact.inventory.furnaceCount < 1) {
    return { ok: false, reason: 'r5_iron_chain_no_furnace' };
  }
  if (compact.inventory.stickCount < 2) {
    return { ok: false, reason: 'r5_iron_chain_no_sticks' };
  }
  const fuelCount = compact.inventory.charcoalCount
    + compact.inventory.coalCount
    + compact.inventory.plankCount
    + compact.inventory.logCount;
  if (fuelCount < 3) {
    return { ok: false, reason: 'r5_iron_chain_no_fuel' };
  }
  if (compact.inventory.rawIronCount > 0
      || compact.inventory.ironIngotCount > 0
      || compact.inventory.ironPickaxeCount > 0) {
    return { ok: false, reason: 'r5_iron_chain_iron_inventory_not_empty' };
  }
  return { ok: true };
}

function directionForRequest(requestIndex, configuredDirections = null) {
  const directions = configuredDirections?.length ? configuredDirections : ['east', 'south', 'west', 'north'];
  return directions[(Math.max(1, requestIndex) - 1) % directions.length];
}

function parseDirectionSequence(value) {
  if (Array.isArray(value)) {
    const parsed = value.map((entry) => nonEmptyString(entry)?.toLowerCase()).filter((entry) => (
      entry && ['north', 'south', 'east', 'west'].includes(entry)
    ));
    return parsed.length ? parsed : null;
  }
  const text = nonEmptyString(value);
  if (!text) return null;
  const parsed = text.split(',')
    .map((entry) => nonEmptyString(entry)?.toLowerCase())
    .filter((entry) => entry && ['north', 'south', 'east', 'west'].includes(entry));
  return parsed.length ? parsed : null;
}

function publicResponseMetrics(metrics = {}) {
  return {
    provider: metrics.provider,
    model: metrics.model,
    latencyMs: metrics.latencyMs,
    promptTokens: metrics.promptTokens,
    completionTokens: metrics.completionTokens,
    totalTokens: metrics.totalTokens,
    callCostUsd: metrics.callCostUsd,
    sessionCostUsd: metrics.sessionCostUsd,
    costCeilingUsd: metrics.costCeilingUsd,
    costCeilingStatus: metrics.costCeilingStatus,
  };
}

function recordParseEvents(metrics, events) {
  const summary = summarizeParseEvents(events);
  if (summary.stage === 'strict') metrics.parse.firstTry += 1;
  if (summary.stage === 'repair') {
    metrics.parse.repaired += 1;
    metrics.parse.repairMethods[summary.repairMethod] = (metrics.parse.repairMethods[summary.repairMethod] || 0) + 1;
  }
  if (summary.stage === 'fail') metrics.parse.failed += 1;
  if (events.some((event) => event.stage === 'target_rejected')) metrics.parse.targetRejected += 1;
}

function summarizeParseEvents(events = [], intent = null) {
  const first = events.find((event) => ['strict', 'repair', 'fail'].includes(event.stage));
  const rejected = events.find((event) => event.stage === 'target_rejected');
  return {
    stage: first?.stage || 'unknown',
    repairMethod: first?.repairMethod || null,
    targetRejected: Boolean(rejected),
    failClosed: intent?.action === 'stop' && ['adapter_parse_error', 'adapter_no_valid_target'].includes(intent.reason),
  };
}

function logParseEvents(instanceId, requestIndex, commandId, events) {
  for (const event of events) {
    if (event.stage === 'repair') {
      console.warn(JSON.stringify({
        evt: 'fabric.deepseek.repair',
        instanceId,
        requestIndex,
        commandId,
        repairMethod: event.repairMethod,
      }));
    } else if (event.stage === 'target_rejected') {
      console.warn(JSON.stringify({
        evt: 'fabric.deepseek.target_rejected',
        instanceId,
        requestIndex,
        commandId,
        reason: event.reason,
      }));
    }
  }
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'unknown';
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function emitParseEvent(opts, event) {
  if (typeof opts.onParseEvent === 'function') opts.onParseEvent(event);
}

function markQuiet(intent) {
  Object.defineProperty(intent, '__quiet', { value: true, enumerable: false });
  return intent;
}

function isQuiet(intent) {
  return Boolean(intent?.__quiet);
}

function sanitizeError(err) {
  return String(err?.message || err || 'unknown').replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value) {
  const number = finiteNumberOrNull(value);
  return number === null ? null : Math.round(number * 1000) / 1000;
}

function finiteNumber(value, defaultValue) {
  const number = Number(value);
  return Number.isFinite(number) ? number : defaultValue;
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampNumber(value, min, max, defaultValue) {
  const number = finiteNumberOrNull(value);
  return number === null ? defaultValue : clamp(number, min, max);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function envFlag(value) {
  if (value === undefined || value === null || value === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

// Campaign-flipped defaults (2026-07 synthesis): unset means ON; only an explicit off value opts out.
function envFlagDefaultOn(value) {
  if (value === undefined || value === null || value === '') return true;
  return envFlag(value);
}
