package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class MiningWorkspaceReturnAccessStateTest {
    private static final MiningWorkspaceReturnAccessState.Snapshot CURRENT = snapshot(
        "workspace-a",
        7L,
        11L
    );

    @Test
    void firstBlockDisablesRemoteReturnAndProducesOneEvent() {
        MiningWorkspaceReturnAccessState state = new MiningWorkspaceReturnAccessState();

        assertEquals(
            MiningWorkspaceReturnAccessState.BlockResult.BLOCKED,
            state.block(
                CURRENT,
                CURRENT,
                MiningWorkspaceReturnAccessState.Consumer.TRANSACTION,
                "route_invalidated",
                "return:0,16,3->0,16,2"
            )
        );
        assertTrue(state.blocked());
        assertFalse(state.permitsRemoteReturn(CURRENT));
        MiningWorkspaceReturnAccessState.BlockedAccess blocked = state.blockedAccess().orElseThrow();
        assertEquals(MiningWorkspaceReturnAccessState.Consumer.TRANSACTION, blocked.consumer());
        assertEquals("route_invalidated", blocked.reason());
        assertEquals("return:0,16,3->0,16,2", blocked.routeSignature());

        MiningWorkspaceReturnAccessState.Event event = state.pollEvent().orElseThrow();
        assertEquals(MiningWorkspaceReturnAccessState.EventType.BLOCKED, event.type());
        assertEquals(blocked, event.blockedAccess());
        assertTrue(state.pollEvent().isEmpty());
    }

    @Test
    void duplicateBlocksAreIdempotentAndPreserveTheFirstCause() {
        MiningWorkspaceReturnAccessState state = blockedState();
        assertTrue(state.pollEvent().isPresent());

        assertEquals(
            MiningWorkspaceReturnAccessState.BlockResult.ALREADY_BLOCKED,
            state.block(
                CURRENT,
                CURRENT,
                MiningWorkspaceReturnAccessState.Consumer.FIELDKIT,
                "known_broken",
                "new-signature"
            )
        );
        assertEquals(1, state.suppressedDuplicateCount());
        assertEquals(
            MiningWorkspaceReturnAccessState.Consumer.TRANSACTION,
            state.blockedAccess().orElseThrow().consumer()
        );
        assertEquals("route_invalidated", state.blockedAccess().orElseThrow().reason());
        assertTrue(state.pollEvent().isEmpty());
    }

    @Test
    void staleWorkspaceSessionAndTrailCannotBlockCurrentAccess() {
        MiningWorkspaceReturnAccessState state = new MiningWorkspaceReturnAccessState();
        assertEquals(MiningWorkspaceReturnAccessState.SyncResult.INITIALIZED, state.synchronize(CURRENT));

        assertEquals(
            MiningWorkspaceReturnAccessState.BlockResult.STALE_WORKSPACE,
            state.block(
                snapshot("workspace-old", 7L, 11L),
                CURRENT,
                MiningWorkspaceReturnAccessState.Consumer.TRANSACTION,
                "route_invalidated",
                "signature"
            )
        );
        assertEquals(
            MiningWorkspaceReturnAccessState.BlockResult.STALE_SESSION,
            state.block(
                snapshot("workspace-a", 6L, 11L),
                CURRENT,
                MiningWorkspaceReturnAccessState.Consumer.TRANSACTION,
                "route_invalidated",
                "signature"
            )
        );
        assertEquals(
            MiningWorkspaceReturnAccessState.BlockResult.STALE_TRAIL,
            state.block(
                snapshot("workspace-a", 7L, 10L),
                CURRENT,
                MiningWorkspaceReturnAccessState.Consumer.TRANSACTION,
                "route_invalidated",
                "signature"
            )
        );
        assertFalse(state.blocked());
        assertTrue(state.permitsRemoteReturn(CURRENT));
        assertTrue(state.pollEvent().isEmpty());
    }

    @Test
    void ordinaryTrailChurnDoesNotRestoreBlockedAccess() {
        MiningWorkspaceReturnAccessState state = blockedState();
        MiningWorkspaceReturnAccessState.Snapshot appended = snapshot("workspace-a", 7L, 12L);

        assertEquals(MiningWorkspaceReturnAccessState.SyncResult.UNCHANGED, state.synchronize(appended));
        assertFalse(state.permitsRemoteReturn(appended));
        assertEquals(11L, state.blockedAccess().orElseThrow().snapshot().trailRevision());
        assertEquals(
            MiningWorkspaceReturnAccessState.BlockResult.ALREADY_BLOCKED,
            state.block(
                appended,
                appended,
                MiningWorkspaceReturnAccessState.Consumer.FIELDKIT,
                "known_broken",
                "latest-signature"
            )
        );
        assertEquals(
            MiningWorkspaceReturnAccessState.BlockResult.STALE_TRAIL,
            state.block(
                CURRENT,
                appended,
                MiningWorkspaceReturnAccessState.Consumer.FIELDKIT,
                "known_broken",
                "stale-signature"
            )
        );
    }

    @Test
    void newerWorkspaceSessionsClearTheLatchButStaleSnapshotsCannotRegressIdentity() {
        MiningWorkspaceReturnAccessState state = blockedState();
        MiningWorkspaceReturnAccessState.Snapshot nextSession = snapshot("workspace-a", 8L, 1L);

        assertTrue(state.permitsRemoteReturn(nextSession));
        assertFalse(state.blocked());
        assertEquals(8L, state.sessionRevision());
        assertFalse(state.permitsRemoteReturn(CURRENT));
        assertEquals(8L, state.sessionRevision());

        MiningWorkspaceReturnAccessState.Snapshot replacement = snapshot("workspace-b", 9L, 1L);
        assertTrue(state.permitsRemoteReturn(replacement));
        assertEquals("workspace-b", state.workspaceId());
        assertEquals(0, state.suppressedDuplicateCount());
    }

    @Test
    void restoreRequiresAnExactVerifiedStanceAndResetCanonicalTrail() {
        MiningWorkspaceReturnAccessState state = blockedState();
        state.pollEvent();
        MiningWorkspaceReturnAccessState.Snapshot reanchored = snapshot("workspace-a", 7L, 12L);

        assertEquals(
            MiningWorkspaceReturnAccessState.RestoreResult.NOT_AT_EXACT_STANCE,
            state.restoreAfterReanchor(reanchored, reanchored, false, true)
        );
        assertEquals(
            MiningWorkspaceReturnAccessState.RestoreResult.TRAIL_NOT_REANCHORED,
            state.restoreAfterReanchor(reanchored, reanchored, true, false)
        );
        assertEquals(
            MiningWorkspaceReturnAccessState.RestoreResult.STALE_TRAIL,
            state.restoreAfterReanchor(CURRENT, reanchored, true, true)
        );
        assertFalse(state.permitsRemoteReturn(reanchored));

        assertEquals(
            MiningWorkspaceReturnAccessState.RestoreResult.RESTORED,
            state.restoreAfterReanchor(reanchored, reanchored, true, true)
        );
        assertTrue(state.permitsRemoteReturn(reanchored));
        assertFalse(state.blocked());
        MiningWorkspaceReturnAccessState.Event event = state.pollEvent().orElseThrow();
        assertEquals(MiningWorkspaceReturnAccessState.EventType.RESTORED, event.type());
        assertEquals(reanchored, event.currentSnapshot());
        assertTrue(state.pollEvent().isEmpty());
        assertEquals(
            MiningWorkspaceReturnAccessState.RestoreResult.ALREADY_AVAILABLE,
            state.restoreAfterReanchor(reanchored, reanchored, true, true)
        );
    }

    @Test
    void blockAndRestoreEventsRemainOrderedWhenPolledLate() {
        MiningWorkspaceReturnAccessState state = blockedState();
        MiningWorkspaceReturnAccessState.Snapshot reanchored = snapshot("workspace-a", 7L, 12L);
        assertEquals(
            MiningWorkspaceReturnAccessState.RestoreResult.RESTORED,
            state.restoreAfterReanchor(reanchored, reanchored, true, true)
        );

        assertEquals(
            MiningWorkspaceReturnAccessState.EventType.BLOCKED,
            state.pollEvent().orElseThrow().type()
        );
        assertEquals(
            MiningWorkspaceReturnAccessState.EventType.RESTORED,
            state.pollEvent().orElseThrow().type()
        );
        assertTrue(state.pollEvent().isEmpty());
    }

    @Test
    void absentWorkspaceAndInvalidRevisionsFailClosed() {
        MiningWorkspaceReturnAccessState state = new MiningWorkspaceReturnAccessState();
        MiningWorkspaceReturnAccessState.Snapshot absent = snapshot("", 1L, 1L);
        MiningWorkspaceReturnAccessState.Snapshot invalid = snapshot("workspace", -1L, 1L);

        assertFalse(state.permitsRemoteReturn(absent));
        assertFalse(state.permitsRemoteReturn(invalid));
        assertEquals(
            MiningWorkspaceReturnAccessState.BlockResult.INVALID,
            state.block(
                absent,
                absent,
                MiningWorkspaceReturnAccessState.Consumer.TRANSACTION,
                "route_invalidated",
                "signature"
            )
        );
        assertEquals(
            MiningWorkspaceReturnAccessState.BlockResult.INVALID,
            state.block(CURRENT, CURRENT, null, "route_invalidated", "signature")
        );
    }

    private static MiningWorkspaceReturnAccessState blockedState() {
        MiningWorkspaceReturnAccessState state = new MiningWorkspaceReturnAccessState();
        assertEquals(
            MiningWorkspaceReturnAccessState.BlockResult.BLOCKED,
            state.block(
                CURRENT,
                CURRENT,
                MiningWorkspaceReturnAccessState.Consumer.TRANSACTION,
                "route_invalidated",
                "return:0,16,3->0,16,2"
            )
        );
        return state;
    }

    private static MiningWorkspaceReturnAccessState.Snapshot snapshot(
        String workspaceId,
        long sessionRevision,
        long trailRevision
    ) {
        return new MiningWorkspaceReturnAccessState.Snapshot(
            workspaceId,
            sessionRevision,
            trailRevision
        );
    }
}
