package com.mcbot.fabricclient;

import java.util.Objects;

/** Pure prepare/acknowledge state machine for interaction cadence. */
final class FabricInteractionController {
    enum Behavior {
        LEGACY,
        SMOOTH
    }

    enum Dispatch {
        NONE,
        BREAK_PROGRESS,
        CANCEL_BREAK,
        ATTACK_ENTITY,
        USE_BLOCK,
        HOLD_ITEM,
        RELEASE_KEYS
    }

    record Observation(long nowMs, long physicalTick) {
    }

    record State(
        boolean initialized,
        LookDemand.Owner owner,
        String commandId,
        String stageIdentity,
        String gestureIdentity,
        String targetIdentity,
        String toolIdentity,
        String faceIdentity,
        InteractionDemand.Action action,
        String lastAppliedPulseRequestId,
        long lastAppliedBreakTick,
        boolean breakOwned,
        boolean useHeld,
        long gestureStartedAtMs,
        long targetStartedAtMs,
        long lastAppliedAtMs,
        long lastTickMs
    ) {
        static State initial() {
            return new State(
                false,
                null,
                "",
                "",
                "",
                "",
                "",
                "",
                InteractionDemand.Action.NONE,
                "",
                Long.MIN_VALUE,
                false,
                false,
                0L,
                0L,
                0L,
                0L
            );
        }
    }

    record Output(
        String requestId,
        Dispatch dispatch,
        boolean cancelBreakBeforeDispatch,
        boolean attackKeyPressed,
        boolean useKeyPressed,
        boolean duplicatePulseSuppressed,
        boolean duplicateBreakUpdateSuppressed,
        boolean logicalGestureContinued,
        boolean commandChanged,
        boolean stageChanged,
        boolean targetChanged,
        long gestureElapsedMs,
        long targetElapsedMs,
        long appliedGapMs,
        long physicalTick
    ) {
    }

    record Transition(State state, Output output) {
    }

    private FabricInteractionController() {
    }

    static State initialState() {
        return State.initial();
    }

    static Transition prepare(
        State previous,
        InteractionDemand demand,
        Observation observation,
        Behavior behavior
    ) {
        State prior = previous == null ? State.initial() : previous;
        Objects.requireNonNull(demand, "demand");
        Objects.requireNonNull(observation, "observation");
        Behavior effectiveBehavior = behavior == null ? Behavior.LEGACY : behavior;
        long nowMs = observation.nowMs();

        if (prior.initialized() && nowMs < prior.lastTickMs()) {
            prior = State.initial();
        }
        boolean commandChanged = prior.initialized()
            && (prior.owner() != demand.owner()
                || !prior.commandId().equals(demand.commandId()));
        boolean stageChanged = prior.initialized()
            && !prior.stageIdentity().equals(demand.stageIdentity());
        boolean targetChanged = prior.initialized()
            && (!prior.targetIdentity().equals(demand.targetIdentity())
                || !prior.faceIdentity().equals(demand.faceIdentity()));
        boolean sameGesture = prior.initialized()
            && prior.breakOwned()
            && demand.isBreakOwnership()
            && prior.owner() == demand.owner()
            && prior.commandId().equals(demand.commandId())
            && prior.gestureIdentity().equals(demand.gestureIdentity())
            && prior.toolIdentity().equals(demand.toolIdentity())
            && !demand.gestureIdentity().isEmpty();
        boolean gestureContinued = effectiveBehavior == Behavior.SMOOTH && sameGesture;
        long gestureStartedAtMs = gestureContinued ? prior.gestureStartedAtMs() : nowMs;
        long targetStartedAtMs = gestureContinued && !targetChanged
            ? prior.targetStartedAtMs()
            : nowMs;

        Dispatch dispatch = dispatchFor(demand.action());
        boolean duplicatePulse = demand.policy() == InteractionDemand.Policy.PULSE
            && demand.requestId().equals(prior.lastAppliedPulseRequestId());
        boolean duplicateBreak = dispatch == Dispatch.BREAK_PROGRESS
            && observation.physicalTick() == prior.lastAppliedBreakTick();
        if (duplicatePulse || duplicateBreak) {
            dispatch = Dispatch.NONE;
        }
        boolean cancelBefore = prior.breakOwned()
            && !demand.isBreakOwnership()
            && dispatch != Dispatch.CANCEL_BREAK;
        boolean desiredBreakOwned = demand.isBreakOwnership();
        boolean desiredUseHeld = dispatch == Dispatch.HOLD_ITEM;

        State proposed = new State(
            true,
            demand.owner(),
            demand.commandId(),
            demand.stageIdentity(),
            demand.gestureIdentity(),
            demand.targetIdentity(),
            demand.toolIdentity(),
            demand.faceIdentity(),
            demand.action(),
            prior.lastAppliedPulseRequestId(),
            prior.lastAppliedBreakTick(),
            desiredBreakOwned,
            desiredUseHeld,
            gestureStartedAtMs,
            targetStartedAtMs,
            prior.lastAppliedAtMs(),
            nowMs
        );
        Output output = new Output(
            demand.requestId(),
            dispatch,
            cancelBefore,
            false,
            desiredUseHeld,
            duplicatePulse,
            duplicateBreak,
            gestureContinued,
            commandChanged,
            stageChanged,
            targetChanged,
            elapsed(nowMs, gestureStartedAtMs),
            elapsed(nowMs, targetStartedAtMs),
            prior.lastAppliedAtMs() <= 0L ? 0L : elapsed(nowMs, prior.lastAppliedAtMs()),
            observation.physicalTick()
        );
        return new Transition(proposed, output);
    }

    /**
     * Commit physical cadence tokens only after the authority reports an applied request.
     * A smooth logical block-break hold has no physical dispatch, but it does prove that
     * the same mining gesture remained continuously owned during air confirmation/travel;
     * advance only the continuity timestamp for that case.
     */
    static State acknowledge(Transition transition, boolean applied, long nowMs) {
        Objects.requireNonNull(transition, "transition");
        State proposed = transition.state();
        Output output = transition.output();
        boolean logicalHold = proposed.action() == InteractionDemand.Action.BLOCK_BREAK_HOLD
            && output.logicalGestureContinued();
        if (!applied && !logicalHold) {
            return proposed;
        }
        String pulse = proposed.lastAppliedPulseRequestId();
        if (applied
            && (output.dispatch() == Dispatch.ATTACK_ENTITY || output.dispatch() == Dispatch.USE_BLOCK)) {
            pulse = output.requestId();
        }
        long breakTick = proposed.lastAppliedBreakTick();
        if (applied && output.dispatch() == Dispatch.BREAK_PROGRESS) {
            breakTick = output.physicalTick();
        }
        return new State(
            proposed.initialized(),
            proposed.owner(),
            proposed.commandId(),
            proposed.stageIdentity(),
            proposed.gestureIdentity(),
            proposed.targetIdentity(),
            proposed.toolIdentity(),
            proposed.faceIdentity(),
            proposed.action(),
            pulse,
            breakTick,
            proposed.breakOwned(),
            proposed.useHeld(),
            proposed.gestureStartedAtMs(),
            proposed.targetStartedAtMs(),
            nowMs,
            proposed.lastTickMs()
        );
    }

    static Output selectApplied(FabricMotionMode mode, Output legacy, Output smooth) {
        FabricMotionMode effectiveMode = mode == null ? FabricMotionMode.LEGACY : mode;
        return effectiveMode == FabricMotionMode.SMOOTH && smooth != null ? smooth : legacy;
    }

    static Dispatch legacyDispatchFor(InteractionDemand demand) {
        return demand == null ? Dispatch.RELEASE_KEYS : dispatchFor(demand.action());
    }

    private static Dispatch dispatchFor(InteractionDemand.Action action) {
        return switch (action) {
            case NONE, BLOCK_BREAK_HOLD -> Dispatch.NONE;
            case BREAK_BLOCK -> Dispatch.BREAK_PROGRESS;
            case CANCEL_BREAK -> Dispatch.CANCEL_BREAK;
            case ATTACK_ENTITY -> Dispatch.ATTACK_ENTITY;
            case USE_BLOCK -> Dispatch.USE_BLOCK;
            case HOLD_ITEM -> Dispatch.HOLD_ITEM;
            case RELEASE -> Dispatch.RELEASE_KEYS;
        };
    }

    private static long elapsed(long nowMs, long thenMs) {
        return Math.max(0L, nowMs - thenMs);
    }
}
