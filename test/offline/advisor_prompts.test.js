import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advisorPromptContext,
  systemPrompt,
  userPromptInitial,
  userPromptReplan,
} from '../../src/advisor/prompts.js';

function snapshot(overrides = {}) {
  return {
    position: { x: 0, y: 64, z: 0, dimension: 'overworld' },
    health: 20,
    food: 20,
    reactiveState: 'NORMAL',
    currentSkill: null,
    queueLength: 0,
    pathfinder: { owner: null, idle: true },
    hazardFlags: {
      inWater: false,
      oxygenLow: false,
      falling: false,
      usingHeldItem: false,
      autoEatEating: false,
    },
    nearbyHostiles: [],
    ...overrides,
  };
}

test('advisor prompt context carries contract, activation key, and safety state', () => {
  const current = snapshot({
    reactiveState: 'FLEEING',
    nearbyHostiles: [{ name: 'zombie', distance: 6 }],
  });
  const context = advisorPromptContext('survive and gather logs', current, { request: 'Produce the initial plan.' });

  assert.equal(context.goal, 'survive and gather logs');
  assert.deepEqual(context.currentState, current);
  assert.equal(context.advisorContract.version, 1);
  assert.ok(context.advisorContract.plannerSkillNames.includes('collect'));
  assert.equal(context.advisorContract.plannerSkillNames.includes('recover_drops'), false);
  assert.equal(context.advisorContract.plannerSkillNames.includes('smelt'), false);
  assert.equal(context.advisorContract.plannerSkillNames.includes('mine_with_progression'), false);
  assert.deepEqual(context.advisorContract.runtimeOnlySkillNames, ['smelt', 'mine_with_progression', 'place_workstation', 'recover_drops']);
  assert.equal(context.activation.normalWorkAllowed, false);
  assert.deepEqual(context.activation.safetyReasons, [
    'reactive state FLEEING',
    'nearby hostile zombie at 6',
  ]);
  assert.equal(context.activation.snapshotKey.reactiveState, 'FLEEING');
  assert.equal(context.request, 'Produce the initial plan.');
});

test('initial and replan user prompts use the advisor context envelope', () => {
  const current = snapshot();
  const initial = JSON.parse(userPromptInitial('collect logs', current));
  const replan = JSON.parse(userPromptReplan(
    'collect logs',
    current,
    { skill: 'collect', params: { block: 'oak_log', count: 1 }, reason: 'no targets' },
    [{ skill: 'deposit', params: { items: [{ name: 'oak_log' }] } }],
  ));

  assert.equal(initial.goal, 'collect logs');
  assert.equal(initial.activation.normalWorkAllowed, true);
  assert.deepEqual(initial.activation.safetyReasons, []);
  assert.equal(initial.advisorContract.runtimeOnlyReasons.recover_drops, 'scheduled only by deterministic death recovery after a recoverable respawn');
  assert.match(initial.advisorContract.runtimeOnlyReasons.smelt, /deterministic progression missions/);
  assert.match(initial.advisorContract.runtimeOnlyReasons.mine_with_progression, /deterministic progression missions/);
  assert.equal(replan.lastFailure.reason, 'no targets');
  assert.deepEqual(replan.remainingQueueDropped, [
    { skill: 'deposit', params: { items: [{ name: 'oak_log' }] } },
  ]);
  assert.equal(replan.activation.snapshotKey.position.dimension, 'overworld');
});

test('system prompt exposes only advisor-callable skills', () => {
  const prompt = systemPrompt();

  assert.doesNotMatch(prompt, /^- recover_drops:/m);
  assert.doesNotMatch(prompt, /^- smelt:/m);
  assert.doesNotMatch(prompt, /^- mine_with_progression:/m);
  assert.match(prompt, /^- collect:/m);
  assert.match(prompt, /^- build_from_schematic:/m);
  assert.match(prompt, /advisorMode: dry-run-only/);
});

test('system prompt tells the advisor to obey activation skill policy', () => {
  const prompt = systemPrompt();

  assert.match(prompt, /activation\.allowedSkillNames/);
  assert.match(prompt, /activation\.blockedSkillNames/);
  assert.match(prompt, /normalWorkAllowed/);
  assert.match(prompt, /observe, flee, logout, or consume/);
});
