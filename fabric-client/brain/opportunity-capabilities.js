// Pure capability registry for the opportunity ledger.
//
// A Minecraft recipe being known is not enough to make its output convertible:
// deterministic code must also have a proven executor which is ready in the
// current state.  The registry makes both requirements explicit and keeps
// speculative discoveries out of inventory accounting.

const CAPABILITY_ID_RE = /^[a-z][a-z0-9_.:-]{0,95}$/;
const EXECUTOR_ID_RE = /^[a-z][a-z0-9_:-]{0,95}$/;
const ITEM_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

const AUTHENTIC_REGISTRIES = new WeakSet();

export const EMPTY_OPPORTUNITY_CAPABILITY_REGISTRY = Object.freeze({
  capabilities: Object.freeze([]),
  rejected: Object.freeze([]),
});
AUTHENTIC_REGISTRIES.add(EMPTY_OPPORTUNITY_CAPABILITY_REGISTRY);

/**
 * Build an immutable registry from code-owned recipe facts.
 *
 * A definition is active only when:
 *   - it explicitly carries `proven: true`;
 *   - its executor id is present in `readyExecutors`; and
 *   - its integer recipe is structurally valid.
 *
 * Invalid/unready entries are retained only as classified diagnostics.  They
 * can never contribute convertible resources.
 */
export function createOpportunityCapabilityRegistry(input = {}) {
  const readyExecutors = new Set(normalizeStringSet(input.readyExecutors));
  const definitions = Array.isArray(input.definitions) ? input.definitions : [];
  const active = [];
  const rejected = [];
  const seen = new Set();

  for (let index = 0; index < definitions.length; index += 1) {
    const raw = definitions[index];
    const normalized = normalizeCapability(raw);
    if (!normalized.ok) {
      rejected.push(frozenRejection(raw?.id, normalized.reason, index));
      continue;
    }
    const capability = normalized.capability;
    if (seen.has(capability.id)) {
      rejected.push(frozenRejection(capability.id, 'duplicate_id', index));
      continue;
    }
    seen.add(capability.id);
    if (raw.proven !== true) {
      rejected.push(frozenRejection(capability.id, 'recipe_not_proven', index));
      continue;
    }
    if (!readyExecutors.has(capability.executor)) {
      rejected.push(frozenRejection(capability.id, 'executor_not_ready', index));
      continue;
    }
    active.push(capability);
  }

  active.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  rejected.sort((left, right) => left.index - right.index || String(left.id).localeCompare(String(right.id)));
  const registry = Object.freeze({
    capabilities: Object.freeze(active),
    rejected: Object.freeze(rejected),
  });
  AUTHENTIC_REGISTRIES.add(registry);
  return registry;
}

export function isOpportunityCapabilityRegistry(value) {
  return Boolean(value && typeof value === 'object' && AUTHENTIC_REGISTRIES.has(value));
}

function normalizeCapability(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'definition_not_object' };
  }
  const id = String(raw.id || '').trim();
  const executor = String(raw.executor || '').trim();
  if (!CAPABILITY_ID_RE.test(id)) return { ok: false, reason: 'invalid_id' };
  if (!EXECUTOR_ID_RE.test(executor)) return { ok: false, reason: 'invalid_executor' };
  const inputs = normalizeRecipeCounts(raw.inputs);
  const outputs = normalizeRecipeCounts(raw.outputs);
  const catalysts = normalizeRecipeCounts(raw.catalysts, true);
  if (!inputs.ok) return { ok: false, reason: `invalid_inputs:${inputs.reason}` };
  if (!outputs.ok) return { ok: false, reason: `invalid_outputs:${outputs.reason}` };
  if (!catalysts.ok) return { ok: false, reason: `invalid_catalysts:${catalysts.reason}` };
  if (Object.keys(inputs.counts).length === 0) return { ok: false, reason: 'inputs_empty' };
  if (Object.keys(outputs.counts).length === 0) return { ok: false, reason: 'outputs_empty' };
  if (Object.keys(outputs.counts).some((item) => Object.hasOwn(inputs.counts, item))) {
    return { ok: false, reason: 'same_item_input_output' };
  }
  return {
    ok: true,
    capability: Object.freeze({
      id,
      executor,
      priority: nonNegativeSafeInteger(raw.priority, 100),
      inputs: Object.freeze(inputs.counts),
      outputs: Object.freeze(outputs.counts),
      catalysts: Object.freeze(catalysts.counts),
    }),
  };
}

function normalizeRecipeCounts(raw, allowEmpty = false) {
  if (raw == null && allowEmpty) return { ok: true, counts: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not_object' };
  }
  const counts = {};
  for (const key of Object.keys(raw).sort()) {
    const item = canonicalItemId(key);
    const count = raw[key];
    if (!item) return { ok: false, reason: 'invalid_item' };
    if (!Number.isSafeInteger(count) || count <= 0) return { ok: false, reason: 'invalid_count' };
    counts[item] = count;
  }
  return { ok: true, counts };
}

function canonicalItemId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const item = raw.includes(':') ? raw : `minecraft:${raw}`;
  return ITEM_ID_RE.test(item) ? item : null;
}

function normalizeStringSet(raw) {
  const values = raw instanceof Set ? [...raw] : Array.isArray(raw) ? raw : [];
  return values
    .map((value) => String(value || '').trim())
    .filter((value) => EXECUTOR_ID_RE.test(value));
}

function nonNegativeSafeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function frozenRejection(id, reason, index) {
  const normalizedId = CAPABILITY_ID_RE.test(String(id || '').trim()) ? String(id).trim() : null;
  return Object.freeze({ id: normalizedId, reason, index });
}
