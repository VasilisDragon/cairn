package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class DescentStepSafetyPolicyTest {
    @Test
    void ordinaryAirSupportRemainsGenericMissingSupport() {
        DescentStepSafetyPolicy.Result result = classify(false, false, null, "", "");

        assertEquals(DescentStepSafetyPolicy.Kind.SUPPORT_MISSING, result.kind());
        assertEquals("descent_next_support_missing:4, 62, 7", result.reason());
    }

    @Test
    void exactSupportWaterPrecedesMissingSupportAndOtherHazards() {
        DescentStepSafetyPolicy.Result result = classify(
            false,
            true,
            new DescentStepSafetyPolicy.Hazard("lava", "4, 63, 7"),
            "5, 62, 7",
            "3, 62, 7"
        );

        assertEquals(DescentStepSafetyPolicy.Kind.SUPPORT_WATER, result.kind());
        assertEquals("water", result.hazardKind());
        assertEquals("4, 62, 7", result.cell());
        assertEquals("descent_water_adjacent:4, 62, 7", result.reason());
    }

    @Test
    void exactBodyWaterPrecedesMissingSupport() {
        DescentStepSafetyPolicy.Result result = classify(
            false,
            false,
            new DescentStepSafetyPolicy.Hazard("water", "4, 63, 7"),
            "",
            ""
        );

        assertEquals(DescentStepSafetyPolicy.Kind.BODY_WATER, result.kind());
        assertEquals("descent_water_adjacent:4, 63, 7", result.reason());
    }

    @Test
    void adjacentWaterKeepsExistingReasonShape() {
        DescentStepSafetyPolicy.Result result = classify(true, false, null, "5, 62, 7", "");

        assertEquals(DescentStepSafetyPolicy.Kind.ADJACENT_WATER, result.kind());
        assertEquals("descent_water_adjacent:5, 62, 7", result.reason());
    }

    @Test
    void bodyHazardPreservesItsKind() {
        DescentStepSafetyPolicy.Result result = classify(
            true,
            false,
            new DescentStepSafetyPolicy.Hazard("magma", "4, 63, 7"),
            "",
            ""
        );

        assertEquals(DescentStepSafetyPolicy.Kind.HAZARD, result.kind());
        assertEquals("magma", result.hazardKind());
        assertEquals("descent_hazard_in_step:magma:4, 63, 7", result.reason());
    }

    @Test
    void bodyLavaRemainsAConcreteHazardKind() {
        DescentStepSafetyPolicy.Result result = classify(
            true,
            false,
            new DescentStepSafetyPolicy.Hazard("lava", "4, 63, 7"),
            "5, 62, 7",
            ""
        );

        assertEquals(DescentStepSafetyPolicy.Kind.HAZARD, result.kind());
        assertEquals("lava", result.hazardKind());
        assertEquals("descent_hazard_in_step:lava:4, 63, 7", result.reason());
    }

    @Test
    void adjacentLavaKeepsExistingReasonShape() {
        DescentStepSafetyPolicy.Result result = classify(true, false, null, "", "3, 62, 7");

        assertEquals(DescentStepSafetyPolicy.Kind.ADJACENT_LAVA, result.kind());
        assertEquals("descent_lava_adjacent:3, 62, 7", result.reason());
    }

    @Test
    void safeStepHasNoReason() {
        DescentStepSafetyPolicy.Result result = classify(true, false, null, "", "");

        assertEquals(DescentStepSafetyPolicy.Kind.SAFE, result.kind());
        assertTrue(result.safe());
        assertNull(result.reason());
    }

    @Test
    void unsafeStepIsNotSafe() {
        assertFalse(classify(false, false, null, "", "").safe());
    }

    private static DescentStepSafetyPolicy.Result classify(
        boolean supportStable,
        boolean supportWater,
        DescentStepSafetyPolicy.Hazard bodyHazard,
        String adjacentWater,
        String adjacentLava
    ) {
        return DescentStepSafetyPolicy.classify(new DescentStepSafetyPolicy.Observation(
            "4, 62, 7",
            supportStable,
            supportWater,
            bodyHazard,
            adjacentWater,
            adjacentLava
        ));
    }
}
