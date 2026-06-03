package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
    void defaultWindowStillReturnsEmptyWhenSurfaceNeedsFallbackWindow() {
        OptionalInt surface = SurfaceScanner.scan(
            64,
            WorldGridPerception.DEFAULT_SURFACE_SCAN_UP,
            WorldGridPerception.DEFAULT_SURFACE_SCAN_DOWN,
            (y) -> y == 75 || y == 36
        );

        assertTrue(surface.isEmpty());
    }
}
