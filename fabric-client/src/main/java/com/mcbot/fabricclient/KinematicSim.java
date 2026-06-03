package com.mcbot.fabricclient;

import java.util.Collections;
import java.util.HashSet;
import java.util.Map;
import java.util.OptionalInt;
import java.util.Set;

/**
 * Pure-Java kinematic world model for validating navigation DECISIONS offline —
 * no Minecraft, no physics fidelity beyond "forward = facing direction".
 *
 * <p>A point agent with position (x, z) + yaw. One {@link #step} applies the look
 * output (turn) and then a forward/strafe move along the facing direction, using
 * the SAME yaw convention as Minecraft and {@link Navigator}:
 * <pre>
 *   forward unit = (-sin yaw,  cos yaw)   // yaw 0 = +Z (south), 90 = -X (west)
 *   strafe  unit = ( cos yaw,  sin yaw)   // +sideways = left, matching inputStateFor
 * </pre>
 * This is the seam that lets the whole control stack (Navigator + LookController +
 * BrainLink.inputStateFor) be exercised end-to-end without launching the game.
 */
public final class KinematicSim implements GridPerception {
    private double x;
    private double z;
    private double yaw;
    private final double speedPerTick;
    private final Set<GridCell> blockedCells;
    private final int minX;
    private final int maxX;
    private final int minZ;
    private final int maxZ;
    private final Map<GridCell, Integer> surfaceHeights;

    public KinematicSim(double x, double z, double yaw, double speedPerTick) {
        this(x, z, yaw, speedPerTick, Collections.emptySet(), Integer.MIN_VALUE, Integer.MAX_VALUE, Integer.MIN_VALUE, Integer.MAX_VALUE);
    }

    public KinematicSim(
        double x,
        double z,
        double yaw,
        double speedPerTick,
        Set<GridCell> blockedCells,
        int minX,
        int maxX,
        int minZ,
        int maxZ
    ) {
        this(x, z, yaw, speedPerTick, blockedCells, Collections.emptyMap(), minX, maxX, minZ, maxZ);
    }

    public KinematicSim(
        double x,
        double z,
        double yaw,
        double speedPerTick,
        Set<GridCell> blockedCells,
        Map<GridCell, Integer> surfaceHeights,
        int minX,
        int maxX,
        int minZ,
        int maxZ
    ) {
        if (minX > maxX) {
            throw new IllegalArgumentException("minX must be <= maxX");
        }
        if (minZ > maxZ) {
            throw new IllegalArgumentException("minZ must be <= maxZ");
        }
        this.x = x;
        this.z = z;
        this.yaw = LookController.normalizeYaw(yaw);
        this.speedPerTick = speedPerTick;
        this.blockedCells = Set.copyOf(blockedCells == null ? Collections.emptySet() : new HashSet<>(blockedCells));
        this.minX = minX;
        this.maxX = maxX;
        this.minZ = minZ;
        this.maxZ = maxZ;
        this.surfaceHeights = Map.copyOf(surfaceHeights == null ? Collections.emptyMap() : surfaceHeights);
    }

    public double x() {
        return x;
    }

    public double z() {
        return z;
    }

    public double yaw() {
        return yaw;
    }

    @Override
    public boolean isBlocked(int x, int z) {
        return !inBounds(x, z) || blockedCells.contains(new GridCell(x, z));
    }

    @Override
    public OptionalInt surfaceY(int x, int z) {
        if (isBlocked(x, z)) {
            return OptionalInt.empty();
        }
        return OptionalInt.of(surfaceHeights.getOrDefault(new GridCell(x, z), 0));
    }

    @Override
    public int minX() {
        return minX;
    }

    @Override
    public int maxX() {
        return maxX;
    }

    @Override
    public int minZ() {
        return minZ;
    }

    @Override
    public int maxZ() {
        return maxZ;
    }

    /** Apply one tick: adopt the look's yaw, then translate along the facing frame per the input. */
    public void step(InputState input, LookController.Look look) {
        yaw = LookController.normalizeYaw(look.yaw());
        double yawRad = Math.toRadians(yaw);
        double forwardX = -Math.sin(yawRad);
        double forwardZ = Math.cos(yawRad);
        double strafeX = Math.cos(yawRad);
        double strafeZ = Math.sin(yawRad);

        double f = input.movementForward() * speedPerTick;
        double s = input.movementSideways() * speedPerTick;
        double nextX = x + forwardX * f + strafeX * s;
        double nextZ = z + forwardZ * f + strafeZ * s;
        GridCell currentCell = new GridCell(cell(x), cell(z));
        GridCell nextCell = new GridCell(cell(nextX), cell(nextZ));
        if (currentCell.equals(nextCell) || canTraverse(currentCell, nextCell)) {
            x = nextX;
            z = nextZ;
        }
    }

    static int cell(double value) {
        return (int) Math.floor(value);
    }
}
