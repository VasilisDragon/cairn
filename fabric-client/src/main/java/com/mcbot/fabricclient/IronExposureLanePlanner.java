package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Selects one bounded, same-plane iron prospect lane without inventing exposure or movement.
 *
 * <p>This is deliberately not a path finder. It considers the current straight continuation and
 * the two deterministic spacing-three U-turns only. The caller remains responsible for executing
 * and verifying every break and stance.</p>
 */
final class IronExposureLanePlanner {
    static final int MIN_PRODUCTIVE_FEET_Y = 13;
    static final int MAX_PRODUCTIVE_FEET_Y = 16;
    static final int LANE_LENGTH = 12;
    static final int LANE_BODY_HEIGHT = 2;
    static final int LANE_SPACING = 3;
    static final int MIN_FRESH_SHELL_CELLS = 24;
    static final double MIN_FRESH_SHELL_PER_BREAK = 2.5D;

    enum Action {
        SELECT_LANE,
        DEFER_VISIBLE_IRON,
        DEFER_CONNECTED_VEIN,
        REJECT
    }

    interface Perception {
        boolean isClear(VoxelCell block);

        boolean isProspectable(VoxelCell block);

        boolean isStableSupport(VoxelCell feet);

        boolean isLiquid(VoxelCell block);

        boolean isHazard(VoxelCell block);

        boolean isAdjacentLava(VoxelCell feet);

        boolean isExcluded(VoxelCell block);
    }

    record Request(
        VoxelCell origin,
        StaircaseDescentPlanner.Direction2d heading,
        Perception perception,
        Set<IronProspectAtlas.InspectedCell> inspectedCells,
        Set<IronProspectAtlas.LaneSignature> completedLanes,
        Set<IronProspectAtlas.ConnectorSignature> completedConnectors,
        boolean visibleIronAvailable,
        boolean connectedVeinAvailable,
        boolean atlasSaturated
    ) {
        Request {
            inspectedCells = inspectedCells == null ? Set.of() : Set.copyOf(inspectedCells);
            completedLanes = completedLanes == null ? Set.of() : Set.copyOf(completedLanes);
            completedConnectors = completedConnectors == null
                ? Set.of()
                : Set.copyOf(completedConnectors);
        }

        Request(
            VoxelCell origin,
            StaircaseDescentPlanner.Direction2d heading,
            Perception perception,
            Set<IronProspectAtlas.InspectedCell> inspectedCells,
            Set<IronProspectAtlas.LaneSignature> completedLanes,
            Set<IronProspectAtlas.ConnectorSignature> completedConnectors
        ) {
            this(
                origin,
                heading,
                perception,
                inspectedCells,
                completedLanes,
                completedConnectors,
                false,
                false,
                false
            );
        }

        static Request fromAtlas(
            VoxelCell origin,
            StaircaseDescentPlanner.Direction2d heading,
            Perception perception,
            IronProspectAtlas atlas,
            boolean visibleIronAvailable,
            boolean connectedVeinAvailable
        ) {
            return new Request(
                origin,
                heading,
                perception,
                atlas == null ? Set.of() : atlas.inspectedCells(),
                atlas == null ? Set.of() : atlas.laneSignatures(),
                atlas == null ? Set.of() : atlas.connectorSignatures(),
                visibleIronAvailable,
                connectedVeinAvailable,
                atlas != null && atlas.saturated()
            );
        }
    }

    record Plan(
        IronProspectAtlas.PlaneRegion plane,
        VoxelCell origin,
        VoxelCell laneOrigin,
        StaircaseDescentPlanner.Direction2d heading,
        List<VoxelCell> connector,
        List<VoxelCell> lane,
        IronProspectAtlas.LaneSignature laneSignature,
        IronProspectAtlas.ConnectorSignature connectorSignature,
        int freshShellCells,
        int overlapCells,
        int projectedBreaks,
        double freshShellPerBreak,
        boolean straightContinuation
    ) {
        Plan {
            connector = connector == null ? List.of() : List.copyOf(connector);
            lane = lane == null ? List.of() : List.copyOf(lane);
        }

        List<VoxelCell> completeRoute() {
            List<VoxelCell> route = new ArrayList<>(1 + connector.size() + lane.size());
            route.add(origin);
            route.addAll(connector);
            route.addAll(lane);
            return List.copyOf(route);
        }
    }

    record Result(Action action, Plan plan, String reason, int consideredCandidates) {
        Result {
            reason = reason == null ? "" : reason;
        }

        boolean selected() {
            return action == Action.SELECT_LANE && plan != null;
        }
    }

    private IronExposureLanePlanner() {
    }

    static Result plan(Request request) {
        if (request == null
            || request.origin() == null
            || request.heading() == null
            || request.perception() == null) {
            return reject("invalid_request", 0);
        }
        if (request.visibleIronAvailable()) {
            return new Result(Action.DEFER_VISIBLE_IRON, null, "visible_iron_priority", 0);
        }
        if (request.connectedVeinAvailable()) {
            return new Result(Action.DEFER_CONNECTED_VEIN, null, "connected_vein_priority", 0);
        }
        if (request.atlasSaturated()) {
            return reject("atlas_saturated", 0);
        }
        VoxelCell origin = request.origin();
        if (origin.y() < MIN_PRODUCTIVE_FEET_Y || origin.y() > MAX_PRODUCTIVE_FEET_Y) {
            return reject("outside_productive_band", 0);
        }
        if (!safeCurrentStance(request.perception(), origin)) {
            return reject("origin_unsafe", 0);
        }

        Set<VoxelCell> completedFootprint = completedLaneFootprint(request.completedLanes());
        Candidate straight = evaluate(
            request,
            origin,
            request.heading(),
            List.of(),
            true,
            completedFootprint
        );
        if (straight != null) {
            return new Result(Action.SELECT_LANE, straight.plan(), "selected", 1);
        }

        List<Candidate> candidates = new ArrayList<>(2);
        StaircaseDescentPlanner.Direction2d reverse = reverse(request.heading());
        for (int side : new int[] {-1, 1}) {
            List<VoxelCell> connector = lateralConnector(origin, request.heading(), side);
            VoxelCell laneOrigin = connector.getLast();
            Candidate lateral = evaluate(
                request,
                laneOrigin,
                reverse,
                connector,
                false,
                completedFootprint
            );
            if (lateral != null) {
                candidates.add(lateral);
            }
        }

        if (candidates.isEmpty()) {
            return reject("plane_exhausted", 3);
        }
        candidates.sort(CANDIDATE_ORDER);
        Candidate selected = candidates.getFirst();
        return new Result(Action.SELECT_LANE, selected.plan(), "selected", 3);
    }

    static Set<IronProspectAtlas.InspectedCell> exposureShell(List<VoxelCell> route) {
        if (route == null || route.size() < 2) {
            return Set.of();
        }
        Set<VoxelCell> bodyVolume = new HashSet<>();
        for (VoxelCell feet : route) {
            if (feet == null) {
                continue;
            }
            bodyVolume.add(feet);
            bodyVolume.add(new VoxelCell(feet.x(), feet.y() + 1, feet.z()));
        }
        Set<IronProspectAtlas.InspectedCell> shell = new LinkedHashSet<>();
        // The first cell is the already occupied origin. It participates in occlusion but does
        // not generate newly predicted exposure.
        for (int index = 1; index < route.size(); index++) {
            VoxelCell feet = route.get(index);
            for (int dy = 0; dy < LANE_BODY_HEIGHT; dy++) {
                VoxelCell body = new VoxelCell(feet.x(), feet.y() + dy, feet.z());
                for (VoxelCell neighbour : faceNeighbours(body)) {
                    if (!bodyVolume.contains(neighbour)) {
                        shell.add(new IronProspectAtlas.InspectedCell(
                            neighbour.x(),
                            neighbour.y(),
                            neighbour.z()
                        ));
                    }
                }
            }
        }
        return Set.copyOf(shell);
    }

    private static Candidate evaluate(
        Request request,
        VoxelCell laneOrigin,
        StaircaseDescentPlanner.Direction2d laneHeading,
        List<VoxelCell> connector,
        boolean straight,
        Set<VoxelCell> completedFootprint
    ) {
        Perception perception = request.perception();
        for (VoxelCell connectorCell : connector) {
            if (overlapsCompletedLane(completedFootprint, connectorCell, request.origin())
                || !safeProspectiveStance(perception, connectorCell)) {
                return null;
            }
        }

        List<VoxelCell> lane = new ArrayList<>(LANE_LENGTH);
        for (int step = 1; step <= LANE_LENGTH; step++) {
            VoxelCell feet = new VoxelCell(
                laneOrigin.x() + laneHeading.dx() * step,
                laneOrigin.y(),
                laneOrigin.z() + laneHeading.dz() * step
            );
            if (overlapsCompletedLane(completedFootprint, feet, request.origin())
                || !safeProspectiveStance(perception, feet)) {
                return null;
            }
            lane.add(feet);
        }

        IronProspectAtlas.LaneSignature laneSignature = new IronProspectAtlas.LaneSignature(
            laneOrigin.y(),
            laneOrigin.x(),
            laneOrigin.z(),
            laneHeading.dx(),
            laneHeading.dz(),
            LANE_LENGTH
        );
        if (request.completedLanes().contains(laneSignature)) {
            return null;
        }

        IronProspectAtlas.ConnectorSignature connectorSignature = connector.isEmpty()
            ? null
            : new IronProspectAtlas.ConnectorSignature(
                request.origin().y(),
                request.origin().x(),
                request.origin().z(),
                laneOrigin.x(),
                laneOrigin.z()
            );
        if (connectorSignature != null
            && request.completedConnectors().contains(connectorSignature)) {
            return null;
        }

        List<VoxelCell> route = new ArrayList<>(1 + connector.size() + lane.size());
        route.add(request.origin());
        route.addAll(connector);
        route.addAll(lane);
        Set<IronProspectAtlas.InspectedCell> shell = exposureShell(route);
        int overlap = 0;
        for (IronProspectAtlas.InspectedCell cell : shell) {
            if (request.inspectedCells().contains(cell)) {
                overlap++;
            }
        }
        int freshShell = shell.size() - overlap;
        int projectedBreaks = projectedBreaks(perception, route);
        double ratio = freshShell / (double) Math.max(1, projectedBreaks);
        if (freshShell < MIN_FRESH_SHELL_CELLS || ratio + 1.0E-9D < MIN_FRESH_SHELL_PER_BREAK) {
            return null;
        }

        IronProspectAtlas.PlaneRegion plane = IronProspectAtlas.PlaneRegion.at(
            request.origin().y(),
            request.origin().x(),
            request.origin().z()
        );
        Plan plan = new Plan(
            plane,
            request.origin(),
            laneOrigin,
            laneHeading,
            connector,
            lane,
            laneSignature,
            connectorSignature,
            freshShell,
            overlap,
            projectedBreaks,
            ratio,
            straight
        );
        return new Candidate(plan);
    }

    private static Set<VoxelCell> completedLaneFootprint(
        Set<IronProspectAtlas.LaneSignature> completedLanes
    ) {
        Set<VoxelCell> footprint = new HashSet<>();
        for (IronProspectAtlas.LaneSignature lane : completedLanes) {
            footprint.addAll(lane.stanceFootprint());
        }
        return Set.copyOf(footprint);
    }

    private static boolean overlapsCompletedLane(
        Set<VoxelCell> completedFootprint,
        VoxelCell candidate,
        VoxelCell permittedSource
    ) {
        return !candidate.equals(permittedSource) && completedFootprint.contains(candidate);
    }

    private static int projectedBreaks(Perception perception, List<VoxelCell> route) {
        Set<VoxelCell> bodyBlocks = new HashSet<>();
        for (int index = 1; index < route.size(); index++) {
            VoxelCell feet = route.get(index);
            bodyBlocks.add(feet);
            bodyBlocks.add(new VoxelCell(feet.x(), feet.y() + 1, feet.z()));
        }
        int breaks = 0;
        for (VoxelCell block : bodyBlocks) {
            if (!perception.isClear(block) && perception.isProspectable(block)) {
                breaks++;
            }
        }
        return breaks;
    }

    private static boolean safeCurrentStance(Perception perception, VoxelCell feet) {
        return stanceEnvironmentSafe(perception, feet)
            && perception.isClear(feet)
            && perception.isClear(new VoxelCell(feet.x(), feet.y() + 1, feet.z()));
    }

    private static boolean safeProspectiveStance(Perception perception, VoxelCell feet) {
        if (!stanceEnvironmentSafe(perception, feet)) {
            return false;
        }
        VoxelCell head = new VoxelCell(feet.x(), feet.y() + 1, feet.z());
        return clearOrProspectable(perception, feet) && clearOrProspectable(perception, head);
    }

    private static boolean stanceEnvironmentSafe(Perception perception, VoxelCell feet) {
        VoxelCell head = new VoxelCell(feet.x(), feet.y() + 1, feet.z());
        VoxelCell support = new VoxelCell(feet.x(), feet.y() - 1, feet.z());
        return perception.isStableSupport(feet)
            && !perception.isLiquid(feet)
            && !perception.isLiquid(head)
            && !perception.isHazard(feet)
            && !perception.isHazard(head)
            && !perception.isAdjacentLava(feet)
            && !perception.isExcluded(feet)
            && !perception.isExcluded(head)
            && !perception.isExcluded(support);
    }

    private static boolean clearOrProspectable(Perception perception, VoxelCell block) {
        return perception.isClear(block) || perception.isProspectable(block);
    }

    private static List<VoxelCell> lateralConnector(
        VoxelCell origin,
        StaircaseDescentPlanner.Direction2d heading,
        int side
    ) {
        int lateralX = -heading.dz() * side;
        int lateralZ = heading.dx() * side;
        List<VoxelCell> connector = new ArrayList<>(LANE_SPACING);
        for (int offset = 1; offset <= LANE_SPACING; offset++) {
            connector.add(new VoxelCell(
                origin.x() + lateralX * offset,
                origin.y(),
                origin.z() + lateralZ * offset
            ));
        }
        return List.copyOf(connector);
    }

    private static StaircaseDescentPlanner.Direction2d reverse(
        StaircaseDescentPlanner.Direction2d heading
    ) {
        return new StaircaseDescentPlanner.Direction2d(
            -heading.dx(),
            -heading.dz(),
            switch (heading.name()) {
                case "north" -> "south";
                case "east" -> "west";
                case "south" -> "north";
                case "west" -> "east";
                default -> "reverse_" + heading.name();
            }
        );
    }

    private static List<VoxelCell> faceNeighbours(VoxelCell cell) {
        return List.of(
            new VoxelCell(cell.x() + 1, cell.y(), cell.z()),
            new VoxelCell(cell.x() - 1, cell.y(), cell.z()),
            new VoxelCell(cell.x(), cell.y() + 1, cell.z()),
            new VoxelCell(cell.x(), cell.y() - 1, cell.z()),
            new VoxelCell(cell.x(), cell.y(), cell.z() + 1),
            new VoxelCell(cell.x(), cell.y(), cell.z() - 1)
        );
    }

    private static int cardinalOrder(StaircaseDescentPlanner.Direction2d heading) {
        return switch (heading.name()) {
            case "north" -> 0;
            case "east" -> 1;
            case "south" -> 2;
            case "west" -> 3;
            default -> 4;
        };
    }

    private static Result reject(String reason, int consideredCandidates) {
        return new Result(Action.REJECT, null, reason, consideredCandidates);
    }

    private static final Comparator<Candidate> CANDIDATE_ORDER =
        Comparator.comparing((Candidate candidate) -> !candidate.plan().straightContinuation())
            .thenComparing((Candidate candidate) -> candidate.plan().freshShellCells(), Comparator.reverseOrder())
            .thenComparingInt(candidate -> candidate.plan().projectedBreaks())
            .thenComparingInt(candidate -> candidate.plan().connector().size())
            .thenComparingInt(candidate -> candidate.plan().overlapCells())
            .thenComparingInt(candidate -> cardinalOrder(candidate.plan().heading()))
            .thenComparingInt(candidate -> candidate.plan().laneOrigin().y())
            .thenComparingInt(candidate -> candidate.plan().laneOrigin().z())
            .thenComparingInt(candidate -> candidate.plan().laneOrigin().x());

    private record Candidate(Plan plan) {
    }
}
