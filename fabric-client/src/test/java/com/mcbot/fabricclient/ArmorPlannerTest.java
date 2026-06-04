package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Map;
import org.junit.jupiter.api.Test;

class ArmorPlannerTest {
    @Test
    void keepsHealthyEquippedArmor() {
        ArmorPlanner.Decision decision = ArmorPlanner.decide(
            ArmorPlanner.ArmorSlot.HELMET,
            new ArmorPlanner.SlotObservation(true, 0.50D, 0, 24)
        );

        assertEquals(ArmorPlanner.Action.KEEP, decision.action());
    }

    @Test
    void equipsSpareWhenEquippedArmorIsBelowFivePercent() {
        ArmorPlanner.Decision decision = ArmorPlanner.decide(
            ArmorPlanner.ArmorSlot.HELMET,
            new ArmorPlanner.SlotObservation(true, 0.03D, 1, 0)
        );

        assertEquals(ArmorPlanner.Action.EQUIP_SPARE, decision.action());
        assertEquals(ArmorPlanner.ArmorSlot.HELMET, decision.slot());
    }

    @Test
    void craftsReplacementWhenMissingAndIronIsAvailable() {
        ArmorPlanner.Decision decision = ArmorPlanner.decide(
            ArmorPlanner.ArmorSlot.CHESTPLATE,
            new ArmorPlanner.SlotObservation(false, -1.0D, 0, 8)
        );

        assertEquals(ArmorPlanner.Action.CRAFT_REPLACE, decision.action());
        assertEquals("craft_iron_chestplate", decision.craftAction());
    }

    @Test
    void waitsWhenReplacementIsNeededButUnavailable() {
        ArmorPlanner.Decision decision = ArmorPlanner.decide(
            ArmorPlanner.ArmorSlot.LEGGINGS,
            new ArmorPlanner.SlotObservation(false, -1.0D, 0, 6)
        );

        assertEquals(ArmorPlanner.Action.WAIT_FOR_MATERIALS, decision.action());
    }

    @Test
    void decideFirstReturnsFirstSlotNeedingWorkInStableOrder() {
        ArmorPlanner.Decision decision = ArmorPlanner.decideFirst(Map.of(
            ArmorPlanner.ArmorSlot.CHESTPLATE, new ArmorPlanner.SlotObservation(false, -1.0D, 1, 0),
            ArmorPlanner.ArmorSlot.HELMET, new ArmorPlanner.SlotObservation(true, 1.0D, 0, 0)
        ));

        assertEquals(ArmorPlanner.Action.EQUIP_SPARE, decision.action());
        assertEquals(ArmorPlanner.ArmorSlot.CHESTPLATE, decision.slot());
    }
}
