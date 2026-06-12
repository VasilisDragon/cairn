package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Set;
import org.junit.jupiter.api.Test;

class PlacementOverlayPerceptionTest {
    @Test
    void overlayReportsPlacementsAsSolidWithoutMutatingBase() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 2, 63, 66, 0, 0);
        world.support(0, 63, 0);
        VoxelCell placed = new VoxelCell(1, 63, 0);

        PlacementOverlayPerception overlay = new PlacementOverlayPerception(world, Set.of(placed));

        assertFalse(world.isSolid(placed.x(), placed.y(), placed.z()));
        assertTrue(overlay.isSolid(placed.x(), placed.y(), placed.z()));
        assertTrue(overlay.isStandable(1, 64, 0), "placement creates standable support");
        assertFalse(world.isStandable(1, 64, 0), "base perception remains unchanged");
    }

    @Test
    void overlayPreservesBoundsAndHazardsFromBase() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 2, 63, 66, 0, 0);
        world.hazard(1, 63, 0);
        PlacementOverlayPerception overlay = new PlacementOverlayPerception(world, Set.of(new VoxelCell(1, 63, 0)));

        assertEquals(world.minX(), overlay.minX());
        assertEquals(world.maxX(), overlay.maxX());
        assertEquals(world.minY(), overlay.minY());
        assertEquals(world.maxY(), overlay.maxY());
        assertEquals(world.minZ(), overlay.minZ());
        assertEquals(world.maxZ(), overlay.maxZ());
        assertTrue(overlay.isHazard(1, 63, 0));
        assertFalse(overlay.isStandable(1, 64, 0), "hazard remains a hard rejection even if overlaid solid");
    }

    @Test
    void capabilityRejectsInvalidBudgets() {
        assertEquals(0, new AgentBuildCapability(0).blockBudget());
        assertEquals(16, new AgentBuildCapability(AgentBuildCapability.MAX_BLOCK_BUDGET).blockBudget());
        assertThrows(IllegalArgumentException.class, () -> new AgentBuildCapability(-1));
        assertThrows(
            IllegalArgumentException.class,
            () -> new AgentBuildCapability(AgentBuildCapability.MAX_BLOCK_BUDGET + 1)
        );
    }
}
