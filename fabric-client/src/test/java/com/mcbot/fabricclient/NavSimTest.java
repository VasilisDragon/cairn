package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * End-to-end offline proof that Navigator + LookController + BrainLink.inputStateFor,
 * driven through the KinematicSim, actually converge on targets. This is the seed
 * suite the hardening loop expands.
 */
class NavSimTest {
    private static final double EPS = 0.5D;
    private static final double TURN = 30.0D;
    private static final double SPEED = 0.2D;
    private static final int MAX_TICKS = 600;

    private static NavScenario.Result run(double sx, double sz, double sy, double tx, double tz) {
        return NavScenario.run(sx, sz, sy, tx, tz, EPS, TURN, SPEED, MAX_TICKS);
    }

    @Test
    void arrivesAtTargetDeadAhead() {
        // Facing south (+Z), target due south.
        NavScenario.Result r = run(0, 0, 0, 0, 10);
        assertTrue(r.arrived(), "should arrive; finalDistance=" + r.finalDistance());
        assertTrue(r.finalDistance() <= EPS);
    }

    @Test
    void turnsAroundForTargetBehind() {
        // Facing south, target due north — must turn ~180 first.
        NavScenario.Result r = run(0, 0, 0, 0, -10);
        assertTrue(r.arrived(), "should turn around and arrive; finalDistance=" + r.finalDistance());
        assertTrue(r.finalDistance() <= EPS);
    }

    @Test
    void reachesTargetToTheSide() {
        // Facing south, target due east.
        NavScenario.Result r = run(0, 0, 0, 10, 0);
        assertTrue(r.arrived(), "should arrive; finalDistance=" + r.finalDistance());
    }

    @Test
    void reachesDiagonalTargetFromArbitraryYaw() {
        NavScenario.Result r = run(5, -3, 123, 20, 14);
        assertTrue(r.arrived(), "diagonal nav; finalDistance=" + r.finalDistance());
    }

    @Test
    void alreadyAtTargetArrivesImmediately() {
        NavScenario.Result r = run(0, 0, 45, 0, 0);
        assertTrue(r.arrived());
        assertEquals(0, r.ticks());
    }

    @Test
    void reachableTargetCompletesWellUnderBudget() {
        // Guards against silent oscillation/never-arriving regressions.
        NavScenario.Result r = run(0, 0, 0, 0, 8);
        assertTrue(r.arrived() && r.ticks() < 200, "ticks=" + r.ticks());
    }
}
