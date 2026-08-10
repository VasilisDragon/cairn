package com.mcbot.fabricclient;

import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

final class ExploreFrontierLivenessController {
    static final long NO_PROGRESS_TIMEOUT_MS = 10_000L;
    static final int MAX_FORWARD_RESYNC_CELLS = 8;
    static final int MAX_ROUTE_COMPUTATIONS = 2;

    enum Outcome {
        IDLE,
        CONTINUE,
        PROGRESSED,
        REPLAN,
        REJECTED
    }

    enum Failure {
        NONE(""),
        BLOCKER_FAILED("blocker_failed"),
        ROUTE_INVALIDATED("route_invalidated");

        private final String reason;

        Failure(String reason) {
            this.reason = reason;
        }

        String reason() {
            return reason;
        }
    }

    record Observation(
        VoxelCell feet,
        boolean onGround,
        boolean verifiedBlockBroken,
        Failure failure
    ) {
        Observation {
            failure = failure == null ? Failure.NONE : failure;
        }

        static Observation pose(VoxelCell feet, boolean onGround) {
            return new Observation(feet, onGround, false, Failure.NONE);
        }

        static Observation verifiedBreak(VoxelCell feet, boolean onGround) {
            return new Observation(feet, onGround, true, Failure.NONE);
        }

        static Observation failure(VoxelCell feet, boolean onGround, Failure failure) {
            return new Observation(feet, onGround, false, failure);
        }
    }

    record Step(
        Outcome outcome,
        String reason,
        ExploreFrontierPlanner.DirectedTransition failedTransition,
        String commandId,
        long routeGeneration,
        int routeComputation,
        int waypointIndex,
        int maximumWaypointIndex,
        int remainingCells,
        VoxelCell stableFeet,
        long lastProgressAgeMs,
        long elapsedMs,
        int verifiedBlocksBroken,
        boolean waypointAdvanced,
        boolean forwardResynchronized
    ) {
    }

    private String commandId = "";
    private long routeGeneration;
    private List<VoxelCell> route = List.of();
    private int routeComputation;
    private int waypointIndex = -1;
    private int maximumWaypointIndex = -1;
    private VoxelCell stableFeet;
    private long startedAtMs;
    private long lastProgressAtMs;
    private int verifiedBlocksBroken;
    private boolean awaitingReplan;
    private boolean rejected;
    private String terminalReason = "";
    private ExploreFrontierPlanner.DirectedTransition failedTransition;

    boolean begin(
        String nextCommandId,
        long nextRouteGeneration,
        List<VoxelCell> nextRoute,
        VoxelCell groundedFeet,
        long nowMs
    ) {
        if (!validRoute(nextRoute, groundedFeet)) {
            return false;
        }
        clear();
        commandId = normalizeCommandId(nextCommandId);
        routeGeneration = nextRouteGeneration;
        routeComputation = 1;
        startedAtMs = nowMs;
        bindRoute(nextRoute, groundedFeet, nowMs);
        return true;
    }

    boolean replaceRoute(
        String expectedCommandId,
        long nextRouteGeneration,
        List<VoxelCell> nextRoute,
        VoxelCell groundedFeet,
        long nowMs
    ) {
        if (!awaitingReplan
            || rejected
            || routeComputation >= MAX_ROUTE_COMPUTATIONS
            || !commandId.equals(normalizeCommandId(expectedCommandId))
            || !validRoute(nextRoute, groundedFeet)) {
            return false;
        }
        routeGeneration = nextRouteGeneration;
        routeComputation++;
        bindRoute(nextRoute, groundedFeet, nowMs);
        awaitingReplan = false;
        failedTransition = null;
        terminalReason = "";
        return true;
    }

    Step tick(Observation observation, long nowMs) {
        return tick(observation, nowMs, true);
    }

    Step tick(Observation observation, long nowMs, boolean enforceDeadline) {
        if (!active()) {
            return idleStep();
        }
        if (awaitingReplan) {
            return step(
                Outcome.REPLAN,
                terminalReason.isBlank() ? "replan_pending" : terminalReason,
                nowMs,
                false,
                false
            );
        }

        Observation observed = observation == null
            ? new Observation(null, false, false, Failure.NONE)
            : observation;
        if (observed.failure() != Failure.NONE) {
            return failOrReplan(observed.failure().reason(), nowMs);
        }

        Synchronization synchronization = synchronizeForward(observed);
        boolean verifiedBreak = observed.verifiedBlockBroken();
        if (synchronization.advanced() || verifiedBreak) {
            if (verifiedBreak) {
                verifiedBlocksBroken++;
            }
            lastProgressAtMs = nowMs;
            String reason = progressReason(synchronization, verifiedBreak);
            return step(
                Outcome.PROGRESSED,
                reason,
                nowMs,
                synchronization.advanced(),
                synchronization.forwardResynchronized()
            );
        }

        if (enforceDeadline && nowMs - lastProgressAtMs >= NO_PROGRESS_TIMEOUT_MS) {
            return failOrReplan("no_progress_deadline", nowMs);
        }
        return step(Outcome.CONTINUE, "active", nowMs, false, false);
    }

    Step failPendingReplan(String reason, long nowMs) {
        if (!active() || !awaitingReplan) {
            return idleStep();
        }
        routeComputation = Math.min(MAX_ROUTE_COMPUTATIONS, routeComputation + 1);
        rejected = true;
        awaitingReplan = false;
        terminalReason = normalizeReason(reason, "replan_failed");
        return step(Outcome.REJECTED, terminalReason, nowMs, false, false);
    }

    boolean active() {
        return !route.isEmpty() && !rejected;
    }

    boolean awaitingReplan() {
        return active() && awaitingReplan;
    }

    boolean matches(String expectedCommandId, long expectedRouteGeneration) {
        return active()
            && commandId.equals(normalizeCommandId(expectedCommandId))
            && routeGeneration == expectedRouteGeneration;
    }

    List<VoxelCell> route() {
        return route;
    }

    int routeComputation() {
        return routeComputation;
    }

    int waypointIndex() {
        return active() ? waypointIndex : -1;
    }

    int maximumWaypointIndex() {
        return active() ? maximumWaypointIndex : -1;
    }

    VoxelCell activeWaypoint() {
        return active() && waypointIndex >= 0 && waypointIndex < route.size()
            ? route.get(waypointIndex)
            : null;
    }

    VoxelCell stableFeet() {
        return active() ? stableFeet : null;
    }

    ExploreFrontierPlanner.DirectedTransition activeTransition() {
        if (!active() || waypointIndex <= 0 || waypointIndex >= route.size()) {
            return null;
        }
        return new ExploreFrontierPlanner.DirectedTransition(
            route.get(waypointIndex - 1),
            route.get(waypointIndex)
        );
    }

    ExploreFrontierPlanner.DirectedTransition failedTransition() {
        return failedTransition;
    }

    long lastProgressAgeMs(long nowMs) {
        return active() ? Math.max(0L, nowMs - lastProgressAtMs) : 0L;
    }

    static double edgeGuardLookahead(
        double playerX,
        double playerZ,
        VoxelCell feet,
        VoxelCell stableFeet,
        VoxelCell waypoint,
        boolean active,
        boolean waypointSafe
    ) {
        if (!active
            || feet == null
            || stableFeet == null
            || waypoint == null
            || !feet.equals(stableFeet)
            || waypoint.y() != stableFeet.y()
            || Math.abs(waypoint.x() - stableFeet.x())
                + Math.abs(waypoint.z() - stableFeet.z()) != 1
            || !waypointSafe) {
            return MiningWorkspaceTraversal.EDGE_GUARD_MAX_LOOKAHEAD;
        }
        return MiningWorkspaceTraversal.edgeGuardLookahead(playerX, playerZ, waypoint);
    }

    void clear() {
        commandId = "";
        routeGeneration = 0L;
        route = List.of();
        routeComputation = 0;
        waypointIndex = -1;
        maximumWaypointIndex = -1;
        stableFeet = null;
        startedAtMs = 0L;
        lastProgressAtMs = 0L;
        verifiedBlocksBroken = 0;
        awaitingReplan = false;
        rejected = false;
        terminalReason = "";
        failedTransition = null;
    }

    private void bindRoute(List<VoxelCell> nextRoute, VoxelCell groundedFeet, long nowMs) {
        route = List.copyOf(nextRoute);
        waypointIndex = 1;
        maximumWaypointIndex = 0;
        stableFeet = groundedFeet;
        lastProgressAtMs = nowMs;
    }

    private Synchronization synchronizeForward(Observation observation) {
        if (!observation.onGround()
            || observation.feet() == null
            || waypointIndex < 0
            || waypointIndex >= route.size()) {
            return Synchronization.NONE;
        }
        int lastIndex = Math.min(route.size() - 1, waypointIndex + MAX_FORWARD_RESYNC_CELLS);
        int observedIndex = -1;
        for (int index = lastIndex; index >= waypointIndex; index--) {
            if (route.get(index).equals(observation.feet())) {
                observedIndex = index;
                break;
            }
        }
        if (observedIndex < waypointIndex) {
            return Synchronization.NONE;
        }

        int previousWaypointIndex = waypointIndex;
        stableFeet = observation.feet();
        maximumWaypointIndex = Math.max(maximumWaypointIndex, observedIndex);
        waypointIndex = Math.min(route.size(), observedIndex + 1);
        return new Synchronization(true, observedIndex > previousWaypointIndex);
    }

    private Step failOrReplan(String reason, long nowMs) {
        terminalReason = normalizeReason(reason, "frontier_failed");
        failedTransition = activeTransition();
        if (routeComputation < MAX_ROUTE_COMPUTATIONS) {
            awaitingReplan = true;
            return step(Outcome.REPLAN, terminalReason, nowMs, false, false);
        }
        rejected = true;
        return step(Outcome.REJECTED, terminalReason, nowMs, false, false);
    }

    private Step step(
        Outcome outcome,
        String reason,
        long nowMs,
        boolean waypointAdvanced,
        boolean forwardResynchronized
    ) {
        return new Step(
            outcome,
            reason,
            failedTransition,
            commandId,
            routeGeneration,
            routeComputation,
            waypointIndex,
            maximumWaypointIndex,
            Math.max(0, route.size() - waypointIndex),
            stableFeet,
            Math.max(0L, nowMs - lastProgressAtMs),
            Math.max(0L, nowMs - startedAtMs),
            verifiedBlocksBroken,
            waypointAdvanced,
            forwardResynchronized
        );
    }

    private static Step idleStep() {
        return new Step(
            Outcome.IDLE,
            "idle",
            null,
            "",
            0L,
            0,
            -1,
            -1,
            0,
            null,
            0L,
            0L,
            0,
            false,
            false
        );
    }

    private static String progressReason(Synchronization synchronization, boolean verifiedBreak) {
        if (synchronization.forwardResynchronized() && verifiedBreak) {
            return "forward_resynchronized_and_verified_block_broken";
        }
        if (synchronization.forwardResynchronized()) {
            return "forward_resynchronized";
        }
        if (synchronization.advanced() && verifiedBreak) {
            return "waypoint_advanced_and_verified_block_broken";
        }
        if (synchronization.advanced()) {
            return "waypoint_advanced";
        }
        return "verified_block_broken";
    }

    private static boolean validRoute(List<VoxelCell> candidate, VoxelCell groundedFeet) {
        if (candidate == null
            || candidate.size() < 2
            || groundedFeet == null
            || !groundedFeet.equals(candidate.get(0))) {
            return false;
        }
        Set<VoxelCell> unique = new HashSet<>();
        VoxelCell previous = null;
        for (VoxelCell cell : candidate) {
            if (cell == null || !unique.add(cell)) {
                return false;
            }
            if (previous != null) {
                int horizontal = Math.abs(cell.x() - previous.x())
                    + Math.abs(cell.z() - previous.z());
                int vertical = cell.y() - previous.y();
                if (horizontal != 1 || vertical < -3 || vertical > 1) {
                    return false;
                }
            }
            previous = cell;
        }
        return true;
    }

    private static String normalizeCommandId(String value) {
        return value == null ? "" : value;
    }

    private static String normalizeReason(String value, String fallback) {
        return value == null || value.isBlank() ? Objects.requireNonNull(fallback) : value;
    }

    private record Synchronization(boolean advanced, boolean forwardResynchronized) {
        private static final Synchronization NONE = new Synchronization(false, false);
    }
}
