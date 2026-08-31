import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  LIVE_CLIENT_ADMISSION_SYMBOL,
  RESOURCE_LOCK_LEASE_SYMBOL,
  assertLowImpactNodeRuntime,
  ensureLiveClientResourceAdmissionSync,
} from '../../src/runtime/live_client_admission.js';

const LOCK_RECEIPT = Object.freeze({
  repositoryId: 'repository-id',
  ownerId: 'owner-id',
  ownerPid: 101,
  processPid: 202,
  inherited: true,
});
const ENDPOINT_RECEIPT = Object.freeze({
  state: 'remote',
  policy: 'phase1_remote_server_only',
});

test('live-client admission acquires once, validates the receipt, and checks the endpoint last', () => {
  const events = [];
  const globalObject = {};
  const lease = { released: false, releaseSync: () => { events.push('release'); } };
  const first = ensureLiveClientResourceAdmissionSync({
    repositoryRoot: process.cwd(),
    globalObject,
    host: '192.0.2.25',
    port: 25565,
    purpose: 'test-live-client',
    assertRuntime: () => ({ v8PoolSize: 1, uvThreadpoolSize: 2 }),
    applyScheduling: () => {
      events.push('schedule');
      return { schedulingPriority: 'Idle' };
    },
    acquireLease: (options) => {
      events.push('acquire');
      assert.equal(options.details.liveClientProfile, 'phase1_remote_only');
      assert.equal(options.details.serialized, true);
      return lease;
    },
    assertLease: (_root, candidate) => {
      events.push('validate');
      assert.equal(candidate, lease);
      return LOCK_RECEIPT;
    },
    assertEndpoint: (options) => {
      events.push('endpoint');
      assert.deepEqual(options, { host: '192.0.2.25', ports: [25565], denyLocalEndpoint: true });
      return ENDPOINT_RECEIPT;
    },
  });
  assert.deepEqual(events, ['schedule', 'acquire', 'validate', 'endpoint']);
  assert.equal(first.lease, lease);
  assert.equal(globalObject[RESOURCE_LOCK_LEASE_SYMBOL], lease);
  assert.equal(globalObject[LIVE_CLIENT_ADMISSION_SYMBOL], first.receipt);
  assert.equal(first.receipt.endpointState, 'remote');

  events.length = 0;
  const second = ensureLiveClientResourceAdmissionSync({
    repositoryRoot: process.cwd(),
    globalObject,
    host: '192.0.2.25',
    port: 25565,
    assertRuntime: () => ({ v8PoolSize: 1, uvThreadpoolSize: 2 }),
    applyScheduling: () => {
      events.push('schedule');
      return { schedulingPriority: 'Idle' };
    },
    acquireLease: () => { throw new Error('must reuse the validated lease'); },
    assertLease: () => {
      events.push('validate');
      return LOCK_RECEIPT;
    },
    assertEndpoint: () => {
      events.push('endpoint');
      return ENDPOINT_RECEIPT;
    },
  });
  assert.equal(second.lease, lease);
  assert.deepEqual(events, ['schedule', 'validate', 'endpoint']);
});

test('live-client admission rolls back only a lease it acquired when endpoint admission fails', () => {
  const globalObject = {};
  let releases = 0;
  const lease = { released: false, releaseSync: () => { releases += 1; } };
  assert.throws(() => ensureLiveClientResourceAdmissionSync({
    repositoryRoot: process.cwd(),
    globalObject,
    host: 'localhost.',
    port: 25565,
    assertRuntime: () => ({ v8PoolSize: 1, uvThreadpoolSize: 2 }),
    applyScheduling: () => ({ schedulingPriority: 'Idle' }),
    acquireLease: () => lease,
    assertLease: () => LOCK_RECEIPT,
    assertEndpoint: () => { throw new Error('local endpoint denied'); },
  }), /local endpoint denied/);
  assert.equal(releases, 1);
  assert.equal(RESOURCE_LOCK_LEASE_SYMBOL in globalObject, false);

  const inheritedGlobal = { [RESOURCE_LOCK_LEASE_SYMBOL]: lease };
  assert.throws(() => ensureLiveClientResourceAdmissionSync({
    repositoryRoot: process.cwd(),
    globalObject: inheritedGlobal,
    host: '192.0.2.25',
    port: 25565,
    assertRuntime: () => ({ v8PoolSize: 1, uvThreadpoolSize: 2 }),
    applyScheduling: () => ({ schedulingPriority: 'Idle' }),
    acquireLease: () => { throw new Error('must not acquire'); },
    assertLease: () => { throw new Error('invalid inherited receipt'); },
    assertEndpoint: () => ENDPOINT_RECEIPT,
  }), /invalid inherited receipt/);
  assert.equal(releases, 1);
  assert.equal(inheritedGlobal[RESOURCE_LOCK_LEASE_SYMBOL], lease);
});

test('live-client admission accepts only an unambiguous one-thread V8 pool declaration', () => {
  assert.deepEqual(assertLowImpactNodeRuntime({ execArgv: ['--v8-pool-size=1'], nodeOptions: '', uvThreadpoolSize: '2' }), {
    v8PoolSize: 1,
    uvThreadpoolSize: 2,
    sources: ['execArgv'],
  });
  assert.deepEqual(assertLowImpactNodeRuntime({ execArgv: [], nodeOptions: '--import="file:///C:/Program%20Files/MCBot/bootstrap.js" --v8-pool-size 1', uvThreadpoolSize: '1' }), {
    v8PoolSize: 1,
    uvThreadpoolSize: 1,
    sources: ['NODE_OPTIONS'],
  });
  assert.throws(() => assertLowImpactNodeRuntime({ execArgv: [], nodeOptions: '', uvThreadpoolSize: '2' }), /requires.*--v8-pool-size=1/);
  assert.throws(() => assertLowImpactNodeRuntime({
    execArgv: ['--v8-pool-size=1', '--v8_pool_size=8'],
    nodeOptions: '',
    uvThreadpoolSize: '2',
  }), /requires.*--v8-pool-size=1/);
  assert.throws(() => assertLowImpactNodeRuntime({ execArgv: [], nodeOptions: '--v8-pool-size="1', uvThreadpoolSize: '2' }), /unterminated quote/);
  assert.throws(() => assertLowImpactNodeRuntime({ execArgv: ['--v8-pool-size=1'], nodeOptions: '', uvThreadpoolSize: '8' }), /UV_THREADPOOL_SIZE=1 or 2/);
});

test('every repository Mineflayer connection is immediately preceded by central admission', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const bot = fs.readFileSync(path.join(root, 'src', 'bot.js'), 'utf8');
  const liveAdmin = fs.readFileSync(path.join(root, 'scripts', 'live-admin-commands.js'), 'utf8');
  const liveRunner = fs.readFileSync(path.join(root, 'scripts', 'run-live-scenario.js'), 'utf8');
  const advisorPlan = fs.readFileSync(path.join(root, 'scripts', 'advisor-live-plan.js'), 'utf8');
  const advisorCase = fs.readFileSync(path.join(root, 'scripts', 'advisor-live-calibration-case.js'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(root, 'scripts', 'resource-lock-bootstrap.js'), 'utf8');
  const launchEnvironment = fs.readFileSync(path.join(root, 'config', 'low-impact-node.env'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const directCreateCall = ['mineflayer', 'createBot('].join('.');
  const directConnections = ['src', 'scripts', 'test']
    .flatMap((directory) => listJavaScriptFiles(path.join(root, directory)))
    .filter((filePath) => fs.readFileSync(filePath, 'utf8').includes(directCreateCall))
    .map((filePath) => path.relative(root, filePath).replaceAll('\\', '/'))
    .sort();
  assert.deepEqual(directConnections, ['src/bot.js']);
  assert.match(bot, /ensureLiveClientResourceAdmissionSync\(\{[\s\S]*?\}\);\s*const bot = mineflayer\.createBot\(mineflayerOptions\)/);
  assert.match(liveAdmin, /ensureLiveClientResourceAdmissionSync\(\{ host, port, purpose: 'rcon-live-admin' \}\);\s*assertNoUncontrolledLocalMinecraftServerSync[\s\S]*?const socket = net\.createConnection/);
  assert.match(liveRunner, /spawn\(process\.execPath, \['--v8-pool-size=1', 'scripts\/live-suite\.js'\]/);
  assert.match(liveRunner, /const nodeRuntime = assertLowImpactNodeRuntime\(\)/);
  assert.match(advisorPlan, /args: \['--v8-pool-size=1', `--max-old-space-size=/);
  assert.match(advisorCase, /args: \['--v8-pool-size=1', 'src\/index\.js'/);
  assert.equal(launchEnvironment.trim(), 'UV_THREADPOOL_SIZE=2');
  assert.match(bootstrap, /if \(!\/\^\[12\]\$\/\.test\(requestedUvThreadpoolSize\)\)/);
  assert.doesNotMatch(bootstrap, /process\.env\.UV_THREADPOOL_SIZE\s*=/,
    'the bootstrap must attest a prelaunch value, not set one after Node initialization');
  for (const name of [
    'start', 'phase0', 'phase1', 'phase2', 'phase3',
    'test:live', 'live:scenario', 'live:admin', 'advisor:live-plan',
    'advisor:live-calibration', 'advisor:live-calibration-case', 'test:live:phase2',
  ]) {
    assert.match(packageJson.scripts[name], /--env-file=\.\/config\/low-impact-node\.env --v8-pool-size=1 --import \.\/scripts\/resource-lock-bootstrap\.js/);
  }
});

function listJavaScriptFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && target.endsWith('.js')) files.push(target);
    }
  }
  return files;
}
