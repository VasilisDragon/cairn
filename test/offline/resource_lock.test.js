import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RESOURCE_LOCK_ENV,
  RESOURCE_LOCK_PROTOCOL,
  ResourceLockBusyError,
  acquireOrJoinResourceLockSync,
  applyLowImpactNodeScheduling,
  assertActiveResourceLockLeaseSync,
  classifyResourceLockOwner,
  createTestOnlyResourceLockEnvironment,
  inspectResourceLock,
  registerResourceLockChildSync,
  releaseResourceLockByOwnerSync,
  resolveRepositoryScope,
  resolveResourceLockLocation,
  unregisterResourceLockChildSync,
} from '../../scripts/resource-lock.js';

function makeRepository(prefix = 'mcbot-resource-lock-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

function lockEnvironment(baseDirectory, initialEnvironment = {}) {
  return createTestOnlyResourceLockEnvironment(path.resolve(baseDirectory), initialEnvironment);
}

function fakeIdentity(pid) {
  return { state: 'running', identity: `test-process-start:${pid}`, startUtc: '2026-08-29T00:00:00.000Z' };
}

test('resource lock scopes linked Git worktrees to one common repository identity', () => {
  const main = makeRepository('mcbot-resource-scope-');
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-linked-'));
  try {
    const admin = path.join(main, '.git', 'worktrees', 'linked');
    fs.mkdirSync(admin, { recursive: true });
    fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${admin}\n`);
    const mainScope = resolveRepositoryScope(main);
    const linkedScope = resolveRepositoryScope(linked);
    assert.equal(mainScope.scopeKind, 'git-common-directory');
    assert.equal(linkedScope.scopeKind, 'git-common-directory');
    assert.equal(linkedScope.repositoryId, mainScope.repositoryId);
    assert.equal(linkedScope.scopePath, mainScope.scopePath);
  } finally {
    fs.rmSync(main, { recursive: true, force: true });
    fs.rmSync(linked, { recursive: true, force: true });
  }
});

test('resource lock resolves a symlinked or junction .git directory to the same scope', () => {
  const main = makeRepository('mcbot-resource-symlink-main-');
  const alias = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-symlink-alias-'));
  try {
    fs.symlinkSync(path.join(main, '.git'), path.join(alias, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(resolveRepositoryScope(alias).repositoryId, resolveRepositoryScope(main).repositoryId);
  } finally {
    fs.rmSync(alias, { recursive: true, force: true });
    fs.rmSync(main, { recursive: true, force: true });
  }
});

test('owner classification requires both PID liveness and exact process-start identity', () => {
  const metadata = {
    protocol: RESOURCE_LOCK_PROTOCOL,
    repository: { id: 'repo-id' },
    machine: { hostname: 'test-host' },
    owner: { id: 'owner-id', pid: 42, processStartIdentity: 'start:a' },
  };
  const shared = { metadata, ageMs: 60_000, repositoryId: 'repo-id', hostname: 'test-host' };
  assert.deepEqual(
    classifyResourceLockOwner({ ...shared, inspectProcess: () => ({ state: 'running', identity: 'start:a' }) }),
    { state: 'active', reclaimable: false, reason: 'owner_pid_and_start_match' },
  );
  assert.deepEqual(
    classifyResourceLockOwner({ ...shared, inspectProcess: () => ({ state: 'running', identity: 'start:b' }) }),
    { state: 'stale_pid_reused', reclaimable: true, reason: 'owner_process_start_mismatch' },
  );
  assert.deepEqual(
    classifyResourceLockOwner({ ...shared, inspectProcess: () => ({ state: 'absent' }) }),
    { state: 'stale_owner_absent', reclaimable: true, reason: 'owner_pid_absent' },
  );
  assert.deepEqual(
    classifyResourceLockOwner({ ...shared, inspectProcess: () => ({ state: 'unknown' }) }),
    { state: 'owner_unverifiable', reclaimable: false, reason: 'owner_process_unverifiable' },
  );
});

test('Node low-impact scheduling is applied and verified fail-closed', () => {
  let requested = null;
  const applied = applyLowImpactNodeScheduling({
    setPriority: (pid, priority) => { requested = { pid, priority }; },
    getPriority: () => os.constants.priority.PRIORITY_LOW,
  });
  assert.deepEqual(requested, { pid: 0, priority: os.constants.priority.PRIORITY_LOW });
  assert.equal(applied.schedulingPriority, 'Idle');
  assert.throws(() => applyLowImpactNodeScheduling({
    setPriority: () => {},
    getPriority: () => os.constants.priority.PRIORITY_NORMAL,
  }), /did not stick/);
});

test('damaged and foreign-machine locks fail closed instead of being reclaimed', () => {
  const damaged = classifyResourceLockOwner({
    metadata: null,
    metadataError: new SyntaxError('bad json'),
    ageMs: 600_000,
    staleGraceMs: 1,
    repositoryId: 'repo-id',
    hostname: 'test-host',
  });
  assert.equal(damaged.state, 'damaged_unverifiable');
  assert.equal(damaged.reclaimable, false);

  const foreign = classifyResourceLockOwner({
    metadata: {
      protocol: RESOURCE_LOCK_PROTOCOL,
      repository: { id: 'repo-id' },
      machine: { hostname: 'other-host' },
      owner: { id: 'owner-id', pid: 42, processStartIdentity: 'start:a' },
    },
    ageMs: 600_000,
    repositoryId: 'repo-id',
    hostname: 'test-host',
    inspectProcess: () => ({ state: 'absent' }),
  });
  assert.deepEqual(foreign, {
    state: 'foreign_machine',
    reclaimable: false,
    reason: 'machine_identity_mismatch',
  });

  for (const owner of [
    { id: '', pid: 42, processStartIdentity: 'start:a' },
    { id: '../escape', pid: 42, processStartIdentity: 'start:a' },
    { id: 'owner-id', pid: 0, processStartIdentity: 'start:a' },
    { id: 'owner-id', pid: -1, processStartIdentity: 'start:a' },
    { id: 'owner-id', pid: 42, processStartIdentity: '' },
    { id: 'owner-id', pid: 42, processStartIdentity: `start:${'x'.repeat(600)}` },
  ]) {
    const invalid = classifyResourceLockOwner({
      metadata: {
        protocol: RESOURCE_LOCK_PROTOCOL,
        repository: { id: 'repo-id' },
        machine: { hostname: 'test-host' },
        owner,
      },
      ageMs: 600_000,
      repositoryId: 'repo-id',
      hostname: 'test-host',
      inspectProcess: () => ({ state: 'absent' }),
    });
    assert.equal(invalid.state, 'damaged_unverifiable');
    assert.equal(invalid.reclaimable, false);
  }
});

test('exclusive acquisition is observable, joinable by inherited children, and owner-released', () => {
  const repository = makeRepository();
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-lock-root-'));
  const ownerEnv = lockEnvironment(locks);
  const contenderEnv = lockEnvironment(locks);
  const inactivePids = new Set();
  const parentPids = new Map([[303, 101]]);
  const inspectTestProcess = (pid) => inactivePids.has(pid)
    ? { state: 'absent' }
    : { ...fakeIdentity(pid), parentPid: parentPids.get(pid) ?? 1 };
  let lease;
  try {
    lease = acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: ownerEnv,
      ownerPid: 101,
      purpose: 'deterministic-test-owner',
      details: { schedulingPriority: 'Idle', activeProcessorCount: 2, apiKey: 'must-not-appear' },
      inspectProcess: inspectTestProcess,
      automaticCleanup: false,
      hostname: 'test-host',
    });
    const ownerPath = path.join(lease.location.lockPath, 'owner.json');
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    assert.equal(owner.owner.pid, 101);
    assert.equal(owner.owner.processStartIdentity, 'test-process-start:101');
    assert.equal(owner.owner.purpose, 'deterministic-test-owner');
    assert.equal(owner.controls.schedulingPriority, 'Idle');
    assert.equal(owner.controls.activeProcessorCount, 2);
    assert.equal('apiKey' in owner.controls, false);
    assert.equal(fs.readFileSync(ownerPath, 'utf8').includes('must-not-appear'), false);
    assert.equal(ownerEnv[RESOURCE_LOCK_ENV.ownerId], owner.owner.id);
    assert.match(fs.readFileSync(lease.location.eventsPath, 'utf8'), /"action":"acquired"/);
    assert.deepEqual(assertActiveResourceLockLeaseSync(repository, lease, {
      env: ownerEnv,
      requesterPid: 101,
      inspectProcess: inspectTestProcess,
      hostname: 'test-host',
    }), {
      protocol: RESOURCE_LOCK_PROTOCOL,
      repositoryId: lease.location.repositoryId,
      lockPath: lease.location.lockPath,
      ownerId: lease.metadata.owner.id,
      ownerPid: 101,
      processPid: 101,
      inherited: false,
      state: 'active',
    });

    assert.throws(() => acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: contenderEnv,
      ownerPid: 202,
      purpose: 'contender',
      inspectProcess: inspectTestProcess,
      automaticCleanup: false,
      hostname: 'test-host',
    }), ResourceLockBusyError);

    assert.throws(() => acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: createTestOnlyResourceLockEnvironment(path.resolve(locks), {
        [RESOURCE_LOCK_ENV.ownerId]: lease.metadata.owner.id,
      }),
      inspectProcess: inspectTestProcess,
      hostname: 'test-host',
    }), /environment is incomplete/);
    assert.throws(() => acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: lockEnvironment(locks, { ...ownerEnv, [RESOURCE_LOCK_ENV.ownerPid]: '999' }),
      inspectProcess: inspectTestProcess,
      hostname: 'test-host',
    }), /owner is no longer active/);
    assert.throws(() => acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: lockEnvironment(locks, { ...ownerEnv, [RESOURCE_LOCK_ENV.ownerPid]: '0101' }),
      inspectProcess: inspectTestProcess,
      hostname: 'test-host',
    }), /owner PID is not canonical/);

    assert.throws(() => acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: lockEnvironment(locks, ownerEnv),
      ownerPid: 404,
      inspectProcess: inspectTestProcess,
      automaticCleanup: false,
      hostname: 'test-host',
    }), /without an exact active owner or registered parent/);

    const inherited = acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: lockEnvironment(locks, ownerEnv),
      ownerPid: 303,
      inspectProcess: inspectTestProcess,
      automaticCleanup: false,
      hostname: 'test-host',
    });
    assert.equal(inherited.inherited, true);
    assert.equal(inherited.metadata.owner.id, lease.metadata.owner.id);
    assert.equal(assertActiveResourceLockLeaseSync(repository, inherited, {
      env: lockEnvironment(locks, ownerEnv),
      requesterPid: 303,
      inspectProcess: inspectTestProcess,
      hostname: 'test-host',
    }).inherited, true);
    assert.equal(inherited.releaseSync(), true);
    assert.throws(() => assertActiveResourceLockLeaseSync(repository, inherited, {
      env: lockEnvironment(locks, ownerEnv),
      requesterPid: 303,
      inspectProcess: inspectTestProcess,
      hostname: 'test-host',
    }), /unreleased MCBot resource-lock lease/);
    assert.equal(lease.releaseSync(), true);
    assert.equal(fs.existsSync(lease.location.lockPath), false);
    assert.equal(inspectResourceLock(repository, { env: contenderEnv }).state, 'available');
    assert.match(fs.readFileSync(lease.location.eventsPath, 'utf8'), /"action":"released"/);
  } finally {
    if (lease && !lease.released && fs.existsSync(lease.location.lockPath)) lease.releaseSync();
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(locks, { recursive: true, force: true });
  }
});

test('stale owner is reclaimed only after its PID/start identity is disproven', () => {
  const repository = makeRepository();
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-stale-'));
  const firstEnv = lockEnvironment(locks);
  const secondEnv = lockEnvironment(locks);
  let first;
  let second;
  try {
    first = acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: firstEnv,
      ownerPid: 111,
      inspectProcess: fakeIdentity,
      automaticCleanup: false,
      hostname: 'test-host',
    });
    second = acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: secondEnv,
      ownerPid: 222,
      inspectProcess: (pid) => pid === 111 ? { state: 'absent' } : fakeIdentity(pid),
      automaticCleanup: false,
      hostname: 'test-host',
    });
    assert.equal(second.metadata.owner.pid, 222);
    assert.match(fs.readFileSync(second.location.eventsPath, 'utf8'), /"action":"stale_reclaimed"/);
    assert.equal(second.releaseSync(), true);
  } finally {
    if (second && !second.released && fs.existsSync(second.location.lockPath)) second.releaseSync();
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(locks, { recursive: true, force: true });
  }
});

test('registered workload children block owner release and stale reclaim until authenticated deregistration', () => {
  const repository = makeRepository();
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-children-'));
  const env = lockEnvironment(locks);
  let lease;
  try {
    lease = acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env,
      ownerPid: 701,
      inspectProcess: fakeIdentity,
      automaticCleanup: false,
      hostname: 'test-host',
    });
    const registration = registerResourceLockChildSync(repository, lease.metadata.owner, 702, {
      env,
      requesterPid: 701,
      inspectProcess: fakeIdentity,
      hostname: 'test-host',
      role: 'test-workload',
    });
    assert.throws(() => lease.releaseSync(), /workload children remain active/);
    const orphaned = inspectResourceLock(repository, {
      env,
      hostname: 'test-host',
      inspectProcess: (pid) => pid === 701 ? { state: 'absent' } : fakeIdentity(pid),
    });
    assert.equal(orphaned.state, 'orphaned_workload_active');
    assert.equal(orphaned.reclaimable, false);
    assert.deepEqual(orphaned.workloadChildren.active, [{ pid: 702, role: 'test-workload' }]);
    assert.throws(() => unregisterResourceLockChildSync(repository, lease.metadata.owner, registration.record.child, {
      env,
      requesterPid: 999,
    }), /unrelated process/);
    assert.equal(unregisterResourceLockChildSync(repository, lease.metadata.owner, registration.record.child, {
      env,
      requesterPid: 702,
      inspectProcess: fakeIdentity,
    }), true);
    assert.equal(lease.releaseSync(), true);
  } finally {
    if (lease && !lease.released && fs.existsSync(lease.location.lockPath)) lease.releaseSync();
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(locks, { recursive: true, force: true });
  }
});

test('workload child registration retries only transiently unknown process identity evidence', () => {
  const repository = makeRepository();
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-child-identity-retry-'));
  const env = lockEnvironment(locks);
  const probeCounts = new Map();
  const inspect = (pid) => {
    probeCounts.set(pid, (probeCounts.get(pid) || 0) + 1);
    if (pid === 702 && probeCounts.get(pid) < 3) return { state: 'unknown' };
    if (pid === 703) return { state: 'unknown' };
    if (pid === 704) return { state: 'absent' };
    return fakeIdentity(pid);
  };
  let lease;
  try {
    lease = acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env,
      ownerPid: 701,
      inspectProcess: inspect,
      automaticCleanup: false,
      hostname: 'test-host',
    });

    const registration = registerResourceLockChildSync(repository, lease.metadata.owner, 702, {
      env,
      requesterPid: 701,
      inspectProcess: inspect,
      hostname: 'test-host',
      role: 'transient-identity-child',
    });
    assert.equal(probeCounts.get(702), 3);
    assert.equal(unregisterResourceLockChildSync(
      repository,
      lease.metadata.owner,
      registration.record.child,
      { env, requesterPid: 702, inspectProcess: inspect },
    ), true);

    assert.throws(() => registerResourceLockChildSync(repository, lease.metadata.owner, 703, {
      env,
      requesterPid: 701,
      inspectProcess: inspect,
      hostname: 'test-host',
    }), /unable to validate workload child process start/);
    assert.equal(probeCounts.get(703), 3);

    assert.throws(() => registerResourceLockChildSync(repository, lease.metadata.owner, 704, {
      env,
      requesterPid: 701,
      inspectProcess: inspect,
      hostname: 'test-host',
    }), /unable to validate workload child process start/);
    assert.equal(probeCounts.get(704), 1);
    assert.equal(lease.releaseSync(), true);
  } finally {
    if (lease && !lease.released && fs.existsSync(lease.location.lockPath)) lease.releaseSync();
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(locks, { recursive: true, force: true });
  }
});

test('workload child registration retries only transiently unknown owner identity evidence', () => {
  const repository = makeRepository();
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-owner-identity-retry-'));
  const env = lockEnvironment(locks);
  let ownerProbeMode = 'running';
  let ownerProbeCount = 0;
  let childProbeCount = 0;
  const inspect = (pid) => {
    if (pid === 711) {
      ownerProbeCount += 1;
      if (ownerProbeMode === 'transient' && ownerProbeCount < 3) return { state: 'unknown' };
      if (ownerProbeMode === 'persistent') return { state: 'unknown' };
      if (ownerProbeMode === 'absent') return { state: 'absent' };
    } else {
      childProbeCount += 1;
    }
    return fakeIdentity(pid);
  };
  let lease;
  try {
    lease = acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env,
      ownerPid: 711,
      inspectProcess: inspect,
      automaticCleanup: false,
      hostname: 'test-host',
    });

    ownerProbeMode = 'transient';
    ownerProbeCount = 0;
    childProbeCount = 0;
    const registration = registerResourceLockChildSync(repository, lease.metadata.owner, 712, {
      env,
      requesterPid: 711,
      inspectProcess: inspect,
      hostname: 'test-host',
      role: 'transient-owner-child',
    });
    assert.equal(ownerProbeCount, 3);
    assert.equal(childProbeCount, 1);
    ownerProbeMode = 'running';
    assert.equal(unregisterResourceLockChildSync(
      repository,
      lease.metadata.owner,
      registration.record.child,
      { env, requesterPid: 712, inspectProcess: inspect },
    ), true);

    ownerProbeMode = 'persistent';
    ownerProbeCount = 0;
    childProbeCount = 0;
    assert.throws(() => registerResourceLockChildSync(repository, lease.metadata.owner, 713, {
      env,
      requesterPid: 711,
      inspectProcess: inspect,
      hostname: 'test-host',
    }), /owner is not active/);
    assert.equal(ownerProbeCount, 3);
    assert.equal(childProbeCount, 0);

    ownerProbeMode = 'absent';
    ownerProbeCount = 0;
    childProbeCount = 0;
    assert.throws(() => registerResourceLockChildSync(repository, lease.metadata.owner, 714, {
      env,
      requesterPid: 711,
      inspectProcess: inspect,
      hostname: 'test-host',
    }), /owner is not active/);
    assert.equal(ownerProbeCount, 1);
    assert.equal(childProbeCount, 0);

    ownerProbeMode = 'running';
    assert.equal(lease.releaseSync(), true);
  } finally {
    ownerProbeMode = 'running';
    if (lease && !lease.released && fs.existsSync(lease.location.lockPath)) lease.releaseSync();
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(locks, { recursive: true, force: true });
  }
});

test('dead owner and wrapper remain blocked by the exact surviving registered workload identity', () => {
  const repository = makeRepository();
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-wrapper-death-'));
  const ownerEnv = lockEnvironment(locks);
  const states = new Map([
    [1_301, { ...fakeIdentity(1_301), parentPid: 1 }],
    [1_302, { ...fakeIdentity(1_302), parentPid: 1_301 }],
    [1_303, { ...fakeIdentity(1_303), parentPid: 1_302 }],
  ]);
  const inspect = (pid) => states.get(pid) || { state: 'absent' };
  let ownerLease;
  let wrapperLease;
  try {
    ownerLease = acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: ownerEnv,
      ownerPid: 1_301,
      inspectProcess: inspect,
      automaticCleanup: false,
      hostname: 'test-host',
    });
    wrapperLease = acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: lockEnvironment(locks, ownerEnv),
      ownerPid: 1_302,
      inspectProcess: inspect,
      automaticCleanup: false,
      hostname: 'test-host',
    });
    registerResourceLockChildSync(repository, ownerLease.metadata.owner, 1_303, {
      env: ownerEnv,
      requesterPid: 1_302,
      inspectProcess: inspect,
      hostname: 'test-host',
      role: 'gradle-real-workload',
    });
    assert.throws(() => wrapperLease.releaseSync(), /registered descendant pid 1303/);

    states.delete(1_301);
    states.delete(1_302);
    const orphaned = inspectResourceLock(repository, {
      env: ownerEnv,
      inspectProcess: inspect,
      hostname: 'test-host',
    });
    assert.equal(orphaned.state, 'orphaned_workload_active');
    assert.equal(orphaned.reclaimable, false);
    assert.deepEqual(orphaned.workloadChildren.active, [{ pid: 1_303, role: 'gradle-real-workload' }]);

    states.delete(1_303);
    const ended = inspectResourceLock(repository, {
      env: ownerEnv,
      inspectProcess: inspect,
      hostname: 'test-host',
    });
    assert.equal(ended.state, 'stale_owner_absent');
    assert.equal(ended.reclaimable, true);
    assert.equal(ownerLease.releaseSync(), true);
  } finally {
    if (ownerLease && !ownerLease.released && fs.existsSync(ownerLease.location.lockPath)) {
      fs.rmSync(ownerLease.location.lockPath, { recursive: true, force: true });
    }
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(locks, { recursive: true, force: true });
  }
});

test('normal child deregistration removes every registry file instead of accumulating process probes', () => {
  const repository = makeRepository();
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-child-volume-'));
  const env = lockEnvironment(locks);
  let lease;
  try {
    lease = acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env,
      ownerPid: 801,
      inspectProcess: fakeIdentity,
      automaticCleanup: false,
      hostname: 'test-host',
    });
    for (let pid = 900; pid < 950; pid += 1) {
      const registration = registerResourceLockChildSync(repository, lease.metadata.owner, pid, {
        env,
        requesterPid: 801,
        inspectProcess: fakeIdentity,
        hostname: 'test-host',
        role: 'sequential-child',
      });
      assert.equal(unregisterResourceLockChildSync(repository, lease.metadata.owner, registration.record.child, {
        env,
        requesterPid: pid,
        inspectProcess: fakeIdentity,
      }), true);
    }
    assert.deepEqual(
      fs.readdirSync(lease.location.lockPath).filter((name) => name.startsWith('workload-child-')),
      [],
    );
    assert.equal(lease.releaseSync(), true);
  } finally {
    if (lease && !lease.released && fs.existsSync(lease.location.lockPath)) lease.releaseSync();
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(locks, { recursive: true, force: true });
  }
});

test('atomic closing state rejects both sides of the child-registration release interleaving', () => {
  const repository = makeRepository();
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-closing-'));
  const firstEnv = lockEnvironment(locks);
  const secondEnv = lockEnvironment(locks);
  let first;
  let second;
  try {
    let closeSideRegistrationWasRejected = false;
    first = acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: firstEnv,
      ownerPid: 1_001,
      inspectProcess: fakeIdentity,
      automaticCleanup: false,
      hostname: 'test-host',
      onClosingMarkerCreated: () => {
        assert.throws(() => registerResourceLockChildSync(repository, first.metadata.owner, 1_002, {
          env: firstEnv,
          requesterPid: 1_001,
          inspectProcess: fakeIdentity,
          hostname: 'test-host',
        }), /lock is closing/);
        closeSideRegistrationWasRejected = true;
      },
    });
    assert.equal(first.releaseSync(), true);
    assert.equal(closeSideRegistrationWasRejected, true);

    second = acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: secondEnv,
      ownerPid: 1_101,
      inspectProcess: fakeIdentity,
      automaticCleanup: false,
      hostname: 'test-host',
    });
    assert.throws(() => registerResourceLockChildSync(repository, second.metadata.owner, 1_102, {
      env: secondEnv,
      requesterPid: 1_101,
      inspectProcess: fakeIdentity,
      hostname: 'test-host',
      onChildRegistrationReadyToWrite: () => assert.equal(second.releaseSync(), true),
    }), /ENOENT|no such file|cannot find/i);
    assert.equal(second.released, true);
  } finally {
    if (first && !first.released && fs.existsSync(first.location.lockPath)) first.releaseSync();
    if (second && !second.released && fs.existsSync(second.location.lockPath)) second.releaseSync();
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(locks, { recursive: true, force: true });
  }
});

test('a quarantined or delete-failed child record remains visible to owner release', () => {
  const repository = makeRepository();
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-child-quarantine-'));
  const env = lockEnvironment(locks);
  let lease;
  try {
    lease = acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env,
      ownerPid: 1_201,
      inspectProcess: fakeIdentity,
      automaticCleanup: false,
      hostname: 'test-host',
    });
    let registration = registerResourceLockChildSync(repository, lease.metadata.owner, 1_202, {
      env,
      requesterPid: 1_201,
      inspectProcess: fakeIdentity,
      hostname: 'test-host',
      role: 'quarantine-child',
    });
    assert.equal(unregisterResourceLockChildSync(repository, lease.metadata.owner, registration.record.child, {
      env,
      requesterPid: 1_202,
      inspectProcess: fakeIdentity,
      onChildRecordQuarantined: () => {
        assert.throws(() => lease.releaseSync(), /workload children remain active/);
      },
    }), true);

    registration = registerResourceLockChildSync(repository, lease.metadata.owner, 1_203, {
      env,
      requesterPid: 1_201,
      inspectProcess: fakeIdentity,
      hostname: 'test-host',
      role: 'delete-failure-child',
    });
    assert.throws(() => unregisterResourceLockChildSync(repository, lease.metadata.owner, registration.record.child, {
      env,
      requesterPid: 1_203,
      inspectProcess: fakeIdentity,
      removeChildRecord: () => { throw new Error('injected child-record delete failure'); },
    }), /injected child-record delete failure/);
    assert.throws(() => lease.releaseSync(), /workload children remain active/);
    assert.equal(unregisterResourceLockChildSync(repository, lease.metadata.owner, registration.record.child, {
      env,
      requesterPid: 1_203,
      inspectProcess: fakeIdentity,
    }), true);
    assert.equal(lease.releaseSync(), true);
  } finally {
    if (lease && !lease.released && fs.existsSync(lease.location.lockPath)) {
      fs.rmSync(lease.location.lockPath, { recursive: true, force: true });
    }
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(locks, { recursive: true, force: true });
  }
});

test('release checks the complete observed owner identity before deleting anything', () => {
  const repository = makeRepository();
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-release-'));
  const env = lockEnvironment(locks);
  let lease;
  try {
    lease = acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env,
      ownerPid: 515,
      inspectProcess: fakeIdentity,
      automaticCleanup: false,
      hostname: 'test-host',
    });
    const ownerPath = path.join(lease.location.lockPath, 'owner.json');
    const original = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    assert.throws(() => releaseResourceLockByOwnerSync(repository, {
      id: original.owner.id,
      pid: original.owner.pid,
      processStartIdentity: original.owner.processStartIdentity,
    }, { env, inspectProcess: fakeIdentity }), /process other than the exact owner/);
    assert.throws(() => releaseResourceLockByOwnerSync(repository, {
      id: original.owner.id,
      pid: original.owner.pid + 1,
      processStartIdentity: original.owner.processStartIdentity,
    }, { env, requesterPid: original.owner.pid, inspectProcess: fakeIdentity }), /owned by another process/);
    assert.throws(() => releaseResourceLockByOwnerSync(repository, {
      id: original.owner.id,
      pid: original.owner.pid,
      processStartIdentity: original.owner.processStartIdentity,
    }, { env, requesterPid: original.owner.pid + 1, inspectProcess: fakeIdentity }), /process other than the exact owner/);
    assert.throws(() => releaseResourceLockByOwnerSync(repository, {
      id: original.owner.id,
      pid: original.owner.pid,
      processStartIdentity: original.owner.processStartIdentity,
    }, {
      env,
      requesterPid: original.owner.pid,
      inspectProcess: (pid) => ({ state: 'running', identity: `reused-start:${pid}` }),
    }), /process other than the exact owner/);
    fs.writeFileSync(ownerPath, `${JSON.stringify({
      ...original,
      owner: { ...original.owner, id: 'different-owner' },
    }, null, 2)}\n`);
    assert.throws(() => lease.releaseSync(), /owned by another process/);
    assert.equal(fs.existsSync(lease.location.lockPath), true);
    fs.writeFileSync(ownerPath, `${JSON.stringify(original, null, 2)}\n`);
    assert.equal(lease.releaseSync(), true);
  } finally {
    if (lease && !lease.released && fs.existsSync(lease.location.lockPath)) {
      const ownerPath = path.join(lease.location.lockPath, 'owner.json');
      fs.writeFileSync(ownerPath, `${JSON.stringify(lease.metadata, null, 2)}\n`);
      lease.releaseSync();
    }
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(locks, { recursive: true, force: true });
  }
});

test('low-impact launch entrypoints are locked, fail-closed, observable, and JVM-capped', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const nodeHelper = fs.readFileSync(path.join(root, 'scripts', 'resource-lock.js'), 'utf8');
  const nodeSchedulingHelper = fs.readFileSync(path.join(root, 'scripts', 'set-node-low-impact.ps1'), 'utf8');
  const helper = fs.readFileSync(path.join(root, 'scripts', 'resource-lock.ps1'), 'utf8');
  const fabricBuild = fs.readFileSync(path.join(root, 'fabric-client', 'build.gradle.kts'), 'utf8');
  const fabricProperties = fs.readFileSync(path.join(root, 'fabric-client', 'gradle.properties'), 'utf8');
  const paperBuild = fs.readFileSync(path.join(root, 'test-harness-plugin', 'build.gradle.kts'), 'utf8');
  const paperProperties = fs.readFileSync(path.join(root, 'test-harness-plugin', 'gradle.properties'), 'utf8');
  const offlineRunner = fs.readFileSync(path.join(root, 'scripts', 'run-offline-tests.js'), 'utf8');
  const synchronousNodeChild = fs.readFileSync(path.join(root, 'scripts', 'baseline-synchronous-node-child.js'), 'utf8');
  const brainRunner = fs.readFileSync(path.join(root, 'scripts', 'run-fabric-brain-tests.js'), 'utf8');
  const nodeBootstrap = fs.readFileSync(path.join(root, 'scripts', 'resource-lock-bootstrap.js'), 'utf8');
  const mineflayerLive = fs.readFileSync(path.join(root, 'scripts', 'live-suite.js'), 'utf8');
  const pluginLive = fs.readFileSync(path.join(root, 'scripts', 'run-live-scenario.js'), 'utf8');
  const gradleWrapper = fs.readFileSync(path.join(root, 'scripts', 'run-gradle-low-impact.ps1'), 'utf8');
  const jdkProbe = fs.readFileSync(path.join(root, 'scripts', 'jdk21-probe.ps1'), 'utf8');
  const offlineTestSources = fs.readdirSync(path.join(root, 'test', 'offline'))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => ({
      name,
      source: fs.readFileSync(path.join(root, 'test', 'offline', name), 'utf8'),
    }));

  assert.match(helper, /ProcessPriorityClass\]::Idle/);
  assert.match(helper, /Required Idle\/one-core policy did not stick/);
  assert.match(helper, /processStartIdentity/);
  assert.match(helper, /PowerShell\.Exiting/);
  assert.match(helper, /function New-McbotProcessIdentity/);
  assert.match(helper, /StartTimeUtcTicks/);
  assert.match(helper, /function New-McbotCimProcessIdentity/);
  assert.match(helper, /Get-CimInstance Win32_Process -Filter "ProcessId = \$processId"/);
  assert.match(helper, /currentCim\.CommandLine/);
  assert.match(helper, /currentCim\.ParentProcessId/);
  assert.match(helper, /Abs\(\[int64\]\$actualStart\.Ticks - \[int64\]\$expectedStart\.Ticks\) -gt 10000/);
  assert.match(helper, /function Get-McbotValidatedProcess/);
  assert.match(helper, /function Stop-McbotProcessIdentityTree/);
  assert.match(helper, /OpenProcess\(PROCESS_TERMINATE \| PROCESS_QUERY_LIMITED_INFORMATION \| SYNCHRONIZE/);
  assert.match(helper, /GetProcessTimes\(process,[\s\S]*actualStartTimeUtcTicks != expectedStartTimeUtcTicks[\s\S]*TerminateProcess\(process, 1\)[\s\S]*WaitForSingleObject\(process, waitMilliseconds\)/);
  assert.match(helper, /NativeProcess\]::TerminateExactWithWait\([\s\S]*\[int\]\$Identity\.Pid,[\s\S]*\[int64\]\$Identity\.StartTimeUtcTicks,[\s\S]*\[uint32\]\$WaitMilliseconds/);
  assert.match(helper, /Stop-McbotProcessIdentityTree -Identity \$identity -WaitMilliseconds \$perIdentityWait -Diagnostic \(\[ref\]\$stopDiagnostic\)/);
  assert.match(helper, /native_termination_refused_or_incomplete/);
  assert.match(helper, /startTicks=\$start,name=\$safeName,role=\$safeRole,jobMember=\$membership,terminationSignaled=\$everSignaled,outcome=\$\(\$diagnostic\.Outcome\),nativeError=\$native/);
  assert.doesNotMatch(helper, /\.Kill\(/);
  assert.doesNotMatch(helper, /CloseMainWindow|Request-McbotProcessIdentityClose/);
  assert.match(helper, /function Get-McbotProcessTreeIdentities/);
  assert.match(helper, /function Test-McbotStrictDescendantIdentity/);
  assert.match(helper, /ChildIdentity\.StartTimeUtcTicks -gt \[int64\]\$ParentIdentity\.StartTimeUtcTicks/);
  assert.match(helper, /Test-McbotStrictDescendantIdentity -ParentIdentity \$parent -ChildIdentity \$child/);
  assert.match(helper, /function Test-McbotCommandLineContainsPath/);
  assert.match(helper, /KILL_ON_JOB_CLOSE/);
  assert.match(helper, /\$basic\.LimitFlags = \[uint32\]0x00002030/);
  assert.match(helper, /\$basic\.PriorityClass = \[uint32\]0x00000040/);
  assert.match(helper, /\$basic\.Affinity = \[UIntPtr\]\$currentAffinity/);
  assert.match(helper, /QueryInformationJobObject\([\s\S]*\$observedBasic\.PriorityClass[\s\S]*\$observedBasic\.Affinity\.ToUInt64\(\)/);
  assert.match(helper, /function Wait-McbotKillOnCloseJobHasNoChildren/);
  assert.match(helper, /Wait-McbotKillOnCloseJobHasNoChildren -TimeoutMilliseconds 5000/);
  assert.match(helper, /Stop-McbotKillOnCloseJobChildren -Reason 'resource-lock finalization'/);
  assert.match(helper, /function Complete-McbotResourceLockWorkloadProcess[\s\S]*Wait-McbotKillOnCloseJobHasNoChildren -TimeoutMilliseconds 5000[\s\S]*Stop-McbotKillOnCloseJobChildren -Reason "\$\(\$Registration\.Role\) completion"[\s\S]*Assert-McbotKillOnCloseJobHasNoChildren/);
  assert.match(helper, /function Assert-McbotDedicatedPowerShellFileHost/);
  assert.match(helper, /\$PSVersionTable\.PSVersion\.Major -lt 7/);
  assert.match(helper, /ProcessStartInfo\]\.GetProperty\('ArgumentList'\)/);
  assert.match(helper, /\[Environment\]::GetCommandLineArgs\(\)/);
  assert.match(helper, /\$executionModeSelectors = @\(/);
  assert.match(helper, /'-command', '-commandwithargs', '-encodedcommand'/);
  assert.match(helper, /refuse PowerShell execution mode \$argument before -File/,
    'a -Command payload must not pass by appending -File and a matching path later');
  assert.match(helper, /Unsupported PowerShell host argument before the required -File entrypoint/);
  assert.match(helper, /dedicated-pwsh-file/);
  assert.match(helper, /entrypoint does not match this MCBot launcher/);
  assert.match(helper, /NativeJob\]::IsProcessInJob\([\s\S]*\$process\.Handle,[\s\S]*\$script:McbotKillOnCloseJobHandle/);
  assert.match(helper, /function Start-McbotRegisteredWorkloadProcess/);
  assert.match(helper, /function Complete-McbotResourceLockWorkloadProcess/);
  assert.match(helper, /\$startInfo\.ArgumentList\.Add\('call'\)/);
  assert.match(helper, /\$startInfo\.ArgumentList\.Add\(\$resolvedBatch\)/,
    'batch paths containing spaces must be forwarded as their own exact argument');
  assert.match(helper, /foreach \(\$argument in \$ArgumentList\) \{ \[void\]\$startInfo\.ArgumentList\.Add\(\[string\]\$argument\) \}/,
    'batch arguments containing spaces must retain their own ProcessStartInfo boundary');
  assert.doesNotMatch(helper, /'call "' \+ \$resolvedBatch/,
    'cmd.exe command text must not be embedded as one CRT-escaped ArgumentList element');
  assert.match(helper, /--owner-start-identity/);
  assert.match(helper, /deregister-child/);
  assert.match(nodeHelper, /function rollbackFailedAcquisition/);
  assert.match(nodeHelper, /ownership changed during failed acquisition; refusing cleanup/);
  assert.match(nodeHelper, /resolveWindowsPowerShellExecutable/);
  assert.match(nodeHelper, /Program Files', 'PowerShell', '7', 'pwsh[.]exe/);
  assert.match(nodeHelper, /GetProperty\(\"ParentProcessId\",\$flags\)/);
  assert.match(nodeHelper, /Abs\(\[int64\]\$cticks-\[int64\]\$ticks\) -gt 10000/);
  assert.match(nodeHelper, /\$p2\.StartTime\.ToUniversalTime\(\)\.Ticks -ne \$ticks/);
  assert.match(nodeHelper, /\$parent2 -ne \$parent/);
  assert.match(nodeHelper, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(nodeHelper, /timeout: 10_000/);
  assert.match(nodeHelper, /if \(output === 'ABSENT'\) return \{ state: 'absent' \}/);
  assert.match(nodeHelper, /return \{ state: 'unknown' \}/);
  assert.match(nodeHelper, /set-node-low-impact\.ps1/);
  assert.match(nodeHelper, /let execution;[\s\S]*?for \(let attempt = 0; attempt < 2; attempt \+= 1\)[\s\S]*?timeout: 30_000/);
  assert.match(nodeHelper, /execution[.]error[?][.]code !== 'ETIMEDOUT'/);
  assert.match(nodeHelper, /receipt\?\.verifierParentPid !== process\.pid/);
  assert.match(nodeHelper, /affinity & \(affinity - 1n\)/);
  assert.match(nodeSchedulingHelper, /GetProperty\([\s\S]*?'ParentProcessId'[\s\S]*?Instance,NonPublic/);
  assert.match(nodeSchedulingHelper, /\$selfParentPid -ne \$TargetPid/);
  assert.match(nodeSchedulingHelper, /\$startTicks -lt \$selfStartTicks/);
  assert.match(nodeSchedulingHelper, /compatibility fallback[\s\S]*?Get-CimInstance Win32_Process/);
  assert.match(nodeSchedulingHelper, /targetAgain\.StartTime\.ToUniversalTime\(\)\.Ticks/);
  assert.match(nodeSchedulingHelper, /targetAgain\.PriorityClass -ne \[Diagnostics\.ProcessPriorityClass\]::Idle/);
  assert.match(nodeSchedulingHelper, /observedMask -ne \$mask/);
  assert.match(helper, /'-XX:\+UseSerialGC'/);
  assert.match(helper, /'-XX:ActiveProcessorCount=2'/);
  assert.match(helper, /'-XX:CICompilerCount=2'/);
  assert.match(helper, /ForkJoinPool\.common\.parallelism=1/);
  assert.match(helper, /JAVA_TOOL_OPTIONS, _JAVA_OPTIONS, JDK_JAVA_OPTIONS, JAVA_OPTS, and GRADLE_OPTS must be unset/);
  assert.match(helper, /function Assert-McbotSafeGradleArguments/);
  assert.equal(helper.includes('-Dorg\\.gradle\\.(?:jvmargs|workers\\.max|parallel|daemon|priority|java\\.home)'), true);
  assert.equal(helper.includes('-D(?:=|$)'), true);
  assert.match(helper, /function Get-McbotCanonicalGradleArguments/);
  assert.match(helper, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$JdkRoot/);
  assert.match(helper, /-Dorg\.gradle\.jvmargs=\$jvmArguments/);
  assert.match(helper, /-Dorg\.gradle\.java\.home=\$resolvedJdkRoot/);
  const canonicalGradleArguments = helper.slice(
    helper.indexOf('function Get-McbotCanonicalGradleArguments'),
    helper.indexOf('function New-McbotProcessIdentity'),
  );
  assert.doesNotMatch(canonicalGradleArguments, /org\.gradle\.priority/);
  assert.doesNotMatch(fabricProperties, /org\.gradle\.priority/);
  assert.doesNotMatch(paperProperties, /org\.gradle\.priority/);
  assert.match(helper, /function Get-McbotKillOnCloseJobProcessPolicySnapshot/);
  assert.match(helper, /function Assert-McbotKillOnCloseJobChildrenLowImpact/);
  assert.match(helper, /function Wait-McbotRegisteredWorkloadProcessLowImpact/);
  assert.match(helper, /A contained workload descendant escaped required Idle\/one-core scheduling/);
  for (const source of [fabricBuild, paperBuild, fabricProperties, paperProperties]) {
    assert.match(source, /UseSerialGC/);
    assert.match(source, /ActiveProcessorCount=2/);
    assert.match(source, /CICompilerCount=2/);
    assert.match(source, /ForkJoinPool\.common\.parallelism=1/);
  }
  assert.match(fabricBuild, /tasks\.withType<JavaExec>\(\)\.configureEach[\s\S]*maxHeapSize = "1G"/);
  assert.match(fabricBuild, /maxParallelForks = 1/);
  assert.match(paperBuild, /maxParallelForks = 1/);
  assert.match(offlineRunner, /acquireOrJoinResourceLockSync/);
  assert.match(offlineRunner, /testConcurrency: 1/);
  assert.match(offlineRunner, /RESOURCE_LOCK_BOOTSTRAP/);
  assert.match(offlineRunner, /createBaselineSynchronousNodeChildEnvironment/);
  assert.match(synchronousNodeChild, /canonical guarded Node options/);
  assert.match(synchronousNodeChild, /env\.NODE_OPTIONS = `\$\{guardOption\} --v8-pool-size=1`/);
  for (const { name, source } of offlineTestSources) {
    assert.doesNotMatch(source,
      /import\s*\{[^}]*\b(?:spawn|fork|exec|execFile)\b[^}]*\}\s*from\s*['"]node:child_process['"]/,
      `${name} must synchronously join every direct child process`);
    assert.doesNotMatch(source, /require\(\s*['"]node:child_process['"]\s*\)/,
      `${name} must use statically auditable child-process imports`);
    assert.doesNotMatch(source, /detached\s*:\s*true/,
      `${name} must not detach a child from its registered test worker`);
  }
  assert.match(offlineRunner, /one-process-per-file isolation/);
  assert.match(offlineRunner, /'--test-reporter=tap'/);
  assert.doesNotMatch(offlineRunner, /^\s*'--test',\s*$/m,
    'the offline runner must not insert an unregistered Node test coordinator');
  assert.doesNotMatch(offlineRunner, /^\s*'--test-concurrency=1',\s*$/m,
    'the outer loop, not a nested Node test coordinator, owns serialization');
  assert.match(brainRunner, /acquireOrJoinResourceLockSync/);
  assert.match(brainRunner, /one-process-per-file isolation/);
  assert.match(brainRunner, /'--test-reporter=tap'/);
  assert.doesNotMatch(brainRunner, /^\s*'--test',\s*$/m,
    'the Fabric brain runner must not insert an unregistered Node test coordinator');
  assert.doesNotMatch(brainRunner, /^\s*'--test-concurrency=1',\s*$/m,
    'the Fabric brain runner outer loop owns serialization');
  assert.match(nodeBootstrap, /acquireOrJoinResourceLockSync/);
  assert.match(mineflayerLive, /acquireOrJoinResourceLockSync/);
  assert.match(mineflayerLive, /applyLowImpactNodeScheduling/);
  assert.match(pluginLive, /acquireOrJoinResourceLockSync/);
  assert.match(pluginLive, /applyLowImpactNodeScheduling/);
  assert.match(pluginLive, /UV_THREADPOOL_SIZE: '2'/);
  assert.match(gradleWrapper, /ValidateSet\('fabric-client', 'test-harness-plugin'\)/);
  assert.match(gradleWrapper, /Enter-McbotResourceLock/);
  assert.match(gradleWrapper, /Set-McbotLowImpactProcessPolicy/);
  assert.match(helper, /--no-daemon/);
  assert.match(helper, /--no-parallel/);
  assert.match(helper, /--max-workers=1/);
  assert.match(gradleWrapper, /Assert-McbotSafeGradleArguments -Arguments \$GradleArguments/);
  assert.match(gradleWrapper, /Get-McbotCanonicalGradleArguments/);
  assert.ok(gradleWrapper.indexOf('selected Java reported major $reportedMajor')
    < gradleWrapper.indexOf('$canonicalGradleArguments = Get-McbotCanonicalGradleArguments'));
  assert.match(gradleWrapper, /Get-McbotCanonicalGradleArguments[\s\S]*-JdkRoot \$validatedJdkRoot/);
  assert.match(gradleWrapper, /Wait-McbotRegisteredWorkloadProcessLowImpact[\s\S]*-RequiredProcessName @\('java', 'javaw'\)/);
  assert.match(gradleWrapper, /\$env:JAVA_TOOL_OPTIONS = Get-McbotCanonicalJavaToolOptions/);
  assert.match(gradleWrapper, /Start-McbotRegisteredWorkloadProcess[\s\S]*gradle-\$Project-java-version-probe/);
  assert.match(gradleWrapper, /bin\\javac\.exe/);
  assert.match(gradleWrapper, /requires JDK 21; selected Java reported major \$reportedMajor/);
  assert.match(gradleWrapper, /New-Item -ItemType File -Path \$javaProbeGate/);
  assert.match(gradleWrapper, /\$javaProbeTimedOut = -not \$javaProbe\.Process\.WaitForExit\(10000\)/);
  assert.doesNotMatch(gradleWrapper, /\$javaProbe\.Process\.WaitForExit\(\)/);
  assert.match(gradleWrapper, /finally \{[\s\S]*Test-McbotProcessIdentity -Identity \$javaProbe\.Identity[\s\S]*Stop-McbotKillOnCloseJobChildren -Reason "\$\(\$javaProbe\.Role\) bounded probe cleanup"[\s\S]*Complete-McbotResourceLockWorkloadProcess -Registration \$javaProbe/);
  assert.match(gradleWrapper, /if \(\$javaProbeTimedOut\) \{\s*throw 'The selected Java executable version probe timed out after 10 seconds\.'/);
  assert.match(gradleWrapper, /StandardOutputTask\.Wait\(1000\)[\s\S]*StandardErrorTask\.Wait\(1000\)/);
  assert.ok(gradleWrapper.indexOf('Complete-McbotResourceLockWorkloadProcess -Registration $javaProbe')
    < gradleWrapper.indexOf('$javaProbeOutputReady = $javaProbe.StandardOutputTask.Wait(1000)'));
  assert.match(jdkProbe, /MCBOT_RESOURCE_LOCK_OWNER_ID/);
  assert.match(jdkProbe, /canonical low-impact Java policy/);
  assert.match(jdkProbe, /PriorityClass -ne \[Diagnostics\.ProcessPriorityClass\]::Idle/);
  assert.match(jdkProbe, /timed out waiting for its containment gate/);
  assert.match(jdkProbe, /& \$javaPath -version/);
  assert.match(gradleWrapper, /Start-McbotRegisteredWorkloadProcess/);
  assert.match(gradleWrapper, /Complete-McbotResourceLockWorkloadProcess/);
});

test('resource-lock location exposes no command line or credential material', () => {
  const repository = makeRepository();
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-metadata-'));
  try {
    const location = resolveResourceLockLocation(repository, { env: lockEnvironment(locks) });
    assert.equal(path.dirname(location.lockPath), path.resolve(locks));
    assert.match(path.basename(location.lockPath), /^[a-f0-9]{32}\.lock$/);
    assert.equal(JSON.stringify(location).includes('API_KEY'), false);
    assert.throws(() => acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: lockEnvironment(locks),
      ownerPid: 818,
      inspectProcess: fakeIdentity,
      purpose: 'token=must-not-be-recorded',
      automaticCleanup: false,
    }), /non-secret slug/);
    assert.throws(() => acquireOrJoinResourceLockSync({
      repositoryRoot: repository,
      env: lockEnvironment(locks),
      ownerPid: 818,
      ownerId: '../claim-path-escape',
      inspectProcess: fakeIdentity,
      automaticCleanup: false,
    }), /owner ID must be a non-secret slug/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(locks, { recursive: true, force: true });
  }
});

test('ambient environment cannot redirect the production repository-common lock root', () => {
  const repository = makeRepository('mcbot-resource-canonical-root-');
  const attemptedOverride = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-root-bypass-'));
  try {
    const canonical = resolveResourceLockLocation(repository, { env: {} });
    const ambientAttempt = resolveResourceLockLocation(repository, {
      env: {
        MCBOT_RESOURCE_LOCK_ROOT: attemptedOverride,
        LOCALAPPDATA: path.join(attemptedOverride, 'local-app-data'),
        XDG_RUNTIME_DIR: path.join(attemptedOverride, 'xdg-runtime'),
        TEMP: path.join(attemptedOverride, 'temp'),
        TMP: path.join(attemptedOverride, 'tmp'),
      },
    });
    assert.equal(ambientAttempt.lockPath, canonical.lockPath);
    assert.notEqual(path.dirname(ambientAttempt.lockPath), path.resolve(attemptedOverride));
    assert.equal(
      path.normalize(path.dirname(ambientAttempt.baseDirectory)),
      path.normalize(resolveRepositoryScope(repository).scopePath),
    );

    const explicitTestEnvironment = lockEnvironment(attemptedOverride);
    const isolated = resolveResourceLockLocation(repository, { env: explicitTestEnvironment });
    assert.equal(path.dirname(isolated.lockPath), path.resolve(attemptedOverride));
  } finally {
    fs.rmSync(attemptedOverride, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
