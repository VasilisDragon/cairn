package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class BreakOcclusionPlannerTest {
    @Test
    void breaksTargetWhenRayHitsTargetFirst() {
        BreakOcclusionPlanner.Decision decision = BreakOcclusionPlanner.decide(
            true,
            true,
            false,
            0,
            4,
            0,
            2
        );

        assertEquals(BreakOcclusionPlanner.Action.BREAK_TARGET, decision.action());
        assertEquals("raycast_hit_target", decision.reason());
    }

    @Test
    void breaksCheapOccluderBeforeTarget() {
        BreakOcclusionPlanner.Decision decision = BreakOcclusionPlanner.decide(
            true,
            false,
            true,
            1,
            4,
            0,
            2
        );

        assertEquals(BreakOcclusionPlanner.Action.BREAK_OCCLUDER, decision.action());
        assertEquals("raycast_hit_breakable_occluder", decision.reason());
    }

    @Test
    void asksForRepositionWhenOccluderIsNotBreakable() {
        BreakOcclusionPlanner.Decision decision = BreakOcclusionPlanner.decide(
            true,
            false,
            false,
            0,
            4,
            1,
            2
        );

        assertEquals(BreakOcclusionPlanner.Action.REPOSITION, decision.action());
        assertEquals("raycast_occluded_reposition", decision.reason());
    }

    @Test
    void abandonsAfterBoundedOcclusionOptions() {
        BreakOcclusionPlanner.Decision hard = BreakOcclusionPlanner.decide(
            true,
            false,
            false,
            0,
            4,
            2,
            2
        );
        BreakOcclusionPlanner.Decision cheapLimit = BreakOcclusionPlanner.decide(
            true,
            false,
            true,
            4,
            4,
            2,
            2
        );

        assertEquals(BreakOcclusionPlanner.Action.ABANDON, hard.action());
        assertEquals("raycast_unbreakable_occluder", hard.reason());
        assertEquals(BreakOcclusionPlanner.Action.ABANDON, cheapLimit.action());
        assertEquals("raycast_occluder_limit", cheapLimit.reason());
    }

    @Test
    void waitsWhenRayHitsNoBlockYet() {
        BreakOcclusionPlanner.Decision decision = BreakOcclusionPlanner.decide(
            false,
            false,
            false,
            0,
            4,
            0,
            2
        );

        assertEquals(BreakOcclusionPlanner.Action.WAIT, decision.action());
        assertEquals("raycast_no_block_hit", decision.reason());
    }

    @Test
    void cheapOccluderClassifierIncludesVegetationButNotHardBlocks() {
        assertEquals(true, BlockBreakController.isCheapOccluderBlockId("grass"));
        assertEquals(true, BlockBreakController.isCheapOccluderBlockId("short_grass"));
        assertEquals(true, BlockBreakController.isCheapOccluderBlockId("fern"));
        assertEquals(true, BlockBreakController.isCheapOccluderBlockId("tall_grass"));
        assertEquals(true, BlockBreakController.isCheapOccluderBlockId("large_fern"));
        assertEquals(true, BlockBreakController.isCheapOccluderBlockId("vine"));
        assertEquals(true, BlockBreakController.isCheapOccluderBlockId("twisting_vines"));

        assertEquals(false, BlockBreakController.isCheapOccluderBlockId("dirt"));
        assertEquals(false, BlockBreakController.isCheapOccluderBlockId("stone"));
        assertEquals(false, BlockBreakController.isCheapOccluderBlockId(""));
    }
}
