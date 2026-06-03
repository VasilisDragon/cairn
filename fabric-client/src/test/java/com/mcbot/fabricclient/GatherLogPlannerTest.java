package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.util.Set;
import org.junit.jupiter.api.Test;

class GatherLogPlannerTest {
    @Test
    void selectsReachableAdjacentCellForTargetLog() {
        KinematicSim perception = new KinematicSim(
            0.0D,
            0.0D,
            0.0D,
            0.2D,
            Set.of(new GridCell(1, 0)),
            -2,
            3,
            -2,
            2
        );

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseAdjacent(perception, new GridCell(0, 0), 1, 0);

        assertEquals("reachable_adjacent_cell", plan.reason());
        assertEquals(new GridCell(0, 0), plan.cell());
        assertFalse(plan.route().isEmpty());
    }

    @Test
    void reportsNoAdjacentPathWhenAllNeighborsAreBlocked() {
        KinematicSim perception = new KinematicSim(
            0.0D,
            0.0D,
            0.0D,
            0.2D,
            Set.of(new GridCell(2, 0), new GridCell(0, 0), new GridCell(1, 1), new GridCell(1, -1)),
            0,
            2,
            -1,
            1
        );

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseAdjacent(perception, new GridCell(0, 1), 1, 0);

        assertEquals("no_reachable_adjacent_cell", plan.reason());
        assertEquals(null, plan.cell());
    }

    @Test
    void skipsExcludedAdjacentCellsForOcclusionReposition() {
        KinematicSim perception = new KinematicSim(
            0.0D,
            0.0D,
            0.0D,
            0.2D,
            Set.of(new GridCell(1, 0)),
            -2,
            3,
            -2,
            2
        );

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseAdjacent(
            perception,
            new GridCell(0, 0),
            1,
            0,
            Set.of(new GridCell(0, 0))
        );

        assertEquals("reachable_adjacent_cell", plan.reason());
        assertEquals(new GridCell(1, 1), plan.cell());
    }
}
