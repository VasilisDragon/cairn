package com.mcbot.fabricclient;

/** Pure turn-rate-limited look control. No Minecraft types by design. */
public final class LookController {
    public static final double DEFAULT_EASE_GAIN = 0.35D;
    public static final double DEFAULT_MIN_DEG_PER_TICK = 0.25D;

    private LookController() {
    }

    public record Look(double yaw, double pitch) {
    }

    public static Look nextLook(
        double curYaw,
        double curPitch,
        double targetYaw,
        double targetPitch,
        double maxDegPerTick
    ) {
        return nextLook(curYaw, curPitch, targetYaw, targetPitch, maxDegPerTick, DEFAULT_EASE_GAIN, DEFAULT_MIN_DEG_PER_TICK);
    }

    public static Look nextLook(
        double curYaw,
        double curPitch,
        double targetYaw,
        double targetPitch,
        double maxDegPerTick,
        double easeGain,
        double minDegPerTick
    ) {
        double step = Math.max(0.0D, Math.abs(maxDegPerTick));
        double gain = Math.max(0.0D, easeGain);
        double minStep = Math.max(0.0D, Math.min(Math.abs(minDegPerTick), step));
        double safeCurPitch = clamp(curPitch, -90.0D, 90.0D);
        double safeTargetPitch = clamp(targetPitch, -90.0D, 90.0D);

        double yawDelta = shortestYawDelta(curYaw, targetYaw);
        double pitchDelta = safeTargetPitch - safeCurPitch;

        double nextYaw = normalizeYaw(curYaw + easedStep(yawDelta, step, gain, minStep));
        double nextPitch = clamp(safeCurPitch + easedStep(pitchDelta, step, gain, minStep), -90.0D, 90.0D);
        return new Look(nextYaw, nextPitch);
    }

    public static double shortestYawDelta(double curYaw, double targetYaw) {
        double delta = normalizeYaw(targetYaw) - normalizeYaw(curYaw);
        return normalizeYaw(delta);
    }

    public static double normalizeYaw(double yaw) {
        double normalized = yaw % 360.0D;
        if (normalized >= 180.0D) {
            normalized -= 360.0D;
        }
        if (normalized < -180.0D) {
            normalized += 360.0D;
        }
        return normalized;
    }

    static double easedStep(double remaining, double maxStep, double gain, double minStep) {
        double distance = Math.abs(remaining);
        if (distance <= 0.0D || maxStep <= 0.0D) {
            return 0.0D;
        }
        double proportional = distance * Math.max(0.0D, gain);
        double magnitude = clamp(proportional, minStep, maxStep);
        magnitude = Math.min(distance, magnitude);
        return Math.copySign(magnitude, remaining);
    }

    private static double clamp(double value, double min, double max) {
        return Math.max(min, Math.min(max, value));
    }
}
