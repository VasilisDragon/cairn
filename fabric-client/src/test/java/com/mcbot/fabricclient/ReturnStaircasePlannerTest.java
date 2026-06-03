package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ReturnStaircasePlannerTest {
    @Test
    void missingTargetUsesExistingCompletedReason() {
        ReturnStaircasePlanner.Decision missing = ReturnStaircasePlanner.decideTargetPresent(false);
        assertEquals(ReturnStaircasePlanner.Action.FAIL_MISSING_TARGET, missing.action());
        assertEquals("return_staircase_failed:missing_target", missing.reason());

        ReturnStaircasePlanner.Decision present = ReturnStaircasePlanner.decideTargetPresent(true);
        assertEquals(ReturnStaircasePlanner.Action.CONTINUE, present.action());
    }

    @Test
    void timeoutPrecedesHealthLoss() {
        ReturnStaircasePlanner.Decision timeout = ReturnStaircasePlanner.decidePreflight(101, 100, 20.0F, 19.0F);
        assertEquals(ReturnStaircasePlanner.Action.FAIL_TIMEOUT, timeout.action());
        assertEquals("return_staircase_timeout", timeout.reason());

        ReturnStaircasePlanner.Decision health = ReturnStaircasePlanner.decidePreflight(100, 100, 20.0F, 19.0F);
        assertEquals(ReturnStaircasePlanner.Action.FAIL_HEALTH_LOST, health.action());
        assertEquals("return_staircase_health_lost", health.reason());

        ReturnStaircasePlanner.Decision ok = ReturnStaircasePlanner.decidePreflight(100, 100, 20.0F, 20.0F);
        assertEquals(ReturnStaircasePlanner.Action.CONTINUE, ok.action());
    }

    @Test
    void surfaceReachedRequiresHorizontalAndHeightThresholds() {
        ReturnStaircasePlanner.Decision reached = ReturnStaircasePlanner.decideSurfaceReached(0.75D, 76.0D, 76);
        assertEquals(ReturnStaircasePlanner.Action.COMPLETE_SURFACE_REACHED, reached.action());
        assertEquals("return_staircase_complete:surface_reached", reached.reason());

        ReturnStaircasePlanner.Decision tooFar = ReturnStaircasePlanner.decideSurfaceReached(0.76D, 76.0D, 76);
        assertEquals(ReturnStaircasePlanner.Action.CONTINUE, tooFar.action());

        ReturnStaircasePlanner.Decision below = ReturnStaircasePlanner.decideSurfaceReached(0.75D, 75.0D, 76);
        assertEquals(ReturnStaircasePlanner.Action.CONTINUE, below.action());
    }

    @Test
    void breadcrumbPathRequiresAtLeastTwoPoints() {
        ReturnStaircasePlanner.Decision tooShort = ReturnStaircasePlanner.decideBreadcrumbPathSize(1);
        assertEquals(ReturnStaircasePlanner.Action.FAIL_BREADCRUMB_PATH_TOO_SHORT, tooShort.action());
        assertEquals("return_staircase_breadcrumb_path_too_short", tooShort.reason());

        ReturnStaircasePlanner.Decision ok = ReturnStaircasePlanner.decideBreadcrumbPathSize(2);
        assertEquals(ReturnStaircasePlanner.Action.CONTINUE, ok.action());
    }

    @Test
    void initialWaypointBacksUpOnlyWhenNearestAlreadyReached() {
        assertEquals(4, ReturnStaircasePlanner.initialWaypointIndex(5, true, 8));
        assertEquals(5, ReturnStaircasePlanner.initialWaypointIndex(5, false, 8));
        assertEquals(0, ReturnStaircasePlanner.initialWaypointIndex(0, true, 8));
        assertEquals(7, ReturnStaircasePlanner.initialWaypointIndex(99, false, 8));
    }

    @Test
    void waypointReachedReportsNextClampedIndex() {
        ReturnStaircasePlanner.Decision move = ReturnStaircasePlanner.decideWaypointReached(false, 2);
        assertEquals(ReturnStaircasePlanner.Action.CONTINUE, move.action());

        ReturnStaircasePlanner.Decision reached = ReturnStaircasePlanner.decideWaypointReached(true, 1);
        assertEquals(ReturnStaircasePlanner.Action.BREADCRUMB_REACHED, reached.action());
        assertEquals("return_staircase_breadcrumb_reached:1", reached.reason());

        ReturnStaircasePlanner.Decision clamped = ReturnStaircasePlanner.decideWaypointReached(true, -1);
        assertEquals("return_staircase_breadcrumb_reached:0", clamped.reason());
    }

    @Test
    void waypointProgressRecordsNewOrImprovedProgressBeforeStuckFailure() {
        ReturnStaircasePlanner.Decision newWaypoint = ReturnStaircasePlanner.decideWaypointProgress(
            -1,
            3,
            10.0D,
            9.0D,
            10_000L,
            1_000L
        );
        assertEquals(ReturnStaircasePlanner.Action.RECORD_BREADCRUMB_PROGRESS, newWaypoint.action());

        ReturnStaircasePlanner.Decision improved = ReturnStaircasePlanner.decideWaypointProgress(
            3,
            3,
            8.94D,
            9.0D,
            10_000L,
            1_000L
        );
        assertEquals(ReturnStaircasePlanner.Action.RECORD_BREADCRUMB_PROGRESS, improved.action());

        ReturnStaircasePlanner.Decision stuck = ReturnStaircasePlanner.decideWaypointProgress(
            3,
            3,
            8.96D,
            9.0D,
            1_001L,
            1_000L
        );
        assertEquals(ReturnStaircasePlanner.Action.FAIL_BREADCRUMB_STUCK, stuck.action());

        ReturnStaircasePlanner.Decision move = ReturnStaircasePlanner.decideWaypointProgress(
            3,
            3,
            8.96D,
            9.0D,
            1_000L,
            1_000L
        );
        assertEquals(ReturnStaircasePlanner.Action.BREADCRUMB_MOVE, move.action());
    }

    @Test
    void jumpRequiresUphillGroundedAndCloseEnough() {
        assertTrue(ReturnStaircasePlanner.shouldJumpToWaypoint(true, true, 0.25D, 1.0D));
        assertFalse(ReturnStaircasePlanner.shouldJumpToWaypoint(false, true, 0.25D, 1.0D));
        assertFalse(ReturnStaircasePlanner.shouldJumpToWaypoint(true, false, 0.25D, 1.0D));
        assertFalse(ReturnStaircasePlanner.shouldJumpToWaypoint(true, true, 1.01D, 1.0D));
    }
}
