package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.util.Set;
import org.junit.jupiter.api.Test;

class CollectNavigationTargetPlannerTest {
    @Test
    void prefersReachableItemCellOverAlreadyAdjacentStartCell() {
        GridPerception perception = new KinematicSim(0.0D, 0.0D, 0.0D, 0.2D, Set.of(), -2, 2, -2, 2);
        GridCell start = new GridCell(0, 0);
        GridCell itemCell = new GridCell(0, 1);

        CollectNavigationTargetPlanner.TargetPlan plan =
            CollectNavigationTargetPlanner.chooseTarget(perception, start, itemCell, 0.0D);

        assertEquals(itemCell, plan.cell());
        assertEquals("reachable_item_cell", plan.reason());
        assertFalse(plan.route().isEmpty());
    }
}
