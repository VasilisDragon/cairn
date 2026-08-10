package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class MiningWorkspaceRouteSuffixRepairTest {
    @Test
    void atomicallyPersistsReturnRepairAndReplaysItForResume() {
        Fixture fixture = fixture();
        MiningWorkspaceTraversalController controller = fixture.transaction().traversal();
        MiningWorkspaceTraversalController.RouteSnapshot before = controller.routeSnapshot();
        long trailRevisionBefore = fixture.store().trailRevision();
        MiningWorkspaceRouteSuffixPlanner.Result plan = plan(
            List.of(
                cell(5, 0),
                cell(5, 1),
                cell(4, 1),
                cell(3, 1),
                cell(3, 0)
            ),
            2,
            1
        );
        assertTrue(fixture.transaction().claimRouteSuffixRepair(
            MiningWorkspaceTraversalController.Mode.RETURN
        ));

        MiningWorkspaceRouteSuffixRepair.Result result =
            MiningWorkspaceRouteSuffixRepair.apply(
                fixture.store(),
                fixture.transaction(),
                fixture.workspace(),
                before,
                plan
            );

        assertTrue(result.repaired(), result.reason());
        assertEquals(5, result.connectorLength());
        assertEquals(1, result.skippedCells());
        assertEquals(trailRevisionBefore + 1L, fixture.store().trailRevision());
        assertEquals(fixture.store().trail(), fixture.transaction().canonicalTrail());
        assertEquals(fixture.store().returnRoute(), controller.route());
        MiningWorkspaceTraversalController.RouteSnapshot after = controller.routeSnapshot();
        assertEquals(before.waypointIndex(), after.waypointIndex());
        assertEquals(before.startedAtMs(), after.startedAtMs());
        assertEquals(before.deadlineAtMs(), after.deadlineAtMs());
        assertEquals(before.lastProgressAtMs(), after.lastProgressAtMs());

        fixture.transaction().markReturned();
        controller.clear();
        assertTrue(fixture.transaction().beginResume("mine-2", cell(0, 0), 2_000L));
        assertEquals(fixture.store().resumeRoute(), controller.route());

        MiningWorkspaceTransaction later = new MiningWorkspaceTransaction();
        assertTrue(later.start(
            fixture.workspace().id(),
            "smelt-2",
            "smelt_raw_iron",
            "mission:SMELT_IRON",
            fixture.store().frontier(),
            fixture.store().returnRoute(),
            fixture.store().resumeRoute(),
            fixture.store().breadcrumbCount(),
            fixture.store().sessionRevision(),
            fixture.store().trailRevision(),
            false,
            3_000L
        ));
        assertEquals(fixture.store().returnRoute(), later.traversal().route());
        assertFalse(later.routeSuffixRepairAttempted(
            MiningWorkspaceTraversalController.Mode.RETURN
        ));
    }

    @Test
    void staleStoreAndMalformedSpliceLeaveBothSidesUnchanged() {
        Fixture fixture = fixture();
        MiningWorkspaceTraversalController.RouteSnapshot snapshot =
            fixture.transaction().traversal().routeSnapshot();
        List<VoxelCell> trailBefore = fixture.store().trail();
        List<VoxelCell> routeBefore = snapshot.route();
        assertTrue(fixture.transaction().claimRouteSuffixRepair(
            MiningWorkspaceTraversalController.Mode.RETURN
        ));
        fixture.store().append(cell(6, 0), true, true);

        MiningWorkspaceRouteSuffixRepair.Result stale =
            MiningWorkspaceRouteSuffixRepair.apply(
                fixture.store(),
                fixture.transaction(),
                fixture.workspace(),
                snapshot,
                plan(
                    List.of(cell(5, 0), cell(5, 1), cell(4, 1), cell(3, 1), cell(3, 0)),
                    2,
                    1
                )
            );

        assertFalse(stale.repaired());
        assertEquals("stale_trail", stale.reason());
        assertEquals(routeBefore, fixture.transaction().traversal().route());
        assertEquals(7, fixture.store().trail().size());
        assertEquals(trailBefore, fixture.store().trail().subList(0, trailBefore.size()));
    }

    @Test
    void rejectedPlannerResultMutatesNeitherStoreNorTransaction() {
        Fixture fixture = fixture();
        MiningWorkspaceTraversalController.RouteSnapshot snapshot =
            fixture.transaction().traversal().routeSnapshot();
        assertTrue(fixture.transaction().claimRouteSuffixRepair(
            MiningWorkspaceTraversalController.Mode.RETURN
        ));
        List<VoxelCell> trailBefore = fixture.store().trail();

        MiningWorkspaceRouteSuffixRepair.Result result =
            MiningWorkspaceRouteSuffixRepair.apply(
                fixture.store(),
                fixture.transaction(),
                fixture.workspace(),
                snapshot,
                new MiningWorkspaceRouteSuffixPlanner.Result(
                    List.of(),
                    null,
                    -1,
                    0,
                    "no_safe_connector",
                    17
                )
            );

        assertFalse(result.repaired());
        assertEquals("no_safe_connector", result.reason());
        assertEquals(17, result.expandedCells());
        assertEquals(trailBefore, fixture.store().trail());
        assertEquals(snapshot, fixture.transaction().traversal().routeSnapshot());
    }

    private static Fixture fixture() {
        MiningWorkspaceStore store = new MiningWorkspaceStore();
        MiningWorkspaceStore.Workspace workspace = new MiningWorkspaceStore.Workspace(
            "workspace",
            cell(0, 0),
            cell(0, -1),
            new VoxelCell(0, 65, -1),
            cell(1, -1),
            new VoxelCell(1, 65, -1)
        );
        store.record(workspace);
        for (int x = 1; x <= 5; x++) {
            assertEquals(
                MiningWorkspaceStore.AppendResult.APPENDED,
                store.append(cell(x, 0), true, true)
            );
        }
        MiningWorkspaceTransaction transaction = new MiningWorkspaceTransaction();
        assertTrue(transaction.start(
            workspace.id(),
            "smelt-1",
            "smelt_raw_iron",
            "mission:SMELT_IRON",
            cell(5, 0),
            store.returnRoute(),
            store.resumeRoute(),
            store.breadcrumbCount(),
            store.sessionRevision(),
            store.trailRevision(),
            false,
            1_000L
        ));
        return new Fixture(store, workspace, transaction);
    }

    private static MiningWorkspaceRouteSuffixPlanner.Result plan(
        List<VoxelCell> connector,
        int rejoinIndex,
        int skippedCells
    ) {
        return new MiningWorkspaceRouteSuffixPlanner.Result(
            connector,
            connector.get(connector.size() - 1),
            rejoinIndex,
            skippedCells,
            "",
            9
        );
    }

    private static VoxelCell cell(int x, int z) {
        return new VoxelCell(x, 64, z);
    }

    private record Fixture(
        MiningWorkspaceStore store,
        MiningWorkspaceStore.Workspace workspace,
        MiningWorkspaceTransaction transaction
    ) {
    }
}
