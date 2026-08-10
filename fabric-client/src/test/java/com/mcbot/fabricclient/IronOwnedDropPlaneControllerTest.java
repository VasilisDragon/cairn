package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class IronOwnedDropPlaneControllerTest {
    private static final int PLANE_Y = 14;

    @Test
    void beginsOnlyFromASettledOwnedDropAndKeepsEveryRouteCellOnThePlane() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 8, 0, 2);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        OwnedDropTracker tracker = settledTracker(
            new OwnedDropTracker.Position(5.5D, PLANE_Y, 2.5D));
        IronOwnedDropPlaneController controller = new IronOwnedDropPlaneController();

        IronOwnedDropPlaneController.StartResult result = controller.begin(
            world,
            resume,
            PLANE_Y,
            resume,
            tracker,
            1_000L
        );

        assertTrue(result.started(), result.reason());
        assertEquals(1, result.routeComputations());
        assertEquals(1, tracker.routeAttempts());
        assertEquals(resume, result.route().getFirst());
        assertEquals(result.pickupCell(), result.route().getLast());
        assertTrue(result.route().size() <= IronOwnedDropPlaneController.MAX_ROUTE_CELLS);
        assertTrue(result.route().stream().allMatch(cell -> cell.y() == PLANE_Y));

        OwnedDropTracker airborne = new OwnedDropTracker();
        UUID id = UUID.randomUUID();
        airborne.arm(Map.of(), new OwnedDropTracker.Position(1.5D, PLANE_Y, 0.5D), 0L);
        airborne.beginAcquisition(0L);
        airborne.update(List.of(observation(id, 1.5D, PLANE_Y, 0.5D, false)), 1L);
        IronOwnedDropPlaneController.StartResult rejected = new IronOwnedDropPlaneController().begin(
            world,
            resume,
            PLANE_Y,
            resume,
            airborne,
            2L
        );
        assertFalse(rejected.started());
        assertEquals("drop_not_settled", rejected.reason());
    }

    @Test
    void rejectsOffPlaneStartsAndRoutesThatNeedAVerticalMove() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 3, 12, 17, 0, 0);
        world.support(0, PLANE_Y - 1, 0);
        world.support(1, PLANE_Y, 0);
        world.support(2, PLANE_Y, 0);
        world.support(3, PLANE_Y, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID id = UUID.randomUUID();

        IronOwnedDropPlaneController.StartResult vertical = new IronOwnedDropPlaneController().begin(
            world,
            resume,
            PLANE_Y,
            resume,
            id,
            new OwnedDropTracker.Position(3.5D, PLANE_Y + 1.0D, 0.5D),
            0L
        );
        assertFalse(vertical.started());
        assertEquals("no_reachable_pickup_cell", vertical.reason());

        IronOwnedDropPlaneController.StartResult band = new IronOwnedDropPlaneController().begin(
            world,
            resume,
            12,
            resume,
            id,
            new OwnedDropTracker.Position(0.5D, PLANE_Y, 0.5D),
            0L
        );
        assertFalse(band.started());
        assertEquals("plane_out_of_bounds", band.reason());
    }

    @Test
    void finalVoxelRequiresExactPickupEnvelopeAndUsesBoundedCellLocalContact() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 0, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID id = UUID.randomUUID();
        // Mirrors the W46 marginal route-length-one geometry: the shared voxel envelope admits
        // the stance, but a player entering at the far edge is not yet touching the item entity.
        OwnedDropTracker.Position drop = new OwnedDropTracker.Position(
            0.92D, PLANE_Y + 1.0D, -0.875D);
        IronOwnedDropPlaneController controller = begun(world, resume, id, drop, 0L);

        IronOwnedDropPlaneController.Step selected = controller.tick(
            new IronOwnedDropPlaneController.PlayerObservation(
                resume, 0.05D, PLANE_Y, 0.05D, true, true),
            new IronOwnedDropPlaneController.DropObservation(id, drop, true, false),
            world,
            false,
            50L
        );
        assertEquals(IronOwnedDropPlaneController.Outcome.HOLD, selected.outcome());
        assertEquals("pickup_contact_selected", selected.reason());
        assertTrue(controller.pickupContactApproachPending());
        assertEquals(0.75D, controller.pickupContactX(), 0.0001D);
        assertEquals(0.25D, controller.pickupContactZ(), 0.0001D);

        IronOwnedDropPlaneController.Step approaching = controller.tick(
            new IronOwnedDropPlaneController.PlayerObservation(
                resume, 0.25D, PLANE_Y, 0.15D, true, true),
            new IronOwnedDropPlaneController.DropObservation(id, drop, true, false),
            world,
            false,
            100L
        );
        assertEquals(IronOwnedDropPlaneController.Outcome.DRIVE, approaching.outcome());
        assertEquals("pickup_contact_approach", approaching.reason());

        IronOwnedDropPlaneController.Step atContactWithoutEnvelope = controller.tick(
            new IronOwnedDropPlaneController.PlayerObservation(
                resume, 0.75D, PLANE_Y, 0.25D, true, true),
            new IronOwnedDropPlaneController.DropObservation(id, drop, true, false),
            world,
            false,
            150L
        );
        assertEquals(IronOwnedDropPlaneController.Outcome.HOLD, atContactWithoutEnvelope.outcome());
        assertEquals("pickup_contact_wait_envelope", atContactWithoutEnvelope.reason());

        IronOwnedDropPlaneController.Step exactEnvelope = controller.tick(
            new IronOwnedDropPlaneController.PlayerObservation(
                resume, 0.75D, PLANE_Y, 0.25D, true, true),
            new IronOwnedDropPlaneController.DropObservation(id, drop, true, true),
            world,
            false,
            200L
        );
        assertEquals(IronOwnedDropPlaneController.Outcome.PICKUP_REACHED, exactEnvelope.outcome());
        assertEquals("pickup_envelope_reached", exactEnvelope.reason());
    }

    @Test
    void plannerRejectsAHeightThatTheExactPickupEnvelopeCannotIntersect() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 0, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        OwnedDropTracker.Position belowEnvelope = new OwnedDropTracker.Position(
            0.5D, PLANE_Y - 1.0D, 0.5D);

        assertTrue(CollectTarget3DPlanner.withinPickupRange(
            resume, belowEnvelope.x(), belowEnvelope.y(), belowEnvelope.z()));
        assertFalse(IronOwnedDropPlaneController.pickupEnvelopeFeasible(
            resume, belowEnvelope));
        IronOwnedDropPlaneController.StartResult result = new IronOwnedDropPlaneController().begin(
            world,
            resume,
            PLANE_Y,
            resume,
            UUID.randomUUID(),
            belowEnvelope,
            0L
        );
        assertFalse(result.started());
        assertEquals("no_reachable_pickup_cell", result.reason());
    }

    @Test
    void plannerAdmitsAReachableDropTwoBlocksAboveTheFrozenPlane() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 4, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        OwnedDropTracker.Position elevated = new OwnedDropTracker.Position(
            3.2D, PLANE_Y + 2.0D, 0.5D);

        assertFalse(CollectTarget3DPlanner.withinPickupRange(
            new VoxelCell(3, PLANE_Y, 0), elevated.x(), elevated.y(), elevated.z()));
        assertTrue(IronOwnedDropPlaneController.pickupEnvelopeFeasible(
            new VoxelCell(3, PLANE_Y, 0), elevated));

        IronOwnedDropPlaneController.StartResult result = new IronOwnedDropPlaneController().begin(
            world,
            resume,
            PLANE_Y,
            resume,
            UUID.randomUUID(),
            elevated,
            0L
        );

        assertTrue(result.started(), result.reason());
        assertEquals(new VoxelCell(3, PLANE_Y, 0), result.pickupCell());
        assertTrue(result.route().stream().allMatch(cell -> cell.y() == PLANE_Y));
    }

    @Test
    void purePreBreakAdmissionRejectsAnIsolatedPickupCavityUntilThePlaneCorridorIsOpen() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 4, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        OwnedDropTracker.Position expectedDrop = new OwnedDropTracker.Position(
            3.5D, PLANE_Y + 2.0D, 0.5D);
        world.solid.add(new VoxelCell(1, PLANE_Y, 0));
        world.solid.add(new VoxelCell(1, PLANE_Y + 1, 0));

        IronOwnedDropPlaneController.RouteAdmission blocked =
            IronOwnedDropPlaneController.assessRoute(
                world, resume, PLANE_Y, expectedDrop);

        assertFalse(blocked.admitted());
        assertEquals("no_reachable_pickup_cell", blocked.reason());

        world.solid.remove(new VoxelCell(1, PLANE_Y, 0));
        world.solid.remove(new VoxelCell(1, PLANE_Y + 1, 0));
        IronOwnedDropPlaneController.RouteAdmission reachable =
            IronOwnedDropPlaneController.assessRoute(
                world, resume, PLANE_Y, expectedDrop);

        assertTrue(reachable.admitted(), reachable.reason());
        assertEquals(resume, reachable.route().getFirst());
        assertTrue(reachable.route().stream().allMatch(cell -> cell.y() == PLANE_Y));
        assertTrue(reachable.route().size() <= IronOwnedDropPlaneController.MAX_ROUTE_CELLS);
    }

    @Test
    void exactPickupEnvelopeKeepsConservativeAxisAndVerticalBounds() {
        VoxelCell cell = new VoxelCell(0, PLANE_Y, 0);

        assertTrue(IronOwnedDropPlaneController.pickupEnvelopeFeasible(
            cell, new OwnedDropTracker.Position(1.90D, PLANE_Y + 2.25D, 0.5D)));
        assertTrue(IronOwnedDropPlaneController.pickupEnvelopeFeasible(
            cell, new OwnedDropTracker.Position(-0.90D, PLANE_Y - 0.70D, 0.5D)));
        assertFalse(IronOwnedDropPlaneController.pickupEnvelopeFeasible(
            cell, new OwnedDropTracker.Position(1.91D, PLANE_Y + 2.25D, 0.5D)));
        assertFalse(IronOwnedDropPlaneController.pickupEnvelopeFeasible(
            cell, new OwnedDropTracker.Position(0.5D, PLANE_Y + 2.251D, 0.5D)));
        assertFalse(IronOwnedDropPlaneController.pickupEnvelopeFeasible(
            cell, new OwnedDropTracker.Position(0.5D, PLANE_Y - 0.701D, 0.5D)));
    }

    @Test
    void settledSameCellDriftRefreshesContactWithoutSpendingAReplan() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 0, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID id = UUID.randomUUID();
        OwnedDropTracker.Position initial = new OwnedDropTracker.Position(0.5D, PLANE_Y, 0.5D);
        IronOwnedDropPlaneController controller = begun(world, resume, id, initial, 0L);
        controller.tick(
            IronOwnedDropPlaneController.PlayerObservation.centered(resume, true, true),
            new IronOwnedDropPlaneController.DropObservation(id, initial, true, false),
            world,
            false,
            50L
        );

        OwnedDropTracker.Position drifted = new OwnedDropTracker.Position(0.7D, PLANE_Y, 0.7D);
        IronOwnedDropPlaneController.Step step = controller.tick(
            new IronOwnedDropPlaneController.PlayerObservation(
                resume, 0.5D, PLANE_Y, 0.5D, true, true),
            new IronOwnedDropPlaneController.DropObservation(id, drifted, true, false),
            world,
            false,
            100L
        );

        assertEquals(IronOwnedDropPlaneController.Outcome.DRIVE, step.outcome());
        assertEquals(0.7D, controller.pickupContactX(), 0.0001D);
        assertEquals(0.7D, controller.pickupContactZ(), 0.0001D);
        assertEquals(1, step.routeComputations());
    }

    @Test
    void adjacentHazardExcludesAStandablePickupCorridor() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(
            0, 4, PLANE_Y - 1, PLANE_Y + 1, 0, 1);
        world.floor(0, 4, 0, 0, PLANE_Y - 1);
        world.hazard(2, PLANE_Y - 1, 1);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);

        IronOwnedDropPlaneController.StartResult result = new IronOwnedDropPlaneController().begin(
            world,
            resume,
            PLANE_Y,
            resume,
            UUID.randomUUID(),
            new OwnedDropTracker.Position(4.5D, PLANE_Y, 0.5D),
            0L
        );

        assertFalse(result.started());
        assertEquals("no_reachable_pickup_cell", result.reason());
    }

    @Test
    void hazardIntroducedAfterPlanningInvalidatesTheActiveWaypoint() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(
            0, 4, PLANE_Y - 1, PLANE_Y + 1, 0, 1);
        world.floor(0, 4, 0, 0, PLANE_Y - 1);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID id = UUID.randomUUID();
        OwnedDropTracker.Position drop = new OwnedDropTracker.Position(4.5D, PLANE_Y, 0.5D);
        IronOwnedDropPlaneController controller = begun(world, resume, id, drop, 0L);

        world.hazard(1, PLANE_Y - 1, 1);
        IronOwnedDropPlaneController.Step rejected = tick(
            controller, world, resume, id, drop, false, 100L);

        assertEquals(IronOwnedDropPlaneController.Outcome.REJECTED, rejected.outcome());
        assertEquals("route_invalidated", rejected.reason());
    }

    @Test
    void overlongPreferredPickupFallsBackToACapCompliantCandidate() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(
            0, 6, PLANE_Y - 1, PLANE_Y + 1, -5, 1);
        // Long corridor to the exact item column: 18 route cells.
        for (int z = 0; z >= -5; z--) {
            world.support(0, PLANE_Y - 1, z);
        }
        for (int x = 1; x <= 6; x++) {
            world.support(x, PLANE_Y - 1, -5);
        }
        for (int z = -4; z <= 0; z++) {
            world.support(6, PLANE_Y - 1, z);
        }
        // Short independent corridor to the diagonal edge of the pickup envelope.
        world.support(0, PLANE_Y - 1, 1);
        for (int x = 1; x <= 5; x++) {
            world.support(x, PLANE_Y - 1, 1);
        }
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);

        IronOwnedDropPlaneController.StartResult result = new IronOwnedDropPlaneController().begin(
            world,
            resume,
            PLANE_Y,
            resume,
            UUID.randomUUID(),
            new OwnedDropTracker.Position(6.5D, PLANE_Y, 0.5D),
            0L
        );

        assertTrue(result.started(), result.reason());
        assertEquals("bounded_pickup_alternative", result.reason());
        assertEquals(new VoxelCell(6, PLANE_Y, -1), result.pickupCell());
        assertEquals(IronOwnedDropPlaneController.MAX_ROUTE_CELLS, result.route().size());
        assertTrue(result.route().size() <= IronOwnedDropPlaneController.MAX_ROUTE_CELLS);
    }

    @Test
    void cursorAdvancesMonotonicallyAndResynchronizesOnlyForward() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 12, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID id = UUID.randomUUID();
        OwnedDropTracker.Position drop = new OwnedDropTracker.Position(10.5D, PLANE_Y, 0.5D);
        IronOwnedDropPlaneController controller = begun(world, resume, id, drop, 0L);

        IronOwnedDropPlaneController.Step first = tick(
            controller, world, new VoxelCell(1, PLANE_Y, 0), id, drop, false, 100L);
        assertTrue(first.waypointAdvanced());
        assertFalse(first.forwardResynchronized());
        int afterFirst = first.waypointIndex();

        IronOwnedDropPlaneController.Step earlier = tick(
            controller, world, resume, id, drop, false, 200L);
        assertEquals(afterFirst, earlier.waypointIndex());
        assertFalse(earlier.waypointAdvanced());

        IronOwnedDropPlaneController.Step resynchronized = tick(
            controller, world, new VoxelCell(9, PLANE_Y, 0), id, drop, false, 300L);
        assertTrue(resynchronized.waypointAdvanced());
        assertTrue(resynchronized.forwardResynchronized());
        assertEquals(9, resynchronized.maximumWaypointIndex());
        assertEquals(1, resynchronized.remainingCells());
        assertEquals(IronOwnedDropPlaneController.Outcome.DRIVE, resynchronized.outcome());

        IronOwnedDropPlaneController.Step pickup = tick(
            controller, world, new VoxelCell(10, PLANE_Y, 0), id, drop, false, 350L);
        assertEquals(IronOwnedDropPlaneController.Outcome.PICKUP_REACHED, pickup.outcome());
        assertEquals(10, pickup.maximumWaypointIndex());
        assertEquals(0, pickup.remainingCells());
    }

    @Test
    void exactFourSecondNoProgressBoundaryRejectsTheTraversal() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 4, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID id = UUID.randomUUID();
        OwnedDropTracker.Position drop = new OwnedDropTracker.Position(4.5D, PLANE_Y, 0.5D);
        IronOwnedDropPlaneController controller = begun(world, resume, id, drop, 0L);

        IronOwnedDropPlaneController.Step pending = tick(
            controller, world, resume, id, drop, false,
            IronOwnedDropPlaneController.STALL_TIMEOUT_MS - 1L);
        assertEquals(IronOwnedDropPlaneController.Outcome.DRIVE, pending.outcome());

        IronOwnedDropPlaneController.Step rejected = tick(
            controller, world, resume, id, drop, false,
            IronOwnedDropPlaneController.STALL_TIMEOUT_MS);
        assertEquals(IronOwnedDropPlaneController.Outcome.REJECTED, rejected.outcome());
        assertEquals("outbound_stalled", rejected.reason());
        assertFalse(controller.active());
    }

    @Test
    void oneDisplacedItemReplanSplicesTheConsumedPrefixAndSecondMovementRejects() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 8, 0, 4);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID id = UUID.randomUUID();
        OwnedDropTracker.Position initial = new OwnedDropTracker.Position(6.5D, PLANE_Y, 0.5D);
        OwnedDropTracker.Position moved = new OwnedDropTracker.Position(6.5D, PLANE_Y, 2.5D);
        IronOwnedDropPlaneController controller = begun(world, resume, id, initial, 0L);

        tick(controller, world, new VoxelCell(2, PLANE_Y, 0), id, initial, false, 100L);
        IronOwnedDropPlaneController.Step replanned = tick(
            controller, world, new VoxelCell(2, PLANE_Y, 0), id, moved, false, 200L);

        assertEquals(IronOwnedDropPlaneController.Outcome.HOLD, replanned.outcome());
        assertTrue(replanned.replanned());
        assertEquals(2, replanned.routeComputations());
        assertEquals(resume, controller.outboundRoute().getFirst());
        assertEquals(new VoxelCell(2, PLANE_Y, 0), controller.outboundRoute().get(2));
        assertTrue(controller.outboundRoute().stream().allMatch(cell -> cell.y() == PLANE_Y));

        IronOwnedDropPlaneController.Step rejected = tick(
            controller,
            world,
            new VoxelCell(2, PLANE_Y, 0),
            id,
            new OwnedDropTracker.Position(6.5D, PLANE_Y, 4.5D),
            false,
            300L
        );
        assertEquals(IronOwnedDropPlaneController.Outcome.REJECTED, rejected.outcome());
        assertEquals("replan_limit", rejected.reason());
    }

    @Test
    void trackerRouteAttemptsAndControllerComputationsStayAligned() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 8, 0, 3);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        OwnedDropTracker tracker = settledTracker(
            new OwnedDropTracker.Position(6.5D, PLANE_Y, 0.5D));
        IronOwnedDropPlaneController controller = new IronOwnedDropPlaneController();
        assertTrue(controller.begin(world, resume, PLANE_Y, resume, tracker, 0L).started());
        assertEquals(1, tracker.routeAttempts());
        assertEquals(tracker.routeAttempts(), controller.routeComputations());

        UUID id = controller.entityId();
        OwnedDropTracker.Position moved = new OwnedDropTracker.Position(6.5D, PLANE_Y, 2.5D);
        IronOwnedDropPlaneController.Step replanned = tick(
            controller, world, resume, id, moved, false, 100L);
        assertTrue(replanned.replanned());
        assertEquals(2, tracker.routeAttempts());
        assertEquals(tracker.routeAttempts(), replanned.routeComputations());

        IronOwnedDropPlaneController.Step limited = tick(
            controller,
            world,
            resume,
            id,
            new OwnedDropTracker.Position(6.5D, PLANE_Y, 3.5D),
            false,
            200L
        );
        assertEquals("replan_limit", limited.reason());
        assertEquals(2, tracker.routeAttempts());

        IronOwnedDropPlaneController exhausted = new IronOwnedDropPlaneController();
        IronOwnedDropPlaneController.StartResult rejected = exhausted.begin(
            world, resume, PLANE_Y, resume, tracker, 300L);
        assertFalse(rejected.started());
        assertEquals("route_attempt_limit", rejected.reason());
        assertEquals(2, rejected.routeComputations());
    }

    @Test
    void uuidReplacementRequiresOneExplicitAuthoritativeReacquisition() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 6, 0, 1);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID original = UUID.randomUUID();
        UUID replacement = UUID.randomUUID();
        OwnedDropTracker.Position initial = new OwnedDropTracker.Position(5.5D, PLANE_Y, 0.5D);

        IronOwnedDropPlaneController unexpected = begun(world, resume, original, initial, 0L);
        IronOwnedDropPlaneController.Step rejected = tick(
            unexpected, world, resume, replacement, initial, false, 1L);
        assertEquals(IronOwnedDropPlaneController.Outcome.REJECTED, rejected.outcome());
        assertEquals("unexpected_entity_id", rejected.reason());

        IronOwnedDropPlaneController admitted = begun(world, resume, original, initial, 0L);
        OwnedDropTracker.Position replacementPosition =
            new OwnedDropTracker.Position(5.6D, PLANE_Y, 0.5D);
        assertFalse(admitted.admitReacquiredEntity(
            original, replacement, replacementPosition, 0));
        assertTrue(admitted.admitReacquiredEntity(
            original, replacement, replacementPosition, 1));
        assertEquals(1, admitted.identityReacquisitions());
        assertEquals(replacement, admitted.entityId());

        IronOwnedDropPlaneController.Step accepted = tick(
            admitted, world, resume, replacement, replacementPosition, false, 10L);
        assertEquals(IronOwnedDropPlaneController.Outcome.DRIVE, accepted.outcome());
        assertFalse(admitted.admitReacquiredEntity(
            replacement, UUID.randomUUID(), replacementPosition, 2));
    }

    @Test
    void displacementCannotTurnAnEarlierCellRevisitIntoCursorRegression() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 8, 0, 3);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID id = UUID.randomUUID();
        OwnedDropTracker.Position initial = new OwnedDropTracker.Position(6.5D, PLANE_Y, 0.5D);
        IronOwnedDropPlaneController controller = begun(world, resume, id, initial, 0L);

        tick(controller, world, new VoxelCell(3, PLANE_Y, 0), id, initial, false, 100L);
        IronOwnedDropPlaneController.Step rejected = tick(
            controller,
            world,
            new VoxelCell(1, PLANE_Y, 0),
            id,
            new OwnedDropTracker.Position(6.5D, PLANE_Y, 2.5D),
            false,
            200L
        );

        assertEquals(IronOwnedDropPlaneController.Outcome.REJECTED, rejected.outcome());
        assertEquals("replan_route_regression", rejected.reason());
    }

    @Test
    void inventoryGainReversesTheConsumedRouteAndStopsAtPickupAndResume() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 4, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID id = UUID.randomUUID();
        OwnedDropTracker.Position drop = new OwnedDropTracker.Position(4.5D, PLANE_Y, 0.5D);
        IronOwnedDropPlaneController controller = begun(world, resume, id, drop, 1_000L);

        IronOwnedDropPlaneController.Step pickup = tick(
            controller, world, new VoxelCell(4, PLANE_Y, 0), id, drop, false, 1_100L);
        assertEquals(IronOwnedDropPlaneController.Outcome.PICKUP_REACHED, pickup.outcome());
        assertTrue(pickup.stopped());

        IronOwnedDropPlaneController.Step returning = tick(
            controller, world, new VoxelCell(4, PLANE_Y, 0), id, drop, true, 1_150L);
        assertEquals(IronOwnedDropPlaneController.Outcome.RETURN_STARTED, returning.outcome());
        assertEquals(IronOwnedDropPlaneController.Phase.RETURNING, returning.phase());
        assertTrue(returning.stopped());
        assertEquals(new VoxelCell(3, PLANE_Y, 0), returning.waypoint());

        IronOwnedDropPlaneController.Step resumeReached = tick(
            controller, world, resume, id, drop, false, 1_250L);
        assertEquals(IronOwnedDropPlaneController.Outcome.RESUME_REACHED, resumeReached.outcome());
        assertEquals(IronOwnedDropPlaneController.Phase.RESUME, resumeReached.phase());
        assertTrue(resumeReached.stopped());

        IronOwnedDropPlaneController.Step complete = tick(
            controller, world, resume, id, drop, false, 1_300L);
        assertEquals(IronOwnedDropPlaneController.Outcome.COMPLETED, complete.outcome());
        assertEquals("plane_restored", complete.reason());
        assertFalse(controller.active());
    }

    @Test
    void authoritativeInventoryGainStartsReturnWhenPickedUpEntityDisappearsSameTick() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 4, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        VoxelCell pickup = new VoxelCell(4, PLANE_Y, 0);
        UUID id = UUID.randomUUID();
        OwnedDropTracker.Position drop = new OwnedDropTracker.Position(4.5D, PLANE_Y, 0.5D);
        IronOwnedDropPlaneController controller = begun(world, resume, id, drop, 1_000L);

        assertEquals(
            IronOwnedDropPlaneController.Outcome.PICKUP_REACHED,
            tick(controller, world, pickup, id, drop, false, 1_100L).outcome()
        );
        IronOwnedDropPlaneController.Step returning = controller.tick(
            IronOwnedDropPlaneController.PlayerObservation.centered(pickup, true, true),
            null,
            world,
            true,
            1_150L
        );

        assertEquals(IronOwnedDropPlaneController.Outcome.RETURN_STARTED, returning.outcome());
        assertEquals(IronOwnedDropPlaneController.Phase.RETURNING, returning.phase());
        assertTrue(returning.stopped());
        assertTrue(controller.active());
    }

    @Test
    void completionTickRequiresExactGroundedValidResumeGeometry() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 3, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID id = UUID.randomUUID();
        OwnedDropTracker.Position drop = new OwnedDropTracker.Position(3.5D, PLANE_Y, 0.5D);

        IronOwnedDropPlaneController displaced = controllerAtResume(world, resume, id, drop);
        IronOwnedDropPlaneController.Step displacedResult = tick(
            displaced, world, new VoxelCell(1, PLANE_Y, 0), id, drop, false, 500L);
        assertEquals(IronOwnedDropPlaneController.Outcome.REJECTED, displacedResult.outcome());
        assertEquals("resume_displaced", displacedResult.reason());

        IronOwnedDropPlaneController airborne = controllerAtResume(world, resume, id, drop);
        IronOwnedDropPlaneController.Step airborneResult = airborne.tick(
            IronOwnedDropPlaneController.PlayerObservation.centered(resume, false, true),
            new IronOwnedDropPlaneController.DropObservation(id, drop, false),
            world,
            false,
            500L
        );
        assertEquals("resume_displaced", airborneResult.reason());

        IronOwnedDropPlaneController invalidated = controllerAtResume(world, resume, id, drop);
        world.solid.remove(new VoxelCell(resume.x(), PLANE_Y - 1, resume.z()));
        IronOwnedDropPlaneController.Step invalidResult = tick(
            invalidated, world, resume, id, drop, false, 500L);
        assertEquals(IronOwnedDropPlaneController.Outcome.REJECTED, invalidResult.outcome());
        assertEquals("resume_invalidated", invalidResult.reason());
    }

    @Test
    void earlyAutomaticPickupReturnsOnlyAcrossTheConsumedPrefix() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 6, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID id = UUID.randomUUID();
        OwnedDropTracker.Position drop = new OwnedDropTracker.Position(6.5D, PLANE_Y, 0.5D);
        IronOwnedDropPlaneController controller = begun(world, resume, id, drop, 0L);

        tick(controller, world, new VoxelCell(2, PLANE_Y, 0), id, drop, false, 100L);
        IronOwnedDropPlaneController.Step returning = tick(
            controller, world, new VoxelCell(2, PLANE_Y, 0), id, drop, true, 200L);

        assertEquals(IronOwnedDropPlaneController.Outcome.RETURN_STARTED, returning.outcome());
        assertEquals(List.of(
            new VoxelCell(2, PLANE_Y, 0),
            new VoxelCell(1, PLANE_Y, 0),
            resume
        ), controller.activeRoute());
    }

    @Test
    void confirmedPickupCannotWaitForeverForAnInvalidReturnStart() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 5, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID id = UUID.randomUUID();
        OwnedDropTracker.Position drop = new OwnedDropTracker.Position(5.5D, PLANE_Y, 0.5D);
        IronOwnedDropPlaneController controller = begun(world, resume, id, drop, 0L);

        IronOwnedDropPlaneController.Step rejected = controller.tick(
            IronOwnedDropPlaneController.PlayerObservation.centered(
                new VoxelCell(0, PLANE_Y + 1, 0),
                true,
                true
            ),
            new IronOwnedDropPlaneController.DropObservation(id, drop, false),
            world,
            true,
            100L
        );

        assertEquals(IronOwnedDropPlaneController.Outcome.REJECTED, rejected.outcome());
        assertEquals("return_start_off_plane", rejected.reason());
    }

    @Test
    void clearRemovesRouteIdentityAndReacquisitionAuthority() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 4, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID id = UUID.randomUUID();
        OwnedDropTracker.Position drop = new OwnedDropTracker.Position(4.5D, PLANE_Y, 0.5D);
        IronOwnedDropPlaneController controller = begun(world, resume, id, drop, 0L);

        controller.clear();

        assertFalse(controller.active());
        assertEquals(0, controller.routeComputations());
        assertEquals(0, controller.identityReacquisitions());
        assertFalse(controller.admitReacquiredEntity(
            id, UUID.randomUUID(), drop, 1));
        assertEquals(
            IronOwnedDropPlaneController.Outcome.IDLE,
            tick(controller, world, resume, id, drop, false, 10L).outcome()
        );
    }

    @Test
    void disappearanceAndCollectionDeadlineFailClosedWithoutGenericRecovery() {
        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 4, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        UUID id = UUID.randomUUID();
        OwnedDropTracker.Position drop = new OwnedDropTracker.Position(4.5D, PLANE_Y, 0.5D);

        IronOwnedDropPlaneController disappeared = begun(world, resume, id, drop, 0L);
        IronOwnedDropPlaneController.Step gone = disappeared.tick(
            IronOwnedDropPlaneController.PlayerObservation.centered(resume, true, true),
            new IronOwnedDropPlaneController.DropObservation(id, drop, false),
            world,
            false,
            1L
        );
        assertEquals("drop_disappeared_without_inventory", gone.reason());

        IronOwnedDropPlaneController timedOut = begun(world, resume, id, drop, 0L);
        IronOwnedDropPlaneController.Step timeout = tick(
            timedOut,
            world,
            resume,
            id,
            drop,
            false,
            IronOwnedDropPlaneController.COLLECTION_TIMEOUT_MS
        );
        assertEquals(IronOwnedDropPlaneController.Outcome.REJECTED, timeout.outcome());
        assertEquals("collection_timeout", timeout.reason());
    }

    @Test
    void routeLengthAndComputationBoundsArePinned() {
        assertEquals(16, IronOwnedDropPlaneController.MAX_ROUTE_CELLS);
        assertEquals(2, IronOwnedDropPlaneController.MAX_ROUTE_COMPUTATIONS);
        assertEquals(8, IronOwnedDropPlaneController.MAX_FORWARD_RESYNC_CELLS);
        assertEquals(4_000L, IronOwnedDropPlaneController.STALL_TIMEOUT_MS);

        VoxelAStarTest.TestVoxelWorld world = floorWorld(0, 30, 0, 0);
        VoxelCell resume = new VoxelCell(0, PLANE_Y, 0);
        IronOwnedDropPlaneController.StartResult bounded = new IronOwnedDropPlaneController().begin(
            world,
            resume,
            PLANE_Y,
            resume,
            UUID.randomUUID(),
            new OwnedDropTracker.Position(30.5D, PLANE_Y, 0.5D),
            0L
        );
        assertFalse(bounded.started());
        assertEquals("no_reachable_pickup_cell", bounded.reason());
        assertEquals(1, bounded.routeComputations());
    }

    private static IronOwnedDropPlaneController begun(
        VoxelPerception world,
        VoxelCell resume,
        UUID id,
        OwnedDropTracker.Position drop,
        long nowMs
    ) {
        IronOwnedDropPlaneController controller = new IronOwnedDropPlaneController();
        IronOwnedDropPlaneController.StartResult result = controller.begin(
            world,
            resume,
            PLANE_Y,
            resume,
            id,
            drop,
            nowMs
        );
        assertTrue(result.started(), result.reason());
        return controller;
    }

    private static IronOwnedDropPlaneController controllerAtResume(
        VoxelPerception world,
        VoxelCell resume,
        UUID id,
        OwnedDropTracker.Position drop
    ) {
        IronOwnedDropPlaneController controller = begun(world, resume, id, drop, 0L);
        VoxelCell pickup = controller.pickupCell();
        assertEquals(
            IronOwnedDropPlaneController.Outcome.PICKUP_REACHED,
            tick(controller, world, pickup, id, drop, false, 100L).outcome()
        );
        assertEquals(
            IronOwnedDropPlaneController.Outcome.RETURN_STARTED,
            tick(controller, world, pickup, id, drop, true, 200L).outcome()
        );
        assertEquals(
            IronOwnedDropPlaneController.Outcome.RESUME_REACHED,
            tick(controller, world, resume, id, drop, false, 300L).outcome()
        );
        return controller;
    }

    private static IronOwnedDropPlaneController.Step tick(
        IronOwnedDropPlaneController controller,
        VoxelPerception world,
        VoxelCell feet,
        UUID id,
        OwnedDropTracker.Position drop,
        boolean inventoryGain,
        long nowMs
    ) {
        return controller.tick(
            IronOwnedDropPlaneController.PlayerObservation.centered(feet, true, true),
            new IronOwnedDropPlaneController.DropObservation(id, drop, true, true),
            world,
            inventoryGain,
            nowMs
        );
    }

    private static VoxelAStarTest.TestVoxelWorld floorWorld(
        int minX,
        int maxX,
        int minZ,
        int maxZ
    ) {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(
            minX,
            maxX,
            PLANE_Y - 1,
            PLANE_Y + 1,
            minZ,
            maxZ
        );
        world.floor(minX, maxX, minZ, maxZ, PLANE_Y - 1);
        return world;
    }

    private static OwnedDropTracker settledTracker(OwnedDropTracker.Position position) {
        UUID id = UUID.randomUUID();
        OwnedDropTracker tracker = new OwnedDropTracker();
        tracker.arm(Map.of(), new OwnedDropTracker.Position(5.5D, PLANE_Y, 2.5D), 0L);
        tracker.beginAcquisition(0L);
        tracker.update(List.of(observation(id, position.x(), position.y(), position.z(), true)), 10L);
        tracker.update(List.of(observation(id, position.x(), position.y(), position.z(), true)), 20L);
        tracker.update(List.of(observation(id, position.x(), position.y(), position.z(), true)), 30L);
        OwnedDropTracker.Update settled = tracker.update(
            List.of(observation(id, position.x(), position.y(), position.z(), true)),
            40L
        );
        assertTrue(tracker.settled(), settled.reason());
        assertNotNull(tracker.entityId());
        return tracker;
    }

    private static OwnedDropTracker.Observation observation(
        UUID id,
        double x,
        double y,
        double z,
        boolean onGround
    ) {
        return new OwnedDropTracker.Observation(
            id,
            1,
            new OwnedDropTracker.Position(x, y, z),
            true,
            onGround
        );
    }
}
