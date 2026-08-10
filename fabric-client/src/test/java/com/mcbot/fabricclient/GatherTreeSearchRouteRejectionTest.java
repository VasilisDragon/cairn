package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class GatherTreeSearchRouteRejectionTest {
    @Test
    void activeSearchEdgeVetoSuppressesPositionalArrivalOnlyForTheSameRoute() {
        assertTrue(GatherTreeSearchRouteRejection.arrivalSuppressedByEdgeVeto(
            "mission-1", "mission-1:tree:search", 1));
        assertFalse(GatherTreeSearchRouteRejection.arrivalSuppressedByEdgeVeto(
            "mission-1", "mission-1:tree:search", 0));
        assertFalse(GatherTreeSearchRouteRejection.arrivalSuppressedByEdgeVeto(
            "mission-1", "mission-2:tree:search", 8));
        assertFalse(GatherTreeSearchRouteRejection.arrivalSuppressedByEdgeVeto(
            null, "mission-1:tree:search", 8));
        assertEquals(0.0D, GatherTreeSearchRouteRejection.navigationArriveEpsilon(0.8D, true));
        assertEquals(0.8D, GatherTreeSearchRouteRejection.navigationArriveEpsilon(0.8D, false));
    }

    @Test
    void signatureIsImmutableStableAndSensitiveToGoalAndInteriorRoute() {
        List<GridCell> mutable = new ArrayList<>(List.of(
            new GridCell(0, 0),
            new GridCell(1, 0),
            new GridCell(1, 1)
        ));
        var signature = GatherTreeSearchRouteRejection.signature(new GridCell(1, 1), mutable);
        String eventId = signature.eventId();
        mutable.set(1, new GridCell(0, 1));

        assertEquals(List.of(
            new GridCell(0, 0),
            new GridCell(1, 0),
            new GridCell(1, 1)
        ), signature.route());
        assertEquals(eventId, GatherTreeSearchRouteRejection.signature(
            new GridCell(1, 1),
            signature.route()
        ).eventId());
        assertNotEquals(eventId, GatherTreeSearchRouteRejection.signature(
            new GridCell(1, 1),
            List.of(new GridCell(0, 0), new GridCell(0, 1), new GridCell(1, 1))
        ).eventId());
        assertNotEquals(eventId, GatherTreeSearchRouteRejection.signature(
            new GridCell(2, 1),
            signature.route()
        ).eventId());
    }

    @Test
    void runRejectsCurrentRouteAtomicallyWithoutChangingBudgetsOrClock() {
        McbotFabricClient.GatherTreeSearchRun run =
            new McbotFabricClient.GatherTreeSearchRun("mission-1", new GridCell(0, 0), 64, 1_000L);
        run.goal = new GridCell(2, 1);
        run.route = List.of(new GridCell(0, 0), new GridCell(1, 0), new GridCell(2, 0), run.goal);
        run.routeReason = "loaded_log_approach";
        run.routeAttempts = 2;
        run.routeUnavailableStreak = 1;
        run.noRouteLogged = true;
        run.nextRouteRetryAtMs = 9_000L;
        run.searchTargetCached = true;
        run.searchTargetCacheKey = 44L;
        run.searchTargetCachedAtMs = 5_000L;

        GatherTreeSearchRouteRejection.Rejected rejected = run.rejectCurrentRoute();

        assertEquals(new GridCell(2, 1), rejected.goal());
        assertEquals("loaded_log_approach", rejected.routeReason());
        assertFalse(rejected.repeatedSignature());
        assertTrue(run.visitedGoals.contains(new GridCell(2, 1)));
        assertTrue(run.rejectedRouteSignatures.contains(rejected.signature()));
        assertNull(run.goal);
        assertEquals(List.of(), run.route);
        assertEquals("", run.routeReason);
        assertFalse(run.searchTargetCached);
        assertEquals(Long.MIN_VALUE, run.searchTargetCacheKey);
        assertEquals(0L, run.searchTargetCachedAtMs);
        assertEquals(2, run.routeAttempts);
        assertEquals(1, run.routeUnavailableStreak);
        assertTrue(run.noRouteLogged);
        assertEquals(9_000L, run.nextRouteRetryAtMs);
        assertEquals(1_000L, run.startedAtMs);
    }

    @Test
    void sameRejectedSignatureIsRecognizedAndEmptyRouteIsNotATransition() {
        McbotFabricClient.GatherTreeSearchRun run =
            new McbotFabricClient.GatherTreeSearchRun("mission-1", new GridCell(0, 0), 64, 1_000L);
        GridCell goal = new GridCell(2, 0);
        List<GridCell> route = List.of(new GridCell(0, 0), new GridCell(1, 0), goal);
        GatherTreeSearchRouteRejection.Signature signature =
            GatherTreeSearchRouteRejection.signature(goal, route);
        run.rejectedRouteSignatures.add(signature);
        run.goal = goal;
        run.route = route;

        assertTrue(run.rejectCurrentRoute().repeatedSignature());
        assertNull(run.rejectCurrentRoute());
    }

    @Test
    void rejectedRouteIsSuppressedAcrossRelocationWhileDistinctRouteRemainsEligible() {
        McbotFabricClient.GatherTreeSearchRun original =
            new McbotFabricClient.GatherTreeSearchRun("mission-1", new GridCell(0, 0), 64, 1_000L);
        McbotFabricClient.GatherTreeSearchTarget rejected = new McbotFabricClient.GatherTreeSearchTarget(
            new GridCell(2, 0),
            List.of(new GridCell(0, 0), new GridCell(1, 0), new GridCell(2, 0)),
            "loaded_log_approach"
        );
        original.goal = rejected.goal();
        original.route = rejected.route();
        original.rejectCurrentRoute();

        McbotFabricClient.GatherTreeSearchRun relocated =
            new McbotFabricClient.GatherTreeSearchRun("mission-1", new GridCell(5, 0), 64, 2_000L);
        relocated.inheritRejectedRoutes(original);
        McbotFabricClient.GatherTreeSearchTarget distinct = new McbotFabricClient.GatherTreeSearchTarget(
            new GridCell(2, 1),
            List.of(new GridCell(0, 0), new GridCell(0, 1), new GridCell(1, 1), new GridCell(2, 1)),
            "loaded_log_approach"
        );

        assertTrue(relocated.rejects(rejected));
        assertFalse(relocated.rejects(distinct));
        assertEquals(0, relocated.repeatedRejectedRouteSignatureCount);
    }

    @Test
    void rejectionMetricsSurviveRelocation() {
        McbotFabricClient.GatherTreeSearchRun original =
            new McbotFabricClient.GatherTreeSearchRun("mission-1", new GridCell(0, 0), 64, 1_000L);
        original.recordEdgeRouteRejection("continuous_edge_veto", false);
        original.recordEdgeRouteRejection("continuous_edge_veto", true);
        original.observe(19, 20.0D);
        original.observe(19, 17.5D);

        McbotFabricClient.GatherTreeSearchRun relocated =
            new McbotFabricClient.GatherTreeSearchRun("mission-1", new GridCell(5, 0), 64, 2_000L);
        relocated.inheritRejectedRoutes(original);
        relocated.inheritEvidence(original);
        relocated.observe(20, 19.0D);

        assertEquals(2, relocated.edgeRouteRejectedCount);
        assertEquals(2, relocated.edgeRouteRejectionReasons.get("continuous_edge_veto"));
        assertEquals(1, relocated.repeatedRejectedRouteSignatureCount);
        assertEquals(19, relocated.inventoryLogsBefore);
        assertEquals(20, relocated.inventoryLogsAfter);
        assertEquals(20.0D, relocated.healthBefore);
        assertEquals(17.5D, relocated.minimumHealth);
        assertEquals(19.0D, relocated.healthAfter);
    }
}
