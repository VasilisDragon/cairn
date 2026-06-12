package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.OptionalInt;
import org.junit.jupiter.api.Test;

/**
 * End-to-end round-trip proof on REAL captured navigation failures (from a live R5 run): each recorded
 * default-scan no_path reproduces its exact live A* outcome when replayed offline. These are the first
 * regression fixtures of the pathing-hardening corpus. A change to A* or perception behavior will change a
 * reproduced outcome here, so the corpus guards against silent pathfinder regressions.
 */
class NavReplayCorpusTest {
    private static NavReplayRecording load(String resource) throws Exception {
        try (InputStream in = NavReplayCorpusTest.class.getResourceAsStream(resource)) {
            assertNotNull(in, "missing test resource: " + resource);
            return NavReplayRecording.fromJson(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    @Test
    void capturedGoalBlockedFailureReproducesOffline() throws Exception {
        // The iron-collect target cell was unstandable, so A* reports goal_blocked. The recording replays
        // that exactly, which is what lets the real bug (collect target-selection) be debugged offline.
        NavReplayRecording recording = load("/nav-recordings/r5-collect-goal-blocked.json");
        assertFalse(recording.liveRouteFound, "fixture should be a captured failure");
        assertEquals("goal_blocked", recording.liveFailureReason);
        assertTrue(recording.reproducesLiveOutcome(), "offline replay must reproduce the live goal_blocked");
        assertEquals("goal_blocked", recording.reproduce().failureReason());
    }

    @Test
    void capturedGoalBlockedChoosesReachableAdjacentCollectCell() throws Exception {
        NavReplayRecording recording = load("/nav-recordings/r5-collect-goal-blocked.json");
        GridPerception perception = recording.toPerception();

        CollectNavigationTargetPlanner.TargetPlan plan =
            CollectNavigationTargetPlanner.chooseTarget(perception, recording.start(), recording.goal());
        PerceptionBackedPathFollowerSim.Result result = PerceptionBackedPathFollowerSim.followRoute(
            perception,
            plan.route(),
            PathFollower.center(recording.start().x()),
            PathFollower.center(recording.start().z()),
            0.0D,
            NavHardeningBatch.ARRIVE_EPSILON,
            NavHardeningBatch.MAX_TURN_DEG_PER_TICK,
            PerceptionBackedPathFollowerSim.Config.defaults()
        );

        assertNotNull(plan.cell());
        assertFalse(plan.cell().equals(recording.goal()), "blocked item cell must not be the nav target");
        assertTrue(perception.surfaceY(plan.cell().x(), plan.cell().z()).isPresent(), "selected cell must be standable");
        assertFalse(plan.route().isEmpty(), "selected collect cell must be reachable");
        assertEquals(PerceptionBackedPathFollowerSim.Outcome.ARRIVED, result.outcome(), result.toString());
    }

    @Test
    void capturedOpenExhaustedFailureReproducesOffline() throws Exception {
        // A* exhausted the reachable open set within the default scan window (open_exhausted); the
        // scan-window fallback later found a route. The recording reproduces the default-scan failure.
        NavReplayRecording recording = load("/nav-recordings/r5-collect-open-exhausted.json");
        assertFalse(recording.liveRouteFound);
        assertEquals("open_exhausted", recording.liveFailureReason);
        assertTrue(recording.reproducesLiveOutcome(), "offline replay must reproduce the live open_exhausted");
        assertEquals("open_exhausted", recording.reproduce().failureReason());
    }

    @Test
    void capturedFollowerStallReproducesOffline() throws Exception {
        // Real captured "stuck jumping" stall: the follower keeps arcing toward the target with step-assist
        // jump engaged but makes no net progress to the goal. The replay reproduces the follow() decision
        // offline; the embedded perception carries the local world that blocks the step.
        try (InputStream in = NavReplayCorpusTest.class.getResourceAsStream("/nav-recordings/r5-collect-follower-stall.json")) {
            assertNotNull(in, "missing follower-stall fixture");
            FollowerStallRecording recording =
                FollowerStallRecording.fromJson(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            assertEquals("follower_no_goal_progress", recording.reason);
            assertTrue(recording.reproducesLiveDecision(), "offline replay must reproduce the live follower decision");
            assertTrue(recording.stepAssistJump, "the stuck-jumping stall engaged step-assist jump");
            assertFalse(recording.outFinished);
        }
    }

    @Test
    void capturedFollowerStallArrivesWhenNavigationStatePersists() throws Exception {
        try (InputStream in = NavReplayCorpusTest.class.getResourceAsStream("/nav-recordings/r5-collect-follower-stall.json")) {
            assertNotNull(in, "missing follower-stall fixture");
            FollowerStallRecording recording =
                FollowerStallRecording.fromJson(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            GridRouteDiagnostic localRoute = recording.perception.reproduce();
            assertTrue(localRoute.routeFound(), "embedded local stall perception must have a route");

            PerceptionBackedPathFollowerSim.Result result = PerceptionBackedPathFollowerSim.followRoute(
                recording.perception.toPerception(),
                localRoute.route(),
                recording.x,
                recording.z,
                recording.yaw,
                0,
                recording.progress(),
                recording.arriveEpsilon,
                recording.maxTurnDegPerTick,
                PerceptionBackedPathFollowerSim.Config.defaults()
            );

            assertEquals(PerceptionBackedPathFollowerSim.Outcome.ARRIVED, result.outcome(), result.toString());
        }
    }

    @Test
    void capturedCollectStallReproducesUnreachableDropOffline() throws Exception {
        // Real captured collect-item stall NOT covered by the goal_blocked fix: the drop's cell IS
        // standable, but its surfaceY is an overhang (y101) ~5 blocks above the drop (y96) in the dug pit,
        // so the 2-D collect routes to the overhang and never reaches the drop. The route to the cell
        // reproduces, and the vertical gap marks the drop unreachable. (The collect-level fix will flip
        // this to ARRIVED, the same way the goal_blocked / follower fixtures were flipped.)
        try (InputStream in = NavReplayCorpusTest.class.getResourceAsStream("/nav-recordings/r5-collect-stall.json")) {
            assertNotNull(in, "missing collect-stall fixture");
            CollectStallRecording recording =
                CollectStallRecording.fromJson(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            assertEquals("raw_iron", recording.dropItemId);
            assertTrue(recording.reproducesRoute(), "the 2-D route to the drop cell reproduces");
            assertTrue(recording.reproducesUnreachableDrop(), "the drop is out of pickup reach of the arrival surface");
            Double gap = recording.verticalGapToDrop();
            assertNotNull(gap, "drop cell should be standable (an overhang surface)");
            assertTrue(Math.abs(gap) > CollectStallRecording.PICKUP_VERTICAL_RANGE, "vertical gap exceeds pickup range");
        }
    }

    @Test
    void dropYAwarePlannerAvoidsOverhangAndPicksDropLevelCell() throws Exception {
        // The fix: passing the drop's actual Y makes the collect planner reject the overhang surface and
        // pick a standable cell near the drop's level instead -- proven against the same real recording
        // that reproduces the unreachable-drop failure above.
        try (InputStream in = NavReplayCorpusTest.class.getResourceAsStream("/nav-recordings/r5-collect-stall.json")) {
            assertNotNull(in, "missing collect-stall fixture");
            CollectStallRecording recording =
                CollectStallRecording.fromJson(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            GridPerception perception = recording.route.toPerception();

            // Old (Y-blind) behavior would route to the overhang cell -> unreachable.
            assertTrue(recording.reproducesUnreachableDrop(), "Y-blind collect can't reach this drop");

            // New (drop-Y-aware) behavior picks a reachable cell whose surface is near the drop's Y.
            CollectNavigationTargetPlanner.TargetPlan plan = CollectNavigationTargetPlanner.chooseTarget(
                perception, recording.botCell(), recording.dropCell(), recording.dropY);
            assertNotNull(plan.cell(), "drop-Y-aware planner must find a near-Y collect cell");
            assertFalse(plan.route().isEmpty(), "chosen collect cell must be reachable");
            OptionalInt surface = perception.surfaceY(plan.cell().x(), plan.cell().z());
            assertTrue(surface.isPresent(), "chosen cell is standable");
            assertTrue(
                Math.abs(surface.getAsInt() - recording.dropY) <= CollectNavigationTargetPlanner.MAX_COLLECT_SURFACE_GAP,
                "chosen cell's surface is near the drop's Y, not the overhang");
        }
    }
}
