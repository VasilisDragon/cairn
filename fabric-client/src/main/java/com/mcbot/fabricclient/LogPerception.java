package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import net.minecraft.block.BlockState;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.BlockView;

final class LogPerception {
    private static final int REACHABILITY_MARGIN = 8;
    private static final double HAND_REACH_BLOCKS = 4.6D;
    private static final double EYE_HEIGHT_ESTIMATE = 1.62D;

    private LogPerception() {
    }

    static List<LogTarget> nearbyLogs(
        BlockView world,
        ClientPlayerEntity player,
        int horizontalRadius,
        int scanDown,
        int scanUp,
        int limit
    ) {
        if (world == null || player == null || horizontalRadius < 0 || limit <= 0) {
            return List.of();
        }
        int baseX = (int) Math.floor(player.getX());
        int baseY = (int) Math.floor(player.getY());
        int baseZ = (int) Math.floor(player.getZ());
        int radius = Math.max(0, horizontalRadius);
        int minY = baseY - Math.max(0, scanDown);
        int maxY = baseY + Math.max(0, scanUp);
        List<LogTarget> targets = new ArrayList<>();
        for (int x = baseX - radius; x <= baseX + radius; x++) {
            for (int y = minY; y <= maxY; y++) {
                for (int z = baseZ - radius; z <= baseZ + radius; z++) {
                    BlockPos pos = new BlockPos(x, y, z);
                    BlockState state = world.getBlockState(pos);
                    if (!state.isIn(BlockTags.LOGS)) {
                        continue;
                    }
                    double distance = Math.sqrt(
                        square((x + 0.5D) - player.getX())
                            + square((y + 0.5D) - player.getEyeY())
                            + square((z + 0.5D) - player.getZ())
                    );
                    targets.add(new LogTarget(Registries.BLOCK.getId(state.getBlock()).getPath(), x, y, z, distance));
                }
            }
        }
        targets.sort(Comparator
            .comparingDouble(LogTarget::distance)
            .thenComparingInt(LogTarget::y)
            .thenComparingInt(LogTarget::x)
            .thenComparingInt(LogTarget::z));
        if (targets.size() <= limit) {
            return List.copyOf(targets);
        }
        return List.copyOf(targets.subList(0, limit));
    }

    static List<LogTarget> nearbyReachableLogs(
        BlockView world,
        ClientPlayerEntity player,
        int horizontalRadius,
        int scanDown,
        int scanUp,
        int limit
    ) {
        List<LogTarget> raw = nearbyLogs(world, player, horizontalRadius, scanDown, scanUp, Math.max(limit * 4, limit));
        if (raw.isEmpty()) {
            return List.of();
        }
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        int referenceFeetY = (int) Math.floor(player.getY());
        List<LogTarget> reachable = new ArrayList<>();
        for (LogTarget target : raw) {
            WorldGridPerception perception = new WorldGridPerception(
                world,
                referenceFeetY,
                Math.min(start.x(), target.x()) - REACHABILITY_MARGIN,
                Math.max(start.x(), target.x()) + REACHABILITY_MARGIN,
                Math.min(start.z(), target.z()) - REACHABILITY_MARGIN,
                Math.max(start.z(), target.z()) + REACHABILITY_MARGIN
            );
            GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseAdjacent(perception, start, target.x(), target.z());
            if (plan.cell() == null) {
                continue;
            }
            var adjacentSurface = perception.surfaceY(plan.cell().x(), plan.cell().z());
            if (adjacentSurface.isEmpty() || !handReachable(plan.cell(), adjacentSurface.getAsInt(), target)) {
                continue;
            }
            reachable.add(target);
            if (reachable.size() >= limit) {
                break;
            }
        }
        return List.copyOf(reachable);
    }

    private static boolean handReachable(GridCell adjacent, int adjacentFeetY, LogTarget target) {
        double eyeX = adjacent.x() + 0.5D;
        double eyeY = adjacentFeetY + EYE_HEIGHT_ESTIMATE;
        double eyeZ = adjacent.z() + 0.5D;
        double targetX = target.x() + 0.5D;
        double targetY = target.y() + 0.5D;
        double targetZ = target.z() + 0.5D;
        double distanceSquared = square(targetX - eyeX) + square(targetY - eyeY) + square(targetZ - eyeZ);
        return distanceSquared <= HAND_REACH_BLOCKS * HAND_REACH_BLOCKS;
    }

    private static double square(double value) {
        return value * value;
    }
}
