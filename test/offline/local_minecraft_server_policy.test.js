import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assertNoUncontrolledLocalMinecraftServerSync,
  inspectLocalMinecraftListenersSync,
} from '../../scripts/local-minecraft-server-policy.js';

test('Phase-1 local-server admission permits only a proven empty listener set', () => {
  assert.deepEqual(assertNoUncontrolledLocalMinecraftServerSync({
    inspectListeners: () => ({ state: 'clear' }),
  }), {
    applied: true,
    state: 'clear',
    policy: 'phase1_no_local_server',
  });
  assert.deepEqual(assertNoUncontrolledLocalMinecraftServerSync({ host: '192.0.2.25' }), {
    applied: true,
    state: 'remote',
    policy: 'phase1_remote_server_only',
  });
  assert.throws(() => assertNoUncontrolledLocalMinecraftServerSync({
    host: '127.0.0.1',
    denyLocalEndpoint: true,
    inspectListeners: () => { throw new Error('must not inspect after categorical local denial'); },
  }), /local Minecraft\/RCON endpoint 127\.0\.0\.1 is disabled/);
  assert.throws(() => assertNoUncontrolledLocalMinecraftServerSync({
    host: 'localhost.',
    denyLocalEndpoint: true,
    inspectListeners: () => { throw new Error('must not inspect an unverified hostname'); },
  }), /require a validated non-local IP literal/);
  assert.throws(() => assertNoUncontrolledLocalMinecraftServerSync({
    host: 'minecraft.private.example',
    denyLocalEndpoint: true,
  }), /require a validated non-local IP literal/);
  assert.throws(() => assertNoUncontrolledLocalMinecraftServerSync({
    host: '[::ffff:127.0.0.1]',
    denyLocalEndpoint: true,
  }), /local Minecraft\/RCON endpoint ::ffff:127\.0\.0\.1 is disabled/);
  assert.throws(() => assertNoUncontrolledLocalMinecraftServerSync({
    host: '192.0.2.44',
    denyLocalEndpoint: true,
    networkInterfaces: () => ({ ethernet: [{ address: '192.0.2.44' }] }),
  }), /local Minecraft\/RCON endpoint 192\.0\.2\.44 is disabled/);
  assert.throws(() => assertNoUncontrolledLocalMinecraftServerSync({
    host: '[::ffff:192.0.2.44]',
    denyLocalEndpoint: true,
    networkInterfaces: () => ({ ethernet: [{ address: '192.0.2.44' }] }),
  }), /local Minecraft\/RCON endpoint ::ffff:192\.0\.2\.44 is disabled/);
  assert.deepEqual(assertNoUncontrolledLocalMinecraftServerSync({
    host: '192.0.2.45',
    denyLocalEndpoint: true,
    networkInterfaces: () => ({ ethernet: [{ address: '192.0.2.44' }] }),
  }), {
    applied: true,
    state: 'remote',
    policy: 'phase1_remote_server_only',
  });
  assert.deepEqual(assertNoUncontrolledLocalMinecraftServerSync({
    host: '::ffff:192.0.2.45',
    denyLocalEndpoint: true,
    networkInterfaces: () => ({ ethernet: [{ address: '192.0.2.44' }] }),
  }), {
    applied: true,
    state: 'remote',
    policy: 'phase1_remote_server_only',
  });
  assert.throws(() => assertNoUncontrolledLocalMinecraftServerSync({
    inspectListeners: () => ({
      state: 'occupied',
      listeners: [{ pid: 4242, processStartIdentity: 'windows-start-ticks:100', ports: [25565, 25575] }],
    }),
  }), /outside Phase-1 resource control \(pid=4242 ports=25565,25575\)/);
  assert.throws(() => assertNoUncontrolledLocalMinecraftServerSync({
    inspectListeners: () => ({ state: 'unverifiable', reason: 'injected' }),
  }), /unable to prove.*injected/);
});

test('Windows listener inspection proves double-empty state before exact PID/start fallback', () => {
  let command = '';
  const observation = inspectLocalMinecraftListenersSync({
    platform: 'win32',
    ports: [25576],
    spawnSync: (_executable, args) => {
      command = args.at(-1);
      return {
        status: 0,
        stdout: JSON.stringify({
          state: 'occupied',
          listeners: [{
            pid: 5151,
            processStartIdentity: 'windows-start-ticks:638900000000000000',
            ports: [25576],
          }],
        }),
      };
    },
  });
  assert.equal(observation.state, 'occupied');
  assert.deepEqual(observation.listeners, [{
    pid: 5151,
    processStartIdentity: 'windows-start-ticks:638900000000000000',
    ports: [25576],
  }]);
  assert.match(command, /CreationDate\.ToUniversalTime\(\)\.Ticks - \$startTicks\) -gt 10000/);
  assert.match(command, /\$processAgain\.StartTime\.ToUniversalTime\(\)\.Ticks -ne \$startTicks/);
  assert.match(command, /\$firstFingerprint -ceq \$secondFingerprint/);
  assert.match(command, /GetActiveTcpListeners\(\)/);
  assert.match(command, /\$managedFirst\.Count -eq 0 -and \$managedSecond\.Count -eq 0/);
  assert.ok(command.indexOf('GetActiveTcpListeners()') < command.indexOf('Get-NetTCPConnection'));
  assert.match(command, /\$emptyConfirmation = @\(Get-NetTCPConnection/);
  assert.match(command, /if \(\$emptyConfirmation\.Count -eq 0\)/);
  assert.doesNotMatch(command, /\$emptyConfirmation\.Count -eq 0\) \{\s*\[Console\]::Out\.Write/);
  assert.doesNotMatch(JSON.stringify(observation), /CommandLine/i);
});

test('Windows listener inspection retries only an indeterminate helper timeout', () => {
  let attempts = 0;
  const observation = inspectLocalMinecraftListenersSync({
    platform: 'win32',
    spawnSync: () => {
      attempts += 1;
      if (attempts === 1) return { status: null, stdout: '', error: { code: 'ETIMEDOUT' } };
      return { status: 0, stdout: JSON.stringify({ state: 'clear', listeners: [] }) };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(observation.state, 'clear');

  attempts = 0;
  const denied = inspectLocalMinecraftListenersSync({
    platform: 'win32',
    spawnSync: () => {
      attempts += 1;
      return { status: 3, stdout: '', stderr: 'identity changed' };
    },
  });
  assert.equal(attempts, 1);
  assert.deepEqual(denied, {
    state: 'unverifiable',
    reason: 'local_minecraft_listener_inspection_failed',
  });
});

test('Linux listener inspection double-samples proc tables and fails closed', () => {
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  const clear = `${header}\n`;
  const occupied = `${header}\n   0: 00000000:63DD 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 45678 1 0000000000000000 100 0 0 10 0`;
  const common = {
    platform: 'linux',
    linuxTcpTables: ['tcp', 'tcp6'],
    sleepSync: () => {},
  };

  assert.deepEqual(inspectLocalMinecraftListenersSync({
    ...common,
    readFileSync: () => clear,
  }), {
    state: 'clear',
    ports: [25565, 25575],
  });

  const observation = inspectLocalMinecraftListenersSync({
    ...common,
    readFileSync: (table) => (table === 'tcp' ? occupied : clear),
  });
  assert.deepEqual(observation, {
    state: 'occupied',
    ports: [25565, 25575],
    listeners: [{
      processStartIdentity: 'linux-socket-inode:45678',
      ports: [25565],
    }],
  });
  assert.throws(() => assertNoUncontrolledLocalMinecraftServerSync({
    inspectListeners: () => observation,
  }), /outside Phase-1 resource control \(linux-socket-inode:45678 ports=25565\)/);

  assert.deepEqual(inspectLocalMinecraftListenersSync({
    ...common,
    readFileSync: () => 'not a proc table',
  }), {
    state: 'unverifiable',
    reason: 'local_minecraft_linux_listener_inspection_failed',
  });

  let readCount = 0;
  assert.deepEqual(inspectLocalMinecraftListenersSync({
    ...common,
    readFileSync: (table) => {
      const snapshotIndex = Math.floor(readCount / 2);
      readCount += 1;
      return table === 'tcp' && snapshotIndex % 2 === 1 ? occupied : clear;
    },
  }), {
    state: 'unverifiable',
    reason: 'local_minecraft_linux_listener_identity_changed',
  });
});

test('every direct heavy launcher fails closed on an uncontrolled local server without targeting it', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const helper = fs.readFileSync(path.join(root, 'scripts', 'local-minecraft-server-policy.js'), 'utf8');
  const powershell = fs.readFileSync(path.join(root, 'scripts', 'resource-lock.ps1'), 'utf8');
  const offline = fs.readFileSync(path.join(root, 'scripts', 'run-offline-tests.js'), 'utf8');
  const live = fs.readFileSync(path.join(root, 'scripts', 'live-suite.js'), 'utf8');
  const plugin = fs.readFileSync(path.join(root, 'scripts', 'run-live-scenario.js'), 'utf8');
  const rcon = fs.readFileSync(path.join(root, 'scripts', 'live-admin-commands.js'), 'utf8');
  const gradle = fs.readFileSync(path.join(root, 'scripts', 'run-gradle-low-impact.ps1'), 'utf8');
  const calibrationCase = fs.readFileSync(path.join(root, 'scripts', 'advisor-live-calibration-case.js'), 'utf8');
  assert.match(powershell, /Assert-McbotNoUncontrolledLocalMinecraftServer/);
  assert.match(powershell, /localMinecraftServerPolicy/);
  for (const source of [offline, live, plugin]) {
    assert.match(source, /assertNoUncontrolledLocalMinecraftServerSync\(\)/);
  }
  assert.match(rcon, /assertNoUncontrolledLocalMinecraftServerSync\(\{ host, ports: \[port\], denyLocalEndpoint: true \}\)/);
  assert.match(live,
    /assertNoUncontrolledLocalMinecraftServerSync\(\{\s*host: config\.minecraft\.host,\s*ports: \[config\.minecraft\.port\],\s*denyLocalEndpoint: true,\s*\}\);[\s\S]*?holdLeaseForProcessLifetime = true;\s*await import\(scenario\.entrypoint\)/,
    'live suite must categorically reject a local endpoint immediately before importing its live connector');
  assert.match(gradle, /Assert-McbotNoUncontrolledLocalMinecraftServer\)\s*\r?\n\s*\$workload = Start-McbotRegisteredWorkloadProcess/);
  assert.match(calibrationCase, /assertNoUncontrolledLocalMinecraftServerSync\(\{\s*host: config\.minecraft\.host,[\s\S]*?denyLocalEndpoint: true,/);
  assert.ok(calibrationCase.indexOf('dryRun') < calibrationCase.lastIndexOf('assertNoUncontrolledLocalMinecraftServerSync({'));
  assert.doesNotMatch(helper, /Stop-Process|taskkill|\.Kill\(/i);
  assert.doesNotMatch(helper, /RuneLite/i);
});
