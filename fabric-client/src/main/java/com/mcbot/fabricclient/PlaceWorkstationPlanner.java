package com.mcbot.fabricclient;

final class PlaceWorkstationPlanner {
    private PlaceWorkstationPlanner() {
    }

    enum Action {
        CONTINUE,
        FAIL_MISSING_ITEM,
        FAIL_UNEXPECTED_SCREEN_OPENED,
        CLOSE_SCREEN_BEFORE_PLACE,
        FAIL_NO_ADJACENT_SUPPORT,
        FACE_CLEAR_SPACE,
        CLEAR_SPACE_BROKEN,
        FAIL_CLEAR_SPACE,
        CLEARING_SPACE,
        FACE_GROUND,
        PLACED,
        FAILED,
        PLACING
    }

    record Decision(Action action, String reason) {
    }

    static Decision decideInventory(boolean hasItem, boolean awaitingPlacementVerification, String missingReason) {
        if (!hasItem && !awaitingPlacementVerification) {
            return new Decision(Action.FAIL_MISSING_ITEM, safe(missingReason));
        }
        return new Decision(Action.CONTINUE, "");
    }

    static Decision decideOpenScreen(boolean screenHandlerOpen, boolean awaitingPlacementVerification, String handlerName) {
        if (!screenHandlerOpen) {
            return new Decision(Action.CONTINUE, "");
        }
        if (awaitingPlacementVerification) {
            return new Decision(Action.FAIL_UNEXPECTED_SCREEN_OPENED, "unexpected_screen_opened:" + safe(handlerName));
        }
        return new Decision(Action.CLOSE_SCREEN_BEFORE_PLACE, "close_screen_before_place");
    }

    static Decision decideSupport(boolean awaitingPlacementVerification, boolean supportPresent, String missingSupportReason) {
        if (!awaitingPlacementVerification && !supportPresent) {
            return new Decision(Action.FAIL_NO_ADJACENT_SUPPORT, safe(missingSupportReason));
        }
        return new Decision(Action.CONTINUE, "");
    }

    static Decision decideClearSpace(
        boolean awaitingPlacementVerification,
        boolean replaceableOccluder,
        boolean lookingAtPlacementCell,
        BlockBreakController.Status clearStatus,
        String clearReason
    ) {
        if (awaitingPlacementVerification || !replaceableOccluder) {
            return new Decision(Action.CONTINUE, "");
        }
        if (!lookingAtPlacementCell) {
            return new Decision(Action.FACE_CLEAR_SPACE, "clear_replaceable_face");
        }
        if (clearStatus == BlockBreakController.Status.BROKEN) {
            return new Decision(Action.CLEAR_SPACE_BROKEN, "clear_space:" + safe(clearReason));
        }
        if (clearStatus == BlockBreakController.Status.FAILED) {
            return new Decision(Action.FAIL_CLEAR_SPACE, "clear_space_failed:" + safe(clearReason));
        }
        return new Decision(Action.CLEARING_SPACE, "clearing_space:" + safe(clearReason));
    }

    static Decision decideLookAlignment(boolean awaitingPlacementVerification, boolean aligned) {
        if (!awaitingPlacementVerification && !aligned) {
            return new Decision(Action.FACE_GROUND, "face_ground");
        }
        return new Decision(Action.CONTINUE, "");
    }

    static Decision decidePlacementResult(BlockPlaceController.Status status, String placementReason) {
        if (status == BlockPlaceController.Status.PLACED) {
            return new Decision(Action.PLACED, safe(placementReason));
        }
        if (status == BlockPlaceController.Status.FAILED) {
            return new Decision(Action.FAILED, safe(placementReason));
        }
        return new Decision(Action.PLACING, safe(placementReason));
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
