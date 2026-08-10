package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import org.junit.jupiter.api.Test;

final class MissionStoneExecutionControllerTest {
    private static final MissionStoneExecutionController.ExecutionKey KEY =
        new MissionStoneExecutionController.ExecutionKey("stone-1", "world-a", "overworld");
    private static final VoxelCell ORIGIN = new VoxelCell(0, 64, 0);

    @Test
    void faceExecutesOnlyFrozenPrefixWithStableGestureAndValidatedHint() {
        List<BlockPos> blocks = List.of(
            new BlockPos(1, 64, 0),
            new BlockPos(1, 65, 0),
            new BlockPos(1, 66, 0)
        );
        MissionStoneExecutionController controller = new MissionStoneExecutionController();
        MissionStoneExecutionController.FrozenPlan frozen = facePlan(blocks);
        TestGeometry geometry = faceGeometry(blocks);

        MissionStoneExecutionController.StartResult started = controller.begin(
            KEY, frozen, 0, 3, 0L, 20_000L);
        assertTrue(started.started());

        MissionStoneExecutionController.Decision first = tick(controller, ORIGIN, 0, geometry, null, 1L);
        assertEquals(MissionStoneExecutionController.Action.BREAK_BLOCK, first.action());
        assertEquals(blocks.get(0), first.breakTarget());
        assertNotNull(first.nextBlockHint());
        assertEquals(blocks.get(1), first.nextBlockHint().target());
        assertEquals(started.gestureIdentity(), first.gestureIdentity());

        geometry.air(blocks.get(0));
        MissionStoneExecutionController.Decision second = tick(
            controller,
            ORIGIN,
            0,
            geometry,
            broken(blocks.get(0)),
            200L
        );
        assertEquals(MissionStoneExecutionController.Action.BREAK_BLOCK, second.action());
        assertEquals(blocks.get(1), second.breakTarget());
        assertEquals(first.breakerCommandId(), second.breakerCommandId());
        assertEquals(first.gestureIdentity(), second.gestureIdentity());
        assertTrue(second.stoneProducedThisTick());
        assertEquals(1, second.verifiedStoneProduced());
    }

    @Test
    void absoluteInventoryCompletionWinsOverSimultaneousBreakFailureAndDeadline() {
        BlockPos block = new BlockPos(1, 64, 0);
        MissionStoneExecutionController controller = startFace(List.of(block), 19, 20, 0L, 100L);
        TestGeometry geometry = faceGeometry(List.of(block));
        tick(controller, ORIGIN, 19, geometry, null, 1L);

        MissionStoneExecutionController.Decision result = tick(
            controller,
            ORIGIN,
            20,
            geometry,
            new MissionStoneExecutionController.BreakFeedback(
                block, BlockBreakController.Status.FAILED, "timeout"),
            100L
        );

        assertEquals(MissionStoneExecutionController.Action.COMPLETE, result.action());
        assertEquals("inventory_requirement_satisfied", result.reason());
        assertFalse(controller.active());
    }

    @Test
    void facePlanExhaustsWithoutBreakingAnUnplannedBlock() {
        List<BlockPos> planned = List.of(new BlockPos(1, 64, 0), new BlockPos(1, 65, 0));
        MissionStoneExecutionController controller = startFace(planned, 0, 8, 0L, 20_000L);
        TestGeometry geometry = faceGeometry(planned);

        tick(controller, ORIGIN, 0, geometry, null, 1L);
        geometry.air(planned.get(0));
        MissionStoneExecutionController.Decision second = tick(
            controller, ORIGIN, 0, geometry, broken(planned.get(0)), 200L);
        assertEquals(planned.get(1), second.breakTarget());
        geometry.air(planned.get(1));
        MissionStoneExecutionController.Decision exhausted = tick(
            controller, ORIGIN, 0, geometry, broken(planned.get(1)), 400L);

        assertEquals(MissionStoneExecutionController.Action.PLAN_EXHAUSTED, exhausted.action());
        assertEquals(2, exhausted.verifiedBreaks());
        assertFalse(controller.active());
    }

    @Test
    void safeDropHarvestStartsOnlyThroughDedicatedFactoryAndNeverUsesStaircaseMovement() {
        VoxelCell landing = new VoxelCell(4, 62, 0);
        List<BlockPos> blocks = List.of(
            new BlockPos(5, 62, 0),
            new BlockPos(5, 63, 0)
        );
        MissionStoneMethodPlanner.Plan selection = plan(
            MissionStoneMethodPlanner.Method.SAFE_DROP,
            "drop",
            blocks,
            List.of(),
            List.of(),
            blocks.size()
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> MissionStoneExecutionController.FrozenPlan.face(selection, landing)
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> MissionStoneExecutionController.FrozenPlan.safeDropHarvest(
                facePlan(blocks).selection(), landing)
        );

        MissionStoneExecutionController controller = new MissionStoneExecutionController();
        MissionStoneExecutionController.FrozenPlan frozen =
            MissionStoneExecutionController.FrozenPlan.safeDropHarvest(selection, landing);
        assertTrue(controller.begin(KEY, frozen, 0, 2, 0L, 20_000L).started());
        TestGeometry geometry = faceGeometryAt(landing, blocks);

        MissionStoneExecutionController.Decision first = tick(
            controller, landing, 0, geometry, null, 1L);
        assertEquals(MissionStoneMethodPlanner.Method.SAFE_DROP, first.method());
        assertEquals(blocks.getFirst(), first.breakTarget());
        assertNoMovement(first);

        geometry.air(blocks.getFirst());
        MissionStoneExecutionController.Decision second = tick(
            controller, landing, 0, geometry, broken(blocks.getFirst()), 2L);
        assertEquals(blocks.get(1), second.breakTarget());
        assertTrue(second.stoneProducedThisTick());
        assertNoMovement(second);

        geometry.air(blocks.get(1));
        MissionStoneExecutionController.Decision exhausted = tick(
            controller, landing, 0, geometry, broken(blocks.get(1)), 3L);
        assertEquals(MissionStoneExecutionController.Action.PLAN_EXHAUSTED, exhausted.action());
        assertEquals("face_sequence_exhausted", exhausted.reason());
        assertEquals(0, exhausted.staircaseStepIndex());
        assertEquals(MissionStoneExecutionController.MovementPhase.NONE, exhausted.movementPhase());
        assertNoMovement(exhausted);
    }

    @Test
    void safeDropHarvestRejectsAnEmptyProductionPackage() {
        MissionStoneExecutionController controller = new MissionStoneExecutionController();
        MissionStoneMethodPlanner.Plan empty = plan(
            MissionStoneMethodPlanner.Method.SAFE_DROP,
            "empty_drop",
            List.of(),
            List.of(),
            List.of(),
            1
        );

        MissionStoneExecutionController.StartResult rejected = controller.begin(
            KEY,
            MissionStoneExecutionController.FrozenPlan.safeDropHarvest(empty, ORIGIN),
            0,
            1,
            0L,
            20_000L
        );

        assertFalse(rejected.started());
        assertEquals("invalid_face_sequence", rejected.reason());
        assertFalse(controller.active());
    }

    @Test
    void nonterminalBreakFeedbackNeverAdvancesTheCursor() {
        BlockPos block = new BlockPos(1, 64, 0);
        MissionStoneExecutionController controller = startFace(List.of(block), 0, 1, 0L, 20_000L);
        TestGeometry geometry = faceGeometry(List.of(block));
        tick(controller, ORIGIN, 0, geometry, null, 1L);

        MissionStoneExecutionController.Decision running = tick(
            controller,
            ORIGIN,
            0,
            geometry,
            new MissionStoneExecutionController.BreakFeedback(
                block, BlockBreakController.Status.RUNNING, "breaking"),
            2_000L
        );

        assertEquals(MissionStoneExecutionController.Action.BREAK_BLOCK, running.action());
        assertEquals(0, running.plannedBreakCursor());
        assertEquals(0, running.verifiedBreaks());
    }

    @Test
    void brokenFeedbackRequiresWorldResamplingToAir() {
        BlockPos block = new BlockPos(1, 64, 0);
        MissionStoneExecutionController controller = startFace(List.of(block), 0, 1, 0L, 20_000L);
        TestGeometry geometry = faceGeometry(List.of(block));
        tick(controller, ORIGIN, 0, geometry, null, 1L);

        MissionStoneExecutionController.Decision rejected = tick(
            controller, ORIGIN, 0, geometry, broken(block), 200L);

        assertEquals(MissionStoneExecutionController.Action.REJECTED, rejected.action());
        assertEquals("broken_block_not_air", rejected.reason());
        assertEquals(0, rejected.verifiedStoneProduced());
    }

    @Test
    void geometryChangesAndRepositionRequestsFailClosed() {
        BlockPos block = new BlockPos(1, 64, 0);
        MissionStoneExecutionController controller = startFace(List.of(block), 0, 1, 0L, 20_000L);
        TestGeometry geometry = faceGeometry(List.of(block));
        geometry.block(block, MissionStoneExecutionController.RuntimeMaterial.ORE);

        MissionStoneExecutionController.Decision changed = tick(
            controller, ORIGIN, 0, geometry, null, 1L);
        assertEquals(MissionStoneExecutionController.Action.REJECTED, changed.action());
        assertTrue(changed.reason().startsWith("break_geometry_changed"));

        controller = startFace(List.of(block), 0, 1, 0L, 20_000L);
        geometry.block(block, MissionStoneExecutionController.RuntimeMaterial.STONE);
        tick(controller, ORIGIN, 0, geometry, null, 1L);
        MissionStoneExecutionController.Decision reposition = tick(
            controller,
            ORIGIN,
            0,
            geometry,
            new MissionStoneExecutionController.BreakFeedback(
                block, BlockBreakController.Status.REPOSITION, "occluded"),
            2L
        );
        assertEquals(MissionStoneExecutionController.Action.REJECTED, reposition.action());
        assertTrue(reposition.reason().startsWith("break_reposition_forbidden"));
    }

    @Test
    void airConfirmationRetainsCurrentTargetAndPreaimsTheNextValidatedBlock() {
        List<BlockPos> blocks = List.of(new BlockPos(1, 64, 0), new BlockPos(1, 65, 0));
        MissionStoneExecutionController controller = startFace(blocks, 0, 2, 0L, 20_000L);
        TestGeometry geometry = faceGeometry(blocks);
        tick(controller, ORIGIN, 0, geometry, null, 1L);
        geometry.air(blocks.get(0));

        MissionStoneExecutionController.Decision confirming = tick(
            controller,
            ORIGIN,
            0,
            geometry,
            new MissionStoneExecutionController.BreakFeedback(
                blocks.get(0), BlockBreakController.Status.RUNNING, "block_air_confirming"),
            100L
        );

        assertEquals(MissionStoneExecutionController.Action.BREAK_BLOCK, confirming.action());
        assertEquals(blocks.get(0), confirming.breakTarget());
        assertEquals(blocks.get(1), confirming.nextBlockHint().target());
        assertEquals("break_air_confirming", confirming.reason());
    }

    @Test
    void invalidNextTargetSuppressesPreaimWithoutRejectingCurrentBreak() {
        List<BlockPos> blocks = List.of(new BlockPos(1, 64, 0), new BlockPos(1, 65, 0));
        MissionStoneExecutionController controller = startFace(blocks, 0, 2, 0L, 20_000L);
        TestGeometry geometry = faceGeometry(blocks);
        geometry.unreachable(blocks.get(1));

        MissionStoneExecutionController.Decision decision = tick(
            controller, ORIGIN, 0, geometry, null, 1L);

        assertEquals(blocks.get(0), decision.breakTarget());
        assertNull(decision.nextBlockHint());
    }

    @Test
    void staircaseClearsFrozenCellsThenUsesCommittedOneBlockLanding() {
        StairPackage stairs = staircase(2);
        MissionStoneExecutionController controller = startStaircase(stairs, 0, 6, 0L, 30_000L);
        TestGeometry geometry = staircaseGeometry(stairs);
        VoxelCell origin = voxel(stairs.steps().getFirst().currentFeet());

        long now = 1L;
        for (int index = 0; index < 3; index++) {
            MissionStoneExecutionController.Decision breaking = tick(
                controller, origin, 0, geometry, null, now++);
            assertEquals(stairs.breaks().get(index).position(), breaking.breakTarget());
            geometry.air(breaking.breakTarget());
            MissionStoneExecutionController.Decision after = tick(
                controller, origin, 0, geometry, broken(breaking.breakTarget()), now++);
            if (index < 2) {
                assertEquals(MissionStoneExecutionController.Action.BREAK_BLOCK, after.action());
            } else {
                assertEquals(MissionStoneExecutionController.Action.MOVE, after.action());
                assertEquals("staircase_movement:descent_selected", after.reason());
                assertFalse(after.descentExempt());
            }
        }

        MissionStoneExecutionController.Decision aligning = tick(
            controller, origin, 0, geometry, null, now++);
        assertEquals("staircase_movement:descent_aligning", aligning.reason());
        assertFalse(aligning.descentExempt());

        MissionStoneExecutionController.Decision launch = tick(
            controller,
            observation(origin, true, true, 0),
            geometry,
            null,
            now++
        );
        assertTrue(launch.forward());
        assertFalse(launch.jump());
        assertFalse(launch.sneak());
        assertTrue(launch.descentExempt());
        assertEquals("staircase_movement:descent_launching", launch.reason());

        VoxelCell landing = voxel(stairs.steps().getFirst().nextFeet());
        MissionStoneExecutionController.Decision settle = tick(
            controller, landing, 0, geometry, null, now++);
        assertEquals("staircase_movement:descent_landing_column_captured", settle.reason());
        assertFalse(settle.descentExempt());
        MissionStoneExecutionController.Decision landed = tick(
            controller, landing, 0, geometry, null, now++);
        assertEquals("staircase_step_landed", landed.reason());
        assertTrue(landed.stepLandedThisTick());
        assertEquals(1, landed.staircaseStepIndex());
    }

    @Test
    void inventorySatisfactionOnFirstLandingPollWaitsForCommittedLandingThenCompletes() {
        StairPackage stairs = staircase(1);
        MissionStoneExecutionController controller = startStaircase(
            stairs, 0, 3, 0L, 30_000L);
        TestGeometry geometry = staircaseGeometry(stairs);
        VoxelCell origin = voxel(stairs.steps().getFirst().currentFeet());
        VoxelCell landing = voxel(stairs.steps().getFirst().nextFeet());
        long now = clearFirstStepAndSelectMovement(controller, stairs, geometry, origin, 10L);

        assertFalse(controller.committedMovementActive());
        assertEquals(
            MissionStoneExecutionController.MovementPhase.SELECTED,
            controller.committedMovementPhase()
        );
        tick(controller, origin, 0, geometry, null, now++); // SELECTED -> ALIGNING
        tick(controller, observation(origin, true, true, 0), geometry, null, now++); // launch

        MissionStoneExecutionController.Decision firstLandingPoll = tick(
            controller, landing, 3, geometry, null, now++);
        assertEquals(MissionStoneExecutionController.Action.MOVE, firstLandingPoll.action());
        assertEquals(
            "staircase_movement:descent_landing_column_captured",
            firstLandingPoll.reason()
        );
        assertTrue(controller.committedMovementActive());
        assertEquals(
            MissionStoneExecutionController.MovementPhase.LAND_SETTLE,
            controller.committedMovementPhase()
        );

        MissionStoneExecutionController.Decision landed = tick(
            controller, landing, 3, geometry, null, now++);
        assertEquals(MissionStoneExecutionController.Action.HOLD, landed.action());
        assertEquals("staircase_step_landed", landed.reason());
        assertTrue(landed.stepLandedThisTick());
        assertFalse(controller.committedMovementActive());

        MissionStoneExecutionController.Decision completed = tick(
            controller, landing, 3, geometry, null, now++);
        assertEquals(MissionStoneExecutionController.Action.COMPLETE, completed.action());
        assertEquals("inventory_requirement_satisfied", completed.reason());
        assertFalse(controller.active());
    }

    @Test
    void inventorySatisfactionWhileAligningCancelsBeforeLaunch() {
        StairPackage stairs = staircase(1);
        MissionStoneExecutionController controller = startStaircase(
            stairs, 0, 3, 0L, 30_000L);
        TestGeometry geometry = staircaseGeometry(stairs);
        VoxelCell origin = voxel(stairs.steps().getFirst().currentFeet());
        long now = clearFirstStepAndSelectMovement(controller, stairs, geometry, origin, 10L);

        MissionStoneExecutionController.Decision aligning = tick(
            controller, origin, 0, geometry, null, now++);
        assertEquals("staircase_movement:descent_aligning", aligning.reason());
        assertEquals(
            MissionStoneExecutionController.MovementPhase.ALIGNING,
            controller.committedMovementPhase()
        );
        assertFalse(controller.committedMovementActive());

        MissionStoneExecutionController.Decision completed = tick(
            controller, observation(origin, true, true, 3), geometry, null, now++);
        assertEquals(MissionStoneExecutionController.Action.COMPLETE, completed.action());
        assertEquals("inventory_requirement_satisfied", completed.reason());
        assertFalse(completed.forward());
        assertFalse(completed.descentExempt());
        assertFalse(controller.active());
    }

    @Test
    void commandDeadlineOnFirstLandingPollWaitsForCommittedLandingThenRejects() {
        StairPackage stairs = staircase(1);
        MissionStoneExecutionController controller = startStaircase(
            stairs, 0, 3, 0L, 18L);
        TestGeometry geometry = staircaseGeometry(stairs);
        VoxelCell origin = voxel(stairs.steps().getFirst().currentFeet());
        VoxelCell landing = voxel(stairs.steps().getFirst().nextFeet());
        long now = clearFirstStepAndSelectMovement(controller, stairs, geometry, origin, 10L);

        tick(controller, origin, 0, geometry, null, now++); // SELECTED -> ALIGNING
        tick(controller, observation(origin, true, true, 0), geometry, null, now++); // launch
        assertEquals(18L, now);

        MissionStoneExecutionController.Decision firstLandingPoll = tick(
            controller, landing, 0, geometry, null, now++);
        assertEquals(MissionStoneExecutionController.Action.MOVE, firstLandingPoll.action());
        assertEquals(
            "staircase_movement:descent_landing_column_captured",
            firstLandingPoll.reason()
        );
        assertEquals(0L, firstLandingPoll.remainingDeadlineMs());
        assertTrue(controller.committedMovementActive());

        MissionStoneExecutionController.Decision landed = tick(
            controller, landing, 0, geometry, null, now++);
        assertEquals(MissionStoneExecutionController.Action.HOLD, landed.action());
        assertEquals("staircase_step_landed", landed.reason());
        assertTrue(landed.stepLandedThisTick());
        assertFalse(controller.committedMovementActive());

        MissionStoneExecutionController.Decision deadline = tick(
            controller, landing, 0, geometry, null, now++);
        assertEquals(MissionStoneExecutionController.Action.REJECTED, deadline.action());
        assertEquals("command_deadline", deadline.reason());
        assertFalse(controller.active());
    }

    @Test
    void staircaseNeverMovesUntilCompleteStepEnvelopeIsActuallyAir() {
        StairPackage stairs = staircase(1);
        MissionStoneExecutionController controller = startStaircase(stairs, 0, 3, 0L, 30_000L);
        TestGeometry geometry = staircaseGeometry(stairs);
        VoxelCell origin = voxel(stairs.steps().getFirst().currentFeet());

        for (int index = 0; index < 3; index++) {
            MissionStoneExecutionController.Decision target = tick(
                controller, origin, 0, geometry, null, 10L + index * 2L);
            if (index != 2) {
                geometry.air(target.breakTarget());
            }
            MissionStoneExecutionController.Decision result = tick(
                controller,
                origin,
                0,
                geometry,
                broken(target.breakTarget()),
                11L + index * 2L
            );
            if (index == 2) {
                assertEquals(MissionStoneExecutionController.Action.REJECTED, result.action());
                assertEquals("broken_block_not_air", result.reason());
            }
        }
    }

    @Test
    void committedLandingNeverReportsAMissWhileStillAtTheFrozenOrigin() {
        StairPackage stairs = staircase(1);
        MissionStoneExecutionController controller = startStaircase(stairs, 0, 3, 0L, 30_000L);
        TestGeometry geometry = staircaseGeometry(stairs);
        VoxelCell origin = voxel(stairs.steps().getFirst().currentFeet());
        long now = clearFirstStepAndSelectMovement(controller, stairs, geometry, origin, 10L);

        tick(controller, origin, 0, geometry, null, now++); // SELECTED -> ALIGNING
        MissionStoneExecutionController.Decision launch = tick(
            controller, observation(origin, true, true, 0), geometry, null, now++);
        assertEquals("staircase_movement:descent_launching", launch.reason());

        MissionStoneExecutionController.Decision originHold = tick(
            controller,
            observation(origin, true, true, 0),
            geometry,
            null,
            now + 2_000L
        );
        assertEquals("staircase_movement:descent_launching", originHold.reason());
        assertTrue(originHold.forward());
        assertTrue(originHold.descentExempt());
        assertFalse(originHold.reason().contains("missed"));

        MissionStoneExecutionController.Decision timeout = tick(
            controller,
            observation(origin, true, true, 0),
            geometry,
            null,
            now + 3_000L
        );
        assertEquals(MissionStoneExecutionController.Action.REJECTED, timeout.action());
        assertEquals("staircase_movement:descent_timeout", timeout.reason());
    }

    @Test
    void elevatedLandingColumnCaptureNeutralizesForwardUntilExactLandingSettles() {
        StairPackage stairs = staircase(1);
        MissionStoneExecutionController controller = startStaircase(stairs, 0, 3, 0L, 30_000L);
        TestGeometry geometry = staircaseGeometry(stairs);
        VoxelCell origin = voxel(stairs.steps().getFirst().currentFeet());
        VoxelCell landing = voxel(stairs.steps().getFirst().nextFeet());
        VoxelCell elevatedColumn = new VoxelCell(landing.x(), origin.y(), landing.z());
        geometry.safeStance(elevatedColumn);
        long now = clearFirstStepAndSelectMovement(controller, stairs, geometry, origin, 10L);

        tick(controller, origin, 0, geometry, null, now++); // SELECTED -> ALIGNING
        tick(controller, observation(origin, true, true, 0), geometry, null, now++); // launch
        MissionStoneExecutionController.Decision transit = tick(
            controller,
            observation(elevatedColumn, true, true, 0),
            geometry,
            null,
            now++
        );

        assertEquals(MissionStoneExecutionController.Action.MOVE, transit.action());
        assertEquals("staircase_movement:descent_landing_column_captured", transit.reason());
        assertFalse(transit.forward());
        assertFalse(transit.descentExempt());
        assertTrue(controller.landingColumnCaptured());

        MissionStoneExecutionController.Decision falling = tick(
            controller,
            observation(elevatedColumn, false, true, 0),
            geometry,
            null,
            now++
        );
        assertEquals("staircase_movement:descent_landing_column_captured", falling.reason());
        assertFalse(falling.forward());
        assertTrue(controller.landingColumnCaptured());

        MissionStoneExecutionController.Decision settle = tick(
            controller, landing, 0, geometry, null, now++);
        assertEquals("staircase_movement:descent_landing_settling", settle.reason());
        assertFalse(settle.forward());
        MissionStoneExecutionController.Decision reached = tick(
            controller, landing, 0, geometry, null, now++);
        assertTrue(reached.stepLandedThisTick());
        assertFalse(controller.landingColumnCaptured());
    }

    @Test
    void directLaunchToLandingSampleEmitsOneCaptureBeforeArrival() {
        StairPackage stairs = staircase(1);
        MissionStoneExecutionController controller = startStaircase(stairs, 0, 3, 0L, 30_000L);
        TestGeometry geometry = staircaseGeometry(stairs);
        VoxelCell origin = voxel(stairs.steps().getFirst().currentFeet());
        VoxelCell landing = voxel(stairs.steps().getFirst().nextFeet());
        long now = clearFirstStepAndSelectMovement(controller, stairs, geometry, origin, 10L);

        tick(controller, origin, 0, geometry, null, now++); // SELECTED -> ALIGNING
        tick(controller, observation(origin, true, true, 0), geometry, null, now++); // launch

        MissionStoneExecutionController.Decision captured = tick(
            controller, landing, 0, geometry, null, now++);
        assertEquals(MissionStoneExecutionController.Action.MOVE, captured.action());
        assertEquals(
            "staircase_movement:descent_landing_column_captured", captured.reason());
        assertFalse(captured.forward());
        assertFalse(captured.descentExempt());
        assertTrue(controller.landingColumnCaptured());

        MissionStoneExecutionController.Decision reached = tick(
            controller, landing, 0, geometry, null, now++);
        assertTrue(reached.stepLandedThisTick());
        assertFalse(controller.landingColumnCaptured());
    }

    @Test
    void landingColumnCaptureWaitsForTrailingEdgeAndNeverReengagesForward() {
        StairPackage stairs = staircase(1);
        MissionStoneExecutionController controller = startStaircase(stairs, 0, 3, 0L, 30_000L);
        TestGeometry geometry = staircaseGeometry(stairs);
        VoxelCell origin = voxel(stairs.steps().getFirst().currentFeet());
        VoxelCell landing = voxel(stairs.steps().getFirst().nextFeet());
        VoxelCell elevatedColumn = new VoxelCell(landing.x(), origin.y(), landing.z());
        geometry.safeStance(elevatedColumn);
        long now = clearFirstStepAndSelectMovement(controller, stairs, geometry, origin, 10L);

        tick(controller, origin, 0, geometry, null, now++); // SELECTED -> ALIGNING
        tick(controller, observation(origin, true, true, 0), geometry, null, now++); // launch

        MissionStoneExecutionController.Decision leadingEdgeOnly = tick(
            controller,
            observationAt(elevatedColumn, 1.05D, 64.0D, 0.5D, true, 0),
            geometry,
            null,
            now++
        );
        assertEquals("staircase_movement:descent_departed", leadingEdgeOnly.reason());
        assertTrue(leadingEdgeOnly.forward());
        assertFalse(controller.landingColumnCaptured());

        MissionStoneExecutionController.Decision captured = tick(
            controller,
            observationAt(elevatedColumn, 1.32D, 64.0D, 0.5D, true, 0),
            geometry,
            null,
            now++
        );
        assertEquals("staircase_movement:descent_landing_column_captured", captured.reason());
        assertFalse(captured.forward());
        assertTrue(controller.landingColumnCaptured());

        MissionStoneExecutionController.Decision recededInsideColumn = tick(
            controller,
            observationAt(elevatedColumn, 1.05D, 64.0D, 0.5D, true, 0),
            geometry,
            null,
            now++
        );
        assertEquals(
            "staircase_movement:descent_landing_column_captured",
            recededInsideColumn.reason()
        );
        assertFalse(recededInsideColumn.forward());
        assertTrue(controller.landingColumnCaptured());
    }

    @Test
    void landingColumnCaptureThresholdIsDirectionalForEveryCardinalHeading() {
        VoxelCell origin = new VoxelCell(0, 64, 0);

        assertFalse(MissionStoneExecutionController.clearsOriginSupport(
            origin, new VoxelCell(1, 63, 0), 1.30D, 0.5D));
        assertTrue(MissionStoneExecutionController.clearsOriginSupport(
            origin, new VoxelCell(1, 63, 0), 1.32D, 0.5D));

        assertFalse(MissionStoneExecutionController.clearsOriginSupport(
            origin, new VoxelCell(-1, 63, 0), -0.30D, 0.5D));
        assertTrue(MissionStoneExecutionController.clearsOriginSupport(
            origin, new VoxelCell(-1, 63, 0), -0.32D, 0.5D));

        assertFalse(MissionStoneExecutionController.clearsOriginSupport(
            origin, new VoxelCell(0, 63, 1), 0.5D, 1.30D));
        assertTrue(MissionStoneExecutionController.clearsOriginSupport(
            origin, new VoxelCell(0, 63, 1), 0.5D, 1.32D));

        assertFalse(MissionStoneExecutionController.clearsOriginSupport(
            origin, new VoxelCell(0, 63, -1), 0.5D, -0.30D));
        assertTrue(MissionStoneExecutionController.clearsOriginSupport(
            origin, new VoxelCell(0, 63, -1), 0.5D, -0.32D));

        assertFalse(MissionStoneExecutionController.clearsOriginSupport(
            origin, origin, 0.5D, 0.5D));
        assertFalse(MissionStoneExecutionController.clearsOriginSupport(
            origin, new VoxelCell(1, 64, 0), 1.32D, 0.5D));
        assertFalse(MissionStoneExecutionController.clearsOriginSupport(
            origin, new VoxelCell(1, 62, 0), 1.32D, 0.5D));
        assertFalse(MissionStoneExecutionController.clearsOriginSupport(
            origin, new VoxelCell(1, 63, 1), 1.5D, 1.5D));
        assertFalse(MissionStoneExecutionController.clearsOriginSupport(
            origin, new VoxelCell(1, 63, 0), Double.NaN, 0.5D));
    }

    @Test
    void leavingALatchedLandingColumnFailsClosedWithoutReengagingForward() {
        StairPackage stairs = staircase(1);
        MissionStoneExecutionController controller = startStaircase(stairs, 0, 3, 0L, 30_000L);
        TestGeometry geometry = staircaseGeometry(stairs);
        VoxelCell origin = voxel(stairs.steps().getFirst().currentFeet());
        VoxelCell landing = voxel(stairs.steps().getFirst().nextFeet());
        VoxelCell elevatedColumn = new VoxelCell(landing.x(), origin.y(), landing.z());
        geometry.safeStance(elevatedColumn);
        long now = clearFirstStepAndSelectMovement(controller, stairs, geometry, origin, 10L);

        tick(controller, origin, 0, geometry, null, now++);
        tick(controller, observation(origin, true, true, 0), geometry, null, now++);
        MissionStoneExecutionController.Decision captured = tick(
            controller,
            observationAt(elevatedColumn, 1.32D, 64.0D, 0.5D, true, 0),
            geometry,
            null,
            now++
        );
        assertFalse(captured.forward());
        assertTrue(controller.landingColumnCaptured());

        VoxelCell offColumn = new VoxelCell(landing.x(), landing.y(), landing.z() + 1);
        geometry.safeStance(offColumn);
        MissionStoneExecutionController.Decision rejected = tick(
            controller, offColumn, 0, geometry, null, now++);

        assertEquals(MissionStoneExecutionController.Action.REJECTED, rejected.action());
        assertEquals("staircase_movement:descent_missed", rejected.reason());
        assertFalse(rejected.forward());
        assertFalse(rejected.descentExempt());
        assertFalse(controller.active());
    }

    @Test
    void offTargetGroundedLandingRejectsOnlyAfterPhysicalDeparture() {
        StairPackage stairs = staircase(1);
        MissionStoneExecutionController controller = startStaircase(stairs, 0, 3, 0L, 30_000L);
        TestGeometry geometry = staircaseGeometry(stairs);
        VoxelCell origin = voxel(stairs.steps().getFirst().currentFeet());
        long now = clearFirstStepAndSelectMovement(controller, stairs, geometry, origin, 10L);
        tick(controller, origin, 0, geometry, null, now++);
        tick(controller, observation(origin, true, true, 0), geometry, null, now++);

        VoxelCell offTarget = new VoxelCell(origin.x(), origin.y() - 1, origin.z() + 1);
        geometry.safeStance(offTarget);
        MissionStoneExecutionController.Decision missed = tick(
            controller, offTarget, 0, geometry, null, now++);

        assertEquals(MissionStoneExecutionController.Action.REJECTED, missed.action());
        assertEquals("staircase_movement:descent_missed", missed.reason());
        assertFalse(missed.forward());
        assertFalse(missed.descentExempt());
    }

    @Test
    void runtimeLandingHazardRejectsWithoutMovementOrRecovery() {
        StairPackage stairs = staircase(1);
        MissionStoneExecutionController controller = startStaircase(stairs, 0, 3, 0L, 30_000L);
        TestGeometry geometry = staircaseGeometry(stairs);
        VoxelCell origin = voxel(stairs.steps().getFirst().currentFeet());

        for (MissionStoneMethodPlanner.BreakCell cell : stairs.breaks()) {
            MissionStoneExecutionController.Decision target = tick(
                controller, origin, 0, geometry, null, 1L);
            geometry.air(cell.position());
            MissionStoneExecutionController.Decision after = tick(
                controller, origin, 0, geometry, broken(cell.position()), 2L);
            if (cell.equals(stairs.breaks().getLast())) {
                // The last feedback would normally select movement; invalidate before resampling it.
                assertEquals(MissionStoneExecutionController.Action.MOVE, after.action());
            } else {
                assertEquals(MissionStoneExecutionController.Action.BREAK_BLOCK, after.action());
            }
        }

        // A change after selection is still caught by the movement motor's per-tick validator.
        VoxelCell landing = voxel(stairs.steps().getFirst().nextFeet());
        geometry.unsafeStance(landing);
        MissionStoneExecutionController.Decision rejected = tick(
            controller, origin, 0, geometry, null, 10L);
        assertEquals(MissionStoneExecutionController.Action.REJECTED, rejected.action());
        assertTrue(rejected.reason().startsWith("staircase_movement:"));
        assertFalse(rejected.forward());
        assertFalse(rejected.jump());
    }

    @Test
    void safeNonOreClearanceDoesNotProduceCobblestone() {
        StairPackage stairs = staircase(
            List.of(MissionStoneMethodPlanner.BreakMaterial.SAFE_NON_ORE,
                MissionStoneMethodPlanner.BreakMaterial.STONE,
                MissionStoneMethodPlanner.BreakMaterial.STONE));
        MissionStoneExecutionController controller = startStaircase(stairs, 0, 2, 0L, 30_000L);
        TestGeometry geometry = staircaseGeometry(stairs);
        VoxelCell origin = voxel(stairs.steps().getFirst().currentFeet());

        MissionStoneExecutionController.Decision first = tick(
            controller, origin, 0, geometry, null, 1L);
        geometry.air(first.breakTarget());
        MissionStoneExecutionController.Decision after = tick(
            controller, origin, 0, geometry, broken(first.breakTarget()), 2L);
        assertFalse(after.stoneProducedThisTick());
        assertEquals(0, after.verifiedStoneProduced());

        geometry.air(after.breakTarget());
        MissionStoneExecutionController.Decision stone = tick(
            controller, origin, 0, geometry, broken(after.breakTarget()), 3L);
        assertTrue(stone.stoneProducedThisTick());
        assertEquals(1, stone.verifiedStoneProduced());
    }

    @Test
    void aBreakPrefixEndingMidStepStopsInsteadOfExcavatingTheRestOfTheEnvelope() {
        StairPackage full = staircase(1);
        MissionStoneMethodPlanner.Plan prefixPlan = plan(
            MissionStoneMethodPlanner.Method.STAIRCASE,
            "stairs",
            List.of(),
            full.breaks().subList(0, 1),
            full.steps(),
            1,
            0
        );
        MissionStoneExecutionController controller = new MissionStoneExecutionController();
        assertTrue(controller.begin(
            KEY,
            MissionStoneExecutionController.FrozenPlan.staircase(prefixPlan),
            0,
            8,
            0L,
            30_000L
        ).started());
        TestGeometry geometry = staircaseGeometry(full);
        VoxelCell origin = voxel(full.steps().getFirst().currentFeet());

        MissionStoneExecutionController.Decision target = tick(
            controller, origin, 0, geometry, null, 1L);
        geometry.air(target.breakTarget());
        MissionStoneExecutionController.Decision exhausted = tick(
            controller, origin, 0, geometry, broken(target.breakTarget()), 2L);

        assertEquals(MissionStoneExecutionController.Action.PLAN_EXHAUSTED, exhausted.action());
        assertEquals("exact_break_prefix_exhausted", exhausted.reason());
        assertFalse(exhausted.forward());
        assertEquals(1, exhausted.verifiedBreaks());
    }

    @Test
    void commandWorldAndDimensionChangesClearAllExecutionState() {
        MissionStoneExecutionController controller = startFace(
            List.of(new BlockPos(1, 64, 0)), 0, 1, 0L, 20_000L);
        TestGeometry geometry = faceGeometry(List.of(new BlockPos(1, 64, 0)));
        MissionStoneExecutionController.ExecutionKey changed =
            new MissionStoneExecutionController.ExecutionKey("stone-1", "world-b", "overworld");

        MissionStoneExecutionController.Decision rejected = controller.tick(
            MissionStoneExecutionController.Observation.centered(changed, ORIGIN, true, true, 0),
            geometry,
            null,
            1L
        );

        assertEquals(MissionStoneExecutionController.Action.REJECTED, rejected.action());
        assertEquals("lifecycle_changed", rejected.reason());
        assertFalse(controller.active());
        assertEquals(MissionStoneExecutionController.Action.IDLE,
            controller.tick(null, geometry, null, 2L).action());
    }

    @Test
    void deadlineIsFixedAndResetAllowsACompletelyNewPlan() {
        BlockPos block = new BlockPos(1, 64, 0);
        MissionStoneExecutionController controller = startFace(List.of(block), 0, 1, 10L, 100L);
        TestGeometry geometry = faceGeometry(List.of(block));

        MissionStoneExecutionController.Decision deadline = tick(
            controller, ORIGIN, 0, geometry, null, 100L);
        assertEquals(MissionStoneExecutionController.Action.REJECTED, deadline.action());
        assertEquals("command_deadline", deadline.reason());

        MissionStoneExecutionController.StartResult restarted = controller.begin(
            KEY, facePlan(List.of(block)), 0, 1, 101L, 200L);
        assertTrue(restarted.started());
        controller.reset();
        assertFalse(controller.active());
    }

    @Test
    void invalidOrChangingHeadingsAndOwnSupportMiningNeverStart() {
        StairPackage packageOne = staircase(2);
        List<StaircaseDescentPlanner.Step> changing = List.of(
            packageOne.steps().get(0),
            StaircaseDescentPlanner.stepFrom(
                packageOne.steps().get(0).nextFeet(), StaircaseDescentPlanner.south(), 2)
        );
        MissionStoneMethodPlanner.Plan invalid = plan(
            MissionStoneMethodPlanner.Method.STAIRCASE,
            "stairs",
            List.of(),
            packageOne.breaks(),
            changing,
            packageOne.breaks().size()
        );
        MissionStoneExecutionController controller = new MissionStoneExecutionController();
        MissionStoneExecutionController.StartResult heading = controller.begin(
            KEY,
            new MissionStoneExecutionController.FrozenPlan(invalid, ORIGIN, null, null),
            0,
            6,
            0L,
            30_000L
        );
        assertFalse(heading.started());
        assertEquals("staircase_heading_changed", heading.reason());

        assertThrows(IllegalArgumentException.class, () ->
            MissionStoneExecutionController.FrozenPlan.face(
                new MissionStoneMethodPlanner.Plan(
                    MissionStoneMethodPlanner.Method.SAFE_DROP,
                    "drop",
                    1,
                    1,
                    1,
                    1,
                    1,
                    cost(),
                    List.of(),
                    List.of(),
                    List.of(),
                    0
                ),
                ORIGIN
            )
        );
    }

    private MissionStoneExecutionController startFace(
        List<BlockPos> blocks,
        int owned,
        int target,
        long nowMs,
        long deadlineAtMs
    ) {
        MissionStoneExecutionController controller = new MissionStoneExecutionController();
        assertTrue(controller.begin(KEY, facePlan(blocks), owned, target, nowMs, deadlineAtMs).started());
        return controller;
    }

    private MissionStoneExecutionController.FrozenPlan facePlan(List<BlockPos> blocks) {
        return MissionStoneExecutionController.FrozenPlan.face(
            plan(
                MissionStoneMethodPlanner.Method.REACHABLE_FACE,
                "face",
                blocks,
                List.of(),
                List.of(),
                blocks.size()
            ),
            ORIGIN
        );
    }

    private MissionStoneExecutionController startStaircase(
        StairPackage stairs,
        int owned,
        int target,
        long nowMs,
        long deadlineAtMs
    ) {
        MissionStoneExecutionController controller = new MissionStoneExecutionController();
        MissionStoneMethodPlanner.Plan selection = plan(
            MissionStoneMethodPlanner.Method.STAIRCASE,
            "stairs",
            List.of(),
            stairs.breaks(),
            stairs.steps(),
            stairs.breaks().size()
        );
        assertTrue(controller.begin(
            KEY,
            MissionStoneExecutionController.FrozenPlan.staircase(selection),
            owned,
            target,
            nowMs,
            deadlineAtMs
        ).started());
        return controller;
    }

    private long clearFirstStepAndSelectMovement(
        MissionStoneExecutionController controller,
        StairPackage stairs,
        TestGeometry geometry,
        VoxelCell origin,
        long now
    ) {
        for (MissionStoneMethodPlanner.BreakCell cell : stairs.breaks().subList(0, 3)) {
            MissionStoneExecutionController.Decision target = tick(
                controller, origin, 0, geometry, null, now++);
            assertEquals(cell.position(), target.breakTarget());
            geometry.air(cell.position());
            tick(controller, origin, 0, geometry, broken(cell.position()), now++);
        }
        return now;
    }

    private MissionStoneMethodPlanner.Plan plan(
        MissionStoneMethodPlanner.Method method,
        String identity,
        List<BlockPos> face,
        List<MissionStoneMethodPlanner.BreakCell> breaks,
        List<StaircaseDescentPlanner.Step> steps,
        int plannedBreaks
    ) {
        return plan(method, identity, face, breaks, steps, plannedBreaks, steps.size());
    }

    private MissionStoneMethodPlanner.Plan plan(
        MissionStoneMethodPlanner.Method method,
        String identity,
        List<BlockPos> face,
        List<MissionStoneMethodPlanner.BreakCell> breaks,
        List<StaircaseDescentPlanner.Step> steps,
        int plannedBreaks,
        int completedSteps
    ) {
        return new MissionStoneMethodPlanner.Plan(
            method,
            identity,
            8,
            Math.max(1, plannedBreaks),
            plannedBreaks,
            steps.size(),
            steps.size(),
            cost(),
            face,
            breaks,
            steps,
            completedSteps
        );
    }

    private MissionStoneMethodPlanner.Cost cost() {
        return new MissionStoneMethodPlanner.Cost(0L, 0L, 0L, 0L, 0L, 0L, 0L, 0L, 0L, 1L);
    }

    private StairPackage staircase(int stepCount) {
        StaircaseDescentPlanner.Direction2d direction = StaircaseDescentPlanner.east();
        List<StaircaseDescentPlanner.Step> steps = new java.util.ArrayList<>();
        List<MissionStoneMethodPlanner.BreakCell> breaks = new java.util.ArrayList<>();
        BlockPos start = block(ORIGIN);
        for (int index = 1; index <= stepCount; index++) {
            StaircaseDescentPlanner.Step step = StaircaseDescentPlanner.step(start, direction, index);
            steps.add(step);
            breaks.add(new MissionStoneMethodPlanner.BreakCell(
                step.sightClear(), MissionStoneMethodPlanner.BreakMaterial.STONE));
            breaks.add(new MissionStoneMethodPlanner.BreakCell(
                step.upperClear(), MissionStoneMethodPlanner.BreakMaterial.STONE));
            breaks.add(new MissionStoneMethodPlanner.BreakCell(
                step.lowerClear(), MissionStoneMethodPlanner.BreakMaterial.STONE));
        }
        return new StairPackage(List.copyOf(steps), List.copyOf(breaks));
    }

    private StairPackage staircase(List<MissionStoneMethodPlanner.BreakMaterial> materials) {
        StairPackage base = staircase(1);
        List<MissionStoneMethodPlanner.BreakCell> breaks = new java.util.ArrayList<>();
        for (int index = 0; index < materials.size(); index++) {
            breaks.add(new MissionStoneMethodPlanner.BreakCell(
                base.breaks().get(index).position(), materials.get(index)));
        }
        return new StairPackage(base.steps(), List.copyOf(breaks));
    }

    private TestGeometry faceGeometry(List<BlockPos> blocks) {
        return faceGeometryAt(ORIGIN, blocks);
    }

    private TestGeometry faceGeometryAt(VoxelCell stance, List<BlockPos> blocks) {
        TestGeometry geometry = new TestGeometry();
        geometry.safeStance(stance);
        blocks.forEach(block -> geometry.block(
            block, MissionStoneExecutionController.RuntimeMaterial.STONE));
        return geometry;
    }

    private void assertNoMovement(MissionStoneExecutionController.Decision decision) {
        assertNull(decision.waypoint());
        assertFalse(decision.forward());
        assertFalse(decision.jump());
        assertFalse(decision.sneak());
        assertFalse(decision.descentExempt());
        assertEquals(MissionStoneExecutionController.MovementPhase.NONE, decision.movementPhase());
    }

    private TestGeometry staircaseGeometry(StairPackage stairs) {
        TestGeometry geometry = new TestGeometry();
        for (StaircaseDescentPlanner.Step step : stairs.steps()) {
            geometry.safeStance(voxel(step.currentFeet()));
            geometry.safeStance(voxel(step.nextFeet()));
        }
        for (MissionStoneMethodPlanner.BreakCell cell : stairs.breaks()) {
            MissionStoneExecutionController.RuntimeMaterial material = switch (cell.material()) {
                case STONE -> MissionStoneExecutionController.RuntimeMaterial.STONE;
                case SAFE_NON_ORE -> MissionStoneExecutionController.RuntimeMaterial.SAFE_NON_ORE;
                default -> MissionStoneExecutionController.RuntimeMaterial.UNKNOWN_SOLID;
            };
            geometry.block(cell.position(), material);
        }
        return geometry;
    }

    private MissionStoneExecutionController.Decision tick(
        MissionStoneExecutionController controller,
        VoxelCell feet,
        int inventory,
        TestGeometry geometry,
        MissionStoneExecutionController.BreakFeedback feedback,
        long nowMs
    ) {
        return controller.tick(observation(feet, true, true, inventory), geometry, feedback, nowMs);
    }

    private MissionStoneExecutionController.Decision tick(
        MissionStoneExecutionController controller,
        MissionStoneExecutionController.Observation observation,
        TestGeometry geometry,
        MissionStoneExecutionController.BreakFeedback feedback,
        long nowMs
    ) {
        return controller.tick(observation, geometry, feedback, nowMs);
    }

    private MissionStoneExecutionController.Observation observation(
        VoxelCell feet,
        boolean grounded,
        boolean aligned,
        int inventory
    ) {
        return MissionStoneExecutionController.Observation.centered(
            KEY, feet, grounded, aligned, inventory);
    }

    private MissionStoneExecutionController.Observation observationAt(
        VoxelCell feet,
        double x,
        double y,
        double z,
        boolean grounded,
        int inventory
    ) {
        return new MissionStoneExecutionController.Observation(
            KEY, feet, x, y, z, grounded, true, inventory);
    }

    private MissionStoneExecutionController.BreakFeedback broken(BlockPos target) {
        return new MissionStoneExecutionController.BreakFeedback(
            target, BlockBreakController.Status.BROKEN, "block_air");
    }

    private static VoxelCell voxel(BlockPos pos) {
        return new VoxelCell(pos.getX(), pos.getY(), pos.getZ());
    }

    private static BlockPos block(VoxelCell cell) {
        return new BlockPos(cell.x(), cell.y(), cell.z());
    }

    private record StairPackage(
        List<StaircaseDescentPlanner.Step> steps,
        List<MissionStoneMethodPlanner.BreakCell> breaks
    ) {
    }

    private static final class TestGeometry implements MissionStoneExecutionController.GeometryProbe {
        private final Map<BlockPos, MissionStoneExecutionController.RuntimeBlock> blocks = new HashMap<>();
        private final Map<VoxelCell, MissionStoneExecutionController.StanceState> stances = new HashMap<>();

        @Override
        public MissionStoneExecutionController.RuntimeBlock block(BlockPos position) {
            return blocks.getOrDefault(position, MissionStoneExecutionController.RuntimeBlock.air());
        }

        @Override
        public MissionStoneExecutionController.StanceState stance(VoxelCell feet) {
            return stances.getOrDefault(
                feet,
                new MissionStoneExecutionController.StanceState(false, false, false, false, false));
        }

        void block(BlockPos position, MissionStoneExecutionController.RuntimeMaterial material) {
            blocks.put(
                position.toImmutable(),
                MissionStoneExecutionController.RuntimeBlock.breakable(material, Direction.WEST)
            );
        }

        void air(BlockPos position) {
            blocks.put(position.toImmutable(), MissionStoneExecutionController.RuntimeBlock.air());
        }

        void unreachable(BlockPos position) {
            MissionStoneExecutionController.RuntimeBlock current = block(position);
            blocks.put(
                position.toImmutable(),
                new MissionStoneExecutionController.RuntimeBlock(
                    current.material(), false, true, Direction.WEST)
            );
        }

        void safeStance(VoxelCell feet) {
            stances.put(feet, MissionStoneExecutionController.StanceState.safe());
        }

        void unsafeStance(VoxelCell feet) {
            stances.put(feet, new MissionStoneExecutionController.StanceState(
                true, true, false, true, true));
        }
    }
}
