package com.mcbot.fabricclient;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Objects;
import java.util.function.Supplier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.BlockView;

/**
 * Bounded, route-opaque proof that one village travel stage can leave the observer safely.
 *
 * <p>The transaction executor may chain several ordinary 32-cell stages, but discovery admission
 * proves only the first one. Complete routes never enter snapshots or wire signals. Repeated
 * snapshot polls reuse one verdict and a moving/stale input fails closed until the throttle opens.
 */
final class VillageFrontierAccessProof {
    static final long REFRESH_INTERVAL_MS = 1_000L;
    static final int MAX_CACHED_DISCOVERIES = OpportunityObservationCollector.MAX_WIRE_DISCOVERIES;

    record Result(
        boolean routeReachable,
        int routeCells,
        int expandedCells,
        boolean frontier,
        String reason
    ) {
        Result {
            routeCells = Math.max(0, routeCells);
            expandedCells = Math.max(0, expandedCells);
            reason = reason == null ? "" : reason;
        }

        static Result rejected(String reason) {
            return new Result(false, 0, 0, false, reason);
        }
    }

    private record Inputs(
        Object worldIdentity,
        VoxelCell observer,
        VoxelCell marker,
        long geometryRevision
    ) {
    }

    private record Cached(Inputs inputs, long computedAtMs, Result result) {
    }

    private final LinkedHashMap<String, Cached> cachedByDiscovery = new LinkedHashMap<>();

    Result evaluate(
        BlockView world,
        String discoveryId,
        BlockPos observerFeet,
        BlockPos frozenMarker,
        long geometryRevision,
        long nowMs
    ) {
        if (world == null || observerFeet == null || frozenMarker == null) {
            return Result.rejected("invalid_request");
        }
        VoxelCell observer = cell(observerFeet);
        VoxelCell marker = cell(frozenMarker);
        if (outsideSessionRadius(observer, marker)) {
            return Result.rejected("outside_session_radius");
        }
        return evaluate(
            world,
            discoveryId,
            observer,
            marker,
            geometryRevision,
            nowMs,
            () -> prove(
                new WorldVoxelPerception(world, observer, marker, 4, 4),
                observer,
                marker)
        );
    }

    Result evaluate(
        Object worldIdentity,
        String discoveryId,
        VoxelCell observer,
        VoxelCell marker,
        long geometryRevision,
        long nowMs,
        Supplier<Result> computation
    ) {
        String key = normalized(discoveryId);
        if (worldIdentity == null || key.isBlank() || observer == null || marker == null
            || computation == null) {
            return Result.rejected("invalid_request");
        }
        if (outsideSessionRadius(observer, marker)) {
            return Result.rejected("outside_session_radius");
        }
        Inputs inputs = new Inputs(
            worldIdentity, observer, marker, Math.max(0L, geometryRevision));
        long canonicalNow = Math.max(0L, nowMs);
        Cached prior = cachedByDiscovery.get(key);
        if (prior != null
            && canonicalNow - prior.computedAtMs() < REFRESH_INTERVAL_MS) {
            return prior.inputs().equals(inputs)
                ? prior.result()
                : Result.rejected("throttled_input_change");
        }
        Result computed = Objects.requireNonNullElseGet(
            computation.get(), () -> Result.rejected("invalid_result"));
        cachedByDiscovery.put(key, new Cached(inputs, canonicalNow, computed));
        while (cachedByDiscovery.size() > MAX_CACHED_DISCOVERIES) {
            cachedByDiscovery.remove(cachedByDiscovery.keySet().iterator().next());
        }
        return computed;
    }

    static Result prove(
        GatherWoodLocalEgressPerception perception,
        VoxelCell observer,
        VoxelCell frozenMarker
    ) {
        if (perception == null || observer == null || frozenMarker == null) {
            return Result.rejected("invalid_request");
        }
        if (outsideSessionRadius(observer, frozenMarker)) {
            return Result.rejected("outside_session_radius");
        }
        VillageRoutePlanSelector.Selection selection = VillageRoutePlanSelector.select(
            perception,
            observer,
            frozenMarker,
            VillageInteractionStancePlanner.Mode.EXACT_TRAVEL,
            true,
            false);
        VillageInteractionStancePlanner.Plan plan = selection.plan();
        if (!selection.accepted()) {
            return new Result(
                false,
                0,
                plan.expandedCells(),
                false,
                plan.reason().isBlank() ? "route_rejected" : plan.reason());
        }
        if (selection.computations() != 1
            || plan.route().isEmpty()
            || plan.route().size() > VillageInteractionStancePlanner.MAX_ROUTE_CELLS
            || !observer.equals(plan.route().getFirst())
            || !plan.stance().equals(plan.route().getLast())) {
            return new Result(
                false, 0, plan.expandedCells(), false, "invalid_frontier_package");
        }
        boolean frontier = selection.frontierStage()
            && plan.frontier()
            && !plan.targetReached();
        if (!frontier) {
            return new Result(
                false, 0, plan.expandedCells(), false, "frontier_required");
        }
        if (frontier
            && horizontalDistance(plan.stance(), frozenMarker) + 2.0D
                > horizontalDistance(observer, frozenMarker)) {
            return new Result(
                false, 0, plan.expandedCells(), true, "nonprogress_frontier");
        }
        return new Result(
            true,
            plan.route().size(),
            plan.expandedCells(),
            frontier,
            "");
    }

    int cachedDiscoveryCount() {
        return cachedByDiscovery.size();
    }

    void clear() {
        cachedByDiscovery.clear();
    }

    private static VoxelCell cell(BlockPos pos) {
        return new VoxelCell(pos.getX(), pos.getY(), pos.getZ());
    }

    private static double horizontalDistance(VoxelCell from, VoxelCell to) {
        return Math.hypot(from.x() - to.x(), from.z() - to.z());
    }

    private static boolean outsideSessionRadius(VoxelCell from, VoxelCell to) {
        return from == null || to == null
            || horizontalDistance(from, to) > VillageOpportunityExecutor.MAX_SESSION_RADIUS;
    }

    private static String normalized(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }
}
