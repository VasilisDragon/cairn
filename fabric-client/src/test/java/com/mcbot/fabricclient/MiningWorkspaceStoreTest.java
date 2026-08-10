package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;

class MiningWorkspaceStoreTest {
    @Test
    void contextChangesAndInvalidationClearSessionState() {
        MiningWorkspaceStore store = new MiningWorkspaceStore();
        assertTrue(store.observeContext("world-a", "overworld"));
        store.record(workspace());
        assertEquals(
            MiningWorkspaceStore.AppendResult.APPENDED,
            store.append(new VoxelCell(1, 64, 0), true, true)
        );

        assertTrue(store.observeContext("world-a", "nether"));
        assertNull(store.workspace());
        assertEquals(0, store.breadcrumbCount());

        store.record(workspace());
        store.invalidate();
        assertNull(store.workspace());
        assertEquals(0, store.breadcrumbCount());
    }

    @Test
    void canonicalAppendRequiresWorkspaceGroundingAndStandability() {
        MiningWorkspaceStore store = new MiningWorkspaceStore();
        VoxelCell next = new VoxelCell(1, 64, 0);
        assertEquals(
            MiningWorkspaceStore.AppendResult.REJECTED_NO_WORKSPACE,
            store.append(next, true, true)
        );

        store.observeContext("world-a", "overworld");
        store.record(workspace());
        assertEquals(
            MiningWorkspaceStore.AppendResult.UNCHANGED,
            store.append(workspace().stance(), true, true)
        );
        assertEquals(
            MiningWorkspaceStore.AppendResult.IGNORED_TRANSIENT,
            store.append(next, false, true)
        );
        assertEquals(
            MiningWorkspaceStore.AppendResult.IGNORED_TRANSIENT,
            store.append(next, true, false)
        );
        assertEquals(List.of(workspace().stance()), store.resumeRoute());
        assertEquals(
            MiningWorkspaceStore.AppendResult.APPENDED,
            store.append(next, true, true)
        );
    }

    @Test
    void sameColumnTransientYObservationsDoNotEnterTheRoute() {
        MiningWorkspaceStore store = recordedStore();
        VoxelCell stable = new VoxelCell(1, 64, 0);
        assertEquals(
            MiningWorkspaceStore.AppendResult.APPENDED,
            store.append(stable, true, true)
        );
        List<VoxelCell> before = store.resumeRoute();

        assertEquals(
            MiningWorkspaceStore.AppendResult.IGNORED_TRANSIENT,
            store.append(new VoxelCell(1, 65, 0), true, true)
        );
        assertEquals(
            MiningWorkspaceStore.AppendResult.IGNORED_TRANSIENT,
            store.append(new VoxelCell(1, 63, 0), true, true)
        );
        assertEquals(before, store.resumeRoute());
    }

    @Test
    void breadcrumbsAcceptOnlyReversibleAdjacentSteps() {
        MiningWorkspaceStore store = recordedStore();
        assertEquals(
            MiningWorkspaceStore.AppendResult.APPENDED,
            store.append(new VoxelCell(1, 64, 0), true, true)
        );
        assertEquals(
            MiningWorkspaceStore.AppendResult.APPENDED,
            store.append(new VoxelCell(2, 65, 0), true, true)
        );
        assertEquals(
            MiningWorkspaceStore.AppendResult.APPENDED,
            store.append(new VoxelCell(3, 64, 0), true, true)
        );
        List<VoxelCell> accepted = store.resumeRoute();

        assertEquals(
            MiningWorkspaceStore.AppendResult.REJECTED_DISCONNECTED,
            store.append(new VoxelCell(5, 64, 0), true, true)
        );
        assertEquals(
            MiningWorkspaceStore.AppendResult.REJECTED_DISCONNECTED,
            store.append(new VoxelCell(4, 64, 1), true, true)
        );
        assertEquals(
            MiningWorkspaceStore.AppendResult.REJECTED_DISCONNECTED,
            store.append(new VoxelCell(4, 66, 0), true, true)
        );
        assertEquals(accepted, store.resumeRoute());
    }

    @Test
    void breadcrumbsTruncateOnlyContiguousLoopsAndProduceRoundTripRoutes() {
        MiningWorkspaceStore store = recordedStore();
        VoxelCell first = new VoxelCell(1, 64, 0);
        store.append(first, true, true);
        store.append(new VoxelCell(1, 64, 1), true, true);
        store.append(new VoxelCell(2, 64, 1), true, true);
        store.append(new VoxelCell(2, 64, 0), true, true);
        assertEquals(
            MiningWorkspaceStore.AppendResult.LOOP_TRUNCATED,
            store.append(first, true, true)
        );
        assertEquals(
            MiningWorkspaceStore.AppendResult.APPENDED,
            store.append(new VoxelCell(1, 64, -1), true, true)
        );

        assertEquals(List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 64, 0),
            new VoxelCell(1, 64, -1)
        ), store.resumeRoute());
        assertEquals(List.of(
            new VoxelCell(1, 64, -1),
            new VoxelCell(1, 64, 0),
            new VoxelCell(0, 64, 0)
        ), store.returnRoute());
    }

    @Test
    void disconnectedExistingBreadcrumbDoesNotTruncateTheRoute() {
        MiningWorkspaceStore store = recordedStore();
        store.append(new VoxelCell(1, 64, 0), true, true);
        store.append(new VoxelCell(2, 64, 0), true, true);
        store.append(new VoxelCell(3, 64, 0), true, true);
        List<VoxelCell> before = store.resumeRoute();

        assertEquals(
            MiningWorkspaceStore.AppendResult.REJECTED_DISCONNECTED,
            store.append(new VoxelCell(1, 64, 0), true, true)
        );
        assertEquals(before, store.resumeRoute());
    }

    @Test
    void breadcrumbMemoryStopsAtTheFixedCap() {
        MiningWorkspaceStore store = recordedStore();
        for (int i = 1; i < MiningWorkspaceStore.MAX_BREADCRUMBS; i++) {
            assertEquals(
                MiningWorkspaceStore.AppendResult.APPENDED,
                store.append(new VoxelCell(i, 64, 0), true, true)
            );
        }
        assertEquals(MiningWorkspaceStore.MAX_BREADCRUMBS, store.breadcrumbCount());
        List<VoxelCell> before = store.resumeRoute();
        assertEquals(
            MiningWorkspaceStore.AppendResult.REJECTED_SATURATED,
            store.append(new VoxelCell(MiningWorkspaceStore.MAX_BREADCRUMBS, 64, 0), true, true)
        );
        assertEquals(before, store.resumeRoute());
        assertFalse(store.returnAvailableFrom(
            new VoxelCell(MiningWorkspaceStore.MAX_BREADCRUMBS, 64, 0)
        ));
    }

    @Test
    void returnAvailabilityRequiresAReversibleFrontierIngress() {
        MiningWorkspaceStore store = new MiningWorkspaceStore();
        VoxelCell frontier = new VoxelCell(2, 64, 0);
        assertFalse(store.returnAvailableFrom(frontier));

        store.observeContext("world-a", "overworld");
        store.record(workspace());
        store.append(new VoxelCell(1, 64, 0), true, true);
        store.append(frontier, true, true);

        assertTrue(store.returnAvailableFrom(frontier));
        assertTrue(store.returnAvailableFrom(new VoxelCell(3, 64, 0)));
        assertTrue(store.returnAvailableFrom(new VoxelCell(3, 65, 0)));
        assertFalse(store.returnAvailableFrom(new VoxelCell(2, 65, 0)));
        assertFalse(store.returnAvailableFrom(new VoxelCell(3, 64, 1)));
        assertFalse(store.returnAvailableFrom(new VoxelCell(3, 66, 0)));
        assertFalse(store.returnAvailableFrom(new VoxelCell(5, 64, 0)));
    }

    @Test
    void exactVerifiedWorkspaceStanceCanAtomicallyResetTheCanonicalTrail() {
        MiningWorkspaceStore store = recordedStore();
        store.append(new VoxelCell(1, 64, 0), true, true);
        store.append(new VoxelCell(2, 64, 0), true, true);
        long session = store.sessionRevision();
        long trail = store.trailRevision();

        assertEquals(
            MiningWorkspaceStore.ReanchorResult.INVALID_STANCE,
            store.reanchorAtWorkspaceStance(
                session,
                trail,
                store.workspace(),
                new VoxelCell(1, 64, 0),
                true,
                true
            )
        );
        assertEquals(3, store.breadcrumbCount());
        assertEquals(
            MiningWorkspaceStore.ReanchorResult.REANCHORED,
            store.reanchorAtWorkspaceStance(
                session,
                trail,
                store.workspace(),
                workspace().stance(),
                true,
                true
            )
        );
        assertEquals(List.of(workspace().stance()), store.trail());
        assertEquals(session, store.sessionRevision());
        assertEquals(trail + 1L, store.trailRevision());
        assertEquals(
            MiningWorkspaceStore.ReanchorResult.ALREADY_ANCHORED,
            store.reanchorAtWorkspaceStance(
                session,
                trail + 1L,
                store.workspace(),
                workspace().stance(),
                true,
                true
            )
        );
    }

    @Test
    void staleReanchorInputsLeaveTheTrailUnchanged() {
        MiningWorkspaceStore store = recordedStore();
        store.append(new VoxelCell(1, 64, 0), true, true);
        List<VoxelCell> before = store.trail();
        long session = store.sessionRevision();
        long trail = store.trailRevision();

        assertEquals(
            MiningWorkspaceStore.ReanchorResult.STALE_SESSION,
            store.reanchorAtWorkspaceStance(
                session - 1L,
                trail,
                store.workspace(),
                workspace().stance(),
                true,
                true
            )
        );
        assertEquals(
            MiningWorkspaceStore.ReanchorResult.STALE_TRAIL,
            store.reanchorAtWorkspaceStance(
                session,
                trail - 1L,
                store.workspace(),
                workspace().stance(),
                true,
                true
            )
        );
        assertEquals(before, store.trail());
    }

    @Test
    void connectorAppendAtomicallyExtendsTheRecordedTrail() {
        MiningWorkspaceStore store = recordedStore();
        store.append(new VoxelCell(1, 64, 0), true, true);
        long revision = store.sessionRevision();
        MiningWorkspaceStore.Workspace workspace = store.workspace();
        VoxelCell frontier = store.frontier();

        assertEquals(
            MiningWorkspaceStore.ConnectorAppendResult.RECONCILED,
            store.appendConnector(
                revision,
                workspace,
                frontier,
                List.of(
                    frontier,
                    new VoxelCell(2, 64, 0),
                    new VoxelCell(2, 65, 1),
                    new VoxelCell(3, 65, 1)
                )
            )
        );
        assertEquals(new VoxelCell(3, 65, 1), store.frontier());
        assertEquals(List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 64, 0),
            new VoxelCell(2, 64, 0),
            new VoxelCell(2, 65, 1),
            new VoxelCell(3, 65, 1)
        ), store.trail());
        assertEquals(store.trail(), store.resumeRoute());
        assertTrue(store.returnAvailableFrom(new VoxelCell(3, 65, 1)));
    }

    @Test
    void staleConnectorInputsNeverMutateTheTrail() {
        MiningWorkspaceStore store = recordedStore();
        VoxelCell frontier = store.frontier();
        long revision = store.sessionRevision();
        MiningWorkspaceStore.Workspace workspace = store.workspace();
        List<VoxelCell> connector = List.of(frontier, new VoxelCell(1, 64, 0));

        assertConnectorRejectionLeavesTrailUnchanged(
            store,
            MiningWorkspaceStore.ConnectorAppendResult.STALE_FRONTIER,
            revision,
            new MiningWorkspaceStore.Workspace(
                "other",
                workspace.stance(),
                workspace.tableSupport(),
                workspace.tablePlacement(),
                workspace.furnaceSupport(),
                workspace.furnacePlacement()
            ),
            frontier,
            connector
        );
        assertConnectorRejectionLeavesTrailUnchanged(
            store,
            MiningWorkspaceStore.ConnectorAppendResult.STALE_FRONTIER,
            revision,
            workspace,
            new VoxelCell(-1, 64, 0),
            connector
        );

        store.record(workspace);
        assertConnectorRejectionLeavesTrailUnchanged(
            store,
            MiningWorkspaceStore.ConnectorAppendResult.STALE_FRONTIER,
            revision,
            workspace,
            frontier,
            connector
        );
    }

    @Test
    void invalidConnectorShapeAndEdgesNeverPartiallyMutateTheTrail() {
        MiningWorkspaceStore store = recordedStore();
        long revision = store.sessionRevision();
        MiningWorkspaceStore.Workspace workspace = store.workspace();
        VoxelCell frontier = store.frontier();

        assertConnectorRejectionLeavesTrailUnchanged(
            store,
            MiningWorkspaceStore.ConnectorAppendResult.INVALID_CONNECTOR,
            revision,
            workspace,
            frontier,
            List.of(frontier)
        );
        assertConnectorRejectionLeavesTrailUnchanged(
            store,
            MiningWorkspaceStore.ConnectorAppendResult.INVALID_CONNECTOR,
            revision,
            workspace,
            frontier,
            List.of(new VoxelCell(1, 64, 0), new VoxelCell(2, 64, 0))
        );
        assertConnectorRejectionLeavesTrailUnchanged(
            store,
            MiningWorkspaceStore.ConnectorAppendResult.INVALID_CONNECTOR,
            revision,
            workspace,
            frontier,
            List.of(frontier, new VoxelCell(1, 64, 0), new VoxelCell(3, 64, 0))
        );
        assertConnectorRejectionLeavesTrailUnchanged(
            store,
            MiningWorkspaceStore.ConnectorAppendResult.INVALID_CONNECTOR,
            revision,
            workspace,
            frontier,
            List.of(frontier, new VoxelCell(1, 66, 0))
        );
        assertConnectorRejectionLeavesTrailUnchanged(
            store,
            MiningWorkspaceStore.ConnectorAppendResult.INVALID_CONNECTOR,
            revision,
            workspace,
            frontier,
            List.of(
                frontier,
                new VoxelCell(1, 64, 0),
                new VoxelCell(2, 64, 0),
                new VoxelCell(3, 64, 0),
                new VoxelCell(4, 64, 0),
                new VoxelCell(5, 64, 0),
                new VoxelCell(6, 64, 0),
                new VoxelCell(7, 64, 0),
                new VoxelCell(8, 64, 0)
            )
        );
    }

    @Test
    void connectorTrailIntersectionsAndDuplicatesNeverMutateTheTrail() {
        MiningWorkspaceStore store = recordedStore();
        store.append(new VoxelCell(1, 64, 0), true, true);
        long revision = store.sessionRevision();
        MiningWorkspaceStore.Workspace workspace = store.workspace();
        VoxelCell frontier = store.frontier();

        assertConnectorRejectionLeavesTrailUnchanged(
            store,
            MiningWorkspaceStore.ConnectorAppendResult.TRAIL_INTERSECTION,
            revision,
            workspace,
            frontier,
            List.of(frontier, new VoxelCell(1, 64, 1), new VoxelCell(0, 64, 1), workspace.stance())
        );
        assertConnectorRejectionLeavesTrailUnchanged(
            store,
            MiningWorkspaceStore.ConnectorAppendResult.TRAIL_INTERSECTION,
            revision,
            workspace,
            frontier,
            List.of(
                frontier,
                new VoxelCell(1, 64, 1),
                new VoxelCell(2, 64, 1),
                new VoxelCell(1, 64, 1)
            )
        );
    }

    @Test
    void connectorSaturationIsAtomicAndReadViewsAreImmutable() {
        MiningWorkspaceStore store = recordedStore();
        for (int index = 1; index < MiningWorkspaceStore.MAX_BREADCRUMBS; index++) {
            store.append(new VoxelCell(index, 64, 0), true, true);
        }
        long revision = store.sessionRevision();
        MiningWorkspaceStore.Workspace workspace = store.workspace();
        VoxelCell frontier = store.frontier();
        assertConnectorRejectionLeavesTrailUnchanged(
            store,
            MiningWorkspaceStore.ConnectorAppendResult.SATURATED,
            revision,
            workspace,
            frontier,
            List.of(frontier, new VoxelCell(MiningWorkspaceStore.MAX_BREADCRUMBS, 64, 0))
        );

        boolean immutable = false;
        try {
            store.trail().add(new VoxelCell(999, 64, 0));
        } catch (UnsupportedOperationException expected) {
            immutable = true;
        }
        assertTrue(immutable);
        assertEquals(MiningWorkspaceStore.MAX_BREADCRUMBS, store.breadcrumbCount());
    }

    @Test
    void trailRevisionChangesOnlyWhenBreadcrumbContentsChange() {
        MiningWorkspaceStore store = new MiningWorkspaceStore();
        long initial = store.trailRevision();
        store.observeContext("world-a", "overworld");
        assertEquals(initial, store.trailRevision());

        store.record(workspace());
        long recorded = store.trailRevision();
        assertTrue(recorded > initial);
        store.record(workspace());
        assertEquals(recorded, store.trailRevision());

        VoxelCell first = new VoxelCell(1, 64, 0);
        store.append(first, true, true);
        long appended = store.trailRevision();
        assertTrue(appended > recorded);
        store.append(first, true, true);
        store.append(new VoxelCell(1, 65, 0), true, true);
        store.append(new VoxelCell(3, 64, 0), true, true);
        assertEquals(appended, store.trailRevision());

        store.append(new VoxelCell(1, 64, 1), true, true);
        store.append(new VoxelCell(0, 64, 1), true, true);
        assertEquals(
            MiningWorkspaceStore.AppendResult.LOOP_TRUNCATED,
            store.append(workspace().stance(), true, true)
        );
        long truncated = store.trailRevision();
        assertTrue(truncated > appended);

        long sessionRevision = store.sessionRevision();
        assertEquals(
            MiningWorkspaceStore.ConnectorAppendResult.RECONCILED,
            store.appendConnector(
                sessionRevision,
                store.workspace(),
                store.frontier(),
                List.of(store.frontier(), new VoxelCell(1, 64, 0))
            )
        );
        long reconciled = store.trailRevision();
        assertTrue(reconciled > truncated);

        store.invalidate();
        long invalidated = store.trailRevision();
        assertTrue(invalidated > reconciled);
        store.invalidate();
        store.observeContext("world-b", "overworld");
        assertEquals(invalidated, store.trailRevision());
    }

    @Test
    void trailReplacementAtomicallyRepairsTheCanonicalRoundTrip() {
        MiningWorkspaceStore store = straightTrailStore(4);
        List<VoxelCell> before = store.trail();
        long trailRevision = store.trailRevision();
        List<VoxelCell> replacement = List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 64, 0),
            new VoxelCell(1, 64, 1),
            new VoxelCell(2, 64, 1),
            new VoxelCell(3, 64, 1),
            new VoxelCell(3, 64, 0),
            new VoxelCell(4, 64, 0)
        );

        assertEquals(
            MiningWorkspaceStore.TrailReplaceResult.REPLACED,
            store.replaceTrail(
                store.sessionRevision(),
                trailRevision,
                store.workspace(),
                before,
                replacement
            )
        );
        assertEquals(replacement, store.resumeRoute());
        assertEquals(List.of(
            new VoxelCell(4, 64, 0),
            new VoxelCell(3, 64, 0),
            new VoxelCell(3, 64, 1),
            new VoxelCell(2, 64, 1),
            new VoxelCell(1, 64, 1),
            new VoxelCell(1, 64, 0),
            new VoxelCell(0, 64, 0)
        ), store.returnRoute());
        assertTrue(store.trailRevision() > trailRevision);
        assertEquals(new VoxelCell(4, 64, 0), store.frontier());
    }

    @Test
    void staleTrailReplacementInputsAreClassifiedWithoutMutation() {
        MiningWorkspaceStore store = straightTrailStore(4);
        List<VoxelCell> before = store.trail();
        long sessionRevision = store.sessionRevision();
        long trailRevision = store.trailRevision();
        List<VoxelCell> replacement = bypassReplacement();
        MiningWorkspaceStore.Workspace workspace = store.workspace();

        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            MiningWorkspaceStore.TrailReplaceResult.STALE_WORKSPACE,
            sessionRevision,
            trailRevision,
            new MiningWorkspaceStore.Workspace(
                "other",
                workspace.stance(),
                workspace.tableSupport(),
                workspace.tablePlacement(),
                workspace.furnaceSupport(),
                workspace.furnacePlacement()
            ),
            before,
            replacement
        );
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            MiningWorkspaceStore.TrailReplaceResult.STALE_SESSION,
            sessionRevision - 1,
            trailRevision,
            workspace,
            before,
            replacement
        );
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            MiningWorkspaceStore.TrailReplaceResult.STALE_TRAIL,
            sessionRevision,
            trailRevision - 1,
            workspace,
            before,
            replacement
        );
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            MiningWorkspaceStore.TrailReplaceResult.STALE_TRAIL,
            sessionRevision,
            trailRevision,
            workspace,
            before.subList(0, before.size() - 1),
            replacement
        );
    }

    @Test
    void invalidTrailReplacementsNeverPartiallyMutateTheStore() {
        MiningWorkspaceStore store = straightTrailStore(4);
        List<VoxelCell> before = store.trail();
        long sessionRevision = store.sessionRevision();
        long trailRevision = store.trailRevision();
        MiningWorkspaceStore.Workspace workspace = store.workspace();

        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            MiningWorkspaceStore.TrailReplaceResult.INVALID_REPLACEMENT,
            sessionRevision,
            trailRevision,
            workspace,
            before,
            List.of(before.get(0))
        );
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            MiningWorkspaceStore.TrailReplaceResult.INVALID_REPLACEMENT,
            sessionRevision,
            trailRevision,
            workspace,
            before,
            List.of(
                new VoxelCell(-1, 64, 0),
                new VoxelCell(0, 64, 0),
                new VoxelCell(1, 64, 0),
                before.get(before.size() - 1)
            )
        );
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            MiningWorkspaceStore.TrailReplaceResult.INVALID_REPLACEMENT,
            sessionRevision,
            trailRevision,
            workspace,
            before,
            List.of(
                before.get(0),
                new VoxelCell(1, 64, 0),
                new VoxelCell(1, 64, 1),
                new VoxelCell(1, 64, 0),
                before.get(before.size() - 1)
            )
        );
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            MiningWorkspaceStore.TrailReplaceResult.INVALID_REPLACEMENT,
            sessionRevision,
            trailRevision,
            workspace,
            before,
            List.of(
                before.get(0),
                new VoxelCell(2, 64, 0),
                before.get(before.size() - 1)
            )
        );
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            MiningWorkspaceStore.TrailReplaceResult.INVALID_REPLACEMENT,
            sessionRevision,
            trailRevision,
            workspace,
            before,
            before
        );
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            MiningWorkspaceStore.TrailReplaceResult.INVALID_REPLACEMENT,
            sessionRevision,
            trailRevision,
            workspace,
            before,
            Arrays.asList(null, before.get(1), before.get(before.size() - 1))
        );
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            MiningWorkspaceStore.TrailReplaceResult.INVALID_REPLACEMENT,
            sessionRevision,
            trailRevision,
            workspace,
            before,
            Arrays.asList(before.get(0), before.get(1), null)
        );
    }

    @Test
    void replacementIntersectionsAndSaturationAreAtomic() {
        MiningWorkspaceStore store = straightTrailStore(4);
        List<VoxelCell> before = store.trail();
        long sessionRevision = store.sessionRevision();
        long trailRevision = store.trailRevision();
        MiningWorkspaceStore.Workspace workspace = store.workspace();

        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            MiningWorkspaceStore.TrailReplaceResult.TRAIL_INTERSECTION,
            sessionRevision,
            trailRevision,
            workspace,
            before,
            List.of(
                new VoxelCell(0, 64, 0),
                new VoxelCell(0, 64, 1),
                new VoxelCell(1, 64, 1),
                new VoxelCell(1, 64, 0),
                new VoxelCell(1, 64, -1),
                new VoxelCell(2, 64, -1),
                new VoxelCell(3, 64, -1),
                new VoxelCell(3, 64, 0),
                new VoxelCell(4, 64, 0)
            )
        );
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            MiningWorkspaceStore.TrailReplaceResult.SATURATED,
            sessionRevision,
            trailRevision,
            workspace,
            before,
            java.util.Collections.nCopies(
                MiningWorkspaceStore.MAX_BREADCRUMBS + 1,
                workspace.stance()
            )
        );
    }

    @Test
    void sessionRevisionChangesOnlyWhenTheWorkspaceSessionChanges() {
        MiningWorkspaceStore store = new MiningWorkspaceStore();
        long initial = store.sessionRevision();
        assertTrue(store.observeContext("world-a", "overworld"));
        long context = store.sessionRevision();
        assertTrue(context > initial);
        assertFalse(store.observeContext("world-a", "overworld"));
        assertEquals(context, store.sessionRevision());

        store.record(workspace());
        long recorded = store.sessionRevision();
        assertTrue(recorded > context);
        store.append(new VoxelCell(1, 64, 0), true, true);
        assertEquals(recorded, store.sessionRevision());

        store.invalidate();
        assertTrue(store.sessionRevision() > recorded);
    }

    private static void assertConnectorRejectionLeavesTrailUnchanged(
        MiningWorkspaceStore store,
        MiningWorkspaceStore.ConnectorAppendResult expectedResult,
        long expectedRevision,
        MiningWorkspaceStore.Workspace expectedWorkspace,
        VoxelCell expectedFrontier,
        List<VoxelCell> connector
    ) {
        List<VoxelCell> before = store.trail();
        assertEquals(
            expectedResult,
            store.appendConnector(
                expectedRevision,
                expectedWorkspace,
                expectedFrontier,
                connector
            )
        );
        assertEquals(before, store.trail());
    }

    private static void assertTrailReplacementRejectionLeavesStoreUnchanged(
        MiningWorkspaceStore store,
        MiningWorkspaceStore.TrailReplaceResult expectedResult,
        long expectedSessionRevision,
        long expectedTrailRevision,
        MiningWorkspaceStore.Workspace expectedWorkspace,
        List<VoxelCell> expectedTrail,
        List<VoxelCell> replacement
    ) {
        MiningWorkspaceStore.Workspace beforeWorkspace = store.workspace();
        List<VoxelCell> beforeTrail = store.trail();
        long beforeSessionRevision = store.sessionRevision();
        long beforeTrailRevision = store.trailRevision();
        assertEquals(
            expectedResult,
            store.replaceTrail(
                expectedSessionRevision,
                expectedTrailRevision,
                expectedWorkspace,
                expectedTrail,
                replacement
            )
        );
        assertEquals(beforeWorkspace, store.workspace());
        assertEquals(beforeTrail, store.trail());
        assertEquals(beforeSessionRevision, store.sessionRevision());
        assertEquals(beforeTrailRevision, store.trailRevision());
    }

    private static MiningWorkspaceStore recordedStore() {
        MiningWorkspaceStore store = new MiningWorkspaceStore();
        store.observeContext("world-a", "overworld");
        store.record(workspace());
        return store;
    }

    private static MiningWorkspaceStore straightTrailStore(int frontierX) {
        MiningWorkspaceStore store = recordedStore();
        for (int x = 1; x <= frontierX; x++) {
            store.append(new VoxelCell(x, 64, 0), true, true);
        }
        return store;
    }

    private static List<VoxelCell> bypassReplacement() {
        return List.of(
            new VoxelCell(0, 64, 0),
            new VoxelCell(1, 64, 0),
            new VoxelCell(1, 64, 1),
            new VoxelCell(2, 64, 1),
            new VoxelCell(3, 64, 1),
            new VoxelCell(3, 64, 0),
            new VoxelCell(4, 64, 0)
        );
    }

    private static MiningWorkspaceStore.Workspace workspace() {
        return new MiningWorkspaceStore.Workspace(
            "workspace:0",
            new VoxelCell(0, 64, 0),
            new VoxelCell(-1, 63, 0),
            new VoxelCell(-1, 64, 0),
            new VoxelCell(1, 63, 0),
            new VoxelCell(1, 64, 0)
        );
    }
}
