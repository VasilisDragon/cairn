package com.mcbot.fabricclient;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

final class GatherTreeBreakStanceTraversalController {
    static final long STALL_TIMEOUT_MS = 4_000L;
    static final long DESCENT_TIMEOUT_MS = 3_000L;
    static final int MAX_FORWARD_RESYNC_CELLS = 8;
    static final double PRECISE_PROGRESS_BLOCKS = 0.05D;
    static final double DESCENT_LIP_DISTANCE_BLOCKS = 0.55D;

    enum Outcome {
        IDLE,
        DRIVE,
        HOLD_DESCENT,
        REACHED,
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
        boolean jump,
        boolean sneak,
        boolean descentExempt,
        String reason,
        long elapsedMs,
        long remainingDeadlineMs,
        int waypointIndex,
        int remainingCells,
        VoxelCell stableFeet,
        int maximumWaypointIndex,
        long lastProgressAgeMs,
        DescentPhase descentPhase,
        boolean waypointAdvanced,
        boolean forwardResynchronized,
        boolean descentStarted,
        boolean descentLanded
    ) {
    }

    private List<VoxelCell> route = List.of();
    private long startedAtMs;
    private long deadlineAtMs;
    private long lastProgressAtMs;
    private int waypointIndex = -1;
    private int maximumWaypointIndex = -1;
    private VoxelCell stableFeet;
    private double bestPreciseDistance = Double.POSITIVE_INFINITY;
    private DescentPhase descentPhase = DescentPhase.NONE;
    private VoxelCell descentOrigin;
    private VoxelCell descentLanding;
    private long descentSelectedAtMs;
    private long descentLandedAtMs;
    private VoxelCell stepUpOrigin;
    private VoxelCell stepUpLanding;

    boolean begin(
        List<VoxelCell> nextRoute,
        VoxelCell feet,
        long nowMs,
        long fixedDeadlineAtMs
    ) {
        if (!validRoute(nextRoute)
            || feet == null
            || !nextRoute.get(0).equals(feet)
            || fixedDeadlineAtMs <= nowMs) {
            return false;
        }
        route = List.copyOf(nextRoute);
        startedAtMs = nowMs;
        deadlineAtMs = fixedDeadlineAtMs;
        lastProgressAtMs = nowMs;
        waypointIndex = 1;
        maximumWaypointIndex = 0;
        stableFeet = feet;
        bestPreciseDistance = Double.POSITIVE_INFINITY;
        clearDescent();
        clearStepUp();
        return true;
    }

    Step tick(
        Observation observation,
        Predicate<VoxelCell> waypointValidator,
        long nowMs
    ) {
        if (!active() || observation == null || observation.feet() == null) {
            return idleStep();
        }
        long elapsedMs = Math.max(0L, nowMs - startedAtMs);
        if (descentPhase == DescentPhase.LANDED && finalLandingGraceAt(nowMs)) {
            return tickDescent(observation, waypointValidator, nowMs, elapsedMs);
        }
        if (nowMs >= deadlineAtMs) {
            return reject("break_stance_deadline", elapsedMs, nowMs);
        }
        if (descentPhase != DescentPhase.NONE) {
            return tickDescent(observation, waypointValidator, nowMs, elapsedMs);
        }

        Synchronization synchronization = synchronizeForward(observation, nowMs);
        if (waypointIndex >= route.size()) {
            if (!validWaypoint(waypointValidator, observation.feet())) {
                return reject("route_invalidated", elapsedMs, nowMs);
            }
            return reach(elapsedMs, nowMs, synchronization);
        }
        if (synchronization.advanced()
            && !validWaypoint(waypointValidator, observation.feet())) {
            return rejectAt("route_invalidated", observation.feet(), elapsedMs, nowMs);
        }
        if (synchronization.advanced()) {
            return step(
                Outcome.DRIVE,
                route.get(waypointIndex),
                false,
                false,
                false,
                false,
                false,
                "waypoint_advanced",
                elapsedMs,
                nowMs,
                synchronization,
                false,
                false
            );
        }

        VoxelCell waypoint = route.get(waypointIndex);
        if (!validWaypoint(waypointValidator, waypoint)) {
            return reject("route_invalidated", elapsedMs, nowMs);
        }
        VoxelCell edgeOrigin = route.get(waypointIndex - 1);
        int verticalDelta = waypoint.y() - edgeOrigin.y();
        boolean elevatedDescentLip = verticalDelta < 0
            && isElevatedLandingColumn(observation.feet(), edgeOrigin, waypoint);
        if (observation.onGround()
            && !elevatedDescentLip
            && !groundedObservationOnRoute(observation, waypoint)) {
            return reject("route_deviation", elapsedMs, nowMs);
        }
        if (observation.onGround()
            && !observation.feet().equals(stableFeet)
            && route.indexOf(observation.feet()) >= 0
            && route.indexOf(observation.feet()) < waypointIndex) {
            if (nowMs - lastProgressAtMs >= STALL_TIMEOUT_MS) {
                return reject("route_stalled", elapsedMs, nowMs);
            }
            return step(
                Outcome.DRIVE,
                waypoint,
                false,
                false,
                false,
                false,
                false,
                "earlier_cell_hold",
                elapsedMs,
                nowMs,
                synchronization,
                false,
                false
            );
        }

        if (verticalDelta < 0) {
            if (!observation.onGround()) {
                return reject("route_unexpected_airborne", elapsedMs, nowMs);
            }
            if (!atDescentLip(observation, edgeOrigin, waypoint)) {
                observePreciseProgress(observation, waypoint, nowMs);
                if (nowMs - lastProgressAtMs >= STALL_TIMEOUT_MS) {
                    return reject("route_stalled", elapsedMs, nowMs);
                }
                if (!observation.aligned()) {
                    return step(
                        Outcome.DRIVE,
                        waypoint,
                        true,
                        false,
                        false,
                        false,
                        false,
                        "descent_lip_aligning",
                        elapsedMs,
                        nowMs,
                        synchronization,
                        false,
                        false
                    );
                }
                return step(
                    Outcome.DRIVE,
                    waypoint,
                    true,
                    true,
                    false,
                    true,
                    false,
                    "descent_lip_staging",
                    elapsedMs,
                    nowMs,
                    synchronization,
                    false,
                    false
                );
            }
            descentOrigin = edgeOrigin;
            descentLanding = waypoint;
            descentSelectedAtMs = nowMs;
            descentPhase = DescentPhase.SELECTED;
            return step(
                Outcome.DRIVE,
                waypoint,
                true,
                false,
                false,
                true,
                false,
                "descent_selected",
                elapsedMs,
                nowMs,
                synchronization,
                false,
                false
            );
        }

        if (observation.onGround() && observation.feet().equals(stableFeet)) {
            observePreciseProgress(observation, waypoint, nowMs);
        }
        if (nowMs - lastProgressAtMs >= STALL_TIMEOUT_MS) {
            return reject("route_stalled", elapsedMs, nowMs);
        }

        boolean stepUp = verticalDelta > 0;
        if (stepUp) {
            if (stepUpLanding == null) {
                if (!observation.onGround()) {
                    return reject("route_unexpected_airborne", elapsedMs, nowMs);
                }
                if (!observation.aligned()) {
                    return step(
                        Outcome.DRIVE,
                        waypoint,
                        false,
                        false,
                        false,
                        false,
                        false,
                        "step_up_aligning",
                        elapsedMs,
                        nowMs,
                        synchronization,
                        false,
                        false
                    );
                }
                stepUpOrigin = edgeOrigin;
                stepUpLanding = waypoint;
            }
            if (!airborneOnActiveEdge(observation.feet(), stepUpOrigin, stepUpLanding)
                && !observation.feet().equals(stepUpLanding)) {
                return reject("route_deviation", elapsedMs, nowMs);
            }
            return step(
                Outcome.DRIVE,
                stepUpLanding,
                false,
                true,
                true,
                false,
                false,
                observation.onGround() ? "step_up_launching" : "step_up_airborne",
                elapsedMs,
                nowMs,
                synchronization,
                false,
                false
            );
        }
        if (!observation.onGround() && !airborneOnActiveEdge(observation.feet(), edgeOrigin, waypoint)) {
            return reject("route_unexpected_airborne", elapsedMs, nowMs);
        }
        if (!observation.aligned()) {
            return step(
                Outcome.DRIVE,
                waypoint,
                false,
                false,
                false,
                false,
                false,
                "aligning",
                elapsedMs,
                nowMs,
                synchronization,
                false,
                false
            );
        }
        boolean stageAtLip = waypointIndex + 1 < route.size()
            && route.get(waypointIndex + 1).y() < waypoint.y();
        return step(
            Outcome.DRIVE,
            waypoint,
            false,
            true,
            false,
            stageAtLip,
            false,
            "driving",
            elapsedMs,
            nowMs,
            synchronization,
            false,
            false
        );
    }

    boolean active() {
        return !route.isEmpty();
    }

    List<VoxelCell> route() {
        return route;
    }

    int waypointIndex() {
        return active() ? waypointIndex : -1;
    }

    VoxelCell activeWaypoint() {
        return active() && waypointIndex >= 0 && waypointIndex < route.size()
            ? route.get(waypointIndex)
            : null;
    }

    int remainingCells() {
        return active() ? Math.max(0, route.size() - waypointIndex) : 0;
    }

    VoxelCell stableFeet() {
        return stableFeet;
    }

    int maximumWaypointIndex() {
        return maximumWaypointIndex;
    }

    long lastProgressAgeMs(long nowMs) {
        return active() ? Math.max(0L, nowMs - lastProgressAtMs) : 0L;
    }

    long deadlineAtMs() {
        return deadlineAtMs;
    }

    long remainingDeadlineMs(long nowMs) {
        return active() ? Math.max(0L, deadlineAtMs - nowMs) : 0L;
    }

    DescentPhase descentPhase() {
        return descentPhase;
    }

    boolean finalLandingGraceAt(long nowMs) {
        return active()
            && descentPhase == DescentPhase.LANDED
            && waypointIndex >= route.size()
            && descentLandedAtMs < deadlineAtMs
            && nowMs == deadlineAtMs;
    }

    void clear() {
        route = List.of();
        startedAtMs = 0L;
        deadlineAtMs = 0L;
        lastProgressAtMs = 0L;
        waypointIndex = -1;
        maximumWaypointIndex = -1;
        stableFeet = null;
        bestPreciseDistance = Double.POSITIVE_INFINITY;
        clearDescent();
        clearStepUp();
    }

    private Step tickDescent(
        Observation observation,
        Predicate<VoxelCell> waypointValidator,
        long nowMs,
        long elapsedMs
    ) {
        if (descentPhase == DescentPhase.LANDED) {
            if (!observation.onGround()
                || !observation.feet().equals(descentLanding)
                || !validWaypoint(waypointValidator, descentLanding)) {
                return rejectAt(
                    "descent_landing_invalidated",
                    descentLanding,
                    elapsedMs,
                    nowMs
                );
            }
            clearDescent();
            if (waypointIndex >= route.size()) {
                return reach(elapsedMs, nowMs, Synchronization.NONE);
            }
            return step(
                Outcome.DRIVE,
                route.get(waypointIndex),
                false,
                false,
                false,
                false,
                false,
                "descent_landing_committed",
                elapsedMs,
                nowMs,
                Synchronization.NONE,
                false,
                false
            );
        }
        if (!validWaypoint(waypointValidator, descentLanding)) {
            return reject("route_invalidated", elapsedMs, nowMs);
        }
        if ((descentPhase == DescentPhase.LAUNCHING || descentPhase == DescentPhase.AIRBORNE)
            && observation.onGround()
            && observation.feet().equals(descentLanding)) {
            return landDescent(waypointIndex, false, nowMs, elapsedMs);
        }
        int forwardLandingIndex = forwardRouteIndex(observation);
        if ((descentPhase == DescentPhase.LAUNCHING || descentPhase == DescentPhase.AIRBORNE)
            && forwardLandingIndex > waypointIndex
            && validWaypoint(waypointValidator, observation.feet())) {
            return landDescent(forwardLandingIndex, true, nowMs, elapsedMs);
        }
        if (nowMs - descentSelectedAtMs >= DESCENT_TIMEOUT_MS) {
            return reject("descent_timeout", elapsedMs, nowMs);
        }
        if (descentPhase == DescentPhase.SELECTED) {
            if (!observation.onGround()
                || (!observation.feet().equals(descentOrigin)
                    && !isElevatedLandingColumn(observation.feet()))) {
                return reject("descent_departed_unaligned", elapsedMs, nowMs);
            }
            descentPhase = DescentPhase.ALIGNING;
            return step(
                Outcome.DRIVE,
                descentLanding,
                true,
                false,
                false,
                true,
                false,
                "descent_lip_settling",
                elapsedMs,
                nowMs,
                Synchronization.NONE,
                false,
                false
            );
        }
        if (descentPhase == DescentPhase.ALIGNING) {
            if (!observation.onGround()
                || (!observation.feet().equals(descentOrigin)
                    && !isElevatedLandingColumn(observation.feet()))) {
                return reject("descent_departed_unaligned", elapsedMs, nowMs);
            }
            if (!observation.aligned()) {
                return step(
                    Outcome.DRIVE,
                    descentLanding,
                    true,
                    false,
                    false,
                    true,
                    false,
                    "descent_aligning",
                    elapsedMs,
                    nowMs,
                    Synchronization.NONE,
                    false,
                    false
                );
            }
            descentPhase = DescentPhase.LAUNCHING;
            return descentStep(
                Outcome.DRIVE,
                true,
                true,
                "descent_launching",
                elapsedMs,
                nowMs,
                true,
                false
            );
        }
        if (descentPhase == DescentPhase.LAUNCHING) {
            if (!observation.onGround()) {
                descentPhase = DescentPhase.AIRBORNE;
                return descentStep(
                    Outcome.HOLD_DESCENT,
                    !sameHorizontalColumn(observation.feet(), descentLanding),
                    true,
                    sameHorizontalColumn(observation.feet(), descentLanding)
                        ? "descent_airborne_column_captured"
                        : "descent_airborne",
                    elapsedMs,
                    nowMs,
                    false,
                    false
                );
            }
            if (!observation.feet().equals(descentOrigin)
                && !isElevatedLandingColumn(observation.feet())) {
                return reject("descent_missed", elapsedMs, nowMs);
            }
            return descentStep(
                Outcome.DRIVE,
                false,
                true,
                "descent_launch_wait",
                elapsedMs,
                nowMs,
                false,
                false
            );
        }
        if (descentPhase == DescentPhase.AIRBORNE) {
            if (!observation.onGround()) {
                return descentStep(
                    Outcome.HOLD_DESCENT,
                    !sameHorizontalColumn(observation.feet(), descentLanding),
                    true,
                    sameHorizontalColumn(observation.feet(), descentLanding)
                        ? "descent_airborne_column_captured"
                        : "descent_airborne",
                    elapsedMs,
                    nowMs,
                    false,
                    false
                );
            }
            return reject("descent_missed", elapsedMs, nowMs);
        }
        return reject("descent_state_invalid", elapsedMs, nowMs);
    }

    private Step landDescent(
        int landedIndex,
        boolean forwardResynchronized,
        long nowMs,
        long elapsedMs
    ) {
        descentLanding = route.get(landedIndex);
        stableFeet = descentLanding;
        waypointIndex = landedIndex + 1;
        maximumWaypointIndex = Math.max(maximumWaypointIndex, landedIndex);
        lastProgressAtMs = nowMs;
        bestPreciseDistance = Double.POSITIVE_INFINITY;
        descentPhase = DescentPhase.LANDED;
        descentLandedAtMs = nowMs;
        return step(
            Outcome.DRIVE,
            descentLanding,
            true,
            false,
            false,
            false,
            false,
            forwardResynchronized
                ? "descent_landed_forward_resynchronized"
                : "descent_landed",
            elapsedMs,
            nowMs,
            new Synchronization(true, forwardResynchronized),
            false,
            true
        );
    }

    private Synchronization synchronizeForward(Observation observation, long nowMs) {
        if (!observation.onGround()) {
            return Synchronization.NONE;
        }
        int forwardIndex = forwardRouteIndex(observation);
        if (forwardIndex >= waypointIndex) {
            boolean forwardResynchronized = forwardIndex > waypointIndex;
            waypointIndex = forwardIndex + 1;
            maximumWaypointIndex = Math.max(maximumWaypointIndex, forwardIndex);
            stableFeet = observation.feet();
            lastProgressAtMs = nowMs;
            bestPreciseDistance = Double.POSITIVE_INFINITY;
            clearStepUp();
            return new Synchronization(true, forwardResynchronized);
        }
        return Synchronization.NONE;
    }

    private int forwardRouteIndex(Observation observation) {
        if (!observation.onGround()) {
            return -1;
        }
        int end = Math.min(route.size() - 1, waypointIndex + MAX_FORWARD_RESYNC_CELLS);
        for (int index = end; index >= waypointIndex; index--) {
            if (route.get(index).equals(observation.feet())) {
                return index;
            }
        }
        return -1;
    }

    private boolean groundedObservationOnRoute(Observation observation, VoxelCell waypoint) {
        if (isElevatedStepOriginColumn(observation.feet(), stableFeet, waypoint)) {
            return true;
        }
        int observedIndex = route.indexOf(observation.feet());
        return observedIndex >= 0 && observedIndex < waypointIndex;
    }

    private void observePreciseProgress(
        Observation observation,
        VoxelCell waypoint,
        long nowMs
    ) {
        double distance = alongEdgeDistance(observation, stableFeet, waypoint);
        if (Double.isInfinite(bestPreciseDistance)) {
            bestPreciseDistance = distance;
            return;
        }
        if (distance <= bestPreciseDistance - PRECISE_PROGRESS_BLOCKS) {
            bestPreciseDistance = distance;
            lastProgressAtMs = nowMs;
        }
    }

    private Step reach(long elapsedMs, long nowMs, Synchronization synchronization) {
        VoxelCell destination = route.get(route.size() - 1);
        Step result = step(
            Outcome.REACHED,
            destination,
            false,
            false,
            false,
            false,
            false,
            "reached",
            elapsedMs,
            nowMs,
            synchronization,
            false,
            false
        );
        clear();
        return result;
    }

    private Step reject(String reason, long elapsedMs, long nowMs) {
        return rejectAt(reason, activeWaypoint(), elapsedMs, nowMs);
    }

    private Step rejectAt(
        String reason,
        VoxelCell rejectedWaypoint,
        long elapsedMs,
        long nowMs
    ) {
        Step result = step(
            Outcome.REJECTED,
            rejectedWaypoint,
            descentPhase != DescentPhase.NONE,
            false,
            false,
            false,
            false,
            reason,
            elapsedMs,
            nowMs,
            Synchronization.NONE,
            false,
            false
        );
        clear();
        return result;
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
            false,
            false,
            exempt,
            reason,
            elapsedMs,
            nowMs,
            Synchronization.NONE,
            started,
            landed
        );
    }

    private Step step(
        Outcome outcome,
        VoxelCell waypoint,
        boolean descending,
        boolean forward,
        boolean jump,
        boolean sneak,
        boolean descentExempt,
        String reason,
        long elapsedMs,
        long nowMs,
        Synchronization synchronization,
        boolean descentStarted,
        boolean descentLanded
    ) {
        return new Step(
            outcome,
            waypoint,
            descending,
            forward,
            jump,
            sneak,
            descentExempt,
            reason,
            elapsedMs,
            Math.max(0L, deadlineAtMs - nowMs),
            waypointIndex,
            Math.max(0, route.size() - waypointIndex),
            stableFeet,
            maximumWaypointIndex,
            Math.max(0L, nowMs - lastProgressAtMs),
            descentPhase,
            synchronization.advanced(),
            synchronization.forwardResynchronized(),
            descentStarted,
            descentLanded
        );
    }

    private Step idleStep() {
        return new Step(
            Outcome.IDLE,
            null,
            false,
            false,
            false,
            false,
            false,
            "inactive",
            0L,
            0L,
            -1,
            0,
            null,
            -1,
            0L,
            DescentPhase.NONE,
            false,
            false,
            false,
            false
        );
    }

    private void clearDescent() {
        descentPhase = DescentPhase.NONE;
        descentOrigin = null;
        descentLanding = null;
        descentSelectedAtMs = 0L;
        descentLandedAtMs = 0L;
    }

    private void clearStepUp() {
        stepUpOrigin = null;
        stepUpLanding = null;
    }

    private boolean isElevatedLandingColumn(VoxelCell feet) {
        return isElevatedLandingColumn(feet, descentOrigin, descentLanding);
    }

    private static boolean isElevatedLandingColumn(
        VoxelCell feet,
        VoxelCell origin,
        VoxelCell landing
    ) {
        return feet != null
            && origin != null
            && landing != null
            && feet.x() == landing.x()
            && feet.z() == landing.z()
            && feet.y() == origin.y();
    }

    private static boolean sameHorizontalColumn(VoxelCell first, VoxelCell second) {
        return first != null
            && second != null
            && first.x() == second.x()
            && first.z() == second.z();
    }

    private static boolean atDescentLip(
        Observation observation,
        VoxelCell origin,
        VoxelCell landing
    ) {
        return isElevatedLandingColumn(observation.feet(), origin, landing)
            || alongEdgeDistance(observation, origin, landing)
                <= DESCENT_LIP_DISTANCE_BLOCKS;
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
            && horizontalDistance(origin, waypoint) == 1
            && feet.x() == origin.x()
            && feet.z() == origin.z()
            && feet.y() == waypoint.y();
    }

    private static boolean airborneOnActiveEdge(
        VoxelCell feet,
        VoxelCell origin,
        VoxelCell waypoint
    ) {
        if (feet == null || origin == null || waypoint == null) {
            return false;
        }
        boolean originColumn = feet.x() == origin.x() && feet.z() == origin.z();
        boolean waypointColumn = feet.x() == waypoint.x() && feet.z() == waypoint.z();
        int minimumY = Math.min(origin.y(), waypoint.y());
        int maximumY = waypoint.y() > origin.y() ? waypoint.y() : origin.y() + 1;
        return (originColumn || waypointColumn)
            && feet.y() >= minimumY
            && feet.y() <= maximumY;
    }

    private static double alongEdgeDistance(
        Observation observation,
        VoxelCell origin,
        VoxelCell waypoint
    ) {
        if (origin.x() != waypoint.x()) {
            return Math.abs(observation.x() - (waypoint.x() + 0.5D));
        }
        return Math.abs(observation.z() - (waypoint.z() + 0.5D));
    }

    private static boolean validWaypoint(
        Predicate<VoxelCell> validator,
        VoxelCell waypoint
    ) {
        return waypoint != null && validator != null && validator.test(waypoint);
    }

    private static boolean validRoute(List<VoxelCell> candidate) {
        if (candidate == null || candidate.isEmpty()) {
            return false;
        }
        Set<VoxelCell> unique = new HashSet<>();
        for (int index = 0; index < candidate.size(); index++) {
            VoxelCell cell = candidate.get(index);
            if (cell == null || !unique.add(cell)) {
                return false;
            }
            if (index == 0) {
                continue;
            }
            VoxelCell previous = candidate.get(index - 1);
            int verticalDelta = cell.y() - previous.y();
            if (horizontalDistance(previous, cell) != 1
                || verticalDelta > 1
                || verticalDelta < -3) {
                return false;
            }
        }
        return true;
    }

    private static int horizontalDistance(VoxelCell first, VoxelCell second) {
        return Math.abs(first.x() - second.x()) + Math.abs(first.z() - second.z());
    }

    private record Synchronization(boolean advanced, boolean forwardResynchronized) {
        private static final Synchronization NONE = new Synchronization(false, false);
    }
}
