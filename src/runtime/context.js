import { WorldModelStore } from '../state/world_model.js';
import { createWorldActionAuthorization } from '../state/world_action_authorization.js';

export function createRuntimeContext(opts = {}) {
  const context = {
    worldModelStore: opts.worldModelStore || new WorldModelStore(opts.worldModelPath),
    worldActionAuthorization: opts.worldActionAuthorization
      || createWorldActionAuthorization(opts.worldActionPolicy || {}),
  };
  if (opts.worldIdentity) context.worldIdentity = opts.worldIdentity;
  if (opts.worldModelSummaryOptions) context.worldModelSummaryOptions = opts.worldModelSummaryOptions;
  return context;
}

export default createRuntimeContext;
