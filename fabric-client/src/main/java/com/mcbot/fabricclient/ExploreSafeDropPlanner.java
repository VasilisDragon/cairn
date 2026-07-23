package com.mcbot.fabricclient;

import java.util.Comparator;
import java.util.List;

public final class ExploreSafeDropPlanner {

    public static final int MAX_FALL_BLOCKS = SafeFallPlanner.VANILLA_SAFE_FALL_BLOCKS;

    private ExploreSafeDropPlanner() {
    }

    public record Candidate(
        int dx,
        int dz,
        int fallBlocks,
        double remainingDistanceSquared,
        boolean progresses,
        boolean columnClear,
        boolean floorSolid,
        boolean feetAir,
        boolean headAir,
        boolean landingHazard,
        boolean adjacentLava,
        boolean boxedPit
    ) {
    }

    public enum Progress {
        ROTATE,
        NUDGE,
        HOLD,
        LANDED,
        REJECTED,
        TIMEOUT
    }

    public static boolean reasonAllowed(String reason) {
        return reason != null && reason.startsWith("exploration:");
    }

    public static boolean edgeGuardActionAllowed(String action) {
        return action != null && action.startsWith("nav3d_approach_safe_drop");
    }

    public static String attemptKey(String commandId, String reason) {
        return (commandId == null ? "" : commandId) + "|" + (reason == null ? "" : reason);
    }

    public static Candidate chooseCandidate(List<Candidate> candidates) {
        if (candidates == null) {
            return null;
        }
        return candidates.stream()
            .filter(candidate -> candidate != null && candidate.progresses())
            .filter(candidate -> SafeFallPlanner.isSurvivableLanding(
                candidate.fallBlocks(),
                MAX_FALL_BLOCKS,
                candidate.columnClear(),
                candidate.floorSolid(),
                candidate.feetAir(),
                candidate.headAir(),
                candidate.landingHazard(),
                candidate.adjacentLava(),
                candidate.boxedPit()
            ))
            .min(Comparator.comparingInt(Candidate::fallBlocks)
                .thenComparingDouble(Candidate::remainingDistanceSquared))
            .orElse(null);
    }

    public static Progress progressDecision(
        boolean airborne,
        boolean onGround,
        boolean landedAtTarget,
        boolean timedOut,
        boolean facingColumn
    ) {
        if (airborne && onGround) {
            return landedAtTarget ? Progress.LANDED : Progress.REJECTED;
        }
        if (timedOut) {
            return Progress.TIMEOUT;
        }
        if (!onGround) {
            return Progress.HOLD;
        }
        return facingColumn ? Progress.NUDGE : Progress.ROTATE;
    }
}
