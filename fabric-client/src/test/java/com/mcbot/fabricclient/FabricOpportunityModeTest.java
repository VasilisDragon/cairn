package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class FabricOpportunityModeTest {
    @Test
    void defaultsOffAndAcceptsShadowAndDeterministicActiveMode() {
        assertEquals(FabricOpportunityMode.OFF, FabricOpportunityMode.resolve(null).mode());
        assertEquals(FabricOpportunityMode.OFF, FabricOpportunityMode.resolve("").mode());
        assertEquals(FabricOpportunityMode.OFF, FabricOpportunityMode.resolve(" off ").mode());
        assertEquals(FabricOpportunityMode.SHADOW, FabricOpportunityMode.resolve(" SHADOW ").mode());
        assertEquals(FabricOpportunityMode.ACTIVE, FabricOpportunityMode.resolve(" ACTIVE ").mode());
        assertFalse(FabricOpportunityMode.resolve(null).rejected());
        assertFalse(FabricOpportunityMode.resolve("shadow").rejected());
        assertFalse(FabricOpportunityMode.resolve("active").rejected());
        assertTrue(FabricOpportunityMode.SHADOW.observes());
        assertTrue(FabricOpportunityMode.ACTIVE.observes());
        assertFalse(FabricOpportunityMode.SHADOW.executes());
        assertTrue(FabricOpportunityMode.ACTIVE.executes());
        assertFalse(FabricOpportunityMode.OFF.observes());
    }

    @Test
    void invalidValuesRejectOnceToOff() {
        FabricOpportunityMode.Resolution invalid = FabricOpportunityMode.resolve("anything_else");
        assertEquals(FabricOpportunityMode.OFF, invalid.mode());
        assertTrue(invalid.rejected());
        assertEquals("anything_else", invalid.configuredValue());
        assertEquals("off", invalid.mode().wireName());
    }
}
