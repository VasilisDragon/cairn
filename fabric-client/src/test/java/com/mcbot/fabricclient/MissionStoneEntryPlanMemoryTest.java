package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class MissionStoneEntryPlanMemoryTest {
    private static final String WORLD = "world-a";
    private static final String DIMENSION = "minecraft:overworld";
    private static final VoxelCell ORIGIN = new VoxelCell(8, 68, 42);

    @Test
    void retainsExactPlanIdentityAcrossCommandReissuesAtSameOrigin() {
        MissionStoneEntryPlanMemory memory = memory();

        assertEquals(
            MissionStoneEntryPlanMemory.RecordResult.RECORDED,
            memory.retire("staircase:west:8,68,42")
        );
        assertEquals(
            MissionStoneEntryPlanMemory.RecordResult.ALREADY_RECORDED,
            memory.retire(" staircase:west:8,68,42 ")
        );
        assertFalse(memory.observeContext(WORLD, DIMENSION, ORIGIN));
        assertTrue(memory.contains("staircase:west:8,68,42"));
        assertFalse(memory.contains("staircase:east:8,68,42"));
        assertEquals(1, memory.retainedPlanCount());
    }

    @Test
    void refusesAPlanBeyondTheFourCardinalHardLimitWithoutEviction() {
        MissionStoneEntryPlanMemory memory = memory();
        for (int index = 0; index < MissionStoneEntryPlanMemory.MAX_RETIRED_PLANS; index++) {
            assertEquals(
                MissionStoneEntryPlanMemory.RecordResult.RECORDED,
                memory.retire("staircase:" + index)
            );
        }

        assertEquals(
            MissionStoneEntryPlanMemory.RecordResult.LIMIT_REACHED,
            memory.retire("staircase:overflow")
        );
        assertEquals(
            MissionStoneEntryPlanMemory.MAX_RETIRED_PLANS,
            memory.retainedPlanCount()
        );
        assertTrue(memory.contains("staircase:0"), "the oldest proof must never be evicted");
        assertFalse(memory.contains("staircase:overflow"));
    }

    @Test
    void worldDimensionAndExactOriginAreIndependentIsolationBoundaries() {
        MissionStoneEntryPlanMemory memory = memory();
        memory.retire("staircase:west");

        assertTrue(memory.observeContext("world-b", DIMENSION, ORIGIN));
        assertEquals(0, memory.retainedPlanCount());
        memory.retire("staircase:west");

        assertTrue(memory.observeContext("world-b", "minecraft:the_nether", ORIGIN));
        assertEquals(0, memory.retainedPlanCount());
        memory.retire("staircase:west");

        assertTrue(memory.observeContext(
            "world-b",
            "minecraft:the_nether",
            new VoxelCell(9, 68, 42)
        ));
        assertEquals(0, memory.retainedPlanCount());
    }

    @Test
    void invalidContextAndBlankIdentityCannotEnterMemory() {
        MissionStoneEntryPlanMemory memory = new MissionStoneEntryPlanMemory();

        assertEquals(
            MissionStoneEntryPlanMemory.RecordResult.INVALID,
            memory.retire("staircase:west")
        );
        memory.observeContext(WORLD, DIMENSION, ORIGIN);
        assertEquals(
            MissionStoneEntryPlanMemory.RecordResult.INVALID,
            memory.retire(" ")
        );
        assertFalse(memory.contains(null));
        assertEquals(0, memory.retainedPlanCount());
    }

    private static MissionStoneEntryPlanMemory memory() {
        MissionStoneEntryPlanMemory memory = new MissionStoneEntryPlanMemory();
        assertTrue(memory.observeContext(WORLD, DIMENSION, ORIGIN));
        return memory;
    }
}
