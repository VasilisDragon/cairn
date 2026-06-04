package com.mcbot.fabricclient;

import java.util.HashMap;
import java.util.Map;
import java.util.OptionalInt;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.BlockView;

/** Live bounded grid perception backed by the client world's current block states. */
final class WorldGridPerception implements GridPerception {
    static final int DEFAULT_SURFACE_SCAN_UP = 3;
    static final int DEFAULT_SURFACE_SCAN_DOWN = 10;
    static final int FALLBACK_SURFACE_SCAN_UP = 12;
    static final int FALLBACK_SURFACE_SCAN_DOWN = 32;

    private final BlockView world;
    private final int referenceFeetY;
    private final int surfaceScanUp;
    private final int surfaceScanDown;
    private final int minX;
    private final int maxX;
    private final int minZ;
    private final int maxZ;
    private final Map<GridCell, OptionalInt> surfaceCache = new HashMap<>();

    WorldGridPerception(BlockView world, int referenceFeetY, GridCell start, GridCell goal, int margin) {
        this(
            world,
            referenceFeetY,
            Math.min(start.x(), goal.x()) - Math.max(0, margin),
            Math.max(start.x(), goal.x()) + Math.max(0, margin),
            Math.min(start.z(), goal.z()) - Math.max(0, margin),
            Math.max(start.z(), goal.z()) + Math.max(0, margin),
            DEFAULT_SURFACE_SCAN_UP,
            DEFAULT_SURFACE_SCAN_DOWN
        );
    }

    WorldGridPerception(BlockView world, int referenceFeetY, int minX, int maxX, int minZ, int maxZ) {
        this(world, referenceFeetY, minX, maxX, minZ, maxZ, DEFAULT_SURFACE_SCAN_UP, DEFAULT_SURFACE_SCAN_DOWN);
    }

    WorldGridPerception(
        BlockView world,
        int referenceFeetY,
        GridCell start,
        GridCell goal,
        int margin,
        int surfaceScanUp,
        int surfaceScanDown
    ) {
        this(
            world,
            referenceFeetY,
            Math.min(start.x(), goal.x()) - Math.max(0, margin),
            Math.max(start.x(), goal.x()) + Math.max(0, margin),
            Math.min(start.z(), goal.z()) - Math.max(0, margin),
            Math.max(start.z(), goal.z()) + Math.max(0, margin),
            surfaceScanUp,
            surfaceScanDown
        );
    }

    WorldGridPerception(
        BlockView world,
        int referenceFeetY,
        int minX,
        int maxX,
        int minZ,
        int maxZ,
        int surfaceScanUp,
        int surfaceScanDown
    ) {
        if (world == null) {
            throw new IllegalArgumentException("world is required");
        }
        if (minX > maxX || minZ > maxZ) {
            throw new IllegalArgumentException("invalid perception bounds");
        }
        this.world = world;
        this.referenceFeetY = referenceFeetY;
        this.surfaceScanUp = Math.max(0, surfaceScanUp);
        this.surfaceScanDown = Math.max(0, surfaceScanDown);
        this.minX = minX;
        this.maxX = maxX;
        this.minZ = minZ;
        this.maxZ = maxZ;
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
        GridCell cell = new GridCell(x, z);
        OptionalInt cached = surfaceCache.get(cell);
        if (cached != null) {
            return cached;
        }
        OptionalInt discovered = scanSurfaceY(x, z);
        surfaceCache.put(cell, discovered);
        return discovered;
    }

    @Override
    public TraversalIssue traversalIssue(GridCell from, GridCell to) {
        if (from == null || to == null) {
            return TraversalIssue.INVALID_REQUEST;
        }
        if (!inBounds(to.x(), to.z())) {
            return TraversalIssue.OUT_OF_BOUNDS;
        }
        OptionalInt fromSurface = surfaceY(from.x(), from.z());
        if (fromSurface.isEmpty()) {
            return TraversalIssue.FROM_BLOCKED;
        }
        OptionalInt toSurface = surfaceY(to.x(), to.z());
        if (toSurface.isEmpty()) {
            return TraversalIssue.TO_BLOCKED;
        }
        int fromY = fromSurface.getAsInt();
        return WalkabilityClassifier.traversalIssueForTransitionClearance(
            fromY,
            toSurface.getAsInt(),
            hasCollision(new BlockPos(to.x(), fromY, to.z())),
            hasCollision(new BlockPos(to.x(), fromY + 1, to.z()))
        );
    }

    int blockedCount() {
        int blocked = 0;
        for (int x = minX; x <= maxX; x++) {
            for (int z = minZ; z <= maxZ; z++) {
                if (isBlocked(x, z)) {
                    blocked++;
                }
            }
        }
        return blocked;
    }

    int cellCount() {
        return (maxX - minX + 1) * (maxZ - minZ + 1);
    }

    int hazardCount() {
        int hazards = 0;
        for (int x = minX; x <= maxX; x++) {
            for (int z = minZ; z <= maxZ; z++) {
                if (columnHasHazard(x, z)) {
                    hazards++;
                }
            }
        }
        return hazards;
    }

    boolean columnHasHazard(int x, int z) {
        if (!inBounds(x, z)) {
            return false;
        }
        for (int y = referenceFeetY - surfaceScanDown - 1; y <= referenceFeetY + surfaceScanUp + 1; y++) {
            if (isHazard(world.getBlockState(new BlockPos(x, y, z)))) {
                return true;
            }
        }
        return false;
    }

    String surfaceSummary(GridCell... cells) {
        StringBuilder builder = new StringBuilder();
        for (GridCell cell : cells) {
            if (builder.length() > 0) {
                builder.append(' ');
            }
            OptionalInt surface = surfaceY(cell.x(), cell.z());
            builder
                .append(cell)
                .append('=')
                .append(surface.isPresent() ? Integer.toString(surface.getAsInt()) : "blocked");
        }
        return builder.toString();
    }

    @Override
    public int minX() {
        return minX;
    }

    @Override
    public int maxX() {
        return maxX;
    }

    @Override
    public int minZ() {
        return minZ;
    }

    @Override
    public int maxZ() {
        return maxZ;
    }

    private OptionalInt scanSurfaceY(int x, int z) {
        return SurfaceScanner.scan(referenceFeetY, surfaceScanUp, surfaceScanDown, (y) -> isStandableAt(x, y, z));
    }

    private boolean isStandableAt(int x, int feetY, int z) {
        BlockPos feet = new BlockPos(x, feetY, z);
        BlockPos head = feet.up();
        BlockPos floor = feet.down();
        boolean floorSolid = hasCollision(floor);
        boolean feetSolid = hasCollision(feet);
        boolean headSolid = hasCollision(head);
        boolean hazard = isHazard(world.getBlockState(floor))
            || isHazard(world.getBlockState(feet))
            || isHazard(world.getBlockState(head));
        return WalkabilityClassifier.isStandableSurface(floorSolid, feetSolid, headSolid, hazard);
    }

    private boolean hasCollision(BlockPos pos) {
        BlockState state = world.getBlockState(pos);
        return !state.getCollisionShape(world, pos).isEmpty();
    }

    private static boolean isHazard(BlockState state) {
        return state.isOf(Blocks.WATER)
            || state.isOf(Blocks.LAVA)
            || state.isOf(Blocks.FIRE)
            || state.isOf(Blocks.SOUL_FIRE)
            || state.isOf(Blocks.CACTUS)
            || state.isOf(Blocks.SWEET_BERRY_BUSH)
            || state.isOf(Blocks.POWDER_SNOW)
            || state.isOf(Blocks.MAGMA_BLOCK)
            || state.isOf(Blocks.CAMPFIRE)
            || state.isOf(Blocks.SOUL_CAMPFIRE)
            || state.getFluidState().isIn(FluidTags.WATER)
            || state.getFluidState().isIn(FluidTags.LAVA);
    }
}
