package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import java.util.List;
import net.minecraft.util.ActionResult;
import org.junit.jupiter.api.Test;

class IronGolemAttackControllerTest {
    private static final String COMMAND = "village:golem:30";
    private static final String UUID = "00000000-0000-0000-0000-000000000030";
    private static final VoxelCell ATTACK = new VoxelCell(613, 152, 600);
    private static final VoxelCell ESCAPE_LANDING = new VoxelCell(612, 149, 600);
    private static final List<VoxelCell> ESCAPE_ROUTE = List.of(
        ESCAPE_LANDING,
        new VoxelCell(611, 149, 600),
        new VoxelCell(610, 149, 600)
    );

    @Test
    void onlyMatchingAppliedMq3ReceiptAdvancesCadence() {
        IronGolemAttackController controller = controller(1_000L);
        IronGolemAttackController.Step request = controller.tick(
            COMMAND,
            ready(true, 20.0D),
            1_000L
        );
        assertEquals(IronGolemAttackController.Outcome.ATTACK, request.outcome());
        assertTrue(request.requestAttack());
        assertEquals("iron_golem:" + UUID, request.targetIdentity());
        assertFalse(request.targetIdentity().equals(UUID));

        assertFalse(controller.acknowledgeInteraction(deferred(request.requestId(), 1_010L)));
        assertTrue(controller.pendingRequestId().isBlank());
        assertEquals(1, controller.deferredReceipts());
        IronGolemAttackController.Step reissued = controller.tick(
            COMMAND,
            ready(true, 20.0D),
            1_020L
        );
        assertTrue(reissued.requestAttack());
        assertFalse(controller.acknowledgeInteraction(applied("wrong", 1_020L)));
        assertFalse(controller.acknowledgeInteraction(appliedUse(reissued.requestId(), 1_030L)));
        assertEquals(0, controller.acknowledgedAttacks());

        assertTrue(controller.acknowledgeInteraction(applied(reissued.requestId(), 1_040L)));
        assertEquals(1, controller.acknowledgedAttacks());
        assertEquals(0, controller.deferredReceipts());
        assertFalse(controller.acknowledgeInteraction(applied(reissued.requestId(), 1_050L)));
        assertEquals(1, controller.acknowledgedAttacks());

        IronGolemAttackController.Step cooldown = controller.tick(
            COMMAND,
            ready(true, 20.0D),
            1_639L
        );
        assertEquals("attack_cooldown_pending", cooldown.reason());
        assertFalse(cooldown.requestAttack());

        IronGolemAttackController.Step next = controller.tick(
            COMMAND,
            ready(true, 20.0D),
            1_640L
        );
        assertTrue(next.requestAttack());
        assertEquals(1, next.attackSequence());
    }

    @Test
    void deferredReceiptsAreBoundedAndSuppressionFailsClosed() {
        IronGolemAttackController deferred = controller(0L);
        for (int attempt = 0;
             attempt < IronGolemAttackController.MAX_DEFERRED_RECEIPTS_PER_ATTACK;
             attempt++) {
            IronGolemAttackController.Step request = deferred.tick(
                COMMAND,
                ready(true, 20.0D),
                attempt * 10L
            );
            assertTrue(request.requestAttack());
            assertFalse(deferred.acknowledgeInteraction(deferred(
                request.requestId(),
                attempt * 10L + 1L
            )));
        }
        IronGolemAttackController.Step limited = deferred.tick(
            COMMAND,
            ready(true, 20.0D),
            100L
        );
        assertEquals(IronGolemAttackController.Outcome.REJECTED, limited.outcome());
        assertEquals("attack_receipt_deferred_limit", limited.reason());

        IronGolemAttackController suppressedBeforeHit = controller(0L);
        IronGolemAttackController.Step initial = suppressedBeforeHit.tick(
            COMMAND, ready(true, 20.0D), 0L);
        assertFalse(suppressedBeforeHit.acknowledgeInteraction(suppressed(
            initial.requestId(), 1L)));
        IronGolemAttackController.Step rejected = suppressedBeforeHit.tick(
            COMMAND, ready(true, 20.0D), 2L);
        assertEquals(IronGolemAttackController.Outcome.REJECTED, rejected.outcome());
        assertEquals("attack_receipt_suppressed", rejected.reason());

        IronGolemAttackController suppressedAfterHit = engagedController();
        IronGolemAttackController.Step second = suppressedAfterHit.tick(
            COMMAND,
            ready(true, 20.0D),
            IronGolemAttackController.ATTACK_INTERVAL_MS + 10L
        );
        assertTrue(second.requestAttack());
        assertFalse(suppressedAfterHit.acknowledgeInteraction(suppressed(
            second.requestId(), IronGolemAttackController.ATTACK_INTERVAL_MS + 11L)));
        IronGolemAttackController.Step escaping = suppressedAfterHit.tick(
            COMMAND,
            ready(true, 20.0D),
            IronGolemAttackController.ATTACK_INTERVAL_MS + 12L
        );
        assertEquals(IronGolemAttackController.Outcome.ESCAPE, escaping.outcome());
        assertEquals("attack_receipt_suppressed", escaping.reason());
    }

    @Test
    void typedExactDeathRequiresAnAcknowledgedAttack() {
        IronGolemAttackController beforeAttack = controller(0L);
        IronGolemAttackController.Step rejected = beforeAttack.tick(
            COMMAND,
            death(UUID),
            10L
        );
        assertEquals(IronGolemAttackController.Outcome.REJECTED, rejected.outcome());
        assertEquals("death_before_acknowledged_attack", rejected.reason());

        IronGolemAttackController controller = engagedController();
        IronGolemAttackController.Step wrongDeath = controller.tick(
            COMMAND,
            new IronGolemAttackController.Observation(
                UUID, true, true, "different", true,
                true, true, true, true, true, 20.0D, 0
            ),
            100L
        );
        assertFalse(wrongDeath.outcome() == IronGolemAttackController.Outcome.DEATH_CONFIRMED);

        IronGolemAttackController.Step confirmed = controller.tick(
            COMMAND,
            death(UUID),
            110L
        );
        assertEquals(IronGolemAttackController.Outcome.DEATH_CONFIRMED, confirmed.outcome());
        assertEquals(IronGolemAttackController.Phase.DEATH_CONFIRMED, confirmed.phase());
        assertFalse(confirmed.requestAttack());
    }

    @Test
    void disappearanceIsNeverMistakenForDeathAndEngagedFailureLatchesEscape() {
        IronGolemAttackController unengaged = controller(0L);
        IronGolemAttackController.Step rejected = unengaged.tick(
            COMMAND,
            ready(false, 20.0D),
            10L
        );
        assertEquals(IronGolemAttackController.Outcome.REJECTED, rejected.outcome());
        assertEquals("target_disappeared_without_typed_death", rejected.reason());

        IronGolemAttackController engaged = engagedController();
        IronGolemAttackController.Step escaping = engaged.tick(
            COMMAND,
            ready(false, 20.0D),
            100L
        );
        assertEquals(IronGolemAttackController.Outcome.ESCAPE, escaping.outcome());
        assertTrue(escaping.engaged());
        assertTrue(escaping.escapeLatched());
        assertEquals(ESCAPE_ROUTE, escaping.escapeRoute());
    }

    @Test
    void healthGeometryThreatAndIdentityInvalidationFailClosed() {
        IronGolemAttackController health = engagedController();
        assertEquals("player_health_lost", health.tick(
            COMMAND, ready(true, 19.0D), 100L).reason());
        assertTrue(health.escapeLatched());

        IronGolemAttackController geometry = engagedController();
        IronGolemAttackController.Observation invalidGeometry = new IronGolemAttackController.Observation(
            UUID, true, true, "", false,
            true, false, true, true, true, 20.0D, 0
        );
        assertEquals("defense_geometry_invalidated", geometry.tick(
            COMMAND, invalidGeometry, 100L).reason());

        IronGolemAttackController threats = engagedController();
        IronGolemAttackController.Observation nearbyThreat = new IronGolemAttackController.Observation(
            UUID, true, true, "", false,
            true, true, true, true, true, 20.0D, 1
        );
        assertEquals("nearby_threats", threats.tick(
            COMMAND, nearbyThreat, 100L).reason());

        IronGolemAttackController identity = engagedController();
        IronGolemAttackController.Observation changed = new IronGolemAttackController.Observation(
            "different", true, true, "", false,
            true, true, true, true, true, 20.0D, 0
        );
        assertEquals("target_identity_changed", identity.tick(
            COMMAND, changed, 100L).reason());
        assertTrue(identity.escapeLatched());

        IronGolemAttackController beforeEngagement = controller(0L);
        assertEquals(IronGolemAttackController.Outcome.REJECTED,
            beforeEngagement.tick("other", ready(true, 20.0D), 1L).outcome());
    }

    @Test
    void reachLineOfSightAndGazeGateEveryAttackPulse() {
        IronGolemAttackController controller = controller(0L);

        IronGolemAttackController.Observation outOfReach = new IronGolemAttackController.Observation(
            UUID, true, true, "", false,
            true, true, false, true, true, 20.0D, 0
        );
        assertEquals("target_out_of_hitbox_reach", controller.tick(
            COMMAND, outOfReach, 1L).reason());

        controller = controller(0L);
        IronGolemAttackController.Observation blocked = new IronGolemAttackController.Observation(
            UUID, true, true, "", false,
            true, true, true, false, true, 20.0D, 0
        );
        assertEquals("target_line_of_sight_blocked", controller.tick(
            COMMAND, blocked, 1L).reason());

        controller = controller(0L);
        IronGolemAttackController.Observation unaligned = new IronGolemAttackController.Observation(
            UUID, true, true, "", false,
            true, true, true, true, false, 20.0D, 0
        );
        IronGolemAttackController.Step held = controller.tick(COMMAND, unaligned, 1L);
        assertEquals(IronGolemAttackController.Outcome.HOLD, held.outcome());
        assertFalse(held.requestAttack());
    }

    @Test
    void deathThenExplicitEscapeRequiresTwoSafeEndpointPolls() {
        IronGolemAttackController controller = engagedController();
        assertEquals(IronGolemAttackController.Outcome.DEATH_CONFIRMED,
            controller.tick(COMMAND, death(UUID), 100L).outcome());
        IronGolemAttackController.Step escape = controller.beginEscape(
            "drop_recovered",
            110L
        );
        assertTrue(escape.escapeLatched());
        assertEquals(ESCAPE_LANDING, escape.escapeLanding());

        assertEquals("escape_in_progress", controller.observeEscapeArrival(
            COMMAND, ESCAPE_LANDING, true, true, true, true, 120L).reason());
        VoxelCell endpoint = ESCAPE_ROUTE.getLast();
        assertEquals("escape_settling", controller.observeEscapeArrival(
            COMMAND, endpoint, true, true, true, true, 130L).reason());
        IronGolemAttackController.Step safe = controller.observeEscapeArrival(
            COMMAND, endpoint, true, true, true, true, 140L
        );
        assertEquals(IronGolemAttackController.Outcome.SAFE, safe.outcome());
        assertFalse(safe.escapeLatched());
    }

    @Test
    void engagedCommandChangeCannotReleaseTheEscapeLease() {
        IronGolemAttackController controller = engagedController();
        IronGolemAttackController.Step escaping = controller.tick(
            "other",
            ready(true, 20.0D),
            100L
        );
        assertEquals(IronGolemAttackController.Outcome.ESCAPE, escaping.outcome());
        assertTrue(escaping.escapeLatched());

        IronGolemAttackController.Step stillEscaping = controller.observeEscapeArrival(
            "other",
            ESCAPE_ROUTE.getLast(),
            true,
            true,
            true,
            true,
            110L
        );
        assertEquals(IronGolemAttackController.Outcome.ESCAPE, stillEscaping.outcome());
        assertEquals("command_changed_while_engaged", stillEscaping.reason());
    }

    @Test
    void validatesFrozenEscapeAndDoesNotExposeBareUuidInStepContract() {
        IronGolemAttackController invalid = new IronGolemAttackController();
        assertFalse(invalid.begin(
            COMMAND,
            UUID,
            ATTACK,
            ESCAPE_LANDING,
            List.of(new VoxelCell(999, 1, 999)),
            20.0D,
            0L
        ));

        assertFalse(Arrays.stream(IronGolemAttackController.Step.class.getRecordComponents())
            .anyMatch(component -> component.getName().equals("targetUuid")));

        IronGolemAttackController controller = controller(0L);
        controller.clear();
        assertEquals(IronGolemAttackController.Outcome.IDLE,
            controller.tick(COMMAND, ready(true, 20.0D), 10L).outcome());
    }

    private static IronGolemAttackController controller(long nowMs) {
        IronGolemAttackController controller = new IronGolemAttackController();
        assertTrue(controller.begin(
            COMMAND,
            UUID,
            ATTACK,
            ESCAPE_LANDING,
            ESCAPE_ROUTE,
            20.0D,
            nowMs
        ));
        return controller;
    }

    private static IronGolemAttackController engagedController() {
        IronGolemAttackController controller = controller(0L);
        IronGolemAttackController.Step request = controller.tick(COMMAND, ready(true, 20.0D), 0L);
        assertTrue(request.requestAttack());
        assertTrue(controller.acknowledgeInteraction(applied(request.requestId(), 10L)));
        return controller;
    }

    private static IronGolemAttackController.Observation ready(boolean alive, double health) {
        return new IronGolemAttackController.Observation(
            UUID,
            true,
            alive,
            "",
            false,
            true,
            true,
            true,
            true,
            true,
            health,
            0
        );
    }

    private static IronGolemAttackController.Observation death(String uuid) {
        return new IronGolemAttackController.Observation(
            UUID,
            true,
            false,
            uuid,
            true,
            true,
            true,
            true,
            true,
            true,
            20.0D,
            0
        );
    }

    private static InteractionAppliedReceipt applied(String requestId, long timestampMs) {
        return new InteractionAppliedReceipt(
            requestId,
            InteractionDemand.Action.ATTACK_ENTITY,
            InteractionAppliedReceipt.Disposition.APPLIED,
            true,
            ActionResult.SUCCESS,
            timestampMs,
            "applied",
            FabricMotionMode.SMOOTH,
            null,
            null,
            false,
            false,
            false
        );
    }

    private static InteractionAppliedReceipt deferred(String requestId, long timestampMs) {
        return new InteractionAppliedReceipt(
            requestId,
            InteractionDemand.Action.ATTACK_ENTITY,
            InteractionAppliedReceipt.Disposition.DEFERRED,
            false,
            ActionResult.PASS,
            timestampMs,
            "deferred",
            FabricMotionMode.SMOOTH,
            null,
            null,
            false,
            false,
            false
        );
    }

    private static InteractionAppliedReceipt appliedUse(String requestId, long timestampMs) {
        return new InteractionAppliedReceipt(
            requestId,
            InteractionDemand.Action.USE_BLOCK,
            InteractionAppliedReceipt.Disposition.APPLIED,
            true,
            ActionResult.SUCCESS,
            timestampMs,
            "applied",
            FabricMotionMode.SMOOTH,
            null,
            null,
            false,
            false,
            false
        );
    }

    private static InteractionAppliedReceipt suppressed(String requestId, long timestampMs) {
        return new InteractionAppliedReceipt(
            requestId,
            InteractionDemand.Action.ATTACK_ENTITY,
            InteractionAppliedReceipt.Disposition.SUPPRESSED,
            false,
            ActionResult.FAIL,
            timestampMs,
            "suppressed",
            FabricMotionMode.SMOOTH,
            null,
            null,
            false,
            false,
            false
        );
    }
}
