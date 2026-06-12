package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Proves the Phase-1.5 follower-stall record/replay round-trips faithfully: a recorded {@link
 * PathFollower#follow} decision (its inputs plus the command it produced) reproduces exactly when
 * replayed offline, and survives a GSON round-trip. Because follow() is pure, replaying the recorded
 * inputs is guaranteed to reproduce the live decision, which is what makes a captured stuck-follow
 * stall debuggable and regression-guardable offline.
 */
class FollowerStallRecordingTest {

    private static FollowerStallRecording record(
        List<GridCell> path,
        int inIndex,
        PathFollower.Progress inProgress,
        double x,
        double z,
        double yaw,
        double epsilon,
        double maxTurn
    ) {
        PathFollower.Command command = PathFollower.follow(path, inIndex, inProgress, x, z, yaw, epsilon, maxTurn);
        FollowerStallRecording recording = new FollowerStallRecording();
        for (GridCell cell : path) {
            recording.waypoints.add(FollowerStallRecording.cellKey(cell));
        }
        recording.arriveEpsilon = epsilon;
        recording.maxTurnDegPerTick = maxTurn;
        recording.inWaypointIndex = inIndex;
        recording.progressWaypointIndex = inProgress.waypointIndex();
        recording.progressClosestDistance = Double.isFinite(inProgress.closestDistance()) ? inProgress.closestDistance() : null;
        recording.progressLastX = Double.isFinite(inProgress.lastX()) ? inProgress.lastX() : null;
        recording.progressLastZ = Double.isFinite(inProgress.lastZ()) ? inProgress.lastZ() : null;
        recording.progressStagnantTicks = inProgress.stagnantTicks();
        recording.x = x;
        recording.z = z;
        recording.yaw = yaw;
        recording.feetY = 64;
        recording.outWaypointIndex = command.waypointIndex();
        recording.outFinished = command.finished();
        recording.outReason = command.intent().reason();
        return recording;
    }

    @Test
    void recordedFollowerDecisionReproducesAndSurvivesGsonRoundTrip() {
        List<GridCell> path = List.of(new GridCell(0, 0), new GridCell(1, 0), new GridCell(2, 0));
        // At the centre of waypoint 1, heading to waypoint 2 -> a non-trivial in-progress decision.
        FollowerStallRecording recording = record(path, 1, PathFollower.Progress.initial(), 1.5D, 0.5D, 0.0D, 0.45D, 30.0D);

        assertTrue(recording.reproducesLiveDecision(), "replay must reproduce the live follower decision");
        assertEquals(recording.outWaypointIndex, recording.reproduce().waypointIndex());
        // initial Progress carries +Inf/NaN, stored as null and rehydrated -> JSON stays standard.
        assertTrue(FollowerStallRecording.fromJson(recording.toJson()).reproducesLiveDecision(),
            "GSON round-trip must stay faithful");
    }

    @Test
    void stalledProgressDecisionReproduces() {
        // A non-initial Progress (accumulated stagnant ticks) round-trips through the finite-double fields.
        List<GridCell> path = List.of(new GridCell(0, 0), new GridCell(0, 1), new GridCell(0, 2));
        PathFollower.Progress stalled = new PathFollower.Progress(1, 0.5D, 0.5D, 1.4D, 14);
        FollowerStallRecording recording = record(path, 1, stalled, 0.5D, 1.4D, 0.0D, 0.45D, 30.0D);

        assertTrue(recording.reproducesLiveDecision());
        FollowerStallRecording roundTripped = FollowerStallRecording.fromJson(recording.toJson());
        assertTrue(roundTripped.reproducesLiveDecision());
        assertEquals(14, roundTripped.progressStagnantTicks);
    }
}
