// Live DeepSeek smoke test for the mission planner (Slice 1).
//
// Opt-in only: runs the REAL model via src/advisor/deepseek.js (which reads the key from
// config/keys.json + enforces a cost ceiling). It feeds a handful of representative states to
// chooseNextObjective and grades each choice against the deterministic oracle. This answers the
// core de-risk question cheaply: does DeepSeek actually pick sensible next objectives?
//
//   Enable with:  MCBOT_PLANNER_SMOKE=1 node fabric-client/brain/mission-planner.smoke.mjs
//   (a DeepSeek key must be configured via env DEEPSEEK_API_KEY or keys.json)
//
// Never prints the API key. Exits nonzero if any case is graded incorrect or errors.

import { complete } from '../../src/advisor/deepseek.js';
import {
  chooseNextObjective,
  expectedObjective,
  gradeChoice,
} from './mission-planner.js';

function state(overrides = {}) {
  return {
    logs: 0, planks: 0, sticks: 0, craftingTables: 0, woodenPickaxes: 0,
    cobblestone: 0, stonePickaxes: 0, stoneSwords: 0, furnaces: 0, fuel: 0,
    rawIron: 0, ironIngots: 0, ironPickaxes: 0, equippedArmorPieces: 0,
    foodLevel: 20, hasFood: false, atIronDepth: false, threatPresent: false,
    ...overrides,
  };
}

const CASES = [
  { label: 'empty inventory', s: state({}) },
  { label: 'have logs, no tools', s: state({ logs: 5 }) },
  { label: 'wooden pickaxe, no cobble', s: state({ woodenPickaxes: 1, logs: 2 }) },
  { label: 'stone tools, enough cobble, no furnace', s: state({ woodenPickaxes: 1, stonePickaxes: 1, stoneSwords: 1, cobblestone: 10 }) },
  { label: 'at depth, raw iron + furnace + fuel', s: state({ stonePickaxes: 1, stoneSwords: 1, furnaces: 1, atIronDepth: true, rawIron: 6, fuel: 5 }) },
  { label: 'iron pickaxe + ingots, no armor', s: state({ stonePickaxes: 1, furnaces: 1, atIronDepth: true, ironPickaxes: 1, ironIngots: 24 }) },
  { label: 'hungry with food (survival interrupt)', s: state({ logs: 0, foodLevel: 3, hasFood: true }) },
  {
    label: 'recovery: stone-tools craft failed (no cobble)',
    s: state({ woodenPickaxes: 1, cobblestone: 1 }),
    opts: { currentObjective: 'MAKE_STONE_TOOLS', lastOutcome: 'failed:insufficient_cobblestone' },
  },
];

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

async function main() {
  if (!process.env.MCBOT_PLANNER_SMOKE) {
    console.log('mission-planner smoke skipped (set MCBOT_PLANNER_SMOKE=1 to run the live DeepSeek check).');
    return 0;
  }

  console.log('=== mission-planner live DeepSeek smoke ===');
  console.log(`${pad('case', 46)}${pad('expected', 18)}${pad('chosen', 18)}${pad('src', 10)}ok`);

  let correct = 0;
  let modelErrors = 0;
  let fallbacks = 0;

  for (const { label, s, opts = {} } of CASES) {
    const expected = expectedObjective(s);
    let chosen = '(error)';
    let source = '-';
    let reason = '';
    try {
      const res = await chooseNextObjective(s, { complete, forceLlm: true, ...opts });
      chosen = res.objective;
      source = res.source;
      reason = res.reason || '';
      if (res.source === 'fallback') fallbacks += 1;
      if (res.error === 'model_error' || (res.error && source === 'fallback')) modelErrors += 1;
    } catch (err) {
      modelErrors += 1;
      reason = String(err?.message || err).slice(0, 40);
    }
    const grade = gradeChoice(s, chosen);
    if (grade.correct) correct += 1;
    const ok = grade.correct ? 'OK' : 'X';
    console.log(`${pad(label, 46)}${pad(expected, 18)}${pad(chosen, 18)}${pad(source, 10)}${ok}${reason ? '  // ' + reason : ''}`);
  }

  console.log('---');
  console.log(`summary: ${correct}/${CASES.length} graded correct, ${fallbacks} fallback, ${modelErrors} model error(s)`);
  const passed = correct === CASES.length && modelErrors === 0;
  console.log(passed ? 'SMOKE PASS' : 'SMOKE FAIL');
  return passed ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Redact anything that looks like a long token before surfacing.
    const msg = String(err?.message || err).replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]');
    console.error('smoke crashed:', msg);
    process.exit(1);
  });
