package com.mcbot.fabricclient;

/**
 * Selects one bounded village route while preserving the code-owned final stance mode.
 *
 * <p>A remote container, hay bale, or bed is not safe to approach as an exact feet target. When
 * its final interaction planner reaches the existing local route-cell/expansion bound, this
 * selector may install one ordinary {@link VillageInteractionStancePlanner.Mode#EXACT_TRAVEL}
 * frontier toward the same frozen block. Re-running the selector at that frontier keeps the
 * original final mode; reaching a frontier therefore never grants interaction authority.</p>
 */
final class VillageRoutePlanSelector {
    record Selection(
        VillageInteractionStancePlanner.Plan plan,
        VillageInteractionStancePlanner.Mode goalMode,
        VillageInteractionStancePlanner.Mode installedMode,
        int computations,
        boolean frontierStage
    ) {
        Selection {
            plan = plan == null
                ? new VillageInteractionStancePlanner.Plan(
                    null, java.util.List.of(), 0, false, "invalid_request")
                : plan;
            computations = Math.max(0, computations);
        }

        boolean accepted() {
            return plan.accepted();
        }

        boolean finalStanceReached() {
            return accepted() && !frontierStage;
        }
    }

    private VillageRoutePlanSelector() {
    }

    static Selection select(
        GatherWoodLocalEgressPerception perception,
        VoxelCell start,
        VoxelCell target,
        VillageInteractionStancePlanner.Mode goalMode,
        boolean allowRemoteStage,
        boolean allowOccupiedExactApproach
    ) {
        if (perception == null || start == null || target == null || goalMode == null) {
            return rejected(goalMode, "invalid_request", 0);
        }

        VillageInteractionStancePlanner.Plan primary =
            VillageInteractionStancePlanner.plan(perception, start, target, goalMode);
        if (primary.accepted()) {
            return new Selection(
                primary,
                goalMode,
                goalMode,
                1,
                goalMode == VillageInteractionStancePlanner.Mode.EXACT_TRAVEL
                    && primary.frontier());
        }

        if (goalMode == VillageInteractionStancePlanner.Mode.EXACT_TRAVEL) {
            if (!allowOccupiedExactApproach
                || !"no_safe_stance".equals(primary.reason())) {
                return new Selection(primary, goalMode, goalMode, 1, false);
            }
            VillageInteractionStancePlanner.Plan approach =
                VillageInteractionStancePlanner.plan(
                    perception,
                    start,
                    target,
                    VillageInteractionStancePlanner.Mode.INTERACT_BLOCK);
            return new Selection(
                approach,
                goalMode,
                VillageInteractionStancePlanner.Mode.INTERACT_BLOCK,
                2,
                false);
        }

        if (!allowRemoteStage || !canStage(primary.reason())) {
            return new Selection(primary, goalMode, goalMode, 1, false);
        }

        VillageInteractionStancePlanner.Plan travel =
            VillageInteractionStancePlanner.plan(
                perception,
                start,
                target,
                VillageInteractionStancePlanner.Mode.EXACT_TRAVEL);
        // Any exact route installed on behalf of a non-exact goal is only travel. Even if the
        // exact target happens to be standable, the final interaction/harvest planner must run
        // again from there before the executor may act.
        boolean staged = travel.accepted();
        return new Selection(
            travel,
            goalMode,
            VillageInteractionStancePlanner.Mode.EXACT_TRAVEL,
            2,
            staged);
    }

    static boolean canStage(String reason) {
        return "route_cell_limit".equals(reason) || "expanded_budget".equals(reason);
    }

    private static Selection rejected(
        VillageInteractionStancePlanner.Mode goalMode,
        String reason,
        int computations
    ) {
        return new Selection(
            new VillageInteractionStancePlanner.Plan(
                null, java.util.List.of(), 0, false, reason),
            goalMode,
            goalMode,
            computations,
            false);
    }
}
