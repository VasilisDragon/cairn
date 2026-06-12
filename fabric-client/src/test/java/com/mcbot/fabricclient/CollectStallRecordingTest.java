package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.OptionalInt;
import org.junit.jupiter.api.Test;

/**
 * Proves the Phase-1.6 collect-stall record/replay round-trips faithfully and characterizes the
 * fell-below failure: the 2-D route to the drop cell reproduces (reusing Phase-1 faithfulness), and the
 * drop sitting below the arrival surface by more than pickup range is detected as unreachable. Because it
 * reuses GridPerception + GridAStar + NavReplayRecording, this carries to real captured recordings.
 */
class CollectStallRecordingTest {

    /** A flat, fully-open grid standing at y=64 everywhere within bounds. */
    private static final class FlatGrid implements GridPerception {
        @Override
        public int minX() {
            return -3;
        }

        @Override
        public int maxX() {
            return 3;
        }

        @Override
        public int minZ() {
            return -3;
        }

        @Override
        public int maxZ() {
            return 3;
        }

        @Override
        public boolean isBlocked(int x, int z) {
            return !inBounds(x, z);
        }

        @Override
        public OptionalInt surfaceY(int x, int z) {
            return isBlocked(x, z) ? OptionalInt.empty() : OptionalInt.of(64);
        }
    }

    @Test
    void recordedFallBelowCollectReproducesOffline() {
        FlatGrid perception = new FlatGrid();
        GridCell bot = new GridCell(-2, 0);
        GridCell drop = new GridCell(2, 0);
        GridRouteDiagnostic diagnostic = GridAStar.diagnose(perception, bot, drop);

        CollectStallRecording recording = new CollectStallRecording();
        recording.dropItemId = "raw_iron";
        recording.dropX = 2.5;
        recording.dropY = 62.0; // 2 blocks below the surface the 2-D collect would arrive at (y64)
        recording.dropZ = 0.5;
        recording.botX = -2.5;
        recording.botY = 64.0;
        recording.botZ = 0.5;
        recording.botYaw = 0.0;
        recording.botFeetY = 64;
        recording.collectElapsedMs = 8000;
        recording.route = NavReplayRecording.capture(perception, 64, bot, drop, diagnostic);

        assertTrue(recording.reproducesRoute(), "the 2-D route to the drop cell reproduces");
        assertEquals(2.0, recording.verticalGapToDrop(), 1e-9, "surfaceY(64) - dropY(62)");
        assertTrue(recording.reproducesUnreachableDrop(), "drop fell below pickup range -> unreachable");

        CollectStallRecording roundTripped = CollectStallRecording.fromJson(recording.toJson());
        assertTrue(roundTripped.reproducesRoute(), "GSON round-trip preserves the route");
        assertTrue(roundTripped.reproducesUnreachableDrop());
        assertEquals(2.0, roundTripped.verticalGapToDrop(), 1e-9);
    }
}
