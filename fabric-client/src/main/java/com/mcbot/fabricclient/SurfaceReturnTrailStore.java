package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

final class SurfaceReturnTrailStore {
    static final int MAX_TRAIL_CELLS = 4096;
    static final int MAX_GAP_KEYS = 64;

    enum StartResult {
        STARTED,
        ALREADY_ACTIVE,
        INVALID_ANCHOR
    }

    enum AppendResult {
        APPENDED,
        LOOP_TRUNCATED,
        UNCHANGED,
        IGNORED_TRANSIENT,
        REJECTED_UNSAFE,
        REJECTED_DISCONNECTED,
        REJECTED_SATURATED,
        REJECTED_NO_SESSION
    }

    enum SegmentResult {
        APPENDED,
        LOOP_TRUNCATED,
        UNCHANGED,
        STALE_FRONTIER,
        INVALID_SEGMENT,
        SATURATED,
        NO_SESSION
    }

    enum ConnectorAppendResult {
        RECONCILED,
        STALE_SESSION,
        STALE_TRAIL,
        STALE_FRONTIER,
        STRUCTURALLY_INVALID,
        INVALID_CONNECTOR,
        TRAIL_INTERSECTION,
        SATURATED
    }

    enum TrailReplaceResult {
        REPLACED,
        STALE_SESSION,
        STALE_TRAIL,
        STALE_ANCHOR,
        INVALID_REPLACEMENT,
        TRAIL_INTERSECTION,
        SATURATED
    }

    enum RemoteSuffixInvalidateResult {
        INVALIDATED,
        UNCHANGED,
        STALE_SESSION,
        STALE_TRAIL
    }

    enum GapStatus {
        RECONCILED,
        REJECTED,
        DUPLICATE,
        KEY_LIMIT,
        IGNORED_TRANSIENT,
        NO_SESSION,
        SATURATED
    }

    enum FinishResult {
        FINISHED,
        NO_SESSION,
        STALE_SESSION,
        NOT_AT_ANCHOR,
        INVALID_STANCE
    }

    private enum SuffixState {
        AVAILABLE,
        GAP_REJECTED,
        STRUCTURALLY_INVALID,
        SATURATED
    }

    private String worldKey = "";
    private String dimensionKey = "";
    private String descentCommandId = "";
    private VoxelCell anchor;
    private final List<VoxelCell> trail = new ArrayList<>();
    private final Set<String> admittedDescentCommandIds = new LinkedHashSet<>();
    private final Set<GapKey> gapKeys = new LinkedHashSet<>();
    private long sessionRevision;
    private long trailRevision;
    private SuffixState suffixState = SuffixState.AVAILABLE;

    boolean observeContext(String nextWorldKey, String nextDimensionKey) {
        String world = normalize(nextWorldKey);
        String dimension = normalize(nextDimensionKey);
        if (world.equals(worldKey) && dimension.equals(dimensionKey)) {
            return false;
        }
        worldKey = world;
        dimensionKey = dimension;
        clearSessionContents();
        sessionRevision++;
        return true;
    }

    StartResult startSession(
        String commandId,
        VoxelCell requestedAnchor,
        boolean grounded,
        GatherWoodLocalEgressPerception perception
    ) {
        if (anchor != null) {
            return StartResult.ALREADY_ACTIVE;
        }
        if (
            !grounded
                || !SurfaceReturnTrailGapPlanner.safeCell(perception, requestedAnchor)
        ) {
            return StartResult.INVALID_ANCHOR;
        }
        descentCommandId = normalize(commandId);
        anchor = requestedAnchor;
        trail.add(requestedAnchor);
        admittedDescentCommandIds.clear();
        if (!descentCommandId.isBlank()) {
            admittedDescentCommandIds.add(descentCommandId);
        }
        gapKeys.clear();
        suffixState = SuffixState.AVAILABLE;
        sessionRevision++;
        trailRevision++;
        return StartResult.STARTED;
    }

    /**
     * Admit a descent command to the active surface excursion before its executor can replace and
     * flush the prior command. This prevents a stale pre-session executor run from contributing a
     * coincidentally connected prefix to the newly created trail.
     */
    boolean admitDescentCommand(String commandId) {
        String normalized = normalize(commandId);
        if (anchor == null || normalized.isBlank()) {
            return false;
        }
        admittedDescentCommandIds.add(normalized);
        return true;
    }

    boolean ownsDescentCommand(String commandId) {
        return anchor != null && admittedDescentCommandIds.contains(normalize(commandId));
    }

    AppendResult appendObserved(
        GatherWoodLocalEgressPerception perception,
        VoxelCell feet,
        boolean grounded
    ) {
        if (anchor == null) {
            return AppendResult.REJECTED_NO_SESSION;
        }
        if (feet == null || !grounded) {
            return AppendResult.IGNORED_TRANSIENT;
        }
        VoxelCell frontier = frontier();
        if (feet.equals(frontier)) {
            if (!SurfaceReturnTrailGapPlanner.safeCell(perception, feet)) {
                return AppendResult.REJECTED_UNSAFE;
            }
            if (suffixState == SuffixState.GAP_REJECTED) {
                // Returning to the last canonical stance is an explicit recovery boundary. Forget
                // only failed signatures launched from that frontier so a later, genuinely changed
                // local connector can be evaluated once instead of remaining DUPLICATE forever.
                gapKeys.removeIf(key -> key.frontier().equals(feet));
                // Availability is part of the externally observed trail snapshot even though the
                // cells did not change. Advance the revision exactly once for this recovery epoch;
                // repeated observations at the same healthy frontier remain revision-stable.
                trailRevision++;
            }
            restoreAfterDirectAppend();
            return AppendResult.UNCHANGED;
        }
        int existing = trail.indexOf(feet);
        if (existing >= 0) {
            if (!SurfaceReturnTrailGapPlanner.safeCell(perception, feet)) {
                return AppendResult.REJECTED_UNSAFE;
            }
            trail.subList(existing + 1, trail.size()).clear();
            trailRevision++;
            restoreAfterDirectAppend();
            return AppendResult.LOOP_TRUNCATED;
        }
        if (sameColumn(frontier, feet)) {
            return AppendResult.IGNORED_TRANSIENT;
        }
        if (!SurfaceReturnTrailGapPlanner.safeCell(perception, feet)) {
            return AppendResult.REJECTED_UNSAFE;
        }
        if (!SurfaceReturnTrailGapPlanner.reversibleStep(perception, frontier, feet)) {
            return AppendResult.REJECTED_DISCONNECTED;
        }
        if (trail.size() >= MAX_TRAIL_CELLS || suffixState == SuffixState.SATURATED) {
            suffixState = SuffixState.SATURATED;
            return AppendResult.REJECTED_SATURATED;
        }
        trail.add(feet);
        trailRevision++;
        restoreAfterDirectAppend();
        return AppendResult.APPENDED;
    }

    SegmentResult appendCompletedSegment(
        GatherWoodLocalEgressPerception perception,
        List<VoxelCell> segment
    ) {
        if (anchor == null) {
            return SegmentResult.NO_SESSION;
        }
        if (
            perception == null
                || segment == null
                || segment.isEmpty()
                || segment.get(0) == null
                || !segment.get(0).equals(frontier())
        ) {
            return SegmentResult.STALE_FRONTIER;
        }
        if (suffixState == SuffixState.SATURATED) {
            return SegmentResult.SATURATED;
        }

        List<VoxelCell> candidate = new ArrayList<>(trail);
        boolean truncated = false;
        for (int index = 0; index < segment.size(); index++) {
            VoxelCell cell = segment.get(index);
            if (cell == null || !SurfaceReturnTrailGapPlanner.safeCell(perception, cell)) {
                return SegmentResult.INVALID_SEGMENT;
            }
            if (index == 0) {
                continue;
            }
            VoxelCell previous = candidate.get(candidate.size() - 1);
            if (!SurfaceReturnTrailGapPlanner.reversibleStep(perception, previous, cell)) {
                if (isValidatedMultiBlockFallSuffix(previous, cell)) {
                    return commitCompletedSegmentCandidate(candidate, truncated, true);
                }
                return SegmentResult.INVALID_SEGMENT;
            }
            int existing = candidate.indexOf(cell);
            if (existing >= 0) {
                candidate.subList(existing + 1, candidate.size()).clear();
                truncated = true;
                continue;
            }
            if (candidate.size() >= MAX_TRAIL_CELLS) {
                suffixState = SuffixState.SATURATED;
                return SegmentResult.SATURATED;
            }
            candidate.add(cell);
        }
        return commitCompletedSegmentCandidate(candidate, truncated, false);
    }

    private SegmentResult commitCompletedSegmentCandidate(
        List<VoxelCell> candidate,
        boolean truncated,
        boolean rejectedSuffix
    ) {
        if (candidate.equals(trail)) {
            if (rejectedSuffix && rejectSamplingGap()) {
                trailRevision++;
            }
            return SegmentResult.UNCHANGED;
        }
        trail.clear();
        trail.addAll(candidate);
        trailRevision++;
        if (rejectedSuffix) {
            rejectSamplingGap();
        } else {
            restoreAfterDirectAppend();
        }
        return truncated ? SegmentResult.LOOP_TRUNCATED : SegmentResult.APPENDED;
    }

    /**
     * A controlled safe fall advances into the adjacent descent column but can land multiple
     * blocks below the prior stance. Its landing is safe but the edge is intentionally not replayed
     * as a staircase transition, so only the reversible prefix before it belongs in the trail.
     */
    private static boolean isValidatedMultiBlockFallSuffix(VoxelCell from, VoxelCell to) {
        if (from == null || to == null) {
            return false;
        }
        int horizontal = Math.abs(to.x() - from.x()) + Math.abs(to.z() - from.z());
        return horizontal == 1 && (long) from.y() - to.y() > 1L;
    }

    /**
     * Append the longest safe, reversible prefix of a failed descent. A later validated safe-fall
     * landing can be one-way and therefore unsuitable for replay, but it must not erase the earlier
     * staircase cells that were already proven reversible.
     */
    SegmentResult appendFailedSegmentPrefix(
        GatherWoodLocalEgressPerception perception,
        List<VoxelCell> segment
    ) {
        if (anchor == null) {
            return SegmentResult.NO_SESSION;
        }
        if (perception == null
            || segment == null
            || segment.isEmpty()
            || segment.get(0) == null
            || !segment.get(0).equals(frontier())) {
            return SegmentResult.STALE_FRONTIER;
        }
        if (suffixState == SuffixState.SATURATED) {
            return SegmentResult.SATURATED;
        }

        int accepted = 1;
        VoxelCell previous = segment.get(0);
        while (accepted < segment.size()) {
            VoxelCell cell = segment.get(accepted);
            if (cell == null
                || !SurfaceReturnTrailGapPlanner.safeCell(perception, cell)
                || !SurfaceReturnTrailGapPlanner.reversibleStep(perception, previous, cell)) {
                break;
            }
            previous = cell;
            accepted++;
        }
        long revisionBeforeAppend = trailRevision;
        SegmentResult result = appendCompletedSegment(perception, segment.subList(0, accepted));
        if (accepted < segment.size() && suffixState != SuffixState.SATURATED) {
            boolean availabilityChanged = rejectSamplingGap();
            if (availabilityChanged && trailRevision == revisionBeforeAppend) {
                trailRevision++;
            }
        }
        return result;
    }

    GapReconcileResult reconcileGap(
        GatherWoodLocalEgressPerception perception,
        VoxelCell current,
        boolean grounded
    ) {
        if (anchor == null) {
            return GapReconcileResult.failure(GapStatus.NO_SESSION, "no_session", 0);
        }
        if (suffixState == SuffixState.SATURATED) {
            return GapReconcileResult.failure(GapStatus.SATURATED, "trail_saturated", 0);
        }
        if (suffixState == SuffixState.STRUCTURALLY_INVALID) {
            return GapReconcileResult.failure(
                GapStatus.REJECTED,
                "remote_suffix_structurally_invalid",
                0
            );
        }
        if (
            current == null
                || !grounded
                || !SurfaceReturnTrailGapPlanner.safeCell(perception, current)
        ) {
            return GapReconcileResult.failure(
                GapStatus.IGNORED_TRANSIENT,
                "current_not_safe",
                0
            );
        }

        VoxelCell expectedFrontier = frontier();
        GapKey key = new GapKey(
            sessionRevision,
            trailRevision,
            expectedFrontier,
            current
        );
        if (gapKeys.contains(key)) {
            return GapReconcileResult.failure(GapStatus.DUPLICATE, "duplicate_gap", 0);
        }
        if (gapKeys.size() >= MAX_GAP_KEYS) {
            rejectSamplingGap();
            return GapReconcileResult.failure(GapStatus.KEY_LIMIT, "gap_key_limit", 0);
        }
        gapKeys.add(key);

        SurfaceReturnTrailGapPlanner.Result planned = SurfaceReturnTrailGapPlanner.plan(
            perception,
            expectedFrontier,
            current,
            trail
        );
        if (!planned.found()) {
            rejectSamplingGap();
            return GapReconcileResult.failure(
                GapStatus.REJECTED,
                planned.failureReason(),
                planned.expandedCells()
            );
        }
        int beforeCount = trail.size();
        ConnectorAppendResult appendResult = appendConnector(
            sessionRevision,
            trailRevision,
            expectedFrontier,
            perception,
            planned.connector()
        );
        if (appendResult != ConnectorAppendResult.RECONCILED) {
            if (appendResult == ConnectorAppendResult.SATURATED) {
                suffixState = SuffixState.SATURATED;
            } else {
                rejectSamplingGap();
            }
            return GapReconcileResult.failure(
                appendResult == ConnectorAppendResult.SATURATED
                    ? GapStatus.SATURATED
                    : GapStatus.REJECTED,
                appendResult.name().toLowerCase(java.util.Locale.ROOT),
                planned.expandedCells()
            );
        }
        return new GapReconcileResult(
            GapStatus.RECONCILED,
            "",
            planned.connector().size(),
            planned.expandedCells(),
            beforeCount,
            trail.size()
        );
    }

    ConnectorAppendResult appendConnector(
        long expectedSessionRevision,
        long expectedTrailRevision,
        VoxelCell expectedFrontier,
        GatherWoodLocalEgressPerception perception,
        List<VoxelCell> connector
    ) {
        if (anchor == null || sessionRevision != expectedSessionRevision) {
            return ConnectorAppendResult.STALE_SESSION;
        }
        if (trailRevision != expectedTrailRevision) {
            return ConnectorAppendResult.STALE_TRAIL;
        }
        if (!Objects.equals(frontier(), expectedFrontier)) {
            return ConnectorAppendResult.STALE_FRONTIER;
        }
        if (suffixState == SuffixState.STRUCTURALLY_INVALID) {
            return ConnectorAppendResult.STRUCTURALLY_INVALID;
        }
        if (
            connector == null
                || connector.size() < 2
                || connector.size() > SurfaceReturnTrailGapPlanner.MAX_ROUTE_CELLS
                || expectedFrontier == null
                || !expectedFrontier.equals(connector.get(0))
        ) {
            return ConnectorAppendResult.INVALID_CONNECTOR;
        }
        for (int index = 0; index < connector.size(); index++) {
            VoxelCell cell = connector.get(index);
            if (
                cell == null
                    || !SurfaceReturnTrailGapPlanner.safeCell(perception, cell)
                    || (index > 0 && !SurfaceReturnTrailGapPlanner.reversibleStep(
                        perception,
                        connector.get(index - 1),
                        cell
                    ))
            ) {
                return ConnectorAppendResult.INVALID_CONNECTOR;
            }
        }
        List<VoxelCell> suffix = connector.subList(1, connector.size());
        for (int index = 0; index < suffix.size(); index++) {
            VoxelCell cell = suffix.get(index);
            if (trail.contains(cell) || suffix.subList(0, index).contains(cell)) {
                return ConnectorAppendResult.TRAIL_INTERSECTION;
            }
        }
        if (
            trail.size() + suffix.size() > MAX_TRAIL_CELLS
                || suffixState == SuffixState.SATURATED
        ) {
            return ConnectorAppendResult.SATURATED;
        }
        trail.addAll(suffix);
        trailRevision++;
        suffixState = SuffixState.AVAILABLE;
        return ConnectorAppendResult.RECONCILED;
    }

    TrailReplaceResult replaceTrail(
        long expectedSessionRevision,
        long expectedTrailRevision,
        VoxelCell expectedAnchor,
        List<VoxelCell> expectedTrail,
        List<VoxelCell> replacement
    ) {
        if (anchor == null || sessionRevision != expectedSessionRevision) {
            return TrailReplaceResult.STALE_SESSION;
        }
        if (!anchor.equals(expectedAnchor)) {
            return TrailReplaceResult.STALE_ANCHOR;
        }
        if (trailRevision != expectedTrailRevision || !trail.equals(expectedTrail)) {
            return TrailReplaceResult.STALE_TRAIL;
        }
        if (replacement == null || replacement.size() < 2) {
            return TrailReplaceResult.INVALID_REPLACEMENT;
        }
        if (replacement.size() > MAX_TRAIL_CELLS) {
            return TrailReplaceResult.SATURATED;
        }
        if (
            expectedTrail == null
                || expectedTrail.size() < 2
                || replacement.equals(expectedTrail)
                || replacement.get(0) == null
                || replacement.get(replacement.size() - 1) == null
                || !replacement.get(0).equals(expectedTrail.get(0))
                || !replacement.get(replacement.size() - 1).equals(
                    expectedTrail.get(expectedTrail.size() - 1)
                )
                || !anchor.equals(replacement.get(0))
        ) {
            return TrailReplaceResult.INVALID_REPLACEMENT;
        }

        Set<VoxelCell> unique = new LinkedHashSet<>();
        for (int index = 0; index < replacement.size(); index++) {
            VoxelCell cell = replacement.get(index);
            if (cell == null || !unique.add(cell)) {
                return TrailReplaceResult.INVALID_REPLACEMENT;
            }
            if (
                index > 0
                    && !structurallyReversible(replacement.get(index - 1), cell)
            ) {
                return TrailReplaceResult.INVALID_REPLACEMENT;
            }
        }

        int commonPrefixLength = commonPrefixLength(expectedTrail, replacement);
        int commonSuffixLength = commonSuffixLength(
            expectedTrail,
            replacement,
            commonPrefixLength
        );
        for (
            int index = commonPrefixLength;
            index < replacement.size() - commonSuffixLength;
            index++
        ) {
            if (expectedTrail.contains(replacement.get(index))) {
                return TrailReplaceResult.TRAIL_INTERSECTION;
            }
        }

        trail.clear();
        trail.addAll(replacement);
        trailRevision++;
        suffixState = SuffixState.AVAILABLE;
        gapKeys.clear();
        return TrailReplaceResult.REPLACED;
    }

    /**
     * Restores a previously verified anchor-to-shaft checkpoint after a bounded retrace. Unlike a
     * suffix repair, the live trail endpoint is expected to change from the crafting detour back to
     * the saved shaft frontier. The caller must provide the exact current snapshot; any concurrent
     * append or session change rejects without mutation.
     */
    TrailReplaceResult restoreVerifiedPrefix(
        long expectedSessionRevision,
        long expectedTrailRevision,
        VoxelCell expectedAnchor,
        List<VoxelCell> expectedCurrentTrail,
        List<VoxelCell> verifiedPrefix
    ) {
        if (anchor == null || sessionRevision != expectedSessionRevision) {
            return TrailReplaceResult.STALE_SESSION;
        }
        if (!anchor.equals(expectedAnchor)) {
            return TrailReplaceResult.STALE_ANCHOR;
        }
        if (trailRevision != expectedTrailRevision
            || expectedCurrentTrail == null
            || !trail.equals(expectedCurrentTrail)) {
            return TrailReplaceResult.STALE_TRAIL;
        }
        if (verifiedPrefix == null
            || verifiedPrefix.size() < 2
            || verifiedPrefix.size() > MAX_TRAIL_CELLS
            || !anchor.equals(verifiedPrefix.getFirst())) {
            return verifiedPrefix != null && verifiedPrefix.size() > MAX_TRAIL_CELLS
                ? TrailReplaceResult.SATURATED
                : TrailReplaceResult.INVALID_REPLACEMENT;
        }
        Set<VoxelCell> unique = new LinkedHashSet<>();
        for (int index = 0; index < verifiedPrefix.size(); index++) {
            VoxelCell cell = verifiedPrefix.get(index);
            if (cell == null || !unique.add(cell)) {
                return TrailReplaceResult.INVALID_REPLACEMENT;
            }
            if (index > 0 && !structurallyReversible(verifiedPrefix.get(index - 1), cell)) {
                return TrailReplaceResult.INVALID_REPLACEMENT;
            }
        }
        if (trail.equals(verifiedPrefix)) {
            boolean availabilityChanged = suffixState != SuffixState.AVAILABLE;
            suffixState = SuffixState.AVAILABLE;
            gapKeys.clear();
            if (availabilityChanged) {
                // Remote availability is part of the versioned trail snapshot even when the
                // canonical cells themselves are unchanged. Consumers cache admission decisions
                // by trail revision, so publish this explicit re-anchor exactly once.
                trailRevision++;
            }
            return TrailReplaceResult.REPLACED;
        }
        trail.clear();
        trail.addAll(verifiedPrefix);
        trailRevision++;
        suffixState = SuffixState.AVAILABLE;
        gapKeys.clear();
        return TrailReplaceResult.REPLACED;
    }

    /**
     * Publish that the canonical trail's own live geometry is no longer replayable. This is an
     * atomic availability update: callers must hold the exact session/trail snapshot they
     * preflighted. A broken cell that exists only in some older frozen shaft prefix must not call
     * this method, because the still-live surface trail remains valid in that case.
     */
    RemoteSuffixInvalidateResult invalidateRemoteSuffix(
        long expectedSessionRevision,
        long expectedTrailRevision,
        List<VoxelCell> expectedTrail
    ) {
        if (anchor == null || sessionRevision != expectedSessionRevision) {
            return RemoteSuffixInvalidateResult.STALE_SESSION;
        }
        if (trailRevision != expectedTrailRevision
            || expectedTrail == null
            || !trail.equals(expectedTrail)) {
            return RemoteSuffixInvalidateResult.STALE_TRAIL;
        }
        if (suffixState == SuffixState.STRUCTURALLY_INVALID
            || suffixState == SuffixState.SATURATED) {
            return RemoteSuffixInvalidateResult.UNCHANGED;
        }
        suffixState = SuffixState.STRUCTURALLY_INVALID;
        trailRevision++;
        return RemoteSuffixInvalidateResult.INVALIDATED;
    }

    RouteSelection selectReturnRoute(VoxelCell current, VoxelCell requestedAnchor) {
        if (anchor == null || trail.isEmpty()) {
            return RouteSelection.failure("no_session", sessionRevision, trailRevision);
        }
        if (suffixState == SuffixState.SATURATED) {
            return RouteSelection.failure("trail_saturated", sessionRevision, trailRevision);
        }
        if (suffixState == SuffixState.GAP_REJECTED
            || suffixState == SuffixState.STRUCTURALLY_INVALID) {
            return RouteSelection.failure(
                "remote_suffix_unavailable",
                sessionRevision,
                trailRevision
            );
        }
        if (!anchor.equals(requestedAnchor) || !anchor.equals(trail.get(0))) {
            return RouteSelection.failure("anchor_not_covered", sessionRevision, trailRevision);
        }
        if (current == null || !current.equals(frontier())) {
            return RouteSelection.failure("current_not_covered", sessionRevision, trailRevision);
        }
        List<VoxelCell> route = new ArrayList<>(trail);
        Collections.reverse(route);
        return new RouteSelection(route, "", sessionRevision, trailRevision);
    }

    FinishResult finishAtAnchor(
        long expectedSessionRevision,
        VoxelCell feet,
        boolean grounded,
        GatherWoodLocalEgressPerception perception
    ) {
        if (anchor == null) {
            return FinishResult.NO_SESSION;
        }
        if (sessionRevision != expectedSessionRevision) {
            return FinishResult.STALE_SESSION;
        }
        if (!anchor.equals(feet)) {
            return FinishResult.NOT_AT_ANCHOR;
        }
        if (!grounded || !SurfaceReturnTrailGapPlanner.safeCell(perception, feet)) {
            return FinishResult.INVALID_STANCE;
        }
        clearSessionContents();
        sessionRevision++;
        return FinishResult.FINISHED;
    }

    void clearSession() {
        if (anchor == null && trail.isEmpty() && gapKeys.isEmpty()) {
            return;
        }
        clearSessionContents();
        sessionRevision++;
    }

    boolean active() {
        return anchor != null;
    }

    String worldKey() {
        return worldKey;
    }

    String dimensionKey() {
        return dimensionKey;
    }

    String descentCommandId() {
        return descentCommandId;
    }

    VoxelCell anchor() {
        return anchor;
    }

    VoxelCell frontier() {
        return trail.isEmpty() ? null : trail.get(trail.size() - 1);
    }

    List<VoxelCell> trail() {
        return List.copyOf(trail);
    }

    int trailCount() {
        return trail.size();
    }

    int gapKeyCount() {
        return gapKeys.size();
    }

    long sessionRevision() {
        return sessionRevision;
    }

    long trailRevision() {
        return trailRevision;
    }

    boolean remoteSuffixAvailable() {
        return anchor != null && suffixState == SuffixState.AVAILABLE;
    }

    boolean saturated() {
        return suffixState == SuffixState.SATURATED;
    }

    private void restoreAfterDirectAppend() {
        if (suffixState == SuffixState.GAP_REJECTED) {
            suffixState = SuffixState.AVAILABLE;
        }
    }

    /**
     * Mark a recoverable observation gap without weakening a stronger structural or saturation
     * failure. Returns whether externally visible availability changed.
     */
    private boolean rejectSamplingGap() {
        if (suffixState != SuffixState.AVAILABLE) {
            return false;
        }
        suffixState = SuffixState.GAP_REJECTED;
        return true;
    }

    private void clearSessionContents() {
        descentCommandId = "";
        anchor = null;
        if (!trail.isEmpty()) {
            trail.clear();
            trailRevision++;
        }
        admittedDescentCommandIds.clear();
        gapKeys.clear();
        suffixState = SuffixState.AVAILABLE;
    }

    private static boolean sameColumn(VoxelCell left, VoxelCell right) {
        return left != null
            && right != null
            && left.x() == right.x()
            && left.z() == right.z();
    }

    private static boolean structurallyReversible(VoxelCell left, VoxelCell right) {
        if (left == null || right == null) {
            return false;
        }
        int horizontal = Math.abs(left.x() - right.x()) + Math.abs(left.z() - right.z());
        int vertical = Math.abs(left.y() - right.y());
        return horizontal == 1 && vertical <= 1;
    }

    private static int commonPrefixLength(List<VoxelCell> left, List<VoxelCell> right) {
        int limit = Math.min(left.size(), right.size());
        int index = 0;
        while (index < limit && left.get(index).equals(right.get(index))) {
            index++;
        }
        return index;
    }

    private static int commonSuffixLength(
        List<VoxelCell> left,
        List<VoxelCell> right,
        int commonPrefixLength
    ) {
        int maxLength = Math.min(left.size(), right.size()) - commonPrefixLength;
        int length = 0;
        while (
            length < maxLength
                && left.get(left.size() - 1 - length).equals(
                    right.get(right.size() - 1 - length)
                )
        ) {
            length++;
        }
        return length;
    }

    private static String normalize(String value) {
        return value == null ? "" : value;
    }

    record GapReconcileResult(
        GapStatus status,
        String reason,
        int connectorCells,
        int expandedCells,
        int trailCountBefore,
        int trailCountAfter
    ) {
        GapReconcileResult {
            reason = reason == null ? "" : reason;
        }

        static GapReconcileResult failure(GapStatus status, String reason, int expandedCells) {
            return new GapReconcileResult(status, reason, 0, expandedCells, 0, 0);
        }

        boolean reconciled() {
            return status == GapStatus.RECONCILED;
        }
    }

    record RouteSelection(
        List<VoxelCell> route,
        String failureReason,
        long sessionRevision,
        long trailRevision
    ) {
        RouteSelection {
            route = route == null ? List.of() : List.copyOf(route);
            failureReason = failureReason == null ? "" : failureReason;
        }

        static RouteSelection failure(
            String reason,
            long sessionRevision,
            long trailRevision
        ) {
            return new RouteSelection(List.of(), reason, sessionRevision, trailRevision);
        }

        boolean selected() {
            return !route.isEmpty();
        }
    }

    private record GapKey(
        long sessionRevision,
        long trailRevision,
        VoxelCell frontier,
        VoxelCell current
    ) {
    }
}
