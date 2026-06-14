package com.mcbot.fabricclient;

import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.minecraft.util.math.BlockPos;

final class DescentHazardMemory {
    private static final Pattern ADJACENT_PATTERN = Pattern.compile(
        "descent_(water|lava)_adjacent:([\\-0-9]+),\\s*([\\-0-9]+),\\s*([\\-0-9]+)"
    );
    private static final Pattern HAZARD_IN_STEP_PATTERN = Pattern.compile(
        "descent_hazard_in_step:([a-z_]+):([\\-0-9]+),\\s*([\\-0-9]+),\\s*([\\-0-9]+)"
    );
    private static final int HAZARD_NEAR_XZ_RADIUS = 2;
    private static final int HAZARD_NEAR_Y_RADIUS = 2;

    private DescentHazardMemory() {
    }

    record HazardMarker(BlockPos pos, String kind) {
        HazardMarker {
            if (pos == null) {
                throw new IllegalArgumentException("pos is required");
            }
            kind = kind == null || kind.isBlank() ? "unknown" : kind;
            pos = pos.toImmutable();
        }
    }

    static HazardMarker parseRejectedStepHazard(String reason) {
        if (reason == null || reason.isBlank()) {
            return null;
        }
        Matcher adjacent = ADJACENT_PATTERN.matcher(reason);
        if (adjacent.find()) {
            return markerFromMatcher(adjacent, adjacent.group(1), 2);
        }
        Matcher inStep = HAZARD_IN_STEP_PATTERN.matcher(reason);
        if (inStep.find()) {
            return markerFromMatcher(inStep, inStep.group(1), 2);
        }
        return null;
    }

    static boolean candidateTooCloseToKnownHazard(StaircaseDescentPlanner.Step candidate, Set<HazardMarker> knownHazards) {
        if (candidate == null || knownHazards == null || knownHazards.isEmpty()) {
            return false;
        }
        for (HazardMarker hazard : knownHazards) {
            if (hazard == null) {
                continue;
            }
            if (near(hazard.pos(), candidate.nextFeet())
                || near(hazard.pos(), candidate.lowerClear())
                || near(hazard.pos(), candidate.upperClear())
                || near(hazard.pos(), candidate.sightClear())
                || near(hazard.pos(), candidate.support())) {
                return true;
            }
        }
        return false;
    }

    private static HazardMarker markerFromMatcher(Matcher matcher, String kind, int coordinateGroupOffset) {
        return new HazardMarker(
            new BlockPos(
                Integer.parseInt(matcher.group(coordinateGroupOffset)),
                Integer.parseInt(matcher.group(coordinateGroupOffset + 1)),
                Integer.parseInt(matcher.group(coordinateGroupOffset + 2))
            ),
            kind
        );
    }

    private static boolean near(BlockPos hazard, BlockPos candidate) {
        return hazard != null
            && candidate != null
            && Math.abs(hazard.getX() - candidate.getX()) <= HAZARD_NEAR_XZ_RADIUS
            && Math.abs(hazard.getZ() - candidate.getZ()) <= HAZARD_NEAR_XZ_RADIUS
            && Math.abs(hazard.getY() - candidate.getY()) <= HAZARD_NEAR_Y_RADIUS;
    }
}
