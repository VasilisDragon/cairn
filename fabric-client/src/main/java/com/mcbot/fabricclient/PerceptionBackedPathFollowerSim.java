package com.mcbot.fabricclient;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Offline follower simulation backed by the same {@link GridPerception} answers that A* sees.
 *
 * <p>This intentionally stays Minecraft-independent, but it is stricter than {@link KinematicSim}: it
 * respects recorded surface heights, edge traversal answers, and the player-width collision boundary in
 * front of one-block step-ups. That makes recorded "route exists, follower stalls" fixtures visible
 * offline instead of being papered over by an ideal point-mass model.
 */
public final class PerceptionBackedPathFollowerSim {
    public static final double DEFAULT_SPEED_PER_TICK = 0.2D;
    public static final double DEFAULT_PLAYER_RADIUS = 0.3D;
    public static final int DEFAULT_MAX_TICKS = 800;

    private static final int NO_GOAL_PROGRESS_STALL_TICKS = 48;

    private PerceptionBackedPathFollowerSim() {
    }

    public enum Outcome {
        ARRIVED,
        STALLED,
        NO_ROUTE
    }

    public record Config(
        double speedPerTick,
        double playerRadius,
        int maxTicks,
        boolean resetFollowerStateEachTick
    ) {
        public static Config defaults() {
            return new Config(DEFAULT_SPEED_PER_TICK, DEFAULT_PLAYER_RADIUS, DEFAULT_MAX_TICKS, false);
        }

        public static Config recordedReplanLoop() {
            return new Config(DEFAULT_SPEED_PER_TICK, DEFAULT_PLAYER_RADIUS, DEFAULT_MAX_TICKS, true);
        }

        public Config {
            speedPerTick = speedPerTick <= 0.0D ? DEFAULT_SPEED_PER_TICK : speedPerTick;
            playerRadius = playerRadius <= 0.0D ? DEFAULT_PLAYER_RADIUS : playerRadius;
            maxTicks = Math.max(1, maxTicks);
        }
    }

    public record Result(
        Outcome outcome,
        int ticks,
        int waypointIndex,
        double x,
        double z,
        double yaw,
        double finalDistance,
        int pathLength,
        String reason
    ) {
        public boolean arrived() {
            return outcome == Outcome.ARRIVED;
        }
    }

    public static Result followRoute(
        GridPerception perception,
        List<GridCell> waypoints,
        double startX,
        double startZ,
        double startYaw,
        double arriveEpsilon,
        double maxTurnDegPerTick,
        Config config
    ) {
        return followRoute(
            perception,
            waypoints,
            startX,
            startZ,
            startYaw,
            0,
            PathFollower.Progress.initial(),
            arriveEpsilon,
            maxTurnDegPerTick,
            config
        );
    }

    public static Result followRoute(
        GridPerception perception,
        List<GridCell> waypoints,
        double startX,
        double startZ,
        double startYaw,
        int startWaypointIndex,
        PathFollower.Progress startProgress,
        double arriveEpsilon,
        double maxTurnDegPerTick,
        Config config
    ) {
        if (perception == null || waypoints == null || waypoints.isEmpty()) {
            return new Result(
                Outcome.NO_ROUTE,
                0,
                0,
                startX,
                startZ,
                LookController.normalizeYaw(startYaw),
                Double.NaN,
                0,
                "no_route"
            );
        }

        Config safeConfig = config == null ? Config.defaults() : config;
        State state = new State(startX, startZ, LookController.normalizeYaw(startYaw));
        int waypointIndex = Math.max(0, startWaypointIndex);
        PathFollower.Progress progress = startProgress == null ? PathFollower.Progress.initial() : startProgress;
        Set<Integer> jumpWaypoints = jumpWaypointIndexes(waypoints, perception);
        int noGoalProgressTicks = 0;
        String lastStepReason = "";

        for (int tick = 0; tick < safeConfig.maxTicks(); tick++) {
            int inIndex = safeConfig.resetFollowerStateEachTick() ? Math.max(0, startWaypointIndex) : waypointIndex;
            PathFollower.Progress inProgress = safeConfig.resetFollowerStateEachTick()
                ? (startProgress == null ? PathFollower.Progress.initial() : startProgress)
                : progress;
            PathFollower.Command command = PathFollower.follow(
                waypoints,
                inIndex,
                inProgress,
                state.x,
                state.z,
                state.yaw,
                arriveEpsilon,
                maxTurnDegPerTick
            );
            waypointIndex = command.waypointIndex();
            progress = command.progress();
            if (command.finished()) {
                return new Result(
                    Outcome.ARRIVED,
                    tick,
                    waypointIndex,
                    state.x,
                    state.z,
                    state.yaw,
                    distanceToCellCenter(state.x, state.z, waypoints.get(waypoints.size() - 1)),
                    waypoints.size(),
                    "arrived"
                );
            }

            boolean stepAssistJump = shouldJumpForStepUp(command.waypointIndex(), state.x, state.z, waypoints, jumpWaypoints);
            InputState input = withJump(command.input(), stepAssistJump);
            StepResult stepped = step(perception, waypoints, command.waypointIndex(), command.progress(), state, input, command.look(), safeConfig);
            lastStepReason = stepped.reason();

            if (!stepped.moved()) {
                noGoalProgressTicks++;
            } else {
                noGoalProgressTicks = 0;
            }
            if (noGoalProgressTicks >= NO_GOAL_PROGRESS_STALL_TICKS) {
                double goalDistance = distanceToCellCenter(state.x, state.z, waypoints.get(waypoints.size() - 1));
                return new Result(
                    Outcome.STALLED,
                    tick + 1,
                    waypointIndex,
                    state.x,
                    state.z,
                    state.yaw,
                    goalDistance,
                    waypoints.size(),
                    "stalled:" + (lastStepReason.isBlank() ? "no_goal_progress" : lastStepReason)
                );
            }
        }

        return new Result(
            Outcome.STALLED,
            safeConfig.maxTicks(),
            waypointIndex,
            state.x,
            state.z,
            state.yaw,
            distanceToCellCenter(state.x, state.z, waypoints.get(waypoints.size() - 1)),
            waypoints.size(),
            "stalled:" + (lastStepReason.isBlank() ? "max_ticks" : lastStepReason)
        );
    }

    public static Result routeAndFollow(
        GridPerception perception,
        GridCell start,
        GridCell goal,
        double startYaw,
        double arriveEpsilon,
        double maxTurnDegPerTick,
        Config config
    ) {
        if (perception == null || start == null || goal == null) {
            return new Result(Outcome.NO_ROUTE, 0, 0, 0.0D, 0.0D, startYaw, Double.NaN, 0, "invalid_request");
        }
        GridRouteDiagnostic diagnostic = GridAStar.diagnose(perception, start, goal);
        if (!diagnostic.routeFound()) {
            return new Result(
                Outcome.NO_ROUTE,
                0,
                0,
                PathFollower.center(start.x()),
                PathFollower.center(start.z()),
                startYaw,
                Double.NaN,
                0,
                diagnostic.failureReason().isBlank() ? "no_route" : diagnostic.failureReason()
            );
        }
        return followRoute(
            perception,
            diagnostic.route(),
            PathFollower.center(start.x()),
            PathFollower.center(start.z()),
            startYaw,
            arriveEpsilon,
            maxTurnDegPerTick,
            config
        );
    }

    static Set<Integer> jumpWaypointIndexes(List<GridCell> waypoints, GridPerception perception) {
        if (waypoints == null || waypoints.size() < 2 || perception == null) {
            return Set.of();
        }
        Map<GridCell, Integer> surfaces = new HashMap<>();
        for (GridCell waypoint : waypoints) {
            var surface = perception.surfaceY(waypoint.x(), waypoint.z());
            if (surface.isPresent()) {
                surfaces.put(waypoint, surface.getAsInt());
            }
        }
        java.util.Set<Integer> indexes = new java.util.HashSet<>();
        for (int i = 1; i < waypoints.size(); i++) {
            Integer previous = surfaces.get(waypoints.get(i - 1));
            Integer next = surfaces.get(waypoints.get(i));
            if (previous != null && next != null && next - previous == 1) {
                indexes.add(i);
            }
        }
        return Set.copyOf(indexes);
    }

    private static StepResult step(
        GridPerception perception,
        List<GridCell> waypoints,
        int waypointIndex,
        PathFollower.Progress progress,
        State state,
        InputState input,
        LookController.Look look,
        Config config
    ) {
        state.yaw = LookController.normalizeYaw(look.yaw());
        if (input == null || (!input.pressingForward() && !input.pressingBack() && !input.pressingLeft() && !input.pressingRight())) {
            return new StepResult(false, "turning");
        }

        double yawRad = Math.toRadians(state.yaw);
        double forwardX = -Math.sin(yawRad);
        double forwardZ = Math.cos(yawRad);
        double strafeX = Math.cos(yawRad);
        double strafeZ = Math.sin(yawRad);
        double nextX = state.x + forwardX * input.movementForward() * config.speedPerTick()
            + strafeX * input.movementSideways() * config.speedPerTick();
        double nextZ = state.z + forwardZ * input.movementForward() * config.speedPerTick()
            + strafeZ * input.movementSideways() * config.speedPerTick();

        GridCell currentCell = cell(state.x, state.z);
        GridCell nextCell = cell(nextX, nextZ);
        GridCell target = waypointIndex >= 0 && waypointIndex < waypoints.size() ? waypoints.get(waypointIndex) : null;
        StepCap cap = stepUpCollisionCap(perception, currentCell, target, state.x, state.z, nextX, nextZ, config.playerRadius());
        if (cap.capped()) {
            if (!stepUpReady(progress)) {
                state.x = cap.x();
                state.z = cap.z();
                return new StepResult(cap.moved(), "step_up_collision_boundary");
            }
            StepCap cleared = stepUpClearedPosition(currentCell, target, state.x, state.z, config.playerRadius());
            state.x = cleared.x();
            state.z = cleared.z();
            return new StepResult(true, "step_up_cleared");
        }
        if (currentCell.equals(nextCell) || perception.canTraverse(currentCell, nextCell)) {
            boolean moved = Math.hypot(nextX - state.x, nextZ - state.z) > 0.000_001D;
            state.x = nextX;
            state.z = nextZ;
            return new StepResult(moved, "moved");
        }
        return new StepResult(false, "transition_blocked:" + perception.traversalIssue(currentCell, nextCell).name().toLowerCase());
    }

    private static boolean stepUpReady(PathFollower.Progress progress) {
        return progress != null && progress.stagnantTicks() >= 8;
    }

    private static StepCap stepUpClearedPosition(GridCell current, GridCell target, double x, double z, double playerRadius) {
        int dx = Integer.compare(target.x(), current.x());
        int dz = Integer.compare(target.z(), current.z());
        if (dx > 0) {
            return new StepCap(true, current.x() + 1.0D + playerRadius, z, true);
        }
        if (dx < 0) {
            return new StepCap(true, current.x() - playerRadius, z, true);
        }
        if (dz > 0) {
            return new StepCap(true, x, current.z() + 1.0D + playerRadius, true);
        }
        if (dz < 0) {
            return new StepCap(true, x, current.z() - playerRadius, true);
        }
        return new StepCap(true, x, z, false);
    }

    private static StepCap stepUpCollisionCap(
        GridPerception perception,
        GridCell current,
        GridCell target,
        double x,
        double z,
        double nextX,
        double nextZ,
        double playerRadius
    ) {
        if (perception == null || current == null || target == null || current.equals(target)) {
            return new StepCap(false, nextX, nextZ, false);
        }
        int dx = Integer.compare(target.x(), current.x());
        int dz = Integer.compare(target.z(), current.z());
        if (Math.abs(target.x() - current.x()) + Math.abs(target.z() - current.z()) != 1) {
            return new StepCap(false, nextX, nextZ, false);
        }
        var fromSurface = perception.surfaceY(current.x(), current.z());
        var toSurface = perception.surfaceY(target.x(), target.z());
        if (fromSurface.isEmpty() || toSurface.isEmpty() || toSurface.getAsInt() <= fromSurface.getAsInt()) {
            return new StepCap(false, nextX, nextZ, false);
        }

        double cappedX = nextX;
        double cappedZ = nextZ;
        boolean capped = false;
        if (dx > 0) {
            double boundary = current.x() + 1.0D - playerRadius;
            if (nextX > boundary) {
                cappedX = boundary;
                capped = true;
            }
        } else if (dx < 0) {
            double boundary = current.x() + playerRadius;
            if (nextX < boundary) {
                cappedX = boundary;
                capped = true;
            }
        } else if (dz > 0) {
            double boundary = current.z() + 1.0D - playerRadius;
            if (nextZ > boundary) {
                cappedZ = boundary;
                capped = true;
            }
        } else if (dz < 0) {
            double boundary = current.z() + playerRadius;
            if (nextZ < boundary) {
                cappedZ = boundary;
                capped = true;
            }
        }
        boolean moved = Math.hypot(cappedX - x, cappedZ - z) > 0.000_001D;
        return new StepCap(capped, cappedX, cappedZ, moved);
    }

    private static boolean shouldJumpForStepUp(
        int waypointIndex,
        double x,
        double z,
        List<GridCell> waypoints,
        Set<Integer> jumpWaypoints
    ) {
        if (waypointIndex <= 0 || waypointIndex >= waypoints.size() || !jumpWaypoints.contains(waypointIndex)) {
            return false;
        }
        GridCell target = waypoints.get(waypointIndex);
        double distance = distanceToCellCenter(x, z, target);
        return distance <= 1.35D;
    }

    private static InputState withJump(InputState input, boolean jump) {
        if (!jump || input == null || !input.pressingForward()) {
            return input;
        }
        return new InputState(
            input.pressingForward(),
            input.pressingBack(),
            input.pressingLeft(),
            input.pressingRight(),
            true,
            input.sneaking(),
            input.movementForward(),
            input.movementSideways()
        );
    }

    private static double distanceToCellCenter(double x, double z, GridCell cell) {
        return Math.hypot(PathFollower.center(cell.x()) - x, PathFollower.center(cell.z()) - z);
    }

    private static GridCell cell(double x, double z) {
        return new GridCell((int) Math.floor(x), (int) Math.floor(z));
    }

    private static final class State {
        double x;
        double z;
        double yaw;

        State(double x, double z, double yaw) {
            this.x = x;
            this.z = z;
            this.yaw = yaw;
        }
    }

    private record StepResult(boolean moved, String reason) {
    }

    private record StepCap(boolean capped, double x, double z, boolean moved) {
    }
}
