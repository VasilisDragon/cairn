#!/usr/bin/env node

import http from 'node:http';

const BLOCK_TARGET_MAX_TIMEOUT_MS = 660000;
const port = Number(process.env.MCBOT_FABRIC_BRAIN_PORT || 8765);
const commands = new Map();
const completed = new Map();
const snapshots = new Map();

function parseBody(body) {
  const newline = body.indexOf('\n');
  if (newline < 0) throw new Error('missing first-line instance id');
  const firstLine = body.slice(0, newline).trim();
  const match = /^instanceId:(.+)$/.exec(firstLine);
  if (!match) throw new Error('first line must be instanceId:<id>');
  const jsonText = body.slice(newline + 1).trim() || '{}';
  return { instanceId: match[1], json: JSON.parse(jsonText) };
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error('request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function writeText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function distanceXZ(a, b) {
  const dx = Number(a.x) - Number(b.x);
  const dz = Number(a.z) - Number(b.z);
  return Math.sqrt(dx * dx + dz * dz);
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeYaw(yaw) {
  let normalized = Number(yaw) % 360;
  if (normalized >= 180) normalized -= 360;
  if (normalized < -180) normalized += 360;
  return normalized;
}

function shortestYawDelta(curYaw, targetYaw) {
  return normalizeYaw(normalizeYaw(targetYaw) - normalizeYaw(curYaw));
}

function lookError(snapshot, target) {
  return {
    yawError: shortestYawDelta(snapshot.yaw, target.yaw),
    pitchError: Number(target.pitch) - Number(snapshot.pitch),
  };
}

function completeCommand(instanceId, command, snapshot, extras = {}) {
  commands.delete(instanceId);
  const summary = {
    ...command,
    ...extras,
    status: 'complete',
    completedAtMs: Date.now(),
    endedAt: { x: snapshot.x, y: snapshot.y, z: snapshot.z, yaw: snapshot.yaw, pitch: snapshot.pitch },
  };
  completed.set(instanceId, summary);
  return summary;
}

function startCommandIfNeeded(instanceId, command, snapshot) {
  if (command.startedAt) {
    return;
  }
  command.startedAt = { x: snapshot.x, z: snapshot.z, yaw: snapshot.yaw, pitch: snapshot.pitch };
  command.startedAtMs = Date.now();
  command.status = 'running';
  console.log(
    `[brain] command ${command.id} started for ${instanceId} at x=${snapshot.x.toFixed(3)} z=${snapshot.z.toFixed(3)} yaw=${Number(snapshot.yaw).toFixed(2)} pitch=${Number(snapshot.pitch).toFixed(2)}`
  );
}

function walkIntent(instanceId, command, snapshot) {
  startCommandIfNeeded(instanceId, command, snapshot);
  const traveled = distanceXZ(command.startedAt, snapshot);
  const target = Number(command.blocks);
  command.lastSnapshot = snapshot;
  command.traveled = traveled;
  if (traveled >= target) {
    const summary = completeCommand(instanceId, command, snapshot, {
      distanceError: traveled - target,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; traveled=${traveled.toFixed(3)} target=${target}`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'target_reached',
      commandId: command.id,
      traveled: summary.traveled,
      target,
    };
  }

  return {
    action: 'walk_forward',
    forward: true,
    ttlMs: 250,
    reason: 'walking_to_target',
    commandId: command.id,
    traveled,
    target,
  };
}

function lookSequenceIntent(instanceId, command, snapshot) {
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  command.samples = command.samples || [];
  const step = command.steps[command.stepIndex];
  const error = lookError(snapshot, step);
  const absYawError = Math.abs(error.yawError);
  const absPitchError = Math.abs(error.pitchError);
  command.samples.push({
    stepIndex: command.stepIndex,
    commanded: { yaw: step.yaw, pitch: step.pitch },
    achieved: { yaw: snapshot.yaw, pitch: snapshot.pitch },
    yawError: error.yawError,
    pitchError: error.pitchError,
    capturedAtMs: snapshot.capturedAtMs,
  });
  if (command.samples.length > 160) {
    command.samples.shift();
  }

  if (absYawError <= command.toleranceDeg && absPitchError <= command.toleranceDeg) {
    const achieved = {
      stepIndex: command.stepIndex,
      commanded: { yaw: step.yaw, pitch: step.pitch },
      achieved: { yaw: snapshot.yaw, pitch: snapshot.pitch },
      yawError: error.yawError,
      pitchError: error.pitchError,
      capturedAtMs: snapshot.capturedAtMs,
    };
    command.achievedSteps.push(achieved);
    console.log(
      `[brain] command ${command.id} step ${command.stepIndex + 1}/${command.steps.length} achieved for ${instanceId}; yawError=${error.yawError.toFixed(2)} pitchError=${error.pitchError.toFixed(2)}`
    );
    command.stepIndex += 1;
    if (command.stepIndex >= command.steps.length) {
      completeCommand(instanceId, command, snapshot, {
        finalYawError: error.yawError,
        finalPitchError: error.pitchError,
      });
      console.log(`[brain] command ${command.id} complete for ${instanceId}; look steps=${command.steps.length}`);
      return {
        action: 'stop',
        forward: false,
        ttlMs: 250,
        reason: 'look_sequence_complete',
        commandId: command.id,
      };
    }
  }

  const nextStep = command.steps[command.stepIndex];
  return {
    action: 'look_at',
    ttlMs: 250,
    reason: 'looking_to_target',
    commandId: command.id,
    stepIndex: command.stepIndex,
    targetYaw: nextStep.yaw,
    targetPitch: nextStep.pitch,
  };
}

function navigatePointIntent(instanceId, command, snapshot) {
  if (command.setupCommands && command.setupCommands.length > 0 && !command.setupIssued) {
    command.setupIssued = true;
    command.setupIssuedAtMs = Date.now();
    command.lastSnapshot = snapshot;
    console.log(`[brain] command ${command.id} issuing setup commands for ${instanceId}; count=${command.setupCommands.length}`);
    return {
      action: 'setup_commands',
      forward: false,
      serverCommands: command.setupCommands,
      ttlMs: 250,
      reason: 'setup_commands',
      commandId: command.id,
    };
  }
  if (command.setupIssued && !command.setupSettled) {
    command.lastSnapshot = snapshot;
    const elapsedMs = Date.now() - command.setupIssuedAtMs;
    const waitingForGround = command.requireOnGroundAfterSetup && !snapshot.onGround;
    const waitingForSettle = elapsedMs < command.setupSettleMs;
    if (waitingForGround || waitingForSettle) {
      return {
        action: 'stop',
        forward: false,
        ttlMs: 250,
        reason: waitingForGround ? 'setup_wait_grounded' : 'setup_settle',
        commandId: command.id,
        setupElapsedMs: elapsedMs,
      };
    }
    command.setupSettled = true;
    command.setupSettledAtMs = Date.now();
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'setup_settle',
      commandId: command.id,
    };
  }

  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  const dx = Number(command.targetX) - Number(snapshot.x);
  const dz = Number(command.targetZ) - Number(snapshot.z);
  const distance = Math.sqrt(dx * dx + dz * dz);
  command.samples = command.samples || [];
  command.minDistance = command.minDistance == null ? distance : Math.min(command.minDistance, distance);
  if (command.lastDistance != null && distance - command.lastDistance > 0.35) {
    command.distanceIncreases = (command.distanceIncreases || 0) + 1;
  }
  command.lastDistance = distance;
  command.samples.push({
    x: snapshot.x,
    y: snapshot.y,
    z: snapshot.z,
    yaw: snapshot.yaw,
    pitch: snapshot.pitch,
    distance,
    inputForward: Boolean(snapshot.inputForward),
    inputBack: Boolean(snapshot.inputBack),
    inputLeft: Boolean(snapshot.inputLeft),
    inputRight: Boolean(snapshot.inputRight),
    inputJump: Boolean(snapshot.inputJump),
    inputSneak: Boolean(snapshot.inputSneak),
    movementForward: finiteOrNull(snapshot.movementForward) ?? 0,
    movementSideways: finiteOrNull(snapshot.movementSideways) ?? 0,
    navigationRouteComputed: Boolean(snapshot.navigationRouteComputed),
    navigationRouteLength: finiteOrNull(snapshot.navigationRouteLength) ?? 0,
    navigationWaypointIndex: finiteOrNull(snapshot.navigationWaypointIndex) ?? 0,
    navigationWaypointX: finiteOrNull(snapshot.navigationWaypointX),
    navigationWaypointZ: finiteOrNull(snapshot.navigationWaypointZ),
    navigationWaypointDistance: finiteOrNull(snapshot.navigationWaypointDistance),
    terrainProbe: snapshot.terrainProbe || null,
    activeNavigationCommandId: snapshot.activeNavigationCommandId || '',
    onGround: Boolean(snapshot.onGround),
    touchingWater: Boolean(snapshot.touchingWater),
    capturedAtMs: snapshot.capturedAtMs,
  });
  if (command.samples.length > 240) {
    command.samples.shift();
  }

  if (distance <= command.arriveEpsilon) {
    completeCommand(instanceId, command, snapshot, {
      finalDistance: distance,
      minDistance: command.minDistance,
      distanceIncreases: command.distanceIncreases || 0,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; finalDistance=${distance.toFixed(3)} target=(${command.targetX},${command.targetZ})`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'navigation_arrived',
      commandId: command.id,
      distance,
    };
  }

  return {
    action: 'navigate_to_point',
    targetX: command.targetX,
    targetZ: command.targetZ,
    arriveEpsilon: command.arriveEpsilon,
    waypoints: command.waypoints,
    blockedCells: command.blockedCells,
    serverCommands: command.setupCommands,
    ttlMs: 250,
    reason: 'navigating_to_point',
    commandId: command.id,
    distance,
  };
}

function nav3dDriveTestIntent(instanceId, command, snapshot) {
  if (command.setupCommands && command.setupCommands.length > 0 && !command.setupIssued) {
    command.setupIssued = true;
    command.setupIssuedAtMs = Date.now();
    command.lastSnapshot = snapshot;
    console.log(`[brain] command ${command.id} issuing setup commands for ${instanceId}; count=${command.setupCommands.length}`);
    return { action: 'setup_commands', forward: false, serverCommands: command.setupCommands, ttlMs: 250, reason: 'setup_commands', commandId: command.id };
  }
  if (command.setupIssued && !command.setupSettled) {
    command.lastSnapshot = snapshot;
    const elapsedMs = Date.now() - command.setupIssuedAtMs;
    const waitingForGround = command.requireOnGroundAfterSetup && !snapshot.onGround;
    const waitingForSettle = elapsedMs < command.setupSettleMs;
    if (waitingForGround || waitingForSettle) {
      return { action: 'stop', forward: false, ttlMs: 250, reason: waitingForGround ? 'setup_wait_grounded' : 'setup_settle', commandId: command.id, setupElapsedMs: elapsedMs };
    }
    command.setupSettled = true;
    command.setupSettledAtMs = Date.now();
    return { action: 'stop', forward: false, ttlMs: 250, reason: 'setup_settle', commandId: command.id };
  }
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  // Capture the ABSOLUTE target once at drive-start from the bot's REAL position + the offset (targetX/Y/Z are
  // offsets). This avoids the stale-snapshot bug: the staged wall is built relative to the bot at the same time.
  if (command.absTargetX == null) {
    command.absTargetX = Math.floor(Number(snapshot.x)) + Number(command.targetX);
    command.absTargetY = Math.floor(Number(snapshot.y)) + Number(command.targetY);
    command.absTargetZ = Math.floor(Number(snapshot.z)) + Number(command.targetZ);
    console.log(`[brain] command ${command.id} nav3d_drive_test absTarget=(${command.absTargetX},${command.absTargetY},${command.absTargetZ}) bot=(${Number(snapshot.x).toFixed(2)},${Number(snapshot.y).toFixed(2)},${Number(snapshot.z).toFixed(2)}) offset=(${command.targetX},${command.targetY},${command.targetZ})`);
  }
  const dx = command.absTargetX - Number(snapshot.x);
  const dy = command.absTargetY - Number(snapshot.y);
  const dz = command.absTargetZ - Number(snapshot.z);
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  command.minDistance = command.minDistance == null ? distance : Math.min(command.minDistance, distance);
  command.lastDistance = distance;
  if (distance <= command.arriveEpsilon) {
    completeCommand(instanceId, command, snapshot, { finalDistance: distance, minDistance: command.minDistance });
    console.log(`[brain] command ${command.id} nav3d_drive_test COMPLETE for ${instanceId}; finalDistance=${distance.toFixed(3)} target=(${command.absTargetX},${command.absTargetY},${command.absTargetZ})`);
    return { action: 'stop', forward: false, ttlMs: 250, reason: 'nav3d_test_arrived', commandId: command.id, distance };
  }
  return {
    action: 'nav3d_drive_test',
    targetX: command.absTargetX,
    targetY: command.absTargetY,
    targetZ: command.absTargetZ,
    ttlMs: 250,
    reason: 'nav3d_driving_to_point',
    commandId: command.id,
    distance,
  };
}

function probeNavigationIntent(instanceId, command, snapshot) {
  if (command.setupCommands && command.setupCommands.length > 0 && !command.setupIssued) {
    command.setupIssued = true;
    command.setupIssuedAtMs = Date.now();
    command.lastSnapshot = snapshot;
    console.log(`[brain] command ${command.id} issuing setup commands for ${instanceId}; count=${command.setupCommands.length}`);
    return {
      action: 'setup_commands',
      forward: false,
      serverCommands: command.setupCommands,
      ttlMs: 250,
      reason: 'setup_commands',
      commandId: command.id,
    };
  }
  if (command.setupIssued && !command.setupSettled) {
    command.lastSnapshot = snapshot;
    const elapsedMs = Date.now() - command.setupIssuedAtMs;
    const waitingForGround = command.requireOnGroundAfterSetup && !snapshot.onGround;
    const waitingForSettle = elapsedMs < command.setupSettleMs;
    if (waitingForGround || waitingForSettle) {
      return {
        action: 'stop',
        forward: false,
        ttlMs: 250,
        reason: waitingForGround ? 'setup_wait_grounded' : 'setup_settle',
        commandId: command.id,
        setupElapsedMs: elapsedMs,
      };
    }
    command.setupSettled = true;
    command.setupSettledAtMs = Date.now();
  }

  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  if (!command.probeIssued) {
    command.probeIssued = true;
    command.probeIssuedAtMs = Date.now();
    return {
      action: 'probe_navigation',
      targetX: command.targetX,
      targetZ: command.targetZ,
      arriveEpsilon: command.arriveEpsilon,
      ttlMs: 250,
      reason: 'probing_navigation',
      commandId: command.id,
    };
  }

  if (Date.now() - command.probeIssuedAtMs >= 500) {
    completeCommand(instanceId, command, snapshot, {
      probeIssued: true,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'probe_complete',
      commandId: command.id,
    };
  }

  return {
    action: 'stop',
    forward: false,
    ttlMs: 250,
    reason: 'probe_wait',
    commandId: command.id,
  };
}

function setupThenWait(command, snapshot) {
  if (command.setupCommands && command.setupCommands.length > 0 && !command.setupIssued) {
    command.setupIssued = true;
    command.setupIssuedAtMs = Date.now();
    command.lastSnapshot = snapshot;
    return {
      action: 'setup_commands',
      forward: false,
      serverCommands: command.setupCommands,
      ttlMs: 250,
      reason: 'setup_commands',
      commandId: command.id,
    };
  }
  if (command.setupIssued && !command.setupSettled) {
    command.lastSnapshot = snapshot;
    const elapsedMs = Date.now() - command.setupIssuedAtMs;
    if (elapsedMs < command.setupSettleMs || (command.requireOnGroundAfterSetup && !snapshot.onGround)) {
      return {
        action: 'stop',
        forward: false,
        ttlMs: 250,
        reason: command.requireOnGroundAfterSetup && !snapshot.onGround ? 'setup_wait_grounded' : 'setup_settle',
        commandId: command.id,
      };
    }
    command.setupSettled = true;
  }
  return null;
}

function targetVisibleInLogs(snapshot, command) {
  const logs = Array.isArray(snapshot.nearbyLogs) ? snapshot.nearbyLogs : [];
  return logs.some((log) => (
    Math.floor(Number(log.x)) === command.targetX
      && Math.floor(Number(log.y)) === command.targetY
      && Math.floor(Number(log.z)) === command.targetZ
  ));
}

function breakKnownBlockIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  if (!targetVisibleInLogs(snapshot, command)) {
    const summary = completeCommand(instanceId, command, snapshot, {
      targetGone: true,
      inventoryLogCount: finiteOrNull(snapshot.inventoryLogCount) ?? 0,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; targetGone=${summary.targetGone}`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'break_target_gone',
      commandId: command.id,
    };
  }
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, { timedOut: true });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'break_known_block_timeout',
      commandId: command.id,
    };
  }
  return {
    action: 'break_block',
    targetX: command.targetX,
    targetY: command.targetY,
    targetZ: command.targetZ,
    ttlMs: command.ttlMs,
    reason: 'break_known_block',
    commandId: command.id,
  };
}

function gatherLogFixedIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  if (command.baselineLogCount == null) {
    command.baselineLogCount = finiteOrNull(snapshot.inventoryLogCount) ?? 0;
  }
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  const currentLogs = finiteOrNull(snapshot.inventoryLogCount) ?? 0;
  if (currentLogs > command.baselineLogCount) {
    const summary = completeCommand(instanceId, command, snapshot, {
      inventoryLogsBefore: command.baselineLogCount,
      inventoryLogsAfter: currentLogs,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; logs=${summary.inventoryLogsAfter}`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'gather_log_complete',
      commandId: command.id,
    };
  }
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      inventoryLogsBefore: command.baselineLogCount,
      inventoryLogsAfter: currentLogs,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'gather_log_timeout',
      commandId: command.id,
    };
  }
  return {
    action: 'gather_log',
    targetX: command.targetX,
    targetY: command.targetY,
    targetZ: command.targetZ,
    ttlMs: command.ttlMs,
    reason: 'gather_log_fixed',
    commandId: command.id,
  };
}

function gatherTreeFixedIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  if (command.baselineLogCount == null) {
    command.baselineLogCount = finiteOrNull(snapshot.inventoryLogCount) ?? 0;
  }
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  const currentLogs = finiteOrNull(snapshot.inventoryLogCount) ?? 0;
  const minLogs = command.minLogs ?? 4;
  if (currentLogs >= command.baselineLogCount + minLogs) {
    const summary = completeCommand(instanceId, command, snapshot, {
      inventoryLogsBefore: command.baselineLogCount,
      inventoryLogsAfter: currentLogs,
      minLogs,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; logs=${summary.inventoryLogsAfter}`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'gather_tree_complete',
      commandId: command.id,
    };
  }
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      inventoryLogsBefore: command.baselineLogCount,
      inventoryLogsAfter: currentLogs,
      minLogs,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'gather_tree_timeout',
      commandId: command.id,
    };
  }
  return {
    action: 'gather_tree',
    targetX: command.targetX,
    targetY: command.targetY,
    targetZ: command.targetZ,
    ttlMs: command.ttlMs,
    reason: 'gather_tree_fixed',
    commandId: command.id,
  };
}

// CP2 beds slice 1: issue hunt_sheep and let the CLIENT complete it (wool-delta / timeout / no
// targets — finishedHuntSheepCommandReasons feeds currentCommandCompletionReason); the stub just
// reissues the same commandId until then, mirroring the other client-completed fixtures.
function huntSheepFixedIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  const clientReason = snapshot?.currentCommandCompleted === true
    && typeof snapshot?.currentCommandCompletionReason === 'string'
    && snapshot.currentCommandCompletionReason.startsWith('hunt_sheep_')
    ? snapshot.currentCommandCompletionReason
    : null;
  if (clientReason) {
    completeCommand(instanceId, command, snapshot, { reason: clientReason });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: clientReason,
      commandId: command.id,
    };
  }
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, { timedOut: true });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'hunt_sheep_timeout',
      commandId: command.id,
    };
  }
  return {
    action: 'hunt_sheep',
    ttlMs: command.ttlMs,
    reason: 'hunt_sheep_fixed',
    commandId: command.id,
  };
}

// CP2 slice 2: issue use_bed (setup gives the bed) and let the CLIENT complete it; same
// client-completed shape as hunt_sheep_fixed.
function useBedFixedIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  const clientReason = snapshot?.currentCommandCompleted === true
    && typeof snapshot?.currentCommandCompletionReason === 'string'
    && snapshot.currentCommandCompletionReason.startsWith('use_bed_')
    ? snapshot.currentCommandCompletionReason
    : null;
  if (clientReason) {
    completeCommand(instanceId, command, snapshot, { reason: clientReason });
    return { action: 'stop', forward: false, ttlMs: 250, reason: clientReason, commandId: command.id };
  }
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, { timedOut: true });
    return { action: 'stop', forward: false, ttlMs: 250, reason: 'use_bed_timeout', commandId: command.id };
  }
  return { action: 'use_bed', ttlMs: command.ttlMs, reason: 'use_bed_fixed', commandId: command.id };
}

function craft2x2FixedIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  if (command.baseline == null) {
    command.baseline = craftCounts(snapshot);
  }
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  const current = craftCounts(snapshot);
  if (craftDeltaComplete(command.action, command.baseline, current)) {
    const summary = completeCommand(instanceId, command, snapshot, {
      inventoryLogsBefore: command.baseline.logs,
      inventoryLogsAfter: current.logs,
      inventoryPlanksBefore: command.baseline.planks,
      inventoryPlanksAfter: current.planks,
      inventorySticksBefore: command.baseline.sticks,
      inventorySticksAfter: current.sticks,
      inventoryTablesBefore: command.baseline.tables,
      inventoryTablesAfter: current.tables,
      inventoryWoodenPickaxesBefore: command.baseline.woodenPickaxes,
      inventoryWoodenPickaxesAfter: current.woodenPickaxes,
      inventoryCobblestoneBefore: command.baseline.cobblestone,
      inventoryCobblestoneAfter: current.cobblestone,
      inventoryStonePickaxesBefore: command.baseline.stonePickaxes,
      inventoryStonePickaxesAfter: current.stonePickaxes,
      inventoryStoneAxesBefore: command.baseline.stoneAxes,
      inventoryStoneAxesAfter: current.stoneAxes,
      inventoryStoneSwordsBefore: command.baseline.stoneSwords,
      inventoryStoneSwordsAfter: current.stoneSwords,
      inventoryIronIngotsBefore: command.baseline.ironIngots,
      inventoryIronIngotsAfter: current.ironIngots,
      inventoryIronPickaxesBefore: command.baseline.ironPickaxes,
      inventoryIronPickaxesAfter: current.ironPickaxes,
      inventoryDiamondsBefore: command.baseline.diamonds,
      inventoryDiamondsAfter: current.diamonds,
      inventoryDiamondPickaxesBefore: command.baseline.diamondPickaxes,
      inventoryDiamondPickaxesAfter: current.diamondPickaxes,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; action=${command.action}`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: `${command.action}_complete`,
      commandId: command.id,
    };
  }
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      inventoryLogsBefore: command.baseline.logs,
      inventoryLogsAfter: current.logs,
      inventoryPlanksBefore: command.baseline.planks,
      inventoryPlanksAfter: current.planks,
      inventorySticksBefore: command.baseline.sticks,
      inventorySticksAfter: current.sticks,
      inventoryTablesBefore: command.baseline.tables,
      inventoryTablesAfter: current.tables,
      inventoryWoodenPickaxesBefore: command.baseline.woodenPickaxes,
      inventoryWoodenPickaxesAfter: current.woodenPickaxes,
      inventoryCobblestoneBefore: command.baseline.cobblestone,
      inventoryCobblestoneAfter: current.cobblestone,
      inventoryStonePickaxesBefore: command.baseline.stonePickaxes,
      inventoryStonePickaxesAfter: current.stonePickaxes,
      inventoryStoneAxesBefore: command.baseline.stoneAxes,
      inventoryStoneAxesAfter: current.stoneAxes,
      inventoryStoneSwordsBefore: command.baseline.stoneSwords,
      inventoryStoneSwordsAfter: current.stoneSwords,
      inventoryIronIngotsBefore: command.baseline.ironIngots,
      inventoryIronIngotsAfter: current.ironIngots,
      inventoryIronPickaxesBefore: command.baseline.ironPickaxes,
      inventoryIronPickaxesAfter: current.ironPickaxes,
      inventoryDiamondsBefore: command.baseline.diamonds,
      inventoryDiamondsAfter: current.diamonds,
      inventoryDiamondPickaxesBefore: command.baseline.diamondPickaxes,
      inventoryDiamondPickaxesAfter: current.diamondPickaxes,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: `${command.action}_timeout`,
      commandId: command.id,
    };
  }
  return {
    action: command.action,
    ttlMs: command.ttlMs,
    reason: `${command.action}_fixed`,
    commandId: command.id,
  };
}

function craftPickaxeRetrieveFixedIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  if (command.baseline == null) {
    command.baseline = craftCounts(snapshot);
  }
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  const current = craftCounts(snapshot);
  if (command.phase === 'retrieve') {
    if (current.tables - command.retrieveBaselineTables >= 1) {
      const summary = completeCommand(instanceId, command, snapshot, {
        inventoryPlanksBefore: command.baseline.planks,
        inventoryPlanksAfter: current.planks,
        inventorySticksBefore: command.baseline.sticks,
        inventorySticksAfter: current.sticks,
        inventoryWoodenPickaxesBefore: command.baseline.woodenPickaxes,
        inventoryWoodenPickaxesAfter: current.woodenPickaxes,
        inventoryTablesBefore: command.retrieveBaselineTables,
        inventoryTablesAfter: current.tables,
      });
      console.log(`[brain] command ${command.id} complete for ${instanceId}; action=craft_pickaxe_retrieve tables=${summary.inventoryTablesAfter}`);
      return {
        action: 'stop',
        forward: false,
        ttlMs: 250,
        reason: 'craft_pickaxe_retrieve_complete',
        commandId: command.id,
      };
    }
    if (Date.now() - command.retrieveStartedAtMs > command.timeoutMs) {
      completeCommand(instanceId, command, snapshot, {
        timedOut: true,
        inventoryTablesBefore: command.retrieveBaselineTables,
        inventoryTablesAfter: current.tables,
      });
      return {
        action: 'stop',
        forward: false,
        ttlMs: 250,
        reason: 'retrieve_table_timeout',
        commandId: command.id,
      };
    }
    return {
      action: 'retrieve_table',
      ttlMs: command.ttlMs,
      reason: 'retrieve_table_after_pickaxe',
      commandId: `${command.id}:retrieve`,
    };
  }
  if (craftDeltaComplete('craft_pickaxe', command.baseline, current)) {
    command.phase = 'retrieve';
    command.retrieveBaselineTables = current.tables;
    command.retrieveStartedAtMs = Date.now();
    console.log(`[brain] command ${command.id} switching to retrieve for ${instanceId}; tables=${current.tables}`);
    return {
      action: 'retrieve_table',
      ttlMs: command.ttlMs,
      reason: 'retrieve_table_after_pickaxe',
      commandId: `${command.id}:retrieve`,
    };
  }
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      inventoryPlanksBefore: command.baseline.planks,
      inventoryPlanksAfter: current.planks,
      inventorySticksBefore: command.baseline.sticks,
      inventorySticksAfter: current.sticks,
      inventoryWoodenPickaxesBefore: command.baseline.woodenPickaxes,
      inventoryWoodenPickaxesAfter: current.woodenPickaxes,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'craft_pickaxe_timeout',
      commandId: command.id,
    };
  }
  return {
    action: 'craft_pickaxe',
    ttlMs: command.ttlMs,
    reason: 'craft_pickaxe_fixed',
    commandId: command.id,
  };
}

function craftCounts(snapshot) {
  return {
    logs: finiteOrNull(snapshot.inventoryLogCount) ?? 0,
    planks: finiteOrNull(snapshot.inventoryPlankCount) ?? 0,
    sticks: finiteOrNull(snapshot.inventoryStickCount) ?? 0,
    tables: finiteOrNull(snapshot.inventoryCraftingTableCount) ?? 0,
    woodenPickaxes: finiteOrNull(snapshot.inventoryWoodenPickaxeCount) ?? 0,
    cobblestone: finiteOrNull(snapshot.inventoryCobblestoneCount) ?? 0,
    stonePickaxes: finiteOrNull(snapshot.inventoryStonePickaxeCount) ?? 0,
    stoneAxes: finiteOrNull(snapshot.inventoryStoneAxeCount) ?? 0,
    stoneSwords: finiteOrNull(snapshot.inventoryStoneSwordCount) ?? 0,
    furnaces: finiteOrNull(snapshot.inventoryFurnaceCount) ?? 0,
    charcoal: finiteOrNull(snapshot.inventoryCharcoalCount) ?? 0,
    coal: finiteOrNull(snapshot.inventoryCoalCount) ?? 0,
    rawIron: finiteOrNull(snapshot.inventoryRawIronCount) ?? 0,
    ironIngots: finiteOrNull(snapshot.inventoryIronIngotCount) ?? 0,
    ironPickaxes: finiteOrNull(snapshot.inventoryIronPickaxeCount) ?? 0,
    diamonds: finiteOrNull(snapshot.inventoryDiamondCount) ?? 0,
    diamondPickaxes: finiteOrNull(snapshot.inventoryDiamondPickaxeCount) ?? 0,
    ironHelmets: finiteOrNull(snapshot.inventoryIronHelmetCount) ?? 0,
    ironChestplates: finiteOrNull(snapshot.inventoryIronChestplateCount) ?? 0,
    ironLeggings: finiteOrNull(snapshot.inventoryIronLeggingsCount) ?? 0,
    ironBoots: finiteOrNull(snapshot.inventoryIronBootsCount) ?? 0,
  };
}

function craftDeltaComplete(action, before, after) {
  if (action === 'craft_planks') {
    return before.logs - after.logs >= 1 && after.planks - before.planks >= 4;
  }
  if (action === 'craft_sticks') {
    return before.planks - after.planks >= 2 && after.sticks - before.sticks >= 4;
  }
  if (action === 'craft_table') {
    return before.planks - after.planks >= 4 && after.tables - before.tables >= 1;
  }
  if (action === 'craft_pickaxe') {
    return before.planks - after.planks >= 3
      && before.sticks - after.sticks >= 2
      && after.woodenPickaxes - before.woodenPickaxes >= 1;
  }
  if (action === 'craft_stone_pickaxe') {
    return before.cobblestone - after.cobblestone >= 3
      && before.sticks - after.sticks >= 2
      && after.stonePickaxes - before.stonePickaxes >= 1;
  }
  if (action === 'craft_iron_pickaxe') {
    return before.ironIngots - after.ironIngots >= 3
      && before.sticks - after.sticks >= 2
      && after.ironPickaxes - before.ironPickaxes >= 1;
  }
  if (action === 'craft_diamond_pickaxe') {
    return before.diamonds - after.diamonds >= 3
      && before.sticks - after.sticks >= 2
      && after.diamondPickaxes - before.diamondPickaxes >= 1;
  }
  if (action === 'craft_stone_axe') {
    return before.cobblestone - after.cobblestone >= 3
      && before.sticks - after.sticks >= 2
      && after.stoneAxes - before.stoneAxes >= 1;
  }
  if (action === 'craft_stone_sword') {
    return before.cobblestone - after.cobblestone >= 2
      && before.sticks - after.sticks >= 1
      && after.stoneSwords - before.stoneSwords >= 1;
  }
  if (action === 'craft_furnace') {
    return before.cobblestone - after.cobblestone >= 8
      && after.furnaces - before.furnaces >= 1;
  }
  if (action === 'craft_iron_helmet') {
    return before.ironIngots - after.ironIngots >= 5
      && after.ironHelmets - before.ironHelmets >= 1;
  }
  if (action === 'craft_iron_chestplate') {
    return before.ironIngots - after.ironIngots >= 8
      && after.ironChestplates - before.ironChestplates >= 1;
  }
  if (action === 'craft_iron_leggings') {
    return before.ironIngots - after.ironIngots >= 7
      && after.ironLeggings - before.ironLeggings >= 1;
  }
  if (action === 'craft_iron_boots') {
    return before.ironIngots - after.ironIngots >= 4
      && after.ironBoots - before.ironBoots >= 1;
  }
  return false;
}

function placeTableFixedIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  if (command.baselineTables == null) {
    command.baselineTables = finiteOrNull(snapshot.inventoryCraftingTableCount) ?? 0;
  }
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  const currentTables = finiteOrNull(snapshot.inventoryCraftingTableCount) ?? 0;
  if (command.baselineTables - currentTables >= 1) {
    const summary = completeCommand(instanceId, command, snapshot, {
      inventoryTablesBefore: command.baselineTables,
      inventoryTablesAfter: currentTables,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; tables=${summary.inventoryTablesAfter}`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'place_table_complete',
      commandId: command.id,
    };
  }
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      inventoryTablesBefore: command.baselineTables,
      inventoryTablesAfter: currentTables,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'place_table_timeout',
      commandId: command.id,
    };
  }
  return {
    action: 'place_table',
    ttlMs: command.ttlMs,
    reason: 'place_table_fixed',
    commandId: command.id,
  };
}

function placeFurnaceFixedIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  if (command.baselineFurnaces == null) {
    command.baselineFurnaces = finiteOrNull(snapshot.inventoryFurnaceCount) ?? 0;
  }
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  const currentFurnaces = finiteOrNull(snapshot.inventoryFurnaceCount) ?? 0;
  if (command.baselineFurnaces - currentFurnaces >= 1) {
    const summary = completeCommand(instanceId, command, snapshot, {
      inventoryFurnacesBefore: command.baselineFurnaces,
      inventoryFurnacesAfter: currentFurnaces,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; furnaces=${summary.inventoryFurnacesAfter}`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'place_furnace_complete',
      commandId: command.id,
    };
  }
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      inventoryFurnacesBefore: command.baselineFurnaces,
      inventoryFurnacesAfter: currentFurnaces,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'place_furnace_timeout',
      commandId: command.id,
    };
  }
  return {
    action: 'place_furnace',
    ttlMs: command.ttlMs,
    reason: 'place_furnace_fixed',
    commandId: command.id,
  };
}

function smeltCharcoalFixedIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  if (command.baseline == null) {
    command.baseline = craftCounts(snapshot);
  }
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  const current = craftCounts(snapshot);
  if (current.charcoal - command.baseline.charcoal >= 1) {
    const summary = completeCommand(instanceId, command, snapshot, {
      inventoryLogsBefore: command.baseline.logs,
      inventoryLogsAfter: current.logs,
      inventoryPlanksBefore: command.baseline.planks,
      inventoryPlanksAfter: current.planks,
      inventoryCharcoalBefore: command.baseline.charcoal,
      inventoryCharcoalAfter: current.charcoal,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; charcoal=${summary.inventoryCharcoalAfter}`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'smelt_charcoal_complete',
      commandId: command.id,
    };
  }
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      inventoryLogsBefore: command.baseline.logs,
      inventoryLogsAfter: current.logs,
      inventoryPlanksBefore: command.baseline.planks,
      inventoryPlanksAfter: current.planks,
      inventoryCharcoalBefore: command.baseline.charcoal,
      inventoryCharcoalAfter: current.charcoal,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'smelt_charcoal_timeout',
      commandId: command.id,
    };
  }
  return {
    action: 'smelt_charcoal',
    ttlMs: command.ttlMs,
    reason: 'smelt_charcoal_fixed',
    commandId: command.id,
  };
}

function makeCharcoalFixedIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  if (command.baseline == null) {
    command.baseline = craftCounts(snapshot);
  }
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  const current = craftCounts(snapshot);
  if (current.charcoal - command.baseline.charcoal >= 1) {
    const summary = completeCommand(instanceId, command, snapshot, {
      inventoryCobblestoneBefore: command.baseline.cobblestone,
      inventoryCobblestoneAfter: current.cobblestone,
      inventoryLogsBefore: command.baseline.logs,
      inventoryLogsAfter: current.logs,
      inventoryPlanksBefore: command.baseline.planks,
      inventoryPlanksAfter: current.planks,
      inventoryFurnacesBefore: command.baseline.furnaces,
      inventoryFurnacesAfter: current.furnaces,
      inventoryCharcoalBefore: command.baseline.charcoal,
      inventoryCharcoalAfter: current.charcoal,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; make_charcoal charcoal=${summary.inventoryCharcoalAfter}`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'make_charcoal_complete',
      commandId: command.id,
    };
  }
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      inventoryCobblestoneBefore: command.baseline.cobblestone,
      inventoryCobblestoneAfter: current.cobblestone,
      inventoryLogsBefore: command.baseline.logs,
      inventoryLogsAfter: current.logs,
      inventoryPlanksBefore: command.baseline.planks,
      inventoryPlanksAfter: current.planks,
      inventoryFurnacesBefore: command.baseline.furnaces,
      inventoryFurnacesAfter: current.furnaces,
      inventoryCharcoalBefore: command.baseline.charcoal,
      inventoryCharcoalAfter: current.charcoal,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'make_charcoal_timeout',
      commandId: command.id,
    };
  }
  return {
    action: 'make_charcoal',
    ttlMs: command.ttlMs,
    reason: 'make_charcoal_fixed',
    commandId: command.id,
  };
}

function mineStoneFixedIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  if (command.baselineCobblestone == null) {
    command.baselineCobblestone = finiteOrNull(snapshot.inventoryCobblestoneCount) ?? 0;
  }
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  const currentCobblestone = finiteOrNull(snapshot.inventoryCobblestoneCount) ?? 0;
  if (currentCobblestone > command.baselineCobblestone) {
    const summary = completeCommand(instanceId, command, snapshot, {
      inventoryCobblestoneBefore: command.baselineCobblestone,
      inventoryCobblestoneAfter: currentCobblestone,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; cobblestone=${summary.inventoryCobblestoneAfter}`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'mine_stone_complete',
      commandId: command.id,
    };
  }
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      inventoryCobblestoneBefore: command.baselineCobblestone,
      inventoryCobblestoneAfter: currentCobblestone,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'mine_stone_timeout',
      commandId: command.id,
    };
  }
  return {
    action: 'mine_stone',
    targetX: command.targetX,
    targetY: command.targetY,
    targetZ: command.targetZ,
    ttlMs: command.ttlMs,
    reason: 'mine_stone_fixed',
    commandId: command.id,
  };
}

function descendStaircaseFixedIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  const target = { x: command.targetX + 0.5, z: command.targetZ + 0.5 };
  const distance = distanceXZ(snapshot, target);
  const currentY = Math.floor(Number(snapshot.y));
  if (snapshot.onGround && currentY <= command.targetY && distance <= 0.8) {
    const summary = completeCommand(instanceId, command, snapshot, {
      targetY: command.targetY,
      finalY: currentY,
      distanceToTarget: distance,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; finalY=${summary.finalY} targetY=${summary.targetY}`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'descend_staircase_complete',
      commandId: command.id,
    };
  }
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      targetY: command.targetY,
      finalY: currentY,
      distanceToTarget: distance,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'descend_staircase_timeout',
      commandId: command.id,
    };
  }
  return {
    action: 'descend_staircase',
    targetX: command.targetX,
    targetY: command.targetY,
    targetZ: command.targetZ,
    ttlMs: command.ttlMs,
    reason: 'descend_staircase_fixed',
    commandId: command.id,
  };
}

function r2MineStoneReturnIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  if (command.baselineCobblestone == null) {
    command.baselineCobblestone = finiteOrNull(snapshot.inventoryCobblestoneCount) ?? 0;
  }
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;

  const currentCobblestone = finiteOrNull(snapshot.inventoryCobblestoneCount) ?? 0;
  const cobbleDelta = currentCobblestone - command.baselineCobblestone;
  const bottomTarget = { x: command.targetX + 0.5, z: command.targetZ + 0.5 };
  const bottomDistance = distanceXZ(snapshot, bottomTarget);
  const currentY = Math.floor(Number(snapshot.y));

  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      phase: command.phase || 'descend',
      inventoryCobblestoneBefore: command.baselineCobblestone,
      inventoryCobblestoneAfter: currentCobblestone,
      cobbleDelta,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'r2_mine_stone_return_timeout',
      commandId: command.id,
    };
  }

  if (!command.phase) command.phase = 'descend';
  if (command.phase === 'descend' && snapshot.onGround && currentY <= command.targetY && bottomDistance <= 0.8) {
    command.phase = 'mine';
    command.reachedBottomAtMs = Date.now();
    console.log(`[brain] command ${command.id} phase=mine for ${instanceId}; y=${currentY} cobbleDelta=${cobbleDelta}`);
  }
  const completionReason = typeof snapshot.currentCommandCompletionReason === 'string'
    ? snapshot.currentCommandCompletionReason
    : '';
  const mineActionComplete = snapshot.currentCommandCompleted === true
    && completionReason.startsWith('mine_nearby_stone_complete:');
  if (command.phase === 'mine' && (mineActionComplete || cobbleDelta >= command.requiredCobblestone)) {
    command.phase = 'return';
    command.mineCompleteAtMs = Date.now();
    console.log(`[brain] command ${command.id} phase=return for ${instanceId}; cobbleDelta=${cobbleDelta} reason=${mineActionComplete ? completionReason : 'required_cobblestone'}`);
  }

  const surfaceTarget = { x: command.startX + 0.5, z: command.startZ + 0.5 };
  const surfaceDistance = distanceXZ(snapshot, surfaceTarget);
  if (command.phase === 'return' && snapshot.onGround && currentY >= command.startY && surfaceDistance <= 0.9) {
    const summary = completeCommand(instanceId, command, snapshot, {
      inventoryCobblestoneBefore: command.baselineCobblestone,
      inventoryCobblestoneAfter: currentCobblestone,
      cobbleDelta,
      finalY: currentY,
      distanceToSurface: surfaceDistance,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; cobbleDelta=${summary.cobbleDelta} finalY=${summary.finalY}`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'r2_mine_stone_return_complete',
      commandId: command.id,
    };
  }

  if (command.phase === 'mine') {
    return {
      action: 'mine_nearby_stone',
      ttlMs: command.ttlMs,
      reason: 'r2_mine_nearby_stone',
      commandId: command.id,
    };
  }
  if (command.phase === 'return') {
    return {
      action: 'return_staircase',
      targetX: command.startX,
      targetY: command.startY,
      targetZ: command.startZ,
      ttlMs: command.ttlMs,
      reason: 'r2_return_staircase',
      commandId: command.id,
    };
  }
  return {
    action: 'descend_staircase',
    targetX: command.targetX,
    targetY: command.targetY,
    targetZ: command.targetZ,
    ttlMs: command.ttlMs,
    reason: 'r2_descend_staircase',
    commandId: command.id,
  };
}

function r5DescendMineIronIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  if (command.baselineRawIron == null) {
    command.baselineRawIron = finiteOrNull(snapshot.inventoryRawIronCount) ?? 0;
  }
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;

  const currentRawIron = finiteOrNull(snapshot.inventoryRawIronCount) ?? 0;
  const rawIronDelta = currentRawIron - command.baselineRawIron;
  const bottomTarget = { x: command.targetX + 0.5, z: command.targetZ + 0.5 };
  const bottomDistance = distanceXZ(snapshot, bottomTarget);
  const currentY = Math.floor(Number(snapshot.y));

  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      phase: command.phase || 'descend',
      inventoryRawIronBefore: command.baselineRawIron,
      inventoryRawIronAfter: currentRawIron,
      rawIronDelta,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'r5_descend_mine_iron_timeout',
      commandId: command.id,
    };
  }

  if (!command.phase) command.phase = 'descend';
  if (command.phase === 'descend' && snapshot.onGround && currentY <= command.targetY) {
    command.phase = 'mine';
    command.mineStartedAtMs = Date.now();
    console.log(`[brain] command ${command.id} phase=mine_iron for ${instanceId}; y=${currentY} distanceToOriginalTarget=${bottomDistance.toFixed(3)} rawIronDelta=${rawIronDelta}`);
  }
  if (command.phase === 'mine' && rawIronDelta >= command.requiredRawIron) {
    const summary = completeCommand(instanceId, command, snapshot, {
      inventoryRawIronBefore: command.baselineRawIron,
      inventoryRawIronAfter: currentRawIron,
      rawIronDelta,
      finalY: currentY,
      distanceToBottom: bottomDistance,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; rawIronDelta=${summary.rawIronDelta} finalY=${summary.finalY}`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'r5_descend_mine_iron_complete',
      commandId: command.id,
    };
  }
  if (command.phase === 'mine' && Date.now() - command.mineStartedAtMs > command.mineTimeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      phase: 'mine',
      inventoryRawIronBefore: command.baselineRawIron,
      inventoryRawIronAfter: currentRawIron,
      rawIronDelta,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'r5_mine_iron_timeout',
      commandId: command.id,
    };
  }

  if (command.phase === 'mine') {
    return {
      action: 'mine_nearby_iron',
      targetX: command.targetX,
      targetY: command.targetY,
      targetZ: command.targetZ,
      ttlMs: command.ttlMs,
      reason: 'r5_mine_nearby_iron',
      commandId: command.id,
    };
  }
  return {
    action: 'descend_staircase',
    targetX: command.targetX,
    targetY: command.targetY,
    targetZ: command.targetZ,
    ttlMs: command.ttlMs,
    reason: 'r5_descend_staircase',
    commandId: command.id,
  };
}

function r5IronChainIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  if (command.baselineIronPickaxes == null) {
    command.baselineRawIron = finiteOrNull(snapshot.inventoryRawIronCount) ?? 0;
    command.baselineIronIngots = finiteOrNull(snapshot.inventoryIronIngotCount) ?? 0;
    command.baselineIronPickaxes = finiteOrNull(snapshot.inventoryIronPickaxeCount) ?? 0;
  }
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;

  const currentRawIron = finiteOrNull(snapshot.inventoryRawIronCount) ?? 0;
  const currentIronIngots = finiteOrNull(snapshot.inventoryIronIngotCount) ?? 0;
  const currentIronPickaxes = finiteOrNull(snapshot.inventoryIronPickaxeCount) ?? 0;
  const ironPickaxeDelta = currentIronPickaxes - command.baselineIronPickaxes;
  if (ironPickaxeDelta >= command.requiredIronPickaxes) {
    const summary = completeCommand(instanceId, command, snapshot, {
      inventoryRawIronBefore: command.baselineRawIron,
      inventoryRawIronAfter: currentRawIron,
      inventoryIronIngotsBefore: command.baselineIronIngots,
      inventoryIronIngotsAfter: currentIronIngots,
      inventoryIronPickaxesBefore: command.baselineIronPickaxes,
      inventoryIronPickaxesAfter: currentIronPickaxes,
      ironPickaxeDelta,
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; ironPickaxeDelta=${summary.ironPickaxeDelta}`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'r5_iron_chain_complete',
      commandId: command.id,
    };
  }
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      inventoryRawIronBefore: command.baselineRawIron,
      inventoryRawIronAfter: currentRawIron,
      inventoryIronIngotsBefore: command.baselineIronIngots,
      inventoryIronIngotsAfter: currentIronIngots,
      inventoryIronPickaxesBefore: command.baselineIronPickaxes,
      inventoryIronPickaxesAfter: currentIronPickaxes,
      ironPickaxeDelta,
    });
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'r5_iron_chain_timeout',
      commandId: command.id,
    };
  }
  return {
    action: 'r5_iron_chain',
    targetX: command.targetX,
    targetY: command.targetY,
    targetZ: command.targetZ,
    ttlMs: command.ttlMs,
    reason: 'r5_iron_chain_fixed',
    commandId: command.id,
  };
}

function r6SurvivalIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  // The survival reflex is client-side and automatic. The stub only keeps the bot idle and
  // alive while the hunger stimulus (issued via setup commands) drains food and the client
  // eats it back up. Pass/fail is read from the client's r6_survival.* logs by the harness.
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      health: finiteOrNull(snapshot.health),
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; r6_survival window elapsed`);
    return {
      action: 'stop',
      forward: false,
      ttlMs: 250,
      reason: 'r6_survival_window_complete',
      commandId: command.id,
    };
  }
  return {
    action: 'stop',
    forward: false,
    ttlMs: 500,
    reason: 'r6_survival_idle',
    commandId: command.id,
  };
}

const R7_ARMOR_PHASES = [
  'craft_iron_helmet',
  'craft_iron_chestplate',
  'craft_iron_leggings',
  'craft_iron_boots',
  'equip_armor',
];

function equippedIronArmorFresh(snapshot) {
  return snapshot.equippedHelmetItem === 'iron_helmet'
    && snapshot.equippedChestplateItem === 'iron_chestplate'
    && snapshot.equippedLeggingsItem === 'iron_leggings'
    && snapshot.equippedBootsItem === 'iron_boots'
    && (finiteOrNull(snapshot.equippedHelmetRemainingFraction) ?? 0) >= 0.95
    && (finiteOrNull(snapshot.equippedChestplateRemainingFraction) ?? 0) >= 0.95
    && (finiteOrNull(snapshot.equippedLeggingsRemainingFraction) ?? 0) >= 0.95
    && (finiteOrNull(snapshot.equippedBootsRemainingFraction) ?? 0) >= 0.95;
}

function r7ArmorIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  if (command.baseline == null) {
    command.baseline = craftCounts(snapshot);
    command.phaseBaseline = craftCounts(snapshot);
    command.phaseIndex = 0;
  }
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;

  if (equippedIronArmorFresh(snapshot)) {
    const current = craftCounts(snapshot);
    const summary = completeCommand(instanceId, command, snapshot, {
      inventoryIronIngotsBefore: command.baseline.ironIngots,
      inventoryIronIngotsAfter: current.ironIngots,
      equippedHelmetRemainingFraction: finiteOrNull(snapshot.equippedHelmetRemainingFraction),
      equippedChestplateRemainingFraction: finiteOrNull(snapshot.equippedChestplateRemainingFraction),
      equippedLeggingsRemainingFraction: finiteOrNull(snapshot.equippedLeggingsRemainingFraction),
      equippedBootsRemainingFraction: finiteOrNull(snapshot.equippedBootsRemainingFraction),
      reason: 'r7_armor_complete',
    });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; r7 armor helmet=${summary.equippedHelmetRemainingFraction}`);
    return { action: 'stop', forward: false, ttlMs: 250, reason: 'r7_armor_complete', commandId: command.id };
  }

  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, {
      timedOut: true,
      phaseIndex: command.phaseIndex,
      phase: R7_ARMOR_PHASES[command.phaseIndex] || 'unknown',
    });
    return { action: 'stop', forward: false, ttlMs: 250, reason: 'r7_armor_timeout', commandId: command.id };
  }

  const phase = R7_ARMOR_PHASES[command.phaseIndex] || 'equip_armor';
  if (phase !== 'equip_armor') {
    const current = craftCounts(snapshot);
    if (craftDeltaComplete(phase, command.phaseBaseline, current)) {
      command.achievedSteps.push(phase);
      command.phaseIndex++;
      command.phaseBaseline = current;
      return { action: 'stop', forward: false, ttlMs: 250, reason: `r7_armor_phase_complete:${phase}`, commandId: command.id };
    }
    return {
      action: phase,
      ttlMs: command.ttlMs,
      reason: `r7_armor_${phase}`,
      commandId: `${command.id}:${phase}`,
    };
  }

  return {
    action: 'equip_armor',
    ttlMs: command.ttlMs,
    reason: 'r7_armor_equip',
    commandId: `${command.id}:equip_armor`,
  };
}

function r7CombatIntent(instanceId, command, snapshot) {
  const setup = setupThenWait(command, snapshot);
  if (setup) return setup;
  startCommandIfNeeded(instanceId, command, snapshot);
  command.lastSnapshot = snapshot;
  // The combat reflex is client-side and automatic: the CombatController takes over to fight when a
  // hostile is near. The stub just keeps the bot idle until the window elapses; the harness reads the
  // client's r7_combat.* logs for pass/fail (the spawned hostile must die).
  if (Date.now() - command.startedAtMs > command.timeoutMs) {
    completeCommand(instanceId, command, snapshot, { health: finiteOrNull(snapshot.health) });
    console.log(`[brain] command ${command.id} complete for ${instanceId}; r7_combat window elapsed`);
    return { action: 'stop', forward: false, ttlMs: 250, reason: 'r7_combat_window_complete', commandId: command.id };
  }
  return { action: 'stop', forward: false, ttlMs: 500, reason: 'r7_combat_idle', commandId: command.id };
}

function intentFor(instanceId, snapshot) {
  snapshots.set(instanceId, snapshot);
  const command = commands.get(instanceId);
  if (!command) {
    return { action: 'stop', forward: false, ttlMs: 250, reason: 'no_command' };
  }

  if (command.type === 'walk_forward_blocks') {
    return walkIntent(instanceId, command, snapshot);
  }
  if (command.type === 'look_sequence') {
    return lookSequenceIntent(instanceId, command, snapshot);
  }
  if (command.type === 'navigate_to_point') {
    return navigatePointIntent(instanceId, command, snapshot);
  }
  if (command.type === 'nav3d_drive_test') {
    return nav3dDriveTestIntent(instanceId, command, snapshot);
  }
  if (command.type === 'probe_navigation') {
    return probeNavigationIntent(instanceId, command, snapshot);
  }
  if (command.type === 'break_known_block') {
    return breakKnownBlockIntent(instanceId, command, snapshot);
  }
  if (command.type === 'gather_log_fixed') {
    return gatherLogFixedIntent(instanceId, command, snapshot);
  }
  if (command.type === 'hunt_sheep_fixed') {
    return huntSheepFixedIntent(instanceId, command, snapshot);
  }
  if (command.type === 'use_bed_fixed') {
    return useBedFixedIntent(instanceId, command, snapshot);
  }
  if (command.type === 'gather_tree_fixed') {
    return gatherTreeFixedIntent(instanceId, command, snapshot);
  }
  if (command.type === 'craft_2x2_fixed' || command.type === 'craft_3x3_fixed') {
    return craft2x2FixedIntent(instanceId, command, snapshot);
  }
  if (command.type === 'craft_pickaxe_retrieve_fixed') {
    return craftPickaxeRetrieveFixedIntent(instanceId, command, snapshot);
  }
  if (command.type === 'place_table_fixed') {
    return placeTableFixedIntent(instanceId, command, snapshot);
  }
  if (command.type === 'place_furnace_fixed') {
    return placeFurnaceFixedIntent(instanceId, command, snapshot);
  }
  if (command.type === 'smelt_charcoal_fixed') {
    return smeltCharcoalFixedIntent(instanceId, command, snapshot);
  }
  if (command.type === 'make_charcoal_fixed') {
    return makeCharcoalFixedIntent(instanceId, command, snapshot);
  }
  if (command.type === 'mine_stone_fixed') {
    return mineStoneFixedIntent(instanceId, command, snapshot);
  }
  if (command.type === 'descend_staircase_fixed') {
    return descendStaircaseFixedIntent(instanceId, command, snapshot);
  }
  if (command.type === 'r2_mine_stone_return_fixed') {
    return r2MineStoneReturnIntent(instanceId, command, snapshot);
  }
  if (command.type === 'r5_descend_mine_iron_fixed') {
    return r5DescendMineIronIntent(instanceId, command, snapshot);
  }
  if (command.type === 'r5_iron_chain_fixed') {
    return r5IronChainIntent(instanceId, command, snapshot);
  }
  if (command.type === 'r6_survival_fixed') {
    return r6SurvivalIntent(instanceId, command, snapshot);
  }
  if (command.type === 'r7_armor_fixed') {
    return r7ArmorIntent(instanceId, command, snapshot);
  }
  if (command.type === 'r7_combat_fixed') {
    return r7CombatIntent(instanceId, command, snapshot);
  }

  commands.delete(instanceId);
  return { action: 'stop', forward: false, ttlMs: 250, reason: 'unsupported_command', commandId: command.id };
}

function buildWalkCommand(json) {
  const blocks = Number(json.blocks);
  if (!Number.isFinite(blocks) || blocks <= 0 || blocks > 20) {
    throw new Error('blocks must be >0 and <=20');
  }
  return {
    id: `walk-${Date.now()}`,
    type: json.type,
    blocks,
    startedAt: null,
    armedAtMs: Date.now(),
    status: 'armed',
  };
}

function buildLookSequenceCommand(json) {
  const rawSteps = Array.isArray(json.steps) ? json.steps : [];
  if (rawSteps.length < 1 || rawSteps.length > 8) {
    throw new Error('steps must contain 1-8 look targets');
  }
  const steps = rawSteps.map((raw, index) => {
    const yaw = Number(raw.yaw);
    const pitch = Number(raw.pitch);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || pitch < -90 || pitch > 90) {
      throw new Error(`step ${index} must have finite yaw and pitch between -90 and 90`);
    }
    return { yaw: normalizeYaw(yaw), pitch };
  });
  const toleranceDeg = Number(json.toleranceDeg ?? 2.5);
  if (!Number.isFinite(toleranceDeg) || toleranceDeg <= 0 || toleranceDeg > 10) {
    throw new Error('toleranceDeg must be >0 and <=10');
  }
  return {
    id: `look-${Date.now()}`,
    type: json.type,
    steps,
    toleranceDeg,
    stepIndex: 0,
    achievedSteps: [],
    samples: [],
    startedAt: null,
    armedAtMs: Date.now(),
    status: 'armed',
  };
}

function buildNavigatePointCommand(json) {
  const targetX = Number(json.targetX);
  const targetZ = Number(json.targetZ);
  if (!Number.isFinite(targetX) || !Number.isFinite(targetZ)) {
    throw new Error('targetX and targetZ must be finite');
  }
  const arriveEpsilon = Number(json.arriveEpsilon ?? 0.45);
  if (!Number.isFinite(arriveEpsilon) || arriveEpsilon <= 0 || arriveEpsilon > 2) {
    throw new Error('arriveEpsilon must be >0 and <=2');
  }
  const rawWaypoints = Array.isArray(json.waypoints) ? json.waypoints : [];
  const waypoints = rawWaypoints.map((raw, index) => {
    const x = Number(raw.x);
    const z = Number(raw.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      throw new Error(`waypoint ${index} must have finite x and z`);
    }
    return { x: Math.floor(x), z: Math.floor(z) };
  });
  const rawBlockedCells = Array.isArray(json.blockedCells) ? json.blockedCells : [];
  const blockedCells = rawBlockedCells.map((raw, index) => {
    const x = Number(raw.x);
    const z = Number(raw.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      throw new Error(`blocked cell ${index} must have finite x and z`);
    }
    return { x: Math.floor(x), z: Math.floor(z) };
  });
  const setupCommands = Array.isArray(json.setupCommands)
    ? json.setupCommands
      .map((command) => String(command || '').trim())
      .filter(Boolean)
      .slice(0, 24)
    : [];
  const setupSettleMs = Number(json.setupSettleMs ?? 250);
  if (!Number.isFinite(setupSettleMs) || setupSettleMs < 0 || setupSettleMs > 60000) {
    throw new Error('setupSettleMs must be >=0 and <=60000');
  }
  return {
    id: `nav-${Date.now()}`,
    type: json.type,
    targetX,
    targetZ,
    arriveEpsilon,
    waypoints,
    blockedCells,
    setupCommands,
    setupSettleMs,
    requireOnGroundAfterSetup: Boolean(json.requireOnGroundAfterSetup),
    samples: [],
    minDistance: null,
    distanceIncreases: 0,
    startedAt: null,
    armedAtMs: Date.now(),
    status: 'armed',
  };
}

function buildProbeNavigationCommand(json) {
  const command = buildNavigatePointCommand({ ...json, type: 'navigate_to_point' });
  return {
    ...command,
    id: `probe-${Date.now()}`,
    type: json.type,
    probeIssued: false,
    probeIssuedAtMs: null,
  };
}

function buildNav3dDriveTestCommand(json) {
  const command = buildNavigatePointCommand({ ...json, type: 'navigate_to_point' });
  const targetY = Number(json.targetY);
  if (!Number.isFinite(targetY)) {
    throw new Error('targetY must be finite');
  }
  return {
    ...command,
    id: `nav3dtest-${Date.now()}`,
    type: json.type,
    targetY,
  };
}

function buildBlockTargetCommand(json, type, idPrefix) {
  const targetX = Number(json.targetX);
  const targetY = Number(json.targetY);
  const targetZ = Number(json.targetZ);
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY) || !Number.isFinite(targetZ)) {
    throw new Error('targetX, targetY, and targetZ must be finite');
  }
  const setupCommands = Array.isArray(json.setupCommands)
    ? json.setupCommands
      .map((command) => String(command || '').trim())
      .filter(Boolean)
      .slice(0, 24)
    : [];
  const setupSettleMs = Number(json.setupSettleMs ?? 500);
  if (!Number.isFinite(setupSettleMs) || setupSettleMs < 0 || setupSettleMs > 60000) {
    throw new Error('setupSettleMs must be >=0 and <=60000');
  }
  const timeoutMs = Number(json.timeoutMs ?? 20000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > BLOCK_TARGET_MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be >0 and <=${BLOCK_TARGET_MAX_TIMEOUT_MS}`);
  }
  const ttlMs = Number(json.ttlMs ?? 15000);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > BLOCK_TARGET_MAX_TIMEOUT_MS) {
    throw new Error(`ttlMs must be >0 and <=${BLOCK_TARGET_MAX_TIMEOUT_MS}`);
  }
  const minLogs = Number(json.minLogs ?? 1);
  if (!Number.isFinite(minLogs) || minLogs <= 0 || minLogs > 32) {
    throw new Error('minLogs must be >0 and <=32');
  }
  return {
    id: `${idPrefix}-${Date.now()}`,
    type,
    targetX: Math.floor(targetX),
    targetY: Math.floor(targetY),
    targetZ: Math.floor(targetZ),
    setupCommands,
    setupSettleMs,
    timeoutMs,
    ttlMs,
    minLogs: Math.floor(minLogs),
    requireOnGroundAfterSetup: Boolean(json.requireOnGroundAfterSetup),
    startedAt: null,
    armedAtMs: Date.now(),
    status: 'armed',
  };
}

function buildCraft2x2Command(json) {
  const action = String(json.action || json.recipe || '').trim();
  if (!['craft_planks', 'craft_sticks', 'craft_table', 'craft_pickaxe', 'craft_stone_pickaxe', 'craft_iron_pickaxe', 'craft_diamond_pickaxe', 'craft_stone_axe', 'craft_stone_sword', 'craft_furnace', 'craft_iron_helmet', 'craft_iron_chestplate', 'craft_iron_leggings', 'craft_iron_boots'].includes(action)) {
    throw new Error('action must be a supported 2x2 or 3x3 craft action');
  }
  const setupCommands = Array.isArray(json.setupCommands)
    ? json.setupCommands
      .map((command) => String(command || '').trim())
      .filter(Boolean)
      .slice(0, 24)
    : [];
  const setupSettleMs = Number(json.setupSettleMs ?? 500);
  if (!Number.isFinite(setupSettleMs) || setupSettleMs < 0 || setupSettleMs > 60000) {
    throw new Error('setupSettleMs must be >=0 and <=60000');
  }
  const timeoutMs = Number(json.timeoutMs ?? 20000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
    throw new Error('timeoutMs must be >0 and <=120000');
  }
  const ttlMs = Number(json.ttlMs ?? 15000);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 120000) {
    throw new Error('ttlMs must be >0 and <=120000');
  }
  return {
    id: `craft-${Date.now()}`,
    type: action === 'craft_pickaxe' || action.startsWith('craft_stone_') || action.startsWith('craft_iron_') || action === 'craft_furnace' ? 'craft_3x3_fixed' : 'craft_2x2_fixed',
    action,
    setupCommands,
    setupSettleMs,
    timeoutMs,
    ttlMs,
    requireOnGroundAfterSetup: Boolean(json.requireOnGroundAfterSetup),
    baseline: null,
    startedAt: null,
    armedAtMs: Date.now(),
    status: 'armed',
  };
}

function buildPlaceTableCommand(json) {
  const setupCommands = Array.isArray(json.setupCommands)
    ? json.setupCommands
      .map((command) => String(command || '').trim())
      .filter(Boolean)
      .slice(0, 24)
    : [];
  const setupSettleMs = Number(json.setupSettleMs ?? 500);
  if (!Number.isFinite(setupSettleMs) || setupSettleMs < 0 || setupSettleMs > 60000) {
    throw new Error('setupSettleMs must be >=0 and <=60000');
  }
  const timeoutMs = Number(json.timeoutMs ?? 20000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
    throw new Error('timeoutMs must be >0 and <=120000');
  }
  const ttlMs = Number(json.ttlMs ?? 15000);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 120000) {
    throw new Error('ttlMs must be >0 and <=120000');
  }
  return {
    id: `place-${Date.now()}`,
    type: 'place_table_fixed',
    setupCommands,
    setupSettleMs,
    timeoutMs,
    ttlMs,
    requireOnGroundAfterSetup: Boolean(json.requireOnGroundAfterSetup),
    baselineTables: null,
    startedAt: null,
    armedAtMs: Date.now(),
    status: 'armed',
  };
}

function buildPlaceFurnaceCommand(json) {
  const setupCommands = Array.isArray(json.setupCommands)
    ? json.setupCommands
      .map((command) => String(command || '').trim())
      .filter(Boolean)
      .slice(0, 24)
    : [];
  const setupSettleMs = Number(json.setupSettleMs ?? 500);
  if (!Number.isFinite(setupSettleMs) || setupSettleMs < 0 || setupSettleMs > 60000) {
    throw new Error('setupSettleMs must be >=0 and <=60000');
  }
  const timeoutMs = Number(json.timeoutMs ?? 20000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
    throw new Error('timeoutMs must be >0 and <=120000');
  }
  const ttlMs = Number(json.ttlMs ?? 15000);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 120000) {
    throw new Error('ttlMs must be >0 and <=120000');
  }
  return {
    id: `place-furnace-${Date.now()}`,
    type: 'place_furnace_fixed',
    setupCommands,
    setupSettleMs,
    timeoutMs,
    ttlMs,
    requireOnGroundAfterSetup: Boolean(json.requireOnGroundAfterSetup),
    baselineFurnaces: null,
    startedAt: null,
    armedAtMs: Date.now(),
    status: 'armed',
  };
}

function buildHuntSheepCommand(json) {
  const setupCommands = Array.isArray(json.setupCommands)
    ? json.setupCommands
      .map((command) => String(command || '').trim())
      .filter(Boolean)
      .slice(0, 32)
    : [];
  const setupSettleMs = Number(json.setupSettleMs ?? 1000);
  if (!Number.isFinite(setupSettleMs) || setupSettleMs < 0 || setupSettleMs > 60000) {
    throw new Error('setupSettleMs must be >=0 and <=60000');
  }
  const timeoutMs = Number(json.timeoutMs ?? 180000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 240000) {
    throw new Error('timeoutMs must be >0 and <=240000');
  }
  const ttlMs = Number(json.ttlMs ?? 45000);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 240000) {
    throw new Error('ttlMs must be >0 and <=240000');
  }
  return {
    id: `hunt-sheep-${Date.now()}`,
    type: 'hunt_sheep_fixed',
    setupCommands,
    setupSettleMs,
    timeoutMs,
    ttlMs,
    requireOnGroundAfterSetup: Boolean(json.requireOnGroundAfterSetup),
    startedAt: null,
    armedAtMs: Date.now(),
    status: 'armed',
  };
}

function buildSmeltCharcoalCommand(json) {
  const setupCommands = Array.isArray(json.setupCommands)
    ? json.setupCommands
      .map((command) => String(command || '').trim())
      .filter(Boolean)
      .slice(0, 24)
    : [];
  const setupSettleMs = Number(json.setupSettleMs ?? 500);
  if (!Number.isFinite(setupSettleMs) || setupSettleMs < 0 || setupSettleMs > 60000) {
    throw new Error('setupSettleMs must be >=0 and <=60000');
  }
  const timeoutMs = Number(json.timeoutMs ?? 90000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 180000) {
    throw new Error('timeoutMs must be >0 and <=180000');
  }
  const ttlMs = Number(json.ttlMs ?? 90000);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 180000) {
    throw new Error('ttlMs must be >0 and <=180000');
  }
  return {
    id: `smelt-charcoal-${Date.now()}`,
    type: 'smelt_charcoal_fixed',
    setupCommands,
    setupSettleMs,
    timeoutMs,
    ttlMs,
    requireOnGroundAfterSetup: Boolean(json.requireOnGroundAfterSetup),
    baseline: null,
    startedAt: null,
    armedAtMs: Date.now(),
    status: 'armed',
  };
}

function buildMakeCharcoalCommand(json) {
  const setupCommands = Array.isArray(json.setupCommands)
    ? json.setupCommands
      .map((command) => String(command || '').trim())
      .filter(Boolean)
      .slice(0, 32)
    : [];
  const setupSettleMs = Number(json.setupSettleMs ?? 500);
  if (!Number.isFinite(setupSettleMs) || setupSettleMs < 0 || setupSettleMs > 60000) {
    throw new Error('setupSettleMs must be >=0 and <=60000');
  }
  const timeoutMs = Number(json.timeoutMs ?? 140000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 240000) {
    throw new Error('timeoutMs must be >0 and <=240000');
  }
  const ttlMs = Number(json.ttlMs ?? 140000);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 240000) {
    throw new Error('ttlMs must be >0 and <=240000');
  }
  return {
    id: `make-charcoal-${Date.now()}`,
    type: 'make_charcoal_fixed',
    setupCommands,
    setupSettleMs,
    timeoutMs,
    ttlMs,
    requireOnGroundAfterSetup: Boolean(json.requireOnGroundAfterSetup),
    baseline: null,
    startedAt: null,
    armedAtMs: Date.now(),
    status: 'armed',
  };
}

function buildR6SurvivalCommand(json) {
  const setupCommands = Array.isArray(json.setupCommands)
    ? json.setupCommands
      .map((command) => String(command || '').trim())
      .filter(Boolean)
      .slice(0, 32)
    : [];
  const setupSettleMs = Number(json.setupSettleMs ?? 750);
  if (!Number.isFinite(setupSettleMs) || setupSettleMs < 0 || setupSettleMs > 60000) {
    throw new Error('setupSettleMs must be >=0 and <=60000');
  }
  const timeoutMs = Number(json.timeoutMs ?? 120000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) {
    throw new Error('timeoutMs must be >0 and <=300000');
  }
  const ttlMs = Number(json.ttlMs ?? 60000);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 300000) {
    throw new Error('ttlMs must be >0 and <=300000');
  }
  return {
    id: `r6-survival-${Date.now()}`,
    type: 'r6_survival_fixed',
    setupCommands,
    setupSettleMs,
    timeoutMs,
    ttlMs,
    requireOnGroundAfterSetup: Boolean(json.requireOnGroundAfterSetup),
    startedAt: null,
    armedAtMs: Date.now(),
    status: 'armed',
  };
}

function buildR7CombatCommand(json) {
  const setupCommands = Array.isArray(json.setupCommands)
    ? json.setupCommands
      .map((command) => String(command || '').trim())
      .filter(Boolean)
      .slice(0, 32)
    : [];
  const setupSettleMs = Number(json.setupSettleMs ?? 750);
  if (!Number.isFinite(setupSettleMs) || setupSettleMs < 0 || setupSettleMs > 60000) {
    throw new Error('setupSettleMs must be >=0 and <=60000');
  }
  const timeoutMs = Number(json.timeoutMs ?? 120000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) {
    throw new Error('timeoutMs must be >0 and <=300000');
  }
  const ttlMs = Number(json.ttlMs ?? 60000);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 300000) {
    throw new Error('ttlMs must be >0 and <=300000');
  }
  return {
    id: `r7-combat-${Date.now()}`,
    type: 'r7_combat_fixed',
    setupCommands,
    setupSettleMs,
    timeoutMs,
    ttlMs,
    requireOnGroundAfterSetup: Boolean(json.requireOnGroundAfterSetup),
    startedAt: null,
    armedAtMs: Date.now(),
    status: 'armed',
  };
}

function buildR7ArmorCommand(json) {
  const command = buildR7CombatCommand(json);
  return {
    ...command,
    id: `r7-armor-${Date.now()}`,
    type: 'r7_armor_fixed',
    baseline: null,
    phaseBaseline: null,
    phaseIndex: 0,
    achievedSteps: [],
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      writeText(res, 200, 'ok\n');
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/snapshot')) {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const instanceId = url.searchParams.get('instanceId');
      if (!instanceId) {
        writeText(res, 400, '{"ok":false,"error":"missing instanceId"}\n');
        return;
      }
      writeText(res, 200, JSON.stringify({ ok: true, instanceId, snapshot: snapshots.get(instanceId) || null }) + '\n');
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/status')) {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const instanceId = url.searchParams.get('instanceId');
      if (!instanceId) {
        writeText(res, 400, '{"ok":false,"error":"missing instanceId"}\n');
        return;
      }
      writeText(res, 200, JSON.stringify({
        ok: true,
        instanceId,
        active: commands.get(instanceId) || null,
        completed: completed.get(instanceId) || null,
        snapshot: snapshots.get(instanceId) || null,
      }) + '\n');
      return;
    }

    if (req.method === 'POST' && req.url === '/command') {
      const { instanceId, json } = parseBody(await readRequest(req));
      let command;
      try {
        if (json.type === 'walk_forward_blocks') {
          command = buildWalkCommand(json);
        } else if (json.type === 'look_sequence') {
          command = buildLookSequenceCommand(json);
        } else if (json.type === 'navigate_to_point') {
          command = buildNavigatePointCommand(json);
        } else if (json.type === 'nav3d_drive_test') {
          command = buildNav3dDriveTestCommand(json);
        } else if (json.type === 'probe_navigation') {
          command = buildProbeNavigationCommand(json);
        } else if (json.type === 'break_known_block') {
          command = buildBlockTargetCommand(json, 'break_known_block', 'break');
        } else if (json.type === 'gather_log_fixed') {
          command = buildBlockTargetCommand(json, 'gather_log_fixed', 'gather');
        } else if (json.type === 'gather_tree_fixed') {
          command = buildBlockTargetCommand(json, 'gather_tree_fixed', 'tree');
        } else if (json.type === 'hunt_sheep_fixed') {
          command = buildHuntSheepCommand(json);
        } else if (json.type === 'use_bed_fixed') {
          command = { ...buildHuntSheepCommand(json), id: `use-bed-${Date.now()}`, type: 'use_bed_fixed' };
        } else if (json.type === 'craft_planks_fixed') {
          command = buildCraft2x2Command({ ...json, action: 'craft_planks' });
        } else if (json.type === 'craft_2x2_fixed') {
          command = buildCraft2x2Command(json);
        } else if (json.type === 'craft_3x3_fixed') {
          command = buildCraft2x2Command(json);
        } else if (json.type === 'craft_pickaxe_retrieve_fixed') {
          command = { ...buildCraft2x2Command({ ...json, action: 'craft_pickaxe' }), type: 'craft_pickaxe_retrieve_fixed', phase: 'craft' };
        } else if (json.type === 'place_table_fixed') {
          command = buildPlaceTableCommand(json);
        } else if (json.type === 'place_furnace_fixed') {
          command = buildPlaceFurnaceCommand(json);
        } else if (json.type === 'smelt_charcoal_fixed') {
          command = buildSmeltCharcoalCommand(json);
        } else if (json.type === 'make_charcoal_fixed') {
          command = buildMakeCharcoalCommand(json);
        } else if (json.type === 'mine_stone_fixed') {
          command = buildBlockTargetCommand(json, 'mine_stone_fixed', 'mine-stone');
        } else if (json.type === 'descend_staircase_fixed') {
          command = buildBlockTargetCommand(json, 'descend_staircase_fixed', 'descend');
        } else if (json.type === 'r2_mine_stone_return_fixed') {
          command = buildBlockTargetCommand(json, 'r2_mine_stone_return_fixed', 'r2-stone');
          command.startX = Math.floor(Number(json.startX));
          command.startY = Math.floor(Number(json.startY));
          command.startZ = Math.floor(Number(json.startZ));
          if (![command.startX, command.startY, command.startZ].every(Number.isFinite)) {
            throw new Error('startX, startY, and startZ must be finite');
          }
          const requiredCobblestone = Number(json.requiredCobblestone ?? 10);
          if (!Number.isFinite(requiredCobblestone) || requiredCobblestone <= 0 || requiredCobblestone > 64) {
            throw new Error('requiredCobblestone must be >0 and <=64');
          }
          command.requiredCobblestone = Math.floor(requiredCobblestone);
          command.phase = 'descend';
        } else if (json.type === 'r5_descend_mine_iron_fixed') {
          command = buildBlockTargetCommand(json, 'r5_descend_mine_iron_fixed', 'r5-iron');
          const requiredRawIron = Number(json.requiredRawIron ?? 3);
          if (!Number.isFinite(requiredRawIron) || requiredRawIron <= 0 || requiredRawIron > 16) {
            throw new Error('requiredRawIron must be >0 and <=16');
          }
          const mineTimeoutMs = Number(json.mineTimeoutMs ?? 90000);
          if (!Number.isFinite(mineTimeoutMs) || mineTimeoutMs <= 0 || mineTimeoutMs > 180000) {
            throw new Error('mineTimeoutMs must be >0 and <=180000');
          }
          command.requiredRawIron = Math.floor(requiredRawIron);
          command.mineTimeoutMs = Math.floor(mineTimeoutMs);
          command.phase = 'descend';
        } else if (json.type === 'r5_iron_chain_fixed') {
          command = buildBlockTargetCommand(json, 'r5_iron_chain_fixed', 'r5-chain');
          const requiredIronPickaxes = Number(json.requiredIronPickaxes ?? 1);
          if (!Number.isFinite(requiredIronPickaxes) || requiredIronPickaxes <= 0 || requiredIronPickaxes > 4) {
            throw new Error('requiredIronPickaxes must be >0 and <=4');
          }
          command.requiredIronPickaxes = Math.floor(requiredIronPickaxes);
        } else if (json.type === 'r6_survival_fixed') {
          command = buildR6SurvivalCommand(json);
        } else if (json.type === 'r7_armor_fixed') {
          command = buildR7ArmorCommand(json);
        } else if (json.type === 'r7_combat_fixed') {
          command = buildR7CombatCommand(json);
        } else {
          writeText(res, 400, `instanceId:${instanceId}\n{"ok":false,"error":"unsupported command"}\n`);
          return;
        }
      } catch (err) {
        writeText(res, 400, `instanceId:${instanceId}\n${JSON.stringify({ ok: false, error: err.message || String(err) })}\n`);
        return;
      }
      completed.delete(instanceId);
      commands.set(instanceId, command);
      console.log(`[brain] command ${command.id} armed for ${instanceId}; type=${command.type}`);
      writeText(res, 200, `instanceId:${instanceId}\n${JSON.stringify({ ok: true, command })}\n`);
      return;
    }

    if (req.method === 'POST' && req.url === '/intent') {
      const { instanceId, json } = parseBody(await readRequest(req));
      const intent = intentFor(instanceId, json);
      writeText(res, 200, `instanceId:${instanceId}\n${JSON.stringify(intent)}\n`);
      return;
    }

    writeText(res, 404, 'not found\n');
  } catch (err) {
    writeText(res, 500, `error: ${err.message || err}\n`);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[brain] listening on http://127.0.0.1:${port}`);
  console.log('[brain] protocol: first request/response line is instanceId:<id>');
});
