import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DETERMINISTIC_RESOURCE_LEASE_SYMBOL,
  assertDeterministicLowImpactNodeRuntime,
  controlledDeterministicNodeLaunch,
  ensureDeterministicResourceAdmissionSync,
  releaseDeterministicResourceAdmissionSync,
} from '../../scripts/deterministic-resource-admission.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runtime() {
  return { v8PoolSize: 1, uvThreadpoolSize: 2, sources: ['execArgv'] };
}

function scheduling() {
  return { schedulingPriority: 'Idle', processorAffinity: '0x2' };
}

function lease() {
  let released = false;
  return {
    environment: {
      MCBOT_RESOURCE_LOCK_PATH: 'lock-path',
      MCBOT_RESOURCE_LOCK_OWNER_ID: 'owner-id',
      MCBOT_RESOURCE_LOCK_REPOSITORY_ID: 'repository-id',
      MCBOT_RESOURCE_LOCK_OWNER_PID: '101',
    },
    releaseSync() {
      released = true;
      return true;
    },
    get released() { return released; },
  };
}

function lockReceipt() {
  return {
    repositoryId: 'repository-id',
    ownerId: 'owner-id',
    ownerPid: 101,
    processPid: 202,
    inherited: true,
  };
}

test('deterministic evaluation requires launch-time V8 and libuv caps', () => {
  assert.deepEqual(assertDeterministicLowImpactNodeRuntime({
    execArgv: ['--v8-pool-size=1'],
    nodeOptions: '',
    uvThreadpoolSize: '2',
  }), {
    v8PoolSize: 1,
    uvThreadpoolSize: 2,
    sources: ['execArgv'],
  });
  assert.throws(() => assertDeterministicLowImpactNodeRuntime({
    execArgv: [], nodeOptions: '', uvThreadpoolSize: '2',
  }), /--v8-pool-size=1/);
  assert.throws(() => assertDeterministicLowImpactNodeRuntime({
    execArgv: ['--v8-pool-size=1', '--v8_pool_size=8'], nodeOptions: '', uvThreadpoolSize: '2',
  }), /--v8-pool-size=1/);
  assert.throws(() => assertDeterministicLowImpactNodeRuntime({
    execArgv: ['--v8-pool-size=1'], nodeOptions: '', uvThreadpoolSize: '8',
  }), /UV_THREADPOOL_SIZE=1 or 2/);
});

test('deterministic admission acquires, validates, publishes, and releases one lease', () => {
  const globalObject = {};
  const ownedLease = lease();
  let acquisition = null;
  const admission = ensureDeterministicResourceAdmissionSync({
    repositoryRoot: ROOT,
    globalObject,
    assertRuntime: () => runtime(),
    applyScheduling: () => scheduling(),
    acquireLease: (options) => {
      acquisition = options;
      return ownedLease;
    },
    assertLease: () => lockReceipt(),
  });
  assert.equal(acquisition.purpose, 'deterministic-evaluation');
  assert.equal(acquisition.details.serialized, true);
  assert.equal(acquisition.details.v8PoolSize, 1);
  assert.equal(acquisition.details.uvThreadpoolSize, 2);
  assert.equal(globalObject[DETERMINISTIC_RESOURCE_LEASE_SYMBOL], ownedLease);
  assert.equal(admission.receipt.schedulingPriority, 'Idle');
  assert.equal(releaseDeterministicResourceAdmissionSync(admission, { globalObject }), true);
  assert.equal(ownedLease.released, true);
  assert.equal(globalObject[DETERMINISTIC_RESOURCE_LEASE_SYMBOL], undefined);
});

test('deterministic admission joins a bootstrapped lease and propagates contention', () => {
  const inheritedLease = lease();
  const globalObject = { [DETERMINISTIC_RESOURCE_LEASE_SYMBOL]: inheritedLease };
  const joined = ensureDeterministicResourceAdmissionSync({
    repositoryRoot: ROOT,
    globalObject,
    assertRuntime: () => runtime(),
    applyScheduling: () => scheduling(),
    acquireLease: () => { throw new Error('must not reacquire'); },
    assertLease: (_repositoryRoot, candidate) => {
      assert.equal(candidate, inheritedLease);
      return lockReceipt();
    },
  });
  assert.equal(joined.acquiredHere, false);

  assert.throws(() => ensureDeterministicResourceAdmissionSync({
    repositoryRoot: ROOT,
    globalObject: {},
    assertRuntime: () => runtime(),
    applyScheduling: () => scheduling(),
    acquireLease: () => { throw new Error('resource lock is active'); },
    assertLease: () => lockReceipt(),
  }), /resource lock is active/);
});

test('failed deterministic lease validation rolls back only a newly acquired lease', () => {
  const globalObject = {};
  const ownedLease = lease();
  assert.throws(() => ensureDeterministicResourceAdmissionSync({
    repositoryRoot: ROOT,
    globalObject,
    assertRuntime: () => runtime(),
    applyScheduling: () => scheduling(),
    acquireLease: () => ownedLease,
    assertLease: () => { throw new Error('invalid active lease'); },
  }), /invalid active lease/);
  assert.equal(ownedLease.released, true);
  assert.equal(globalObject[DETERMINISTIC_RESOURCE_LEASE_SYMBOL], undefined);
});

test('every deterministic Node descendant receives the join bootstrap and pool caps', () => {
  const admission = { lease: lease(), runtime: runtime() };
  const launch = controlledDeterministicNodeLaunch(
    ['scripts/check-js.js'],
    admission,
    { NODE_OPTIONS: '--require="guard.cjs"', PATH: 'test-path' },
  );
  assert.deepEqual(launch.args.slice(0, 2), ['--v8-pool-size=1', '--import']);
  assert.match(launch.args[2], /^file:/);
  assert.equal(launch.args.at(-1), 'scripts/check-js.js');
  assert.match(launch.env.NODE_OPTIONS, /--require="guard\.cjs"/);
  assert.match(launch.env.NODE_OPTIONS, /--import="file:/);
  assert.match(launch.env.NODE_OPTIONS, /--v8-pool-size=1/);
  assert.equal(launch.env.UV_THREADPOOL_SIZE, '2');
  assert.equal(launch.env.MCBOT_RESOURCE_LOCK_OWNER_ID, 'owner-id');
});

test('public deterministic and syntax commands use canonical low-impact launch flags', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const canonical = /--env-file=\.\/config\/low-impact-node\.env --v8-pool-size=1 --import \.\/scripts\/resource-lock-bootstrap\.js/;
  const baselineCanonical = /^node --env-file=\.\/config\/low-impact-node\.env --v8-pool-size=1 scripts\/run-(?:baseline|test-all)\.js$/;
  assert.match(packageJson.scripts['test:det'], canonical);
  assert.match(packageJson.scripts.check, canonical);
  assert.match(packageJson.scripts['test:baseline'], baselineCanonical);
  assert.match(packageJson.scripts['test:all'], baselineCanonical);

  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'deterministic-eval.js'), 'utf8');
  assert.match(source, /ensureDeterministicResourceAdmissionSync\(\)/);
  assert.match(source, /controlledDeterministicNodeLaunch\(args, resourceAdmission, sourceEnvironment\)/);
  assert.match(source, /finally \{\s*releaseDeterministicResourceAdmissionSync\(resourceAdmission\)/);
});
