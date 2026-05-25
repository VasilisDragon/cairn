#!/usr/bin/env node
import process from 'node:process';

import { buildLiveAdminPlan, runLiveAdminPlan } from './live-admin-commands.js';

const plan = buildLiveAdminPlan(process.argv.slice(2));
if (!plan.ok) {
  console.error(plan.reason);
  process.exit(1);
}

try {
  const result = await runLiveAdminPlan(plan);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(err?.message || String(err));
  process.exit(1);
}
