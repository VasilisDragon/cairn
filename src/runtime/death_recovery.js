import { Vec3 } from 'vec3';

const DEFAULT_RECOVERY_MAX_DISTANCE = 96;
const DEFAULT_RECOVERY_ATTEMPTS = 1;
const RECENT_EVENT_MS = 10000;
const DEFAULT_INVENTORY_SNAPSHOT_CAP = 64;

const DESTRUCTIVE_HAZARD_BLOCKS = new Set([
  'lava',
  'fire',
  'soul_fire',
  'void_air',
]);

const LAVA_FIRE_RE = /\b(lava|fire|flame|flames|burned|burnt)\b/i;
const VOID_RE = /\bvoid\b/i;
const FALL_RE = /\b(fell|fall|hit the ground|doomed to fall)\b/i;

export function summarizeDamageSource(source) {
  if (!source || typeof source !== 'object') return null;
  const type = source.type || null;
  const name = source.name || source.displayName || null;
  const username = source.username || null;
  const kind = type === 'player' || username ? 'player' : (source.kind || type || name || 'unknown');
  return {
    id: source.id ?? null,
    type,
    kind,
    name,
    username,
  };
}

export function classifyDeathCause(record = {}) {
  const source = record.damageSource || null;
  if (source?.kind === 'player' || source?.type === 'player' || source?.username) {
    return {
      kind: 'player',
      destructive: false,
      detail: source.username || source.name || 'player',
    };
  }

  const message = String(record.message || '');
  if (LAVA_FIRE_RE.test(message)) {
    return {
      kind: 'destructive_hazard',
      destructive: true,
      detail: /lava/i.test(message) ? 'lava' : 'fire',
    };
  }
  if (VOID_RE.test(message)) {
    return {
      kind: 'destructive_hazard',
      destructive: true,
      detail: 'void',
    };
  }

  const nearbyHazard = (record.nearbyHazards || []).find((name) => DESTRUCTIVE_HAZARD_BLOCKS.has(name));
  if (nearbyHazard) {
    return {
      kind: 'destructive_hazard',
      destructive: true,
      detail: nearbyHazard,
    };
  }

  if (FALL_RE.test(message)) {
    return {
      kind: 'environment',
      destructive: false,
      detail: 'fall',
    };
  }

  if (source) {
    return {
      kind: source.kind || source.type || 'entity',
      destructive: false,
      detail: source.username || source.name || source.type || null,
    };
  }

  return {
    kind: 'unknown',
    destructive: false,
    detail: null,
  };
}

export function decideDropRecovery(record = {}, opts = {}) {
  const maxDistance = opts.maxDistance ?? DEFAULT_RECOVERY_MAX_DISTANCE;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_RECOVERY_ATTEMPTS;
  const cause = record.cause || classifyDeathCause(record);
  const previousRecoveryAttempts = Number(record.previousRecoveryAttempts || 0);

  if (cause.kind === 'player') {
    return abandon('death caused by player; dropped items are likely contested', cause);
  }
  if (cause.destructive) {
    return abandon(`death caused by ${cause.detail || 'destructive hazard'}; dropped items are likely destroyed`, cause);
  }
  if (previousRecoveryAttempts >= maxAttempts) {
    return abandon('already attempted drop recovery once; abandon to avoid recovery loops', cause);
  }
  if (!isPosition(record.deathPosition)) {
    return abandon('death position unavailable', cause);
  }
  if (record.deathDimension && record.respawnDimension && record.deathDimension !== record.respawnDimension) {
    return abandon(`death dimension ${record.deathDimension} differs from respawn dimension ${record.respawnDimension}`, cause);
  }

  const distance = distanceBetween(record.respawnPosition, record.deathPosition);
  if (distance !== null && distance > maxDistance) {
    return abandon(`death drops are ${Math.round(distance)} blocks away; exceeds max recovery distance ${maxDistance}`, cause, { distance });
  }

  return {
    action: 'recover_drops',
    recoverable: true,
    cause,
    distance,
    maxDistance,
    attemptsAllowed: maxAttempts - previousRecoveryAttempts,
    reason: 'death drops are close enough for one recovery attempt',
  };
}

export function createDeathRecoveryTracker(bot, opts = {}) {
  let lastDamage = null;
  let lastMessage = null;
  let pending = null;

  return {
    observeEntityHurt(entity, source) {
      if (!isBotEntity(bot, entity)) return;
      lastDamage = {
        at: Date.now(),
        source: summarizeDamageSource(source),
      };
    },

    observeMessage(message) {
      if (!isLikelyBotDeathMessage(bot, message)) return;
      lastMessage = {
        at: Date.now(),
        message: String(message || ''),
      };
    },

    recordDeath() {
      const now = Date.now();
      const deathPosition = clonePosition(bot?.entity?.position);
      const deathDimension = bot?.game?.dimension || null;
      const recentDamage = lastDamage && now - lastDamage.at <= RECENT_EVENT_MS ? lastDamage.source : null;
      const recentMessage = lastMessage && now - lastMessage.at <= RECENT_EVENT_MS ? lastMessage.message : null;
      const nearbyHazards = sampleNearbyHazards(bot, deathPosition);
      const currentTask = summarizeCurrentTask(bot);
      const inventorySnapshot = summarizeInventorySnapshot(bot, opts.inventorySnapshotCap);
      const previousRecoveryAttempts = pending?.status === 'recovering' ? pending.attempts : 0;
      const cause = classifyDeathCause({
        message: recentMessage,
        damageSource: recentDamage,
        nearbyHazards,
      });
      const decision = decideDropRecovery({
        cause,
        deathPosition,
        deathDimension,
        previousRecoveryAttempts,
      }, opts);

      if (decision.recoverable) {
        pending = {
          status: 'pending',
          attempts: previousRecoveryAttempts,
          deathPosition,
          deathDimension,
          cause,
          decision,
        };
      } else {
        pending = null;
      }

      return {
        deathPosition,
        deathDimension,
        message: recentMessage,
        damageSource: recentDamage,
        nearbyHazards,
        currentTask,
        inventorySnapshot,
        cause,
        decision,
      };
    },

    recordRespawn() {
      if (!pending) return null;
      const respawnPosition = clonePosition(bot?.entity?.position);
      const respawnDimension = bot?.game?.dimension || null;
      const decision = decideDropRecovery({
        cause: pending.cause,
        deathPosition: pending.deathPosition,
        deathDimension: pending.deathDimension,
        respawnPosition,
        respawnDimension,
        previousRecoveryAttempts: pending.attempts,
      }, opts);
      pending = decision.recoverable
        ? { ...pending, respawnPosition, respawnDimension, decision }
        : null;
      return pending ? { ...pending } : { status: 'abandoned', decision };
    },

    markRecoveryStarted() {
      if (!pending) return null;
      pending = {
        ...pending,
        status: 'recovering',
        attempts: pending.attempts + 1,
      };
      return { ...pending };
    },

    pendingRecovery() {
      return pending ? { ...pending } : null;
    },
  };
}

function abandon(reason, cause, extra = {}) {
  return {
    action: 'abandon_drops',
    recoverable: false,
    cause,
    reason,
    ...extra,
  };
}

function isBotEntity(bot, entity) {
  if (!entity || !bot?.entity) return false;
  if (entity === bot.entity) return true;
  if (entity.id != null && bot.entity.id != null) return entity.id === bot.entity.id;
  return false;
}

function isLikelyBotDeathMessage(bot, message) {
  const text = String(message || '');
  if (!text) return false;
  const username = bot?.username;
  if (!username) return true;
  return text.toLowerCase().includes(String(username).toLowerCase());
}

function sampleNearbyHazards(bot, position) {
  if (!bot?.blockAt || !isPosition(position)) return [];
  const base = floorPosition(position);
  const offsets = [
    [0, 0, 0],
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const hazards = new Set();
  for (const [dx, dy, dz] of offsets) {
    try {
      const block = bot.blockAt(new Vec3(base.x + dx, base.y + dy, base.z + dz));
      if (block?.name && DESTRUCTIVE_HAZARD_BLOCKS.has(block.name)) hazards.add(block.name);
    } catch {
      // Death logging must not throw while the bot is already in a bad state.
    }
  }
  return [...hazards].sort();
}

function summarizeCurrentTask(bot) {
  try {
    const executor = bot?.skillExecutor;
    if (!executor) return null;
    const call = executor.currentCall || null;
    const subtask = executor.currentSubtask || null;
    const queueLength = Array.isArray(executor.queue) ? executor.queue.length : null;
    if (!call?.skill && !subtask && queueLength === null) return null;
    return {
      ...(call?.skill ? { skill: call.skill } : {}),
      ...(call?.params !== undefined ? { params: cloneJsonForLog(call.params) } : {}),
      ...(subtask ? { subtask } : {}),
      ...(queueLength !== null ? { queueLength } : {}),
    };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

function summarizeInventorySnapshot(bot, cap = DEFAULT_INVENTORY_SNAPSHOT_CAP) {
  const limit = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_INVENTORY_SNAPSHOT_CAP;
  try {
    if (typeof bot?.inventory?.items !== 'function') {
      return { ok: false, items: [], error: 'inventory items unavailable' };
    }
    const rawItems = bot.inventory.items();
    const items = rawItems
      .map(compactItemForLog)
      .filter(Boolean)
      .sort((a, b) => (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
    return {
      ok: true,
      items: items.slice(0, limit),
      totalStacks: items.length,
      totalItems: items.reduce((sum, item) => sum + (item.count || 0), 0),
      truncated: items.length > limit,
      ...(bot?.heldItem ? { heldItem: compactItemForLog(bot.heldItem) } : {}),
    };
  } catch (err) {
    return { ok: false, items: [], error: errorMessage(err) };
  }
}

function compactItemForLog(item) {
  if (!item?.name) return null;
  return {
    name: item.name,
    count: Number.isFinite(item.count) ? item.count : 1,
    ...(Number.isFinite(item.slot) ? { slot: item.slot } : {}),
  };
}

function cloneJsonForLog(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch (err) {
    return { unavailable: errorMessage(err) };
  }
}

function clonePosition(position) {
  if (!isPosition(position)) return null;
  return {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
  };
}

function floorPosition(position) {
  return {
    x: Math.floor(Number(position.x)),
    y: Math.floor(Number(position.y)),
    z: Math.floor(Number(position.z)),
  };
}

function isPosition(position) {
  return position && ['x', 'y', 'z'].every((axis) => Number.isFinite(Number(position[axis])));
}

function distanceBetween(a, b) {
  if (!isPosition(a) || !isPosition(b)) return null;
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y), Number(a.z) - Number(b.z));
}

function errorMessage(err) {
  return err?.message || String(err);
}
