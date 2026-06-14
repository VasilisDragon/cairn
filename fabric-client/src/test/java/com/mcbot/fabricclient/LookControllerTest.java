package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class LookControllerTest {
    private static final double EPSILON = 0.000_001D;

    @Test
    void wrapsShortestYawAcrossPositiveNegativeBoundary() {
        LookController.Look look = LookController.nextLook(179.0D, 0.0D, -179.0D, 0.0D, 5.0D);
        assertEquals(0.7D, LookController.shortestYawDelta(179.0D, look.yaw()), EPSILON);
        assertEquals(0.0D, look.pitch(), EPSILON);
    }

    @Test
    void capsCombinedStepAndMovesDiagonally() {
        // Vector easing (feel pass 2): yaw+pitch advance along the COMBINED direction (one straight
        // diagonal line, no axis-by-axis L), capped at 1.8x base for big swings — still firmly
        // turn-rate-limited (16 deg/tick peak at the live base of 9).
        LookController.Look look = LookController.nextLook(0.0D, 10.0D, 100.0D, -80.0D, 7.5D);
        double yawStep = LookController.shortestYawDelta(0.0D, look.yaw());
        double pitchStep = look.pitch() - 10.0D;
        assertEquals(7.5D * 1.8D, Math.hypot(yawStep, pitchStep), EPSILON);
        // Direction preserved: the step is parallel to the (100, -90) delta.
        assertEquals(100.0D / -90.0D, yawStep / pitchStep, 1.0E-9D);
    }

    @Test
    void convergesToTargetOverRepeatedSteps() {
        LookController.Look look = new LookController.Look(0.0D, 0.0D);
        for (int i = 0; i < 80; i++) {
            look = LookController.nextLook(look.yaw(), look.pitch(), 45.0D, -30.0D, 5.0D);
        }

        assertEquals(45.0D, look.yaw(), EPSILON);
        assertEquals(-30.0D, look.pitch(), EPSILON);
    }

    @Test
    void pitchTargetClampsAtPoles() {
        LookController.Look lookUp = new LookController.Look(0.0D, 80.0D);
        for (int i = 0; i < 40; i++) {
            lookUp = LookController.nextLook(lookUp.yaw(), lookUp.pitch(), 0.0D, 140.0D, 20.0D);
        }
        assertEquals(90.0D, lookUp.pitch(), EPSILON);

        LookController.Look lookDown = new LookController.Look(0.0D, -80.0D);
        for (int i = 0; i < 40; i++) {
            lookDown = LookController.nextLook(lookDown.yaw(), lookDown.pitch(), 0.0D, -140.0D, 20.0D);
        }
        assertEquals(-90.0D, lookDown.pitch(), EPSILON);

        assertTrue(lookUp.pitch() <= 90.0D);
        assertTrue(lookDown.pitch() >= -90.0D);
    }

    @Test
    void proportionalStepShrinksNearTarget() {
        LookController.Look far = LookController.nextLook(0.0D, 0.0D, 20.0D, 0.0D, 30.0D);
        LookController.Look near = LookController.nextLook(18.0D, 0.0D, 20.0D, 0.0D, 30.0D);

        double farStep = Math.abs(LookController.shortestYawDelta(0.0D, far.yaw()));
        double nearStep = Math.abs(LookController.shortestYawDelta(18.0D, near.yaw()));
        assertTrue(nearStep < farStep, "nearStep=" + nearStep + " farStep=" + farStep);
        assertTrue(nearStep >= LookController.DEFAULT_MIN_DEG_PER_TICK);
    }
}
