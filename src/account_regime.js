export const ACCOUNT_REGIMES = Object.freeze({
  TEST: 'test',
  PRODUCTION: 'production',
});

export const DEFAULT_USER_ELSEWHERE_KICK_COOLDOWN_MS = 60000;

const DEFAULT_TEST_USERNAME = 'MCBot';
const DEFAULT_TEST_AUTH = 'offline';
const PRODUCTION_AUTH = 'microsoft';

const USER_ELSEWHERE_KICK_PATTERNS = Object.freeze([
  /logged in from another location/i,
  /logged in elsewhere/i,
  /you logged in from another location/i,
  /duplicate login/i,
  /already connected/i,
  /multiplayer\.disconnect\.(duplicate_login|logged_in_other_location)/i,
]);

export function normalizeAccountRegime(value) {
  const normalized = String(value || ACCOUNT_REGIMES.TEST).trim().toLowerCase();
  return normalized === ACCOUNT_REGIMES.PRODUCTION ? ACCOUNT_REGIMES.PRODUCTION : ACCOUNT_REGIMES.TEST;
}

export function normalizeAccountConfig(account = {}) {
  const regime = normalizeAccountRegime(account.regime);
  const cooldown = positiveFinite(account.userElsewhereKickCooldownMs)
    ?? DEFAULT_USER_ELSEWHERE_KICK_COOLDOWN_MS;
  return {
    regime,
    userElsewhereKickCooldownMs: cooldown,
    ...(account.microsoftProfileCacheDir ? { microsoftProfileCacheDir: account.microsoftProfileCacheDir } : {}),
  };
}

export function resolveMinecraftAccountConfig(minecraft = {}, account = {}) {
  const normalizedAccount = normalizeAccountConfig(account);
  const resolvedMinecraft = { ...minecraft };

  if (normalizedAccount.regime === ACCOUNT_REGIMES.PRODUCTION) {
    resolvedMinecraft.auth = PRODUCTION_AUTH;
    if (normalizedAccount.microsoftProfileCacheDir) {
      resolvedMinecraft.profilesFolder = normalizedAccount.microsoftProfileCacheDir;
    }
  } else {
    resolvedMinecraft.auth = DEFAULT_TEST_AUTH;
    resolvedMinecraft.username = resolvedMinecraft.username || DEFAULT_TEST_USERNAME;
    delete resolvedMinecraft.profilesFolder;
  }

  return {
    account: normalizedAccount,
    minecraft: resolvedMinecraft,
  };
}

export function buildMineflayerOptions(minecraft = {}, account = {}) {
  const resolved = resolveMinecraftAccountConfig(minecraft, account);
  const safety = validateAccountRuntimeConfig(resolved.minecraft, resolved.account);
  if (!safety.ok) {
    throw new Error(safety.reason);
  }
  return {
    host: resolved.minecraft.host,
    port: resolved.minecraft.port,
    version: resolved.minecraft.version,
    username: resolved.minecraft.username,
    auth: resolved.minecraft.auth,
    ...(resolved.minecraft.profilesFolder ? { profilesFolder: resolved.minecraft.profilesFolder } : {}),
  };
}

export function validateAccountRuntimeConfig(minecraft = {}, account = {}) {
  const regime = normalizeAccountRegime(account.regime);
  if (regime === ACCOUNT_REGIMES.TEST) {
    if (minecraft.auth !== DEFAULT_TEST_AUTH) {
      return { ok: false, reason: 'Regime A/test requires offline auth' };
    }
    return { ok: true };
  }

  if (minecraft.auth !== PRODUCTION_AUTH) {
    return { ok: false, reason: 'Regime B/production requires microsoft auth' };
  }
  if (!minecraft.username || String(minecraft.username).trim().toLowerCase() === DEFAULT_TEST_USERNAME.toLowerCase()) {
    return {
      ok: false,
      reason: 'Regime B/production requires an explicit user Microsoft account username; default MCBot is Regime A only',
    };
  }
  return { ok: true };
}

export function createUserElsewhereKickGuard(account = {}, opts = {}) {
  const normalizedAccount = normalizeAccountConfig(account);
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;
  let cooldownUntilMs = 0;
  let lastKick = null;

  return {
    regime: normalizedAccount.regime,
    noteKick(reason, nowMs = nowFn()) {
      const matched = normalizedAccount.regime === ACCOUNT_REGIMES.PRODUCTION && isUserElsewhereKickReason(reason);
      if (!matched) {
        return {
          matched: false,
          regime: normalizedAccount.regime,
          reconnectAllowed: nowMs >= cooldownUntilMs,
          cooldownRemainingMs: Math.max(0, cooldownUntilMs - nowMs),
        };
      }
      cooldownUntilMs = nowMs + normalizedAccount.userElsewhereKickCooldownMs;
      lastKick = {
        reason: stringifyKickReason(reason),
        atMs: nowMs,
        cooldownUntilMs,
      };
      return {
        matched: true,
        regime: normalizedAccount.regime,
        reason: lastKick.reason,
        cooldownUntilMs,
        cooldownMs: normalizedAccount.userElsewhereKickCooldownMs,
        reconnectAllowed: false,
        cooldownRemainingMs: normalizedAccount.userElsewhereKickCooldownMs,
      };
    },
    reconnectStatus(nowMs = nowFn()) {
      return {
        regime: normalizedAccount.regime,
        reconnectAllowed: nowMs >= cooldownUntilMs,
        cooldownUntilMs: cooldownUntilMs || null,
        cooldownRemainingMs: Math.max(0, cooldownUntilMs - nowMs),
        lastKick,
      };
    },
  };
}

export function isUserElsewhereKickReason(reason) {
  const text = stringifyKickReason(reason);
  return USER_ELSEWHERE_KICK_PATTERNS.some((pattern) => pattern.test(text));
}

export function stringifyKickReason(reason) {
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function positiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export default {
  ACCOUNT_REGIMES,
  DEFAULT_USER_ELSEWHERE_KICK_COOLDOWN_MS,
  normalizeAccountRegime,
  normalizeAccountConfig,
  resolveMinecraftAccountConfig,
  buildMineflayerOptions,
  validateAccountRuntimeConfig,
  createUserElsewhereKickGuard,
  isUserElsewhereKickReason,
  stringifyKickReason,
};
