package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Pure formatting for the observability cockpit HUD — NO Minecraft types, so it is unit-testable.
 *
 * <p>The renderer ({@code McbotFabricClient#renderCockpitHud}) builds a {@link Status} from the live
 * client state each frame and hands it here to produce the text lines; this class never touches the
 * screen. Keeping the string logic here (objective parsing, running/stopped, brain-state labels) means
 * the part that can actually be wrong is covered by {@code CockpitHudTest} rather than only by eyes.
 */
final class CockpitHud {
    private CockpitHud() {
    }

    /** Immutable snapshot of what the HUD shows; assembled on the client thread, formatted here. */
    record Status(
        boolean controlEnabled,
        String activeLayer,       // control | combat | survival | stopped | idle
        String action,            // brain intent action (Diagnostics.currentAction)
        String reason,            // brain intent reason (Diagnostics.currentReason) — encodes mission:OBJECTIVE
        String subStep,           // last ControlDecision / reflex reason (the granular "what right now")
        boolean brainInFlight,
        long remainingTtlMs,
        long lastRoundTripMs,
        String commandId,
        float health,
        int feetY,
        long msSinceResponseMs
    ) {
    }

    private static final String MISSION_PREFIX = "mission:";
    private static final int MAX_SUBSTEP_CHARS = 24;
    /** "stale" = no successful brain round-trip within this window (NOT the per-tick intent TTL). */
    private static final long BRAIN_STALE_MS = 1500L;

    /** Cap a string at {@code max} chars with an ellipsis so a long sub-step can't overflow the panel. */
    static String truncate(String value, int max) {
        if (value == null) {
            return "";
        }
        return value.length() <= max ? value : value.substring(0, Math.max(0, max - 1)) + "…";
    }

    /** Mission objective parsed from the brain reason ("mission:MINE_IRON" -> "MINE_IRON"); "-" otherwise. */
    static String objectiveLabel(String reason) {
        if (reason == null || reason.isEmpty() || !reason.startsWith(MISSION_PREFIX)) {
            return "-";
        }
        String objective = reason.substring(MISSION_PREFIX.length());
        return objective.isEmpty() ? "-" : objective;
    }

    /** One-word health of the brain link for the HUD: paused (bot off) / deciding now / stale / ok.
     * {@code brainInFlight} is expected to be DEBOUNCED by the caller (only true for a genuinely slow
     * call) so this label doesn't flicker THINKING/ok on every fast local round-trip. */
    static String brainStateLabel(Status status) {
        if (!status.controlEnabled()) {
            return "paused";
        }
        if (status.brainInFlight()) {
            return "THINKING";
        }
        // "stale" means the BRAIN stopped answering -- no successful round-trip recently. It is NOT
        // the current intent's per-tick TTL: long-running held commands and stop/idle intents
        // legitimately sit at remainingTtlMs=0 while the brain keeps responding every tick.
        if (status.msSinceResponseMs() >= 0L && status.msSinceResponseMs() > BRAIN_STALE_MS) {
            return "stale";
        }
        return "ok";
    }

    /** The HUD text lines, top to bottom. */
    static List<String> lines(Status status) {
        List<String> out = new ArrayList<>();
        out.add("MCBot  " + (status.controlEnabled() ? "RUNNING" : "STOPPED") + "  [" + safe(status.activeLayer()) + "]");
        out.add("objective: " + objectiveLabel(status.reason()));
        String action = "action: " + safe(status.action());
        if (!isBlank(status.subStep())) {
            action += "  (" + truncate(status.subStep(), MAX_SUBSTEP_CHARS) + ")";
        }
        out.add(action);
        out.add("brain: " + brainStateLabel(status)
            + "  rtt=" + Math.max(-1L, status.lastRoundTripMs()) + "ms"
            + "  ttl=" + Math.max(0L, status.remainingTtlMs()) + "ms");
        out.add("cmd: " + shortCommandId(status.commandId()));
        out.add(String.format(Locale.ROOT, "hp %.1f   y=%d", status.health(), status.feetY()));
        return out;
    }

    /** The DeepSeek decision panel: what the planner last decided + whether it's deciding now. */
    static List<String> deepSeekLines(String planSource, String planReason, boolean inFlight) {
        List<String> out = new ArrayList<>();
        out.add("DeepSeek" + (inFlight ? "  *thinking*" : ""));
        out.add("src: " + safe(planSource));
        out.add("why: " + (isBlank(planReason) ? "-" : truncate(planReason, 34)));
        return out;
    }

    private static String safe(String value) {
        return value == null || value.isEmpty() ? "-" : value;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isEmpty();
    }

    /** Command ids are long ("mission-<instance>-19"); show just the trailing "-19" suffix. */
    static String shortCommandId(String commandId) {
        if (commandId == null || commandId.isEmpty()) {
            return "-";
        }
        int dash = commandId.lastIndexOf('-');
        return dash >= 0 && dash < commandId.length() - 1 ? "…" + commandId.substring(dash) : commandId;
    }
}
