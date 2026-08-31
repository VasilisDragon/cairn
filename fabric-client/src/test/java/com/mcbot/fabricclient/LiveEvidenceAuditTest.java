package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.jupiter.api.Test;

class LiveEvidenceAuditTest {
    @Test
    void normalizesAndHashesCommandsWithoutTheTransportSlash() {
        assertEquals("difficulty normal", LiveEvidenceAudit.normalizeCommand(" /difficulty normal "));
        assertEquals(
            "f3b5d7ad8d3e13e4ee8e0fdd54f8d455c7d85a889aa54fe3c3731c45b8c4b2f1",
            LiveEvidenceAudit.commandSha256("/difficulty normal")
        );
    }

    @Test
    void classifiesFixtureMutationKinds() {
        assertEquals("rules_and_mode", LiveEvidenceAudit.commandCategory("gamerule doMobSpawning false"));
        assertEquals("position_and_spawn", LiveEvidenceAudit.commandCategory("/tp @p 0 80 0"));
        assertEquals("player_and_inventory", LiveEvidenceAudit.commandCategory("give @p minecraft:bread 1"));
        assertEquals("blocks", LiveEvidenceAudit.commandCategory("fill 0 0 0 1 1 1 air"));
        assertEquals("entities", LiveEvidenceAudit.commandCategory("summon minecraft:zombie"));
        assertEquals("time_and_weather", LiveEvidenceAudit.commandCategory("time set day"));
    }

    @Test
    void payloadEncodingIsSingleLineAndReversible() {
        String json = "{\"difficulty\":\"normal\",\"gameMode\":\"survival\"}";
        String encoded = LiveEvidenceAudit.payloadBase64(json);
        assertEquals(json, new String(Base64.getDecoder().decode(encoded), StandardCharsets.UTF_8));
    }
}
