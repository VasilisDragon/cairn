package com.mcbot.fabricclient;

interface GatherWoodLocalEgressPerception extends VoxelPerception {
    boolean isWater(int x, int y, int z);

    boolean isLava(int x, int y, int z);

    /**
     * Whether a support cell has a canonical full-block top surface.
     *
     * <p>Most pure test perceptions model only full voxels, so solidity is the conservative
     * compatibility default. Live world perception overrides this to reject beds, slabs, and
     * other partial-height supports whose physical standing height cannot be represented by the
     * route motor's integer feet cell.</p>
     */
    default boolean isFullHeightSupport(int x, int y, int z) {
        return isSolid(x, y, z);
    }
}
