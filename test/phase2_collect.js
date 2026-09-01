// Phase 2 checkpoint: a hardcoded plan (no LLM) collects 10 oak logs then
// deposits them in the nearest chest, all via skill calls.
//
// Pre-conditions (set up by user in the LAN world):
//   - The bot is reasonably near an oak forest (oak_log within ~64 blocks)
//   - A regular chest exists within ~32 blocks of the bot's expected end position
//
// Run with: npm run phase2

import createBot from '../src/bot.js';
import ReactiveController from '../src/reactive/reactive.js';
import { SkillExecutor } from '../src/executor/queue.js';
import { createRuntimeContext } from '../src/runtime/context.js';
import buildSnapshot from '../src/state/snapshot.js';
import log from '../src/logger.js';

const bot = createBot();

// Spawn-only watchdog: if the bot fails to spawn (connection problem, wrong
// version, etc.) within SPAWN_TIMEOUT_MS, abort. This is the ONLY wall-clock
// watchdog. Once spawn fires it's cleared, and the rest of the run is gated
// on real progress (skill:start / skill:result / skill:preempted events) via
// the stall watchdog set up inside the spawn handler.
const SPAWN_TIMEOUT_MS = 30000;
const spawnWatchdog = setTimeout(() => {
  log.test.error('phase2.spawn-timeout', { ms: SPAWN_TIMEOUT_MS });
  process.exit(1);
}, SPAWN_TIMEOUT_MS);

bot.once('spawn', async () => {
  clearTimeout(spawnWatchdog);
  const spawnT = Date.now();
  log.test.info('phase2.spawned');

  // === DIAGNOSTIC (one-off): does findBlock see oak_log at increasing post-spawn delays?
  // Hypothesis: collect failed ~8ms after spawn because chunks weren't loaded yet.
  // We probe at 0/500/1000/2000/3000ms and log nearest + count. No skill code changed.
  const mcData = bot.registry;
  const oak = mcData?.blocksByName?.oak_log;
  log.test.info('phase2.diag.registry', {
    registryReady: !!mcData,
    blocksByNameCount: mcData ? Object.keys(mcData.blocksByName).length : 0,
    oak_log_id: oak?.id ?? null,
  });
  if (oak) {
    for (const targetMs of [0, 500, 1000, 2000, 3000]) {
      const waitFor = targetMs - (Date.now() - spawnT);
      if (waitFor > 0) await new Promise((r) => setTimeout(r, waitFor));
      const pos = bot.entity?.position;
      const found = bot.findBlocks({ matching: oak.id, maxDistance: 64, count: 100 });
      const nearest = found[0]
        ? {
            x: found[0].x,
            y: found[0].y,
            z: found[0].z,
            dist: pos ? Math.round(pos.distanceTo(found[0]) * 10) / 10 : null,
          }
        : null;
      log.test.info('phase2.diag.findBlocks', {
        targetMs,
        actualDtMs: Date.now() - spawnT,
        botPos: pos ? { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10, z: Math.round(pos.z * 10) / 10 } : null,
        count: found.length,
        nearest,
      });
    }
  }
  // === END DIAGNOSTIC ===

  // Start reactive layer (DO NOT DIE)
  new ReactiveController(bot);

  // Build executor
  const runtimeContext = bot.runtimeContext || createRuntimeContext();
  const executor = new SkillExecutor(bot, { context: runtimeContext });

  // Hardcoded plan — no DeepSeek involved.
  const plan = [
    { skill: 'observe', params: {} },
    { skill: 'collect', params: { block: 'oak_log', count: 10, maxDistance: 64 } },
    { skill: 'deposit', params: { items: [{ name: 'oak_log' }], maxDistance: 32 } },
    { skill: 'observe', params: {} },
  ];

  log.test.info('phase2.plan', { plan });
  executor.enqueue(plan);

  // Stall watchdog: any executor event resets the idle timer. The executor's
  // own per-skill timeout (config.executor.skillTimeoutMs, default 120 s)
  // will always fire skill:result with a timeout error on truly hung skills,
  // which itself resets the idle clock. So this watchdog only fires if even
  // that mechanism is broken — pure defense-in-depth.
  const STALL_TIMEOUT_MS = 180000;
  let lastActivity = Date.now();
  const bump = () => { lastActivity = Date.now(); };
  executor.on('skill:start', bump);
  executor.on('skill:preempted', ({ call, result }) => {
    bump();
    log.test.info('phase2.preempted', { skill: call.skill, reason: result.reason });
  });
  executor.on('skill:result', ({ call, result }) => {
    bump();
    log.test.info('phase2.step', { skill: call.skill, ok: result.ok, reason: result.reason });
  });
  const stallInterval = setInterval(() => {
    const idle = Date.now() - lastActivity;
    if (idle > STALL_TIMEOUT_MS) {
      clearInterval(stallInterval);
      log.test.error('phase2.stall', { idleMs: idle, threshold: STALL_TIMEOUT_MS });
      const snap = buildSnapshot(bot, runtimeContext);
      log.test.info('phase2.stall-snapshot', snap);
      setTimeout(() => { try { bot.quit('phase2 stall'); } catch {} process.exit(3); }, 500);
    }
  }, 5000);

  executor.on('queue:empty', () => {
    clearInterval(stallInterval);
    log.test.info('phase2.done', { msg: 'all skills completed successfully' });
    const snap = buildSnapshot(bot, runtimeContext);
    log.test.info('phase2.final-snapshot', snap);
    setTimeout(() => { try { bot.quit('phase2 done'); } catch {} process.exit(0); }, 500);
  });

  executor.on('queue:failure', ({ call, result }) => {
    clearInterval(stallInterval);
    log.test.error('phase2.failure', { skill: call.skill, reason: result.reason });
    const snap = buildSnapshot(bot, runtimeContext);
    log.test.info('phase2.failure-snapshot', snap);
    setTimeout(() => { try { bot.quit('phase2 failure'); } catch {} process.exit(2); }, 500);
  });

  await executor.runUntilDone();
});

bot.on('error', (err) => log.test.error('phase2.error', { err: err?.message || String(err) }));
bot.on('kicked', (reason) => log.test.error('phase2.kicked', { reason }));
