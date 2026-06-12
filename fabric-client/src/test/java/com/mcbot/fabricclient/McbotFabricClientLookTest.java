package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class McbotFabricClientLookTest {

    @Test
    void wrapDegreesDeltaHandlesSeamCrossing() {
        assertEquals(0.0, McbotFabricClient.wrapDegreesDelta(0.0), 1e-9);
        assertEquals(-20.0, McbotFabricClient.wrapDegreesDelta(340.0), 1e-9);
        assertEquals(20.0, McbotFabricClient.wrapDegreesDelta(-340.0), 1e-9);
        assertEquals(-180.0, McbotFabricClient.wrapDegreesDelta(180.0), 1e-9);
        assertEquals(-90.0, McbotFabricClient.wrapDegreesDelta(270.0), 1e-9);
    }
}
