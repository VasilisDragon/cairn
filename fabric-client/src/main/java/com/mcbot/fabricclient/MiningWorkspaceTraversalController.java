package com.mcbot.fabricclient;

import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;

final class MiningWorkspaceTraversalController {
    private static final long STALL_TIMEOUT_MS = 4_000L;
    private static final long DESCENT_TIMEOUT_MS = 3_000L;
    private static final int MAX_FORWARD_RESYNC_CELLS = 8;
    private static final double PRECISE_PROGRESS_BLOCKS = 0.05D;

    enum Mode {
        NONE,
        RETURN,
        RESUME
    }

    enum Outcome {
        IDLE,
        DRIVE,
        HOLD_DESCENT,
        RETURNED,
        RESUMED,
        REJECTED
    }

    enum DescentPhase {
        NONE,
        SELECTED,
        ALIGNING,
        LAUNCHING,
        AIRBORNE,
        LANDED
    }

    record Observation(
        VoxelCell feet,
        double x,
        double y,
        double z,
        boolean onGround,
        boolean aligned
    ) {
        static Observation centered(VoxelCell feet, boolean onGround, boolean aligned) {
            return new Observation(
                feet,
                feet == null ? 0.0D : feet.x() + 0.5D,
                feet == null ? 0.0D : feet.y(),
                feet == null ? 0.0D : feet.z() + 0.5D,
                onGround,
                aligned
            );
        }
    }

    record Step(
        Outcome outcome,
        VoxelCell waypoint,
        boolean descending,
        boolean forward,
        boolean descentExempt,
        String reason,
        long elapsedMs,
        Mode mode,
        int waypointIndex,
        int remainingCells,
        VoxelCell stableFeet,
        long lastProgressAgeMs,
        DescentPhase descentPhase,
        boolean waypointAdvanced,
        boolean descentStarted,
        boolean descentLanded
    ) {
    }

    record RouteSnapshot(
        Mode mode,
        List<VoxelCell> route,
        int waypointIndex,
        VoxelCell activeWaypoint,
        VoxelCell stableFeet,
        long startedAtMs,
        long deadlineAtMs,
        long lastProgressAtMs,
        DescentPhase descentPhase
    ) {
        RouteSnapshot {
            route = route == null ? List.of() : List.copyOf(route);
        }
    }

    private Mode mode = Mode.NONE;
    private List<VoxelCell> route = List.of();
    private long startedAtMs;
    private long deadlineAtMs;
    private long lastProgressAtMs;
    private int waypointIndex;
    private VoxelCell stableFeet;
    private double bestPreciseDistance = Double.POSITIVE_INFINITY;
    private DescentPhase descentPhase = DescentPhase.NONE;
    private VoxelCell descentOrigin;
    private VoxelCell descentLanding;
    private long descentStartedAtMs;

    boolean begin(Mode nextMode, List<VoxelCell> nextRoute, VoxelCell feet, long nowMs) {
        if (nextMode == null
            || nextMode == Mode.NONE
            || nextRoute == null
            || nextRoute.isEmpty()
            || feet == null
            || !MiningWorkspaceTraversal.reversibleRoute(nextRoute)) {
            return false;
        }
        if (!nextRoute.get(0).equals(feet)) {
            return false;
        }
        mode = nextMode;
        route = List.copyOf(nextRoute);
        startedAtMs = nowMs;
        deadlineAtMs = nowMs + MiningWorkspaceTraversal.timeoutMs(route.size());
        lastProgressAtMs = nowMs;
        waypointIndex = 1;
        stableFeet = feet;
        bestPreciseDistance = Double.POSITIVE_INFINITY;
        descentPhase = DescentPhase.NONE;
        descentOrigin = null;
        descentLanding = null;
        descentStartedAtMs = 0L;
        return true;
    }

    Step tick(
        Observation observation,
        Predicate<VoxelCell> waypointValidator,
        long nowMs
    ) {
        if (mode == Mode.NONE || route.isEmpty() || observation == null || observation.feet() == null) {
            return idleStep();
        }
        long elapsedMs = elapsedMs(nowMs);
        if (nowMs >= deadlineAtMs) {
            return reject(modeName() + "_timeout", elapsedMs, nowMs);
        }
        if (descentPhase != DescentPhase.NONE) {
            return tickDescent(observation, waypointValidator, nowMs, elapsedMs);
        }

        boolean waypointAdvanced = synchronizeForward(observation, nowMs);
        if (waypointIndex >= route.size()) {
            if (!validWaypoint(waypointValidator, observation.feet())) {
                return reject("route_invalidated", elapsedMs, nowMs);
            }
            return arrive(elapsedMs, nowMs, waypointAdvanced);
        }
        if (waypointAdvanced && !validWaypoint(waypointValidator, observation.feet())) {
            return reject("route_invalidated", elapsedMs, nowMs);
        }
        VoxelCell waypoint = route.get(waypointIndex);
        if (observation.onGround()) {
            int exact = route.indexOf(observation.feet());
            boolean elevatedStepTransition =
                isElevatedStepOriginColumn(observation.feet(), stableFeet, waypoint);
            if ((exact < 0 || exact < waypointIndex - 2 || exact >= waypointIndex)
                && !elevatedStepTransition) {
                return reject("route_deviation", elapsedMs, nowMs);
            }
            if (exact == waypointIndex - 1) {
                stableFeet = observation.feet();
            }
        }

        if (!validWaypoint(waypointValidator, waypoint)) {
            if (waypointAdvanced) {
                return step(
                    Outcome.DRIVE,
                    waypoint,
                    false,
                    false,
                    false,
                    "route_invalidated_pending",
                    elapsedMs,
                    nowMs,
                    true,
                    false,
                    false
                );
            }
            return reject("route_invalidated", elapsedMs, nowMs);
        }
        if (!observation.onGround()
            && (stableFeet == null || waypoint.y() <= stableFeet.y())) {
            return reject("route_unexpected_airborne", elapsedMs, nowMs);
        }
        if (stableFeet != null
            && MiningWorkspaceStore.reversible(stableFeet, waypoint)
            && MiningWorkspaceTraversal.descending(stableFeet, waypoint)) {
            descentOrigin = stableFeet;
            descentLanding = waypoint;
            descentStartedAtMs = nowMs;
            descentPhase = DescentPhase.SELECTED;
            return step(
                Outcome.DRIVE,
                waypoint,
                true,
                false,
                false,
                "descent_selected",
                elapsedMs,
                nowMs,
                waypointAdvanced,
                false,
                false
            );
        }

        if (observation.onGround()
            && waypointIndex > 0
            && route.get(waypointIndex - 1).equals(observation.feet())) {
            observePreciseProgress(observation, waypoint, nowMs);
        }
        if (nowMs - lastProgressAtMs >= STALL_TIMEOUT_MS) {
            return reject(modeName() + "_stalled", elapsedMs, nowMs);
        }
        return step(
            Outcome.DRIVE,
            waypoint,
            false,
            true,
            false,
            "driving",
            elapsedMs,
            nowMs,
            waypointAdvanced,
            false,
            false
        );
    }

    Mode mode() {
        return mode;
    }

    boolean active() {
        return mode != Mode.NONE && !route.isEmpty();
    }

    List<VoxelCell> route() {
        return route;
    }

    long startedAtMs() {
        return startedAtMs;
    }

    long timeoutMs() {
        return route.isEmpty() ? 0L : MiningWorkspaceTraversal.timeoutMs(route.size());
    }

    int waypointIndex() {
        return active() ? waypointIndex : -1;
    }

    int remainingCells() {
        return active() ? Math.max(0, route.size() - waypointIndex) : 0;
    }

    VoxelCell activeWaypoint() {
        return active() && waypointIndex >= 0 && waypointIndex < route.size()
            ? route.get(waypointIndex)
            : null;
    }

    VoxelCell stableFeet() {
        return stableFeet;
    }

    long lastProgressAgeMs(long nowMs) {
        return active() ? Math.max(0L, nowMs - lastProgressAtMs) : 0L;
    }

    DescentPhase descentPhase() {
        return descentPhase;
    }

    RouteSnapshot routeSnapshot() {
        return new RouteSnapshot(
            mode,
            route,
            waypointIndex,
            activeWaypoint(),
            stableFeet,
            startedAtMs,
            deadlineAtMs,
            lastProgressAtMs,
            descentPhase
        );
    }

    long remainingDeadlineMs(long nowMs) {
        return active() ? Math.max(0L, deadlineAtMs - nowMs) : 0L;
    }

    Step waitForWaypointAvailability(long nowMs) {
        if (!active()) {
            return idleStep();
        }
        long elapsedMs = elapsedMs(nowMs);
        if (nowMs >= deadlineAtMs) {
            return reject(modeName() + "_timeout", elapsedMs, nowMs);
        }
        if (nowMs - lastProgressAtMs >= STALL_TIMEOUT_MS) {
            return reject(modeName() + "_stalled", elapsedMs, nowMs);
        }
        return step(
            Outcome.DRIVE,
            activeWaypoint(),
            false,
            false,
            false,
            "route_unavailable_pending",
            elapsedMs,
            nowMs,
            false,
            false,
            false
        );
    }

    boolean routeSuffixRepairEligible(RouteSnapshot expected, long nowMs) {
        return expected != null
            && active()
            && expected.equals(routeSnapshot())
            && descentPhase == DescentPhase.NONE
            && waypointIndex > 0
            && waypointIndex < route.size() - 1
            && nowMs < deadlineAtMs
            && nowMs - lastProgressAtMs < STALL_TIMEOUT_MS;
    }

    boolean canReplaceRoute(RouteSnapshot expected, List<VoxelCell> replacement) {
        if (expected == null
            || replacement == null
            || !active()
            || descentPhase != DescentPhase.NONE
            || !expected.equals(routeSnapshot())
            || waypointIndex <= 0
            || waypointIndex >= route.size()
            || waypointIndex >= replacement.size()
            || !MiningWorkspaceTraversal.reversibleRoute(replacement)
            || !route.get(route.size() - 1).equals(replacement.get(replacement.size() - 1))) {
            return false;
        }
        return route.subList(0, waypointIndex).equals(replacement.subList(0, waypointIndex));
    }

    boolean replaceRoute(RouteSnapshot expected, List<VoxelCell> replacement) {
        if (!canReplaceRoute(expected, replacement)) {
            return false;
        }
        replacePrevalidatedRoute(replacement);
        return true;
    }

    void replacePrevalidatedRoute(List<VoxelCell> replacement) {
        route = List.copyOf(replacement);
        bestPreciseDistance = Double.POSITIVE_INFINITY;
    }

    void clear() {
        mode = Mode.NONE;
        route = List.of();
        startedAtMs = 0L;
        deadlineAtMs = 0L;
        lastProgressAtMs = 0L;
        waypointIndex = -1;
        stableFeet = null;
        bestPreciseDistance = Double.POSITIVE_INFINITY;
        descentPhase = DescentPhase.NONE;
        descentOrigin = null;
        descentLanding = null;
        descentStartedAtMs = 0L;
    }

    private Step tickDescent(
        Observation observation,
        Predicate<VoxelCell> waypointValidator,
        long nowMs,
        long elapsedMs
    ) {
        if (descentPhase == DescentPhase.LANDED) {
            descentPhase = DescentPhase.NONE;
            descentOrigin = null;
            descentLanding = null;
            descentStartedAtMs = 0L;
            if (waypointIndex >= route.size()) {
                return arrive(elapsedMs, nowMs, false);
            }
            return tick(observation, waypointValidator, nowMs);
        }
        if (!validWaypoint(waypointValidator, descentLanding)) {
            return reject("route_invalidated", elapsedMs, nowMs);
        }
        if (nowMs - descentStartedAtMs >= DESCENT_TIMEOUT_MS) {
            return reject("descent_timeout", elapsedMs, nowMs);
        }
        if ((descentPhase == DescentPhase.LAUNCHING || descentPhase == DescentPhase.AIRBORNE)
            && observation.onGround()
            && observation.feet().equals(descentLanding)) {
            return landDescent(observation, nowMs, elapsedMs);
        }
        if (descentPhase == DescentPhase.SELECTED || descentPhase == DescentPhase.ALIGNING) {
            if (!observation.onGround() || !observation.feet().equals(descentOrigin)) {
                return reject("descent_departed_unaligned", elapsedMs, nowMs);
            }
            if (!observation.aligned()) {
                descentPhase = DescentPhase.ALIGNING;
                return descentStep(Outcome.DRIVE, false, false, "descent_aligning", elapsedMs, nowMs, false, false);
            }
            descentPhase = DescentPhase.LAUNCHING;
            return descentStep(Outcome.DRIVE, true, true, "descent_launching", elapsedMs, nowMs, true, false);
        }
        if (descentPhase == DescentPhase.LAUNCHING) {
            if (!observation.onGround()) {
                descentPhase = DescentPhase.AIRBORNE;
                return descentStep(Outcome.HOLD_DESCENT, true, true, "descent_airborne", elapsedMs, nowMs, false, false);
            }
            if (!observation.feet().equals(descentOrigin)
                && !isElevatedLandingColumn(observation.feet())) {
                return reject("descent_missed", elapsedMs, nowMs);
            }
            return descentStep(Outcome.DRIVE, true, true, "descent_launching", elapsedMs, nowMs, false, false);
        }
        if (descentPhase == DescentPhase.AIRBORNE) {
            if (!observation.onGround()) {
                return descentStep(Outcome.HOLD_DESCENT, true, true, "descent_airborne", elapsedMs, nowMs, false, false);
            }
            return reject("descent_missed", elapsedMs, nowMs);
        }
        return reject("descent_state_invalid", elapsedMs, nowMs);
    }

    private Step landDescent(Observation observation, long nowMs, long elapsedMs) {
        stableFeet = descentLanding;
        waypointIndex++;
        lastProgressAtMs = nowMs;
        bestPreciseDistance = Double.POSITIVE_INFINITY;
        descentPhase = DescentPhase.LANDED;
        return step(
            Outcome.DRIVE,
            descentLanding,
            true,
            false,
            false,
            "descent_landed",
            elapsedMs,
            nowMs,
            true,
            false,
            true
        );
    }

    private boolean isElevatedLandingColumn(VoxelCell feet) {
        return feet != null
            && descentOrigin != null
            && descentLanding != null
            && feet.x() == descentLanding.x()
            && feet.z() == descentLanding.z()
            && feet.y() == descentOrigin.y();
    }

    private static boolean isElevatedStepOriginColumn(
        VoxelCell feet,
        VoxelCell origin,
        VoxelCell waypoint
    ) {
        return feet != null
            && origin != null
            && waypoint != null
            && waypoint.y() == origin.y() + 1
            && Math.abs(waypoint.x() - origin.x()) + Math.abs(waypoint.z() - origin.z()) == 1
            && feet.x() == origin.x()
            && feet.z() == origin.z()
            && feet.y() == waypoint.y();
    }

    private boolean synchronizeForward(Observation observation, long nowMs) {
        if (!observation.onGround()) {
            return false;
        }
        int end = Math.min(route.size() - 1, waypointIndex + MAX_FORWARD_RESYNC_CELLS - 1);
        for (int index = Math.max(0, waypointIndex); index <= end; index++) {
            if (!route.get(index).equals(observation.feet())) {
                continue;
            }
            waypointIndex = index + 1;
            stableFeet = observation.feet();
            lastProgressAtMs = nowMs;
            bestPreciseDistance = Double.POSITIVE_INFINITY;
            return true;
        }
        return false;
    }

    private void observePreciseProgress(Observation observation, VoxelCell waypoint, long nowMs) {
        double distance = preciseDistance(observation, stableFeet, waypoint);
        if (Double.isInfinite(bestPreciseDistance)) {
            bestPreciseDistance = distance;
            return;
        }
        if (distance <= bestPreciseDistance - PRECISE_PROGRESS_BLOCKS) {
            bestPreciseDistance = distance;
            lastProgressAtMs = nowMs;
        }
    }

    private Step arrive(long elapsedMs, long nowMs, boolean waypointAdvanced) {
        Mode completedMode = mode;
        VoxelCell destination = route.get(route.size() - 1);
        Outcome outcome = completedMode == Mode.RETURN ? Outcome.RETURNED : Outcome.RESUMED;
        Step step = step(
            outcome,
            destination,
            false,
            false,
            false,
            "arrived",
            elapsedMs,
            nowMs,
            waypointAdvanced,
            false,
            false
        );
        clear();
        return step;
    }

    private Step reject(String reason, long elapsedMs, long nowMs) {
        Step step = step(
            Outcome.REJECTED,
            activeWaypoint(),
            descentPhase != DescentPhase.NONE,
            false,
            false,
            reason,
            elapsedMs,
            nowMs,
            false,
            false,
            false
        );
        clear();
        return step;
    }

    private Step descentStep(
        Outcome outcome,
        boolean forward,
        boolean exempt,
        String reason,
        long elapsedMs,
        long nowMs,
        boolean started,
        boolean landed
    ) {
        return step(
            outcome,
            descentLanding,
            true,
            forward,
            exempt,
            reason,
            elapsedMs,
            nowMs,
            false,
            started,
            landed
        );
    }

    private Step step(
        Outcome outcome,
        VoxelCell waypoint,
        boolean descending,
        boolean forward,
        boolean descentExempt,
        String reason,
        long elapsedMs,
        long nowMs,
        boolean waypointAdvanced,
        boolean descentStarted,
        boolean descentLanded
    ) {
        return new Step(
            outcome,
            waypoint,
            descending,
            forward,
            descentExempt,
            reason,
            elapsedMs,
            mode,
            waypointIndex,
            Math.max(0, route.size() - waypointIndex),
            stableFeet,
            Math.max(0L, nowMs - lastProgressAtMs),
            descentPhase,
            waypointAdvanced,
            descentStarted,
            descentLanded
        );
    }

    private static boolean validWaypoint(Predicate<VoxelCell> validator, VoxelCell waypoint) {
        return waypoint != null && validator != null && validator.test(waypoint);
    }

    private static double preciseDistance(
        Observation observation,
        VoxelCell origin,
        VoxelCell waypoint
    ) {
        if (origin != null && origin.x() != waypoint.x()) {
            return Math.abs(observation.x() - (waypoint.x() + 0.5D));
        }
        return Math.abs(observation.z() - (waypoint.z() + 0.5D));
    }

    private Step idleStep() {
        return new Step(
            Outcome.IDLE,
            null,
            false,
            false,
            false,
            "inactive",
            0L,
            Mode.NONE,
            -1,
            0,
            null,
            0L,
            DescentPhase.NONE,
            false,
            false,
            false
        );
    }

    private long elapsedMs(long nowMs) {
        return Math.max(0L, nowMs - startedAtMs);
    }

    private String modeName() {
        return mode.name().toLowerCase(Locale.ROOT);
    }
}
