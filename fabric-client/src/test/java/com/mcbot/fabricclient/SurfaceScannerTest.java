package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;
import java.util.OptionalInt;
import org.junit.jupiter.api.Test;

class SurfaceScannerTest {
    @Test
    void fallbackWindowFindsSurfaceAboveDefaultLimit() {
        OptionalInt surface = SurfaceScanner.scan(
            64,
            WorldGridPerception.FALLBACK_SURFACE_SCAN_UP,
            WorldGridPerception.FALLBACK_SURFACE_SCAN_DOWN,
            (y) -> y == 75
        );

        assertEquals(75, surface.orElseThrow());
    }

    @Test
    void fallbackWindowFindsSurfaceBelowDefaultLimit() {
        OptionalInt surface = SurfaceScanner.scan(
            64,
            WorldGridPerception.FALLBACK_SURFACE_SCAN_UP,
            WorldGridPerception.FALLBACK_SURFACE_SCAN_DOWN,
            (y) -> y == 36
        );

        assertEquals(36, surface.orElseThrow());
    }

    @Test
    void defaultWindowNowCoversFormerFallbackDepths() {
        OptionalInt surface = SurfaceScanner.scan(
            64,
            WorldGridPerception.DEFAULT_SURFACE_SCAN_UP,
            WorldGridPerception.DEFAULT_SURFACE_SCAN_DOWN,
            (y) -> y == 75 || y == 36
        );

        assertEquals(75, surface.orElseThrow());
    }

    @Test
    void defaultWindowRoutesDugPitFixtureWithoutFallback() {
        Map<GridCell, Integer> lowSurfaces = new HashMap<>();
        lowSurfaces.put(new GridCell(0, 0), 64);
        lowSurfaces.put(new GridCell(1, 0), 61);
        lowSurfaces.put(new GridCell(2, 0), 58);
        lowSurfaces.put(new GridCell(3, 0), 55);
        lowSurfaces.put(new GridCell(4, 0), 52);
        lowSurfaces.put(new GridCell(5, 0), 53);
        lowSurfaces.put(new GridCell(6, 0), 54);
        lowSurfaces.put(new GridCell(7, 0), 55);
        lowSurfaces.put(new GridCell(8, 0), 56);
        lowSurfaces.put(new GridCell(9, 0), 57);
        lowSurfaces.put(new GridCell(10, 0), 58);
        lowSurfaces.put(new GridCell(11, 0), 59);
        lowSurfaces.put(new GridCell(12, 0), 60);
        lowSurfaces.put(new GridCell(13, 0), 61);
        lowSurfaces.put(new GridCell(14, 0), 62);
        lowSurfaces.put(new GridCell(15, 0), 63);
        lowSurfaces.put(new GridCell(16, 0), 64);
        ScanWindowFixturePerception oldShallowScan =
            new ScanWindowFixturePerception(64, 3, 10, lowSurfaces);
        ScanWindowFixturePerception defaultScan =
            new ScanWindowFixturePerception(
                64,
                WorldGridPerception.DEFAULT_SURFACE_SCAN_UP,
                WorldGridPerception.DEFAULT_SURFACE_SCAN_DOWN,
                lowSurfaces
            );

        GridRouteDiagnostic oldDiagnostic =
            GridAStar.diagnose(oldShallowScan, new GridCell(0, 0), new GridCell(16, 0));
        GridRouteDiagnostic defaultDiagnostic =
            GridAStar.diagnose(defaultScan, new GridCell(0, 0), new GridCell(16, 0));

        assertFalse(oldDiagnostic.routeFound(), "former shallow scan should reproduce the open-exhausted shape");
        assertEquals("open_exhausted", oldDiagnostic.failureReason());
        assertTrue(defaultDiagnostic.routeFound(), "default scan should now find the dug-pit route first");
        assertEquals(17, defaultDiagnostic.routeLength());
    }

    private record ScanWindowFixturePerception(
        int referenceY,
        int scanUp,
        int scanDown,
        Map<GridCell, Integer> surfaces
    ) implements GridPerception {
        @Override
        public boolean isBlocked(int x, int z) {
            return surfaceY(x, z).isEmpty();
        }

        @Override
        public int minX() {
            return 0;
        }

        @Override
        public int maxX() {
            return 16;
        }

        @Override
        public int minZ() {
            return 0;
        }

        @Override
        public int maxZ() {
            return 0;
        }

        @Override
        public OptionalInt surfaceY(int x, int z) {
            if (!inBounds(x, z)) {
                return OptionalInt.empty();
            }
            GridCell cell = new GridCell(x, z);
            Integer surface = surfaces.get(cell);
            if (surface == null) {
                return OptionalInt.empty();
            }
            return SurfaceScanner.scan(referenceY, scanUp, scanDown, (candidateY) -> candidateY == surface);
        }
    }
}
