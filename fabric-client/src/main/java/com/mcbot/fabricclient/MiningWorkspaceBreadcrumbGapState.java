package com.mcbot.fabricclient;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

final class MiningWorkspaceBreadcrumbGapState {
    static final int MAX_COMPUTATIONS_PER_COMMAND = 4;
    static final int MAX_KEYS_PER_SESSION = 64;

    enum Context {
        MINE_NEARBY_IRON("mine_nearby_iron"),
        MINE_IRON_RECOVERY("mine_iron_recovery"),
        TRANSACTION_ADMISSION("transaction_admission"),
        FIELDKIT_RETURN("fieldkit_return");

        private final String eventName;

        Context(String eventName) {
            this.eventName = eventName;
        }

        String eventName() {
            return eventName;
        }

        boolean admits(String action, String reason) {
            return switch (this) {
                case MINE_NEARBY_IRON, FIELDKIT_RETURN -> "mine_nearby_iron".equals(action);
                case MINE_IRON_RECOVERY -> "descend_staircase".equals(action)
                    && "mission:MINE_IRON_RECOVERY".equals(reason);
                case TRANSACTION_ADMISSION ->
                    MiningWorkspaceTransaction.eligibleAction(action, reason)
                        || MiningWorkspaceTransaction.replacementAction(action, reason);
            };
        }
    }

    enum Disposition {
        COMPUTE,
        INVALID_INPUT,
        DUPLICATE_KEY,
        COMMAND_LIMIT,
        SESSION_KEY_LIMIT,
        FAILED_SEGMENT_LATCHED
    }

    enum Outcome {
        RECONCILED,
        REJECTED
    }

    record GapKey(String workspaceId, VoxelCell frontier, VoxelCell current) {
    }

    record Decision(
        Disposition disposition,
        GapKey key,
        long sessionRevision,
        int attempt
    ) {
        boolean shouldCompute() {
            return disposition == Disposition.COMPUTE;
        }
    }

    private final Set<GapKey> attemptedKeys = new LinkedHashSet<>();
    private final Map<String, Integer> computationsByCommand = new LinkedHashMap<>();
    private long sessionRevision = Long.MIN_VALUE;
    private FailedSegment failedSegment;

    static boolean shouldAttempt(
        Context context,
        String action,
        String reason,
        boolean grounded,
        boolean standable,
        boolean workspaceValid,
        boolean transactionActive
    ) {
        return context != null
            && context.admits(action, reason)
            && grounded
            && standable
            && workspaceValid
            && !transactionActive;
    }

    Decision begin(
        long nextSessionRevision,
        String nextCommandId,
        String workspaceId,
        VoxelCell frontier,
        VoxelCell current
    ) {
        synchronizeSession(nextSessionRevision);
        if (
            nextCommandId == null
                || nextCommandId.isBlank()
                || workspaceId == null
                || workspaceId.isBlank()
                || frontier == null
                || current == null
        ) {
            return decision(Disposition.INVALID_INPUT, null, 0);
        }
        GapKey key = new GapKey(workspaceId, frontier, current);
        int commandComputations = computationsByCommand.getOrDefault(nextCommandId, 0);
        if (failedSegment != null && failedSegment.matches(key)) {
            return decision(Disposition.FAILED_SEGMENT_LATCHED, key, commandComputations);
        }
        if (attemptedKeys.contains(key)) {
            return decision(Disposition.DUPLICATE_KEY, key, commandComputations);
        }
        if (commandComputations >= MAX_COMPUTATIONS_PER_COMMAND) {
            return decision(Disposition.COMMAND_LIMIT, key, commandComputations);
        }
        if (attemptedKeys.size() >= MAX_KEYS_PER_SESSION) {
            return decision(Disposition.SESSION_KEY_LIMIT, key, commandComputations);
        }

        attemptedKeys.add(key);
        commandComputations++;
        computationsByCommand.put(nextCommandId, commandComputations);
        return new Decision(Disposition.COMPUTE, key, sessionRevision, commandComputations);
    }

    void record(Decision decision, Outcome outcome) {
        if (
            decision == null
                || !decision.shouldCompute()
                || decision.sessionRevision() != sessionRevision
                || decision.key() == null
                || !attemptedKeys.contains(decision.key())
                || outcome == null
        ) {
            return;
        }
        if (outcome == Outcome.REJECTED) {
            failedSegment = new FailedSegment(
                decision.key().workspaceId(),
                decision.key().frontier()
            );
        }
    }

    void canonicalContinuityRestored(long nextSessionRevision) {
        synchronizeSession(nextSessionRevision);
        failedSegment = null;
    }

    int commandComputations(String commandId) {
        return computationsByCommand.getOrDefault(commandId, 0);
    }

    int retainedKeyCount() {
        return attemptedKeys.size();
    }

    boolean failedSegmentLatched() {
        return failedSegment != null;
    }

    long sessionRevision() {
        return sessionRevision;
    }

    private Decision decision(Disposition disposition, GapKey key, int commandComputations) {
        return new Decision(disposition, key, sessionRevision, commandComputations);
    }

    private void synchronizeSession(long nextSessionRevision) {
        if (sessionRevision == nextSessionRevision) {
            return;
        }
        sessionRevision = nextSessionRevision;
        attemptedKeys.clear();
        computationsByCommand.clear();
        failedSegment = null;
    }

    private record FailedSegment(String workspaceId, VoxelCell frontier) {
        boolean matches(GapKey key) {
            return workspaceId.equals(key.workspaceId()) && frontier.equals(key.frontier());
        }
    }
}
