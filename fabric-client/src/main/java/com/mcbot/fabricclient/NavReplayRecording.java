package com.mcbot.fabricclient;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.OptionalInt;

/**
 * A captured, replayable navigation perception plus the live A* outcome — the foundation for offline
 * pathing debugging (Phase 1 of the pathing-hardening plan).
 *
 * <p>It records the EXACT answers a {@link GridPerception} (in practice the live {@link
 * WorldGridPerception}) gave the pathfinder over its bounded box: {@code surfaceY} per cell and {@code
 * traversalIssue} per in-bounds 4-adjacency. Because {@link GridAStar} is a pure function of the
 * {@link GridPerception} interface, replaying those recorded answers reproduces the live route result
 * byte-for-byte — including the clearance-aware {@code traversalIssue} that {@code WorldGridPerception}
 * overrides (which a surfaceY-only sim would miss). That faithfulness is a property of the interface,
 * so it is provable with an offline round-trip test (see {@code NavReplayRecordingTest}).
 *
 * <p>Minecraft-independent + GSON-serializable (primitives + String-keyed maps), so recorded real
 * failures can be replayed, fixed, and re-verified entirely offline.
 */
final class NavReplayRecording {
    int minX;
    int maxX;
    int minZ;
    int maxZ;
    int referenceFeetY;
    int startX;
    int startZ;
    int goalX;
    int goalZ;
    // "x,z" -> surfaceY at that cell. A cell ABSENT from this map is blocked (surfaceY empty).
    Map<String, Integer> surfaceY = new LinkedHashMap<>();
    // "fx,fz>tx,tz" -> TraversalIssue name, for every in-bounds 4-adjacency the pathfinder could query.
    Map<String, String> traversal = new LinkedHashMap<>();
    // The live A* outcome, captured for round-trip assertion.
    boolean liveRouteFound;
    int liveRouteLength;
    String liveFailureReason = "";

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    private static final GridCell[] NEIGHBORS = {
        new GridCell(1, 0),
        new GridCell(-1, 0),
        new GridCell(0, 1),
        new GridCell(0, -1)
    };

    static String cellKey(int x, int z) {
        return x + "," + z;
    }

    static String edgeKey(GridCell from, GridCell to) {
        return from.x() + "," + from.z() + ">" + to.x() + "," + to.z();
    }

    GridCell start() {
        return new GridCell(startX, startZ);
    }

    GridCell goal() {
        return new GridCell(goalX, goalZ);
    }

    /**
     * Capture every answer {@code perception} gives over its bounds, plus the live diagnostic, into a
     * recording that replays A* identically. Records only what the pathfinder can observe — no MC types.
     */
    static NavReplayRecording capture(
        GridPerception perception,
        int referenceFeetY,
        GridCell start,
        GridCell goal,
        GridRouteDiagnostic live
    ) {
        NavReplayRecording r = new NavReplayRecording();
        r.minX = perception.minX();
        r.maxX = perception.maxX();
        r.minZ = perception.minZ();
        r.maxZ = perception.maxZ();
        r.referenceFeetY = referenceFeetY;
        r.startX = start.x();
        r.startZ = start.z();
        r.goalX = goal.x();
        r.goalZ = goal.z();
        for (int x = r.minX; x <= r.maxX; x++) {
            for (int z = r.minZ; z <= r.maxZ; z++) {
                OptionalInt surface = perception.surfaceY(x, z);
                if (surface.isPresent()) {
                    r.surfaceY.put(cellKey(x, z), surface.getAsInt());
                }
                GridCell from = new GridCell(x, z);
                for (GridCell delta : NEIGHBORS) {
                    GridCell to = new GridCell(x + delta.x(), z + delta.z());
                    if (to.x() < r.minX || to.x() > r.maxX || to.z() < r.minZ || to.z() > r.maxZ) {
                        continue;
                    }
                    r.traversal.put(edgeKey(from, to), perception.traversalIssue(from, to).name());
                }
            }
        }
        r.liveRouteFound = live != null && live.routeFound();
        r.liveRouteLength = live == null ? 0 : live.routeLength();
        r.liveFailureReason = live == null ? "" : live.failureReason();
        return r;
    }

    /** A {@link GridPerception} that replays the recorded answers exactly. */
    GridPerception toPerception() {
        return new Replayed(this);
    }

    /** Re-run A* over the replayed perception — should match the live outcome. */
    GridRouteDiagnostic reproduce() {
        return GridAStar.diagnose(toPerception(), start(), goal());
    }

    /** True when an offline replay reproduces the recorded live route result (faithfulness check). */
    boolean reproducesLiveOutcome() {
        GridRouteDiagnostic d = reproduce();
        return d.routeFound() == liveRouteFound
            && d.routeLength() == liveRouteLength
            && d.failureReason().equals(liveFailureReason);
    }

    String summary() {
        int cells = (maxX - minX + 1) * (maxZ - minZ + 1);
        return "bounds=[" + minX + "," + maxX + "]x[" + minZ + "," + maxZ + "]"
            + " cells=" + cells + " standable=" + surfaceY.size()
            + " start=" + start() + " goal=" + goal()
            + " liveRouteFound=" + liveRouteFound + " liveReason=" + liveFailureReason;
    }

    String toJson() {
        return GSON.toJson(this);
    }

    static NavReplayRecording fromJson(String json) {
        return GSON.fromJson(json, NavReplayRecording.class);
    }

    void save(Path file) {
        try {
            if (file.getParent() != null) {
                Files.createDirectories(file.getParent());
            }
            Files.writeString(file, toJson());
        } catch (Throwable ignored) {
            // recording is a dev aid; a failed write must never break a run
        }
    }

    static NavReplayRecording load(Path file) {
        try {
            return fromJson(Files.readString(file));
        } catch (Throwable t) {
            return null;
        }
    }

    /** Replays recorded {@code surfaceY} / {@code traversalIssue} answers; pure, no Minecraft types. */
    private static final class Replayed implements GridPerception {
        private final NavReplayRecording recording;

        Replayed(NavReplayRecording recording) {
            this.recording = recording;
        }

        @Override
        public int minX() {
            return recording.minX;
        }

        @Override
        public int maxX() {
            return recording.maxX;
        }

        @Override
        public int minZ() {
            return recording.minZ;
        }

        @Override
        public int maxZ() {
            return recording.maxZ;
        }

        @Override
        public boolean isBlocked(int x, int z) {
            return surfaceY(x, z).isEmpty();
        }

        @Override
        public OptionalInt surfaceY(int x, int z) {
            if (!inBounds(x, z)) {
                return OptionalInt.empty();
            }
            Integer y = recording.surfaceY.get(cellKey(x, z));
            return y == null ? OptionalInt.empty() : OptionalInt.of(y);
        }

        @Override
        public TraversalIssue traversalIssue(GridCell from, GridCell to) {
            if (from == null || to == null) {
                return TraversalIssue.INVALID_REQUEST;
            }
            String name = recording.traversal.get(edgeKey(from, to));
            if (name != null) {
                try {
                    return TraversalIssue.valueOf(name);
                } catch (IllegalArgumentException ignored) {
                    // fall through to the interface default
                }
            }
            return GridPerception.super.traversalIssue(from, to);
        }
    }
}
