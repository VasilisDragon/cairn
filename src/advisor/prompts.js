// System prompt + user message builders. Kept terse — the loop is frequent.

import { skillSchemaForPrompt } from '../skills/schema.js';
import {
  advisorInterfaceManifest,
  buildAdvisorContextEnvelope,
  sanitizeAdvisorValue,
} from './context.js';

export {
  advisorInterfaceManifest,
  buildAdvisorContextEnvelope,
  sanitizeAdvisorValue,
};

export function systemPrompt() {
  return [
    'You are the advisor for a Minecraft bot.',
    'Your job: decompose a natural-language goal into an ordered list of skill calls.',
    '',
    'STRICT OUTPUT CONTRACT:',
    '- Output a single JSON object with exactly one key: "plan".',
    '- "plan" is an array of skill-call objects: {"skill":"<name>","params":{...}}',
    '- No prose, no markdown, no commentary. JSON object only.',
    '- Only use skills from the vocabulary below — never invent skills or params.',
    '- Keep plans short (1-6 steps). The executor will report results; on failure, you will be called again with the new snapshot and the failure reason, and may extend or change the plan.',
    '',
    'ACTIVATION POLICY:',
    '- The user message includes activation.allowedSkillNames and activation.blockedSkillNames from the deterministic safety gate.',
    '- Emit only skills listed in activation.allowedSkillNames, even if more skills appear in the vocabulary below.',
    '- Never emit a skill listed in activation.blockedSkillNames.',
    '- If activation.normalWorkAllowed is false, choose only observe, flee, logout, or consume as appropriate for survival/recovery.',
    '',
    'AVAILABLE SKILLS:',
    skillSchemaForPrompt(),
    '',
    'TIPS:',
    '- Start with "observe" if you need fresh information; the snapshot below is usually enough.',
    '- "collect" already handles pathing and tool selection — you do not need to "goto" first.',
    '- "deposit" finds the nearest chest within maxDistance and walks to it.',
    '- "build_from_schematic" is dry-run only and does not place blocks — do not include it in normal build plans.',
    '- If a skill failed because nothing was found, increase maxDistance or change strategy (e.g., explore via goto with a faraway target).',
  ].join('\n');
}

/** Format the user turn for an initial plan. */
export function userPromptInitial(goal, snapshot) {
  return JSON.stringify(advisorPromptContext(goal, snapshot, {
    request: 'Produce the initial plan.',
  }));
}

/** Format the user turn for a re-plan after a skill failure. */
export function userPromptReplan(goal, snapshot, lastFailure, remainingQueue) {
  return JSON.stringify(advisorPromptContext(goal, snapshot, {
    lastFailure,
    remainingQueueDropped: remainingQueue || [],
    request:
      'A previous skill in the plan failed. Re-plan from the current state to make progress toward the goal. The previous remaining queue has been discarded.',
  }));
}

/** When DeepSeek returns malformed JSON or an invalid plan, re-ask with the error. */
export function userPromptRepair(prev, errorReason) {
  return JSON.stringify({
    previousResponse: prev,
    error: errorReason,
    request: 'Your previous response was rejected. Re-emit a valid JSON object {"plan": [...]} per the schema.',
  });
}

export function advisorPromptContext(goal, snapshot, extra = {}) {
  return buildAdvisorContextEnvelope(goal, snapshot, extra).context;
}
