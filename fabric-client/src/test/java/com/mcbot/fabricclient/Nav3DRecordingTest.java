package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class Nav3DRecordingTest {
    @Test
    void captureAndReplayReproduceRouteOutcome() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 4, 63, 67, 0, 1);
        world.floor(0, 4, 0, 1, 63);
        world.hazard(2, 63, 0);
        VoxelCell start = new VoxelCell(0, 64, 0);
        VoxelCell goal = new VoxelCell(4, 64, 0);
        Nav3DRouteDiagnostic live = VoxelAStar.diagnose(world, start, goal);

        Nav3DRecording recording = Nav3DRecording.capture(world, start, goal, live);
        Nav3DRecording roundTripped = Nav3DRecording.fromJson(recording.toJson());

        assertTrue(live.routeFound(), "fixture should route around the hazard");
        assertTrue(roundTripped.reproducesLiveOutcome(), roundTripped.summary());
        assertEquals(live.route(), roundTripped.reproduce().route());
    }

    @Test
    void noPathFailuresRoundTrip() {
        VoxelAStarTest.TestVoxelWorld world = new VoxelAStarTest.TestVoxelWorld(0, 1, 63, 66, 0, 0);
        world.support(0, 63, 0);
        VoxelCell start = new VoxelCell(0, 64, 0);
        VoxelCell goal = new VoxelCell(1, 64, 0);
        Nav3DRouteDiagnostic live = VoxelAStar.diagnose(world, start, goal);

        Nav3DRecording recording = Nav3DRecording.capture(world, start, goal, live);

        assertEquals("goal_blocked", live.failureReason());
        assertTrue(Nav3DRecording.fromJson(recording.toJson()).reproducesLiveOutcome());
    }
}
