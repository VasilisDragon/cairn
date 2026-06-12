package com.mcbot.fabricclient;

import java.util.HashMap;
import java.util.Map;
import net.minecraft.block.BlockState;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.BlockView;

/** Live bounded 3-D voxel perception backed by the client world's current block states. */
final class WorldVoxelPerception implements VoxelPerception {
    private final BlockView world;
    private final int minX;
    private final int maxX;
    private final int minY;
    private final int maxY;
    private final int minZ;
    private final int maxZ;
    private final Map<BlockPos, BlockState> blockCache = new HashMap<>();

    WorldVoxelPerception(BlockView world, VoxelCell start, VoxelCell goal, int margin, int verticalMargin) {
        this(
            world,
            Math.min(start.x(), goal.x()) - Math.max(0, margin),
            Math.max(start.x(), goal.x()) + Math.max(0, margin),
            Math.min(start.y(), goal.y()) - Math.max(0, verticalMargin) - 1,
            Math.max(start.y(), goal.y()) + Math.max(0, verticalMargin) + 1,
            Math.min(start.z(), goal.z()) - Math.max(0, margin),
            Math.max(start.z(), goal.z()) + Math.max(0, margin)
        );
    }

    WorldVoxelPerception(BlockView world, int minX, int maxX, int minY, int maxY, int minZ, int maxZ) {
        if (world == null) {
            throw new IllegalArgumentException("world is required");
        }
        if (minX > maxX || minY > maxY || minZ > maxZ) {
            throw new IllegalArgumentException("invalid voxel bounds");
        }
        this.world = world;
        this.minX = minX;
        this.maxX = maxX;
        this.minY = minY;
        this.maxY = maxY;
        this.minZ = minZ;
        this.maxZ = maxZ;
    }

    @Override
    public int minX() {
        return minX;
    }

    @Override
    public int maxX() {
        return maxX;
    }

    @Override
    public int minY() {
        return minY;
    }

    @Override
    public int maxY() {
        return maxY;
    }

    @Override
    public int minZ() {
        return minZ;
    }

    @Override
    public int maxZ() {
        return maxZ;
    }

    @Override
    public boolean isSolid(int x, int y, int z) {
        if (!inBounds(x, y, z)) {
            return true;
        }
        BlockPos pos = new BlockPos(x, y, z);
        return !state(pos).getCollisionShape(world, pos).isEmpty();
    }

    @Override
    public boolean isHazard(int x, int y, int z) {
        if (!inBounds(x, y, z)) {
            return true;
        }
        return WorldGridPerception.isHazard(state(new BlockPos(x, y, z)));
    }

    private BlockState state(BlockPos pos) {
        BlockPos key = pos.toImmutable();
        BlockState cached = blockCache.get(key);
        if (cached != null) {
            return cached;
        }
        BlockState discovered = world.getBlockState(key);
        blockCache.put(key, discovered);
        return discovered;
    }
}
