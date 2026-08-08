package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class MotionGazeIntegrationSourceTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src",
        "main",
        "java",
        "com",
        "mcbot",
        "fabricclient",
        "McbotFabricClient.java"
    );

    @Test
    void twoDimensionalTravelKeepsLegacyAndRawGazeChannelsSeparate() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);

        assertTrue(source.contains("command.intent().targetYaw()"));
        assertTrue(source.contains("TravelGazePolicy.STABLE_TRAVEL_PITCH_DEG")
            || source.contains("8.0D"));
        assertTrue(source.contains("command.look().yaw()"));
        assertTrue(source.contains("command.look().pitch()"));
        assertTrue(source.contains("smoothDemand = withTravelHeading(smoothDemand, routePlan);"));
        assertTrue(source.contains("routePlan == null ? null : routePlan.demand()"));
    }

    @Test
    void allWholeRouteUsersOwnIndependentMonotonicCursors() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);

        assertTrue(source.contains("mineNearbyStoneOwnedDropGazeCursor"));
        assertTrue(source.contains("gatherTreeOwnedDropGazeCursor"));
        assertTrue(source.contains("nav3dDriveGazeCursor"));
        assertEquals(2, occurrences(source, "MotionNav3DWaypoints waypoints = motionNav3DWaypoints("));
        assertTrue(source.contains(": motionNav3DWaypoints(\n"));
        assertTrue(source.contains("? exploreFrontierMotionWaypoints(route)"));
        assertFalse(source.contains("nav3dNextWaypoint("));
        assertTrue(occurrences(source, ".cell().y() < playerFeet.y()") >= 3);
    }

    @Test
    void identicalGenericRouteRefreshPreservesGenerationAndCursor() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        int installStart = source.indexOf("private List<VoxelCell> installNav3dCollectRoute(");
        int nextMethod = source.indexOf("private ControlDecision", installStart);
        String install = source.substring(installStart, nextMethod);

        assertTrue(install.contains("if (!candidate.equals(nav3dCollectRoute))"));
        assertTrue(install.contains("nav3dCollectRouteGeneration++;"));
        assertTrue(install.contains("nav3dDriveGazeCursor.resetAll();"));
        assertTrue(install.indexOf("nav3dCollectRouteGeneration++;")
            < install.indexOf("nav3dCollectRouteDrop = drop;"));
    }

    @Test
    void precisionAndOwnedDropTargetsCarryCodeOwnedIdentity() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String placement = Files.readString(CLIENT_SOURCE.resolveSibling(
            "PlaceWorkstationExecutor.java"
        ));

        assertTrue(source.contains("lookIntentForAnglesAndTarget("));
        assertTrue(source.contains("target.getX()"));
        assertTrue(source.contains("trackingDropGazeDemand("));
        assertTrue(source.contains("\"drop:\" + entityId"));
        assertEquals(4, occurrences(placement, "lookIntentForAnglesAtBlock("));
    }

    private static int occurrences(String value, String needle) {
        int count = 0;
        int from = 0;
        while ((from = value.indexOf(needle, from)) >= 0) {
            count++;
            from += needle.length();
        }
        return count;
    }
}
