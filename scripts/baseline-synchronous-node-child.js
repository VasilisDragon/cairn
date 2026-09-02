import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function createBaselineSynchronousNodeChildEnvironment(sourceEnv, repositoryRoot) {
  const env = { ...sourceEnv };
  if (sourceEnv.MCBOT_BASELINE !== '1') return env;

  const guardPath = path.join(repositoryRoot, 'scripts', 'baseline-network-guard.cjs');
  const bootstrapPath = path.join(repositoryRoot, 'scripts', 'resource-lock-bootstrap.js');
  const guardOption = `--require=${JSON.stringify(guardPath)}`;
  const bootstrapOption = `--import=${JSON.stringify(pathToFileURL(bootstrapPath).href)}`;
  const expected = `${guardOption} ${bootstrapOption} --v8-pool-size=1`;
  if (sourceEnv.NODE_OPTIONS !== expected) {
    throw new Error('baseline synchronous children require the canonical guarded Node options');
  }

  // The caller must already be a registered, serialized lock child and must
  // synchronously join the child before it can release that lease. Windows
  // inherits its Idle priority and one-core affinity. Preserve the egress guard
  // and V8 cap while avoiding a redundant recursive lock bootstrap.
  env.NODE_OPTIONS = `${guardOption} --v8-pool-size=1`;
  return env;
}
