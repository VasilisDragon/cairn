package com.mcbot.fabricclient;

import java.util.HashMap;
import java.util.Map;
import java.util.List;

/** Bounded encounter accounting, independent of brain commands and changing combat reason strings. */
final class CombatEncounterTracker {
    static final long NO_PROGRESS_MS = 8_000L;
    static final long ENGAGEMENT_MS = 30_000L;
    static final long RECOVERY_MS = 12_000L;
    static final long CLEAR_MS = 2_000L;
    static final int MAX_TARGETS = 16;
    private static final long ATTACK_DAMAGE_WINDOW_MS = 2_000L;
    private static final double APPROACH_PROGRESS = 0.5D;

    record Target(String id, double playerX, double playerY, double playerZ,
                  double targetX, double targetY, double targetZ, double distance, float health) {
        boolean valid() {
            return id != null && !id.isBlank() && Double.isFinite(playerX) && Double.isFinite(playerY)
                && Double.isFinite(playerZ) && Double.isFinite(targetX) && Double.isFinite(targetY)
                && Double.isFinite(targetZ) && Double.isFinite(distance) && distance >= 0
                && Float.isFinite(health) && health >= 0;
        }
    }

    record Snapshot(long encounter, long activeMs, long noProgressMs, boolean recovering,
                    long recoveryMs, boolean exhausted, int trackedTargets, String progress, String trigger,
                    int approachProgressCount, int damageProgressCount) { }

    record Damage(String targetId, float health) { }

    private static final class Track {
        Target credited;
        double bestDistance;
        long attackAt = -1;
        float attackHealth;

        Track(Target first) { credited = first; bestDistance = first.distance(); }
    }

    private final Map<String, Track> targets = new HashMap<>();
    private long sequence;
    private long lastAt = -1;
    private long noHostilesAt = -1;
    private long activeMs;
    private long noProgressMs;
    private long recoveryAt = -1;
    private boolean engagedPreviously;
    private boolean started;
    private String trigger = "none";
    private int approachProgressCount;
    private int damageProgressCount;

    void reset() {
        targets.clear();
        lastAt = -1;
        noHostilesAt = -1;
        activeMs = 0;
        noProgressMs = 0;
        recoveryAt = -1;
        engagedPreviously = false;
        started = false;
        trigger = "none";
        approachProgressCount = 0;
        damageProgressCount = 0;
    }

    Snapshot tick(long observedNow, int sensedHostiles, boolean engaging, boolean actionable, Target target) {
        return tick(observedNow, sensedHostiles, engaging, actionable, target, List.of());
    }

    Snapshot tick(long observedNow, int sensedHostiles, boolean engaging, boolean actionable, Target target, List<Damage> observations) {
        // Clock rollback cannot refund time or extend the following interval.
        long now = Math.max(0L, Math.max(lastAt, observedNow));
        long delta = lastAt < 0 ? 0L : now - lastAt;
        if (engagedPreviously && started && recoveryAt < 0) {
            activeMs += delta;
            noProgressMs += delta;
        }
        lastAt = now;
        if (sensedHostiles == 0) {
            if (noHostilesAt < 0) noHostilesAt = now;
            if (now - noHostilesAt >= CLEAR_MS) {
                reset();
                lastAt = now;
            }
        } else {
            noHostilesAt = -1;
        }
        if (engaging && !started) {
            started = true;
            sequence++;
        }
        String progress = "none";
        if (started && recoveryAt < 0 && observations != null) {
            for (int i = 0; i < Math.min(MAX_TARGETS, observations.size()); i++) {
                Damage damage = observations.get(i);
                if (damage != null && creditDamage(targets.get(damage.targetId()), damage.health(), now)) {
                    progress = "applied_attack_damage";
                }
            }
        }
        if (engaging && recoveryAt < 0 && target != null && target.valid()) {
            Track track = targets.get(target.id());
            if (track == null && targets.size() < MAX_TARGETS) {
                track = new Track(target);
                targets.put(target.id(), track);
            } else if (track != null) {
                track.bestDistance = Math.min(track.bestDistance, target.distance());
                if (creditDamage(track, target.health(), now)) {
                    progress = "applied_attack_damage";
                } else if (track.bestDistance <= track.credited.distance() - APPROACH_PROGRESS
                    && target.distance() <= track.bestDistance + 1.0e-6D
                    && closingFromPlayerMovement(track.credited, target) >= APPROACH_PROGRESS) {
                    progress = "approach";
                    // Damage must not move this approach watermark: returning to an old best
                    // distance after attack knockback is not new approach progress.
                    track.credited = target;
                    noProgressMs = 0;
                    approachProgressCount++;
                }
            }
        }
        if (started && actionable && recoveryAt < 0
            && (noProgressMs >= NO_PROGRESS_MS || activeMs >= ENGAGEMENT_MS)) {
            recoveryAt = now;
            trigger = noProgressMs >= NO_PROGRESS_MS ? "no_progress" : "engagement_limit";
        }
        engagedPreviously = engaging && recoveryAt < 0;
        long recoveryMs = recoveryAt < 0 ? 0 : now - recoveryAt;
        return new Snapshot(sequence, activeMs, noProgressMs, recoveryAt >= 0, recoveryMs,
            actionable && recoveryAt >= 0 && recoveryMs >= RECOVERY_MS, targets.size(), progress, trigger,
            approachProgressCount, damageProgressCount);
    }

    void attackApplied(String targetId, float health, long now) {
        Track track = targets.get(targetId);
        if (track != null && Float.isFinite(health) && health >= 0) {
            track.attackAt = Math.max(lastAt, now);
            track.attackHealth = health;
        }
    }

    private boolean creditDamage(Track track, float health, long now) {
        if (track == null || track.attackAt < 0 || now - track.attackAt > ATTACK_DAMAGE_WINDOW_MS
            || !Float.isFinite(health) || health < 0 || health >= track.attackHealth) return false;
        track.attackAt = -1;
        noProgressMs = 0;
        damageProgressCount++;
        return true;
    }

    private static double closingFromPlayerMovement(Target prior, Target current) {
        // Freeze the target at the previous credited observation. Target-only motion cannot buy time.
        return distance(prior.playerX(), prior.playerY(), prior.playerZ(), prior.targetX(), prior.targetY(), prior.targetZ())
            - distance(current.playerX(), current.playerY(), current.playerZ(), prior.targetX(), prior.targetY(), prior.targetZ());
    }

    private static double distance(double ax, double ay, double az, double bx, double by, double bz) {
        return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by) + (az - bz) * (az - bz));
    }
}
