// Phase 0 checkpoint: bot joins LAN world and prints a valid world-state snapshot.
// Run with: npm run phase0  (after copying config.example.json -> config.json and
// adjusting host/port for your LAN world).

import createBot from '../src/bot.js';
import buildSnapshot from '../src/state/snapshot.js';
import log from '../src/logger.js';

const bot = createBot();

let snapshotCount = 0;
const MAX_SNAPSHOTS = 3;

bot.once('spawn', () => {
  log.test.info('phase0.spawned');

  // Print 3 snapshots ~2s apart, then exit. Lets us see how state stabilizes.
  const tick = () => {
    snapshotCount += 1;
    const snap = buildSnapshot(bot);
    log.test.info('phase0.snapshot', { n: snapshotCount, ...snap });
    if (snapshotCount >= MAX_SNAPSHOTS) {
      log.test.info('phase0.done', { msg: 'checkpoint passed — bot joined and emitted snapshots' });
      setTimeout(() => { try { bot.quit('phase0 done'); } catch {} process.exit(0); }, 500);
      return;
    }
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 1500);
});

// Safety net so the script doesn't hang forever if we never spawn.
setTimeout(() => {
  log.test.error('phase0.timeout', { msg: 'no spawn after 30s — failing' });
  process.exit(1);
}, 30000);

bot.on('error', (err) => log.test.error('phase0.error', { err: err?.message || String(err) }));
bot.on('kicked', (reason) => log.test.error('phase0.kicked', { reason }));
bot.on('end', (reason) => log.test.warn('phase0.end', { reason }));
