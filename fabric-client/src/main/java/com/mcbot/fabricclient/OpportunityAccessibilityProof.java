package com.mcbot.fabricclient;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.BlockView;

/**
 * Conservative, bounded proof that an observed opportunity has a safe local interaction stance.
 *
 * <p>This is not a route planner and exposes no route. It computes one bounded reversible reachability
 * envelope around the player's observed feet and answers boolean access questions from that envelope.
 */
final class OpportunityAccessibilityProof {
    static final int MAX_HORIZONTAL_DISTANCE = 16;
    static final int MAX_VERTICAL_DISTANCE = 4;
    static final int MAX_EXPANDED_CELLS = 512;
    private static final double BLOCK_INTERACTION_RANGE_SQ = 4.5D * 4.5D;
    private static final double ENTITY_APPROACH_RANGE_SQ = 3.0D * 3.0D;
    private static final List<VoxelCell> CARDINAL = List.of(
        new VoxelCell(0, 0, -1),
        new VoxelCell(1, 0, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(-1, 0, 0)
    );

    private final VoxelPerception perception;
    private final VoxelCell origin;
    private final Set<VoxelCell> reachable;
    private final int expandedCells;

    private OpportunityAccessibilityProof(
        VoxelPerception perception,
        VoxelCell origin,
        Set<VoxelCell> reachable,
        int expandedCells
    ) {
        this.perception = perception;
        this.origin = origin;
        this.reachable = Set.copyOf(reachable);
        this.expandedCells = Math.max(0, expandedCells);
    }

    static OpportunityAccessibilityProof capture(BlockView world, BlockPos observedFeet) {
        if (world == null || observedFeet == null) {
            return unavailable();
        }
        VoxelCell start = new VoxelCell(
            observedFeet.getX(), observedFeet.getY(), observedFeet.getZ());
        WorldVoxelPerception perception = new WorldVoxelPerception(
            world,
            start.x() - MAX_HORIZONTAL_DISTANCE,
            start.x() + MAX_HORIZONTAL_DISTANCE,
            start.y() - MAX_VERTICAL_DISTANCE - 1,
            start.y() + MAX_VERTICAL_DISTANCE + 2,
            start.z() - MAX_HORIZONTAL_DISTANCE,
            start.z() + MAX_HORIZONTAL_DISTANCE
        );
        return compute(perception, start);
    }

    static OpportunityAccessibilityProof compute(VoxelPerception perception, VoxelCell observedFeet) {
        if (perception == null || observedFeet == null) {
            return unavailable();
        }
        VoxelCell start = canonicalStart(perception, observedFeet);
        if (start == null) {
            return new OpportunityAccessibilityProof(perception, observedFeet, Set.of(), 0);
        }
        Set<VoxelCell> reachable = new HashSet<>();
        ArrayDeque<VoxelCell> queue = new ArrayDeque<>();
        reachable.add(start);
        queue.add(start);
        int expanded = 0;
        while (!queue.isEmpty() && expanded < MAX_EXPANDED_CELLS) {
            VoxelCell current = queue.removeFirst();
            expanded += 1;
            for (VoxelCell delta : CARDINAL) {
                VoxelAStar.Move forward = VoxelAStar.resolveTraversalMove(
                    perception, current, delta);
                VoxelCell next = forward.destination();
                if (next == null
                    || !insideEnvelope(start, next)
                    || !safeDryStance(perception, next)
                    || reachable.contains(next)) {
                    continue;
                }
                VoxelCell reverseDelta = new VoxelCell(
                    current.x() - next.x(), 0, current.z() - next.z());
                VoxelAStar.Move reverse = VoxelAStar.resolveTraversalMove(
                    perception, next, reverseDelta);
                if (!current.equals(reverse.destination())) {
                    continue;
                }
                reachable.add(next);
                queue.addLast(next);
            }
        }
        return new OpportunityAccessibilityProof(perception, start, reachable, expanded);
    }

    boolean canAccessBlock(BlockPos target) {
        if (target == null || reachable.isEmpty() || !insideTargetEnvelope(target)
            || !safeTargetEnvelope(target)) {
            return false;
        }
        for (VoxelCell stance : reachable) {
            double dx = target.getX() + 0.5D - (stance.x() + 0.5D);
            double dy = target.getY() + 0.5D - (stance.y() + 1.62D);
            double dz = target.getZ() + 0.5D - (stance.z() + 0.5D);
            if (dx * dx + dy * dy + dz * dz <= BLOCK_INTERACTION_RANGE_SQ
                && clearInteractionLine(stance, target)) {
                return true;
            }
        }
        return false;
    }

    boolean canApproachEntity(BlockPos target) {
        if (target == null || reachable.isEmpty() || !insideTargetEnvelope(target)
            || !safeTargetEnvelope(target)) {
            return false;
        }
        for (VoxelCell stance : reachable) {
            double dx = target.getX() + 0.5D - (stance.x() + 0.5D);
            double dy = target.getY() - stance.y();
            double dz = target.getZ() + 0.5D - (stance.z() + 0.5D);
            if (dx * dx + dy * dy + dz * dz <= ENTITY_APPROACH_RANGE_SQ
                && clearInteractionLine(stance, target)) {
                return true;
            }
        }
        return false;
    }

    int expandedCells() {
        return expandedCells;
    }

    int reachableCellCount() {
        return reachable.size();
    }

    private boolean clearInteractionLine(VoxelCell stance, BlockPos target) {
        double startX = stance.x() + 0.5D;
        double startY = stance.y() + 1.62D;
        double startZ = stance.z() + 0.5D;
        double endX = target.getX() + 0.5D;
        double endY = target.getY() + 0.5D;
        double endZ = target.getZ() + 0.5D;
        double distance = Math.sqrt(
            square(endX - startX) + square(endY - startY) + square(endZ - startZ));
        int samples = Math.max(1, (int) Math.ceil(distance * 4.0D));
        for (int index = 1; index < samples; index++) {
            double fraction = (double) index / samples;
            int x = (int) Math.floor(startX + (endX - startX) * fraction);
            int y = (int) Math.floor(startY + (endY - startY) * fraction);
            int z = (int) Math.floor(startZ + (endZ - startZ) * fraction);
            if (x == target.getX() && y == target.getY() && z == target.getZ()) {
                continue;
            }
            if (!perception.inBounds(x, y, z)
                || perception.isSolid(x, y, z)
                || perception.isHazard(x, y, z)
                || isLiquid(perception, x, y, z)) {
                return false;
            }
        }
        return true;
    }

    private boolean insideTargetEnvelope(BlockPos target) {
        return Math.abs(target.getX() - origin.x()) <= MAX_HORIZONTAL_DISTANCE + 4
            && Math.abs(target.getZ() - origin.z()) <= MAX_HORIZONTAL_DISTANCE + 4
            && Math.abs(target.getY() - origin.y()) <= MAX_VERTICAL_DISTANCE + 4;
    }

    private boolean safeTargetEnvelope(BlockPos target) {
        if (!perception.inBounds(target.getX(), target.getY(), target.getZ())
            || perception.isHazard(target.getX(), target.getY(), target.getZ())
            || isLiquid(perception, target.getX(), target.getY(), target.getZ())) {
            return false;
        }
        for (VoxelCell delta : CARDINAL) {
            int x = target.getX() + delta.x();
            int z = target.getZ() + delta.z();
            if (!perception.inBounds(x, target.getY(), z)
                || perception.isHazard(x, target.getY(), z)
                || isLava(perception, x, target.getY(), z)) {
                return false;
            }
        }
        return true;
    }

    private static VoxelCell canonicalStart(VoxelPerception perception, VoxelCell observed) {
        for (int deltaY : new int[] {0, 1, -1}) {
            VoxelCell candidate = new VoxelCell(observed.x(), observed.y() + deltaY, observed.z());
            if (safeDryStance(perception, candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private static boolean insideEnvelope(VoxelCell origin, VoxelCell candidate) {
        return Math.abs(candidate.x() - origin.x()) <= MAX_HORIZONTAL_DISTANCE
            && Math.abs(candidate.z() - origin.z()) <= MAX_HORIZONTAL_DISTANCE
            && Math.abs(candidate.y() - origin.y()) <= MAX_VERTICAL_DISTANCE;
    }

    private static boolean safeDryStance(VoxelPerception perception, VoxelCell cell) {
        if (cell == null || !perception.isStandable(cell.x(), cell.y(), cell.z())) {
            return false;
        }
        for (int dy = -1; dy <= 1; dy++) {
            if (isLiquid(perception, cell.x(), cell.y() + dy, cell.z())) {
                return false;
            }
        }
        for (VoxelCell delta : CARDINAL) {
            int x = cell.x() + delta.x();
            int z = cell.z() + delta.z();
            for (int dy = -1; dy <= 1; dy++) {
                int y = cell.y() + dy;
                if (!perception.inBounds(x, y, z)
                    || perception.isHazard(x, y, z)
                    || isLava(perception, x, y, z)) {
                    return false;
                }
            }
        }
        return true;
    }

    private static boolean isLiquid(VoxelPerception perception, int x, int y, int z) {
        return perception instanceof GatherWoodLocalEgressPerception liquid
            && (liquid.isWater(x, y, z) || liquid.isLava(x, y, z));
    }

    private static boolean isLava(VoxelPerception perception, int x, int y, int z) {
        return perception instanceof GatherWoodLocalEgressPerception liquid
            && liquid.isLava(x, y, z);
    }

    private static double square(double value) {
        return value * value;
    }

    private static OpportunityAccessibilityProof unavailable() {
        return new OpportunityAccessibilityProof(null, new VoxelCell(0, 0, 0), Set.of(), 0);
    }
}
