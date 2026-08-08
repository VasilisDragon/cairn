package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class InteractionDemandTest {
    @Test
    void blockDemandFreezesEveryCodeOwnedIdentity() {
        InteractionDemand demand = block("request:1", "stage:break", "block:1");

        assertEquals("request:1", demand.requestId());
        assertEquals(LookDemand.Owner.NORMAL, demand.owner());
        assertEquals(InteractionDemand.Action.BREAK_BLOCK, demand.action());
        assertEquals(InteractionDemand.Policy.CONTINUOUS, demand.policy());
        assertEquals("mission:stone", demand.commandId());
        assertEquals("stage:break", demand.stageIdentity());
        assertEquals("stone-sequence:1", demand.gestureIdentity());
        assertEquals("block:1", demand.targetIdentity());
        assertEquals("minecraft:stone_pickaxe", demand.toolIdentity());
        assertEquals("north", demand.faceIdentity());
        assertTrue(demand.isBreakOwnership());
    }

    @Test
    void holdAndNextBlockShareOneLogicalGesture() {
        InteractionDemand first = block("request:1", "break:1", "block:1");
        InteractionDemand hold = InteractionDemand.blockBreakHold(
            "request:hold:2",
            LookDemand.Owner.NORMAL,
            "mission:stone",
            "confirm:1",
            "stone-sequence:1",
            "block:2",
            "minecraft:stone_pickaxe",
            "up",
            "preaim_next"
        );
        InteractionDemand second = InteractionDemand.breakBlock(
            "request:2",
            LookDemand.Owner.NORMAL,
            "mission:stone",
            "break:2",
            "stone-sequence:1",
            "block:2",
            "minecraft:stone_pickaxe",
            "up",
            "break_next"
        );

        assertTrue(first.sameLogicalGesture(hold));
        assertTrue(hold.sameLogicalGesture(second));
        assertTrue(hold.isBreakOwnership());
    }

    @Test
    void commandOrToolChangeEndsLogicalGesture() {
        InteractionDemand first = block("request:1", "break:1", "block:1");
        InteractionDemand commandChanged = InteractionDemand.breakBlock(
            "request:2",
            LookDemand.Owner.NORMAL,
            "mission:other",
            "break:2",
            "stone-sequence:1",
            "block:2",
            "minecraft:stone_pickaxe",
            "north",
            "break"
        );
        InteractionDemand toolChanged = InteractionDemand.breakBlock(
            "request:3",
            LookDemand.Owner.NORMAL,
            "mission:stone",
            "break:2",
            "stone-sequence:1",
            "block:2",
            "minecraft:iron_pickaxe",
            "north",
            "break"
        );

        assertFalse(first.sameLogicalGesture(commandChanged));
        assertFalse(first.sameLogicalGesture(toolChanged));
    }

    @Test
    void pulseAndHoldFactoriesCarryRetryAndEpisodeIdentity() {
        InteractionDemand attack = InteractionDemand.attackEntity(
            "attack:zombie:4",
            LookDemand.Owner.COMBAT,
            "combat:engage",
            "attack_ready",
            "hostile:uuid",
            "aligned"
        );
        InteractionDemand use = InteractionDemand.useBlock(
            "place:table:1",
            LookDemand.Owner.NORMAL,
            "mission:place",
            "place_table",
            "block:3,64,3",
            "up",
            "aligned"
        );
        InteractionDemand eat = InteractionDemand.holdItem(
            "eat:episode:7",
            LookDemand.Owner.SURVIVAL,
            "survival:eat",
            "eating",
            "eat:episode:7",
            "minecraft:bread",
            "critical_food"
        );

        assertEquals(InteractionDemand.Policy.PULSE, attack.policy());
        assertEquals("attack:zombie:4", attack.requestId());
        assertEquals(InteractionDemand.Action.USE_BLOCK, use.action());
        assertEquals("up", use.faceIdentity());
        assertEquals(InteractionDemand.Policy.HOLD, eat.policy());
        assertEquals("eat:episode:7", eat.gestureIdentity());
    }

    @Test
    void malformedActionPolicyAndMissingIdentitiesFailClosed() {
        assertThrows(IllegalArgumentException.class, () -> new InteractionDemand(
            "request",
            LookDemand.Owner.NORMAL,
            InteractionDemand.Action.BREAK_BLOCK,
            InteractionDemand.Policy.PULSE,
            "command",
            "stage",
            "gesture",
            "target",
            "tool",
            "face",
            "reason"
        ));
        assertThrows(IllegalArgumentException.class, () -> InteractionDemand.breakBlock(
            "request",
            LookDemand.Owner.NORMAL,
            "command",
            "stage",
            "",
            "target",
            "tool",
            "face",
            "reason"
        ));
        assertThrows(IllegalArgumentException.class, () -> InteractionDemand.useBlock(
            "request",
            LookDemand.Owner.NORMAL,
            "command",
            "stage",
            "target",
            "",
            "reason"
        ));
    }

    private static InteractionDemand block(String request, String stage, String target) {
        return InteractionDemand.breakBlock(
            request,
            LookDemand.Owner.NORMAL,
            "mission:stone",
            stage,
            "stone-sequence:1",
            target,
            "minecraft:stone_pickaxe",
            "north",
            "break"
        );
    }
}
