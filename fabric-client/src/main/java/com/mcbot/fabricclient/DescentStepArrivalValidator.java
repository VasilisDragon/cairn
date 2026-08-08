package com.mcbot.fabricclient;

import java.util.HashSet;
import java.util.Set;

final class DescentStepArrivalValidator {
    static final int REQUIRED_VALID_POLLS = 2;

    enum Status {
        NOT_AT_TARGET,
        PENDING_VALID_POLL,
        REACHED,
        SUPPRESSED
    }

    record Observation(
        VoxelCell plannedFeet,
        VoxelCell canonicalFeet,
        double horizontalDistance,
        double arriveEpsilon,
        boolean grounded,
        boolean dry,
        boolean bodyClear,
        boolean hazardFree,
        boolean supportStable
    ) {
    }

    record Decision(
        Status status,
        String reason,
        int validPolls,
        boolean suppressionEvent
    ) {
    }

    private String activeStepKey;
    private int validPolls;
    private final Set<String> emittedSuppressionReasons = new HashSet<>();

    Decision tick(String stepKey, Observation observation) {
        if (stepKey == null || stepKey.isBlank()) {
            reset();
            return notAtTarget("invalid_step_key");
        }
        if (!stepKey.equals(activeStepKey)) {
            beginStep(stepKey);
        }
        if (observation == null
            || observation.plannedFeet() == null
            || observation.canonicalFeet() == null) {
            validPolls = 0;
            return notAtTarget("invalid_position");
        }
        if (!Double.isFinite(observation.horizontalDistance())
            || !Double.isFinite(observation.arriveEpsilon())
            || observation.horizontalDistance() < 0.0D
            || observation.arriveEpsilon() < 0.0D) {
            validPolls = 0;
            return notAtTarget("invalid_distance");
        }
        String suppressionReason = suppressionReason(observation);
        if (suppressionReason != null) {
            validPolls = 0;
            return new Decision(
                Status.SUPPRESSED,
                suppressionReason,
                0,
                emittedSuppressionReasons.add(suppressionReason)
            );
        }
        if (observation.horizontalDistance() > observation.arriveEpsilon()) {
            validPolls = 0;
            return notAtTarget("horizontal_outside_epsilon");
        }
        if (!observation.canonicalFeet().equals(observation.plannedFeet())) {
            validPolls = 0;
            String reason = "arrival_canonical_feet_mismatch";
            return new Decision(
                Status.SUPPRESSED,
                reason,
                0,
                emittedSuppressionReasons.add(reason)
            );
        }

        validPolls = Math.min(REQUIRED_VALID_POLLS, validPolls + 1);
        if (validPolls < REQUIRED_VALID_POLLS) {
            return new Decision(
                Status.PENDING_VALID_POLL,
                "arrival_pending_valid_poll",
                validPolls,
                false
            );
        }
        return new Decision(Status.REACHED, "arrival_validated", validPolls, false);
    }

    void reset() {
        activeStepKey = null;
        validPolls = 0;
        emittedSuppressionReasons.clear();
    }

    String activeStepKey() {
        return activeStepKey;
    }

    int validPolls() {
        return validPolls;
    }

    private void beginStep(String stepKey) {
        activeStepKey = stepKey;
        validPolls = 0;
        emittedSuppressionReasons.clear();
    }

    private Decision notAtTarget(String reason) {
        return new Decision(Status.NOT_AT_TARGET, reason, validPolls, false);
    }

    private static String suppressionReason(Observation observation) {
        if (!observation.grounded()) {
            return "arrival_not_grounded";
        }
        if (!observation.dry()) {
            return "arrival_not_dry";
        }
        if (!observation.bodyClear()) {
            return "arrival_body_blocked";
        }
        if (!observation.hazardFree()) {
            return "arrival_hazard";
        }
        if (!observation.supportStable()) {
            return "arrival_support_unstable";
        }
        return null;
    }
}
