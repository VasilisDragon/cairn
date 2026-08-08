package com.mcbot.fabricclient;

import java.util.HashSet;
import java.util.Set;

final class DescentWaterContainmentController {
    static final int MAX_UNIQUE_EPISODES = 4;
    static final long EPISODE_TIMEOUT_MS = 8_000L;
    static final long SEAL_TIMEOUT_MS = 4_000L;
    static final long POST_BREAK_PROBE_MIN_MS = 300L;
    static final int REQUIRED_STABLE_DRY_POLLS = 2;
    static final double MAX_ANCHOR_HORIZONTAL_DISTANCE_SQ = 4.0D;
    static final int MAX_ANCHOR_VERTICAL_DISTANCE = 3;

    enum Phase {
        IDLE,
        SEALING,
        RETREAT_ALIGN,
        RETREATING,
        DRY_SETTLE,
        RECOVERED,
        REJECTED
    }

    enum Trigger {
        SUPPORT_WATER,
        POST_BREAK_BREACH,
        PLAYER_WET
    }

    enum PendingBreakObservation {
        INTACT,
        OPEN_DRY,
        OPEN_WATER
    }

    enum Action {
        NONE,
        ATTEMPT_SEAL,
        ALIGN_TO_ANCHOR,
        MOVE_TO_ANCHOR,
        HOLD_DRY,
        RECOVERED,
        REJECTED
    }

    enum SealStatus {
        NOT_STARTED,
        RUNNING,
        SUCCEEDED,
        FAILED
    }

    record Cell(int x, int y, int z) {
        double horizontalDistanceSquared(Cell other) {
            if (other == null) {
                return Double.POSITIVE_INFINITY;
            }
            long dx = (long) x - other.x;
            long dz = (long) z - other.z;
            return (double) (dx * dx + dz * dz);
        }
    }

    record EpisodeKey(Trigger trigger, int stepIndex, Cell waterCell, Cell openedCell) {
        EpisodeKey {
            if (trigger == null) {
                throw new IllegalArgumentException("trigger is required");
            }
            if (waterCell == null) {
                throw new IllegalArgumentException("waterCell is required");
            }
        }
    }

    record SealKey(int stepIndex, Cell waterCell) {
    }

    record Episode(
        EpisodeKey key,
        Cell detectedFeet,
        Cell dryAnchor,
        long startedAtMs,
        boolean sealEligible
    ) {
        Episode {
            if (key == null || detectedFeet == null || dryAnchor == null) {
                throw new IllegalArgumentException("episode cells are required");
            }
        }
    }

    record StartRequest(
        Trigger trigger,
        int stepIndex,
        Cell waterCell,
        Cell openedCell,
        Cell detectedFeet,
        Cell dryAnchor,
        boolean playerWet,
        boolean detectedDryStable,
        boolean sealEligible,
        long nowMs
    ) {
    }

    record Observation(
        long nowMs,
        Cell playerFeet,
        boolean touchingWater,
        boolean grounded,
        boolean bodyClear,
        boolean supportStable,
        boolean anchorValid,
        boolean alignedToAnchor,
        boolean waterPresent,
        SealStatus sealStatus
    ) {
        Observation {
            sealStatus = sealStatus == null ? SealStatus.NOT_STARTED : sealStatus;
        }
    }

    record Decision(
        Phase phase,
        Action action,
        Episode episode,
        String reason,
        boolean transitioned,
        int stableDryPolls,
        long remainingMs
    ) {
    }

    private final Set<EpisodeKey> attemptedEpisodes = new HashSet<>();
    private final Set<SealKey> attemptedSeals = new HashSet<>();
    private Phase phase = Phase.IDLE;
    private Episode episode;
    private long sealStartedAtMs;
    private int stableDryPolls;
    private String terminalReason = "";

    Decision start(StartRequest request) {
        if (phase != Phase.IDLE) {
            return decision(Action.NONE, "episode_active", false, request == null ? 0L : request.nowMs());
        }
        if (request == null
            || request.trigger() == null
            || request.waterCell() == null
            || request.detectedFeet() == null
            || request.dryAnchor() == null) {
            return reject(null, "invalid_episode", request == null ? 0L : request.nowMs());
        }

        EpisodeKey key = new EpisodeKey(
            request.trigger(),
            request.stepIndex(),
            request.waterCell(),
            request.openedCell()
        );
        Episode candidate = new Episode(
            key,
            request.detectedFeet(),
            request.dryAnchor(),
            request.nowMs(),
            request.sealEligible()
        );
        if (attemptedEpisodes.contains(key)) {
            return reject(candidate, "episode_duplicate", request.nowMs());
        }
        if (attemptedEpisodes.size() >= MAX_UNIQUE_EPISODES) {
            return reject(candidate, "episode_limit", request.nowMs());
        }
        attemptedEpisodes.add(key);
        episode = candidate;
        stableDryPolls = 0;
        terminalReason = "";

        if (!anchorWithinBounds(request.detectedFeet(), request.dryAnchor())) {
            return reject(candidate, "anchor_out_of_bounds", request.nowMs());
        }
        boolean maySeal = request.sealEligible()
            && !request.playerWet()
            && request.trigger() != Trigger.PLAYER_WET
            && attemptedSeals.add(new SealKey(request.stepIndex(), request.waterCell()));
        if (maySeal) {
            phase = Phase.SEALING;
            sealStartedAtMs = request.nowMs();
            return decision(Action.ATTEMPT_SEAL, "seal_started", true, request.nowMs());
        }
        if (!request.playerWet()
            && request.detectedDryStable()
            && request.detectedFeet().equals(request.dryAnchor())) {
            phase = Phase.RECOVERED;
            terminalReason = "dry_anchor_reroute";
            sealStartedAtMs = 0L;
            return decision(Action.RECOVERED, terminalReason, true, request.nowMs());
        }
        phase = Phase.RETREAT_ALIGN;
        sealStartedAtMs = 0L;
        return decision(Action.ALIGN_TO_ANCHOR, "retreat_required", true, request.nowMs());
    }

    Decision tick(Observation observation) {
        long nowMs = observation == null ? 0L : observation.nowMs();
        if (phase == Phase.IDLE) {
            return decision(Action.NONE, "idle", false, nowMs);
        }
        if (phase == Phase.RECOVERED) {
            return decision(Action.RECOVERED, terminalReason, false, nowMs);
        }
        if (phase == Phase.REJECTED) {
            return decision(Action.REJECTED, terminalReason, false, nowMs);
        }
        if (observation == null || observation.playerFeet() == null) {
            return reject(episode, "missing_observation", nowMs);
        }
        if (elapsedMs(nowMs) >= EPISODE_TIMEOUT_MS) {
            return reject(episode, "episode_timeout", nowMs);
        }
        if (!observation.anchorValid()) {
            return reject(episode, "anchor_invalid", nowMs);
        }
        if (!anchorWithinBounds(observation.playerFeet(), episode.dryAnchor())) {
            return reject(episode, "anchor_out_of_bounds", nowMs);
        }

        return switch (phase) {
            case SEALING -> tickSealing(observation);
            case RETREAT_ALIGN -> tickRetreatAlign(observation);
            case RETREATING -> tickRetreating(observation);
            case DRY_SETTLE -> tickDrySettle(observation);
            default -> decision(Action.NONE, "idle", false, nowMs);
        };
    }

    private Decision tickSealing(Observation observation) {
        boolean sealed = observation.sealStatus() == SealStatus.SUCCEEDED;
        boolean sealingFailed = observation.sealStatus() == SealStatus.FAILED
            || observation.nowMs() - sealStartedAtMs >= SEAL_TIMEOUT_MS;
        if (sealed) {
            return beginDrySettleOrRetreat(observation, "seal_verified");
        }
        if (observation.touchingWater() || sealingFailed) {
            phase = Phase.RETREAT_ALIGN;
            stableDryPolls = 0;
            String reason = observation.touchingWater() ? "wet_during_seal" : "seal_unavailable";
            return decision(Action.ALIGN_TO_ANCHOR, reason, true, observation.nowMs());
        }
        return decision(Action.ATTEMPT_SEAL, "sealing", false, observation.nowMs());
    }

    private Decision tickRetreatAlign(Observation observation) {
        if (dryAtAnchor(observation)) {
            return beginDrySettle(observation, "anchor_reached");
        }
        if (observation.alignedToAnchor()) {
            phase = Phase.RETREATING;
            return decision(Action.MOVE_TO_ANCHOR, "retreating", true, observation.nowMs());
        }
        return decision(Action.ALIGN_TO_ANCHOR, "aligning", false, observation.nowMs());
    }

    private Decision tickRetreating(Observation observation) {
        if (dryAtAnchor(observation)) {
            return beginDrySettle(observation, "anchor_reached");
        }
        Action action = observation.alignedToAnchor() ? Action.MOVE_TO_ANCHOR : Action.ALIGN_TO_ANCHOR;
        String reason = observation.alignedToAnchor() ? "retreating" : "retreat_realign";
        return decision(action, reason, false, observation.nowMs());
    }

    private Decision tickDrySettle(Observation observation) {
        if (!dryAtAnchor(observation)) {
            return reject(episode, "dry_settle_lost", observation.nowMs());
        }
        stableDryPolls++;
        if (stableDryPolls >= REQUIRED_STABLE_DRY_POLLS) {
            phase = Phase.RECOVERED;
            terminalReason = "dry_recovered";
            return decision(Action.RECOVERED, terminalReason, true, observation.nowMs());
        }
        return decision(Action.HOLD_DRY, "dry_settling", false, observation.nowMs());
    }

    private Decision beginDrySettleOrRetreat(Observation observation, String reason) {
        if (dryAtAnchor(observation)) {
            return beginDrySettle(observation, reason);
        }
        phase = Phase.RETREAT_ALIGN;
        stableDryPolls = 0;
        return decision(Action.ALIGN_TO_ANCHOR, reason + ":retreat", true, observation.nowMs());
    }

    private Decision beginDrySettle(Observation observation, String reason) {
        phase = Phase.DRY_SETTLE;
        stableDryPolls = 1;
        return decision(Action.HOLD_DRY, reason, true, observation.nowMs());
    }

    private boolean dryAtAnchor(Observation observation) {
        return episode != null
            && episode.dryAnchor().equals(observation.playerFeet())
            && !observation.touchingWater()
            && observation.grounded()
            && observation.bodyClear()
            && observation.supportStable()
            && observation.anchorValid();
    }

    static boolean anchorWithinBounds(Cell detectedFeet, Cell dryAnchor) {
        return detectedFeet != null
            && dryAnchor != null
            && detectedFeet.horizontalDistanceSquared(dryAnchor) <= MAX_ANCHOR_HORIZONTAL_DISTANCE_SQ
            && Math.abs(detectedFeet.y() - dryAnchor.y()) <= MAX_ANCHOR_VERTICAL_DISTANCE;
    }

    static boolean postBreakProbeComplete(int stableDryPolls, long elapsedMs) {
        return stableDryPolls >= REQUIRED_STABLE_DRY_POLLS
            && elapsedMs >= POST_BREAK_PROBE_MIN_MS;
    }

    static PendingBreakObservation classifyPendingBreak(
        boolean tracked,
        boolean targetAir,
        boolean targetWater
    ) {
        if (!tracked) {
            return PendingBreakObservation.INTACT;
        }
        if (targetWater) {
            return PendingBreakObservation.OPEN_WATER;
        }
        return targetAir
            ? PendingBreakObservation.OPEN_DRY
            : PendingBreakObservation.INTACT;
    }

    static boolean mustRerouteAfterRecovery(
        Trigger trigger,
        boolean retreatUsed,
        boolean stepMissing,
        boolean waterRemains
    ) {
        return trigger == Trigger.POST_BREAK_BREACH
            || retreatUsed
            || stepMissing
            || waterRemains;
    }

    private Decision reject(Episode rejectedEpisode, String reason, long nowMs) {
        episode = rejectedEpisode;
        phase = Phase.REJECTED;
        stableDryPolls = 0;
        terminalReason = reason == null ? "rejected" : reason;
        return decision(Action.REJECTED, terminalReason, true, nowMs);
    }

    private Decision decision(Action action, String reason, boolean transitioned, long nowMs) {
        long remaining = episode == null
            ? 0L
            : Math.max(0L, EPISODE_TIMEOUT_MS - elapsedMs(nowMs));
        return new Decision(phase, action, episode, reason, transitioned, stableDryPolls, remaining);
    }

    private long elapsedMs(long nowMs) {
        return episode == null ? 0L : Math.max(0L, nowMs - episode.startedAtMs());
    }

    void resetEpisode() {
        phase = Phase.IDLE;
        episode = null;
        sealStartedAtMs = 0L;
        stableDryPolls = 0;
        terminalReason = "";
    }

    void clear() {
        resetEpisode();
        attemptedEpisodes.clear();
        attemptedSeals.clear();
    }

    Phase phase() {
        return phase;
    }

    Episode episode() {
        return episode;
    }

    int uniqueEpisodeCount() {
        return attemptedEpisodes.size();
    }

    int sealAttemptCount() {
        return attemptedSeals.size();
    }
}
