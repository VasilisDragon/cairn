import net from 'node:net';
import { ensureLiveClientResourceAdmissionSync } from '../src/runtime/live_client_admission.js';
import { assertNoUncontrolledLocalMinecraftServerSync } from './local-minecraft-server-policy.js';

const AUTH_TYPE = 3;
const COMMAND_TYPE = 2;
const RESPONSE_TYPE = 0;
const DEFAULT_RCON_HOST = '127.0.0.1';
const DEFAULT_RCON_PORT = 25575;
const DEFAULT_TIMEOUT_MS = 5000;

export function buildLiveAdminPlan(argv = []) {
  const [action, ...args] = argv;
  if (!action || action === 'help' || action === '--help' || action === '-h') {
    return { ok: false, reason: usageText() };
  }
  switch (action) {
    case 'clear-non-players':
      return plan('clear-non-players', ['minecraft:kill @e[type=!player]']);
    case 'summon-zombie':
      return summonPlan('summon-zombie', 'minecraft:zombie', args);
    case 'summon-zombie-fire-resistant':
      return summonZombieFireResistantPlan(args);
    case 'summon-zombie-wave-fire-resistant':
      return summonZombieWaveFireResistantPlan(args);
    case 'mcbottest-spawn-zombie-fire-resistant':
      return mcbottestSpawnZombieFireResistantPlan(args);
    case 'mcbottest-spawn-zombie-wave-fire-resistant':
      return mcbottestSpawnZombieWaveFireResistantPlan(args);
    case 'kill-zombies-near':
      return killZombiesNearPlan(args);
    case 'query-do-mob-spawning':
      return plan('query-do-mob-spawning', ['gamerule spawn_monsters']);
    case 'set-do-mob-spawning':
      return setDoMobSpawningPlan(args);
    case 'summon-spider':
      return summonPlan('summon-spider', 'minecraft:spider', args);
    case 'fixture-single-zombie':
      return fixtureSingleHostilePlan('fixture-single-zombie', 'minecraft:zombie', args);
    case 'fixture-single-zombie-fire-resistant':
      return fixtureSingleZombieFireResistantPlan(args);
    case 'fixture-single-spider':
      return fixtureSingleHostilePlan('fixture-single-spider', 'minecraft:spider', args);
    case 'death-recovery-fall':
      return deathRecoveryFallPlan(args);
    case 'give':
      return givePlan(args);
    case 'teleport-player':
      return teleportPlayerPlan(args);
    case 'raw':
      return rawPlan(args);
    default:
      return { ok: false, reason: `unknown live admin action "${action}". ${usageText()}` };
  }
}

export function validateLiveAdminEnv(env = process.env, opts = {}) {
  if (env.MCBOT_LIVE_TESTS !== '1') {
    return 'refusing live admin command without MCBOT_LIVE_TESTS=1';
  }
  if (env.MCBOT_LIVE_ADMIN_OK !== '1') {
    return 'refusing live admin command without MCBOT_LIVE_ADMIN_OK=1';
  }
  if (opts.raw === true && env.MCBOT_LIVE_ADMIN_RAW_OK !== '1') {
    return 'refusing raw live admin command without MCBOT_LIVE_ADMIN_RAW_OK=1';
  }
  if (opts.dryRun === true) return null;
  const mode = env.MCBOT_LIVE_ADMIN_MODE || 'rcon';
  if (mode === 'rcon') {
    if (!env.MCBOT_RCON_PASSWORD) {
      return 'refusing live admin rcon command without MCBOT_RCON_PASSWORD';
    }
    return null;
  }
  if (mode === 'bot-chat') {
    return 'refusing live admin bot-chat mode; use RCON for server admin commands';
  }
  return `unsupported MCBOT_LIVE_ADMIN_MODE="${mode}"; supported mode is rcon`;
}

export function rconConfigFromEnv(env = process.env) {
  return {
    host: env.MCBOT_RCON_HOST || DEFAULT_RCON_HOST,
    port: envInteger(env.MCBOT_RCON_PORT, DEFAULT_RCON_PORT),
    password: env.MCBOT_RCON_PASSWORD || '',
    timeoutMs: envInteger(env.MCBOT_RCON_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

export async function runLiveAdminPlan(plan, env = process.env, transport = sendRconCommands) {
  if (!plan?.ok) throw new Error(plan?.reason || 'invalid live admin plan');
  const dryRun = env.MCBOT_LIVE_ADMIN_DRY_RUN === '1';
  const envReason = validateLiveAdminEnv(env, { dryRun, raw: plan.raw === true });
  if (envReason) throw new Error(envReason);
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      action: plan.action,
      commands: plan.commands,
    };
  }
  const mode = env.MCBOT_LIVE_ADMIN_MODE || 'rcon';
  const config = rconConfigFromEnv(env);
  const responses = await transport({
    ...config,
    commands: plan.commands,
  });
  return {
    ok: true,
    dryRun: false,
    action: plan.action,
    mode,
    commandCount: plan.commands.length,
    responses,
  };
}

export async function sendRconCommands({ host, port, password, timeoutMs = DEFAULT_TIMEOUT_MS, commands }) {
  if (!password) throw new Error('missing rcon password');
  if (!Array.isArray(commands) || commands.length === 0) throw new Error('no rcon commands to send');
  ensureLiveClientResourceAdmissionSync({ host, port, purpose: 'rcon-live-admin' });
  assertNoUncontrolledLocalMinecraftServerSync({ host, ports: [port], denyLocalEndpoint: true });
  const socket = net.createConnection({ host, port });
  const pending = new Map();
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  let timer = null;

  const failAll = (err) => {
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readInt32LE(0);
      if (buffer.length < length + 4) return;
      const packet = decodePacket(buffer.subarray(4, length + 4));
      buffer = buffer.subarray(length + 4);
      const request = pending.get(packet.id);
      if (request && (request.expectedType === null || request.expectedType === packet.type)) {
        pending.delete(packet.id);
        request.resolve(packet);
      }
      if (packet.id === -1) failAll(new Error('rcon authentication failed'));
    }
  });
  socket.on('error', failAll);
  socket.on('close', () => failAll(new Error('rcon socket closed before all commands completed')));

  try {
    await onceConnect(socket, timeoutMs);
    const send = (type, body, expectedType = RESPONSE_TYPE) => {
      const id = nextId;
      nextId += 1;
      const packet = encodePacket(id, type, body);
      const response = waitForResponse(pending, id, expectedType);
      socket.write(packet);
      return response;
    };

    timer = setTimeout(() => {
      socket.destroy(new Error(`rcon command timed out after ${timeoutMs}ms`));
      failAll(new Error(`rcon command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    await send(AUTH_TYPE, password, COMMAND_TYPE);
    const responses = [];
    for (const command of commands) {
      const packet = await send(COMMAND_TYPE, normalizeCommand(command));
      responses.push({
        command,
        response: packet.body,
        type: packet.type,
      });
    }
    return responses;
  } finally {
    if (timer) clearTimeout(timer);
    socket.end();
  }
}

function plan(action, commands, extra = {}) {
  return {
    ok: true,
    action,
    commands: commands.map(normalizeCommand),
    ...extra,
  };
}

function summonPlan(action, entity, args) {
  const position = parsePosition(args);
  if (!position.ok) return position;
  return plan(action, [`summon ${entity} ${position.x} ${position.y} ${position.z}`]);
}

function summonZombieFireResistantPlan(args) {
  const position = parsePosition(args);
  if (!position.ok) return position;
  return plan('summon-zombie-fire-resistant', zombieFireResistantCommands(position));
}

function summonZombieWaveFireResistantPlan(args) {
  const parsed = parseCountAndPosition(args, { maxCount: 8 });
  if (!parsed.ok) return parsed;
  const summons = Array.from(
    { length: parsed.count },
    () => `summon minecraft:zombie ${parsed.x} ${parsed.y} ${parsed.z}`,
  );
  return plan('summon-zombie-wave-fire-resistant', [
    ...summons,
    `effect give @e[type=minecraft:zombie,x=${parsed.x},y=${parsed.y},z=${parsed.z},distance=..6] minecraft:fire_resistance 120 1 true`,
  ]);
}

function mcbottestSpawnZombieFireResistantPlan(args) {
  const [tag, ...positionArgs] = args;
  if (!safeTag(tag)) return { ok: false, reason: 'mcbottest-spawn-zombie-fire-resistant requires a safe tag' };
  const position = parsePosition(positionArgs);
  if (!position.ok) return position;
  return plan('mcbottest-spawn-zombie-fire-resistant', [mcbottestSpawnZombieFireResistantCommand(tag, position)]);
}

function mcbottestSpawnZombieWaveFireResistantPlan(args) {
  const [tagPrefix, ...waveArgs] = args;
  if (!safeTag(tagPrefix)) return { ok: false, reason: 'mcbottest-spawn-zombie-wave-fire-resistant requires a safe tag prefix' };
  const parsed = parseCountAndPosition(waveArgs, { maxCount: 8 });
  if (!parsed.ok) return parsed;
  const commands = Array.from(
    { length: parsed.count },
    (_, index) => mcbottestSpawnZombieFireResistantCommand(`${tagPrefix}-${index + 1}`, parsed),
  );
  return plan('mcbottest-spawn-zombie-wave-fire-resistant', commands);
}

function mcbottestSpawnZombieFireResistantCommand(tag, position) {
  return `mcbottest spawn zombie ${position.x} ${position.y} ${position.z} --tag ${tag} --effects fire_resistance:120:1 --no-burn`;
}

function killZombiesNearPlan(args) {
  if (args.length !== 3 && args.length !== 4) {
    return { ok: false, reason: 'kill-zombies-near requires x y z [radius]' };
  }
  const position = parsePosition(args.slice(0, 3));
  if (!position.ok) return position;
  const radius = args[3] == null ? '24' : parsePositiveRadius(args[3]);
  if (!radius) return { ok: false, reason: 'kill-zombies-near radius must be a positive number up to 64' };
  return plan('kill-zombies-near', [
    `execute positioned ${position.x} ${position.y} ${position.z} run minecraft:kill @e[type=minecraft:zombie,distance=..${radius}]`,
  ]);
}

function fixtureSingleHostilePlan(action, entity, args) {
  const position = parsePosition(args);
  if (!position.ok) return position;
  return plan(action, [
    'minecraft:kill @e[type=!player]',
    `summon ${entity} ${position.x} ${position.y} ${position.z}`,
  ]);
}

function fixtureSingleZombieFireResistantPlan(args) {
  const position = parsePosition(args);
  if (!position.ok) return position;
  return plan('fixture-single-zombie-fire-resistant', [
    'minecraft:kill @e[type=!player]',
    ...zombieFireResistantCommands(position),
  ]);
}

function zombieFireResistantCommands(position) {
  const selector = `@e[type=minecraft:zombie,x=${position.x},y=${position.y},z=${position.z},distance=..5,sort=nearest,limit=1]`;
  return [
    `summon minecraft:zombie ${position.x} ${position.y} ${position.z}`,
    `effect give ${selector} minecraft:fire_resistance 120 1 true`,
  ];
}

function givePlan(args) {
  const [player, item, countText = '1'] = args;
  if (!safeName(player)) return { ok: false, reason: 'give requires a safe player name' };
  if (!safeItem(item)) return { ok: false, reason: 'give requires an item id like minecraft:stone or stone' };
  const count = parsePositiveInteger(countText);
  if (!count) return { ok: false, reason: 'give count must be a positive integer' };
  return plan('give', [`give ${player} ${item} ${count}`]);
}

function teleportPlayerPlan(args) {
  const [player, ...positionArgs] = args;
  if (!safeName(player)) return { ok: false, reason: 'teleport-player requires a safe player name' };
  const position = parsePosition(positionArgs);
  if (!position.ok) return position;
  return plan('teleport-player', [`minecraft:tp ${player} ${position.x} ${position.y} ${position.z}`]);
}

function deathRecoveryFallPlan(args) {
  const [player, amountText = '100'] = args;
  if (!safeName(player)) return { ok: false, reason: 'death-recovery-fall requires a safe player name' };
  const amount = parsePositiveAmount(amountText);
  if (!amount) return { ok: false, reason: 'death-recovery-fall amount must be a positive number up to 10000' };
  return plan('death-recovery-fall', [
    'gamerule keep_inventory false',
    'gamerule fall_damage true',
    `minecraft:damage ${player} ${amount} minecraft:fall`,
  ]);
}

function setDoMobSpawningPlan(args) {
  if (args.length !== 1 || !['true', 'false'].includes(String(args[0]).toLowerCase())) {
    return { ok: false, reason: 'set-do-mob-spawning requires true or false' };
  }
  return plan('set-do-mob-spawning', [`gamerule spawn_monsters ${String(args[0]).toLowerCase()}`]);
}

function rawPlan(args) {
  const command = normalizeCommand(args.join(' '));
  if (!command) return { ok: false, reason: 'raw requires a command string' };
  return plan('raw', [command], { raw: true });
}

function parsePosition(args) {
  if (args.length !== 3) return { ok: false, reason: 'position requires x y z' };
  const [x, y, z] = args.map((value) => Number(value));
  if (![x, y, z].every(Number.isFinite)) return { ok: false, reason: 'position coordinates must be finite numbers' };
  return { ok: true, x: formatCoordinate(x), y: formatCoordinate(y), z: formatCoordinate(z) };
}

function parseCountAndPosition(args, opts = {}) {
  if (args.length !== 4) return { ok: false, reason: 'counted position requires count x y z' };
  const count = parsePositiveInteger(args[0]);
  const maxCount = opts.maxCount ?? 16;
  if (!count || count > maxCount) return { ok: false, reason: `count must be a positive integer up to ${maxCount}` };
  const position = parsePosition(args.slice(1));
  if (!position.ok) return position;
  return { ok: true, count, ...position };
}

function safeName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(value);
}

function safeItem(value) {
  return typeof value === 'string' && /^[a-z0-9_.:-]+$/.test(value);
}

function safeTag(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value);
}

function parsePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parsePositiveAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 10000) return null;
  return formatCoordinate(number);
}

function parsePositiveRadius(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 64) return null;
  return formatCoordinate(number);
}

function formatCoordinate(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

function normalizeCommand(command) {
  return String(command || '').trim().replace(/^\/+/, '');
}

function envInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function encodePacket(id, type, body) {
  const bodyBuffer = Buffer.from(String(body), 'utf8');
  const length = 4 + 4 + bodyBuffer.length + 2;
  const packet = Buffer.alloc(length + 4);
  packet.writeInt32LE(length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  bodyBuffer.copy(packet, 12);
  packet.writeInt8(0, 12 + bodyBuffer.length);
  packet.writeInt8(0, 13 + bodyBuffer.length);
  return packet;
}

function decodePacket(packet) {
  const id = packet.readInt32LE(0);
  const type = packet.readInt32LE(4);
  const body = packet.subarray(8, Math.max(8, packet.length - 2)).toString('utf8');
  return { id, type, body };
}

function waitForResponse(pending, id, expectedType) {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, expectedType });
  });
}

function onceConnect(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`rcon connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function usageText() {
  return 'usage: node scripts/live-admin.js <clear-non-players|summon-zombie x y z|summon-zombie-fire-resistant x y z|summon-zombie-wave-fire-resistant count x y z|mcbottest-spawn-zombie-fire-resistant tag x y z|mcbottest-spawn-zombie-wave-fire-resistant tagPrefix count x y z|kill-zombies-near x y z [radius]|query-do-mob-spawning|set-do-mob-spawning true|false|summon-spider x y z|fixture-single-zombie x y z|fixture-single-spider x y z|death-recovery-fall player [amount]|give player item count|teleport-player player x y z|raw command...>';
}
