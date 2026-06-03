package com.mcbot.fabricclient;

import net.minecraft.util.math.Direction;

final class BlockPlacementPlanner {
    private BlockPlacementPlanner() {
    }

    enum Action {
        PLACE_AGAINST_FACE,
        CLEAR_PLACEMENT_CELL,
        WAIT,
        NO_VALID_FACE,
        OUT_OF_REACH
    }

    record Decision(Action action, String reason) {
    }

    static boolean requiresSneakForInteractiveAdjacency(boolean hitBlockInteractive, boolean placementCellAdjacentInteractive) {
        return hitBlockInteractive || placementCellAdjacentInteractive;
    }

    static Decision decide(
        boolean blockHit,
        boolean withinReach,
        Direction hitSide,
        boolean replaceableHit,
        boolean placementCellOpen,
        boolean placementCellReplaceable,
        boolean placementCellClearOfPlayer
    ) {
        if (!blockHit) {
            return new Decision(Action.WAIT, "raycast_no_block_hit");
        }
        if (!withinReach) {
            return new Decision(Action.OUT_OF_REACH, "raycast_out_of_reach");
        }
        if (!placementCellClearOfPlayer) {
            return new Decision(Action.NO_VALID_FACE, "placement_cell_occupied_by_player");
        }
        if (!placementCellOpen) {
            return new Decision(Action.NO_VALID_FACE, "placement_cell_occupied");
        }
        if (placementCellReplaceable) {
            return new Decision(Action.CLEAR_PLACEMENT_CELL, "placement_cell_replaceable_clear_first");
        }
        if (replaceableHit) {
            return new Decision(Action.NO_VALID_FACE, "raycast_replaceable_hit");
        }
        if (hitSide != Direction.UP) {
            return new Decision(Action.NO_VALID_FACE, "raycast_not_ground_face");
        }
        return new Decision(Action.PLACE_AGAINST_FACE, "raycast_ground_face");
    }
}
