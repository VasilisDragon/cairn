// ISOLATION DIAGNOSTIC: can bot.collectBlock.collect() break a single oak_log
// to completion when nothing else is touching the bot?
//
// NO ReactiveController, NO SkillExecutor, NO advisor. Just bare mineflayer +
// collectblock + pathfinder, all the standard plugins, against one block.
//
// Pre-conditions:
//   - LAN world on PEACEFUL (no hostiles)
//   - Oak tree adjacent / within ~16 blocks of spawn
//   - Bot has empty hand at start (we're testing bare-hand log breaking)
//
// Run: node test/phase2_isolate_collect.js

import createBot from '../src/bot.js';
import log from '../src/logger.js';

const bot = createBot();

bot.once('spawn', async () => {
  const spawnT = Date.now();
  log.test.info('isolate.spawned');

  // Wait for chunks. Diagnostic showed ~500ms is enough; use 3000 for safety.
  log.test.info('isolate.waiting-for-chunks');
  await new Promise((r) => setTimeout(r, 3000));
  if (typeof bot.waitForChunksToLoad === 'function') {
    try { await bot.waitForChunksToLoad(); } catch (e) { log.test.warn('isolate.waitForChunks-error', { err: e.message }); }
  }
  log.test.info('isolate.chunks-loaded', { dtMs: Date.now() - spawnT });

  const mcData = bot.registry;
  const oak = mcData?.blocksByName?.oak_log;
  if (!oak) {
    log.test.error('isolate.no-oak-in-registry');
    process.exit(2);
  }

  // Find the nearest oak_log. Pick exactly one.
  const positions = bot.findBlocks({ matching: oak.id, maxDistance: 16, count: 10 });
  log.test.info('isolate.scan', { found: positions.length });
  if (positions.length === 0) {
    log.test.error('isolate.no-oak-nearby', { msg: 'place an oak log within 16 blocks of spawn' });
    process.exit(2);
  }
  const targetPos = positions[0];
  const target = bot.blockAt(targetPos);
  const me = bot.entity.position;
  log.test.info('isolate.target', {
    pos: { x: target.position.x, y: target.position.y, z: target.position.z },
    distance: Math.round(me.distanceTo(target.position) * 100) / 100,
    block: target.name,
  });

  // Instrument every relevant bot event so we can see the lifecycle.
  bot.on('diggingCompleted', (block) => {
    log.test.info('isolate.diggingCompleted', { name: block?.name, pos: block?.position, dtMs: Date.now() - spawnT });
  });
  bot.on('diggingAborted', (block) => {
    log.test.warn('isolate.diggingAborted', { name: block?.name, pos: block?.position, dtMs: Date.now() - spawnT });
  });
  bot.on('blockUpdate:' + target.position.toString(), (oldBlock, newBlock) => {
    log.test.info('isolate.targetBlockUpdate', { from: oldBlock?.name, to: newBlock?.name, dtMs: Date.now() - spawnT });
  });
  bot.on('path_update', (r) => {
    log.test.debug('isolate.path_update', { status: r.status, cost: r.cost, time: r.time });
  });
  bot.on('goal_reached', () => {
    log.test.info('isolate.goal_reached', { dtMs: Date.now() - spawnT });
  });
  bot.on('collectBlock_finished', () => {
    log.test.info('isolate.collectBlock_finished', { dtMs: Date.now() - spawnT });
  });
  // Tool / item pickup signal
  bot.on('playerCollect', (collector, collected) => {
    if (collector?.username === bot.username) {
      log.test.info('isolate.playerCollect', { item: collected?.name, dtMs: Date.now() - spawnT });
    }
  });

  // Pre-collect state snapshot (just oak_log count).
  const oakBefore = bot.inventory.items().filter((it) => it.name === 'oak_log').reduce((s, it) => s + it.count, 0);
  log.test.info('isolate.preInventory', { oak_log: oakBefore, heldItem: bot.heldItem?.name || 'empty-hand' });

  // The one call we are isolating. No timeouts wrapping it, no abort, no parallel writers.
  log.test.info('isolate.collect.start', { dtMs: Date.now() - spawnT });
  const t0 = Date.now();
  try {
    await bot.collectBlock.collect(target, { ignoreNoPath: true });
    log.test.info('isolate.collect.resolved', { dtMs: Date.now() - t0 });
  } catch (err) {
    log.test.error('isolate.collect.threw', {
      errName: err?.name,
      errMessage: err?.message,
      stack: err?.stack?.split('\n').slice(0, 4).join('\n'),
      dtMs: Date.now() - t0,
    });
    setTimeout(() => { try { bot.quit('isolate threw'); } catch {} process.exit(3); }, 1000);
    return;
  }

  // Give pickup a moment.
  await new Promise((r) => setTimeout(r, 1500));
  const oakAfter = bot.inventory.items().filter((it) => it.name === 'oak_log').reduce((s, it) => s + it.count, 0);
  const delta = oakAfter - oakBefore;
  log.test.info('isolate.postInventory', { oak_log: oakAfter, delta });

  if (delta >= 1) {
    log.test.info('isolate.PASS', { msg: 'collectBlock broke and collected one oak_log uninterrupted' });
    setTimeout(() => { try { bot.quit('isolate done'); } catch {} process.exit(0); }, 500);
  } else {
    log.test.error('isolate.FAIL', { msg: 'collectBlock.collect() resolved but oak_log count did not increase', oakBefore, oakAfter });
    setTimeout(() => { try { bot.quit('isolate fail'); } catch {} process.exit(1); }, 500);
  }
});

setTimeout(() => {
  log.test.error('isolate.timeout', { msg: 'no spawn after 30s' });
  process.exit(1);
}, 30000);

bot.on('error', (err) => log.test.error('isolate.error', { err: err?.message || String(err) }));
bot.on('kicked', (reason) => log.test.error('isolate.kicked', { reason }));
bot.on('end', (reason) => log.test.warn('isolate.end', { reason }));
