package com.mcbot.fabricclient;

import java.util.List;

/** Pure controller for exactly three verified jump/place cycles of a frozen golem pillar. */
final class IronGolemPillarController {
    static final long JUMP_PULSE_MS = 150L;
    static final long CYCLE_DEADLINE_MS = 4_000L;
    static final long HARD_DEADLINE_MS = 15_000L;
    static final int SETTLE_POLLS = 2;

    enum Phase {
        IDLE,
        ALIGNING,
        JUMPING,
        AIRBORNE,
        SETTLING,
        COMPLETE,
        REJECTED
    }

    enum Outcome {
        IDLE,
        ACTIVE,
        COMPLETE,
        REJECTED
    }

    enum PlacementFeedback {
        NONE,
        DEFERRED,
        APPLIED,
        REJECTED
    }

    record Observation(
        VoxelCell feet,
        double preciseY,
        boolean onGround,
        boolean dry,
        boolean bodyClear,
        boolean supportStable,
        boolean aligned,
        String observedTargetUuid,
        boolean targetAlive,
        boolean placementCellOpen,
        boolean activePlacementVerified,
        PlacementFeedback placementFeedback
    ) {
        Observation {
            observedTargetUuid = normalize(observedTargetUuid);
            placementFeedback = placementFeedback == null
                ? PlacementFeedback.NONE : placementFeedback;
            if (!Double.isFinite(preciseY)) {
                throw new IllegalArgumentException("preciseY must be finite");
            }
        }

        static Observation ready(
            VoxelCell feet,
            String targetUuid,
            boolean aligned
        ) {
            return new Observation(
                feet,
                feet == null ? 0.0D : feet.y(),
                true,
                true,
                true,
                true,
                aligned,
                targetUuid,
                true,
                true,
                false,
                PlacementFeedback.NONE
            );
        }
    }

    record Step(
        Outcome outcome,
        Phase phase,
        boolean jump,
        boolean sneak,
        boolean requestPlacement,
        VoxelCell placementCell,
        VoxelCell expectedFeet,
        int cycle,
        int completedPlacements,
        int appliedPlacementReceipts,
        int settlementPolls,
        long elapsedMs,
        String reason
    ) {
        Step {
            reason = normalize(reason);
        }

        boolean active() {
            return outcome == Outcome.ACTIVE;
        }
    }

    private String commandId = "";
    private String targetUuid = "";
    private VoxelCell base;
    private VoxelCell attackStance;
    private List<VoxelCell> placementCells = List.of();
    private Phase phase = Phase.IDLE;
    private long startedAtMs;
    private long cycleStartedAtMs;
    private long jumpStartedAtMs;
    private int completedPlacements;
    private int appliedPlacementReceipts;
    private int settlementPolls;
    private boolean placementApplied;

    boolean begin(
        String nextCommandId,
        String nextTargetUuid,
        VoxelCell nextBase,
        List<VoxelCell> nextPlacementCells,
        VoxelCell nextAttackStance,
        VoxelCell currentFeet,
        long nowMs
    ) {
        clear();
        String command = normalize(nextCommandId);
        String target = normalize(nextTargetUuid);
        if (command.isBlank() || target.isBlank() || nextBase == null
            || nextAttackStance == null || !nextBase.equals(currentFeet)
            || !validPillarCells(nextBase, nextPlacementCells, nextAttackStance)) {
            return false;
        }
        commandId = command;
        targetUuid = target;
        base = nextBase;
        attackStance = nextAttackStance;
        placementCells = List.copyOf(nextPlacementCells);
        phase = Phase.ALIGNING;
        startedAtMs = nowMs;
        cycleStartedAtMs = nowMs;
        return true;
    }

    Step tick(String expectedCommandId, Observation observation, long nowMs) {
        if (phase == Phase.IDLE || commandId.isBlank()) {
            return idle("idle");
        }
        if (phase == Phase.COMPLETE) {
            return step(Outcome.COMPLETE, false, false, false, "pillar_complete", nowMs);
        }
        if (phase == Phase.REJECTED) {
            return step(Outcome.REJECTED, false, false, false, "pillar_rejected", nowMs);
        }
        if (!commandId.equals(normalize(expectedCommandId))) {
            return reject("command_changed", nowMs);
        }
        if (observation == null || !targetUuid.equals(observation.observedTargetUuid())
            || !observation.targetAlive()) {
            return reject("target_identity_changed", nowMs);
        }
        if (elapsed(nowMs, startedAtMs) >= HARD_DEADLINE_MS) {
            return reject("pillar_timeout", nowMs);
        }
        if (elapsed(nowMs, cycleStartedAtMs) >= CYCLE_DEADLINE_MS) {
            return reject("pillar_cycle_timeout", nowMs);
        }
        if (observation.placementFeedback() == PlacementFeedback.REJECTED) {
            return reject("placement_rejected", nowMs);
        }
        if (observation.placementFeedback() == PlacementFeedback.APPLIED && !placementApplied) {
            placementApplied = true;
            appliedPlacementReceipts += 1;
        }

        VoxelCell expected = expectedFeet();
        VoxelCell landing = nextFeet();
        return switch (phase) {
            case ALIGNING -> tickAligning(observation, expected, nowMs);
            case JUMPING -> tickJumping(observation, expected, nowMs);
            case AIRBORNE -> tickAirborne(observation, expected, landing, nowMs);
            case SETTLING -> tickSettling(observation, landing, nowMs);
            case IDLE, COMPLETE, REJECTED -> throw new IllegalStateException("terminal phase handled above");
        };
    }

    boolean active() {
        return phase != Phase.IDLE && phase != Phase.COMPLETE && phase != Phase.REJECTED;
    }

    Phase phase() {
        return phase;
    }

    int completedPlacements() {
        return completedPlacements;
    }

    String targetUuid() {
        return targetUuid;
    }

    VoxelCell attackStance() {
        return attackStance;
    }

    void clear() {
        commandId = "";
        targetUuid = "";
        base = null;
        attackStance = null;
        placementCells = List.of();
        phase = Phase.IDLE;
        startedAtMs = 0L;
        cycleStartedAtMs = 0L;
        jumpStartedAtMs = 0L;
        completedPlacements = 0;
        appliedPlacementReceipts = 0;
        settlementPolls = 0;
        placementApplied = false;
    }

    private Step tickAligning(Observation observation, VoxelCell expected, long nowMs) {
        if (!safeAt(observation, expected) || !observation.placementCellOpen()) {
            return reject("pillar_origin_invalid", nowMs);
        }
        if (!observation.aligned()) {
            return step(Outcome.ACTIVE, false, false, false, "pillar_aligning", nowMs);
        }
        phase = Phase.JUMPING;
        jumpStartedAtMs = nowMs;
        return step(Outcome.ACTIVE, true, false, false, "pillar_jump_started", nowMs);
    }

    private Step tickJumping(Observation observation, VoxelCell expected, long nowMs) {
        boolean departed = !observation.onGround()
            || !expected.equals(observation.feet())
            || observation.preciseY() >= expected.y() + 0.35D;
        if (departed) {
            phase = Phase.AIRBORNE;
            return step(
                Outcome.ACTIVE,
                false,
                false,
                !placementApplied,
                placementApplied ? "pillar_airborne" : "pillar_place_requested",
                nowMs
            );
        }
        if (!safeAt(observation, expected) || !observation.placementCellOpen()) {
            return reject("pillar_launch_invalid", nowMs);
        }
        if (elapsed(nowMs, jumpStartedAtMs) >= JUMP_PULSE_MS) {
            return reject("pillar_takeoff_timeout", nowMs);
        }
        return step(Outcome.ACTIVE, true, false, false, "pillar_jump_pulse", nowMs);
    }

    private Step tickAirborne(
        Observation observation,
        VoxelCell expected,
        VoxelCell landing,
        long nowMs
    ) {
        if (observation.onGround()) {
            if (!landing.equals(observation.feet())) {
                return reject("pillar_landing_missed", nowMs);
            }
            if (!safeAt(observation, landing) || !placementApplied
                || !observation.activePlacementVerified()) {
                return reject("pillar_landing_unverified", nowMs);
            }
            phase = Phase.SETTLING;
            settlementPolls = 1;
            return step(Outcome.ACTIVE, false, false, false, "pillar_landing_settling", nowMs);
        }
        if (observation.feet() != null
            && (Math.abs(observation.feet().x() - expected.x()) > 0
                || Math.abs(observation.feet().z() - expected.z()) > 0)) {
            return reject("pillar_column_missed", nowMs);
        }
        return step(
            Outcome.ACTIVE,
            false,
            false,
            !placementApplied,
            placementApplied ? "pillar_airborne" : "pillar_place_requested",
            nowMs
        );
    }

    private Step tickSettling(Observation observation, VoxelCell landing, long nowMs) {
        if (!safeAt(observation, landing) || !placementApplied
            || !observation.activePlacementVerified()) {
            settlementPolls = 0;
            return reject("pillar_settlement_invalid", nowMs);
        }
        settlementPolls += 1;
        if (settlementPolls < SETTLE_POLLS) {
            return step(Outcome.ACTIVE, false, false, false, "pillar_landing_settling", nowMs);
        }

        completedPlacements += 1;
        if (completedPlacements == IronGolemDefensePackagePlanner.REQUIRED_PILLAR_BLOCKS) {
            phase = Phase.COMPLETE;
            return step(Outcome.COMPLETE, false, false, false, "pillar_complete", nowMs);
        }
        if (completedPlacements > IronGolemDefensePackagePlanner.REQUIRED_PILLAR_BLOCKS) {
            return reject("pillar_placement_limit", nowMs);
        }
        phase = Phase.ALIGNING;
        cycleStartedAtMs = nowMs;
        jumpStartedAtMs = 0L;
        settlementPolls = 0;
        placementApplied = false;
        return step(Outcome.ACTIVE, false, false, false, "pillar_cycle_completed", nowMs);
    }

    private Step reject(String reason, long nowMs) {
        phase = Phase.REJECTED;
        return step(Outcome.REJECTED, false, false, false, reason, nowMs);
    }

    private Step idle(String reason) {
        return new Step(
            Outcome.IDLE,
            Phase.IDLE,
            false,
            false,
            false,
            null,
            null,
            0,
            0,
            0,
            0,
            0L,
            reason
        );
    }

    private Step step(
        Outcome outcome,
        boolean jump,
        boolean sneak,
        boolean requestPlacement,
        String reason,
        long nowMs
    ) {
        return new Step(
            outcome,
            phase,
            jump,
            sneak,
            requestPlacement,
            completedPlacements < placementCells.size()
                ? placementCells.get(completedPlacements) : null,
            expectedFeet(),
            Math.min(completedPlacements + 1, IronGolemDefensePackagePlanner.REQUIRED_PILLAR_BLOCKS),
            completedPlacements,
            appliedPlacementReceipts,
            settlementPolls,
            elapsed(nowMs, startedAtMs),
            reason
        );
    }

    private VoxelCell expectedFeet() {
        return base == null ? null
            : new VoxelCell(base.x(), base.y() + completedPlacements, base.z());
    }

    private VoxelCell nextFeet() {
        VoxelCell expected = expectedFeet();
        return expected == null ? null
            : new VoxelCell(expected.x(), expected.y() + 1, expected.z());
    }

    private static boolean safeAt(Observation observation, VoxelCell expected) {
        return observation != null && expected != null && expected.equals(observation.feet())
            && observation.onGround() && observation.dry() && observation.bodyClear()
            && observation.supportStable();
    }

    private static boolean validPillarCells(
        VoxelCell base,
        List<VoxelCell> cells,
        VoxelCell attackStance
    ) {
        if (cells == null || cells.size() != IronGolemDefensePackagePlanner.REQUIRED_PILLAR_BLOCKS) {
            return false;
        }
        for (int index = 0; index < cells.size(); index++) {
            if (!new VoxelCell(base.x(), base.y() + index, base.z()).equals(cells.get(index))) {
                return false;
            }
        }
        return new VoxelCell(base.x(), base.y() + cells.size(), base.z()).equals(attackStance);
    }

    private static long elapsed(long nowMs, long thenMs) {
        return Math.max(0L, nowMs - thenMs);
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim();
    }
}
