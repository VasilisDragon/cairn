package com.mcbot.fabricclient;

/**
 * Result of a single objective tick: the {@link BrainLink.Intent} the shell should treat as
 * effective for this tick, paired with the {@link InputState} to apply.
 *
 * <p>Promoted from a private nested record in {@code McbotFabricClient} to a top-level type so the
 * extracted {@link ObjectiveExecutor} implementations can return it. The shell — not the executor —
 * assigns {@code currentInputState} from {@link #input()} and may override it (edge-guard /
 * screen-guard) before applying, so executors return a value and never write a sink.
 */
public record ControlDecision(
    BrainLink.Intent intent,
    InputState input,
    LookDemand lookDemand,
    LookDemand legacyLookDemand,
    LocomotionDemand locomotionDemand,
    InteractionDemand interactionDemand,
    FabricInteractionAuthority.Payload interactionPayload
) {
    public ControlDecision(BrainLink.Intent intent, InputState input) {
        this(intent, input, null, null, null, null, null);
    }

    public ControlDecision(BrainLink.Intent intent, InputState input, LookDemand lookDemand) {
        this(intent, input, lookDemand, null, null, null, null);
    }

    public ControlDecision(
        BrainLink.Intent intent,
        InputState input,
        LookDemand lookDemand,
        LookDemand legacyLookDemand
    ) {
        this(intent, input, lookDemand, legacyLookDemand, null, null, null);
    }

    public ControlDecision(
        BrainLink.Intent intent,
        InputState input,
        LookDemand lookDemand,
        LookDemand legacyLookDemand,
        LocomotionDemand locomotionDemand
    ) {
        this(intent, input, lookDemand, legacyLookDemand, locomotionDemand, null, null);
    }

    public ControlDecision(
        BrainLink.Intent intent,
        InputState input,
        LookDemand lookDemand,
        LookDemand legacyLookDemand,
        LocomotionDemand locomotionDemand,
        InteractionDemand interactionDemand
    ) {
        this(intent, input, lookDemand, legacyLookDemand, locomotionDemand, interactionDemand, null);
    }
}
