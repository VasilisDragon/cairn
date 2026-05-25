import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMineflayerOptions,
  createUserElsewhereKickGuard,
  isUserElsewhereKickReason,
  normalizeAccountConfig,
  resolveMinecraftAccountConfig,
  validateAccountRuntimeConfig,
} from '../../src/account_regime.js';

test('account config defaults to Regime A offline MCBot', () => {
  const resolved = resolveMinecraftAccountConfig({
    host: 'localhost',
    port: 25565,
    version: '1.21.11',
    username: 'MCBot',
    auth: 'microsoft',
  }, {});

  assert.deepEqual(resolved.account, {
    regime: 'test',
    userElsewhereKickCooldownMs: 60000,
  });
  assert.equal(resolved.minecraft.username, 'MCBot');
  assert.equal(resolved.minecraft.auth, 'offline');
});

test('Regime B selects Microsoft auth and optional Mineflayer token cache', () => {
  const resolved = resolveMinecraftAccountConfig({
    host: 'example.test',
    port: 25565,
    version: '1.21.11',
    username: 'user@example.com',
    auth: 'offline',
  }, {
    regime: 'production',
    userElsewhereKickCooldownMs: 30000,
    microsoftProfileCacheDir: 'D:\\mc-cache',
  });

  assert.equal(resolved.account.regime, 'production');
  assert.equal(resolved.account.userElsewhereKickCooldownMs, 30000);
  assert.equal(resolved.minecraft.auth, 'microsoft');
  assert.equal(resolved.minecraft.profilesFolder, 'D:\\mc-cache');
  assert.deepEqual(buildMineflayerOptions(resolved.minecraft, resolved.account), {
    host: 'example.test',
    port: 25565,
    version: '1.21.11',
    username: 'user@example.com',
    auth: 'microsoft',
    profilesFolder: 'D:\\mc-cache',
  });
});

test('Regime B refuses the default MCBot offline-account username', () => {
  const resolved = resolveMinecraftAccountConfig({
    host: 'localhost',
    port: 25565,
    version: '1.21.11',
    username: 'MCBot',
    auth: 'offline',
  }, {
    regime: 'production',
  });

  const status = validateAccountRuntimeConfig(resolved.minecraft, resolved.account);
  assert.equal(status.ok, false);
  assert.match(status.reason, /MCBot is Regime A only/);
  assert.throws(() => buildMineflayerOptions(resolved.minecraft, resolved.account), /Regime A only/);
});

test('Regime-B user-elsewhere kick cooldown is production-only', () => {
  assert.equal(isUserElsewhereKickReason('You logged in from another location'), true);

  const testGuard = createUserElsewhereKickGuard(normalizeAccountConfig({ regime: 'test' }), { now: () => 1000 });
  const ignored = testGuard.noteKick('You logged in from another location');
  assert.equal(ignored.matched, false);
  assert.equal(testGuard.reconnectStatus(1000).reconnectAllowed, true);

  const productionGuard = createUserElsewhereKickGuard({
    regime: 'production',
    userElsewhereKickCooldownMs: 60000,
  }, { now: () => 1000 });
  const matched = productionGuard.noteKick('You logged in from another location', 1000);
  assert.equal(matched.matched, true);
  assert.equal(matched.reconnectAllowed, false);
  assert.equal(matched.cooldownUntilMs, 61000);
  assert.equal(productionGuard.reconnectStatus(60000).reconnectAllowed, false);
  assert.equal(productionGuard.reconnectStatus(61000).reconnectAllowed, true);
});
