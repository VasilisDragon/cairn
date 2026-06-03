package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class GridAStarHeightTest {
    @Test
    void oneBlockStepUpIsRoutable() {
        KinematicSim perception = heightMap(
            Map.of(
                new GridCell(0, 0), 64,
                new GridCell(1, 0), 65,
                new GridCell(2, 0), 65
            )
        );

        List<GridCell> route = GridAStar.route(perception, new GridCell(0, 0), new GridCell(2, 0));

        assertEquals(List.of(new GridCell(0, 0), new GridCell(1, 0), new GridCell(2, 0)), route);
    }

    @Test
    void twoBlockRiseIsBlocked() {
        KinematicSim perception = heightMap(
            Map.of(
                new GridCell(0, 0), 64,
                new GridCell(1, 0), 66,
                new GridCell(2, 0), 66
            )
        );

        assertTrue(GridAStar.route(perception, new GridCell(0, 0), new GridCell(2, 0)).isEmpty());
    }

    @Test
    void safeDropIsRoutableButUnsafeDropIsNot() {
        KinematicSim safe = heightMap(
            Map.of(
                new GridCell(0, 0), 66,
                new GridCell(1, 0), 63
            )
        );
        assertFalse(GridAStar.route(safe, new GridCell(0, 0), new GridCell(1, 0)).isEmpty());

        KinematicSim unsafe = heightMap(
            Map.of(
                new GridCell(0, 0), 67,
                new GridCell(1, 0), 63
            )
        );
        assertTrue(GridAStar.route(unsafe, new GridCell(0, 0), new GridCell(1, 0)).isEmpty());
    }

    @Test
    void undulatingTerrainThatFlatSliceWouldRejectNowRoutes() {
        Map<GridCell, Integer> heights = Map.of(
            new GridCell(0, 0), 64,
            new GridCell(1, 0), 65,
            new GridCell(2, 0), 65,
            new GridCell(3, 0), 64,
            new GridCell(4, 0), 65
        );
        KinematicSim heightAware = heightMap(heights);
        GridPerception fixedSingleYSlice = new KinematicSim(
            0.5D,
            0.5D,
            0.0D,
            0.2D,
            Set.of(new GridCell(1, 0), new GridCell(2, 0), new GridCell(4, 0)),
            0,
            4,
            0,
            0
        );

        assertTrue(GridAStar.route(fixedSingleYSlice, new GridCell(0, 0), new GridCell(4, 0)).isEmpty());

        List<GridCell> route = GridAStar.route(heightAware, new GridCell(0, 0), new GridCell(4, 0));
        assertEquals(
            List.of(new GridCell(0, 0), new GridCell(1, 0), new GridCell(2, 0), new GridCell(3, 0), new GridCell(4, 0)),
            route
        );
    }

    private static KinematicSim heightMap(Map<GridCell, Integer> heights) {
        return new KinematicSim(
            0.5D,
            0.5D,
            0.0D,
            0.2D,
            Set.of(),
            heights,
            0,
            Math.max(0, heights.keySet().stream().mapToInt(GridCell::x).max().orElse(0)),
            0,
            0
        );
    }
}
