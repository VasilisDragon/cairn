package com.mcbot.fabricclient;

import java.util.OptionalInt;

/**
 * Overlays the player's current grid cell with the actual feet Y observed from
 * the player pose. Live surface scanning can misread a just-cleared resource
 * cell as a much lower fallback surface; path planning should still trust the
 * cell the player is already standing in when block checks prove it is clear.
 */
final class StartAnchoredGridPerception implements GridPerception {
    private final GridPerception delegate;
    private final GridCell start;
    private final int startSurfaceY;

    private StartAnchoredGridPerception(GridPerception delegate, GridCell start, int startSurfaceY) {
        if (delegate == null) {
            throw new IllegalArgumentException("delegate is required");
        }
        if (start == null) {
            throw new IllegalArgumentException("start is required");
        }
        this.delegate = delegate;
        this.start = start;
        this.startSurfaceY = startSurfaceY;
    }

    static GridPerception anchor(GridPerception delegate, GridCell start, int startSurfaceY) {
        return new StartAnchoredGridPerception(delegate, start, startSurfaceY);
    }

    @Override
    public boolean isBlocked(int x, int z) {
        return !inBounds(x, z) || surfaceY(x, z).isEmpty();
    }

    @Override
    public OptionalInt surfaceY(int x, int z) {
        if (start.x() == x && start.z() == z) {
            return OptionalInt.of(startSurfaceY);
        }
        return delegate.surfaceY(x, z);
    }

    @Override
    public TraversalIssue traversalIssue(GridCell from, GridCell to) {
        if (from == null || to == null) {
            return TraversalIssue.INVALID_REQUEST;
        }
        if (!inBounds(to.x(), to.z())) {
            return TraversalIssue.OUT_OF_BOUNDS;
        }
        if (!isStart(from) && !isStart(to)) {
            return delegate.traversalIssue(from, to);
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

    @Override
    public int minX() {
        return delegate.minX();
    }

    @Override
    public int maxX() {
        return delegate.maxX();
    }

    @Override
    public int minZ() {
        return delegate.minZ();
    }

    @Override
    public int maxZ() {
        return delegate.maxZ();
    }

    private boolean isStart(GridCell cell) {
        return start.equals(cell);
    }
}
