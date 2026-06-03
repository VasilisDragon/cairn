package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Set;
import org.junit.jupiter.api.Test;

class KinematicSimObstacleTest {
    private static final double EPS = 0.000_001D;

    @Test
    void blockedCellRejectsPenetrationButAllowsYawUpdate() {
        KinematicSim sim = new KinematicSim(
            0.5D,
            0.5D,
            0.0D,
            0.6D,
            Set.of(new GridCell(0, 1)),
            -2,
            2,
            -2,
            2
        );

        sim.step(
            new InputState(true, false, false, false, false, false, 1.0F, 0.0F),
            new LookController.Look(30.0D, 0.0D)
        );

        assertEquals(0.5D, sim.x(), EPS);
        assertEquals(0.5D, sim.z(), EPS);
        assertEquals(30.0D, sim.yaw(), EPS);
    }

    @Test
    void openCellMovementStillAdvances() {
        KinematicSim sim = new KinematicSim(
            0.5D,
            0.5D,
            0.0D,
            0.4D,
            Set.of(new GridCell(2, 2)),
            -2,
            2,
            -2,
            2
        );

        sim.step(
            new InputState(true, false, false, false, false, false, 1.0F, 0.0F),
            new LookController.Look(0.0D, 0.0D)
        );

        assertEquals(0.5D, sim.x(), EPS);
        assertEquals(0.9D, sim.z(), EPS);
    }

    @Test
    void navScenarioObstacleVariantCarriesLayoutAndPreventsStraightLineArrival() {
        NavScenario.Result result = NavScenario.run(
            0.5D,
            0.5D,
            0.0D,
            0.5D,
            3.5D,
            0.25D,
            30.0D,
            0.4D,
            40,
            Set.of(new GridCell(0, 1)),
            -2,
            2,
            -2,
            4
        );

        assertFalse(result.arrived());
        assertTrue(result.finalDistance() > 2.0D);
    }
}
