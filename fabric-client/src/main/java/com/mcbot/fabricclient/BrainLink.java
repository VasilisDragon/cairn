package com.mcbot.fabricclient;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Minecraft-independent brain IPC + intent state machine — the unit-testable core
 * of the two-speed control loop.
 *
 * <p>Threading contract:
 * <ul>
 *   <li>{@link #poll} and {@link #effectiveIntent} are called ONLY on the client
 *       (game) thread.</li>
 *   <li>The brain {@link Transport} call runs on a dedicated single daemon thread,
 *       never the caller's thread, so a slow brain never blocks the game tick.</li>
 *   <li>The reply crosses back via an {@link AtomicReference} drained on the client
 *       thread.</li>
 *   <li>A stale / expired intent decays to a safe stop — never a guess on old data.</li>
 * </ul>
 *
 * <p>No Minecraft types are referenced here on purpose: this is the seam that lets
 * the thread model be proven without launching the game (see {@code BrainLinkTest}).
 */
public final class BrainLink {

    /** Injectable transport: send a request body, return the raw response body. */
    public interface Transport {
        String send(String body) throws Exception;
    }

    public record Diagnostics(
        boolean inFlight,
        long dispatchedRequestCount,
        long completedRequestCount,
        long currentIntentAgeMs,
        long currentIntentRemainingTtlMs,
        long currentRequestAgeMs,
        long lastRoundTripMs,
        String currentAction,
        String currentReason,
        String currentCommandId
    ) {
    }

    /** An immutable command for the on-tick applier. */
    public record Intent(
        String action,
        boolean forward,
        boolean back,
        boolean left,
        boolean right,
        boolean jump,
        boolean sneak,
        Double movementForwardOverride,
        Double movementSidewaysOverride,
        Double targetYaw,
        Double targetPitch,
        Double targetX,
        Double targetY,
        Double targetZ,
        List<GridCell> waypoints,
        List<GridCell> blockedCells,
        Double arriveEpsilon,
        List<String> serverCommands,
        long expiresAtMs,
        String reason,
        String commandId
    ) {
        public Intent(
            String action,
            boolean forward,
            boolean back,
            boolean left,
            boolean right,
            boolean jump,
            boolean sneak,
            Double movementForwardOverride,
            Double movementSidewaysOverride,
            Double targetYaw,
            Double targetPitch,
            Double targetX,
            Double targetZ,
            List<GridCell> waypoints,
            List<GridCell> blockedCells,
            Double arriveEpsilon,
            List<String> serverCommands,
            long expiresAtMs,
            String reason,
            String commandId
        ) {
            this(
                action,
                forward,
                back,
                left,
                right,
                jump,
                sneak,
                movementForwardOverride,
                movementSidewaysOverride,
                targetYaw,
                targetPitch,
                targetX,
                null,
                targetZ,
                waypoints,
                blockedCells,
                arriveEpsilon,
                serverCommands,
                expiresAtMs,
                reason,
                commandId
            );
        }

        public Intent(
            String action,
            boolean forward,
            boolean back,
            boolean left,
            boolean right,
            boolean jump,
            boolean sneak,
            Double targetYaw,
            Double targetPitch,
            Double targetX,
            Double targetY,
            Double targetZ,
            List<GridCell> waypoints,
            List<GridCell> blockedCells,
            Double arriveEpsilon,
            List<String> serverCommands,
            long expiresAtMs,
            String reason,
            String commandId
        ) {
            this(
                action,
                forward,
                back,
                left,
                right,
                jump,
                sneak,
                null,
                null,
                targetYaw,
                targetPitch,
                targetX,
                targetY,
                targetZ,
                waypoints,
                blockedCells,
                arriveEpsilon,
                serverCommands,
                expiresAtMs,
                reason,
                commandId
            );
        }

        public Intent(
            String action,
            boolean forward,
            boolean back,
            boolean left,
            boolean right,
            boolean jump,
            boolean sneak,
            Double targetYaw,
            Double targetPitch,
            Double targetX,
            Double targetZ,
            List<GridCell> waypoints,
            List<GridCell> blockedCells,
            Double arriveEpsilon,
            List<String> serverCommands,
            long expiresAtMs,
            String reason,
            String commandId
        ) {
            this(
                action,
                forward,
                back,
                left,
                right,
                jump,
                sneak,
                null,
                null,
                targetYaw,
                targetPitch,
                targetX,
                null,
                targetZ,
                waypoints,
                blockedCells,
                arriveEpsilon,
                serverCommands,
                expiresAtMs,
                reason,
                commandId
            );
        }

        public boolean isFresh(long nowMs) {
            return "stop".equals(action) || expiresAtMs > nowMs;
        }

        public static Intent stop(String reason) {
            return new Intent("stop", false, false, false, false, false, false, null, null, null, null, List.of(), List.of(), null, List.of(), Long.MAX_VALUE, reason, "");
        }
    }

    private final String instanceId;
    private final Transport transport;
    private final long minIntervalMs;
    private final long maxTtlMs;
    private final ExecutorService executor;
    private final AtomicBoolean inFlight = new AtomicBoolean(false);
    private final AtomicReference<Intent> pending = new AtomicReference<>();
    private volatile Intent current = Intent.stop("initial");
    private volatile long currentReceivedAtMs = 0L;
    private volatile long lastRequestStartedAtMs = 0L;
    private volatile long lastRoundTripMs = -1L;
    private volatile long dispatchedRequestCount = 0L;
    private volatile long completedRequestCount = 0L;
    private volatile String recentlyCompletedCommandId = "";
    private volatile String recentlyCompletedAction = "";
    private volatile String recentlyCompletedReason = "command_complete";
    private volatile long recentlyCompletedSuppressUntilMs = 0L;
    private long lastRequestMs = 0L;

    public BrainLink(String instanceId, Transport transport, long minIntervalMs, long maxTtlMs) {
        this.instanceId = instanceId;
        this.transport = transport;
        this.minIntervalMs = minIntervalMs;
        this.maxTtlMs = maxTtlMs;
        this.executor = Executors.newSingleThreadExecutor((task) -> {
            Thread thread = new Thread(task, "mcbot-brain-ipc");
            thread.setDaemon(true);
            return thread;
        });
    }

    /**
     * Client thread: drain any reply into {@code current}, then maybe dispatch a new
     * request off-thread. Returns immediately — it never blocks on the transport.
     */
    public void poll(String snapshotJson, long nowMs) {
        Intent received = pending.getAndSet(null);
        if (received != null) {
            if (shouldSuppressCompletedCommandIntent(received, nowMs)) {
                received = freshStop(nowMs, recentlyCompletedReason, recentlyCompletedCommandId);
            }
            current = received;
            currentReceivedAtMs = nowMs;
        }
        if (inFlight.get() || nowMs - lastRequestMs < minIntervalMs) {
            return;
        }
        if (holdsBrainPolling(current, nowMs)) {
            return;
        }
        lastRequestMs = nowMs;
        lastRequestStartedAtMs = nowMs;
        dispatchedRequestCount++;
        inFlight.set(true);
        // Future private threat-policy hook: transform snapshotJson before dispatch.
        // Deliberately no threat/detection/evasion policy in this spike.
        String body = "instanceId:" + instanceId + "\n" + snapshotJson + "\n";
        long requestStartedAtMs = nowMs;
        executor.submit(() -> {
            try {
                pending.set(parse(transport.send(body), System.currentTimeMillis()));
            } catch (Exception err) {
                pending.set(Intent.stop("brain_error:" + sanitize(err.getMessage())));
            } finally {
                lastRoundTripMs = Math.max(0L, System.currentTimeMillis() - requestStartedAtMs);
                completedRequestCount++;
                inFlight.set(false);
            }
        });
    }

    /** Client thread: the intent to apply now, honoring TTL (expired -> safe stop). */
    public Intent effectiveIntent(long nowMs) {
        Intent c = current;
        return c.isFresh(nowMs) ? c : Intent.stop("intent_expired");
    }

    public Diagnostics diagnostics(long nowMs) {
        Intent c = current;
        long ageMs = currentReceivedAtMs <= 0L ? -1L : Math.max(0L, nowMs - currentReceivedAtMs);
        long remainingTtlMs = c.expiresAtMs() <= 0L ? 0L : c.expiresAtMs() - nowMs;
        long requestAgeMs = inFlight.get() && lastRequestStartedAtMs > 0L
            ? Math.max(0L, nowMs - lastRequestStartedAtMs)
            : 0L;
        return new Diagnostics(
            inFlight.get(),
            dispatchedRequestCount,
            completedRequestCount,
            ageMs,
            remainingTtlMs,
            requestAgeMs,
            lastRoundTripMs,
            c.action(),
            c.reason(),
            c.commandId()
        );
    }

    /** Pure intent-to-input mapping. MC glue copies this value object onto Input. */
    public static InputState inputStateFor(Intent intent) {
        if (intent == null || "stop".equals(intent.action())) {
            return InputState.stop();
        }
        float movementForward = 0.0F;
        if (intent.forward()) {
            movementForward += 1.0F;
        }
        if (intent.back()) {
            movementForward -= 1.0F;
        }
        if (intent.movementForwardOverride() != null) {
            movementForward = clampAxis(intent.movementForwardOverride());
        }

        float movementSideways = 0.0F;
        if (intent.left()) {
            movementSideways += 1.0F;
        }
        if (intent.right()) {
            movementSideways -= 1.0F;
        }
        if (intent.movementSidewaysOverride() != null) {
            movementSideways = clampAxis(intent.movementSidewaysOverride());
        }

        return new InputState(
            intent.forward(),
            intent.back(),
            intent.left(),
            intent.right(),
            intent.jump(),
            intent.sneak(),
            movementForward,
            movementSideways
        );
    }

    /** Latest delivered intent regardless of freshness. Package-private for tests/diagnostics. */
    Intent currentIntent() {
        return current;
    }

    /** Client thread: release a held fast-loop command after the deterministic executor completes it. */
    public void completeCurrentCommand(String commandId, String reason, long nowMs) {
        Intent c = current;
        String expected = commandId == null ? "" : commandId;
        String completedAction = c != null && expected.equals(c.commandId()) ? c.action() : "";
        if (!expected.isBlank() && !completedAction.isBlank()) {
            recentlyCompletedCommandId = expected;
            recentlyCompletedAction = completedAction;
            recentlyCompletedReason = reason == null || reason.isBlank() ? "command_complete" : reason;
            recentlyCompletedSuppressUntilMs = nowMs + Math.max(1_000L, maxTtlMs);
        }
        if (c != null && expected.equals(c.commandId())) {
            current = new Intent(
                "stop",
                false,
                false,
                false,
                false,
                false,
                false,
                null,
                null,
                null,
                null,
                List.of(),
                List.of(),
                null,
                List.of(),
                nowMs + Math.min(250L, Math.max(1L, maxTtlMs)),
                reason == null || reason.isBlank() ? "command_complete" : reason,
                expected
            );
            currentReceivedAtMs = nowMs;
        }
    }

    private boolean shouldSuppressCompletedCommandIntent(Intent intent, long nowMs) {
        return intent != null
            && !"stop".equals(intent.action())
            && nowMs <= recentlyCompletedSuppressUntilMs
            && !recentlyCompletedCommandId.isBlank()
            && recentlyCompletedCommandId.equals(intent.commandId())
            && recentlyCompletedAction.equals(intent.action());
    }

    public void shutdown() {
        executor.shutdownNow();
    }

    /**
     * Parse a brain response into an {@link Intent}. Package-private so the TTL math can
     * be exercised deterministically with a caller-supplied {@code nowMs}.
     */
    Intent parse(String body, long nowMs) {
        if (body == null) {
            throw new IllegalStateException("null brain response");
        }
        int newline = body.indexOf('\n');
        if (newline < 0) {
            throw new IllegalStateException("missing response instance line");
        }
        String firstLine = body.substring(0, newline).trim();
        if (!firstLine.equals("instanceId:" + instanceId)) {
            throw new IllegalStateException("wrong response instance line");
        }
        String json = body.substring(newline + 1).trim();
        JsonObject root;
        try {
            JsonElement parsed = JsonParser.parseString(json.isEmpty() ? "{}" : json);
            root = parsed != null && parsed.isJsonObject() ? parsed.getAsJsonObject() : new JsonObject();
        } catch (JsonSyntaxException err) {
            return freshStop(nowMs, "parse_error", "");
        }

        String action = readString(root, "action", "");
        long ttlMs = readLong(root, "ttlMs", 0L);
        String reason = readString(root, "reason", action.isBlank() ? "stop" : action);
        String commandId = readString(root, "commandId", "");
        long boundedTtlMs = Math.min(Math.max(ttlMs, 1L), maxTtlMs);

        boolean inferredForward = "walk_forward".equals(action);
        boolean inferredBack = "walk_backward".equals(action) || "walk_back".equals(action);
        boolean inferredLeft = "strafe_left".equals(action);
        boolean inferredRight = "strafe_right".equals(action);
        boolean inferredJump = "jump".equals(action);
        boolean inferredSneak = "sneak".equals(action);

        boolean forward = readBoolean(root, "forward", inferredForward);
        boolean back = readBoolean(root, "back", inferredBack);
        boolean left = readBoolean(root, "left", inferredLeft);
        boolean right = readBoolean(root, "right", inferredRight);
        boolean jump = readBoolean(root, "jump", inferredJump);
        boolean sneak = readBoolean(root, "sneak", inferredSneak);
        Double movementForwardOverride = readDouble(root, "movementForward", readDouble(root, "movementForwardOverride", null));
        Double movementSidewaysOverride = readDouble(root, "movementSideways", readDouble(root, "movementSidewaysOverride", null));
        Double targetYaw = readDouble(root, "targetYaw", readDouble(root, "yaw", null));
        Double targetPitch = readDouble(root, "targetPitch", readDouble(root, "pitch", null));
        Double targetX = readDouble(root, "targetX", null);
        Double targetY = readDouble(root, "targetY", null);
        Double targetZ = readDouble(root, "targetZ", null);
        List<GridCell> waypoints = readWaypoints(root);
        List<GridCell> blockedCells = readCells(root, "blockedCells");
        Double arriveEpsilon = readDouble(root, "arriveEpsilon", null);
        List<String> serverCommands = readStringList(root, "serverCommands");
        boolean hasNavigation = (targetX != null && targetZ != null) || !waypoints.isEmpty();
        boolean hasBlockTarget = ("gather_log".equals(action) || "gather_tree".equals(action) || "break_block".equals(action))
            && targetX != null
            && targetY != null
            && targetZ != null;
        boolean hasInventoryAction = isHeldInventoryAction(action);
        boolean hasFastLoopAction = isHeldFastLoopAction(action);
        boolean hasControl = forward
            || back
            || left
            || right
            || jump
            || sneak
            || movementForwardOverride != null
            || movementSidewaysOverride != null
            || targetYaw != null
            || targetPitch != null
            || hasNavigation
            || hasBlockTarget
            || hasInventoryAction
            || hasFastLoopAction
            || !serverCommands.isEmpty();

        if (ttlMs <= 0L || "stop".equals(action) || !hasControl) {
            return new Intent("stop", false, false, false, false, false, false, null, null, null, null, List.of(), List.of(), null, List.of(), nowMs + boundedTtlMs, reason, commandId);
        }
        String normalizedAction = action.isBlank() ? "move" : action;
        return new Intent(
            normalizedAction,
            forward,
            back,
            left,
            right,
            jump,
            sneak,
            movementForwardOverride,
            movementSidewaysOverride,
            targetYaw,
            targetPitch,
            targetX,
            targetY,
            targetZ,
            waypoints,
            blockedCells,
            arriveEpsilon,
            serverCommands,
            nowMs + boundedTtlMs,
            reason,
            commandId
        );
    }

    private Intent freshStop(long nowMs, String reason, String commandId) {
        return new Intent("stop", false, false, false, false, false, false, null, null, null, null, List.of(), List.of(), null, List.of(), nowMs + 1L, reason, commandId);
    }

    private static boolean holdsBrainPolling(Intent intent, long nowMs) {
        if (intent == null || !intent.isFresh(nowMs)) {
            return false;
        }
        return "gather_log".equals(intent.action())
            || "gather_tree".equals(intent.action())
            || "mine_stone".equals(intent.action())
            || "descend_staircase".equals(intent.action())
            || "mine_nearby_stone".equals(intent.action())
            || "mine_nearby_iron".equals(intent.action())
            || "return_staircase".equals(intent.action())
            || "r2_mine_stone_return".equals(intent.action())
            || "r5_iron_chain".equals(intent.action())
            || "break_block".equals(intent.action())
            || isHeldInventoryAction(intent.action());
    }

    private static boolean isHeldFastLoopAction(String action) {
        return "descend_staircase".equals(action)
            || "mine_nearby_stone".equals(action)
            || "mine_nearby_iron".equals(action)
            || "return_staircase".equals(action)
            || "r2_mine_stone_return".equals(action)
            || "r5_iron_chain".equals(action);
    }

    private static boolean isHeldInventoryAction(String action) {
        return "craft_planks".equals(action)
            || "craft_sticks".equals(action)
            || "craft_table".equals(action)
            || "craft_pickaxe".equals(action)
            || "craft_stone_pickaxe".equals(action)
            || "craft_iron_pickaxe".equals(action)
            || "craft_iron_helmet".equals(action)
            || "craft_iron_chestplate".equals(action)
            || "craft_iron_leggings".equals(action)
            || "craft_iron_boots".equals(action)
            || "craft_stone_axe".equals(action)
            || "craft_stone_sword".equals(action)
            || "craft_furnace".equals(action)
            || "equip_armor".equals(action)
            || "place_table".equals(action)
            || "place_furnace".equals(action)
            || "smelt_charcoal".equals(action)
            || "smelt_raw_iron".equals(action)
            || "make_charcoal".equals(action)
            || "retrieve_table".equals(action);
    }

    private static boolean readBoolean(JsonObject root, String name, boolean defaultValue) {
        JsonElement value = root.get(name);
        if (value == null || value.isJsonNull() || !value.isJsonPrimitive()) {
            return defaultValue;
        }
        try {
            if (value.getAsJsonPrimitive().isBoolean()) {
                return value.getAsBoolean();
            }
            if (value.getAsJsonPrimitive().isString()) {
                String text = value.getAsString().trim().toLowerCase(Locale.ROOT);
                if ("true".equals(text)) {
                    return true;
                }
                if ("false".equals(text)) {
                    return false;
                }
            }
        } catch (RuntimeException ignored) {
            return defaultValue;
        }
        return defaultValue;
    }

    private static long readLong(JsonObject root, String name, long defaultValue) {
        JsonElement value = root.get(name);
        if (value == null || value.isJsonNull() || !value.isJsonPrimitive()) {
            return defaultValue;
        }
        try {
            return value.getAsLong();
        } catch (RuntimeException ignored) {
            return defaultValue;
        }
    }

    private static Double readDouble(JsonObject root, String name, Double defaultValue) {
        JsonElement value = root.get(name);
        if (value == null || value.isJsonNull() || !value.isJsonPrimitive()) {
            return defaultValue;
        }
        try {
            double parsed = value.getAsDouble();
            return Double.isFinite(parsed) ? parsed : defaultValue;
        } catch (RuntimeException ignored) {
            return defaultValue;
        }
    }

    private static List<GridCell> readWaypoints(JsonObject root) {
        return readCells(root, "waypoints");
    }

    private static List<GridCell> readCells(JsonObject root, String name) {
        JsonElement value = root.get(name);
        if (value == null || value.isJsonNull() || !value.isJsonArray()) {
            return List.of();
        }
        List<GridCell> parsed = new ArrayList<>();
        for (JsonElement element : value.getAsJsonArray()) {
            if (element == null || !element.isJsonObject()) {
                continue;
            }
            JsonObject waypoint = element.getAsJsonObject();
            Double x = readDouble(waypoint, "x", null);
            Double z = readDouble(waypoint, "z", null);
            if (x != null && z != null) {
                parsed.add(new GridCell((int) Math.floor(x), (int) Math.floor(z)));
            }
        }
        return List.copyOf(parsed);
    }

    private static List<String> readStringList(JsonObject root, String name) {
        JsonElement value = root.get(name);
        if (value == null || value.isJsonNull() || !value.isJsonArray()) {
            return List.of();
        }
        List<String> parsed = new ArrayList<>();
        for (JsonElement element : value.getAsJsonArray()) {
            if (element == null || !element.isJsonPrimitive()) {
                continue;
            }
            String text = element.getAsString();
            if (text != null && !text.isBlank()) {
                parsed.add(text.trim());
            }
        }
        return List.copyOf(parsed);
    }

    private static String readString(JsonObject root, String name, String defaultValue) {
        JsonElement value = root.get(name);
        if (value == null || value.isJsonNull() || !value.isJsonPrimitive()) {
            return defaultValue;
        }
        try {
            return value.getAsString();
        } catch (RuntimeException ignored) {
            return defaultValue;
        }
    }

    private static String sanitize(String value) {
        if (value == null || value.isBlank()) {
            return "unknown";
        }
        return value.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9_.:-]", "_");
    }

    private static float clampAxis(double value) {
        if (!Double.isFinite(value)) {
            return 0.0F;
        }
        return (float) Math.max(-1.0D, Math.min(1.0D, value));
    }
}
