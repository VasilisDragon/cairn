package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.*;
import java.util.List;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

class DescentAdjacentReturnTest {
    private static final VoxelCell TARGET = new VoxelCell(0, 64, 0);
    private static final List<VoxelCell> REACHED = List.of(new VoxelCell(-1, 65, 0), TARGET);

    private static void accepts(VoxelCell actual) {
        var trail = new DescentRejoinPolicy.Trail(true, true, 7, 3, REACHED);
        var result = DescentRejoinPolicy.plan(trail, REACHED, actual, TARGET, cell -> true, (a, b) -> true);
        assertTrue(result.accepted(), result.failure());
        assertEquals(List.of(actual, TARGET), result.route());
        assertEquals("adjacent_return", result.routeKind());
        assertEquals(REACHED, trail.cells());
    }

    @Test void acceptsEastAdjacentReturn() { accepts(new VoxelCell(1, 64, 0)); }
    @Test void acceptsWestAdjacentReturn() { accepts(new VoxelCell(-1, 64, 0)); }
    @Test void acceptsNorthAdjacentReturn() { accepts(new VoxelCell(0, 64, -1)); }
    @Test void acceptsSouthAdjacentReturn() { accepts(new VoxelCell(0, 64, 1)); }

    private static final VoxelCell ACTUAL = new VoxelCell(0, 64, 1);
    private static DescentRejoinPolicy.Plan plan(List<VoxelCell> reached, VoxelCell actual) {
        return DescentRejoinPolicy.plan(DescentRejoinPolicy.Trail.inactive(), reached, actual, TARGET,
            c -> true, (a, b) -> true);
    }
    @Test void recordedRouteTakesPrecedenceEvenWhenAcceptedTargetIsAdjacent() {
        var recorded = List.of(ACTUAL, new VoxelCell(1, 64, 1), new VoxelCell(1, 64, 0), TARGET);
        var result = plan(recorded, ACTUAL);
        assertEquals(recorded, result.route());
        assertEquals("recorded_segment", result.routeKind());
    }
    @Test void invalidRecordedRouteNeverFallsBackToDirectReturn() {
        var recorded = List.of(ACTUAL, new VoxelCell(1, 64, 1), new VoxelCell(1, 64, 0), TARGET);
        var result = DescentRejoinPolicy.plan(DescentRejoinPolicy.Trail.inactive(), recorded, ACTUAL, TARGET,
            c -> !c.equals(recorded.get(1)), (a,b) -> true);
        assertEquals("unsafe_route", result.failure());
        assertNull(result.routeKind());
    }
    @Test void rejectsDiagonalVerticalDistantAndOverflowCoordinates() {
        for (var actual : List.of(new VoxelCell(1,64,1), new VoxelCell(0,65,1),
            new VoxelCell(0,63,1), new VoxelCell(0,64,2), new VoxelCell(Integer.MIN_VALUE,64,1),
            new VoxelCell(Integer.MAX_VALUE,64,2), TARGET)) assertFalse(plan(REACHED, actual).accepted(), actual.toString());
    }
    @Test void rejectsUnavailableMissingOverlapAndDuplicateTrailsBeforeCellQueries() {
        for (var trail : List.of(new DescentRejoinPolicy.Trail(true,false,1,1,REACHED),
            new DescentRejoinPolicy.Trail(true,true,1,1,List.of(new VoxelCell(8,64,8))),
            new DescentRejoinPolicy.Trail(true,true,1,1,List.of(TARGET,REACHED.getFirst(),TARGET)),
            new DescentRejoinPolicy.Trail(true,true,1,1,List.of()))) {
            var result = DescentRejoinPolicy.plan(trail,REACHED,ACTUAL,TARGET,
                c -> { fail("invalid trail reached cell admission"); return true; }, (a,b) -> true);
            assertFalse(result.accepted());
        }
    }
    @Test void disconnectedReachedTrailCannotBeRepairedByAdjacentReturn() {
        assertEquals("route_unavailable", plan(List.of(new VoxelCell(9,64,9),TARGET), ACTUAL).failure());
        assertEquals("route_unavailable", plan(List.of(new VoxelCell(0,65,0),TARGET), ACTUAL).failure());
        assertEquals("route_unavailable", plan(List.of(new VoxelCell(1,67,0),TARGET), ACTUAL).failure());
    }
    @Test void targetMustRemainFinalReachedCell() {
        var result = DescentRejoinPolicy.plan(DescentRejoinPolicy.Trail.inactive(),REACHED,ACTUAL,REACHED.getFirst(),
            c -> true,(a,b) -> true);
        assertEquals("stale_trail",result.failure());
    }
    @Test void validatesExactlyBothReturnCellsAndBothEdgeDirections() {
        var cells = new ArrayList<VoxelCell>();
        var edges = new ArrayList<List<VoxelCell>>();
        var result = DescentRejoinPolicy.plan(DescentRejoinPolicy.Trail.inactive(),REACHED,ACTUAL,TARGET,
            c -> { cells.add(c); return true; }, (a,b) -> { edges.add(List.of(a,b)); return true; });
        assertTrue(result.accepted());
        assertEquals(List.of(ACTUAL,TARGET),cells);
        assertEquals(List.of(List.of(ACTUAL,TARGET),List.of(TARGET,ACTUAL)),edges);
    }
    @Test void oneWayEdgesCannotAuthorizeReturn() {
        for (var deniedFrom : List.of(ACTUAL,TARGET)) {
            assertEquals("unsafe_route",DescentRejoinPolicy.plan(DescentRejoinPolicy.Trail.inactive(),REACHED,ACTUAL,TARGET,
                c -> true,(a,b) -> !a.equals(deniedFrom)).failure());
        }
    }
    @Test void routeAndTrailSnapshotsAreImmutable() {
        var reached = new ArrayList<>(REACHED);
        var result = plan(reached,ACTUAL);
        assertEquals(REACHED,reached);
        reached.clear();
        assertEquals(List.of(ACTUAL,TARGET),result.route());
        assertThrows(UnsupportedOperationException.class,() -> result.route().clear());
    }
    @Test void exactExpiryAndExistingTwentySecondTraversalBoundRemainUnchanged() {
        var stance = new DescentRejoinPolicy.Stance(true,true,true,true,true);
        assertEquals(DescentRejoinPolicy.Admission.READY,DescentRejoinPolicy.admission(stance,999,1000));
        assertEquals(DescentRejoinPolicy.Admission.EXPIRED,DescentRejoinPolicy.admission(stance,1000,1000));
        assertEquals(DescentRejoinPolicy.Admission.EXPIRED,DescentRejoinPolicy.admission(stance,1001,1000));
        assertEquals(1000,DescentRejoinPolicy.deadline(999,1000,2));
        assertEquals(21000,DescentRejoinPolicy.deadline(1000,45000,2));
    }
    @Test void changedSessionRevisionAndTrailInvalidateAdmittedAdjacentRoute() {
        var frozen = new DescentRejoinPolicy.Trail(true,true,1,2,REACHED);
        for (var changed : List.of(new DescentRejoinPolicy.Trail(true,true,2,2,REACHED),
            new DescentRejoinPolicy.Trail(true,true,1,3,REACHED),
            new DescentRejoinPolicy.Trail(true,true,1,2,List.of(TARGET)),
            new DescentRejoinPolicy.Trail(true,false,1,2,REACHED))) assertFalse(DescentRejoinPolicy.sameTrail(frozen,changed));
    }
    @Test void oneAttemptSurvivesRepeatedTicksAndArrival() {
        var attempts = new DescentRejoinPolicy.Attempts();
        assertTrue(attempts.claim("held"));
        assertTrue(plan(REACHED,ACTUAL).accepted());
        for (int i=0;i<100;i++) assertFalse(attempts.claim("held"));
    }
    private static final class World implements GatherWoodLocalEgressPerception {
        final Set<VoxelCell> blocked = new HashSet<>(), wet = new HashSet<>(), hazardous = new HashSet<>(), unsupported = new HashSet<>();
        boolean loaded = true;
        public int minX() { return -3; } public int maxX() { return 3; }
        public int minY() { return 60; } public int maxY() { return 68; }
        public int minZ() { return -3; } public int maxZ() { return loaded ? 3 : -1; }
        public boolean isSolid(int x,int y,int z) { return (y==63 && !unsupported.contains(new VoxelCell(x,64,z))) || blocked.contains(new VoxelCell(x,y,z)); }
        public boolean isHazard(int x,int y,int z) { return hazardous.contains(new VoxelCell(x,y,z)); }
        public boolean isWater(int x,int y,int z) { return wet.contains(new VoxelCell(x,y,z)); }
        public boolean isLava(int x,int y,int z) { return false; }
    }
    private static DescentRejoinPolicy.Plan worldPlan(World world) {
        return DescentRejoinPolicy.plan(DescentRejoinPolicy.Trail.inactive(),REACHED,ACTUAL,TARGET,
            c -> SurfaceReturnTrailGapPlanner.safeCell(world,c),
            (a,b) -> SurfaceReturnTrailGapPlanner.reversibleStep(world,a,b));
    }
    @Test void usesExistingWorldPredicatesForSafeLevelReturn() { assertTrue(worldPlan(new World()).accepted()); }
    @Test void blockedCellsRejectWithoutMutation() {
        for (var cell : List.of(ACTUAL,TARGET,new VoxelCell(0,65,0))) {
            var world = new World(); world.blocked.add(cell); assertFalse(worldPlan(world).accepted()); assertEquals(Set.of(cell),world.blocked);
        }
    }
    @Test void wetCellsReject() { for(var cell:List.of(ACTUAL,TARGET)) { var world=new World();world.wet.add(cell);assertFalse(worldPlan(world).accepted()); } }
    @Test void unsupportedCellsReject() { for(var cell:List.of(ACTUAL,TARGET)) { var world=new World();world.unsupported.add(cell);assertFalse(worldPlan(world).accepted()); } }
    @Test void hazardousCellsReject() { for(var cell:List.of(ACTUAL,TARGET)) { var world=new World();world.hazardous.add(cell);assertFalse(worldPlan(world).accepted()); } }
    @Test void unavailableWorldRejects() { var world=new World();world.loaded=false;assertFalse(worldPlan(world).accepted()); }
    @Test void terrainChangesInvalidateReturnBeforeTraversalContinues() {
        var world = new World(); var route = worldPlan(world).route();
        assertEquals(List.of(ACTUAL,TARGET),route);
        world.blocked.add(TARGET);
        assertFalse(DescentRejoinPolicy.validRoute(route,c -> SurfaceReturnTrailGapPlanner.safeCell(world,c),
            (a,b) -> SurfaceReturnTrailGapPlanner.reversibleStep(world,a,b)));
    }
}
