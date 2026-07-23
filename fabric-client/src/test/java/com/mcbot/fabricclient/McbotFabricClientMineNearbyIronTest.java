package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class McbotFabricClientMineNearbyIronTest {

    @Test
    void connectedOreCellsFollowsTwentySixNeighborhoodThroughOre() {
        Set<BlockPos> ore = Set.of(
            new BlockPos(1, 10, 0),
            new BlockPos(2, 11, 1),
            new BlockPos(3, 11, 1)
        );
        Set<BlockPos> found = McbotFabricClient.connectedOreCells(
            Set.of(new BlockPos(0, 10, 0)),
            ore::contains,
            32
        );
        assertEquals(ore, found, "diagonal steps chain the vein: seed->1,10,0->2,11,1->3,11,1");
    }

    @Test
    void connectedOreCellsIgnoresDisconnectedVeins() {
        Set<BlockPos> ore = Set.of(
            new BlockPos(1, 10, 0),
            new BlockPos(5, 10, 0)
        );
        Set<BlockPos> found = McbotFabricClient.connectedOreCells(
            Set.of(new BlockPos(0, 10, 0)),
            ore::contains,
            32
        );
        assertTrue(found.contains(new BlockPos(1, 10, 0)));
        assertFalse(found.contains(new BlockPos(5, 10, 0)),
            "an ore cell with a >1 gap is a different vein and must not extend the rider");
    }

    @Test
    void connectedOreCellsHonorsBudgetAndEmptyInputs() {
        Predicate<BlockPos> everythingIsOre = cell -> true;
        Set<BlockPos> capped = McbotFabricClient.connectedOreCells(
            Set.of(new BlockPos(0, 0, 0)),
            everythingIsOre,
            5
        );
        assertEquals(5, capped.size());

        assertTrue(McbotFabricClient.connectedOreCells(Set.of(), everythingIsOre, 5).isEmpty());
        assertTrue(McbotFabricClient.connectedOreCells(null, everythingIsOre, 5).isEmpty());
        assertTrue(McbotFabricClient.connectedOreCells(Set.of(new BlockPos(0, 0, 0)), null, 5).isEmpty());
        assertTrue(McbotFabricClient.connectedOreCells(Set.of(new BlockPos(0, 0, 0)), everythingIsOre, 0).isEmpty());
    }
}
