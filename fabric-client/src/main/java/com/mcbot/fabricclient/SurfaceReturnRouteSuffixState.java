package com.mcbot.fabricclient;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

final class SurfaceReturnRouteSuffixState {
    static final int MAX_REJECTED_SIGNATURES = 64;

    enum Admission {
        AVAILABLE,
        KNOWN_BROKEN,
        SATURATED,
        INVALID
    }

    record Signature(
        long sessionRevision,
        long trailRevision,
        VoxelCell source,
        VoxelCell invalidWaypoint
    ) {
    }

    private final Set<Signature> rejected = new LinkedHashSet<>();
    private long sessionRevision = Long.MIN_VALUE;
    private long trailRevision = Long.MIN_VALUE;
    private boolean saturated;

    Admission admission(
        long nextSessionRevision,
        long nextTrailRevision,
        List<VoxelCell> route
    ) {
        synchronize(nextSessionRevision, nextTrailRevision);
        if (route == null || route.size() < 2) {
            return Admission.INVALID;
        }
        if (saturated) {
            return Admission.SATURATED;
        }
        for (int index = 1; index < route.size(); index++) {
            if (rejected.contains(signature(route, index))) {
                return Admission.KNOWN_BROKEN;
            }
        }
        return Admission.AVAILABLE;
    }

    Signature signature(List<VoxelCell> route, int invalidWaypointIndex) {
        if (
            route == null
                || invalidWaypointIndex <= 0
                || invalidWaypointIndex >= route.size()
        ) {
            return null;
        }
        return signature(route.get(invalidWaypointIndex - 1), route.get(invalidWaypointIndex));
    }

    Signature signature(VoxelCell source, VoxelCell invalidWaypoint) {
        if (source == null || invalidWaypoint == null) {
            return null;
        }
        return new Signature(sessionRevision, trailRevision, source, invalidWaypoint);
    }

    boolean reject(Signature signature) {
        if (
            signature == null
                || signature.sessionRevision() != sessionRevision
                || signature.trailRevision() != trailRevision
        ) {
            return false;
        }
        if (rejected.contains(signature)) {
            return true;
        }
        if (rejected.size() >= MAX_REJECTED_SIGNATURES) {
            saturated = true;
            return false;
        }
        rejected.add(signature);
        return true;
    }

    boolean contains(Signature signature) {
        return signature != null && rejected.contains(signature);
    }

    int retainedSignatureCount() {
        return rejected.size();
    }

    boolean saturated() {
        return saturated;
    }

    long sessionRevision() {
        return sessionRevision;
    }

    long trailRevision() {
        return trailRevision;
    }

    private void synchronize(long nextSessionRevision, long nextTrailRevision) {
        if (
            sessionRevision == nextSessionRevision
                && trailRevision == nextTrailRevision
        ) {
            return;
        }
        sessionRevision = nextSessionRevision;
        trailRevision = nextTrailRevision;
        rejected.clear();
        saturated = false;
    }
}
