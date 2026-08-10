package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Proves the thread-model properties the Fabric spike depends on, without launching
 * Minecraft: the brain call is dispatched off the caller's thread, a slow brain never
 * blocks the caller, and a stale intent decays to a safe stop.
 */
class BrainLinkTest {

    private static String walkResponse(String instanceId, long ttlMs) {
        return "instanceId:" + instanceId + "\n"
            + "{\"action\":\"walk_forward\",\"forward\":true,\"ttlMs\":" + ttlMs
            + ",\"reason\":\"test\",\"commandId\":\"c1\"}\n";
    }

    private static String response(String instanceId, String json) {
        return "instanceId:" + instanceId + "\n" + json + "\n";
    }

    @Test
    void pollIsNonBlockingAndDispatchesOffThread() throws Exception {
        AtomicReference<String> transportThread = new AtomicReference<>();
        BrainLink.Transport slow = (body) -> {
            transportThread.set(Thread.currentThread().getName());
            Thread.sleep(800L); // a deliberately slow "brain"
            return walkResponse("inst-A", 500L);
        };
        BrainLink link = new BrainLink("inst-A", slow, 100L, 500L);
        try {
            String callerThread = Thread.currentThread().getName();

            long startNs = System.nanoTime();
            link.poll("{}", 0L);
            long pollMs = (System.nanoTime() - startNs) / 1_000_000L;

            // Non-blocking: poll returns at once even though the brain sleeps 800ms.
            assertTrue(pollMs < 100L, "poll must not block on the transport; took " + pollMs + "ms");
            // Until the reply lands, the effective intent is a safe stop, never a guess.
            assertEquals("stop", link.effectiveIntent(0L).action());

            // The reply eventually arrives and is delivered on a later poll.
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if (link.currentIntent().forward()) {
                    delivered = true;
                    break;
                }
                Thread.sleep(20L);
            }
            assertTrue(delivered, "slow brain reply must eventually be delivered");

            // The blocking transport ran on the dedicated IPC thread, not the caller's.
            assertEquals("mcbot-brain-ipc", transportThread.get());
            assertNotEquals(callerThread, transportThread.get());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseAppliesTtlFreshnessWindow() {
        BrainLink link = new BrainLink("inst-B", (body) -> walkResponse("inst-B", 50L), 100L, 500L);
        try {
            // Parse a fresh walk_forward as if it arrived at t=1000.
            BrainLink.Intent walk = link.parse(walkResponse("inst-B", 50L), 1000L);
            assertEquals("walk_forward", walk.action());
            assertTrue(walk.forward());
            assertFalse(walk.back());
            assertFalse(walk.left());
            assertFalse(walk.right());
            assertTrue(walk.isFresh(1049L), "within the 50ms TTL it must still be fresh");
            assertFalse(walk.isFresh(1051L), "past the TTL it must be stale");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void effectiveIntentDecaysToStopAfterTtl() throws Exception {
        // One dispatch (high min-interval), short TTL; after the TTL the effective intent must be a stop.
        BrainLink link = new BrainLink("inst-C", (body) -> walkResponse("inst-C", 30L), 10_000L, 500L);
        try {
            link.poll("{}", 0L);

            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if (link.currentIntent().forward()) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "walk intent should be delivered");

            Thread.sleep(60L); // let the 30ms TTL lapse
            BrainLink.Intent effective = link.effectiveIntent(System.currentTimeMillis());
            assertEquals("stop", effective.action());
            assertEquals("intent_expired", effective.reason());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void freshNonHeldMovementDoesNotSuppressPolling() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-nonheld",
            (body) -> {
                callCount.incrementAndGet();
                return walkResponse("inst-nonheld", 1000L);
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("walk_forward".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "movement intent should be delivered");
            int deliveredCallCount = callCount.get();
            assertTrue(deliveredCallCount >= 1,
                "delivery may already dispatch the next non-held poll on the same tick");

            link.poll("{}", System.currentTimeMillis() + 10L);
            deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline
                && callCount.get() <= deliveredCallCount) {
                link.poll("{}", System.currentTimeMillis());
                Thread.sleep(5L);
            }
            assertTrue(callCount.get() > deliveredCallCount,
                "fresh non-held movement must not hold the brain polling loop");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void initialStopIntentDoesNotExpireIntoWarningState() {
        BrainLink link = new BrainLink("inst-initial-stop", (body) -> "unused", 100L, 500L);
        try {
            BrainLink.Intent effective = link.effectiveIntent(1_000_000L);

            assertEquals("stop", effective.action());
            assertEquals("initial", effective.reason());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsExpandedControlFields() {
        BrainLink link = new BrainLink("inst-D", (body) -> "unused", 100L, 500L);
        try {
            BrainLink.Intent intent = link.parse(
                response(
                    "inst-D",
                    "{"
                        + "\"action\":\"move\","
                        + "\"forward\":false,"
                        + "\"back\":true,"
                        + "\"left\":true,"
                        + "\"right\":false,"
                        + "\"jump\":true,"
                        + "\"sneak\":true,"
                        + "\"targetYaw\":135.5,"
                        + "\"targetPitch\":-22.25,"
                        + "\"ttlMs\":250,"
                        + "\"reason\":\"roundtrip\","
                        + "\"commandId\":\"c-expanded\""
                        + "}"
                ),
                2000L
            );

            assertEquals("move", intent.action());
            assertFalse(intent.forward());
            assertTrue(intent.back());
            assertTrue(intent.left());
            assertFalse(intent.right());
            assertTrue(intent.jump());
            assertTrue(intent.sneak());
            assertNull(intent.movementForwardOverride());
            assertNull(intent.movementSidewaysOverride());
            assertEquals(135.5, intent.targetYaw());
            assertEquals(-22.25, intent.targetPitch());
            assertNull(intent.targetX());
            assertNull(intent.targetZ());
            assertNull(intent.completionInventoryLogCount());
            assertNull(intent.completionInventoryPlankCount());
            assertNull(intent.completionInventoryCobblestoneCount());
            assertNull(intent.remainingMissionIronCount());
            assertNull(intent.reservedIronPickaxeCount());
            assertNull(intent.reservedIronPickaxeDurabilityFloor());
            assertTrue(intent.waypoints().isEmpty());
            assertTrue(intent.serverCommands().isEmpty());
            assertEquals("roundtrip", intent.reason());
            assertEquals("c-expanded", intent.commandId());
            assertTrue(intent.isFresh(2249L));
            assertFalse(intent.isFresh(2251L));
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseAcceptsPositiveIntegralInventoryCompletionTargets() {
        BrainLink link = new BrainLink("inst-completion-targets", (body) -> "unused", 100L, 500L);
        try {
            BrainLink.Intent intent = link.parse(
                response(
                    "inst-completion-targets",
                    "{"
                        + "\"action\":\"gather_tree\","
                        + "\"completionInventoryLogCount\":20,"
                        + "\"completionInventoryPlankCount\":48,"
                        + "\"completionInventoryCobblestoneCount\":8,"
                        + "\"ttlMs\":100,"
                        + "\"commandId\":\"gather-completion\""
                        + "}"
                ),
                0L
            );

            assertEquals(20, intent.completionInventoryLogCount());
            assertEquals(48, intent.completionInventoryPlankCount());
            assertEquals(8, intent.completionInventoryCobblestoneCount());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRejectsMalformedOrNonPositiveInventoryCompletionTargets() {
        BrainLink link = new BrainLink("inst-invalid-completion-targets", (body) -> "unused", 100L, 500L);
        try {
            String[] invalidValues = {
                "null",
                "\"20\"",
                "true",
                "0",
                "-1",
                "19.5",
                "2147483648",
                "{}",
                "[]"
            };
            for (String invalidValue : invalidValues) {
                BrainLink.Intent intent = link.parse(
                    response(
                        "inst-invalid-completion-targets",
                        "{"
                            + "\"action\":\"gather_tree\","
                            + "\"completionInventoryLogCount\":" + invalidValue + ","
                            + "\"completionInventoryPlankCount\":" + invalidValue + ","
                            + "\"completionInventoryCobblestoneCount\":" + invalidValue + ","
                            + "\"ttlMs\":100,"
                            + "\"commandId\":\"gather-completion-invalid\""
                            + "}"
                    ),
                    0L
                );
                assertNull(intent.completionInventoryLogCount(), invalidValue);
                assertNull(intent.completionInventoryPlankCount(), invalidValue);
                assertNull(intent.completionInventoryCobblestoneCount(), invalidValue);
            }

            BrainLink.Intent absent = link.parse(
                response(
                    "inst-invalid-completion-targets",
                    "{\"action\":\"gather_tree\",\"ttlMs\":100,\"commandId\":\"gather-completion-absent\"}"
                ),
                0L
            );
            assertNull(absent.completionInventoryLogCount());
            assertNull(absent.completionInventoryPlankCount());
            assertNull(absent.completionInventoryCobblestoneCount());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseAcceptsBoundedMissionIronReserveFields() {
        BrainLink link = new BrainLink("inst-iron-reserve", (body) -> "unused", 100L, 500L);
        try {
            BrainLink.Intent intent = link.parse(
                response(
                    "inst-iron-reserve",
                    "{"
                        + "\"action\":\"mine_nearby_iron\","
                        + "\"remainingMissionIronCount\":24,"
                        + "\"reservedIronPickaxeCount\":1,"
                        + "\"reservedIronPickaxeDurabilityFloor\":64,"
                        + "\"ttlMs\":100,"
                        + "\"commandId\":\"iron-reserve\""
                        + "}"
                ),
                0L
            );

            assertEquals(24, intent.remainingMissionIronCount());
            assertEquals(1, intent.reservedIronPickaxeCount());
            assertEquals(64, intent.reservedIronPickaxeDurabilityFloor());

            BrainLink.Intent boundaries = link.parse(
                response(
                    "inst-iron-reserve",
                    "{"
                        + "\"action\":\"mine_nearby_iron\","
                        + "\"remainingMissionIronCount\":64,"
                        + "\"reservedIronPickaxeCount\":2,"
                        + "\"reservedIronPickaxeDurabilityFloor\":250,"
                        + "\"ttlMs\":100,"
                        + "\"commandId\":\"iron-reserve-boundaries\""
                        + "}"
                ),
                0L
            );
            assertEquals(64, boundaries.remainingMissionIronCount());
            assertEquals(2, boundaries.reservedIronPickaxeCount());
            assertEquals(250, boundaries.reservedIronPickaxeDurabilityFloor());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRejectsMalformedOrOutOfRangeMissionIronReserveFields() {
        BrainLink link = new BrainLink("inst-invalid-iron-reserve", (body) -> "unused", 100L, 500L);
        try {
            String[][] invalidValues = {
                {"null", "null", "null"},
                {"\"24\"", "\"1\"", "\"64\""},
                {"true", "true", "true"},
                {"-1", "-1", "-1"},
                {"24.5", "1.5", "64.5"},
                {"65", "3", "251"},
                {"2147483648", "2147483648", "2147483648"},
                {"{}", "{}", "{}"},
                {"[]", "[]", "[]"}
            };
            for (String[] invalid : invalidValues) {
                BrainLink.Intent intent = link.parse(
                    response(
                        "inst-invalid-iron-reserve",
                        "{"
                            + "\"action\":\"mine_nearby_iron\","
                            + "\"remainingMissionIronCount\":" + invalid[0] + ","
                            + "\"reservedIronPickaxeCount\":" + invalid[1] + ","
                            + "\"reservedIronPickaxeDurabilityFloor\":" + invalid[2] + ","
                            + "\"ttlMs\":100,"
                            + "\"commandId\":\"invalid-iron-reserve\""
                            + "}"
                    ),
                    0L
                );
                assertNull(intent.remainingMissionIronCount(), invalid[0]);
                assertNull(intent.reservedIronPickaxeCount(), invalid[1]);
                assertNull(intent.reservedIronPickaxeDurabilityFloor(), invalid[2]);
            }

            BrainLink.Intent zeroes = link.parse(
                response(
                    "inst-invalid-iron-reserve",
                    "{"
                        + "\"action\":\"mine_nearby_iron\","
                        + "\"remainingMissionIronCount\":0,"
                        + "\"reservedIronPickaxeCount\":0,"
                        + "\"reservedIronPickaxeDurabilityFloor\":0,"
                        + "\"ttlMs\":100,"
                        + "\"commandId\":\"zero-iron-reserve\""
                        + "}"
                ),
                0L
            );
            assertEquals(0, zeroes.remainingMissionIronCount());
            assertEquals(0, zeroes.reservedIronPickaxeCount());
            assertEquals(0, zeroes.reservedIronPickaxeDurabilityFloor());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void compatibilityConstructorLeavesMissionIronReserveAbsent() {
        BrainLink.Intent intent = new BrainLink.Intent(
            "move",
            true,
            false,
            false,
            false,
            false,
            false,
            null,
            null,
            null,
            null,
            null,
            null,
            List.of(),
            List.of(),
            null,
            List.of(),
            100L,
            "compatibility",
            "compatibility-command"
        );

        assertNull(intent.remainingMissionIronCount());
        assertNull(intent.reservedIronPickaxeCount());
        assertNull(intent.reservedIronPickaxeDurabilityFloor());
    }

    @Test
    void actionVocabularyInfersMovementWhenBooleansAreAbsent() {
        BrainLink link = new BrainLink("inst-E", (body) -> "unused", 100L, 500L);
        try {
            assertTrue(link.parse(response("inst-E", "{\"action\":\"walk_forward\",\"ttlMs\":100}"), 0L).forward());
            assertTrue(link.parse(response("inst-E", "{\"action\":\"walk_backward\",\"ttlMs\":100}"), 0L).back());
            assertTrue(link.parse(response("inst-E", "{\"action\":\"walk_back\",\"ttlMs\":100}"), 0L).back());
            assertTrue(link.parse(response("inst-E", "{\"action\":\"strafe_left\",\"ttlMs\":100}"), 0L).left());
            assertTrue(link.parse(response("inst-E", "{\"action\":\"strafe_right\",\"ttlMs\":100}"), 0L).right());
            assertTrue(link.parse(response("inst-E", "{\"action\":\"jump\",\"ttlMs\":100}"), 0L).jump());
            assertTrue(link.parse(response("inst-E", "{\"action\":\"sneak\",\"ttlMs\":100}"), 0L).sneak());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void inputStateForMapsMovementAxesAndButtons() {
        BrainLink.Intent intent = new BrainLink.Intent(
            "move",
            true,
            false,
            true,
            false,
            true,
            true,
            null,
            null,
            null,
            null,
            List.of(),
            List.of(),
            null,
            List.of(),
            100L,
            "test",
            "c-input"
        );

        InputState state = BrainLink.inputStateFor(intent);
        assertTrue(state.pressingForward());
        assertFalse(state.pressingBack());
        assertTrue(state.pressingLeft());
        assertFalse(state.pressingRight());
        assertTrue(state.jumping());
        assertTrue(state.sneaking());
        assertEquals(1.0F, state.movementForward());
        assertEquals(1.0F, state.movementSideways());
    }

    @Test
    void inputStateForStopsAndCancelsOpposedAxes() {
        assertEquals(InputState.stop(), BrainLink.inputStateFor(null));
        assertEquals(InputState.stop(), BrainLink.inputStateFor(BrainLink.Intent.stop("manual")));

        BrainLink.Intent opposed = new BrainLink.Intent(
            "move",
            true,
            true,
            true,
            true,
            false,
            false,
            null,
            null,
            null,
            null,
            List.of(),
            List.of(),
            null,
            List.of(),
            100L,
            "opposed",
            "c-opposed"
        );
        InputState state = BrainLink.inputStateFor(opposed);
        assertTrue(state.pressingForward());
        assertTrue(state.pressingBack());
        assertTrue(state.pressingLeft());
        assertTrue(state.pressingRight());
        assertEquals(0.0F, state.movementForward());
        assertEquals(0.0F, state.movementSideways());
    }

    @Test
    void inputStateForAppliesClampedMovementOverrides() {
        BrainLink.Intent intent = new BrainLink.Intent(
            "move",
            true,
            false,
            false,
            true,
            false,
            false,
            0.35D,
            -2.0D,
            null,
            null,
            null,
            null,
            List.of(),
            List.of(),
            null,
            List.of(),
            100L,
            "override",
            "c-override"
        );

        InputState state = BrainLink.inputStateFor(intent);
        assertTrue(state.pressingForward());
        assertTrue(state.pressingRight());
        assertEquals(0.35F, state.movementForward());
        assertEquals(-1.0F, state.movementSideways());
    }

    @Test
    void parsesExactVillageDetourCorrelationFields() {
        BrainLink link = new BrainLink("inst-village", body -> "unused", 100L, 500L);
        try {
            BrainLink.Intent intent = link.parse(response(
                "inst-village",
                "{\"action\":\"village_travel\",\"targetX\":4,\"targetY\":70,"
                    + "\"targetZ\":8,\"opportunityId\":\"Village:Opaque-A\","
                    + "\"opportunityRevision\":9,\"opportunityStage\":\"travel_edge\","
                    + "\"opportunityMission\":\"iron_armor\","
                    + "\"detourId\":\"village-detour-XyZ\",\"detourStageSeq\":3,"
                    + "\"resumeToken\":\"resume-Aa\",\"ttlMs\":500,"
                    + "\"commandId\":\"mission-village-3\"}"), 10L);

            assertEquals("Village:Opaque-A", intent.opportunityId());
            assertEquals(9L, intent.opportunityRevision());
            assertEquals("travel_edge", intent.opportunityStage());
            assertEquals("iron_armor", intent.opportunityMission());
            assertEquals("village-detour-XyZ", intent.detourId());
            assertEquals(3, intent.detourStageSeq());
            assertEquals("resume-Aa", intent.resumeToken());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void golemOpportunityIsHeldAndPreservesOpaqueOpportunityIdentity() {
        BrainLink link = new BrainLink("inst-golem", body -> "unused", 100L, 500L);
        try {
            BrainLink.Intent intent = link.parse(response(
                "inst-golem",
                "{\"action\":\"village_defeat_iron_golem\","
                    + "\"targetX\":4,\"targetY\":70,\"targetZ\":8,"
                    + "\"opportunityId\":\"entity:opaque-golem-A\","
                    + "\"opportunityRevision\":12,\"opportunityStage\":\"defeat_golem\","
                    + "\"opportunityMission\":\"armor\","
                    + "\"detourId\":\"village-detour-golem\",\"detourStageSeq\":4,"
                    + "\"resumeToken\":\"resume-golem\",\"ttlMs\":1,"
                    + "\"commandId\":\"mission-village-golem-4\"}"), 10L);

            assertEquals("village_defeat_iron_golem", intent.action());
            assertEquals("entity:opaque-golem-A", intent.opportunityId());
            assertEquals("defeat_golem", intent.opportunityStage());
            assertTrue(intent.expiresAtMs() < 10_000L,
                "the executor-owned action is parsed independently of its ordinary TTL");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void rejectsNegativeVillageRevisionsAndStageSequences() {
        BrainLink link = new BrainLink("inst-village-invalid", body -> "unused", 100L, 500L);
        try {
            BrainLink.Intent intent = link.parse(response(
                "inst-village-invalid",
                "{\"action\":\"village_travel\",\"targetX\":1,\"targetY\":70,"
                    + "\"targetZ\":1,\"opportunityRevision\":-1,"
                    + "\"detourStageSeq\":-2,\"ttlMs\":500}"), 10L);
            assertNull(intent.opportunityRevision());
            assertNull(intent.detourStageSeq());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void malformedFieldsDefaultSafely() {
        BrainLink link = new BrainLink("inst-F", (body) -> "unused", 100L, 500L);
        try {
            BrainLink.Intent intent = link.parse(
                response(
                    "inst-F",
                    "{"
                        + "\"action\":\"move\","
                        + "\"forward\":\"not-a-boolean\","
                        + "\"back\":{},"
                        + "\"left\":true,"
                        + "\"jump\":123,"
                        + "\"sneak\":null,"
                        + "\"movementForward\":\"bad\","
                        + "\"yaw\":\"not-a-number\","
                        + "\"pitch\":[],"
                        + "\"ttlMs\":100"
                        + "}"
                ),
                0L
            );

            assertFalse(intent.forward());
            assertFalse(intent.back());
            assertTrue(intent.left());
            assertFalse(intent.jump());
            assertFalse(intent.sneak());
            assertNull(intent.movementForwardOverride());
            assertNull(intent.targetYaw());
            assertNull(intent.targetPitch());

            BrainLink.Intent missingTtl = link.parse(
                response("inst-F", "{\"action\":\"move\",\"forward\":true,\"ttlMs\":\"bad\"}"),
                0L
            );
            assertEquals("stop", missingTtl.action());
            assertFalse(missingTtl.forward());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsNavigationTargets() {
        BrainLink link = new BrainLink("inst-G", (body) -> "unused", 100L, 500L);
        try {
            BrainLink.Intent intent = link.parse(
                response(
                    "inst-G",
                    "{"
                        + "\"action\":\"navigate_to_point\","
                        + "\"targetX\":12.5,"
                        + "\"targetZ\":-4.5,"
                        + "\"arriveEpsilon\":0.45,"
                        + "\"waypoints\":[{\"x\":10,\"z\":-4},{\"x\":12,\"z\":-4}],"
                        + "\"blockedCells\":[{\"x\":11,\"z\":-4}],"
                        + "\"serverCommands\":[\"tp @p 0 80 0\"],"
                        + "\"ttlMs\":250,"
                        + "\"commandId\":\"nav-1\""
                        + "}"
                ),
                5000L
            );

            assertEquals("navigate_to_point", intent.action());
            assertEquals(12.5D, intent.targetX());
            assertEquals(-4.5D, intent.targetZ());
            assertEquals(0.45D, intent.arriveEpsilon());
            assertEquals(List.of(new GridCell(10, -4), new GridCell(12, -4)), intent.waypoints());
            assertEquals(List.of(new GridCell(11, -4)), intent.blockedCells());
            assertEquals(List.of("tp @p 0 80 0"), intent.serverCommands());
            assertEquals("nav-1", intent.commandId());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsNavigationProbeTargets() {
        BrainLink link = new BrainLink("inst-probe", (body) -> "unused", 100L, 500L);
        try {
            BrainLink.Intent intent = link.parse(
                response(
                    "inst-probe",
                    "{"
                        + "\"action\":\"probe_navigation\","
                        + "\"targetX\":42.5,"
                        + "\"targetZ\":17.5,"
                        + "\"arriveEpsilon\":0.8,"
                        + "\"ttlMs\":250,"
                        + "\"reason\":\"probing_navigation\","
                        + "\"commandId\":\"probe-1\""
                        + "}"
                ),
                100L
            );

            assertEquals("probe_navigation", intent.action());
            assertEquals(42.5D, intent.targetX());
            assertEquals(17.5D, intent.targetZ());
            assertEquals(0.8D, intent.arriveEpsilon());
            assertEquals("probing_navigation", intent.reason());
            assertEquals("probe-1", intent.commandId());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsGatherLogBlockTargets() {
        BrainLink link = new BrainLink("inst-gather", (body) -> "unused", 100L, 10_000L);
        try {
            BrainLink.Intent intent = link.parse(
                response(
                    "inst-gather",
                    "{"
                        + "\"action\":\"gather_log\","
                        + "\"targetX\":12,"
                        + "\"targetY\":64,"
                        + "\"targetZ\":-4,"
                        + "\"ttlMs\":5000,"
                        + "\"reason\":\"pick_log\","
                        + "\"commandId\":\"gather-1\""
                        + "}"
                ),
                100L
            );

            assertEquals("gather_log", intent.action());
            assertEquals(12.0D, intent.targetX());
            assertEquals(64.0D, intent.targetY());
            assertEquals(-4.0D, intent.targetZ());
            assertEquals("pick_log", intent.reason());
            assertEquals("gather-1", intent.commandId());
            assertTrue(intent.isFresh(5099L));
        } finally {
            link.shutdown();
        }
    }

    @Test
    void freshGatherLogIntentHoldsFurtherBrainPolling() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-hold",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-hold",
                    "{"
                        + "\"action\":\"gather_log\","
                        + "\"targetX\":1,"
                        + "\"targetY\":64,"
                        + "\"targetZ\":2,"
                        + "\"ttlMs\":1000,"
                        + "\"commandId\":\"gather-hold\""
                        + "}"
                );
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("gather_log".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "gather intent should be delivered");
            assertEquals(1, callCount.get());

            long now = System.currentTimeMillis();
            for (int i = 0; i < 10; i++) {
                link.poll("{}", now + i * 50L);
            }
            assertEquals(1, callCount.get(), "fresh gather_log must let the fast loop own the sequence");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void expiredHeldFastLoopCommandKeepsOwnershipUntilCompletion() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-expired-descent-hold",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-expired-descent-hold",
                    "{"
                        + "\"action\":\"descend_staircase\","
                        + "\"targetX\":-1,"
                        + "\"targetY\":16,"
                        + "\"targetZ\":19,"
                        + "\"ttlMs\":45000,"
                        + "\"reason\":\"mission:DESCEND\","
                        + "\"commandId\":\"descend-hold\""
                        + "}"
                );
            },
            0L,
            500L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("descend_staircase".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "descend intent should be delivered");
            assertEquals(1, callCount.get());

            long futureAfterShortTtl = System.currentTimeMillis() + 10_000L;
            assertEquals("descend_staircase", link.effectiveIntent(futureAfterShortTtl).action());
            for (int i = 0; i < 10; i++) {
                link.poll("{}", futureAfterShortTtl + i * 1000L);
            }
            assertEquals(1, callCount.get(), "expired held descent must not mint replacement commands before completion");

            link.completeCurrentCommand(
                "descend-hold",
                "descent_failed:descent_player_in_hazard:water:-1, 24, 11",
                futureAfterShortTtl + 11_000L
            );
            BrainLink.Intent completed = link.effectiveIntent(futureAfterShortTtl + 11_001L);
            assertEquals("stop", completed.action());
            assertEquals("descent_failed:descent_player_in_hazard:water:-1, 24, 11", completed.reason());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsGatherTreeBlockTargetsAndHoldsPolling() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-tree",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-tree",
                    "{"
                        + "\"action\":\"gather_tree\","
                        + "\"targetX\":1,"
                        + "\"targetY\":64,"
                        + "\"targetZ\":2,"
                        + "\"ttlMs\":1000,"
                        + "\"reason\":\"tree\","
                        + "\"commandId\":\"tree-hold\""
                        + "}"
                );
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("gather_tree".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "gather_tree intent should be delivered");
            assertEquals(1.0D, link.currentIntent().targetX());
            assertEquals(64.0D, link.currentIntent().targetY());
            assertEquals(2.0D, link.currentIntent().targetZ());
            assertEquals(1, callCount.get());

            long now = System.currentTimeMillis();
            for (int i = 0; i < 10; i++) {
                link.poll("{}", now + i * 50L);
            }
            assertEquals(1, callCount.get(), "fresh gather_tree must let the fast loop own the sequence");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseHoldsTargetlessGatherTreeForLiveClientSeedSelection() {
        BrainLink link = new BrainLink("inst-tree-live", (body) -> "unused", 100L, 2_000L);
        try {
            BrainLink.Intent intent = link.parse(
                response(
                    "inst-tree-live",
                    "{"
                        + "\"action\":\"gather_tree\","
                        + "\"ttlMs\":1000,"
                        + "\"reason\":\"mission:GATHER_WOOD\","
                        + "\"commandId\":\"tree-live\""
                        + "}"
                ),
                2000L
            );

            assertEquals("gather_tree", intent.action());
            assertNull(intent.targetX());
            assertNull(intent.targetY());
            assertNull(intent.targetZ());
            assertEquals("mission:GATHER_WOOD", intent.reason());
            assertEquals("tree-live", intent.commandId());
            assertTrue(intent.isFresh(2999L));
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsCraftPlanksAndHoldsPolling() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-craft",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-craft",
                    "{"
                        + "\"action\":\"craft_planks\","
                        + "\"ttlMs\":1000,"
                        + "\"reason\":\"craft\","
                        + "\"commandId\":\"craft-hold\""
                        + "}"
                );
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("craft_planks".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "craft_planks intent should be delivered");
            assertEquals(1, callCount.get());

            long now = System.currentTimeMillis();
            for (int i = 0; i < 10; i++) {
                link.poll("{}", now + i * 50L);
            }
            assertEquals(1, callCount.get(), "fresh craft_planks must let the fast loop own the sequence");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsEatAndHoldsPolling() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-eat",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-eat",
                    "{"
                        + "\"action\":\"eat\","
                        + "\"ttlMs\":1000,"
                        + "\"reason\":\"mission:EAT\","
                        + "\"commandId\":\"eat-hold\""
                        + "}"
                );
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("eat".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "eat intent should be delivered");
            assertEquals("mission:EAT", link.currentIntent().reason());
            assertEquals("eat-hold", link.currentIntent().commandId());
            assertEquals(1, callCount.get());

            long now = System.currentTimeMillis();
            for (int i = 0; i < 10; i++) {
                link.poll("{}", now + i * 50L);
            }
            assertEquals(1, callCount.get(), "fresh eat must let the fast survival loop own the sequence");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsShapedCraftsAndHoldsPolling() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-shaped-craft",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-shaped-craft",
                    "{"
                        + "\"action\":\"craft_sticks\","
                        + "\"ttlMs\":1000,"
                        + "\"reason\":\"sticks\","
                        + "\"commandId\":\"craft-sticks-hold\""
                        + "}"
                );
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("craft_sticks".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "craft_sticks intent should be delivered");
            assertEquals(1, callCount.get());

            long now = System.currentTimeMillis();
            for (int i = 0; i < 10; i++) {
                link.poll("{}", now + i * 50L);
            }
            assertEquals(1, callCount.get(), "fresh shaped craft must let the fast loop own the sequence");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void completeCurrentCommandReleasesHeldCraftIntent() {
        BrainLink link = new BrainLink(
            "inst-craft-release",
            (body) -> response("inst-craft-release", "{\"action\":\"craft_planks\",\"ttlMs\":250,\"commandId\":\"craft-release\"}"),
            0L,
            500L
        );
        try {
            link.poll("{}", 20L);
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline && !"craft_planks".equals(link.currentIntent().action())) {
                link.poll("{}", System.currentTimeMillis());
            }
            assertEquals("craft_planks", link.currentIntent().action());
            link.completeCurrentCommand("missing", "wrong", 20L);
            assertEquals("craft_planks", link.currentIntent().action());
            link.completeCurrentCommand("craft-release", "craft_done", 30L);
            assertEquals("stop", link.currentIntent().action());
            assertEquals("craft_done", link.currentIntent().reason());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void lateHeldIntentForCompletedCommandIsSuppressed() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-completed-late",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-completed-late",
                    "{"
                        + "\"action\":\"return_staircase\","
                        + "\"targetX\":1,"
                        + "\"targetY\":64,"
                        + "\"targetZ\":0,"
                        + "\"ttlMs\":1000,"
                        + "\"reason\":\"late-return\","
                        + "\"commandId\":\"return-done\""
                        + "}"
                );
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline && !"return_staircase".equals(link.currentIntent().action())) {
                link.poll("{}", System.currentTimeMillis());
                Thread.sleep(5L);
            }
            assertEquals("return_staircase", link.currentIntent().action());

            link.completeCurrentCommand("return-done", "return_done", System.currentTimeMillis());
            assertEquals("stop", link.currentIntent().action());

            link.poll("{}", System.currentTimeMillis());
            deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline && callCount.get() < 2) {
                link.poll("{}", System.currentTimeMillis());
                Thread.sleep(5L);
            }
            deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline && link.diagnostics(System.currentTimeMillis()).completedRequestCount() < 2) {
                link.poll("{}", System.currentTimeMillis());
                Thread.sleep(5L);
            }
            link.poll("{}", System.currentTimeMillis());

            assertEquals(2, callCount.get());
            assertEquals("stop", link.currentIntent().action());
            assertEquals("return_done", link.currentIntent().reason());
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsPlaceTableAndHoldsPolling() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-place-table",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-place-table",
                    "{"
                        + "\"action\":\"place_table\","
                        + "\"ttlMs\":1000,"
                        + "\"reason\":\"place\","
                        + "\"commandId\":\"place-table-hold\""
                        + "}"
                );
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("place_table".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "place_table intent should be delivered");
            assertEquals(1, callCount.get());

            long now = System.currentTimeMillis();
            for (int i = 0; i < 10; i++) {
                link.poll("{}", now + i * 50L);
            }
            assertEquals(1, callCount.get(), "fresh place_table must let the fast loop own the sequence");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsCraftPickaxeAndHoldsPolling() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-craft-pickaxe",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-craft-pickaxe",
                    "{"
                        + "\"action\":\"craft_pickaxe\","
                        + "\"ttlMs\":1000,"
                        + "\"reason\":\"pickaxe\","
                        + "\"commandId\":\"craft-pickaxe-hold\""
                        + "}"
                );
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("craft_pickaxe".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "craft_pickaxe intent should be delivered");
            assertEquals(1, callCount.get());

            long now = System.currentTimeMillis();
            for (int i = 0; i < 10; i++) {
                link.poll("{}", now + i * 50L);
            }
            assertEquals(1, callCount.get(), "fresh craft_pickaxe must let the fast loop own the table sequence");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsStoneToolCraftAndHoldsPolling() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-craft-stone-pickaxe",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-craft-stone-pickaxe",
                    "{"
                        + "\"action\":\"craft_stone_pickaxe\","
                        + "\"ttlMs\":1000,"
                        + "\"reason\":\"stone_pickaxe\","
                        + "\"commandId\":\"craft-stone-pickaxe-hold\""
                        + "}"
                );
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("craft_stone_pickaxe".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "craft_stone_pickaxe intent should be delivered");
            assertEquals(1, callCount.get());

            long now = System.currentTimeMillis();
            for (int i = 0; i < 10; i++) {
                link.poll("{}", now + i * 50L);
            }
            assertEquals(1, callCount.get(), "fresh craft_stone_pickaxe must let the fast loop own the table sequence");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsFurnacePlacementAndHoldsPolling() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-place-furnace",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-place-furnace",
                    "{"
                        + "\"action\":\"place_furnace\","
                        + "\"ttlMs\":1000,"
                        + "\"reason\":\"place_furnace\","
                        + "\"commandId\":\"place-furnace-hold\""
                        + "}"
                );
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("place_furnace".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "place_furnace intent should be delivered");
            assertEquals(1, callCount.get());

            long now = System.currentTimeMillis();
            for (int i = 0; i < 10; i++) {
                link.poll("{}", now + i * 50L);
            }
            assertEquals(1, callCount.get(), "fresh place_furnace must let the fast loop own placement");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsSmeltCharcoalAndHoldsPolling() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-smelt-charcoal",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-smelt-charcoal",
                    "{"
                        + "\"action\":\"smelt_charcoal\","
                        + "\"ttlMs\":1000,"
                        + "\"reason\":\"smelt_charcoal\","
                        + "\"commandId\":\"smelt-charcoal-hold\""
                        + "}"
                );
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("smelt_charcoal".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "smelt_charcoal intent should be delivered");
            assertEquals(1, callCount.get());

            long now = System.currentTimeMillis();
            for (int i = 0; i < 10; i++) {
                link.poll("{}", now + i * 50L);
            }
            assertEquals(1, callCount.get(), "fresh smelt_charcoal must let the fast loop own the furnace wait");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsMakeCharcoalAndHoldsPolling() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-make-charcoal",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-make-charcoal",
                    "{"
                        + "\"action\":\"make_charcoal\","
                        + "\"ttlMs\":1000,"
                        + "\"reason\":\"make_charcoal\","
                        + "\"commandId\":\"make-charcoal-hold\""
                        + "}"
                );
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("make_charcoal".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "make_charcoal intent should be delivered");
            assertEquals(1, callCount.get());

            long now = System.currentTimeMillis();
            for (int i = 0; i < 10; i++) {
                link.poll("{}", now + i * 50L);
            }
            assertEquals(1, callCount.get(), "fresh make_charcoal must let the fast loop own the composite");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsMineStoneAndHoldsPolling() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-mine-stone",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-mine-stone",
                    "{"
                        + "\"action\":\"mine_stone\","
                        + "\"targetX\":1,"
                        + "\"targetY\":64,"
                        + "\"targetZ\":0,"
                        + "\"ttlMs\":1000,"
                        + "\"reason\":\"stone\","
                        + "\"commandId\":\"mine-stone-hold\""
                        + "}"
                );
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("mine_stone".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "mine_stone intent should be delivered");
            assertEquals(1, callCount.get());

            long now = System.currentTimeMillis();
            for (int i = 0; i < 10; i++) {
                link.poll("{}", now + i * 50L);
            }
            assertEquals(1, callCount.get(), "fresh mine_stone must let the fast loop own the mining sequence");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsR2CompositeAndHoldsPolling() throws Exception {
        AtomicInteger callCount = new AtomicInteger();
        BrainLink link = new BrainLink(
            "inst-r2",
            (body) -> {
                callCount.incrementAndGet();
                return response(
                    "inst-r2",
                    "{"
                        + "\"action\":\"r2_mine_stone_return\","
                        + "\"targetX\":6,"
                        + "\"targetY\":58,"
                        + "\"targetZ\":0,"
                        + "\"ttlMs\":1000,"
                        + "\"reason\":\"cobble\","
                        + "\"commandId\":\"r2-hold\""
                        + "}"
                );
            },
            0L,
            2_000L
        );
        try {
            link.poll("{}", 0L);
            boolean delivered = false;
            long deadline = System.currentTimeMillis() + 2000L;
            while (System.currentTimeMillis() < deadline) {
                link.poll("{}", System.currentTimeMillis());
                if ("r2_mine_stone_return".equals(link.currentIntent().action())) {
                    delivered = true;
                    break;
                }
                Thread.sleep(5L);
            }
            assertTrue(delivered, "r2 composite intent should be delivered");
            assertEquals(6.0D, link.currentIntent().targetX());
            assertEquals(58.0D, link.currentIntent().targetY());
            assertEquals(0.0D, link.currentIntent().targetZ());
            assertEquals(1, callCount.get());

            long now = System.currentTimeMillis();
            for (int i = 0; i < 10; i++) {
                link.poll("{}", now + i * 50L);
            }
            assertEquals(1, callCount.get(), "fresh r2 composite must let the fast loop own the sequence");
        } finally {
            link.shutdown();
        }
    }

    @Test
    void parseRoundTripsMovementOverrides() {
        BrainLink link = new BrainLink("inst-H", (body) -> "unused", 100L, 500L);
        try {
            BrainLink.Intent intent = link.parse(
                response(
                    "inst-H",
                    "{"
                        + "\"action\":\"move\","
                        + "\"forward\":true,"
                        + "\"right\":true,"
                        + "\"movementForward\":0.42,"
                        + "\"movementSideways\":-0.25,"
                        + "\"ttlMs\":250"
                        + "}"
                ),
                10L
            );

            assertTrue(intent.forward());
            assertTrue(intent.right());
            assertEquals(0.42D, intent.movementForwardOverride());
            assertEquals(-0.25D, intent.movementSidewaysOverride());
            InputState state = BrainLink.inputStateFor(intent);
            assertEquals(0.42F, state.movementForward());
            assertEquals(-0.25F, state.movementSideways());
        } finally {
            link.shutdown();
        }
    }
}
