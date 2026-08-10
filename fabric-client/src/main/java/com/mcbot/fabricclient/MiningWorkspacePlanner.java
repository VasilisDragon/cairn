package com.mcbot.fabricclient;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;
import net.minecraft.util.math.Vec3d;

final class MiningWorkspacePlanner {
    static final int MAX_EXPANDED_CELLS = 2_048;
    static final int MAX_CARVE_BLOCKS = 12;
    private static final double EYE_HEIGHT = 1.62D;
    private static final VoxelCell[] NEIGHBORS = {
        new VoxelCell(1, 0, 0),
        new VoxelCell(-1, 0, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(0, 0, -1)
    };

    private MiningWorkspacePlanner() {
    }

    static Result plan(
        VoxelPerception perception,
        VoxelCell start,
        List<Site> sites,
        double interactionReach,
        Set<String> excludedWorkspaceIds
    ) {
        return plan(perception, start, sites, interactionReach, excludedWorkspaceIds, MAX_EXPANDED_CELLS);
    }

    static Result plan(
        VoxelPerception perception,
        VoxelCell start,
        List<Site> sites,
        double interactionReach,
        Set<String> excludedWorkspaceIds,
        int maxExpandedCells
    ) {
        if (perception == null || start == null || sites == null
            || !Double.isFinite(interactionReach) || interactionReach <= 0.0D) {
            return new Result(null, "invalid_request", 0);
        }
        if (!perception.isStandable(start.x(), start.y(), start.z())) {
            return new Result(null, "start_unstandable", 0);
        }
        int budget = Math.max(1, Math.min(MAX_EXPANDED_CELLS, maxExpandedCells));
        Set<String> excluded = excludedWorkspaceIds == null ? Set.of() : Set.copyOf(excludedWorkspaceIds);
        List<Site> eligible = sites.stream().filter(site -> validSite(perception, site)).toList();
        PriorityQueue<Node> open = new PriorityQueue<>(
            Comparator.comparingInt(Node::cost)
                .thenComparingInt(node -> node.cell().y())
                .thenComparingInt(node -> node.cell().z())
                .thenComparingInt(node -> node.cell().x())
        );
        Map<VoxelCell, VoxelCell> cameFrom = new HashMap<>();
        Map<VoxelCell, Integer> bestCost = new HashMap<>();
        Set<VoxelCell> closed = new HashSet<>();
        List<Candidate> candidates = new ArrayList<>();
        bestCost.put(start, 0);
        open.add(new Node(start, 0));

        while (!open.isEmpty() && closed.size() < budget) {
            Node node = open.poll();
            VoxelCell stance = node.cell();
            if (!closed.add(stance)) {
                continue;
            }
            List<VoxelCell> route = reconstruct(cameFrom, start, stance);
            for (Site table : eligible) {
                if (table.interactiveSupport() || !usableFrom(perception, stance, table, interactionReach, route)) {
                    continue;
                }
                for (Site furnace : eligible) {
                    if (table.support().equals(furnace.support())
                        || table.placement().equals(furnace.placement())
                        || !usableFrom(perception, stance, furnace, interactionReach, route)
                        || !hasSafeEgress(perception, stance, route, table.placement(), furnace.placement())) {
                        continue;
                    }
                    String workspaceId = workspaceId(table, furnace);
                    if (excluded.contains(workspaceId)) {
                        continue;
                    }
                    double tableDistance = interactionDistance(stance, table.support());
                    double furnaceDistance = interactionDistance(stance, furnace.support());
                    candidates.add(new Candidate(
                        workspaceId,
                        stance,
                        table,
                        furnace,
                        route,
                        furnace.interactiveSupport() || furnace.interactiveAdjacent(),
                        Math.max(tableDistance, furnaceDistance),
                        Math.abs(stance.y() - start.y())
                    ));
                }
            }
            for (VoxelCell delta : NEIGHBORS) {
                VoxelAStar.Move move = VoxelAStar.resolveTraversalMove(perception, stance, delta);
                VoxelCell next = move.destination();
                if (next == null || closed.contains(next)) {
                    continue;
                }
                int cost = node.cost() + move.cost();
                if (cost >= bestCost.getOrDefault(next, Integer.MAX_VALUE)) {
                    continue;
                }
                bestCost.put(next, cost);
                cameFrom.put(next, stance);
                open.add(new Node(next, cost));
            }
        }

        if (candidates.isEmpty()) {
            return new Result(null, open.isEmpty() ? "no_reachable_site" : "expanded_budget", closed.size());
        }
        Candidate chosen = candidates.stream().min(
            Comparator.comparingInt((Candidate candidate) -> candidate.sneakRequired() ? 1 : 0)
                .thenComparingInt(candidate -> candidate.route().size())
                .thenComparingDouble(Candidate::interactionDistance)
                .thenComparingInt(Candidate::verticalDisplacement)
                .thenComparingInt(candidate -> candidate.table().support().y())
                .thenComparingInt(candidate -> candidate.table().support().z())
                .thenComparingInt(candidate -> candidate.table().support().x())
                .thenComparingInt(candidate -> candidate.furnace().support().y())
                .thenComparingInt(candidate -> candidate.furnace().support().z())
                .thenComparingInt(candidate -> candidate.furnace().support().x())
                .thenComparingInt(candidate -> candidate.stance().y())
                .thenComparingInt(candidate -> candidate.stance().z())
                .thenComparingInt(candidate -> candidate.stance().x())
        ).orElseThrow();
        return new Result(new Plan(
            chosen.workspaceId(),
            chosen.stance(),
            chosen.table().support(),
            chosen.table().placement(),
            chosen.furnace().support(),
            chosen.furnace().placement(),
            chosen.route(),
            chosen.sneakRequired(),
            closed.size(),
            chosen.interactionDistance(),
            chosen.stance().y() - start.y(),
            List.of()
        ), "", closed.size());
    }

    static CarveResult validateCarve(CarveOption option) {
        if (option == null || option.blocks() == null || option.blocks().isEmpty()) {
            return new CarveResult(false, "missing_carve", List.of());
        }
        List<VoxelCell> blocks = List.copyOf(option.blocks());
        if (blocks.size() > MAX_CARVE_BLOCKS) {
            return new CarveResult(false, "carve_budget", List.of());
        }
        if (new HashSet<>(blocks).size() != blocks.size()) {
            return new CarveResult(false, "duplicate_carve_cell", List.of());
        }
        if (!option.nonOre() || !option.supportsPreserved()) {
            return new CarveResult(false, "unsafe_support_or_ore", List.of());
        }
        if (!option.fluidBoundaryClosed() || !option.hazardBoundaryClosed()) {
            return new CarveResult(false, "fluid_or_hazard_boundary", List.of());
        }
        return new CarveResult(true, "", blocks);
    }

    private static boolean validSite(VoxelPerception perception, Site site) {
        return site != null
            && site.support() != null
            && site.placement() != null
            && site.placement().x() == site.support().x()
            && site.placement().y() == site.support().y() + 1
            && site.placement().z() == site.support().z()
            && perception.inBounds(site.support().x(), site.support().y(), site.support().z())
            && perception.inBounds(site.placement().x(), site.placement().y(), site.placement().z())
            && perception.isSolid(site.support().x(), site.support().y(), site.support().z())
            && !perception.isHazard(site.support().x(), site.support().y(), site.support().z())
            && !perception.isHazard(site.placement().x(), site.placement().y(), site.placement().z())
            && site.placementOpen()
            && !site.supportOre()
            && !site.recordedTrail()
            && !site.liquid()
            && !site.adjacentLava()
            && !site.gravityUnstable();
    }

    private static boolean usableFrom(
        VoxelPerception perception,
        VoxelCell stance,
        Site site,
        double interactionReach,
        List<VoxelCell> route
    ) {
        if (site.support().y() != stance.y() - 1
            || site.placement().y() != stance.y()
            || bodyIntersects(stance, site.placement())
            || route.contains(site.placement())) {
            return false;
        }
        Vec3d eye = eyePosition(stance);
        Vec3d supportTop = supportTop(site.support());
        return eye.distanceTo(supportTop) <= interactionReach
            && clearLineOfSight(perception, eye, supportTop, site.support());
    }

    private static boolean hasSafeEgress(
        VoxelPerception perception,
        VoxelCell stance,
        List<VoxelCell> route,
        VoxelCell tablePlacement,
        VoxelCell furnacePlacement
    ) {
        if (route.size() > 1) {
            VoxelCell previous = route.get(route.size() - 2);
            return !previous.equals(tablePlacement)
                && !previous.equals(furnacePlacement)
                && perception.isStandable(previous.x(), previous.y(), previous.z());
        }
        for (VoxelCell delta : NEIGHBORS) {
            VoxelCell next = VoxelAStar.resolveTraversalMove(perception, stance, delta).destination();
            if (next != null && !next.equals(tablePlacement) && !next.equals(furnacePlacement)) {
                return true;
            }
        }
        return false;
    }

    private static boolean bodyIntersects(VoxelCell stance, VoxelCell placement) {
        return placement.x() == stance.x()
            && placement.z() == stance.z()
            && (placement.y() == stance.y() || placement.y() == stance.y() + 1);
    }

    private static double interactionDistance(VoxelCell stance, VoxelCell support) {
        return eyePosition(stance).distanceTo(supportTop(support));
    }

    private static Vec3d eyePosition(VoxelCell stance) {
        return new Vec3d(stance.x() + 0.5D, stance.y() + EYE_HEIGHT, stance.z() + 0.5D);
    }

    private static Vec3d supportTop(VoxelCell support) {
        return new Vec3d(support.x() + 0.5D, support.y() + 1.0D, support.z() + 0.5D);
    }

    private static boolean clearLineOfSight(
        VoxelPerception perception,
        Vec3d eye,
        Vec3d target,
        VoxelCell support
    ) {
        double distance = eye.distanceTo(target);
        int steps = Math.max(1, (int) Math.ceil(distance * 10.0D));
        for (int step = 1; step < steps; step++) {
            double t = step / (double) steps;
            int x = (int) Math.floor(eye.x + ((target.x - eye.x) * t));
            int y = (int) Math.floor(eye.y + ((target.y - eye.y) * t));
            int z = (int) Math.floor(eye.z + ((target.z - eye.z) * t));
            if (x == support.x() && y == support.y() && z == support.z()) {
                continue;
            }
            if (!perception.inBounds(x, y, z) || perception.isSolid(x, y, z)) {
                return false;
            }
        }
        return true;
    }

    private static List<VoxelCell> reconstruct(
        Map<VoxelCell, VoxelCell> cameFrom,
        VoxelCell start,
        VoxelCell goal
    ) {
        ArrayDeque<VoxelCell> reversed = new ArrayDeque<>();
        VoxelCell cursor = goal;
        reversed.addFirst(cursor);
        while (!cursor.equals(start)) {
            cursor = cameFrom.get(cursor);
            if (cursor == null) {
                return List.of();
            }
            reversed.addFirst(cursor);
        }
        return List.copyOf(reversed);
    }

    private static String workspaceId(Site table, Site furnace) {
        return "workspace:"
            + table.support().x() + ":" + table.support().y() + ":" + table.support().z()
            + ":"
            + furnace.support().x() + ":" + furnace.support().y() + ":" + furnace.support().z();
    }

    record Site(
        VoxelCell support,
        VoxelCell placement,
        boolean placementOpen,
        boolean supportOre,
        boolean recordedTrail,
        boolean liquid,
        boolean adjacentLava,
        boolean gravityUnstable,
        boolean interactiveSupport,
        boolean interactiveAdjacent
    ) {
    }

    record Plan(
        String workspaceId,
        VoxelCell stance,
        VoxelCell tableSupport,
        VoxelCell tablePlacement,
        VoxelCell furnaceSupport,
        VoxelCell furnacePlacement,
        List<VoxelCell> route,
        boolean furnaceSneakRequired,
        int expandedCells,
        double interactionDistance,
        int verticalDelta,
        List<VoxelCell> carveBlocks
    ) {
    }

    record Result(Plan plan, String failureReason, int expandedCells) {
        boolean found() {
            return plan != null;
        }
    }

    record CarveOption(
        List<VoxelCell> blocks,
        boolean nonOre,
        boolean supportsPreserved,
        boolean fluidBoundaryClosed,
        boolean hazardBoundaryClosed
    ) {
    }

    record CarveResult(boolean accepted, String reason, List<VoxelCell> blocks) {
    }

    private record Node(VoxelCell cell, int cost) {
    }

    private record Candidate(
        String workspaceId,
        VoxelCell stance,
        Site table,
        Site furnace,
        List<VoxelCell> route,
        boolean sneakRequired,
        double interactionDistance,
        int verticalDisplacement
    ) {
    }
}
