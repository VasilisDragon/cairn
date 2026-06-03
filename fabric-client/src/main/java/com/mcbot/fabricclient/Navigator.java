package com.mcbot.fabricclient;

/** Straight-line X/Z navigator. Obstacle and terrain handling are deliberately deferred. */
public final class Navigator {
    public static final double FULL_FORWARD_ALIGNMENT_DEGREES = 12.0D;
    public static final double ARC_FORWARD_ALIGNMENT_DEGREES = 45.0D;
    public static final double MIN_ARC_FORWARD = 0.18D;

    private Navigator() {
    }

    public static BrainLink.Intent toward(
        double curX,
        double curZ,
        double curYaw,
        double targetX,
        double targetZ,
        double arriveEpsilon
    ) {
        double dx = targetX - curX;
        double dz = targetZ - curZ;
        double distance = Math.hypot(dx, dz);
        double epsilon = Math.max(0.0D, arriveEpsilon);
        if (distance <= epsilon) {
            return BrainLink.Intent.stop("arrived");
        }

        double desiredYaw = yawToward(dx, dz);
        double yawError = Math.abs(LookController.shortestYawDelta(curYaw, desiredYaw));
        double forwardAmount = forwardAmountForYawError(yawError);
        boolean moving = forwardAmount > 0.0D;
        return new BrainLink.Intent(
            moving ? "navigate_forward" : "turn_toward",
            moving,
            false,
            false,
            false,
            false,
            false,
            moving ? forwardAmount : null,
            null,
            desiredYaw,
            null,
            null,
            null,
            java.util.List.of(),
            java.util.List.of(),
            null,
            java.util.List.of(),
            Long.MAX_VALUE,
            moving ? "arcing_to_target" : "turning_to_target",
            ""
        );
    }

    public static double yawToward(double dx, double dz) {
        return LookController.normalizeYaw(Math.toDegrees(Math.atan2(-dx, dz)));
    }

    public static double forwardAmountForYawError(double yawError) {
        double error = Math.abs(yawError);
        if (error <= FULL_FORWARD_ALIGNMENT_DEGREES) {
            return 1.0D;
        }
        if (error >= ARC_FORWARD_ALIGNMENT_DEGREES) {
            return 0.0D;
        }

        double span = ARC_FORWARD_ALIGNMENT_DEGREES - FULL_FORWARD_ALIGNMENT_DEGREES;
        double normalized = (error - FULL_FORWARD_ALIGNMENT_DEGREES) / span;
        return MIN_ARC_FORWARD + (1.0D - MIN_ARC_FORWARD) * (1.0D - normalized);
    }
}
