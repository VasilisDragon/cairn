package com.mcbot.fabricclient;

import java.util.Locale;
import net.minecraft.world.BlockView;
import org.slf4j.Logger;

final class MiningWorkspaceBreadcrumbGapReconciler {
    private final String instanceId;
    private final Logger logger;
    private final MiningWorkspaceStore store;
    private final MiningWorkspaceBreadcrumbGapState state = new MiningWorkspaceBreadcrumbGapState();

    MiningWorkspaceBreadcrumbGapReconciler(
        String instanceId,
        Logger logger,
        MiningWorkspaceStore store
    ) {
        this.instanceId = instanceId == null ? "" : instanceId;
        this.logger = logger;
        this.store = store;
    }

    Observation observe(
        BlockView world,
        String commandId,
        String action,
        String reason,
        MiningWorkspaceBreadcrumbGapState.Context context,
        VoxelCell current,
        boolean grounded,
        boolean standable,
        boolean workspaceValid,
        boolean transactionActive
    ) {
        if (world == null
            || store == null
            || context == null
            || !context.admits(action, reason)) {
            return Observation.canonical(MiningWorkspaceStore.AppendResult.REJECTED_NO_WORKSPACE);
        }

        MiningWorkspaceStore.AppendResult appendResult =
            store.append(current, grounded, standable);
        long sessionRevision = store.sessionRevision();
        if (appendResult == MiningWorkspaceStore.AppendResult.APPENDED
            || appendResult == MiningWorkspaceStore.AppendResult.LOOP_TRUNCATED) {
            state.canonicalContinuityRestored(sessionRevision);
            return Observation.canonical(appendResult);
        }
        if (appendResult != MiningWorkspaceStore.AppendResult.REJECTED_DISCONNECTED
            || !MiningWorkspaceBreadcrumbGapState.shouldAttempt(
                context,
                action,
                reason,
                grounded,
                standable,
                workspaceValid,
                transactionActive
            )) {
            return Observation.canonical(appendResult);
        }

        MiningWorkspaceStore.Workspace workspace = store.workspace();
        VoxelCell frontier = store.frontier();
        MiningWorkspaceBreadcrumbGapState.Decision decision = state.begin(
            sessionRevision,
            commandId,
            workspace == null ? "" : workspace.id(),
            frontier,
            current
        );
        if (!decision.shouldCompute()) {
            return Observation.canonical(appendResult);
        }

        int beforeCount = store.breadcrumbCount();
        int horizontalGap = Math.abs(current.x() - frontier.x())
            + Math.abs(current.z() - frontier.z());
        int verticalGap = Math.abs(current.y() - frontier.y());
        logger.info(
            "mining.workspace.breadcrumbs.gap_detected instanceId={} commandId={} context={} workspaceId={} frontier={} current={} horizontalGap={} verticalGap={} attempt={} connectorLength=0 appendedLength=0 expandedCells=0 breadcrumbCountBefore={} breadcrumbCountAfter={} returnAvailable=false elapsedMs=0 reason=rejected_disconnected",
            instanceId,
            commandId,
            context.eventName(),
            workspace.id(),
            frontier,
            current,
            horizontalGap,
            verticalGap,
            decision.attempt(),
            beforeCount,
            beforeCount
        );

        long startedAtNs = System.nanoTime();
        WorldVoxelPerception perception = new WorldVoxelPerception(
            world,
            frontier,
            current,
            MiningWorkspaceBreadcrumbGapPlanner.MAX_HORIZONTAL_MANHATTAN,
            MiningWorkspaceBreadcrumbGapPlanner.MAX_VERTICAL_DIFFERENCE
        );
        MiningWorkspaceBreadcrumbGapPlanner.Result plan =
            MiningWorkspaceBreadcrumbGapPlanner.plan(
                perception,
                frontier,
                current,
                store.trail()
            );
        long elapsedMs = Math.max(0L, (System.nanoTime() - startedAtNs) / 1_000_000L);
        if (!plan.found()) {
            state.record(decision, MiningWorkspaceBreadcrumbGapState.Outcome.REJECTED);
            logRejected(
                commandId,
                context,
                workspace,
                frontier,
                current,
                horizontalGap,
                verticalGap,
                decision.attempt(),
                0,
                plan.expandedCells(),
                beforeCount,
                elapsedMs,
                plan.failureReason()
            );
            return Observation.canonical(appendResult);
        }

        MiningWorkspaceStore.ConnectorAppendResult connectorResult =
            store.appendConnector(
                sessionRevision,
                workspace,
                frontier,
                plan.connector()
            );
        if (connectorResult != MiningWorkspaceStore.ConnectorAppendResult.RECONCILED) {
            state.record(decision, MiningWorkspaceBreadcrumbGapState.Outcome.REJECTED);
            logRejected(
                commandId,
                context,
                workspace,
                frontier,
                current,
                horizontalGap,
                verticalGap,
                decision.attempt(),
                plan.connector().size(),
                plan.expandedCells(),
                beforeCount,
                elapsedMs,
                connectorResult.name().toLowerCase(Locale.ROOT)
            );
            return Observation.canonical(appendResult);
        }

        state.record(decision, MiningWorkspaceBreadcrumbGapState.Outcome.RECONCILED);
        int afterCount = store.breadcrumbCount();
        boolean returnAvailable = store.returnAvailableFrom(current);
        logger.info(
            "mining.workspace.breadcrumbs.gap_reconciled instanceId={} commandId={} context={} workspaceId={} frontier={} current={} horizontalGap={} verticalGap={} attempt={} connectorLength={} appendedLength={} expandedCells={} breadcrumbCountBefore={} breadcrumbCountAfter={} returnAvailable={} elapsedMs={} reason=reconciled",
            instanceId,
            commandId,
            context.eventName(),
            workspace.id(),
            frontier,
            current,
            horizontalGap,
            verticalGap,
            decision.attempt(),
            plan.connector().size(),
            Math.max(0, plan.connector().size() - 1),
            plan.expandedCells(),
            beforeCount,
            afterCount,
            returnAvailable,
            elapsedMs
        );
        return Observation.reconciled(appendResult);
    }

    private void logRejected(
        String commandId,
        MiningWorkspaceBreadcrumbGapState.Context context,
        MiningWorkspaceStore.Workspace workspace,
        VoxelCell frontier,
        VoxelCell current,
        int horizontalGap,
        int verticalGap,
        int attempt,
        int connectorLength,
        int expandedCells,
        int beforeCount,
        long elapsedMs,
        String reason
    ) {
        logger.warn(
            "mining.workspace.breadcrumbs.gap_rejected instanceId={} commandId={} context={} workspaceId={} frontier={} current={} horizontalGap={} verticalGap={} attempt={} connectorLength={} appendedLength=0 expandedCells={} breadcrumbCountBefore={} breadcrumbCountAfter={} returnAvailable=false elapsedMs={} reason={}",
            instanceId,
            commandId,
            context.eventName(),
            workspace.id(),
            frontier,
            current,
            horizontalGap,
            verticalGap,
            attempt,
            connectorLength,
            expandedCells,
            beforeCount,
            store.breadcrumbCount(),
            elapsedMs,
            reason
        );
    }

    record Observation(
        MiningWorkspaceStore.AppendResult appendResult,
        boolean reconciled
    ) {
        static Observation canonical(MiningWorkspaceStore.AppendResult appendResult) {
            return new Observation(appendResult, false);
        }

        static Observation reconciled(MiningWorkspaceStore.AppendResult appendResult) {
            return new Observation(appendResult, true);
        }

        boolean extended() {
            return reconciled
                || appendResult == MiningWorkspaceStore.AppendResult.APPENDED
                || appendResult == MiningWorkspaceStore.AppendResult.LOOP_TRUNCATED;
        }

        String resultName() {
            return reconciled
                ? "reconciled"
                : appendResult.name().toLowerCase(Locale.ROOT);
        }
    }
}
