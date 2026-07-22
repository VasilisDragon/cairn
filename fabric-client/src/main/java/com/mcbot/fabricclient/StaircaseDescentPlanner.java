package com.mcbot.fabricclient;

import java.util.List;
import java.util.function.Predicate;
import net.minecraft.util.math.BlockPos;

final class StaircaseDescentPlanner {
    private StaircaseDescentPlanner() {
    }

    record Direction2d(int dx, int dz, String name) {
        Direction2d {
            if (Math.abs(dx) + Math.abs(dz) != 1) {
                throw new IllegalArgumentException("direction must be cardinal");
            }
        }
    }

    record Step(
        int index,
        BlockPos currentFeet,
        BlockPos nextFeet,
        BlockPos sightClear,
        BlockPos upperClear,
        BlockPos lowerClear,
        BlockPos support
    ) {
    }

    static Step step(BlockPos startFeet, Direction2d direction, int index) {
        if (startFeet == null) {
            throw new IllegalArgumentException("startFeet is required");
        }
        if (direction == null) {
            throw new IllegalArgumentException("direction is required");
        }
        if (index < 1) {
            throw new IllegalArgumentException("index must be >= 1");
        }
        BlockPos currentFeet = startFeet.add(direction.dx() * (index - 1), -(index - 1), direction.dz() * (index - 1));
        return stepFrom(currentFeet, direction, index);
    }

    static Step stepFrom(BlockPos currentFeet, Direction2d direction, int index) {
        if (currentFeet == null) {
            throw new IllegalArgumentException("currentFeet is required");
        }
        if (direction == null) {
            throw new IllegalArgumentException("direction is required");
        }
        if (index < 1) {
            throw new IllegalArgumentException("index must be >= 1");
        }
        BlockPos nextFeet = currentFeet.add(direction.dx(), -1, direction.dz());
        return new Step(
            index,
            currentFeet,
            nextFeet,
            nextFeet.up(2),
            nextFeet.up(),
            nextFeet,
            nextFeet.down()
        );
    }

    // Mine-through level step: advance one cell in `direction` at the SAME y, carving a 2-high
    // tunnel. sightClear duplicates upperClear so BREAK_SIGHT digs the head cell and BREAK_UPPER
    // falls through on the now-air duplicate; support stays the floor under the next cell, so
    // descentStepUnsafeReason demands a solid tunnel floor exactly like a down step.
    static Step levelStepFrom(BlockPos currentFeet, Direction2d direction, int index) {
        if (currentFeet == null) {
            throw new IllegalArgumentException("currentFeet is required");
        }
        if (direction == null) {
            throw new IllegalArgumentException("direction is required");
        }
        if (index < 1) {
            throw new IllegalArgumentException("index must be >= 1");
        }
        BlockPos nextFeet = currentFeet.add(direction.dx(), 0, direction.dz());
        return new Step(
            index,
            currentFeet,
            nextFeet,
            nextFeet.up(),
            nextFeet.up(),
            nextFeet,
            nextFeet.down()
        );
    }

    static boolean targetsSelfSupport(Step step) {
        if (step == null) {
            return false;
        }
        BlockPos currentSupport = step.currentFeet().down();
        return currentSupport.equals(step.sightClear()) || currentSupport.equals(step.upperClear()) || currentSupport.equals(step.lowerClear());
    }

    static List<Direction2d> rerouteCandidates(Direction2d current) {
        if (current == null) {
            return List.of(south(), east(), west(), north());
        }
        if (current.equals(north())) {
            return List.of(east(), west(), south());
        }
        if (current.equals(south())) {
            return List.of(west(), east(), north());
        }
        if (current.equals(east())) {
            return List.of(south(), north(), west());
        }
        return List.of(north(), south(), east());
    }

    static Direction2d chooseReroute(Direction2d current, Predicate<Direction2d> safe) {
        if (safe == null) {
            return null;
        }
        for (Direction2d candidate : rerouteCandidates(current)) {
            if (safe.test(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    static int boundedDepth(int requestedDepth, int maxDepth) {
        int positiveMax = Math.max(1, maxDepth);
        return Math.max(1, Math.min(positiveMax, requestedDepth));
    }

    static Direction2d cardinalFromDelta(double dx, double dz, Direction2d fallback) {
        if (Math.abs(dx) >= Math.abs(dz) && Math.abs(dx) > 0.001D) {
            return dx > 0.0D ? east() : west();
        }
        if (Math.abs(dz) > 0.001D) {
            return dz > 0.0D ? south() : north();
        }
        return fallback == null ? south() : fallback;
    }

    static Direction2d east() {
        return new Direction2d(1, 0, "east");
    }

    static Direction2d west() {
        return new Direction2d(-1, 0, "west");
    }

    static Direction2d south() {
        return new Direction2d(0, 1, "south");
    }

    static Direction2d north() {
        return new Direction2d(0, -1, "north");
    }
}
