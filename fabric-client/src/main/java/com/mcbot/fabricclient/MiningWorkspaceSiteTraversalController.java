package com.mcbot.fabricclient;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;

/**
 * Traverses the one-way route produced by {@link MiningWorkspacePlanner}.
 *
 * <p>This controller is intentionally separate from workspace breadcrumb traversal. Planner
 * routes may contain a validated one-to-three-block descent and therefore are not necessarily
 * reversible.</p>
 */
final class MiningWorkspaceSiteTraversalController {
    static final long STALL_TIMEOUT_MS = 4_000L;
    static final long DESCENT_TIMEOUT_MS = 3_000L;
    static final long STEP_UP_PULSE_MS = 150L;
    static final int MAX_FORWARD_RESYNC_CELLS = 8;
    static final double PRECISE_PROGRESS_BLOCKS = 0.05D;

    enum Outcome {
        IDLE,
        DRIVE,
        HOLD_DESCENT,
        REACHED,
        REJECTED
    }

    enum StepUpPhase {
        NONE,
        ALIGNING,
        PULSING,
        AIRBORNE,
        LANDED
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
        boolean aligned,
        boolean dry,
        boolean bodyClear,
        boolean stableSupport
    ) {
        static Observation centered(
            VoxelCell feet,
            boolean onGround,
            boolean aligned,
            boolean dry,
            boolean bodyClear,
            boolean stableSupport
        ) {
            return new Observation(
                feet,
                feet == null ? 0.0D : feet.x() + 0.5D,
                feet == null ? 0.0D : feet.y(),
                feet == null ? 0.0D : feet.z() + 0.5D,
                onGround,
                aligned,
                dry,
                bodyClear,
                stableSupport
            );
        }

        static Observation centered(VoxelCell feet, boolean onGround, boolean aligned) {
            return centered(feet, onGround, aligned, true, true, true);
        }
    }

    /**
     * A pure movement request. Callers must map {@code descentExempt} only to the existing
     * {@code _nav3d_descend} edge-guard exemption. This controller never requests sneak.
     */
    record Step(
        Outcome outcome,
        VoxelCell waypoint,
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
        StepUpPhase stepUpPhase,
        DescentPhase descentPhase,
        boolean waypointAdvanced,
        boolean forwardResynchronized,
        boolean stepUpStarted,
        boolean stepUpCompleted,
        boolean descentSelected,
        boolean descentStarted,
        boolean descentDeparted,
        boolean descentLanded,
        boolean stanceReached
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
    private int finalArrivalPolls;

    private StepUpPhase stepUpPhase = StepUpPhase.NONE;
    private VoxelCell stepUpOrigin;
    private VoxelCell stepUpLanding;
    private long stepUpPulseStartedAtMs;

    private DescentPhase descentPhase = DescentPhase.NONE;
    private VoxelCell descentOrigin;
    private VoxelCell descentLanding;
    private long descentSelectedAtMs;
    private boolean descentDepartureObserved;
    private int descentLandingPolls;

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
        finalArrivalPolls = 0;
        clearStepUp();
        clearDescent();
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
        if (nowMs >= deadlineAtMs) {
            return reject("workspace_site_timeout", elapsedMs, nowMs);
        }
        if (descentPhase != DescentPhase.NONE) {
            return tickDescent(observation, waypointValidator, nowMs, elapsedMs);
        }
        if (stepUpPhase != StepUpPhase.NONE) {
            return tickStepUp(observation, waypointValidator, nowMs, elapsedMs);
        }

        Synchronization synchronization = synchronizeForward(observation, waypointValidator, nowMs);
        if (waypointIndex >= route.size()) {
            return tickFinalArrival(observation, waypointValidator, synchronization, nowMs, elapsedMs);
        }
        if (synchronization.advanced()) {
            return stoppedStep(
                route.get(waypointIndex),
                synchronization.forwardResynchronized()
                    ? "forward_resynchronized"
                    : "waypoint_advanced",
                elapsedMs,
                nowMs,
                synchronization,
                false,
                false,
                false,
                false,
                false,
                false,
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
        if (!observation.onGround()) {
            return reject("route_unexpected_airborne", elapsedMs, nowMs);
        }
        if (!groundedObservationAtActiveEdgeOrigin(observation)) {
            return reject("route_deviation", elapsedMs, nowMs);
        }
        if (observation.feet().equals(stableFeet)) {
            observePreciseProgress(observation, waypoint, nowMs);
        }
        if (nowMs - lastProgressAtMs >= STALL_TIMEOUT_MS) {
            return reject("route_stalled", elapsedMs, nowMs);
        }

        if (verticalDelta < 0) {
            descentOrigin = edgeOrigin;
            descentLanding = waypoint;
            descentSelectedAtMs = nowMs;
            descentDepartureObserved = false;
            descentLandingPolls = 0;
            descentPhase = DescentPhase.SELECTED;
            return stoppedStep(
                waypoint,
                "descent_selected",
                elapsedMs,
                nowMs,
                Synchronization.NONE,
                false,
                false,
                true,
                false,
                false,
                false,
                false,
                false
            );
        }
        if (verticalDelta > 0) {
            stepUpOrigin = edgeOrigin;
            stepUpLanding = waypoint;
            stepUpPulseStartedAtMs = 0L;
            stepUpPhase = StepUpPhase.ALIGNING;
            return stoppedStep(
                waypoint,
                "step_up_selected",
                elapsedMs,
                nowMs,
                Synchronization.NONE,
                false,
                false,
                false,
                false,
                false,
                false,
                false,
                false
            );
        }
        if (!observation.aligned()) {
            return stoppedStep(
                waypoint,
                "aligning",
                elapsedMs,
                nowMs,
                Synchronization.NONE,
                false,
                false,
                false,
                false,
                false,
                false,
                false,
                false
            );
        }
        return driveStep(
            waypoint,
            true,
            false,
            false,
            "driving",
            elapsedMs,
            nowMs,
            Synchronization.NONE,
            false,
            false,
            false,
            false,
            false,
            false,
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

    long startedAtMs() {
        return startedAtMs;
    }

    long deadlineAtMs() {
        return deadlineAtMs;
    }

    long remainingDeadlineMs(long nowMs) {
        return active() ? Math.max(0L, deadlineAtMs - nowMs) : 0L;
    }

    long lastProgressAgeMs(long nowMs) {
        return active() ? Math.max(0L, nowMs - lastProgressAtMs) : 0L;
    }

    StepUpPhase stepUpPhase() {
        return stepUpPhase;
    }

    DescentPhase descentPhase() {
        return descentPhase;
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
        finalArrivalPolls = 0;
        clearStepUp();
        clearDescent();
    }

    private Step tickStepUp(
        Observation observation,
        Predicate<VoxelCell> waypointValidator,
        long nowMs,
        long elapsedMs
    ) {
        if (!validWaypoint(waypointValidator, stepUpLanding)) {
            return reject("route_invalidated", elapsedMs, nowMs);
        }
        if (safeGroundedAt(observation, stepUpLanding, waypointValidator)) {
            return completeStepUp(nowMs, elapsedMs);
        }
        if (nowMs - lastProgressAtMs >= STALL_TIMEOUT_MS) {
            return reject("route_stalled", elapsedMs, nowMs);
        }
        if (stepUpPhase == StepUpPhase.ALIGNING) {
            if (!safeAtStepUpOrigin(observation)) {
                return reject("route_deviation", elapsedMs, nowMs);
            }
            if (!observation.aligned()) {
                return stoppedStep(
                    stepUpLanding,
                    "step_up_aligning",
                    elapsedMs,
                    nowMs,
                    Synchronization.NONE,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false
                );
            }
            stepUpPhase = StepUpPhase.PULSING;
            stepUpPulseStartedAtMs = nowMs;
            return driveStep(
                stepUpLanding,
                true,
                true,
                false,
                "step_up_pulse",
                elapsedMs,
                nowMs,
                Synchronization.NONE,
                true,
                false,
                false,
                false,
                false,
                false,
                false,
                false
            );
        }
        if (stepUpPhase == StepUpPhase.PULSING) {
            if (!observation.onGround()) {
                stepUpPhase = StepUpPhase.AIRBORNE;
                return driveStep(
                    stepUpLanding,
                    true,
                    false,
                    false,
                    "step_up_airborne",
                    elapsedMs,
                    nowMs,
                    Synchronization.NONE,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false
                );
            }
            if (!safeAtStepUpOrigin(observation)) {
                return reject("route_deviation", elapsedMs, nowMs);
            }
            boolean pulseActive = nowMs - stepUpPulseStartedAtMs < STEP_UP_PULSE_MS;
            return driveStep(
                stepUpLanding,
                true,
                pulseActive,
                false,
                pulseActive ? "step_up_pulse" : "step_up_pulse_completed",
                elapsedMs,
                nowMs,
                Synchronization.NONE,
                false,
                false,
                false,
                false,
                false,
                false,
                false,
                false
            );
        }
        if (stepUpPhase == StepUpPhase.AIRBORNE) {
            if (observation.onGround()) {
                return reject("step_up_missed", elapsedMs, nowMs);
            }
            if (!airborneOnActiveEdge(observation.feet(), stepUpOrigin, stepUpLanding)) {
                return reject("route_deviation", elapsedMs, nowMs);
            }
            return driveStep(
                stepUpLanding,
                true,
                false,
                false,
                "step_up_airborne",
                elapsedMs,
                nowMs,
                Synchronization.NONE,
                false,
                false,
                false,
                false,
                false,
                false,
                false,
                false
            );
        }
        return reject("step_up_state_invalid", elapsedMs, nowMs);
    }

    private Step completeStepUp(long nowMs, long elapsedMs) {
        stableFeet = stepUpLanding;
        waypointIndex++;
        maximumWaypointIndex = Math.max(maximumWaypointIndex, waypointIndex - 1);
        lastProgressAtMs = nowMs;
        bestPreciseDistance = Double.POSITIVE_INFINITY;
        if (waypointIndex >= route.size()) {
            finalArrivalPolls = 1;
        }
        VoxelCell landed = stepUpLanding;
        clearStepUp();
        return stoppedStep(
            landed,
            "step_up_landed",
            elapsedMs,
            nowMs,
            new Synchronization(true, false),
            false,
            true,
            false,
            false,
            false,
            false,
            false,
            false
        );
    }

    private Step tickDescent(
        Observation observation,
        Predicate<VoxelCell> waypointValidator,
        long nowMs,
        long elapsedMs
    ) {
        boolean landingValid = validWaypoint(waypointValidator, descentLanding);
        if (!landingValid && !descentDepartureObserved) {
            return reject("route_invalidated", elapsedMs, nowMs);
        }
        if (nowMs - descentSelectedAtMs >= DESCENT_TIMEOUT_MS) {
            return reject("descent_timeout", elapsedMs, nowMs);
        }
        if (!landingValid && descentDepartureObserved) {
            if (!observation.onGround()) {
                descentPhase = DescentPhase.AIRBORNE;
                return descentDriveStep(
                    Outcome.HOLD_DESCENT,
                    true,
                    "descent_airborne_landing_invalidated",
                    elapsedMs,
                    nowMs,
                    false,
                    false,
                    false
                );
            }
            return reject("descent_missed", elapsedMs, nowMs);
        }
        if (descentPhase == DescentPhase.LANDED) {
            if (!safeGroundedAt(observation, descentLanding, waypointValidator)) {
                return reject("descent_landing_invalidated", elapsedMs, nowMs);
            }
            clearDescent();
            if (waypointIndex >= route.size()) {
                return reach(elapsedMs, nowMs, true);
            }
            return stoppedStep(
                route.get(waypointIndex),
                "descent_landing_committed",
                elapsedMs,
                nowMs,
                Synchronization.NONE,
                false,
                false,
                false,
                false,
                false,
                false,
                false,
                false
            );
        }
        if (observation.onGround()
            && descentLanding.equals(observation.feet())
            && !safeGroundedAt(observation, descentLanding, waypointValidator)) {
            return reject("descent_landing_invalidated", elapsedMs, nowMs);
        }
        if (safeGroundedAt(observation, descentLanding, waypointValidator)) {
            boolean departureNow = markDescentDeparted();
            descentLandingPolls++;
            if (descentLandingPolls < 2) {
                return stoppedStep(
                    descentLanding,
                    "descent_landing_settling",
                    elapsedMs,
                    nowMs,
                    Synchronization.NONE,
                    false,
                    false,
                    false,
                    false,
                    departureNow,
                    false,
                    false,
                    false
                );
            }
            return completeDescent(nowMs, elapsedMs, departureNow);
        }
        descentLandingPolls = 0;

        if (descentPhase == DescentPhase.SELECTED) {
            if (!safeAtDescentOrigin(observation)) {
                return reject("descent_departed_unaligned", elapsedMs, nowMs);
            }
            descentPhase = DescentPhase.ALIGNING;
            return stoppedStep(
                descentLanding,
                "descent_aligning",
                elapsedMs,
                nowMs,
                Synchronization.NONE,
                false,
                false,
                false,
                false,
                false,
                false,
                false,
                false
            );
        }
        if (descentPhase == DescentPhase.ALIGNING) {
            if (!safeAtDescentOrigin(observation)) {
                return reject("descent_departed_unaligned", elapsedMs, nowMs);
            }
            if (!observation.aligned()) {
                return stoppedStep(
                    descentLanding,
                    "descent_aligning",
                    elapsedMs,
                    nowMs,
                    Synchronization.NONE,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false
                );
            }
            descentPhase = DescentPhase.LAUNCHING;
            return descentDriveStep(
                Outcome.DRIVE,
                true,
                "descent_launching",
                elapsedMs,
                nowMs,
                true,
                false,
                false
            );
        }
        if (descentPhase == DescentPhase.LAUNCHING) {
            if (!observation.onGround()) {
                boolean departureNow = markDescentDeparted();
                descentPhase = DescentPhase.AIRBORNE;
                return descentDriveStep(
                    Outcome.HOLD_DESCENT,
                    true,
                    "descent_airborne",
                    elapsedMs,
                    nowMs,
                    false,
                    departureNow,
                    false
                );
            }
            if (observation.feet().equals(descentOrigin)) {
                return descentDriveStep(
                    Outcome.DRIVE,
                    true,
                    "descent_launching",
                    elapsedMs,
                    nowMs,
                    false,
                    false,
                    false
                );
            }
            if (isElevatedLandingColumn(observation.feet())) {
                boolean departureNow = markDescentDeparted();
                return descentDriveStep(
                    Outcome.DRIVE,
                    true,
                    "descent_launching_departed",
                    elapsedMs,
                    nowMs,
                    false,
                    departureNow,
                    false
                );
            }
            markDescentDeparted();
            return reject("descent_missed", elapsedMs, nowMs);
        }
        if (descentPhase == DescentPhase.AIRBORNE) {
            if (!observation.onGround()) {
                return descentDriveStep(
                    Outcome.HOLD_DESCENT,
                    true,
                    "descent_airborne",
                    elapsedMs,
                    nowMs,
                    false,
                    false,
                    false
                );
            }
            return reject("descent_missed", elapsedMs, nowMs);
        }
        return reject("descent_state_invalid", elapsedMs, nowMs);
    }

    private Step completeDescent(long nowMs, long elapsedMs, boolean departureNow) {
        stableFeet = descentLanding;
        waypointIndex++;
        maximumWaypointIndex = Math.max(maximumWaypointIndex, waypointIndex - 1);
        lastProgressAtMs = nowMs;
        bestPreciseDistance = Double.POSITIVE_INFINITY;
        if (waypointIndex >= route.size()) {
            finalArrivalPolls = 2;
        }
        descentPhase = DescentPhase.LANDED;
        return stoppedStep(
            descentLanding,
            "descent_landed",
            elapsedMs,
            nowMs,
            new Synchronization(true, false),
            false,
            false,
            false,
            false,
            departureNow,
            true,
            false,
            false
        );
    }

    private Step tickFinalArrival(
        Observation observation,
        Predicate<VoxelCell> waypointValidator,
        Synchronization synchronization,
        long nowMs,
        long elapsedMs
    ) {
        VoxelCell destination = route.get(route.size() - 1);
        if (!safeGroundedAt(observation, destination, waypointValidator)) {
            finalArrivalPolls = 0;
            return reject("final_stance_invalid", elapsedMs, nowMs);
        }
        finalArrivalPolls++;
        if (finalArrivalPolls < 2) {
            return stoppedStep(
                destination,
                "final_stance_settling",
                elapsedMs,
                nowMs,
                synchronization,
                false,
                false,
                false,
                false,
                false,
                false,
                false,
                false
            );
        }
        return reach(elapsedMs, nowMs, true);
    }

    private Synchronization synchronizeForward(
        Observation observation,
        Predicate<VoxelCell> waypointValidator,
        long nowMs
    ) {
        if (!safeGrounded(observation) || waypointIndex >= route.size()) {
            return Synchronization.NONE;
        }
        int end = Math.min(route.size() - 1, waypointIndex + MAX_FORWARD_RESYNC_CELLS);
        for (int index = end; index >= waypointIndex; index--) {
            if (!route.get(index).equals(observation.feet())
                || !validWaypoint(waypointValidator, observation.feet())) {
                continue;
            }
            boolean forwardResynchronized = index > waypointIndex;
            waypointIndex = index + 1;
            maximumWaypointIndex = Math.max(maximumWaypointIndex, index);
            stableFeet = observation.feet();
            lastProgressAtMs = nowMs;
            bestPreciseDistance = Double.POSITIVE_INFINITY;
            finalArrivalPolls = 0;
            return new Synchronization(true, forwardResynchronized);
        }
        return Synchronization.NONE;
    }

    private boolean groundedObservationAtActiveEdgeOrigin(Observation observation) {
        return safeGrounded(observation)
            && stableFeet != null
            && stableFeet.equals(observation.feet());
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

    private Step reach(long elapsedMs, long nowMs, boolean stanceReached) {
        VoxelCell destination = route.get(route.size() - 1);
        Step result = stoppedStep(
            destination,
            "reached",
            elapsedMs,
            nowMs,
            Synchronization.NONE,
            false,
            false,
            false,
            false,
            false,
            false,
            stanceReached,
            false
        );
        result = new Step(
            Outcome.REACHED,
            result.waypoint(),
            result.forward(),
            result.jump(),
            result.sneak(),
            result.descentExempt(),
            result.reason(),
            result.elapsedMs(),
            result.remainingDeadlineMs(),
            result.waypointIndex(),
            result.remainingCells(),
            result.stableFeet(),
            result.maximumWaypointIndex(),
            result.lastProgressAgeMs(),
            result.stepUpPhase(),
            result.descentPhase(),
            result.waypointAdvanced(),
            result.forwardResynchronized(),
            result.stepUpStarted(),
            result.stepUpCompleted(),
            result.descentSelected(),
            result.descentStarted(),
            result.descentDeparted(),
            result.descentLanded(),
            result.stanceReached()
        );
        clear();
        return result;
    }

    private Step reject(String reason, long elapsedMs, long nowMs) {
        Step result = new Step(
            Outcome.REJECTED,
            activeWaypoint(),
            false,
            false,
            false,
            false,
            reason,
            elapsedMs,
            Math.max(0L, deadlineAtMs - nowMs),
            waypointIndex,
            Math.max(0, route.size() - waypointIndex),
            stableFeet,
            maximumWaypointIndex,
            Math.max(0L, nowMs - lastProgressAtMs),
            stepUpPhase,
            descentPhase,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false
        );
        clear();
        return result;
    }

    private Step descentDriveStep(
        Outcome outcome,
        boolean forward,
        String reason,
        long elapsedMs,
        long nowMs,
        boolean descentStarted,
        boolean descentDeparted,
        boolean descentLanded
    ) {
        return buildStep(
            outcome,
            descentLanding,
            forward,
            false,
            true,
            reason,
            elapsedMs,
            nowMs,
            Synchronization.NONE,
            false,
            false,
            false,
            descentStarted,
            descentDeparted,
            descentLanded,
            false
        );
    }

    private Step driveStep(
        VoxelCell waypoint,
        boolean forward,
        boolean jump,
        boolean descentExempt,
        String reason,
        long elapsedMs,
        long nowMs,
        Synchronization synchronization,
        boolean stepUpStarted,
        boolean stepUpCompleted,
        boolean descentSelected,
        boolean descentStarted,
        boolean descentDeparted,
        boolean descentLanded,
        boolean stanceReached,
        boolean ignored
    ) {
        return buildStep(
            Outcome.DRIVE,
            waypoint,
            forward,
            jump,
            descentExempt,
            reason,
            elapsedMs,
            nowMs,
            synchronization,
            stepUpStarted,
            stepUpCompleted,
            descentSelected,
            descentStarted,
            descentDeparted,
            descentLanded,
            stanceReached
        );
    }

    private Step stoppedStep(
        VoxelCell waypoint,
        String reason,
        long elapsedMs,
        long nowMs,
        Synchronization synchronization,
        boolean stepUpStarted,
        boolean stepUpCompleted,
        boolean descentSelected,
        boolean descentStarted,
        boolean descentDeparted,
        boolean descentLanded,
        boolean stanceReached,
        boolean ignored
    ) {
        return buildStep(
            Outcome.DRIVE,
            waypoint,
            false,
            false,
            false,
            reason,
            elapsedMs,
            nowMs,
            synchronization,
            stepUpStarted,
            stepUpCompleted,
            descentSelected,
            descentStarted,
            descentDeparted,
            descentLanded,
            stanceReached
        );
    }

    private Step buildStep(
        Outcome outcome,
        VoxelCell waypoint,
        boolean forward,
        boolean jump,
        boolean descentExempt,
        String reason,
        long elapsedMs,
        long nowMs,
        Synchronization synchronization,
        boolean stepUpStarted,
        boolean stepUpCompleted,
        boolean descentSelected,
        boolean descentStarted,
        boolean descentDeparted,
        boolean descentLanded,
        boolean stanceReached
    ) {
        return new Step(
            outcome,
            waypoint,
            forward,
            jump,
            false,
            descentExempt,
            reason,
            elapsedMs,
            Math.max(0L, deadlineAtMs - nowMs),
            waypointIndex,
            Math.max(0, route.size() - waypointIndex),
            stableFeet,
            maximumWaypointIndex,
            Math.max(0L, nowMs - lastProgressAtMs),
            stepUpPhase,
            descentPhase,
            synchronization.advanced(),
            synchronization.forwardResynchronized(),
            stepUpStarted,
            stepUpCompleted,
            descentSelected,
            descentStarted,
            descentDeparted,
            descentLanded,
            stanceReached
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
            "inactive",
            0L,
            0L,
            -1,
            0,
            null,
            -1,
            0L,
            StepUpPhase.NONE,
            DescentPhase.NONE,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false
        );
    }

    private boolean safeAtStepUpOrigin(Observation observation) {
        return safeGrounded(observation)
            && (observation.feet().equals(stepUpOrigin)
                || isElevatedOriginColumn(observation.feet(), stepUpOrigin, stepUpLanding));
    }

    private boolean safeAtDescentOrigin(Observation observation) {
        return safeGrounded(observation)
            && (observation.feet().equals(descentOrigin)
                || isElevatedLandingColumn(observation.feet()));
    }

    private boolean markDescentDeparted() {
        if (descentDepartureObserved) {
            return false;
        }
        descentDepartureObserved = true;
        return true;
    }

    private boolean isElevatedLandingColumn(VoxelCell feet) {
        return feet != null
            && descentOrigin != null
            && descentLanding != null
            && feet.x() == descentLanding.x()
            && feet.z() == descentLanding.z()
            && feet.y() == descentOrigin.y();
    }

    private static boolean isElevatedOriginColumn(
        VoxelCell feet,
        VoxelCell origin,
        VoxelCell landing
    ) {
        return feet != null
            && origin != null
            && landing != null
            && feet.x() == origin.x()
            && feet.z() == origin.z()
            && feet.y() == landing.y();
    }

    private static boolean airborneOnActiveEdge(
        VoxelCell feet,
        VoxelCell origin,
        VoxelCell landing
    ) {
        if (feet == null || origin == null || landing == null) {
            return false;
        }
        boolean originColumn = feet.x() == origin.x() && feet.z() == origin.z();
        boolean landingColumn = feet.x() == landing.x() && feet.z() == landing.z();
        return (originColumn || landingColumn)
            && feet.y() >= Math.min(origin.y(), landing.y())
            && feet.y() <= Math.max(origin.y(), landing.y()) + 1;
    }

    private static boolean safeGroundedAt(
        Observation observation,
        VoxelCell expected,
        Predicate<VoxelCell> waypointValidator
    ) {
        return observation != null
            && expected != null
            && expected.equals(observation.feet())
            && safeGrounded(observation)
            && validWaypoint(waypointValidator, expected);
    }

    private static boolean safeGrounded(Observation observation) {
        return observation != null
            && observation.onGround()
            && observation.dry()
            && observation.bodyClear()
            && observation.stableSupport();
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

    private void clearStepUp() {
        stepUpPhase = StepUpPhase.NONE;
        stepUpOrigin = null;
        stepUpLanding = null;
        stepUpPulseStartedAtMs = 0L;
    }

    private void clearDescent() {
        descentPhase = DescentPhase.NONE;
        descentOrigin = null;
        descentLanding = null;
        descentSelectedAtMs = 0L;
        descentDepartureObserved = false;
        descentLandingPolls = 0;
    }

    private record Synchronization(boolean advanced, boolean forwardResynchronized) {
        private static final Synchronization NONE = new Synchronization(false, false);
    }
}
