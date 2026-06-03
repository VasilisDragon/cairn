package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class GridPerceptionTest {
    @Test
    void kinematicSimExposesBlockedCellsAndBounds() {
        KinematicSim sim = new KinematicSim(
            0.0D,
            0.0D,
            0.0D,
            0.2D,
            Set.of(new GridCell(2, 3)),
            -5,
            5,
            -4,
            4
        );

        assertTrue(sim.inBounds(0, 0));
        assertTrue(sim.isBlocked(2, 3));
        assertTrue(sim.surfaceY(2, 3).isEmpty());
        assertFalse(sim.isBlocked(1, 3));
        assertTrue(sim.surfaceY(1, 3).isPresent());
        assertTrue(sim.isBlocked(6, 0), "out-of-bounds cells are treated as blocked");
        assertTrue(sim.isBlocked(0, -5), "out-of-bounds cells are treated as blocked");
    }

    @Test
    void defaultKinematicSimIsUnboundedOpenWorld() {
        KinematicSim sim = new KinematicSim(0.0D, 0.0D, 0.0D, 0.2D);

        assertFalse(sim.isBlocked(0, 0));
        assertFalse(sim.isBlocked(1_000_000, -1_000_000));
    }

    @Test
    void kinematicSimCarriesSurfaceHeightsAndStepRules() {
        KinematicSim sim = new KinematicSim(
            0.5D,
            0.5D,
            0.0D,
            0.2D,
            Set.of(),
            Map.of(
                new GridCell(0, 0), 64,
                new GridCell(1, 0), 65,
                new GridCell(2, 0), 67
            ),
            0,
            2,
            0,
            0
        );

        assertTrue(sim.surfaceY(0, 0).isPresent());
        assertTrue(sim.canTraverse(new GridCell(0, 0), new GridCell(1, 0)));
        assertFalse(sim.canTraverse(new GridCell(1, 0), new GridCell(2, 0)));
    }
}
