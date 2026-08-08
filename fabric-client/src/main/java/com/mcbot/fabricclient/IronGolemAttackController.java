package com.mcbot.fabricclient;

import java.util.List;

/**
 * Pure exact-identity attack cadence and engagement/escape latch for the golem shortcut.
 *
 * <p>Only a matching {@link InteractionAppliedReceipt} advances attack cadence. A vanished entity
 * is not a kill: typed death of the frozen UUID is required after at least one acknowledged hit.</p>
 */
final class IronGolemAttackController {
    static final long ATTACK_INTERVAL_MS = 600L;
    static final long ATTACK_DEADLINE_MS = 120_000L;
    static final int ESCAPE_SETTLE_POLLS = 2;
    static final int MAX_DEFERRED_RECEIPTS_PER_ATTACK = 4;

    enum Phase {
        IDLE,
        ATTACKING,
        DEATH_CONFIRMED,
        ESCAPING,
        SAFE,
        REJECTED
    }

    enum Outcome {
        IDLE,
        HOLD,
        ATTACK,
        DEATH_CONFIRMED,
        ESCAPE,
        SAFE,
        REJECTED
    }

    record Observation(
        String observedTargetUuid,
        boolean targetIsIronGolem,
        boolean targetAlive,
        String typedDeathUuid,
        boolean typedDeathIsIronGolem,
        boolean atFrozenAttackStance,
        boolean defenseGeometryValid,
        boolean withinHitboxReach,
        boolean lineOfSight,
        boolean gazeAligned,
        double playerHealth,
        int nearbyHostileCount
    ) {
        Observation {
            observedTargetUuid = normalize(observedTargetUuid);
            typedDeathUuid = normalize(typedDeathUuid);
            if (!Double.isFinite(playerHealth) || playerHealth < 0.0D
                || nearbyHostileCount < 0) {
                throw new IllegalArgumentException("invalid attack observation");
            }
        }

        boolean exactTypedDeath(String uuid) {
            return typedDeathIsIronGolem && uuid.equals(typedDeathUuid);
        }
    }

    record Step(
        Outcome outcome,
        Phase phase,
        boolean requestAttack,
        String requestId,
        String targetIdentity,
        boolean engaged,
        boolean escapeLatched,
        VoxelCell escapeLanding,
        List<VoxelCell> escapeRoute,
        int acknowledgedAttacks,
        int attackSequence,
        long lastAppliedAttackMs,
        long elapsedMs,
        String reason
    ) {
        Step {
            requestId = normalize(requestId);
            targetIdentity = normalize(targetIdentity);
            escapeRoute = escapeRoute == null ? List.of() : List.copyOf(escapeRoute);
            reason = normalize(reason);
        }
    }

    private String commandId = "";
    private String targetUuid = "";
    private String targetIdentity = "";
    private VoxelCell attackStance;
    private VoxelCell escapeLanding;
    private List<VoxelCell> escapeRoute = List.of();
    private double baselineHealth;
    private long startedAtMs;
    private long lastAppliedAttackMs;
    private int attackSequence;
    private int acknowledgedAttacks;
    private int deferredReceipts;
    private String pendingRequestId = "";
    private Phase phase = Phase.IDLE;
    private String terminalReason = "";
    private int escapeSettlePolls;

    boolean begin(
        String nextCommandId,
        String nextTargetUuid,
        VoxelCell nextAttackStance,
        VoxelCell nextEscapeLanding,
        List<VoxelCell> nextEscapeRoute,
        double nextBaselineHealth,
        long nowMs
    ) {
        clear();
        String command = normalize(nextCommandId);
        String uuid = normalize(nextTargetUuid);
        if (command.isBlank() || uuid.isBlank() || nextAttackStance == null
            || nextEscapeLanding == null || nextEscapeRoute == null
            || nextEscapeRoute.isEmpty() || !Double.isFinite(nextBaselineHealth)
            || nextBaselineHealth <= 0.0D
            || !nextEscapeLanding.equals(nextEscapeRoute.getFirst())) {
            return false;
        }
        commandId = command;
        targetUuid = uuid;
        targetIdentity = "iron_golem:" + uuid;
        attackStance = nextAttackStance;
        escapeLanding = nextEscapeLanding;
        escapeRoute = List.copyOf(nextEscapeRoute);
        baselineHealth = nextBaselineHealth;
        startedAtMs = nowMs;
        lastAppliedAttackMs = nowMs - ATTACK_INTERVAL_MS;
        phase = Phase.ATTACKING;
        return true;
    }

    Step tick(String expectedCommandId, Observation observation, long nowMs) {
        if (phase == Phase.IDLE) {
            return idle();
        }
        if (!commandId.equals(normalize(expectedCommandId))) {
            return invalidate("command_changed", nowMs);
        }
        if (phase == Phase.SAFE) {
            return step(Outcome.SAFE, false, "safe_escape_complete", nowMs);
        }
        if (phase == Phase.REJECTED) {
            return step(Outcome.REJECTED, false, terminalReason, nowMs);
        }
        if (phase == Phase.ESCAPING) {
            return step(Outcome.ESCAPE, false, terminalReason, nowMs);
        }
        if (phase == Phase.DEATH_CONFIRMED) {
            return step(Outcome.DEATH_CONFIRMED, false, "typed_death_confirmed", nowMs);
        }
        if (observation == null) {
            return invalidate("missing_observation", nowMs);
        }

        boolean exactTarget = targetUuid.equals(observation.observedTargetUuid())
            && observation.targetIsIronGolem();
        if (observation.exactTypedDeath(targetUuid)) {
            if (acknowledgedAttacks <= 0) {
                return reject("death_before_acknowledged_attack", nowMs);
            }
            phase = Phase.DEATH_CONFIRMED;
            pendingRequestId = "";
            return step(Outcome.DEATH_CONFIRMED, false, "typed_death_confirmed", nowMs);
        }
        if (elapsed(nowMs, startedAtMs) >= ATTACK_DEADLINE_MS) {
            return invalidate("attack_timeout", nowMs);
        }
        if (!exactTarget) {
            return invalidate("target_identity_changed", nowMs);
        }
        if (!observation.targetAlive()) {
            return invalidate("target_disappeared_without_typed_death", nowMs);
        }
        if (observation.playerHealth() + 0.01D < baselineHealth) {
            return invalidate("player_health_lost", nowMs);
        }
        if (observation.nearbyHostileCount() > 0) {
            return invalidate("nearby_threats", nowMs);
        }
        if (!observation.atFrozenAttackStance() || !observation.defenseGeometryValid()) {
            return invalidate("defense_geometry_invalidated", nowMs);
        }
        if (!observation.withinHitboxReach()) {
            return invalidate("target_out_of_hitbox_reach", nowMs);
        }
        if (!observation.lineOfSight()) {
            return invalidate("target_line_of_sight_blocked", nowMs);
        }
        if (!observation.gazeAligned()) {
            return step(Outcome.HOLD, false, "attack_aligning", nowMs);
        }
        if (!pendingRequestId.isBlank()) {
            return step(Outcome.HOLD, false, "attack_receipt_pending", nowMs);
        }
        if (elapsed(nowMs, lastAppliedAttackMs) < ATTACK_INTERVAL_MS) {
            return step(Outcome.HOLD, false, "attack_cooldown_pending", nowMs);
        }

        pendingRequestId = commandId + ":iron_golem_attack:" + attackSequence + ":" + targetUuid;
        return step(Outcome.ATTACK, true, "attack_requested", nowMs);
    }

    /**
     * Counts only a physically applied MQ-3 receipt matching the frozen pending request.
     * Matching deferrals release the request for a bounded reissue; suppression fails closed.
     */
    boolean acknowledgeInteraction(InteractionAppliedReceipt receipt) {
        if (phase != Phase.ATTACKING || pendingRequestId.isBlank() || receipt == null
            || receipt.action() != InteractionDemand.Action.ATTACK_ENTITY
            || !pendingRequestId.equals(receipt.requestId())) {
            return false;
        }
        if (receipt.disposition() == InteractionAppliedReceipt.Disposition.DEFERRED) {
            pendingRequestId = "";
            deferredReceipts += 1;
            if (deferredReceipts >= MAX_DEFERRED_RECEIPTS_PER_ATTACK) {
                invalidate("attack_receipt_deferred_limit", receipt.timestampMs());
            }
            return false;
        }
        if (receipt.disposition() == InteractionAppliedReceipt.Disposition.SUPPRESSED) {
            pendingRequestId = "";
            invalidate("attack_receipt_suppressed", receipt.timestampMs());
            return false;
        }
        if (!receipt.applied()) {
            return false;
        }
        lastAppliedAttackMs = receipt.timestampMs();
        acknowledgedAttacks += 1;
        attackSequence += 1;
        deferredReceipts = 0;
        pendingRequestId = "";
        return true;
    }

    /** Explicitly latches the frozen escape after drop collection or any engaged abort. */
    Step beginEscape(String reason, long nowMs) {
        if (phase == Phase.IDLE || phase == Phase.SAFE || phase == Phase.REJECTED) {
            return phase == Phase.REJECTED
                ? step(Outcome.REJECTED, false, terminalReason, nowMs) : idle();
        }
        if (acknowledgedAttacks <= 0 && phase != Phase.DEATH_CONFIRMED) {
            return reject(normalizedReason(reason, "escape_before_engagement"), nowMs);
        }
        phase = Phase.ESCAPING;
        pendingRequestId = "";
        terminalReason = normalizedReason(reason, "safe_escape_required");
        escapeSettlePolls = 0;
        return step(Outcome.ESCAPE, false, terminalReason, nowMs);
    }

    /** Two exact safe polls at the frozen route endpoint are required to release the lease. */
    Step observeEscapeArrival(
        String expectedCommandId,
        VoxelCell feet,
        boolean grounded,
        boolean dry,
        boolean bodyClear,
        boolean supportStable,
        long nowMs
    ) {
        if (phase != Phase.ESCAPING) {
            return phase == Phase.SAFE
                ? step(Outcome.SAFE, false, "safe_escape_complete", nowMs)
                : step(Outcome.REJECTED, false, "escape_not_latched", nowMs);
        }
        if (!commandId.equals(normalize(expectedCommandId))) {
            terminalReason = "command_changed_while_engaged";
            escapeSettlePolls = 0;
            return step(Outcome.ESCAPE, false, terminalReason, nowMs);
        }
        VoxelCell endpoint = escapeRoute.getLast();
        if (!endpoint.equals(feet) || !grounded || !dry || !bodyClear || !supportStable) {
            escapeSettlePolls = 0;
            return step(Outcome.ESCAPE, false, "escape_in_progress", nowMs);
        }
        escapeSettlePolls += 1;
        if (escapeSettlePolls < ESCAPE_SETTLE_POLLS) {
            return step(Outcome.ESCAPE, false, "escape_settling", nowMs);
        }
        phase = Phase.SAFE;
        terminalReason = "safe_escape_complete";
        return step(Outcome.SAFE, false, terminalReason, nowMs);
    }

    boolean engaged() {
        return acknowledgedAttacks > 0;
    }

    boolean escapeLatched() {
        return phase == Phase.ESCAPING;
    }

    String pendingRequestId() {
        return pendingRequestId;
    }

    String targetIdentity() {
        return targetIdentity;
    }

    int acknowledgedAttacks() {
        return acknowledgedAttacks;
    }

    int deferredReceipts() {
        return deferredReceipts;
    }

    void clear() {
        commandId = "";
        targetUuid = "";
        targetIdentity = "";
        attackStance = null;
        escapeLanding = null;
        escapeRoute = List.of();
        baselineHealth = 0.0D;
        startedAtMs = 0L;
        lastAppliedAttackMs = 0L;
        attackSequence = 0;
        acknowledgedAttacks = 0;
        deferredReceipts = 0;
        pendingRequestId = "";
        phase = Phase.IDLE;
        terminalReason = "";
        escapeSettlePolls = 0;
    }

    private Step invalidate(String reason, long nowMs) {
        if (acknowledgedAttacks > 0) {
            phase = Phase.ESCAPING;
            pendingRequestId = "";
            terminalReason = reason;
            escapeSettlePolls = 0;
            return step(Outcome.ESCAPE, false, reason, nowMs);
        }
        return reject(reason, nowMs);
    }

    private Step reject(String reason, long nowMs) {
        phase = Phase.REJECTED;
        pendingRequestId = "";
        terminalReason = reason;
        return step(Outcome.REJECTED, false, reason, nowMs);
    }

    private Step step(Outcome outcome, boolean requestAttack, String reason, long nowMs) {
        return new Step(
            outcome,
            phase,
            requestAttack,
            requestAttack ? pendingRequestId : "",
            targetIdentity,
            acknowledgedAttacks > 0,
            phase == Phase.ESCAPING,
            escapeLanding,
            escapeRoute,
            acknowledgedAttacks,
            attackSequence,
            lastAppliedAttackMs,
            elapsed(nowMs, startedAtMs),
            reason
        );
    }

    private static Step idle() {
        return new Step(
            Outcome.IDLE,
            Phase.IDLE,
            false,
            "",
            "",
            false,
            false,
            null,
            List.of(),
            0,
            0,
            0L,
            0L,
            "idle"
        );
    }

    private static long elapsed(long nowMs, long thenMs) {
        return Math.max(0L, nowMs - thenMs);
    }

    private static String normalizedReason(String reason, String fallback) {
        String normalized = normalize(reason);
        return normalized.isBlank() ? fallback : normalized;
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim();
    }
}
