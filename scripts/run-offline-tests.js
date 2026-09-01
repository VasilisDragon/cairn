#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  captureDirectoryState,
  restoreDirectoryState,
} from './report-preservation.js';
import { acquireOrJoinResourceLockSync, applyLowImpactNodeScheduling } from './resource-lock.js';
import { assertNoUncontrolledLocalMinecraftServerSync } from './local-minecraft-server-policy.js';

const ROOT = process.cwd();
const TEST_DIR = path.join(ROOT, 'test', 'offline');
const REPORT_DIR = path.join(ROOT, 'reports');
const RESOURCE_LOCK_BOOTSTRAP = path.join(ROOT, 'scripts', 'resource-lock-bootstrap.js');
const RESOURCE_LOCK_BOOTSTRAP_URL = pathToFileURL(RESOURCE_LOCK_BOOTSTRAP).href;

let nodeScheduling;
try {
  // Unit tests are intentionally serialized and run at the OS's lowest
  // scheduling priority so they do not contend with latency-sensitive apps.
  nodeScheduling = applyLowImpactNodeScheduling();
} catch (error) {
  process.stderr.write(`run-offline-tests: unable to lower process priority: ${error.message}\n`);
  process.exit(1);
}

const files = fs.readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(TEST_DIR, name));

if (files.length === 0) {
  process.stderr.write('No offline unit tests found in test/offline\n');
  process.exit(1);
}

let resourceLease;
try {
  const localServerPolicy = assertNoUncontrolledLocalMinecraftServerSync();
  resourceLease = globalThis[Symbol.for('mcbot.resourceLockBootstrapLease')]
    || acquireOrJoinResourceLockSync({
    repositoryRoot: ROOT,
    purpose: 'root-offline-tests',
    details: {
      schedulingPriority: nodeScheduling.schedulingPriority,
      localMinecraftServerPolicy: localServerPolicy.policy,
      testConcurrency: 1,
      v8PoolSize: 1,
      uvThreadpoolSize: 2,
    },
    });
} catch (error) {
  process.stderr.write(`run-offline-tests: ${error.message}\n`);
  process.exit(1);
}

const childEnv = {
  ...process.env,
  ...resourceLease.environment,
  UV_THREADPOOL_SIZE: '2',
};

try {
  const reportState = captureDirectoryState(REPORT_DIR);
  let failed = false;
  for (const file of files) {
    // The outer loop already provides one-process-per-file isolation. Invoking
    // `node --test` here would add an unregistered test-runner coordinator
    // between this lock owner and the bootstrapped worker, so execute the test
    // file directly and keep the reporter explicit instead.
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

  try {
    restoreDirectoryState(reportState);
  } catch (err) {
    process.stderr.write(`run-offline-tests: failed to restore reports directory after tests: ${err.message}\n`);
    failed = true;
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  if (resourceLease) resourceLease.releaseSync();
}
