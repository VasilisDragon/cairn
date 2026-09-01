#!/usr/bin/env node
import process from 'node:process';

import {
  acquireOrJoinResourceLockSync,
  inspectResourceLock,
  registerResourceLockChildSync,
  releaseResourceLockByOwnerSync,
  unregisterResourceLockChildSync,
} from './resource-lock.js';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith('--') || index + 1 >= rest.length) throw new Error(`invalid resource-lock argument: ${key}`);
    values[key.slice(2)] = rest[index += 1];
  }
  if (!['acquire', 'register-child', 'deregister-child', 'release', 'observe'].includes(command)) {
    throw new Error('resource-lock command must be acquire, register-child, deregister-child, release, or observe');
  }
  if (!values['repo-root']) throw new Error('--repo-root is required');
  return { command, values };
}

function decodeDetails(encoded) {
  if (!encoded) return {};
  const text = Buffer.from(encoded, 'base64').toString('utf8');
  if (Buffer.byteLength(text) > 8_192) throw new Error('resource-lock details exceed 8192 bytes');
  return JSON.parse(text);
}

function optionalNumber(value, label) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a finite non-negative number`);
  return parsed;
}

function canonicalPositiveInteger(value, label) {
  const text = String(value ?? '');
  const parsed = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(parsed) || String(parsed) !== text) {
    throw new Error(`${label} must be a canonical positive integer`);
  }
  return parsed;
}

try {
  const { command, values } = parseArgs(process.argv.slice(2));
  const common = {
    repositoryRoot: values['repo-root'],
    staleGraceMs: optionalNumber(values['stale-grace-ms'], '--stale-grace-ms'),
  };
  if (command === 'acquire') {
    const ownerPid = canonicalPositiveInteger(values['owner-pid'], '--owner-pid');
    if (ownerPid !== process.ppid) {
      throw new Error('resource-lock CLI owner PID must be its invoking parent process');
    }
    const lease = acquireOrJoinResourceLockSync({
      ...common,
      purpose: values.purpose || 'powershell-live-harness',
      ownerPid,
      ownerExecutable: values['owner-executable'] || 'pwsh.exe',
      waitMs: optionalNumber(values['wait-ms'], '--wait-ms') ?? 0,
      details: decodeDetails(values.details),
      automaticCleanup: false,
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      inherited: lease.inherited,
      lockPath: lease.location.lockPath,
      eventsPath: lease.location.eventsPath,
      repositoryId: lease.location.repositoryId,
      metadata: lease.metadata,
      environment: lease.environment,
      childRegistration: lease.childRegistration ? lease.childRegistration.record.child : null,
    })}\n`);
  } else if (command === 'register-child') {
    const childPid = canonicalPositiveInteger(values['child-pid'], '--child-pid');
    const registration = registerResourceLockChildSync(values['repo-root'], {
      id: values['owner-id'],
      pid: canonicalPositiveInteger(values['owner-pid'], '--owner-pid'),
      processStartIdentity: values['owner-start-identity'],
    }, childPid, {
      ...common,
      requesterPid: process.ppid,
      role: values.role || 'powershell-workload-child',
    });
    process.stdout.write(`${JSON.stringify({ ok: true, child: registration.record.child })}\n`);
  } else if (command === 'deregister-child') {
    unregisterResourceLockChildSync(values['repo-root'], {
      id: values['owner-id'],
      pid: canonicalPositiveInteger(values['owner-pid'], '--owner-pid'),
      processStartIdentity: values['owner-start-identity'],
    }, {
      pid: canonicalPositiveInteger(values['child-pid'], '--child-pid'),
      processStartIdentity: values['child-start-identity'],
    }, { ...common, requesterPid: process.ppid });
    process.stdout.write(`${JSON.stringify({ ok: true, deregistered: true })}\n`);
  } else if (command === 'release') {
    releaseResourceLockByOwnerSync(values['repo-root'], {
      id: values['owner-id'],
      pid: canonicalPositiveInteger(values['owner-pid'], '--owner-pid'),
      processStartIdentity: values['owner-start-identity'],
    }, { ...common, requesterPid: process.ppid });
    process.stdout.write(`${JSON.stringify({ ok: true, released: true })}\n`);
  } else {
    const observation = inspectResourceLock(values['repo-root'], common);
    process.stdout.write(`${JSON.stringify({ ok: true, observation })}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error?.code || 'MCBOT_RESOURCE_LOCK_ERROR',
    message: String(error?.message || error),
    observation: error?.observation || null,
  })}\n`);
  process.exitCode = error?.code === 'MCBOT_RESOURCE_LOCK_BUSY' ? 75 : 1;
}
