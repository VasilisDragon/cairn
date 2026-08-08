package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class MiningWorkspaceTraversalTest {
    @Test
    void retainsTrueYAndAcceptsOnlyReversibleRecordedRoutes() {
        List<VoxelCell> route = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 65, 0),
            new VoxelCell(2, 64, 0)
        );

        assertTrue(MiningWorkspaceTraversal.reversibleRoute(route));
        assertFalse(MiningWorkspaceTraversal.reversibleRoute(List.of(
            route.get(0),
            new VoxelCell(2, 64, 0)
        )));
        assertFalse(MiningWorkspaceTraversal.reversibleRoute(List.of(
            route.get(0),
            new VoxelCell(1, 62, 0)
        )));
        assertTrue(MiningWorkspaceTraversal.descending(route.get(1), route.get(2)));
        assertTrue(MiningWorkspaceTraversal.shouldJump(route.get(0), route.get(1), true, true));
    }

    @Test
    void rejectsLargeDeviationAndNarrowsTheDescentExemption() {
        assertEquals(
            "mining_workspace_nav3d_descend",
            MiningWorkspaceTraversal.driveReason("mining_workspace", true)
        );
        assertEquals(
            "mining_workspace_nav3d",
            MiningWorkspaceTraversal.driveReason("mining_workspace", false)
        );
    }

    @Test
    void appliesTheBoundedRouteLengthTimeout() {
        assertEquals(20_000L, MiningWorkspaceTraversal.timeoutMs(1));
        assertEquals(25_000L, MiningWorkspaceTraversal.timeoutMs(10));
        assertEquals(180_000L, MiningWorkspaceTraversal.timeoutMs(1_000));
    }

    @Test
    void boundsEdgeGuardLookaheadAtTheValidatedWaypoint() {
        assertEquals(
            1.2D,
            MiningWorkspaceTraversal.edgeGuardLookahead(
                0.5D,
                0.5D,
                new VoxelCell(0, 16, 1)
            ),
            0.0001D
        );
        assertEquals(
            0.8D,
            MiningWorkspaceTraversal.edgeGuardLookahead(
                0.5D,
                1.45D,
                new VoxelCell(0, 16, 1)
            ),
            0.0001D
        );
        assertEquals(
            MiningWorkspaceTraversal.EDGE_GUARD_MAX_LOOKAHEAD,
            MiningWorkspaceTraversal.edgeGuardLookahead(
                0.5D,
                0.5D,
                null
            ),
            0.0001D
        );
    }
}
