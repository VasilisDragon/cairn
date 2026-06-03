package com.mcbot.fabricclient;

import java.util.Set;

/**
 * Drives the full offline control stack to a target through the {@link KinematicSim}:
 * each tick, {@link Navigator} decides an intent, {@link LookController} rate-limits the
 * turn toward the intent's desired yaw, {@link BrainLink#inputStateFor} maps the intent to
 * movement input, and the sim integrates one step.
 *
 * <p>This is the harness the overnight hardening loop runs thousands of randomized
 * scenarios through. No Minecraft types — decisions only, not physics fidelity.
 */
public final class NavScenario {
    private NavScenario() {
    }

    /** Outcome of a single navigation scenario. */
    public record Result(boolean arrived, int ticks, double finalDistance) {
    }

    public static Result run(
        double startX,
        double startZ,
        double startYaw,
        double targetX,
        double targetZ,
        double arriveEpsilon,
        double maxTurnDegPerTick,
        double speedPerTick,
        int maxTicks
    ) {
        KinematicSim sim = new KinematicSim(startX, startZ, startYaw, speedPerTick);
        return run(sim, targetX, targetZ, arriveEpsilon, maxTurnDegPerTick, maxTicks);
    }

    public static Result run(
        double startX,
        double startZ,
        double startYaw,
        double targetX,
        double targetZ,
        double arriveEpsilon,
        double maxTurnDegPerTick,
        double speedPerTick,
        int maxTicks,
        Set<GridCell> blockedCells,
        int minX,
        int maxX,
        int minZ,
        int maxZ
    ) {
        KinematicSim sim = new KinematicSim(startX, startZ, startYaw, speedPerTick, blockedCells, minX, maxX, minZ, maxZ);
        return run(sim, targetX, targetZ, arriveEpsilon, maxTurnDegPerTick, maxTicks);
    }

    public static Result run(
        KinematicSim sim,
        double targetX,
        double targetZ,
        double arriveEpsilon,
        double maxTurnDegPerTick,
        int maxTicks
    ) {
        for (int tick = 0; tick < maxTicks; tick++) {
            BrainLink.Intent intent =
                Navigator.toward(sim.x(), sim.z(), sim.yaw(), targetX, targetZ, arriveEpsilon);
            if ("stop".equals(intent.action())) {
                return new Result(true, tick, distanceTo(sim, targetX, targetZ));
            }
            double desiredYaw = intent.targetYaw() != null ? intent.targetYaw() : sim.yaw();
            LookController.Look look =
                LookController.nextLook(sim.yaw(), 0.0D, desiredYaw, 0.0D, maxTurnDegPerTick);
            InputState input = BrainLink.inputStateFor(intent);
            sim.step(input, look);
        }
        return new Result(false, maxTicks, distanceTo(sim, targetX, targetZ));
    }

    private static double distanceTo(KinematicSim sim, double targetX, double targetZ) {
        return Math.hypot(targetX - sim.x(), targetZ - sim.z());
    }
}
