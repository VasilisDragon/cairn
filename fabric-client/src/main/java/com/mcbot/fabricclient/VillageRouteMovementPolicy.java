package com.mcbot.fabricclient;

/** Pure village-route movement projection layered over the committed voxel motor. */
final class VillageRouteMovementPolicy {
    record Output(boolean forward, boolean jump, boolean sprintRequested,
                  boolean landingColumnCaptured) {
    }

    private VillageRouteMovementPolicy() {
    }

    static Output apply(
        MiningWorkspaceSiteTraversalController.Step step,
        VoxelCell feet
    ) {
        if (step == null) {
            return new Output(false, false, false, false);
        }
        VoxelCell waypoint = step.waypoint();
        boolean landingColumnCaptured = step.descentExempt()
            && feet != null
            && waypoint != null
            && feet.x() == waypoint.x()
            && feet.z() == waypoint.z();
        boolean forward = step.forward() && !landingColumnCaptured;
        return new Output(
            forward,
            step.jump(),
            // Village routes predate routed-locomotion sprint envelopes. Preserve their exact
            // no-sprint pass-through behavior until a later chunk provides validated straight/
            // wide-turn lookahead instead of flickering sprint at every one-cell waypoint.
            false,
            landingColumnCaptured
        );
    }
}
