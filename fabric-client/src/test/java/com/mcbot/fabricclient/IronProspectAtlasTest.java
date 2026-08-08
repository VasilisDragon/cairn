package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class IronProspectAtlasTest {
    private static final StaircaseDescentPlanner.Direction2d NORTH = new StaircaseDescentPlanner.Direction2d(0, -1, "north");
    private static final StaircaseDescentPlanner.Direction2d EAST = new StaircaseDescentPlanner.Direction2d(1, 0, "east");
    private static final StaircaseDescentPlanner.Direction2d SOUTH = new StaircaseDescentPlanner.Direction2d(0, 1, "south");
    private static final StaircaseDescentPlanner.Direction2d WEST = new StaircaseDescentPlanner.Direction2d(-1, 0, "west");
    private static final List<StaircaseDescentPlanner.Direction2d> CARDINALS = List.of(NORTH, EAST, SOUTH, WEST);

    @Test
    void recordsOnlyExactFacesOfAVerifiedClearedBlock() {
        IronProspectAtlas atlas = new IronProspectAtlas();
        atlas.recordClearedProspectBlock(10, 14, 20);

        assertEquals(6, atlas.rememberedCells());
        assertTrue(atlas.contains(new IronProspectAtlas.InspectedCell(11, 14, 20)));
        assertTrue(atlas.contains(new IronProspectAtlas.InspectedCell(10, 15, 20)));
        assertFalse(atlas.contains(new IronProspectAtlas.InspectedCell(12, 14, 20)));
        assertFalse(atlas.contains(new IronProspectAtlas.InspectedCell(11, 14, 21)));
    }

    @Test
    void groundedTwoHighStanceRecordsItsExactExteriorShell() {
        IronProspectAtlas atlas = new IronProspectAtlas();
        atlas.recordGroundedLaneCell(0, 14, 0);

        assertEquals(10, atlas.rememberedCells());
        assertFalse(atlas.contains(new IronProspectAtlas.InspectedCell(0, 15, 0)));
        assertTrue(atlas.contains(new IronProspectAtlas.InspectedCell(0, 13, 0)));
        assertTrue(atlas.contains(new IronProspectAtlas.InspectedCell(0, 16, 0)));
        assertTrue(atlas.contains(new IronProspectAtlas.InspectedCell(1, 15, 0)));
    }

    @Test
    void projectedLaneShellIsExactAndDoesNotInferPlusOrMinusTwoWalls() {
        Set<IronProspectAtlas.InspectedCell> shell = IronProspectAtlas.exposureShellForLane(
            new VoxelCell(0, 14, 0),
            SOUTH,
            12
        );

        assertEquals(74, shell.size());
        assertTrue(shell.contains(new IronProspectAtlas.InspectedCell(1, 14, 6)));
        assertTrue(shell.contains(new IronProspectAtlas.InspectedCell(0, 13, 6)));
        assertFalse(shell.contains(new IronProspectAtlas.InspectedCell(2, 14, 6)));
        assertFalse(shell.contains(new IronProspectAtlas.InspectedCell(1, 13, 7)));
    }

    @Test
    void spacingThreeParallelLanesExposeDistinctCompleteWallFaces() {
        Set<IronProspectAtlas.InspectedCell> first = IronProspectAtlas.exposureShellForLane(
            new VoxelCell(0, 14, 0),
            SOUTH,
            12
        );
        Set<IronProspectAtlas.InspectedCell> second = IronProspectAtlas.exposureShellForLane(
            new VoxelCell(3, 14, 13),
            NORTH,
            12
        );

        Set<IronProspectAtlas.InspectedCell> intersection = new java.util.HashSet<>(first);
        intersection.retainAll(second);
        assertTrue(intersection.isEmpty());
        for (int z = 1; z <= 12; z++) {
            for (int y = 14; y <= 15; y++) {
                assertTrue(first.contains(new IronProspectAtlas.InspectedCell(1, y, z)));
                assertTrue(second.contains(new IronProspectAtlas.InspectedCell(2, y, z)));
            }
        }
    }

    @Test
    void remembersExactExposureAcrossCommandsAndSuccessfulEpochs() {
        IronProspectAtlas atlas = new IronProspectAtlas();
        atlas.observeContext(1L, "overworld", 0, 0);
        atlas.beginEpoch();
        for (int z = 1; z <= 12; z++) {
            atlas.recordGroundedLaneCell(0, 14, z);
        }
        int remembered = atlas.rememberedCells();
        assertTrue(remembered >= 70);
        assertTrue(atlas.rankHeadings(0, 14, 0, SOUTH, CARDINALS).getLast().projectedOverlap() > 0);

        atlas.accountCommand(96, 1_000L);
        atlas.completeEpoch();
        atlas.beginEpoch();
        assertEquals(remembered, atlas.rememberedCells());
    }

    @Test
    void planeRegionsDoNotCollapseDifferentFeetLevels() {
        IronProspectAtlas atlas = new IronProspectAtlas();
        IronProspectAtlas.Selection y13 = atlas.rankHeadings(0, 13, 0, SOUTH, CARDINALS).getFirst();
        IronProspectAtlas.Selection y14 = atlas.rankHeadings(0, 14, 0, SOUTH, CARDINALS).getFirst();

        assertNotEquals(y13.planeRegion(), y14.planeRegion());
        atlas.markRegionStarted(y13);
        atlas.markRegionStarted(y14);
        assertEquals(2, atlas.regionCount());
    }

    @Test
    void resetsForWorldDimensionAndLargePositionDiscontinuities() {
        IronProspectAtlas atlas = new IronProspectAtlas();
        atlas.observeContext(1L, "overworld", 0, 0);
        atlas.recordClearedProspectBlock(0, 14, 1);
        atlas.rememberLane(new IronProspectAtlas.LaneSignature(14, 0, 0, 0, 1, 12));
        assertFalse(atlas.observeContext(1L, "overworld", 10, 10));
        assertTrue(atlas.observeContext(1L, "overworld", 100, 10));
        assertEquals(0, atlas.rememberedCells());
        assertEquals(0, atlas.laneCount());

        atlas.recordClearedProspectBlock(100, 14, 10);
        assertTrue(atlas.observeContext(1L, "nether", 100, 10));
        assertEquals(0, atlas.rememberedCells());
        atlas.recordClearedProspectBlock(100, 14, 10);
        assertTrue(atlas.observeContext(2L, "nether", 100, 10));
        assertEquals(0, atlas.rememberedCells());

        atlas.recordClearedProspectBlock(100, 14, 10);
        atlas.observeContext(2L, "nether", 100, 14, 10);
        assertTrue(atlas.observeContext(2L, "nether", 100, 100, 10));
        assertEquals(0, atlas.rememberedCells());
    }

    @Test
    void exhaustionRegionAttemptsAndHintRankDeterministically() {
        IronProspectAtlas atlas = new IronProspectAtlas();
        atlas.beginEpoch();
        atlas.markHeadingExhausted(NORTH);
        IronProspectAtlas.Selection east = atlas.rankHeadings(0, 14, 0, EAST, CARDINALS).getFirst();
        assertEquals(EAST, east.heading());
        atlas.markRegionStarted(east);
        assertEquals(WEST, atlas.rankHeadings(0, 14, 0, EAST, CARDINALS).getFirst().heading());
        assertEquals(WEST, atlas.rankHeadings(0, 14, 0, WEST, CARDINALS).getFirst().heading());
    }

    @Test
    void fixedEpochBudgetsSurvivePartialCommandsAndResetOnlyOnCompletion() {
        IronProspectAtlas atlas = new IronProspectAtlas(16_384, 256, 384, 900_000L);
        assertEquals(1, atlas.beginEpoch());
        atlas.accountCommand(96, 225_000L);
        assertEquals(288, atlas.remainingBlocks());
        assertEquals(675_000L, atlas.remainingActiveMs());
        atlas.accountCommand(288, 675_000L);
        assertTrue(atlas.exhaustedWith(0, 0L));
        atlas.completeEpoch();
        assertEquals(2, atlas.beginEpoch());
        assertEquals(384, atlas.remainingBlocks());
        assertEquals(900_000L, atlas.remainingActiveMs());
    }

    @Test
    void laneAndConnectorSignaturesEnforceCanonicalStructure() {
        assertThrows(IllegalArgumentException.class,
            () -> new IronProspectAtlas.LaneSignature(14, 0, 0, 0, 1, 11));
        assertThrows(IllegalArgumentException.class,
            () -> new IronProspectAtlas.LaneSignature(14, 0, 0, 1, 1, 12));
        assertThrows(IllegalArgumentException.class,
            () -> new IronProspectAtlas.ConnectorSignature(14, 0, 0, 2, 1));
        assertThrows(IllegalArgumentException.class,
            () -> new IronProspectAtlas.ConnectorSignature(14, 0, 0, 2, 0));

        IronProspectAtlas.ConnectorSignature forward =
            new IronProspectAtlas.ConnectorSignature(14, 0, 0, 3, 0);
        IronProspectAtlas.ConnectorSignature reverse =
            new IronProspectAtlas.ConnectorSignature(14, 3, 0, 0, 0);
        assertEquals(forward, reverse);
        assertEquals(0, reverse.sourceX());
        assertEquals(3, reverse.destinationX());
    }

    @Test
    void atomicPlanRegistrationCoversEveryNegativeCoordinatePlaneRegion() {
        IronProspectAtlas atlas = new IronProspectAtlas(100, 10, 10, 10, 384, 900_000L);
        IronProspectAtlas.LaneSignature lane =
            new IronProspectAtlas.LaneSignature(14, -17, 0, 1, 0, 12);
        List<VoxelCell> cells = laneCells(lane);

        assertEquals(
            IronProspectAtlas.PlanRegistrationResult.REGISTERED,
            atlas.registerPlan(lane, null, List.of(), cells)
        );
        assertEquals(2, atlas.regionCount());
        assertEquals(1, atlas.laneCount());
        assertEquals(
            Set.of(
                new IronProspectAtlas.PlaneRegion(14, -2, 0),
                new IronProspectAtlas.PlaneRegion(14, -1, 0)
            ),
            atlas.planeRegions()
        );
    }

    @Test
    void planRegistrationValidatesConnectorRouteAndIsIdempotent() {
        IronProspectAtlas atlas = new IronProspectAtlas();
        IronProspectAtlas.LaneSignature lane =
            new IronProspectAtlas.LaneSignature(14, 3, 0, 0, 1, 12);
        IronProspectAtlas.ConnectorSignature connector =
            new IronProspectAtlas.ConnectorSignature(14, 3, 0, 0, 0);
        List<VoxelCell> connectorCells = List.of(
            new VoxelCell(1, 14, 0),
            new VoxelCell(2, 14, 0),
            new VoxelCell(3, 14, 0)
        );

        assertEquals(IronProspectAtlas.PlanRegistrationResult.INVALID_PLAN,
            atlas.registerPlan(lane, connector, connectorCells.reversed(), laneCells(lane)));
        assertEquals(0, atlas.laneCount());
        assertEquals(0, atlas.connectorCount());

        IronProspectAtlas.LaneSignature collinearLane =
            new IronProspectAtlas.LaneSignature(14, 0, 3, 0, 1, 12);
        IronProspectAtlas.ConnectorSignature collinearConnector =
            new IronProspectAtlas.ConnectorSignature(14, 0, 0, 0, 3);
        assertEquals(IronProspectAtlas.PlanRegistrationResult.INVALID_PLAN,
            atlas.registerPlan(
                collinearLane,
                collinearConnector,
                List.of(
                    new VoxelCell(0, 14, 1),
                    new VoxelCell(0, 14, 2),
                    new VoxelCell(0, 14, 3)
                ),
                laneCells(collinearLane)
            ));
        assertEquals(IronProspectAtlas.PlanRegistrationResult.REGISTERED,
            atlas.registerPlan(lane, connector, connectorCells, laneCells(lane)));
        assertEquals(IronProspectAtlas.PlanRegistrationResult.ALREADY_REGISTERED,
            atlas.registerPlan(lane, connector, connectorCells, laneCells(lane)));
        assertEquals(1, atlas.laneCount());
        assertEquals(1, atlas.connectorCount());
    }

    @Test
    void regionSaturationRejectsPlanWithoutPartialMutation() {
        IronProspectAtlas atlas = new IronProspectAtlas(100, 1, 10, 10, 384, 900_000L);
        IronProspectAtlas.LaneSignature crossing =
            new IronProspectAtlas.LaneSignature(14, -17, 0, 1, 0, 12);

        assertEquals(IronProspectAtlas.PlanRegistrationResult.SATURATED,
            atlas.registerPlan(crossing, null, List.of(), laneCells(crossing)));
        assertEquals(0, atlas.regionCount());
        assertEquals(0, atlas.laneCount());
        assertEquals(0, atlas.connectorCount());
        assertTrue(atlas.consumeSaturationEvent());
        assertFalse(atlas.consumeSaturationEvent());
    }

    @Test
    void signatureSaturationLeavesRegionsAndOtherSignaturesByteStable() {
        IronProspectAtlas atlas = new IronProspectAtlas(100, 10, 1, 10, 384, 900_000L);
        IronProspectAtlas.LaneSignature first =
            new IronProspectAtlas.LaneSignature(14, 0, 0, 0, 1, 12);
        assertEquals(IronProspectAtlas.PlanRegistrationResult.REGISTERED,
            atlas.registerPlan(first, null, List.of(), laneCells(first)));
        int regionsBefore = atlas.regionCount();
        Set<IronProspectAtlas.LaneSignature> lanesBefore = atlas.laneSignatures();
        Set<IronProspectAtlas.ConnectorSignature> connectorsBefore = atlas.connectorSignatures();

        IronProspectAtlas.LaneSignature second =
            new IronProspectAtlas.LaneSignature(14, 19, 0, 0, 1, 12);
        IronProspectAtlas.ConnectorSignature connector =
            new IronProspectAtlas.ConnectorSignature(14, 16, 0, 19, 0);
        List<VoxelCell> connectorCells = List.of(
            new VoxelCell(17, 14, 0),
            new VoxelCell(18, 14, 0),
            new VoxelCell(19, 14, 0)
        );
        assertEquals(IronProspectAtlas.PlanRegistrationResult.SATURATED,
            atlas.registerPlan(second, connector, connectorCells, laneCells(second)));
        assertEquals(regionsBefore, atlas.regionCount());
        assertEquals(lanesBefore, atlas.laneSignatures());
        assertEquals(connectorsBefore, atlas.connectorSignatures());
    }

    @Test
    void explicitMissionCleanupClearsMemoryBudgetsSignaturesAndContext() {
        IronProspectAtlas atlas = new IronProspectAtlas();
        atlas.observeContext(7L, "overworld", 0, 14, 0);
        atlas.recordGroundedLaneCell(0, 14, 0);
        atlas.accountCommand(96, 225_000L);
        IronProspectAtlas.LaneSignature lane =
            new IronProspectAtlas.LaneSignature(14, 0, 0, 0, 1, 12);
        atlas.registerPlan(lane, null, List.of(), laneCells(lane));

        atlas.resetMission();

        assertEquals(0, atlas.rememberedCells());
        assertEquals(0, atlas.regionCount());
        assertEquals(0, atlas.laneCount());
        assertEquals(0, atlas.connectorCount());
        assertEquals(0, atlas.epoch());
        assertEquals(384, atlas.remainingBlocks());
        assertEquals(900_000L, atlas.remainingActiveMs());
        assertFalse(atlas.saturated());
        assertFalse(atlas.observeContext(8L, "nether", 500, 80, 500));
    }

    @Test
    void allMemoryClassesAreBoundedAndSaturationReportsOnce() {
        IronProspectAtlas atlas = new IronProspectAtlas(5, 1, 1, 1, 384, 900_000L);
        atlas.recordClearedProspectBlock(0, 14, 0);
        assertEquals(0, atlas.rememberedCells());
        assertTrue(atlas.saturated());
        assertTrue(atlas.consumeSaturationEvent());
        assertFalse(atlas.consumeSaturationEvent());

        IronProspectAtlas lanes = new IronProspectAtlas(100, 10, 1, 10, 384, 900_000L);
        assertTrue(lanes.rememberLane(new IronProspectAtlas.LaneSignature(14, 0, 0, 0, 1, 12)));
        assertFalse(lanes.rememberLane(new IronProspectAtlas.LaneSignature(14, 3, 0, 0, -1, 12)));

        IronProspectAtlas connectors = new IronProspectAtlas(100, 10, 10, 1, 384, 900_000L);
        assertTrue(connectors.rememberConnector(new IronProspectAtlas.ConnectorSignature(14, 0, 0, 3, 0)));
        assertFalse(connectors.rememberConnector(new IronProspectAtlas.ConnectorSignature(14, 3, 0, 6, 0)));
    }

    private static List<VoxelCell> laneCells(IronProspectAtlas.LaneSignature lane) {
        java.util.ArrayList<VoxelCell> cells = new java.util.ArrayList<>();
        for (int step = 1; step <= lane.length(); step++) {
            cells.add(new VoxelCell(
                lane.originX() + lane.dx() * step,
                lane.feetY(),
                lane.originZ() + lane.dz() * step
            ));
        }
        return List.copyOf(cells);
    }
}
