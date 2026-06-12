package com.mcbot.fabricclient;

/**
 * Minecraft-independent bounded 3-D voxel query seam.
 *
 * <p>A standable voxel is the player's feet position: solid support at {@code y - 1}, clear feet/head at
 * {@code y}/{@code y + 1}, and no hazard in the support/body column.
 */
public interface VoxelPerception {
    int minX();

    int maxX();

    int minY();

    int maxY();

    int minZ();

    int maxZ();

    boolean isSolid(int x, int y, int z);

    boolean isHazard(int x, int y, int z);

    default boolean inBounds(int x, int y, int z) {
        return x >= minX() && x <= maxX()
            && y >= minY() && y <= maxY()
            && z >= minZ() && z <= maxZ();
    }

    default boolean isStandable(int x, int y, int z) {
        if (!inBounds(x, y, z) || !inBounds(x, y - 1, z) || !inBounds(x, y + 1, z)) {
            return false;
        }
        boolean hazard = isHazard(x, y - 1, z) || isHazard(x, y, z) || isHazard(x, y + 1, z);
        return WalkabilityClassifier.isStandableSurface(
            isSolid(x, y - 1, z),
            isSolid(x, y, z),
            isSolid(x, y + 1, z),
            hazard
        );
    }
}
