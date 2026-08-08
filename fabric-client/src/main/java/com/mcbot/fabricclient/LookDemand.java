package com.mcbot.fabricclient;

import java.util.Objects;

record LookDemand(
    Owner owner,
    String targetIdentity,
    Profile profile,
    double desiredYaw,
    double desiredPitch,
    RetargetPolicy retargetPolicy,
    String commandId,
    String reason
) {
    private static final String[] TRAVEL_REASON_MARKERS = {
        "nav",
        "route",
        "move",
        "step",
        "descend",
        "approach",
        "egress",
        "climb",
        "travers",
        "frontier",
        "tunnel",
        "safe_drop"
    };
    private static final String[] TRACKING_REASON_MARKERS = {
        "collect",
        "pickup",
        "drop",
        "track"
    };

    enum Owner {
        NORMAL,
        COMBAT,
        SURVIVAL,
        HUNT
    }

    enum Profile {
        TRAVEL(240.0D, 960.0D),
        PRECISION(180.0D, 720.0D),
        TRACKING(300.0D, 1_200.0D),
        CRITICAL(Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY);

        private final double maxSpeedDegPerSecond;
        private final double maxAccelerationDegPerSecondSquared;

        Profile(double maxSpeedDegPerSecond, double maxAccelerationDegPerSecondSquared) {
            this.maxSpeedDegPerSecond = maxSpeedDegPerSecond;
            this.maxAccelerationDegPerSecondSquared = maxAccelerationDegPerSecondSquared;
        }

        double maxSpeedDegPerSecond() {
            return maxSpeedDegPerSecond;
        }

        double maxAccelerationDegPerSecondSquared() {
            return maxAccelerationDegPerSecondSquared;
        }
    }

    enum RetargetPolicy {
        CONTINUOUS,
        COMMITTED,
        IMMEDIATE
    }

    LookDemand {
        owner = Objects.requireNonNull(owner, "owner");
        targetIdentity = requireText(targetIdentity, "targetIdentity");
        profile = Objects.requireNonNull(profile, "profile");
        retargetPolicy = Objects.requireNonNull(retargetPolicy, "retargetPolicy");
        commandId = requireText(commandId, "commandId");
        reason = requireText(reason, "reason");
        if (!Double.isFinite(desiredYaw) || !Double.isFinite(desiredPitch)) {
            throw new IllegalArgumentException("look angles must be finite");
        }
        if (profile == Profile.CRITICAL && retargetPolicy != RetargetPolicy.IMMEDIATE) {
            throw new IllegalArgumentException("critical look demands must be immediate");
        }
        desiredYaw = LookController.normalizeYaw(desiredYaw);
        desiredPitch = Math.max(-90.0D, Math.min(90.0D, desiredPitch));
    }

    boolean sameCommitmentScope(LookDemand other) {
        return other != null
            && owner == other.owner
            && commandId.equals(other.commandId)
            && reason.equals(other.reason);
    }

    static LookDemand fromNormalDecision(BrainLink.Intent intent, InputState input) {
        return fromNormalDecision(intent, input, 0.0D, 0.0D);
    }

    static LookDemand fromNormalDecision(
        BrainLink.Intent intent,
        InputState input,
        double fallbackYaw,
        double fallbackPitch
    ) {
        if (intent == null || (intent.targetYaw() == null && intent.targetPitch() == null)) {
            return null;
        }
        String command = textOr(intent.commandId(), "uncommanded");
        String reason = textOr(intent.reason(), textOr(intent.action(), "look"));
        Profile profile = classifyNormalProfile(reason, input);
        RetargetPolicy policy = profile == Profile.PRECISION
            ? RetargetPolicy.COMMITTED
            : RetargetPolicy.CONTINUOUS;
        return new LookDemand(
            Owner.NORMAL,
            normalTargetIdentity(intent, command, reason, profile),
            profile,
            intent.targetYaw() == null ? fallbackYaw : intent.targetYaw(),
            intent.targetPitch() == null ? fallbackPitch : intent.targetPitch(),
            policy,
            command,
            reason
        );
    }

    private static Profile classifyNormalProfile(String reason, InputState input) {
        String lower = reason.toLowerCase(java.util.Locale.ROOT);
        boolean moving = input != null
            && (input.pressingForward()
                || input.pressingBack()
                || input.pressingLeft()
                || input.pressingRight()
                || input.jumping());
        if (containsAny(lower, TRACKING_REASON_MARKERS)) {
            return Profile.TRACKING;
        }
        if (moving
            || containsAny(lower, TRAVEL_REASON_MARKERS)) {
            return Profile.TRAVEL;
        }
        return Profile.PRECISION;
    }

    private static String normalTargetIdentity(
        BrainLink.Intent intent,
        String command,
        String reason,
        Profile profile
    ) {
        if (profile == Profile.TRACKING || profile == Profile.TRAVEL) {
            return profile.name().toLowerCase(java.util.Locale.ROOT) + ":" + command + ":" + reason;
        }
        String coordinates = intent.targetX() == null || intent.targetY() == null || intent.targetZ() == null
            ? "angles"
            : intent.targetX() + ":" + intent.targetY() + ":" + intent.targetZ();
        return "fixed:" + command + ":" + reason + ":" + coordinates;
    }

    private static boolean containsAny(String value, String[] needles) {
        for (String needle : needles) {
            if (value.contains(needle)) {
                return true;
            }
        }
        return false;
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
