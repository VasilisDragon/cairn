package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class IronProspectAtlas {
    static final int DEFAULT_COLUMN_LIMIT = 4096;
    static final int DEFAULT_REGION_LIMIT = 256;
    static final int DEFAULT_BLOCK_LIMIT = 384;
    static final long DEFAULT_TIME_LIMIT_MS = 900_000L;
    static final int PROJECTED_CELLS = 12;
    static final int DEPARTURE_SEAM_CELLS = 2;

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

    record Selection(
        StaircaseDescentPlanner.Direction2d heading,
        Region region,
        int projectedOverlap,
        int regionStarts,
        boolean exhausted,
        String source
    ) {
    }

    private final int columnLimit;
    private final int regionLimit;
    private final int blockLimit;
    private final long timeLimitMs;
    private final Set<Column> remembered = new LinkedHashSet<>();
    private final Map<Region, Integer> regionStarts = new HashMap<>();
    private final Set<String> exhaustedHeadings = new HashSet<>();
    private long worldToken = Long.MIN_VALUE;
    private String dimension = "";
    private Column lastPosition = null;
    private int epoch = 0;
    private int epochBlocks = 0;
    private long epochActiveMs = 0L;
    private boolean epochActive = false;
    private boolean saturated = false;
    private boolean saturationReported = false;

    IronProspectAtlas() {
        this(DEFAULT_COLUMN_LIMIT, DEFAULT_REGION_LIMIT, DEFAULT_BLOCK_LIMIT, DEFAULT_TIME_LIMIT_MS);
    }

    IronProspectAtlas(int columnLimit, int regionLimit, int blockLimit, long timeLimitMs) {
        this.columnLimit = Math.max(1, columnLimit);
        this.regionLimit = Math.max(1, regionLimit);
        this.blockLimit = Math.max(1, blockLimit);
        this.timeLimitMs = Math.max(1L, timeLimitMs);
    }

    boolean observeContext(long nextWorldToken, String nextDimension, int x, int z) {
        String normalizedDimension = nextDimension == null ? "" : nextDimension;
        boolean changed = worldToken != Long.MIN_VALUE
            && (worldToken != nextWorldToken || !dimension.equals(normalizedDimension));
        boolean discontinuity = lastPosition != null
            && Math.hypot(x - lastPosition.x(), z - lastPosition.z()) > 64.0D;
        if (changed || discontinuity) {
            resetAll();
        }
        worldToken = nextWorldToken;
        dimension = normalizedDimension;
        lastPosition = new Column(x, z);
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
        List<Selection> ranked = new ArrayList<>();
        for (StaircaseDescentPlanner.Direction2d heading : headings) {
            int destinationX = originX + heading.dx() * PROJECTED_CELLS;
            int destinationZ = originZ + heading.dz() * PROJECTED_CELLS;
            Region region = Region.at(destinationX, destinationZ);
            ranked.add(new Selection(
                heading,
                region,
                projectedOverlap(originX, originZ, heading),
                regionStarts.getOrDefault(region, 0),
                exhaustedHeadings.contains(heading.name()),
                hint != null && hint.equals(heading) ? "brain_hint" : "atlas"
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
        Region region = selection.region();
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

    void recordCorridor(int feetX, int feetY, int feetZ, StaircaseDescentPlanner.Direction2d heading) {
        if (heading == null || feetY < 6 || feetY > 16 || saturated) {
            return;
        }
        int perpX = -heading.dz();
        int perpZ = heading.dx();
        addColumn(new Column(feetX, feetZ));
        addColumn(new Column(feetX + perpX, feetZ + perpZ));
        addColumn(new Column(feetX + perpX * 2, feetZ + perpZ * 2));
        addColumn(new Column(feetX - perpX, feetZ - perpZ));
        addColumn(new Column(feetX - perpX * 2, feetZ - perpZ * 2));
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

    int rememberedColumns() {
        return remembered.size();
    }

    int regionCount() {
        return regionStarts.size();
    }

    boolean consumeSaturationEvent() {
        if (!saturated || saturationReported) {
            return false;
        }
        saturationReported = true;
        return true;
    }

    private int projectedOverlap(int originX, int originZ, StaircaseDescentPlanner.Direction2d heading) {
        int overlap = 0;
        int perpX = -heading.dz();
        int perpZ = heading.dx();
        for (int step = DEPARTURE_SEAM_CELLS + 1; step <= PROJECTED_CELLS; step++) {
            int x = originX + heading.dx() * step;
            int z = originZ + heading.dz() * step;
            for (int offset = -2; offset <= 2; offset++) {
                if (remembered.contains(new Column(x + perpX * offset, z + perpZ * offset))) {
                    overlap++;
                }
            }
        }
        return overlap;
    }

    private void addColumn(Column column) {
        if (remembered.contains(column)) {
            return;
        }
        if (remembered.size() >= columnLimit) {
            saturated = true;
            return;
        }
        remembered.add(column);
    }

    private void resetAll() {
        remembered.clear();
        regionStarts.clear();
        exhaustedHeadings.clear();
        lastPosition = null;
        epoch = 0;
        epochBlocks = 0;
        epochActiveMs = 0L;
        epochActive = false;
        saturated = false;
        saturationReported = false;
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
}
