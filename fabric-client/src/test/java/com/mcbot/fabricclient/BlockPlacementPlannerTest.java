package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import net.minecraft.util.math.Direction;
import org.junit.jupiter.api.Test;

class BlockPlacementPlannerTest {
    @Test
    void placesAgainstReachableGroundFaceWithEmptyAdjacentCell() {
        BlockPlacementPlanner.Decision decision = BlockPlacementPlanner.decide(true, true, Direction.UP, false, true, false, true);

        assertEquals(BlockPlacementPlanner.Action.PLACE_AGAINST_FACE, decision.action());
        assertEquals("raycast_ground_face", decision.reason());
    }

    @Test
    void rejectsReplaceableGrassAsAStablePlacementFace() {
        BlockPlacementPlanner.Decision decision = BlockPlacementPlanner.decide(true, true, Direction.UP, true, true, false, true);

        assertEquals(BlockPlacementPlanner.Action.NO_VALID_FACE, decision.action());
        assertEquals("raycast_replaceable_hit", decision.reason());
    }

    @Test
    void requestsClearBeforeReplacingGrassInPlacementCell() {
        BlockPlacementPlanner.Decision decision = BlockPlacementPlanner.decide(true, true, Direction.UP, false, true, true, true);

        assertEquals(BlockPlacementPlanner.Action.CLEAR_PLACEMENT_CELL, decision.action());
        assertEquals("placement_cell_replaceable_clear_first", decision.reason());
    }

    @Test
    void waitsWhenRaycastHasNoBlockHit() {
        BlockPlacementPlanner.Decision decision = BlockPlacementPlanner.decide(false, true, null, false, true, false, true);

        assertEquals(BlockPlacementPlanner.Action.WAIT, decision.action());
        assertEquals("raycast_no_block_hit", decision.reason());
    }

    @Test
    void rejectsOutOfReachHits() {
        BlockPlacementPlanner.Decision decision = BlockPlacementPlanner.decide(true, false, Direction.UP, false, true, false, true);

        assertEquals(BlockPlacementPlanner.Action.OUT_OF_REACH, decision.action());
        assertEquals("raycast_out_of_reach", decision.reason());
    }

    @Test
    void rejectsWallFacesForTheGroundPlacementPrimitive() {
        BlockPlacementPlanner.Decision decision = BlockPlacementPlanner.decide(true, true, Direction.NORTH, false, true, false, true);

        assertEquals(BlockPlacementPlanner.Action.NO_VALID_FACE, decision.action());
        assertEquals("raycast_not_ground_face", decision.reason());
    }

    @Test
    void acceptsOnlyTheExplicitHorizontalPlacementFace() {
        BlockPlacementPlanner.Decision allowed = BlockPlacementPlanner.decide(
            true, true, Direction.NORTH, false, true, false, true, Direction.NORTH
        );
        BlockPlacementPlanner.Decision wrongFace = BlockPlacementPlanner.decide(
            true, true, Direction.SOUTH, false, true, false, true, Direction.NORTH
        );
        BlockPlacementPlanner.Decision downFace = BlockPlacementPlanner.decide(
            true, true, Direction.DOWN, false, true, false, true, Direction.DOWN
        );

        assertEquals(BlockPlacementPlanner.Action.PLACE_AGAINST_FACE, allowed.action());
        assertEquals("raycast_explicit_side_face", allowed.reason());
        assertEquals(BlockPlacementPlanner.Action.NO_VALID_FACE, wrongFace.action());
        assertEquals(BlockPlacementPlanner.Action.NO_VALID_FACE, downFace.action());
    }

    @Test
    void placementSafetyChecksPrecedeTheExplicitFacePermission() {
        BlockPlacementPlanner.Decision occupied = BlockPlacementPlanner.decide(
            true, true, Direction.NORTH, false, false, false, true, Direction.NORTH
        );
        BlockPlacementPlanner.Decision outOfReach = BlockPlacementPlanner.decide(
            true, false, Direction.NORTH, false, true, false, true, Direction.NORTH
        );

        assertEquals(BlockPlacementPlanner.Action.NO_VALID_FACE, occupied.action());
        assertEquals("placement_cell_occupied", occupied.reason());
        assertEquals(BlockPlacementPlanner.Action.OUT_OF_REACH, outOfReach.action());
    }

    @Test
    void rejectsOccupiedPlacementCell() {
        BlockPlacementPlanner.Decision decision = BlockPlacementPlanner.decide(true, true, Direction.UP, false, false, false, true);

        assertEquals(BlockPlacementPlanner.Action.NO_VALID_FACE, decision.action());
        assertEquals("placement_cell_occupied", decision.reason());
    }

    @Test
    void rejectsPlacementCellOccupiedByPlayer() {
        BlockPlacementPlanner.Decision decision = BlockPlacementPlanner.decide(true, true, Direction.UP, true, true, false, false);

        assertEquals(BlockPlacementPlanner.Action.NO_VALID_FACE, decision.action());
        assertEquals("placement_cell_occupied_by_player", decision.reason());
    }

    @Test
    void requiresSneakWhenPlacementWouldInteractWithAWorkstation() {
        assertEquals(true, BlockPlacementPlanner.requiresSneakForInteractiveAdjacency(true, false));
        assertEquals(true, BlockPlacementPlanner.requiresSneakForInteractiveAdjacency(false, true));
        assertEquals(false, BlockPlacementPlanner.requiresSneakForInteractiveAdjacency(false, false));
    }
}
