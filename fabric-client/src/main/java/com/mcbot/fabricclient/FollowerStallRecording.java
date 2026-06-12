package com.mcbot.fabricclient;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * A captured path-FOLLOWING stall, for offline debugging of "route found but bot doesn't progress"
 * (Phase 1.5 of the pathing-hardening plan). Phase 1's {@link NavReplayRecording} reproduces path-
 * FINDING (A*) failures; this reproduces the follower decision at a stall and carries the surrounding
 * context to explain WHY the move doesn't advance.
 *
 * <p>Captures three things:
 * <ul>
 *   <li>the FAITHFUL stall frame: the exact inputs to {@link PathFollower#follow} (waypoints, waypoint
 *       index, {@link PathFollower.Progress}, pose) and the decision it produced, so replaying it
 *       offline reproduces the follower's command (follow() is a pure function);</li>
 *   <li>a lightweight recent-pose trail (the "trace" view) showing the bot oscillating / not advancing
 *       while {@code stagnantTicks} climbs;</li>
 *   <li>a small local {@link NavReplayRecording} perception around the bot + current target waypoint, so
 *       the WORLD geometry that blocks the move (e.g. a step-up the follower can't clear) is visible.</li>
 * </ul>
 *
 * <p>GSON-serializable; Progress doubles that are non-finite ({@code +Inf}/{@code NaN} in an initial
 * Progress) are stored as null and rehydrated, so the JSON stays standard.
 */
final class FollowerStallRecording {
    String commandId = "";
    String reason = "follower_stall";
    // Inputs to PathFollower.follow at the stall frame.
    List<String> waypoints = new ArrayList<>(); // "x,z" per cell
    double arriveEpsilon;
    double maxTurnDegPerTick;
    int inWaypointIndex;
    // The Progress going into the stall frame (non-finite fields stored as null).
    Integer progressWaypointIndex;
    Double progressClosestDistance;
    Double progressLastX;
    Double progressLastZ;
    int progressStagnantTicks;
    double x;
    double z;
    double yaw;
    int feetY;
    // The decision the live follower produced at the stall frame (asserted on replay).
    int outWaypointIndex;
    boolean outFinished;
    String outReason = "";
    boolean stepAssistJump;
    // Diagnostic recent-pose trail (most-recent last).
    List<PoseSample> trail = new ArrayList<>();
    // Local world around the bot + current target waypoint (why the move is blocked).
    NavReplayRecording perception;

    /** A lightweight per-tick sample of the follower's progress (diagnostic only, not replayed). */
    static final class PoseSample {
        double x;
        double z;
        int feetY;
        double yaw;
        int waypointIndex;
        int stagnantTicks;
        boolean jump;

        PoseSample() {
        }

        PoseSample(double x, double z, int feetY, double yaw, int waypointIndex, int stagnantTicks, boolean jump) {
            this.x = x;
            this.z = z;
            this.feetY = feetY;
            this.yaw = yaw;
            this.waypointIndex = waypointIndex;
            this.stagnantTicks = stagnantTicks;
            this.jump = jump;
        }
    }

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    static String cellKey(GridCell cell) {
        return cell.x() + "," + cell.z();
    }

    List<GridCell> waypointCells() {
        List<GridCell> cells = new ArrayList<>(waypoints.size());
        for (String key : waypoints) {
            int comma = key.indexOf(',');
            cells.add(new GridCell(
                Integer.parseInt(key.substring(0, comma).trim()),
                Integer.parseInt(key.substring(comma + 1).trim())));
        }
        return cells;
    }

    PathFollower.Progress progress() {
        return new PathFollower.Progress(
            progressWaypointIndex == null ? -1 : progressWaypointIndex,
            progressClosestDistance == null ? Double.POSITIVE_INFINITY : progressClosestDistance,
            progressLastX == null ? Double.NaN : progressLastX,
            progressLastZ == null ? Double.NaN : progressLastZ,
            progressStagnantTicks);
    }

    /** Re-run the pure follower with the recorded stall inputs. */
    PathFollower.Command reproduce() {
        return PathFollower.follow(
            waypointCells(),
            inWaypointIndex,
            progress(),
            x,
            z,
            yaw,
            arriveEpsilon,
            maxTurnDegPerTick);
    }

    /** True when an offline replay reproduces the follower's recorded decision (index + finished + reason). */
    boolean reproducesLiveDecision() {
        PathFollower.Command command = reproduce();
        return command.waypointIndex() == outWaypointIndex
            && command.finished() == outFinished
            && command.intent().reason().equals(outReason);
    }

    String summary() {
        return "reason=" + reason + " stagnantTicks=" + progressStagnantTicks
            + " inIndex=" + inWaypointIndex + " outIndex=" + outWaypointIndex
            + " finished=" + outFinished + " outReason=" + outReason
            + " stepAssistJump=" + stepAssistJump + " waypoints=" + waypoints.size()
            + " trail=" + trail.size() + " pos=(" + round(x) + "," + feetY + "," + round(z) + ")";
    }

    private static double round(double value) {
        return Math.round(value * 100.0) / 100.0;
    }

    String toJson() {
        return GSON.toJson(this);
    }

    static FollowerStallRecording fromJson(String json) {
        return GSON.fromJson(json, FollowerStallRecording.class);
    }

    void save(Path file) {
        try {
            if (file.getParent() != null) {
                Files.createDirectories(file.getParent());
            }
            Files.writeString(file, toJson());
        } catch (Throwable ignored) {
            // dev aid; a failed write must never break a run
        }
    }

    static FollowerStallRecording load(Path file) {
        try {
            return fromJson(Files.readString(file));
        } catch (Throwable t) {
            return null;
        }
    }
}
