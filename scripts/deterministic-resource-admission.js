import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  acquireOrJoinResourceLockSync,
  applyLowImpactNodeScheduling,
  assertActiveResourceLockLeaseSync,
} from './resource-lock.js';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCE_LOCK_BOOTSTRAP_URL = pathToFileURL(path.join(
  REPOSITORY_ROOT,
  'scripts',
  'resource-lock-bootstrap.js',
)).href;

export const DETERMINISTIC_RESOURCE_LEASE_SYMBOL = Symbol.for('mcbot.resourceLockBootstrapLease');

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
  if (quote) throw new Error('NODE_OPTIONS contains an unterminated quote; refusing deterministic evaluation');
  if (token) tokens.push(token);
  return tokens;
}

export function assertDeterministicLowImpactNodeRuntime(options = {}) {
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
    throw new Error('deterministic evaluation requires an unambiguous --v8-pool-size=1 launch-time cap');
  }
  const uvThreadpoolSizeText = String(options.uvThreadpoolSize ?? process.env.UV_THREADPOOL_SIZE ?? '');
  if (!/^[12]$/.test(uvThreadpoolSizeText)) {
    throw new Error('deterministic evaluation requires UV_THREADPOOL_SIZE=1 or 2 at process launch');
  }
  return Object.freeze({
    v8PoolSize: 1,
    uvThreadpoolSize: Number(uvThreadpoolSizeText),
    sources: Object.freeze([...new Set(declarations.map(({ source }) => source))]),
  });
}

export function ensureDeterministicResourceAdmissionSync(options = {}) {
  const repositoryRoot = options.repositoryRoot || REPOSITORY_ROOT;
  const globalObject = options.globalObject || globalThis;
  const runtime = (options.assertRuntime || assertDeterministicLowImpactNodeRuntime)(options.runtimeOptions);
  const scheduling = (options.applyScheduling || applyLowImpactNodeScheduling)();
  let lease = globalObject[DETERMINISTIC_RESOURCE_LEASE_SYMBOL];
  let acquiredHere = false;
  if (!lease) {
    lease = (options.acquireLease || acquireOrJoinResourceLockSync)({
      repositoryRoot,
      purpose: 'deterministic-evaluation',
      childRole: 'deterministic-evaluation',
      details: {
        ...scheduling,
        serialized: true,
        uvThreadpoolSize: runtime.uvThreadpoolSize,
        v8PoolSize: runtime.v8PoolSize,
      },
    });
    globalObject[DETERMINISTIC_RESOURCE_LEASE_SYMBOL] = lease;
    acquiredHere = true;
  }

  try {
    const lock = (options.assertLease || assertActiveResourceLockLeaseSync)(repositoryRoot, lease);
    return Object.freeze({
      lease,
      acquiredHere,
      runtime,
      scheduling,
      receipt: Object.freeze({
        protocol: 'mcbot.deterministic-resource-admission.v1',
        repositoryId: lock.repositoryId,
        ownerId: lock.ownerId,
        ownerPid: lock.ownerPid,
        processPid: lock.processPid,
        inherited: lock.inherited,
        schedulingPriority: scheduling.schedulingPriority,
        processorAffinity: scheduling.processorAffinity,
        v8PoolSize: runtime.v8PoolSize,
        uvThreadpoolSize: runtime.uvThreadpoolSize,
      }),
    });
  } catch (error) {
    if (acquiredHere) {
      try {
        lease.releaseSync();
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          'deterministic resource admission and resource-lock rollback both failed',
        );
      } finally {
        if (globalObject[DETERMINISTIC_RESOURCE_LEASE_SYMBOL] === lease) {
          delete globalObject[DETERMINISTIC_RESOURCE_LEASE_SYMBOL];
        }
      }
    }
    throw error;
  }
}

export function controlledDeterministicNodeLaunch(args, admission, sourceEnvironment = process.env) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('controlled deterministic Node arguments must be strings');
  }
  if (!admission?.lease?.environment || admission.runtime?.v8PoolSize !== 1
      || ![1, 2].includes(admission.runtime?.uvThreadpoolSize)) {
    throw new Error('controlled deterministic Node launch requires a valid resource admission');
  }
  const inheritedOptions = String(sourceEnvironment.NODE_OPTIONS || '').trim();
  const canonicalOptions = [
    `--import=${JSON.stringify(RESOURCE_LOCK_BOOTSTRAP_URL)}`,
    '--v8-pool-size=1',
  ].join(' ');
  return Object.freeze({
    args: Object.freeze([
      '--v8-pool-size=1',
      '--import',
      RESOURCE_LOCK_BOOTSTRAP_URL,
      ...args,
    ]),
    env: Object.freeze({
      ...sourceEnvironment,
      ...admission.lease.environment,
      UV_THREADPOOL_SIZE: String(admission.runtime.uvThreadpoolSize),
      NODE_OPTIONS: inheritedOptions ? `${inheritedOptions} ${canonicalOptions}` : canonicalOptions,
    }),
  });
}

export function releaseDeterministicResourceAdmissionSync(admission, options = {}) {
  if (!admission?.lease || typeof admission.lease.releaseSync !== 'function') {
    throw new TypeError('deterministic resource admission is invalid');
  }
  const globalObject = options.globalObject || globalThis;
  const released = admission.lease.releaseSync();
  if (globalObject[DETERMINISTIC_RESOURCE_LEASE_SYMBOL] === admission.lease) {
    delete globalObject[DETERMINISTIC_RESOURCE_LEASE_SYMBOL];
  }
  return released;
}
