package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class StartAnchoredGridPerceptionTest {
    @Test
    void anchoredStartAvoidsCutLogCellsThatScanAsLowSurface() {
        GridCell start = new GridCell(-2, 0);
        KinematicSim misreadCutLogRow = new KinematicSim(
            -2.2D,
            0.5D,
            90.0D,
            0.2D,
            Set.of(new GridCell(-5, 0)),
            Map.of(
                start, -8,
                new GridCell(-3, 0), -8,
                new GridCell(-2, 1), 24,
                new GridCell(-3, 1), 24,
                new GridCell(-4, 1), 24,
                new GridCell(-4, -1), 24
            ),
            -6,
            0,
            -2,
            2
        );

        GatherLogPlanner.AdjacentPlan unanchored =
            GatherLogPlanner.chooseAdjacent(misreadCutLogRow, start, -4, 0);
        GatherLogPlanner.AdjacentPlan anchored =
            GatherLogPlanner.chooseAdjacent(StartAnchoredGridPerception.anchor(misreadCutLogRow, start, 24), start, -4, 0);

        assertEquals(new GridCell(-3, 0), unanchored.cell());
        assertNotEquals(new GridCell(-3, 0), anchored.cell());
        assertEquals(new GridCell(-4, 1), anchored.cell());
        assertEquals("reachable_adjacent_cell", anchored.reason());
    }
}
