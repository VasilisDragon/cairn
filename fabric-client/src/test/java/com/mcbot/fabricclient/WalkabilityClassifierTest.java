package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class WalkabilityClassifierTest {
    @Test
    void solidFeetOrHeadBlocksTheCell() {
        assertTrue(WalkabilityClassifier.isBlocked(true, false, 0, false));
        assertTrue(WalkabilityClassifier.isBlocked(false, true, 0, false));
    }

    @Test
    void hazardsBlockEvenWhenSpaceIsOpen() {
        assertTrue(WalkabilityClassifier.isBlocked(false, false, 0, true));
    }

    @Test
    void oneBlockDropIsWalkableButTwoPlusDropIsBlocked() {
        assertFalse(WalkabilityClassifier.isBlocked(false, false, 0, false));
        assertFalse(WalkabilityClassifier.isBlocked(false, false, 1, false));
        assertTrue(WalkabilityClassifier.isBlocked(false, false, 2, false));
    }

    @Test
    void supportDropMapsCurrentAndOneLowerSupport() {
        assertEquals(0, WalkabilityClassifier.supportDrop(true, false));
        assertEquals(1, WalkabilityClassifier.supportDrop(false, true));
        assertEquals(2, WalkabilityClassifier.supportDrop(false, false));
    }

    @Test
    void standableSurfaceRequiresFloorClearanceAndNoHazard() {
        assertTrue(WalkabilityClassifier.isStandableSurface(true, false, false, false));
        assertFalse(WalkabilityClassifier.isStandableSurface(false, false, false, false));
        assertFalse(WalkabilityClassifier.isStandableSurface(true, true, false, false));
        assertFalse(WalkabilityClassifier.isStandableSurface(true, false, true, false));
        assertFalse(WalkabilityClassifier.isStandableSurface(true, false, false, true));
    }

    @Test
    void surfaceHeightTraversalAllowsAutoStepAndSafeDropsOnly() {
        assertTrue(WalkabilityClassifier.canTraverseSurfaceHeights(64, 64));
        assertTrue(WalkabilityClassifier.canTraverseSurfaceHeights(64, 65));
        assertTrue(WalkabilityClassifier.canTraverseSurfaceHeights(65, 64));
        assertFalse(WalkabilityClassifier.canTraverseSurfaceHeights(64, 66), "two-block rise needs jump logic");
        assertTrue(WalkabilityClassifier.canTraverseSurfaceHeights(66, 63), "bounded safe drop is allowed");
        assertFalse(WalkabilityClassifier.canTraverseSurfaceHeights(67, 63), "larger falls are not safe drops");
        assertEquals(TraversalIssue.RISE_TOO_HIGH, WalkabilityClassifier.traversalIssueForSurfaceHeights(64, 66));
        assertEquals(TraversalIssue.DROP_TOO_FAR, WalkabilityClassifier.traversalIssueForSurfaceHeights(67, 63));
    }

    @Test
    void transitionClearanceBlocksSameOrDropMovesThroughCurrentHeightCollision() {
        assertEquals(
            TraversalIssue.TO_BLOCKED,
            WalkabilityClassifier.traversalIssueForTransitionClearance(143, 142, false, true)
        );
        assertEquals(
            TraversalIssue.TO_BLOCKED,
            WalkabilityClassifier.traversalIssueForTransitionClearance(143, 143, true, false)
        );
        assertEquals(
            TraversalIssue.NONE,
            WalkabilityClassifier.traversalIssueForTransitionClearance(143, 144, true, false),
            "one-block step-up is allowed to have a block at the lower feet level"
        );
    }
}
