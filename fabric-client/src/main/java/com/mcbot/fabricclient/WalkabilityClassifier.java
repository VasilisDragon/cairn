package com.mcbot.fabricclient;

/** Pure walkability rules shared by live block sampling and offline tests. */
public final class WalkabilityClassifier {
    public static final int MAX_AUTO_STEP_UP = 1;
    public static final int MAX_AUTO_STEP_DOWN = 1;
    public static final int MAX_SAFE_DROP = 3;

    private WalkabilityClassifier() {
    }

    public static boolean isBlocked(boolean feetSolid, boolean headSolid, int supportDrop, boolean hazard) {
        return feetSolid || headSolid || hazard || supportDrop >= 2;
    }

    public static int supportDrop(boolean supportAtCurrentLevel, boolean supportOneLower) {
        if (supportAtCurrentLevel) {
            return 0;
        }
        if (supportOneLower) {
            return 1;
        }
        return 2;
    }

    public static boolean isStandableSurface(boolean floorSolid, boolean feetSolid, boolean headSolid, boolean hazard) {
        return floorSolid && !feetSolid && !headSolid && !hazard;
    }

    public static boolean canTraverseSurfaceHeights(int fromSurfaceY, int toSurfaceY) {
        return traversalIssueForSurfaceHeights(fromSurfaceY, toSurfaceY) == TraversalIssue.NONE;
    }

    public static TraversalIssue traversalIssueForSurfaceHeights(int fromSurfaceY, int toSurfaceY) {
        int delta = toSurfaceY - fromSurfaceY;
        if (delta > MAX_AUTO_STEP_UP) {
            return TraversalIssue.RISE_TOO_HIGH;
        }
        if (delta < -MAX_SAFE_DROP) {
            return TraversalIssue.DROP_TOO_FAR;
        }
        return TraversalIssue.NONE;
    }

    public static TraversalIssue traversalIssueForTransitionClearance(
        int fromSurfaceY,
        int toSurfaceY,
        boolean toFeetSolidAtFromHeight,
        boolean toHeadSolidAtFromHeight
    ) {
        TraversalIssue heightIssue = traversalIssueForSurfaceHeights(fromSurfaceY, toSurfaceY);
        if (heightIssue != TraversalIssue.NONE) {
            return heightIssue;
        }
        if (toSurfaceY <= fromSurfaceY && (toFeetSolidAtFromHeight || toHeadSolidAtFromHeight)) {
            return TraversalIssue.TO_BLOCKED;
        }
        return TraversalIssue.NONE;
    }

    public static boolean isAutoStepDelta(int fromSurfaceY, int toSurfaceY) {
        int delta = Math.abs(toSurfaceY - fromSurfaceY);
        return delta <= MAX_AUTO_STEP_UP;
    }
}
