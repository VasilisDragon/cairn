package com.mcbot.fabricclient;

import java.util.OptionalInt;
import java.util.Set;

/**
 * Veto-feedback seam (live runs showed a repeated standoff as the dominant failure): cells the global
 * edge-guard refused to walk into are overlaid as BLOCKED on route perception, so recomputation
 * paths around the edge — and where no route exists, the existing
 * target_rejected_no_path / abandon flows fire. The guard stops being anonymous.
 *
 * <p>Pure decorator, Minecraft-independent, unit-testable. Only the destination cell is veto-
 * checked in traversal: the bot may legitimately be STANDING in a vetoed cell (the veto refused
 * walking out of it over an edge), and blocking {@code from} would wedge every route.
 */
final class VetoAwareGridPerception implements GridPerception {
    private final GridPerception base;
    private final Set<GridCell> vetoed;

    VetoAwareGridPerception(GridPerception base, Set<GridCell> vetoed) {
        this.base = base;
        this.vetoed = vetoed == null ? Set.of() : vetoed;
    }

    @Override
    public boolean isBlocked(int x, int z) {
        return vetoed.contains(new GridCell(x, z)) || base.isBlocked(x, z);
    }

    @Override
    public int minX() {
        return base.minX();
    }

    @Override
    public int maxX() {
        return base.maxX();
    }

    @Override
    public int minZ() {
        return base.minZ();
    }

    @Override
    public int maxZ() {
        return base.maxZ();
    }

    @Override
    public OptionalInt surfaceY(int x, int z) {
        return vetoed.contains(new GridCell(x, z)) ? OptionalInt.empty() : base.surfaceY(x, z);
    }

    @Override
    public TraversalIssue traversalIssue(GridCell from, GridCell to) {
        if (to != null && vetoed.contains(to)) {
            return TraversalIssue.TO_BLOCKED;
        }
        return base.traversalIssue(from, to);
    }
}
