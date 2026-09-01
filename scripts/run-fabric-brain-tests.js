#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { acquireOrJoinResourceLockSync, applyLowImpactNodeScheduling } from './resource-lock.js';
import { assertNoUncontrolledLocalMinecraftServerSync } from './local-minecraft-server-policy.js';

const ROOT = process.cwd();
const BRAIN_DIR = path.join(ROOT, 'fabric-client', 'brain');
const RESOURCE_LOCK_BOOTSTRAP_URL = pathToFileURL(
  path.join(ROOT, 'scripts', 'resource-lock-bootstrap.js'),
).href;

let nodeScheduling;
try {
  nodeScheduling = applyLowImpactNodeScheduling();
} catch (error) {
  process.stderr.write(`run-fabric-brain-tests: unable to lower process priority: ${error.message}\n`);
  process.exit(1);
}

const files = fs.readdirSync(BRAIN_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join(BRAIN_DIR, name));

if (files.length === 0) {
  process.stderr.write('run-fabric-brain-tests: no Fabric brain tests found\n');
  process.exit(1);
}

let resourceLease;
try {
  const localServerPolicy = assertNoUncontrolledLocalMinecraftServerSync();
  resourceLease = globalThis[Symbol.for('mcbot.resourceLockBootstrapLease')]
    || acquireOrJoinResourceLockSync({
      repositoryRoot: ROOT,
      purpose: 'fabric-brain-tests',
      details: {
        schedulingPriority: nodeScheduling.schedulingPriority,
        localMinecraftServerPolicy: localServerPolicy.policy,
        testConcurrency: 1,
        v8PoolSize: 1,
        uvThreadpoolSize: 2,
      },
    });
} catch (error) {
  process.stderr.write(`run-fabric-brain-tests: ${error.message}\n`);
  process.exit(1);
}

const childEnv = {
  ...process.env,
  ...resourceLease.environment,
  UV_THREADPOOL_SIZE: '2',
};

try {
  let failed = false;
  for (const file of files) {
    // The loop provides one-process-per-file isolation. `node --test` would add
    // an unregistered coordinator between this lock owner and each worker.
    const result = spawnSync(process.execPath, [
      '--v8-pool-size=1',
      '--import',
      RESOURCE_LOCK_BOOTSTRAP_URL,
      '--test-reporter=tap',
      file,
    ], {
      cwd: ROOT,
      env: childEnv,
      stdio: 'inherit',
    });
    if ((result.status ?? 1) !== 0) {
      failed = true;
      break;
    }
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  if (resourceLease) resourceLease.releaseSync();
}
