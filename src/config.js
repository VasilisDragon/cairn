// Loads config from config.json + keys.json + env, in that order (later overrides earlier).
// Both keys.json and config.json are gitignored. Examples are committed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMinecraftAccountConfig } from './account_regime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function tryReadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`[config] failed to parse ${p}:`, err.message);
    return null;
  }
}

function tryReadDotenv(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  const text = fs.readFileSync(p, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

// Defaults: same shape as config.example.json
const DEFAULTS = {
  account: {
    regime: 'test',
    userElsewhereKickCooldownMs: 60000,
  },
  minecraft: {
    host: 'localhost',
    port: 25565,
    version: '1.21.11',
    username: 'MCBot',
    auth: 'offline',
  },
  reactive: {
    lowHealthFleeThreshold: 8,
    criticalHealthLogoutThreshold: 4,
    hostileScanRadius: 16,
    engageOverFlee: false,
    autoEatStartAt: 18,
    autoEatPriority: 'saturation',
    // How many reactive preempts can hit the SAME fungible target (collect
    // block, goto{block}) before we exclude it and pick another.
    maxInterruptionsPerTarget: 3,
    // After reactive releases, the executor waits this long with the
    // pathfinder idle before resuming the next skill. Separate knob from
    // executor.skillTimeoutMs and any advisor timing.
    resumeDebounceMs: 1000,
    // Historical advisory range for flee behavior. The current custom
    // FleeGoal keeps running until hostileExitRadius hysteresis clears.
    fleeRange: 16,
    // Reactive flee uses a custom FleeGoal whose isEnd() never returns true
    // (so the bot never stops fleeing mid-threat). FleeGoal.hasChanged()
    // triggers re-plans whenever the live entity has moved more than this
    // many blocks from the cached position used for the current path. Small
    // values keep paths fresh against the live entity at higher A* cost;
    // larger values are coarser. 4 is a starting point.
    fleeReplanThresholdBlocks: 4,
    // If a hostile closes to melee range while the bot is already fleeing,
    // refresh the flee goal on a short timer. This handles terrain pinning
    // where the hostile has not moved far enough to trigger FleeGoal.hasChanged
    // but the current partial path is no longer creating separation.
    fleeCloseRepathDistance: 3,
    fleeCloseRepathMs: 500,
    // Hysteresis for the FLEEING -> NORMAL transition. While FLEEING, the
    // threat must be outside hostileExitRadius continuously for
    // hostileExitDebounceMs before we transition out. Prevents churn for a
    // mob hovering at hostileScanRadius (the enter threshold). Exit radius is
    // intentionally large enough to break ordinary zombie-style pursuit
    // pressure instead of stopping right at the edge of re-aggro distance.
    // Vanilla zombies can pursue from roughly the mid-30 block range, so the
    // default keeps a buffer beyond that before survival gives control back.
    hostileExitRadius: 42,
    hostileExitDebounceMs: 500,
    // If engageOverFlee is enabled for private/local combat tests, require
    // at least this many equipped armor points before melee engagement.
    minArmorScoreToEngage: 6,
    // Conservative private/local PvM guardrail: deterministic melee engage is
    // single-target by default. Groups stay in flee/disengage behavior until a
    // stronger threat budget exists.
    maxMeleeEngageThreatCount: 1,
    // Conservative private/local PvM guardrail: require an estimated survival
    // margin before melee engagement. The estimate is intentionally coarse and
    // errs toward fleeing; it is substrate context, not perfect combat math.
    minMeleeSurvivalSecondsToEngage: 3,
    // Conservative private/local PvM guardrail: require estimated kill time to
    // leave this many seconds of low-health margin before melee engagement.
    minMeleeKillMarginSecondsToEngage: 1,
    // Rolling window for observed health-loss pressure. This lets combat
    // decisions account for recent damage ticks without treating a single old
    // hit as permanent danger.
    recentDamageWindowMs: 10000,
    // Optional extra private/local combat guardrail: equip/require a shield
    // before melee engagement. Shield timing/blocking remains separate.
    requireShieldToEngage: false,
    // Optional private/local combat guardrail: actively use an equipped
    // off-hand shield against close melee/ranged/creeper pressure.
    shieldBlockingEnabled: false,
    shieldBlockDistance: 4.5,
    shieldReleaseDistance: 7,
    // Optional private/local combat prep: equip bow/crossbow plus arrows for
    // creeper/ranged-hostile pressure. This never enables player combat.
    rangedCombatPrepEnabled: false,
    // Optional private/local ranged firing. Disabled by default and gated by
    // ammo, held ranged weapon, positive line-of-sight, and safe distance.
    rangedCombatFireEnabled: false,
    rangedCombatFireMinDistance: 7,
    rangedCombatFireMaxDistance: 16,
    rangedCombatFireShotDrawMs: 900,
    rangedCombatFireCooldownMs: 1500,
    // Bounded post-release observation window. This reports whether the
    // ranged target disappeared, took damage, or still needs follow-up.
    rangedCombatFireVerifyMs: 250,
    // Bound unresolved ranged follow-up shots per target. A target that
    // remains present/damaged after this many shots is held in flee state
    // instead of spending arrows forever.
    rangedCombatFireMaxFollowUpShots: 3,
    rangedCombatFireFollowUpWindowMs: 10000,
    // Optional private/local survival bridge from deterministic consumable
    // recommendations into bounded item use during hostile pressure.
    reactiveConsumablesEnabled: false,
    reactiveConsumablePotions: false,
    reactiveConsumableGoldenApples: true,
    reactiveConsumableEnchantedGoldenApples: false,
    reactiveConsumableCooldownMs: 5000,
    // Optional private/local hazard response: when lava/fire/magma is detected
    // near the bot, use a held/inventory water bucket at the bot's feet.
    // Disabled by default; the Nether is always refused at runtime.
    waterBucketHazardResponseEnabled: false,
    waterBucketHazardCooldownMs: 3000,
    // When the opt-in water-bucket hazard response successfully places
    // water, try to recover that water once the hazard clears.
    waterBucketPickupEnabled: true,
    waterBucketPickupMaxDistance: 4.5,
  },
  advisor: {
    tickIntervalMs: 5000,
    maxPlanRetries: 2,
    // Per-session advisor API ceiling. DeepSeek stays opt-in; once calls are
    // allowed, this bounds spend and drives fallback/logout policy.
    costUsdMax: 2.00,
    // Conservative default accounting rates for budget enforcement. These are
    // configurable because provider prices can change without code changes.
    promptUsdPerMillionTokens: 2.00,
    completionUsdPerMillionTokens: 8.00,
    snapshotHostileCap: 5,
    snapshotInventoryCap: 40,
    // Compact executor/reactive event history exposed in advisor snapshots.
    // This is recent structured context, not raw logs.
    snapshotRecentEventsCap: 12,
  },
  executor: {
    skillTimeoutMs: 120000,
    // Container close is cleanup; bound it so a hung GUI close does not hold
    // a skill until the much larger skill timeout.
    containerCloseTimeoutMs: 5000,
    // Container open is a Mineflayer GUI operation; bound it before the
    // broader skill timeout so storage/deposit failures stay actionable.
    containerOpenTimeoutMs: 10000,
    // Container item transfers can also hang on server/GUI state; keep them
    // operation-bounded so skills return structured failures.
    containerTransferTimeoutMs: 10000,
    // Crafting is a Mineflayer operation that can wait on server/GUI state;
    // bound each craft call separately from the full skill timeout.
    craftOperationTimeoutMs: 30000,
    // Equipping can wait on inventory/server state; keep it bounded as its
    // own operation.
    equipOperationTimeoutMs: 10000,
    // Consuming food/potions/golden apples waits on server item-use state;
    // bound it separately so a bad consume does not hold the whole skill.
    consumeOperationTimeoutMs: 5000,
    // Placing blocks/buckets can wait on server state; bound it separately so
    // reactive hazard handling does not hang on a bad placement.
    placeBlockOperationTimeoutMs: 10000,
    // Ranged shots use normal look/use/release mechanics; bound each step so
    // a bad item-use state cannot pin reactive combat.
    rangedShotOperationTimeoutMs: 5000,
    // Spawn/respawn chunk readiness should not block all world-querying
    // skills forever if Mineflayer's waitForChunksToLoad never settles.
    chunkReadyTimeoutMs: 30000,
    // Resume waits should not hang forever if reactive has released but the
    // pathfinder never reports idle. This does not apply while reactive is
    // actively paused/owning survival control.
    resumeGateTimeoutMs: 30000,
    // After a log collection request reaches its count, the collect skill may
    // keep working the active tree to avoid floating leftovers. Bound that
    // cleanup so optional tree finishing cannot consume the whole skill timer.
    collectTreeCleanupFailureLimit: 2,
    collectTreeCleanupTargetTimeoutMs: 30000,
    collectTreeCleanupMinRemainingMs: 15000,
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
  },
  humanization: {
    // C1 is opt-in. When disabled, installed wrappers pass straight through.
    enabled: false,
    seed: 'mcbot-humanize-v1',
    mood: 'efficient',
    aimMinMs: 100,
    aimMaxMs: 400,
    aimFrameMs: 50,
    aimJitterDegrees: 2,
    maxRotationDegreesPerSecond: 720,
    maxRotationDegreesPerTick: 35,
    reactionMedianMs: 250,
    reactionP95Ms: 500,
    criticalReactionMs: 0,
    clickMinIntervalMs: 70,
    cadenceJitterMs: 45,
    attackReach: 4.5,
    interactReach: 5.0,
    moodDriftStep: 0.025,
    interActionVariationEnabled: true,
    interActionMinMs: 60,
    interActionMaxMs: 260,
    interActionLookChance: 0.22,
    interActionMicroRepositionChance: 0.10,
    interActionMicroRepositionMs: 140,
    // Idle micro-behaviors only run when MCBOT_HUMANIZE=1 and the runtime is
    // genuinely idle. They are never used while a skill or survival action is
    // active.
    idleMicroBehaviorEnabled: true,
    idleMinMs: 12000,
    idleMaxMs: 28000,
    idleHopMs: 180,
    idleInventoryFlipMs: 550,
    // Active navigation entropy keeps the original pathfinder goal semantics
    // and only biases eligible static GoalNear route scoring by a tiny amount.
    pathEntropyEnabled: true,
    pathEntropyMaxOffsetBlocks: 1,
    pathEntropyMinRange: 1,
  },
  control: {
    logoutCommand: '!logout',
    authorizedUsers: [],
  },
  logging: {
    level: 'info',
    pretty: true,
  },
};

function deepMerge(a, b) {
  if (b === undefined || b === null) return a;
  if (typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
}

const fileConfig = tryReadJson(path.join(ROOT, 'config.json')) || {};
const keys = tryReadJson(path.join(ROOT, 'keys.json')) || {};
const dotenvVars = tryReadDotenv(path.join(ROOT, '.env'));

// env > .env > keys.json
const envBag = { ...keys, ...dotenvVars, ...process.env };

const envOverride = {
  account: {
    ...(envBag.MCBOT_ACCOUNT_REGIME && { regime: envBag.MCBOT_ACCOUNT_REGIME }),
    ...(positiveNumber(envBag.MCBOT_USER_ELSEWHERE_KICK_COOLDOWN_MS) !== null
      && { userElsewhereKickCooldownMs: positiveNumber(envBag.MCBOT_USER_ELSEWHERE_KICK_COOLDOWN_MS) }),
    ...(envBag.MCBOT_MICROSOFT_PROFILE_CACHE_DIR && {
      microsoftProfileCacheDir: envBag.MCBOT_MICROSOFT_PROFILE_CACHE_DIR,
    }),
  },
  minecraft: {
    ...(envBag.MC_HOST && { host: envBag.MC_HOST }),
    ...(envBag.MC_PORT && { port: Number(envBag.MC_PORT) }),
    ...(envBag.MC_VERSION && { version: envBag.MC_VERSION }),
    ...(envBag.MC_USERNAME && { username: envBag.MC_USERNAME }),
    ...(envBag.MC_AUTH && { auth: envBag.MC_AUTH }),
  },
  advisor: {
    ...(positiveNumber(envBag.MCBOT_ADVISOR_COST_USD_MAX) !== null
      && { costUsdMax: positiveNumber(envBag.MCBOT_ADVISOR_COST_USD_MAX) }),
  },
  humanization: {
    ...(envFlag(envBag.MCBOT_HUMANIZE) !== null && { enabled: envFlag(envBag.MCBOT_HUMANIZE) }),
    ...(envBag.MCBOT_HUMANIZE_MOOD && { mood: envBag.MCBOT_HUMANIZE_MOOD }),
    ...(envFlag(envBag.MCBOT_HUMANIZE_IDLE) !== null
      && { idleMicroBehaviorEnabled: envFlag(envBag.MCBOT_HUMANIZE_IDLE) }),
    ...(positiveNumber(envBag.MCBOT_HUMANIZE_IDLE_MIN_MS) !== null
      && { idleMinMs: positiveNumber(envBag.MCBOT_HUMANIZE_IDLE_MIN_MS) }),
    ...(positiveNumber(envBag.MCBOT_HUMANIZE_IDLE_MAX_MS) !== null
      && { idleMaxMs: positiveNumber(envBag.MCBOT_HUMANIZE_IDLE_MAX_MS) }),
    ...(envFlag(envBag.MCBOT_HUMANIZE_PATH_ENTROPY) !== null
      && { pathEntropyEnabled: envFlag(envBag.MCBOT_HUMANIZE_PATH_ENTROPY) }),
    ...(positiveNumber(envBag.MCBOT_HUMANIZE_PATH_ENTROPY_MAX_OFFSET) !== null
      && { pathEntropyMaxOffsetBlocks: positiveNumber(envBag.MCBOT_HUMANIZE_PATH_ENTROPY_MAX_OFFSET) }),
    ...(positiveNumber(envBag.MCBOT_HUMANIZE_PATH_ENTROPY_MIN_RANGE) !== null
      && { pathEntropyMinRange: positiveNumber(envBag.MCBOT_HUMANIZE_PATH_ENTROPY_MIN_RANGE) }),
  },
  control: {
    ...(envBag.MCBOT_LOGOUT_COMMAND && { logoutCommand: envBag.MCBOT_LOGOUT_COMMAND }),
    ...(envBag.MCBOT_AUTHORIZED_USERS && { authorizedUsers: splitList(envBag.MCBOT_AUTHORIZED_USERS) }),
  },
};

const config = deepMerge(deepMerge(DEFAULTS, fileConfig), envOverride);
const accountResolved = resolveMinecraftAccountConfig(config.minecraft, config.account);
config.account = accountResolved.account;
config.minecraft = accountResolved.minecraft;

config.deepseek = {
  apiKey: envBag.DEEPSEEK_API_KEY || config.deepseek?.apiKey || null,
  baseUrl: envBag.DEEPSEEK_BASE_URL || config.deepseek?.baseUrl || 'https://api.deepseek.com',
  model: envBag.DEEPSEEK_MODEL || config.deepseek?.model || 'deepseek-v4-pro',
};

export default config;

function positiveNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function envFlag(value) {
  if (value === undefined || value === null || value === '') return null;
  if (['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())) return false;
  return null;
}
