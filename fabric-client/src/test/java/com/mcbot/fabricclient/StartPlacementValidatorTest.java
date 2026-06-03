package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.OptionalInt;
import org.junit.jupiter.api.Test;

class StartPlacementValidatorTest {
    @Test
    void rejectsVegetationInsideBotBodyEvenWhenLowerSurfaceExists() {
        assertEquals(
            StartPlacementValidator.Issue.VEGETATION_BODY_COLLISION,
            StartPlacementValidator.classify(
                152,
                OptionalInt.of(144),
                true,
                true,
                true,
                false
            )
        );
    }

    @Test
    void rejectsNonVegetationBodyObstructionAbovePerceivedSurface() {
        assertEquals(
            StartPlacementValidator.Issue.BODY_OBSTRUCTED_ABOVE_SURFACE,
            StartPlacementValidator.classify(
                70,
                OptionalInt.of(68),
                true,
                false,
                false,
                false
            )
        );
    }

    @Test
    void rejectsClearBodyThatIsFarAbovePerceivedGround() {
        assertEquals(
            StartPlacementValidator.Issue.OFF_SURFACE_START,
            StartPlacementValidator.classify(
                80,
                OptionalInt.of(76),
                false,
                false,
                false,
                false
            )
        );
    }

    @Test
    void acceptsClearBodyOnOrNearSurface() {
        assertEquals(
            StartPlacementValidator.Issue.NONE,
            StartPlacementValidator.classify(
                65,
                OptionalInt.of(64),
                false,
                false,
                false,
                false
            )
        );
    }
}
