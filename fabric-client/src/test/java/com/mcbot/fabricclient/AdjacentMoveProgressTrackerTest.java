package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class AdjacentMoveProgressTrackerTest {
    @Test
    void initializesWithoutStalling() {
        AdjacentMoveProgressTracker tracker = new AdjacentMoveProgressTracker();

        AdjacentMoveProgressTracker.Result result = tracker.update(new GridCell(1, 0), 3.0D, 0.5D, 0.5D, 100L, 2_500L, 0.05D, 0.05D);

        assertFalse(result.stalled());
        assertEquals(3.0D, result.bestDistance(), 0.000_001D);
        assertEquals(0L, result.stalledMs());
    }

    @Test
    void improvementResetsStallWindow() {
        AdjacentMoveProgressTracker tracker = new AdjacentMoveProgressTracker();

        tracker.update(new GridCell(1, 0), 3.0D, 0.5D, 0.5D, 100L, 2_500L, 0.05D, 0.05D);
        AdjacentMoveProgressTracker.Result improved = tracker.update(new GridCell(1, 0), 2.8D, 0.55D, 0.5D, 2_000L, 2_500L, 0.05D, 0.05D);
        AdjacentMoveProgressTracker.Result waiting = tracker.update(new GridCell(1, 0), 2.79D, 0.55D, 0.5D, 4_000L, 2_500L, 0.05D, 0.05D);

        assertFalse(improved.stalled());
        assertFalse(waiting.stalled());
        assertEquals(2.8D, waiting.bestDistance(), 0.000_001D);
    }

    @Test
    void stallsAfterNoImprovementThreshold() {
        AdjacentMoveProgressTracker tracker = new AdjacentMoveProgressTracker();

        tracker.update(new GridCell(1, 0), 3.0D, 0.5D, 0.5D, 100L, 2_500L, 0.05D, 0.05D);
        AdjacentMoveProgressTracker.Result result = tracker.update(new GridCell(1, 0), 2.98D, 0.5D, 0.5D, 2_700L, 2_500L, 0.05D, 0.05D);

        assertTrue(result.stalled());
        assertEquals(2_600L, result.stalledMs());
    }

    @Test
    void targetChangeResetsProgress() {
        AdjacentMoveProgressTracker tracker = new AdjacentMoveProgressTracker();

        tracker.update(new GridCell(1, 0), 3.0D, 0.5D, 0.5D, 100L, 2_500L, 0.05D, 0.05D);
        AdjacentMoveProgressTracker.Result firstTarget = tracker.update(new GridCell(1, 0), 3.0D, 0.5D, 0.5D, 2_700L, 2_500L, 0.05D, 0.05D);
        AdjacentMoveProgressTracker.Result secondTarget = tracker.update(new GridCell(0, 1), 4.0D, 0.5D, 0.5D, 2_800L, 2_500L, 0.05D, 0.05D);

        assertTrue(firstTarget.stalled());
        assertFalse(secondTarget.stalled());
        assertEquals(4.0D, secondTarget.bestDistance(), 0.000_001D);
    }

    @Test
    void movementWithoutGoalProgressPreventsStall() {
        AdjacentMoveProgressTracker tracker = new AdjacentMoveProgressTracker();

        tracker.update(new GridCell(1, 0), 3.0D, 0.5D, 0.5D, 100L, 2_500L, 0.05D, 0.05D);
        AdjacentMoveProgressTracker.Result moved = tracker.update(new GridCell(1, 0), 3.0D, 0.7D, 0.5D, 2_700L, 2_500L, 0.05D, 0.05D);

        assertFalse(moved.stalled());
        assertEquals(3.0D, moved.bestDistance(), 0.000_001D);
    }

    @Test
    void distanceOnlyStallsDespiteMovementWithoutGoalProgress() {
        AdjacentMoveProgressTracker tracker = new AdjacentMoveProgressTracker();

        tracker.updateDistanceOnly(new GridCell(1, 0), 3.0D, 100L, 2_500L, 0.05D);
        AdjacentMoveProgressTracker.Result moved = tracker.updateDistanceOnly(new GridCell(1, 0), 3.0D, 2_700L, 2_500L, 0.05D);

        assertTrue(moved.stalled());
        assertEquals(3.0D, moved.bestDistance(), 0.000_001D);
        assertEquals(2_600L, moved.stalledMs());
    }

    @Test
    void distanceOnlyImprovementResetsStallWindow() {
        AdjacentMoveProgressTracker tracker = new AdjacentMoveProgressTracker();

        tracker.updateDistanceOnly(new GridCell(1, 0), 3.0D, 100L, 2_500L, 0.05D);
        AdjacentMoveProgressTracker.Result improved = tracker.updateDistanceOnly(new GridCell(1, 0), 2.8D, 2_000L, 2_500L, 0.05D);
        AdjacentMoveProgressTracker.Result waiting = tracker.updateDistanceOnly(new GridCell(1, 0), 2.79D, 4_000L, 2_500L, 0.05D);

        assertFalse(improved.stalled());
        assertFalse(waiting.stalled());
        assertEquals(2.8D, waiting.bestDistance(), 0.000_001D);
    }
}
