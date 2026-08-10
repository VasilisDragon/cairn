package com.mcbot.fabricclient;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

final class Nav3DGazeCursor {
    static final int MAX_FORWARD_RESYNC_CELLS = 8;

    enum Scope {
        SHADOW,
        SMOOTH
    }

    record Identity(
        String commandId,
        long routeGeneration,
        String targetIdentity,
        String worldIdentity,
        String dimensionIdentity
    ) {
        Identity {
            Objects.requireNonNull(commandId, "commandId");
            Objects.requireNonNull(targetIdentity, "targetIdentity");
            Objects.requireNonNull(worldIdentity, "worldIdentity");
            Objects.requireNonNull(dimensionIdentity, "dimensionIdentity");
        }
    }

    record Selection(
        boolean active,
        VoxelCell waypoint,
        int waypointIndex,
        int remainingCells,
        int maximumWaypointIndex,
        int forwardResynchronizations,
        boolean reset,
        boolean advanced,
        boolean forwardResynchronized
    ) {
        static Selection inactive() {
            return new Selection(false, null, -1, 0, -1, 0, false, false, false);
        }
    }

    private final Map<Scope, State> states = new EnumMap<>(Scope.class);

    Selection select(
        Scope scope,
        Identity identity,
        List<VoxelCell> route,
        VoxelCell observedFeet
    ) {
        if (scope == null
            || identity == null
            || route == null
            || route.isEmpty()
            || observedFeet == null) {
            reset(scope);
            return Selection.inactive();
        }

        State state = states.computeIfAbsent(scope, ignored -> new State());
        if (state.requiresReset(identity, route)) {
            if (!validRoute(route)) {
                reset(scope);
                return Selection.inactive();
            }
            state.bind(identity, route);
            return state.selection(true, false, false);
        }

        int observedIndex = state.forwardObservedIndex(observedFeet);
        if (observedIndex < state.waypointIndex) {
            return state.selection(false, false, false);
        }

        int previousIndex = state.waypointIndex;
        int nextIndex = Math.min(observedIndex + 1, state.route.size() - 1);
        boolean advanced = nextIndex > previousIndex;
        boolean forwardResynchronized = observedIndex > previousIndex;
        if (advanced) {
            state.waypointIndex = nextIndex;
            state.maximumWaypointIndex = Math.max(state.maximumWaypointIndex, nextIndex);
            if (forwardResynchronized) {
                state.forwardResynchronizations++;
            }
        }
        return state.selection(false, advanced, advanced && forwardResynchronized);
    }

    void reset(Scope scope) {
        if (scope != null) {
            states.remove(scope);
        }
    }

    void resetAll() {
        states.clear();
    }

    private static boolean validRoute(List<VoxelCell> route) {
        for (VoxelCell cell : route) {
            if (cell == null) {
                return false;
            }
        }
        return true;
    }

    private static final class State {
        private Identity identity;
        private List<VoxelCell> route = List.of();
        private List<VoxelCell> routeSource;
        private int waypointIndex = -1;
        private int maximumWaypointIndex = -1;
        private int forwardResynchronizations;

        private boolean requiresReset(Identity nextIdentity, List<VoxelCell> nextRoute) {
            return identity == null
                || !identity.equals(nextIdentity)
                || routeSource != nextRoute;
        }

        private void bind(Identity nextIdentity, List<VoxelCell> nextRoute) {
            identity = nextIdentity;
            routeSource = nextRoute;
            route = List.copyOf(nextRoute);
            waypointIndex = route.size() == 1 ? 0 : 1;
            maximumWaypointIndex = waypointIndex;
            forwardResynchronizations = 0;
        }

        private int forwardObservedIndex(VoxelCell observedFeet) {
            int lastIndex = Math.min(
                route.size() - 1,
                waypointIndex + MAX_FORWARD_RESYNC_CELLS
            );
            for (int index = lastIndex; index >= waypointIndex; index--) {
                if (route.get(index).equals(observedFeet)) {
                    return index;
                }
            }
            return -1;
        }

        private Selection selection(
            boolean reset,
            boolean advanced,
            boolean forwardResynchronized
        ) {
            return new Selection(
                true,
                route.get(waypointIndex),
                waypointIndex,
                Math.max(0, route.size() - 1 - waypointIndex),
                maximumWaypointIndex,
                forwardResynchronizations,
                reset,
                advanced,
                forwardResynchronized
            );
        }
    }
}
