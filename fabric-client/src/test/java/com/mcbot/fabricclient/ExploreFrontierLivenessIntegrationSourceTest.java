package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class ExploreFrontierLivenessIntegrationSourceTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java"
    );

    @Test
    void activeFrontierOwnsItsRouteBudgetAndTerminalRejection() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);

        assertTrue(source.contains("if ((!nearOldRoute || stale) && !activeFrontierRoute)"));
        assertTrue(source.contains("if (!frontierRoute && nowMs - nav3dRealProgressMs"));
        assertTrue(source.contains("Set.of(failedTransition)"));
        assertTrue(source.contains("? \"excluded_transition_replayed\" : failureReason"));
        assertTrue(source.contains("finishedNavigationCommandReasons.put(commandId, \"target_rejected_no_path\")"));
        assertTrue(source.contains("return new ControlDecision(stopFrom(effective, \"target_rejected_no_path\")"));
        assertFalse(source.contains("nav3dAbandonedDrops.add(failedTransition"));
    }

    @Test
    void frontierProgressRequiresGroundedWaypointsOrVerifiedBlockClearing() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);

        assertTrue(source.contains("Observation.verifiedBreak("));
        assertTrue(source.contains("boolean verifiedCleared = client.world.getBlockState(obstacle).isAir()"));
        assertTrue(source.contains("if (!frontierRoute) {\n                            nav3dRealProgressMs = nowMs"));
        assertTrue(source.contains("player.isOnGround()\n                && ExploreFrontierPlanner.reached"));
        assertTrue(source.contains("observation,\n                false"));
        assertTrue(source.contains("exploreFrontierEdgeGuardLookahead(client, player, intent)"));
        assertTrue(source.contains("exploreFrontierLivenessController.activeWaypoint()"));
        assertTrue(source.contains("frontierRoute\n                ? exploreFrontierMotionWaypoints(route)"));
        assertTrue(source.contains("waypointIndex = exploreFrontierLivenessController.waypointIndex()"));
        assertTrue(source.contains("waypoint = exploreFrontierLivenessController.activeWaypoint()"));
        assertTrue(source.contains("return new MotionNav3DWaypoints(selected, selected, legacy)"));
        assertTrue(source.contains("frontierRoute && exploreFrontierOriginalTarget != null"));
    }

    @Test
    void frontierLifecycleFailsClosedAndClearsEveryOwnedState() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);

        assertTrue(source.contains("\"motion_cursor_inactive\""));
        assertTrue(source.contains("\"frontier_control_exception\""));
        assertTrue(source.contains("exploreFrontierLivenessController.clear()"));
        assertTrue(source.contains("nav3dDigCommandId = \"\""));
        assertTrue(source.contains("blockBreakController.reset()"));
        assertTrue(source.contains("!nav3dCollectRoute.equals(exploreFrontierLivenessController.route())"));
    }
}
