package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class GridAStarDiagnosticTest {
    @Test
    void diagnosticCountsOutOfBoundsWhenRouteNeedsMoreSearchSpace() {
        KinematicSim boxed = new KinematicSim(
            0.5D,
            0.5D,
            0.0D,
            0.2D,
            Set.of(new GridCell(1, 0)),
            0,
            2,
            0,
            0
        );

        GridRouteDiagnostic diagnostic = GridAStar.diagnose(boxed, new GridCell(0, 0), new GridCell(2, 0));

        assertFalse(diagnostic.routeFound());
        assertEquals("open_exhausted", diagnostic.failureReason());
        assertTrue(diagnostic.rejectionCount(TraversalIssue.OUT_OF_BOUNDS) > 0);
    }

    @Test
    void diagnosticCountsElevationRejections() {
        KinematicSim perception = heightMap(
            Map.of(
                new GridCell(0, 0), 64,
                new GridCell(1, 0), 66
            )
        );

        GridRouteDiagnostic diagnostic = GridAStar.diagnose(perception, new GridCell(0, 0), new GridCell(1, 0));

        assertFalse(diagnostic.routeFound());
        assertEquals("open_exhausted", diagnostic.failureReason());
        assertTrue(diagnostic.rejectionCount(TraversalIssue.RISE_TOO_HIGH) > 0);
        GridRejectionSample sample = diagnostic.rejectionSamples().stream()
            .filter((candidate) -> candidate.issue() == TraversalIssue.RISE_TOO_HIGH)
            .findFirst()
            .orElseThrow();
        assertEquals(TraversalIssue.RISE_TOO_HIGH, sample.issue());
        assertEquals(new GridCell(0, 0), sample.from());
        assertEquals(new GridCell(1, 0), sample.to());
        assertEquals(64, sample.fromSurfaceY());
        assertEquals(66, sample.toSurfaceY());
    }

    @Test
    void diagnosticKeepsRouteWhenFound() {
        KinematicSim perception = heightMap(
            Map.of(
                new GridCell(0, 0), 64,
                new GridCell(1, 0), 65
            )
        );

        GridRouteDiagnostic diagnostic = GridAStar.diagnose(perception, new GridCell(0, 0), new GridCell(1, 0));

        assertTrue(diagnostic.routeFound());
        assertEquals(2, diagnostic.routeLength());
        assertEquals("", diagnostic.failureReason());
    }

    private static KinematicSim heightMap(Map<GridCell, Integer> heights) {
        return new KinematicSim(
            0.5D,
            0.5D,
            0.0D,
            0.2D,
            Set.of(),
            heights,
            0,
            Math.max(0, heights.keySet().stream().mapToInt(GridCell::x).max().orElse(0)),
            0,
            0
        );
    }
}
