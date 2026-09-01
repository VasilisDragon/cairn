#!/usr/bin/env node
import { assertNoUncontrolledLocalMinecraftServerSync } from './local-minecraft-server-policy.js';

try {
  const result = assertNoUncontrolledLocalMinecraftServerSync();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
