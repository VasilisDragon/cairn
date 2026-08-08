package com.mcbot.fabricclient;

import java.util.List;
import java.util.function.Predicate;

/**
 * Stage-specific wrapper around the proven break-stance traversal motor.
 *
 * <p>The wrapper deliberately owns no movement policy. It adds only the
 * frontier lifecycle and the stopped handoff required before the caller runs
 * the one permitted same-target planner computation.</p>
 */
final class GatherTreeReachableSeedFrontierController {
    static final int MAX_ROUTE_CELLS = 32;

    enum Outcome {
        IDLE,
        DRIVE,
        HOLD_DESCENT,
        REACHED,
        HOLD_AT_FRONTIER,
        READY_TO_REPLAN,
        REJECTED
    }

    enum Phase {
        IDLE,
        TRAVERSING,
        REACHED,
        STOPPED,
        READY_TO_REPLAN,
        REJECTED
    }

    record Step(
        Outcome outcome,
        Phase phase,
        GatherTreeBreakStanceTraversalController.Outcome motorOutcome,
        VoxelCell waypoint,
        boolean descending,
        boolean forward,
        boolean jump,
        boolean sneak,
        boolean descentExempt,
        String reason,
        String motorReason,
        long elapsedMs,
        long remainingDeadlineMs,
        int waypointIndex,
        int remainingCells,
        VoxelCell stableFeet,
        int maximumWaypointIndex,
        long lastProgressAgeMs,
        GatherTreeBreakStanceTraversalController.DescentPhase descentPhase,
        boolean waypointAdvanced,
        boolean forwardResynchronized,
        boolean descentStarted,
        boolean descentLanded,
        int stoppedTicksAfterReach
    ) {
        boolean stopped() {
            return !forward && !jump && !sneak;
        }
    }

    private final GatherTreeBreakStanceTraversalController traversal =
        new GatherTreeBreakStanceTraversalController();

    private Phase phase = Phase.IDLE;
    private List<VoxelCell> route = List.of();
    private VoxelCell frontier;
    private long startedAtMs;
    private long deadlineAtMs;
    private long reachedAtMs;
    private int stoppedTicksAfterReach;
    private GatherTreeBreakStanceTraversalController.Step reachedStep;

    boolean begin(
        List<VoxelCell> nextRoute,
        VoxelCell feet,
        long nowMs,
        long fixedDeadlineAtMs
    ) {
        if (phase != Phase.IDLE
            || nextRoute == null
            || nextRoute.size() < 2
            || nextRoute.size() > MAX_ROUTE_CELLS
            || !traversal.begin(nextRoute, feet, nowMs, fixedDeadlineAtMs)) {
            return false;
        }
        route = List.copyOf(nextRoute);
        frontier = route.get(route.size() - 1);
        startedAtMs = nowMs;
        deadlineAtMs = fixedDeadlineAtMs;
        reachedAtMs = 0L;
        stoppedTicksAfterReach = 0;
        reachedStep = null;
        phase = Phase.TRAVERSING;
        return true;
    }

    Step tick(
        GatherTreeBreakStanceTraversalController.Observation observation,
        Predicate<VoxelCell> waypointValidator,
        long nowMs
    ) {
        if (phase == Phase.IDLE
            || phase == Phase.READY_TO_REPLAN
            || phase == Phase.REJECTED) {
            return idleStep();
        }
        if (phase == Phase.REACHED || phase == Phase.STOPPED) {
            return tickReached(observation, waypointValidator, nowMs);
        }

        GatherTreeBreakStanceTraversalController.Step motorStep =
            traversal.tick(observation, waypointValidator, nowMs);
        return switch (motorStep.outcome()) {
            case IDLE -> idleStep();
            case DRIVE -> fromMotor(Outcome.DRIVE, Phase.TRAVERSING, motorStep,
                motorStep.reason(), nowMs);
            case HOLD_DESCENT -> fromMotor(
                Outcome.HOLD_DESCENT,
                Phase.TRAVERSING,
                motorStep,
                motorStep.reason(),
                nowMs
            );
            case REACHED -> reached(motorStep, nowMs);
            case REJECTED -> reject(
                "break_stance_deadline".equals(motorStep.reason())
                    ? "frontier_deadline"
                    : motorStep.reason(),
                motorStep,
                nowMs
            );
        };
    }

    boolean active() {
        return phase == Phase.TRAVERSING
            || phase == Phase.REACHED
            || phase == Phase.STOPPED;
    }

    boolean readyToReplan() {
        return phase == Phase.READY_TO_REPLAN;
    }

    Phase phase() {
        return phase;
    }

    List<VoxelCell> route() {
        return route;
    }

    VoxelCell frontier() {
        return frontier;
    }

    int waypointIndex() {
        if (phase == Phase.TRAVERSING) {
            return traversal.waypointIndex();
        }
        return reachedStep == null ? -1 : reachedStep.waypointIndex();
    }

    VoxelCell activeWaypoint() {
        if (phase == Phase.TRAVERSING) {
            return traversal.activeWaypoint();
        }
        return active() ? frontier : null;
    }

    int remainingCells() {
        return phase == Phase.TRAVERSING ? traversal.remainingCells() : 0;
    }

    VoxelCell stableFeet() {
        if (phase == Phase.TRAVERSING) {
            return traversal.stableFeet();
        }
        return reachedStep == null ? null : reachedStep.stableFeet();
    }

    int maximumWaypointIndex() {
        if (phase == Phase.TRAVERSING) {
            return traversal.maximumWaypointIndex();
        }
        return reachedStep == null ? -1 : reachedStep.maximumWaypointIndex();
    }

    long lastProgressAgeMs(long nowMs) {
        if (phase == Phase.TRAVERSING) {
            return traversal.lastProgressAgeMs(nowMs);
        }
        if (reachedStep == null) {
            return 0L;
        }
        return reachedStep.lastProgressAgeMs() + Math.max(0L, nowMs - reachedAtMs);
    }

    long deadlineAtMs() {
        return deadlineAtMs;
    }

    long remainingDeadlineMs(long nowMs) {
        return phase == Phase.IDLE
            ? 0L
            : Math.max(0L, deadlineAtMs - nowMs);
    }

    GatherTreeBreakStanceTraversalController.DescentPhase descentPhase() {
        return phase == Phase.TRAVERSING
            ? traversal.descentPhase()
            : GatherTreeBreakStanceTraversalController.DescentPhase.NONE;
    }

    void clear() {
        traversal.clear();
        phase = Phase.IDLE;
        route = List.of();
        frontier = null;
        startedAtMs = 0L;
        deadlineAtMs = 0L;
        reachedAtMs = 0L;
        stoppedTicksAfterReach = 0;
        reachedStep = null;
    }

    private Step reached(
        GatherTreeBreakStanceTraversalController.Step motorStep,
        long nowMs
    ) {
        reachedStep = motorStep;
        reachedAtMs = nowMs;
        stoppedTicksAfterReach = 0;
        phase = Phase.REACHED;
        return fromMotor(
            Outcome.REACHED,
            phase,
            motorStep,
            "frontier_reached",
            nowMs
        );
    }

    private Step tickReached(
        GatherTreeBreakStanceTraversalController.Observation observation,
        Predicate<VoxelCell> waypointValidator,
        long nowMs
    ) {
        if (nowMs >= deadlineAtMs) {
            return reject("frontier_deadline", reachedStep, nowMs);
        }
        if (observation == null
            || observation.feet() == null
            || !observation.onGround()
            || !frontier.equals(observation.feet())) {
            return reject("frontier_departed_after_reach", reachedStep, nowMs);
        }
        if (waypointValidator == null || !waypointValidator.test(frontier)) {
            return reject("frontier_invalidated_after_reach", reachedStep, nowMs);
        }
        if (phase == Phase.REACHED) {
            stoppedTicksAfterReach = 1;
            phase = Phase.STOPPED;
            return syntheticStep(
                Outcome.HOLD_AT_FRONTIER,
                "frontier_stop_tick",
                nowMs
            );
        }
        phase = Phase.READY_TO_REPLAN;
        return syntheticStep(
            Outcome.READY_TO_REPLAN,
            "frontier_ready_to_replan",
            nowMs
        );
    }

    private Step reject(
        String reason,
        GatherTreeBreakStanceTraversalController.Step motorStep,
        long nowMs
    ) {
        traversal.clear();
        phase = Phase.REJECTED;
        GatherTreeBreakStanceTraversalController.Step diagnostics = motorStep == null
            ? reachedStep
            : motorStep;
        if (diagnostics == null) {
            return new Step(
                Outcome.REJECTED,
                phase,
                GatherTreeBreakStanceTraversalController.Outcome.REJECTED,
                frontier,
                false,
                false,
                false,
                false,
                false,
                reason,
                reason,
                Math.max(0L, nowMs - startedAtMs),
                Math.max(0L, deadlineAtMs - nowMs),
                -1,
                0,
                null,
                -1,
                0L,
                GatherTreeBreakStanceTraversalController.DescentPhase.NONE,
                false,
                false,
                false,
                false,
                stoppedTicksAfterReach
            );
        }
        return fromMotor(Outcome.REJECTED, phase, diagnostics, reason, nowMs);
    }

    private Step syntheticStep(Outcome outcome, String reason, long nowMs) {
        GatherTreeBreakStanceTraversalController.Step diagnostics = reachedStep;
        return new Step(
            outcome,
            phase,
            diagnostics == null
                ? GatherTreeBreakStanceTraversalController.Outcome.IDLE
                : diagnostics.outcome(),
            frontier,
            false,
            false,
            false,
            false,
            false,
            reason,
            diagnostics == null ? "" : diagnostics.reason(),
            Math.max(0L, nowMs - startedAtMs),
            Math.max(0L, deadlineAtMs - nowMs),
            diagnostics == null ? -1 : diagnostics.waypointIndex(),
            0,
            frontier,
            diagnostics == null ? -1 : diagnostics.maximumWaypointIndex(),
            lastProgressAgeMs(nowMs),
            GatherTreeBreakStanceTraversalController.DescentPhase.NONE,
            false,
            false,
            false,
            false,
            stoppedTicksAfterReach
        );
    }

    private Step fromMotor(
        Outcome outcome,
        Phase nextPhase,
        GatherTreeBreakStanceTraversalController.Step motorStep,
        String reason,
        long nowMs
    ) {
        return new Step(
            outcome,
            nextPhase,
            motorStep.outcome(),
            motorStep.waypoint(),
            motorStep.descending(),
            motorStep.forward(),
            motorStep.jump(),
            motorStep.sneak(),
            motorStep.descentExempt(),
            reason,
            motorStep.reason(),
            Math.max(0L, nowMs - startedAtMs),
            Math.max(0L, deadlineAtMs - nowMs),
            motorStep.waypointIndex(),
            motorStep.remainingCells(),
            motorStep.stableFeet(),
            motorStep.maximumWaypointIndex(),
            motorStep.lastProgressAgeMs(),
            motorStep.descentPhase(),
            motorStep.waypointAdvanced(),
            motorStep.forwardResynchronized(),
            motorStep.descentStarted(),
            motorStep.descentLanded(),
            stoppedTicksAfterReach
        );
    }

    private Step idleStep() {
        return new Step(
            Outcome.IDLE,
            phase,
            GatherTreeBreakStanceTraversalController.Outcome.IDLE,
            null,
            false,
            false,
            false,
            false,
            false,
            "inactive",
            "inactive",
            0L,
            0L,
            -1,
            0,
            null,
            -1,
            0L,
            GatherTreeBreakStanceTraversalController.DescentPhase.NONE,
            false,
            false,
            false,
            false,
            stoppedTicksAfterReach
        );
    }
}
