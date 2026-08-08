package com.mcbot.fabricclient;

import java.util.List;
import net.minecraft.util.math.BlockPos;

/**
 * Command-scoped ownership for the single reachable-seed frontier allowance.
 *
 * <p>The session deliberately does not plan or move. It freezes the first
 * planner outcome, proves the stage made real progress at the exact frontier,
 * accounts for the stopped handoff tick, and reserves the second and final
 * planner computation before the caller invokes the singleton search.</p>
 */
final class GatherTreeReachableSeedFrontierSession {
    static final int MAX_PLANNER_COMPUTATIONS = 2;
    static final int STAGE_EPISODE = 1;

    enum Phase {
        UNUSED,
        TRAVERSING,
        HOLDING_AT_FRONTIER,
        READY_TO_REPLAN,
        REPLANNING,
        FINAL_ROUTE_READY,
        REJECTED
    }

    record Transition(boolean accepted, Phase phase, String reason) {
        Transition {
            reason = reason == null ? "" : reason;
        }
    }

    record ReplanPermit(
        String commandId,
        BlockPos target,
        long candidateFingerprint,
        VoxelCell start,
        int computation,
        int stageEpisode,
        GatherTreeLivenessPolicy.BreakStanceEpisode breakStanceEpisode
    ) {
        ReplanPermit {
            commandId = commandId == null ? "" : commandId;
            target = target == null ? null : target.toImmutable();
        }
    }

    record ReplanReservation(Transition transition, ReplanPermit permit) {
        boolean granted() {
            return transition != null && transition.accepted() && permit != null;
        }
    }

    record ReplanResolution(
        Transition transition,
        GatherTreeReachableSeedPlanner.Plan plan
    ) {
        boolean accepted() {
            return transition != null && transition.accepted() && plan != null;
        }
    }

    private static final double DISTANCE_EPSILON = 1.0E-9D;

    private String commandId;

    private Phase phase = Phase.UNUSED;
    private boolean stageUsed;
    private boolean active;
    private BlockPos target;
    private long candidateFingerprint;
    private VoxelCell origin;
    private VoxelCell frontier;
    private List<VoxelCell> stageRoute = List.of();
    private int stageRouteLength;
    private int expandedCells;
    private double startDistance = Double.NaN;
    private double plannedRemainingDistance = Double.NaN;
    private double actualRemainingDistance = Double.NaN;
    private double actualNetProgress;
    private int plannerComputations;
    private int stoppedHoldTicks;
    private GatherTreeLivenessPolicy.BreakStanceEpisode breakStanceEpisode;
    private ReplanPermit activePermit;
    private GatherTreeReachableSeedPlanner.Plan finalPlan;
    private String rejectionReason = "";

    GatherTreeReachableSeedFrontierSession() {
        this.commandId = null;
    }

    GatherTreeReachableSeedFrontierSession(String commandId) {
        this.commandId = commandId == null ? "" : commandId;
    }

    Transition beginStage(
        String incomingCommandId,
        long fingerprint,
        GatherTreeReachableSeedPlanner.FrontierPlan plan,
        GatherTreeLivenessPolicy.BreakStanceEpisode episode,
        long nowMs
    ) {
        bindCommandIfNeeded(incomingCommandId);
        if (!commandMatches(incomingCommandId)) {
            return denied("command_changed");
        }
        if (stageUsed) {
            return denied("stage_already_used");
        }
        String invalidReason = validateStagePlan(plan);
        if (!invalidReason.isEmpty()) {
            return denied(invalidReason);
        }
        if (episode == null) {
            return denied("missing_break_stance_episode");
        }
        if (episode.expiredAt(nowMs)) {
            return denied("frontier_deadline");
        }

        stageUsed = true;
        active = true;
        phase = Phase.TRAVERSING;
        target = plan.target().toImmutable();
        candidateFingerprint = fingerprint;
        origin = plan.origin();
        frontier = plan.frontier();
        stageRoute = List.copyOf(plan.route());
        stageRouteLength = stageRoute.size();
        expandedCells = plan.expandedCells();
        startDistance = plan.startDistance();
        plannedRemainingDistance = plan.remainingDistance();
        actualRemainingDistance = Double.NaN;
        actualNetProgress = 0.0D;
        plannerComputations = 1;
        stoppedHoldTicks = 0;
        breakStanceEpisode = episode;
        activePermit = null;
        finalPlan = null;
        rejectionReason = "";
        return accepted("frontier_selected");
    }

    Transition markFrontierReached(
        String incomingCommandId,
        BlockPos liveTarget,
        VoxelCell actualFeet,
        boolean grounded,
        long nowMs
    ) {
        if (phase != Phase.TRAVERSING) {
            return denied("frontier_not_traversing");
        }
        String invalidReason = validateFrontierState(
            incomingCommandId,
            liveTarget,
            actualFeet,
            grounded,
            nowMs
        );
        if (!invalidReason.isEmpty()) {
            return reject(invalidReason);
        }

        actualRemainingDistance = horizontalDistance(actualFeet, target);
        actualNetProgress = startDistance - actualRemainingDistance;
        if (actualNetProgress + DISTANCE_EPSILON
            < GatherTreeReachableSeedPlanner.MIN_FRONTIER_HORIZONTAL_PROGRESS) {
            return reject("frontier_progress_insufficient");
        }

        phase = Phase.HOLDING_AT_FRONTIER;
        return accepted("frontier_reached");
    }

    Transition completeStoppedHoldTick(
        String incomingCommandId,
        BlockPos liveTarget,
        VoxelCell actualFeet,
        boolean grounded,
        boolean movementStopped,
        long nowMs
    ) {
        if (phase != Phase.HOLDING_AT_FRONTIER) {
            return denied("frontier_not_holding");
        }
        String invalidReason = validateFrontierState(
            incomingCommandId,
            liveTarget,
            actualFeet,
            grounded,
            nowMs
        );
        if (!invalidReason.isEmpty()) {
            return reject(invalidReason);
        }
        if (!movementStopped) {
            return reject("frontier_hold_not_stopped");
        }

        stoppedHoldTicks = 1;
        phase = Phase.READY_TO_REPLAN;
        return accepted("frontier_hold_complete");
    }

    ReplanReservation reserveSingletonReplan(
        String incomingCommandId,
        BlockPos liveTarget,
        VoxelCell actualFeet,
        boolean grounded,
        long nowMs
    ) {
        if (phase != Phase.READY_TO_REPLAN) {
            return new ReplanReservation(denied("frontier_not_ready_to_replan"), null);
        }
        String invalidReason = validateFrontierState(
            incomingCommandId,
            liveTarget,
            actualFeet,
            grounded,
            nowMs
        );
        if (!invalidReason.isEmpty()) {
            return new ReplanReservation(reject(invalidReason), null);
        }
        if (plannerComputations != 1) {
            return new ReplanReservation(reject("planner_computation_limit"), null);
        }

        plannerComputations = 2;
        phase = Phase.REPLANNING;
        activePermit = new ReplanPermit(
            commandId,
            target,
            candidateFingerprint,
            frontier,
            plannerComputations,
            STAGE_EPISODE,
            breakStanceEpisode
        );
        return new ReplanReservation(accepted("singleton_replan_reserved"), activePermit);
    }

    ReplanResolution resolveSingletonReplan(
        ReplanPermit permit,
        GatherTreeReachableSeedPlanner.Result result,
        long nowMs
    ) {
        if (phase != Phase.REPLANNING) {
            return new ReplanResolution(denied("singleton_replan_not_active"), null);
        }
        if (permit == null || permit != activePermit) {
            return new ReplanResolution(reject("stale_replan_permit"), null);
        }
        if (breakStanceEpisode == null || breakStanceEpisode.expiredAt(nowMs)) {
            return new ReplanResolution(reject("frontier_deadline"), null);
        }
        if (plannerComputations != MAX_PLANNER_COMPUTATIONS) {
            return new ReplanResolution(reject("planner_computation_limit"), null);
        }
        if (result == null) {
            return new ReplanResolution(reject("singleton_replan_missing"), null);
        }
        if (!result.found()) {
            String reason = result.frontierFound()
                ? "second_frontier_not_allowed"
                : normalizedFailure(result.failureReason(), "no_reachable_break_stance");
            return new ReplanResolution(reject(reason), null);
        }

        GatherTreeReachableSeedPlanner.Plan plan = result.plan();
        String invalidReason = validateFinalPlan(plan);
        if (!invalidReason.isEmpty()) {
            return new ReplanResolution(reject(invalidReason), null);
        }

        finalPlan = plan;
        activePermit = null;
        active = false;
        phase = Phase.FINAL_ROUTE_READY;
        return new ReplanResolution(accepted("singleton_replan_succeeded"), finalPlan);
    }

    Transition rejectTarget(String reason) {
        if (!stageUsed) {
            return denied("stage_unused");
        }
        return reject(normalizedFailure(reason, "target_rejected"));
    }

    String commandId() {
        return commandId == null ? "" : commandId;
    }

    Phase phase() {
        return phase;
    }

    boolean stageUsed() {
        return stageUsed;
    }

    boolean active() {
        return active;
    }

    BlockPos target() {
        return target;
    }

    long candidateFingerprint() {
        return candidateFingerprint;
    }

    VoxelCell origin() {
        return origin;
    }

    VoxelCell frontier() {
        return frontier;
    }

    List<VoxelCell> stageRoute() {
        return stageRoute;
    }

    int stageRouteLength() {
        return stageRouteLength;
    }

    int expandedCells() {
        return expandedCells;
    }

    double startDistance() {
        return startDistance;
    }

    double plannedRemainingDistance() {
        return plannedRemainingDistance;
    }

    double actualRemainingDistance() {
        return actualRemainingDistance;
    }

    double actualNetProgress() {
        return actualNetProgress;
    }

    int plannerComputations() {
        return plannerComputations;
    }

    int stoppedHoldTicks() {
        return stoppedHoldTicks;
    }

    int stageEpisode() {
        return stageUsed ? STAGE_EPISODE : 0;
    }

    GatherTreeLivenessPolicy.BreakStanceEpisode breakStanceEpisode() {
        return breakStanceEpisode;
    }

    long deadlineAtMs() {
        return breakStanceEpisode == null ? 0L : breakStanceEpisode.deadlineAtMs();
    }

    GatherTreeReachableSeedPlanner.Plan finalPlan() {
        return finalPlan;
    }

    String rejectionReason() {
        return rejectionReason;
    }

    private String validateStagePlan(GatherTreeReachableSeedPlanner.FrontierPlan plan) {
        if (plan == null || plan.target() == null || plan.origin() == null || plan.frontier() == null) {
            return "invalid_frontier_plan";
        }
        List<VoxelCell> route = plan.route();
        if (route == null
            || route.size() < 2
            || route.size() > GatherTreeReachableSeedPlanner.MAX_ROUTE_CELLS
            || !plan.origin().equals(route.get(0))
            || !plan.frontier().equals(route.get(route.size() - 1))) {
            return "invalid_frontier_route";
        }
        if (plan.expandedCells() < 0
            || plan.expandedCells() > GatherTreeReachableSeedPlanner.MAX_EXPANDED_CELLS) {
            return "invalid_frontier_expansion_count";
        }
        if (!Double.isFinite(plan.startDistance())
            || !Double.isFinite(plan.remainingDistance())
            || plan.startDistance() < 0.0D
            || plan.remainingDistance() < 0.0D) {
            return "invalid_frontier_distance";
        }
        double expectedStart = horizontalDistance(plan.origin(), plan.target());
        double expectedRemaining = horizontalDistance(plan.frontier(), plan.target());
        if (Math.abs(plan.startDistance() - expectedStart) > DISTANCE_EPSILON
            || Math.abs(plan.remainingDistance() - expectedRemaining) > DISTANCE_EPSILON) {
            return "frontier_distance_mismatch";
        }
        if (plan.startDistance() - plan.remainingDistance() + DISTANCE_EPSILON
            < GatherTreeReachableSeedPlanner.MIN_FRONTIER_HORIZONTAL_PROGRESS) {
            return "frontier_progress_insufficient";
        }
        return "";
    }

    private String validateFrontierState(
        String incomingCommandId,
        BlockPos liveTarget,
        VoxelCell actualFeet,
        boolean grounded,
        long nowMs
    ) {
        if (!commandMatches(incomingCommandId)) {
            return "command_changed";
        }
        if (breakStanceEpisode == null || breakStanceEpisode.expiredAt(nowMs)) {
            return "frontier_deadline";
        }
        if (liveTarget == null) {
            return "frontier_target_missing";
        }
        if (!target.equals(liveTarget)) {
            return "frontier_target_changed";
        }
        if (!grounded || actualFeet == null || !frontier.equals(actualFeet)) {
            return "frontier_arrival_invalid";
        }
        return "";
    }

    private String validateFinalPlan(GatherTreeReachableSeedPlanner.Plan plan) {
        if (plan == null || plan.target() == null || !target.equals(plan.target())) {
            return "singleton_target_changed";
        }
        List<VoxelCell> route = plan.route();
        if (route == null
            || route.isEmpty()
            || route.size() > GatherTreeReachableSeedPlanner.MAX_ROUTE_CELLS
            || !frontier.equals(route.get(0))
            || plan.stance() == null
            || !plan.stance().equals(route.get(route.size() - 1))) {
            return "singleton_route_invalid";
        }
        if (plan.expandedCells() < 0
            || plan.expandedCells() > GatherTreeReachableSeedPlanner.MAX_EXPANDED_CELLS) {
            return "singleton_expansion_count_invalid";
        }
        return "";
    }

    private boolean commandMatches(String incomingCommandId) {
        return commandId != null
            && commandId.equals(incomingCommandId == null ? "" : incomingCommandId);
    }

    private void bindCommandIfNeeded(String incomingCommandId) {
        if (commandId == null) {
            commandId = incomingCommandId == null ? "" : incomingCommandId;
        }
    }

    private Transition accepted(String reason) {
        return new Transition(true, phase, reason);
    }

    private Transition denied(String reason) {
        return new Transition(false, phase, reason);
    }

    private Transition reject(String reason) {
        active = false;
        activePermit = null;
        finalPlan = null;
        rejectionReason = normalizedFailure(reason, "target_rejected");
        phase = Phase.REJECTED;
        return denied(rejectionReason);
    }

    private static double horizontalDistance(VoxelCell cell, BlockPos block) {
        return Math.hypot(cell.x() - block.getX(), cell.z() - block.getZ());
    }

    private static String normalizedFailure(String reason, String fallback) {
        return reason == null || reason.isBlank() ? fallback : reason;
    }
}
