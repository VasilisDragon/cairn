import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  acquireOrJoinResourceLockSync,
  applyLowImpactNodeScheduling,
  assertActiveResourceLockLeaseSync,
} from '../../scripts/resource-lock.js';
import { assertNoUncontrolledLocalMinecraftServerSync } from '../../scripts/local-minecraft-server-policy.js';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const RESOURCE_LOCK_LEASE_SYMBOL = Symbol.for('mcbot.resourceLockBootstrapLease');
export const LIVE_CLIENT_ADMISSION_SYMBOL = Symbol.for('mcbot.liveClientResourceAdmission');

function tokenizeNodeOptions(value) {
  const tokens = [];
  let token = '';
  let quote = null;
  for (const character of String(value || '')) {
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = '';
    } else {
      token += character;
    }
  }
  if (quote) throw new Error('NODE_OPTIONS contains an unterminated quote; refusing live client launch');
  if (token) tokens.push(token);
  return tokens;
}

export function assertLowImpactNodeRuntime(options = {}) {
  const groups = [
    { source: 'NODE_OPTIONS', tokens: tokenizeNodeOptions(options.nodeOptions ?? process.env.NODE_OPTIONS) },
    { source: 'execArgv', tokens: [...(options.execArgv || process.execArgv)] },
  ];
  const declarations = [];
  for (const group of groups) {
    for (let index = 0; index < group.tokens.length; index += 1) {
      const token = String(group.tokens[index]);
      const match = /^--v8[-_]pool[-_]size(?:=(.*))?$/i.exec(token);
      if (!match) continue;
      const value = match[1] === undefined ? String(group.tokens[++index] ?? '') : match[1];
      declarations.push({ source: group.source, value });
    }
  }
  if (declarations.length === 0 || declarations.some(({ value }) => value !== '1')) {
    throw new Error('live client requires an unambiguous --v8-pool-size=1 launch-time cap');
  }
  const uvThreadpoolSizeText = String(options.uvThreadpoolSize ?? process.env.UV_THREADPOOL_SIZE ?? '');
  if (!/^[12]$/.test(uvThreadpoolSizeText)) {
    throw new Error('live client requires UV_THREADPOOL_SIZE=1 or 2 at process launch');
  }
  return Object.freeze({
    v8PoolSize: 1,
    uvThreadpoolSize: Number(uvThreadpoolSizeText),
    sources: Object.freeze([...new Set(declarations.map(({ source }) => source))]),
  });
}

export function ensureLiveClientResourceAdmissionSync(options = {}) {
  const repositoryRoot = options.repositoryRoot || REPOSITORY_ROOT;
  const globalObject = options.globalObject || globalThis;
  const port = Number(options.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('live client requires a valid Minecraft port');
  }

  const runtime = (options.assertRuntime || assertLowImpactNodeRuntime)(options.runtimeOptions);
  const scheduling = (options.applyScheduling || applyLowImpactNodeScheduling)();
  let lease = globalObject[RESOURCE_LOCK_LEASE_SYMBOL];
  let acquiredHere = false;
  if (!lease) {
    lease = (options.acquireLease || acquireOrJoinResourceLockSync)({
      repositoryRoot,
      purpose: options.purpose || 'mineflayer-live-client',
      childRole: options.purpose || 'mineflayer-live-client',
      details: {
        ...scheduling,
        liveClientProfile: 'phase1_remote_only',
        serialized: true,
        uvThreadpoolSize: runtime.uvThreadpoolSize,
        v8PoolSize: runtime.v8PoolSize,
      },
    });
    globalObject[RESOURCE_LOCK_LEASE_SYMBOL] = lease;
    acquiredHere = true;
  }

  try {
    const lock = (options.assertLease || assertActiveResourceLockLeaseSync)(repositoryRoot, lease);
    const endpoint = (options.assertEndpoint || assertNoUncontrolledLocalMinecraftServerSync)({
      host: options.host,
      ports: [port],
      denyLocalEndpoint: true,
    });
    const receipt = Object.freeze({
      protocol: 'mcbot.live-client-resource-admission.v1',
      repositoryId: lock.repositoryId,
      ownerId: lock.ownerId,
      ownerPid: lock.ownerPid,
      processPid: lock.processPid,
      inherited: lock.inherited,
      schedulingPriority: scheduling.schedulingPriority,
      v8PoolSize: runtime.v8PoolSize,
      uvThreadpoolSize: runtime.uvThreadpoolSize,
      endpointPolicy: endpoint.policy,
      endpointState: endpoint.state,
      port,
    });
    globalObject[LIVE_CLIENT_ADMISSION_SYMBOL] = receipt;
    return { lease, receipt };
  } catch (error) {
    if (acquiredHere) {
      try {
        lease.releaseSync();
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'live-client admission and resource-lock rollback both failed');
      } finally {
        if (globalObject[RESOURCE_LOCK_LEASE_SYMBOL] === lease) {
          delete globalObject[RESOURCE_LOCK_LEASE_SYMBOL];
        }
      }
    }
    throw error;
  }
}
