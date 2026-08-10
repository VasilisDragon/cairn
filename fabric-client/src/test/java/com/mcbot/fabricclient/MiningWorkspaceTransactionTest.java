package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class MiningWorkspaceTransactionTest {
    @Test
    void classifiesOnlyMiningPhaseWorkspaceActions() {
        assertTrue(MiningWorkspaceTransaction.eligibleAction("smelt_raw_iron", "mission:SMELT_IRON"));
        assertTrue(MiningWorkspaceTransaction.eligibleAction("craft_iron_pickaxe", "mission:MAKE_IRON_TOOLS"));
        assertTrue(MiningWorkspaceTransaction.eligibleAction("craft_iron_helmet", "mission:MAKE_ARMOR"));
        assertTrue(MiningWorkspaceTransaction.eligibleAction("craft_stone_pickaxe", "mission:MINE_IRON"));
        assertTrue(MiningWorkspaceTransaction.eligibleAction("craft_stone_pickaxe", "mission:MAKE_STONE_TOOLS"));
        assertEquals(
            MiningWorkspaceTransaction.Workstation.TABLE,
            MiningWorkspaceTransaction.workstationFor("craft_stone_pickaxe")
        );
        assertFalse(MiningWorkspaceTransaction.eligibleAction("craft_stone_pickaxe", "mission:MAKE_ARMOR"));
        assertFalse(MiningWorkspaceTransaction.eligibleAction("craft_stone_pickaxe", "mission:MINE_STONE"));
        assertFalse(MiningWorkspaceTransaction.eligibleAction("craft_stone_pickaxe", "manual"));
        assertFalse(MiningWorkspaceTransaction.eligibleAction("craft_iron_pickaxe", "mission:MAKE_STONE_TOOLS"));
        assertFalse(MiningWorkspaceTransaction.eligibleAction("craft_table", "mission:MAKE_IRON_TOOLS"));

        assertTrue(MiningWorkspaceTransaction.replacementAction("craft_table", "mission:SMELT_IRON"));
        assertTrue(MiningWorkspaceTransaction.replacementAction("place_furnace", "mission:SMELT_IRON"));
        assertTrue(MiningWorkspaceTransaction.replacementAction("craft_table", "mission:MAKE_FURNACE"));
        assertTrue(MiningWorkspaceTransaction.replacementAction("craft_table", "mission:MINE_IRON"));
        assertTrue(MiningWorkspaceTransaction.replacementAction("craft_table", "mission:MAKE_STONE_TOOLS"));
        assertFalse(MiningWorkspaceTransaction.replacementAction("craft_table", "mission:MINE_STONE"));
        assertFalse(MiningWorkspaceTransaction.replacementAction("craft_table", "manual"));
    }

    @Test
    void stonePickRestockRetainsOneReturnReuseAndResumeTransaction() {
        MiningWorkspaceTransaction transaction = new MiningWorkspaceTransaction();
        List<VoxelCell> resume = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 16, 0),
            new VoxelCell(2, 16, 0)
        );
        List<VoxelCell> returning = List.of(resume.get(2), resume.get(1), resume.get(0));

        assertTrue(transaction.start(
            "workspace:stone-restock",
            "stone-pick-1",
            "craft_stone_pickaxe",
            "mission:MAKE_STONE_TOOLS",
            resume.get(2),
            returning,
            resume,
            3,
            true,
            1_000L
        ));
        assertTrue(transaction.replacementSuppression());

        transaction.markReturned();
        transaction.traversal().clear();
        transaction.observeResidentCommand(
            "stone-pick-1",
            "craft_stone_pickaxe",
            "mission:MAKE_STONE_TOOLS"
        );
        assertEquals(
            MiningWorkspaceTransaction.Workstation.TABLE,
            transaction.residentWorkstation("stone-pick-1")
        );
        assertTrue(transaction.markReused("stone-pick-1"));
        assertFalse(transaction.markReused("stone-pick-1"));

        assertTrue(transaction.beginResume("mine-2", resume.get(0), 2_000L));
        assertFalse(transaction.beginResume("mine-2", resume.get(0), 2_001L));
        assertEquals(returning.size(), transaction.routeLength());
    }

    @Test
    void freezesOneRoundTripAndDeduplicatesReuse() {
        MiningWorkspaceTransaction transaction = transaction();
        assertTrue(transaction.active());
        assertTrue(transaction.travelActive());
        assertEquals(new VoxelCell(2, 16, 0), transaction.frontier());
        assertEquals(3, transaction.breadcrumbCount());

        transaction.markReturned();
        transaction.traversal().clear();
        assertTrue(transaction.atWorkspace());
        assertTrue(transaction.markReused("smelt-1"));
        assertFalse(transaction.markReused("smelt-1"));
        assertTrue(transaction.markReused("craft-pick-1"));
        transaction.observeResidentCommand(
            "craft-pick-1",
            "craft_iron_pickaxe",
            "mission:MAKE_IRON_TOOLS"
        );
        assertEquals(
            MiningWorkspaceTransaction.Workstation.TABLE,
            transaction.residentWorkstation("craft-pick-1")
        );
        assertEquals("craft_iron_pickaxe", transaction.residentAction("craft-pick-1"));

        assertTrue(transaction.beginResume("mine-2", new VoxelCell(0, 16, 0), 2_000L));
        assertTrue(transaction.travelCommandMatches("mine-2"));
        assertFalse(transaction.beginResume("mine-2", new VoxelCell(0, 16, 0), 2_001L));
        transaction.markResumed();
        transaction.clear();
        assertFalse(transaction.active());
    }

    @Test
    void completesOneShortReturnAndOneFrontierResume() {
        MiningWorkspaceTransaction transaction = transaction();
        MiningWorkspaceTraversalController traversal = transaction.traversal();
        assertEquals(
            MiningWorkspaceTraversalController.Outcome.DRIVE,
            tick(traversal, new VoxelCell(1, 16, 0), true, 1_100L).outcome()
        );
        assertEquals(
            MiningWorkspaceTraversalController.Outcome.RETURNED,
            tick(traversal, new VoxelCell(0, 16, 0), true, 1_200L).outcome()
        );
        transaction.markReturned();
        assertTrue(transaction.beginResume("mine-2", new VoxelCell(0, 16, 0), 1_300L));
        assertEquals(
            MiningWorkspaceTraversalController.Outcome.DRIVE,
            tick(traversal, new VoxelCell(1, 16, 0), true, 1_400L).outcome()
        );
        assertEquals(
            MiningWorkspaceTraversalController.Outcome.RESUMED,
            tick(traversal, new VoxelCell(2, 16, 0), true, 1_500L).outcome()
        );
    }

    @Test
    void descendingReturnCommitsBeforeAcceptingTheLanding() {
        MiningWorkspaceTransaction transaction = new MiningWorkspaceTransaction();
        List<VoxelCell> resume = List.of(
            new VoxelCell(0, 15, 0),
            new VoxelCell(1, 16, 0),
            new VoxelCell(2, 16, 0)
        );
        List<VoxelCell> returning = List.of(resume.get(2), resume.get(1), resume.get(0));
        assertTrue(transaction.start(
            "workspace:lower",
            "smelt-lower",
            "smelt_raw_iron",
            "mission:SMELT_IRON",
            returning.get(0),
            returning,
            resume,
            3,
            false,
            1_000L
        ));

        MiningWorkspaceTraversalController traversal = transaction.traversal();
        MiningWorkspaceTraversalController.Step selected =
            tick(traversal, returning.get(1), false, 1_100L);
        assertEquals(MiningWorkspaceTraversalController.DescentPhase.SELECTED, selected.descentPhase());
        assertFalse(selected.descentExempt());
        MiningWorkspaceTraversalController.Step aligning =
            tick(traversal, returning.get(1), false, 1_200L);
        assertEquals(MiningWorkspaceTraversalController.DescentPhase.ALIGNING, aligning.descentPhase());
        MiningWorkspaceTraversalController.Step launching =
            tick(traversal, returning.get(1), true, 1_300L);
        assertTrue(launching.descentStarted());
        assertTrue(launching.descentExempt());
        MiningWorkspaceTraversalController.Step landed =
            tick(traversal, returning.get(2), true, 1_400L);
        assertTrue(landed.descentLanded());
        assertFalse(landed.descentExempt());
        assertEquals(
            MiningWorkspaceTraversalController.Outcome.RETURNED,
            tick(traversal, returning.get(2), true, 1_500L).outcome()
        );
    }

    @Test
    void freezesTrailRevisionsAndReplaysAnAcceptedReturnRepairDuringResume() {
        MiningWorkspaceTransaction transaction = transaction();
        assertEquals(7L, transaction.workspaceSessionRevision());
        assertEquals(11L, transaction.workspaceTrailRevision());
        assertEquals(List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 16, 0),
            new VoxelCell(2, 16, 0)
        ), transaction.canonicalTrail());

        MiningWorkspaceTraversalController traversal = transaction.traversal();
        MiningWorkspaceTraversalController.RouteSnapshot frozen = traversal.routeSnapshot();
        List<VoxelCell> repairedCanonical = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(0, 16, 1),
            new VoxelCell(1, 16, 1),
            new VoxelCell(2, 16, 1),
            new VoxelCell(2, 16, 0)
        );

        assertTrue(transaction.claimRouteSuffixRepair(
            MiningWorkspaceTraversalController.Mode.RETURN
        ));
        assertFalse(transaction.claimRouteSuffixRepair(
            MiningWorkspaceTraversalController.Mode.RETURN
        ));
        assertTrue(transaction.canApplyCanonicalRepair(
            MiningWorkspaceTraversalController.Mode.RETURN,
            frozen,
            7L,
            11L,
            transaction.canonicalTrail(),
            repairedCanonical,
            12L
        ));
        assertTrue(transaction.applyCanonicalRepair(
            MiningWorkspaceTraversalController.Mode.RETURN,
            frozen,
            7L,
            11L,
            transaction.canonicalTrail(),
            repairedCanonical,
            12L
        ));

        List<VoxelCell> repairedReturn = List.of(
            new VoxelCell(2, 16, 0),
            new VoxelCell(2, 16, 1),
            new VoxelCell(1, 16, 1),
            new VoxelCell(0, 16, 1),
            new VoxelCell(0, 16, 0)
        );
        assertEquals(repairedCanonical, transaction.canonicalTrail());
        assertEquals(repairedCanonical, transaction.resumeRoute());
        assertEquals(repairedReturn, transaction.returnRoute());
        assertEquals(repairedReturn, traversal.route());
        assertEquals(12L, transaction.workspaceTrailRevision());
        assertEquals(5, transaction.breadcrumbCount());
        MiningWorkspaceTraversalController.RouteSnapshot repaired = traversal.routeSnapshot();
        assertEquals(frozen.waypointIndex(), repaired.waypointIndex());
        assertEquals(frozen.stableFeet(), repaired.stableFeet());
        assertEquals(frozen.startedAtMs(), repaired.startedAtMs());
        assertEquals(frozen.deadlineAtMs(), repaired.deadlineAtMs());
        assertEquals(frozen.lastProgressAtMs(), repaired.lastProgressAtMs());
        assertEquals("smelt-1", transaction.originalCommandId());
        assertEquals("smelt_raw_iron", transaction.originalAction());
        assertEquals("mission:SMELT_IRON", transaction.objectiveReason());
        assertEquals(new VoxelCell(2, 16, 0), transaction.frontier());
        assertEquals(500L, transaction.elapsedMs(1_500L));

        transaction.markReturned();
        traversal.clear();
        assertTrue(transaction.beginResume("mine-2", repairedCanonical.get(0), 2_000L));
        assertEquals(repairedCanonical, traversal.route());
        MiningWorkspaceTraversalController.RouteSnapshot resumeFrozen = traversal.routeSnapshot();
        assertTrue(transaction.claimRouteSuffixRepair(
            MiningWorkspaceTraversalController.Mode.RESUME
        ));
        assertFalse(transaction.claimRouteSuffixRepair(
            MiningWorkspaceTraversalController.Mode.RESUME
        ));
        List<VoxelCell> resumeRepairedCanonical = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(-1, 16, 0),
            new VoxelCell(-1, 16, 1),
            new VoxelCell(0, 16, 1),
            new VoxelCell(1, 16, 1),
            new VoxelCell(2, 16, 1),
            new VoxelCell(2, 16, 0)
        );
        assertTrue(transaction.applyCanonicalRepair(
            MiningWorkspaceTraversalController.Mode.RESUME,
            resumeFrozen,
            7L,
            12L,
            repairedCanonical,
            resumeRepairedCanonical,
            13L
        ));
        assertEquals(resumeRepairedCanonical, traversal.route());
        assertEquals(resumeRepairedCanonical, transaction.resumeRoute());
        assertEquals(13L, transaction.workspaceTrailRevision());
    }

    @Test
    void canonicalRepairRejectsStaleOrMalformedInputsWithoutPartialMutation() {
        MiningWorkspaceTransaction transaction = transaction();
        MiningWorkspaceTraversalController.RouteSnapshot frozen =
            transaction.traversal().routeSnapshot();
        List<VoxelCell> beforeCanonical = transaction.canonicalTrail();
        List<VoxelCell> beforeReturn = transaction.returnRoute();
        assertTrue(transaction.claimRouteSuffixRepair(
            MiningWorkspaceTraversalController.Mode.RETURN
        ));

        List<VoxelCell> repaired = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(0, 16, 1),
            new VoxelCell(1, 16, 1),
            new VoxelCell(2, 16, 1),
            new VoxelCell(2, 16, 0)
        );
        assertFalse(transaction.applyCanonicalRepair(
            MiningWorkspaceTraversalController.Mode.RETURN,
            frozen,
            8L,
            11L,
            beforeCanonical,
            repaired,
            12L
        ));
        assertFalse(transaction.applyCanonicalRepair(
            MiningWorkspaceTraversalController.Mode.RETURN,
            frozen,
            7L,
            11L,
            beforeCanonical,
            List.of(
                new VoxelCell(0, 16, 0),
                new VoxelCell(1, 16, 0),
                new VoxelCell(1, 16, 0),
                new VoxelCell(2, 16, 0)
            ),
            12L
        ));
        assertEquals(beforeCanonical, transaction.canonicalTrail());
        assertEquals(beforeReturn, transaction.returnRoute());
        assertEquals(11L, transaction.workspaceTrailRevision());
        assertEquals(frozen, transaction.traversal().routeSnapshot());
    }

    @Test
    void classifiesResidenceResumeAndTerminalClosure() {
        assertTrue(MiningWorkspaceTransaction.residentAction("smelt_raw_iron", "mission:SMELT_IRON"));
        assertTrue(MiningWorkspaceTransaction.residentAction("equip_armor", "mission:MAKE_ARMOR"));
        assertTrue(MiningWorkspaceTransaction.residentAction("craft_sticks", "mission:MAKE_ARMOR"));
        assertTrue(MiningWorkspaceTransaction.residentAction(
            "stop",
            "smelt_raw_iron_complete:typed_delta"
        ));
        assertTrue(MiningWorkspaceTransaction.resumeAction("mine_nearby_iron", "mission:MINE_IRON"));
        assertTrue(MiningWorkspaceTransaction.resumeAction(
            "descend_staircase",
            "mission:MINE_IRON_RECOVERY"
        ));
        assertFalse(MiningWorkspaceTransaction.resumeAction(
            "descend_staircase",
            "mission:DESCEND_RECOVERY"
        ));
        assertTrue(MiningWorkspaceTransaction.closesWithoutResume("return_staircase", "mission:RETURN"));
        assertTrue(MiningWorkspaceTransaction.closesWithoutResume("stop", "mission:done"));
    }

    private static MiningWorkspaceTransaction transaction() {
        MiningWorkspaceTransaction transaction = new MiningWorkspaceTransaction();
        List<VoxelCell> resume = List.of(
            new VoxelCell(0, 16, 0),
            new VoxelCell(1, 16, 0),
            new VoxelCell(2, 16, 0)
        );
        List<VoxelCell> returning = List.of(resume.get(2), resume.get(1), resume.get(0));
        assertTrue(transaction.start(
            "workspace:1",
            "smelt-1",
            "smelt_raw_iron",
            "mission:SMELT_IRON",
            resume.get(2),
            returning,
            resume,
            3,
            7L,
            11L,
            false,
            1_000L
        ));
        return transaction;
    }

    private static MiningWorkspaceTraversalController.Step tick(
        MiningWorkspaceTraversalController traversal,
        VoxelCell feet,
        boolean aligned,
        long nowMs
    ) {
        return traversal.tick(
            MiningWorkspaceTraversalController.Observation.centered(feet, true, aligned),
            cell -> true,
            nowMs
        );
    }
}
