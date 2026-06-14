package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

// The R0b·2 collect-fix gate — the validated intent-spec. All four assertions
// MUST hold: (1) positive abandon, (2) regression guard (never abandon while progressing),
// (3) normal quick collect, (4) boundary resets.
class SideCollectStallTrackerTest {
    // (1) POSITIVE: K consecutive selections for the same drop with no inventory gain and no net
    // distance improvement -> escalate (abandon) exactly at the streak limit.
    @Test
    void escalatesAfterKSelectionsWithNoProgress() {
        SideCollectStallTracker t = new SideCollectStallTracker(4, 0.08D);

        assertFalse(t.shouldEscalate("drop-a", 0, 1.50D)); // streak 1 (new drop)
        assertFalse(t.shouldEscalate("drop-a", 0, 1.49D)); // 0.01 < epsilon -> not improvement -> 2
        assertFalse(t.shouldEscalate("drop-a", 0, 1.50D)); // streak 3
        assertTrue(t.shouldEscalate("drop-a", 0, 1.50D));  // streak 4 -> escalate
    }

    // (2) REGRESSION GUARD a: a drop the bot is steadily getting closer to is NEVER abandoned, even
    // well past K (every selection improves distance > epsilon -> resets the streak).
    @Test
    void steadyDistanceImprovementNeverEscalates() {
        SideCollectStallTracker t = new SideCollectStallTracker(4, 0.08D);

        assertFalse(t.shouldEscalate("drop-a", 0, 2.00D));
        assertFalse(t.shouldEscalate("drop-a", 0, 1.80D));
        assertFalse(t.shouldEscalate("drop-a", 0, 1.60D));
        assertFalse(t.shouldEscalate("drop-a", 0, 1.40D));
        assertFalse(t.shouldEscalate("drop-a", 0, 1.20D));
        assertFalse(t.shouldEscalate("drop-a", 0, 1.00D)); // 6 selections, never escalates
        assertEquals(0, t.streak());
    }

    // (2) REGRESSION GUARD b: a pickup (inventory log count rises) resets the streak; escalation only
    // resumes if a fresh no-progress run follows.
    @Test
    void inventoryGainResetsAndPreventsEscalation() {
        SideCollectStallTracker t = new SideCollectStallTracker(4, 0.08D);

        assertFalse(t.shouldEscalate("drop-a", 0, 1.50D)); // streak 1
        assertFalse(t.shouldEscalate("drop-a", 0, 1.50D)); // streak 2
        assertFalse(t.shouldEscalate("drop-a", 1, 1.50D)); // +1 log -> reset
        assertFalse(t.shouldEscalate("drop-a", 1, 1.50D)); // streak 1
        assertFalse(t.shouldEscalate("drop-a", 1, 1.50D)); // streak 2
        assertFalse(t.shouldEscalate("drop-a", 1, 1.50D)); // streak 3
        assertTrue(t.shouldEscalate("drop-a", 1, 1.50D));  // streak 4 -> escalate
    }

    // (3) NORMAL: a couple of approach selections then a pickup never nears the limit.
    @Test
    void normalQuickCollectNeverNearsEscalation() {
        SideCollectStallTracker t = new SideCollectStallTracker(4, 0.08D);

        assertFalse(t.shouldEscalate("drop-a", 0, 1.50D)); // streak 1
        assertFalse(t.shouldEscalate("drop-a", 0, 1.30D)); // closer -> reset
        assertFalse(t.shouldEscalate("drop-a", 1, 1.10D)); // picked up + closer -> reset
        assertEquals(0, t.streak());
    }

    // (4) BOUNDARIES: a new drop key restarts the streak; reset() clears it.
    @Test
    void newDropAndResetRestartTheStreak() {
        SideCollectStallTracker t = new SideCollectStallTracker(4, 0.08D);

        assertFalse(t.shouldEscalate("drop-a", 0, 1.50D));
        assertFalse(t.shouldEscalate("drop-a", 0, 1.50D));
        assertFalse(t.shouldEscalate("drop-a", 0, 1.50D)); // streak 3 on drop-a
        assertFalse(t.shouldEscalate("drop-b", 0, 1.50D)); // NEW drop -> streak 1
        assertFalse(t.shouldEscalate("drop-b", 0, 1.50D));
        assertFalse(t.shouldEscalate("drop-b", 0, 1.50D));
        assertTrue(t.shouldEscalate("drop-b", 0, 1.50D));  // streak 4 on drop-b -> escalate

        t.reset();
        assertEquals(0, t.streak());
        assertFalse(t.shouldEscalate("drop-b", 0, 1.50D)); // fresh streak 1 after reset
    }
}
