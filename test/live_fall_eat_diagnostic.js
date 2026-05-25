// Manual live diagnostic for the fall-while-eating recovery path.
//
// Run only on a local/private server:
//   $env:MCBOT_LIVE_TESTS='1'
//   $env:MCBOT_LIVE_SCENARIO='fall_eat_manual'
//   npm run test:live:phase2
//
// After spawn, make the bot start eating and step off a safe short ledge.
// The script exits successfully only after the reactive log stream proves:
// fall hazard detected -> HAZARD -> auto-eat suppressed -> NORMAL -> resumed.

import createBot from '../src/bot.js';
import ReactiveController from '../src/reactive/reactive.js';
import buildSnapshot from '../src/state/snapshot.js';
import log from '../src/logger.js';

const EXPECTED_EVENTS = Object.freeze([
  'hazard.detected',
  'state.transition NORMAL->HAZARD',
  'autoeat.suppressed',
  'state.transition HAZARD->NORMAL',
  'autoeat.resumed',
]);

const parsedTimeout = Number.parseInt(process.env.MCBOT_LIVE_DIAGNOSTIC_TIMEOUT_MS || '', 10);
const DIAGNOSTIC_TIMEOUT_MS = Number.isFinite(parsedTimeout) && parsedTimeout > 0
  ? parsedTimeout
  : 180000;

const bot = createBot();
const seen = {
  fallHazard: false,
  hazardState: false,
  suppressed: false,
  normalState: false,
  resumed: false,
};

let spawnWatchdog = null;
let diagnosticWatchdog = null;
let snapshotInterval = null;
let finishing = false;

function compactSeen() {
  return { ...seen };
}

function stopSoon(code, reason) {
  if (finishing) return;
  finishing = true;
  if (spawnWatchdog) clearTimeout(spawnWatchdog);
  if (diagnosticWatchdog) clearTimeout(diagnosticWatchdog);
  if (snapshotInterval) clearInterval(snapshotInterval);
  setTimeout(() => {
    try { bot.quit(reason); } catch {}
    process.exit(code);
  }, 500);
}

function maybeDone() {
  if (!seen.fallHazard || !seen.hazardState || !seen.suppressed || !seen.normalState || !seen.resumed) return;
  log.test.info('fall_eat.done', {
    seen: compactSeen(),
    msg: 'fall/eat hazard recovered and auto-eat resumed after NORMAL',
  });
  stopSoon(0, 'fall_eat done');
}

function trackingLogger(base) {
  const wrapped = {};
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    wrapped[level] = (evt, fields = {}) => {
      base[level](evt, fields);
      if (evt === 'hazard.detected' && fields.kind === 'fall') {
        seen.fallHazard = true;
      } else if (evt === 'state.transition' && fields.from === 'NORMAL' && fields.to === 'HAZARD') {
        seen.hazardState = true;
      } else if (evt === 'autoeat.suppressed') {
        seen.suppressed = true;
      } else if (evt === 'state.transition' && fields.from === 'HAZARD' && fields.to === 'NORMAL') {
        seen.normalState = true;
      } else if (evt === 'autoeat.resumed') {
        seen.resumed = true;
      }
      maybeDone();
    };
  }
  return wrapped;
}

spawnWatchdog = setTimeout(() => {
  log.test.error('fall_eat.spawn-timeout', { ms: 30000 });
  stopSoon(1, 'fall_eat spawn timeout');
}, 30000);

bot.once('spawn', () => {
  clearTimeout(spawnWatchdog);
  spawnWatchdog = null;
  log.test.info('fall_eat.spawned', {
    timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
    expectedEvents: EXPECTED_EVENTS,
    manualSetup: 'start an auto-eat cycle, then make the bot fall from a safe local/private ledge and land',
  });

  const controller = new ReactiveController(bot);
  controller.log = trackingLogger(controller.log);

  snapshotInterval = setInterval(() => {
    log.test.info('fall_eat.snapshot', {
      reactiveState: controller.state,
      seen: compactSeen(),
      snapshot: buildSnapshot(bot),
    });
  }, 5000);

  diagnosticWatchdog = setTimeout(() => {
    log.test.error('fall_eat.timeout', {
      ms: DIAGNOSTIC_TIMEOUT_MS,
      seen: compactSeen(),
      expectedEvents: EXPECTED_EVENTS,
    });
    stopSoon(4, 'fall_eat timeout');
  }, DIAGNOSTIC_TIMEOUT_MS);
});

bot.on('death', () => {
  log.test.error('fall_eat.death', { seen: compactSeen(), snapshot: buildSnapshot(bot) });
  stopSoon(5, 'fall_eat death');
});
bot.on('error', (err) => log.test.error('fall_eat.error', { err: err?.message || String(err) }));
bot.on('kicked', (reason) => log.test.error('fall_eat.kicked', { reason }));
