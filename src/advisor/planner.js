// Planner: calls the LLM, parses the JSON response, validates against the skill schema.
// Retries on malformed output up to config.advisor.maxPlanRetries.

import config from '../config.js';
import log from '../logger.js';
import { validateAdvisorPlan } from '../skills/schema.js';
import { complete as defaultComplete } from './deepseek.js';
import { systemPrompt, userPromptInitial, userPromptReplan, userPromptRepair } from './prompts.js';

// Allow tests to inject a mock LLM. agent.js / production code uses defaultComplete.
let llmCall = defaultComplete;
export function setLlmCall(fn) { llmCall = fn || defaultComplete; }

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, reason: `JSON parse: ${err.message}` };
  }
}

function extractPlan(parsed) {
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'response is not an object' };
  if (!Array.isArray(parsed.plan)) return { ok: false, reason: 'missing "plan" array' };
  return { ok: true, plan: parsed.plan };
}

export function plannerMessages(userContent) {
  return [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userContent },
  ];
}

export function initialPlanMessages(goal, snapshot) {
  return plannerMessages(userPromptInitial(goal, snapshot));
}

export function replanMessages(goal, snapshot, lastFailure, remainingQueue) {
  return plannerMessages(userPromptReplan(goal, snapshot, lastFailure, remainingQueue));
}

export function repairMessages(prev, errorReason) {
  return plannerMessages(userPromptRepair(prev, errorReason));
}

export function validatePlannerResponse(raw) {
  const parsed = tryParse(raw);
  if (!parsed.ok) return { ok: false, stage: 'json', reason: parsed.reason };
  const ex = extractPlan(parsed.value);
  if (!ex.ok) return { ok: false, stage: 'shape', reason: ex.reason };
  const v = validateAdvisorPlan(ex.plan);
  if (!v.ok) {
    return {
      ok: false,
      stage: 'schema',
      reason: v.reason,
      badIndex: v.badIndex,
    };
  }
  return { ok: true, plan: ex.plan, raw };
}

async function planLoop({ initialUserMsg, label }) {
  const [sys, initialUser] = plannerMessages(initialUserMsg);
  let userMsg = initialUser;
  const retries = config.advisor.maxPlanRetries ?? 2;
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await llmCall([sys, userMsg]);
    last = raw;
    const validated = validatePlannerResponse(raw);
    if (!validated.ok) {
      if (validated.stage === 'json') {
        log.advisor.warn('plan.bad-json', { label, attempt, reason: validated.reason, raw: raw.slice(0, 200) });
      } else if (validated.stage === 'shape') {
        log.advisor.warn('plan.bad-shape', { label, attempt, reason: validated.reason });
      } else {
        log.advisor.warn('plan.invalid-skills', { label, attempt, reason: validated.reason, badIndex: validated.badIndex });
      }
      const repairReason = validated.stage === 'schema'
        ? `Schema validation: ${validated.reason} (at index ${validated.badIndex})`
        : validated.reason;
      userMsg = repairMessages(raw, repairReason)[1];
      continue;
    }
    log.advisor.info('plan.accepted', { label, attempt, steps: validated.plan.length, plan: validated.plan });
    return { ok: true, plan: validated.plan, raw };
  }
  log.advisor.error('plan.gave-up', { label, retries, lastRaw: last?.slice(0, 200) });
  return { ok: false, reason: `advisor produced invalid output ${retries + 1} times`, raw: last };
}

export async function plan(goal, snapshot) {
  return planLoop({
    initialUserMsg: userPromptInitial(goal, snapshot),
    label: 'initial',
  });
}

export async function replan(goal, snapshot, lastFailure, remainingQueue) {
  return planLoop({
    initialUserMsg: userPromptReplan(goal, snapshot, lastFailure, remainingQueue),
    label: 'replan',
  });
}
