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
        RETREATING,
        SURFACING,
        WADING_OUT
    }

    enum Action {
        NONE,
        EAT,
        RETREAT,
        SWIM_UP,
        SWIM_TO_SHORE,
        LOGOUT
    }

    /** Tunable thresholds, passed in so tests can pin exact boundaries. */
    record Config(
        int eatStartFoodLevel,
        int eatStopFoodLevel,
        float criticalHealth,
        float logoutHealth,
        double hostileRetreatRadius,
        int swimUpStartAir,
        int swimUpStopAir
    ) {
        static Config defaults() {
            // Air starts at 300 and drowning damage only begins once it is fully exhausted, so
            // engaging at 240 leaves ~12 s of margin; releasing at 290 (hysteresis) prevents
            // flapping at the surface.
            return new Config(16, 18, 6.0F, 4.0F, 8.0D, 240, 290);
        }
    }

    record Observation(
        float health,
        int foodLevel,
        boolean hasEdibleFood,
        boolean onGround,
        double nearestHostileDistance,
        boolean touchingWater,
        boolean submergedInWater,
        int airSupply,
        boolean dryStable
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

        // 2. Drowning reflex: meaningfully low on air while in water — swim up NOW. This engages
        //    long before damage exists (air 240 of 300), so in open water it fires while health is
        //    still full; the logout rule above remains the last-resort net for a trapped pocket
        //    where surfacing is impossible. Drowning outranks hostiles: the bot cannot fight while
        //    suffocating. Once air recovers, control is NOT handed straight back — that produced
        //    a surface-bob-sink loop (the mission sank the bot again and
        //    the reflex re-fired). WADING_OUT keeps the reflex in charge until the bot is standing
        //    on dry land, stable (the dry-land drive lives in the controller, ported from the
        //    proven mineflayer water-escape system).
        if (state.mode() == Mode.SURFACING) {
            if (!obs.touchingWater() || obs.airSupply() >= cfg.swimUpStopAir()) {
                return new Decision(state.withMode(Mode.WADING_OUT), Action.SWIM_TO_SHORE, "swim_to_shore_start:air=" + obs.airSupply());
            }
            return new Decision(state, Action.SWIM_UP, "swim_up_continue:air=" + obs.airSupply());
        }
        if (state.mode() == Mode.WADING_OUT) {
            if (obs.submergedInWater() && obs.airSupply() < cfg.swimUpStartAir()) {
                return new Decision(state.withMode(Mode.SURFACING), Action.SWIM_UP, "swim_up_restart:air=" + obs.airSupply());
            }
            if (obs.dryStable()) {
                return new Decision(State.idle(), Action.NONE, "swim_to_shore_complete");
            }
            return new Decision(state, Action.SWIM_TO_SHORE, "swim_to_shore_continue");
        }
        if (obs.submergedInWater() && obs.airSupply() < cfg.swimUpStartAir()) {
            return new Decision(state.withMode(Mode.SURFACING), Action.SWIM_UP, "swim_up_start:air=" + obs.airSupply());
        }

        // 3. Retreat: low health with a hostile in range — back away.
        if (obs.health() <= cfg.criticalHealth() && hostileNear) {
            return new Decision(
                state.withMode(Mode.RETREATING),
                Action.RETREAT,
                "retreat:hostile:" + fmt(obs.nearestHostileDistance())
            );
        }

        // 4. Eat: hungry, have food, on the ground, and safe enough to stand still. Hysteresis
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

        // 5. Nothing to do — hand control back to the normal loop.
        return new Decision(State.idle(), Action.NONE, "ok");
    }

    private static String fmt(double value) {
        return String.format(Locale.ROOT, "%.1f", value);
    }
}
