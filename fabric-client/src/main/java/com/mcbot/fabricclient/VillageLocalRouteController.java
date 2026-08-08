package com.mcbot.fabricclient;

import java.util.List;
import java.util.function.Predicate;

/**
 * Village-only wrapper around the proven committed site traversal motor.
 *
 * <p>It owns the one-replan/two-computation budget. It cannot plan, dig, construct, or invoke
 * generic navigation; callers supply one already validated local route at a time.</p>
 */
final class VillageLocalRouteController {
    static final long ROUTE_DEADLINE_MS = 45_000L;
    static final long REPLAN_SETTLE_TIMEOUT_MS = 3_000L;
    static final int REPLAN_SETTLE_POLLS = 2;
    static final int MAX_COMPUTATIONS = 2;

    enum ReplanReadiness {
        IDLE,
        WAITING,
        READY,
        TIMED_OUT
    }

    private final MiningWorkspaceSiteTraversalController motor =
        new MiningWorkspaceSiteTraversalController();
    private String commandId = "";
    private int computations;
    private long hardDeadlineAtMs;
    private boolean replanPending;
    private long replanPendingAtMs;
    private int replanSafePolls;
    private String rejectedReason = "";

    boolean begin(
        String nextCommandId,
        List<VoxelCell> route,
        VoxelCell feet,
        long nowMs
    ) {
        return begin(nextCommandId, route, feet, nowMs, nowMs + ROUTE_DEADLINE_MS);
    }

    boolean begin(
        String nextCommandId,
        List<VoxelCell> route,
        VoxelCell feet,
        long nowMs,
        long fixedDeadlineAtMs
    ) {
        clear();
        commandId = normalize(nextCommandId);
        hardDeadlineAtMs = Math.min(nowMs + ROUTE_DEADLINE_MS, fixedDeadlineAtMs);
        computations = 1;
        if (commandId.isBlank() || route == null
            || hardDeadlineAtMs <= nowMs
            || route.size() > VillageInteractionStancePlanner.MAX_ROUTE_CELLS
            || !motor.begin(route, feet, nowMs, hardDeadlineAtMs)) {
            clear();
            return false;
        }
        return true;
    }

    boolean replan(List<VoxelCell> route, VoxelCell feet, long nowMs) {
        if (commandId.isBlank() || computations >= MAX_COMPUTATIONS
            || nowMs >= hardDeadlineAtMs) {
            return false;
        }
        computations += 1;
        clearReplanPending();
        motor.clear();
        return route != null
            && route.size() <= VillageInteractionStancePlanner.MAX_ROUTE_CELLS
            && motor.begin(route, feet, nowMs, hardDeadlineAtMs);
    }

    MiningWorkspaceSiteTraversalController.Step tick(
        String expectedCommandId,
        MiningWorkspaceSiteTraversalController.Observation observation,
        Predicate<VoxelCell> waypointValidator,
        long nowMs
    ) {
        if (!active() || !commandId.equals(normalize(expectedCommandId))) {
            return null;
        }
        return motor.tick(observation, waypointValidator, nowMs);
    }

    boolean active() {
        return !commandId.isBlank() && motor.active();
    }

    int computations() {
        return computations;
    }

    int waypointIndex() {
        return motor.waypointIndex();
    }

    VoxelCell activeWaypoint() {
        return motor.activeWaypoint();
    }

    /**
     * The committed traversal intentionally advances its cursor past the final route index before
     * emitting {@code REACHED}; it then requires the normal stable-arrival poll. During that one
     * bounded state there is no active waypoint, but the frozen endpoint remains the only cell
     * whose geometry may authorize completion.
     */
    boolean finalArrivalPendingAt(VoxelCell endpoint) {
        return active()
            && endpoint != null
            && motor.activeWaypoint() == null
            && endpoint.equals(motor.stableFeet());
    }

    void deferReplan(String reason, long nowMs) {
        if (replanPending) {
            return;
        }
        replanPending = true;
        replanPendingAtMs = nowMs;
        replanSafePolls = 0;
        rejectedReason = reason == null ? "route_rejected" : reason;
    }

    boolean replanPending() {
        return replanPending;
    }

    String rejectedReason() {
        return rejectedReason;
    }

    ReplanReadiness observeReplanReadiness(boolean safeGrounded, long nowMs) {
        if (!replanPending) {
            return ReplanReadiness.IDLE;
        }
        if (nowMs - replanPendingAtMs >= REPLAN_SETTLE_TIMEOUT_MS
            || nowMs >= hardDeadlineAtMs) {
            return ReplanReadiness.TIMED_OUT;
        }
        if (!safeGrounded) {
            replanSafePolls = 0;
            return ReplanReadiness.WAITING;
        }
        replanSafePolls += 1;
        return replanSafePolls >= REPLAN_SETTLE_POLLS
            ? ReplanReadiness.READY : ReplanReadiness.WAITING;
    }

    void clear() {
        motor.clear();
        commandId = "";
        computations = 0;
        hardDeadlineAtMs = 0L;
        clearReplanPending();
    }

    private void clearReplanPending() {
        replanPending = false;
        replanPendingAtMs = 0L;
        replanSafePolls = 0;
        rejectedReason = "";
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim();
    }
}
