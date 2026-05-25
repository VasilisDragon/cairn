// Phase 1 checkpoint: bot connects, the reactive FSM runs, and the bot
// reacts to hunger / hostiles / hazards with zero LLM involvement.
//
// Run with: npm run phase1
//
// What to observe in the logs:
//   - reactive.init line on startup
//   - state.transition NORMAL -> FLEEING when a hostile gets within range
//   - autoeat.start / autoeat.finish lines when hunger drops below threshold
//   - hazard.detected lines if you walk the bot near lava / a cliff
//   - emergency.logout if you hurt the bot down to critical health
//
// We can't drive game state from this script — open the world to LAN and create
// the scenarios manually (e.g. /summon zombie ~ ~ ~ near the bot).

import createBot from '../src/bot.js';
import ReactiveController from '../src/reactive/reactive.js';
import buildSnapshot from '../src/state/snapshot.js';
import log from '../src/logger.js';

const bot = createBot();

bot.once('spawn', () => {
  log.test.info('phase1.spawned');
  // Reactive controller installs all its listeners on construction.
  new ReactiveController(bot);

  // Periodic snapshot so we can correlate state with surroundings.
  const interval = setInterval(() => {
    const snap = buildSnapshot(bot);
    log.test.info('phase1.snapshot', snap);
  }, 5000);

  bot.on('end', () => { clearInterval(interval); process.exit(0); });
});

setTimeout(() => {
  log.test.error('phase1.timeout', { msg: 'no spawn after 30s — failing' });
  process.exit(1);
}, 30000);

bot.on('error', (err) => log.test.error('phase1.error', { err: err?.message || String(err) }));
bot.on('kicked', (reason) => log.test.error('phase1.kicked', { reason }));
