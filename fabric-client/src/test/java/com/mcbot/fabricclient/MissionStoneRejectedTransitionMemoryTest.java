package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class MissionStoneRejectedTransitionMemoryTest {
    private static final String WORLD = "world-a";
    private static final String DIMENSION = "minecraft:overworld";
    private static final long SESSION = 17L;

    @Test
    void recordsOneDirectedPhysicalRejectionAndSuppressesItsReplay() {
        MissionStoneRejectedTransitionMemory memory = memory();
        VoxelCell origin = cell(0);
        VoxelCell landing = cell(1);

        assertEquals(
            MissionStoneRejectedTransitionMemory.RecordResult.RECORDED,
            memory.recordPhysicalRejection(origin, landing)
        );
        assertEquals(
            MissionStoneRejectedTransitionMemory.RecordResult.ALREADY_RECORDED,
            memory.recordPhysicalRejection(origin, landing)
        );
        assertTrue(memory.contains(origin, landing));
        assertFalse(memory.contains(landing, origin), "the reverse edge is a different transition");
        assertEquals(1, memory.retainedTransitionCount());
    }

    @Test
    void sameSessionObservationPreservesMemoryAcrossCommandAndTrailChurn() {
        MissionStoneRejectedTransitionMemory memory = memory();
        VoxelCell origin = cell(3);
        VoxelCell landing = cell(4);
        memory.recordPhysicalRejection(origin, landing);

        assertFalse(memory.observeContext(WORLD, DIMENSION, SESSION));
        assertTrue(memory.contains(origin, landing));
        assertEquals(1, memory.retainedTransitionCount());
    }

    @Test
    void preActivationScopeSurvivesProvisionalSurfaceSessionChurn() {
        MissionStoneRejectedTransitionMemory memory = new MissionStoneRejectedTransitionMemory();
        VoxelCell origin = cell(5);
        VoxelCell landing = cell(6);

        assertTrue(memory.observeContext(
            WORLD,
            DIMENSION,
            MissionStoneRejectedTransitionMemory.PRE_ACTIVATION_SESSION
        ));
        assertEquals(
            MissionStoneRejectedTransitionMemory.RecordResult.RECORDED,
            memory.recordPhysicalRejection(origin, landing)
        );

        // The client may start and discard any number of one-cell SurfaceReturnTrailStore
        // sessions before a real landing. They all map back to the same pre-activation scope.
        assertFalse(memory.observeContext(
            WORLD,
            DIMENSION,
            MissionStoneRejectedTransitionMemory.PRE_ACTIVATION_SESSION
        ));
        assertTrue(memory.contains(origin, landing));

        assertTrue(memory.observeContext(WORLD, DIMENSION, SESSION));
        assertFalse(memory.contains(origin, landing), "a verified shaft session is a new boundary");
    }

    @Test
    void oneRememberedEdgeBlocksDirectSafeDropReplayButNotAnEarlierExecutablePrefix() {
        MissionStoneRejectedTransitionMemory memory = memory();
        StaircaseDescentPlanner.Step earlier = StaircaseDescentPlanner.stepFrom(
            new BlockPos(0, 70, 0),
            StaircaseDescentPlanner.south(),
            1
        );
        StaircaseDescentPlanner.Step rejected = StaircaseDescentPlanner.stepFrom(
            earlier.nextFeet(),
            StaircaseDescentPlanner.south(),
            2
        );
        VoxelCell rejectedOrigin = voxel(rejected.currentFeet());
        VoxelCell rejectedLanding = voxel(rejected.nextFeet());
        memory.recordPhysicalRejection(rejectedOrigin, rejectedLanding);

        assertTrue(
            memory.suppressesSafeDrop(rejectedOrigin, rejectedLanding),
            "SAFE_DROP must not physically replay the same directed edge"
        );
        assertNull(
            memory.firstRejectedExecutableStep(List.of(earlier)),
            "a smaller exact prefix before the rejected edge remains admissible"
        );
        assertEquals(
            rejected,
            memory.firstRejectedExecutableStep(List.of(earlier, rejected)),
            "the edge is suppressed as soon as it becomes executable"
        );
    }

    @Test
    void worldDimensionAndSurfaceSessionChangesAreIndependentIsolationBoundaries() {
        MissionStoneRejectedTransitionMemory memory = memory();
        VoxelCell origin = cell(8);
        VoxelCell landing = cell(9);
        memory.recordPhysicalRejection(origin, landing);

        assertTrue(memory.observeContext("world-b", DIMENSION, SESSION));
        assertFalse(memory.contains(origin, landing));
        memory.recordPhysicalRejection(origin, landing);

        assertTrue(memory.observeContext("world-b", "minecraft:the_nether", SESSION));
        assertFalse(memory.contains(origin, landing));
        memory.recordPhysicalRejection(origin, landing);

        assertTrue(memory.observeContext("world-b", "minecraft:the_nether", SESSION + 1L));
        assertFalse(memory.contains(origin, landing));
        assertEquals(0, memory.retainedTransitionCount());
    }

    @Test
    void evictsOldestTransitionDeterministicallyWithoutRefreshingDuplicates() {
        MissionStoneRejectedTransitionMemory memory = memory();
        for (int index = 0;
             index < MissionStoneRejectedTransitionMemory.MAX_REJECTED_TRANSITIONS;
             index++) {
            assertEquals(
                MissionStoneRejectedTransitionMemory.RecordResult.RECORDED,
                memory.recordPhysicalRejection(cell(index), cell(index + 1))
            );
        }

        assertEquals(
            MissionStoneRejectedTransitionMemory.RecordResult.ALREADY_RECORDED,
            memory.recordPhysicalRejection(cell(0), cell(1))
        );
        assertEquals(
            MissionStoneRejectedTransitionMemory.RecordResult.RECORDED,
            memory.recordPhysicalRejection(cell(100), cell(101))
        );
        assertFalse(memory.contains(cell(0), cell(1)), "the first FIFO entry is evicted");
        assertTrue(memory.contains(cell(1), cell(2)));
        assertTrue(memory.contains(cell(100), cell(101)));

        memory.recordPhysicalRejection(cell(102), cell(103));
        assertFalse(
            memory.contains(cell(1), cell(2)),
            "a duplicate lookup must not move the second entry to the tail"
        );
        assertEquals(
            MissionStoneRejectedTransitionMemory.MAX_REJECTED_TRANSITIONS,
            memory.retainedTransitionCount()
        );
    }

    @Test
    void invalidContextAndNonTransitionsCannotEnterMemory() {
        MissionStoneRejectedTransitionMemory memory = new MissionStoneRejectedTransitionMemory();
        VoxelCell cell = cell(0);

        assertEquals(
            MissionStoneRejectedTransitionMemory.RecordResult.INVALID,
            memory.recordPhysicalRejection(cell, cell(1))
        );
        memory.observeContext(WORLD, DIMENSION, SESSION);
        assertEquals(
            MissionStoneRejectedTransitionMemory.RecordResult.INVALID,
            memory.recordPhysicalRejection(null, cell)
        );
        assertEquals(
            MissionStoneRejectedTransitionMemory.RecordResult.INVALID,
            memory.recordPhysicalRejection(cell, cell)
        );
        assertFalse(memory.contains(cell, cell));
        assertEquals(0, memory.retainedTransitionCount());
    }

    private static MissionStoneRejectedTransitionMemory memory() {
        MissionStoneRejectedTransitionMemory memory =
            new MissionStoneRejectedTransitionMemory();
        assertTrue(memory.observeContext(WORLD, DIMENSION, SESSION));
        return memory;
    }

    private static VoxelCell cell(int x) {
        return new VoxelCell(x, 64, 0);
    }

    private static VoxelCell voxel(BlockPos cell) {
        return new VoxelCell(cell.getX(), cell.getY(), cell.getZ());
    }
}
