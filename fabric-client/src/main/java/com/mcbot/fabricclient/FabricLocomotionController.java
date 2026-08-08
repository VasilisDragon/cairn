package com.mcbot.fabricclient;

import java.util.Objects;

final class FabricLocomotionController {
    static final double FORWARD_ENGAGE_YAW_DEGREES = 12.0D;
    static final double FORWARD_RELEASE_YAW_DEGREES = 28.0D;
    static final long SPRINT_ENGAGE_MS = 150L;
    static final long JUMP_PULSE_MS = 150L;
    private static final float AXIS_EPSILON = 0.000_001F;

    record Observation(
        long nowMs,
        double playerYaw,
        boolean onGround,
        boolean touchingWater,
        VoxelCell groundedFeet,
        boolean actualSprinting
    ) {
        Observation {
            if (!Double.isFinite(playerYaw)) {
                throw new IllegalArgumentException("playerYaw must be finite");
            }
            if (onGround) {
                groundedFeet = Objects.requireNonNull(groundedFeet, "groundedFeet");
            }
        }
    }

    record State(
        boolean initialized,
        LookDemand.Owner owner,
        LocomotionDemand.Policy policy,
        String commandId,
        long routeGeneration,
        int waypointIndex,
        String segmentIdentity,
        boolean forwardEngaged,
        long sprintEligibleSinceMs,
        boolean sprintRequested,
        LocomotionDemand.StepIdentity activePulse,
        long pulseStartedAtMs,
        LocomotionDemand.StepIdentity disarmedPulse,
        LocomotionDemand.JumpPolicy disarmedPulsePolicy,
        VoxelCell lastGroundedFeet,
        long lastTickMs
    ) {
        static State initial() {
            return new State(
                false,
                null,
                null,
                "",
                -1L,
                -1,
                "",
                false,
                -1L,
                false,
                null,
                0L,
                null,
                LocomotionDemand.JumpPolicy.NONE,
                null,
                0L
            );
        }
    }

    record Output(
        InputState input,
        boolean sprintRequested,
        boolean actualSprinting,
        boolean passthrough,
        boolean forwardChanged,
        boolean sprintChanged,
        boolean jumpStarted,
        boolean jumpCompleted,
        boolean jumpRejected,
        boolean duplicateJumpSuppressed,
        double yawError
    ) {
    }

    record Transition(State state, Output output) {
    }

    private FabricLocomotionController() {
    }

    static State initialState() {
        return State.initial();
    }

    static Transition step(
        State previous,
        LocomotionDemand demand,
        Observation observation
    ) {
        State prior = previous == null ? State.initial() : previous;
        Objects.requireNonNull(demand, "demand");
        Objects.requireNonNull(observation, "observation");

        if (demand.policy() == LocomotionDemand.Policy.PASSTHROUGH
            || !forwardOnly(demand.rawInput())) {
            State next = passiveState(demand, observation);
            return transition(
                prior,
                next,
                demand.rawInput(),
                demand.legacySprintRequested(),
                observation.actualSprinting(),
                true,
                false,
                false,
                false,
                0.0D
            );
        }

        boolean clockReset = prior.initialized() && observation.nowMs() < prior.lastTickMs();
        boolean sameScope = !clockReset && sameRouteScope(prior, demand);
        boolean sameWaypoint = sameScope
            && demand.waypointIndex() == prior.waypointIndex()
            && demand.segmentIdentity().equals(prior.segmentIdentity());
        boolean forwardContinuation = sameScope
            && demand.waypointIndex() == prior.waypointIndex() + 1
            && demand.preserveFromPrevious();
        boolean preserveMotion = sameWaypoint || forwardContinuation;
        boolean groundedProgress = observation.onGround()
            && observation.groundedFeet() != null
            && prior.lastGroundedFeet() != null
            && !observation.groundedFeet().equals(prior.lastGroundedFeet());
        boolean routeProgress = sameScope && demand.waypointIndex() > prior.waypointIndex();
        boolean activePulseAdvanced = sameScope
            && prior.activePulse() != null
            && demand.waypointIndex() > prior.activePulse().waypointIndex();
        LocomotionDemand.StepIdentity disarmedPulse = sameScope
            ? prior.disarmedPulse()
            : null;
        LocomotionDemand.JumpPolicy disarmedPulsePolicy = disarmedPulse == null
            ? LocomotionDemand.JumpPolicy.NONE
            : prior.disarmedPulsePolicy();
        boolean stepAdvanced = disarmedPulse != null
            && routeProgress
            && demand.waypointIndex() > disarmedPulse.waypointIndex();
        boolean unstickProgress = disarmedPulse != null
            && disarmedPulsePolicy == LocomotionDemand.JumpPolicy.UNSTICK_PULSE
            && groundedProgress;
        if (stepAdvanced || unstickProgress) {
            disarmedPulse = null;
            disarmedPulsePolicy = LocomotionDemand.JumpPolicy.NONE;
        }

        double yawError = Math.abs(
            LookController.shortestYawDelta(observation.playerYaw(), demand.desiredYaw())
        );
        boolean rawForward = rawForwardPermitted(demand.rawInput());
        boolean forward = rawForward
            && (preserveMotion && prior.forwardEngaged()
                ? yawError <= FORWARD_RELEASE_YAW_DEGREES
                : yawError <= FORWARD_ENGAGE_YAW_DEGREES);

        LocomotionDemand.StepIdentity activePulse = sameScope
            && prior.activePulse() != null
            && prior.activePulse().equals(demand.stepIdentity())
                ? prior.activePulse()
                : null;
        long pulseStartedAtMs = activePulse == null ? 0L : prior.pulseStartedAtMs();
        boolean jumpStarted = false;
        boolean jumpCompleted = activePulseAdvanced;
        boolean jumpRejected = false;
        boolean duplicateJumpSuppressed = false;
        boolean jump = false;
        boolean pulseDemand = isPulse(demand.jumpPolicy()) && demand.rawInput().jumping();

        if (activePulse != null) {
            boolean stillRequested = activePulse.equals(demand.stepIdentity());
            if (!stillRequested) {
                activePulse = null;
                pulseStartedAtMs = 0L;
            } else if (!observation.onGround()) {
                disarmedPulse = activePulse;
                disarmedPulsePolicy = demand.jumpPolicy();
                activePulse = null;
                pulseStartedAtMs = 0L;
                jumpCompleted = true;
            } else if (elapsed(observation.nowMs(), pulseStartedAtMs) >= JUMP_PULSE_MS) {
                disarmedPulse = activePulse;
                disarmedPulsePolicy = demand.jumpPolicy();
                activePulse = null;
                pulseStartedAtMs = 0L;
                jumpRejected = true;
            } else {
                jump = true;
            }
        }

        if (activePulse == null && pulseDemand && !jumpCompleted && !jumpRejected) {
            boolean disarmedStepNotAdvanced = disarmedPulse != null
                && disarmedPulsePolicy == LocomotionDemand.JumpPolicy.STEP_PULSE
                && sameScope
                && demand.waypointIndex() <= disarmedPulse.waypointIndex();
            if (demand.stepIdentity().equals(disarmedPulse) || disarmedStepNotAdvanced) {
                duplicateJumpSuppressed = true;
            } else if (observation.onGround()
                && yawError <= FORWARD_ENGAGE_YAW_DEGREES
                && forward) {
                activePulse = demand.stepIdentity();
                pulseStartedAtMs = observation.nowMs();
                jump = true;
                jumpStarted = true;
            }
        } else if (!isPulse(demand.jumpPolicy())) {
            jump = demand.jumpPolicy() == LocomotionDemand.JumpPolicy.CONTINUOUS
                && demand.rawInput().jumping();
        }

        boolean sprintEligible = forward
            && demand.sprintEligible()
            && !demand.routeEnd()
            && !jump
            && observation.onGround()
            && !demand.rawInput().sneaking()
            && !observation.touchingWater();
        long sprintEligibleSinceMs = -1L;
        boolean sprintRequested = false;
        if (sprintEligible) {
            boolean retainSprintClock = preserveMotion
                && prior.sprintEligibleSinceMs() >= 0L
                && !clockReset;
            sprintEligibleSinceMs = retainSprintClock
                ? prior.sprintEligibleSinceMs()
                : observation.nowMs();
            sprintRequested = elapsed(observation.nowMs(), sprintEligibleSinceMs)
                >= SPRINT_ENGAGE_MS;
        }

        InputState applied = new InputState(
            forward,
            false,
            false,
            false,
            jump,
            demand.rawInput().sneaking(),
            forward ? 1.0F : 0.0F,
            0.0F
        );
        VoxelCell groundedFeet = observation.onGround()
            ? observation.groundedFeet()
            : prior.lastGroundedFeet();
        State next = new State(
            true,
            demand.owner(),
            demand.policy(),
            demand.commandId(),
            demand.routeGeneration(),
            demand.waypointIndex(),
            demand.segmentIdentity(),
            forward,
            sprintEligibleSinceMs,
            sprintRequested,
            activePulse,
            pulseStartedAtMs,
            disarmedPulse,
            disarmedPulsePolicy,
            groundedFeet,
            observation.nowMs()
        );
        return transition(
            prior,
            next,
            applied,
            sprintRequested,
            observation.actualSprinting(),
            false,
            jumpStarted,
            jumpCompleted,
            jumpRejected,
            duplicateJumpSuppressed,
            yawError
        );
    }

    private static boolean sameRouteScope(State state, LocomotionDemand demand) {
        return state.initialized()
            && state.owner() == demand.owner()
            && state.policy() == demand.policy()
            && state.commandId().equals(demand.commandId())
            && state.routeGeneration() == demand.routeGeneration();
    }

    private static boolean forwardOnly(InputState input) {
        return input != null
            && !input.pressingBack()
            && !input.pressingLeft()
            && !input.pressingRight()
            && Math.abs(input.movementSideways()) <= AXIS_EPSILON;
    }

    private static boolean rawForwardPermitted(InputState input) {
        return input.pressingForward() && input.movementForward() > AXIS_EPSILON;
    }

    private static boolean isPulse(LocomotionDemand.JumpPolicy policy) {
        return policy == LocomotionDemand.JumpPolicy.STEP_PULSE
            || policy == LocomotionDemand.JumpPolicy.UNSTICK_PULSE;
    }

    private static long elapsed(long nowMs, long sinceMs) {
        return Math.max(0L, nowMs - sinceMs);
    }

    private static State passiveState(
        LocomotionDemand demand,
        Observation observation
    ) {
        return new State(
            true,
            demand.owner(),
            demand.policy(),
            demand.commandId(),
            demand.routeGeneration(),
            demand.waypointIndex(),
            demand.segmentIdentity(),
            false,
            -1L,
            demand.legacySprintRequested(),
            null,
            0L,
            null,
            LocomotionDemand.JumpPolicy.NONE,
            observation.onGround() ? observation.groundedFeet() : null,
            observation.nowMs()
        );
    }

    private static Transition transition(
        State prior,
        State next,
        InputState input,
        boolean sprintRequested,
        boolean actualSprinting,
        boolean passthrough,
        boolean jumpStarted,
        boolean jumpCompleted,
        boolean jumpRejected,
        double yawError
    ) {
        return transition(
            prior,
            next,
            input,
            sprintRequested,
            actualSprinting,
            passthrough,
            jumpStarted,
            jumpCompleted,
            jumpRejected,
            false,
            yawError
        );
    }

    private static Transition transition(
        State prior,
        State next,
        InputState input,
        boolean sprintRequested,
        boolean actualSprinting,
        boolean passthrough,
        boolean jumpStarted,
        boolean jumpCompleted,
        boolean jumpRejected,
        boolean duplicateJumpSuppressed,
        double yawError
    ) {
        Output output = new Output(
            input,
            sprintRequested,
            actualSprinting,
            passthrough,
            prior.forwardEngaged() != next.forwardEngaged(),
            prior.sprintRequested() != next.sprintRequested(),
            jumpStarted,
            jumpCompleted,
            jumpRejected,
            duplicateJumpSuppressed,
            yawError
        );
        return new Transition(next, output);
    }
}
