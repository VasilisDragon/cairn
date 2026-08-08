package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

final class MineNearbyIronExposureIntegrationTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java"
    );

    private static VoxelCell cell(int x) {
        return new VoxelCell(x, 14, 0);
    }

    @Test
    void forwardResynchronizationChoosesFurthestReachedCellInsideEightCellWindow() {
        List<VoxelCell> route = List.of(
            cell(0), cell(1), cell(2), cell(3), cell(4), cell(5), cell(6), cell(7), cell(8), cell(9)
        );

        assertEquals(
            9,
            McbotFabricClient.forwardIronExposureRouteIndex(route, 1, cell(9), 8)
        );
    }

    @Test
    void routeCursorNeverRegressesToAnEarlierCell() {
        List<VoxelCell> route = List.of(cell(0), cell(1), cell(2), cell(3), cell(4));

        assertEquals(
            3,
            McbotFabricClient.forwardIronExposureRouteIndex(route, 3, cell(1), 8)
        );
    }

    @Test
    void routeCursorDoesNotResynchronizeBeyondBoundedWindow() {
        List<VoxelCell> route = List.of(
            cell(0), cell(1), cell(2), cell(3), cell(4), cell(5), cell(6), cell(7), cell(8), cell(9), cell(10)
        );

        assertEquals(
            1,
            McbotFabricClient.forwardIronExposureRouteIndex(route, 1, cell(10), 8)
        );
    }

    @Test
    void laneAndConnectorMovementWaitsForWrappedYawAlignment() {
        assertTrue(McbotFabricClient.ironExposureMoveAligned(0.0D, 24.0D));
        assertFalse(McbotFabricClient.ironExposureMoveAligned(0.0D, 24.01D));
        assertTrue(McbotFabricClient.ironExposureMoveAligned(179.0D, -179.0D));
        assertFalse(McbotFabricClient.ironExposureMoveAligned(179.0D, -150.0D));
    }

    @Test
    void missionPlaneUsesExactRecordingAndSuppressesArbitraryLocalRaster() throws IOException {
        String source = Files.readString(CLIENT_SOURCE).replace("\r\n", "\n");

        assertTrue(source.contains("ironProspectAtlas.recordClearedProspectBlock(completedTarget"));
        assertTrue(source.contains("ironProspectAtlas.recordGroundedLaneCell(feet)"));
        assertFalse(source.contains("ironProspectAtlas.recordCorridor("));
        assertTrue(source.contains("if (!missionIronExposurePlaneActive(run, oreKind)) {\n"
            + "                        run.currentTarget = selectVisibleOreProspectTarget"));
    }

    @Test
    void neutralBoundaryPersistsFrozenLaneAndPreservesEpoch() throws IOException {
        String source = Files.readString(CLIENT_SOURCE).replace("\r\n", "\n");

        assertTrue(source.contains("saveIronExposureLaneContinuation(run);"));
        assertTrue(source.contains("restoreIronExposureLaneContinuation(run, player, nowMs);"));
        assertTrue(source.contains("ironProspectAtlas.registerPlan("));
        assertTrue(source.contains("|| \"same_plane_continue\".equals(reason)"));
        assertTrue(source.contains("if (!\"same_plane_continue\".equals(reason)\n"
            + "                && !\"tool_reserve_required\".equals(reason)) {\n"
            + "                ironExposureLaneContinuation = null;"));
        assertTrue(source.contains("ironProspectAtlas.resetMission();"));
    }

    @Test
    void unproductiveCommandBoundariesAreClassifiedBeforeLegacyFailureHandoff() throws IOException {
        String source = Files.readString(CLIENT_SOURCE).replace("\r\n", "\n");

        assertFalse(source.contains("canContinueMissionIronExposurePlane("));
        assertTrue(source.contains("assessMissionIronExposureContinuation(client, player, run)"));
        assertTrue(count(source, "rejectIronExposurePlane(run, continuation.reason(), nowMs);") == 2);
        assertTrue(count(source,
            "\"mine_nearby_iron_plane_exhausted:\" + continuation.reason()") == 2);
    }

    @Test
    void productivePlaneRanksLowerVerticalVeinOreBeforeCloserUpperOre() {
        BlockPos lower = new BlockPos(-511, 14, -219);
        BlockPos upper = new BlockPos(-511, 15, -219);

        assertTrue(McbotFabricClient.betterMissionIronPlaneTarget(
            lower, 6.0D, upper, 1.0D, 14));
        assertFalse(McbotFabricClient.betterMissionIronPlaneTarget(
            upper, 1.0D, lower, 6.0D, 14));
        assertTrue(McbotFabricClient.betterMissionIronPlaneTarget(
            new BlockPos(-512, 14, -219), 1.0D, lower, 2.0D, 14));
        assertTrue(McbotFabricClient.betterMissionIronPlaneTarget(
            new BlockPos(-512, 14, -220), 2.0D,
            new BlockPos(-511, 14, -220), 2.0D, 14));
        assertFalse(McbotFabricClient.betterMissionIronPlaneTarget(
            new BlockPos(-511, 12, -219), 0.5D, lower, 6.0D, 14));
        assertFalse(McbotFabricClient.betterMissionIronPlaneTarget(
            new BlockPos(-511, 13, -219), 0.5D,
            new BlockPos(-511, 15, -219), 6.0D, 14));
        assertFalse(McbotFabricClient.betterMissionIronPlaneTarget(
            new BlockPos(-511, 12, -219), 0.5D,
            new BlockPos(-511, 16, -219), 6.0D, 14));
    }

    @Test
    void ownedDropContactUsesExactEntityEnvelopeAndPreciseGazeTarget() throws IOException {
        String source = Files.readString(CLIENT_SOURCE).replace("\r\n", "\n");

        assertTrue(source.contains("player.getBoundingBox().expand(1.0D, 0.5D, 1.0D)"));
        assertTrue(source.contains("pickupEnvelope.intersects(item.getBoundingBox())"));
        assertTrue(source.contains("pickupContactApproachPending()"));
        assertTrue(source.contains("ownedDropPlaneController.pickupContactX()"));
        assertTrue(source.contains("ownedDropPlaneController.pickupContactZ()"));
    }

    @Test
    void planeSpecificOreRankingRequiresFrozenIdentityAndConnectedVeinFiltering() throws IOException {
        String source = Files.readString(CLIENT_SOURCE).replace("\r\n", "\n");

        assertTrue(source.contains("!hasFrozenMissionIronExposurePlane(run)"));
        assertTrue(source.contains("allowedTargets != null && !allowedTargets.contains(candidate)"));
        assertTrue(source.contains(
            "return selectVisibleOreTargetForRun(client, player, run, oreKind, vein);"));
        assertTrue(source.contains("missionIronTargetDropRecoverable(client, player, run, candidate)"));
        assertTrue(source.contains("IronOwnedDropPlaneController.assessRoute("));
        assertTrue(source.contains("isIronOreBlock(state) || isProspectableMiningBlock"));
        assertTrue(source.contains("run.currentTargetIron = headIron;"));
        assertTrue(source.contains("run.currentProspectCell = headIron ? null"));
        assertTrue(source.contains("run.currentTargetIron = feetIron;"));
        assertTrue(source.contains("run.currentProspectCell = feetIron ? null"));
        assertTrue(McbotFabricClient.betterMissionIronPlaneTarget(
            new BlockPos(0, 14, 0), 2.0D,
            new BlockPos(0, 15, 0), 1.0D,
            Integer.MIN_VALUE));
    }

    @Test
    void frozenPlaneIdentitySurvivesCompletedLanesButClearsOnLifecycleReset() throws IOException {
        String source = Files.readString(CLIENT_SOURCE).replace("\r\n", "\n");

        assertTrue(source.contains("freezeIronExposurePlaneIdentity(run, plan.origin(), plan.heading());"));
        assertTrue(source.contains("run.exposurePlaneFeetY != Integer.MIN_VALUE\n"
            + "            && feet.y() != run.exposurePlaneFeetY"));
        assertTrue(source.contains("run.exposurePlaneId = \"\";"));
        assertTrue(source.contains("run.exposurePlaneFeetY = Integer.MIN_VALUE;"));
        assertTrue(source.contains("run.exposurePlaneOrigin = null;"));
        assertTrue(source.contains("run.exposurePlaneRegion = null;"));
        assertTrue(source.contains("run.exposureLastLaneHeading = null;"));
    }

    private static int count(String source, String token) {
        int total = 0;
        int cursor = 0;
        while ((cursor = source.indexOf(token, cursor)) >= 0) {
            total++;
            cursor += token.length();
        }
        return total;
    }
}
