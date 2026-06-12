package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

/**
 * Replay of REAL 3-D collect captures from a live R5 run ({@code MCBOT_FABRIC_NAV3D_RECORD=1}). These prove
 * the 3-D recorder is faithful on real geometry, and they pin the empirical split the live run revealed:
 * the 3-D traversal nav reaches some real drops the 2-D heightmap cannot represent (a descent to a pickup
 * cell below the bot), while other real drops have NO reachable standable pickup cell by traversal at all
 * and therefore need constructive nav (Phase B/C), not Phase A traversal.
 */
class Nav3DCollectCorpusTest {
    private static Nav3DRecording load(String resource) throws Exception {
        try (InputStream in = Nav3DCollectCorpusTest.class.getResourceAsStream(resource)) {
            assertNotNull(in, "missing fixture: " + resource);
            return Nav3DRecording.fromJson(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    @Test
    void realDescentDropIsReachableByThreeDTraversal() throws Exception {
        Nav3DRecording rec = load("/nav-recordings/r5-nav3d-collect-reachable.json");
        assertTrue(rec.liveRouteFound, "captured live verdict was reachable");
        assertEquals("reachable_pickup_cell", rec.liveFailureReason);

        CollectTarget3DPlanner.TargetPlan plan = rec.reproduceCollectTarget();
        assertNotNull(plan.cell(), "3-D planner reaches the drop on the real capture");
        assertFalse(plan.route().isEmpty(), "the pickup cell is reachable via a real route");
        assertEquals("reachable_pickup_cell", plan.reason());
        // The win over 2-D: the reached pickup cell is BELOW the bot -- a descent the heightmap can't see.
        assertTrue(plan.cell().y() < rec.start().y(), "reaches a cell below the bot (multi-level)");
    }

    @Test
    void realUnreachableDropNeedsConstruction() throws Exception {
        Nav3DRecording rec = load("/nav-recordings/r5-nav3d-collect-unreachable.json");
        assertFalse(rec.liveRouteFound, "captured live verdict was unreachable");
        assertEquals("no_reachable_pickup_cell", rec.liveFailureReason);
        assertTrue(rec.reproducesLiveCollectOutcome(), rec.summary());
        // No standable pickup cell is reachable by traversal -> this real drop needs Phase B/C construction.
        assertNull(rec.reproduceCollectTarget().cell());
    }
}
