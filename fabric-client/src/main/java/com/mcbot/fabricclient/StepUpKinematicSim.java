package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.List;

/**
 * Minimal, MC-faithful-enough kinematic model of the ONE question that blocks the live 3-D collect executor:
 * can a given step-up policy mount a 1-block step? A point-with-width bot moves along +x toward a 1-block step
 * (near floor top at y=0, ledge top at y=1, wall face at {@code wallX}) under MC-like jump / gravity / ground +
 * air control, and the sim reports whether the policy lands it on the ledge.
 *
 * <p>This is Staging #0 of {@code docs/3d-nav-executor-plan.md}: a fast, deterministic, unit-testable loop to
 * DEVELOP and PROVE the executor's mount policy (run-up momentum vs. a flush standstill vs. back-up-then-approach)
 * without the non-deterministic, confounded live R5 chain. It is NOT a live-fidelity guarantee — the constants
 * approximate vanilla and the bot is a single column of width {@link #BOT_WIDTH}; the live staged fixture remains
 * the gate. Its job is to pin the QUALITATIVE facts the executor must respect.
 */
public final class StepUpKinematicSim {
    static final double JUMP_VELOCITY = 0.42D;
    static final double GRAVITY = 0.08D;
    static final double Y_DRAG = 0.98D;
    static final double GROUND_ACCEL = 0.18D;   // with GROUND_DRAG -> steady-state walk ~0.216 blocks/tick
    static final double GROUND_DRAG = 0.546D;   // 0.6 slipperiness * 0.91
    static final double AIR_ACCEL = 0.02D;
    static final double AIR_DRAG = 0.91D;
    static final double BOT_WIDTH = 0.6D;
    static final double HALF_WIDTH = BOT_WIDTH / 2.0D;
    static final double NEAR_FLOOR_Y = 0.0D;
    static final double LEDGE_Y = 1.0D;
    private static final double EPS = 1e-9D;

    private StepUpKinematicSim() {
    }

    /** Bot kinematic state: x = center along the approach axis, y = feet height. */
    record BotState(double x, double y, double vx, double vy, boolean onGround) {
        static BotState restingAt(double x, double y) {
            return new BotState(x, y, 0.0D, 0.0D, true);
        }
    }

    /** Per-tick control: forward (+x) / back (-x) / jump. */
    record Input(boolean forward, boolean back, boolean jump) {
    }

    /** A pure step-up follower policy: decide the input from the current state + the step's wall position. */
    interface Policy {
        Input decide(BotState state, double wallX);
    }

    record Result(boolean mounted, int ticks, BotState finalState, List<BotState> trail) {
    }

    static Result simulate(BotState start, double wallX, Policy policy, int maxTicks) {
        BotState state = start;
        List<BotState> trail = new ArrayList<>();
        trail.add(state);
        for (int t = 1; t <= maxTicks; t++) {
            Input input = policy.decide(state, wallX);
            state = step(state, input, wallX);
            trail.add(state);
            if (mounted(state, wallX)) {
                return new Result(true, t, state, List.copyOf(trail));
            }
        }
        return new Result(false, maxTicks, state, List.copyOf(trail));
    }

    /** Mounted = standing at the ledge height with the footprint on the step block (cleared the wall). */
    static boolean mounted(BotState s, double wallX) {
        return s.onGround() && s.y() >= LEDGE_Y - EPS && (s.x() + HALF_WIDTH) > wallX;
    }

    static BotState step(BotState s, Input in, double wallX) {
        boolean wasOnGround = s.onGround();
        double vx = s.vx();
        double vy = s.vy();

        // Jump only off the ground (MC sets jump velocity at the start of the tick).
        if (in.jump() && wasOnGround) {
            vy = JUMP_VELOCITY;
        }

        // Horizontal accel + drag: full traction on the ground, weak control in the air.
        double forwardInput = (in.forward() ? 1.0D : 0.0D) - (in.back() ? 1.0D : 0.0D);
        double accel = forwardInput * (wasOnGround ? GROUND_ACCEL : AIR_ACCEL);
        vx = (vx + accel) * (wasOnGround ? GROUND_DRAG : AIR_DRAG);

        double nx = s.x() + vx;
        double ny = s.y() + vy;

        // The step block occupies x in [wallX, wallX+1], y in [0,1]. Approaching FROM THE NEAR SIDE, the bot
        // (width BOT_WIDTH) cannot push its leading edge into the block while its feet are below the block top --
        // that is the wall. Once the footprint is already over the block it is landing on the top, not hitting the
        // wall, so it must NOT be pushed back (that mismatch was slamming a cleared run-up back to the wall).
        boolean approachingFromNearSide = (s.x() + HALF_WIDTH) <= wallX + EPS;
        if (approachingFromNearSide && (nx + HALF_WIDTH) > wallX && ny < LEDGE_Y - EPS) {
            nx = wallX - HALF_WIDTH;
            vx = 0.0D;
        }

        // Support height: the block top (y=1) once the footprint reaches the block (east edge past the face),
        // otherwise the near floor (y=0). Consistent with the wall above, so momentum is only lost on a real hit.
        double floorY = (nx + HALF_WIDTH) > wallX ? LEDGE_Y : NEAR_FLOOR_Y;
        boolean onGround;
        if (ny <= floorY + EPS) {
            ny = floorY;
            vy = 0.0D;
            onGround = true;
        } else {
            onGround = false;
            vy = (vy - GRAVITY) * Y_DRAG; // gravity for the next tick (MC applies it after the move)
        }

        return new BotState(nx, ny, vx, vy, onGround);
    }

    /** Naive: jump whenever on the ground within {@code jumpDistanceBlocks} of the wall, always pressing forward. */
    static final class MomentumJumpPolicy implements Policy {
        private final double jumpDistanceBlocks;

        MomentumJumpPolicy(double jumpDistanceBlocks) {
            this.jumpDistanceBlocks = jumpDistanceBlocks;
        }

        @Override
        public Input decide(BotState state, double wallX) {
            double distanceToWall = wallX - (state.x() + HALF_WIDTH);
            boolean jump = state.onGround() && distanceToWall <= jumpDistanceBlocks;
            return new Input(true, false, jump);
        }
    }

    /** Robust: if there is no run-up room (too close / flush), back up to {@code runUpBlocks} first, then approach
     * and jump with momentum. This is the policy the live executor should use for an OPEN step (a slot with no
     * backup room needs digging instead — out of scope for this sim). */
    static final class BackUpThenApproachPolicy implements Policy {
        private final double runUpBlocks;
        private final double jumpDistanceBlocks;
        private boolean backingUp;
        private boolean initialized;

        BackUpThenApproachPolicy(double runUpBlocks, double jumpDistanceBlocks) {
            this.runUpBlocks = runUpBlocks;
            this.jumpDistanceBlocks = jumpDistanceBlocks;
        }

        @Override
        public Input decide(BotState state, double wallX) {
            double distanceToWall = wallX - (state.x() + HALF_WIDTH);
            if (!initialized) {
                initialized = true;
                backingUp = distanceToWall < runUpBlocks;
            }
            if (backingUp) {
                if (distanceToWall >= runUpBlocks) {
                    backingUp = false;
                } else {
                    return new Input(false, true, false); // create run-up room, no jump
                }
            }
            boolean jump = state.onGround() && distanceToWall <= jumpDistanceBlocks;
            return new Input(true, false, jump);
        }
    }
}
