// Phase 3 calibration: DeepSeek decomposes "gather 10 oak logs" into skill calls,
// executes them, and recovers from at least one induced failure.
//
// Pre-conditions (set up by user in the LAN world):
//   - Oak forest reachable within ~128 blocks
//   - A chest within ~32 blocks (optional — only used if the advisor plans a deposit)
//   - DEEPSEEK_API_KEY set in .env or keys.json
//   - MCBOT_ALLOW_DEEPSEEK=1 and MCBOT_LIVE_TESTS=1 set explicitly
//
// Fault injection:
//   - The first 'collect' attempt is faked-failed once, to force a re-plan.
//
// Run with:
//   $env:MCBOT_ALLOW_DEEPSEEK='1'; $env:MCBOT_LIVE_TESTS='1'; npm run phase3

import {
  deepseekAdvisorRunGate,
  formatDeepseekAdvisorRunGate,
} from '../src/advisor/deepseek_run_gate.js';

const GOAL = process.argv.slice(2).join(' ') || 'gather 10 oak logs';
const gate = deepseekAdvisorRunGate(process.env, {
  entrypoint: 'phase3_calibration',
  requiresLiveTests: true,
});

if (!gate.ok) {
  console.error(formatDeepseekAdvisorRunGate(gate));
  process.exit(1);
}

const [
  { default: createBot },
  { default: ReactiveController },
  { SkillExecutor },
  { AdvisorAgent },
  { advisorAgentOptions },
  { SKILL_REGISTRY },
  { createRuntimeContext },
  { default: buildSnapshot },
  { default: log },
] = await Promise.all([
  import('../src/bot.js'),
  import('../src/reactive/reactive.js'),
  import('../src/executor/queue.js'),
  import('../src/advisor/agent.js'),
  import('../src/advisor/runtime_options.js'),
  import('../src/skills/index.js'),
  import('../src/runtime/context.js'),
  import('../src/state/snapshot.js'),
  import('../src/logger.js'),
]);

const bot = createBot();
bot.once('spawn', async () => {
  log.test.info('phase3.spawned', { goal: GOAL });

  new ReactiveController(bot);

  // Fault injector: wrap the first 'collect' call so it fails once, then runs normally.
  let collectFailsRemaining = 1;
  const realCollect = SKILL_REGISTRY.collect;
  SKILL_REGISTRY.collect = async (botArg, params, ctx) => {
    if (collectFailsRemaining > 0) {
      collectFailsRemaining -= 1;
      log.test.warn('phase3.inject-failure', { skill: 'collect', params });
      return {
        ok: false,
        reason: 'INDUCED_FAILURE: simulated tool error (testing replan loop)',
        state: buildSnapshot(botArg, ctx),
      };
    }
    return realCollect(botArg, params, ctx);
  };

  const runtimeContext = createRuntimeContext();
  const executor = new SkillExecutor(bot, { context: runtimeContext });
  const agent = new AdvisorAgent(bot, executor, advisorAgentOptions(runtimeContext, { maxReplans: 4 }));

  try {
    const result = await agent.pursue(GOAL);
    const snap = buildSnapshot(bot, runtimeContext);
    if (result.ok) {
      log.test.info('phase3.done', { result, snap });
      setTimeout(() => { try { bot.quit('phase3 done'); } catch {} process.exit(0); }, 500);
    } else {
      log.test.error('phase3.failure', { result, snap });
      setTimeout(() => { try { bot.quit('phase3 fail'); } catch {} process.exit(2); }, 500);
    }
  } catch (err) {
    log.test.error('phase3.exception', { err: err.message, stack: err.stack });
    setTimeout(() => { try { bot.quit('phase3 exception'); } catch {} process.exit(3); }, 500);
  }
});

setTimeout(() => {
  log.test.error('phase3.timeout', { msg: 'no spawn after 30s' });
  process.exit(1);
}, 30000);

bot.on('error', (err) => log.test.error('phase3.error', { err: err?.message || String(err) }));
bot.on('kicked', (reason) => log.test.error('phase3.kicked', { reason }));
