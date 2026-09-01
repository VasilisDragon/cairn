import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RESOURCE_LOCK_PROTOCOL = 'mcbot.exclusive-resource-lock.v1';
export const RESOURCE_LOCK_ENV = Object.freeze({
  path: 'MCBOT_RESOURCE_LOCK_PATH',
  ownerId: 'MCBOT_RESOURCE_LOCK_OWNER_ID',
  repositoryId: 'MCBOT_RESOURCE_LOCK_REPOSITORY_ID',
  ownerPid: 'MCBOT_RESOURCE_LOCK_OWNER_PID',
});

const OWNER_FILE = 'owner.json';
const CLOSING_FILE = 'closing.json';
const WORKLOAD_CHILD_PREFIX = 'workload-child-';
const DEFAULT_STALE_GRACE_MS = 30_000;
const EVENT_LIMIT_BYTES = 4_096;
const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const ROLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const MAX_PROCESS_IDENTITY_LENGTH = 512;
const TEST_ONLY_LOCK_ROOT_BY_ENVIRONMENT = new WeakMap();
const RESOURCE_CONTROL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export function createTestOnlyResourceLockEnvironment(baseDirectory, initialEnvironment = {}) {
  if (typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory)) {
    throw new Error('test-only resource-lock root must be an absolute path');
  }
  const environment = { ...initialEnvironment };
  TEST_ONLY_LOCK_ROOT_BY_ENVIRONMENT.set(environment, path.resolve(baseDirectory));
  return environment;
}

function isPositivePid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isOwnerId(value) {
  return typeof value === 'string' && OWNER_ID_PATTERN.test(value);
}

function isProcessStartIdentity(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PROCESS_IDENTITY_LENGTH
    && !/[\r\n\0]/.test(value);
}

function isRole(value) {
  return typeof value === 'string' && ROLE_PATTERN.test(value);
}

function isCompleteOwnerIdentity(owner) {
  return isOwnerId(owner?.id)
    && isPositivePid(owner?.pid)
    && isProcessStartIdentity(owner?.processStartIdentity);
}

export class ResourceLockBusyError extends Error {
  constructor(observation) {
    const owner = observation?.metadata?.owner || {};
    const ownerSummary = [
      owner.purpose ? `purpose=${owner.purpose}` : null,
      Number.isInteger(owner.pid) ? `pid=${owner.pid}` : null,
      owner.processStartUtc ? `started=${owner.processStartUtc}` : null,
      observation?.state ? `state=${observation.state}` : null,
    ].filter(Boolean).join(' ');
    super(`MCBot resource lock is already held${ownerSummary ? ` (${ownerSummary})` : ''}`);
    this.name = 'ResourceLockBusyError';
    this.code = 'MCBOT_RESOURCE_LOCK_BUSY';
    this.observation = observation;
  }
}

function slash(value) {
  return value.replaceAll('\\', '/');
}

function canonicalPath(value, platform = process.platform) {
  let resolved = path.resolve(value);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // The caller reports a more useful error when a required path is absent.
  }
  resolved = slash(resolved).replace(/\/+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolveGitDirectory(repositoryRoot) {
  const dotGit = path.join(repositoryRoot, '.git');
  let markerPath = dotGit;
  let stat = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    markerPath = fs.realpathSync.native(markerPath);
    stat = fs.statSync(markerPath);
  }
  if (stat.isDirectory()) return fs.realpathSync.native(markerPath);
  if (!stat.isFile()) return null;
  const match = /^gitdir:\s*(.+?)\s*$/im.exec(fs.readFileSync(markerPath, 'utf8'));
  if (!match) return null;
  const gitDirectory = path.resolve(repositoryRoot, match[1]);
  return fs.realpathSync.native(gitDirectory);
}

export function resolveRepositoryScope(repositoryRoot, platform = process.platform) {
  if (!repositoryRoot || !fs.statSync(repositoryRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`resource lock repository root does not exist: ${repositoryRoot}`);
  }
  const root = fs.realpathSync.native(repositoryRoot);
  const gitDirectory = resolveGitDirectory(root);
  let scopePath = root;
  let scopeKind = 'worktree';
  if (gitDirectory) {
    const commonDirFile = path.join(gitDirectory, 'commondir');
    const commonDirText = fs.existsSync(commonDirFile)
      ? fs.readFileSync(commonDirFile, 'utf8').trim()
      : '';
    const commonGitDirectory = commonDirText
      ? fs.realpathSync.native(path.resolve(gitDirectory, commonDirText))
      : gitDirectory;
    scopePath = commonGitDirectory;
    scopeKind = 'git-common-directory';
  }
  const canonicalScope = canonicalPath(scopePath, platform);
  return {
    repositoryRoot: canonicalPath(root, platform),
    scopeKind,
    scopePath: canonicalScope,
    repositoryId: crypto.createHash('sha256').update(canonicalScope).digest('hex'),
  };
}

export function resolveResourceLockLocation(repositoryRoot, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const scope = resolveRepositoryScope(repositoryRoot, platform);
  const defaultBase = path.join(scope.scopePath, 'mcbot-resource-locks');
  // Production always uses one repository-common canonical base. Linked Git
  // worktrees resolve the same common .git directory, and no caller-controlled
  // environment path can split the exclusive lock. Tests can receive an
  // isolated root only through the identity-bound environment object made
  // by createTestOnlyResourceLockEnvironment; an ambient variable is ignored.
  const baseDirectory = TEST_ONLY_LOCK_ROOT_BY_ENVIRONMENT.get(env) || path.resolve(defaultBase);
  const shortId = scope.repositoryId.slice(0, 32);
  return {
    ...scope,
    baseDirectory,
    lockPath: path.join(baseDirectory, `${shortId}.lock`),
    eventsPath: path.join(baseDirectory, `${shortId}.events.jsonl`),
  };
}

function windowsProcessIdentity(pid) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const windowsPowerShell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const executable = fs.existsSync(windowsPowerShell) ? windowsPowerShell : 'pwsh.exe';
  const command = '$ErrorActionPreference="Stop";'
    + `try{$p=[Diagnostics.Process]::GetProcessById(${pid});$ticks=$p.StartTime.ToUniversalTime().Ticks;`
    + `$c=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop;`
    // Process.StartTime and CIM CreationDate can differ by a few 100 ns ticks
    // while describing the same Windows creation time. Bind CIM to the stable
    // Process handle within 1 ms, then require the second Process snapshot to
    // retain the original exact tick identity.
    + '$cticks=$c.CreationDate.ToUniversalTime().Ticks;if([Math]::Abs([int64]$cticks-[int64]$ticks) -gt 10000){throw "PID_REUSED"};'
    + `$p2=[Diagnostics.Process]::GetProcessById(${pid});if($p2.StartTime.ToUniversalTime().Ticks -ne $ticks){throw "PID_REUSED"};`
    + '$utc=$p.StartTime.ToUniversalTime().ToString("o",[Globalization.CultureInfo]::InvariantCulture);'
    + '[Console]::Out.Write("RUNNING|"+$ticks+"|"+$utc+"|"+$c.ParentProcessId)}'
    + 'catch [ArgumentException]{[Console]::Out.Write("ABSENT")}'
    + 'catch{[Console]::Out.Write("UNKNOWN")}';
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 8_192,
  });
  const output = String(result.stdout || '').trim();
  if (output === 'ABSENT') return { state: 'absent' };
  if (output === 'UNKNOWN' || result.error || result.status !== 0) return { state: 'unknown' };
  const match = /^RUNNING\|(\d+)\|(.+)\|(\d+)$/.exec(output);
  if (!match) return { state: 'unknown' };
  return {
    state: 'running',
    identity: `windows-start-ticks:${match[1]}`,
    startUtc: match[2],
    parentPid: Number(match[3]),
  };
}

function procProcessIdentity(pid) {
  const statPath = `/proc/${pid}/stat`;
  try {
    const stat = fs.readFileSync(statPath, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return { state: 'unknown' };
    const fieldsFromState = stat.slice(close + 2).trim().split(/\s+/);
    const startTicks = fieldsFromState[19];
    if (!/^\d+$/.test(startTicks || '')) return { state: 'unknown' };
    const parentPid = Number(fieldsFromState[1]);
    if (!Number.isSafeInteger(parentPid) || parentPid < 0) return { state: 'unknown' };
    return { state: 'running', identity: `proc-start-ticks:${startTicks}`, parentPid };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return { state: 'absent' };
    return { state: 'unknown' };
  }
}

function portableProcessIdentity(pid) {
  const result = spawnSync('ps', ['-o', 'ppid=', '-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 8_192,
  });
  const output = String(result.stdout || '').trim().replace(/\s+/g, ' ');
  if (result.status === 1 && !output) return { state: 'absent' };
  if (result.error || result.status !== 0 || !output) return { state: 'unknown' };
  const match = /^(\d+)\s+(.+)$/.exec(output);
  if (!match) return { state: 'unknown' };
  return { state: 'running', identity: `ps-lstart:${match[2]}`, parentPid: Number(match[1]) };
}

export function getProcessStartIdentity(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'absent' };
  if (platform === 'win32') return windowsProcessIdentity(pid);
  if (fs.existsSync('/proc')) return procProcessIdentity(pid);
  return portableProcessIdentity(pid);
}

function readJsonFile(filePath) {
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function directoryAgeMs(lockPath, nowMs) {
  try {
    const stat = fs.statSync(lockPath);
    return Math.max(0, nowMs - Math.max(stat.birthtimeMs || 0, stat.mtimeMs || 0));
  } catch {
    return null;
  }
}

export function classifyResourceLockOwner(input) {
  const {
    metadata,
    metadataError,
    ageMs,
    repositoryId,
    hostname = os.hostname(),
    staleGraceMs = DEFAULT_STALE_GRACE_MS,
    inspectProcess = getProcessStartIdentity,
  } = input;
  if (!Number.isFinite(staleGraceMs) || staleGraceMs < 0) {
    throw new Error('resource-lock stale grace must be a finite non-negative number');
  }
  if (!metadata || metadataError) {
    return {
      state: ageMs !== null && ageMs >= staleGraceMs ? 'damaged_unverifiable' : 'initializing',
      reclaimable: false,
      reason: metadataError ? 'owner_metadata_unreadable' : 'owner_metadata_missing',
    };
  }
  if (metadata.protocol !== RESOURCE_LOCK_PROTOCOL || metadata.repository?.id !== repositoryId) {
    return { state: 'foreign_or_unsupported', reclaimable: false, reason: 'lock_scope_or_protocol_mismatch' };
  }
  if (!isCompleteOwnerIdentity(metadata.owner)) {
    return {
      state: 'damaged_unverifiable',
      reclaimable: false,
      reason: 'owner_metadata_malformed',
    };
  }
  if (String(metadata.machine?.hostname || '').toLowerCase() !== String(hostname).toLowerCase()) {
    return { state: 'foreign_machine', reclaimable: false, reason: 'machine_identity_mismatch' };
  }
  const processIdentity = inspectProcess(metadata.owner.pid);
  if (processIdentity?.state === 'absent') {
    return { state: 'stale_owner_absent', reclaimable: true, reason: 'owner_pid_absent' };
  }
  if (processIdentity?.state !== 'running') {
    return { state: 'owner_unverifiable', reclaimable: false, reason: 'owner_process_unverifiable' };
  }
  if (processIdentity.identity !== metadata.owner.processStartIdentity) {
    return { state: 'stale_pid_reused', reclaimable: true, reason: 'owner_process_start_mismatch' };
  }
  return { state: 'active', reclaimable: false, reason: 'owner_pid_and_start_match' };
}

export function inspectResourceLock(repositoryRoot, options = {}) {
  const location = resolveResourceLockLocation(repositoryRoot, options);
  if (!fs.existsSync(location.lockPath)) {
    return { ...location, exists: false, state: 'available', reclaimable: false, metadata: null };
  }
  const ownerRead = readJsonFile(path.join(location.lockPath, OWNER_FILE));
  const ageMs = directoryAgeMs(location.lockPath, options.nowMs ?? Date.now());
  const classification = classifyResourceLockOwner({
    metadata: ownerRead.value,
    metadataError: ownerRead.error,
    ageMs,
    repositoryId: location.repositoryId,
    hostname: options.hostname || os.hostname(),
    staleGraceMs: options.staleGraceMs ?? DEFAULT_STALE_GRACE_MS,
    inspectProcess: options.inspectProcess || getProcessStartIdentity,
  });
  let effectiveClassification = classification;
  let workloadChildren = { state: 'not_checked', active: [], inactive: [] };
  if (classification.reclaimable) {
    workloadChildren = inspectRegisteredWorkloadChildren(location, ownerRead.value, options);
    if (workloadChildren.state === 'active') {
      effectiveClassification = {
        state: 'orphaned_workload_active',
        reclaimable: false,
        reason: 'registered_workload_child_still_active',
      };
    } else if (workloadChildren.state === 'unverifiable') {
      effectiveClassification = {
        state: 'orphaned_workload_unverifiable',
        reclaimable: false,
        reason: workloadChildren.reason,
      };
    }
  }
  return {
    ...location,
    exists: true,
    ageMs,
    metadata: ownerRead.value,
    metadataError: ownerRead.error ? ownerRead.error.code || ownerRead.error.name : null,
    workloadChildren,
    ...effectiveClassification,
  };
}

export function assertActiveResourceLockLeaseSync(repositoryRoot, lease, options = {}) {
  if (!lease || typeof lease !== 'object' || lease.released === true) {
    throw new Error('live client requires an unreleased MCBot resource-lock lease');
  }
  const location = resolveResourceLockLocation(repositoryRoot, options);
  if (!lease.location
      || lease.location.repositoryId !== location.repositoryId
      || canonicalPath(lease.location.lockPath, options.platform || process.platform)
        !== canonicalPath(location.lockPath, options.platform || process.platform)) {
    throw new Error('MCBot resource-lock lease does not match the live client repository scope');
  }
  const observation = inspectResourceLock(repositoryRoot, options);
  if (observation.state !== 'active'
      || metadataFingerprint(observation.metadata) !== metadataFingerprint(lease.metadata)) {
    throw new Error('MCBot resource-lock lease owner is no longer active or changed identity');
  }

  const requesterPid = options.requesterPid ?? process.pid;
  const inspectProcess = options.inspectProcess || getProcessStartIdentity;
  const requester = inspectProcess(requesterPid);
  if (requester?.state !== 'running' || !isProcessStartIdentity(requester.identity)) {
    throw new Error('unable to validate the live client process identity');
  }

  if (lease.inherited === true) {
    const childRegistration = lease.childRegistration;
    const child = childRegistration?.record?.child;
    if (child?.pid !== requesterPid || child?.processStartIdentity !== requester.identity) {
      throw new Error('inherited MCBot resource-lock lease is not registered to this live client process');
    }
    const childKey = crypto.createHash('sha256')
      .update(`${lease.metadata.owner.id}|${child.pid}|${child.processStartIdentity}`)
      .digest('hex')
      .slice(0, 24);
    const expectedPath = path.join(location.lockPath, `${WORKLOAD_CHILD_PREFIX}${childKey}.json`);
    if (canonicalPath(childRegistration.path, options.platform || process.platform)
        !== canonicalPath(expectedPath, options.platform || process.platform)
        || workloadChildFingerprint(readJsonFile(expectedPath).value)
          !== workloadChildFingerprint(childRegistration.record)) {
      throw new Error('inherited MCBot resource-lock child receipt is missing or changed identity');
    }
  } else if (lease.inherited === false) {
    if (lease.metadata?.owner?.pid !== requesterPid
        || lease.metadata?.owner?.processStartIdentity !== requester.identity) {
      throw new Error('owned MCBot resource-lock lease is not held by this live client process');
    }
  } else {
    throw new Error('MCBot resource-lock lease kind is invalid');
  }

  return Object.freeze({
    protocol: RESOURCE_LOCK_PROTOCOL,
    repositoryId: location.repositoryId,
    lockPath: location.lockPath,
    ownerId: lease.metadata.owner.id,
    ownerPid: lease.metadata.owner.pid,
    processPid: requesterPid,
    inherited: lease.inherited,
    state: 'active',
  });
}

function appendEvent(location, event) {
  const record = JSON.stringify({
    protocol: RESOURCE_LOCK_PROTOCOL,
    at: new Date().toISOString(),
    repositoryId: location.repositoryId,
    ...event,
  });
  if (Buffer.byteLength(record) > EVENT_LIMIT_BYTES) return;
  try {
    fs.appendFileSync(location.eventsPath, `${record}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // The owner.json record is authoritative; diagnostics must not break release.
  }
}

function metadataFingerprint(metadata) {
  if (!metadata) return null;
  return JSON.stringify([
    metadata.protocol || '',
    metadata.repository?.id || '',
    metadata.machine?.hostname || '',
    metadata.owner?.id || '',
    metadata.owner?.pid || '',
    metadata.owner?.processStartIdentity || '',
    metadata.acquiredAt || '',
  ]);
}

function workloadChildFingerprint(record) {
  if (!record) return null;
  return JSON.stringify([
    record.protocol || '',
    record.repositoryId || '',
    record.owner?.id || '',
    record.owner?.pid || '',
    record.owner?.processStartIdentity || '',
    record.child?.pid || '',
    record.child?.processStartIdentity || '',
    record.child?.role || '',
    record.registrar?.pid || '',
    record.registrar?.processStartIdentity || '',
  ]);
}

function readValidatedWorkloadChildRecords(location, metadata) {
  let names;
  try {
    names = fs.readdirSync(location.lockPath)
      .filter((name) => /^workload-child-[a-f0-9]{24}\.json(?:\.release-[a-f0-9-]+)?$/i.test(name));
  } catch (error) {
    throw new Error(`unable to read workload-child registry: ${error?.code || error?.name || 'unknown'}`);
  }
  return names.map((name) => {
    const childRead = readJsonFile(path.join(location.lockPath, name));
    const record = childRead.value;
    if (childRead.error
        || record?.protocol !== RESOURCE_LOCK_PROTOCOL
        || record?.repositoryId !== location.repositoryId
        || record?.owner?.id !== metadata.owner.id
        || record?.owner?.pid !== metadata.owner.pid
        || record?.owner?.processStartIdentity !== metadata.owner.processStartIdentity
        || String(record?.machine?.hostname || '').toLowerCase() !== String(metadata.machine?.hostname || '').toLowerCase()
        || !isCompleteOwnerIdentity(record?.owner)
        || !isPositivePid(record?.child?.pid)
        || !isProcessStartIdentity(record?.child?.processStartIdentity)
        || !isRole(record?.child?.role)
        || !isPositivePid(record?.registrar?.pid)
        || !isProcessStartIdentity(record?.registrar?.processStartIdentity)) {
      throw new Error('workload-child registry contains malformed or foreign metadata');
    }
    return { name, record };
  });
}

function findAuthorizedRegistrar(location, metadata, requesterPid, inspectProcess) {
  const observed = inspectProcess(requesterPid);
  if (observed?.state !== 'running' || !isProcessStartIdentity(observed.identity)) return null;
  const match = readValidatedWorkloadChildRecords(location, metadata)
    .find(({ record }) => record.child.pid === requesterPid
      && record.child.processStartIdentity === observed.identity);
  return match ? {
    pid: requesterPid,
    processStartIdentity: observed.identity,
  } : null;
}

function closingFingerprint(record) {
  if (!record) return null;
  return JSON.stringify([
    record.protocol || '',
    record.repositoryId || '',
    record.owner?.id || '',
    record.owner?.pid || '',
    record.owner?.processStartIdentity || '',
    record.nonce || '',
  ]);
}

function removeClosingMarker(location, expected) {
  const closingPath = path.join(location.lockPath, CLOSING_FILE);
  const current = readJsonFile(closingPath).value;
  if (closingFingerprint(current) !== closingFingerprint(expected)) {
    throw new Error('resource lock closing marker changed; refusing cleanup');
  }
  fs.rmSync(closingPath, { force: false });
}

function inspectRegisteredWorkloadChildren(location, metadata, options = {}) {
  const inspectProcess = options.inspectProcess || getProcessStartIdentity;
  try {
    const records = readValidatedWorkloadChildRecords(location, metadata);
    const active = [];
    const inactive = [];
    for (const { record } of records) {
      const observed = inspectProcess(record.child.pid);
      const summary = { pid: record.child.pid, role: record.child.role || null };
      if (observed?.state === 'running' && observed.identity === record.child.processStartIdentity) {
        active.push(summary);
      } else if (observed?.state === 'absent'
          || (observed?.state === 'running' && observed.identity !== record.child.processStartIdentity)) {
        inactive.push(summary);
      } else {
        return { state: 'unverifiable', active, inactive, reason: 'child_process_unverifiable' };
      }
    }
    return { state: active.length > 0 ? 'active' : 'inactive', active, inactive };
  } catch (error) {
    return { state: 'unverifiable', active: [], reason: error?.code || error?.name || 'child_registry_unreadable' };
  }
}

function rollbackFailedAcquisition(location, metadata) {
  const quarantine = `${location.lockPath}.failed-${metadata.owner.id}`;
  try {
    fs.renameSync(location.lockPath, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const movedMetadata = readJsonFile(path.join(quarantine, OWNER_FILE)).value;
  let claim = null;
  try {
    claim = fs.readFileSync(path.join(quarantine, `.claim-${metadata.owner.id}`), 'utf8').trim();
  } catch { }
  const ownershipMatches = metadataFingerprint(movedMetadata) === metadataFingerprint(metadata)
    || claim === metadata.owner.id;
  if (!ownershipMatches) {
    try {
      if (!fs.existsSync(location.lockPath)) fs.renameSync(quarantine, location.lockPath);
    } catch { }
    throw new Error('resource lock ownership changed during failed acquisition; refusing cleanup');
  }
  try {
    fs.rmSync(quarantine, { recursive: true, force: false });
  } catch (error) {
    try {
      if (!fs.existsSync(location.lockPath)) fs.renameSync(quarantine, location.lockPath);
    } catch { }
    throw error;
  }
}

function reclaimStaleLock(location, observation) {
  const quarantine = `${location.lockPath}.stale-${crypto.randomUUID()}`;
  const expectedFingerprint = metadataFingerprint(observation.metadata);
  try {
    fs.renameSync(location.lockPath, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const moved = readJsonFile(path.join(quarantine, OWNER_FILE)).value;
  if (metadataFingerprint(moved) !== expectedFingerprint) {
    try {
      if (!fs.existsSync(location.lockPath)) fs.renameSync(quarantine, location.lockPath);
    } catch {
      // Fail closed below. Never delete a directory whose ownership changed.
    }
    throw new Error('resource lock owner changed during stale reclaim; refusing to continue');
  }
  try {
    fs.rmSync(quarantine, { recursive: true, force: false });
  } catch (error) {
    try {
      if (!fs.existsSync(location.lockPath)) fs.renameSync(quarantine, location.lockPath);
    } catch { }
    throw error;
  }
  appendEvent(location, {
    action: 'stale_reclaimed',
    staleState: observation.state,
    staleOwnerId: observation.metadata?.owner?.id || null,
    staleOwnerPid: observation.metadata?.owner?.pid || null,
  });
  return true;
}

function normalizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const allowedKeys = new Set([
    'activeProcessorCount',
    'ciCompilerCount',
    'forkJoinParallelism',
    'gradleWorkers',
    'killOnCloseJob',
    'liveClientProfile',
    'localMinecraftServerPolicy',
    'lowSpecClient',
    'maxHeapMiB',
    'maxWorkers',
    'nodeThreadPoolSize',
    'processorAffinity',
    'schedulingPriority',
    'serialGc',
    'serialized',
    'testConcurrency',
    'uvThreadpoolSize',
    'v8PoolSize',
  ]);
  const result = {};
  for (const [key, value] of Object.entries(details)) {
    if (!allowedKeys.has(key)) continue;
    if (typeof value === 'boolean' || typeof value === 'number' || value === null) result[key] = value;
    else if (typeof value === 'string' && value.length <= 512) result[key] = value;
  }
  return result;
}

function createOwnerMetadata(location, options, ownerIdentity) {
  const ownerId = options.ownerId || crypto.randomUUID();
  const ownerPid = options.ownerPid ?? process.pid;
  const now = new Date(options.nowMs ?? Date.now()).toISOString();
  const purpose = String(options.purpose || 'unspecified');
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(purpose)) {
    throw new Error('resource-lock purpose must be a non-secret slug of at most 128 characters');
  }
  if (!isOwnerId(ownerId)) {
    throw new Error('resource-lock owner ID must be a non-secret slug of at most 128 characters');
  }
  if (!isPositivePid(ownerPid) || !isProcessStartIdentity(ownerIdentity?.identity)) {
    throw new Error('resource-lock owner identity is invalid');
  }
  return {
    protocol: RESOURCE_LOCK_PROTOCOL,
    repository: {
      id: location.repositoryId,
      root: location.repositoryRoot,
      scopeKind: location.scopeKind,
      scopePath: location.scopePath,
    },
    machine: {
      hostname: options.hostname || os.hostname(),
      platform: options.platform || process.platform,
      arch: process.arch,
    },
    owner: {
      id: ownerId,
      pid: ownerPid,
      processStartIdentity: ownerIdentity.identity,
      processStartUtc: ownerIdentity.startUtc || (ownerPid === process.pid
        ? new Date(Date.now() - (process.uptime() * 1_000)).toISOString()
        : null),
      purpose,
      executable: path.basename(options.ownerExecutable || process.execPath),
    },
    controls: normalizeDetails(options.details),
    acquiredAt: now,
  };
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function installCleanup(lease) {
  const exitHandler = () => {
    try { lease.releaseSync(); } catch { }
  };
  // Never terminate or release from a signal listener: application-level signal
  // handlers must stop their child process tree before the lease is released.
  // Node's synchronous exit event remains the final fallback for default exits.
  process.once('exit', exitHandler);
  return () => {
    process.removeListener('exit', exitHandler);
  };
}

export function applyLowImpactNodeScheduling(options = {}) {
  const setPriority = options.setPriority || os.setPriority;
  const getPriority = options.getPriority || os.getPriority;
  const priority = os.constants.priority.PRIORITY_LOW;
  const platform = options.platform || process.platform;

  if (platform === 'win32' && !options.setPriority && !options.getPriority) {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    if (!systemRoot) throw new Error('unable to locate Windows PowerShell for Node scheduling enforcement');
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helper = path.join(RESOURCE_CONTROL_DIRECTORY, 'set-node-low-impact.ps1');
    if (!fs.statSync(powershell, { throwIfNoEntry: false })?.isFile()
        || !fs.statSync(helper, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('required Node Idle/one-core scheduling helper is unavailable');
    }
    const execution = spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', helper, '-TargetPid', String(process.pid),
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    if (execution.error || execution.status !== 0) {
      throw new Error(`required Node Idle/one-core scheduling failed (${execution.error?.code || execution.status || 'unknown'})`);
    }
    let receipt;
    try {
      receipt = JSON.parse(String(execution.stdout || ''));
    } catch {
      throw new Error('required Node Idle/one-core scheduling returned malformed evidence');
    }
    const affinityText = String(receipt?.processorAffinity || '');
    let affinity;
    try {
      if (!/^0x[0-9a-f]+$/i.test(affinityText)) throw new Error('invalid affinity');
      affinity = BigInt(affinityText);
    } catch {
      throw new Error('required Node Idle/one-core scheduling returned invalid affinity evidence');
    }
    if (receipt?.protocol !== 'mcbot.node-low-impact.v1'
        || receipt?.applied !== true
        || receipt?.targetPid !== process.pid
        || receipt?.verifierParentPid !== process.pid
        || !Number.isSafeInteger(receipt?.verifierPid)
        || receipt.verifierPid <= 0
        || !/^windows-start-ticks:\d+$/.test(String(receipt?.processStartIdentity || ''))
        || receipt?.schedulingPriority !== 'Idle'
        || affinity <= 0n
        || (affinity & (affinity - 1n)) !== 0n) {
      throw new Error('required Node Idle/one-core scheduling evidence did not match this process');
    }
    const observed = getPriority(0);
    if (!Number.isFinite(observed) || observed < priority) {
      throw new Error(`required low Node scheduling priority did not stick (observed ${observed})`);
    }
    return Object.freeze({
      schedulingPriority: 'Idle',
      numericPriority: observed,
      processorAffinity: affinityText.toLowerCase(),
      processStartIdentity: receipt.processStartIdentity,
      verifierPid: receipt.verifierPid,
    });
  }

  setPriority(0, priority);
  const observed = getPriority(0);
  if (!Number.isFinite(observed) || observed < priority) {
    throw new Error(`required low Node scheduling priority did not stick (observed ${observed})`);
  }
  return {
    schedulingPriority: 'Idle',
    numericPriority: observed,
    processorAffinity: null,
    processStartIdentity: null,
  };
}

function createLease(location, metadata, options = {}) {
  let released = false;
  let uninstallCleanup = () => {};
  const environmentTarget = options.env || process.env;
  const previousEnvironment = Object.fromEntries(Object.values(RESOURCE_LOCK_ENV).map((name) => [name, environmentTarget[name]]));
  const lease = {
    inherited: false,
    location,
    metadata,
    get released() { return released; },
    environment: {
      [RESOURCE_LOCK_ENV.path]: location.lockPath,
      [RESOURCE_LOCK_ENV.ownerId]: metadata.owner.id,
      [RESOURCE_LOCK_ENV.repositoryId]: location.repositoryId,
      [RESOURCE_LOCK_ENV.ownerPid]: String(metadata.owner.pid),
    },
    releaseSync() {
      if (released) return false;
      const beforeClosing = readJsonFile(path.join(location.lockPath, OWNER_FILE)).value;
      if (metadataFingerprint(beforeClosing) !== metadataFingerprint(metadata)) {
        throw new Error('refusing to release an MCBot resource lock owned by another process');
      }
      const closing = {
        protocol: RESOURCE_LOCK_PROTOCOL,
        repositoryId: location.repositoryId,
        owner: {
          id: metadata.owner.id,
          pid: metadata.owner.pid,
          processStartIdentity: metadata.owner.processStartIdentity,
        },
        nonce: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      const closingPath = path.join(location.lockPath, CLOSING_FILE);
      try {
        fs.writeFileSync(closingPath, `${JSON.stringify(closing, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw new Error('resource lock is already closing; refusing concurrent release');
        }
        throw error;
      }
      let directoryMoved = false;
      try {
        options.onClosingMarkerCreated?.();
        const current = readJsonFile(path.join(location.lockPath, OWNER_FILE)).value;
        if (metadataFingerprint(current) !== metadataFingerprint(metadata)) {
          throw new Error('resource lock owner changed while closing; refusing cleanup');
        }
        const workloadChildren = inspectRegisteredWorkloadChildren(location, current, options);
        if (workloadChildren.state === 'active' || workloadChildren.state === 'unverifiable') {
          const activePids = workloadChildren.active.map((entry) => entry.pid).join(',');
          throw new Error(`refusing to release MCBot resource lock while workload children remain ${workloadChildren.state}${activePids ? ` (pids=${activePids})` : ''}`);
        }
        const quarantine = `${location.lockPath}.release-${metadata.owner.id}`;
        fs.renameSync(location.lockPath, quarantine);
        directoryMoved = true;
        const moved = readJsonFile(path.join(quarantine, OWNER_FILE)).value;
        if (metadataFingerprint(moved) !== metadataFingerprint(metadata)) {
          try {
            if (!fs.existsSync(location.lockPath)) {
              fs.renameSync(quarantine, location.lockPath);
              directoryMoved = false;
            }
          } catch { }
          throw new Error('resource lock owner changed during release; refusing cleanup');
        }
        try {
        fs.rmSync(quarantine, { recursive: true, force: false });
        } catch (error) {
          try {
            if (!fs.existsSync(location.lockPath)) {
              fs.renameSync(quarantine, location.lockPath);
              directoryMoved = false;
            }
          } catch { }
          throw error;
        }
      } catch (error) {
        if (!directoryMoved && fs.existsSync(closingPath)) {
          try {
            removeClosingMarker(location, closing);
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'resource lock release and closing-marker cleanup both failed');
          }
        }
        throw error;
      }
      released = true;
      uninstallCleanup();
      for (const [name, oldValue] of Object.entries(previousEnvironment)) {
        if (environmentTarget[name] !== lease.environment[name]) continue;
        if (oldValue === undefined) delete environmentTarget[name];
        else environmentTarget[name] = oldValue;
      }
      appendEvent(location, { action: 'released', ownerId: metadata.owner.id, ownerPid: metadata.owner.pid });
      return true;
    },
  };
  Object.assign(environmentTarget, lease.environment);
  if (options.automaticCleanup !== false) uninstallCleanup = installCleanup(lease);
  return lease;
}

function inheritedLease(location, metadata, childRegistration, options = {}) {
  let released = false;
  let uninstallCleanup = () => {};
  const lease = {
    inherited: true,
    location,
    metadata,
    childRegistration,
    get released() { return released; },
    environment: {
      [RESOURCE_LOCK_ENV.path]: location.lockPath,
      [RESOURCE_LOCK_ENV.ownerId]: metadata.owner.id,
      [RESOURCE_LOCK_ENV.repositoryId]: location.repositoryId,
      [RESOURCE_LOCK_ENV.ownerPid]: String(metadata.owner.pid),
    },
    releaseSync() {
      if (released) return false;
      unregisterResourceLockChildSync(location.repositoryRoot, metadata.owner, childRegistration.record.child, options);
      released = true;
      uninstallCleanup();
      return true;
    },
  };
  if (options.automaticCleanup !== false) uninstallCleanup = installCleanup(lease);
  return lease;
}

export function registerResourceLockChildSync(repositoryRoot, owner, childPid, options = {}) {
  if (!isCompleteOwnerIdentity(owner)) {
    throw new Error('resource lock child registration requires complete owner identity');
  }
  if (!isPositivePid(childPid)) {
    throw new Error('resource lock child registration requires a positive child PID');
  }
  const requesterPid = options.requesterPid ?? process.pid;
  const role = String(options.role || 'workload-child');
  if (!isRole(role)) {
    throw new Error('resource-lock child role must be a non-secret slug of at most 128 characters');
  }
  const location = resolveResourceLockLocation(repositoryRoot, options);
  if (fs.existsSync(path.join(location.lockPath, CLOSING_FILE))) {
    throw new Error('resource lock is closing; refusing workload-child registration');
  }
  const currentRead = readJsonFile(path.join(location.lockPath, OWNER_FILE));
  const metadata = currentRead.value;
  if (!metadata
      || metadata.owner?.id !== owner.id
      || metadata.owner?.pid !== owner.pid
      || metadata.owner?.processStartIdentity !== owner.processStartIdentity) {
    throw new Error('refusing to register a child for a different MCBot resource-lock owner');
  }
  const inspectProcess = options.inspectProcess || getProcessStartIdentity;
  const ownerIdentity = inspectProcess(owner.pid);
  if (ownerIdentity?.state !== 'running' || ownerIdentity.identity !== owner.processStartIdentity) {
    throw new Error('resource-lock owner is not active during child registration');
  }
  const childIdentity = inspectProcess(childPid);
  if (childIdentity?.state !== 'running' || !isProcessStartIdentity(childIdentity.identity)) {
    throw new Error(`unable to validate workload child process start for pid ${childPid}`);
  }
  let registrar;
  if (requesterPid === owner.pid) {
    registrar = {
      pid: owner.pid,
      processStartIdentity: owner.processStartIdentity,
    };
  } else if (requesterPid === childPid) {
    const parentRegistrar = childIdentity.parentPid === owner.pid
      ? {
        pid: owner.pid,
        processStartIdentity: owner.processStartIdentity,
      }
      : findAuthorizedRegistrar(location, metadata, childIdentity.parentPid, inspectProcess);
    if (!parentRegistrar) {
      throw new Error('refusing inherited self-registration without an exact active owner or registered parent');
    }
    registrar = {
      pid: childPid,
      processStartIdentity: childIdentity.identity,
    };
  } else {
    registrar = findAuthorizedRegistrar(location, metadata, requesterPid, inspectProcess);
    if (!registrar || childIdentity.parentPid !== requesterPid) {
      throw new Error('refusing workload-child registration from an unrelated process');
    }
  }
  const record = {
    protocol: RESOURCE_LOCK_PROTOCOL,
    repositoryId: location.repositoryId,
    machine: { hostname: metadata.machine.hostname },
    owner: {
      id: owner.id,
      pid: owner.pid,
      processStartIdentity: owner.processStartIdentity,
    },
    child: {
      pid: childPid,
      processStartIdentity: childIdentity.identity,
      processStartUtc: childIdentity.startUtc || null,
      role,
    },
    registrar,
    registeredAt: new Date(options.nowMs ?? Date.now()).toISOString(),
  };
  const childKey = crypto.createHash('sha256')
    .update(`${owner.id}|${childPid}|${childIdentity.identity}`)
    .digest('hex')
    .slice(0, 24);
  const childPath = path.join(location.lockPath, `${WORKLOAD_CHILD_PREFIX}${childKey}.json`);
  options.onChildRegistrationReadyToWrite?.();
  if (fs.existsSync(path.join(location.lockPath, CLOSING_FILE))) {
    throw new Error('resource lock began closing during workload-child registration');
  }
  try {
    fs.writeFileSync(childPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code !== 'EEXIST'
        || workloadChildFingerprint(readJsonFile(childPath).value) !== workloadChildFingerprint(record)) {
      throw error;
    }
  }
  const ownerAfterWrite = readJsonFile(path.join(location.lockPath, OWNER_FILE)).value;
  const closingAfterWrite = fs.existsSync(path.join(location.lockPath, CLOSING_FILE));
  if (closingAfterWrite || metadataFingerprint(ownerAfterWrite) !== metadataFingerprint(metadata)) {
    const written = readJsonFile(childPath).value;
    if (workloadChildFingerprint(written) === workloadChildFingerprint(record)) {
      try { fs.rmSync(childPath, { force: false }); } catch { }
    }
    throw new Error(closingAfterWrite
      ? 'resource lock began closing during workload-child registration'
      : 'resource lock owner changed during workload-child registration');
  }
  appendEvent(location, { action: 'child_registered', ownerId: owner.id, childPid, role });
  return { path: childPath, record };
}

export function unregisterResourceLockChildSync(repositoryRoot, owner, child, options = {}) {
  if (!isCompleteOwnerIdentity(owner)
      || !isPositivePid(child?.pid)
      || !isProcessStartIdentity(child?.processStartIdentity)) {
    throw new Error('resource lock child deregistration requires complete owner and child identity');
  }
  const requesterPid = options.requesterPid ?? process.pid;
  const location = resolveResourceLockLocation(repositoryRoot, options);
  const childKey = crypto.createHash('sha256')
    .update(`${owner.id}|${child.pid}|${child.processStartIdentity}`)
    .digest('hex')
    .slice(0, 24);
  const childPath = path.join(location.lockPath, `${WORKLOAD_CHILD_PREFIX}${childKey}.json`);
  const record = readJsonFile(childPath).value;
  if (!record
      || record.owner?.id !== owner.id
      || record.owner?.pid !== owner.pid
      || record.owner?.processStartIdentity !== owner.processStartIdentity
      || record.child?.pid !== child.pid
      || record.child?.processStartIdentity !== child.processStartIdentity
      || !isPositivePid(record.registrar?.pid)
      || !isProcessStartIdentity(record.registrar?.processStartIdentity)) {
    throw new Error('refusing to deregister a different MCBot workload child');
  }
  const inspectProcess = options.inspectProcess || getProcessStartIdentity;
  const currentRegistrar = requesterPid === record.registrar.pid
    && requesterPid !== child.pid
    ? findAuthorizedRegistrar(
      location,
      readJsonFile(path.join(location.lockPath, OWNER_FILE)).value,
      requesterPid,
      inspectProcess,
    )
    : null;
  const registrarAuthorized = currentRegistrar?.pid === record.registrar.pid
    && currentRegistrar?.processStartIdentity === record.registrar.processStartIdentity;
  const requesterIdentity = inspectProcess(requesterPid);
  const ownerRequesterAuthorized = requesterPid === owner.pid
    && requesterIdentity?.state === 'running'
    && requesterIdentity.identity === owner.processStartIdentity;
  const childRequesterAuthorized = requesterPid === child.pid
    && requesterIdentity?.state === 'running'
    && requesterIdentity.identity === child.processStartIdentity;
  if (!ownerRequesterAuthorized && !childRequesterAuthorized && !registrarAuthorized) {
    throw new Error('refusing workload-child deregistration from an unrelated process');
  }
  const dependents = readValidatedWorkloadChildRecords(
    location,
    readJsonFile(path.join(location.lockPath, OWNER_FILE)).value,
  ).filter(({ record: candidate }) => candidate.child.pid !== child.pid
    && candidate.registrar.pid === child.pid
    && candidate.registrar.processStartIdentity === child.processStartIdentity);
  for (const { record: dependent } of dependents) {
    const observed = inspectProcess(dependent.child.pid);
    if (observed?.state === 'unknown'
        || (observed?.state === 'running' && observed.identity === dependent.child.processStartIdentity)) {
      throw new Error(`refusing to deregister workload wrapper while registered descendant pid ${dependent.child.pid} may still be active`);
    }
  }
  const quarantine = `${childPath}.release-${crypto.randomUUID()}`;
  fs.renameSync(childPath, quarantine);
  const moved = readJsonFile(quarantine).value;
  if (workloadChildFingerprint(moved) !== workloadChildFingerprint(record)) {
    try {
      if (!fs.existsSync(childPath)) fs.renameSync(quarantine, childPath);
    } catch { }
    throw new Error('workload-child identity changed during deregistration');
  }
  try {
    options.onChildRecordQuarantined?.();
    const removeChildRecord = options.removeChildRecord || ((target) => fs.rmSync(target, { force: false }));
    removeChildRecord(quarantine);
  } catch (error) {
    try {
      if (!fs.existsSync(childPath)) fs.renameSync(quarantine, childPath);
    } catch {
      // The quarantine filename remains part of the authoritative registry scan,
      // so even a failed rollback cannot hide a live workload from release.
    }
    throw error;
  }
  appendEvent(location, {
    action: 'child_deregistered',
    ownerId: owner.id,
    childPid: child.pid,
    role: record.child.role,
  });
  return true;
}

export function acquireOrJoinResourceLockSync(options = {}) {
  const repositoryRoot = options.repositoryRoot || process.cwd();
  const location = resolveResourceLockLocation(repositoryRoot, options);
  const env = options.env || process.env;
  const inheritedValues = Object.values(RESOURCE_LOCK_ENV).map((name) => env[name]);
  const inheritedValueCount = inheritedValues.filter((value) => value !== undefined && value !== '').length;
  if (inheritedValueCount !== 0 && inheritedValueCount !== inheritedValues.length) {
    throw new Error('inherited MCBot resource lock environment is incomplete');
  }
  if (inheritedValueCount === inheritedValues.length) {
    const inheritedOwnerId = env[RESOURCE_LOCK_ENV.ownerId];
    const inheritedOwnerPidText = String(env[RESOURCE_LOCK_ENV.ownerPid]);
    const inheritedOwnerPid = Number(inheritedOwnerPidText);
    if (!/^[1-9]\d*$/.test(inheritedOwnerPidText)
        || !Number.isSafeInteger(inheritedOwnerPid)
        || String(inheritedOwnerPid) !== inheritedOwnerPidText) {
      throw new Error('inherited MCBot resource lock owner PID is not canonical');
    }
    if (path.resolve(env[RESOURCE_LOCK_ENV.path] || '') !== path.resolve(location.lockPath)
        || env[RESOURCE_LOCK_ENV.repositoryId] !== location.repositoryId) {
      throw new Error('inherited MCBot resource lock does not match this repository scope');
    }
    const observation = inspectResourceLock(repositoryRoot, options);
    if (observation.state !== 'active'
        || observation.metadata?.owner?.id !== inheritedOwnerId
        || observation.metadata?.owner?.pid !== inheritedOwnerPid) {
      throw new Error('inherited MCBot resource lock owner is no longer active');
    }
    const childPid = options.ownerPid ?? process.pid;
    const childRegistration = registerResourceLockChildSync(repositoryRoot, observation.metadata.owner, childPid, {
      ...options,
      requesterPid: childPid,
      role: options.childRole || options.purpose || 'inherited-workload',
    });
    return inheritedLease(location, observation.metadata, childRegistration, {
      ...options,
      requesterPid: childPid,
    });
  }

  const ownerPid = options.ownerPid ?? process.pid;
  const inspectProcess = options.inspectProcess || getProcessStartIdentity;
  const ownerIdentity = inspectProcess(ownerPid);
  if (ownerIdentity?.state !== 'running' || !isProcessStartIdentity(ownerIdentity.identity)) {
    throw new Error(`unable to validate resource-lock owner process start for pid ${ownerPid}`);
  }
  const waitMs = Number(options.waitMs ?? 0);
  const requestedPollMs = Number(options.pollMs ?? 200);
  if (!Number.isFinite(waitMs) || waitMs < 0 || !Number.isFinite(requestedPollMs) || requestedPollMs <= 0) {
    throw new Error('resource-lock wait and poll durations must be finite non-negative numbers');
  }
  const pollMs = Math.min(1_000, Math.max(25, requestedPollMs));
  const deadline = Date.now() + waitMs;
  fs.mkdirSync(location.baseDirectory, { recursive: true, mode: 0o700 });
  while (true) {
    const metadata = createOwnerMetadata(location, { ...options, ownerPid }, ownerIdentity);
    let created = false;
    try {
      // mkdir is the cross-platform atomic ownership operation. Contenders treat the
      // short owner-file initialization window as non-reclaimable and fail closed.
      fs.mkdirSync(location.lockPath, { mode: 0o700 });
      created = true;
      const claimPath = path.join(location.lockPath, `.claim-${metadata.owner.id}`);
      fs.writeFileSync(claimPath, `${metadata.owner.id}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      const temporaryOwner = path.join(location.lockPath, `.owner-${metadata.owner.id}.tmp`);
      fs.writeFileSync(temporaryOwner, `${JSON.stringify(metadata, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(temporaryOwner, path.join(location.lockPath, OWNER_FILE));
      fs.rmSync(claimPath, { force: false });
      appendEvent(location, {
        action: 'acquired',
        ownerId: metadata.owner.id,
        ownerPid: metadata.owner.pid,
        purpose: metadata.owner.purpose,
        controls: metadata.controls,
      });
      return createLease(location, metadata, options);
    } catch (error) {
      if (created) {
        rollbackFailedAcquisition(location, metadata);
        throw error;
      }
      if (!fs.existsSync(location.lockPath)) throw error;
      const observation = inspectResourceLock(repositoryRoot, { ...options, inspectProcess });
      if (observation.reclaimable && reclaimStaleLock(location, observation)) continue;
      if (Date.now() >= deadline) {
        appendEvent(location, {
          action: 'contended',
          ownerId: observation.metadata?.owner?.id || null,
          ownerPid: observation.metadata?.owner?.pid || null,
          state: observation.state,
        });
        throw new ResourceLockBusyError(observation);
      }
      sleepSync(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  }
}

export function releaseResourceLockByOwnerSync(repositoryRoot, owner, options = {}) {
  if (!isCompleteOwnerIdentity(owner)) {
    throw new Error('resource lock release requires complete owner identity');
  }
  const location = resolveResourceLockLocation(repositoryRoot, options);
  const ownerRead = readJsonFile(path.join(location.lockPath, OWNER_FILE));
  const metadata = ownerRead.value;
  if (!metadata
      || metadata.owner?.id !== owner.id
      || metadata.owner?.pid !== owner.pid
      || metadata.owner?.processStartIdentity !== owner.processStartIdentity) {
    throw new Error('refusing to release an MCBot resource lock owned by another process');
  }
  const requesterPid = options.requesterPid ?? process.pid;
  const inspectProcess = options.inspectProcess || getProcessStartIdentity;
  const requester = inspectProcess(requesterPid);
  if (requesterPid !== metadata.owner.pid
      || requester?.state !== 'running'
      || requester.identity !== metadata.owner.processStartIdentity) {
    throw new Error('refusing resource lock release from a process other than the exact owner identity');
  }
  return createLease(location, metadata, { ...options, automaticCleanup: false }).releaseSync();
}
