package com.mcbot.fabricclient;

import java.util.Objects;

final class TravelGazePolicy {
    static final double STABLE_TRAVEL_PITCH_DEG = 8.0D;
    private static final double SAME_HORIZONTAL_POSITION_EPSILON = 0.000_001D;

    private TravelGazePolicy() {
    }

    static LookDemand demand(
        String commandId,
        long routeGeneration,
        int waypointIndex,
        String targetIdentity,
        String reason,
        double playerX,
        double playerZ,
        double currentYaw,
        VoxelCell playerFeet,
        VoxelCell waypoint,
        boolean committedDescent,
        double exactPitch
    ) {
        Objects.requireNonNull(playerFeet, "playerFeet");
        Objects.requireNonNull(waypoint, "waypoint");
        if (routeGeneration < 0L) {
            throw new IllegalArgumentException("routeGeneration must be non-negative");
        }
        if (waypointIndex < 0) {
            throw new IllegalArgumentException("waypointIndex must be non-negative");
        }
        if (targetIdentity == null || targetIdentity.isBlank()) {
            throw new IllegalArgumentException("targetIdentity must not be blank");
        }
        if (!Double.isFinite(playerX)
            || !Double.isFinite(playerZ)
            || !Double.isFinite(currentYaw)
            || !Double.isFinite(exactPitch)) {
            throw new IllegalArgumentException("travel gaze angles and positions must be finite");
        }
        boolean lowerWaypoint = waypoint.y() < playerFeet.y();
        if (committedDescent != lowerWaypoint) {
            throw new IllegalArgumentException(
                committedDescent
                    ? "committed descent requires a lower waypoint"
                    : "lower waypoint requires committed descent"
            );
        }

        double dx = waypoint.x() + 0.5D - playerX;
        double dz = waypoint.z() + 0.5D - playerZ;
        double desiredYaw = Math.hypot(dx, dz) <= SAME_HORIZONTAL_POSITION_EPSILON
            ? currentYaw
            : Navigator.yawToward(dx, dz);
        double desiredPitch = committedDescent ? exactPitch : STABLE_TRAVEL_PITCH_DEG;
        String stableTargetIdentity = "travel:"
            + commandId
            + ":route="
            + routeGeneration
            + ":waypoint="
            + waypointIndex
            + ":target="
            + targetIdentity;

        return new LookDemand(
            LookDemand.Owner.NORMAL,
            stableTargetIdentity,
            LookDemand.Profile.TRAVEL,
            desiredYaw,
            desiredPitch,
            LookDemand.RetargetPolicy.CONTINUOUS,
            commandId,
            reason
        );
    }
}
