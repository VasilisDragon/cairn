package com.mcbot.fabricclient;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * A captured, replayable 3-D voxel perception plus the A* outcome.
 *
 * <p>Stores only what {@link VoxelAStar} can observe: solid/hazard answers over a bounded voxel box.
 * Replaying those answers reproduces the route result because A* is pure over {@link VoxelPerception}.
 */
final class Nav3DRecording {
    int minX;
    int maxX;
    int minY;
    int maxY;
    int minZ;
    int maxZ;
    int startX;
    int startY;
    int startZ;
    int goalX;
    int goalY;
    int goalZ;
    Double targetX;
    Double targetY;
    Double targetZ;
    Set<String> solid = new LinkedHashSet<>();
    Set<String> hazard = new LinkedHashSet<>();
    boolean liveRouteFound;
    int liveRouteLength;
    String liveFailureReason = "";

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    static String cellKey(int x, int y, int z) {
        return x + "," + y + "," + z;
    }

    VoxelCell start() {
        return new VoxelCell(startX, startY, startZ);
    }

    VoxelCell goal() {
        return new VoxelCell(goalX, goalY, goalZ);
    }

    static Nav3DRecording capture(
        VoxelPerception perception,
        VoxelCell start,
        VoxelCell goal,
        Nav3DRouteDiagnostic live
    ) {
        Nav3DRecording recording = new Nav3DRecording();
        recording.minX = perception.minX();
        recording.maxX = perception.maxX();
        recording.minY = perception.minY();
        recording.maxY = perception.maxY();
        recording.minZ = perception.minZ();
        recording.maxZ = perception.maxZ();
        recording.startX = start.x();
        recording.startY = start.y();
        recording.startZ = start.z();
        recording.goalX = goal.x();
        recording.goalY = goal.y();
        recording.goalZ = goal.z();
        for (int x = recording.minX; x <= recording.maxX; x++) {
            for (int y = recording.minY; y <= recording.maxY; y++) {
                for (int z = recording.minZ; z <= recording.maxZ; z++) {
                    if (perception.isSolid(x, y, z)) {
                        recording.solid.add(cellKey(x, y, z));
                    }
                    if (perception.isHazard(x, y, z)) {
                        recording.hazard.add(cellKey(x, y, z));
                    }
                }
            }
        }
        recording.liveRouteFound = live != null && live.routeFound();
        recording.liveRouteLength = live == null ? 0 : live.routeLength();
        recording.liveFailureReason = live == null ? "" : live.failureReason();
        return recording;
    }

    static Nav3DRecording captureCollect(
        VoxelPerception perception,
        VoxelCell start,
        double targetX,
        double targetY,
        double targetZ,
        CollectTarget3DPlanner.TargetPlan live
    ) {
        VoxelCell selected = live == null || live.cell() == null ? start : live.cell();
        Nav3DRecording recording = capture(
            perception,
            start,
            selected,
            new Nav3DRouteDiagnostic(
                live == null ? List.of() : live.route(),
                live == null ? "invalid_request" : live.reason(),
                0,
                Map.of()
            )
        );
        recording.targetX = targetX;
        recording.targetY = targetY;
        recording.targetZ = targetZ;
        recording.liveRouteFound = live != null && live.cell() != null;
        recording.liveRouteLength = live == null ? 0 : live.route().size();
        recording.liveFailureReason = live == null ? "invalid_request" : live.reason();
        return recording;
    }

    VoxelPerception toPerception() {
        return new Replayed(this);
    }

    Nav3DRouteDiagnostic reproduce() {
        return VoxelAStar.diagnose(toPerception(), start(), goal());
    }

    boolean reproducesLiveOutcome() {
        Nav3DRouteDiagnostic diagnostic = reproduce();
        return diagnostic.routeFound() == liveRouteFound
            && diagnostic.routeLength() == liveRouteLength
            && diagnostic.failureReason().equals(liveFailureReason);
    }

    CollectTarget3DPlanner.TargetPlan reproduceCollectTarget() {
        if (targetX == null || targetY == null || targetZ == null) {
            return new CollectTarget3DPlanner.TargetPlan(null, List.of(), "missing_collect_target");
        }
        return CollectTarget3DPlanner.chooseTarget(toPerception(), start(), targetX, targetY, targetZ);
    }

    boolean reproducesLiveCollectOutcome() {
        CollectTarget3DPlanner.TargetPlan plan = reproduceCollectTarget();
        return (plan.cell() != null) == liveRouteFound
            && plan.route().size() == liveRouteLength
            && plan.reason().equals(liveFailureReason);
    }

    String summary() {
        int cells = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
        return "bounds=[" + minX + "," + maxX + "]x[" + minY + "," + maxY + "]x[" + minZ + "," + maxZ + "]"
            + " cells=" + cells + " solid=" + solid.size() + " hazard=" + hazard.size()
            + " start=" + start() + " goal=" + goal()
            + " liveRouteFound=" + liveRouteFound + " liveReason=" + liveFailureReason;
    }

    String toJson() {
        return GSON.toJson(this);
    }

    static Nav3DRecording fromJson(String json) {
        return GSON.fromJson(json, Nav3DRecording.class);
    }

    void save(Path file) {
        try {
            if (file.getParent() != null) {
                Files.createDirectories(file.getParent());
            }
            Files.writeString(file, toJson());
        } catch (Throwable ignored) {
            // recording is a dev aid; failed writes must never affect a run
        }
    }

    static Optional<Nav3DRecording> load(Path file) {
        try {
            return Optional.ofNullable(fromJson(Files.readString(file)));
        } catch (Throwable t) {
            return Optional.empty();
        }
    }

    private static final class Replayed implements VoxelPerception {
        private final Nav3DRecording recording;

        Replayed(Nav3DRecording recording) {
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
        public int minY() {
            return recording.minY;
        }

        @Override
        public int maxY() {
            return recording.maxY;
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
        public boolean isSolid(int x, int y, int z) {
            return !inBounds(x, y, z) || recording.solid.contains(cellKey(x, y, z));
        }

        @Override
        public boolean isHazard(int x, int y, int z) {
            return !inBounds(x, y, z) || recording.hazard.contains(cellKey(x, y, z));
        }
    }
}
