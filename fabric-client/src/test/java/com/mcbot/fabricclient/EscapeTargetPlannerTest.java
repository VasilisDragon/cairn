package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;

class EscapeTargetPlannerTest {
    /** Minimal flat grid: every in-bounds cell is walkable except the explicitly blocked (wall) cells. */
    private static final class Grid implements GridPerception {
        private final Set<GridCell> blocked;
        private final int minX;
        private final int maxX;
        private final int minZ;
        private final int maxZ;

        Grid(int minX, int maxX, int minZ, int maxZ, Set<GridCell> blocked) {
            this.minX = minX;
            this.maxX = maxX;
            this.minZ = minZ;
            this.maxZ = maxZ;
            this.blocked = blocked;
        }

        @Override
        public boolean isBlocked(int x, int z) {
            return blocked.contains(new GridCell(x, z));
        }

        @Override
        public int minX() {
            return minX;
        }

        @Override
        public int maxX() {
            return maxX;
        }

        @Override
        public int minZ() {
            return minZ;
        }

        @Override
        public int maxZ() {
            return maxZ;
        }
    }

    private static Set<GridCell> walls(GridCell... cells) {
        Set<GridCell> set = new HashSet<>();
        for (GridCell cell : cells) {
            set.add(cell);
        }
        return set;
    }

    @Test
    void picksFarthestReachableCellInOpenGrid() {
        Grid g = new Grid(0, 4, 0, 4, walls());
        Optional<GridCell> escape = EscapeTargetPlanner.pickEscapeCell(g, new GridCell(2, 2), new GridCell(0, 0), 1024);
        assertTrue(escape.isPresent());
        assertEquals(new GridCell(4, 4), escape.get());
    }

    @Test
    void routesAroundAWallThroughAGap() {
        // Wall along x=2 for z=0..3 with a gap at (2,4). Bot in the left half, threat to its west;
        // the farthest reachable cells are in the right half, reachable only through the gap.
        Set<GridCell> w = walls(new GridCell(2, 0), new GridCell(2, 1), new GridCell(2, 2), new GridCell(2, 3));
        Grid g = new Grid(0, 4, 0, 4, w);
        Optional<GridCell> escape = EscapeTargetPlanner.pickEscapeCell(g, new GridCell(1, 2), new GridCell(0, 2), 1024);
        assertTrue(escape.isPresent());
        assertEquals(4, escape.get().x());
    }

    @Test
    void escapesDownACorridorAwayFromAnAdjacentThreat() {
        Grid g = new Grid(0, 6, 0, 0, walls());
        Optional<GridCell> escape = EscapeTargetPlanner.pickEscapeCell(g, new GridCell(2, 0), new GridCell(1, 0), 1024);
        assertTrue(escape.isPresent());
        assertEquals(new GridCell(6, 0), escape.get());
    }

    @Test
    void returnsEmptyWhenBoxedIn() {
        Set<GridCell> w = walls(new GridCell(3, 2), new GridCell(1, 2), new GridCell(2, 3), new GridCell(2, 1));
        Grid g = new Grid(0, 4, 0, 4, w);
        Optional<GridCell> escape = EscapeTargetPlanner.pickEscapeCell(g, new GridCell(2, 2), new GridCell(0, 2), 1024);
        assertFalse(escape.isPresent());
    }

    @Test
    void returnsEmptyWhenAlreadyFarthestFromThreat() {
        Grid g = new Grid(0, 4, 0, 4, walls());
        Optional<GridCell> escape = EscapeTargetPlanner.pickEscapeCell(g, new GridCell(4, 4), new GridCell(0, 0), 1024);
        assertFalse(escape.isPresent());
    }

    @Test
    void nullArgumentsYieldEmpty() {
        Grid g = new Grid(0, 4, 0, 4, walls());
        assertFalse(EscapeTargetPlanner.pickEscapeCell(null, new GridCell(0, 0), new GridCell(1, 1), 16).isPresent());
        assertFalse(EscapeTargetPlanner.pickEscapeCell(g, null, new GridCell(1, 1), 16).isPresent());
        assertFalse(EscapeTargetPlanner.pickEscapeCell(g, new GridCell(0, 0), null, 16).isPresent());
    }
}
