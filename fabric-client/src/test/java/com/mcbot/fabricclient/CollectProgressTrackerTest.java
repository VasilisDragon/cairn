package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class CollectProgressTrackerTest {
    @Test
    void stallsSameDropWhenDistanceDoesNotImprove() {
        CollectProgressTracker tracker = new CollectProgressTracker(2_500L, 0.08D);

        assertFalse(tracker.stalled("drop-a", 1.42D, 1_000L));
        assertFalse(tracker.stalled("drop-a", 1.40D, 2_000L));

        assertTrue(tracker.stalled("drop-a", 1.39D, 3_600L));
    }

    @Test
    void distanceImprovementResetsStallWindow() {
        CollectProgressTracker tracker = new CollectProgressTracker(2_500L, 0.08D);

        assertFalse(tracker.stalled("drop-a", 1.42D, 1_000L));
        assertFalse(tracker.stalled("drop-a", 1.25D, 3_000L));

        assertFalse(tracker.stalled("drop-a", 1.24D, 4_000L));
    }

    @Test
    void newDropResetsStallWindow() {
        CollectProgressTracker tracker = new CollectProgressTracker(2_500L, 0.08D);

        assertFalse(tracker.stalled("drop-a", 1.42D, 1_000L));
        assertTrue(tracker.stalled("drop-a", 1.41D, 3_600L));

        assertFalse(tracker.stalled("drop-b", 1.41D, 3_700L));
    }
}
