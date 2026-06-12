package com.mcbot.fabricclient;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.OptionalInt;

/**
 * A captured collect-item stall: the bot mined a drop but cannot pick it up within the collect timeout,
 * looping look-at-item without closing the gap (Phase 1.6). The classic case is a drop that fell BELOW
 * the bot into dug terrain: the 2-D collect navigation routes to the drop's x,z, but the item sits a few
 * blocks down, so the bot stands above it and never gets within pickup range.
 *
 * <p>Wraps a {@link NavReplayRecording} (perception + A* botCell -> dropCell, reproducible offline) and
 * adds the 3-D drop + bot positions and the collect elapsed, so the VERTICAL mismatch the 2-D collect
 * ignores is both visible and offline-reproducible. Reuses the Phase-1 record/replay faithfulness for the
 * route. GSON-serializable, Minecraft-independent.
 */
final class CollectStallRecording {
    // Pickup needs the bot within ~1 block of the item vertically; allow a little slack.
    static final double PICKUP_VERTICAL_RANGE = 1.5;

    String commandId = "";
    String reason = "collect_no_pickup";
    String dropItemId = "";
    double dropX;
    double dropY;
    double dropZ;
    double botX;
    double botY;
    double botZ;
    double botYaw;
    int botFeetY;
    long collectElapsedMs;
    NavReplayRecording route; // perception + A* botCell -> dropCell

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    GridCell botCell() {
        return new GridCell((int) Math.floor(botX), (int) Math.floor(botZ));
    }

    GridCell dropCell() {
        return new GridCell((int) Math.floor(dropX), (int) Math.floor(dropZ));
    }

    /** The surfaceY the 2-D collect would arrive at over the drop's cell (empty = unstandable there). */
    OptionalInt dropCellSurfaceY() {
        return route == null ? OptionalInt.empty() : route.toPerception().surfaceY(dropCell().x(), dropCell().z());
    }

    /** Vertical blocks between where the bot would stand at the drop's cell and the drop itself
     * (positive = drop is below the arrival surface). Null if the drop's cell is unstandable. */
    Double verticalGapToDrop() {
        OptionalInt surface = dropCellSurfaceY();
        return surface.isEmpty() ? null : surface.getAsInt() - dropY;
    }

    /** The Phase-1 faithfulness check: the 2-D route to the drop cell reproduces its live outcome. */
    boolean reproducesRoute() {
        return route != null && route.reproducesLiveOutcome();
    }

    /** Reproduces the collect failure: either no route to the drop cell, or the route arrives at a surface
     * that is more than a pickup-range above/below the drop (the fell-below case). */
    boolean reproducesUnreachableDrop() {
        if (route == null) {
            return false;
        }
        if (!route.liveRouteFound) {
            return true;
        }
        Double gap = verticalGapToDrop();
        return gap != null && Math.abs(gap) > PICKUP_VERTICAL_RANGE;
    }

    String summary() {
        Double gap = verticalGapToDrop();
        return "reason=" + reason + " dropItem=" + dropItemId
            + " drop=(" + r(dropX) + "," + r(dropY) + "," + r(dropZ) + ")"
            + " bot=(" + r(botX) + "," + botFeetY + "," + r(botZ) + ")"
            + " botCell=" + botCell() + " dropCell=" + dropCell()
            + " dropCellSurfaceY=" + (dropCellSurfaceY().isPresent() ? Integer.toString(dropCellSurfaceY().getAsInt()) : "blocked")
            + " verticalGap=" + (gap == null ? "n/a" : Double.toString(r(gap)))
            + " routeFound=" + (route != null && route.liveRouteFound)
            + " collectElapsedMs=" + collectElapsedMs;
    }

    private static double r(double value) {
        return Math.round(value * 100.0) / 100.0;
    }

    String toJson() {
        return GSON.toJson(this);
    }

    static CollectStallRecording fromJson(String json) {
        return GSON.fromJson(json, CollectStallRecording.class);
    }

    void save(Path file) {
        try {
            if (file.getParent() != null) {
                Files.createDirectories(file.getParent());
            }
            Files.writeString(file, toJson());
        } catch (Throwable ignored) {
            // dev aid; a failed write must never break a run
        }
    }

    static CollectStallRecording load(Path file) {
        try {
            return fromJson(Files.readString(file));
        } catch (Throwable t) {
            return null;
        }
    }
}
