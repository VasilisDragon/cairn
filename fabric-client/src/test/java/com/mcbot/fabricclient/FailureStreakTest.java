package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class FailureStreakTest {
    @Test
    void sameKeyAccumulatesAndEscalatesAtThreshold() {
        FailureStreak streak = new FailureStreak();

        assertEquals(1, streak.record("k"));
        assertEquals(2, streak.record("k"));
        assertFalse(streak.escalated(4));
        assertEquals(3, streak.record("k"));
        assertFalse(streak.escalated(4));
        assertEquals(4, streak.record("k"));
        assertTrue(streak.escalated(4));
    }

    @Test
    void changingKeyRestartsTheStreak() {
        FailureStreak streak = new FailureStreak();

        streak.record("a");
        streak.record("a");
        streak.record("a");
        assertEquals(1, streak.record("b"));
        assertFalse(streak.escalated(3));
        assertEquals(2, streak.record("b"));
        assertEquals(3, streak.record("b"));
        assertTrue(streak.escalated(3));
    }

    @Test
    void nullKeyResetsTheStreak() {
        FailureStreak streak = new FailureStreak();

        streak.record("a");
        streak.record("a");
        assertEquals(0, streak.record(null));
        assertNull(streak.key());
        assertFalse(streak.escalated(1));
        // A fresh occurrence after the reset starts over at 1.
        assertEquals(1, streak.record("a"));
    }

    @Test
    void explicitResetClearsKeyAndCount() {
        FailureStreak streak = new FailureStreak();

        streak.record("a");
        streak.record("a");
        streak.reset();
        assertEquals(0, streak.count());
        assertNull(streak.key());
        assertFalse(streak.escalated(1));
    }
}
