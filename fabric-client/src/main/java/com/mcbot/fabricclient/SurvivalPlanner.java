package com.mcbot.fabricclient;

import java.util.Locale;

/**
 * Pure decision core for the R6 survival reflex: eat when hungry, retreat from a hostile when
 * health is low, and log out as a last resort when health is critical and recovery isn't
 * possible. Contains no Minecraft types, so it is fully unit-testable offline. The
 * {@link SurvivalController} feeds it observations read from the live client and executes the
 * chosen action. By design this is a fast-loop reflex, never a brain intent — survival must
 * never wait on the slow LLM advisor.
 */
final class SurvivalPlanner {
    private SurvivalPlanner() {
    }

    enum Mode {
        IDLE,
        EATING,
        RETREATING
    }

    enum Action {
        NONE,
        EAT,
        RETREAT,
        LOGOUT
    }

    /** Tunable thresholds, passed in so tests can pin exact boundaries. */
    record Config(
        int eatStartFoodLevel,
        int eatStopFoodLevel,
        float criticalHealth,
        float logoutHealth,
        double hostileRetreatRadius
    ) {
        static Config defaults() {
            return new Config(16, 18, 6.0F, 4.0F, 8.0D);
        }
    }

    record Observation(
        float health,
        int foodLevel,
        boolean hasEdibleFood,
        boolean onGround,
        double nearestHostileDistance
    ) {
        boolean hostileWithin(double radius) {
            return nearestHostileDistance >= 0.0D && nearestHostileDistance <= radius;
        }
    }

    record State(Mode mode) {
        State {
            mode = mode == null ? Mode.IDLE : mode;
        }

        static State idle() {
            return new State(Mode.IDLE);
        }

        State withMode(Mode next) {
            return new State(next);
        }
    }

    record Decision(State state, Action action, String reason) {
    }

    static Decision decide(State state, Observation obs, Config cfg) {
        boolean hostileNear = obs.hostileWithin(cfg.hostileRetreatRadius());

        // 1. Last-resort logout: critically low health AND either under threat or unable to recover.
        if (obs.health() <= cfg.logoutHealth() && (hostileNear || !obs.hasEdibleFood())) {
            String why = hostileNear ? "critical_health_hostile" : "critical_health_no_food";
            return new Decision(State.idle(), Action.LOGOUT, "logout:" + why + ":" + fmt(obs.health()));
        }

        // 2. Retreat: low health with a hostile in range — back away.
        if (obs.health() <= cfg.criticalHealth() && hostileNear) {
            return new Decision(
                state.withMode(Mode.RETREATING),
                Action.RETREAT,
                "retreat:hostile:" + fmt(obs.nearestHostileDistance())
            );
        }

        // 3. Eat: hungry, have food, on the ground, and safe enough to stand still. Hysteresis
        //    between start/stop food levels avoids flicker; an approaching hostile interrupts.
        if (state.mode() == Mode.EATING) {
            if (hostileNear) {
                return new Decision(State.idle(), Action.NONE, "eat_interrupt_hostile");
            }
            if (obs.foodLevel() >= cfg.eatStopFoodLevel() || !obs.hasEdibleFood()) {
                return new Decision(State.idle(), Action.NONE, "eat_complete:food=" + obs.foodLevel());
            }
            if (!obs.onGround()) {
                return new Decision(state, Action.NONE, "eat_pause_airborne");
            }
            return new Decision(state, Action.EAT, "eat_continue:food=" + obs.foodLevel());
        }
        if (obs.foodLevel() <= cfg.eatStartFoodLevel()
            && obs.hasEdibleFood()
            && obs.onGround()
            && !hostileNear) {
            return new Decision(state.withMode(Mode.EATING), Action.EAT, "eat_start:food=" + obs.foodLevel());
        }

        // 4. Nothing to do — hand control back to the normal loop.
        return new Decision(State.idle(), Action.NONE, "ok");
    }

    private static String fmt(double value) {
        return String.format(Locale.ROOT, "%.1f", value);
    }
}
