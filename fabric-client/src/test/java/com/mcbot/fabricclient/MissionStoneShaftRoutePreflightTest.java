package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

final class MissionStoneShaftRoutePreflightTest {
    @Test
    void completeLiveComposedRouteIsAdmitted() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = descendingWorld();
        List<VoxelCell> route = descendingRoute();

        McbotFabricClient.MissionStoneShaftRoutePreflight result =
            McbotFabricClient.missionStoneShaftRoutePreflight(world, route);

        assertTrue(result.valid());
        assertTrue(result.fullyObserved());
        assertEquals(McbotFabricClient.MissionStoneShaftRoutePreflight.Status.SAFE, result.status());
        assertEquals(route.size(), result.validatedCells());
        assertEquals(-1, result.invalidIndex());
    }

    @Test
    void missingSupportAnywhereInSuffixRejectsBeforeTraversalLaunch() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = descendingWorld();
        List<VoxelCell> route = descendingRoute();
        VoxelCell invalid = route.get(3);
        world.removeSupport(invalid.x(), invalid.y() - 1, invalid.z());

        McbotFabricClient.MissionStoneShaftRoutePreflight result =
            McbotFabricClient.missionStoneShaftRoutePreflight(world, route);

        assertFalse(result.valid());
        assertEquals("unsafe_cell", result.reason());
        assertEquals(3, result.invalidIndex());
        assertEquals(invalid, result.invalidCell());
    }

    @Test
    void unavailableCellsAreNotReadOrMisclassifiedAsStructuralDamage() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = descendingWorld();
        List<VoxelCell> route = descendingRoute();
        VoxelCell unavailable = route.get(3);
        world.removeSupport(unavailable.x(), unavailable.y() - 1, unavailable.z());

        McbotFabricClient.MissionStoneShaftRoutePreflight result =
            McbotFabricClient.missionStoneShaftRoutePreflight(
                world,
                route,
                cell -> !unavailable.equals(cell)
            );

        assertTrue(result.valid());
        assertFalse(result.fullyObserved());
        assertEquals(
            McbotFabricClient.MissionStoneShaftRoutePreflight.Status.UNAVAILABLE,
            result.status()
        );
        assertEquals("unavailable_cell", result.reason());
        assertEquals(3, result.invalidIndex());
        assertEquals(unavailable, result.invalidCell());
        assertEquals(route.size() - 1, result.validatedCells());
    }

    @Test
    void observedStructuralDamageStillWinsOverAnotherUnavailableCell() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = descendingWorld();
        List<VoxelCell> route = descendingRoute();
        VoxelCell invalid = route.get(2);
        VoxelCell unavailable = route.get(4);
        world.removeSupport(invalid.x(), invalid.y() - 1, invalid.z());

        McbotFabricClient.MissionStoneShaftRoutePreflight result =
            McbotFabricClient.missionStoneShaftRoutePreflight(
                world,
                route,
                cell -> !unavailable.equals(cell)
            );

        assertFalse(result.valid());
        assertEquals(McbotFabricClient.MissionStoneShaftRoutePreflight.Status.UNSAFE, result.status());
        assertEquals("unsafe_cell", result.reason());
        assertEquals(2, result.invalidIndex());
        assertEquals(invalid, result.invalidCell());
    }

    @Test
    void envelopeRequiresAdjacentChunksAtAChunkBoundary() {
        Set<String> queried = new HashSet<>();
        VoxelCell boundary = new VoxelCell(15, 64, 0);

        boolean observed = McbotFabricClient.missionStoneShaftEnvelopeObserved(
            boundary,
            (chunkX, chunkZ) -> {
                queried.add(chunkX + ":" + chunkZ);
                return chunkX != 1 || chunkZ != 0;
            }
        );

        assertFalse(observed);
        assertTrue(queried.contains("0:0"));
        assertTrue(queried.contains("0:-1"));
        assertTrue(queried.contains("1:0"));
        assertTrue(McbotFabricClient.missionStoneShaftEnvelopeObserved(
            boundary,
            (chunkX, chunkZ) -> true
        ));
    }

    @Test
    void oneWayOrDisconnectedEdgeRejectsEvenWhenEndpointsAreStandable() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = new
            SurfaceReturnTrailGapPlannerTest.TestWorld(-1, 3, 60, 70, -1, 1);
        world.support(0, 63, 0);
        world.support(2, 63, 0);
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(2, 64, 0)
        );

        McbotFabricClient.MissionStoneShaftRoutePreflight result =
            McbotFabricClient.missionStoneShaftRoutePreflight(world, route);

        assertFalse(result.valid());
        assertEquals("unsafe_edge", result.reason());
        assertEquals(1, result.invalidIndex());

        McbotFabricClient.MissionStoneShaftRoutePreflight unavailableEndpoints =
            McbotFabricClient.missionStoneShaftRoutePreflight(
                world,
                route,
                cell -> false
            );
        assertFalse(unavailableEndpoints.valid());
        assertEquals("unsafe_edge", unavailableEndpoints.reason());
        assertEquals(1, unavailableEndpoints.invalidIndex());
    }

    private static SurfaceReturnTrailGapPlannerTest.TestWorld descendingWorld() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world = new
            SurfaceReturnTrailGapPlannerTest.TestWorld(-1, 6, 58, 72, -1, 1);
        for (int x = 0; x <= 5; x++) {
            int feetY = 68 - x;
            world.support(x, feetY - 1, 0);
        }
        return world;
    }

    private static List<VoxelCell> descendingRoute() {
        return List.of(
            new VoxelCell(0, 68, 0),
            new VoxelCell(1, 67, 0),
            new VoxelCell(2, 66, 0),
            new VoxelCell(3, 65, 0),
            new VoxelCell(4, 64, 0),
            new VoxelCell(5, 63, 0)
        );
    }
}
