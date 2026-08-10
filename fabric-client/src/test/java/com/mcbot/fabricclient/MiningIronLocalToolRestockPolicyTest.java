package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class MiningIronLocalToolRestockPolicyTest {
    @Test
    void nearbyTableStillRequiresPickInputsAndProtectedPlanks() {
        assertTrue(assess(3, 2, 0, 0, true, false).admitted());
        assertTrue(assess(3, 0, 8, 0, true, false).admitted());
        assertFalse(assess(2, 2, 6, 0, true, false).admitted());
        assertFalse(assess(3, 0, 7, 0, true, false).admitted());
    }

    @Test
    void carriedAndCraftedTablesRequireALegalAlcove() {
        assertFalse(assess(3, 2, 6, 1, false, false).admitted());
        assertTrue(assess(3, 2, 0, 1, false, true).admitted());
        assertFalse(assess(3, 2, 9, 0, false, true).admitted());
        MiningIronLocalToolRestockPolicy.Decision crafted = assess(3, 2, 10, 0, false, true);
        assertTrue(crafted.admitted());
        assertEquals(10, crafted.requiredPlanks());
    }

    @Test
    void combinedStickAndTableCraftPreservesSixPlanks() {
        assertFalse(assess(3, 0, 11, 0, false, true).admitted());
        MiningIronLocalToolRestockPolicy.Decision decision = assess(3, 0, 12, 0, false, true);
        assertTrue(decision.admitted());
        assertTrue(decision.craftSticks());
        assertTrue(decision.placeOrCraftTable());
        assertEquals(12, decision.requiredPlanks());
    }

    @Test
    void logsAreCountedOnlyAsConvertiblePlanksForTheExistingLocalPath() {
        MiningIronLocalToolRestockPolicy.Decision decision = MiningIronLocalToolRestockPolicy.assess(
            new MiningIronLocalToolRestockPolicy.Request(3, 0, 0, 3, 0, false, true)
        );
        assertTrue(decision.admitted());
        assertTrue(decision.craftSticks());
        assertTrue(decision.placeOrCraftTable());
        assertEquals(12, decision.requiredPlanks());
    }

    private MiningIronLocalToolRestockPolicy.Decision assess(
        int cobble,
        int sticks,
        int planks,
        int tables,
        boolean nearby,
        boolean alcove
    ) {
        return MiningIronLocalToolRestockPolicy.assess(
            new MiningIronLocalToolRestockPolicy.Request(
                cobble, sticks, planks, tables, nearby, alcove
            )
        );
    }
}
