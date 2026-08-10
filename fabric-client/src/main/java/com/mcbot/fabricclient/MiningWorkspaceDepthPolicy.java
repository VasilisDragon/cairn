package com.mcbot.fabricclient;

final class MiningWorkspaceDepthPolicy {
    static final int MAX_TARGET_Y = 16;
    static final int LOWER_TOLERANCE = 3;
    static final int UPPER_STANCE_TOLERANCE = 1;

    private MiningWorkspaceDepthPolicy() {
    }

    static boolean applies(String commandId, String reason, Double targetY) {
        return commandId != null
            && commandId.startsWith("mission-")
            && ("mission:DESCEND".equals(reason) || "mission:DESCEND_RECOVERY".equals(reason))
            && validTarget(targetY)
            && targetY <= MAX_TARGET_Y;
    }

    static boolean terminalLandingReached(int feetY, Double targetY) {
        if (!validTarget(targetY)) {
            return false;
        }
        int target = (int) Math.floor(targetY);
        return feetY >= target - LOWER_TOLERANCE && feetY <= target;
    }

    static boolean latchTerminalLanding(boolean alreadyReached, int feetY, Double targetY) {
        return alreadyReached || terminalLandingReached(feetY, targetY);
    }

    static boolean immediateAdmissionAllowed(
        String commandId,
        String reason,
        Double targetY,
        int feetY,
        boolean grounded,
        boolean dry,
        boolean bodyClear,
        boolean supportStable
    ) {
        return applies(commandId, reason, targetY)
            && terminalLandingReached(feetY, targetY)
            && grounded
            && dry
            && bodyClear
            && supportStable;
    }

    static boolean workspaceStanceAllowed(VoxelCell stance, Double targetY) {
        if (stance == null || !validTarget(targetY)) {
            return false;
        }
        int target = (int) Math.floor(targetY);
        return stance.y() >= target - LOWER_TOLERANCE
            && stance.y() <= target + UPPER_STANCE_TOLERANCE;
    }

    static boolean safeFallLandingAllowed(
        String commandId,
        String reason,
        Double targetY,
        int landingFeetY
    ) {
        return !applies(commandId, reason, targetY)
            || landingFeetY >= (int) Math.floor(targetY) - LOWER_TOLERANCE;
    }

    private static boolean validTarget(Double targetY) {
        return targetY != null && Double.isFinite(targetY);
    }
}
