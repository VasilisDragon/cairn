package com.mcbot.fabricclient;

import java.util.List;

/**
 * Pure waypoint follower: A* supplies cells, Navigator supplies per-waypoint intent,
 * LookController rate-limits yaw, and BrainLink maps intent to input.
 */
public final class PathFollower {
    private static final double WAYPOINT_BOUNDARY_TOLERANCE = 0.001D;
    private static final double STALLED_BOUNDARY_TOLERANCE = 0.35D;
    private static final double APPROACH_CORRIDOR_TOLERANCE = 0.08D;
    private static final double DISTANCE_IMPROVEMENT_TOLERANCE = 0.002D;
    private static final double POSITION_MOVEMENT_TOLERANCE = 0.01D;
    private static final int BOUNDARY_STALL_TICKS = 8;

    private PathFollower() {
    }

    public record Command(
        BrainLink.Intent intent,
        LookController.Look look,
        InputState input,
        int waypointIndex,
        boolean finished,
        Progress progress
    ) {
    }

    public record Progress(
        int waypointIndex,
        double closestDistance,
        double lastX,
        double lastZ,
        int stagnantTicks
    ) {
        public static Progress initial() {
            return new Progress(-1, Double.POSITIVE_INFINITY, Double.NaN, Double.NaN, 0);
        }
    }

    public static Command follow(
        List<GridCell> waypoints,
        int waypointIndex,
        double curX,
        double curZ,
        double curYaw,
        double arriveEpsilon,
        double maxTurnDegPerTick
    ) {
        return follow(
            waypoints,
            waypointIndex,
            Progress.initial(),
            curX,
            curZ,
            curYaw,
            arriveEpsilon,
            maxTurnDegPerTick
        );
    }

    public static Command follow(
        List<GridCell> waypoints,
        int waypointIndex,
        Progress progress,
        double curX,
        double curZ,
        double curYaw,
        double arriveEpsilon,
        double maxTurnDegPerTick
    ) {
        if (waypoints == null || waypoints.isEmpty()) {
            BrainLink.Intent stop = BrainLink.Intent.stop("no_path");
            return new Command(stop, new LookController.Look(curYaw, 0.0D), InputState.stop(), 0, true, Progress.initial());
        }

        int index = Math.max(0, waypointIndex);
        double epsilon = Math.max(0.0D, arriveEpsilon);
        while (index < waypoints.size() && shouldAdvanceWaypointImmediate(waypoints, index, curX, curZ, epsilon)) {
            index++;
            progress = Progress.initial();
        }
        if (index < waypoints.size()) {
            Progress updated = updateProgress(progress, index, curX, curZ, distanceToCellCenter(curX, curZ, waypoints.get(index)));
            if (shouldAdvanceStalledBoundary(waypoints, index, curX, curZ, epsilon, updated)) {
                index++;
                progress = Progress.initial();
                while (index < waypoints.size() && shouldAdvanceWaypointImmediate(waypoints, index, curX, curZ, epsilon)) {
                    index++;
                }
            } else {
                progress = updated;
            }
        }
        if (index >= waypoints.size()) {
            BrainLink.Intent stop = BrainLink.Intent.stop("path_complete");
            return new Command(stop, new LookController.Look(curYaw, 0.0D), InputState.stop(), waypoints.size(), true, Progress.initial());
        }

        GridCell target = waypoints.get(index);
        double targetX = center(target.x());
        double targetZ = center(target.z());
        BrainLink.Intent intent = Navigator.toward(curX, curZ, curYaw, targetX, targetZ, epsilon);
        double desiredYaw = intent.targetYaw() != null ? intent.targetYaw() : curYaw;
        LookController.Look look = LookController.nextLook(curYaw, 0.0D, desiredYaw, 0.0D, maxTurnDegPerTick);
        InputState input = BrainLink.inputStateFor(intent);
        return new Command(intent, look, input, index, false, progress);
    }

    public static double center(int cellCoordinate) {
        return cellCoordinate + 0.5D;
    }

    private static double distanceToCellCenter(double x, double z, GridCell cell) {
        return Math.hypot(center(cell.x()) - x, center(cell.z()) - z);
    }

    private static boolean shouldAdvanceWaypointImmediate(List<GridCell> waypoints, int index, double x, double z, double epsilon) {
        GridCell waypoint = waypoints.get(index);
        double distance = distanceToCellCenter(x, z, waypoint);
        if (distance <= epsilon) {
            return true;
        }
        if (index <= 0) {
            return false;
        }

        GridCell previous = waypoints.get(index - 1);
        double previousX = center(previous.x());
        double previousZ = center(previous.z());
        double waypointX = center(waypoint.x());
        double waypointZ = center(waypoint.z());
        double segmentX = waypointX - previousX;
        double segmentZ = waypointZ - previousZ;
        double segmentLengthSquared = segmentX * segmentX + segmentZ * segmentZ;
        if (segmentLengthSquared <= 0.0D) {
            return false;
        }

        double currentX = x - previousX;
        double currentZ = z - previousZ;
        double projection = (currentX * segmentX + currentZ * segmentZ) / segmentLengthSquared;
        double crossTrack = Math.abs(currentX * segmentZ - currentZ * segmentX) / Math.sqrt(segmentLengthSquared);
        if (!isFinalWaypoint(waypoints, index) && projection >= 1.0D && crossTrack <= epsilon) {
            return true;
        }

        return false;
    }

    private static boolean shouldAdvanceStalledBoundary(
        List<GridCell> waypoints,
        int index,
        double x,
        double z,
        double epsilon,
        Progress progress
    ) {
        if (isFinalWaypoint(waypoints, index) || progress.stagnantTicks() < BOUNDARY_STALL_TICKS || index <= 0) {
            return false;
        }
        GridCell waypoint = waypoints.get(index);
        double distance = distanceToCellCenter(x, z, waypoint);
        if (distance > epsilon + Math.max(WAYPOINT_BOUNDARY_TOLERANCE, STALLED_BOUNDARY_TOLERANCE)) {
            return false;
        }

        GridCell previous = waypoints.get(index - 1);
        double previousX = center(previous.x());
        double previousZ = center(previous.z());
        double waypointX = center(waypoint.x());
        double waypointZ = center(waypoint.z());
        double segmentX = waypointX - previousX;
        double segmentZ = waypointZ - previousZ;
        double segmentLengthSquared = segmentX * segmentX + segmentZ * segmentZ;
        if (segmentLengthSquared <= 0.0D) {
            return false;
        }

        double currentX = x - previousX;
        double currentZ = z - previousZ;
        double projection = (currentX * segmentX + currentZ * segmentZ) / segmentLengthSquared;
        double crossTrack = Math.abs(currentX * segmentZ - currentZ * segmentX) / Math.sqrt(segmentLengthSquared);
        return projection >= 0.0D
            && projection <= 1.0D
            && crossTrack <= APPROACH_CORRIDOR_TOLERANCE;
    }

    private static Progress updateProgress(Progress progress, int index, double x, double z, double distance) {
        if (progress == null || progress.waypointIndex() != index) {
            return new Progress(index, distance, x, z, 0);
        }
        double closest = progress.closestDistance();
        double positionDelta = positionDelta(progress, x, z);
        if (distance < closest - DISTANCE_IMPROVEMENT_TOLERANCE || positionDelta > POSITION_MOVEMENT_TOLERANCE) {
            return new Progress(index, Math.min(distance, closest), x, z, 0);
        }
        return new Progress(index, closest, x, z, progress.stagnantTicks() + 1);
    }

    private static double positionDelta(Progress progress, double x, double z) {
        if (Double.isNaN(progress.lastX()) || Double.isNaN(progress.lastZ())) {
            return Double.POSITIVE_INFINITY;
        }
        return Math.hypot(x - progress.lastX(), z - progress.lastZ());
    }

    private static boolean isFinalWaypoint(List<GridCell> waypoints, int index) {
        return index >= waypoints.size() - 1;
    }
}
