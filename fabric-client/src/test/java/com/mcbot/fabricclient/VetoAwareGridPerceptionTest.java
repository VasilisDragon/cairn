package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.OptionalInt;
import java.util.Set;
import org.junit.jupiter.api.Test;

class VetoAwareGridPerceptionTest {
    private static final GridPerception OPEN = new GridPerception() {
        @Override
        public boolean isBlocked(int x, int z) {
            return false;
        }

        @Override
        public int minX() {
            return -16;
        }

        @Override
        public int maxX() {
            return 16;
        }

        @Override
        public int minZ() {
            return -16;
        }

        @Override
        public int maxZ() {
            return 16;
        }
    };

    @Test
    void vetoedCellsReadBlockedAndSurfaceless() {
        VetoAwareGridPerception perception =
            new VetoAwareGridPerception(OPEN, Set.of(new GridCell(3, 4)));
        assertTrue(perception.isBlocked(3, 4));
        assertEquals(OptionalInt.empty(), perception.surfaceY(3, 4));
        assertFalse(perception.isBlocked(2, 4));
        assertTrue(perception.surfaceY(2, 4).isPresent());
    }

    @Test
    void traversalBlocksIntoVetoButNotOutOfIt() {
        VetoAwareGridPerception perception =
            new VetoAwareGridPerception(OPEN, Set.of(new GridCell(1, 0)));
        assertEquals(TraversalIssue.TO_BLOCKED,
            perception.traversalIssue(new GridCell(0, 0), new GridCell(1, 0)));
        // Standing IN the vetoed cell must not wedge: walking out stays legal.
        assertEquals(TraversalIssue.NONE,
            perception.traversalIssue(new GridCell(1, 0), new GridCell(2, 0)));
    }

    @Test
    void routerPathsAroundVetoedCells() {
        // Straight line 0,0 -> 4,0 with the middle vetoed: the route must detour, not fail.
        VetoAwareGridPerception perception =
            new VetoAwareGridPerception(OPEN, Set.of(new GridCell(2, 0)));
        var route = GridAStar.route(perception, new GridCell(0, 0), new GridCell(4, 0));
        assertFalse(route.isEmpty(), "expected a detour route");
        assertFalse(route.contains(new GridCell(2, 0)), "route must avoid the vetoed cell");
    }
}
