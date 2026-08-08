package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class FabricMotionModeTest {
    @Test
    void defaultsToSmoothAndAcceptsEveryImplementedMode() {
        assertEquals(FabricMotionMode.SMOOTH, FabricMotionMode.resolve(null).mode());
        assertEquals(FabricMotionMode.SMOOTH, FabricMotionMode.resolve("").mode());
        assertEquals(FabricMotionMode.SMOOTH, FabricMotionMode.resolve("   ").mode());
        assertEquals(FabricMotionMode.LEGACY, FabricMotionMode.resolve("legacy").mode());
        assertEquals(FabricMotionMode.SHADOW, FabricMotionMode.resolve(" SHADOW ").mode());
        assertEquals(FabricMotionMode.SMOOTH, FabricMotionMode.resolve("smooth").mode());
        assertFalse(FabricMotionMode.resolve(null).rejected());
    }

    @Test
    void invalidAndActiveValuesRejectToLegacy() {
        FabricMotionMode.Resolution invalid = FabricMotionMode.resolve("active");
        assertEquals(FabricMotionMode.LEGACY, invalid.mode());
        assertTrue(invalid.rejected());
        assertEquals("active", invalid.configuredValue());
    }
}
