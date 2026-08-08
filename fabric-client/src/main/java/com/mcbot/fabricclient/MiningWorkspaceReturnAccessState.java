package com.mcbot.fabricclient;

import java.util.ArrayDeque;
import java.util.Optional;

final class MiningWorkspaceReturnAccessState {
    enum Consumer {
        TRANSACTION("transaction"),
        FIELDKIT("fieldkit");

        private final String eventName;

        Consumer(String eventName) {
            this.eventName = eventName;
        }

        String eventName() {
            return eventName;
        }
    }

    enum SyncResult {
        INITIALIZED,
        UNCHANGED,
        REPLACED,
        STALE_SESSION,
        INVALID
    }

    enum BlockResult {
        BLOCKED,
        ALREADY_BLOCKED,
        STALE_WORKSPACE,
        STALE_SESSION,
        STALE_TRAIL,
        INVALID
    }

    enum RestoreResult {
        RESTORED,
        ALREADY_AVAILABLE,
        STALE_WORKSPACE,
        STALE_SESSION,
        STALE_TRAIL,
        NOT_AT_EXACT_STANCE,
        TRAIL_NOT_REANCHORED,
        INVALID
    }

    enum EventType {
        BLOCKED,
        RESTORED
    }

    record Snapshot(String workspaceId, long sessionRevision, long trailRevision) {
        Snapshot {
            workspaceId = workspaceId == null ? "" : workspaceId;
        }

        boolean hasWorkspace() {
            return !workspaceId.isBlank();
        }

        boolean validRevisions() {
            return sessionRevision >= 0L && trailRevision >= 0L;
        }
    }

    record BlockedAccess(
        Snapshot snapshot,
        Consumer consumer,
        String reason,
        String routeSignature
    ) {
    }

    record Event(EventType type, BlockedAccess blockedAccess, Snapshot currentSnapshot) {
    }

    private final ArrayDeque<Event> pendingEvents = new ArrayDeque<>(2);
    private String workspaceId = "";
    private long sessionRevision = Long.MIN_VALUE;
    private BlockedAccess blockedAccess;
    private int suppressedDuplicateCount;

    SyncResult synchronize(Snapshot current) {
        if (current == null || !current.validRevisions()) {
            return SyncResult.INVALID;
        }
        if (sessionRevision == Long.MIN_VALUE) {
            replaceIdentity(current);
            return SyncResult.INITIALIZED;
        }
        if (current.sessionRevision() < sessionRevision) {
            return SyncResult.STALE_SESSION;
        }
        if (current.sessionRevision() == sessionRevision) {
            return workspaceId.equals(current.workspaceId())
                ? SyncResult.UNCHANGED
                : SyncResult.INVALID;
        }
        replaceIdentity(current);
        return SyncResult.REPLACED;
    }

    BlockResult block(
        Snapshot expected,
        Snapshot current,
        Consumer consumer,
        String reason,
        String routeSignature
    ) {
        if (!validBlockInput(expected, current, consumer, reason, routeSignature)) {
            return BlockResult.INVALID;
        }
        SyncResult sync = synchronize(current);
        if (sync == SyncResult.STALE_SESSION) {
            return BlockResult.STALE_SESSION;
        }
        if (sync == SyncResult.INVALID) {
            return BlockResult.INVALID;
        }
        BlockResult stale = compare(expected, current);
        if (stale != null) {
            return stale;
        }
        if (blockedAccess != null) {
            suppressedDuplicateCount++;
            return BlockResult.ALREADY_BLOCKED;
        }

        blockedAccess = new BlockedAccess(current, consumer, reason, routeSignature);
        pendingEvents.addLast(new Event(EventType.BLOCKED, blockedAccess, current));
        return BlockResult.BLOCKED;
    }

    RestoreResult restoreAfterReanchor(
        Snapshot expected,
        Snapshot current,
        boolean atExactVerifiedWorkspaceStance,
        boolean canonicalTrailReset
    ) {
        if (expected == null || current == null || !current.hasWorkspace()
            || !expected.validRevisions() || !current.validRevisions()) {
            return RestoreResult.INVALID;
        }
        SyncResult sync = synchronize(current);
        if (sync == SyncResult.STALE_SESSION) {
            return RestoreResult.STALE_SESSION;
        }
        if (sync == SyncResult.INVALID) {
            return RestoreResult.INVALID;
        }
        RestoreResult stale = compareForRestore(expected, current);
        if (stale != null) {
            return stale;
        }
        if (!atExactVerifiedWorkspaceStance) {
            return RestoreResult.NOT_AT_EXACT_STANCE;
        }
        if (!canonicalTrailReset) {
            return RestoreResult.TRAIL_NOT_REANCHORED;
        }
        if (blockedAccess == null) {
            return RestoreResult.ALREADY_AVAILABLE;
        }

        BlockedAccess restored = blockedAccess;
        blockedAccess = null;
        pendingEvents.addLast(new Event(EventType.RESTORED, restored, current));
        return RestoreResult.RESTORED;
    }

    boolean permitsRemoteReturn(Snapshot current) {
        SyncResult sync = synchronize(current);
        return sync != SyncResult.INVALID
            && sync != SyncResult.STALE_SESSION
            && current.hasWorkspace()
            && blockedAccess == null;
    }

    boolean blocked() {
        return blockedAccess != null;
    }

    Optional<BlockedAccess> blockedAccess() {
        return Optional.ofNullable(blockedAccess);
    }

    Optional<Event> pollEvent() {
        return Optional.ofNullable(pendingEvents.pollFirst());
    }

    int suppressedDuplicateCount() {
        return suppressedDuplicateCount;
    }

    String workspaceId() {
        return workspaceId;
    }

    long sessionRevision() {
        return sessionRevision;
    }

    private static boolean validBlockInput(
        Snapshot expected,
        Snapshot current,
        Consumer consumer,
        String reason,
        String routeSignature
    ) {
        return expected != null
            && current != null
            && expected.hasWorkspace()
            && current.hasWorkspace()
            && expected.validRevisions()
            && current.validRevisions()
            && consumer != null
            && reason != null
            && !reason.isBlank()
            && routeSignature != null
            && !routeSignature.isBlank();
    }

    private static BlockResult compare(Snapshot expected, Snapshot current) {
        if (!expected.workspaceId().equals(current.workspaceId())) {
            return BlockResult.STALE_WORKSPACE;
        }
        if (expected.sessionRevision() != current.sessionRevision()) {
            return BlockResult.STALE_SESSION;
        }
        if (expected.trailRevision() != current.trailRevision()) {
            return BlockResult.STALE_TRAIL;
        }
        return null;
    }

    private static RestoreResult compareForRestore(Snapshot expected, Snapshot current) {
        if (!expected.workspaceId().equals(current.workspaceId())) {
            return RestoreResult.STALE_WORKSPACE;
        }
        if (expected.sessionRevision() != current.sessionRevision()) {
            return RestoreResult.STALE_SESSION;
        }
        if (expected.trailRevision() != current.trailRevision()) {
            return RestoreResult.STALE_TRAIL;
        }
        return null;
    }

    private void replaceIdentity(Snapshot current) {
        workspaceId = current.workspaceId();
        sessionRevision = current.sessionRevision();
        blockedAccess = null;
        suppressedDuplicateCount = 0;
        pendingEvents.clear();
    }
}
