package com.mcbot.fabricclient;

import java.util.Locale;

/**
 * Pure decision core for the R7 combat reflex: assess nearby hostiles and decide whether to ENGAGE
 * (melee the nearest), FLEE (create distance), LOG OUT (last resort), or do NOTHING. Contains no
 * Minecraft types, so it is fully unit-testable offline. The {@link CombatController} feeds it
 * observations read from the live client and executes the chosen action. Like survival, this is a
 * fast-loop reflex — threat response must never wait on the slow LLM advisor.
 *
 * <p>First slice (R7): engage a single weak melee/ranged hostile when armed and healthy; flee when
 * outnumbered, unarmed, low on health, or facing an explosive (creeper); log out as a last resort.
 * Mob groups, ranged kiting, creeper tactics, and the late-game fights are deliberately out of scope.
 */
final class CombatPlanner {
    private CombatPlanner() {
    }

    enum Mode {
        IDLE,
        ENGAGING,
        FLEEING
    }

    enum Action {
        NONE,
        ENGAGE,
        FLEE,
        LOGOUT
    }

    /** Coarse threat classification of the nearest hostile (the controller maps entity type -> kind). */
    enum ThreatKind {
        NONE,
        MELEE,
        RANGED,
        EXPLOSIVE
    }

    record Config(
        float fleeHealth,
        float logoutHealth,
        int maxEngageHostiles,
        double engageRadius
    ) {
        static Config defaults() {
            // Engage up to 3 hostiles within 16 blocks while healthy + armed; flee at <=8 health or
            // when outnumbered (>3) / unarmed / facing a creeper; log out as a last resort at <=4 health.
            return new Config(8.0F, 4.0F, 3, 16.0D);
        }
    }

    record Observation(
        float health,
        int hostileCount,
        double nearestHostileDistance,
        ThreatKind nearestKind,
        boolean hasWeapon,
        boolean onGround
    ) {
        boolean hasHostile() {
            return nearestKind != ThreatKind.NONE && nearestHostileDistance >= 0.0D;
        }

        boolean within(double radius) {
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
        // No threat in range -> stand down and hand control back to the normal loop.
        if (!obs.hasHostile() || !obs.within(cfg.engageRadius())) {
            return new Decision(State.idle(), Action.NONE, "no_threat");
        }

        // 1. Last-resort logout: critically low health with a hostile present.
        if (obs.health() <= cfg.logoutHealth()) {
            return new Decision(State.idle(), Action.LOGOUT, "logout:critical_health:" + fmt(obs.health()));
        }

        // 2. Flee when we cannot safely win.
        if (obs.health() <= cfg.fleeHealth()) {
            return new Decision(state.withMode(Mode.FLEEING), Action.FLEE, "flee:low_health:" + fmt(obs.health()));
        }
        if (obs.hostileCount() > cfg.maxEngageHostiles()) {
            return new Decision(state.withMode(Mode.FLEEING), Action.FLEE, "flee:outnumbered:" + obs.hostileCount());
        }
        if (!obs.hasWeapon()) {
            return new Decision(state.withMode(Mode.FLEEING), Action.FLEE, "flee:unarmed");
        }
        if (obs.nearestKind() == ThreatKind.EXPLOSIVE) {
            return new Decision(state.withMode(Mode.FLEEING), Action.FLEE, "flee:explosive:" + fmt(obs.nearestHostileDistance()));
        }

        // 3. Engage: a single hostile, healthy, armed, not an explosive.
        return new Decision(
            state.withMode(Mode.ENGAGING),
            Action.ENGAGE,
            "engage:" + obs.nearestKind().name().toLowerCase(Locale.ROOT) + ":" + fmt(obs.nearestHostileDistance())
        );
    }

    private static String fmt(double value) {
        return String.format(Locale.ROOT, "%.1f", value);
    }
}
