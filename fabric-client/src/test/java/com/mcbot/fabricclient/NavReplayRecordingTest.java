package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.OptionalInt;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Proves the Phase-1 pathing record/replay round-trips FAITHFULLY: capturing a {@link GridPerception}'s
 * answers (then serializing through GSON and back) reproduces {@link GridAStar}'s exact result. Because
 * capture only uses the {@link GridPerception} interface and the live {@link WorldGridPerception} is one
 * such perception, this property carries to real recordings — including the clearance-aware
 * {@code traversalIssue} overrides that a surfaceY-only sim would miss.
 */
class NavReplayRecordingTest {

    /** A controllable source perception: blocked cells + per-cell surfaceY + forced edge overrides. */
    private static final class SourcePerception implements GridPerception {
        final int minX;
        final int maxX;
        final int minZ;
        final int maxZ;
        final Set<GridCell> blocked;
        final Map<GridCell, Integer> surfaces;
        final Map<String, TraversalIssue> overrides;

        SourcePerception(
            int minX,
            int maxX,
            int minZ,
            int maxZ,
            Set<GridCell> blocked,
            Map<GridCell, Integer> surfaces,
            Map<String, TraversalIssue> overrides
        ) {
            this.minX = minX;
            this.maxX = maxX;
            this.minZ = minZ;
            this.maxZ = maxZ;
            this.blocked = blocked;
            this.surfaces = surfaces;
            this.overrides = overrides;
        }

        @Override
        public int minX() {
            return minX;
        }

        @Override
        public int maxX() {
            return maxX;
        }

        @Override
        public int minZ() {
            return minZ;
        }

        @Override
        public int maxZ() {
            return maxZ;
        }

        @Override
        public boolean isBlocked(int x, int z) {
            return !inBounds(x, z) || blocked.contains(new GridCell(x, z));
        }

        @Override
        public OptionalInt surfaceY(int x, int z) {
            if (isBlocked(x, z)) {
                return OptionalInt.empty();
            }
            return OptionalInt.of(surfaces.getOrDefault(new GridCell(x, z), 0));
        }

        @Override
        public TraversalIssue traversalIssue(GridCell from, GridCell to) {
            TraversalIssue forced = overrides.get(NavReplayRecording.edgeKey(from, to));
            if (forced != null) {
                return forced;
            }
            return GridPerception.super.traversalIssue(from, to);
        }
    }

    @Test
    void captureAndReplayReproduceTheLiveRouteByteForByte() {
        // 5x5 grid. A vertical wall at x=2 with a single gap at z=4 forces a detour, and a forced
        // RISE_TOO_HIGH override closes one otherwise-open edge near the gap so A* must route around it.
        Set<GridCell> blocked = new HashSet<>();
        for (int z = 0; z <= 3; z++) {
            blocked.add(new GridCell(2, z)); // wall x=2, open only at z=4
        }
        Map<GridCell, Integer> surfaces = new HashMap<>();
        Map<String, TraversalIssue> overrides = new HashMap<>();
        overrides.put(
            NavReplayRecording.edgeKey(new GridCell(1, 4), new GridCell(2, 4)),
            TraversalIssue.RISE_TOO_HIGH
        );
        SourcePerception source = new SourcePerception(0, 4, 0, 4, blocked, surfaces, overrides);

        GridCell start = new GridCell(0, 0);
        GridCell goal = new GridCell(4, 0);
        GridRouteDiagnostic live = GridAStar.diagnose(source, start, goal);

        NavReplayRecording recording = NavReplayRecording.capture(source, 64, start, goal, live);

        // The forced clearance override was captured (a surfaceY-only sim would not reproduce it).
        assertEquals(
            TraversalIssue.RISE_TOO_HIGH.name(),
            recording.traversal.get(NavReplayRecording.edgeKey(new GridCell(1, 4), new GridCell(2, 4))),
            "clearance override must be captured"
        );

        // In-memory replay reproduces the route + reason exactly.
        GridRouteDiagnostic replayed = recording.reproduce();
        assertEquals(live.route(), replayed.route(), "replayed route must match live");
        assertEquals(live.failureReason(), replayed.failureReason());
        assertTrue(recording.reproducesLiveOutcome());

        // GSON round-trip preserves it.
        NavReplayRecording roundTripped = NavReplayRecording.fromJson(recording.toJson());
        assertTrue(roundTripped.reproducesLiveOutcome(), "GSON round-trip must stay faithful");
        assertEquals(live.route(), roundTripped.reproduce().route());
    }

    @Test
    void noPathFailuresAreCapturedAndReproduced() {
        // Goal cell is blocked -> live A* reports goal_blocked; the replay must reproduce that exactly.
        Set<GridCell> blocked = new HashSet<>();
        blocked.add(new GridCell(4, 4));
        SourcePerception source = new SourcePerception(0, 4, 0, 4, blocked, new HashMap<>(), new HashMap<>());

        GridCell start = new GridCell(0, 0);
        GridCell goal = new GridCell(4, 4);
        GridRouteDiagnostic live = GridAStar.diagnose(source, start, goal);
        assertFalse(live.routeFound(), "fixture should be a no-path case");
        assertEquals("goal_blocked", live.failureReason());

        NavReplayRecording recording = NavReplayRecording.capture(source, 64, start, goal, live);
        GridRouteDiagnostic replayed = recording.reproduce();
        assertFalse(replayed.routeFound());
        assertEquals("goal_blocked", replayed.failureReason());
        assertTrue(recording.reproducesLiveOutcome());
        assertTrue(NavReplayRecording.fromJson(recording.toJson()).reproducesLiveOutcome());
    }
}
