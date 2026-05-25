export function advisorAgentOptions(runtimeContext, opts = {}) {
  const options = { ...opts };
  if (
    runtimeContext
    && options.snapshotContext === undefined
    && options.snapshotContextProvider === undefined
  ) {
    options.snapshotContext = runtimeContext;
  }
  return options;
}

export default advisorAgentOptions;
