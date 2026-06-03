package com.mcbot.fabricclient;

import java.util.Locale;

final class DescentControlPlanner {
    private DescentControlPlanner() {
    }

    enum Stage {
        BREAK_SIGHT,
        BREAK_UPPER,
        BREAK_LOWER,
        MOVE_TO_STEP
    }

    enum Action {
        CONTINUE,
        FAIL_TIMEOUT,
        FAIL_HEALTH_LOST,
        FAIL_PLAYER_HAZARD,
        WAIT_ON_GROUND,
        FAIL_HOSTILE_NEARBY,
        RUN_IRON_CLEANUP,
        COMPLETE,
        FAIL_SELF_SUPPORT,
        FAIL_OVERSHOT_STEP,
        STEP_REACHED,
        REROUTE_OR_FAIL,
        BREAK_SIGHT,
        BREAK_UPPER,
        BREAK_LOWER,
        MOVE_TO_STEP
    }

    record State(int stepIndex, int depthReached, Stage stage) {
        State {
            stepIndex = Math.max(1, stepIndex);
            depthReached = Math.max(0, depthReached);
            stage = stage == null ? Stage.BREAK_SIGHT : stage;
        }

        State withStage(Stage nextStage) {
            return new State(stepIndex, depthReached, nextStage);
        }

        State afterStepReached() {
            return new State(stepIndex + 1, depthReached + 1, Stage.BREAK_SIGHT);
        }
    }

    record PreflightObservation(
        long elapsedMs,
        long timeoutMs,
        float healthBefore,
        float currentHealth,
        String playerHazardReason,
        boolean onGround,
        double nearestHostileDistance,
        double hostileAbortRadius
    ) {
    }

    record StepObservation(
        boolean ironCleanupAvailable,
        boolean complete,
        boolean targetsSelfSupport,
        boolean overshotStep,
        boolean reachedStep,
        String unsafeReason,
        boolean sightClearAir,
        boolean upperClearAir,
        boolean lowerClearAir
    ) {
    }

    record Decision(State state, Action action, String reason) {
    }

    static Decision decidePreflight(State state, PreflightObservation observation) {
        if (observation.elapsedMs() > observation.timeoutMs()) {
            return new Decision(state, Action.FAIL_TIMEOUT, "descent_timeout");
        }
        if (observation.currentHealth() + 0.1F < observation.healthBefore()) {
            return new Decision(state, Action.FAIL_HEALTH_LOST, "descent_health_lost");
        }
        if (observation.playerHazardReason() != null) {
            return new Decision(state, Action.FAIL_PLAYER_HAZARD, observation.playerHazardReason());
        }
        if (!observation.onGround()) {
            return new Decision(state, Action.WAIT_ON_GROUND, "descent_waiting_on_ground");
        }
        if (observation.nearestHostileDistance() >= 0.0D
            && observation.nearestHostileDistance() <= observation.hostileAbortRadius()) {
            return new Decision(
                state,
                Action.FAIL_HOSTILE_NEARBY,
                "descent_hostile_nearby:" + String.format(Locale.ROOT, "%.2f", observation.nearestHostileDistance())
            );
        }
        return new Decision(state, Action.CONTINUE, "");
    }

    static Decision decideStep(State state, StepObservation observation) {
        if (observation.ironCleanupAvailable()) {
            return new Decision(state, Action.RUN_IRON_CLEANUP, "descent_iron_cleanup");
        }
        if (observation.complete()) {
            return new Decision(state, Action.COMPLETE, "target_depth_reached");
        }
        if (observation.targetsSelfSupport()) {
            return new Decision(state, Action.FAIL_SELF_SUPPORT, "descent_self_support_target_refused");
        }
        if (observation.overshotStep()) {
            return new Decision(state, Action.FAIL_OVERSHOT_STEP, "descent_overshot_step");
        }
        if (observation.reachedStep()) {
            return new Decision(state.afterStepReached(), Action.STEP_REACHED, "descent_step_reached");
        }
        if (observation.unsafeReason() != null) {
            return new Decision(state, Action.REROUTE_OR_FAIL, observation.unsafeReason());
        }

        Stage stage = state.stage();
        if (stage == Stage.BREAK_SIGHT && observation.sightClearAir()) {
            stage = Stage.BREAK_UPPER;
        }
        if (stage == Stage.BREAK_UPPER && observation.upperClearAir()) {
            stage = Stage.BREAK_LOWER;
        }
        if (stage == Stage.BREAK_LOWER && observation.lowerClearAir()) {
            stage = Stage.MOVE_TO_STEP;
        }
        return switch (stage) {
            case BREAK_SIGHT -> new Decision(state.withStage(stage), Action.BREAK_SIGHT, "descent_break_sight");
            case BREAK_UPPER -> new Decision(state.withStage(stage), Action.BREAK_UPPER, "descent_break_upper");
            case BREAK_LOWER -> new Decision(state.withStage(stage), Action.BREAK_LOWER, "descent_break_lower");
            case MOVE_TO_STEP -> new Decision(state.withStage(stage), Action.MOVE_TO_STEP, "descent_move_to_step");
        };
    }
}
