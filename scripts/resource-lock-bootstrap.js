import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { acquireOrJoinResourceLockSync, applyLowImpactNodeScheduling } from './resource-lock.js';

const requestedUvThreadpoolSize = String(process.env.UV_THREADPOOL_SIZE || '').trim();
if (!/^[12]$/.test(requestedUvThreadpoolSize)) {
  throw new Error('resource-lock bootstrap requires launch-time UV_THREADPOOL_SIZE=1 or 2');
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const purpose = 'node-workload-child';
const nodeScheduling = applyLowImpactNodeScheduling();
const lease = acquireOrJoinResourceLockSync({
  repositoryRoot,
  purpose,
  childRole: purpose,
  details: { ...nodeScheduling, serialized: true, uvThreadpoolSize: Number(requestedUvThreadpoolSize), v8PoolSize: 1 },
});

// Retain the lease for the entire Node lifetime. Its exit hook deregisters this
// exact PID/start identity before the process can finish.
globalThis[Symbol.for('mcbot.resourceLockBootstrapLease')] = lease;
