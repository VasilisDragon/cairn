package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class IronProspectAtlasTest {
    private static final StaircaseDescentPlanner.Direction2d NORTH = new StaircaseDescentPlanner.Direction2d(0, -1, "north");
    private static final StaircaseDescentPlanner.Direction2d EAST = new StaircaseDescentPlanner.Direction2d(1, 0, "east");
    private static final StaircaseDescentPlanner.Direction2d SOUTH = new StaircaseDescentPlanner.Direction2d(0, 1, "south");
    private static final StaircaseDescentPlanner.Direction2d WEST = new StaircaseDescentPlanner.Direction2d(-1, 0, "west");
    private static final List<StaircaseDescentPlanner.Direction2d> CARDINALS = List.of(NORTH, EAST, SOUTH, WEST);

    @Test
    void remembersExposedColumnsAcrossCommandsAndSuccessfulEpochs() {
        IronProspectAtlas atlas = new IronProspectAtlas();
        atlas.observeContext(1L, "overworld", 0, 0);
        atlas.beginEpoch();
        for (int z = 1; z <= 12; z++) {
            atlas.recordCorridor(0, 14, z, SOUTH);
        }
        assertEquals(60, atlas.rememberedColumns());
        assertEquals(NORTH, atlas.rankHeadings(0, 0, SOUTH, CARDINALS).get(0).heading());
        atlas.accountCommand(96, 1000L);
        atlas.completeEpoch();
        atlas.beginEpoch();
        assertEquals(60, atlas.rememberedColumns());
        assertTrue(atlas.rankHeadings(0, 0, SOUTH, CARDINALS).get(3).projectedOverlap() > 0);
    }

    @Test
    void resetsForWorldDimensionAndLargePositionDiscontinuities() {
        IronProspectAtlas atlas = new IronProspectAtlas();
        atlas.observeContext(1L, "overworld", 0, 0);
        atlas.recordCorridor(0, 14, 1, SOUTH);
        assertFalse(atlas.observeContext(1L, "overworld", 10, 10));
        assertTrue(atlas.observeContext(1L, "overworld", 100, 10));
        assertEquals(0, atlas.rememberedColumns());
        atlas.recordCorridor(100, 14, 10, EAST);
        assertTrue(atlas.observeContext(1L, "nether", 100, 10));
        assertEquals(0, atlas.rememberedColumns());
        atlas.recordCorridor(100, 14, 10, EAST);
        assertTrue(atlas.observeContext(2L, "nether", 100, 10));
        assertEquals(0, atlas.rememberedColumns());
    }

    @Test
    void overlapExhaustionRegionAttemptsAndHintRankDeterministically() {
        IronProspectAtlas atlas = new IronProspectAtlas();
        atlas.beginEpoch();
        atlas.markHeadingExhausted(NORTH);
        IronProspectAtlas.Selection east = atlas.rankHeadings(0, 0, EAST, CARDINALS).get(0);
        assertEquals(EAST, east.heading());
        atlas.markRegionStarted(east);
        assertEquals(WEST, atlas.rankHeadings(0, 0, EAST, CARDINALS).get(0).heading());
        assertEquals(WEST, atlas.rankHeadings(0, 0, WEST, CARDINALS).get(0).heading());
    }

    @Test
    void perpendicularDepartureIgnoresOnlyTheUnavoidableTwoCellCorridorSeam() {
        IronProspectAtlas atlas = new IronProspectAtlas();
        for (int z = 1; z <= 12; z++) {
            atlas.recordCorridor(0, 14, z, SOUTH);
        }
        IronProspectAtlas.Selection selected = atlas.rankHeadings(0, 12, EAST, CARDINALS).get(0);
        assertEquals(EAST, selected.heading());
        assertEquals(0, selected.projectedOverlap());
        assertTrue(atlas.rankHeadings(0, 0, SOUTH, CARDINALS).getLast().projectedOverlap() > 0);
    }

    @Test
    void fixedEpochBudgetsSurvivePartialCommandsAndResetOnlyOnCompletion() {
        IronProspectAtlas atlas = new IronProspectAtlas(4096, 256, 384, 900_000L);
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
    void boundedMemorySaturatesOnceWithoutEviction() {
        IronProspectAtlas atlas = new IronProspectAtlas(5, 1, 384, 900_000L);
        atlas.recordCorridor(0, 14, 0, SOUTH);
        atlas.recordCorridor(10, 14, 0, SOUTH);
        assertEquals(5, atlas.rememberedColumns());
        IronProspectAtlas.Selection first = atlas.rankHeadings(0, 0, NORTH, CARDINALS).get(0);
        atlas.markRegionStarted(first);
        IronProspectAtlas.Selection other = atlas.rankHeadings(128, 128, NORTH, CARDINALS).get(0);
        atlas.markRegionStarted(other);
        assertEquals(1, atlas.regionCount());
        assertTrue(atlas.consumeSaturationEvent());
        assertFalse(atlas.consumeSaturationEvent());
    }
}
