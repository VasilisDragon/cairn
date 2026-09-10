package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.function.BiPredicate;
import java.util.function.Predicate;

/** Recorded-route rejoin with a bounded adjacent return. No search or progress credit. */
final class DescentRejoinPolicy {
    static final int MAX_ROUTE_CELLS = 16;

    enum Admission { READY, WAIT_GROUNDED, UNSAFE, EXPIRED }
    record Stance(boolean grounded, boolean dry, boolean bodyClear, boolean supportStable, boolean hazardFree) { }
    static Admission admission(Stance stance, long nowMs, long deadlineMs) {
        if (stance == null) return Admission.UNSAFE;
        if (nowMs >= deadlineMs) return Admission.EXPIRED;
        if (!stance.dry() || !stance.bodyClear() || !stance.hazardFree()) return Admission.UNSAFE;
        if (!stance.grounded()) return Admission.WAIT_GROUNDED;
        return stance.supportStable() ? Admission.READY : Admission.UNSAFE;
    }

    static boolean captureLanding(VoxelCell origin, VoxelCell landing, VoxelCell feet,
                                  boolean grounded, double x, double z) {
        return captureLanding(origin, landing, feet, grounded,
            new Footprint(x - 0.30D, x + 0.30D, z - 0.30D, z + 0.30D));
    }

    record Footprint(double minX, double maxX, double minZ, double maxZ) {
        boolean valid() {
            return Double.isFinite(minX) && Double.isFinite(maxX)
                && Double.isFinite(minZ) && Double.isFinite(maxZ) && minX < maxX && minZ < maxZ;
        }
    }

    static boolean captureLanding(VoxelCell origin, VoxelCell landing, VoxelCell feet,
                                  boolean grounded, Footprint body) {
        if (origin == null || landing == null || feet == null || landing.y() != origin.y() - 1
            || Math.abs(landing.x() - origin.x()) + Math.abs(landing.z() - origin.z()) != 1
            || feet.x() != landing.x() || feet.z() != landing.z()
            || body == null || !body.valid()) return false;
        // Braking is not transition admission. The latter deliberately requires
        // extra clearance; waiting for that margin here can apply another full
        // forward tick after horizontal movement has already left the support,
        // while onGround still reflects the earlier vertical collision.
        boolean cleared = landing.x() > origin.x() ? body.minX() >= origin.x() + 1.0D
            : landing.x() < origin.x() ? body.maxX() <= origin.x()
            : landing.z() > origin.z() ? body.minZ() >= origin.z() + 1.0D
            : body.maxZ() <= origin.z();
        return !grounded || feet.y() < origin.y()
            || cleared;
    }

    record Trail(boolean active, boolean available, long session, long revision, List<VoxelCell> cells) {
        Trail { cells = cells == null ? null : java.util.Collections.unmodifiableList(new ArrayList<>(cells)); }
        static Trail inactive() { return new Trail(false, true, 0, 0, List.of()); }
    }

    static final class Attempts {
        private final HashSet<String> spent = new HashSet<>();
        boolean claim(String command) {
            return command != null && !command.isBlank() && spent.size() < 256 && spent.add(command);
        }
        boolean contains(String command) { return spent.contains(command); }
        void clearForNewSession() { spent.clear(); }
    }

    record Plan(List<VoxelCell> route, String failure, String routeKind) {
        boolean accepted() { return failure == null; }
        static Plan reject(String reason) { return new Plan(List.of(), reason, null); }
    }

    static Plan plan(Trail canonical, List<VoxelCell> reached, VoxelCell actual, VoxelCell target,
                     Predicate<VoxelCell> safeCell, BiPredicate<VoxelCell, VoxelCell> safeEdge) {
        if (canonical == null || reached == null || reached.isEmpty() || reached.stream().anyMatch(java.util.Objects::isNull)
            || actual == null || target == null || safeCell == null || safeEdge == null) {
            return Plan.reject("unsafe_state");
        }
        if (!canonical.available() || canonical.cells() == null || canonical.cells().stream().anyMatch(java.util.Objects::isNull)) {
            return Plan.reject("route_unavailable");
        }
        if (!target.equals(reached.getLast())) return Plan.reject("stale_trail");
        var merged = new ArrayList<VoxelCell>();
        int overlap = 0;
        if (canonical.active()) {
            if (canonical.cells().isEmpty()) return Plan.reject("route_unavailable");
            merged.addAll(canonical.cells());
            for (int count = Math.min(merged.size(), reached.size()); count > 0; count--) {
                if (merged.subList(merged.size() - count, merged.size()).equals(reached.subList(0, count))) {
                    overlap = count;
                    break;
                }
            }
            if (overlap == 0) return Plan.reject("route_unavailable");
        }
        merged.addAll(reached.subList(overlap, reached.size()));
        if (new HashSet<>(merged).size() != merged.size()) return Plan.reject("ambiguous_route");
        int sourceIndex = merged.indexOf(actual);
        int targetIndex = merged.indexOf(target);
        if (sourceIndex < 0) {
            // This fallback cannot repair a missing/ambiguous trail, select an
            // intermediate target, or shorten an existing recorded segment.
            if (targetIndex != merged.size() - 1 || actual.y() != target.y()
                || horizontalDistance(actual, target) != 1) return Plan.reject("route_unavailable");
            for (int i = 1; i < merged.size(); i++) {
                VoxelCell before = merged.get(i - 1), after = merged.get(i);
                if (horizontalDistance(before, after) != 1
                    || Math.abs((long) before.y() - after.y()) > 1) return Plan.reject("route_unavailable");
            }
            List<VoxelCell> route = List.of(actual, target);
            if (!validRoute(route, safeCell, safeEdge)) return Plan.reject("unsafe_route");
            return new Plan(route, null, "adjacent_return");
        }
        if (targetIndex <= sourceIndex) return Plan.reject("route_unavailable");
        if (targetIndex - sourceIndex + 1 > MAX_ROUTE_CELLS) return Plan.reject("route_limit");
        List<VoxelCell> route = List.copyOf(merged.subList(sourceIndex, targetIndex + 1));
        if (!validRoute(route, safeCell, safeEdge)) return Plan.reject("unsafe_route");
        return new Plan(route, null, "recorded_segment");
    }

    private static long horizontalDistance(VoxelCell a, VoxelCell b) {
        return Math.abs((long) a.x() - b.x()) + Math.abs((long) a.z() - b.z());
    }

    static boolean validRoute(List<VoxelCell> route, Predicate<VoxelCell> safeCell,
                              BiPredicate<VoxelCell, VoxelCell> safeEdge) {
        if (route == null || route.isEmpty() || route.size() > MAX_ROUTE_CELLS
            || safeCell == null || safeEdge == null) return false;
        for (int i = 0; i < route.size(); i++) {
            if (route.get(i) == null || !safeCell.test(route.get(i))) return false;
            if (i > 0 && (!safeEdge.test(route.get(i - 1), route.get(i))
                || !safeEdge.test(route.get(i), route.get(i - 1)))) return false;
        }
        return true;
    }

    static boolean sameTrail(Trail frozen, Trail live) {
        return frozen != null && live != null && frozen.cells() != null && live.cells() != null && live.available()
            && frozen.active() == live.active() && frozen.session() == live.session()
            && frozen.revision() == live.revision() && frozen.cells().equals(live.cells());
    }

    static long deadline(long startedAtMs, long commandDeadlineMs, int cells) {
        return Math.min(commandDeadlineMs, startedAtMs + MiningWorkspaceTraversal.timeoutMs(cells));
    }

    private DescentRejoinPolicy() { }
}
