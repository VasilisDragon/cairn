package com.mcbot.fabricclient;

import java.util.Set;

/** Voxel perception overlay that treats planned block placements as solid without mutating the base world. */
final class PlacementOverlayPerception implements VoxelPerception {
    private final VoxelPerception base;
    private final Set<VoxelCell> placements;

    PlacementOverlayPerception(VoxelPerception base, Set<VoxelCell> placements) {
        if (base == null) {
            throw new IllegalArgumentException("base perception is required");
        }
        this.base = base;
        this.placements = Set.copyOf(placements == null ? Set.of() : placements);
    }

    Set<VoxelCell> placements() {
        return placements;
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
    public int minY() {
        return base.minY();
    }

    @Override
    public int maxY() {
        return base.maxY();
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
    public boolean isSolid(int x, int y, int z) {
        return placements.contains(new VoxelCell(x, y, z)) || base.isSolid(x, y, z);
    }

    @Override
    public boolean isHazard(int x, int y, int z) {
        return base.isHazard(x, y, z);
    }
}
