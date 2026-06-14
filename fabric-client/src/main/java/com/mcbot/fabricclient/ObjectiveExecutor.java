package com.mcbot.fabricclient;

/**
 * A single dispatchable objective lifted out of the {@code McbotFabricClient} god class.
 *
 * <p>Strangler seam: each objective that was previously an {@code if (isX(effective)) return
 * resolveXControl(...)} branch in {@code resolveControl} becomes an {@code ObjectiveExecutor}
 * registered in the {@link ObjectiveRegistry}. The shell consults the registry at the top of
 * {@code resolveControl}; unregistered actions fall through to the unchanged dispatch chain, so the
 * lift is incremental and behavior-preserving.
 *
 * <p>{@link #tick(TickContext)} returns a {@link ControlDecision}; it must never write the shell's
 * input sink directly (the shell may still override the input afterward). Completion bookkeeping
 * mirrors the prior {@code completed*CommandIds} / {@code finished*CommandReasons} idiom and is read
 * back by the shell's command-completion aggregator via {@link #isFinished(String)} /
 * {@link #finishedReason(String)}.
 */
public interface ObjectiveExecutor {

    /** Whether this executor handles the given intent action (e.g. {@code "mine_stone"}). */
    boolean handles(String action);

    /** Advance this objective one client tick and return the control decision to apply. */
    ControlDecision tick(TickContext ctx);

    /** Whether the given commandId has been recorded as finished (completed or failed). */
    boolean isFinished(String commandId);

    /** The recorded completion/failure reason for the commandId, or {@code null} if none. */
    String finishedReason(String commandId);
}
