package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.List;

/**
 * Pure admission policy for a controlled descent safe-fall, including the two origin-height cells the
 * player must cross before entering the drop column.
 */
final class DescentSafeFallLaunchPlanner {
    static final int MAX_CLEARANCE_CELLS = 2;

    private DescentSafeFallLaunchPlanner() {
    }

    record Origin(
        VoxelCell feet,
        boolean grounded,
        boolean dry,
        boolean bodyClear,
        boolean supportStable,
        boolean hazardFree,
        boolean adjacentLava
    ) {
    }

    record LaunchCell(
        VoxelCell cell,
        boolean collisionFree,
        boolean leafTagged,
        boolean liquid,
        boolean hazard,
        boolean adjacentLava,
        boolean gravityBlock
    ) {
    }

    record Landing(
        VoxelCell feet,
        boolean dropColumnClear,
        boolean dropColumnDry,
        boolean dropColumnHazardFree,
        boolean floorStable,
        boolean feetClear,
        boolean headClear,
        boolean dry,
        boolean hazardFree,
        boolean adjacentLava,
        boolean boxed,
        boolean targetDepthAllowed
    ) {
    }

    record Request(
        Origin origin,
        LaunchCell launchFeet,
        LaunchCell launchHead,
        VoxelCell dropColumn,
        Landing landing,
        int fallDepth,
        int maxSafeFall,
        int maxHealthFall,
        float currentHealth,
        float healthMargin
    ) {
    }

    record Plan(
        VoxelCell origin,
        VoxelCell launchFeet,
        VoxelCell launchHead,
        VoxelCell dropColumn,
        VoxelCell landing,
        int fallDepth,
        int expectedDamage,
        List<VoxelCell> clearanceCells
    ) {
        Plan {
            clearanceCells = clearanceCells == null ? List.of() : List.copyOf(clearanceCells);
        }
    }

    /**
     * Geometry that was actually evaluated, retained for rejection telemetry only. Unlike {@link Plan},
     * this package never confers launch, clearance, or movement authority.
     */
    record Evaluation(
        VoxelCell origin,
        VoxelCell launchFeet,
        VoxelCell launchHead,
        VoxelCell dropColumn,
        VoxelCell landing,
        int fallDepth,
        int expectedDamage
    ) {
    }

    record Decision(Plan plan, Evaluation evaluation, String reason) {
        Decision {
            reason = reason == null ? "" : reason;
        }

        Decision(Plan plan, String reason) {
            this(plan, DescentSafeFallLaunchPlanner.evaluation(plan), reason);
        }

        boolean accepted() {
            return plan != null;
        }
    }

    static Decision plan(Request request) {
        if (request == null
            || request.origin() == null
            || request.launchFeet() == null
            || request.launchHead() == null
            || request.dropColumn() == null
            || request.landing() == null
            || request.origin().feet() == null
            || request.launchFeet().cell() == null
            || request.launchHead().cell() == null
            || request.landing().feet() == null
            || request.maxSafeFall() < 1
            || request.maxHealthFall() < request.maxSafeFall()
            || !Float.isFinite(request.currentHealth())
            || !Float.isFinite(request.healthMargin())
            || request.currentHealth() < 0.0F
            || request.healthMargin() < 0.0F) {
            return rejected(evaluation(request), "invalid_request");
        }
        Evaluation evaluation = evaluation(request);
        Origin origin = request.origin();
        if (!origin.grounded()) {
            return rejected(evaluation, "origin_not_grounded");
        }
        if (!origin.dry()) {
            return rejected(evaluation, "origin_not_dry");
        }
        if (!origin.bodyClear()) {
            return rejected(evaluation, "origin_body_blocked");
        }
        if (!origin.supportStable()) {
            return rejected(evaluation, "origin_support_unstable");
        }
        if (!origin.hazardFree()) {
            return rejected(evaluation, "origin_hazard");
        }
        if (origin.adjacentLava()) {
            return rejected(evaluation, "origin_adjacent_lava");
        }
        String geometryReason = geometryReason(request);
        if (geometryReason != null) {
            return rejected(evaluation, geometryReason);
        }

        List<VoxelCell> clearance = new ArrayList<>(MAX_CLEARANCE_CELLS);
        // Clear top-down so a falling/updated leaf shape cannot make the lower target ambiguous.
        String headReason = classifyLaunchCell(request.launchHead(), clearance);
        if (headReason != null) {
            return rejected(evaluation, "launch_head_" + headReason);
        }
        String feetReason = classifyLaunchCell(request.launchFeet(), clearance);
        if (feetReason != null) {
            return rejected(evaluation, "launch_feet_" + feetReason);
        }
        if (clearance.size() > MAX_CLEARANCE_CELLS) {
            return rejected(evaluation, "clearance_limit");
        }

        Landing landing = request.landing();
        if (!landing.targetDepthAllowed()) {
            return rejected(evaluation, "landing_outside_depth_band");
        }
        if (!landing.dropColumnClear()) {
            return rejected(evaluation, "drop_column_blocked");
        }
        if (!landing.dropColumnDry()) {
            return rejected(evaluation, "drop_column_liquid");
        }
        if (!landing.dropColumnHazardFree()) {
            return rejected(evaluation, "drop_column_hazard");
        }
        if (!landing.floorStable()) {
            return rejected(evaluation, "landing_support_unstable");
        }
        if (!landing.feetClear() || !landing.headClear()) {
            return rejected(evaluation, "landing_body_blocked");
        }
        if (!landing.dry()) {
            return rejected(evaluation, "landing_liquid");
        }
        if (!landing.hazardFree()) {
            return rejected(evaluation, "landing_hazard");
        }
        if (landing.adjacentLava()) {
            return rejected(evaluation, "landing_adjacent_lava");
        }
        if (landing.boxed()) {
            return rejected(evaluation, "landing_boxed");
        }
        if (!fallAllowed(request)) {
            return rejected(evaluation, "fall_not_survivable");
        }

        Plan plan = new Plan(
            origin.feet(),
            request.launchFeet().cell(),
            request.launchHead().cell(),
            request.dropColumn(),
            landing.feet(),
            request.fallDepth(),
            SafeFallPlanner.fallDamage(request.fallDepth()),
            clearance
        );
        return new Decision(
            plan,
            evaluation(plan),
            clearance.isEmpty() ? "launch_envelope_clear" : "launch_envelope_clearable"
        );
    }

    /** Re-samples a frozen package without allowing its geometry or damage contract to change. */
    static Decision revalidate(Plan frozen, Request current) {
        if (frozen == null) {
            return rejected(evaluation(current), "missing_frozen_plan");
        }
        Decision refreshed = plan(current);
        if (!refreshed.accepted()) {
            return refreshed;
        }
        Plan candidate = refreshed.plan();
        if (!frozen.origin().equals(candidate.origin())
            || !frozen.launchFeet().equals(candidate.launchFeet())
            || !frozen.launchHead().equals(candidate.launchHead())
            || !frozen.dropColumn().equals(candidate.dropColumn())
            || !frozen.landing().equals(candidate.landing())
            || frozen.fallDepth() != candidate.fallDepth()
            || frozen.expectedDamage() != candidate.expectedDamage()) {
            return rejected(refreshed.evaluation(), "geometry_changed");
        }
        return refreshed;
    }

    private static String geometryReason(Request request) {
        VoxelCell origin = request.origin().feet();
        VoxelCell launchFeet = request.launchFeet().cell();
        VoxelCell launchHead = request.launchHead().cell();
        VoxelCell column = request.dropColumn();
        VoxelCell landing = request.landing().feet();
        int horizontal = Math.abs(origin.x() - launchFeet.x()) + Math.abs(origin.z() - launchFeet.z());
        if (horizontal != 1 || origin.y() != launchFeet.y()) {
            return "launch_not_cardinal";
        }
        if (launchHead.x() != launchFeet.x()
            || launchHead.z() != launchFeet.z()
            || launchHead.y() != launchFeet.y() + 1) {
            return "launch_body_disconnected";
        }
        if (column.x() != launchFeet.x()
            || column.z() != launchFeet.z()
            || column.y() != launchFeet.y() - 1) {
            return "drop_column_disconnected";
        }
        if (request.fallDepth() < 1
            || landing.x() != column.x()
            || landing.z() != column.z()
            || landing.y() != origin.y() - request.fallDepth()) {
            return "landing_geometry_mismatch";
        }
        return null;
    }

    private static String classifyLaunchCell(LaunchCell launch, List<VoxelCell> clearance) {
        if (launch.liquid()) {
            return "liquid";
        }
        if (launch.hazard()) {
            return "hazard";
        }
        if (launch.adjacentLava()) {
            return "adjacent_lava";
        }
        if (launch.gravityBlock()) {
            return "gravity_block";
        }
        if (launch.collisionFree()) {
            return null;
        }
        if (!launch.leafTagged()) {
            return "blocked";
        }
        clearance.add(launch.cell());
        return null;
    }

    private static boolean fallAllowed(Request request) {
        if (request.fallDepth() < 1) {
            return false;
        }
        if (request.fallDepth() <= request.maxSafeFall()) {
            return true;
        }
        return SafeFallPlanner.isHealthSurvivableFall(
            request.fallDepth(),
            request.maxHealthFall(),
            request.currentHealth(),
            request.healthMargin()
        );
    }

    private static Evaluation evaluation(Request request) {
        if (request == null
            || request.origin() == null
            || request.launchFeet() == null
            || request.launchHead() == null
            || request.landing() == null
            || request.origin().feet() == null
            || request.launchFeet().cell() == null
            || request.launchHead().cell() == null
            || request.dropColumn() == null
            || request.landing().feet() == null) {
            return null;
        }
        int expectedDamage = request.fallDepth() < 1
            ? 0
            : SafeFallPlanner.fallDamage(request.fallDepth());
        return new Evaluation(
            request.origin().feet(),
            request.launchFeet().cell(),
            request.launchHead().cell(),
            request.dropColumn(),
            request.landing().feet(),
            request.fallDepth(),
            expectedDamage
        );
    }

    private static Evaluation evaluation(Plan plan) {
        if (plan == null) {
            return null;
        }
        return new Evaluation(
            plan.origin(),
            plan.launchFeet(),
            plan.launchHead(),
            plan.dropColumn(),
            plan.landing(),
            plan.fallDepth(),
            plan.expectedDamage()
        );
    }

    private static Decision rejected(Evaluation evaluation, String reason) {
        return new Decision(null, evaluation, reason);
    }
}
