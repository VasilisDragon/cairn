package com.mcbot.fabricclient;

import java.util.List;
import java.util.function.Predicate;

final class ReturnStaircaseTraversalController {
    static final long STALL_TIMEOUT_MS = 4_000L;
    static final long TRANSITION_TIMEOUT_MS = 3_000L;
    static final long JUMP_PULSE_MS = 150L;
    static final int MAX_FORWARD_RESYNC_CELLS = 8;
    static final double PRECISE_PROGRESS_BLOCKS = 0.05D;
    static final int REQUIRED_SAFE_POLLS = 2;

    enum Outcome {
        IDLE,
        DRIVE,
        HOLD,
        ARRIVED,
        HANDOFF_REQUIRED,
        REJECTED
    }

    enum TransitionKind {
        NONE,
        STEP_UP,
        DESCENT
    }

    enum TransitionPhase {
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
        boolean dry,
        boolean stable,
        boolean aligned,
        boolean lipTransientSafe
    ) {
        Observation(
            VoxelCell feet,
            double x,
            double y,
            double z,
            boolean onGround,
            boolean dry,
            boolean stable,
            boolean aligned
        ) {
            this(feet, x, y, z, onGround, dry, stable, aligned, false);
        }

        static Observation centered(
            VoxelCell feet,
            boolean onGround,
            boolean dry,
            boolean stable,
            boolean aligned
        ) {
            return new Observation(
                feet,
                feet == null ? 0.0D : feet.x() + 0.5D,
                feet == null ? 0.0D : feet.y(),
                feet == null ? 0.0D : feet.z() + 0.5D,
                onGround,
                dry,
                stable,
                aligned,
                false
            );
        }

        boolean safeGrounded() {
            return feet != null && onGround && dry && stable;
        }
    }

    record Step(
        Outcome outcome,
        VoxelCell waypoint,
        boolean forward,
        boolean jump,
        boolean descentExempt,
        String reason,
        long elapsedMs,
        long remainingDeadlineMs,
        int waypointIndex,
        int maximumWaypointIndex,
        int remainingCells,
        VoxelCell stableFeet,
        long lastProgressAgeMs,
        TransitionKind transitionKind,
        TransitionPhase transitionPhase,
        int safeArrivalPolls,
        boolean waypointAdvanced,
        boolean forwardResynchronized,
        boolean preciseProgress,
        boolean transitionStarted,
        boolean transitionLanded
    ) {
        boolean stopped() {
            return !forward && !jump;
        }
    }

    record RouteSnapshot(
        List<VoxelCell> route,
        int waypointIndex,
        int maximumWaypointIndex,
        VoxelCell activeWaypoint,
        VoxelCell stableFeet,
        long startedAtMs,
        long deadlineAtMs,
        long lastProgressAtMs,
        TransitionKind transitionKind,
        TransitionPhase transitionPhase
    ) {
        RouteSnapshot {
            route = route == null ? List.of() : List.copyOf(route);
        }
    }

    private List<VoxelCell> route = List.of();
    private boolean active;
    private boolean handoffIssued;
    private long startedAtMs;
    private long deadlineAtMs;
    private long lastProgressAtMs;
    private int waypointIndex = -1;
    private int maximumWaypointIndex = -1;
    private VoxelCell stableFeet;
    private double bestAlongProgress;
    private VoxelCell arrivalCandidate;
    private int arrivalCandidateIndex = -1;
    private int safeArrivalPolls;
    private TransitionKind transitionKind = TransitionKind.NONE;
    private TransitionPhase transitionPhase = TransitionPhase.NONE;
    private VoxelCell transitionOrigin;
    private VoxelCell transitionLanding;
    private long transitionStartedAtMs;
    private long launchStartedAtMs;
    private boolean stepUpRelaunchUsed;

    boolean begin(
        List<VoxelCell> frozenCurrentToSurfaceRoute,
        VoxelCell currentFeet,
        long nowMs,
        long hardDeadlineAtMs
    ) {
        if (active
            || handoffIssued
            || frozenCurrentToSurfaceRoute == null
            || frozenCurrentToSurfaceRoute.isEmpty()
            || currentFeet == null
            || hardDeadlineAtMs <= nowMs
            || !frozenCurrentToSurfaceRoute.get(0).equals(currentFeet)
            || !MiningWorkspaceTraversal.reversibleRoute(frozenCurrentToSurfaceRoute)) {
            return false;
        }
        route = List.copyOf(frozenCurrentToSurfaceRoute);
        active = true;
        startedAtMs = nowMs;
        deadlineAtMs = hardDeadlineAtMs;
        lastProgressAtMs = nowMs;
        waypointIndex = 1;
        maximumWaypointIndex = 0;
        stableFeet = currentFeet;
        bestAlongProgress = 0.0D;
        clearArrivalLatch();
        clearTransition();
        return true;
    }

    Step tick(
        Observation observation,
        Predicate<VoxelCell> waypointValidator,
        long nowMs
    ) {
        if (!active) {
            return idleStep();
        }
        if (nowMs >= deadlineAtMs) {
            return reject("hard_deadline", nowMs);
        }
        if (observation == null || observation.feet() == null || waypointValidator == null) {
            return handoff("observation_missing", nowMs);
        }
        if (transitionPhase != TransitionPhase.NONE) {
            return tickTransition(observation, waypointValidator, nowMs);
        }
        if (waypointIndex >= route.size()) {
            return tickExhaustedRoute(observation, waypointValidator, nowMs);
        }

        VoxelCell waypoint = route.get(waypointIndex);
        if (!waypointValidator.test(waypoint)) {
            return handoff("route_invalidated", nowMs);
        }

        int observedForwardIndex = safeForwardIndex(observation, waypointValidator);
        if (observedForwardIndex >= waypointIndex) {
            return observeArrival(observation, observedForwardIndex, nowMs, false);
        }
        resetArrivalIfMoved(observation.feet());

        if (!observation.dry() || (observation.onGround() && !observation.stable())) {
            return handoff("unsafe_observation", nowMs);
        }
        if (!observation.onGround()) {
            if (nowMs - lastProgressAtMs >= STALL_TIMEOUT_MS) {
                return handoff("waypoint_stalled", nowMs);
            }
            return step(Outcome.HOLD, waypoint, false, false, false,
                "awaiting_ground", nowMs, false, false, false, false, false);
        }

        if (!observation.feet().equals(stableFeet)) {
            return handoff("route_deviation", nowMs);
        }

        int verticalDelta = waypoint.y() - stableFeet.y();
        if (observation.feet().equals(stableFeet) && Math.abs(verticalDelta) == 1) {
            selectTransition(verticalDelta > 0 ? TransitionKind.STEP_UP : TransitionKind.DESCENT,
                stableFeet, waypoint, nowMs);
            return step(Outcome.HOLD, waypoint, false, false, false,
                transitionReason("selected"), nowMs, false, false, false, false, false);
        }

        boolean preciseProgress = false;
        if (observation.safeGrounded() && observation.feet().equals(stableFeet)) {
            preciseProgress = observePreciseProgress(observation, waypoint, nowMs);
        }
        if (nowMs - lastProgressAtMs >= STALL_TIMEOUT_MS) {
            return handoff("waypoint_stalled", nowMs);
        }
        return step(Outcome.DRIVE, waypoint, true, false, false,
            preciseProgress ? "along_edge_progress" : "driving",
            nowMs, false, false, preciseProgress, false, false);
    }

    boolean active() {
        return active;
    }

    boolean handoffIssued() {
        return handoffIssued;
    }

    List<VoxelCell> route() {
        return route;
    }

    int waypointIndex() {
        return active ? waypointIndex : -1;
    }

    int maximumWaypointIndex() {
        return maximumWaypointIndex;
    }

    VoxelCell activeWaypoint() {
        return active && waypointIndex >= 0 && waypointIndex < route.size()
            ? route.get(waypointIndex)
            : null;
    }

    VoxelCell stableFeet() {
        return stableFeet;
    }

    long startedAtMs() {
        return startedAtMs;
    }

    long deadlineAtMs() {
        return deadlineAtMs;
    }

    long remainingDeadlineMs(long nowMs) {
        return active ? Math.max(0L, deadlineAtMs - nowMs) : 0L;
    }

    long lastProgressAgeMs(long nowMs) {
        return active ? Math.max(0L, nowMs - lastProgressAtMs) : 0L;
    }

    TransitionKind transitionKind() {
        return transitionKind;
    }

    TransitionPhase transitionPhase() {
        return transitionPhase;
    }

    RouteSnapshot routeSnapshot() {
        return new RouteSnapshot(
            route,
            waypointIndex,
            maximumWaypointIndex,
            activeWaypoint(),
            stableFeet,
            startedAtMs,
            deadlineAtMs,
            lastProgressAtMs,
            transitionKind,
            transitionPhase
        );
    }

    boolean routeSuffixRepairEligible(RouteSnapshot expected, long nowMs) {
        return expected != null
            && active
            && expected.equals(routeSnapshot())
            && transitionKind == TransitionKind.NONE
            && transitionPhase == TransitionPhase.NONE
            && waypointIndex > 0
            && waypointIndex < route.size() - 1
            && stableFeet != null
            && route.get(waypointIndex - 1).equals(stableFeet)
            && nowMs < deadlineAtMs
            && nowMs - lastProgressAtMs < STALL_TIMEOUT_MS;
    }

    boolean canReplaceRoute(RouteSnapshot expected, List<VoxelCell> replacement) {
        if (expected == null
            || replacement == null
            || !active
            || transitionKind != TransitionKind.NONE
            || transitionPhase != TransitionPhase.NONE
            || !expected.equals(routeSnapshot())
            || waypointIndex <= 0
            || waypointIndex >= route.size()
            || waypointIndex >= replacement.size()
            || stableFeet == null
            || !route.get(waypointIndex - 1).equals(stableFeet)
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
        bestAlongProgress = 0.0D;
        clearArrivalLatch();
    }

    void clear() {
        active = false;
        handoffIssued = false;
        route = List.of();
        startedAtMs = 0L;
        deadlineAtMs = 0L;
        lastProgressAtMs = 0L;
        waypointIndex = -1;
        maximumWaypointIndex = -1;
        stableFeet = null;
        bestAlongProgress = 0.0D;
        clearArrivalLatch();
        clearTransition();
    }

    private Step tickExhaustedRoute(
        Observation observation,
        Predicate<VoxelCell> waypointValidator,
        long nowMs
    ) {
        VoxelCell destination = route.get(route.size() - 1);
        if (!waypointValidator.test(destination)) {
            return handoff("route_invalidated", nowMs);
        }
        if (!observation.feet().equals(destination)) {
            return handoff("route_exhausted_away_from_destination", nowMs);
        }
        return observeArrival(observation, route.size() - 1, nowMs, true);
    }

    private int safeForwardIndex(
        Observation observation,
        Predicate<VoxelCell> waypointValidator
    ) {
        if (!observation.safeGrounded()) {
            return -1;
        }
        int end = Math.min(route.size() - 1, waypointIndex + MAX_FORWARD_RESYNC_CELLS - 1);
        for (int index = waypointIndex; index <= end; index++) {
            if (route.get(index).equals(observation.feet()) && waypointValidator.test(route.get(index))) {
                return index;
            }
        }
        return -1;
    }

    private Step observeArrival(
        Observation observation,
        int observedIndex,
        long nowMs,
        boolean exhaustedAtStart
    ) {
        if (!observation.safeGrounded()) {
            clearArrivalLatch();
            return step(Outcome.HOLD, route.get(observedIndex), false, false, false,
                "arrival_not_stable", nowMs, false, false, false, false, false);
        }
        if (arrivalCandidateIndex != observedIndex || !observation.feet().equals(arrivalCandidate)) {
            arrivalCandidate = observation.feet();
            arrivalCandidateIndex = observedIndex;
            safeArrivalPolls = 1;
            return step(Outcome.HOLD, route.get(observedIndex), false, false, false,
                exhaustedAtStart ? "route_exhausted_confirming" : "arrival_confirming",
                nowMs, false, false, false, false, false);
        }
        safeArrivalPolls++;
        if (safeArrivalPolls < REQUIRED_SAFE_POLLS) {
            return step(Outcome.HOLD, route.get(observedIndex), false, false, false,
                "arrival_confirming", nowMs, false, false, false, false, false);
        }
        return advanceTo(observedIndex, nowMs, observedIndex > waypointIndex);
    }

    private Step advanceTo(int observedIndex, long nowMs, boolean forwardResynchronized) {
        stableFeet = route.get(observedIndex);
        waypointIndex = observedIndex + 1;
        maximumWaypointIndex = Math.max(maximumWaypointIndex, observedIndex);
        lastProgressAtMs = nowMs;
        bestAlongProgress = 0.0D;
        clearArrivalLatch();
        clearTransition();
        if (waypointIndex >= route.size()) {
            Step arrived = step(Outcome.ARRIVED, stableFeet, false, false, false,
                "route_exhausted_at_destination", nowMs, true,
                forwardResynchronized, false, false, false);
            deactivate(false);
            return arrived;
        }
        return step(Outcome.HOLD, route.get(waypointIndex), false, false, false,
            forwardResynchronized ? "forward_resynchronized" : "waypoint_reached",
            nowMs, true, forwardResynchronized, false, false, false);
    }

    private void selectTransition(
        TransitionKind kind,
        VoxelCell origin,
        VoxelCell landing,
        long nowMs
    ) {
        transitionKind = kind;
        transitionPhase = TransitionPhase.SELECTED;
        transitionOrigin = origin;
        transitionLanding = landing;
        transitionStartedAtMs = nowMs;
        launchStartedAtMs = 0L;
        stepUpRelaunchUsed = false;
        clearArrivalLatch();
    }

    private Step tickTransition(
        Observation observation,
        Predicate<VoxelCell> waypointValidator,
        long nowMs
    ) {
        if (!waypointValidator.test(transitionLanding)) {
            return handoff("route_invalidated", nowMs);
        }
        if (nowMs - transitionStartedAtMs >= TRANSITION_TIMEOUT_MS) {
            return handoff(transitionReason("timeout"), nowMs);
        }
        if (!observation.dry()) {
            return handoff(transitionReason("wet"), nowMs);
        }
        if (transitionPhase == TransitionPhase.LANDED) {
            if (!observation.safeGrounded() || !observation.feet().equals(transitionLanding)) {
                return handoff(transitionReason("landing_lost"), nowMs);
            }
            safeArrivalPolls++;
            if (safeArrivalPolls < REQUIRED_SAFE_POLLS) {
                return transitionStep(Outcome.HOLD, false, false,
                    transitionReason("landing_confirming"), nowMs, false, false);
            }
            return advanceTransitionLanding(nowMs);
        }

        if (observation.safeGrounded() && observation.feet().equals(transitionLanding)) {
            transitionPhase = TransitionPhase.LANDED;
            arrivalCandidate = transitionLanding;
            arrivalCandidateIndex = waypointIndex;
            safeArrivalPolls = 1;
            return transitionStep(Outcome.HOLD, false, false,
                transitionReason("landed"), nowMs, false, true);
        }

        if (transitionPhase == TransitionPhase.SELECTED
            || transitionPhase == TransitionPhase.ALIGNING) {
            if (!observation.safeGrounded() || !observation.feet().equals(transitionOrigin)) {
                return handoff(transitionReason("departed_unaligned"), nowMs);
            }
            if (!observation.aligned()) {
                transitionPhase = TransitionPhase.ALIGNING;
                return transitionStep(Outcome.HOLD, false, false,
                    transitionReason("aligning"), nowMs, false, false);
            }
            transitionPhase = TransitionPhase.LAUNCHING;
            launchStartedAtMs = nowMs;
            return transitionStep(Outcome.DRIVE, true, transitionKind == TransitionKind.STEP_UP,
                transitionReason("launching"), nowMs, true, false);
        }

        if (transitionPhase == TransitionPhase.LAUNCHING) {
            if (!observation.onGround()) {
                transitionPhase = TransitionPhase.AIRBORNE;
                return transitionStep(Outcome.DRIVE, true, false,
                    transitionReason("airborne"), nowMs, false, false);
            }
            if (!atLaunchColumn(observation.feet())) {
                return handoff(transitionReason("missed"), nowMs);
            }
            boolean jump = transitionKind == TransitionKind.STEP_UP
                && nowMs - launchStartedAtMs < JUMP_PULSE_MS;
            return transitionStep(Outcome.DRIVE, true, jump,
                transitionReason("launching"), nowMs, false, false);
        }

        if (transitionPhase == TransitionPhase.AIRBORNE) {
            if (!observation.onGround()) {
                return transitionStep(Outcome.DRIVE, true, false,
                    transitionReason("airborne"), nowMs, false, false);
            }
            if (transitionKind == TransitionKind.STEP_UP
                && observation.safeGrounded()
                && observation.feet().equals(transitionOrigin)
                && !stepUpRelaunchUsed) {
                // A one-tick hop can return to the exact verified origin before forward momentum
                // clears the lip. Stop, realign, and permit one more bounded pulse without moving
                // either the transition or command deadline. Any second return still fails closed.
                stepUpRelaunchUsed = true;
                transitionPhase = TransitionPhase.SELECTED;
                launchStartedAtMs = 0L;
                return transitionStep(Outcome.HOLD, false, false,
                    transitionReason("relaunch_selected"), nowMs, false, false);
            }
            if (transitionKind == TransitionKind.STEP_UP
                && observation.onGround()
                && observation.dry()
                && !observation.stable()
                && observation.lipTransientSafe()
                && isElevatedOriginColumn(observation.feet())) {
                // The client can report a grounded elevated-origin column for several ticks while
                // forward momentum finishes crossing the step lip. The frozen transition deadline
                // remains authoritative; an arbitrary lateral landing is still rejected at once.
                return transitionStep(Outcome.DRIVE, true, false,
                    transitionReason("settling"), nowMs, false, false);
            }
            return handoff(transitionReason("missed"), nowMs);
        }
        return handoff("transition_state_invalid", nowMs);
    }

    private boolean isElevatedOriginColumn(VoxelCell feet) {
        return feet != null
            && transitionOrigin != null
            && transitionLanding != null
            && feet.x() == transitionOrigin.x()
            && feet.z() == transitionOrigin.z()
            && feet.y() == transitionLanding.y();
    }

    private Step advanceTransitionLanding(long nowMs) {
        int landedIndex = waypointIndex;
        TransitionKind completedKind = transitionKind;
        stableFeet = transitionLanding;
        waypointIndex++;
        maximumWaypointIndex = Math.max(maximumWaypointIndex, landedIndex);
        lastProgressAtMs = nowMs;
        bestAlongProgress = 0.0D;
        clearArrivalLatch();
        clearTransition();
        if (waypointIndex >= route.size()) {
            Step arrived = step(Outcome.ARRIVED, stableFeet, false, false, false,
                "route_exhausted_at_destination", nowMs, true, false,
                false, false, true, completedKind, TransitionPhase.LANDED);
            deactivate(false);
            return arrived;
        }
        return step(Outcome.HOLD, route.get(waypointIndex), false, false, false,
            "transition_landed", nowMs, true, false,
            false, false, true, completedKind, TransitionPhase.LANDED);
    }

    private boolean atLaunchColumn(VoxelCell feet) {
        if (feet == null || transitionOrigin == null || transitionLanding == null) {
            return false;
        }
        if (feet.equals(transitionOrigin)) {
            return true;
        }
        if (transitionKind == TransitionKind.STEP_UP) {
            return feet.x() == transitionOrigin.x()
                && feet.z() == transitionOrigin.z()
                && feet.y() == transitionLanding.y();
        }
        return feet.x() == transitionLanding.x()
            && feet.z() == transitionLanding.z()
            && feet.y() == transitionOrigin.y();
    }

    private boolean observePreciseProgress(
        Observation observation,
        VoxelCell waypoint,
        long nowMs
    ) {
        int dx = waypoint.x() - stableFeet.x();
        int dz = waypoint.z() - stableFeet.z();
        if (Math.abs(dx) + Math.abs(dz) != 1) {
            return false;
        }
        double along = (observation.x() - (stableFeet.x() + 0.5D)) * dx
            + (observation.z() - (stableFeet.z() + 0.5D)) * dz;
        if (along < bestAlongProgress + PRECISE_PROGRESS_BLOCKS) {
            return false;
        }
        bestAlongProgress = along;
        lastProgressAtMs = nowMs;
        return true;
    }

    private void resetArrivalIfMoved(VoxelCell feet) {
        if (arrivalCandidate != null && !arrivalCandidate.equals(feet)) {
            clearArrivalLatch();
        }
    }

    private Step handoff(String reason, long nowMs) {
        if (handoffIssued) {
            return reject("handoff_already_issued", nowMs);
        }
        handoffIssued = true;
        Step step = step(Outcome.HANDOFF_REQUIRED, activeWaypoint(), false, false, false,
            reason, nowMs, false, false, false, false, false);
        deactivate(true);
        return step;
    }

    private Step reject(String reason, long nowMs) {
        Step step = step(Outcome.REJECTED, activeWaypoint(), false, false, false,
            reason, nowMs, false, false, false, false, false);
        deactivate(handoffIssued);
        return step;
    }

    private Step transitionStep(
        Outcome outcome,
        boolean forward,
        boolean jump,
        String reason,
        long nowMs,
        boolean transitionStarted,
        boolean transitionLanded
    ) {
        return step(outcome, transitionLanding, forward, jump,
            transitionKind == TransitionKind.DESCENT
                && (transitionPhase == TransitionPhase.LAUNCHING
                    || transitionPhase == TransitionPhase.AIRBORNE),
            reason, nowMs, false, false, false, transitionStarted, transitionLanded);
    }

    private Step step(
        Outcome outcome,
        VoxelCell waypoint,
        boolean forward,
        boolean jump,
        boolean descentExempt,
        String reason,
        long nowMs,
        boolean waypointAdvanced,
        boolean forwardResynchronized,
        boolean preciseProgress,
        boolean transitionStarted,
        boolean transitionLanded
    ) {
        return step(outcome, waypoint, forward, jump, descentExempt, reason, nowMs,
            waypointAdvanced, forwardResynchronized, preciseProgress,
            transitionStarted, transitionLanded, transitionKind, transitionPhase);
    }

    private Step step(
        Outcome outcome,
        VoxelCell waypoint,
        boolean forward,
        boolean jump,
        boolean descentExempt,
        String reason,
        long nowMs,
        boolean waypointAdvanced,
        boolean forwardResynchronized,
        boolean preciseProgress,
        boolean transitionStarted,
        boolean transitionLanded,
        TransitionKind reportedKind,
        TransitionPhase reportedPhase
    ) {
        return new Step(
            outcome,
            waypoint,
            forward,
            jump,
            descentExempt,
            reason,
            Math.max(0L, nowMs - startedAtMs),
            Math.max(0L, deadlineAtMs - nowMs),
            waypointIndex,
            maximumWaypointIndex,
            Math.max(0, route.size() - waypointIndex),
            stableFeet,
            Math.max(0L, nowMs - lastProgressAtMs),
            reportedKind,
            reportedPhase,
            safeArrivalPolls,
            waypointAdvanced,
            forwardResynchronized,
            preciseProgress,
            transitionStarted,
            transitionLanded
        );
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
            0L,
            -1,
            maximumWaypointIndex,
            0,
            null,
            0L,
            TransitionKind.NONE,
            TransitionPhase.NONE,
            0,
            false,
            false,
            false,
            false,
            false
        );
    }

    private String transitionReason(String suffix) {
        return (transitionKind == TransitionKind.STEP_UP ? "step_up_" : "descent_") + suffix;
    }

    private void clearArrivalLatch() {
        arrivalCandidate = null;
        arrivalCandidateIndex = -1;
        safeArrivalPolls = 0;
    }

    private void clearTransition() {
        transitionKind = TransitionKind.NONE;
        transitionPhase = TransitionPhase.NONE;
        transitionOrigin = null;
        transitionLanding = null;
        transitionStartedAtMs = 0L;
        launchStartedAtMs = 0L;
        stepUpRelaunchUsed = false;
    }

    private void deactivate(boolean preserveHandoff) {
        active = false;
        route = List.of();
        waypointIndex = -1;
        stableFeet = null;
        bestAlongProgress = 0.0D;
        clearArrivalLatch();
        clearTransition();
        if (!preserveHandoff) {
            handoffIssued = false;
        }
    }
}
