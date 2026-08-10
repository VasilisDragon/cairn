package com.mcbot.fabricclient;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.PriorityQueue;
import java.util.Set;

/**
 * Pure bounded planner for the one code-owned iron-golem defense package.
 *
 * <p>The planner may traverse already-safe terrain and may reserve exactly three vertical filler
 * placements. It cannot clear blocks, invent supports, search for arbitrary construction, or
 * expose the entity identity outside its returned package.</p>
 */
final class IronGolemDefensePackagePlanner {
    static final int MAX_EXPANDED_CELLS = 512;
    static final int MAX_ROUTE_CELLS = 32;
    static final int MAX_HORIZONTAL_FROM_TARGET = 8;
    static final int MAX_VERTICAL_FROM_TARGET = 4;
    static final int REQUIRED_PILLAR_BLOCKS = 3;
    static final double ENTITY_REACH = 3.0D;
    static final double ATTACK_REACH_MARGIN = 0.20D;
    static final double MIN_HEALTH = 16.0D;
    static final int MIN_FOOD_LEVEL = 14;
    static final int MIN_STONE_SWORD_DURABILITY = 24;
    static final double MIN_ESCAPE_HORIZONTAL_CLEARANCE = 2.0D;

    private static final List<VoxelCell> CARDINAL = List.of(
        new VoxelCell(0, 0, -1),
        new VoxelCell(1, 0, 0),
        new VoxelCell(0, 0, 1),
        new VoxelCell(-1, 0, 0)
    );
    private static final Comparator<OpenNode> OPEN_ORDER = Comparator
        .comparingInt(OpenNode::estimatedTotalCost)
        .thenComparingInt(OpenNode::costFromStart)
        .thenComparingInt(node -> node.cell().y())
        .thenComparingInt(node -> node.cell().z())
        .thenComparingInt(node -> node.cell().x());
    private static final Comparator<Candidate> CANDIDATE_ORDER = Comparator
        .comparingInt((Candidate candidate) -> candidate.routeToBase().size()
            + candidate.placementCells().size() + candidate.escapeRoute().size())
        .thenComparingInt(candidate -> candidate.routeToBase().size())
        .thenComparingInt(candidate -> candidate.escapeRoute().size())
        .thenComparingDouble(Candidate::attackDistance)
        .thenComparingInt(candidate -> Math.abs(candidate.attackStance().y() - candidate.base().y()))
        .thenComparingInt(candidate -> candidate.base().y())
        .thenComparingInt(candidate -> candidate.base().z())
        .thenComparingInt(candidate -> candidate.base().x());

    enum Mode {
        EXISTING_PROTECTED_STANCE,
        THREE_BLOCK_PILLAR
    }

    /** Additional world facts that cannot be represented by generic voxel solidity alone. */
    interface Perception extends GatherWoodLocalEgressPerception {
        boolean isProtectedBlock(int x, int y, int z);

        boolean isContainerBlock(int x, int y, int z);

        default boolean isReplaceableBlock(int x, int y, int z) {
            return !isSolid(x, y, z);
        }

        default boolean isGravityUnstable(int x, int y, int z) {
            return false;
        }

        /**
         * Code-owned proof that this existing stance prevents a golem melee hit while retaining
         * a legal attack ray. Returning true grants no placement or movement authority.
         */
        boolean isExistingProtectedAttackStance(VoxelCell stance, EntityBounds targetBounds);
    }

    record EntityBounds(
        double minX,
        double minY,
        double minZ,
        double maxX,
        double maxY,
        double maxZ
    ) {
        EntityBounds {
            if (!finite(minX) || !finite(minY) || !finite(minZ)
                || !finite(maxX) || !finite(maxY) || !finite(maxZ)
                || minX >= maxX || minY >= maxY || minZ >= maxZ) {
                throw new IllegalArgumentException("invalid entity bounds");
            }
        }

        double closestX(double x) {
            return Math.max(minX, Math.min(maxX, x));
        }

        double closestY(double y) {
            return Math.max(minY, Math.min(maxY, y));
        }

        double closestZ(double z) {
            return Math.max(minZ, Math.min(maxZ, z));
        }
    }

    record Target(String entityUuid, EntityBounds bounds) {
        Target {
            entityUuid = normalize(entityUuid);
            Objects.requireNonNull(bounds, "bounds");
            if (entityUuid.isBlank()) {
                throw new IllegalArgumentException("entityUuid must not be blank");
            }
        }
    }

    record Readiness(
        double health,
        int foodLevel,
        int stoneSwordRemainingDurability,
        int fillerBlocks,
        int reservedFillerBlocks,
        int nearbyHostileCount,
        int liveIronGolemCount
    ) {
        Readiness {
            if (!finite(health) || health < 0.0D || foodLevel < 0
                || stoneSwordRemainingDurability < 0 || fillerBlocks < 0
                || reservedFillerBlocks < 0 || nearbyHostileCount < 0
                || liveIronGolemCount < 0) {
                throw new IllegalArgumentException("readiness values must be finite and non-negative");
            }
        }

        int expendableFillerBlocks() {
            return Math.max(0, fillerBlocks - reservedFillerBlocks);
        }
    }

    record Plan(
        Target target,
        Mode mode,
        List<VoxelCell> routeToBase,
        VoxelCell base,
        VoxelCell attackStance,
        List<VoxelCell> placementCells,
        VoxelCell escapeLanding,
        List<VoxelCell> escapeRoute,
        int expandedCells,
        double attackDistance,
        String reason
    ) {
        Plan {
            routeToBase = immutable(routeToBase);
            placementCells = immutable(placementCells);
            escapeRoute = immutable(escapeRoute);
            reason = normalize(reason);
        }

        boolean accepted() {
            return target != null && mode != null && base != null && attackStance != null
                && escapeLanding != null && !routeToBase.isEmpty() && !escapeRoute.isEmpty()
                && reason.isBlank();
        }

        int fillerRequired() {
            return placementCells.size();
        }

        static Plan rejected(Target target, int expandedCells, String reason) {
            return new Plan(
                target,
                null,
                List.of(),
                null,
                null,
                List.of(),
                null,
                List.of(),
                expandedCells,
                Double.POSITIVE_INFINITY,
                reason
            );
        }
    }

    private IronGolemDefensePackagePlanner() {
    }

    static Plan plan(
        Perception perception,
        VoxelCell start,
        Target target,
        Readiness readiness
    ) {
        if (perception == null || start == null || target == null || readiness == null) {
            return Plan.rejected(target, 0, "invalid_request");
        }
        String readinessReason = readinessRejection(readiness);
        if (!readinessReason.isBlank()) {
            return Plan.rejected(target, 0, readinessReason);
        }
        if (!safeTravelStance(perception, start) || intersectsTarget(start, target.bounds())) {
            return Plan.rejected(target, 0, "start_blocked");
        }

        PriorityQueue<OpenNode> open = new PriorityQueue<>(OPEN_ORDER);
        Map<VoxelCell, VoxelCell> parent = new HashMap<>();
        Map<VoxelCell, Integer> bestCost = new HashMap<>();
        Set<VoxelCell> closed = new HashSet<>();
        List<Candidate> candidates = new ArrayList<>();
        boolean routeCellLimit = false;
        boolean defenseGeometrySeen = false;
        boolean safeEscapeSeen = false;

        int startHeuristic = horizontalHeuristic(start, target.bounds());
        open.add(new OpenNode(start, 0, startHeuristic));
        bestCost.put(start, 0);

        while (!open.isEmpty() && closed.size() < MAX_EXPANDED_CELLS) {
            OpenNode node = open.remove();
            if (node.costFromStart() != bestCost.getOrDefault(node.cell(), Integer.MAX_VALUE)
                || !closed.add(node.cell())) {
                continue;
            }
            List<VoxelCell> route = reconstruct(parent, start, node.cell());

            Candidate protectedCandidate = protectedCandidate(perception, target, node.cell(), route);
            if (protectedCandidate != null) {
                defenseGeometrySeen = true;
                safeEscapeSeen = true;
                candidates.add(protectedCandidate);
            }

            PillarCandidateResult pillar = pillarCandidate(perception, target, node.cell(), route);
            defenseGeometrySeen |= pillar.defenseGeometrySeen();
            safeEscapeSeen |= pillar.safeEscapeSeen();
            if (pillar.candidate() != null
                && readiness.expendableFillerBlocks() >= REQUIRED_PILLAR_BLOCKS) {
                candidates.add(pillar.candidate());
            }

            if (route.size() >= MAX_ROUTE_CELLS) {
                routeCellLimit = true;
                continue;
            }
            for (VoxelCell delta : CARDINAL) {
                VoxelAStar.Move forward = VoxelAStar.resolveTraversalMove(perception, node.cell(), delta);
                VoxelCell next = forward.destination();
                if (next == null || closed.contains(next)
                    || !safeTravelStance(perception, next)
                    || intersectsTarget(next, target.bounds())) {
                    continue;
                }
                VoxelCell reverseDelta = new VoxelCell(
                    node.cell().x() - next.x(),
                    0,
                    node.cell().z() - next.z()
                );
                VoxelAStar.Move reverse = VoxelAStar.resolveTraversalMove(perception, next, reverseDelta);
                if (!node.cell().equals(reverse.destination())) {
                    continue;
                }
                int nextCost = node.costFromStart() + 1;
                if (nextCost >= bestCost.getOrDefault(next, Integer.MAX_VALUE)) {
                    continue;
                }
                bestCost.put(next, nextCost);
                parent.put(next, node.cell());
                open.add(new OpenNode(
                    next,
                    nextCost,
                    nextCost + horizontalHeuristic(next, target.bounds())
                ));
            }
        }

        if (!candidates.isEmpty()) {
            candidates.sort(CANDIDATE_ORDER);
            Candidate selected = candidates.getFirst();
            return new Plan(
                target,
                selected.mode(),
                selected.routeToBase(),
                selected.base(),
                selected.attackStance(),
                selected.placementCells(),
                selected.escapeLanding(),
                selected.escapeRoute(),
                closed.size(),
                selected.attackDistance(),
                ""
            );
        }
        if (readiness.expendableFillerBlocks() < REQUIRED_PILLAR_BLOCKS
            && defenseGeometrySeen) {
            return Plan.rejected(target, closed.size(), "filler_reserve_short");
        }
        if (defenseGeometrySeen && !safeEscapeSeen) {
            return Plan.rejected(target, closed.size(), "no_safe_escape");
        }
        if (closed.size() >= MAX_EXPANDED_CELLS && !open.isEmpty()) {
            return Plan.rejected(target, closed.size(), "expanded_budget");
        }
        return Plan.rejected(
            target,
            closed.size(),
            routeCellLimit ? "route_cell_limit" : "no_safe_defense_package"
        );
    }

    static String readinessRejection(Readiness readiness) {
        if (readiness == null) {
            return "invalid_readiness";
        }
        if (readiness.health() < MIN_HEALTH) {
            return "health_not_ready";
        }
        if (readiness.foodLevel() < MIN_FOOD_LEVEL) {
            return "food_not_ready";
        }
        if (readiness.stoneSwordRemainingDurability() < MIN_STONE_SWORD_DURABILITY) {
            return "stone_sword_missing_or_worn";
        }
        if (readiness.nearbyHostileCount() > 0) {
            return "nearby_threats";
        }
        if (readiness.liveIronGolemCount() != 1) {
            return readiness.liveIronGolemCount() > 1 ? "multiple_golems" : "target_not_live";
        }
        return "";
    }

    private static Candidate protectedCandidate(
        Perception perception,
        Target target,
        VoxelCell stance,
        List<VoxelCell> route
    ) {
        if (!candidateInsideTargetEnvelope(stance, target.bounds())
            || !perception.isExistingProtectedAttackStance(stance, target.bounds())) {
            return null;
        }
        double distance = attackDistance(stance, target.bounds());
        if (distance > ENTITY_REACH - ATTACK_REACH_MARGIN
            || !hasClearAttackRay(perception, stance, target.bounds())) {
            return null;
        }
        List<VoxelCell> escape = reversed(route);
        return new Candidate(
            Mode.EXISTING_PROTECTED_STANCE,
            route,
            stance,
            stance,
            List.of(),
            stance,
            escape,
            distance
        );
    }

    private static PillarCandidateResult pillarCandidate(
        Perception perception,
        Target target,
        VoxelCell base,
        List<VoxelCell> route
    ) {
        if (!candidateInsideTargetEnvelope(base, target.bounds())) {
            return PillarCandidateResult.none(false, false);
        }
        List<VoxelCell> placements = List.of(
            base,
            new VoxelCell(base.x(), base.y() + 1, base.z()),
            new VoxelCell(base.x(), base.y() + 2, base.z())
        );
        VoxelCell attackStance = new VoxelCell(base.x(), base.y() + 3, base.z());
        VoxelCell attackHead = new VoxelCell(base.x(), base.y() + 4, base.z());
        for (VoxelCell cell : placements) {
            if (!clearPlacementCell(perception, cell)) {
                return PillarCandidateResult.none(false, false);
            }
        }
        if (!clearBodyCell(perception, attackStance)
            || !clearBodyCell(perception, attackHead)
            || intersectsTarget(attackStance, target.bounds())) {
            return PillarCandidateResult.none(false, false);
        }
        double distance = attackDistance(attackStance, target.bounds());
        if (distance > ENTITY_REACH - ATTACK_REACH_MARGIN
            || !hasClearAttackRay(perception, attackStance, target.bounds())) {
            return PillarCandidateResult.none(false, false);
        }

        Escape escape = selectEscape(perception, target.bounds(), base, route);
        if (escape == null) {
            return PillarCandidateResult.none(true, false);
        }
        return new PillarCandidateResult(
            new Candidate(
                Mode.THREE_BLOCK_PILLAR,
                route,
                base,
                attackStance,
                placements,
                escape.landing(),
                escape.route(),
                distance
            ),
            true,
            true
        );
    }

    private static Escape selectEscape(
        Perception perception,
        EntityBounds target,
        VoxelCell base,
        List<VoxelCell> routeToBase
    ) {
        VoxelCell predecessor = routeToBase.size() >= 2
            ? routeToBase.get(routeToBase.size() - 2) : null;
        List<EscapeCandidate> escapes = new ArrayList<>();
        for (VoxelCell delta : CARDINAL) {
            VoxelCell landing = new VoxelCell(base.x() + delta.x(), base.y(), base.z() + delta.z());
            if (!safeTravelStance(perception, landing)
                || intersectsTarget(landing, target)
                || horizontalDistanceToBounds(landing.x() + 0.5D, landing.z() + 0.5D, target)
                    < MIN_ESCAPE_HORIZONTAL_CLEARANCE) {
                continue;
            }
            List<VoxelCell> escapeRoute;
            boolean rejoinsInboundRoute = landing.equals(predecessor);
            if (rejoinsInboundRoute) {
                List<VoxelCell> reverse = reversed(routeToBase);
                escapeRoute = reverse.subList(1, reverse.size());
            } else {
                escapeRoute = List.of(landing);
            }
            escapes.add(new EscapeCandidate(
                landing,
                List.copyOf(escapeRoute),
                rejoinsInboundRoute,
                horizontalDistanceToBounds(landing.x() + 0.5D, landing.z() + 0.5D, target)
            ));
        }
        if (escapes.isEmpty()) {
            return null;
        }
        escapes.sort(Comparator
            .comparingInt((EscapeCandidate candidate) -> candidate.rejoinsInboundRoute() ? 0 : 1)
            .thenComparing(Comparator.comparingDouble(EscapeCandidate::horizontalClearance).reversed())
            .thenComparingInt(candidate -> candidate.landing().y())
            .thenComparingInt(candidate -> candidate.landing().z())
            .thenComparingInt(candidate -> candidate.landing().x()));
        EscapeCandidate selected = escapes.getFirst();
        return new Escape(selected.landing(), selected.route());
    }

    private static boolean safeTravelStance(Perception perception, VoxelCell cell) {
        if (perception == null || cell == null
            || !perception.isStandable(cell.x(), cell.y(), cell.z())
            || !perception.isFullHeightSupport(cell.x(), cell.y() - 1, cell.z())) {
            return false;
        }
        for (int dy = -1; dy <= 1; dy++) {
            int y = cell.y() + dy;
            if (perception.isWater(cell.x(), y, cell.z())
                || perception.isLava(cell.x(), y, cell.z())
                || perception.isHazard(cell.x(), y, cell.z())
                || perception.isProtectedBlock(cell.x(), y, cell.z())
                || perception.isContainerBlock(cell.x(), y, cell.z())) {
                return false;
            }
        }
        if (perception.isGravityUnstable(cell.x(), cell.y() - 1, cell.z())) {
            return false;
        }
        return !adjacentLava(perception, cell);
    }

    private static boolean clearPlacementCell(Perception perception, VoxelCell cell) {
        return perception.inBounds(cell.x(), cell.y(), cell.z())
            && perception.isReplaceableBlock(cell.x(), cell.y(), cell.z())
            && !perception.isWater(cell.x(), cell.y(), cell.z())
            && !perception.isLava(cell.x(), cell.y(), cell.z())
            && !perception.isHazard(cell.x(), cell.y(), cell.z())
            && !perception.isProtectedBlock(cell.x(), cell.y(), cell.z())
            && !perception.isContainerBlock(cell.x(), cell.y(), cell.z())
            && !perception.isGravityUnstable(cell.x(), cell.y(), cell.z())
            && !adjacentLava(perception, cell);
    }

    private static boolean clearBodyCell(Perception perception, VoxelCell cell) {
        return perception.inBounds(cell.x(), cell.y(), cell.z())
            && !perception.isSolid(cell.x(), cell.y(), cell.z())
            && !perception.isWater(cell.x(), cell.y(), cell.z())
            && !perception.isLava(cell.x(), cell.y(), cell.z())
            && !perception.isHazard(cell.x(), cell.y(), cell.z())
            && !perception.isProtectedBlock(cell.x(), cell.y(), cell.z())
            && !perception.isContainerBlock(cell.x(), cell.y(), cell.z());
    }

    private static boolean adjacentLava(Perception perception, VoxelCell cell) {
        for (VoxelCell delta : CARDINAL) {
            if (perception.isLava(cell.x() + delta.x(), cell.y(), cell.z() + delta.z())
                || perception.isLava(cell.x() + delta.x(), cell.y() - 1, cell.z() + delta.z())) {
                return true;
            }
        }
        return false;
    }

    static double attackDistance(VoxelCell stance, EntityBounds target) {
        if (stance == null || target == null) {
            return Double.POSITIVE_INFINITY;
        }
        double eyeX = stance.x() + 0.5D;
        double eyeY = stance.y() + 1.62D;
        double eyeZ = stance.z() + 0.5D;
        double dx = target.closestX(eyeX) - eyeX;
        double dy = target.closestY(eyeY) - eyeY;
        double dz = target.closestZ(eyeZ) - eyeZ;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    static boolean hasClearAttackRay(
        Perception perception,
        VoxelCell stance,
        EntityBounds target
    ) {
        if (perception == null || stance == null || target == null) {
            return false;
        }
        double startX = stance.x() + 0.5D;
        double startY = stance.y() + 1.62D;
        double startZ = stance.z() + 0.5D;
        double endX = target.closestX(startX);
        double endY = target.closestY(startY);
        double endZ = target.closestZ(startZ);
        double dx = endX - startX;
        double dy = endY - startY;
        double dz = endZ - startZ;
        int samples = Math.max(1, (int) Math.ceil(Math.sqrt(dx * dx + dy * dy + dz * dz) * 16.0D));
        VoxelCell previous = null;
        for (int sample = 0; sample < samples; sample++) {
            double t = (double) sample / (double) samples;
            VoxelCell cell = new VoxelCell(
                floor(startX + dx * t),
                floor(startY + dy * t),
                floor(startZ + dz * t)
            );
            if (cell.equals(previous)) {
                continue;
            }
            previous = cell;
            if (!perception.inBounds(cell.x(), cell.y(), cell.z())
                || perception.isSolid(cell.x(), cell.y(), cell.z())) {
                return false;
            }
        }
        return true;
    }

    private static boolean intersectsTarget(VoxelCell feet, EntityBounds target) {
        double playerMinX = feet.x() + 0.2D;
        double playerMaxX = feet.x() + 0.8D;
        double playerMinY = feet.y();
        double playerMaxY = feet.y() + 1.8D;
        double playerMinZ = feet.z() + 0.2D;
        double playerMaxZ = feet.z() + 0.8D;
        return playerMaxX > target.minX() && playerMinX < target.maxX()
            && playerMaxY > target.minY() && playerMinY < target.maxY()
            && playerMaxZ > target.minZ() && playerMinZ < target.maxZ();
    }

    private static int horizontalHeuristic(VoxelCell cell, EntityBounds bounds) {
        double dx = horizontalAxisDistance(cell.x() + 0.5D, bounds.minX(), bounds.maxX());
        double dz = horizontalAxisDistance(cell.z() + 0.5D, bounds.minZ(), bounds.maxZ());
        return (int) Math.floor(dx + dz);
    }

    private static boolean candidateInsideTargetEnvelope(VoxelCell cell, EntityBounds bounds) {
        return horizontalDistanceToBounds(cell.x() + 0.5D, cell.z() + 0.5D, bounds)
                <= MAX_HORIZONTAL_FROM_TARGET
            && Math.abs(cell.y() - floor(bounds.minY())) <= MAX_VERTICAL_FROM_TARGET;
    }

    private static double horizontalDistanceToBounds(double x, double z, EntityBounds bounds) {
        double dx = horizontalAxisDistance(x, bounds.minX(), bounds.maxX());
        double dz = horizontalAxisDistance(z, bounds.minZ(), bounds.maxZ());
        return Math.sqrt(dx * dx + dz * dz);
    }

    private static double horizontalAxisDistance(double value, double min, double max) {
        if (value < min) {
            return min - value;
        }
        return value > max ? value - max : 0.0D;
    }

    private static List<VoxelCell> reconstruct(
        Map<VoxelCell, VoxelCell> parent,
        VoxelCell start,
        VoxelCell goal
    ) {
        ArrayDeque<VoxelCell> reversed = new ArrayDeque<>();
        VoxelCell cursor = goal;
        reversed.addFirst(cursor);
        while (!cursor.equals(start)) {
            cursor = parent.get(cursor);
            if (cursor == null) {
                return List.of();
            }
            reversed.addFirst(cursor);
        }
        return List.copyOf(reversed);
    }

    private static List<VoxelCell> reversed(List<VoxelCell> route) {
        ArrayList<VoxelCell> reversed = new ArrayList<>(route);
        java.util.Collections.reverse(reversed);
        return List.copyOf(reversed);
    }

    private static List<VoxelCell> immutable(List<VoxelCell> cells) {
        return cells == null ? List.of() : List.copyOf(cells);
    }

    private static int floor(double value) {
        return (int) Math.floor(value);
    }

    private static boolean finite(double value) {
        return !Double.isNaN(value) && !Double.isInfinite(value);
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim();
    }

    private record OpenNode(VoxelCell cell, int costFromStart, int estimatedTotalCost) {
    }

    private record Candidate(
        Mode mode,
        List<VoxelCell> routeToBase,
        VoxelCell base,
        VoxelCell attackStance,
        List<VoxelCell> placementCells,
        VoxelCell escapeLanding,
        List<VoxelCell> escapeRoute,
        double attackDistance
    ) {
    }

    private record PillarCandidateResult(
        Candidate candidate,
        boolean defenseGeometrySeen,
        boolean safeEscapeSeen
    ) {
        static PillarCandidateResult none(boolean defenseGeometrySeen, boolean safeEscapeSeen) {
            return new PillarCandidateResult(null, defenseGeometrySeen, safeEscapeSeen);
        }
    }

    private record Escape(VoxelCell landing, List<VoxelCell> route) {
    }

    private record EscapeCandidate(
        VoxelCell landing,
        List<VoxelCell> route,
        boolean rejoinsInboundRoute,
        double horizontalClearance
    ) {
    }
}
