package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class SurfaceReturnTrailStoreTest {
    private static final int FEET_Y = 64;

    @Test
    void descentSegmentOwnershipIsScopedToTheActiveSurfaceExcursion() {
        TestWorld world = levelWorld(-2, 4, -1, 1);
        SurfaceReturnTrailStore store = new SurfaceReturnTrailStore();
        assertEquals(
            SurfaceReturnTrailStore.StartResult.STARTED,
            store.startSession("descent-new", cell(0, 0), true, world)
        );

        assertTrue(store.ownsDescentCommand("descent-new"));
        assertFalse(store.ownsDescentCommand("descent-stale"));
        assertTrue(store.admitDescentCommand("descent-recovery"));
        assertTrue(store.ownsDescentCommand("descent-recovery"));

        store.clearSession();
        assertFalse(store.ownsDescentCommand("descent-new"));
        assertFalse(store.ownsDescentCommand("descent-recovery"));
        assertFalse(store.admitDescentCommand("descent-after-cleanup"));
    }

    @Test
    void contextAndSessionLifecycleFreezeTheFirstAnchor() {
        TestWorld world = levelWorld(-2, 4, -2, 2);
        SurfaceReturnTrailStore store = new SurfaceReturnTrailStore();
        assertTrue(store.observeContext("world-a", "overworld"));
        assertEquals(
            SurfaceReturnTrailStore.StartResult.INVALID_ANCHOR,
            store.startSession("descent-1", cell(0, 0), false, world)
        );
        assertFalse(store.active());

        assertEquals(
            SurfaceReturnTrailStore.StartResult.STARTED,
            store.startSession("descent-1", cell(0, 0), true, world)
        );
        long sessionRevision = store.sessionRevision();
        assertEquals(
            SurfaceReturnTrailStore.StartResult.ALREADY_ACTIVE,
            store.startSession("descent-recovery", cell(3, 0), true, world)
        );
        assertEquals(cell(0, 0), store.anchor());
        assertEquals("descent-1", store.descentCommandId());
        assertEquals(sessionRevision, store.sessionRevision());

        assertFalse(store.observeContext("world-a", "overworld"));
        assertTrue(store.observeContext("world-a", "the_nether"));
        assertFalse(store.active());
        assertTrue(store.trail().isEmpty());
        assertEquals("the_nether", store.dimensionKey());
    }

    @Test
    void observedCellsRequireGroundedDrySafeBidirectionalTransitions() {
        TestWorld world = levelWorld(-1, 5, -1, 1);
        SurfaceReturnTrailStore store = startedStore(world);
        assertEquals(
            SurfaceReturnTrailStore.AppendResult.IGNORED_TRANSIENT,
            store.appendObserved(world, cell(1, 0), false)
        );
        world.water(1, FEET_Y, 0);
        assertEquals(
            SurfaceReturnTrailStore.AppendResult.REJECTED_UNSAFE,
            store.appendObserved(world, cell(1, 0), true)
        );

        TestWorld dry = levelWorld(-1, 5, -1, 1);
        assertEquals(
            SurfaceReturnTrailStore.AppendResult.APPENDED,
            store.appendObserved(dry, cell(1, 0), true)
        );
        List<VoxelCell> before = store.trail();
        assertEquals(
            SurfaceReturnTrailStore.AppendResult.IGNORED_TRANSIENT,
            store.appendObserved(dry, new VoxelCell(1, FEET_Y + 1, 0), true)
        );
        assertEquals(
            SurfaceReturnTrailStore.AppendResult.REJECTED_DISCONNECTED,
            store.appendObserved(dry, cell(3, 0), true)
        );
        assertEquals(before, store.trail());
    }

    @Test
    void completedSegmentsConcatenateWithoutRecoveryReseeding() {
        TestWorld world = descendingWorld();
        SurfaceReturnTrailStore store = new SurfaceReturnTrailStore();
        store.observeContext("world-a", "overworld");
        VoxelCell anchor = new VoxelCell(0, 70, 0);
        assertEquals(
            SurfaceReturnTrailStore.StartResult.STARTED,
            store.startSession("descent-1", anchor, true, world)
        );

        List<VoxelCell> first = List.of(
            anchor,
            new VoxelCell(1, 69, 0),
            new VoxelCell(2, 68, 0)
        );
        List<VoxelCell> second = List.of(
            first.getLast(),
            new VoxelCell(3, 67, 0),
            new VoxelCell(4, 66, 0)
        );
        List<VoxelCell> third = List.of(
            second.getLast(),
            new VoxelCell(5, 65, 0),
            new VoxelCell(6, 64, 0)
        );
        assertEquals(
            SurfaceReturnTrailStore.SegmentResult.APPENDED,
            store.appendCompletedSegment(world, first)
        );
        assertEquals(
            SurfaceReturnTrailStore.StartResult.ALREADY_ACTIVE,
            store.startSession("mine-iron-recovery", second.getFirst(), true, world)
        );
        assertEquals(
            SurfaceReturnTrailStore.SegmentResult.APPENDED,
            store.appendCompletedSegment(world, second)
        );
        assertEquals(
            SurfaceReturnTrailStore.SegmentResult.APPENDED,
            store.appendCompletedSegment(world, third)
        );

        assertEquals(List.of(
            new VoxelCell(0, 70, 0),
            new VoxelCell(1, 69, 0),
            new VoxelCell(2, 68, 0),
            new VoxelCell(3, 67, 0),
            new VoxelCell(4, 66, 0),
            new VoxelCell(5, 65, 0),
            new VoxelCell(6, 64, 0)
        ), store.trail());
        assertEquals(anchor, store.anchor());
        assertEquals("descent-1", store.descentCommandId());
    }

    @Test
    void invalidCompletedSegmentCannotPartiallyMutateTheTrail() {
        TestWorld world = levelWorld(-1, 8, -1, 1);
        SurfaceReturnTrailStore store = startedStore(world);
        List<VoxelCell> before = store.trail();
        long revision = store.trailRevision();

        assertEquals(
            SurfaceReturnTrailStore.SegmentResult.INVALID_SEGMENT,
            store.appendCompletedSegment(
                world,
                List.of(cell(0, 0), cell(1, 0), cell(4, 0))
            )
        );
        assertEquals(before, store.trail());
        assertEquals(revision, store.trailRevision());
        assertEquals(
            SurfaceReturnTrailStore.SegmentResult.STALE_FRONTIER,
            store.appendCompletedSegment(world, List.of(cell(1, 0), cell(2, 0)))
        );
        assertEquals(before, store.trail());
    }

    @Test
    void completedSegmentRejectsAtomicallyWhenARerouteDestroyedPriorStanceSupport() {
        TestWorld world = descendingWorld();
        SurfaceReturnTrailStore store = new SurfaceReturnTrailStore();
        store.observeContext("world-a", "overworld");
        VoxelCell anchor = new VoxelCell(0, 70, 0);
        assertEquals(
            SurfaceReturnTrailStore.StartResult.STARTED,
            store.startSession("descent-1", anchor, true, world)
        );

        List<VoxelCell> first = List.of(
            anchor,
            new VoxelCell(1, 69, 0),
            new VoxelCell(2, 68, 0)
        );
        assertEquals(
            SurfaceReturnTrailStore.SegmentResult.APPENDED,
            store.appendCompletedSegment(world, first)
        );
        List<VoxelCell> before = store.trail();
        long revision = store.trailRevision();

        // Mirrors the terminal-depth failure: the player had already reached x=3, then a turn's
        // clearance break removed that stance's support before the segment was committed.
        world.removeSupport(3, 66, 0);
        assertEquals(
            SurfaceReturnTrailStore.SegmentResult.INVALID_SEGMENT,
            store.appendCompletedSegment(
                world,
                List.of(
                    first.getLast(),
                    new VoxelCell(3, 67, 0),
                    new VoxelCell(4, 66, 0),
                    new VoxelCell(5, 65, 0)
                )
            )
        );
        assertEquals(before, store.trail());
        assertEquals(revision, store.trailRevision());
        assertEquals(first.getLast(), store.frontier());
    }

    @Test
    void directLoopTruncationProducesAnExactImmutableReturnRoute() {
        TestWorld world = levelWorld(-1, 4, -1, 2);
        SurfaceReturnTrailStore store = startedStore(world);
        for (VoxelCell cell : List.of(cell(1, 0), cell(1, 1), cell(2, 1), cell(2, 0))) {
            assertEquals(
                SurfaceReturnTrailStore.AppendResult.APPENDED,
                store.appendObserved(world, cell, true)
            );
        }
        assertEquals(
            SurfaceReturnTrailStore.AppendResult.LOOP_TRUNCATED,
            store.appendObserved(world, cell(1, 0), true)
        );
        assertEquals(
            SurfaceReturnTrailStore.AppendResult.APPENDED,
            store.appendObserved(world, cell(1, -1), true)
        );

        SurfaceReturnTrailStore.RouteSelection selected = store.selectReturnRoute(
            cell(1, -1),
            cell(0, 0)
        );
        assertTrue(selected.selected(), selected.failureReason());
        assertEquals(
            List.of(cell(1, -1), cell(1, 0), cell(0, 0)),
            selected.route()
        );
        boolean immutable = false;
        try {
            selected.route().add(cell(99, 0));
        } catch (UnsupportedOperationException expected) {
            immutable = true;
        }
        assertTrue(immutable);
    }

    @Test
    void nonAdjacentPriorCellObservationTruncatesAPartialReturnAtomically() {
        TestWorld world = levelWorld(-1, 6, -1, 1);
        SurfaceReturnTrailStore store = startedStore(world);
        for (int x = 1; x <= 5; x++) {
            assertEquals(
                SurfaceReturnTrailStore.AppendResult.APPENDED,
                store.appendObserved(world, cell(x, 0), true)
            );
        }
        long beforeRevision = store.trailRevision();

        assertEquals(
            SurfaceReturnTrailStore.AppendResult.LOOP_TRUNCATED,
            store.appendObserved(world, cell(2, 0), true)
        );
        assertEquals(List.of(cell(0, 0), cell(1, 0), cell(2, 0)), store.trail());
        assertEquals(cell(2, 0), store.frontier());
        assertEquals(beforeRevision + 1, store.trailRevision());
        assertTrue(store.selectReturnRoute(cell(2, 0), cell(0, 0)).selected());
    }

    @Test
    void routeAdmissionRequiresExactFrontierAndExactAnchorCoverage() {
        TestWorld world = levelWorld(-1, 5, -1, 1);
        SurfaceReturnTrailStore store = startedStore(world);
        store.appendObserved(world, cell(1, 0), true);
        store.appendObserved(world, cell(2, 0), true);

        assertRouteFailure("current_not_covered", store.selectReturnRoute(cell(1, 0), cell(0, 0)));
        assertRouteFailure("current_not_covered", store.selectReturnRoute(cell(3, 0), cell(0, 0)));
        assertRouteFailure("anchor_not_covered", store.selectReturnRoute(cell(2, 0), cell(-1, 0)));

        SurfaceReturnTrailStore.RouteSelection selected = store.selectReturnRoute(
            cell(2, 0),
            cell(0, 0)
        );
        assertTrue(selected.selected());
        assertEquals(List.of(cell(2, 0), cell(1, 0), cell(0, 0)), selected.route());
    }

    @Test
    void boundedGapReconciliationAtomicallyRestoresCoverage() {
        TestWorld world = levelWorld(-1, 4, -2, 1);
        SurfaceReturnTrailStore store = startedStore(world);
        assertEquals(
            SurfaceReturnTrailStore.AppendResult.REJECTED_DISCONNECTED,
            store.appendObserved(world, cell(2, 0), true)
        );

        SurfaceReturnTrailStore.GapReconcileResult result = store.reconcileGap(
            world,
            cell(2, 0),
            true
        );
        assertTrue(result.reconciled(), result.reason());
        assertEquals(3, result.connectorCells());
        assertEquals(List.of(cell(0, 0), cell(1, 0), cell(2, 0)), store.trail());
        assertTrue(store.remoteSuffixAvailable());
        assertTrue(store.selectReturnRoute(cell(2, 0), cell(0, 0)).selected());
    }

    @Test
    void failedGapIsDeduplicatedAndDirectAppendRestoresAvailability() {
        TestWorld world = new TestWorld(-1, 4, 60, 68, -2, 1);
        world.support(0, 63, 0);
        world.support(0, 63, -1);
        world.support(2, 63, 0);
        SurfaceReturnTrailStore store = startedStore(world);
        List<VoxelCell> before = store.trail();

        SurfaceReturnTrailStore.GapReconcileResult rejected = store.reconcileGap(
            world,
            cell(2, 0),
            true
        );
        assertEquals(SurfaceReturnTrailStore.GapStatus.REJECTED, rejected.status());
        assertEquals("no_safe_connector", rejected.reason());
        assertEquals(before, store.trail());
        assertFalse(store.remoteSuffixAvailable());
        assertRouteFailure(
            "remote_suffix_unavailable",
            store.selectReturnRoute(cell(0, 0), cell(0, 0))
        );

        SurfaceReturnTrailStore.GapReconcileResult duplicate = store.reconcileGap(
            world,
            cell(2, 0),
            true
        );
        assertEquals(SurfaceReturnTrailStore.GapStatus.DUPLICATE, duplicate.status());
        assertEquals(1, store.gapKeyCount());
        assertEquals(
            SurfaceReturnTrailStore.AppendResult.APPENDED,
            store.appendObserved(world, cell(0, -1), true)
        );
        assertTrue(store.remoteSuffixAvailable());
        assertTrue(store.selectReturnRoute(cell(0, -1), cell(0, 0)).selected());
    }

    @Test
    void exactReturnToRecordedFrontierRestoresAvailabilityAfterRejectedGap() {
        TestWorld world = new TestWorld(-1, 4, 60, 68, -1, 1);
        world.support(0, 63, 0);
        world.support(2, 63, 0);
        SurfaceReturnTrailStore store = startedStore(world);
        long rejectedRevision = store.trailRevision();

        SurfaceReturnTrailStore.GapReconcileResult rejected = store.reconcileGap(
            world,
            cell(2, 0),
            true
        );
        assertEquals(SurfaceReturnTrailStore.GapStatus.REJECTED, rejected.status());
        assertFalse(store.remoteSuffixAvailable());

        assertEquals(
            SurfaceReturnTrailStore.AppendResult.UNCHANGED,
            store.appendObserved(world, cell(0, 0), true)
        );
        assertTrue(store.remoteSuffixAvailable());
        assertEquals(rejectedRevision + 1L, store.trailRevision());
        assertEquals(0, store.gapKeyCount());
        assertTrue(store.selectReturnRoute(cell(0, 0), cell(0, 0)).selected());

        long restoredRevision = store.trailRevision();
        assertEquals(
            SurfaceReturnTrailStore.AppendResult.UNCHANGED,
            store.appendObserved(world, cell(0, 0), true)
        );
        assertEquals(restoredRevision, store.trailRevision());

        world.support(1, 63, 0);
        assertEquals(
            SurfaceReturnTrailStore.AppendResult.REJECTED_DISCONNECTED,
            store.appendObserved(world, cell(2, 0), true)
        );
        SurfaceReturnTrailStore.GapReconcileResult retried = store.reconcileGap(
            world,
            cell(2, 0),
            true
        );
        assertTrue(retried.reconciled(), retried.reason());
        assertEquals(List.of(cell(0, 0), cell(1, 0), cell(2, 0)), store.trail());
    }

    @Test
    void completedSegmentKeepsMaximalReversiblePrefixBeforeOneWaySafeFall() {
        TestWorld world = new TestWorld(-1, 5, 56, 68, -1, 1);
        world.support(0, 63, 0);
        world.support(1, 62, 0);
        world.support(2, 61, 0);
        world.support(3, 58, 0);
        SurfaceReturnTrailStore store = startedStore(world);
        VoxelCell firstStep = new VoxelCell(1, 63, 0);
        VoxelCell secondStep = new VoxelCell(2, 62, 0);
        VoxelCell safeFallLanding = new VoxelCell(3, 59, 0);

        SurfaceReturnTrailStore.SegmentResult result = store.appendCompletedSegment(
            world,
            List.of(cell(0, 0), firstStep, secondStep, safeFallLanding)
        );

        assertEquals(SurfaceReturnTrailStore.SegmentResult.APPENDED, result);
        assertEquals(List.of(cell(0, 0), firstStep, secondStep), store.trail());
        assertEquals(secondStep, store.frontier());
        assertFalse(store.remoteSuffixAvailable());

        long rejectedRevision = store.trailRevision();
        assertEquals(
            SurfaceReturnTrailStore.SegmentResult.UNCHANGED,
            store.appendCompletedSegment(world, List.of(secondStep, safeFallLanding))
        );
        assertEquals(rejectedRevision, store.trailRevision());
    }

    @Test
    void rejectedFailedSegmentSuffixRevisesAvailabilityEvenWithoutNewCells() {
        TestWorld world = new TestWorld(-1, 3, 58, 68, -1, 1);
        world.support(0, 63, 0);
        world.support(1, 59, 0);
        SurfaceReturnTrailStore store = startedStore(world);
        long availableRevision = store.trailRevision();

        assertEquals(
            SurfaceReturnTrailStore.SegmentResult.UNCHANGED,
            store.appendFailedSegmentPrefix(
                world,
                List.of(cell(0, 0), new VoxelCell(1, 60, 0))
            )
        );
        assertFalse(store.remoteSuffixAvailable());
        assertEquals(availableRevision + 1L, store.trailRevision());
    }

    @Test
    void reconciledGapCanRepeatAfterTrailRevisitChangesRevision() {
        TestWorld world = levelWorld(-1, 4, -1, 1);
        SurfaceReturnTrailStore store = startedStore(world);

        assertEquals(
            SurfaceReturnTrailStore.AppendResult.REJECTED_DISCONNECTED,
            store.appendObserved(world, cell(2, 0), true)
        );
        SurfaceReturnTrailStore.GapReconcileResult first = store.reconcileGap(
            world,
            cell(2, 0),
            true
        );
        assertTrue(first.reconciled(), first.reason());
        assertEquals(List.of(cell(0, 0), cell(1, 0), cell(2, 0)), store.trail());

        assertEquals(
            SurfaceReturnTrailStore.AppendResult.LOOP_TRUNCATED,
            store.appendObserved(world, cell(0, 0), true)
        );
        assertEquals(List.of(cell(0, 0)), store.trail());
        assertEquals(
            SurfaceReturnTrailStore.AppendResult.REJECTED_DISCONNECTED,
            store.appendObserved(world, cell(2, 0), true)
        );

        SurfaceReturnTrailStore.GapReconcileResult repeated = store.reconcileGap(
            world,
            cell(2, 0),
            true
        );
        assertTrue(repeated.reconciled(), repeated.reason());
        assertEquals(List.of(cell(0, 0), cell(1, 0), cell(2, 0)), store.trail());
        assertEquals(2, store.gapKeyCount());
    }

    @Test
    void connectorValidationAndGapKeyCapAreAtomic() {
        TestWorld world = levelWorld(-5, 5, -5, 5);
        SurfaceReturnTrailStore store = startedStore(world);
        List<VoxelCell> before = store.trail();
        long sessionRevision = store.sessionRevision();
        long trailRevision = store.trailRevision();

        assertEquals(
            SurfaceReturnTrailStore.ConnectorAppendResult.STALE_SESSION,
            store.appendConnector(
                sessionRevision - 1,
                trailRevision,
                store.frontier(),
                world,
                List.of(cell(0, 0), cell(1, 0))
            )
        );
        assertEquals(
            SurfaceReturnTrailStore.ConnectorAppendResult.INVALID_CONNECTOR,
            store.appendConnector(
                sessionRevision,
                trailRevision,
                store.frontier(),
                world,
                List.of(cell(0, 0), cell(2, 0))
            )
        );
        assertEquals(before, store.trail());
        assertEquals(trailRevision, store.trailRevision());

        TestWorld isolated = new TestWorld(-5, 5, 58, 70, -5, 5);
        isolated.support(0, 63, 0);
        SurfaceReturnTrailStore capped = startedStore(isolated);
        List<VoxelCell> candidates = isolatedGoals();
        for (int index = 0; index < SurfaceReturnTrailStore.MAX_GAP_KEYS; index++) {
            VoxelCell current = candidates.get(index);
            isolated.support(current.x(), current.y() - 1, current.z());
            SurfaceReturnTrailStore.GapReconcileResult result = capped.reconcileGap(
                isolated,
                current,
                true
            );
            assertEquals(SurfaceReturnTrailStore.GapStatus.REJECTED, result.status());
            isolated.removeSupport(current.x(), current.y() - 1, current.z());
        }
        VoxelCell extra = candidates.get(SurfaceReturnTrailStore.MAX_GAP_KEYS);
        isolated.support(extra.x(), extra.y() - 1, extra.z());
        assertEquals(
            SurfaceReturnTrailStore.GapStatus.KEY_LIMIT,
            capped.reconcileGap(isolated, extra, true).status()
        );
        assertEquals(SurfaceReturnTrailStore.MAX_GAP_KEYS, capped.gapKeyCount());
        assertEquals(List.of(cell(0, 0)), capped.trail());
    }

    @Test
    void trailReplacementAtomicallyRepairsTheCanonicalSurfaceRoute() {
        TestWorld world = levelWorld(-1, 5, -2, 2);
        SurfaceReturnTrailStore store = startedStore(world);
        for (int x = 1; x <= 4; x++) {
            assertEquals(
                SurfaceReturnTrailStore.AppendResult.APPENDED,
                store.appendObserved(world, cell(x, 0), true)
            );
        }
        List<VoxelCell> before = store.trail();
        long sessionRevision = store.sessionRevision();
        long trailRevision = store.trailRevision();
        List<VoxelCell> replacement = List.of(
            cell(0, 0),
            new VoxelCell(0, FEET_Y + 1, 1),
            new VoxelCell(1, FEET_Y, 1),
            new VoxelCell(2, FEET_Y, 1),
            cell(2, 0),
            cell(3, 0),
            cell(4, 0)
        );

        assertEquals(
            SurfaceReturnTrailStore.TrailReplaceResult.REPLACED,
            store.replaceTrail(
                sessionRevision,
                trailRevision,
                cell(0, 0),
                before,
                replacement
            )
        );
        assertEquals(replacement, store.trail());
        assertEquals(cell(0, 0), store.anchor());
        assertEquals(cell(4, 0), store.frontier());
        assertEquals(sessionRevision, store.sessionRevision());
        assertEquals(trailRevision + 1L, store.trailRevision());
        assertTrue(store.remoteSuffixAvailable());
        assertEquals(
            List.of(
                cell(4, 0),
                cell(3, 0),
                cell(2, 0),
                new VoxelCell(2, FEET_Y, 1),
                new VoxelCell(1, FEET_Y, 1),
                new VoxelCell(0, FEET_Y + 1, 1),
                cell(0, 0)
            ),
            store.selectReturnRoute(cell(4, 0), cell(0, 0)).route()
        );
    }

    @Test
    void staleTrailReplacementInputsAreClassifiedWithoutMutation() {
        TestWorld world = levelWorld(-1, 5, -2, 2);
        SurfaceReturnTrailStore store = straightTrailStore(world, 4);
        List<VoxelCell> before = store.trail();
        long sessionRevision = store.sessionRevision();
        long trailRevision = store.trailRevision();
        List<VoxelCell> replacement = bypassReplacement();

        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            SurfaceReturnTrailStore.TrailReplaceResult.STALE_SESSION,
            sessionRevision - 1,
            trailRevision,
            cell(0, 0),
            before,
            replacement
        );
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            SurfaceReturnTrailStore.TrailReplaceResult.STALE_ANCHOR,
            sessionRevision,
            trailRevision,
            cell(-1, 0),
            before,
            replacement
        );
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            SurfaceReturnTrailStore.TrailReplaceResult.STALE_TRAIL,
            sessionRevision,
            trailRevision - 1,
            cell(0, 0),
            before,
            replacement
        );
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            SurfaceReturnTrailStore.TrailReplaceResult.STALE_TRAIL,
            sessionRevision,
            trailRevision,
            cell(0, 0),
            before.subList(0, before.size() - 1),
            replacement
        );
    }

    @Test
    void verifiedShaftPrefixAtomicallyReplacesACraftingDetour() {
        TestWorld world = levelWorld(-1, 5, -2, 2);
        SurfaceReturnTrailStore store = startedStore(world);
        List<VoxelCell> liveDetour = List.of(
            cell(0, 0),
            cell(1, 0),
            cell(2, 0),
            cell(2, 1),
            cell(3, 1)
        );
        for (int index = 1; index < liveDetour.size(); index++) {
            assertEquals(
                SurfaceReturnTrailStore.AppendResult.APPENDED,
                store.appendObserved(world, liveDetour.get(index), true)
            );
        }
        List<VoxelCell> verifiedShaft = List.of(
            cell(0, 0),
            cell(1, 0),
            cell(2, 0),
            cell(3, 0),
            cell(4, 0)
        );
        long sessionRevision = store.sessionRevision();
        long trailRevision = store.trailRevision();

        assertEquals(
            SurfaceReturnTrailStore.TrailReplaceResult.REPLACED,
            store.restoreVerifiedPrefix(
                sessionRevision,
                trailRevision,
                cell(0, 0),
                liveDetour,
                verifiedShaft
            )
        );
        assertEquals(verifiedShaft, store.trail());
        assertEquals(cell(4, 0), store.frontier());
        assertEquals(sessionRevision, store.sessionRevision());
        assertEquals(trailRevision + 1L, store.trailRevision());
        assertTrue(store.remoteSuffixAvailable());
    }

    @Test
    void availabilityOnlyVerifiedPrefixRestoreAdvancesRevisionExactlyOnce() {
        TestWorld world = levelWorld(-1, 10, -1, 1);
        SurfaceReturnTrailStore store = straightTrailStore(world, 2);
        List<VoxelCell> verified = store.trail();

        VoxelCell disconnected = cell(8, 0);
        assertEquals(
            SurfaceReturnTrailStore.AppendResult.REJECTED_DISCONNECTED,
            store.appendObserved(world, disconnected, true)
        );
        SurfaceReturnTrailStore.GapReconcileResult gap = store.reconcileGap(
            world,
            disconnected,
            true
        );
        assertEquals(SurfaceReturnTrailStore.GapStatus.REJECTED, gap.status());
        assertFalse(store.remoteSuffixAvailable());
        assertEquals(verified, store.trail());

        long unavailableRevision = store.trailRevision();
        assertEquals(
            SurfaceReturnTrailStore.TrailReplaceResult.REPLACED,
            store.restoreVerifiedPrefix(
                store.sessionRevision(),
                unavailableRevision,
                cell(0, 0),
                verified,
                verified
            )
        );
        assertEquals(unavailableRevision + 1L, store.trailRevision());
        assertEquals(verified, store.trail());
        assertTrue(store.remoteSuffixAvailable());

        long availableRevision = store.trailRevision();
        assertEquals(
            SurfaceReturnTrailStore.TrailReplaceResult.REPLACED,
            store.restoreVerifiedPrefix(
                store.sessionRevision(),
                availableRevision,
                cell(0, 0),
                verified,
                verified
            )
        );
        assertEquals(availableRevision, store.trailRevision());
        assertEquals(verified, store.trail());
        assertTrue(store.remoteSuffixAvailable());
    }

    @Test
    void staleVerifiedPrefixRestoreRejectsWithoutAnyPartialMutation() {
        TestWorld world = levelWorld(-2, 6, -2, 2);
        SurfaceReturnTrailStore store = straightTrailStore(world, 3);
        List<VoxelCell> current = store.trail();
        List<VoxelCell> verified = List.of(
            cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0), cell(4, 0));
        long session = store.sessionRevision();
        long revision = store.trailRevision();

        assertVerifiedRestoreLeavesStoreUnchanged(
            store,
            SurfaceReturnTrailStore.TrailReplaceResult.STALE_SESSION,
            session - 1,
            revision,
            cell(0, 0),
            current,
            verified
        );
        assertVerifiedRestoreLeavesStoreUnchanged(
            store,
            SurfaceReturnTrailStore.TrailReplaceResult.STALE_TRAIL,
            session,
            revision - 1,
            cell(0, 0),
            current,
            verified
        );
        assertVerifiedRestoreLeavesStoreUnchanged(
            store,
            SurfaceReturnTrailStore.TrailReplaceResult.STALE_ANCHOR,
            session,
            revision,
            cell(-1, 0),
            current,
            verified
        );
        assertVerifiedRestoreLeavesStoreUnchanged(
            store,
            SurfaceReturnTrailStore.TrailReplaceResult.STALE_TRAIL,
            session,
            revision,
            cell(0, 0),
            current.subList(0, current.size() - 1),
            verified
        );
    }

    @Test
    void invalidTrailReplacementNeverPartiallyMutatesTheStore() {
        TestWorld world = levelWorld(-2, 8, -3, 3);
        SurfaceReturnTrailStore store = straightTrailStore(world, 4);
        List<VoxelCell> before = store.trail();
        long sessionRevision = store.sessionRevision();
        long trailRevision = store.trailRevision();

        for (List<VoxelCell> invalid : List.of(
            before,
            List.of(cell(0, 0)),
            List.of(cell(0, 0), cell(0, 1), cell(0, 0), cell(4, 0)),
            List.of(cell(0, 0), cell(1, 1), cell(4, 0)),
            List.of(cell(0, 0), new VoxelCell(1, FEET_Y + 2, 0), cell(4, 0)),
            List.of(cell(0, 0), cell(0, 1), cell(4, 1))
        )) {
            assertTrailReplacementRejectionLeavesStoreUnchanged(
                store,
                SurfaceReturnTrailStore.TrailReplaceResult.INVALID_REPLACEMENT,
                sessionRevision,
                trailRevision,
                cell(0, 0),
                before,
                invalid
            );
        }

        List<VoxelCell> intersectsRemovedMiddle = List.of(
            cell(0, 0),
            cell(0, 1),
            cell(1, 1),
            cell(2, 1),
            cell(2, 0),
            cell(2, -1),
            cell(3, -1),
            cell(4, -1),
            cell(4, 0)
        );
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            SurfaceReturnTrailStore.TrailReplaceResult.TRAIL_INTERSECTION,
            sessionRevision,
            trailRevision,
            cell(0, 0),
            before,
            intersectsRemovedMiddle
        );

        List<VoxelCell> oversized = new ArrayList<>();
        for (int x = 0; x <= SurfaceReturnTrailStore.MAX_TRAIL_CELLS; x++) {
            oversized.add(new VoxelCell(x, FEET_Y, 0));
        }
        assertTrailReplacementRejectionLeavesStoreUnchanged(
            store,
            SurfaceReturnTrailStore.TrailReplaceResult.SATURATED,
            sessionRevision,
            trailRevision,
            cell(0, 0),
            before,
            oversized
        );
    }

    @Test
    void maximumSizedUniqueReplacementIsAccepted() {
        TestWorld world = levelWorld(-1, 4, -1, 1);
        SurfaceReturnTrailStore store = straightTrailStore(world, 3);
        List<VoxelCell> before = store.trail();
        long trailRevision = store.trailRevision();
        List<VoxelCell> replacement = new ArrayList<>(SurfaceReturnTrailStore.MAX_TRAIL_CELLS);
        replacement.add(cell(0, 0));
        replacement.add(cell(0, 1));
        for (int x = 1; x <= 2048; x++) {
            replacement.add(cell(x, 1));
        }
        replacement.add(cell(2048, 0));
        for (int x = 2047; x >= 3; x--) {
            replacement.add(cell(x, 0));
        }

        assertEquals(SurfaceReturnTrailStore.MAX_TRAIL_CELLS, replacement.size());
        assertEquals(
            SurfaceReturnTrailStore.TrailReplaceResult.REPLACED,
            store.replaceTrail(
                store.sessionRevision(),
                trailRevision,
                cell(0, 0),
                before,
                replacement
            )
        );
        assertEquals(replacement, store.trail());
        assertEquals(trailRevision + 1L, store.trailRevision());
    }

    @Test
    void saturationRetainsBytesAndInvalidatesRemoteReplay() {
        TestWorld world = levelWorld(-1, SurfaceReturnTrailStore.MAX_TRAIL_CELLS + 1, -1, 1);
        SurfaceReturnTrailStore store = startedStore(world);
        for (int x = 1; x < SurfaceReturnTrailStore.MAX_TRAIL_CELLS; x++) {
            assertEquals(
                SurfaceReturnTrailStore.AppendResult.APPENDED,
                store.appendObserved(world, cell(x, 0), true)
            );
        }
        assertEquals(SurfaceReturnTrailStore.MAX_TRAIL_CELLS, store.trailCount());
        List<VoxelCell> before = store.trail();
        assertEquals(
            SurfaceReturnTrailStore.AppendResult.REJECTED_SATURATED,
            store.appendObserved(world, cell(SurfaceReturnTrailStore.MAX_TRAIL_CELLS, 0), true)
        );
        assertEquals(before, store.trail());
        assertTrue(store.saturated());
        assertRouteFailure(
            "trail_saturated",
            store.selectReturnRoute(before.getLast(), cell(0, 0))
        );
    }

    @Test
    void liveTrailInvalidationIsAtomicAndDoesNotMutateCanonicalCells() {
        TestWorld world = levelWorld(-1, 4, -1, 1);
        SurfaceReturnTrailStore store = straightTrailStore(world, 3);
        long session = store.sessionRevision();
        long revision = store.trailRevision();
        List<VoxelCell> trail = store.trail();

        assertEquals(
            SurfaceReturnTrailStore.RemoteSuffixInvalidateResult.STALE_SESSION,
            store.invalidateRemoteSuffix(session - 1, revision, trail)
        );
        assertEquals(
            SurfaceReturnTrailStore.RemoteSuffixInvalidateResult.STALE_TRAIL,
            store.invalidateRemoteSuffix(session, revision - 1, trail)
        );
        assertTrue(store.remoteSuffixAvailable());
        assertEquals(trail, store.trail());

        assertEquals(
            SurfaceReturnTrailStore.RemoteSuffixInvalidateResult.INVALIDATED,
            store.invalidateRemoteSuffix(session, revision, trail)
        );
        assertFalse(store.remoteSuffixAvailable());
        assertEquals(trail, store.trail());
        assertEquals(revision + 1, store.trailRevision());
        assertEquals(
            SurfaceReturnTrailStore.RemoteSuffixInvalidateResult.UNCHANGED,
            store.invalidateRemoteSuffix(session, revision + 1, trail)
        );
        assertEquals(revision + 1, store.trailRevision());
    }

    @Test
    void structuralInvalidationSurvivesOrdinaryObservationsAndGapReconciliation() {
        TestWorld world = levelWorld(-1, 8, -1, 1);
        SurfaceReturnTrailStore store = straightTrailStore(world, 4);
        List<VoxelCell> invalidatedTrail = store.trail();

        assertEquals(
            SurfaceReturnTrailStore.RemoteSuffixInvalidateResult.INVALIDATED,
            store.invalidateRemoteSuffix(
                store.sessionRevision(),
                store.trailRevision(),
                invalidatedTrail
            )
        );
        long invalidatedRevision = store.trailRevision();

        assertEquals(
            SurfaceReturnTrailStore.AppendResult.UNCHANGED,
            store.appendObserved(world, cell(4, 0), true)
        );
        assertEquals(invalidatedRevision, store.trailRevision());
        assertFalse(store.remoteSuffixAvailable());

        assertEquals(
            SurfaceReturnTrailStore.AppendResult.APPENDED,
            store.appendObserved(world, cell(5, 0), true)
        );
        assertFalse(store.remoteSuffixAvailable());

        assertEquals(
            SurfaceReturnTrailStore.AppendResult.LOOP_TRUNCATED,
            store.appendObserved(world, cell(3, 0), true)
        );
        assertEquals(List.of(cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0)), store.trail());
        assertFalse(store.remoteSuffixAvailable());

        List<VoxelCell> beforeGap = store.trail();
        long beforeGapRevision = store.trailRevision();
        SurfaceReturnTrailStore.GapReconcileResult gap = store.reconcileGap(
            world,
            cell(5, 0),
            true
        );
        assertEquals(SurfaceReturnTrailStore.GapStatus.REJECTED, gap.status());
        assertEquals("remote_suffix_structurally_invalid", gap.reason());
        assertEquals(0, gap.expandedCells());
        assertEquals(beforeGap, store.trail());
        assertEquals(beforeGapRevision, store.trailRevision());
        assertFalse(store.remoteSuffixAvailable());
        assertEquals(
            SurfaceReturnTrailStore.ConnectorAppendResult.STRUCTURALLY_INVALID,
            store.appendConnector(
                store.sessionRevision(),
                beforeGapRevision,
                cell(3, 0),
                world,
                List.of(cell(3, 0), cell(4, 0))
            )
        );
        assertEquals(beforeGap, store.trail());
        assertEquals(beforeGapRevision, store.trailRevision());
        assertRouteFailure(
            "remote_suffix_unavailable",
            store.selectReturnRoute(cell(3, 0), cell(0, 0))
        );
    }

    @Test
    void validatedRouteReplacementExplicitlyRestoresStructurallyInvalidTrail() {
        TestWorld world = levelWorld(-1, 5, -2, 2);
        SurfaceReturnTrailStore store = straightTrailStore(world, 4);
        List<VoxelCell> brokenTrail = store.trail();

        assertEquals(
            SurfaceReturnTrailStore.RemoteSuffixInvalidateResult.INVALIDATED,
            store.invalidateRemoteSuffix(
                store.sessionRevision(),
                store.trailRevision(),
                brokenTrail
            )
        );
        long invalidatedRevision = store.trailRevision();
        List<VoxelCell> replacement = bypassReplacement();

        assertEquals(
            SurfaceReturnTrailStore.TrailReplaceResult.INVALID_REPLACEMENT,
            store.replaceTrail(
                store.sessionRevision(),
                invalidatedRevision,
                cell(0, 0),
                brokenTrail,
                brokenTrail
            )
        );
        assertEquals(brokenTrail, store.trail());
        assertEquals(invalidatedRevision, store.trailRevision());
        assertFalse(store.remoteSuffixAvailable());

        assertEquals(
            SurfaceReturnTrailStore.TrailReplaceResult.REPLACED,
            store.replaceTrail(
                store.sessionRevision(),
                invalidatedRevision,
                cell(0, 0),
                brokenTrail,
                replacement
            )
        );
        assertEquals(replacement, store.trail());
        assertEquals(invalidatedRevision + 1L, store.trailRevision());
        assertTrue(store.remoteSuffixAvailable());
        assertTrue(store.selectReturnRoute(cell(4, 0), cell(0, 0)).selected());
    }

    @Test
    void exactVerifiedReanchorExplicitlyRestoresStructurallyInvalidTrail() {
        TestWorld world = levelWorld(-1, 4, -1, 1);
        SurfaceReturnTrailStore store = straightTrailStore(world, 3);
        List<VoxelCell> verifiedTrail = store.trail();

        assertEquals(
            SurfaceReturnTrailStore.RemoteSuffixInvalidateResult.INVALIDATED,
            store.invalidateRemoteSuffix(
                store.sessionRevision(),
                store.trailRevision(),
                verifiedTrail
            )
        );
        long invalidatedRevision = store.trailRevision();

        assertEquals(
            SurfaceReturnTrailStore.TrailReplaceResult.REPLACED,
            store.restoreVerifiedPrefix(
                store.sessionRevision(),
                invalidatedRevision,
                cell(0, 0),
                verifiedTrail,
                verifiedTrail
            )
        );
        assertEquals(verifiedTrail, store.trail());
        assertEquals(invalidatedRevision + 1L, store.trailRevision());
        assertTrue(store.remoteSuffixAvailable());
    }

    @Test
    void verifiedFinishClearsOnlyTheExpectedSessionAtTheAnchor() {
        TestWorld world = levelWorld(-1, 3, -1, 1);
        SurfaceReturnTrailStore store = startedStore(world);
        long sessionRevision = store.sessionRevision();
        assertEquals(
            SurfaceReturnTrailStore.FinishResult.STALE_SESSION,
            store.finishAtAnchor(sessionRevision - 1, cell(0, 0), true, world)
        );
        assertEquals(
            SurfaceReturnTrailStore.FinishResult.NOT_AT_ANCHOR,
            store.finishAtAnchor(sessionRevision, cell(1, 0), true, world)
        );
        assertEquals(
            SurfaceReturnTrailStore.FinishResult.INVALID_STANCE,
            store.finishAtAnchor(sessionRevision, cell(0, 0), false, world)
        );
        assertTrue(store.active());
        assertEquals(
            SurfaceReturnTrailStore.FinishResult.FINISHED,
            store.finishAtAnchor(sessionRevision, cell(0, 0), true, world)
        );
        assertFalse(store.active());
        assertTrue(store.trail().isEmpty());
        assertEquals(
            SurfaceReturnTrailStore.FinishResult.NO_SESSION,
            store.finishAtAnchor(store.sessionRevision(), cell(0, 0), true, world)
        );
    }

    private static SurfaceReturnTrailStore startedStore(TestWorld world) {
        SurfaceReturnTrailStore store = new SurfaceReturnTrailStore();
        store.observeContext("world-a", "overworld");
        assertEquals(
            SurfaceReturnTrailStore.StartResult.STARTED,
            store.startSession("descent-1", cell(0, 0), true, world)
        );
        return store;
    }

    private static SurfaceReturnTrailStore straightTrailStore(TestWorld world, int length) {
        SurfaceReturnTrailStore store = startedStore(world);
        for (int x = 1; x <= length; x++) {
            assertEquals(
                SurfaceReturnTrailStore.AppendResult.APPENDED,
                store.appendObserved(world, cell(x, 0), true)
            );
        }
        return store;
    }

    private static List<VoxelCell> bypassReplacement() {
        return List.of(
            cell(0, 0),
            cell(0, 1),
            cell(1, 1),
            cell(2, 1),
            cell(3, 1),
            cell(4, 1),
            cell(4, 0)
        );
    }

    private static void assertTrailReplacementRejectionLeavesStoreUnchanged(
        SurfaceReturnTrailStore store,
        SurfaceReturnTrailStore.TrailReplaceResult expectedResult,
        long expectedSessionRevision,
        long expectedTrailRevision,
        VoxelCell expectedAnchor,
        List<VoxelCell> expectedTrail,
        List<VoxelCell> replacement
    ) {
        StoreSnapshot before = StoreSnapshot.capture(store);
        assertEquals(
            expectedResult,
            store.replaceTrail(
                expectedSessionRevision,
                expectedTrailRevision,
                expectedAnchor,
                expectedTrail,
                replacement
            )
        );
        assertEquals(before, StoreSnapshot.capture(store));
    }

    private static void assertVerifiedRestoreLeavesStoreUnchanged(
        SurfaceReturnTrailStore store,
        SurfaceReturnTrailStore.TrailReplaceResult expectedResult,
        long expectedSessionRevision,
        long expectedTrailRevision,
        VoxelCell expectedAnchor,
        List<VoxelCell> expectedTrail,
        List<VoxelCell> verifiedPrefix
    ) {
        StoreSnapshot before = StoreSnapshot.capture(store);
        assertEquals(
            expectedResult,
            store.restoreVerifiedPrefix(
                expectedSessionRevision,
                expectedTrailRevision,
                expectedAnchor,
                expectedTrail,
                verifiedPrefix
            )
        );
        assertEquals(before, StoreSnapshot.capture(store));
    }

    private static TestWorld descendingWorld() {
        TestWorld world = new TestWorld(-1, 7, 60, 73, -1, 1);
        for (int x = 0; x <= 6; x++) {
            int feetY = 70 - x;
            world.support(x, feetY - 1, 0);
        }
        return world;
    }

    private static TestWorld levelWorld(int minX, int maxX, int minZ, int maxZ) {
        TestWorld world = new TestWorld(minX, maxX, 60, 68, minZ, maxZ);
        world.floor(minX, maxX, minZ, maxZ, 63);
        return world;
    }

    private static List<VoxelCell> isolatedGoals() {
        List<VoxelCell> goals = new ArrayList<>();
        for (int y = FEET_Y - 2; y <= FEET_Y + 2; y++) {
            for (int x = -4; x <= 4; x++) {
                for (int z = -4; z <= 4; z++) {
                    int distance = Math.abs(x) + Math.abs(z);
                    if (distance >= 2 && distance <= 4) {
                        goals.add(new VoxelCell(x, y, z));
                    }
                }
            }
        }
        return goals;
    }

    private static VoxelCell cell(int x, int z) {
        return new VoxelCell(x, FEET_Y, z);
    }

    private static void assertRouteFailure(
        String reason,
        SurfaceReturnTrailStore.RouteSelection selection
    ) {
        assertFalse(selection.selected());
        assertTrue(selection.route().isEmpty());
        assertEquals(reason, selection.failureReason());
    }

    private record StoreSnapshot(
        String worldKey,
        String dimensionKey,
        String commandId,
        VoxelCell anchor,
        VoxelCell frontier,
        List<VoxelCell> trail,
        int gapKeyCount,
        long sessionRevision,
        long trailRevision,
        boolean remoteSuffixAvailable,
        boolean saturated
    ) {
        static StoreSnapshot capture(SurfaceReturnTrailStore store) {
            return new StoreSnapshot(
                store.worldKey(),
                store.dimensionKey(),
                store.descentCommandId(),
                store.anchor(),
                store.frontier(),
                store.trail(),
                store.gapKeyCount(),
                store.sessionRevision(),
                store.trailRevision(),
                store.remoteSuffixAvailable(),
                store.saturated()
            );
        }
    }

    private static final class TestWorld implements GatherWoodLocalEgressPerception {
        private final int minX;
        private final int maxX;
        private final int minY;
        private final int maxY;
        private final int minZ;
        private final int maxZ;
        private final java.util.Set<VoxelCell> solid = new java.util.HashSet<>();
        private final java.util.Set<VoxelCell> hazards = new java.util.HashSet<>();
        private final java.util.Set<VoxelCell> water = new java.util.HashSet<>();
        private final java.util.Set<VoxelCell> lava = new java.util.HashSet<>();

        TestWorld(int minX, int maxX, int minY, int maxY, int minZ, int maxZ) {
            this.minX = minX;
            this.maxX = maxX;
            this.minY = minY;
            this.maxY = maxY;
            this.minZ = minZ;
            this.maxZ = maxZ;
        }

        void floor(int fromX, int toX, int fromZ, int toZ, int y) {
            for (int x = fromX; x <= toX; x++) {
                for (int z = fromZ; z <= toZ; z++) {
                    support(x, y, z);
                }
            }
        }

        void support(int x, int y, int z) {
            solid.add(new VoxelCell(x, y, z));
        }

        void removeSupport(int x, int y, int z) {
            solid.remove(new VoxelCell(x, y, z));
        }

        void water(int x, int y, int z) {
            water.add(new VoxelCell(x, y, z));
        }

        @Override
        public int minX() {
            return minX;
        }

        @Override
        public int maxX() {
            return maxX;
        }

        @Override
        public int minY() {
            return minY;
        }

        @Override
        public int maxY() {
            return maxY;
        }

        @Override
        public int minZ() {
            return minZ;
        }

        @Override
        public int maxZ() {
            return maxZ;
        }

        @Override
        public boolean isSolid(int x, int y, int z) {
            return !inBounds(x, y, z) || solid.contains(new VoxelCell(x, y, z));
        }

        @Override
        public boolean isHazard(int x, int y, int z) {
            return !inBounds(x, y, z) || hazards.contains(new VoxelCell(x, y, z));
        }

        @Override
        public boolean isWater(int x, int y, int z) {
            return water.contains(new VoxelCell(x, y, z));
        }

        @Override
        public boolean isLava(int x, int y, int z) {
            return !inBounds(x, y, z) || lava.contains(new VoxelCell(x, y, z));
        }
    }
}
