package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class CockpitHudTest {
    @Test
    void objectiveLabelStripsMissionPrefix() {
        assertEquals("MINE_IRON", CockpitHud.objectiveLabel("mission:MINE_IRON"));
        assertEquals("MAKE_IRON_TOOLS", CockpitHud.objectiveLabel("mission:MAKE_IRON_TOOLS"));
    }

    @Test
    void objectiveLabelIsDashForNonMissionOrEmptyReasons() {
        assertEquals("-", CockpitHud.objectiveLabel(null));
        assertEquals("-", CockpitHud.objectiveLabel(""));
        assertEquals("-", CockpitHud.objectiveLabel("mission:"));
        assertEquals("-", CockpitHud.objectiveLabel("descent_step_arrived")); // a non-mission control reason
    }

    @Test
    void brainStateLabelUsesResponseRecencyNotIntentTtl() {
        // THINKING while a (debounced) brain call is outstanding.
        assertEquals("THINKING", CockpitHud.brainStateLabel(status(true, true, 50L)));
        // "stale" = the BRAIN stopped answering (no successful round-trip in a while).
        assertEquals("stale", CockpitHud.brainStateLabel(status(true, false, 5_000L)));
        // A recent response reads "ok" EVEN THOUGH the helper pins remainingTtlMs=0 (a held command).
        assertEquals("ok", CockpitHud.brainStateLabel(status(true, false, 50L)));
        // No completed response yet (-1) is a startup state, not stale (THINKING covers active polling).
        assertEquals("ok", CockpitHud.brainStateLabel(status(true, false, -1L)));
    }

    @Test
    void brainStateLabelIsPausedWhenControlDisabled() {
        // When the bot is toggled off, the brain isn't polled — show a calm "paused", never the live
        // THINKING/ok/stale that would otherwise flicker from a frozen in-flight snapshot.
        assertEquals("paused", CockpitHud.brainStateLabel(status(false, true, 500L)));
        assertEquals("paused", CockpitHud.brainStateLabel(status(false, false, 0L)));
        assertEquals("paused", CockpitHud.brainStateLabel(status(false, false, 300L)));
    }

    @Test
    void linesShowRunningStoppedAndObjective() {
        List<String> running = CockpitHud.lines(status(true, false, 300L));
        assertTrue(running.get(0).contains("RUNNING"), running.get(0));
        assertFalse(running.get(0).contains("STOPPED"), running.get(0));
        assertTrue(running.stream().anyMatch(l -> l.equals("objective: MINE_IRON")), running.toString());

        List<String> stopped = CockpitHud.lines(status(false, false, 300L));
        assertTrue(stopped.get(0).contains("STOPPED"), stopped.get(0));
    }

    @Test
    void truncateCapsLongSubStepsWithEllipsis() {
        assertEquals("short", CockpitHud.truncate("short", 24));
        assertEquals("", CockpitHud.truncate(null, 24));
        String longSub = "direct_collect_fallback:mine_nearby_iron_collect_drop";
        String capped = CockpitHud.truncate(longSub, 24);
        assertEquals(24, capped.length());
        assertTrue(capped.endsWith("…"), capped);
        // the action line in lines() must stay bounded even with a very long sub-step
        List<String> lines = CockpitHud.lines(new CockpitHud.Status(
            true, "control", "mine_nearby_iron", "mission:MINE_IRON", longSub, false, 300L, 42L, "x-13", 20.0F, 8, 50L));
        String actionLine = lines.stream().filter(l -> l.startsWith("action:")).findFirst().orElseThrow();
        assertTrue(actionLine.length() <= "action: mine_nearby_iron  (".length() + 24 + 1, actionLine);
    }

    @Test
    void shortCommandIdKeepsTheTrailingSuffix() {
        assertEquals("…-19", CockpitHud.shortCommandId("mission-fabric-gather-20260604-095934-19"));
        assertEquals("-", CockpitHud.shortCommandId(null));
        assertEquals("-", CockpitHud.shortCommandId(""));
        assertEquals("plain", CockpitHud.shortCommandId("plain"));
    }

    @Test
    void deepSeekLinesShowSourceReasonAndThinking() {
        List<String> thinking = CockpitHud.deepSeekLines("llm", "iron pickaxe needs 3 ingots", true);
        assertEquals("DeepSeek  *thinking*", thinking.get(0));
        assertTrue(thinking.stream().anyMatch(l -> l.equals("src: llm")), thinking.toString());
        assertTrue(thinking.stream().anyMatch(l -> l.startsWith("why: iron pickaxe")), thinking.toString());

        List<String> idle = CockpitHud.deepSeekLines("none", "", false);
        assertEquals("DeepSeek", idle.get(0));
        assertTrue(idle.stream().anyMatch(l -> l.equals("why: -")), idle.toString());
    }

    private static CockpitHud.Status status(boolean controlEnabled, boolean inFlight, long msSinceResponseMs) {
        return new CockpitHud.Status(
            controlEnabled,
            "control",
            "mine_nearby_iron",
            "mission:MINE_IRON",
            "mine_nearby_iron.target_selected",
            inFlight,
            0L, // remainingTtlMs: held-command intents sit at 0 -- must NOT read as stale
            42L,
            "mission-x-19",
            18.0F,
            11,
            msSinceResponseMs
        );
    }
}
