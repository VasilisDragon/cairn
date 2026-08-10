package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

final class OpportunityAccessibilityProofTest {
    @Test
    void openNearbyBlockAndEntityReceiveAccessProof() {
        VoxelAStarTest.TestVoxelWorld world =
            new VoxelAStarTest.TestVoxelWorld(-4, 8, 62, 68, -4, 4);
        world.floor(-4, 8, -4, 4, 63);
        OpportunityAccessibilityProof proof = OpportunityAccessibilityProof.compute(
            world, new VoxelCell(0, 64, 0));

        assertTrue(proof.canAccessBlock(new BlockPos(4, 64, 0)));
        assertTrue(proof.canApproachEntity(new BlockPos(6, 64, 0)));
        assertTrue(proof.expandedCells() <= OpportunityAccessibilityProof.MAX_EXPANDED_CELLS);
    }

    @Test
    void sealedBedrockLikeResourceIsNotClaimedAccessible() {
        VoxelAStarTest.TestVoxelWorld world =
            new VoxelAStarTest.TestVoxelWorld(-4, 8, 62, 68, -4, 4);
        world.floor(-4, 8, -4, 4, 63);
        BlockPos target = new BlockPos(4, 64, 0);
        for (int y = 64; y <= 66; y++) {
            for (int x = 3; x <= 5; x++) {
                for (int z = -1; z <= 1; z++) {
                    if (x != target.getX() || y != target.getY() || z != target.getZ()) {
                        world.support(x, y, z);
                    }
                }
            }
        }
        world.support(target.getX(), target.getY(), target.getZ());

        OpportunityAccessibilityProof proof = OpportunityAccessibilityProof.compute(
            world, new VoxelCell(0, 64, 0));

        assertFalse(proof.canAccessBlock(target));
        assertFalse(proof.canApproachEntity(target));
    }

    @Test
    void unsafeOrOutOfEnvelopeObservationsFailClosed() {
        VoxelAStarTest.TestVoxelWorld world =
            new VoxelAStarTest.TestVoxelWorld(-20, 40, 60, 70, -20, 20);
        world.floor(-20, 40, -20, 20, 63);
        world.hazard(1, 63, 0);
        OpportunityAccessibilityProof proof = OpportunityAccessibilityProof.compute(
            world, new VoxelCell(0, 64, 0));

        assertFalse(proof.canAccessBlock(new BlockPos(40, 64, 0)));
        assertTrue(proof.reachableCellCount() <= OpportunityAccessibilityProof.MAX_EXPANDED_CELLS);
    }
}
