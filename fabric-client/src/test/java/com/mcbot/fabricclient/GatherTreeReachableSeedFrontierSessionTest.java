package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class GatherTreeReachableSeedFrontierSessionTest {
    private static final String COMMAND = "gather-tree-frontier";
    private static final long FINGERPRINT = 0x1234abcdL;
    private static final VoxelCell ORIGIN = new VoxelCell(0, 64, 0);
    private static final VoxelCell FRONTIER = new VoxelCell(3, 64, 0);
    private static final BlockPos TARGET = new BlockPos(8, 65, 0);

    @Test
    void selectionFreezesStageAndConsumesComputationOne() {
        GatherTreeReachableSeedFrontierSession session = session();
        GatherTreeLivenessPolicy.BreakStanceEpisode episode = episode();

        GatherTreeReachableSeedFrontierSession.Transition selected = session.beginStage(
            COMMAND,
            FINGERPRINT,
            frontierPlan(),
            episode,
            1_000L
        );

        assertTrue(selected.accepted());
        assertEquals(GatherTreeReachableSeedFrontierSession.Phase.TRAVERSING, session.phase());
        assertTrue(session.stageUsed());
        assertTrue(session.active());
        assertEquals(TARGET, session.target());
        assertEquals(FINGERPRINT, session.candidateFingerprint());
        assertEquals(ORIGIN, session.origin());
        assertEquals(FRONTIER, session.frontier());
        assertEquals(
            List.of(
                ORIGIN,
                new VoxelCell(1, 64, 0),
                new VoxelCell(2, 64, 0),
                FRONTIER
            ),
            session.stageRoute()
        );
        assertEquals(4, session.stageRouteLength());
        assertEquals(77, session.expandedCells());
        assertEquals(8.0D, session.startDistance());
        assertEquals(5.0D, session.plannedRemainingDistance());
        assertEquals(1, session.plannerComputations());
        assertEquals(1, session.stageEpisode());
        assertSame(episode, session.breakStanceEpisode());
        assertEquals(46_000L, session.deadlineAtMs());
    }

    @Test
    void exactFrontierAndTwoBlockActualProgressAreRequired() {
        GatherTreeReachableSeedFrontierSession wrongFeet = startedSession();
        GatherTreeReachableSeedFrontierSession.Transition wrong = wrongFeet.markFrontierReached(
            COMMAND,
            TARGET,
            new VoxelCell(2, 64, 0),
            true,
            2_000L
        );
        assertFalse(wrong.accepted());
        assertEquals("frontier_arrival_invalid", wrong.reason());
        assertFalse(wrongFeet.active());
        assertTrue(wrongFeet.stageUsed());

        GatherTreeReachableSeedFrontierSession insufficient = session();
        BlockPos closeTarget = new BlockPos(8, 65, 0);
        VoxelCell shortFrontier = new VoxelCell(1, 64, 0);
        GatherTreeReachableSeedPlanner.FrontierPlan invalidPlan = new GatherTreeReachableSeedPlanner.FrontierPlan(
            closeTarget,
            ORIGIN,
            shortFrontier,
            List.of(ORIGIN, shortFrontier),
            "reachable_seed_frontier_3d",
            10,
            8.0D,
            7.0D,
            0
        );
        GatherTreeReachableSeedFrontierSession.Transition rejected = insufficient.beginStage(
            COMMAND,
            FINGERPRINT,
            invalidPlan,
            episode(),
            1_000L
        );
        assertFalse(rejected.accepted());
        assertEquals("frontier_progress_insufficient", rejected.reason());
        assertFalse(insufficient.stageUsed());

        GatherTreeReachableSeedFrontierSession exact = startedSession();
        GatherTreeReachableSeedFrontierSession.Transition reached = exact.markFrontierReached(
            COMMAND,
            TARGET,
            FRONTIER,
            true,
            2_000L
        );
        assertTrue(reached.accepted());
        assertEquals(GatherTreeReachableSeedFrontierSession.Phase.HOLDING_AT_FRONTIER, exact.phase());
        assertEquals(5.0D, exact.actualRemainingDistance());
        assertEquals(3.0D, exact.actualNetProgress());

        VoxelCell boundaryFrontier = new VoxelCell(2, 64, 0);
        GatherTreeReachableSeedFrontierSession boundary = session();
        GatherTreeReachableSeedPlanner.FrontierPlan boundaryPlan =
            new GatherTreeReachableSeedPlanner.FrontierPlan(
                TARGET,
                ORIGIN,
                boundaryFrontier,
                List.of(ORIGIN, new VoxelCell(1, 64, 0), boundaryFrontier),
                "reachable_seed_frontier_3d",
                20,
                8.0D,
                6.0D,
                0
            );
        assertTrue(boundary.beginStage(
            COMMAND,
            FINGERPRINT,
            boundaryPlan,
            episode(),
            1_000L
        ).accepted());
        assertTrue(boundary.markFrontierReached(
            COMMAND,
            TARGET,
            boundaryFrontier,
            true,
            2_000L
        ).accepted());
        assertEquals(2.0D, boundary.actualNetProgress());
    }

    @Test
    void stoppedHoldTickPrecedesSingletonReservation() {
        GatherTreeReachableSeedFrontierSession session = reachedSession();

        GatherTreeReachableSeedFrontierSession.ReplanReservation early =
            session.reserveSingletonReplan(COMMAND, TARGET, FRONTIER, true, 2_010L);
        assertFalse(early.granted());
        assertEquals(1, session.plannerComputations());

        GatherTreeReachableSeedFrontierSession.Transition moving =
            session.completeStoppedHoldTick(COMMAND, TARGET, FRONTIER, true, false, 2_020L);
        assertFalse(moving.accepted());
        assertEquals("frontier_hold_not_stopped", moving.reason());
        assertEquals(GatherTreeReachableSeedFrontierSession.Phase.REJECTED, session.phase());

        GatherTreeReachableSeedFrontierSession stopped = reachedSession();
        GatherTreeReachableSeedFrontierSession.Transition held =
            stopped.completeStoppedHoldTick(COMMAND, TARGET, FRONTIER, true, true, 2_020L);
        assertTrue(held.accepted());
        assertEquals(1, stopped.stoppedHoldTicks());
        assertEquals(GatherTreeReachableSeedFrontierSession.Phase.READY_TO_REPLAN, stopped.phase());
    }

    @Test
    void singletonPermitConsumesComputationTwoBeforePlannerResultAndNoThirdExists() {
        GatherTreeReachableSeedFrontierSession session = readySession();
        GatherTreeLivenessPolicy.BreakStanceEpisode original = session.breakStanceEpisode();

        GatherTreeReachableSeedFrontierSession.ReplanReservation reserved =
            session.reserveSingletonReplan(COMMAND, TARGET, FRONTIER, true, 2_100L);

        assertTrue(reserved.granted());
        assertEquals(2, session.plannerComputations());
        assertEquals(GatherTreeReachableSeedFrontierSession.Phase.REPLANNING, session.phase());
        assertEquals(2, reserved.permit().computation());
        assertEquals(1, reserved.permit().stageEpisode());
        assertSame(original, reserved.permit().breakStanceEpisode());
        assertEquals(46_000L, session.deadlineAtMs());

        GatherTreeReachableSeedFrontierSession.ReplanReservation third =
            session.reserveSingletonReplan(COMMAND, TARGET, FRONTIER, true, 2_101L);
        assertFalse(third.granted());
        assertEquals(2, session.plannerComputations());

        GatherTreeReachableSeedPlanner.Plan finalPlan = new GatherTreeReachableSeedPlanner.Plan(
            TARGET,
            new VoxelCell(7, 64, 0),
            List.of(FRONTIER, new VoxelCell(4, 64, 0), new VoxelCell(7, 64, 0)),
            "reachable_seed_frontier_3d",
            44,
            1.0D,
            0
        );
        GatherTreeReachableSeedFrontierSession.ReplanResolution resolved =
            session.resolveSingletonReplan(
                reserved.permit(),
                new GatherTreeReachableSeedPlanner.Result(finalPlan, "", 44, 1),
                2_200L
            );

        assertTrue(resolved.accepted());
        assertSame(finalPlan, resolved.plan());
        assertSame(finalPlan, session.finalPlan());
        assertSame(original, session.breakStanceEpisode());
        assertEquals(46_000L, session.deadlineAtMs());
        assertEquals(2, session.plannerComputations());
        assertEquals(GatherTreeReachableSeedFrontierSession.Phase.FINAL_ROUTE_READY, session.phase());
        assertFalse(session.active());
    }

    @Test
    void failedSingletonClearsActiveTargetWorkButPermanentlyConsumesStage() {
        GatherTreeReachableSeedFrontierSession session = readySession();
        GatherTreeReachableSeedFrontierSession.ReplanReservation reservation =
            session.reserveSingletonReplan(COMMAND, TARGET, FRONTIER, true, 2_100L);

        GatherTreeReachableSeedFrontierSession.ReplanResolution rejected =
            session.resolveSingletonReplan(
                reservation.permit(),
                new GatherTreeReachableSeedPlanner.Result(
                    null,
                    "no_reachable_break_stance",
                    80,
                    1
                ),
                2_200L
            );

        assertFalse(rejected.accepted());
        assertNull(rejected.plan());
        assertEquals("no_reachable_break_stance", rejected.transition().reason());
        assertEquals(GatherTreeReachableSeedFrontierSession.Phase.REJECTED, session.phase());
        assertFalse(session.active());
        assertTrue(session.stageUsed());
        assertEquals(2, session.plannerComputations());
        assertEquals("no_reachable_break_stance", session.rejectionReason());

        GatherTreeReachableSeedFrontierSession.Transition replay = session.beginStage(
            COMMAND,
            FINGERPRINT,
            frontierPlan(),
            episode(),
            3_000L
        );
        assertFalse(replay.accepted());
        assertEquals("stage_already_used", replay.reason());
    }

    @Test
    void targetRejectionAndDeadlinePreserveTheOriginalCommandScopedLatch() {
        GatherTreeReachableSeedFrontierSession rejected = startedSession();
        GatherTreeLivenessPolicy.BreakStanceEpisode original = rejected.breakStanceEpisode();
        GatherTreeReachableSeedFrontierSession.Transition targetRejected =
            rejected.rejectTarget("target_disappeared");

        assertFalse(targetRejected.accepted());
        assertFalse(rejected.active());
        assertTrue(rejected.stageUsed());
        assertSame(original, rejected.breakStanceEpisode());
        assertEquals(1, rejected.plannerComputations());

        GatherTreeReachableSeedFrontierSession expired = startedSession();
        GatherTreeReachableSeedFrontierSession.Transition deadline = expired.markFrontierReached(
            COMMAND,
            TARGET,
            FRONTIER,
            true,
            46_000L
        );
        assertFalse(deadline.accepted());
        assertEquals("frontier_deadline", deadline.reason());
        assertTrue(expired.stageUsed());
        assertFalse(expired.active());
        assertEquals(46_000L, expired.deadlineAtMs());
    }

    @Test
    void malformedOrMismatchedPlansNeverConsumeTheStageAllowance() {
        GatherTreeReachableSeedFrontierSession session = session();

        GatherTreeReachableSeedFrontierSession.Transition wrongCommand = session.beginStage(
            "other-command",
            FINGERPRINT,
            frontierPlan(),
            episode(),
            1_000L
        );
        assertFalse(wrongCommand.accepted());
        assertFalse(session.stageUsed());

        GatherTreeReachableSeedPlanner.FrontierPlan mismatch = new GatherTreeReachableSeedPlanner.FrontierPlan(
            TARGET,
            ORIGIN,
            FRONTIER,
            List.of(ORIGIN, FRONTIER),
            "reachable_seed_frontier_3d",
            12,
            99.0D,
            5.0D,
            0
        );
        GatherTreeReachableSeedFrontierSession.Transition malformed = session.beginStage(
            COMMAND,
            FINGERPRINT,
            mismatch,
            episode(),
            1_000L
        );
        assertFalse(malformed.accepted());
        assertEquals("frontier_distance_mismatch", malformed.reason());
        assertFalse(session.stageUsed());
        assertEquals(0, session.plannerComputations());
        assertNull(session.target());
        assertNotNull(session.commandId());
    }

    private static GatherTreeReachableSeedFrontierSession session() {
        return new GatherTreeReachableSeedFrontierSession(COMMAND);
    }

    private static GatherTreeReachableSeedFrontierSession startedSession() {
        GatherTreeReachableSeedFrontierSession session = session();
        assertTrue(session.beginStage(
            COMMAND,
            FINGERPRINT,
            frontierPlan(),
            episode(),
            1_000L
        ).accepted());
        return session;
    }

    private static GatherTreeReachableSeedFrontierSession reachedSession() {
        GatherTreeReachableSeedFrontierSession session = startedSession();
        assertTrue(session.markFrontierReached(
            COMMAND,
            TARGET,
            FRONTIER,
            true,
            2_000L
        ).accepted());
        return session;
    }

    private static GatherTreeReachableSeedFrontierSession readySession() {
        GatherTreeReachableSeedFrontierSession session = reachedSession();
        assertTrue(session.completeStoppedHoldTick(
            COMMAND,
            TARGET,
            FRONTIER,
            true,
            true,
            2_020L
        ).accepted());
        return session;
    }

    private static GatherTreeLivenessPolicy.BreakStanceEpisode episode() {
        return GatherTreeLivenessPolicy.beginBreakStanceEpisode(1_000L);
    }

    private static GatherTreeReachableSeedPlanner.FrontierPlan frontierPlan() {
        return new GatherTreeReachableSeedPlanner.FrontierPlan(
            TARGET,
            ORIGIN,
            FRONTIER,
            List.of(
                ORIGIN,
                new VoxelCell(1, 64, 0),
                new VoxelCell(2, 64, 0),
                FRONTIER
            ),
            "reachable_seed_frontier_3d",
            77,
            8.0D,
            5.0D,
            0
        );
    }
}
