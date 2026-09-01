import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  beginLiveEvidence,
  canonicalJson,
  companionMarkdownPath,
  completeLiveEvidence,
  describeEffectiveConfig,
  liveEvidenceV2Integrity,
  markLiveEvidenceIncomplete,
  publicLiveEvidenceSummary,
  registerLiveEvidenceFixtureCommands,
  registerLiveEvidenceFixtureReceipts,
  sha256Text,
  writeLiveEvidenceJson,
  writeLiveEvidenceReportPair,
} from '../../scripts/live-evidence-v2.js';
import { mergeCalibrationEvidenceCase } from '../../scripts/advisor-live-calibration-case.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRYPOINT = path.join(ROOT, 'scripts', 'run-live-scenario.js');
const CLEAN_HASH = '1'.repeat(40);
const NEXT_HASH = '2'.repeat(40);
const DIRTY_HASH = 'a'.repeat(64);

function snapshot(sha = CLEAN_HASH, dirtyCount = 0, dirtyDigestSha256 = DIRTY_HASH) {
  return {
    available: true,
    sha,
    branch: 'codex/test',
    dirtyCount,
    dirtyDigestSha256,
  };
}

function stableSnapshotProvider() {
  return snapshot();
}

const DEFAULT_GAME_RULES = Object.freeze({
  announceAdvancements: true,
  commandBlockOutput: true,
  disableElytraMovementCheck: false,
  disableRaids: false,
  doDaylightCycle: true,
  doEntityDrops: true,
  doFireTick: true,
  doImmediateRespawn: false,
  doInsomnia: true,
  doLimitedCrafting: false,
  doMobLoot: true,
  doMobSpawning: true,
  doPatrolSpawning: true,
  doTileDrops: true,
  doTraderSpawning: true,
  doWeatherCycle: true,
  drowningDamage: true,
  fallDamage: true,
  fireDamage: true,
  forgiveDeadPlayers: true,
  freezeDamage: true,
  keepInventory: false,
  mobGriefing: true,
  naturalRegeneration: true,
  showDeathMessages: true,
  universalAnger: false,
});

function completeWorldState(overrides = {}) {
  const gameRules = { ...DEFAULT_GAME_RULES, ...(overrides.gameRules || {}) };
  const defaultGameRules = { ...DEFAULT_GAME_RULES, ...(overrides.defaultGameRules || {}) };
  const defaultKeys = Object.keys(defaultGameRules).sort();
  return {
    available: true,
    gameMode: 'survival',
    difficulty: 'normal',
    gameRulesSchemaVersion: 1,
    gameRulesRegistry: 'minecraft:game_rules',
    gameRulesComplete: true,
    ...overrides,
    gameRules,
    defaultGameRules,
    gameRulesRegistryMetadata: {
      schemaVersion: 1,
      source: 'server_default_registry',
      registeredRuleCount: defaultKeys.length,
      registeredKeySetDigestSha256: sha256Text(canonicalJson(defaultKeys)),
    },
  };
}

function attestedFreshWorld(identity, state = {}) {
  return {
    origin: 'fresh_generated',
    opaqueIdentity: identity,
    restore: {
      status: 'random_world_generated',
      uniqueNewSaveProven: true,
      worldIdentitySource: 'unique_new_save',
      seedExposed: false,
    },
    state,
  };
}

test('Node live evidence V2 is additive, deterministic, and omits credential material', () => {
  const record = { ok: true, status: 'fixture_passed', customField: { retained: true } };
  const effectiveConfig = {
    timeoutMs: 1000,
    maxTokens: 4096,
    rconHost: '127.0.0.1',
    nested: { mode: 'test', apiKey: 'never-write-this-api-key' },
    apiKeyMaxTokens: 'never-write-this-overlap-secret',
    secretRconHost: 'never-write-this-prefixed-secret',
    tokenizerMode: 'precise',
    password: 'never-write-this-password',
    seed: 'hidden-seed-value',
  };
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    effectiveConfig,
    env: {
      MCBOT_MODE: 'test',
      MCBOT_RCON_PASSWORD: 'never-write-this-rcon-password',
      MCBOT_SETUP_COMMAND: 'give MCBot diamond 64',
      MCBOT_RESOURCE_LOCK_OWNER_ID: 'runtime-owner-one',
    },
    snapshotProvider: stableSnapshotProvider,
    world: {
      retainedLegacyField: 'preserved',
      origin: 'fresh_generated',
      opaqueIdentity: 'opaque-world-id',
      restore: { status: 'random_world_generated', uniqueNewSaveProven: true, worldIdentitySource: 'unique_new_save', seedExposed: false },
      state: {
        initial: completeWorldState(),
        postSetup: completeWorldState({
          difficulty: 'hard',
          gameRules: {
            doDaylightCycle: true,
            doFireTick: true,
            doMobSpawning: true,
            keepInventory: true,
            mobGriefing: true,
          },
          defaultGameRules: {
            doDaylightCycle: true,
            doFireTick: true,
            doMobSpawning: true,
            keepInventory: false,
            mobGriefing: true,
          },
        }),
        terminal: completeWorldState(),
      },
    },
  });
  completeLiveEvidence(record);

  assert.deepEqual(record.customField, { retained: true });
  assert.equal(record.resultSchemaVersion, 2);
  assert.equal(record.validity.scenarioOutcomeIndependent, true);
  assert.equal(record.validity.northStarEligible, false);
  assert.equal(record.validity.evidenceCompleteness, 'complete');
  assert.equal(record.world.retainedLegacyField, 'preserved');
  assert.equal(liveEvidenceV2Integrity(record), true);
  assert.match(record.provenance.effectiveConfig.sha256, /^[a-f0-9]{64}$/);
  assert.match(record.provenance.entrypoint.sha256, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /never-write-this/);
  assert.equal(
    describeEffectiveConfig(effectiveConfig, { MCBOT_MODE: 'test' }).sha256,
    describeEffectiveConfig({
      nested: { apiKey: 'changed', mode: 'test' },
      apiKeyMaxTokens: 'changed-overlap-secret',
      secretRconHost: 'changed-prefixed-secret',
      tokenizerMode: 'precise',
      seed: 'hidden-seed-value',
      timeoutMs: 1000,
      maxTokens: 4096,
      rconHost: '127.0.0.1',
      password: 'changed',
    }, { MCBOT_MODE: 'test', MCBOT_RESOURCE_LOCK_OWNER_ID: 'runtime-owner-two' }).sha256,
  );
  assert.notEqual(
    describeEffectiveConfig(effectiveConfig, { MCBOT_MODE: 'test' }).sha256,
    describeEffectiveConfig({ ...effectiveConfig, maxTokens: 8192 }, { MCBOT_MODE: 'test' }).sha256,
  );
  assert.notEqual(
    describeEffectiveConfig(effectiveConfig, { MCBOT_MODE: 'test' }).sha256,
    describeEffectiveConfig({ ...effectiveConfig, rconHost: 'localhost' }, { MCBOT_MODE: 'test' }).sha256,
  );
});

test('Node evidence never fabricates default-rule registry completeness from a small current-rule map', () => {
  const sparseState = {
    gameMode: 'survival',
    difficulty: 'normal',
    gameRulesComplete: true,
    gameRules: {
      doDaylightCycle: true,
      doFireTick: true,
      doMobSpawning: true,
      keepInventory: false,
      mobGriefing: true,
    },
  };
  const record = { ok: true, finishedAt: '2026-08-29T00:00:01.000Z' };
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    world: attestedFreshWorld('sparse-world', {
      initial: sparseState,
      postSetup: sparseState,
      terminal: sparseState,
    }),
  });
  completeLiveEvidence(record);
  assert.equal(record.world.state.initial.defaultGameRules, null);
  assert.equal(record.world.state.initial.gameRulesRegistryMetadata, null);
  assert.equal(record.world.stateValidation.initial.valid, false);
  assert.equal(record.validity.evidenceCompleteness, 'incomplete');
});

test('fresh-world origin is downgraded without an accepted unique-save attestation source', () => {
  const record = { ok: true, finishedAt: '2026-08-29T00:00:01.000Z' };
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    world: {
      origin: 'fresh_generated',
      opaqueIdentity: 'unattested-world',
      restore: { uniqueNewSaveProven: true, seedExposed: false },
      state: {
        initial: completeWorldState(),
        postSetup: completeWorldState(),
        terminal: completeWorldState(),
      },
    },
  });
  completeLiveEvidence(record);
  assert.equal(record.world.origin, 'fresh_generation_unverified');
  assert.equal(record.validity.evidenceCompleteness, 'incomplete');
  assert.ok(record.validity.reasonCodes.includes('world_origin_unverified'));
  assert.equal(record.validity.northStarEligible, false);

  const contradictory = { ok: true, finishedAt: '2026-08-29T00:00:01.000Z' };
  beginLiveEvidence(contradictory, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    world: {
      origin: 'fresh_generated',
      opaqueIdentity: 'contradictory-world-marker',
      restore: {
        status: 'restored',
        uniqueNewSaveProven: true,
        worldIdentitySource: 'unique_new_save',
        seedExposed: false,
      },
      state: {
        initial: completeWorldState(),
        postSetup: completeWorldState(),
        terminal: completeWorldState(),
      },
    },
  });
  completeLiveEvidence(contradictory);
  assert.equal(contradictory.world.origin, 'fresh_generation_unverified');
  assert.equal(contradictory.validity.evidenceCompleteness, 'incomplete');
  assert.equal(liveEvidenceV2Integrity(contradictory), true);
});

test('Node live evidence records exact fixture commands locally but exports only categories and hashes', () => {
  const record = { ok: true, status: 'fixture_passed' };
  const command = 'minecraft:give MCBot minecraft:iron_pickaxe 1';
  const hint = { x: 101, y: 64, z: -22, note: 'local-only-coordinate' };
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    fixtureCommands: [{ command, source: 'test-fixture' }],
    fixtureReceipts: [{
      command,
      authority: 'server_command_receipt.v1',
      status: 'applied',
      result: 'completed',
      resultCode: 1,
    }],
    targetHints: [hint],
  });
  completeLiveEvidence(record);
  const summary = publicLiveEvidenceSummary(record);

  assert.equal(record.fixtureMutations.declared[0].command, command);
  assert.deepEqual(record.fixtureMutations.targetHints.declared[0].hint, hint);
  assert.deepEqual(summary.fixtureCategories, ['player_and_inventory']);
  assert.deepEqual(summary.targetHintCategories, ['mission_target_hint']);
  assert.doesNotMatch(JSON.stringify(summary), /iron_pickaxe|local-only-coordinate|"x":101/);
  assert.match(summary.fixtureDeclaredDigestSha256, /^[a-f0-9]{64}$/);
  assert.match(summary.fixtureReceiptDigestSha256, /^[a-f0-9]{64}$/);
  record.validity.reasonCodes.push('password=must-not-export');
  record.fixtureMutations.categories.push('secret-command-category');
  assert.doesNotMatch(JSON.stringify(publicLiveEvidenceSummary(record)), /must-not-export|secret-command-category/);
});

test('Node live evidence rejects missing or mismatched fixture receipts', () => {
  const declared = 'minecraft:give MCBot minecraft:stone 1';
  const record = { ok: true, status: 'fixture_passed' };
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    fixtureCommands: [declared],
    fixtureReceipts: [{
      command: 'minecraft:give MCBot minecraft:dirt 1',
      authority: 'server_command_receipt.v1',
      status: 'applied',
      result: 'completed',
      resultCode: 1,
    }],
    world: attestedFreshWorld('mismatch-world', {
        initial: completeWorldState(),
        postSetup: completeWorldState(),
        terminal: completeWorldState(),
      }),
  });
  completeLiveEvidence(record);
  assert.equal(record.fixtureMutations.allDeclaredApplied, false);
  assert.equal(record.fixtureMutations.validation.status, 'invalid');
  assert.equal(record.validity.evidenceCompleteness, 'partial');
  assert.ok(record.validity.reasonCodes.includes('fixture_receipts_incomplete'));
});

test('Node live evidence preserves receipt order and rejects a reversed authoritative ledger', () => {
  const commands = [
    'minecraft:time set day',
    'minecraft:weather clear',
  ];
  const record = { ok: true, status: 'fixture_passed' };
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    fixtureCommands: commands,
    fixtureReceipts: [...commands].reverse().map((command) => ({
      command,
      authority: 'server_command_receipt.v1',
      status: 'applied',
      result: 'completed',
      resultCode: 1,
    })),
    world: attestedFreshWorld('reversed-receipt-world', {
      initial: completeWorldState(),
      postSetup: completeWorldState(),
      terminal: completeWorldState(),
    }),
  });
  completeLiveEvidence(record);
  assert.deepEqual(record.fixtureMutations.appliedReceipts.map((entry) => entry.command), [...commands].reverse());
  assert.equal(record.fixtureMutations.allDeclaredApplied, false);
  assert.ok(record.fixtureMutations.validation.issues.includes('fixture_receipt_order_mismatch'));
  assert.equal(record.validity.evidenceCompleteness, 'partial');
  assert.equal(liveEvidenceV2Integrity(record), true);
});

test('Node live evidence matches explicitly registered post-execution receipts', () => {
  const record = { ok: true, finishedAt: '2026-08-29T00:00:01.000Z' };
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    world: attestedFreshWorld('receipt-test-world', {
        initial: completeWorldState(),
        postSetup: completeWorldState(),
        terminal: completeWorldState(),
      }),
  });
  registerLiveEvidenceFixtureCommands(record, ['minecraft:time set day'], 'test-harness');
  registerLiveEvidenceFixtureReceipts(record, [{
    command: 'minecraft:time set day',
    authority: 'server_command_receipt.v1',
    status: 'applied',
    result: 'completed',
    resultCode: 1,
  }], 'test-harness');
  completeLiveEvidence(record, { final: true });
  assert.equal(record.fixtureMutations.declaredCount, 1);
  assert.equal(record.fixtureMutations.appliedCount, 1);
  assert.equal(record.fixtureMutations.allDeclaredApplied, true);
  assert.equal(record.validity.evidenceCompleteness, 'complete');

  const originTampered = structuredClone(record);
  originTampered.world.origin = 'restored_snapshot';
  assert.equal(liveEvidenceV2Integrity(originTampered), false);

  const profileTampered = structuredClone(record);
  profileTampered.validity.profile = 'qualification_unseen.v1';
  profileTampered.validity.classification = 'qualification_only';
  assert.equal(liveEvidenceV2Integrity(profileTampered), false);

  const tampered = structuredClone(record);
  tampered.fixtureMutations.validation.declarationsFrozen = true;
  tampered.fixtureMutations.declared[0].command = 'minecraft:time set night';
  assert.equal(liveEvidenceV2Integrity(tampered), false);
  const aggregate = { ok: true, status: 'aggregate_complete' };
  beginLiveEvidence(aggregate, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    inputRecords: [tampered],
  });
  completeLiveEvidence(aggregate);
  assert.equal(aggregate.validity.evidenceCompleteness, 'incomplete');
  assert.ok(aggregate.validity.reasonCodes.includes('child_result_invalid'));
});

test('Node live evidence accepts an authoritative successful zero command result', () => {
  const command = 'minecraft:gamerule keepInventory false';
  const record = { ok: true, finishedAt: '2026-08-29T00:00:01.000Z' };
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    fixtureCommands: [command],
    fixtureReceipts: [{
      command,
      authority: 'server_command_receipt.v1',
      status: 'applied',
      result: 'completed',
      resultCode: 0,
    }],
    world: attestedFreshWorld('zero-result-world', {
      initial: completeWorldState(),
      postSetup: completeWorldState(),
      terminal: completeWorldState(),
    }),
  });
  completeLiveEvidence(record);
  assert.equal(record.fixtureMutations.validation.status, 'valid');
  assert.equal(record.fixtureMutations.allDeclaredApplied, true);
  assert.equal(record.fixtureMutations.appliedReceipts[0].resultCode, 0);
  assert.equal(liveEvidenceV2Integrity(record), true);
});

test('RCON transport packets remain unverified rather than becoming command-success receipts', () => {
  const record = { ok: true, finishedAt: '2026-08-29T00:00:01.000Z' };
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    fixtureCommands: ['minecraft:time set day'],
    world: attestedFreshWorld('transport-world', {
        initial: completeWorldState(),
        postSetup: completeWorldState(),
        terminal: completeWorldState(),
      }),
  });
  registerLiveEvidenceFixtureReceipts(record, [{
    command: 'minecraft:time set day',
    response: 'transport body is not an authoritative result',
    type: 0,
  }]);
  completeLiveEvidence(record);
  assert.equal(record.fixtureMutations.appliedReceipts[0].authority, 'transport_observation.v1');
  assert.equal(record.fixtureMutations.appliedReceipts[0].status, 'unknown');
  assert.equal(record.fixtureMutations.allDeclaredApplied, false);
  assert.equal(record.validity.evidenceCompleteness, 'partial');
});

test('aggregate validation recomputes repository stability instead of trusting a child flag', () => {
  const child = { ok: true, finishedAt: '2026-08-29T00:00:01.000Z' };
  beginLiveEvidence(child, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    world: attestedFreshWorld('stable-world', {
        initial: completeWorldState(),
        postSetup: completeWorldState(),
        terminal: completeWorldState(),
      }),
  });
  completeLiveEvidence(child);
  child.provenance.repository.finish.sha = NEXT_HASH;
  child.provenance.repository.stable = true;
  assert.equal(liveEvidenceV2Integrity(child), false);

  const aggregate = { ok: true, status: 'aggregate_complete' };
  beginLiveEvidence(aggregate, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    inputRecords: [child],
  });
  completeLiveEvidence(aggregate);
  assert.equal(aggregate.validity.evidenceCompleteness, 'incomplete');
  assert.ok(aggregate.validity.reasonCodes.includes('child_result_invalid'));
});

test('calibration case ledgers bind every retained case into V2 integrity', () => {
  const cases = { first: { liveProven: true }, second: { liveProven: false } };
  const casesDigestSha256 = sha256Text(canonicalJson(cases));
  const ledgerCore = {
    schemaVersion: 1,
    caseIds: Object.keys(cases).sort(),
    unclassifiedCaseIds: [],
    casesDigestSha256,
  };
  const record = {
    status: 'calibration_aggregate',
    finishedAt: '2026-08-29T00:00:01.000Z',
    cases,
    calibrationCaseLedger: {
      ...ledgerCore,
      ledgerDigestSha256: sha256Text(canonicalJson(ledgerCore)),
    },
  };
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
  });
  completeLiveEvidence(record);
  assert.equal(liveEvidenceV2Integrity(record), true);
  record.cases.first.liveProven = false;
  assert.equal(liveEvidenceV2Integrity(record), false);

  const missingCases = structuredClone(record);
  missingCases.cases = null;
  assert.equal(liveEvidenceV2Integrity(missingCases), false);
});

test('calibration ledger retires legacy case taint one rerun at a time without re-adding prior reruns', () => {
  const legacy = {
    cases: {
      first: { liveProven: true },
      second: { liveProven: true },
    },
  };
  const firstRerun = mergeCalibrationEvidenceCase(legacy, 'first', { liveProven: true });
  assert.deepEqual(firstRerun.calibrationCaseLedger.unclassifiedCaseIds, ['second']);
  beginLiveEvidence(firstRerun, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
  });
  completeLiveEvidence(firstRerun);
  assert.equal(liveEvidenceV2Integrity(firstRerun), true);

  const secondRerun = mergeCalibrationEvidenceCase(firstRerun, 'second', { liveProven: true });
  assert.deepEqual(secondRerun.calibrationCaseLedger.unclassifiedCaseIds, []);
  assert.deepEqual(secondRerun.calibrationCaseLedger.classifiedCaseIds, ['first', 'second']);
  assert.equal(secondRerun.calibrationCaseLedger.classificationCycleComplete, true);
  beginLiveEvidence(secondRerun, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
  });
  completeLiveEvidence(secondRerun);
  assert.equal(secondRerun.validity.evidenceCompleteness, 'incomplete');
  assert.equal(liveEvidenceV2Integrity(secondRerun), true);

  const laterRerun = mergeCalibrationEvidenceCase(secondRerun, 'first', { liveProven: true, rerun: 2 });
  assert.deepEqual(laterRerun.calibrationCaseLedger.unclassifiedCaseIds, []);
  assert.deepEqual(laterRerun.calibrationCaseLedger.classifiedCaseIds, ['first', 'second']);
  assert.equal(laterRerun.calibrationCaseLedger.classificationCycleComplete, true);
});

test('an incomplete bound calibration ledger reclassifies retained cases before reuse', () => {
  const cases = {
    first: { liveProven: true },
    second: { liveProven: true },
  };
  const casesDigestSha256 = sha256Text(canonicalJson(cases));
  const ledgerCore = {
    schemaVersion: 1,
    caseIds: Object.keys(cases).sort(),
    unclassifiedCaseIds: [],
    casesDigestSha256,
  };
  const incomplete = {
    status: 'calibration_aggregate',
    finishedAt: '2026-08-29T00:00:01.000Z',
    cases,
    calibrationCaseLedger: {
      ...ledgerCore,
      ledgerDigestSha256: sha256Text(canonicalJson(ledgerCore)),
    },
  };
  beginLiveEvidence(incomplete, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
  });
  completeLiveEvidence(incomplete);
  assert.equal(incomplete.validity.evidenceCompleteness, 'incomplete');
  assert.equal(liveEvidenceV2Integrity(incomplete), true);

  const rerun = mergeCalibrationEvidenceCase(incomplete, 'first', { liveProven: true });
  assert.deepEqual(rerun.calibrationCaseLedger.unclassifiedCaseIds, ['second']);
});

test('Node live evidence profiles distinguish restored qualification and fail-closed North Star records', () => {
  const qualification = { ok: true, status: 'qualification_passed' };
  beginLiveEvidence(qualification, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    qualification: true,
    world: {
      restore: {
        status: 'restored',
        worldIdentity: 'sealed-corpus-world',
        worldIdentitySource: 'sealed_qualification_corpus',
        qualificationCorpus: true,
      },
      state: {
        initial: completeWorldState(),
        postSetup: completeWorldState(),
        terminal: completeWorldState(),
      },
    },
  });
  completeLiveEvidence(qualification);
  assert.equal(qualification.world.origin, 'restored_snapshot');
  assert.equal(qualification.validity.profile, 'qualification_unseen.v1');
  assert.equal(qualification.validity.classification, 'qualification_only');

  const genericRestoredQualification = { ok: true, status: 'qualification_passed' };
  beginLiveEvidence(genericRestoredQualification, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    qualification: true,
    world: {
      restore: {
        status: 'restored',
        worldIdentity: 'generic-restored-world',
        worldIdentitySource: 'verified_snapshot',
        qualificationCorpus: false,
      },
      state: {
        initial: completeWorldState(),
        postSetup: completeWorldState(),
        terminal: completeWorldState(),
      },
    },
  });
  completeLiveEvidence(genericRestoredQualification);
  assert.equal(genericRestoredQualification.validity.evidenceCompleteness, 'incomplete');
  assert.ok(genericRestoredQualification.validity.reasonCodes.includes('world_origin_unverified'));
  assert.equal(genericRestoredQualification.validity.northStarEligible, false);

  const north = { ok: true, status: 'dragon_defeated', execution: { deathEvents: 1 } };
  beginLiveEvidence(north, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    profile: 'north_star_record.v1',
    world: {
      freshGenerated: true,
      uniqueNewSaveProven: true,
      opaqueIdentity: 'brand-new-world',
      restore: { status: 'random_world_generated', uniqueNewSaveProven: true, worldIdentitySource: 'unique_new_save', seedExposed: false },
      state: {
        initial: completeWorldState(),
        postSetup: completeWorldState({
          difficulty: 'hard',
          gameRules: {
            doDaylightCycle: true,
            doFireTick: true,
            doMobSpawning: true,
            keepInventory: true,
            mobGriefing: true,
          },
          defaultGameRules: {
            doDaylightCycle: true,
            doFireTick: true,
            doMobSpawning: true,
            keepInventory: false,
            mobGriefing: true,
          },
        }),
        terminal: completeWorldState(),
      },
    },
  });
  completeLiveEvidence(north);
  assert.equal(north.validity.profile, 'north_star_record.v1');
  assert.equal(north.validity.classification, 'north_star_uncertified');
  assert.equal(north.validity.northStarEligible, false);
  assert.ok(north.validity.reasonCodes.includes('passive_server_auditor_not_implemented'));
  assert.ok(north.validity.reasonCodes.includes('dragon_terminal_not_authoritative'));
  assert.ok(north.validity.reasonCodes.includes('difficulty_changed_during_run'));
  assert.ok(north.validity.reasonCodes.includes('normal_difficulty_not_proven'));
  assert.ok(north.validity.reasonCodes.includes('game_rules_changed_during_run'));
  assert.ok(north.validity.reasonCodes.includes('default_game_rules_not_proven'));
  assert.ok(north.validity.reasonCodes.includes('player_death_observed'));
  assert.equal(north.validity.authoritativeProof.clientDeathObserved, true);
});

test('Node live evidence detects repository changes and missing world evidence without changing scenario outcome', () => {
  const snapshots = [snapshot(CLEAN_HASH, 0, 'a'.repeat(64)), snapshot(NEXT_HASH, 1, 'b'.repeat(64))];
  const record = { ok: true, status: 'scenario_passed' };
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: () => snapshots.shift(),
  });
  completeLiveEvidence(record);

  assert.equal(record.ok, true);
  assert.equal(record.provenance.repository.stable, false);
  assert.equal(record.validity.evidenceCompleteness, 'incomplete');
  assert.ok(record.validity.reasonCodes.includes('repository_changed_during_run'));
  assert.ok(record.validity.reasonCodes.includes('world_identity_missing'));
  assert.ok(record.validity.reasonCodes.includes('world_state_missing_or_incomplete'));
});

test('Node live evidence accepts an earlier wrapper start snapshot', () => {
  const record = { ok: true, status: 'wrapper_passed' };
  const earlier = snapshot(CLEAN_HASH, 0, '3'.repeat(64));
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    startGitSnapshot: earlier,
    snapshotProvider: () => snapshot(CLEAN_HASH, 0, '3'.repeat(64)),
  });
  completeLiveEvidence(record);
  assert.deepEqual(record.provenance.repository.start, earlier);
  assert.equal(record.provenance.repository.stable, true);
});

test('scenario failure remains independent from otherwise complete evidence validity', () => {
  const record = { ok: false, status: 'scenario_assertions_failed', outcome: 'fail' };
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    world: attestedFreshWorld('failed-scenario-world', {
        initial: completeWorldState(),
        postSetup: completeWorldState(),
        terminal: completeWorldState(),
      }),
  });
  completeLiveEvidence(record);
  assert.equal(record.ok, false);
  assert.equal(record.outcome, 'fail');
  assert.equal(record.validity.evidenceCompleteness, 'complete');
  assert.equal(record.validity.classification, 'development_only');
  assert.equal(record.validity.scenarioOutcomeIndependent, true);
});

test('calibration aggregate death observations remain visible in V2 validity', () => {
  const record = {
    ok: false,
    status: 'calibration_complete',
    cases: {
      death_recovery: { recovery: { deathObserved: true, respawnObserved: true } },
    },
  };
  const casesDigestSha256 = sha256Text(canonicalJson(record.cases));
  const ledgerCore = {
    schemaVersion: 2,
    caseIds: ['death_recovery'],
    classifiedCaseIds: ['death_recovery'],
    unclassifiedCaseIds: [],
    classificationCycleComplete: true,
    casesDigestSha256,
  };
  record.calibrationCaseLedger = {
    ...ledgerCore,
    ledgerDigestSha256: sha256Text(canonicalJson(ledgerCore)),
  };
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
  });
  completeLiveEvidence(record);
  assert.equal(record.validity.authoritativeProof.clientDeathObserved, true);
  assert.ok(record.validity.reasonCodes.includes('player_death_observed'));
  assert.equal(record.validity.northStarEligible, false);
});

test('Node catch/fatal evidence and legacy child evidence are always incomplete', () => {
  const fatal = { ok: false, status: 'unexpected_failure' };
  beginLiveEvidence(fatal, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
  });
  markLiveEvidenceIncomplete(fatal, 'wrapper_fatal_error');
  completeLiveEvidence(fatal);
  assert.equal(fatal.validity.evidenceCompleteness, 'incomplete');
  assert.equal(fatal.validity.classification, 'incomplete');
  assert.equal(fatal.validity.northStarEligible, false);
  assert.ok(fatal.validity.reasonCodes.includes('wrapper_fatal_error'));

  const aggregate = { ok: true, status: 'aggregate_complete' };
  beginLiveEvidence(aggregate, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    inputRecords: [{ resultSchemaVersion: 1, ok: true }],
  });
  completeLiveEvidence(aggregate);
  assert.equal(aggregate.validity.evidenceCompleteness, 'incomplete');
  assert.ok(aggregate.validity.reasonCodes.includes('child_result_legacy_v1'));
  assert.deepEqual(publicLiveEvidenceSummary({ resultSchemaVersion: 1, ok: true }), {
    resultSchemaVersion: null,
    classification: 'legacy_unclassified',
    northStarEligible: false,
  });

  const malformed = structuredClone(fatal);
  malformed.validity.classification = 'development_only';
  const malformedSummary = publicLiveEvidenceSummary(malformed);
  assert.equal(malformedSummary.classification, 'incomplete');
  assert.equal(malformedSummary.evidenceCompleteness, 'incomplete');
  assert.ok(malformedSummary.reasonCodes.includes('child_result_invalid'));

  const malformedAggregate = { ok: true, status: 'aggregate_complete' };
  beginLiveEvidence(malformedAggregate, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    inputRecords: [malformed],
  });
  completeLiveEvidence(malformedAggregate);
  assert.equal(malformedAggregate.validity.evidenceCompleteness, 'incomplete');
  assert.ok(malformedAggregate.validity.reasonCodes.includes('child_result_invalid'));
});

test('Node live evidence writer persists a V2 catch-path record', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-node-evidence-v2-'));
  const output = path.join(temp, 'result.json');
  const record = { ok: false, status: 'caught_failure', failure: 'synthetic' };
  markLiveEvidenceIncomplete(record, 'wrapper_fatal_error', {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
  });
  writeLiveEvidenceJson(output, record);
  const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(parsed.resultSchemaVersion, 2);
  assert.equal(parsed.validity.classification, 'incomplete');
  assert.equal(parsed.validity.northStarEligible, false);
});

test('fallback completion failure preserves registered commands, hints, and captured provenance', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-node-evidence-fallback-'));
  const output = path.join(temp, 'result.json');
  const record = {
    ok: false,
    status: 'caught_failure',
    world: { retainedWorldNote: 'keep-me' },
    fixtureMutations: {
      declared: [{ command: 'minecraft:weather clear', source: 'preexisting-child' }],
      appliedReceipts: [{
        command: 'minecraft:weather clear',
        authority: 'server_command_receipt.v1',
        status: 'applied',
        result: 'completed',
        resultCode: 1,
      }],
      targetHints: {
        declared: [{ hint: { category: 'preexisting-target', x: 1 }, source: 'preexisting-child' }],
      },
    },
  };
  const malformedChild = new Proxy({}, {
    get() {
      throw new Error('synthetic aggregate completion failure');
    },
  });
  beginLiveEvidence(record, {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    fixtureCommands: ['minecraft:time set day'],
    fixtureReceipts: [{
      command: 'minecraft:time set day',
      authority: 'server_command_receipt.v1',
      status: 'applied',
      result: 'completed',
      resultCode: 1,
    }],
    targetHints: [{ category: 'test-target', x: 4, y: 64, z: 9 }],
    inputRecords: [malformedChild],
    world: attestedFreshWorld('fallback-context-world', {
      initial: completeWorldState(),
      postSetup: completeWorldState(),
      terminal: completeWorldState(),
    }),
  });
  writeLiveEvidenceJson(output, record);
  const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(parsed.validity.evidenceCompleteness, 'incomplete');
  assert.deepEqual(parsed.fixtureMutations.declared.map((entry) => entry.command), [
    'minecraft:time set day',
    'minecraft:weather clear',
  ]);
  assert.deepEqual(parsed.fixtureMutations.appliedReceipts.map((entry) => entry.command), [
    'minecraft:time set day',
    'minecraft:weather clear',
  ]);
  assert.deepEqual(parsed.fixtureMutations.targetHints.declared.map((entry) => entry.hint), [{
    category: 'test-target', x: 4, y: 64, z: 9,
  }, { category: 'preexisting-target', x: 1 }]);
  assert.equal(parsed.world.retainedWorldNote, 'keep-me');
  assert.equal(parsed.world.origin, 'fresh_generated');
  assert.match(parsed.world.opaqueIdentitySha256, /^[a-f0-9]{64}$/);
  assert.equal(parsed.provenance.repository.start.sha, CLEAN_HASH);
  assert.ok(parsed.validity.reasonCodes.includes('evidence_completion_failed'));
  assert.doesNotMatch(JSON.stringify(publicLiveEvidenceSummary(parsed)), /minecraft:time set day|test-target/);
});

test('report pairs cannot collide and a Markdown failure leaves JSON evidence incomplete', () => {
  assert.equal(companionMarkdownPath('result.json'), 'result.md');
  assert.equal(companionMarkdownPath('result.JSON'), 'result.md');
  assert.equal(companionMarkdownPath('result.data'), 'result.data.md');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-node-evidence-pair-'));
  const output = path.join(temp, 'result.data');
  const record = { ok: true, status: 'scenario_passed', finishedAt: '2026-08-29T00:00:01.000Z' };
  assert.throws(() => writeLiveEvidenceReportPair(output, record, () => '# report\n', {
    repositoryRoot: ROOT,
    entrypointPath: ENTRYPOINT,
    snapshotProvider: stableSnapshotProvider,
    markdownWriter() {
      throw new Error('synthetic Markdown failure');
    },
  }), /synthetic Markdown failure/);
  const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(parsed.validity.evidenceCompleteness, 'incomplete');
  assert.ok(parsed.validity.reasonCodes.includes('wrapper_fatal_error'));
  assert.equal(fs.existsSync(companionMarkdownPath(output)), false);
});

test('every remaining Node live-result writer routes JSON results through the shared V2 helper', () => {
  const writers = [
    'scripts/advisor-live-calibration-case.js',
    'scripts/advisor-live-calibration.js',
    'scripts/advisor-live-plan.js',
    'scripts/run-live-scenario.js',
  ];
  for (const relativePath of writers) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.match(source, /live-evidence-v2\.js/, relativePath);
    assert.match(source, /writeLiveEvidence(?:Json|ReportPair)\s*\(/, relativePath);
    assert.doesNotMatch(
      source,
      /(?:writeFileSync|writeFile)\s*\([\s\S]{0,240}?JSON\.stringify\s*\((?:report|data|value)/,
      `${relativePath} retains a direct JSON result write`,
    );
  }
  for (const relativePath of [
    'scripts/advisor-live-calibration-case.js',
    'scripts/advisor-live-calibration.js',
    'scripts/advisor-live-plan.js',
    'scripts/run-live-scenario.js',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.match(source, /markLiveEvidenceIncomplete\s*\(/, `${relativePath} lacks a catch-path fail-closed marker`);
  }
  for (const relativePath of [
    'scripts/advisor-live-plan.js',
    'scripts/run-live-scenario.js',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.match(source, /client_evidence_trace_read_error/, `${relativePath} can lose its terminal artifact on malformed telemetry`);
  }
  const scenarioRunner = fs.readFileSync(path.join(ROOT, 'scripts/run-live-scenario.js'), 'utf8');
  assert.match(scenarioRunner, /child\.once\('error',[\s\S]{0,160}?reject\(err\)/, 'async child spawn errors must reach the V2 catch path');
  const advisorPlan = fs.readFileSync(path.join(ROOT, 'scripts/advisor-live-plan.js'), 'utf8');
  assert.match(
    advisorPlan,
    /final snapshot checkpoint write failed:[\s\S]{0,220}?stopChild\(child, reason\)/,
    'a checkpoint write failure must not skip final child shutdown or terminal cleanup',
  );
  assert.match(
    advisorPlan,
    /if \(runConfig\.options\.dryRun\)[\s\S]{0,900}?assertNoUncontrolledLocalMinecraftServerSync\([\s\S]{0,220}?runAdvisorLivePlan\(runConfig\)/,
    'live advisor execution must enforce local-server admission after the dry-run boundary and before spawn',
  );
  assert.match(
    advisorPlan,
    /if \(parsed\.token\)[\s\S]{0,180}?report\.plugin\.token = parsed\.token;[\s\S]{0,180}?if \(!parsed\.token \|\| !parsed\.telemetryPath\)/,
    'a partial plugin start must retain its token before telemetry-path validation',
  );
  assert.match(
    advisorPlan,
    /plugin telemetry start failed:[\s\S]{0,220}?await finishPluginTelemetry\(report\)/,
    'partial plugin startup must attempt scenario cleanup before returning',
  );
  const calibrationCase = fs.readFileSync(path.join(ROOT, 'scripts/advisor-live-calibration-case.js'), 'utf8');
  assert.match(
    calibrationCase,
    /JSON\.parse\([\s\S]{0,180}?Array\.isArray\(value\)[\s\S]{0,100}?malformed: true/,
    'primitive and array aggregate JSON must be treated as malformed child evidence',
  );
  const liveHelpers = fs.readFileSync(path.join(ROOT, 'test/live_helpers.js'), 'utf8');
  assert.match(liveHelpers, /opts\.onFinish\?\.\(\{ code, event, fields, bot, observedDeaths \}\)/);
});
