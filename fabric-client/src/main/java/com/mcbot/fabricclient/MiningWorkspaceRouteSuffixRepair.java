package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

final class MiningWorkspaceRouteSuffixRepair {
    private MiningWorkspaceRouteSuffixRepair() {
    }

    static Result apply(
        MiningWorkspaceStore store,
        MiningWorkspaceTransaction transaction,
        MiningWorkspaceStore.Workspace workspace,
        MiningWorkspaceTraversalController.RouteSnapshot snapshot,
        MiningWorkspaceRouteSuffixPlanner.Result plan
    ) {
        if (store == null || transaction == null || workspace == null || snapshot == null) {
            return rejected("stale_transaction", plan);
        }
        if (plan == null || !plan.found()) {
            return rejected(plan == null ? "no_safe_connector" : plan.failureReason(), plan);
        }
        List<VoxelCell> activeRoute = snapshot.route();
        int invalidIndex = snapshot.waypointIndex();
        int rejoinIndex = plan.rejoinIndex();
        List<VoxelCell> connector = plan.connector();
        if (snapshot.mode() == MiningWorkspaceTraversalController.Mode.NONE
            || snapshot.descentPhase() != MiningWorkspaceTraversalController.DescentPhase.NONE
            || invalidIndex <= 0
            || invalidIndex >= activeRoute.size()
            || rejoinIndex <= invalidIndex
            || rejoinIndex >= activeRoute.size()
            || connector.size() < 2
            || !activeRoute.get(invalidIndex - 1).equals(connector.get(0))
            || !activeRoute.get(rejoinIndex).equals(connector.get(connector.size() - 1))
            || plan.skippedCells() != rejoinIndex - invalidIndex) {
            return rejected("invalid_replacement", plan);
        }

        List<VoxelCell> repairedActive = splice(
            activeRoute,
            invalidIndex,
            rejoinIndex,
            connector
        );
        List<VoxelCell> repairedCanonical =
            snapshot.mode() == MiningWorkspaceTraversalController.Mode.RETURN
                ? reversed(repairedActive)
                : repairedActive;
        List<VoxelCell> expectedCanonical = transaction.canonicalTrail();
        List<VoxelCell> expectedActive =
            snapshot.mode() == MiningWorkspaceTraversalController.Mode.RETURN
                ? reversed(expectedCanonical)
                : expectedCanonical;
        long sessionRevision = transaction.workspaceSessionRevision();
        long trailRevision = transaction.workspaceTrailRevision();
        long nextTrailRevision = trailRevision + 1L;
        if (!activeRoute.equals(expectedActive)
            || !transaction.canApplyCanonicalRepair(
                snapshot.mode(),
                snapshot,
                sessionRevision,
                trailRevision,
                expectedCanonical,
                repairedCanonical,
                nextTrailRevision
            )) {
            return rejected("stale_transaction", plan);
        }

        MiningWorkspaceStore.TrailReplaceResult storeResult = store.replaceTrail(
            sessionRevision,
            trailRevision,
            workspace,
            expectedCanonical,
            repairedCanonical
        );
        if (storeResult != MiningWorkspaceStore.TrailReplaceResult.REPLACED) {
            return rejected(storeResult.name().toLowerCase(Locale.ROOT), plan);
        }
        long appliedTrailRevision = store.trailRevision();
        transaction.applyPrevalidatedCanonicalRepair(
            snapshot.mode(),
            repairedCanonical,
            appliedTrailRevision
        );
        return new Result(
            true,
            "",
            plan.rejoinWaypoint(),
            plan.rejoinIndex(),
            plan.skippedCells(),
            connector.size(),
            activeRoute.size(),
            repairedActive.size(),
            expectedCanonical.size(),
            repairedCanonical.size(),
            plan.expandedCells()
        );
    }

    private static List<VoxelCell> splice(
        List<VoxelCell> activeRoute,
        int invalidIndex,
        int rejoinIndex,
        List<VoxelCell> connector
    ) {
        List<VoxelCell> repaired = new ArrayList<>(
            activeRoute.size() + connector.size()
        );
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
        MiningWorkspaceRouteSuffixPlanner.Result plan
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
            plan == null ? 0 : plan.expandedCells()
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
        int breadcrumbCountBefore,
        int breadcrumbCountAfter,
        int expandedCells
    ) {
    }
}
