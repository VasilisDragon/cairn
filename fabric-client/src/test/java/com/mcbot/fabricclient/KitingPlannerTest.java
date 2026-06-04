package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class KitingPlannerTest {
    @Test
    void strafesAgainstRangedThreatAtMidDistance() {
        KitingPlanner.Decision decision = KitingPlanner.decide(
            CombatPlanner.ThreatKind.RANGED,
            8.0D,
            3.0D,
            14.0D,
            1,
            2_000L,
            1_000L,
            700L
        );

        assertTrue(decision.strafing());
        assertEquals(-1, decision.direction());
        assertTrue(decision.switched());
    }

    @Test
    void keepsDirectionUntilSwitchIntervalElapses() {
        KitingPlanner.Decision decision = KitingPlanner.decide(
            CombatPlanner.ThreatKind.RANGED,
            8.0D,
            3.0D,
            14.0D,
            -1,
            1_200L,
            1_000L,
            700L
        );

        assertTrue(decision.strafing());
        assertEquals(-1, decision.direction());
        assertFalse(decision.switched());
    }

    @Test
    void doesNotStrafeMeleeThreats() {
        KitingPlanner.Decision decision = KitingPlanner.decide(
            CombatPlanner.ThreatKind.MELEE,
            8.0D,
            3.0D,
            14.0D,
            1,
            2_000L,
            1_000L,
            700L
        );

        assertFalse(decision.strafing());
        assertEquals("not_ranged", decision.reason());
    }

    @Test
    void doesNotStrafeWhenAlreadyInMeleeReach() {
        KitingPlanner.Decision decision = KitingPlanner.decide(
            CombatPlanner.ThreatKind.RANGED,
            2.8D,
            3.0D,
            14.0D,
            1,
            2_000L,
            1_000L,
            700L
        );

        assertFalse(decision.strafing());
        assertEquals("in_reach", decision.reason());
    }
}
