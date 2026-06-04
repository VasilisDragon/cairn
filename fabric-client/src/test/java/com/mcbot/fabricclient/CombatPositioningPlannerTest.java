package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CombatPositioningPlannerTest {
    @Test
    void biasesAwayFromCrowdedLeftFlank() {
        assertEquals(
            CombatPositioningPlanner.Hint.STRAFE_RIGHT,
            CombatPositioningPlanner.decide(new CombatPositioningPlanner.SurroundingThreats(0, 2, 0, 0))
        );
    }

    @Test
    void biasesAwayFromCrowdedRightFlank() {
        assertEquals(
            CombatPositioningPlanner.Hint.STRAFE_LEFT,
            CombatPositioningPlanner.decide(new CombatPositioningPlanner.SurroundingThreats(0, 0, 2, 0))
        );
    }

    @Test
    void backsUpWhenFrontIsCrowdedAndRearIsOpen() {
        assertEquals(
            CombatPositioningPlanner.Hint.BACK_UP,
            CombatPositioningPlanner.decide(new CombatPositioningPlanner.SurroundingThreats(1, 0, 0, 0))
        );
    }
}
