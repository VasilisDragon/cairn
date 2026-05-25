// Main entry. Connects, brings up the reactive layer + executor, and if a goal
// is provided on the command line, runs the advisor on it.
//
// Usage:
//   npm start                        -> connect, run reactive only, log snapshots
//   $env:MCBOT_ALLOW_DEEPSEEK='1'; npm start -- "gather 10 oak logs"
//                                    -> connect, run reactive + advisor on that goal

import {
  deepseekAdvisorRunGate,
  formatDeepseekAdvisorRunGate,
} from './advisor/deepseek_run_gate.js';

const GOAL = process.argv.slice(2).join(' ').trim();

if (GOAL) {
  const gate = deepseekAdvisorRunGate(process.env, { entrypoint: 'main' });
  if (!gate.ok) {
    console.error(formatDeepseekAdvisorRunGate(gate));
    process.exit(1);
  }
}

const [
  { default: createBot },
  { default: ReactiveController },
  { SkillExecutor },
  { createRuntimeContext },
  { createGracefulShutdown },
  { installMainSpawnHandler, installProcessHandler },
  { installIdleHumanization },
  { installUserControlCommands },
  { default: buildSnapshot },
  { default: config },
  { default: log },
] = await Promise.all([
  import('./bot.js'),
  import('./reactive/reactive.js'),
  import('./executor/queue.js'),
  import('./runtime/context.js'),
  import('./runtime/shutdown.js'),
  import('./runtime/startup.js'),
  import('./runtime/idle_humanization.js'),
  import('./runtime/user_control.js'),
  import('./state/snapshot.js'),
  import('./config.js'),
  import('./logger.js'),
]);

let AdvisorAgent = null;
let advisorAgentOptions = null;
if (GOAL) {
  [
    { AdvisorAgent },
    { advisorAgentOptions },
  ] = await Promise.all([
    import('./advisor/agent.js'),
    import('./advisor/runtime_options.js'),
  ]);
}

const bot = createBot();
let executor = null;
const shutdown = createGracefulShutdown({ bot, getExecutor: () => executor });

installUserControlCommands(bot, {
  authorizedUsers: config.control?.authorizedUsers,
  logoutCommand: config.control?.logoutCommand,
  shutdown,
});

installMainSpawnHandler(bot, async () => {
  log.startup.info('main.spawned', { goal: GOAL || '(none — reactive-only)' });

  new ReactiveController(bot);
  const runtimeContext = createRuntimeContext();
  executor = new SkillExecutor(bot, { context: runtimeContext });

  // Always emit a startup snapshot.
  setTimeout(() => {
    const snap = buildSnapshot(bot, runtimeContext);
    log.bot.info('snapshot', snap);
  }, 1500);

  const startupDelayMs = positiveInteger(process.env.MCBOT_STARTUP_DELAY_MS);
  if (startupDelayMs > 0) {
    log.startup.info('main.startup-delay', { ms: startupDelayMs });
    await sleep(startupDelayMs);
  }

  if (!GOAL) {
    installIdleHumanization(bot, { logger: log.bot });
    // Idle mode: just observe periodically.
    setInterval(() => {
      const snap = buildSnapshot(bot, runtimeContext);
      log.bot.info('snapshot', snap);
    }, 10000);
    return;
  }

  const agent = new AdvisorAgent(bot, executor, advisorAgentOptions(runtimeContext, { maxReplans: 6 }));
  try {
    const result = await agent.pursue(GOAL);
    if (result.ok) {
      log.startup.info('main.goal-done', result);
    } else {
      log.startup.error('main.goal-failed', result);
    }
  } catch (err) {
    log.startup.fatal('main.exception', { err: err.message, stack: err.stack });
  }
});

installProcessHandler(process, 'SIGINT', () => shutdown('SIGINT'));
installProcessHandler(process, 'SIGTERM', () => shutdown('SIGTERM'));
installProcessHandler(process, 'uncaughtException', (err) => {
  log.startup.fatal('uncaughtException', { err: err.message, stack: err.stack });
  shutdown('uncaughtException');
});
installProcessHandler(process, 'unhandledRejection', (err) => {
  log.startup.fatal('unhandledRejection', { err: err?.message || String(err), stack: err?.stack });
});

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
