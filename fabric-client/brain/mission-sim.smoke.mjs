// Live DeepSeek smoke for the mission CLOSED LOOP (Slice 2).
//
// Opt-in only. Drives the real MissionOrchestrator (real DeepSeek as the planner) against the
// simulated world, proving the LLM can SEQUENCE a full multi-step mission to completion and RECOVER
// from a mid-mission material shortfall — the Unit 2/3 de-risk, made reproducible without the MC
// client. The in-world harness run additionally confirms the sub-executor's action ids drive the
// real client; this proves the planning loop itself.
//
//   Enable:  MCBOT_MISSION_SMOKE=1 node fabric-client/brain/mission-sim.smoke.mjs
//   (a DeepSeek key must be configured via env DEEPSEEK_API_KEY or keys.json)
//
// Never prints the API key. Exits nonzero if either scenario fails.

import { complete, getAdvisorCostSnapshot } from '../../src/advisor/deepseek.js';
import { MissionOrchestrator } from './mission-orchestrator.js';
import { runMissionInSim } from './mission-sim.js';

function compactTrace(trace) {
  const out = [];
  let last = null;
  for (const o of trace) { if (o !== last) { out.push(o); last = o; } }
  return out.join(' -> ');
}

async function scenarioFullMission() {
  const orch = new MissionOrchestrator({ complete, forceLlm: true });
  const res = await runMissionInSim(orch, {}, { maxSteps: 400 });
  const ok = res.done && res.state.ironPickaxes >= 1 && res.state.equippedArmorPieces >= 4;
  const fallbacks = res.signals.filter((s) => s.evt === 'mission.objective.chosen' && s.source === 'fallback').length;
  console.log(`\n[A] full mission: done=${res.done} steps=${res.steps} llmCalls=${res.llmCalls} fallbacks=${fallbacks}`);
  console.log(`    ironPickaxe=${res.state.ironPickaxes} armor=${res.state.equippedArmorPieces}/4`);
  console.log(`    objectives: ${compactTrace(res.objectiveTrace)}`);
  return { ok, fallbacks };
}

async function scenarioRecovery() {
  // Pre-seed near the stone-tools step to keep the scenario short; inject a cobble shortfall the
  // instant MAKE_STONE_TOOLS is active, and require the planner to recover.
  const orch = new MissionOrchestrator({ complete, forceLlm: true });
  const res = await runMissionInSim(orch, { woodenPickaxes: 1, planks: 24, sticks: 24, tablePlaced: true }, {
    maxSteps: 60,
    mutate: (state) => {
      if (orch.state.currentObjective === 'MAKE_STONE_TOOLS' && state.cobblestone >= 3 && state.stonePickaxes < 1) {
        return { ...state, cobblestone: 0 };
      }
      return undefined;
    },
  });
  const evts = res.signals.map((s) => s.evt);
  const blocked = evts.includes('mission.objective.blocked') || evts.includes('mission.objective.failed');
  const replanned = res.signals.some((s) => s.evt === 'mission.replan');
  const recovered = res.state.stonePickaxes >= 1;
  const ok = res.mutated && blocked && replanned && recovered;
  console.log(`\n[B] recovery: shortfallInjected=${res.mutated} blocked/failed=${blocked} replanned=${replanned} recovered(stonePickaxe)=${recovered}`);
  console.log(`    objectives: ${compactTrace(res.objectiveTrace)}`);
  return { ok };
}

async function main() {
  if (!process.env.MCBOT_MISSION_SMOKE) {
    console.log('mission-sim smoke skipped (set MCBOT_MISSION_SMOKE=1 to run the live DeepSeek closed-loop check).');
    return 0;
  }
  console.log('=== mission closed-loop live DeepSeek smoke ===');
  const a = await scenarioFullMission();
  const b = await scenarioRecovery();

  const cost = getAdvisorCostSnapshot();
  console.log(`\ncumulative DeepSeek: calls=${cost.callCount} sessionCostUsd=${(cost.sessionCostUsd ?? 0).toFixed(4)} ceilingUsd=${cost.maxUsd}`);
  const passed = a.ok && b.ok;
  console.log(passed ? '\nSMOKE PASS' : '\nSMOKE FAIL');
  return passed ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const msg = String(err?.message || err).replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]');
    console.error('smoke crashed:', msg);
    process.exit(1);
  });
