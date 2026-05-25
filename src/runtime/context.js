import { WorldModelStore } from '../state/world_model.js';

export function createRuntimeContext(opts = {}) {
  const context = {
    worldModelStore: opts.worldModelStore || new WorldModelStore(opts.worldModelPath),
  };
  if (opts.worldModelSummaryOptions) context.worldModelSummaryOptions = opts.worldModelSummaryOptions;
  return context;
}

export default createRuntimeContext;
