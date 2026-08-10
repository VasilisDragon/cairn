package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Bounded, exact three-dimensional memory for mission iron prospecting.
 *
 * <p>The old atlas stored five inferred X/Z columns for every cleared prospect block. That
 * collapsed different mining levels and credited walls that had never actually been exposed.
 * This atlas stores only block cells that are known to have been exposed from a verified cleared
 * block or a verified grounded two-high stance.</p>
 */
final class IronProspectAtlas {
    /** Compatibility name retained for existing diagnostics and constructor call sites. */
    static final int DEFAULT_COLUMN_LIMIT = 16_384;
    static final int DEFAULT_INSPECTED_CELL_LIMIT = DEFAULT_COLUMN_LIMIT;
    static final int DEFAULT_REGION_LIMIT = 256;
    static final int DEFAULT_LANE_SIGNATURE_LIMIT = 512;
    static final int DEFAULT_CONNECTOR_SIGNATURE_LIMIT = 512;
    static final int DEFAULT_BLOCK_LIMIT = 384;
    static final long DEFAULT_TIME_LIMIT_MS = 900_000L;
    static final int PROJECTED_CELLS = 12;
    static final int CANONICAL_CONNECTOR_CELLS = 3;
    static final int DEPARTURE_SEAM_CELLS = 2;
    static final int DEFAULT_COMPATIBILITY_FEET_Y = 14;

    /** Exact world block that has genuinely been exposed to a verified air volume. */
    record InspectedCell(int x, int y, int z) {
        VoxelCell voxel() {
            return new VoxelCell(x, y, z);
        }
    }

    /** Compatibility diagnostic type; new accounting must use {@link InspectedCell}. */
    record Column(int x, int z) {
    }

    record Region(int x, int z) {
        static Region at(int x, int z) {
            return new Region(Math.floorDiv(x, 16), Math.floorDiv(z, 16));
        }

        String key() {
            return x + ":" + z;
        }
    }

    record PlaneRegion(int feetY, int x, int z) {
        static PlaneRegion at(int feetY, int x, int z) {
            return new PlaneRegion(feetY, Math.floorDiv(x, 16), Math.floorDiv(z, 16));
        }

        String key() {
            return feetY + ":" + x + ":" + z;
        }

        Region horizontalRegion() {
            return new Region(x, z);
        }
    }

    record LaneSignature(
        int feetY,
        int originX,
        int originZ,
        int dx,
        int dz,
        int length
    ) {
        LaneSignature {
            if (Math.abs(dx) + Math.abs(dz) != 1) {
                throw new IllegalArgumentException("lane heading must be cardinal");
            }
            if (length != PROJECTED_CELLS) {
                throw new IllegalArgumentException("lane length must be exactly " + PROJECTED_CELLS);
            }
        }

        Set<VoxelCell> stanceFootprint() {
            Set<VoxelCell> footprint = new LinkedHashSet<>();
            for (int step = 0; step <= length; step++) {
                footprint.add(new VoxelCell(
                    originX + dx * step,
                    feetY,
                    originZ + dz * step
                ));
            }
            return Set.copyOf(footprint);
        }
    }

    record ConnectorSignature(
        int feetY,
        int sourceX,
        int sourceZ,
        int destinationX,
        int destinationZ
    ) {
        ConnectorSignature {
            int deltaX = destinationX - sourceX;
            int deltaZ = destinationZ - sourceZ;
            if ((deltaX != 0 && deltaZ != 0)
                || Math.abs(deltaX) + Math.abs(deltaZ) != CANONICAL_CONNECTOR_CELLS) {
                throw new IllegalArgumentException(
                    "connector must be a cardinal spacing-" + CANONICAL_CONNECTOR_CELLS + " segment"
                );
            }
            if (coordinateOrder(destinationX, destinationZ, sourceX, sourceZ) < 0) {
                int oldSourceX = sourceX;
                int oldSourceZ = sourceZ;
                sourceX = destinationX;
                sourceZ = destinationZ;
                destinationX = oldSourceX;
                destinationZ = oldSourceZ;
            }
        }

        boolean hasEndpoint(VoxelCell cell) {
            return cell != null
                && cell.y() == feetY
                && ((cell.x() == sourceX && cell.z() == sourceZ)
                    || (cell.x() == destinationX && cell.z() == destinationZ));
        }
    }

    enum PlanRegistrationResult {
        REGISTERED,
        ALREADY_REGISTERED,
        INVALID_PLAN,
        SATURATED
    }

    record Selection(
        StaircaseDescentPlanner.Direction2d heading,
        Region region,
        int projectedOverlap,
        int regionStarts,
        boolean exhausted,
        String source,
        PlaneRegion planeRegion
    ) {
        Selection(
            StaircaseDescentPlanner.Direction2d heading,
            Region region,
            int projectedOverlap,
            int regionStarts,
            boolean exhausted,
            String source
        ) {
            this(
                heading,
                region,
                projectedOverlap,
                regionStarts,
                exhausted,
                source,
                new PlaneRegion(DEFAULT_COMPATIBILITY_FEET_Y, region.x(), region.z())
            );
        }
    }

    private final int inspectedCellLimit;
    private final int regionLimit;
    private final int laneSignatureLimit;
    private final int connectorSignatureLimit;
    private final int blockLimit;
    private final long timeLimitMs;
    private final Set<InspectedCell> inspected = new LinkedHashSet<>();
    private final Map<PlaneRegion, Integer> regionStarts = new HashMap<>();
    private final Set<LaneSignature> laneSignatures = new LinkedHashSet<>();
    private final Set<ConnectorSignature> connectorSignatures = new LinkedHashSet<>();
    private final Set<String> exhaustedHeadings = new HashSet<>();
    private long worldToken = Long.MIN_VALUE;
    private String dimension = "";
    private VoxelCell lastPosition = null;
    private int epoch = 0;
    private int epochBlocks = 0;
    private long epochActiveMs = 0L;
    private boolean epochActive = false;
    private boolean saturated = false;
    private boolean saturationReported = false;

    IronProspectAtlas() {
        this(
            DEFAULT_INSPECTED_CELL_LIMIT,
            DEFAULT_REGION_LIMIT,
            DEFAULT_LANE_SIGNATURE_LIMIT,
            DEFAULT_CONNECTOR_SIGNATURE_LIMIT,
            DEFAULT_BLOCK_LIMIT,
            DEFAULT_TIME_LIMIT_MS
        );
    }

    /** Compatibility constructor: the first bound now limits exact inspected cells. */
    IronProspectAtlas(int columnLimit, int regionLimit, int blockLimit, long timeLimitMs) {
        this(
            columnLimit,
            regionLimit,
            DEFAULT_LANE_SIGNATURE_LIMIT,
            DEFAULT_CONNECTOR_SIGNATURE_LIMIT,
            blockLimit,
            timeLimitMs
        );
    }

    IronProspectAtlas(
        int inspectedCellLimit,
        int regionLimit,
        int laneSignatureLimit,
        int connectorSignatureLimit,
        int blockLimit,
        long timeLimitMs
    ) {
        this.inspectedCellLimit = Math.max(1, inspectedCellLimit);
        this.regionLimit = Math.max(1, regionLimit);
        this.laneSignatureLimit = Math.max(1, laneSignatureLimit);
        this.connectorSignatureLimit = Math.max(1, connectorSignatureLimit);
        this.blockLimit = Math.max(1, blockLimit);
        this.timeLimitMs = Math.max(1L, timeLimitMs);
    }

    boolean observeContext(long nextWorldToken, String nextDimension, int x, int z) {
        return observeContext(nextWorldToken, nextDimension, x, DEFAULT_COMPATIBILITY_FEET_Y, z);
    }

    boolean observeContext(long nextWorldToken, String nextDimension, int x, int y, int z) {
        String normalizedDimension = nextDimension == null ? "" : nextDimension;
        boolean changed = worldToken != Long.MIN_VALUE
            && (worldToken != nextWorldToken || !dimension.equals(normalizedDimension));
        boolean discontinuity = lastPosition != null
            && Math.sqrt(
                square(x - lastPosition.x())
                    + square(y - lastPosition.y())
                    + square(z - lastPosition.z())
            ) > 64.0D;
        if (changed || discontinuity) {
            resetAll();
        }
        worldToken = nextWorldToken;
        dimension = normalizedDimension;
        lastPosition = new VoxelCell(x, y, z);
        return changed || discontinuity;
    }

    int beginEpoch() {
        if (!epochActive) {
            epoch++;
            epochActive = true;
            epochBlocks = 0;
            epochActiveMs = 0L;
            exhaustedHeadings.clear();
        }
        return epoch;
    }

    List<Selection> rankHeadings(
        int originX,
        int originZ,
        StaircaseDescentPlanner.Direction2d hint,
        List<StaircaseDescentPlanner.Direction2d> headings
    ) {
        return rankHeadings(originX, DEFAULT_COMPATIBILITY_FEET_Y, originZ, hint, headings);
    }

    List<Selection> rankHeadings(
        int originX,
        int feetY,
        int originZ,
        StaircaseDescentPlanner.Direction2d hint,
        List<StaircaseDescentPlanner.Direction2d> headings
    ) {
        List<Selection> ranked = new ArrayList<>();
        for (StaircaseDescentPlanner.Direction2d heading : headings) {
            int destinationX = originX + heading.dx() * PROJECTED_CELLS;
            int destinationZ = originZ + heading.dz() * PROJECTED_CELLS;
            PlaneRegion planeRegion = PlaneRegion.at(feetY, destinationX, destinationZ);
            ranked.add(new Selection(
                heading,
                planeRegion.horizontalRegion(),
                projectedOverlap(originX, feetY, originZ, heading),
                regionStarts.getOrDefault(planeRegion, 0),
                exhaustedHeadings.contains(heading.name()),
                hint != null && hint.equals(heading) ? "brain_hint" : "atlas",
                planeRegion
            ));
        }
        ranked.sort(Comparator
            .comparingInt(Selection::projectedOverlap)
            .thenComparing(Selection::exhausted)
            .thenComparingInt(Selection::regionStarts)
            .thenComparing(selection -> hint == null || !selection.heading().equals(hint))
            .thenComparingInt(selection -> cardinalOrder(selection.heading())));
        return List.copyOf(ranked);
    }

    void markRegionStarted(Selection selection) {
        if (selection == null) {
            return;
        }
        PlaneRegion region = selection.planeRegion();
        if (regionStarts.containsKey(region)) {
            regionStarts.put(region, regionStarts.get(region) + 1);
        } else if (regionStarts.size() < regionLimit) {
            regionStarts.put(region, 1);
        } else {
            saturated = true;
        }
    }

    void markHeadingExhausted(StaircaseDescentPlanner.Direction2d heading) {
        if (heading != null) {
            exhaustedHeadings.add(heading.name());
        }
    }

    /**
     * Compatibility entry point. A cleared prospect block exposes only its six direct faces.
     * The heading is deliberately ignored: it may not authorize inferred side columns.
     */
    void recordCorridor(int blockX, int blockY, int blockZ, StaircaseDescentPlanner.Direction2d heading) {
        recordClearedProspectBlock(blockX, blockY, blockZ);
    }

    void recordClearedProspectBlock(int blockX, int blockY, int blockZ) {
        recordClearedProspectBlock(new VoxelCell(blockX, blockY, blockZ));
    }

    void recordClearedProspectBlock(VoxelCell clearedBlock) {
        if (clearedBlock == null || saturated) {
            return;
        }
        Set<InspectedCell> exposed = new LinkedHashSet<>();
        for (VoxelCell face : faceNeighbours(clearedBlock)) {
            exposed.add(new InspectedCell(face.x(), face.y(), face.z()));
        }
        addInspectedAtomically(exposed);
    }

    /** Records the exact exterior shell visible from a verified two-high grounded stance. */
    void recordGroundedLaneCell(int feetX, int feetY, int feetZ) {
        recordGroundedLaneCell(new VoxelCell(feetX, feetY, feetZ));
    }

    void recordGroundedLaneCell(VoxelCell feet) {
        if (feet == null || saturated) {
            return;
        }
        Set<VoxelCell> body = Set.of(feet, new VoxelCell(feet.x(), feet.y() + 1, feet.z()));
        Set<InspectedCell> exposed = new LinkedHashSet<>();
        for (VoxelCell bodyCell : body) {
            for (VoxelCell face : faceNeighbours(bodyCell)) {
                if (!body.contains(face)) {
                    exposed.add(new InspectedCell(face.x(), face.y(), face.z()));
                }
            }
        }
        addInspectedAtomically(exposed);
    }

    boolean rememberLane(LaneSignature signature) {
        if (signature == null) {
            return false;
        }
        if (laneSignatures.contains(signature)) {
            return true;
        }
        if (saturated || laneSignatures.size() >= laneSignatureLimit) {
            saturated = true;
            return false;
        }
        laneSignatures.add(signature);
        return true;
    }

    boolean rememberConnector(ConnectorSignature signature) {
        if (signature == null) {
            return false;
        }
        if (connectorSignatures.contains(signature)) {
            return true;
        }
        if (saturated || connectorSignatures.size() >= connectorSignatureLimit) {
            saturated = true;
            return false;
        }
        connectorSignatures.add(signature);
        return true;
    }

    /**
     * Atomically registers one fully validated lane package and every plane region it touches.
     * Any validation or capacity rejection leaves regions and signatures unchanged.
     */
    PlanRegistrationResult registerPlan(
        LaneSignature laneSignature,
        ConnectorSignature connectorSignature,
        List<VoxelCell> connector,
        List<VoxelCell> lane
    ) {
        if (saturated) {
            return PlanRegistrationResult.SATURATED;
        }
        if (!validLaneRoute(laneSignature, lane)
            || !validConnectorRoute(laneSignature, connectorSignature, connector)) {
            return PlanRegistrationResult.INVALID_PLAN;
        }
        if (laneSignatures.contains(laneSignature)) {
            return PlanRegistrationResult.ALREADY_REGISTERED;
        }
        if (connectorSignature != null && connectorSignatures.contains(connectorSignature)) {
            return PlanRegistrationResult.INVALID_PLAN;
        }

        Set<PlaneRegion> touchedRegions = touchedRegions(
            laneSignature,
            connectorSignature,
            connector,
            lane
        );
        long newRegions = touchedRegions.stream().filter(region -> !regionStarts.containsKey(region)).count();
        boolean overCapacity = laneSignatures.size() + 1 > laneSignatureLimit
            || (connectorSignature != null && connectorSignatures.size() + 1 > connectorSignatureLimit)
            || regionStarts.size() + newRegions > regionLimit;
        if (overCapacity) {
            saturated = true;
            return PlanRegistrationResult.SATURATED;
        }

        laneSignatures.add(laneSignature);
        if (connectorSignature != null) {
            connectorSignatures.add(connectorSignature);
        }
        for (PlaneRegion region : touchedRegions) {
            regionStarts.put(region, regionStarts.getOrDefault(region, 0) + 1);
        }
        return PlanRegistrationResult.REGISTERED;
    }

    boolean contains(InspectedCell cell) {
        return cell != null && inspected.contains(cell);
    }

    Set<InspectedCell> inspectedCells() {
        return Set.copyOf(inspected);
    }

    Set<LaneSignature> laneSignatures() {
        return Set.copyOf(laneSignatures);
    }

    Set<ConnectorSignature> connectorSignatures() {
        return Set.copyOf(connectorSignatures);
    }

    boolean saturated() {
        return saturated;
    }

    void accountCommand(int blocks, long activeMs) {
        beginEpoch();
        epochBlocks = Math.min(blockLimit, epochBlocks + Math.max(0, blocks));
        epochActiveMs = Math.min(timeLimitMs, epochActiveMs + Math.max(0L, activeMs));
    }

    void completeEpoch() {
        epochActive = false;
        epochBlocks = 0;
        epochActiveMs = 0L;
        exhaustedHeadings.clear();
    }

    boolean exhaustedWith(int currentBlocks, long currentActiveMs) {
        return epochBlocks + Math.max(0, currentBlocks) >= blockLimit
            || epochActiveMs + Math.max(0L, currentActiveMs) >= timeLimitMs;
    }

    int remainingBlocks() {
        return Math.max(0, blockLimit - epochBlocks);
    }

    long remainingActiveMs() {
        return Math.max(0L, timeLimitMs - epochActiveMs);
    }

    int epoch() {
        return epoch;
    }

    int epochBlocks() {
        return epochBlocks;
    }

    long epochActiveMs() {
        return epochActiveMs;
    }

    /** Compatibility diagnostic: now reports exact inspected-cell count. */
    int rememberedColumns() {
        return inspected.size();
    }

    int rememberedCells() {
        return inspected.size();
    }

    int regionCount() {
        return regionStarts.size();
    }

    Set<PlaneRegion> planeRegions() {
        return Set.copyOf(regionStarts.keySet());
    }

    int laneCount() {
        return laneSignatures.size();
    }

    int connectorCount() {
        return connectorSignatures.size();
    }

    boolean consumeSaturationEvent() {
        if (!saturated || saturationReported) {
            return false;
        }
        saturationReported = true;
        return true;
    }

    /** Clears all mission-owned memory and context identity during mission cleanup. */
    void resetMission() {
        resetAll();
        worldToken = Long.MIN_VALUE;
        dimension = "";
    }

    static Set<InspectedCell> exposureShellForLane(
        VoxelCell origin,
        StaircaseDescentPlanner.Direction2d heading,
        int length
    ) {
        if (origin == null || heading == null || length < 1) {
            return Set.of();
        }
        Set<VoxelCell> airVolume = new HashSet<>();
        for (int step = 0; step <= length; step++) {
            int x = origin.x() + heading.dx() * step;
            int z = origin.z() + heading.dz() * step;
            airVolume.add(new VoxelCell(x, origin.y(), z));
            airVolume.add(new VoxelCell(x, origin.y() + 1, z));
        }
        Set<InspectedCell> shell = new LinkedHashSet<>();
        for (int step = 1; step <= length; step++) {
            int x = origin.x() + heading.dx() * step;
            int z = origin.z() + heading.dz() * step;
            for (int y = origin.y(); y <= origin.y() + 1; y++) {
                VoxelCell bodyCell = new VoxelCell(x, y, z);
                for (VoxelCell face : faceNeighbours(bodyCell)) {
                    if (!airVolume.contains(face)) {
                        shell.add(new InspectedCell(face.x(), face.y(), face.z()));
                    }
                }
            }
        }
        return Set.copyOf(shell);
    }

    private int projectedOverlap(
        int originX,
        int feetY,
        int originZ,
        StaircaseDescentPlanner.Direction2d heading
    ) {
        VoxelCell projectedOrigin = new VoxelCell(
            originX + heading.dx() * DEPARTURE_SEAM_CELLS,
            feetY,
            originZ + heading.dz() * DEPARTURE_SEAM_CELLS
        );
        int projectedLength = PROJECTED_CELLS - DEPARTURE_SEAM_CELLS;
        int overlap = 0;
        for (InspectedCell cell : exposureShellForLane(projectedOrigin, heading, projectedLength)) {
            if (inspected.contains(cell)) {
                overlap++;
            }
        }
        return overlap;
    }

    private void addInspectedAtomically(Set<InspectedCell> cells) {
        Set<InspectedCell> additions = new LinkedHashSet<>(cells);
        additions.removeAll(inspected);
        if (inspected.size() + additions.size() > inspectedCellLimit) {
            saturated = true;
            return;
        }
        inspected.addAll(additions);
    }

    private static boolean validLaneRoute(LaneSignature signature, List<VoxelCell> lane) {
        if (signature == null || lane == null || lane.size() != PROJECTED_CELLS) {
            return false;
        }
        for (int step = 1; step <= PROJECTED_CELLS; step++) {
            VoxelCell expected = new VoxelCell(
                signature.originX() + signature.dx() * step,
                signature.feetY(),
                signature.originZ() + signature.dz() * step
            );
            if (!expected.equals(lane.get(step - 1))) {
                return false;
            }
        }
        return true;
    }

    private static boolean validConnectorRoute(
        LaneSignature laneSignature,
        ConnectorSignature signature,
        List<VoxelCell> connector
    ) {
        List<VoxelCell> cells = connector == null ? List.of() : connector;
        if (signature == null) {
            return cells.isEmpty();
        }
        if (cells.size() != CANONICAL_CONNECTOR_CELLS) {
            return false;
        }
        VoxelCell laneOrigin = new VoxelCell(
            laneSignature.originX(),
            laneSignature.feetY(),
            laneSignature.originZ()
        );
        if (!signature.hasEndpoint(laneOrigin) || !laneOrigin.equals(cells.getLast())) {
            return false;
        }
        int connectorDx = signature.destinationX() - signature.sourceX();
        int connectorDz = signature.destinationZ() - signature.sourceZ();
        if (connectorDx * laneSignature.dx() + connectorDz * laneSignature.dz() != 0) {
            return false;
        }
        VoxelCell traversalSource = signature.sourceX() == laneOrigin.x()
            && signature.sourceZ() == laneOrigin.z()
            ? new VoxelCell(signature.destinationX(), signature.feetY(), signature.destinationZ())
            : new VoxelCell(signature.sourceX(), signature.feetY(), signature.sourceZ());
        int dx = Integer.compare(laneOrigin.x(), traversalSource.x());
        int dz = Integer.compare(laneOrigin.z(), traversalSource.z());
        for (int step = 1; step <= CANONICAL_CONNECTOR_CELLS; step++) {
            VoxelCell expected = new VoxelCell(
                traversalSource.x() + dx * step,
                signature.feetY(),
                traversalSource.z() + dz * step
            );
            if (!expected.equals(cells.get(step - 1))) {
                return false;
            }
        }
        return true;
    }

    private static Set<PlaneRegion> touchedRegions(
        LaneSignature laneSignature,
        ConnectorSignature connectorSignature,
        List<VoxelCell> connector,
        List<VoxelCell> lane
    ) {
        Set<PlaneRegion> regions = new LinkedHashSet<>();
        regions.add(PlaneRegion.at(
            laneSignature.feetY(),
            laneSignature.originX(),
            laneSignature.originZ()
        ));
        if (connectorSignature != null) {
            regions.add(PlaneRegion.at(
                connectorSignature.feetY(),
                connectorSignature.sourceX(),
                connectorSignature.sourceZ()
            ));
            regions.add(PlaneRegion.at(
                connectorSignature.feetY(),
                connectorSignature.destinationX(),
                connectorSignature.destinationZ()
            ));
        }
        for (VoxelCell cell : connector) {
            regions.add(PlaneRegion.at(cell.y(), cell.x(), cell.z()));
        }
        for (VoxelCell cell : lane) {
            regions.add(PlaneRegion.at(cell.y(), cell.x(), cell.z()));
        }
        return Set.copyOf(regions);
    }

    private void resetAll() {
        inspected.clear();
        regionStarts.clear();
        laneSignatures.clear();
        connectorSignatures.clear();
        exhaustedHeadings.clear();
        lastPosition = null;
        epoch = 0;
        epochBlocks = 0;
        epochActiveMs = 0L;
        epochActive = false;
        saturated = false;
        saturationReported = false;
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

    private static double square(int value) {
        return (double) value * value;
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

    private static int coordinateOrder(int firstX, int firstZ, int secondX, int secondZ) {
        int x = Integer.compare(firstX, secondX);
        return x != 0 ? x : Integer.compare(firstZ, secondZ);
    }
}
