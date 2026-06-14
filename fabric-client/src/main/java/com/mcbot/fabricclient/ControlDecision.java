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
public record ControlDecision(BrainLink.Intent intent, InputState input) {
}
