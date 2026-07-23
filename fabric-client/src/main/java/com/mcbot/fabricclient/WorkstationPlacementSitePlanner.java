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

final class WorkstationPlacementSitePlanner {
    static final int MAX_EXPANDED_CELLS = 2_048;
    private static final double EYE_HEIGHT = 1.62D;
    private static final VoxelCell[] NEIGHBORS = {
        new VoxelCell(1, 0, 0),
        new VoxelCell(-1, 0, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(0, 0, -1)
    };

    enum Mode {
        TABLE,
        FURNACE
    }

    private WorkstationPlacementSitePlanner() {
    }

    static Result plan(
        VoxelPerception perception,
        VoxelCell start,
        List<Site> sites,
        Mode mode,
        double interactionReach,
        Set<VoxelCell> excludedSupports
    ) {
        return plan(perception, start, sites, mode, interactionReach, excludedSupports, MAX_EXPANDED_CELLS);
    }

    static Result plan(
        VoxelPerception perception,
        VoxelCell start,
        List<Site> sites,
        Mode mode,
        double interactionReach,
        Set<VoxelCell> excludedSupports,
        int maxExpandedCells
    ) {
        if (perception == null || start == null || sites == null || mode == null
            || !Double.isFinite(interactionReach) || interactionReach <= 0.0D) {
            return new Result(null, "invalid_request", 0);
        }
        if (!perception.isStandable(start.x(), start.y(), start.z())) {
            return new Result(null, "start_unstandable", 0);
        }
        Set<VoxelCell> excluded = excludedSupports == null ? Set.of() : Set.copyOf(excludedSupports);
        List<Site> eligibleSites = sites.stream()
            .filter(site -> validSite(perception, site, mode, excluded))
            .toList();
        int budget = Math.max(1, Math.min(MAX_EXPANDED_CELLS, maxExpandedCells));
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
            for (Site site : eligibleSites) {
                if (!bodyClearOfPlacement(stance, site.placement())) {
                    continue;
                }
                Vec3d eye = eyePosition(stance);
                Vec3d supportTop = supportTop(site.support());
                double distance = eye.distanceTo(supportTop);
                if (distance > interactionReach || !clearLineOfSight(perception, eye, supportTop, site.support())) {
                    continue;
                }
                List<VoxelCell> route = reconstruct(cameFrom, start, stance);
                if (route.contains(site.placement()) || !hasSafeEgress(perception, stance, site.placement(), route)) {
                    continue;
                }
                candidates.add(new Candidate(
                    stance,
                    site,
                    route,
                    mode == Mode.FURNACE && (site.interactiveSupport() || site.interactiveAdjacent()),
                    distance,
                    Math.abs(stance.y() - start.y())
                ));
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
                .thenComparingInt(candidate -> candidate.site().support().y())
                .thenComparingInt(candidate -> candidate.site().support().z())
                .thenComparingInt(candidate -> candidate.site().support().x())
                .thenComparingInt(candidate -> candidate.stance().y())
                .thenComparingInt(candidate -> candidate.stance().z())
                .thenComparingInt(candidate -> candidate.stance().x())
        ).orElseThrow();
        return new Result(new Plan(
            chosen.stance(),
            chosen.site().support(),
            chosen.site().placement(),
            chosen.route(),
            chosen.sneakRequired(),
            closed.size(),
            chosen.interactionDistance(),
            chosen.stance().y() - start.y()
        ), "", closed.size());
    }

    private static boolean validSite(
        VoxelPerception perception,
        Site site,
        Mode mode,
        Set<VoxelCell> excluded
    ) {
        if (site == null || site.support() == null || site.placement() == null
            || site.placement().x() != site.support().x()
            || site.placement().y() != site.support().y() + 1
            || site.placement().z() != site.support().z()
            || excluded.contains(site.support())
            || !perception.inBounds(site.support().x(), site.support().y(), site.support().z())
            || !perception.inBounds(site.placement().x(), site.placement().y(), site.placement().z())
            || !perception.isSolid(site.support().x(), site.support().y(), site.support().z())
            || perception.isHazard(site.support().x(), site.support().y(), site.support().z())
            || perception.isHazard(site.placement().x(), site.placement().y(), site.placement().z())
            || !site.placementOpen()
            || site.supportOre()
            || site.recordedTrail()
            || site.liquid()
            || site.adjacentLava()) {
            return false;
        }
        return mode != Mode.TABLE || !site.interactiveSupport();
    }

    private static boolean bodyClearOfPlacement(VoxelCell stance, VoxelCell placement) {
        return !(placement.x() == stance.x() && placement.z() == stance.z()
            && (placement.y() == stance.y() || placement.y() == stance.y() + 1));
    }

    private static boolean hasSafeEgress(
        VoxelPerception perception,
        VoxelCell stance,
        VoxelCell placement,
        List<VoxelCell> route
    ) {
        if (route.size() > 1) {
            VoxelCell previous = route.get(route.size() - 2);
            return !previous.equals(placement) && perception.isStandable(previous.x(), previous.y(), previous.z());
        }
        for (VoxelCell delta : NEIGHBORS) {
            VoxelCell next = VoxelAStar.resolveTraversalMove(perception, stance, delta).destination();
            if (next != null && !next.equals(placement)) {
                return true;
            }
        }
        return false;
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
            int x = (int) Math.floor(eye.x + (target.x - eye.x) * t);
            int y = (int) Math.floor(eye.y + (target.y - eye.y) * t);
            int z = (int) Math.floor(eye.z + (target.z - eye.z) * t);
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

    record Site(
        VoxelCell support,
        VoxelCell placement,
        boolean placementOpen,
        boolean supportOre,
        boolean recordedTrail,
        boolean liquid,
        boolean adjacentLava,
        boolean interactiveSupport,
        boolean interactiveAdjacent
    ) {
    }

    record Plan(
        VoxelCell stance,
        VoxelCell support,
        VoxelCell placement,
        List<VoxelCell> route,
        boolean sneakRequired,
        int expandedCells,
        double interactionDistance,
        int verticalDelta
    ) {
    }

    record Result(Plan plan, String failureReason, int expandedCells) {
        boolean found() {
            return plan != null && !plan.route().isEmpty();
        }
    }

    private record Node(VoxelCell cell, int cost) {
    }

    private record Candidate(
        VoxelCell stance,
        Site site,
        List<VoxelCell> route,
        boolean sneakRequired,
        double interactionDistance,
        int verticalDisplacement
    ) {
    }
}
