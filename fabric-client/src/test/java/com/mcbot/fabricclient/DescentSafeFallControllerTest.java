package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class DescentSafeFallControllerTest {
    private static final Object WORLD = new Object();
    private static final VoxelCell ORIGIN = new VoxelCell(0, 20, 0);
    private static final VoxelCell LAUNCH_FEET = new VoxelCell(1, 20, 0);
    private static final VoxelCell LAUNCH_HEAD = new VoxelCell(1, 21, 0);
    private static final VoxelCell COLUMN = new VoxelCell(1, 19, 0);
    private static final VoxelCell LANDING = new VoxelCell(1, 18, 0);

    @Test
    void committedLaunchUsesBoundedForwardThrottle() {
        assertEquals(0.25F, DescentSafeFallController.LAUNCH_FORWARD_SCALE);
    }

    @Test
    void clearsFrozenLeafTargetsInTopDownOrderBeforeAligning() {
        DescentSafeFallController controller = started(plan(List.of(LAUNCH_HEAD, LAUNCH_FEET)), 100L);
        assertEquals(DescentSafeFallController.Phase.SELECTED, controller.phase());

        DescentSafeFallController.Decision clearing = controller.tick(origin(110L, false));
        assertEquals(DescentSafeFallController.Phase.CLEARING, clearing.phase());
        assertEquals(DescentSafeFallController.Action.CLEAR_BLOCKER, clearing.action());
        assertEquals(LAUNCH_HEAD, clearing.clearanceCell());

        DescentSafeFallController.Decision second = controller.tick(clearance(
            120L, DescentSafeFallController.ClearanceStatus.VERIFIED, LAUNCH_HEAD, true));
        assertEquals(LAUNCH_FEET, second.clearanceCell());
        assertEquals(1, controller.clearanceIndex());

        DescentSafeFallController.Decision alignedNext = controller.tick(clearance(
            130L, DescentSafeFallController.ClearanceStatus.VERIFIED, LAUNCH_FEET, true));
        assertEquals(DescentSafeFallController.Phase.ALIGNING, alignedNext.phase());
        assertEquals(DescentSafeFallController.Action.ALIGN, alignedNext.action());
        assertNull(alignedNext.clearanceCell());
    }

    @Test
    void clearanceRequiresTerminalVerificationAndFreshGeometry() {
        DescentSafeFallController controller = started(plan(List.of(LAUNCH_HEAD)), 100L);
        controller.tick(origin(110L, false));

        DescentSafeFallController.Decision running = controller.tick(clearance(
            120L, DescentSafeFallController.ClearanceStatus.RUNNING, LAUNCH_HEAD, true));
        assertEquals(DescentSafeFallController.Phase.CLEARING, running.phase());
        assertEquals(0, controller.clearanceIndex());

        DescentSafeFallController.Decision invalidated = controller.tick(clearance(
            130L, DescentSafeFallController.ClearanceStatus.VERIFIED, LAUNCH_HEAD, false));
        assertEquals(DescentSafeFallController.Phase.REJECTED, invalidated.phase());
        assertEquals("geometry_invalidated_after_clearance", invalidated.reason());
    }

    @Test
    void alignmentHasAnExactTwoSecondNonResettingDeadline() {
        DescentSafeFallController controller = started(plan(List.of()), 100L);
        controller.tick(origin(110L, false));
        DescentSafeFallController.Decision pending = controller.tick(origin(2_109L, false));
        assertEquals(DescentSafeFallController.Action.ALIGN, pending.action());

        DescentSafeFallController.Decision timedOut = controller.tick(origin(2_110L, false));
        assertEquals(DescentSafeFallController.Phase.REJECTED, timedOut.phase());
        assertEquals("alignment_timeout", timedOut.reason());
    }

    @Test
    void firstAlignedObservationAtTheDeadlineCannotLaunch() {
        DescentSafeFallController controller = started(plan(List.of()), 100L);
        controller.tick(origin(110L, false));

        DescentSafeFallController.Decision timedOut = controller.tick(origin(2_110L, true));

        assertEquals(DescentSafeFallController.Phase.REJECTED, timedOut.phase());
        assertEquals(DescentSafeFallController.Action.REJECTED, timedOut.action());
        assertEquals("alignment_timeout", timedOut.reason());
        assertEquals(0L, controller.launchStartedAtMs());
    }

    @Test
    void alignedLaunchHoldsAtOriginAndTimesOutExactlyOnce() {
        DescentSafeFallController controller = started(plan(List.of()), 100L);
        assertFalse(controller.committedMovementActive());
        controller.tick(origin(110L, false));
        assertFalse(controller.committedMovementActive());
        DescentSafeFallController.Decision launched = controller.tick(origin(120L, true));
        assertEquals(DescentSafeFallController.Phase.LAUNCHING, launched.phase());
        assertEquals(DescentSafeFallController.Action.HOLD_FORWARD, launched.action());
        assertEquals(120L, controller.launchStartedAtMs());
        assertTrue(controller.committedMovementActive());

        DescentSafeFallController.Decision hold = controller.tick(origin(3_119L, true));
        assertEquals("launch_hold", hold.reason());
        assertFalse(hold.departed());

        DescentSafeFallController.Decision timedOut = controller.tick(origin(3_120L, true));
        assertEquals(DescentSafeFallController.Phase.REJECTED, timedOut.phase());
        assertEquals("launch_timeout", timedOut.reason());
        assertFalse(controller.committedMovementActive());
    }

    @Test
    void firstPostLaunchAirborneHealthLossRecordsCommittedDepartureBeforeRejecting() {
        DescentSafeFallController controller = launched(100L);

        DescentSafeFallController.Decision departed = controller.tick(observation(
            150L, ORIGIN, 0.0D, 0.0D, false, true, true, true, true, true,
            19.0F, true, 1.0D));

        assertEquals(DescentSafeFallController.Phase.AIRBORNE, departed.phase());
        assertEquals(DescentSafeFallController.Action.HOLD_FORWARD, departed.action());
        assertTrue(departed.departed());
        assertTrue(controller.departed());
        assertTrue(controller.committedMovementActive());

        DescentSafeFallController.Decision firstLanding = controller.tick(landing(200L, 19.0F));
        assertEquals(DescentSafeFallController.Phase.LAND_SETTLE, firstLanding.phase());
        assertEquals(DescentSafeFallController.Action.HOLD_AIRBORNE, firstLanding.action());

        DescentSafeFallController.Decision rejected = controller.tick(landing(210L, 19.0F));
        assertEquals(DescentSafeFallController.Phase.REJECTED, rejected.phase());
        assertEquals(DescentSafeFallController.Action.REJECTED, rejected.action());
        assertEquals("postdeparture_health_loss", rejected.reason());
        assertEquals(2, rejected.stableLandingPolls());
        assertTrue(controller.committedMovementActive());
    }

    @Test
    void postDepartureGeometryRejectionRetainsCommitmentForClientLandingDeferral() {
        DescentSafeFallController controller = launched(100L);
        DescentSafeFallController.Decision departed = controller.tick(observation(
            150L, ORIGIN, 0.0D, 0.0D, false, true, true, true, true, true,
            20.0F, true, 1.0D));
        assertTrue(departed.departed());

        DescentSafeFallController.Decision pending = controller.tick(observation(
            160L, COLUMN, 1.2D, 0.5D, false, true, true, true, true, true,
            20.0F, false, 1.0D));

        assertEquals(DescentSafeFallController.Phase.AIRBORNE, pending.phase());
        assertEquals(DescentSafeFallController.Action.HOLD_AIRBORNE, pending.action());
        assertTrue(pending.departed());
        assertTrue(controller.committedMovementActive());

        DescentSafeFallController.Decision firstLanding = controller.tick(landing(200L));
        assertEquals(DescentSafeFallController.Phase.LAND_SETTLE, firstLanding.phase());
        assertEquals(DescentSafeFallController.Action.HOLD_AIRBORNE, firstLanding.action());

        DescentSafeFallController.Decision rejected = controller.tick(landing(210L));
        assertEquals(DescentSafeFallController.Phase.REJECTED, rejected.phase());
        assertEquals("geometry_invalidated_after_departure", rejected.reason());
        assertEquals(2, rejected.stableLandingPolls());
        assertTrue(controller.committedMovementActive());
    }

    @Test
    void firstAirborneGeometryInvalidationIsPostDepartureAndKeepsFallControl() {
        DescentSafeFallController controller = launched(100L);

        DescentSafeFallController.Decision pending = controller.tick(observation(
            150L, ORIGIN, 0.0D, 0.0D, false, true, true, true, true, true,
            20.0F, false, 1.0D));

        assertEquals(DescentSafeFallController.Phase.AIRBORNE, pending.phase());
        assertEquals(DescentSafeFallController.Action.HOLD_FORWARD, pending.action());
        assertTrue(pending.departed());
        assertTrue(controller.committedMovementActive());

        assertEquals(DescentSafeFallController.Phase.LAND_SETTLE,
            controller.tick(landing(200L)).phase());
        DescentSafeFallController.Decision rejected = controller.tick(landing(210L));
        assertEquals(DescentSafeFallController.Phase.REJECTED, rejected.phase());
        assertEquals("geometry_invalidated_after_departure", rejected.reason());
    }

    @Test
    void departureObservedAtTheDeadlineCannotBypassLaunchTimeout() {
        DescentSafeFallController controller = launched(100L);

        DescentSafeFallController.Decision timedOut = controller.tick(observation(
            3_120L, ORIGIN, 0.06D, 0.0D, true, true, true, true, true, true,
            20.0F, true, 1.0D));

        assertEquals(DescentSafeFallController.Phase.REJECTED, timedOut.phase());
        assertEquals("launch_timeout", timedOut.reason());
        assertFalse(timedOut.departed());
    }

    @Test
    void preciseHorizontalProgressCommitsDepartureAndLatchesDamage() {
        DescentSafeFallController controller = launched(100L);
        DescentSafeFallController.Decision departed = controller.tick(observation(
            150L, ORIGIN, 0.06D, 0.0D, true, true, true, true, true, true,
            20.0F, true, 1.0D));

        assertEquals(DescentSafeFallController.Phase.AIRBORNE, departed.phase());
        assertEquals(DescentSafeFallController.Action.HOLD_FORWARD, departed.action());
        assertTrue(departed.departed());
        assertTrue(departed.expectedDamageLatched());
        assertFalse(departed.columnCaptured());
    }

    @Test
    void groundedLaunchCellTransitKeepsForwardUntilActualAirborneCapture() {
        DescentSafeFallController controller = launched(100L);
        controller.tick(observation(
            150L, ORIGIN, 0.06D, 0.0D, true, true, true, true, true, true,
            20.0F, true, 1.0D));

        DescentSafeFallController.Decision lipTransit = controller.tick(observation(
            175L, LAUNCH_FEET, 1.30D, 0.0D, true, true, true, true, true, true,
            20.0F, true, 1.0D));
        assertEquals(DescentSafeFallController.Phase.AIRBORNE, lipTransit.phase());
        assertEquals(DescentSafeFallController.Action.HOLD_FORWARD, lipTransit.action());
        assertFalse(lipTransit.columnCaptured());

        DescentSafeFallController.Decision supportCleared = controller.tick(observation(
            190L, LAUNCH_FEET, 1.32D, 0.0D, true, true, true, true, true, true,
            20.0F, true, 1.0D));
        assertEquals(DescentSafeFallController.Action.HOLD_AIRBORNE, supportCleared.action());
        assertTrue(supportCleared.columnCaptured());

        DescentSafeFallController.Decision airborne = controller.tick(observation(
            200L, LAUNCH_FEET, 1.0D, 0.0D, false, true, true, true, false, true,
            20.0F, true, 1.0D));
        assertEquals(DescentSafeFallController.Action.HOLD_AIRBORNE, airborne.action());
        assertTrue(airborne.columnCaptured());
    }

    @Test
    void absolutePlayerBoundsGateCaptureForOffCenterStartsInEveryCardinalDirection() {
        double halfWidth = 0.30D;
        DescentSafeFallLaunchPlanner.Plan east = directionalPlan(1, 0);
        DescentSafeFallLaunchPlanner.Plan west = directionalPlan(-1, 0);
        DescentSafeFallLaunchPlanner.Plan south = directionalPlan(0, 1);
        DescentSafeFallLaunchPlanner.Plan north = directionalPlan(0, -1);

        assertFalse(DescentSafeFallController.clearsOriginSupport(east, 0.91D, 0.50D, halfWidth));
        assertTrue(DescentSafeFallController.clearsOriginSupport(east, 1.32D, 0.50D, halfWidth));
        assertFalse(DescentSafeFallController.clearsOriginSupport(west, 0.09D, 0.50D, halfWidth));
        assertTrue(DescentSafeFallController.clearsOriginSupport(west, -0.32D, 0.50D, halfWidth));
        assertFalse(DescentSafeFallController.clearsOriginSupport(south, 0.50D, 0.91D, halfWidth));
        assertTrue(DescentSafeFallController.clearsOriginSupport(south, 0.50D, 1.32D, halfWidth));
        assertFalse(DescentSafeFallController.clearsOriginSupport(north, 0.50D, 0.09D, halfWidth));
        assertTrue(DescentSafeFallController.clearsOriginSupport(north, 0.50D, -0.32D, halfWidth));
    }

    @Test
    void originSupportClearanceFailsClosedForNonCardinalLaunchGeometry() {
        double halfWidth = 0.30D;
        DescentSafeFallLaunchPlanner.Plan diagonal = planWithLaunch(new VoxelCell(1, 20, 1));
        DescentSafeFallLaunchPlanner.Plan distant = planWithLaunch(new VoxelCell(2, 20, 0));
        DescentSafeFallLaunchPlanner.Plan vertical = planWithLaunch(new VoxelCell(1, 21, 0));

        assertFalse(DescentSafeFallController.clearsOriginSupport(diagonal, 1.5D, 1.5D, halfWidth));
        assertFalse(DescentSafeFallController.clearsOriginSupport(distant, 2.5D, 0.5D, halfWidth));
        assertFalse(DescentSafeFallController.clearsOriginSupport(vertical, 1.5D, 0.5D, halfWidth));
        assertFalse(DescentSafeFallController.clearsOriginSupport(null, 1.5D, 0.5D, halfWidth));
        assertFalse(DescentSafeFallController.clearsOriginSupport(
            directionalPlan(1, 0), Double.NaN, 0.5D, halfWidth));
    }

    @Test
    void invalidPlayerWidthRejectsStart() {
        DescentSafeFallController controller = new DescentSafeFallController();
        DescentSafeFallController.Decision rejected = controller.start(
            new DescentSafeFallController.StartRequest(
                "descent-command", WORLD, plan(List.of()), 0.0D, 0.0D, 0.0D, 20.0F, 100L));

        assertEquals(DescentSafeFallController.Phase.REJECTED, rejected.phase());
        assertEquals("invalid_start", rejected.reason());
    }

    @Test
    void lateralMotionDoesNotFabricateDepartureProgress() {
        DescentSafeFallController controller = launched(100L);
        DescentSafeFallController.Decision lateral = controller.tick(observation(
            150L, ORIGIN, 0.0D, 0.40D, true, true, true, true, true, true,
            20.0F, true, 1.0D));

        assertEquals(DescentSafeFallController.Phase.LAUNCHING, lateral.phase());
        assertEquals("launch_hold", lateral.reason());
        assertFalse(lateral.departed());
    }

    @Test
    void airborneMotionNeutralizesAfterEnteringFrozenLandingColumn() {
        DescentSafeFallController controller = launched(100L);
        DescentSafeFallController.Decision airborne = controller.tick(observation(
            150L, ORIGIN, 0.0D, 0.0D, false, true, true, true, true, true,
            20.0F, true, 1.0D));
        assertEquals(DescentSafeFallController.Action.HOLD_FORWARD, airborne.action());

        DescentSafeFallController.Decision captured = controller.tick(observation(
            180L, COLUMN, 1.2D, 0.5D, false, true, true, true, true, true,
            20.0F, true, 1.0D));
        assertEquals(DescentSafeFallController.Phase.AIRBORNE, captured.phase());
        assertEquals(DescentSafeFallController.Action.HOLD_AIRBORNE, captured.action());
        assertTrue(captured.columnCaptured());
    }

    @Test
    void exactLandingRequiresTwoConsecutiveGroundedDryStablePolls() {
        DescentSafeFallController controller = launched(100L);
        controller.tick(observation(
            150L, ORIGIN, 0.0D, 0.0D, false, true, true, true, true, true,
            20.0F, true, 1.0D));

        DescentSafeFallController.Decision first = controller.tick(landing(180L));
        assertEquals(DescentSafeFallController.Phase.LAND_SETTLE, first.phase());
        assertEquals(1, first.stableLandingPolls());
        assertEquals(DescentSafeFallController.Action.HOLD_AIRBORNE, first.action());
        assertTrue(controller.committedMovementActive());

        DescentSafeFallController.Decision landed = controller.tick(landing(230L));
        assertEquals(DescentSafeFallController.Phase.LANDED, landed.phase());
        assertEquals(2, landed.stableLandingPolls());
        assertEquals(DescentSafeFallController.Action.LANDED, landed.action());
        assertTrue(controller.committedMovementActive());
    }

    @Test
    void firstLandingObservedAtTheDeadlineCannotBypassLandingTimeout() {
        DescentSafeFallController controller = launched(100L);
        controller.tick(observation(
            150L, ORIGIN, 0.0D, 0.0D, false, true, true, true, true, true,
            20.0F, true, 1.0D));

        DescentSafeFallController.Decision timedOut = controller.tick(landing(3_120L));

        assertEquals(DescentSafeFallController.Phase.REJECTED, timedOut.phase());
        assertEquals("landing_timeout", timedOut.reason());
    }

    @Test
    void landingSettleMustFinishBeforeTheNonResettingDeadline() {
        DescentSafeFallController controller = launched(100L);
        controller.tick(observation(
            150L, ORIGIN, 0.0D, 0.0D, false, true, true, true, true, true,
            20.0F, true, 1.0D));

        DescentSafeFallController.Decision first = controller.tick(landing(3_119L));
        assertEquals(DescentSafeFallController.Phase.LAND_SETTLE, first.phase());
        assertEquals(1, first.stableLandingPolls());

        DescentSafeFallController.Decision timedOut = controller.tick(landing(3_120L));
        assertEquals(DescentSafeFallController.Phase.REJECTED, timedOut.phase());
        assertEquals("landing_timeout", timedOut.reason());
    }

    @Test
    void landingSettleMayFinishImmediatelyBeforeTheDeadline() {
        DescentSafeFallController controller = launched(100L);
        controller.tick(observation(
            150L, ORIGIN, 0.0D, 0.0D, false, true, true, true, true, true,
            20.0F, true, 1.0D));

        DescentSafeFallController.Decision first = controller.tick(landing(3_118L));
        assertEquals(DescentSafeFallController.Phase.LAND_SETTLE, first.phase());

        DescentSafeFallController.Decision landed = controller.tick(landing(3_119L));
        assertEquals(DescentSafeFallController.Phase.LANDED, landed.phase());
        assertEquals(2, landed.stableLandingPolls());
    }

    @Test
    void groundedStepDownCanLandWithoutAnObservedAirborneTick() {
        DescentSafeFallController controller = launched(100L);
        DescentSafeFallController.Decision first = controller.tick(landing(150L));
        assertEquals(DescentSafeFallController.Phase.LAND_SETTLE, first.phase());
        assertEquals("grounded_step_down", first.reason());
        assertTrue(first.departed());

        assertEquals(
            DescentSafeFallController.Phase.LANDED,
            controller.tick(landing(200L)).phase()
        );
    }

    @Test
    void offTargetGroundedLandingRejectsOnlyAfterDeparture() {
        DescentSafeFallController controller = launched(100L);
        DescentSafeFallController.Decision smallOriginHold = controller.tick(observation(
            150L, ORIGIN, 0.01D, 0.0D, true, true, true, true, true, true,
            20.0F, true, 1.0D));
        assertEquals(DescentSafeFallController.Phase.LAUNCHING, smallOriginHold.phase());

        VoxelCell wrong = new VoxelCell(1, 19, 1);
        DescentSafeFallController.Decision rejected = controller.tick(observation(
            180L, wrong, 1.5D, 1.5D, true, true, true, true, true, true,
            20.0F, true, 1.0D));
        assertEquals(DescentSafeFallController.Phase.REJECTED, rejected.phase());
        assertEquals("off_target_landing", rejected.reason());
    }

    @Test
    void unsafeExactLandingIsClassifiedSeparately() {
        DescentSafeFallController controller = launched(100L);
        DescentSafeFallController.Decision rejected = controller.tick(observation(
            180L, LANDING, 1.5D, 0.5D, true, false, true, true, true, true,
            20.0F, true, 0.0D));

        assertEquals(DescentSafeFallController.Phase.REJECTED, rejected.phase());
        assertEquals("landing_invalid", rejected.reason());
    }

    @Test
    void prelaunchHealthLossAndWorldReplacementFailClosed() {
        DescentSafeFallController healthController = started(plan(List.of()), 100L);
        DescentSafeFallController.Decision health = healthController.tick(observation(
            110L, WORLD, ORIGIN, 0.0D, 0.0D, true, true, true, true, true, false,
            19.0F, DescentSafeFallController.ClearanceStatus.NONE, null, true, 1.0D));
        assertEquals("prelaunch_health_loss", health.reason());

        DescentSafeFallController worldController = started(plan(List.of()), 100L);
        DescentSafeFallController.Decision world = worldController.tick(observation(
            110L, new Object(), ORIGIN, 0.0D, 0.0D, true, true, true, true, true, false,
            20.0F, DescentSafeFallController.ClearanceStatus.NONE, null, true, 1.0D));
        assertEquals("lifecycle_changed", world.reason());
    }

    @Test
    void clearDropsAllLifecycleAndMovementState() {
        DescentSafeFallController controller = launched(100L);
        controller.tick(observation(
            150L, ORIGIN, 0.0D, 0.0D, false, true, true, true, true, true,
            20.0F, true, 1.0D));
        assertTrue(controller.active());
        assertTrue(controller.departed());

        controller.clear();
        assertFalse(controller.active());
        assertFalse(controller.departed());
        assertFalse(controller.committedMovementActive());
        assertNull(controller.phase());
        assertEquals(0L, controller.launchStartedAtMs());
        assertEquals(0, controller.clearanceIndex());
    }

    private static DescentSafeFallController started(
        DescentSafeFallLaunchPlanner.Plan plan,
        long nowMs
    ) {
        DescentSafeFallController controller = new DescentSafeFallController();
        DescentSafeFallController.Decision selected = controller.start(
            new DescentSafeFallController.StartRequest(
                "descent-command", WORLD, plan, 0.0D, 0.0D, 0.30D, 20.0F, nowMs));
        assertEquals(DescentSafeFallController.Phase.SELECTED, selected.phase());
        return controller;
    }

    private static DescentSafeFallController launched(long nowMs) {
        DescentSafeFallController controller = started(plan(List.of()), nowMs);
        controller.tick(origin(nowMs + 10L, false));
        DescentSafeFallController.Decision launch = controller.tick(origin(nowMs + 20L, true));
        assertEquals(DescentSafeFallController.Phase.LAUNCHING, launch.phase());
        return controller;
    }

    private static DescentSafeFallLaunchPlanner.Plan plan(List<VoxelCell> clearance) {
        return new DescentSafeFallLaunchPlanner.Plan(
            ORIGIN, LAUNCH_FEET, LAUNCH_HEAD, COLUMN, LANDING, 2, 0, clearance);
    }

    private static DescentSafeFallLaunchPlanner.Plan directionalPlan(int directionX, int directionZ) {
        VoxelCell launchFeet = new VoxelCell(directionX, 20, directionZ);
        return planWithLaunch(launchFeet);
    }

    private static DescentSafeFallLaunchPlanner.Plan planWithLaunch(VoxelCell launchFeet) {
        return new DescentSafeFallLaunchPlanner.Plan(
            ORIGIN,
            launchFeet,
            new VoxelCell(launchFeet.x(), launchFeet.y() + 1, launchFeet.z()),
            new VoxelCell(launchFeet.x(), launchFeet.y() - 1, launchFeet.z()),
            new VoxelCell(launchFeet.x(), launchFeet.y() - 2, launchFeet.z()),
            2,
            0,
            List.of()
        );
    }

    private static DescentSafeFallController.Observation origin(long nowMs, boolean aligned) {
        return observation(
            nowMs, ORIGIN, 0.0D, 0.0D, true, true, true, true, true, aligned,
            20.0F, true, 1.0D);
    }

    private static DescentSafeFallController.Observation clearance(
        long nowMs,
        DescentSafeFallController.ClearanceStatus status,
        VoxelCell cell,
        boolean packageValid
    ) {
        return observation(
            nowMs, WORLD, ORIGIN, 0.0D, 0.0D, true, true, true, true, true, false,
            20.0F, status, cell, packageValid, 1.0D);
    }

    private static DescentSafeFallController.Observation landing(long nowMs) {
        return landing(nowMs, 20.0F);
    }

    private static DescentSafeFallController.Observation landing(long nowMs, float health) {
        return observation(
            nowMs, LANDING, 1.5D, 0.5D, true, true, true, true, true, true,
            health, true, 0.0D);
    }

    private static DescentSafeFallController.Observation observation(
        long nowMs,
        VoxelCell feet,
        double x,
        double z,
        boolean grounded,
        boolean dry,
        boolean bodyClear,
        boolean hazardFree,
        boolean supportStable,
        boolean aligned,
        float health,
        boolean packageValid,
        double landingDistance
    ) {
        return observation(
            nowMs, WORLD, feet, x, z, grounded, dry, bodyClear, hazardFree, supportStable,
            aligned, health, DescentSafeFallController.ClearanceStatus.NONE, null,
            packageValid, landingDistance);
    }

    private static DescentSafeFallController.Observation observation(
        long nowMs,
        Object world,
        VoxelCell feet,
        double x,
        double z,
        boolean grounded,
        boolean dry,
        boolean bodyClear,
        boolean hazardFree,
        boolean supportStable,
        boolean aligned,
        float health,
        DescentSafeFallController.ClearanceStatus clearance,
        VoxelCell clearanceCell,
        boolean packageValid,
        double landingDistance
    ) {
        return new DescentSafeFallController.Observation(
            nowMs,
            world,
            feet,
            x,
            z,
            grounded,
            dry,
            bodyClear,
            hazardFree,
            supportStable,
            aligned,
            health,
            clearance,
            clearanceCell,
            packageValid,
            landingDistance,
            0.25D
        );
    }
}
