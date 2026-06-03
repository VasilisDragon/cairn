package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class NavigatorTest {
    private static final double EPSILON = 0.000_001D;

    @Test
    void headingPointsAtTargetAndMovesForwardWhenAligned() {
        BrainLink.Intent south = Navigator.toward(0.0D, 0.0D, 0.0D, 0.0D, 10.0D, 0.25D);
        assertEquals("navigate_forward", south.action());
        assertTrue(south.forward());
        assertEquals(0.0D, south.targetYaw(), EPSILON);

        BrainLink.Intent east = Navigator.toward(0.0D, 0.0D, -90.0D, 10.0D, 0.0D, 0.25D);
        assertEquals("navigate_forward", east.action());
        assertTrue(east.forward());
        assertEquals(-90.0D, east.targetYaw(), EPSILON);
    }

    @Test
    void arrivalWithinEpsilonStops() {
        BrainLink.Intent arrived = Navigator.toward(5.0D, 5.0D, 0.0D, 5.2D, 5.1D, 0.5D);

        assertEquals("stop", arrived.action());
        assertFalse(arrived.forward());
        assertEquals("arrived", arrived.reason());
        assertNull(arrived.targetYaw());
    }

    @Test
    void facingAwayTurnsFirstWithoutForwardInput() {
        BrainLink.Intent intent = Navigator.toward(0.0D, 0.0D, 180.0D, 0.0D, 10.0D, 0.25D);

        assertEquals("turn_toward", intent.action());
        assertFalse(intent.forward());
        assertEquals(0.0D, intent.targetYaw(), EPSILON);
        assertEquals("turning_to_target", intent.reason());
    }

    @Test
    void yawErrorRampsForwardAmountBeforeStoppingMovement() {
        BrainLink.Intent aligned = Navigator.toward(0.0D, 0.0D, 8.0D, 0.0D, 10.0D, 0.25D);
        assertTrue(aligned.forward());
        assertEquals(1.0D, aligned.movementForwardOverride(), EPSILON);

        BrainLink.Intent arcing = Navigator.toward(0.0D, 0.0D, 30.0D, 0.0D, 10.0D, 0.25D);
        assertEquals("navigate_forward", arcing.action());
        assertTrue(arcing.forward());
        assertTrue(arcing.movementForwardOverride() > Navigator.MIN_ARC_FORWARD);
        assertTrue(arcing.movementForwardOverride() < 1.0D);

        BrainLink.Intent tooFarOff = Navigator.toward(0.0D, 0.0D, 55.0D, 0.0D, 10.0D, 0.25D);
        assertFalse(tooFarOff.forward());
        assertEquals("turn_toward", tooFarOff.action());
    }
}
