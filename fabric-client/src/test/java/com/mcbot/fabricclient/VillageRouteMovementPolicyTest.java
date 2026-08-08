package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class VillageRouteMovementPolicyTest {
    @Test
    void villageRoutePassThroughNeverInventsSprint() {
        VoxelCell origin = new VoxelCell(0, 1, 0);
        VoxelCell level = new VoxelCell(1, 1, 0);
        VillageRouteMovementPolicy.Output levelOutput = VillageRouteMovementPolicy.apply(
            step(level, true, false, false,
                MiningWorkspaceSiteTraversalController.StepUpPhase.NONE,
                MiningWorkspaceSiteTraversalController.DescentPhase.NONE),
            origin);
        assertTrue(levelOutput.forward());
        assertFalse(levelOutput.sprintRequested());

        VillageRouteMovementPolicy.Output stepUp = VillageRouteMovementPolicy.apply(
            step(level, true, true, false,
                MiningWorkspaceSiteTraversalController.StepUpPhase.PULSING,
                MiningWorkspaceSiteTraversalController.DescentPhase.NONE),
            origin);
        assertTrue(stepUp.forward());
        assertFalse(stepUp.sprintRequested());

        VillageRouteMovementPolicy.Output descent = VillageRouteMovementPolicy.apply(
            step(level, true, false, true,
                MiningWorkspaceSiteTraversalController.StepUpPhase.NONE,
                MiningWorkspaceSiteTraversalController.DescentPhase.AIRBORNE),
            origin);
        assertTrue(descent.forward());
        assertFalse(descent.sprintRequested());
    }

    @Test
    void capturedLandingColumnNeutralizesHorizontalMomentum() {
        VoxelCell landing = new VoxelCell(1, 0, 0);
        VillageRouteMovementPolicy.Output output = VillageRouteMovementPolicy.apply(
            step(landing, true, false, true,
                MiningWorkspaceSiteTraversalController.StepUpPhase.NONE,
                MiningWorkspaceSiteTraversalController.DescentPhase.AIRBORNE),
            new VoxelCell(1, 1, 0));
        assertTrue(output.landingColumnCaptured());
        assertFalse(output.forward());
        assertFalse(output.sprintRequested());
    }

    private static MiningWorkspaceSiteTraversalController.Step step(
        VoxelCell waypoint,
        boolean forward,
        boolean jump,
        boolean descentExempt,
        MiningWorkspaceSiteTraversalController.StepUpPhase stepUpPhase,
        MiningWorkspaceSiteTraversalController.DescentPhase descentPhase
    ) {
        return new MiningWorkspaceSiteTraversalController.Step(
            MiningWorkspaceSiteTraversalController.Outcome.DRIVE,
            waypoint,
            forward,
            jump,
            false,
            descentExempt,
            "test",
            0L,
            1_000L,
            1,
            1,
            new VoxelCell(0, 1, 0),
            0,
            0L,
            stepUpPhase,
            descentPhase,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false
        );
    }
}
