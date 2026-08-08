package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * Coordinates the atomic store/controller half of an active canonical surface-return repair.
 *
 * <p>The traversal route is frontier-to-surface while the store is surface-to-frontier. All
 * validation that can fail is therefore completed before the store mutation; the controller's
 * final update uses its prevalidated replacement seam.
 */
final class SurfaceReturnRouteSuffixRepair {
    private SurfaceReturnRouteSuffixRepair() {
    }

    static Result apply(
        SurfaceReturnTrailStore store,
        ReturnStaircaseTraversalController traversal,
        long expectedSessionRevision,
        long expectedTrailRevision,
        VoxelCell expectedAnchor,
        List<VoxelCell> expectedCanonicalTrail,
        ReturnStaircaseTraversalController.RouteSnapshot snapshot,
        SurfaceReturnRouteSuffixPlanner.Result plan
    ) {
        if (store == null
            || traversal == null
            || expectedAnchor == null
            || expectedCanonicalTrail == null
            || snapshot == null) {
            return rejected("stale_return", plan);
        }
        if (plan == null || !plan.found()) {
            return rejected(plan == null ? "no_safe_connector" : plan.failureReason(), plan);
        }

        List<VoxelCell> activeRoute = snapshot.route();
        int invalidIndex = snapshot.waypointIndex();
        int rejoinIndex = plan.rejoinIndex();
        List<VoxelCell> connector = plan.connector();
        if (snapshot.transitionKind() != ReturnStaircaseTraversalController.TransitionKind.NONE
            || snapshot.transitionPhase() != ReturnStaircaseTraversalController.TransitionPhase.NONE
            || invalidIndex <= 0
            || invalidIndex >= activeRoute.size() - 1
            || rejoinIndex <= invalidIndex
            || rejoinIndex >= activeRoute.size()
            || connector.size() < 2
            || !activeRoute.get(invalidIndex - 1).equals(connector.get(0))
            || !activeRoute.get(rejoinIndex).equals(connector.get(connector.size() - 1))
            || plan.skippedCells() != rejoinIndex - invalidIndex) {
            return rejected("invalid_replacement", plan);
        }

        List<VoxelCell> expectedActiveRoute = reversed(expectedCanonicalTrail);
        if (!activeRoute.equals(expectedActiveRoute)) {
            return rejected("stale_trail", plan);
        }
        List<VoxelCell> repairedActiveRoute = splice(
            activeRoute,
            invalidIndex,
            rejoinIndex,
            connector
        );
        List<VoxelCell> repairedCanonicalTrail = reversed(repairedActiveRoute);
        if (!traversal.canReplaceRoute(snapshot, repairedActiveRoute)) {
            return rejected("stale_traversal", plan);
        }

        SurfaceReturnTrailStore.TrailReplaceResult storeResult = store.replaceTrail(
            expectedSessionRevision,
            expectedTrailRevision,
            expectedAnchor,
            expectedCanonicalTrail,
            repairedCanonicalTrail
        );
        if (storeResult != SurfaceReturnTrailStore.TrailReplaceResult.REPLACED) {
            return rejected(
                storeResult.name().toLowerCase(Locale.ROOT),
                storeResult.name(),
                plan
            );
        }

        traversal.replacePrevalidatedRoute(repairedActiveRoute);
        return new Result(
            true,
            "",
            plan.rejoinWaypoint(),
            plan.rejoinIndex(),
            plan.skippedCells(),
            connector.size(),
            activeRoute.size(),
            repairedActiveRoute.size(),
            expectedCanonicalTrail.size(),
            repairedCanonicalTrail.size(),
            plan.expandedCells(),
            expectedTrailRevision,
            store.trailRevision(),
            storeResult.name()
        );
    }

    private static List<VoxelCell> splice(
        List<VoxelCell> activeRoute,
        int invalidIndex,
        int rejoinIndex,
        List<VoxelCell> connector
    ) {
        List<VoxelCell> repaired = new ArrayList<>(activeRoute.size() + connector.size());
        repaired.addAll(activeRoute.subList(0, invalidIndex));
        repaired.addAll(connector.subList(1, connector.size()));
        repaired.addAll(activeRoute.subList(rejoinIndex + 1, activeRoute.size()));
        return List.copyOf(repaired);
    }

    private static List<VoxelCell> reversed(List<VoxelCell> route) {
        List<VoxelCell> reversed = new ArrayList<>(route);
        Collections.reverse(reversed);
        return List.copyOf(reversed);
    }

    private static Result rejected(
        String reason,
        SurfaceReturnRouteSuffixPlanner.Result plan
    ) {
        return rejected(reason, "NOT_ATTEMPTED", plan);
    }

    private static Result rejected(
        String reason,
        String storeResult,
        SurfaceReturnRouteSuffixPlanner.Result plan
    ) {
        return new Result(
            false,
            reason == null || reason.isBlank() ? "no_safe_connector" : reason,
            plan == null ? null : plan.rejoinWaypoint(),
            plan == null ? -1 : plan.rejoinIndex(),
            plan == null ? 0 : plan.skippedCells(),
            plan == null ? 0 : plan.connector().size(),
            0,
            0,
            0,
            0,
            plan == null ? 0 : plan.expandedCells(),
            -1L,
            -1L,
            storeResult == null ? "" : storeResult
        );
    }

    record Result(
        boolean repaired,
        String reason,
        VoxelCell rejoinWaypoint,
        int rejoinIndex,
        int skippedCells,
        int connectorLength,
        int routeLengthBefore,
        int routeLengthAfter,
        int trailLengthBefore,
        int trailLengthAfter,
        int expandedCells,
        long trailRevisionBefore,
        long trailRevisionAfter,
        String storeResult
    ) {
    }
}
