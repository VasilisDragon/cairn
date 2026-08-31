import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PROFILES = new Set([
  'development_fixture.v1',
  'qualification_unseen.v1',
  'north_star_record.v1',
]);
const ORIGINS = new Set([
  'fresh_generated',
  'fresh_generation_unverified',
  'restored_snapshot',
  'existing_or_unknown',
]);
const CLASSIFICATIONS = new Set([
  'development_only',
  'qualification_only',
  'north_star_uncertified',
  'incomplete',
]);
const COMPLETENESS = new Set(['complete', 'partial', 'incomplete']);
const FIXTURE_VALUE_KEY = /(setup[_-]?command|target[_-]?hint)/i;
const SAFE_BEHAVIOR_CONFIG_NAMES = new Set([
  'max_tokens',
  'max_plan_tokens',
  'provider_max_tokens',
  'advisor_max_tokens',
  'advisor_f3_max_tokens',
  'mcbot_advisor_max_tokens',
  'mcbot_advisor_f3_max_tokens',
  'mcbot_fabric_deepseek_max_tokens',
  'rcon_host',
  'rcon_port',
  'rcon_timeout_ms',
  'mcbot_rcon_host',
  'mcbot_rcon_port',
  'mcbot_rcon_timeout_ms',
]);
const RUNTIME_PLUMBING_CONFIG_NAMES = new Set([
  'mcbot_resource_lock_path',
  'mcbot_resource_lock_owner_id',
  'mcbot_resource_lock_repository_id',
  'mcbot_resource_lock_owner_pid',
]);
const HASH_RE = /^[a-f0-9]{64}$/;
const GIT_HASH_RE = /^[a-f0-9]{40,64}$/;
const FRESH_WORLD_CREATION_STATUSES = new Set([
  'random_world_generated',
  'pristine_random_world_created',
  'new_save_created',
  'server_world_created',
]);
const COMMAND_CATEGORIES = new Set([
  'empty',
  'rules_and_mode',
  'position_and_spawn',
  'player_and_inventory',
  'blocks',
  'entities',
  'time_and_weather',
  'other_server_command',
]);
const PUBLIC_REASON_CODES = new Set([
  'passive_server_auditor_not_implemented',
  'wrapper_fatal_error',
  'forced_client_termination',
  'client_evidence_trace_read_error',
  'client_evidence_trace_payload_invalid',
  'client_evidence_expected_instance_missing',
  'client_evidence_foreign_instance_marker',
  'client_evidence_missing',
  'live_execution_timeout',
  'result_write_before_completion',
  'repository_changed_during_run',
  'entrypoint_hash_missing',
  'effective_config_hash_missing',
  'world_identity_missing',
  'world_origin_unverified',
  'world_state_missing_or_incomplete',
  'initial_world_state_missing_or_incomplete',
  'post_setup_world_state_missing_or_incomplete',
  'terminal_world_state_missing_or_incomplete',
  'difficulty_changed_during_run',
  'game_mode_changed_during_run',
  'game_rules_changed_during_run',
  'fixture_intervention_declared',
  'fixture_receipts_incomplete',
  'fixture_declarations_not_frozen',
  'target_hints_not_frozen',
  'fixture_receipt_missing',
  'fixture_receipt_unmatched',
  'fixture_receipt_index_invalid',
  'fixture_receipt_hash_invalid',
  'fixture_receipt_order_mismatch',
  'fixture_receipt_category_mismatch',
  'fixture_receipt_status_failed',
  'fixture_receipt_result_invalid',
  'fixture_receipt_result_code_invalid',
  'fixture_declaration_index_mutated',
  'fixture_declaration_command_not_normalized',
  'fixture_declaration_hash_mutated',
  'fixture_declaration_category_mutated',
  'target_hint_index_mutated',
  'target_hint_hash_mutated',
  'target_hint_category_mutated',
  'fixture_frozen_prefix_truncated',
  'fixture_checkpoint_corrupted',
  'fixture_frozen_prefix_mutated',
  'fixture_freeze_checkpoint_missing',
  'fixture_final_batch_not_frozen',
  'fixture_declarations_unavailable',
  'fixture_commands_present',
  'target_hints_present',
  'player_death_observed',
  'fresh_world_not_proven',
  'repository_not_clean',
  'hidden_seed_not_proven',
  'survival_mode_not_proven',
  'normal_difficulty_not_proven',
  'default_game_rules_not_proven',
  'death_absence_not_authoritative',
  'intervention_absence_not_authoritative',
  'manual_input_absence_not_authoritative',
  'reload_absence_not_authoritative',
  'pause_absence_not_authoritative',
  'dragon_terminal_not_authoritative',
  'evidence_completion_failed',
  'child_result_missing',
  'child_result_invalid',
  'child_result_legacy_v1',
]);
for (const phase of ['initial', 'post_setup', 'terminal']) {
  for (const issue of [
    'state_unavailable',
    'game_mode_invalid',
    'difficulty_invalid',
    'game_rules_schema_invalid',
    'game_rules_registry_invalid',
    'game_rules_map_missing',
    'default_game_rules_map_missing',
    'game_rules_registry_metadata_invalid',
    'game_rules_count_mismatch',
    'default_game_rules_count_mismatch',
    'game_rules_digest_mismatch',
    'default_game_rules_digest_mismatch',
    'game_rules_key_set_digest_mismatch',
    'default_game_rules_key_set_digest_mismatch',
    'game_rules_key_set_incomplete',
    'game_rules_required_key_missing',
    'game_rules_registry_metadata_mismatch',
  ]) PUBLIC_REASON_CODES.add(`${phase}_${issue}`);
}
const contexts = new WeakMap();

export function sha256Text(value = '') {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function companionMarkdownPath(resultPath) {
  const value = String(resultPath || 'result');
  return /\.json$/i.test(value) ? value.replace(/\.json$/i, '.md') : `${value}.md`;
}

function canonicalValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => canonicalValue(entry, seen));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalValue(value[key], seen);
  }
  seen.delete(value);
  return result;
}

function sanitizeEffectiveConfig(value, state = { omittedSecretCount: 0, inputFieldCount: 0 }, key = '') {
  if (isCredentialKey(key) || isRuntimePlumbingKey(key) || FIXTURE_VALUE_KEY.test(key)) {
    state.omittedSecretCount += 1;
    return undefined;
  }
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') {
    if (/seed/i.test(key)) return { valueSha256: sha256Text(canonicalJson(value)) };
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeEffectiveConfig(entry, state, key)).filter((entry) => entry !== undefined);
  }
  const out = {};
  for (const childKey of Object.keys(value).sort()) {
    state.inputFieldCount += 1;
    const child = sanitizeEffectiveConfig(value[childKey], state, childKey);
    if (child !== undefined) out[childKey] = child;
  }
  return out;
}

function isCredentialKey(key) {
  const normalized = normalizeConfigurationName(key);
  if (!normalized) return false;
  if (SAFE_BEHAVIOR_CONFIG_NAMES.has(normalized)) return false;
  return /(?:^|_)(?:api_?key|token|secret|password|passwd|credential|cookie|authorization|private_?key|client_?secret|access_?token|auth_?token|bearer_?token|refresh_?token|session_?(?:id|key|token|secret))(?:_|$)/.test(normalized);
}

function isRuntimePlumbingKey(key) {
  return RUNTIME_PLUMBING_CONFIG_NAMES.has(normalizeConfigurationName(key));
}

function normalizeConfigurationName(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function describeEffectiveConfig(value = {}, env = process.env) {
  const state = { omittedSecretCount: 0, inputFieldCount: 0 };
  const selectedEnvironment = {};
  for (const name of Object.keys(env || {}).sort()) {
    if (!name.startsWith('MCBOT_')) continue;
    state.inputFieldCount += 1;
    const sanitized = sanitizeEffectiveConfig(env[name], state, name);
    if (sanitized !== undefined) selectedEnvironment[name] = sanitized;
  }
  const sanitized = sanitizeEffectiveConfig({ input: value, environment: selectedEnvironment }, state);
  return {
    algorithm: 'sha256',
    canonicalization: 'sorted-json-utf8.v1',
    sha256: sha256Text(canonicalJson(sanitized)),
    inputFieldCount: state.inputFieldCount,
    omittedSecretCount: state.omittedSecretCount,
  };
}

function runGit(repositoryRoot, args, { encoding = 'utf8', maxBuffer = 64 * 1024 * 1024 } = {}) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
    encoding,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer,
  });
  if (result.error || result.status !== 0) throw result.error || new Error(`git ${args[0]} failed`);
  return result.stdout;
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

export function captureGitSnapshot(repositoryRoot, dependencies = {}) {
  const git = dependencies.runGit || runGit;
  try {
    const sha = String(git(repositoryRoot, ['rev-parse', 'HEAD'])).trim().toLowerCase();
    if (!GIT_HASH_RE.test(sha)) throw new Error('git HEAD was not a commit hash');
    let branch = '(detached)';
    try {
      branch = String(git(repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || branch;
    } catch {
      // Detached HEAD is a valid provenance state.
    }
    const status = String(git(repositoryRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    const stagedDiffSha256 = sha256Text(git(repositoryRoot, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv']));
    const worktreeDiffSha256 = sha256Text(git(repositoryRoot, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv']));
    const untracked = String(git(repositoryRoot, ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '-z']))
      .split('\0')
      .filter(Boolean)
      .sort();
    const untrackedManifest = untracked.map((relativePath) => {
      const fullPath = path.resolve(repositoryRoot, relativePath);
      const stat = fs.statSync(fullPath);
      return {
        pathSha256: sha256Text(relativePath.replaceAll('\\', '/')),
        contentSha256: hashFile(fullPath),
        sizeBytes: stat.size,
      };
    });
    const dirtyMaterial = {
      stagedDiffSha256,
      worktreeDiffSha256,
      untrackedContentSha256: sha256Text(canonicalJson(untrackedManifest)),
      untrackedFileCount: untrackedManifest.length,
    };
    return {
      available: true,
      sha,
      branch,
      dirtyCount: status.split('\0').filter(Boolean).length,
      dirtyDigestSha256: sha256Text(canonicalJson(dirtyMaterial)),
      dirtyDigestAlgorithm: 'git-diff-and-untracked-content.v1',
      ...dirtyMaterial,
    };
  } catch (error) {
    return {
      available: false,
      sha: null,
      branch: null,
      dirtyCount: null,
      dirtyDigestSha256: null,
      errorType: error?.name || 'Error',
    };
  }
}

function entrypointDescriptor(entrypointPath) {
  try {
    const fullPath = path.resolve(entrypointPath);
    return {
      sha256: crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex'),
      fileName: path.basename(fullPath),
    };
  } catch {
    return { sha256: null, fileName: path.basename(String(entrypointPath || 'unknown')) };
  }
}

function normalizeProfile(value) {
  return PROFILES.has(value) ? value : 'development_fixture.v1';
}

function requestedProfile(options = {}) {
  if (options.qualification === true || options.world?.qualificationCorpus === true) return 'qualification_unseen.v1';
  return normalizeProfile(options.profile || options.env?.MCBOT_EVIDENCE_PROFILE || process.env.MCBOT_EVIDENCE_PROFILE);
}

export function beginLiveEvidence(record, options = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('live evidence record must be an object');
  if (contexts.has(record)) return record;
  const repositoryRoot = path.resolve(options.repositoryRoot || process.cwd());
  const entrypointPath = path.resolve(options.entrypointPath || process.argv[1] || 'unknown');
  const snapshotProvider = options.snapshotProvider || captureGitSnapshot;
  contexts.set(record, {
    repositoryRoot,
    entrypointPath,
    snapshotProvider,
    startGit: options.startGitSnapshot || snapshotProvider(repositoryRoot),
    finishGit: null,
    effectiveConfig: describeEffectiveConfig(options.effectiveConfig || {}, options.env || process.env),
    entrypoint: entrypointDescriptor(entrypointPath),
    profile: requestedProfile(options),
    world: options.world || null,
    fixtureCommands: copyFixtureCommands(options.fixtureCommands),
    fixtureReceipts: copyFixtureReceipts(options.fixtureReceipts),
    targetHints: copyTargetHints(options.targetHints),
    inputRecords: [...(options.inputRecords || [])],
    reasonCodes: new Set(options.reasonCodes || []),
    fatalReasons: new Set(),
  });
  return record;
}

function contextFor(record, options = {}) {
  beginLiveEvidence(record, options);
  const context = contexts.get(record);
  if (options.entrypointPath) {
    const entrypointPath = path.resolve(options.entrypointPath);
    if (entrypointPath !== context.entrypointPath) {
      context.entrypointPath = entrypointPath;
      context.entrypoint = entrypointDescriptor(entrypointPath);
    }
  }
  if (options.world) context.world = options.world;
  if (options.profile || options.qualification === true) context.profile = requestedProfile(options);
  if (options.effectiveConfig) context.effectiveConfig = describeEffectiveConfig(options.effectiveConfig, options.env || process.env);
  if (options.fixtureCommands) context.fixtureCommands = copyFixtureCommands(options.fixtureCommands);
  if (options.fixtureReceipts) context.fixtureReceipts = copyFixtureReceipts(options.fixtureReceipts);
  if (options.targetHints) context.targetHints = copyTargetHints(options.targetHints);
  if (options.inputRecords) context.inputRecords = [...options.inputRecords];
  if (options.startGitSnapshot) context.startGit = options.startGitSnapshot;
  if (options.refreshFinishGit === true) context.finishGit = null;
  for (const reason of options.reasonCodes || []) context.reasonCodes.add(reason);
  return context;
}

export function markLiveEvidenceIncomplete(record, reasonCode = 'wrapper_fatal_error', options = {}) {
  if (options.ifStarted === true && !contexts.has(record)) return record;
  const context = contextFor(record, options);
  context.fatalReasons.add(reasonCode || 'wrapper_fatal_error');
  return record;
}

export function registerLiveEvidenceFixtureCommands(record, commands, source = 'harness', options = {}) {
  const context = contextFor(record, options);
  for (const command of commands || []) {
    const normalized = normalizeCommand(command?.command ?? command);
    if (normalized) context.fixtureCommands.push({ command: normalized, source });
  }
  return record;
}

export function registerLiveEvidenceFixtureReceipts(record, receipts, source = 'harness', options = {}) {
  const context = contextFor(record, options);
  for (const receipt of receipts || []) {
    const normalized = normalizeCommand(receipt?.command ?? receipt);
    if (!normalized) continue;
    // An RCON response packet proves transport delivery only; its packet type
    // does not prove that Minecraft applied the command.  Only a receipt from
    // the later authoritative command auditor may be classified as applied.
    const authoritative = receipt?.authority === 'server_command_receipt.v1';
    const successful = authoritative && receipt?.status === 'applied' && receipt?.result === 'completed';
    const failed = authoritative && (receipt?.status === 'failed' || receipt?.result === 'failed');
    context.fixtureReceipts.push({
      command: normalized,
      source,
      authority: authoritative ? 'server_command_receipt.v1' : 'transport_observation.v1',
      status: successful ? 'applied' : (failed ? 'failed' : 'unknown'),
      result: successful ? 'completed' : (failed ? 'failed' : 'unverified'),
      resultCode: authoritative && Number.isInteger(receipt?.resultCode) ? receipt.resultCode : null,
    });
  }
  return record;
}

export function registerLiveEvidenceTargetHints(record, hints, options = {}) {
  const context = contextFor(record, options);
  for (const hint of hints || []) {
    if (hint === null || hint === undefined) continue;
    context.targetHints.push(canonicalValue(hint));
  }
  return record;
}

export function commandCategory(command) {
  const normalized = String(command || '').trim().replace(/^\//, '');
  const verb = normalized.split(/\s+/, 1)[0].replace(/^minecraft:/, '').toLowerCase();
  if (/^(difficulty|gamemode|gamerule)$/.test(verb)) return 'rules_and_mode';
  if (/^(tp|teleport|spreadplayers|spawnpoint|setworldspawn|forceload)$/.test(verb)) return 'position_and_spawn';
  if (/^(give|clear|item|effect|experience|xp|enchant)$/.test(verb)) return 'player_and_inventory';
  if (/^(setblock|fill|clone|place)$/.test(verb)) return 'blocks';
  if (/^(summon|kill|damage|ride)$/.test(verb)) return 'entities';
  if (/^(time|weather)$/.test(verb)) return 'time_and_weather';
  return normalized ? 'other_server_command' : 'empty';
}

function normalizeCommand(value) {
  return String(value || '').trim().replace(/^\//, '');
}

function copyFixtureCommands(values = []) {
  return [...(values || [])].map((entry) => (
    entry && typeof entry === 'object'
      ? { command: normalizeCommand(entry.command), source: String(entry.source || 'harness') }
      : normalizeCommand(entry)
  ));
}

function copyFixtureReceipts(values = []) {
  return [...(values || [])].map((entry) => (
    entry && typeof entry === 'object'
      ? {
          command: normalizeCommand(entry.command),
          source: String(entry.source || 'harness'),
          authority: entry.authority,
          status: entry.status,
          result: entry.result,
          resultCode: entry.resultCode,
        }
      : normalizeCommand(entry)
  ));
}

function copyTargetHints(values = []) {
  return [...(values || [])]
    .filter((hint) => hint !== null && hint !== undefined)
    .map((hint) => canonicalValue(hint));
}

function discoverFixtureEvidence(record) {
  const commands = [];
  const receipts = [];
  const seen = new WeakSet();
  const hasTopLevelRconLedger = Array.isArray(record?.rcon?.commands);
  function visit(value, pathParts = []) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...pathParts, String(index)]));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (['provenance', 'world', 'fixtureMutations', 'validity'].includes(key)) continue;
      const childPath = [...pathParts, key];
      if (key === 'commands' && Array.isArray(child) && child.every((entry) => typeof entry === 'string')) {
        const responseQueues = new Map();
        for (const response of Array.isArray(value.responses) ? value.responses : []) {
          if (!response || typeof response.command !== 'string') continue;
          const responseCommand = normalizeCommand(response.command);
          const queue = responseQueues.get(responseCommand) || [];
          queue.push(response);
          responseQueues.set(responseCommand, queue);
        }
        child.forEach((command, index) => {
          const normalized = normalizeCommand(command);
          if (!normalized) return;
          commands.push({ command: normalized, source: childPath.join('.'), sequence: index });
          const response = responseQueues.get(normalized)?.shift();
          if (response) {
            receipts.push({
              command: normalized,
              authority: 'transport_observation.v1',
              status: 'unknown',
              result: 'unverified',
              resultCode: null,
            });
          }
        });
      }
      const responseLedgerAllowed = !hasTopLevelRconLedger || childPath[0] === 'rcon';
      if (key === 'responses' && Array.isArray(child) && !Array.isArray(value.commands) && responseLedgerAllowed) {
        child.forEach((response) => {
          if (!response || typeof response.command !== 'string') return;
          const normalized = normalizeCommand(response.command);
          if (!normalized) return;
          commands.push({ command: normalized, source: childPath.join('.'), sequence: commands.length });
          receipts.push({
            command: normalized,
            authority: 'transport_observation.v1',
            status: 'unknown',
            result: 'unverified',
            resultCode: null,
          });
        });
      }
      visit(child, childPath);
    }
  }
  visit(record);
  const scenarioId = record.scenarioId || record.plugin?.scenarioId || record.scenario;
  if (record.plugin?.required === true && scenarioId) {
    const startCommand = `mcbottest start ${scenarioId}`;
    if (!commands.some((entry) => normalizeCommand(entry.command) === startCommand)) {
      commands.push({ command: startCommand, source: 'implicit.plugin.start', sequence: 0 });
    }
  }
  if (record.plugin?.token) {
    const endCommand = `mcbottest end ${record.plugin.token}`;
    if (!commands.some((entry) => normalizeCommand(entry.command) === endCommand)) {
      commands.push({ command: endCommand, source: 'implicit.plugin.end', sequence: 0 });
    }
  }
  return { commands, receipts };
}

function normalizedDeclarations(record, context) {
  const discoveries = [
    record,
    ...(context.inputRecords || []).filter((entry) => entry?.resultSchemaVersion !== 2),
  ]
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => discoverFixtureEvidence(entry));
  const childDeclarations = (context.inputRecords || []).flatMap((entry) => (
    Array.isArray(entry?.fixtureMutations?.declared) ? entry.fixtureMutations.declared : []
  ));
  const childReceipts = (context.inputRecords || []).flatMap((entry) => {
    const receipts = Array.isArray(entry?.fixtureMutations?.appliedReceipts)
      ? entry.fixtureMutations.appliedReceipts
      : [];
    const trustedCompleteChild = entry?.resultSchemaVersion === 2
      && entry.validity?.evidenceCompleteness === 'complete'
      && liveEvidenceV2Integrity(entry);
    const fabricReceiptLedger = entry?.fixtureMutations?.validation?.schemaVersion === undefined
      && entry?.fixtureMutations?.validation?.declarationsFrozen === true;
    return receipts.map((receipt) => (
      trustedCompleteChild && fabricReceiptLedger
        ? { ...receipt, authority: 'server_command_receipt.v1' }
        : receipt
    ));
  });
  const rawCommands = mergeCommandEvidence(
    context.fixtureCommands,
    [...discoveries.flatMap((entry) => entry.commands), ...childDeclarations],
  );
  const declarations = [];
  for (const raw of rawCommands) {
    const source = typeof raw === 'object' && raw ? String(raw.source || 'harness') : 'harness';
    const command = normalizeCommand(typeof raw === 'object' && raw ? raw.command : raw);
    if (!command) continue;
    declarations.push({
      index: declarations.length,
      command,
      sha256: sha256Text(command),
      category: commandCategory(command),
      source,
    });
  }
  const rawReceipts = mergeCommandEvidence(
    context.fixtureReceipts,
    [...discoveries.flatMap((entry) => entry.receipts), ...childReceipts],
  );
  const receipts = [];
  for (const raw of rawReceipts) {
    const command = normalizeCommand(raw?.command ?? raw);
    if (!command) continue;
    const hash = sha256Text(command);
    const authoritative = raw?.authority === 'server_command_receipt.v1';
    const successful = authoritative && raw?.status === 'applied' && raw?.result === 'completed';
    const failed = authoritative && (raw?.status === 'failed' || raw?.result === 'failed');
    const receipt = {
      index: receipts.length,
      command,
      sha256: hash,
      category: commandCategory(command),
      authority: authoritative ? 'server_command_receipt.v1' : 'transport_observation.v1',
      status: successful ? 'applied' : (failed ? 'failed' : 'unknown'),
      result: successful ? 'completed' : (failed ? 'failed' : 'unverified'),
      resultCode: authoritative && Number.isInteger(raw?.resultCode) ? raw.resultCode : null,
    };
    receipts.push(receipt);
  }
  return { declarations, receipts };
}

function nodeFixtureAssessment(declarations, receipts) {
  const issues = [];
  if (receipts.length < declarations.length) issues.push('fixture_receipt_missing');
  if (receipts.length > declarations.length) issues.push('fixture_receipt_unmatched');
  const ordered = declarations.length === receipts.length
    && receipts.every((receipt, index) => receipt.index === index && receipt.sha256 === declarations[index]?.sha256);
  if (declarations.length === receipts.length && !ordered) issues.push('fixture_receipt_order_mismatch');
  const allDeclaredApplied = ordered
    && receipts.every((receipt) => receipt.status === 'applied'
      && receipt.result === 'completed'
      && receipt.authority === 'server_command_receipt.v1'
      && Number.isInteger(receipt.resultCode)
      && receipt.resultCode >= 0);
  if (!allDeclaredApplied) issues.push('fixture_receipts_incomplete');
  return { allDeclaredApplied, issues: issues.sort() };
}

function mergeCommandEvidence(primary = [], discovered = []) {
  const merged = [...primary];
  const retainedCounts = new Map();
  for (const entry of primary) {
    const command = normalizeCommand(entry?.command ?? entry);
    retainedCounts.set(command, (retainedCounts.get(command) || 0) + 1);
  }
  const seenCounts = new Map();
  for (const entry of discovered) {
    const command = normalizeCommand(entry?.command ?? entry);
    const seen = (seenCounts.get(command) || 0) + 1;
    seenCounts.set(command, seen);
    if (seen > (retainedCounts.get(command) || 0)) merged.push(entry);
  }
  return merged;
}

function mergeTargetHintEvidence(primary = [], discovered = []) {
  const merged = [...primary];
  const retainedCounts = new Map();
  for (const hint of primary) {
    const key = canonicalJson(hint?.hint ?? hint);
    retainedCounts.set(key, (retainedCounts.get(key) || 0) + 1);
  }
  const seenCounts = new Map();
  for (const hint of discovered) {
    const value = hint?.hint ?? hint;
    const key = canonicalJson(value);
    const seen = (seenCounts.get(key) || 0) + 1;
    seenCounts.set(key, seen);
    if (seen > (retainedCounts.get(key) || 0)) merged.push(value);
  }
  return merged;
}

function targetHintEvidence(context) {
  const childHints = (context.inputRecords || []).flatMap((record) => (
    Array.isArray(record?.fixtureMutations?.targetHints?.declared)
      ? record.fixtureMutations.targetHints.declared.map((entry) => entry?.hint).filter((hint) => hint !== undefined)
      : []
  ));
  const allHints = [...context.targetHints, ...childHints];
  const declared = allHints.map((hint, index) => ({
    index,
    hint,
    sha256: sha256Text(canonicalJson(hint)),
    category: 'mission_target_hint',
    source: 'harness',
  }));
  const projection = declared.map(({ index, sha256, category, source }) => ({ index, sha256, category, source }));
  return {
    localEvidenceContainsExactHints: true,
    declared,
    declaredCount: declared.length,
    categories: [...new Set(declared.map((entry) => entry.category))].sort(),
    declaredDigestSha256: sha256Text(canonicalJson(projection)),
  };
}

function normalizedWorld(record, context, options) {
  const supplied = options.world || context.world || record.worldEvidence || record.world || {};
  const restore = supplied.restore || supplied.pristineMarker || record.worldRestore || record.setup?.worldRestore || null;
  const identity = supplied.opaqueIdentitySha256 || supplied.opaqueIdentity || supplied.worldIdentity
    || restore?.worldIdentity || restore?.contentDigestSha256 || null;
  const identitySource = String(restore?.worldIdentitySource || supplied.worldIdentitySource || '');
  const restoreStatus = String(restore?.status || '');
  const freshAttested = Boolean(identity && freshWorldMarkerAttestationValid(restore));
  const restoredAttested = Boolean(identity
    && restoreStatus === 'restored'
    && ['verified_snapshot', 'sealed_qualification_corpus'].includes(identitySource));
  let origin = supplied.origin;
  if (origin === 'fresh_generated' && !freshAttested) origin = 'fresh_generation_unverified';
  else if (origin === 'restored_snapshot' && !restoredAttested) origin = 'existing_or_unknown';
  else if (!ORIGINS.has(origin)) {
    if (restoredAttested) origin = 'restored_snapshot';
    else if (freshAttested) origin = 'fresh_generated';
    else if (supplied.freshGenerated === true || supplied.randomWorld === true) origin = 'fresh_generation_unverified';
    else origin = 'existing_or_unknown';
  }
  const state = {
    initial: normalizeWorldState(supplied.state?.initial ?? supplied.initial ?? null),
    postSetup: normalizeWorldState(supplied.state?.postSetup ?? supplied.postSetup ?? null),
    terminal: normalizeWorldState(supplied.state?.terminal ?? supplied.terminal ?? null),
  };
  return {
    ...supplied,
    origin,
    opaqueIdentitySha256: identity ? (HASH_RE.test(String(identity).toLowerCase()) ? String(identity).toLowerCase() : sha256Text(identity)) : null,
    pristineMarker: restore ? {
      ...restore,
      status: restore.status ?? null,
      qualificationCorpus: restore.qualificationCorpus === true,
      uniqueNewSaveProven: restore.uniqueNewSaveProven === true,
      worldIdentitySource: restore.worldIdentitySource ?? null,
      seedExposed: restore.seedExposed ?? null,
    } : null,
    state,
    stateValidation: Object.fromEntries(Object.entries(state).map(([phase, value]) => [phase, {
      valid: isCompleteWorldState(value),
      issues: isCompleteWorldState(value) ? [] : ['state_unavailable'],
    }])),
  };
}

function freshWorldMarkerAttestationValid(marker) {
  if (!marker || typeof marker !== 'object' || marker.uniqueNewSaveProven !== true) return false;
  const source = String(marker.worldIdentitySource || '');
  const status = String(marker.status || '');
  if (!FRESH_WORLD_CREATION_STATUSES.has(status)) return false;
  if (source === 'local_save') return status === 'pristine_random_world_created';
  if (source === 'server_world_creation_receipt') return status === 'server_world_created';
  return source === 'unique_new_save';
}

function worldOriginAttestationValid(world, profile = null) {
  if (!world || !HASH_RE.test(String(world.opaqueIdentitySha256 || '').toLowerCase())) return false;
  const marker = world.pristineMarker;
  if (!marker || typeof marker !== 'object') return false;
  const source = String(marker.worldIdentitySource || '');
  const status = String(marker.status || '');
  if (profile === 'qualification_unseen.v1') {
    return world.origin === 'restored_snapshot'
      && status === 'restored'
      && marker.qualificationCorpus === true
      && source === 'sealed_qualification_corpus';
  }
  if (world.origin === 'fresh_generated') {
    return freshWorldMarkerAttestationValid(marker);
  }
  if (world.origin === 'restored_snapshot') {
    return status === 'restored' && ['verified_snapshot', 'sealed_qualification_corpus'].includes(source);
  }
  return false;
}

function normalizeWorldState(value) {
  if (!value || typeof value !== 'object') return null;
  const gameRules = value.gameRules && typeof value.gameRules === 'object' ? canonicalValue(value.gameRules) : null;
  const defaultGameRules = value.defaultGameRules && typeof value.defaultGameRules === 'object'
    ? canonicalValue(value.defaultGameRules)
    : null;
  const gameRuleKeys = gameRules ? Object.keys(gameRules).sort() : [];
  const defaultRuleKeys = defaultGameRules ? Object.keys(defaultGameRules).sort() : [];
  const gameRulesKeySetDigestSha256 = sha256Text(canonicalJson(gameRuleKeys));
  const defaultGameRulesKeySetDigestSha256 = sha256Text(canonicalJson(defaultRuleKeys));
  return {
    ...value,
    available: value.available === true,
    gameRulesSchemaVersion: value.gameRulesSchemaVersion ?? null,
    gameRulesRegistry: value.gameRulesRegistry ?? null,
    gameRules,
    defaultGameRules,
    gameRulesCount: value.gameRulesCount ?? gameRuleKeys.length,
    defaultGameRulesCount: value.defaultGameRulesCount ?? defaultRuleKeys.length,
    gameRulesDigestSha256: value.gameRulesDigestSha256 ?? (gameRules ? sha256Text(canonicalJson(gameRules)) : null),
    defaultGameRulesDigestSha256: value.defaultGameRulesDigestSha256
      ?? (defaultGameRules ? sha256Text(canonicalJson(defaultGameRules)) : null),
    gameRulesKeySetDigestSha256: value.gameRulesKeySetDigestSha256 ?? gameRulesKeySetDigestSha256,
    defaultGameRulesKeySetDigestSha256: value.defaultGameRulesKeySetDigestSha256 ?? defaultGameRulesKeySetDigestSha256,
    gameRulesRegistryMetadata: value.gameRulesRegistryMetadata ?? null,
  };
}

function isCompleteWorldState(value) {
  if (!value || value.available !== true) return false;
  if (!['survival', 'creative', 'adventure', 'spectator'].includes(value.gameMode)) return false;
  if (!['peaceful', 'easy', 'normal', 'hard'].includes(value.difficulty)) return false;
  if (value.gameRulesSchemaVersion !== 1 || value.gameRulesRegistry !== 'minecraft:game_rules') return false;
  if (!value.gameRules || !value.defaultGameRules) return false;
  const keys = Object.keys(value.gameRules).sort();
  const defaultKeys = Object.keys(value.defaultGameRules).sort();
  // Five hand-picked rules are not a complete registry snapshot.  The exact
  // registry grows between Minecraft versions, so validate against the
  // independently captured registry metadata and a conservative floor.
  if (keys.length < 20 || keys.join('\0') !== defaultKeys.join('\0')) return false;
  if (!['doDaylightCycle', 'doFireTick', 'doMobSpawning', 'keepInventory', 'mobGriefing']
    .every((key) => defaultKeys.includes(key))) return false;
  if (Number(value.gameRulesCount) !== keys.length || Number(value.defaultGameRulesCount) !== defaultKeys.length) return false;
  if (value.gameRulesDigestSha256 !== sha256Text(canonicalJson(value.gameRules))) return false;
  if (value.defaultGameRulesDigestSha256 !== sha256Text(canonicalJson(value.defaultGameRules))) return false;
  if (value.gameRulesKeySetDigestSha256 !== sha256Text(canonicalJson(keys))) return false;
  if (value.defaultGameRulesKeySetDigestSha256 !== sha256Text(canonicalJson(defaultKeys))) return false;
  const registry = value.gameRulesRegistryMetadata;
  return Boolean(registry
    && registry.schemaVersion === 1
    && registry.source === 'server_default_registry'
    && Number(registry.registeredRuleCount) === defaultKeys.length
    && registry.registeredKeySetDigestSha256 === value.defaultGameRulesKeySetDigestSha256);
}

function repositoryStable(start, finish) {
  return Boolean(start?.available && finish?.available
    && start.sha === finish.sha
    && start.dirtyCount === finish.dirtyCount
    && start.dirtyDigestSha256 === finish.dirtyDigestSha256);
}

function isFinalRecord(record) {
  if (record.finishedAt || record.endedAt) return true;
  const status = String(record.status || record.outcome || '');
  return status !== '' && !/(running|pending|starting)$/i.test(status);
}

function classificationFor(profile, completeness) {
  if (completeness === 'incomplete') return 'incomplete';
  if (profile === 'qualification_unseen.v1') return 'qualification_only';
  if (profile === 'north_star_record.v1') return 'north_star_uncertified';
  return 'development_only';
}

function knownClientDeathObserved(record) {
  const candidates = [
    record?.execution?.deathEvents,
    record?.telemetrySummary?.botDeathCount,
    record?.plugin?.telemetrySummary?.botDeathCount,
  ];
  if (candidates.some((value) => Number(value) > 0)) return true;
  if (record?.clientEvidence?.playerDeath === true || record?.recovery?.deathObserved === true) return true;
  if (record?.evidenceCase?.recovery?.deathObserved === true) return true;
  const cases = record?.cases;
  if (!cases || typeof cases !== 'object' || Array.isArray(cases)) return false;
  return Object.values(cases).some((entry) => (
    entry?.deathObserved === true
    || entry?.recovery?.deathObserved === true
    || entry?.evidenceCase?.recovery?.deathObserved === true
  ));
}

function inputEvidenceReasonCodes(inputs = []) {
  const reasons = [];
  for (const entry of inputs) {
    if (!entry) reasons.push('child_result_missing');
    else if (entry.resultSchemaVersion !== 2) reasons.push('child_result_legacy_v1');
    else if (!liveEvidenceV2Integrity(entry) || entry.validity?.evidenceCompleteness !== 'complete') {
      reasons.push('child_result_invalid');
    }
  }
  return reasons;
}

export function completeLiveEvidence(record, options = {}) {
  const context = contextFor(record, options);
  if (options.fatal === true) context.fatalReasons.add(options.reasonCode || 'wrapper_fatal_error');
  for (const reason of inputEvidenceReasonCodes(context.inputRecords)) context.fatalReasons.add(reason);
  const final = options.final ?? isFinalRecord(record);
  if (final && !context.finishGit) context.finishGit = context.snapshotProvider(context.repositoryRoot);
  const finishGit = context.finishGit || context.startGit;
  const stable = repositoryStable(context.startGit, finishGit);
  const world = normalizedWorld(record, context, options);
  const { declarations, receipts } = normalizedDeclarations(record, context);
  const hintEvidence = targetHintEvidence(context);
  const declarationProjection = declarations.map(({ index, sha256, category, source }) => ({ index, sha256, category, source }));
  const receiptProjection = receipts.map(({ index, sha256, category, authority, status, result, resultCode }) => ({
    index, sha256, category, authority, status, result, resultCode,
  }));
  const fixtureAssessment = nodeFixtureAssessment(declarations, receipts);
  const { allDeclaredApplied } = fixtureAssessment;
  const fixtureIssues = fixtureAssessment.issues;
  const worldStatesComplete = Object.values(world.stateValidation).every((entry) => entry.valid);
  const worldOriginAttested = worldOriginAttestationValid(world, context.profile);
  const reasonCodes = new Set([
    'passive_server_auditor_not_implemented',
    ...context.reasonCodes,
    ...context.fatalReasons,
    ...fixtureIssues,
  ]);
  if (!final) reasonCodes.add('result_write_before_completion');
  if (!stable) reasonCodes.add('repository_changed_during_run');
  if (!HASH_RE.test(context.entrypoint.sha256 || '')) reasonCodes.add('entrypoint_hash_missing');
  if (!HASH_RE.test(context.effectiveConfig.sha256 || '')) reasonCodes.add('effective_config_hash_missing');
  if (!world.opaqueIdentitySha256) reasonCodes.add('world_identity_missing');
  if (!worldOriginAttested) reasonCodes.add('world_origin_unverified');
  if (!worldStatesComplete) reasonCodes.add('world_state_missing_or_incomplete');
  for (const [phase, validation] of Object.entries(world.stateValidation)) {
    if (!validation.valid) {
      const phaseName = phase === 'postSetup' ? 'post_setup' : phase;
      reasonCodes.add(`${phaseName}_world_state_missing_or_incomplete`);
    }
  }
  const validStates = Object.values(world.state).filter((state) => isCompleteWorldState(state));
  if (new Set(validStates.map((state) => state.difficulty)).size > 1) reasonCodes.add('difficulty_changed_during_run');
  if (new Set(validStates.map((state) => state.gameMode)).size > 1) reasonCodes.add('game_mode_changed_during_run');
  if (new Set(validStates.map((state) => state.gameRulesDigestSha256)).size > 1) reasonCodes.add('game_rules_changed_during_run');
  if (declarations.length + hintEvidence.declaredCount > 0) reasonCodes.add('fixture_intervention_declared');
  const clientDeathObserved = knownClientDeathObserved(record);
  if (clientDeathObserved) reasonCodes.add('player_death_observed');
  if (context.profile === 'north_star_record.v1') {
    if (world.origin !== 'fresh_generated') reasonCodes.add('fresh_world_not_proven');
    if (declarations.length > 0) reasonCodes.add('fixture_commands_present');
    if (hintEvidence.declaredCount > 0) reasonCodes.add('target_hints_present');
    if ((context.startGit.dirtyCount ?? 1) !== 0 || (finishGit.dirtyCount ?? 1) !== 0) reasonCodes.add('repository_not_clean');
    if (world.pristineMarker?.seedExposed !== false) reasonCodes.add('hidden_seed_not_proven');
    if (validStates.length !== 3 || validStates.some((state) => state.gameMode !== 'survival')) {
      reasonCodes.add('survival_mode_not_proven');
    }
    if (validStates.length !== 3 || validStates.some((state) => state.difficulty !== 'normal')) {
      reasonCodes.add('normal_difficulty_not_proven');
    }
    if (!worldStatesComplete || validStates.some((state) => state.gameRulesDigestSha256 !== state.defaultGameRulesDigestSha256)) {
      reasonCodes.add('default_game_rules_not_proven');
    }
    for (const reason of [
      'death_absence_not_authoritative',
      'intervention_absence_not_authoritative',
      'manual_input_absence_not_authoritative',
      'reload_absence_not_authoritative',
      'pause_absence_not_authoritative',
      'dragon_terminal_not_authoritative',
    ]) reasonCodes.add(reason);
  }
  const fatal = context.fatalReasons.size > 0;
  const coreProvenanceAvailable = context.startGit?.available === true
    && finishGit?.available === true
    && GIT_HASH_RE.test(context.startGit?.sha || '')
    && GIT_HASH_RE.test(finishGit?.sha || '')
    && HASH_RE.test(context.startGit?.dirtyDigestSha256 || '')
    && HASH_RE.test(finishGit?.dirtyDigestSha256 || '')
    && HASH_RE.test(context.entrypoint.sha256 || '')
    && HASH_RE.test(context.effectiveConfig.sha256 || '');
  const completeness = fatal || !final || !coreProvenanceAvailable
    || !world.opaqueIdentitySha256 || !worldOriginAttested || !worldStatesComplete
    ? 'incomplete'
    : (stable && world.opaqueIdentitySha256 && worldStatesComplete && allDeclaredApplied ? 'complete' : 'partial');
  record.resultSchemaVersion = 2;
  record.provenance = {
    repository: { start: context.startGit, finish: finishGit, stable },
    effectiveConfig: context.effectiveConfig,
    entrypoint: context.entrypoint,
  };
  record.world = world;
  record.fixtureMutations = {
    localEvidenceContainsCommands: true,
    declared: declarations,
    appliedReceipts: receipts,
    declaredCount: declarations.length,
    appliedCount: receipts.filter((receipt) => receipt.status === 'applied').length,
    allDeclaredApplied,
    validation: {
      schemaVersion: 1,
      status: allDeclaredApplied ? 'valid' : 'invalid',
      issues: fixtureIssues,
    },
    categories: [...new Set(declarations.map((entry) => entry.category))].sort(),
    declaredDigestSha256: sha256Text(canonicalJson(declarationProjection)),
    receiptDigestSha256: sha256Text(canonicalJson(receiptProjection)),
    targetHints: hintEvidence,
  };
  record.validity = {
    profile: context.profile,
    evidenceCompleteness: completeness,
    classification: classificationFor(context.profile, completeness),
    scenarioOutcomeIndependent: true,
    northStarEligible: false,
    reasonCodes: [...reasonCodes].sort(),
    authoritativeProof: {
      death: false,
      intervention: false,
      dragonTerminal: false,
      clientDeathObserved,
      declaredInterventionCount: declarations.length + hintEvidence.declaredCount,
      source: 'future_passive_server_auditor',
    },
    timingContract: {
      startEvent: 'first_server_tick_after_natural_spawn_and_bot_control',
      endEvent: 'authoritative_dragon_death_tick',
      primaryClock: 'uninterrupted_wall_time',
      authoritative: false,
    },
  };
  return record;
}

function fallbackIncompleteRecord(record, entrypointPath, reasonCode, profileHint) {
  const context = contexts.get(record);
  const profile = normalizeProfile(profileHint || context?.profile || process.env.MCBOT_EVIDENCE_PROFILE);
  const safeObject = (value) => {
    try {
      return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
    } catch {
      return {};
    }
  };
  const existingProvenance = safeObject(record?.provenance);
  const existingRepository = safeObject(existingProvenance.repository);
  const existingFixture = safeObject(record?.fixtureMutations);
  const existingHints = safeObject(existingFixture.targetHints);
  const recordWorld = safeObject(record?.world);
  let contextWorld = {};
  if (context?.world) {
    try {
      contextWorld = normalizedWorld({}, context, { world: context.world });
    } catch {
      contextWorld = safeObject(context.world);
    }
  }
  const existingWorld = {
    ...contextWorld,
    ...recordWorld,
    origin: recordWorld.origin || contextWorld.origin,
    opaqueIdentitySha256: recordWorld.opaqueIdentitySha256 || contextWorld.opaqueIdentitySha256,
    pristineMarker: recordWorld.pristineMarker || contextWorld.pristineMarker,
  };
  const existingValidity = safeObject(record?.validity);
  const rawCommands = mergeCommandEvidence(
    Array.isArray(context?.fixtureCommands) ? context.fixtureCommands : [],
    Array.isArray(existingFixture.declared) ? existingFixture.declared : [],
  );
  const declarations = rawCommands
    .map((entry) => ({
      command: normalizeCommand(entry?.command ?? entry),
      source: String(entry?.source || 'harness'),
    }))
    .filter((entry) => entry.command)
    .map((entry, index) => ({
      index,
      command: entry.command,
      sha256: sha256Text(entry.command),
      category: commandCategory(entry.command),
      source: entry.source,
    }));
  const rawReceipts = mergeCommandEvidence(
    Array.isArray(context?.fixtureReceipts) ? context.fixtureReceipts : [],
    Array.isArray(existingFixture.appliedReceipts) ? existingFixture.appliedReceipts : [],
  );
  const receipts = rawReceipts
    .map((entry) => {
      const command = normalizeCommand(entry?.command ?? entry);
      const authoritative = entry?.authority === 'server_command_receipt.v1';
      const successful = authoritative && entry?.status === 'applied' && entry?.result === 'completed';
      const failed = authoritative && (entry?.status === 'failed' || entry?.result === 'failed');
      return {
        command,
        authority: authoritative ? 'server_command_receipt.v1' : 'transport_observation.v1',
        status: successful ? 'applied' : (failed ? 'failed' : 'unknown'),
        result: successful ? 'completed' : (failed ? 'failed' : 'unverified'),
        resultCode: authoritative && Number.isInteger(entry?.resultCode) ? entry.resultCode : null,
      };
    })
    .filter((entry) => entry.command)
    .map((entry, index) => ({
      index,
      command: entry.command,
      sha256: sha256Text(entry.command),
      category: commandCategory(entry.command),
      authority: entry.authority,
      status: entry.status,
      result: entry.result,
      resultCode: entry.resultCode,
    }));
  const rawHints = mergeTargetHintEvidence(
    Array.isArray(context?.targetHints) ? context.targetHints : [],
    Array.isArray(existingHints.declared)
      ? existingHints.declared.map((entry) => entry?.hint).filter((hint) => hint !== undefined)
      : [],
  );
  const hints = rawHints.map((hint, index) => ({
    index,
    hint: canonicalValue(hint),
    sha256: sha256Text(canonicalJson(hint)),
    category: 'mission_target_hint',
    source: 'harness',
  }));
  const declarationProjection = declarations.map(({ index, sha256, category, source }) => ({ index, sha256, category, source }));
  const receiptProjection = receipts.map(({ index, sha256, category, authority, status, result, resultCode }) => ({
    index, sha256, category, authority, status, result, resultCode,
  }));
  const hintProjection = hints.map(({ index, sha256, category, source }) => ({ index, sha256, category, source }));
  const existingState = {
    ...safeObject(contextWorld.state),
    ...safeObject(recordWorld.state),
  };
  const existingStateValidation = {
    ...safeObject(contextWorld.stateValidation),
    ...safeObject(recordWorld.stateValidation),
  };
  const existingReasons = Array.isArray(existingValidity.reasonCodes) ? existingValidity.reasonCodes : [];
  const entrypoint = context?.entrypoint || safeObject(existingProvenance.entrypoint);
  const effectiveConfig = context?.effectiveConfig || safeObject(existingProvenance.effectiveConfig);
  return Object.assign(record, {
    resultSchemaVersion: 2,
    provenance: {
      ...existingProvenance,
      repository: {
        ...existingRepository,
        start: context?.startGit || existingRepository.start || null,
        finish: context?.finishGit || existingRepository.finish || context?.startGit || existingRepository.start || null,
        stable: false,
      },
      effectiveConfig: Object.keys(effectiveConfig).length > 0 ? effectiveConfig : { sha256: null },
      entrypoint: Object.keys(entrypoint).length > 0
        ? entrypoint
        : { sha256: null, fileName: path.basename(String(entrypointPath || 'unknown')) },
    },
    world: {
      ...existingWorld,
      origin: ORIGINS.has(existingWorld.origin) ? existingWorld.origin : 'existing_or_unknown',
      opaqueIdentitySha256: existingWorld.opaqueIdentitySha256 || null,
      pristineMarker: existingWorld.pristineMarker || null,
      state: {
        initial: existingState.initial || null,
        postSetup: existingState.postSetup || null,
        terminal: existingState.terminal || null,
      },
      stateValidation: existingStateValidation,
    },
    fixtureMutations: {
      ...existingFixture,
      localEvidenceContainsCommands: true,
      declared: declarations,
      appliedReceipts: receipts,
      declaredCount: declarations.length,
      appliedCount: receipts.filter((entry) => entry.status === 'applied').length,
      allDeclaredApplied: false,
      validation: {
        ...safeObject(existingFixture.validation),
        schemaVersion: 1,
        status: 'invalid',
        issues: [...new Set([
          ...(Array.isArray(existingFixture.validation?.issues) ? existingFixture.validation.issues : []),
          'evidence_completion_failed',
          'fixture_receipts_incomplete',
        ])].sort(),
      },
      categories: [...new Set(declarations.map((entry) => entry.category))].sort(),
      declaredDigestSha256: sha256Text(canonicalJson(declarationProjection)),
      receiptDigestSha256: sha256Text(canonicalJson(receiptProjection)),
      targetHints: {
        ...existingHints,
        localEvidenceContainsExactHints: true,
        declared: hints,
        declaredCount: hints.length,
        categories: [...new Set(hints.map((entry) => entry.category))].sort(),
        declaredDigestSha256: sha256Text(canonicalJson(hintProjection)),
      },
    },
    validity: {
      ...existingValidity,
      profile,
      evidenceCompleteness: 'incomplete',
      classification: 'incomplete',
      scenarioOutcomeIndependent: true,
      northStarEligible: false,
      reasonCodes: [...new Set([
        ...existingReasons,
        'evidence_completion_failed',
        reasonCode || 'wrapper_fatal_error',
        'passive_server_auditor_not_implemented',
      ])].sort(),
      authoritativeProof: {
        death: false,
        intervention: false,
        dragonTerminal: false,
        clientDeathObserved: knownClientDeathObserved(record),
        declaredInterventionCount: declarations.length + hints.length,
        source: 'future_passive_server_auditor',
      },
      timingContract: {
        startEvent: 'first_server_tick_after_natural_spawn_and_bot_control',
        endEvent: 'authoritative_dragon_death_tick',
        primaryClock: 'uninterrupted_wall_time',
        authoritative: false,
      },
    },
  });
}

export function writeLiveEvidenceJson(filePath, record, options = {}) {
  let completed = record;
  try {
    completed = completeLiveEvidence(record, options);
  } catch {
    completed = fallbackIncompleteRecord(record, options.entrypointPath, options.reasonCode, contexts.get(record)?.profile);
  }
  const fullPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const temporaryPath = path.join(path.dirname(fullPath), `.${path.basename(fullPath)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(completed, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, fullPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
  return completed;
}

export function writeLiveEvidenceReportPair(resultPath, record, renderMarkdown, options = {}) {
  const {
    markdownWriter = (filePath, value) => fs.writeFileSync(filePath, value, 'utf8'),
    ...evidenceOptions
  } = options;
  const completed = writeLiveEvidenceJson(resultPath, record, evidenceOptions);
  try {
    const markdown = typeof renderMarkdown === 'function' ? renderMarkdown(completed) : String(renderMarkdown ?? '');
    markdownWriter(companionMarkdownPath(resultPath), markdown);
  } catch (error) {
    markLiveEvidenceIncomplete(record, 'wrapper_fatal_error');
    writeLiveEvidenceJson(resultPath, record, { ...evidenceOptions, refreshFinishGit: true });
    throw error;
  }
  return completed;
}

export function liveEvidenceV2Integrity(record) {
  if (!record || record.resultSchemaVersion !== 2) return false;
  const { provenance, world, fixtureMutations, validity } = record;
  if (![provenance, world, fixtureMutations, validity].every((value) => value && typeof value === 'object')) return false;
  if (!PROFILES.has(validity.profile)
    || !CLASSIFICATIONS.has(validity.classification)
    || !COMPLETENESS.has(validity.evidenceCompleteness)) return false;
  if ((validity.evidenceCompleteness === 'incomplete') !== (validity.classification === 'incomplete')) return false;
  if (validity.classification !== 'incomplete'
    && validity.classification !== classificationFor(validity.profile, validity.evidenceCompleteness)) return false;
  if (validity.scenarioOutcomeIndependent !== true || validity.northStarEligible !== false) return false;
  if (!Array.isArray(validity.reasonCodes)
    || !validity.reasonCodes.includes('passive_server_auditor_not_implemented')) return false;
  const proof = validity.authoritativeProof;
  if (!proof || proof.death !== false || proof.intervention !== false || proof.dragonTerminal !== false
    || proof.source !== 'future_passive_server_auditor') return false;
  const timing = validity.timingContract;
  if (!timing
    || timing.startEvent !== 'first_server_tick_after_natural_spawn_and_bot_control'
    || timing.endEvent !== 'authoritative_dragon_death_tick'
    || timing.primaryClock !== 'uninterrupted_wall_time'
    || timing.authoritative !== false) return false;
  if (!ORIGINS.has(world.origin) || !fixtureMutations.targetHints || !fixtureMutations.validation) return false;
  const originAttested = worldOriginAttestationValid(world, validity.profile);
  if (!originAttested && validity.evidenceCompleteness !== 'incomplete') return false;
  const hasCalibrationCases = Object.prototype.hasOwnProperty.call(record, 'cases');
  const hasCalibrationLedger = Object.prototype.hasOwnProperty.call(record, 'calibrationCaseLedger');
  if ((hasCalibrationCases || hasCalibrationLedger) && !calibrationCaseLedgerIntegrity(record)) return false;
  if (validity.evidenceCompleteness !== 'incomplete') {
    if (provenance.repository?.start?.available !== true
      || provenance.repository?.finish?.available !== true
      || !GIT_HASH_RE.test(provenance.repository?.start?.sha || '')
      || !GIT_HASH_RE.test(provenance.repository?.finish?.sha || '')
      || !Number.isSafeInteger(provenance.repository?.start?.dirtyCount)
      || provenance.repository.start.dirtyCount < 0
      || !Number.isSafeInteger(provenance.repository?.finish?.dirtyCount)
      || provenance.repository.finish.dirtyCount < 0
      || !HASH_RE.test(provenance.repository?.start?.dirtyDigestSha256 || '')
      || !HASH_RE.test(provenance.repository?.finish?.dirtyDigestSha256 || '')
      || typeof provenance.repository?.stable !== 'boolean'
      || !HASH_RE.test(provenance.effectiveConfig?.sha256 || '')
      || !HASH_RE.test(provenance.entrypoint?.sha256 || '')
      || !HASH_RE.test(fixtureMutations.declaredDigestSha256 || '')
      || !HASH_RE.test(fixtureMutations.receiptDigestSha256 || '')
      || !HASH_RE.test(fixtureMutations.targetHints.declaredDigestSha256 || '')
      || !Number.isSafeInteger(Number(fixtureMutations.declaredCount))
      || Number(fixtureMutations.declaredCount) < 0
      || !Number.isSafeInteger(Number(fixtureMutations.appliedCount))
      || Number(fixtureMutations.appliedCount) < 0
      || !Number.isSafeInteger(Number(fixtureMutations.targetHints.declaredCount))
      || Number(fixtureMutations.targetHints.declaredCount) < 0
      || typeof fixtureMutations.allDeclaredApplied !== 'boolean') return false;
    const computedRepositoryStable = repositoryStable(
      provenance.repository.start,
      provenance.repository.finish,
    );
    if (provenance.repository.stable !== computedRepositoryStable) return false;
    const nodeFixtureSchema = fixtureMutations.validation.schemaVersion === 1;
    const fabricFixtureSchema = !nodeFixtureSchema
      && Object.prototype.hasOwnProperty.call(fixtureMutations.validation, 'declarationsFrozen');
    if (nodeFixtureSchema) {
      if (!nodeFixtureIntegrity(fixtureMutations)) return false;
    } else if (fabricFixtureSchema) {
      if (!fabricFixtureIntegrity(fixtureMutations)) return false;
    } else {
      return false;
    }
  }
  if (validity.evidenceCompleteness === 'complete') {
    if (!HASH_RE.test(world.opaqueIdentitySha256 || '')
      || provenance.repository.stable !== true
      || fixtureMutations.validation.status !== 'valid'
      || fixtureMutations.allDeclaredApplied !== true) return false;
    return ['initial', 'postSetup', 'terminal'].every((phase) => (
      world.stateValidation?.[phase]?.valid === true && isCompleteWorldState(world.state?.[phase])
    ));
  }
  return true;
}

function calibrationCaseLedgerIntegrity(record) {
  if (!record.cases || typeof record.cases !== 'object' || Array.isArray(record.cases)) return false;
  const ledger = record.calibrationCaseLedger;
  const caseIds = Object.keys(record.cases).sort();
  const normalizedUnclassified = Array.isArray(ledger?.unclassifiedCaseIds)
    ? [...new Set(ledger.unclassifiedCaseIds.map(String))]
      .filter((caseId) => caseIds.includes(caseId))
      .sort()
    : null;
  const casesDigestSha256 = sha256Text(canonicalJson(record.cases));
  if (!ledger || ![1, 2].includes(ledger.schemaVersion)) return false;
  const classifiedCaseIds = normalizedUnclassified === null
    ? null
    : caseIds.filter((caseId) => !normalizedUnclassified.includes(caseId));
  const ledgerCore = ledger.schemaVersion === 2
    ? {
        schemaVersion: 2,
        caseIds,
        classifiedCaseIds,
        unclassifiedCaseIds: normalizedUnclassified,
        classificationCycleComplete: normalizedUnclassified?.length === 0,
        casesDigestSha256,
      }
    : {
        schemaVersion: 1,
        caseIds,
        unclassifiedCaseIds: normalizedUnclassified,
        casesDigestSha256,
      };
  return Boolean(ledger
    && Array.isArray(ledger.caseIds)
    && Array.isArray(ledger.unclassifiedCaseIds)
    && canonicalJson(ledger.caseIds) === canonicalJson(caseIds)
    && canonicalJson(ledger.unclassifiedCaseIds) === canonicalJson(normalizedUnclassified)
    && (ledger.schemaVersion !== 2 || (
      Array.isArray(ledger.classifiedCaseIds)
      && canonicalJson(ledger.classifiedCaseIds) === canonicalJson(classifiedCaseIds)
      && ledger.classificationCycleComplete === (normalizedUnclassified.length === 0)
    ))
    && ledger.casesDigestSha256 === casesDigestSha256
    && ledger.ledgerDigestSha256 === sha256Text(canonicalJson(ledgerCore)));
}

function nodeFixtureIntegrity(fixture) {
  if (fixture.validation?.schemaVersion !== 1
    || fixture.localEvidenceContainsCommands !== true
    || fixture.targetHints?.localEvidenceContainsExactHints !== true
    || !Array.isArray(fixture.declared)
    || !Array.isArray(fixture.appliedReceipts)
    || !Array.isArray(fixture.categories)
    || !Array.isArray(fixture.validation?.issues)
    || !Array.isArray(fixture.targetHints?.declared)
    || !Array.isArray(fixture.targetHints?.categories)) return false;

  const declarations = fixture.declared;
  const receipts = fixture.appliedReceipts;
  const hints = fixture.targetHints.declared;
  if (Number(fixture.declaredCount) !== declarations.length
    || Number(fixture.appliedCount) !== receipts.filter((entry) => entry?.status === 'applied').length
    || Number(fixture.targetHints.declaredCount) !== hints.length) return false;

  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    const command = normalizeCommand(declaration?.command);
    if (!declaration
      || declaration.index !== index
      || declaration.command !== command
      || !command
      || declaration.sha256 !== sha256Text(command)
      || declaration.category !== commandCategory(command)
      || typeof declaration.source !== 'string') return false;
  }
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    const command = normalizeCommand(receipt?.command);
    if (!Number.isInteger(receipt?.index)
      || receipt.index !== index
      || receipt.command !== command
      || !command
      || receipt.sha256 !== sha256Text(command)
      || receipt.category !== commandCategory(command)
      || !['server_command_receipt.v1', 'transport_observation.v1'].includes(receipt.authority)
      || !['applied', 'failed', 'unknown'].includes(receipt.status)
      || !['completed', 'failed', 'unverified'].includes(receipt.result)
      || (receipt.authority === 'transport_observation.v1'
        && (receipt.status !== 'unknown' || receipt.result !== 'unverified' || receipt.resultCode !== null))
      || (receipt.authority === 'server_command_receipt.v1'
        && !((receipt.status === 'applied' && receipt.result === 'completed')
          || (receipt.status === 'failed' && receipt.result === 'failed')))
      || (receipt.resultCode !== null && !Number.isInteger(receipt.resultCode))) return false;
  }
  for (let index = 0; index < hints.length; index += 1) {
    const hint = hints[index];
    if (!hint
      || hint.index !== index
      || hint.sha256 !== sha256Text(canonicalJson(hint.hint))
      || hint.category !== 'mission_target_hint'
      || typeof hint.source !== 'string') return false;
  }

  const declarationProjection = declarations.map(({ index, sha256, category, source }) => ({ index, sha256, category, source }));
  const receiptProjection = receipts.map(({ index, sha256, category, authority, status, result, resultCode }) => ({
    index, sha256, category, authority, status, result, resultCode,
  }));
  const hintProjection = hints.map(({ index, sha256, category, source }) => ({ index, sha256, category, source }));
  const fixtureAssessment = nodeFixtureAssessment(declarations, receipts);
  const { allDeclaredApplied } = fixtureAssessment;
  const expectedCategories = [...new Set(declarations.map((entry) => entry.category))].sort();
  const expectedHintCategories = [...new Set(hints.map((entry) => entry.category))].sort();
  return fixture.allDeclaredApplied === allDeclaredApplied
    && fixture.validation.status === (allDeclaredApplied ? 'valid' : 'invalid')
    && canonicalJson([...fixture.validation.issues].sort()) === canonicalJson(fixtureAssessment.issues)
    && canonicalJson(fixture.categories) === canonicalJson(expectedCategories)
    && canonicalJson(fixture.targetHints.categories) === canonicalJson(expectedHintCategories)
    && fixture.declaredDigestSha256 === sha256Text(canonicalJson(declarationProjection))
    && fixture.receiptDigestSha256 === sha256Text(canonicalJson(receiptProjection))
    && fixture.targetHints.declaredDigestSha256 === sha256Text(canonicalJson(hintProjection));
}

function fabricFixtureIntegrity(fixture) {
  const validation = fixture.validation;
  const declarations = fixture.declared;
  const receipts = fixture.appliedReceipts;
  const hints = fixture.targetHints?.declared;
  if (validation?.schemaVersion !== undefined
    || validation?.declarationsFrozen !== true
    || !['valid', 'invalid'].includes(validation?.status)
    || fixture.localEvidenceContainsCommands !== true
    || fixture.targetHints?.localEvidenceContainsExactHints !== true
    || !Array.isArray(declarations)
    || !Array.isArray(receipts)
    || !Array.isArray(hints)
    || !Array.isArray(fixture.categories)
    || !Array.isArray(fixture.targetHints.categories)
    || !Array.isArray(validation.issues)
    || Number(validation.frozenDeclarationCount) !== declarations.length
    || Number(fixture.targetHints.frozenDeclarationCount) !== hints.length
    || Number(fixture.declaredCount) !== declarations.length
    || Number(fixture.appliedCount) !== receipts.filter((entry) => entry?.status === 'applied').length
    || Number(fixture.targetHints.declaredCount) !== hints.length) return false;

  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    const command = normalizeCommand(declaration?.command);
    if (!declaration
      || declaration.index !== index
      || !Number.isInteger(declaration.batch)
      || declaration.batch < 0
      || !Number.isInteger(declaration.batchIndex)
      || declaration.batchIndex < 0
      || declaration.command !== command
      || !command
      || declaration.sha256 !== sha256Text(command)
      || declaration.category !== fabricCommandCategory(command)
      || typeof declaration.source !== 'string') return false;
  }
  for (let index = 0; index < hints.length; index += 1) {
    const hint = hints[index];
    if (!hint
      || hint.index !== index
      || hint.sha256 !== sha256Text(canonicalJson(hint.hint))
      || hint.category !== 'mission_target_hint'
      || typeof hint.source !== 'string') return false;
  }
  if (receipts.length !== declarations.length) return validation.status === 'invalid'
    && fixture.allDeclaredApplied === false
    && fabricFixtureDigestsValid(fixture, declarations, receipts, hints);
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    const declaration = declarations[index];
    const command = normalizeCommand(receipt?.command);
    if (!receipt
      || receipt.index !== declaration.batchIndex
      || receipt.command !== command
      || !command
      || receipt.sha256 !== sha256Text(command)
      || receipt.sha256 !== declaration.sha256
      || receipt.category !== fabricCommandCategory(command)
      || typeof receipt.batchId !== 'string'
      || typeof receipt.commandId !== 'string'
      || !['applied', 'failed'].includes(receipt.status)
      || !['completed', 'failed'].includes(receipt.result)
      || (receipt.resultCode !== null && !Number.isInteger(receipt.resultCode))) return false;
  }
  const receiptsApplied = receipts.every((receipt) => (
    receipt.status === 'applied'
    && receipt.result === 'completed'
    && Number.isInteger(receipt.resultCode)
    && receipt.resultCode >= 0
  ));
  if (fixture.allDeclaredApplied !== (validation.status === 'valid')) return false;
  if (validation.status === 'valid' && (!receiptsApplied
    || validation.issues.length !== 0
    || String(validation.traceReadErrorType || '') !== ''
    || Number(validation.invalidTracePayloadCount) !== 0
    || validation.expectedInstanceMissing !== false
    || Number(validation.foreignInstanceMarkerCount) !== 0
    || !Array.isArray(validation.declarationIntegrityIssues)
    || validation.declarationIntegrityIssues.length !== 0
    || !Number.isSafeInteger(Number(validation.checkpointCount))
    || Number(validation.checkpointCount) < 1
    || !HASH_RE.test(validation.finalCheckpointDigestSha256 || ''))) return false;
  return fabricFixtureDigestsValid(fixture, declarations, receipts, hints);
}

function fabricCommandCategory(command) {
  const normalized = String(command || '').trim().replace(/^\//, '');
  const verb = normalized.split(/\s+/, 1)[0].toLowerCase();
  if (/^(difficulty|gamemode|gamerule)$/.test(verb)) return 'rules_and_mode';
  if (/^(tp|teleport|spreadplayers|spawnpoint|setworldspawn)$/.test(verb)) return 'position_and_spawn';
  if (/^(give|clear|item|effect|experience|xp|enchant)$/.test(verb)) return 'player_and_inventory';
  if (/^(setblock|fill|clone|place)$/.test(verb)) return 'blocks';
  if (/^(summon|kill|damage|ride)$/.test(verb)) return 'entities';
  if (/^(time|weather)$/.test(verb)) return 'time_and_weather';
  return normalized ? 'other_server_command' : 'empty';
}

function fabricFixtureDigestsValid(fixture, declarations, receipts, hints) {
  const declarationProjection = declarations.map(({ index, batch, batchIndex, sha256, category, source }) => ({
    index, batch, batchIndex, sha256, category, source,
  }));
  const receiptProjection = receipts.map((receipt) => ({
    batchIdSha256: sha256Text(String(receipt.batchId || '')),
    commandIdSha256: sha256Text(String(receipt.commandId || '')),
    index: receipt.index,
    sha256: receipt.sha256,
    category: receipt.category,
    status: receipt.status,
    result: receipt.result,
    resultCode: receipt.resultCode === null ? null : Number(receipt.resultCode),
    errorTypeSha256: String(receipt.errorType || '').trim() ? sha256Text(String(receipt.errorType)) : null,
  }));
  const hintProjection = hints.map(({ index, sha256, category, source }) => ({ index, sha256, category, source }));
  const expectedCategories = [...new Set(declarations.map((entry) => entry.category))].sort();
  const expectedHintCategories = [...new Set(hints.map((entry) => entry.category))].sort();
  return canonicalJson(fixture.categories) === canonicalJson(expectedCategories)
    && canonicalJson(fixture.targetHints.categories) === canonicalJson(expectedHintCategories)
    && fixture.declaredDigestSha256 === sha256Text(canonicalJson(declarationProjection))
    && fixture.receiptDigestSha256 === sha256Text(canonicalJson(receiptProjection))
    && fixture.targetHints.declaredDigestSha256 === sha256Text(canonicalJson(hintProjection));
}

export function publicLiveEvidenceSummary(record) {
  if (!record || record.resultSchemaVersion !== 2) {
    return { resultSchemaVersion: null, classification: 'legacy_unclassified', northStarEligible: false };
  }
  const integrityValid = liveEvidenceV2Integrity(record);
  const profile = PROFILES.has(record.validity?.profile) ? record.validity.profile : 'development_fixture.v1';
  const classification = integrityValid && CLASSIFICATIONS.has(record.validity?.classification)
    ? record.validity.classification
    : 'incomplete';
  const evidenceCompleteness = integrityValid && COMPLETENESS.has(record.validity?.evidenceCompleteness)
    ? record.validity.evidenceCompleteness
    : 'incomplete';
  const fixtureCategories = Array.isArray(record.fixtureMutations?.categories) ? record.fixtureMutations.categories : [];
  const hintCategories = Array.isArray(record.fixtureMutations?.targetHints?.categories)
    ? record.fixtureMutations.targetHints.categories
    : [];
  const reasonCodes = Array.isArray(record.validity?.reasonCodes) ? record.validity.reasonCodes : [];
  return {
    resultSchemaVersion: 2,
    profile,
    classification,
    evidenceCompleteness,
    northStarEligible: false,
    repositoryStartSha: GIT_HASH_RE.test(record.provenance?.repository?.start?.sha || '') ? record.provenance.repository.start.sha : null,
    repositoryFinishSha: GIT_HASH_RE.test(record.provenance?.repository?.finish?.sha || '') ? record.provenance.repository.finish.sha : null,
    repositoryStable: integrityValid && record.provenance?.repository?.stable === true,
    effectiveConfigSha256: HASH_RE.test(record.provenance?.effectiveConfig?.sha256 || '') ? record.provenance.effectiveConfig.sha256 : null,
    entrypointSha256: HASH_RE.test(record.provenance?.entrypoint?.sha256 || '') ? record.provenance.entrypoint.sha256 : null,
    worldOrigin: ORIGINS.has(record.world?.origin) ? record.world.origin : 'existing_or_unknown',
    fixtureDeclaredCount: Math.max(0, Number(record.fixtureMutations?.declaredCount) || 0),
    fixtureAppliedCount: Math.max(0, Number(record.fixtureMutations?.appliedCount) || 0),
    fixtureCategories: [...new Set(fixtureCategories)]
      .filter((category) => COMMAND_CATEGORIES.has(category))
      .sort(),
    fixtureDeclaredDigestSha256: HASH_RE.test(record.fixtureMutations?.declaredDigestSha256 || '') ? record.fixtureMutations.declaredDigestSha256 : null,
    fixtureReceiptDigestSha256: HASH_RE.test(record.fixtureMutations?.receiptDigestSha256 || '') ? record.fixtureMutations.receiptDigestSha256 : null,
    targetHintCount: Math.max(0, Number(record.fixtureMutations?.targetHints?.declaredCount) || 0),
    targetHintCategories: [...new Set(hintCategories)]
      .filter((category) => category === 'mission_target_hint')
      .sort(),
    targetHintDigestSha256: HASH_RE.test(record.fixtureMutations?.targetHints?.declaredDigestSha256 || '')
      ? record.fixtureMutations.targetHints.declaredDigestSha256
      : null,
    reasonCodes: [...new Set([
      ...reasonCodes.filter((reason) => PUBLIC_REASON_CODES.has(reason)),
      ...(integrityValid ? [] : ['child_result_invalid']),
    ])].sort(),
  };
}
