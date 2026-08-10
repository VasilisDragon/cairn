package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class DescentStepArrivalValidatorTest {
    private static final VoxelCell TARGET = new VoxelCell(2, 15, -3);

    @Test
    void requiresTwoConsecutiveValidPolls() {
        DescentStepArrivalValidator validator = new DescentStepArrivalValidator();

        DescentStepArrivalValidator.Decision first =
            validator.tick("command:step:1", validObservation());
        DescentStepArrivalValidator.Decision second =
            validator.tick("command:step:1", validObservation());
        DescentStepArrivalValidator.Decision third =
            validator.tick("command:step:1", validObservation());

        assertEquals(DescentStepArrivalValidator.Status.PENDING_VALID_POLL, first.status());
        assertEquals(1, first.validPolls());
        assertEquals("arrival_pending_valid_poll", first.reason());
        assertEquals(DescentStepArrivalValidator.Status.REACHED, second.status());
        assertEquals(2, second.validPolls());
        assertEquals("arrival_validated", second.reason());
        assertEquals(DescentStepArrivalValidator.Status.REACHED, third.status());
        assertEquals(2, third.validPolls());
    }

    @Test
    void requiresExactCanonicalFeetAndHorizontalEpsilon() {
        DescentStepArrivalValidator validator = new DescentStepArrivalValidator();

        DescentStepArrivalValidator.Decision wrongCell = validator.tick(
            "command:step:1",
            observation(new VoxelCell(2, 14, -3), 0.1D, 0.42D, true, true, true, true, true)
        );
        DescentStepArrivalValidator.Decision outsideEpsilon = validator.tick(
            "command:step:1",
            observation(TARGET, 0.421D, 0.42D, true, true, true, true, true)
        );
        DescentStepArrivalValidator.Decision atBoundary = validator.tick(
            "command:step:1",
            observation(TARGET, 0.42D, 0.42D, true, true, true, true, true)
        );

        assertEquals(DescentStepArrivalValidator.Status.SUPPRESSED, wrongCell.status());
        assertEquals("arrival_canonical_feet_mismatch", wrongCell.reason());
        assertEquals(DescentStepArrivalValidator.Status.NOT_AT_TARGET, outsideEpsilon.status());
        assertEquals("horizontal_outside_epsilon", outsideEpsilon.reason());
        assertEquals(DescentStepArrivalValidator.Status.PENDING_VALID_POLL, atBoundary.status());
    }

    @Test
    void classifiesEverySafetySuppression() {
        List<DescentStepArrivalValidator.Observation> observations = List.of(
            observation(TARGET, 0.1D, 0.42D, false, true, true, true, true),
            observation(TARGET, 0.1D, 0.42D, true, false, true, true, true),
            observation(TARGET, 0.1D, 0.42D, true, true, false, true, true),
            observation(TARGET, 0.1D, 0.42D, true, true, true, false, true),
            observation(TARGET, 0.1D, 0.42D, true, true, true, true, false)
        );
        List<String> reasons = List.of(
            "arrival_not_grounded",
            "arrival_not_dry",
            "arrival_body_blocked",
            "arrival_hazard",
            "arrival_support_unstable"
        );

        for (int index = 0; index < observations.size(); index++) {
            DescentStepArrivalValidator validator = new DescentStepArrivalValidator();
            DescentStepArrivalValidator.Decision decision =
                validator.tick("command:step:1", observations.get(index));
            assertEquals(DescentStepArrivalValidator.Status.SUPPRESSED, decision.status());
            assertEquals(reasons.get(index), decision.reason());
            assertEquals(0, decision.validPolls());
            assertTrue(decision.suppressionEvent());
        }
    }

    @Test
    void unsafeStateOutranksCanonicalMismatchNearTheTarget() {
        DescentStepArrivalValidator validator = new DescentStepArrivalValidator();

        DescentStepArrivalValidator.Decision decision = validator.tick(
            "command:step:1",
            observation(
                new VoxelCell(2, 14, -3),
                0.1D,
                0.42D,
                false,
                true,
                true,
                true,
                true
            )
        );

        assertEquals(DescentStepArrivalValidator.Status.SUPPRESSED, decision.status());
        assertEquals("arrival_not_grounded", decision.reason());
    }

    @Test
    void unsafeStateOutranksHorizontalDistanceDuringApproach() {
        DescentStepArrivalValidator validator = new DescentStepArrivalValidator();

        DescentStepArrivalValidator.Decision decision = validator.tick(
            "command:step:1",
            observation(TARGET, 0.8D, 0.42D, true, true, true, true, false)
        );

        assertEquals(DescentStepArrivalValidator.Status.SUPPRESSED, decision.status());
        assertEquals("arrival_support_unstable", decision.reason());
    }

    @Test
    void invalidPollResetsTheConsecutiveSequence() {
        DescentStepArrivalValidator validator = new DescentStepArrivalValidator();

        assertEquals(
            DescentStepArrivalValidator.Status.PENDING_VALID_POLL,
            validator.tick("command:step:1", validObservation()).status()
        );
        assertEquals(
            DescentStepArrivalValidator.Status.SUPPRESSED,
            validator.tick(
                "command:step:1",
                observation(TARGET, 0.1D, 0.42D, true, false, true, true, true)
            ).status()
        );
        assertEquals(
            DescentStepArrivalValidator.Status.PENDING_VALID_POLL,
            validator.tick("command:step:1", validObservation()).status()
        );
        assertEquals(
            DescentStepArrivalValidator.Status.REACHED,
            validator.tick("command:step:1", validObservation()).status()
        );
    }

    @Test
    void suppressionsAreDeduplicatedPerStepAndReason() {
        DescentStepArrivalValidator validator = new DescentStepArrivalValidator();
        DescentStepArrivalValidator.Observation wet =
            observation(TARGET, 0.1D, 0.42D, true, false, true, true, true);
        DescentStepArrivalValidator.Observation unsupported =
            observation(TARGET, 0.1D, 0.42D, true, true, true, true, false);

        assertTrue(validator.tick("command:step:1", wet).suppressionEvent());
        assertFalse(validator.tick("command:step:1", wet).suppressionEvent());
        assertTrue(validator.tick("command:step:1", unsupported).suppressionEvent());
        assertFalse(validator.tick("command:step:1", unsupported).suppressionEvent());
        assertTrue(validator.tick("command:step:2", wet).suppressionEvent());

        validator.reset();
        assertTrue(validator.tick("command:step:2", wet).suppressionEvent());
        assertEquals("command:step:2", validator.activeStepKey());
        assertEquals(0, validator.validPolls());
    }

    @Test
    void invalidInputsFailClosedAndResetState() {
        DescentStepArrivalValidator validator = new DescentStepArrivalValidator();
        validator.tick("command:step:1", validObservation());

        DescentStepArrivalValidator.Decision nullObservation =
            validator.tick("command:step:1", null);
        assertEquals(DescentStepArrivalValidator.Status.NOT_AT_TARGET, nullObservation.status());
        assertEquals("invalid_position", nullObservation.reason());
        assertEquals(0, nullObservation.validPolls());

        DescentStepArrivalValidator.Decision invalidDistance = validator.tick(
            "command:step:1",
            observation(TARGET, Double.NaN, 0.42D, true, true, true, true, true)
        );
        assertEquals(DescentStepArrivalValidator.Status.NOT_AT_TARGET, invalidDistance.status());
        assertEquals("invalid_distance", invalidDistance.reason());

        DescentStepArrivalValidator.Decision invalidKey =
            validator.tick("", validObservation());
        assertEquals(DescentStepArrivalValidator.Status.NOT_AT_TARGET, invalidKey.status());
        assertEquals("invalid_step_key", invalidKey.reason());
        assertNull(validator.activeStepKey());
        assertEquals(0, validator.validPolls());
    }

    private static DescentStepArrivalValidator.Observation validObservation() {
        return observation(TARGET, 0.1D, 0.42D, true, true, true, true, true);
    }

    private static DescentStepArrivalValidator.Observation observation(
        VoxelCell canonicalFeet,
        double horizontalDistance,
        double arriveEpsilon,
        boolean grounded,
        boolean dry,
        boolean bodyClear,
        boolean hazardFree,
        boolean supportStable
    ) {
        return new DescentStepArrivalValidator.Observation(
            TARGET,
            canonicalFeet,
            horizontalDistance,
            arriveEpsilon,
            grounded,
            dry,
            bodyClear,
            hazardFree,
            supportStable
        );
    }
}
