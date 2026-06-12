package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Staging #0: an offline, deterministic model of the 1-block step-up mount, used to develop + prove the
 * executor's mount policy.
 *
 * <p>KEY finding: with forward correctly applied toward the step, the mount WORKS -- run-up momentum mounts
 * cleanly and fast, and a back-up-then-approach rescues a flush start. (In fact even a plain flush bunny-hop
 * eventually creeps over via air drift.) So an "unmountable step" was NOT the live blocker. The live failure
 * (bot pinned in place with its yaw facing ~north, not toward the step) was the look / forward DIRECTION plus the
 * 1-wide-slot geometry -- which this idealized open-step sim abstracts away and the live fixture must reproduce.
 * The policy lesson the live executor should carry: approach the step with run-up momentum, and back up first if
 * there is no run-up room.
 */
class StepUpKinematicSimTest {
    private static final double WALL_X = 5.0D;
    private static final int MAX_TICKS = 80;

    @Test
    void aStandingJumpClearsAOneBlockHeight() {
        // The physics must be able to clear a 1-block step at all: forward+jump on flat ground peaks >= ledge.
        StepUpKinematicSim.Result r = StepUpKinematicSim.simulate(
            StepUpKinematicSim.BotState.restingAt(0.0D, 0.0D),
            100.0D,
            new StepUpKinematicSim.MomentumJumpPolicy(1000.0D), // always jumps when grounded; wall far away
            20);
        double maxY = r.trail().stream().mapToDouble(StepUpKinematicSim.BotState::y).max().orElse(0.0D);
        assertTrue(maxY >= StepUpKinematicSim.LEDGE_Y, "a jump must clear a 1-block height, peak=" + maxY);
    }

    @Test
    void runUpMomentumMountsTheStep() {
        // With run-up room, jumping while approaching (the proven momentum pattern) mounts the 1-block step.
        StepUpKinematicSim.Result r = StepUpKinematicSim.simulate(
            StepUpKinematicSim.BotState.restingAt(2.0D, 0.0D), // ~2.7 blocks of run-up to the wall face
            WALL_X,
            new StepUpKinematicSim.MomentumJumpPolicy(1.2D),
            MAX_TICKS);
        assertTrue(r.mounted(), "run-up momentum should mount; final=" + r.finalState());
    }

    @Test
    void backUpThenApproachMountsFromAFlushStart() {
        // The executor policy for a flush start with backup room: back up to create run-up, then approach + jump.
        StepUpKinematicSim.Result r = StepUpKinematicSim.simulate(
            StepUpKinematicSim.BotState.restingAt(WALL_X - StepUpKinematicSim.HALF_WIDTH, 0.0D),
            WALL_X,
            new StepUpKinematicSim.BackUpThenApproachPolicy(2.0D, 1.2D),
            MAX_TICKS);
        assertTrue(r.mounted(), "back-up-then-approach should mount from flush; final=" + r.finalState());
    }
}
