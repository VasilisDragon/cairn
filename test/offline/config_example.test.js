import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const example = JSON.parse(fs.readFileSync(new URL('../../config.example.json', import.meta.url), 'utf8'));

test('config example documents Regime A default account selector', () => {
  assert.equal(example.account.regime, 'test');
  assert.equal(example.account.userElsewhereKickCooldownMs, 60000);
  assert.equal(example.minecraft.username, 'MCBot');
  assert.equal(example.minecraft.auth, 'offline');
});

test('config example documents user control logout defaults', () => {
  assert.equal(example.control.logoutCommand, '!logout');
  assert.deepEqual(example.control.authorizedUsers, []);
});

test('config example documents executor timeout knobs', () => {
  const executor = example.executor;
  for (const key of [
    'skillTimeoutMs',
    'containerCloseTimeoutMs',
    'containerOpenTimeoutMs',
    'containerTransferTimeoutMs',
    'craftOperationTimeoutMs',
    'equipOperationTimeoutMs',
    'consumeOperationTimeoutMs',
    'placeBlockOperationTimeoutMs',
    'chunkReadyTimeoutMs',
    'resumeGateTimeoutMs',
    'collectTreeCleanupFailureLimit',
    'collectTreeCleanupTargetTimeoutMs',
    'collectTreeCleanupMinRemainingMs',
  ]) {
    assert.equal(typeof executor[key], 'number', `${key} should be documented as a number`);
    assert.ok(executor[key] > 0, `${key} should be positive`);
  }
});

test('config example documents reactive combat armor gate', () => {
  assert.equal(typeof example.reactive.minArmorScoreToEngage, 'number');
  assert.ok(example.reactive.minArmorScoreToEngage >= 0);
});

test('config example documents reactive combat threat-count gate', () => {
  assert.equal(typeof example.reactive.maxMeleeEngageThreatCount, 'number');
  assert.ok(example.reactive.maxMeleeEngageThreatCount >= 1);
});

test('config example documents reactive combat survival-margin gate', () => {
  assert.equal(typeof example.reactive.minMeleeSurvivalSecondsToEngage, 'number');
  assert.ok(example.reactive.minMeleeSurvivalSecondsToEngage >= 0);
});

test('config example documents reactive combat kill-window gate', () => {
  assert.equal(typeof example.reactive.minMeleeKillMarginSecondsToEngage, 'number');
  assert.ok(example.reactive.minMeleeKillMarginSecondsToEngage >= 0);
});

test('config example documents reactive recent-damage pressure window', () => {
  assert.equal(typeof example.reactive.recentDamageWindowMs, 'number');
  assert.ok(example.reactive.recentDamageWindowMs >= 1000);
});

test('config example documents advisor recent-event cap', () => {
  assert.equal(typeof example.advisor.snapshotRecentEventsCap, 'number');
  assert.ok(example.advisor.snapshotRecentEventsCap >= 1);
});

test('config example documents advisor cost ceiling defaults', () => {
  assert.equal(example.advisor.costUsdMax, 2.0);
  assert.equal(typeof example.advisor.promptUsdPerMillionTokens, 'number');
  assert.equal(typeof example.advisor.completionUsdPerMillionTokens, 'number');
  assert.ok(example.advisor.promptUsdPerMillionTokens > 0);
  assert.ok(example.advisor.completionUsdPerMillionTokens > 0);
});

test('config example documents the verified DeepSeek frontier default', () => {
  assert.equal(example.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(example.deepseek.model, 'deepseek-v4-pro');
});

test('config example documents opt-in humanization defaults and vanilla limits', () => {
  assert.equal(example.humanization.enabled, false);
  assert.equal(example.humanization.seed, 'mcbot-humanize-v1');
  assert.equal(example.humanization.mood, 'efficient');
  for (const key of [
    'aimMinMs',
    'aimMaxMs',
    'aimFrameMs',
    'aimJitterDegrees',
    'maxRotationDegreesPerSecond',
    'maxRotationDegreesPerTick',
    'reactionMedianMs',
    'reactionP95Ms',
    'criticalReactionMs',
    'clickMinIntervalMs',
    'cadenceJitterMs',
    'attackReach',
    'interactReach',
    'moodDriftStep',
    'interActionMinMs',
    'interActionMaxMs',
    'interActionLookChance',
    'interActionMicroRepositionChance',
    'interActionMicroRepositionMs',
    'idleMinMs',
    'idleMaxMs',
    'idleHopMs',
    'idleInventoryFlipMs',
    'pathEntropyMaxOffsetBlocks',
    'pathEntropyMinRange',
  ]) {
    assert.equal(typeof example.humanization[key], 'number', `${key} should be documented as a number`);
    assert.ok(example.humanization[key] >= 0, `${key} should be non-negative`);
  }
  assert.equal(example.humanization.interActionVariationEnabled, true);
  assert.ok(example.humanization.interActionMaxMs >= example.humanization.interActionMinMs);
  assert.ok(example.humanization.interActionLookChance >= 0 && example.humanization.interActionLookChance <= 1);
  assert.ok(
    example.humanization.interActionMicroRepositionChance >= 0
      && example.humanization.interActionMicroRepositionChance <= 1,
  );
  assert.equal(example.humanization.idleMicroBehaviorEnabled, true);
  assert.equal(example.humanization.pathEntropyEnabled, true);
  assert.ok(example.humanization.idleMaxMs >= example.humanization.idleMinMs);
  assert.equal(example.humanization.maxRotationDegreesPerSecond, 720);
  assert.equal(example.humanization.maxRotationDegreesPerTick, 35);
  assert.equal(example.humanization.clickMinIntervalMs, 70);
  assert.equal(example.humanization.attackReach, 4.5);
  assert.equal(example.humanization.interactReach, 5.0);
});

test('config example keeps hostile flee exit beyond ordinary zombie pursuit range', () => {
  assert.equal(typeof example.reactive.hostileExitRadius, 'number');
  assert.ok(example.reactive.hostileExitRadius >= 40);
});

test('config example documents close-threat flee replanning', () => {
  assert.equal(typeof example.reactive.fleeCloseRepathDistance, 'number');
  assert.equal(typeof example.reactive.fleeCloseRepathMs, 'number');
  assert.ok(example.reactive.fleeCloseRepathDistance > 0);
  assert.ok(example.reactive.fleeCloseRepathMs >= 100);
});

test('config example documents reactive combat shield gate', () => {
  assert.equal(typeof example.reactive.requireShieldToEngage, 'boolean');
});

test('config example documents reactive combat shield blocking', () => {
  assert.equal(typeof example.reactive.shieldBlockingEnabled, 'boolean');
  assert.equal(typeof example.reactive.shieldBlockDistance, 'number');
  assert.equal(typeof example.reactive.shieldReleaseDistance, 'number');
  assert.ok(example.reactive.shieldReleaseDistance >= example.reactive.shieldBlockDistance);
});

test('config example documents reactive ranged combat prep', () => {
  assert.equal(typeof example.reactive.rangedCombatPrepEnabled, 'boolean');
  assert.equal(typeof example.reactive.rangedCombatFireEnabled, 'boolean');
  assert.ok(example.reactive.rangedCombatFireMinDistance > 0);
  assert.ok(example.reactive.rangedCombatFireMaxDistance >= example.reactive.rangedCombatFireMinDistance);
  assert.ok(example.reactive.rangedCombatFireShotDrawMs > 0);
  assert.ok(example.reactive.rangedCombatFireCooldownMs > 0);
  assert.ok(example.reactive.rangedCombatFireVerifyMs >= 0);
  assert.ok(example.reactive.rangedCombatFireMaxFollowUpShots >= 1);
  assert.ok(example.reactive.rangedCombatFireFollowUpWindowMs >= example.reactive.rangedCombatFireVerifyMs);
  assert.ok(example.executor.rangedShotOperationTimeoutMs > 0);
});

test('config example documents opt-in player threat scanning', () => {
  assert.equal(example.reactive.playerThreatScanEnabled, false);
});

test('config example documents reactive consumable bridge', () => {
  assert.equal(typeof example.reactive.reactiveConsumablesEnabled, 'boolean');
  assert.equal(typeof example.reactive.reactiveConsumablePotions, 'boolean');
  assert.equal(typeof example.reactive.reactiveConsumableGoldenApples, 'boolean');
  assert.equal(typeof example.reactive.reactiveConsumableEnchantedGoldenApples, 'boolean');
  assert.equal(typeof example.reactive.reactiveConsumableCooldownMs, 'number');
  assert.ok(example.reactive.reactiveConsumableCooldownMs >= 0);
});

test('config example documents reactive water bucket hazard response', () => {
  assert.equal(typeof example.reactive.waterBucketHazardResponseEnabled, 'boolean');
  assert.equal(typeof example.reactive.waterBucketHazardCooldownMs, 'number');
  assert.ok(example.reactive.waterBucketHazardCooldownMs >= 0);
  assert.equal(typeof example.reactive.waterBucketPickupEnabled, 'boolean');
  assert.equal(typeof example.reactive.waterBucketPickupMaxDistance, 'number');
  assert.ok(example.reactive.waterBucketPickupMaxDistance > 0);
});
