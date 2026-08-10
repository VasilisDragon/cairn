package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class MissionStoneInventoryCompletionPolicyTest {
    @Test
    void freezesOneAbsoluteTargetForTheCommand() {
        MissionStoneInventoryCompletionPolicy policy = new MissionStoneInventoryCompletionPolicy();
        Object world = new Object();

        MissionStoneInventoryCompletionPolicy.Requirement first = policy.freeze(world, "stone-1", 8);
        MissionStoneInventoryCompletionPolicy.Requirement repeated = policy.freeze(world, "stone-1", 14);

        assertEquals(8, first.requiredCobblestone());
        assertEquals(first, repeated);
        assertFalse(MissionStoneInventoryCompletionPolicy.isSatisfied(first, 7));
        assertTrue(MissionStoneInventoryCompletionPolicy.isSatisfied(first, 8));
        assertTrue(MissionStoneInventoryCompletionPolicy.isSatisfied(first, 9));
    }

    @Test
    void commandWorldAndClearBoundTheFrozenState() {
        MissionStoneInventoryCompletionPolicy policy = new MissionStoneInventoryCompletionPolicy();
        Object firstWorld = new Object();
        Object secondWorld = new Object();

        policy.freeze(firstWorld, "stone-1", 8);
        assertEquals(14, policy.freeze(firstWorld, "stone-2", 14).requiredCobblestone());
        assertEquals(3, policy.freeze(secondWorld, "stone-2", 3).requiredCobblestone());
        policy.clear();
        assertEquals(11, policy.freeze(secondWorld, "stone-2", 11).requiredCobblestone());
    }

    @Test
    void absentOrNonpositiveTargetsLeaveThePolicyDisabled() {
        MissionStoneInventoryCompletionPolicy policy = new MissionStoneInventoryCompletionPolicy();
        Object world = new Object();

        MissionStoneInventoryCompletionPolicy.Requirement absent = policy.freeze(world, "one", null);
        assertFalse(absent.enabled());
        assertNull(absent.requiredCobblestone());
        assertFalse(MissionStoneInventoryCompletionPolicy.isSatisfied(absent, 64));

        MissionStoneInventoryCompletionPolicy.Requirement zero = policy.freeze(world, "two", 0);
        assertFalse(zero.enabled());
        assertNull(zero.requiredCobblestone());
    }
}
