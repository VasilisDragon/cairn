package com.mcbot.fabricclient;

import java.util.OptionalInt;

/** Pure start-placement checks for stable live campaign candidate selection. */
final class StartPlacementValidator {
    private StartPlacementValidator() {
    }

    enum Issue {
        NONE("valid_start"),
        VEGETATION_BODY_COLLISION("vegetation_body_collision"),
        BODY_OBSTRUCTED_ABOVE_SURFACE("body_obstructed_above_surface"),
        BODY_OBSTRUCTED("body_obstructed"),
        OFF_SURFACE_START("off_surface_start");

        private final String reason;

        Issue(String reason) {
            this.reason = reason;
        }

        String reason() {
            return reason;
        }
    }

    static Issue classify(
        int referenceFeetY,
        OptionalInt perceivedSurfaceY,
        boolean feetSolid,
        boolean headSolid,
        boolean feetVegetation,
        boolean headVegetation
    ) {
        boolean bodyObstructed = feetSolid || headSolid;
        if (bodyObstructed && (feetVegetation || headVegetation)) {
            return Issue.VEGETATION_BODY_COLLISION;
        }
        if (bodyObstructed && perceivedSurfaceY.isPresent() && perceivedSurfaceY.getAsInt() < referenceFeetY) {
            return Issue.BODY_OBSTRUCTED_ABOVE_SURFACE;
        }
        if (bodyObstructed) {
            return Issue.BODY_OBSTRUCTED;
        }
        if (perceivedSurfaceY.isPresent() && referenceFeetY - perceivedSurfaceY.getAsInt() > 1) {
            return Issue.OFF_SURFACE_START;
        }
        return Issue.NONE;
    }
}
