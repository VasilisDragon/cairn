package com.mcbot.fabricclient;

/**
 * Ordered registry of {@link ObjectiveExecutor}s consulted at the top of {@code resolveControl}.
 *
 * <p>First-match-wins by {@link ObjectiveExecutor#handles(String)}. During the strangler migration
 * the registry holds only the executors already lifted out of the god class; every other action
 * returns {@code null} from {@link #forAction(String)} and falls through to the unchanged dispatch
 * chain, so registering an executor is behavior-neutral for all other actions.
 */
public final class ObjectiveRegistry {
    private final java.util.List<ObjectiveExecutor> executors = new java.util.ArrayList<>();

    public void register(ObjectiveExecutor e) {
        executors.add(e);
    }

    public ObjectiveExecutor forAction(String action) {
        for (ObjectiveExecutor e : executors) {
            if (e.handles(action)) {
                return e;
            }
        }
        return null;
    }
}
