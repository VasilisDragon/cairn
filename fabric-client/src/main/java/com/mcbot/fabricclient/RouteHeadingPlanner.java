package com.mcbot.fabricclient;

import java.util.List;

final class RouteHeadingPlanner {
    private static final double MAX_CORNER_ROUNDING_OFFSET = 0.9D;

    enum Kind {
        ACTIVE,
        STRAIGHT_LOOKAHEAD,
        WIDE_CORNER
    }

    record Plan(
        double desiredYaw,
        Kind kind,
        int aimIndex,
        VoxelCell aimCell,
        boolean preserveForward,
        boolean sprintEligible,
        String suppressionReason
    ) {
    }

    private RouteHeadingPlanner() {
    }

    static Plan plan(
        GatherWoodLocalEgressPerception perception,
        List<VoxelCell> route,
        int activeIndex,
        double playerX,
        double playerZ,
        double arrivalEpsilon
    ) {
        if (perception == null || route == null || route.isEmpty()) {
            return new Plan(0.0D, Kind.ACTIVE, -1, null, false, false, "invalid_request");
        }
        if (activeIndex < 0 || activeIndex >= route.size()) {
            return new Plan(0.0D, Kind.ACTIVE, -1, null, false, false, "invalid_active_index");
        }

        VoxelCell active = route.get(activeIndex);
        if (!safeCell(perception, active)) {
            return fallback(active, activeIndex, playerX, playerZ, "active_unsafe");
        }
        if (activeIndex == route.size() - 1) {
            return fallback(active, activeIndex, playerX, playerZ, "route_end");
        }

        Direction incoming = null;
        if (activeIndex > 0) {
            VoxelCell previous = route.get(activeIndex - 1);
            String transitionFailure = transitionFailure(perception, previous, active);
            if (!transitionFailure.isEmpty()) {
                return fallback(active, activeIndex, playerX, playerZ, transitionFailure);
            }
            incoming = Direction.between(previous, active);
        }

        VoxelCell first = route.get(activeIndex + 1);
        String firstFailure = transitionFailure(perception, active, first);
        if (!firstFailure.isEmpty()) {
            return fallback(active, activeIndex, playerX, playerZ, firstFailure);
        }
        Direction firstDirection = Direction.between(active, first);
        Kind kind = Kind.STRAIGHT_LOOKAHEAD;
        VoxelCell roundingCorner = null;
        Direction roundingExit = null;
        if (incoming != null) {
            if (incoming.reverses(firstDirection)) {
                return fallback(active, activeIndex, playerX, playerZ, "route_reversal");
            }
            if (incoming.turns(firstDirection)) {
                if (!wideCorner(perception, route.get(activeIndex - 1), active, first)) {
                    return fallback(active, activeIndex, playerX, playerZ, "corner_envelope_unsafe");
                }
                kind = Kind.WIDE_CORNER;
                roundingCorner = active;
                roundingExit = firstDirection;
            }
        }

        int aimIndex = activeIndex + 1;
        VoxelCell aim = first;
        boolean blockedAhead = false;
        int secondIndex = activeIndex + 2;
        if (kind != Kind.WIDE_CORNER && secondIndex < route.size()) {
            VoxelCell second = route.get(secondIndex);
            String secondFailure = transitionFailure(perception, first, second);
            if (secondFailure.isEmpty()) {
                Direction secondDirection = Direction.between(first, second);
                if (firstDirection.reverses(secondDirection)) {
                    blockedAhead = true;
                } else if (firstDirection.turns(secondDirection)) {
                    if (kind == Kind.WIDE_CORNER || !wideCorner(perception, active, first, second)) {
                        blockedAhead = true;
                    } else {
                        aimIndex = secondIndex;
                        aim = second;
                        kind = Kind.WIDE_CORNER;
                        roundingCorner = first;
                        roundingExit = secondDirection;
                    }
                } else {
                    aimIndex = secondIndex;
                    aim = second;
                }
            } else {
                blockedAhead = true;
            }
        }

        boolean sprintEligible = !blockedAhead && aimIndex < route.size() - 1;
        double roundingOffset = Math.min(
            MAX_CORNER_ROUNDING_OFFSET,
            Math.max(0.0D, arrivalEpsilon * 0.9D)
        );
        double desiredYaw = roundingCorner == null || roundingExit == null
            ? yawToward(playerX, playerZ, aim)
            : yawToward(
                playerX,
                playerZ,
                roundingCorner.x() + 0.5D + roundingExit.dx * roundingOffset,
                roundingCorner.z() + 0.5D + roundingExit.dz * roundingOffset
            );
        return new Plan(
            desiredYaw,
            kind,
            aimIndex,
            aim,
            true,
            sprintEligible,
            ""
        );
    }

    private static Plan fallback(
        VoxelCell active,
        int activeIndex,
        double playerX,
        double playerZ,
        String reason
    ) {
        return new Plan(
            yawToward(playerX, playerZ, active),
            Kind.ACTIVE,
            activeIndex,
            active,
            false,
            false,
            reason
        );
    }

    private static double yawToward(double playerX, double playerZ, VoxelCell cell) {
        if (cell == null) {
            return 0.0D;
        }
        return yawToward(playerX, playerZ, cell.x() + 0.5D, cell.z() + 0.5D);
    }

    private static double yawToward(
        double playerX,
        double playerZ,
        double targetX,
        double targetZ
    ) {
        return Navigator.yawToward(targetX - playerX, targetZ - playerZ);
    }

    private static String transitionFailure(
        GatherWoodLocalEgressPerception perception,
        VoxelCell from,
        VoxelCell to
    ) {
        if (from == null || to == null) {
            return "route_gap";
        }
        if (from.y() != to.y()) {
            return "vertical_transition";
        }
        Direction direction = Direction.between(from, to);
        if (direction == null) {
            return "route_gap";
        }
        if (!safeCell(perception, from) || !safeCell(perception, to)) {
            return "unsafe_lookahead";
        }
        VoxelAStar.Move forward = VoxelAStar.resolveTraversalMove(
            perception,
            from,
            new VoxelCell(direction.dx, 0, direction.dz)
        );
        VoxelAStar.Move reverse = VoxelAStar.resolveTraversalMove(
            perception,
            to,
            new VoxelCell(-direction.dx, 0, -direction.dz)
        );
        if (!to.equals(forward.destination()) || !from.equals(reverse.destination())) {
            return "non_reversible";
        }
        return "";
    }

    private static boolean wideCorner(
        GatherWoodLocalEgressPerception perception,
        VoxelCell before,
        VoxelCell corner,
        VoxelCell after
    ) {
        Direction into = Direction.between(before, corner);
        Direction out = Direction.between(corner, after);
        if (into == null || out == null || !into.turns(out)
            || before.y() != corner.y() || corner.y() != after.y()) {
            return false;
        }
        VoxelCell fourth = new VoxelCell(
            before.x() + out.dx,
            before.y(),
            before.z() + out.dz
        );
        return safeCell(perception, before)
            && safeCell(perception, corner)
            && safeCell(perception, after)
            && safeCell(perception, fourth)
            && transitionFailure(perception, before, corner).isEmpty()
            && transitionFailure(perception, corner, after).isEmpty()
            && transitionFailure(perception, before, fourth).isEmpty()
            && transitionFailure(perception, fourth, after).isEmpty();
    }

    private static boolean safeCell(GatherWoodLocalEgressPerception perception, VoxelCell cell) {
        if (perception == null || cell == null
            || !perception.isStandable(cell.x(), cell.y(), cell.z())) {
            return false;
        }
        for (int y = cell.y() - 1; y <= cell.y() + 1; y++) {
            if (!perception.inBounds(cell.x(), y, cell.z())
                || perception.isHazard(cell.x(), y, cell.z())
                || perception.isWater(cell.x(), y, cell.z())
                || perception.isLava(cell.x(), y, cell.z())) {
                return false;
            }
        }
        for (Direction direction : Direction.values()) {
            int x = cell.x() + direction.dx;
            int z = cell.z() + direction.dz;
            for (int y = cell.y() - 1; y <= cell.y() + 1; y++) {
                if (perception.inBounds(x, y, z) && perception.isLava(x, y, z)) {
                    return false;
                }
            }
        }
        return true;
    }

    private enum Direction {
        NORTH(0, -1),
        EAST(1, 0),
        SOUTH(0, 1),
        WEST(-1, 0);

        private final int dx;
        private final int dz;

        Direction(int dx, int dz) {
            this.dx = dx;
            this.dz = dz;
        }

        static Direction between(VoxelCell from, VoxelCell to) {
            if (from == null || to == null || from.y() != to.y()) {
                return null;
            }
            int dx = to.x() - from.x();
            int dz = to.z() - from.z();
            for (Direction direction : values()) {
                if (direction.dx == dx && direction.dz == dz) {
                    return direction;
                }
            }
            return null;
        }

        boolean reverses(Direction other) {
            return other != null && dx == -other.dx && dz == -other.dz;
        }

        boolean turns(Direction other) {
            return other != null && dx * other.dx + dz * other.dz == 0;
        }
    }
}
