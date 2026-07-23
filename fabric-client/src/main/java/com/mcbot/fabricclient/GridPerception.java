package com.mcbot.fabricclient;

import java.util.OptionalInt;

/**
 * Minecraft-independent integer grid query seam.
 *
 * <p>The live client will provide a world-backed implementation later; the hardening loop
 * sim tests use deterministic blocked-cell layouts.
 */
public interface GridPerception {
    boolean isBlocked(int x, int z);

    int minX();

    int maxX();

    int minZ();

    int maxZ();

    default boolean inBounds(int x, int z) {
        return x >= minX() && x <= maxX() && z >= minZ() && z <= maxZ();
    }

    default OptionalInt surfaceY(int x, int z) {
        return isBlocked(x, z) ? OptionalInt.empty() : OptionalInt.of(0);
    }

    default boolean canTraverse(GridCell from, GridCell to) {
        return traversalIssue(from, to) == TraversalIssue.NONE;
    }

    default TraversalIssue traversalIssue(GridCell from, GridCell to) {
        if (from == null || to == null) {
            return TraversalIssue.INVALID_REQUEST;
        }
        if (!inBounds(to.x(), to.z())) {
            return TraversalIssue.OUT_OF_BOUNDS;
        }
        OptionalInt fromSurface = surfaceY(from.x(), from.z());
        if (fromSurface.isEmpty()) {
            return TraversalIssue.FROM_BLOCKED;
        }
        OptionalInt toSurface = surfaceY(to.x(), to.z());
        if (toSurface.isEmpty()) {
            return TraversalIssue.TO_BLOCKED;
        }
        return WalkabilityClassifier.traversalIssueForSurfaceHeights(fromSurface.getAsInt(), toSurface.getAsInt());
    }
}
