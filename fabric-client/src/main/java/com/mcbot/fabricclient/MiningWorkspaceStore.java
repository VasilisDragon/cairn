package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

final class MiningWorkspaceStore {
    static final int MAX_BREADCRUMBS = 512;

    enum AppendResult {
        APPENDED,
        LOOP_TRUNCATED,
        UNCHANGED,
        IGNORED_TRANSIENT,
        REJECTED_DISCONNECTED,
        REJECTED_SATURATED,
        REJECTED_NO_WORKSPACE
    }

    enum ConnectorAppendResult {
        RECONCILED,
        STALE_FRONTIER,
        INVALID_CONNECTOR,
        TRAIL_INTERSECTION,
        SATURATED
    }

    enum TrailReplaceResult {
        REPLACED,
        STALE_WORKSPACE,
        STALE_SESSION,
        STALE_TRAIL,
        INVALID_REPLACEMENT,
        TRAIL_INTERSECTION,
        SATURATED
    }

    enum ReanchorResult {
        REANCHORED,
        ALREADY_ANCHORED,
        STALE_WORKSPACE,
        STALE_SESSION,
        STALE_TRAIL,
        INVALID_STANCE
    }

    private String worldKey = "";
    private String dimensionKey = "";
    private Workspace workspace;
    private final List<VoxelCell> breadcrumbs = new ArrayList<>();
    private long sessionRevision;
    private long trailRevision;

    boolean observeContext(String nextWorldKey, String nextDimensionKey) {
        String world = nextWorldKey == null ? "" : nextWorldKey;
        String dimension = nextDimensionKey == null ? "" : nextDimensionKey;
        if (world.equals(worldKey) && dimension.equals(dimensionKey)) {
            return false;
        }
        worldKey = world;
        dimensionKey = dimension;
        workspace = null;
        clearBreadcrumbs();
        sessionRevision++;
        return true;
    }

    void record(Workspace nextWorkspace) {
        workspace = nextWorkspace;
        List<VoxelCell> nextBreadcrumbs = new ArrayList<>();
        if (nextWorkspace != null && nextWorkspace.stance() != null) {
            nextBreadcrumbs.add(nextWorkspace.stance());
        }
        if (!breadcrumbs.equals(nextBreadcrumbs)) {
            breadcrumbs.clear();
            breadcrumbs.addAll(nextBreadcrumbs);
            trailRevision++;
        }
        sessionRevision++;
    }

    Workspace workspace() {
        return workspace;
    }

    VoxelCell frontier() {
        return breadcrumbs.isEmpty() ? null : breadcrumbs.get(breadcrumbs.size() - 1);
    }

    List<VoxelCell> trail() {
        return List.copyOf(breadcrumbs);
    }

    long sessionRevision() {
        return sessionRevision;
    }

    long trailRevision() {
        return trailRevision;
    }

    void invalidate() {
        workspace = null;
        clearBreadcrumbs();
        sessionRevision++;
    }

    AppendResult append(VoxelCell feet, boolean grounded, boolean standable) {
        if (workspace == null) {
            return AppendResult.REJECTED_NO_WORKSPACE;
        }
        if (feet == null || !grounded || !standable) {
            return AppendResult.IGNORED_TRANSIENT;
        }
        VoxelCell frontier = breadcrumbs.isEmpty() ? null : breadcrumbs.get(breadcrumbs.size() - 1);
        if (feet.equals(frontier)) {
            return AppendResult.UNCHANGED;
        }
        if (frontier != null && sameColumn(frontier, feet)) {
            return AppendResult.IGNORED_TRANSIENT;
        }
        if (frontier != null && !reversible(frontier, feet)) {
            return AppendResult.REJECTED_DISCONNECTED;
        }
        int existing = breadcrumbs.indexOf(feet);
        if (existing >= 0) {
            breadcrumbs.subList(existing + 1, breadcrumbs.size()).clear();
            trailRevision++;
            return AppendResult.LOOP_TRUNCATED;
        }
        if (breadcrumbs.size() >= MAX_BREADCRUMBS) {
            return AppendResult.REJECTED_SATURATED;
        }
        breadcrumbs.add(feet);
        trailRevision++;
        return AppendResult.APPENDED;
    }

    ConnectorAppendResult appendConnector(
        long expectedSessionRevision,
        Workspace expectedWorkspace,
        VoxelCell expectedFrontier,
        List<VoxelCell> connector
    ) {
        VoxelCell actualFrontier = frontier();
        if (
            workspace == null
                || sessionRevision != expectedSessionRevision
                || !workspace.equals(expectedWorkspace)
                || !java.util.Objects.equals(actualFrontier, expectedFrontier)
        ) {
            return ConnectorAppendResult.STALE_FRONTIER;
        }
        if (
            connector == null
                || connector.size() < 2
                || connector.size() > 8
                || expectedFrontier == null
                || !expectedFrontier.equals(connector.get(0))
        ) {
            return ConnectorAppendResult.INVALID_CONNECTOR;
        }

        for (int index = 1; index < connector.size(); index++) {
            VoxelCell previous = connector.get(index - 1);
            VoxelCell current = connector.get(index);
            if (!reversible(previous, current) || !reversible(current, previous)) {
                return ConnectorAppendResult.INVALID_CONNECTOR;
            }
        }

        List<VoxelCell> suffix = connector.subList(1, connector.size());
        for (int index = 0; index < suffix.size(); index++) {
            VoxelCell cell = suffix.get(index);
            if (breadcrumbs.contains(cell) || suffix.subList(0, index).contains(cell)) {
                return ConnectorAppendResult.TRAIL_INTERSECTION;
            }
        }
        if (breadcrumbs.size() + suffix.size() > MAX_BREADCRUMBS) {
            return ConnectorAppendResult.SATURATED;
        }

        breadcrumbs.addAll(suffix);
        trailRevision++;
        return ConnectorAppendResult.RECONCILED;
    }

    TrailReplaceResult replaceTrail(
        long expectedSessionRevision,
        long expectedTrailRevision,
        Workspace expectedWorkspace,
        List<VoxelCell> expectedTrail,
        List<VoxelCell> replacement
    ) {
        if (workspace == null || !workspace.equals(expectedWorkspace)) {
            return TrailReplaceResult.STALE_WORKSPACE;
        }
        if (sessionRevision != expectedSessionRevision) {
            return TrailReplaceResult.STALE_SESSION;
        }
        if (trailRevision != expectedTrailRevision || !breadcrumbs.equals(expectedTrail)) {
            return TrailReplaceResult.STALE_TRAIL;
        }
        if (replacement == null || replacement.size() < 2) {
            return TrailReplaceResult.INVALID_REPLACEMENT;
        }
        if (replacement.size() > MAX_BREADCRUMBS) {
            return TrailReplaceResult.SATURATED;
        }
        if (
            expectedTrail == null
                || expectedTrail.size() < 2
                || replacement.equals(expectedTrail)
                || replacement.get(0) == null
                || replacement.get(replacement.size() - 1) == null
                || !replacement.get(0).equals(expectedTrail.get(0))
                || !replacement.get(replacement.size() - 1).equals(expectedTrail.get(expectedTrail.size() - 1))
                || workspace.stance() == null
                || !workspace.stance().equals(replacement.get(0))
        ) {
            return TrailReplaceResult.INVALID_REPLACEMENT;
        }

        for (int index = 0; index < replacement.size(); index++) {
            VoxelCell cell = replacement.get(index);
            if (cell == null || replacement.subList(0, index).contains(cell)) {
                return TrailReplaceResult.INVALID_REPLACEMENT;
            }
            if (index > 0) {
                VoxelCell previous = replacement.get(index - 1);
                if (!reversible(previous, cell) || !reversible(cell, previous)) {
                    return TrailReplaceResult.INVALID_REPLACEMENT;
                }
            }
        }

        int commonPrefixLength = commonPrefixLength(expectedTrail, replacement);
        int commonSuffixLength = commonSuffixLength(expectedTrail, replacement, commonPrefixLength);
        for (
            int index = commonPrefixLength;
            index < replacement.size() - commonSuffixLength;
            index++
        ) {
            if (expectedTrail.contains(replacement.get(index))) {
                return TrailReplaceResult.TRAIL_INTERSECTION;
            }
        }

        breadcrumbs.clear();
        breadcrumbs.addAll(replacement);
        trailRevision++;
        return TrailReplaceResult.REPLACED;
    }

    ReanchorResult reanchorAtWorkspaceStance(
        long expectedSessionRevision,
        long expectedTrailRevision,
        Workspace expectedWorkspace,
        VoxelCell feet,
        boolean grounded,
        boolean standable
    ) {
        if (workspace == null || !workspace.equals(expectedWorkspace)) {
            return ReanchorResult.STALE_WORKSPACE;
        }
        if (sessionRevision != expectedSessionRevision) {
            return ReanchorResult.STALE_SESSION;
        }
        if (trailRevision != expectedTrailRevision) {
            return ReanchorResult.STALE_TRAIL;
        }
        if (!grounded || !standable || feet == null || !feet.equals(workspace.stance())) {
            return ReanchorResult.INVALID_STANCE;
        }
        List<VoxelCell> anchored = List.of(workspace.stance());
        if (breadcrumbs.equals(anchored)) {
            return ReanchorResult.ALREADY_ANCHORED;
        }
        breadcrumbs.clear();
        breadcrumbs.add(workspace.stance());
        trailRevision++;
        return ReanchorResult.REANCHORED;
    }

    List<VoxelCell> returnRoute() {
        List<VoxelCell> route = new ArrayList<>(breadcrumbs);
        Collections.reverse(route);
        return List.copyOf(route);
    }

    List<VoxelCell> resumeRoute() {
        return List.copyOf(breadcrumbs);
    }

    int breadcrumbCount() {
        return breadcrumbs.size();
    }

    boolean returnAvailableFrom(VoxelCell feet) {
        if (workspace == null || feet == null || breadcrumbs.isEmpty()) {
            return false;
        }
        VoxelCell frontier = breadcrumbs.get(breadcrumbs.size() - 1);
        return feet.equals(frontier)
            || (breadcrumbs.size() < MAX_BREADCRUMBS && reversible(feet, frontier));
    }

    static boolean reversible(VoxelCell left, VoxelCell right) {
        if (left == null || right == null) {
            return false;
        }
        int horizontal = Math.abs(left.x() - right.x()) + Math.abs(left.z() - right.z());
        int vertical = Math.abs(left.y() - right.y());
        return horizontal == 1 && vertical <= 1;
    }

    private static boolean sameColumn(VoxelCell left, VoxelCell right) {
        return left.x() == right.x() && left.z() == right.z();
    }

    private void clearBreadcrumbs() {
        if (breadcrumbs.isEmpty()) {
            return;
        }
        breadcrumbs.clear();
        trailRevision++;
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
                && left.get(left.size() - 1 - length).equals(right.get(right.size() - 1 - length))
        ) {
            length++;
        }
        return length;
    }

    record Workspace(
        String id,
        VoxelCell stance,
        VoxelCell tableSupport,
        VoxelCell tablePlacement,
        VoxelCell furnaceSupport,
        VoxelCell furnacePlacement
    ) {
    }
}
