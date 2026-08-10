package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class MiningWorkspaceBreadcrumbGapStateTest {
    private static final long SESSION = 7L;
    private static final String WORKSPACE = "workspace-a";
    private static final VoxelCell FRONTIER = new VoxelCell(0, 16, 0);

    @Test
    void admitsOnlyTheFourBoundedMiningWorkspaceContexts() {
        assertTrue(MiningWorkspaceBreadcrumbGapState.Context.MINE_NEARBY_IRON.admits(
            "mine_nearby_iron", "mission:MINE_IRON"));
        assertTrue(MiningWorkspaceBreadcrumbGapState.Context.FIELDKIT_RETURN.admits(
            "mine_nearby_iron", "mission:MINE_IRON"));
        assertTrue(MiningWorkspaceBreadcrumbGapState.Context.MINE_IRON_RECOVERY.admits(
            "descend_staircase", "mission:MINE_IRON_RECOVERY"));
        assertTrue(MiningWorkspaceBreadcrumbGapState.Context.TRANSACTION_ADMISSION.admits(
            "smelt_raw_iron", "mission:SMELT_IRON"));

        assertFalse(MiningWorkspaceBreadcrumbGapState.Context.MINE_NEARBY_IRON.admits(
            "mine_nearby_coal", "mission:MINE_COAL"));
        assertFalse(MiningWorkspaceBreadcrumbGapState.Context.FIELDKIT_RETURN.admits(
            "mine_nearby_stone", "mission:MINE_STONE"));
        assertFalse(MiningWorkspaceBreadcrumbGapState.Context.MINE_IRON_RECOVERY.admits(
            "descend_staircase", "mission:DESCEND_RECOVERY"));
        assertFalse(MiningWorkspaceBreadcrumbGapState.Context.TRANSACTION_ADMISSION.admits(
            "navigate_to_point", "mission:RETURN_SURFACE"));
    }

    @Test
    void planningRequiresGroundedSafeValidStateAndNoActiveTransaction() {
        assertTrue(MiningWorkspaceBreadcrumbGapState.shouldAttempt(
            MiningWorkspaceBreadcrumbGapState.Context.MINE_NEARBY_IRON,
            "mine_nearby_iron",
            "mission:MINE_IRON",
            true,
            true,
            true,
            false
        ));
        assertFalse(MiningWorkspaceBreadcrumbGapState.shouldAttempt(
            MiningWorkspaceBreadcrumbGapState.Context.MINE_NEARBY_IRON,
            "mine_nearby_iron",
            "mission:MINE_IRON",
            false,
            true,
            true,
            false
        ));
        assertFalse(MiningWorkspaceBreadcrumbGapState.shouldAttempt(
            MiningWorkspaceBreadcrumbGapState.Context.MINE_NEARBY_IRON,
            "mine_nearby_iron",
            "mission:MINE_IRON",
            true,
            false,
            true,
            false
        ));
        assertFalse(MiningWorkspaceBreadcrumbGapState.shouldAttempt(
            MiningWorkspaceBreadcrumbGapState.Context.MINE_NEARBY_IRON,
            "mine_nearby_iron",
            "mission:MINE_IRON",
            true,
            true,
            false,
            false
        ));
        assertFalse(MiningWorkspaceBreadcrumbGapState.shouldAttempt(
            MiningWorkspaceBreadcrumbGapState.Context.MINE_NEARBY_IRON,
            "mine_nearby_iron",
            "mission:MINE_IRON",
            true,
            true,
            true,
            true
        ));
    }

    @Test
    void deduplicatesKeysAndLimitsEachCommandToFourComputations() {
        MiningWorkspaceBreadcrumbGapState state = new MiningWorkspaceBreadcrumbGapState();

        MiningWorkspaceBreadcrumbGapState.Decision first = begin(
            state, SESSION, "command-a", FRONTIER, new VoxelCell(2, 16, 0));
        assertTrue(first.shouldCompute());
        assertEquals(1, first.attempt());
        assertEquals(
            MiningWorkspaceBreadcrumbGapState.Disposition.DUPLICATE_KEY,
            begin(state, SESSION, "command-a", FRONTIER, new VoxelCell(2, 16, 0)).disposition()
        );

        for (int offset = 3; offset <= 5; offset++) {
            assertTrue(begin(
                state,
                SESSION,
                "command-a",
                new VoxelCell(offset * 10, 16, 0),
                new VoxelCell(offset * 10 + 2, 16, 0)
            ).shouldCompute());
        }
        assertEquals(4, state.commandComputations("command-a"));
        assertEquals(
            MiningWorkspaceBreadcrumbGapState.Disposition.COMMAND_LIMIT,
            begin(
                state,
                SESSION,
                "command-a",
                new VoxelCell(60, 16, 0),
                new VoxelCell(62, 16, 0)
            ).disposition()
        );

        MiningWorkspaceBreadcrumbGapState.Decision nextCommand = begin(
            state,
            SESSION,
            "command-b",
            new VoxelCell(70, 16, 0),
            new VoxelCell(72, 16, 0)
        );
        assertTrue(nextCommand.shouldCompute());
        assertEquals(1, nextCommand.attempt());
        assertEquals(5, state.retainedKeyCount());
        assertEquals(
            MiningWorkspaceBreadcrumbGapState.Disposition.COMMAND_LIMIT,
            begin(
                state,
                SESSION,
                "command-a",
                new VoxelCell(80, 16, 0),
                new VoxelCell(82, 16, 0)
            ).disposition()
        );
    }

    @Test
    void rejectedConnectorLatchesTheFrontierUntilCanonicalProgress() {
        MiningWorkspaceBreadcrumbGapState state = new MiningWorkspaceBreadcrumbGapState();
        MiningWorkspaceBreadcrumbGapState.Decision rejected = begin(
            state, SESSION, "command-a", FRONTIER, new VoxelCell(2, 16, 0));
        state.record(rejected, MiningWorkspaceBreadcrumbGapState.Outcome.REJECTED);

        assertTrue(state.failedSegmentLatched());
        assertEquals(
            MiningWorkspaceBreadcrumbGapState.Disposition.FAILED_SEGMENT_LATCHED,
            begin(
                state,
                SESSION,
                "command-b",
                FRONTIER,
                new VoxelCell(3, 16, 1)
            ).disposition()
        );

        state.canonicalContinuityRestored(SESSION);
        assertFalse(state.failedSegmentLatched());
        assertTrue(begin(
            state,
            SESSION,
            "command-b",
            FRONTIER,
            new VoxelCell(3, 16, 1)
        ).shouldCompute());
    }

    @Test
    void reconciledConnectorDoesNotLatchLaterPlanning() {
        MiningWorkspaceBreadcrumbGapState state = new MiningWorkspaceBreadcrumbGapState();
        MiningWorkspaceBreadcrumbGapState.Decision reconciled = begin(
            state, SESSION, "command-a", FRONTIER, new VoxelCell(2, 16, 0));
        state.record(reconciled, MiningWorkspaceBreadcrumbGapState.Outcome.RECONCILED);

        assertFalse(state.failedSegmentLatched());
        assertTrue(begin(
            state,
            SESSION,
            "command-a",
            new VoxelCell(2, 16, 0),
            new VoxelCell(4, 16, 0)
        ).shouldCompute());
    }

    @Test
    void workspaceSessionChangeClearsKeysLimitsAndFailureLatch() {
        MiningWorkspaceBreadcrumbGapState state = new MiningWorkspaceBreadcrumbGapState();
        MiningWorkspaceBreadcrumbGapState.Decision rejected = begin(
            state, SESSION, "command-a", FRONTIER, new VoxelCell(2, 16, 0));
        state.record(rejected, MiningWorkspaceBreadcrumbGapState.Outcome.REJECTED);

        MiningWorkspaceBreadcrumbGapState.Decision fresh = begin(
            state, SESSION + 1, "command-a", FRONTIER, new VoxelCell(2, 16, 0));
        assertTrue(fresh.shouldCompute());
        assertEquals(1, fresh.attempt());
        assertEquals(1, state.retainedKeyCount());
        assertFalse(state.failedSegmentLatched());
        assertEquals(SESSION + 1, state.sessionRevision());
    }

    @Test
    void retainsTheFirstSixtyFourKeysWithoutEviction() {
        MiningWorkspaceBreadcrumbGapState state = new MiningWorkspaceBreadcrumbGapState();

        for (int index = 0; index < MiningWorkspaceBreadcrumbGapState.MAX_KEYS_PER_SESSION; index++) {
            MiningWorkspaceBreadcrumbGapState.Decision decision = begin(
                state,
                SESSION,
                "command-" + index,
                new VoxelCell(index * 3, 16, 0),
                new VoxelCell(index * 3 + 2, 16, 0)
            );
            assertTrue(decision.shouldCompute());
        }
        assertEquals(64, state.retainedKeyCount());
        assertEquals(
            MiningWorkspaceBreadcrumbGapState.Disposition.SESSION_KEY_LIMIT,
            begin(
                state,
                SESSION,
                "overflow",
                new VoxelCell(300, 16, 0),
                new VoxelCell(302, 16, 0)
            ).disposition()
        );
        assertEquals(64, state.retainedKeyCount());
        assertEquals(
            MiningWorkspaceBreadcrumbGapState.Disposition.DUPLICATE_KEY,
            begin(
                state,
                SESSION,
                "revisit",
                new VoxelCell(0, 16, 0),
                new VoxelCell(2, 16, 0)
            ).disposition()
        );
    }

    @Test
    void invalidAndStaleResultsCannotMutateFailureState() {
        MiningWorkspaceBreadcrumbGapState state = new MiningWorkspaceBreadcrumbGapState();
        assertEquals(
            MiningWorkspaceBreadcrumbGapState.Disposition.INVALID_INPUT,
            state.begin(SESSION, "", WORKSPACE, FRONTIER, new VoxelCell(2, 16, 0)).disposition()
        );

        MiningWorkspaceBreadcrumbGapState.Decision stale = begin(
            state, SESSION, "command-a", FRONTIER, new VoxelCell(2, 16, 0));
        state.canonicalContinuityRestored(SESSION + 1);
        state.record(stale, MiningWorkspaceBreadcrumbGapState.Outcome.REJECTED);
        assertFalse(state.failedSegmentLatched());
    }

    private static MiningWorkspaceBreadcrumbGapState.Decision begin(
        MiningWorkspaceBreadcrumbGapState state,
        long session,
        String commandId,
        VoxelCell frontier,
        VoxelCell current
    ) {
        return state.begin(session, commandId, WORKSPACE, frontier, current);
    }
}
