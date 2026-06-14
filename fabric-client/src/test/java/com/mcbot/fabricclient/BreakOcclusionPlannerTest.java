package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

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
        assertEquals(true, BlockBreakController.isCheapOccluderBlockId("snow"));

        assertEquals(false, BlockBreakController.isCheapOccluderBlockId("dirt"));
        assertEquals(false, BlockBreakController.isCheapOccluderBlockId("snow_block"));
        assertEquals(false, BlockBreakController.isCheapOccluderBlockId("stone"));
        assertEquals(false, BlockBreakController.isCheapOccluderBlockId(""));
    }

    @Test
    void reachUsesNearestBlockFaceNotOnlyCenter() {
        Vec3d eye = new Vec3d(-0.75D, 65.5D, 0.5D);
        BlockPos target = new BlockPos(4, 65, 0);

        assertEquals(true, BlockBreakController.withinReach(eye, target, 4.8D));
        assertEquals(false, eye.squaredDistanceTo(Vec3d.ofCenter(target)) <= 4.8D * 4.8D);
        assertEquals(false, BlockBreakController.withinReach(eye, target, 4.7D));
    }

    @Test
    void stableAirConfirmationRequiresAWindow() {
        assertEquals(false, BlockBreakController.hasStableAirConfirmation(-1L, 1_000L, 150L));
        assertEquals(false, BlockBreakController.hasStableAirConfirmation(1_000L, 999L, 150L));
        assertEquals(false, BlockBreakController.hasStableAirConfirmation(1_000L, 1_149L, 150L));
        assertEquals(true, BlockBreakController.hasStableAirConfirmation(1_000L, 1_150L, 150L));
    }

    @Test
    void terrainOccludersCoverPlainRockAndSoilOnly() {
        assertEquals(true, BlockBreakController.isTerrainOccluderBlockId("stone"));
        assertEquals(true, BlockBreakController.isTerrainOccluderBlockId("deepslate"));
        assertEquals(true, BlockBreakController.isTerrainOccluderBlockId("granite"));
        assertEquals(true, BlockBreakController.isTerrainOccluderBlockId("tuff"));
        assertEquals(true, BlockBreakController.isTerrainOccluderBlockId("dirt"));

        // Ores are targets, never occluders; gravity blocks would collapse onto the dig line.
        assertEquals(false, BlockBreakController.isTerrainOccluderBlockId("iron_ore"));
        assertEquals(false, BlockBreakController.isTerrainOccluderBlockId("deepslate_iron_ore"));
        assertEquals(false, BlockBreakController.isTerrainOccluderBlockId("diamond_ore"));
        assertEquals(false, BlockBreakController.isTerrainOccluderBlockId("gravel"));
        assertEquals(false, BlockBreakController.isTerrainOccluderBlockId("sand"));
        assertEquals(false, BlockBreakController.isTerrainOccluderBlockId("oak_log"));
        assertEquals(false, BlockBreakController.isTerrainOccluderBlockId(""));
        assertEquals(false, BlockBreakController.isTerrainOccluderBlockId(null));
    }
}
