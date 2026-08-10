package com.mcbot.fabricclient;

import java.util.Objects;

record LocomotionDemand(
    LookDemand.Owner owner,
    Policy policy,
    InputState rawInput,
    boolean legacySprintRequested,
    String commandId,
    long routeGeneration,
    int waypointIndex,
    String segmentIdentity,
    double desiredYaw,
    boolean preserveFromPrevious,
    boolean routeEnd,
    boolean sprintEligible,
    JumpPolicy jumpPolicy,
    StepIdentity stepIdentity,
    String reason
) {
    enum Policy {
        ROUTE_TRAVEL,
        PASSTHROUGH
    }

    enum JumpPolicy {
        NONE,
        STEP_PULSE,
        UNSTICK_PULSE,
        CONTINUOUS
    }

    record StepIdentity(
        String commandId,
        long routeGeneration,
        int waypointIndex,
        VoxelCell origin,
        VoxelCell landing
    ) {
        StepIdentity {
            commandId = requireText(commandId, "commandId");
            if (routeGeneration < 0L) {
                throw new IllegalArgumentException("routeGeneration must be non-negative");
            }
            if (waypointIndex < 0) {
                throw new IllegalArgumentException("waypointIndex must be non-negative");
            }
            origin = Objects.requireNonNull(origin, "origin");
            landing = Objects.requireNonNull(landing, "landing");
        }
    }

    LocomotionDemand {
        owner = Objects.requireNonNull(owner, "owner");
        policy = Objects.requireNonNull(policy, "policy");
        rawInput = Objects.requireNonNull(rawInput, "rawInput");
        commandId = requireText(commandId, "commandId");
        segmentIdentity = requireText(segmentIdentity, "segmentIdentity");
        jumpPolicy = Objects.requireNonNull(jumpPolicy, "jumpPolicy");
        reason = requireText(reason, "reason");
        if (!Double.isFinite(desiredYaw)) {
            throw new IllegalArgumentException("desiredYaw must be finite");
        }
        desiredYaw = LookController.normalizeYaw(desiredYaw);
        if (policy == Policy.ROUTE_TRAVEL) {
            if (routeGeneration < 0L) {
                throw new IllegalArgumentException("routeGeneration must be non-negative");
            }
            if (waypointIndex < 0) {
                throw new IllegalArgumentException("waypointIndex must be non-negative");
            }
        }
        boolean pulse = jumpPolicy == JumpPolicy.STEP_PULSE
            || jumpPolicy == JumpPolicy.UNSTICK_PULSE;
        if (pulse != (stepIdentity != null)) {
            throw new IllegalArgumentException(
                pulse
                    ? "pulse jump policy requires stepIdentity"
                    : "stepIdentity requires a pulse jump policy"
            );
        }
        if (stepIdentity != null
            && (!commandId.equals(stepIdentity.commandId())
                || routeGeneration != stepIdentity.routeGeneration()
                || waypointIndex != stepIdentity.waypointIndex())) {
            throw new IllegalArgumentException(
                "stepIdentity must match commandId, routeGeneration, and waypointIndex"
            );
        }
    }

    static LocomotionDemand passthrough(
        LookDemand.Owner owner,
        InputState rawInput,
        boolean legacySprintRequested,
        String commandId,
        String reason
    ) {
        String command = textOr(commandId, "uncommanded");
        String stableReason = textOr(reason, "passthrough");
        return new LocomotionDemand(
            owner,
            Policy.PASSTHROUGH,
            rawInput,
            legacySprintRequested,
            command,
            0L,
            0,
            "passthrough:" + command + ":" + stableReason,
            0.0D,
            false,
            false,
            false,
            JumpPolicy.CONTINUOUS,
            null,
            stableReason
        );
    }

    private static String textOr(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }

    private static String requireText(String value, String name) {
        Objects.requireNonNull(value, name);
        if (value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return value;
    }
}
