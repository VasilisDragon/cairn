import buildSnapshot from '../state/snapshot.js';
import { collectVisibleBlockSamples } from '../state/world_model.js';
import log from '../logger.js';
import { awaitBotChunksReady } from '../control/chunk_ready.js';

export async function run(bot, params = {}, ctx = {}) {
  if (ctx.signal?.aborted) return { preempted: true, reason: 'pre-aborted', state: buildSnapshot(bot, ctx) };
  const ingest = await maybeIngestWorld(bot, params, ctx);
  if (ingest.preempted) return { preempted: true, reason: ingest.reason, state: buildSnapshot(bot, ctx) };
  const state = buildSnapshot(bot, ctx);
  return { ok: true, reason: observeReason(ingest), state };
}

async function maybeIngestWorld(bot, params, ctx) {
  if (params.ingestWorld === false || !ctx.worldModelStore?.ingestBlockSamples) return { ok: true, skipped: true };
  const ready = await awaitBotChunksReady(bot, ctx.signal, 'reactive preempt before observe world-model ingest');
  if (ready.preempted) return ready;
  if (ready.error) return { ok: true, ingestFailed: true, reason: ready.error?.message || String(ready.error) };
  if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt before observe world-model ingest' };

  const sampleOpts = params.worldModelIngest || ctx.worldModelIngestOptions || {};
  try {
    const samples = collectVisibleBlockSamples(bot, sampleOpts);
    if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt during observe world-model ingest' };
    ctx.worldModelStore.ingestBlockSamples(samples, {
      ...sampleOpts,
      source: sampleOpts.source || 'observe',
    });
    if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt during observe world-model ingest' };
    return { ok: true, ingested: true, sampleCount: samples.length };
  } catch (err) {
    if (ctx.signal?.aborted) return { preempted: true, reason: 'reactive preempt during observe world-model ingest' };
    const reason = err?.message || String(err);
    log.executor.warn('observe.world-model-ingest-failed', { err: reason });
    return { ok: true, ingestFailed: true, reason };
  }
}

function observeReason(ingest) {
  if (ingest.ingestFailed) return `snapshot captured (world-model ingest failed: ${ingest.reason})`;
  if (ingest.ingested) return `snapshot captured (world-model samples: ${ingest.sampleCount})`;
  return 'snapshot captured';
}
