package com.mcbot.fabricclient;

/** Positive evidence is required to defer a distant melee mob; uncertainty keeps it actionable. */
final class CombatThreatAdmission {
    static final double DEFERRAL_MIN_DISTANCE = 8.0D;
    static final double DEFERRAL_MAX_DISTANCE = 16.0D;
    static final long DAMAGE_QUIET_MS = 5_000L;
    static final int MAX_PROBES_PER_TICK = 8;

    enum Visibility { BLOCKED, CLEAR, UNKNOWN }

    record Observation(
        CombatPlanner.ThreatKind kind, double distance, double sensingRadius,
        Visibility eye, Visibility torso, boolean grounded, boolean dry,
        float health, float fleeHealth, long damageQuietMs
    ) { }

    private CombatThreatAdmission() { }

    static final class ProbeBudget {
        private int used;
        boolean acquire(Observation observation) {
            if (used >= MAX_PROBES_PER_TICK || !canProbe(observation)) return false;
            used++;
            return true;
        }
        int used() { return used; }
    }

    static CombatPlanner.ThreatKind deferralKind(String type, CombatPlanner.ThreatKind existingKind) {
        // The legacy combat planner defaults unfamiliar hostiles to MELEE. That fallback is not
        // positive evidence: witches and weapon-dependent drowned must stay actionable.
        if (existingKind != CombatPlanner.ThreatKind.MELEE || type == null) return CombatPlanner.ThreatKind.NONE;
        if (type.contains(":")) {
            if (!type.startsWith("minecraft:")) return CombatPlanner.ThreatKind.NONE;
            type = type.substring("minecraft:".length());
        }
        return switch (type) {
            case "zombie", "husk", "zombie_villager", "spider", "cave_spider", "silverfish", "endermite", "vindicator" -> existingKind;
            default -> CombatPlanner.ThreatKind.NONE;
        };
    }

    static String reason(Observation o, boolean probeBudgetExhausted) {
        if (o == null) return "missing_observation";
        if (o.kind() != CombatPlanner.ThreatKind.MELEE) return "non_melee_or_unknown";
        if (!Double.isFinite(o.distance()) || !Double.isFinite(o.sensingRadius())) return "unknown_distance";
        if (o.distance() <= DEFERRAL_MIN_DISTANCE || o.distance() > Math.min(DEFERRAL_MAX_DISTANCE, o.sensingRadius())) return "outside_deferral_band";
        if (!o.grounded() || !o.dry()) return "unsafe_stance";
        if (!Float.isFinite(o.health()) || !Float.isFinite(o.fleeHealth()) || o.health() <= o.fleeHealth()) return "low_or_unknown_health";
        if (o.damageQuietMs() < DAMAGE_QUIET_MS) return "recent_or_unknown_damage";
        if (probeBudgetExhausted) return "probe_budget";
        if (o.eye() == Visibility.CLEAR || o.torso() == Visibility.CLEAR) return "target_visible";
        return defer(o) ? "both_colliders_blocked" : "unknown_visibility";
    }

    static boolean canProbe(Observation o) {
        return o != null && o.kind() == CombatPlanner.ThreatKind.MELEE
            && Double.isFinite(o.distance()) && Double.isFinite(o.sensingRadius())
            && o.distance() > DEFERRAL_MIN_DISTANCE && o.distance() <= Math.min(DEFERRAL_MAX_DISTANCE, o.sensingRadius())
            && o.grounded() && o.dry() && Float.isFinite(o.health())
            && Float.isFinite(o.fleeHealth()) && o.health() > o.fleeHealth()
            && o.damageQuietMs() >= DAMAGE_QUIET_MS;
    }

    static boolean defer(Observation o) {
        return canProbe(o) && o.eye() == Visibility.BLOCKED && o.torso() == Visibility.BLOCKED;
    }
}
