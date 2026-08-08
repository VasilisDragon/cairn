package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class GatherTreeLivenessPolicyTest {
    @Test
    void breakStanceDeadlineExpiresAtTheExactFortyFiveSecondBoundary() {
        GatherTreeLivenessPolicy.BreakStanceEpisode episode =
            GatherTreeLivenessPolicy.beginBreakStanceEpisode(10_000L);

        assertEquals(45_000L, GatherTreeLivenessPolicy.BREAK_STANCE_DEADLINE_MS);
        assertEquals(10_000L, episode.startedAtMs());
        assertEquals(55_000L, episode.deadlineAtMs());
        assertFalse(episode.expiredAt(54_999L));
        assertEquals(44_999L, episode.elapsedMs(54_999L));
        assertEquals(1L, episode.remainingMs(54_999L));
        assertTrue(episode.expiredAt(55_000L));
        assertEquals(45_000L, episode.elapsedMs(55_000L));
        assertEquals(0L, episode.remainingMs(55_000L));
        assertTrue(episode.expiredAt(55_001L));
        assertEquals(45_001L, episode.elapsedMs(55_001L));
        assertEquals(0L, episode.remainingMs(55_001L));
    }

    @Test
    void commandDeadlineExpiresAtTheExactThreeMinuteBoundary() {
        GatherTreeLivenessPolicy.CommandDeadline deadline =
            GatherTreeLivenessPolicy.fromCommandStart(20_000L);

        assertEquals(180_000L, GatherTreeLivenessPolicy.COMMAND_DEADLINE_MS);
        assertEquals(20_000L, deadline.startedAtMs());
        assertEquals(200_000L, deadline.deadlineAtMs());
        assertFalse(deadline.expiredAt(199_999L));
        assertEquals(179_999L, deadline.elapsedMs(199_999L));
        assertEquals(1L, deadline.remainingMs(199_999L));
        assertTrue(deadline.expiredAt(200_000L));
        assertEquals(180_000L, deadline.elapsedMs(200_000L));
        assertEquals(0L, deadline.remainingMs(200_000L));
        assertTrue(deadline.expiredAt(200_001L));
    }

    @Test
    void replanPreservesTheOriginalBreakStanceEpisodeByApiDesign() {
        GatherTreeLivenessPolicy.BreakStanceEpisode original =
            GatherTreeLivenessPolicy.beginBreakStanceEpisode(1_000L);
        GatherTreeLivenessPolicy.BreakStanceEpisode replanned = original.afterReplan();

        assertSame(original, replanned);
        assertEquals(1_000L, replanned.startedAtMs());
        assertEquals(46_000L, replanned.deadlineAtMs());
        assertFalse(replanned.expiredAt(45_999L));
        assertTrue(replanned.expiredAt(46_000L));
    }

    @Test
    void elapsedAndRemainingClampClockReversalAndSaturateOverflow() {
        GatherTreeLivenessPolicy.BreakStanceEpisode future =
            GatherTreeLivenessPolicy.beginBreakStanceEpisode(50_000L);

        assertEquals(0L, future.elapsedMs(49_999L));
        assertEquals(45_000L, future.remainingMs(49_999L));
        assertFalse(future.expiredAt(49_999L));

        GatherTreeLivenessPolicy.BreakStanceEpisode nearMaximum =
            GatherTreeLivenessPolicy.beginBreakStanceEpisode(Long.MAX_VALUE - 10L);
        assertEquals(Long.MAX_VALUE, nearMaximum.deadlineAtMs());
        assertEquals(10L, nearMaximum.elapsedMs(Long.MAX_VALUE));
        assertEquals(44_990L, nearMaximum.remainingMs(Long.MAX_VALUE));
        assertFalse(nearMaximum.expiredAt(Long.MAX_VALUE));

        GatherTreeLivenessPolicy.CommandDeadline fullRange =
            GatherTreeLivenessPolicy.fromCommandStart(Long.MIN_VALUE);
        assertEquals(Long.MAX_VALUE, fullRange.elapsedMs(Long.MAX_VALUE));
        assertEquals(0L, fullRange.remainingMs(Long.MAX_VALUE));
        assertTrue(fullRange.expiredAt(Long.MAX_VALUE));
    }

    @Test
    void commandChangesAndPreemptedDeadlineChecksStayExact() {
        GatherTreeLivenessPolicy.CommandDeadline deadline =
            GatherTreeLivenessPolicy.fromCommandStart(1_000L);

        assertFalse(GatherTreeLivenessPolicy.commandChanged(null, "next"));
        assertFalse(GatherTreeLivenessPolicy.commandChanged("same", "same"));
        assertTrue(GatherTreeLivenessPolicy.commandChanged("old", "next"));
        assertTrue(GatherTreeLivenessPolicy.commandChanged("old", null));

        assertFalse(GatherTreeLivenessPolicy.shouldEnforceCommandDeadline(
            false, true, "same", "same", deadline, 181_000L));
        assertFalse(GatherTreeLivenessPolicy.shouldEnforceCommandDeadline(
            true, false, "same", "same", deadline, 181_000L));
        assertFalse(GatherTreeLivenessPolicy.shouldEnforceCommandDeadline(
            true, true, "old", "next", deadline, 181_000L));
        assertFalse(GatherTreeLivenessPolicy.shouldEnforceCommandDeadline(
            true, true, "same", "same", deadline, 180_999L));
        assertTrue(GatherTreeLivenessPolicy.shouldEnforceCommandDeadline(
            true, true, "same", "same", deadline, 181_000L));
    }
}
