package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.*;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class DescentRejoinPolicyTest {
    private static final VoxelCell A = new VoxelCell(0, 64, 0);
    private static final VoxelCell B = new VoxelCell(1, 63, 0);
    private static final VoxelCell C = new VoxelCell(2, 62, 0);
    private static final VoxelCell D = new VoxelCell(3, 61, 0);
    private static DescentRejoinPolicy.Plan plan(DescentRejoinPolicy.Trail trail, List<VoxelCell> own, VoxelCell source) {
        return DescentRejoinPolicy.plan(trail, own, source, own.getLast(), c -> true,
            (a, b) -> Math.abs(a.x() - b.x()) + Math.abs(a.z() - b.z()) == 1 && Math.abs(a.y() - b.y()) <= 1);
    }

    @Test void selectsExactRecordedSegmentWithoutSearch() {
        var route = plan(DescentRejoinPolicy.Trail.inactive(), List.of(A, B, C, D), B);
        assertTrue(route.accepted());
        assertEquals(List.of(B, C, D), route.route());
    }
    @Test void admissionRequiresGroundedDrySupportedClearHazardFreeStance() {
        assertEquals(DescentRejoinPolicy.Admission.READY, DescentRejoinPolicy.admission(new DescentRejoinPolicy.Stance(true, true, true, true, true), 100, 200));
        assertEquals(DescentRejoinPolicy.Admission.UNSAFE, DescentRejoinPolicy.admission(new DescentRejoinPolicy.Stance(true, false, true, true, true), 100, 200));
        assertEquals(DescentRejoinPolicy.Admission.UNSAFE, DescentRejoinPolicy.admission(new DescentRejoinPolicy.Stance(true, true, false, true, true), 100, 200));
        assertEquals(DescentRejoinPolicy.Admission.UNSAFE, DescentRejoinPolicy.admission(new DescentRejoinPolicy.Stance(true, true, true, false, true), 100, 200));
        assertEquals(DescentRejoinPolicy.Admission.UNSAFE, DescentRejoinPolicy.admission(new DescentRejoinPolicy.Stance(true, true, true, true, false), 100, 200));
        assertEquals(DescentRejoinPolicy.Admission.UNSAFE, DescentRejoinPolicy.admission(null, 100, 200));
    }
    @Test void waitingForGroundNeverExtendsExactDeadline() {
        var stance = new DescentRejoinPolicy.Stance(false, true, true, false, true);
        assertEquals(DescentRejoinPolicy.Admission.WAIT_GROUNDED, DescentRejoinPolicy.admission(stance, 199, 200));
        assertEquals(DescentRejoinPolicy.Admission.EXPIRED, DescentRejoinPolicy.admission(stance, 200, 200));
        assertEquals(DescentRejoinPolicy.Admission.EXPIRED, DescentRejoinPolicy.admission(stance, 201, 200));
    }
    @Test void capturesLandingOnlyAfterClearingOriginSupportOrDeparting() {
        var elevated = new VoxelCell(1, 64, 0);
        assertFalse(DescentRejoinPolicy.captureLanding(A, B, A, true, 0.9, 0.5));
        assertFalse(DescentRejoinPolicy.captureLanding(A, B, elevated, true, 1.1, 0.5));
        assertTrue(DescentRejoinPolicy.captureLanding(A, B, elevated, true, 1.5, 0.5));
        assertTrue(DescentRejoinPolicy.captureLanding(A, B, elevated, false, 1.1, 0.5));
        assertTrue(DescentRejoinPolicy.captureLanding(A, B, B, true, 1.5, 0.5));
    }
    @Test void landingCaptureDoesNotAuthorizeLevelUpwardOrUnknownMovement() {
        assertFalse(DescentRejoinPolicy.captureLanding(B, A, A, false, 0.5, 0.5));
        assertFalse(DescentRejoinPolicy.captureLanding(A, new VoxelCell(1, 64, 0), new VoxelCell(1, 64, 0), false, 1.5, 0.5));
        assertFalse(DescentRejoinPolicy.captureLanding(A, B, B, false, Double.NaN, 0.5));
        assertFalse(DescentRejoinPolicy.captureLanding(A, B, null, false, 1.5, 0.5));
    }
    @Test void physicallyClearedSupportStopsBeforeTheExtraAdmissionMargin() {
        // onGround can describe the vertical collision earlier in this tick,
        // while horizontal motion has already cleared the support face.
        // This is a braking decision, not permission to traverse/claim a landing.
        assertTrue(DescentRejoinPolicy.captureLanding(A, B, new VoxelCell(1, 64, 0), true, 1.305, 0.5));
        assertTrue(DescentRejoinPolicy.captureLanding(B, C, new VoxelCell(2, 63, 0), true, 2.305, 0.5));
        var west = new VoxelCell(-1, 63, 0);
        assertTrue(DescentRejoinPolicy.captureLanding(A, west, new VoxelCell(-1, 64, 0), true, -0.305, 0.5));
        assertTrue(DescentRejoinPolicy.captureLanding(A, new VoxelCell(0, 63, 1), new VoxelCell(0, 64, 1), true, 0.5, 1.305));
        assertTrue(DescentRejoinPolicy.captureLanding(A, new VoxelCell(0, 63, -1), new VoxelCell(0, 64, -1), true, 0.5, -0.305));
    }
    @Test void brakingUsesActualBodyEdgesWithoutRoundingAwayRemainingSupport() {
        var feet = new VoxelCell(1, 64, 0);
        assertFalse(DescentRejoinPolicy.captureLanding(A, B, feet, true,
            new DescentRejoinPolicy.Footprint(0.999999999, 1.6, 0.2, 0.8)));
        assertTrue(DescentRejoinPolicy.captureLanding(A, B, feet, true,
            new DescentRejoinPolicy.Footprint(1.000000001, 1.6, 0.2, 0.8)));
        assertTrue(DescentRejoinPolicy.captureLanding(A, B, feet, true,
            new DescentRejoinPolicy.Footprint(1.0, 1.6, 0.2, 0.8)));
    }
    @Test void brakingRejectsMalformedBodiesAndNonRecordedTransitionShapes() {
        var feet = new VoxelCell(1, 64, 0);
        for (var body : List.of(
            new DescentRejoinPolicy.Footprint(Double.NaN, 1.6, 0.2, 0.8),
            new DescentRejoinPolicy.Footprint(1, Double.POSITIVE_INFINITY, 0.2, 0.8),
            new DescentRejoinPolicy.Footprint(2, 1, 0.2, 0.8),
            new DescentRejoinPolicy.Footprint(1, 1, 0.2, 0.8))) {
            assertFalse(DescentRejoinPolicy.captureLanding(A, B, feet, true, body));
        }
        assertFalse(DescentRejoinPolicy.captureLanding(A, B, feet, true, null));
        assertFalse(DescentRejoinPolicy.captureLanding(A, new VoxelCell(2, 63, 0), new VoxelCell(2, 64, 0), false, 2.5, 0.5));
        assertFalse(DescentRejoinPolicy.captureLanding(A, new VoxelCell(1, 62, 0), feet, false, 1.5, 0.5));
    }
    @Test void earlyBrakingDoesNotWeakenTheSharedOffRouteLandingGuard() {
        var traversal = new MiningWorkspaceTraversalController();
        assertTrue(traversal.begin(MiningWorkspaceTraversalController.Mode.RESUME, List.of(A, B, C), A, 0));
        traversal.tick(MiningWorkspaceTraversalController.Observation.centered(A, true, true), c -> true, 50);
        traversal.tick(MiningWorkspaceTraversalController.Observation.centered(A, true, true), c -> true, 100);
        var edge = traversal.tick(new MiningWorkspaceTraversalController.Observation(new VoxelCell(1, 64, 0), 1.305, 64, 0.5, true, true), c -> true, 150);
        assertTrue(edge.forward());
        assertTrue(DescentRejoinPolicy.captureLanding(edge.stableFeet(), edge.waypoint(), new VoxelCell(1, 64, 0), true, 1.305, 0.5));
        // Even if external momentum/intervention subsequently carries the player
        // beyond the landing, the existing controller still rejects it.
        traversal.tick(MiningWorkspaceTraversalController.Observation.centered(B, true, true), c -> true, 200);
        var rejected = traversal.tick(MiningWorkspaceTraversalController.Observation.centered(new VoxelCell(2, 63, 0), true, true), c -> true, 250);
        assertEquals(MiningWorkspaceTraversalController.Outcome.REJECTED, rejected.outcome());
        assertEquals("route_deviation", rejected.reason());
    }
    @Test void joinsCanonicalPrefixAtAnExactOverlap() {
        var canonical = new DescentRejoinPolicy.Trail(true, true, 4, 7, List.of(A, B));
        assertEquals(List.of(A, B, C, D), plan(canonical, List.of(B, C, D), A).route());
    }
    @Test void preservesLongerExactOverlapWithoutDuplicatingCells() {
        var canonical = new DescentRejoinPolicy.Trail(true, true, 4, 7, List.of(A, B, C));
        assertEquals(List.of(A, B, C, D), plan(canonical, List.of(B, C, D), A).route());
    }
    @Test void refusesDisconnectedCanonicalAndCurrentRoutes() {
        var canonical = new DescentRejoinPolicy.Trail(true, true, 4, 7, List.of(A));
        assertEquals("route_unavailable", plan(canonical, List.of(B, C, D), A).failure());
    }
    @Test void neverRestoresInvalidatedCanonicalSuffix() {
        var canonical = new DescentRejoinPolicy.Trail(true, false, 4, 7, List.of(A, B));
        assertFalse(plan(canonical, List.of(B, C, D), B).accepted());
    }
    @Test void rejectsAmbiguousLoopsAndEndpoints() {
        assertEquals("ambiguous_route", plan(DescentRejoinPolicy.Trail.inactive(), List.of(A, B, A, B, C), A).failure());
    }
    @Test void doesNotSelectNearestCellForOffTrailPlayer() {
        assertEquals("route_unavailable", plan(DescentRejoinPolicy.Trail.inactive(), List.of(A, B, C), new VoxelCell(0, 64, 1)).failure());
    }
    @Test void unchangedStanceDoesNotCreateARejoinRoute() {
        assertFalse(plan(DescentRejoinPolicy.Trail.inactive(), List.of(A, B), B).accepted());
    }
    @Test void rejectsChangedAcceptedEndpoint() {
        assertEquals("stale_trail", DescentRejoinPolicy.plan(DescentRejoinPolicy.Trail.inactive(), List.of(A, B), A, C,
            c -> true, (a, b) -> true).failure());
    }
    @Test void sixteenCellsAreAcceptedAndSeventeenRejected() {
        var cells = new ArrayList<VoxelCell>();
        for (int i = 0; i < 17; i++) cells.add(new VoxelCell(i, 64 - i, 0));
        assertTrue(plan(DescentRejoinPolicy.Trail.inactive(), cells.subList(0, 16), cells.getFirst()).accepted());
        assertEquals("route_limit", plan(DescentRejoinPolicy.Trail.inactive(), cells, cells.getFirst()).failure());
    }
    @Test void checksAllRouteCellsNotOnlyTheDestination() {
        assertEquals("unsafe_route", DescentRejoinPolicy.plan(DescentRejoinPolicy.Trail.inactive(), List.of(A, B, C), A, C,
            c -> !c.equals(B), (a, b) -> true).failure());
    }
    @Test void requiresBothDirectionsOfEveryTransition() {
        assertEquals("unsafe_route", DescentRejoinPolicy.plan(DescentRejoinPolicy.Trail.inactive(), List.of(A, B, C), A, C,
            c -> true, (a, b) -> a.x() < b.x()).failure());
    }
    @Test void malformedAndUnknownObservationsFailClosed() {
        assertFalse(DescentRejoinPolicy.plan(null, List.of(A, B), A, B, c -> true, (a, b) -> true).accepted());
        var cells = new ArrayList<VoxelCell>(); cells.add(A); cells.add(null);
        assertFalse(DescentRejoinPolicy.plan(DescentRejoinPolicy.Trail.inactive(), cells, A, B, c -> true, (a, b) -> true).accepted());
        assertFalse(DescentRejoinPolicy.plan(DescentRejoinPolicy.Trail.inactive(), List.of(A, B), null, B, c -> true, (a, b) -> true).accepted());
    }
    @Test void freezesSessionRevisionAndContents() {
        var frozen = new DescentRejoinPolicy.Trail(true, true, 1, 2, List.of(A, B));
        assertTrue(DescentRejoinPolicy.sameTrail(frozen, frozen));
        assertFalse(DescentRejoinPolicy.sameTrail(frozen, new DescentRejoinPolicy.Trail(true, true, 2, 2, List.of(A, B))));
        assertFalse(DescentRejoinPolicy.sameTrail(frozen, new DescentRejoinPolicy.Trail(true, true, 1, 3, List.of(A, B))));
        assertFalse(DescentRejoinPolicy.sameTrail(frozen, new DescentRejoinPolicy.Trail(true, true, 1, 2, List.of(A, C))));
        assertFalse(DescentRejoinPolicy.sameTrail(frozen, new DescentRejoinPolicy.Trail(true, false, 1, 2, List.of(A, B))));
    }
    @Test void originalDeadlineAlwaysCapsExistingRouteTimeout() {
        assertEquals(1500, DescentRejoinPolicy.deadline(1000, 1500, 16));
        assertEquals(21000, DescentRejoinPolicy.deadline(1000, 100000, 2));
        assertEquals(41000, DescentRejoinPolicy.deadline(1000, 100000, 16));
    }
    @Test void resultDoesNotAliasCallerOwnedMutableLists() {
        var own = new ArrayList<>(List.of(A, B, C));
        var result = plan(DescentRejoinPolicy.Trail.inactive(), own, A);
        own.clear();
        assertEquals(List.of(A, B, C), result.route());
        assertThrows(UnsupportedOperationException.class, () -> result.route().clear());
    }
    @Test void canonicalSnapshotDoesNotAliasCallerOwnedList() {
        var cells = new ArrayList<>(List.of(A, B));
        var snapshot = new DescentRejoinPolicy.Trail(true, true, 1, 2, cells);
        cells.clear();
        assertEquals(List.of(A, B), snapshot.cells());
    }
    @Test void oneAttemptPersistsAcrossOtherCommandsAndRepeatedRequests() {
        var budget = new DescentRejoinPolicy.Attempts();
        assertTrue(budget.claim("first"));
        assertFalse(budget.claim("first"));
        assertTrue(budget.claim("second"));
        assertFalse(budget.claim("first"));
        assertTrue(budget.contains("first"));
        assertFalse(budget.claim(null));
        assertFalse(budget.claim(""));
    }
    @Test void boundedMemoryNeverEvictsAnOldSpentAttempt() {
        var budget = new DescentRejoinPolicy.Attempts();
        for (int i = 0; i < 256; i++) assertTrue(budget.claim("command-" + i));
        assertFalse(budget.claim("overflow"));
        assertFalse(budget.claim("command-0"));
        budget.clearForNewSession();
        assertTrue(budget.claim("command-0"));
    }
}
