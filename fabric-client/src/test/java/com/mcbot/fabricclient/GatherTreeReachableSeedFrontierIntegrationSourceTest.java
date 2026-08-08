package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class GatherTreeReachableSeedFrontierIntegrationSourceTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java"
    );

    @Test
    void initialAndClusterSelectionAdmitAFrontierWithoutReportingAPlannerRejection()
        throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String initial = methodBody(
            source,
            "private LiveGatherTreeSeedSelection selectLiveGatherTreeSeedFromCandidates("
        );
        String cluster = methodBody(source, "private GatherTreeTargetSelection selectNextTreeTarget(");

        int initialSource = initial.indexOf("\"initial_seed\"");
        assertTrue(initialSource >= 0);
        assertTrue(initial.indexOf("true", initialSource) > initialSource);
        assertTrue(source.contains(
            "source + (attempt.frontierFound() ? \"_3d_frontier\" : \"_3d\")"
        ));
        assertTrue(cluster.contains("\"cluster_target\""));
        assertTrue(cluster.contains("reachableSeedAttempt.admissible()"));
        assertTrue(cluster.contains("\"reachable_tree_log_frontier_3d\""));
        assertTrue(cluster.contains("!run.reachableSeedFrontierSession.stageUsed()"));
        assertTrue(source.contains(
            "if (attempt == null || attempt.admissible() || attempt.result() == null)"
        ));
    }

    @Test
    void singletonHandoffReservesAttemptTwoAndPlansOnlyTheFrozenTarget()
        throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String method = methodBody(
            source,
            "private ControlDecision resolveGatherTreeReachableSeedFrontierTraversal("
        );

        int reserve = method.indexOf("reserveSingletonReplan(");
        int plan = method.indexOf("planGatherTreeReachableSeed(", reserve);
        int singletonCandidates = method.indexOf("List.of(target)", plan);
        int resolve = method.indexOf("resolveSingletonReplan(", plan);
        int install = method.indexOf("beginGatherTreeReachableSeedTraversal(", resolve);

        assertTrue(reserve >= 0);
        assertTrue(method.contains("BlockPos target = session.target()"));
        assertTrue(plan > reserve);
        assertTrue(singletonCandidates > plan);
        assertTrue(resolve > singletonCandidates);
        assertTrue(install > resolve);
        assertTrue(method.substring(plan, resolve).contains("\"frontier_target\""));
        assertTrue(method.substring(plan, resolve).contains("\"bypass\""));
        assertTrue(method.substring(plan, resolve).contains("false"));
        assertTrue(method.substring(install).contains("true"));
        assertFalse(method.contains("selectNextTreeTarget("));
    }

    @Test
    void stageAndFinalRouteShareOneEpisodeAndExactlyTwoComputations()
        throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String beginStage = methodBody(
            source,
            "private ControlDecision beginGatherTreeReachableSeedFrontierTraversal("
        );
        String installFinal = methodBody(
            source,
            "private ControlDecision beginGatherTreeReachableSeedTraversal("
        );
        String resetTarget = methodBody(
            source,
            "private void resetGatherTreeCurrentTarget("
        );

        assertTrue(beginStage.contains("GatherTreeLivenessPolicy.beginBreakStanceEpisode(nowMs)"));
        assertTrue(beginStage.contains("beginStage("));
        assertTrue(beginStage.contains("episode.deadlineAtMs()"));
        assertTrue(beginStage.contains("breakStanceRouteAttempts = 1"));
        assertFalse(beginStage.contains("breakStanceNav3dSelectedCount++"));
        assertFalse(beginStage.contains("reachableSeedNav3dSelectedCount++"));

        assertTrue(installFinal.contains("fromFrontier"));
        assertTrue(installFinal.contains("? 2"));
        assertTrue(installFinal.contains("if (!fromFrontier || run.breakStanceEpisode == null)"));
        assertTrue(installFinal.contains("run.breakStanceEpisode.deadlineAtMs()"));
        assertTrue(installFinal.contains("\"reachable_seed_frontier_3d\""));

        assertTrue(resetTarget.contains("reachableSeedFrontierTraversal.clear()"));
        assertFalse(resetTarget.contains("new GatherTreeReachableSeedFrontierSession"));
        assertTrue(source.contains(
            "new GatherTreeReachableSeedFrontierSession(this.commandId)"
        ));
    }

    @Test
    void frontierUsesStageSpecificActionsAndValidatedWaypointLookahead()
        throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String traversal = methodBody(
            source,
            "private ControlDecision resolveGatherTreeReachableSeedFrontierTraversal("
        );
        String edgeLookahead = methodBody(
            source,
            "private double gatherTreeBreakStanceEdgeGuardLookahead("
        );

        assertTrue(traversal.contains("gather_tree_reachable_seed_frontier_nav3d"));
        assertTrue(traversal.contains("gather_tree_reachable_seed_frontier_nav3d_descend"));
        assertTrue(edgeLookahead.contains(
            "\"gather_tree_reachable_seed_frontier_nav3d\".equals(intent.action())"
        ));
        assertTrue(edgeLookahead.contains("run.reachableSeedFrontierTraversal"));
        assertTrue(edgeLookahead.contains("traversal.activeWaypoint()"));
        assertTrue(edgeLookahead.contains("GatherTreeBreakStanceTraversal.edgeGuardLookahead("));

        assertFalse(traversal.contains("tryNav3dDriveToward("));
        assertFalse(traversal.contains("breakStanceNav3dSelectedCount++"));
        assertFalse(traversal.contains("breakStanceNav3dReachedCount++"));
        assertFalse(traversal.contains("tunnel"));
        assertFalse(traversal.contains("pillar"));
        assertFalse(traversal.contains("bridge"));
        assertFalse(traversal.contains("constructive"));
    }

    @Test
    void stageEventsAndCompletionExposeBoundedOutcomeTelemetry() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);

        assertTrue(source.contains("gather_tree.reachable_seed_frontier_selected"));
        assertTrue(source.contains("gather_tree.reachable_seed_frontier_progress"));
        assertTrue(source.contains("gather_tree.reachable_seed_frontier_reached"));
        assertTrue(source.contains("gather_tree.reachable_seed_frontier_target_replanned"));
        assertTrue(source.contains("gather_tree.reachable_seed_frontier_rejected"));

        assertTrue(source.contains("reachableSeedFrontierSelected="));
        assertTrue(source.contains("reachableSeedFrontierProgress="));
        assertTrue(source.contains("reachableSeedFrontierReached="));
        assertTrue(source.contains("reachableSeedFrontierTargetReplanned="));
        assertTrue(source.contains("reachableSeedFrontierRejected="));
        assertTrue(source.contains("reachableSeedFrontierRejectionReasons="));
        assertTrue(source.contains("reachableSeedFrontierMaximumRouteLength="));
        assertTrue(source.contains("reachableSeedFrontierMaximumExpandedCells="));
        assertTrue(source.contains("reachableSeedFrontierMaximumProgress="));
        assertTrue(source.contains("reachableSeedFrontierCursorRegression="));
        assertTrue(source.contains("reachableSeedFrontierDuplicateStageAttempts="));
        assertTrue(source.contains("reachableSeedFrontierPostStage2d="));
        assertTrue(source.contains("reachableSeedFrontierPostStage3d="));
        assertTrue(source.contains("reachableSeedFrontierTotalComputations="));
    }

    private static String methodBody(String source, String signature) {
        int start = source.indexOf(signature);
        assertTrue(start >= 0, "missing method: " + signature);
        int openingBrace = source.indexOf('{', start);
        assertTrue(openingBrace >= 0, "missing method body: " + signature);
        int depth = 0;
        for (int index = openingBrace; index < source.length(); index++) {
            char current = source.charAt(index);
            if (current == '{') {
                depth++;
            } else if (current == '}') {
                depth--;
                if (depth == 0) {
                    return source.substring(start, index + 1);
                }
            }
        }
        throw new AssertionError("unterminated method: " + signature);
    }
}
