package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class PlaceWorkstationPlannerTest {
    @Test
    void inventoryMissingFailsOnlyBeforePlacementVerification() {
        PlaceWorkstationPlanner.Decision missing = PlaceWorkstationPlanner.decideInventory(false, false, "place_table_no_table");
        assertEquals(PlaceWorkstationPlanner.Action.FAIL_MISSING_ITEM, missing.action());
        assertEquals("place_table_no_table", missing.reason());

        PlaceWorkstationPlanner.Decision awaiting = PlaceWorkstationPlanner.decideInventory(false, true, "place_table_no_table");
        assertEquals(PlaceWorkstationPlanner.Action.CONTINUE, awaiting.action());

        PlaceWorkstationPlanner.Decision present = PlaceWorkstationPlanner.decideInventory(true, false, "place_table_no_table");
        assertEquals(PlaceWorkstationPlanner.Action.CONTINUE, present.action());
    }

    @Test
    void openScreenFailsDuringVerificationAndClosesBeforePlacementOtherwise() {
        PlaceWorkstationPlanner.Decision none = PlaceWorkstationPlanner.decideOpenScreen(false, false, "FurnaceScreenHandler");
        assertEquals(PlaceWorkstationPlanner.Action.CONTINUE, none.action());

        PlaceWorkstationPlanner.Decision awaiting = PlaceWorkstationPlanner.decideOpenScreen(true, true, "FurnaceScreenHandler");
        assertEquals(PlaceWorkstationPlanner.Action.FAIL_UNEXPECTED_SCREEN_OPENED, awaiting.action());
        assertEquals("unexpected_screen_opened:FurnaceScreenHandler", awaiting.reason());

        PlaceWorkstationPlanner.Decision close = PlaceWorkstationPlanner.decideOpenScreen(true, false, "FurnaceScreenHandler");
        assertEquals(PlaceWorkstationPlanner.Action.CLOSE_SCREEN_BEFORE_PLACE, close.action());
        assertEquals("close_screen_before_place", close.reason());
    }

    @Test
    void supportMissingFailsOnlyBeforeVerification() {
        PlaceWorkstationPlanner.Decision missing = PlaceWorkstationPlanner.decideSupport(false, false, "place_furnace_no_adjacent_support");
        assertEquals(PlaceWorkstationPlanner.Action.FAIL_NO_ADJACENT_SUPPORT, missing.action());
        assertEquals("place_furnace_no_adjacent_support", missing.reason());

        PlaceWorkstationPlanner.Decision awaiting = PlaceWorkstationPlanner.decideSupport(true, false, "place_furnace_no_adjacent_support");
        assertEquals(PlaceWorkstationPlanner.Action.CONTINUE, awaiting.action());

        PlaceWorkstationPlanner.Decision present = PlaceWorkstationPlanner.decideSupport(false, true, "place_furnace_no_adjacent_support");
        assertEquals(PlaceWorkstationPlanner.Action.CONTINUE, present.action());
    }

    @Test
    void clearSpaceDecidesFacingBrokenFailedAndContinuingBranches() {
        PlaceWorkstationPlanner.Decision awaiting = PlaceWorkstationPlanner.decideClearSpace(
            true,
            true,
            false,
            BlockBreakController.Status.RUNNING,
            "progress"
        );
        assertEquals(PlaceWorkstationPlanner.Action.CONTINUE, awaiting.action());

        PlaceWorkstationPlanner.Decision noOccluder = PlaceWorkstationPlanner.decideClearSpace(
            false,
            false,
            false,
            BlockBreakController.Status.RUNNING,
            "progress"
        );
        assertEquals(PlaceWorkstationPlanner.Action.CONTINUE, noOccluder.action());

        PlaceWorkstationPlanner.Decision face = PlaceWorkstationPlanner.decideClearSpace(
            false,
            true,
            false,
            BlockBreakController.Status.RUNNING,
            "progress"
        );
        assertEquals(PlaceWorkstationPlanner.Action.FACE_CLEAR_SPACE, face.action());
        assertEquals("clear_replaceable_face", face.reason());

        PlaceWorkstationPlanner.Decision broken = PlaceWorkstationPlanner.decideClearSpace(
            false,
            true,
            true,
            BlockBreakController.Status.BROKEN,
            "broken"
        );
        assertEquals(PlaceWorkstationPlanner.Action.CLEAR_SPACE_BROKEN, broken.action());
        assertEquals("clear_space:broken", broken.reason());

        PlaceWorkstationPlanner.Decision failed = PlaceWorkstationPlanner.decideClearSpace(
            false,
            true,
            true,
            BlockBreakController.Status.FAILED,
            "blocked"
        );
        assertEquals(PlaceWorkstationPlanner.Action.FAIL_CLEAR_SPACE, failed.action());
        assertEquals("clear_space_failed:blocked", failed.reason());

        PlaceWorkstationPlanner.Decision clearing = PlaceWorkstationPlanner.decideClearSpace(
            false,
            true,
            true,
            BlockBreakController.Status.RUNNING,
            "progress"
        );
        assertEquals(PlaceWorkstationPlanner.Action.CLEARING_SPACE, clearing.action());
        assertEquals("clearing_space:progress", clearing.reason());
    }

    @Test
    void lookAlignmentRequestsFacingOnlyBeforeVerification() {
        PlaceWorkstationPlanner.Decision face = PlaceWorkstationPlanner.decideLookAlignment(false, false);
        assertEquals(PlaceWorkstationPlanner.Action.FACE_GROUND, face.action());
        assertEquals("face_ground", face.reason());

        PlaceWorkstationPlanner.Decision awaiting = PlaceWorkstationPlanner.decideLookAlignment(true, false);
        assertEquals(PlaceWorkstationPlanner.Action.CONTINUE, awaiting.action());

        PlaceWorkstationPlanner.Decision aligned = PlaceWorkstationPlanner.decideLookAlignment(false, true);
        assertEquals(PlaceWorkstationPlanner.Action.CONTINUE, aligned.action());
    }

    @Test
    void placementResultClassifiesPlacedFailedAndProgress() {
        PlaceWorkstationPlanner.Decision placed = PlaceWorkstationPlanner.decidePlacementResult(
            BlockPlaceController.Status.PLACED,
            "verified"
        );
        assertEquals(PlaceWorkstationPlanner.Action.PLACED, placed.action());
        assertEquals("verified", placed.reason());

        PlaceWorkstationPlanner.Decision failed = PlaceWorkstationPlanner.decidePlacementResult(
            BlockPlaceController.Status.FAILED,
            "no_valid_face"
        );
        assertEquals(PlaceWorkstationPlanner.Action.FAILED, failed.action());
        assertEquals("no_valid_face", failed.reason());

        PlaceWorkstationPlanner.Decision placing = PlaceWorkstationPlanner.decidePlacementResult(
            BlockPlaceController.Status.RUNNING,
            "waiting"
        );
        assertEquals(PlaceWorkstationPlanner.Action.PLACING, placing.action());
        assertEquals("waiting", placing.reason());
    }
}
