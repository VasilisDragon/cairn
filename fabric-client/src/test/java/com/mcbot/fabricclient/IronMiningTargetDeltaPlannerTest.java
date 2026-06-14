package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class IronMiningTargetDeltaPlannerTest {
    @Test
    void targetsIronPickaxeBeforeArmor() {
        assertEquals(3, target(0, 0, 0, armor(false, false, false, false)));
        assertEquals(1, target(1, 1, 0, armor(false, false, false, false)));
        assertEquals(0, target(2, 1, 0, armor(false, false, false, false)));
    }

    @Test
    void targetsNextMissingArmorPieceAfterIronPickaxe() {
        assertEquals(5, target(0, 0, 1, armor(false, false, false, false)));
        assertEquals(8, target(0, 0, 1, armor(true, false, false, false)));
        assertEquals(7, target(0, 0, 1, armor(true, true, false, false)));
        assertEquals(4, target(0, 0, 1, armor(true, true, true, false)));
    }

    @Test
    void carriedIronReducesArmorTargetDelta() {
        assertEquals(3, target(1, 1, 1, armor(false, false, false, false)));
        assertEquals(0, target(3, 2, 1, armor(false, false, false, false)));
        assertEquals(5, target(2, 1, 1, armor(true, false, false, false)));
    }

    @Test
    void spareArmorSatisfiesMissingSlotSoMiningCanMoveToNextNeed() {
        IronMiningTargetDeltaPlanner.ArmorState helmetSpare = new IronMiningTargetDeltaPlanner.ArmorState(
            false,
            false,
            false,
            false,
            1,
            0,
            0,
            0
        );

        assertEquals(8, IronMiningTargetDeltaPlanner.targetDelta(0, 0, 1, helmetSpare, 3, 8));
    }

    @Test
    void returnsDefaultWhenIronGearIsAlreadySatisfied() {
        assertEquals(3, target(0, 0, 1, armor(true, true, true, true)));
    }

    @Test
    void capsLargeTargetsAndNormalizesNegativeInputs() {
        assertEquals(8, IronMiningTargetDeltaPlanner.targetDelta(
            -3,
            -2,
            1,
            armor(true, false, false, false),
            3,
            8
        ));
    }

    private static int target(int rawIron, int ironIngots, int ironPickaxes, IronMiningTargetDeltaPlanner.ArmorState armor) {
        return IronMiningTargetDeltaPlanner.targetDelta(rawIron, ironIngots, ironPickaxes, armor, 3, 8);
    }

    private static IronMiningTargetDeltaPlanner.ArmorState armor(
        boolean helmet,
        boolean chestplate,
        boolean leggings,
        boolean boots
    ) {
        return new IronMiningTargetDeltaPlanner.ArmorState(
            helmet,
            chestplate,
            leggings,
            boots,
            0,
            0,
            0,
            0
        );
    }
}
