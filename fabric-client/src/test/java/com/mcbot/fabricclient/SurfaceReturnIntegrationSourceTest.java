package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * Pins the client-side authority boundary between canonical mission surface returns and the
 * historical return-staircase implementations. These checks intentionally inspect integration
 * ordering that is difficult to exercise without a live Minecraft client.
 */
class SurfaceReturnIntegrationSourceTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java"
    );

    @Test
    void canonicalSurfaceReturnIsGatedByExactActionAndMissionReason() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String predicate = method(source, "private static boolean isMissionSurfaceReturn(");
        String dispatcher = method(source, "private ControlDecision resolveReturnStaircaseControl(");

        assertTrue(predicate.contains("\"return_staircase\".equals(intent.action())"));
        assertTrue(predicate.contains("\"mission:GATHER_WOOD\".equals(intent.reason())"));
        assertTrue(dispatcher.contains(
            "if (isMissionSurfaceReturn(effective)) {\n"
                + "            return resolveMissionSurfaceReturnControl(client, player, effective, nowMs);\n"
                + "        }"
        ));
        assertTrue(dispatcher.indexOf("isMissionSurfaceReturn(effective)")
            < dispatcher.indexOf("directReturnPathForCommand("));
    }

    @Test
    void canonicalTrailSelectionPrecedesAllLegacyPathDiagnostics() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String mission = method(source, "private ControlDecision resolveMissionSurfaceReturnControl(");

        int selection = mission.indexOf("surfaceReturnTrailStore.selectReturnRoute(");
        int legacyTail = mission.indexOf("lastCompletedDescentPath");
        int legacyCoverage = mission.indexOf("returnPathCoversStart(lastCompletedDescentPath");

        assertTrue(selection >= 0);
        assertTrue(legacyTail > selection);
        assertTrue(legacyCoverage > selection);
        assertTrue(mission.contains("source=canonical_surface_trail"));
        assertFalse(mission.contains("returnPath = lastCompletedDescentPath"));
        assertFalse(mission.contains("retraceTrailBetween("));
        assertFalse(mission.contains("trajectoryTrail"));
    }

    @Test
    void oneFallbackHandoffPreservesTheOriginalAbsoluteDeadline() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String mission = method(source, "private ControlDecision resolveMissionSurfaceReturnControl(");
        String handoff = method(
            source,
            "private void beginMissionSurfaceReturnHandoff(\n"
                + "        MinecraftClient client,\n"
                + "        ReturnStaircaseRun run,\n"
                + "        BrainLink.Intent effective,\n"
                + "        ClientPlayerEntity player,\n"
                + "        long nowMs,\n"
                + "        String reason,\n"
                + "        ReturnStaircaseTraversalController.Step failedStep"
        );
        String run = nestedClass(source, "private static final class ReturnStaircaseRun");

        assertTrue(mission.contains("nowMs + timeoutMs"));
        assertTrue(mission.contains("if (nowMs >= run.hardDeadlineAtMs)"));
        assertTrue(mission.indexOf("if (nowMs >= run.hardDeadlineAtMs)")
            < mission.indexOf("if (run.fallbackActive)"));
        assertTrue(handoff.contains("run == null || run.fallbackHandoffCount > 0"));
        assertTrue(handoff.contains("run.fallbackHandoffCount = 1"));
        assertTrue(handoff.contains("run.fallbackActive = true"));
        assertTrue(handoff.contains("isSafeMissionSurfaceReturnCell(client, actualFeet)"));
        assertTrue(handoff.contains("missionSurfaceReturnFallbackAscentCommitEligible("));
        assertTrue(handoff.contains("run.fallbackAscentCommitted = true"));
        String normalizedHandoff = handoff.replaceAll("\\s+", " ");
        assertTrue(normalizedHandoff.contains(
            "if (missionSurfaceReturnFallbackAscentCommitEligible( reason, player.isOnGround(), "
                + "!player.isTouchingWater(), actualFeet, failedOrigin, safeActualFeet )) {"
        ));
        assertTrue(normalizedHandoff.indexOf("if (missionSurfaceReturnFallbackAscentCommitEligible(")
            < normalizedHandoff.indexOf("run.fallbackAscentCommitted = true"));
        assertTrue(handoff.indexOf("run.traversal.activeWaypoint()")
            < handoff.indexOf("run.traversal.clear()"));
        assertTrue(handoff.indexOf("run.traversal.waypointIndex()")
            < handoff.indexOf("run.traversal.clear()"));
        assertTrue(handoff.contains("activeWaypoint={} routeLength={} waypointIndex={}"));
        assertTrue(handoff.contains("run.hardDeadlineAtMs - nowMs"));
        assertFalse(handoff.contains("run.hardDeadlineAtMs ="));
        assertFalse(handoff.contains("run.startedAtMs ="));
        String eligibility = method(
            source,
            "private static boolean missionSurfaceReturnHandoffEligible("
        );
        assertTrue(eligibility.contains("reason.equals(\"step_up_missed\")"));
        assertTrue(run.contains("final long startedAtMs;"));
        assertTrue(run.contains("final long hardDeadlineAtMs;"));
    }

    @Test
    void successfulMissionReturnFinishesOnceAndClearsEveryOwnedState() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String complete = method(source, "private ControlDecision completeMissionSurfaceReturn(");

        int remember = complete.indexOf("finishedReturnStaircaseCommandReasons.put(run.commandId, reason)");
        int clearExecution = complete.indexOf("clearSurfaceReturnExecutionState(run)");
        int clearTrail = complete.indexOf("surfaceReturnTrailStore.clearSession()");
        int clearRun = complete.indexOf("activeReturnStaircase = null");
        int completeCommand = complete.indexOf("brainLink.completeCurrentCommand(run.commandId, reason, nowMs)");
        int stoppedDecision = complete.indexOf("return new ControlDecision(stopFrom(effective, reason), InputState.stop())");

        assertTrue(complete.contains("\"return_staircase_complete:surface_reached\""));
        assertTrue(remember >= 0);
        assertTrue(clearExecution > remember);
        assertTrue(clearTrail > clearExecution);
        assertTrue(clearRun > clearTrail);
        assertTrue(completeCommand > clearRun);
        assertTrue(stoppedDecision > completeCommand);
    }

    @Test
    void canonicalEdgeExemptionIsLimitedToCommittedDescents() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String exemption = method(source, "private static boolean isStaircaseDrivenIntent(");
        String mission = method(source, "private ControlDecision resolveMissionSurfaceReturnControl(");

        assertFalse(exemption.contains("|| \"return_staircase\".equals(action)"));
        assertTrue(exemption.contains(
            "reason.startsWith(\"return_staircase_trail\")\n"
                + "                && reason.endsWith(\"_nav3d_descend\")"
        ));
        assertTrue(mission.contains(
            "step.descentExempt()\n"
                + "            ? \"return_staircase_trail_nav3d_descend\"\n"
                + "            : \"return_staircase_trail_move\""
        ));
        assertFalse(exemption.contains("reason.equals(\"return_staircase_trail_move\")"));
    }

    @Test
    void nonMissionAndChainCallersRetainTheLegacyOverload() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String dispatcher = method(source, "private ControlDecision resolveReturnStaircaseControl(");
        String legacyOverload = methodAfter(
            source,
            "private ControlDecision resolveReturnStaircaseControl(",
            dispatcher.length()
        );
        String run = nestedClass(source, "private static final class ReturnStaircaseRun");

        assertTrue(dispatcher.contains("directReturnPathForCommand(completedDescentPaths, commandId)"));
        assertTrue(dispatcher.contains("returnPath = lastCompletedDescentPath"));
        assertTrue(dispatcher.contains("retraceTrailBetween("));
        assertTrue(dispatcher.contains(
            "resolveReturnStaircaseControl(\n"
                + "            client,\n"
                + "            player,\n"
                + "            effective,\n"
                + "            nowMs,\n"
                + "            returnPath"
        ));
        assertTrue(legacyOverload.contains("List<BlockPos> returnPath"));
        assertTrue(legacyOverload.contains(
            "new ReturnStaircaseRun(commandId, target, nowMs, player.getHealth(), returnPath)"
        ));
        assertTrue(run.contains(
            "this(commandId, target, startedAtMs, healthBefore, returnPath, false, 0L, 0L)"
        ));
    }

    @Test
    void completedSegmentsBuildPerceptionFromEveryDetourCell() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String recorder = method(source, "private void appendSurfaceReturnDescentSegment(");
        String bounds = method(source, "private static WorldVoxelPerception surfaceReturnPerceptionForCells(");

        assertTrue(recorder.contains("surfaceReturnPerceptionForCells(client.world, segment)"));
        assertTrue(bounds.contains("for (VoxelCell cell : cells)"));
        assertTrue(bounds.contains("minX = Math.min(minX, cell.x())"));
        assertTrue(bounds.contains("maxX = Math.max(maxX, cell.x())"));
        assertTrue(bounds.contains("minZ = Math.min(minZ, cell.z())"));
        assertTrue(bounds.contains("maxZ = Math.max(maxZ, cell.z())"));
        assertTrue(bounds.contains("minX - 2"));
        assertTrue(bounds.contains("maxY + 4"));
    }

    @Test
    void primaryDescentOwnsSessionLifecycleAndKeepsLegacyRecordingCompatible() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String gate = method(source, "private static boolean isPrimaryMissionDescent(");
        String terminal = method(source, "private static boolean isMissionTerminalStop(");
        String observer = method(source, "private void observeSurfaceReturnTrail(");
        String recorder = method(
            source,
            "public void recordCompletedDescentPath(\n        String commandId"
        );

        assertTrue(gate.contains("\"descend_staircase\".equals(intent.action())"));
        assertTrue(gate.contains("\"mission:DESCEND\".equals(intent.reason())"));
        assertTrue(terminal.contains("\"mission:done\".equals(intent.reason())"));
        assertTrue(terminal.contains("\"mission:aborted\".equals(intent.reason())"));
        assertTrue(observer.contains("if (isMissionTerminalStop(effective))"));
        assertTrue(observer.contains("clearSurfaceReturnState()"));
        assertTrue(observer.indexOf("surfaceReturnTrailStore.observeContext(")
            < observer.indexOf("surfaceReturnTrailStore.startSession("));
        assertTrue(observer.indexOf("surfaceReturnTrailStore.startSession(")
            < observer.indexOf("surfaceReturnTrailStore.appendObserved("));
        int descentSync = observer.indexOf(
            "synchronizeSurfaceReturnFrontier(\n"
                + "                client,\n"
                + "                player,\n"
                + "                effective,\n"
                + "                \"descent_command_admission_gap\""
        );
        int descentSkip = observer.indexOf("|| \"descend_staircase\".equals(effective.action())");
        assertTrue(descentSync >= 0);
        assertTrue(descentSkip > descentSync);
        assertTrue(observer.contains("surfaceReturnLastDescentCommandId = descentCommandId"));
        assertTrue(recorder.indexOf("completedDescentPaths.put(commandId, List.copyOf(path))")
            < recorder.indexOf("appendSurfaceReturnDescentSegment("));
        assertTrue(recorder.indexOf("lastCompletedDescentPath = List.copyOf(path)")
            < recorder.indexOf("appendSurfaceReturnDescentSegment("));
    }

    @Test
    void delayedSessionAdmissionUsesTheAnchorFromTheRequestThatStartedDescent() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String tick = method(source, "private void onClientTick(");
        String observer = method(source, "private void observeSurfaceReturnTrail(");
        String admissionDescent = method(source, "private static boolean isMissionSurfaceDescent(");

        assertTrue(admissionDescent.contains("\"mission:DESCEND\".equals(intent.reason())"));
        assertTrue(admissionDescent.contains("\"mission:DESCEND_RECOVERY\".equals(intent.reason())"));

        int snapshotCandidate = tick.indexOf("snapshotStableAnchor = voxelFeet(player)");
        int poll = tick.indexOf("brainLink.poll(snapshotJson, nowMs)");
        int observerCall = tick.indexOf("observeSurfaceReturnTrail(client, player, effective, nowMs)");
        int dispatchedReadback = tick.indexOf(
            "brainDiagnostics.dispatchedRequestCount() > dispatchedRequestsBeforePoll"
        );
        int rememberDispatched = tick.indexOf(
            "surfaceReturnLastDispatchedStableAnchor = snapshotStableAnchor"
        );
        assertTrue(snapshotCandidate >= 0);
        assertTrue(poll > snapshotCandidate);
        assertTrue(observerCall > poll);
        assertTrue(dispatchedReadback > observerCall);
        assertTrue(rememberDispatched > dispatchedReadback);

        int freezeRoot = observer.indexOf("surfaceReturnExcursionRootCommandId.isEmpty()");
        int freezeAnchor = observer.indexOf(
            "surfaceReturnRequestedAnchor = surfaceReturnLastDispatchedStableAnchor"
        );
        int start = observer.indexOf("surfaceReturnTrailStore.startSession(");
        assertTrue(freezeRoot >= 0);
        assertTrue(freezeAnchor > freezeRoot);
        assertTrue(observer.substring(freezeRoot, freezeAnchor).contains(
            "surfaceReturnLastDispatchedStableAnchor != null"
        ));
        assertTrue(start >= 0);
        assertTrue(start > freezeAnchor);
        assertTrue(observer.contains("surfaceReturnRequestedAnchor;"));
        assertTrue(observer.contains("surfaceReturnExcursionRootCommandId,"));
        assertTrue(observer.contains("requestedAnchor,"));
        assertFalse(observer.contains(
            "surfaceReturnTrailStore.startSession(\n"
                + "                effective.commandId(),\n"
                + "                feet,"
        ));

        int death = source.indexOf("if (player.getHealth() <= 0.0F || player.isDead())");
        String deathBlock = balancedBlock(source, death);
        assertTrue(deathBlock.contains("clearSurfaceReturnState()"));
    }

    @Test
    void failedDescentPreservesOnlyItsCanonicalVerifiedPrefix() throws IOException {
        String client = Files.readString(CLIENT_SOURCE);
        String descent = Files.readString(Path.of(
            "src", "main", "java", "com", "mcbot", "fabricclient", "DescentExecutor.java"
        ));
        String partial = method(client, "public void recordPartialDescentPath(");
        String failed = method(descent, "private ControlDecision failDescent(");

        assertTrue(failed.contains("shell.recordPartialDescentPath(run.commandId, run.reachedFeet)"));
        assertTrue(partial.contains("appendSurfaceReturnDescentSegment(commandId, path, \"partial\")"));
        assertFalse(partial.contains("completedDescentPaths.put("));
        assertFalse(partial.contains("lastCompletedDescentPath ="));
    }

    @Test
    void replacingAnActiveDescentPreservesItsVerifiedPrefixBeforeReset() throws IOException {
        String descent = Files.readString(Path.of(
            "src", "main", "java", "com", "mcbot", "fabricclient", "DescentExecutor.java"
        ));
        String resolve = method(descent, "public ControlDecision resolve(");

        int replacement = resolve.indexOf(
            "if (activeRun == null || !commandId.equals(activeRun.commandId))"
        );
        int preserve = resolve.indexOf(
            "shell.recordPartialDescentPath(activeRun.commandId, activeRun.reachedFeet)",
            replacement
        );
        int clearProbe = resolve.indexOf("clearPostBreakProbe(activeRun)", replacement);
        int replace = resolve.indexOf("activeRun = new DescentRun(", replacement);

        assertTrue(replacement >= 0);
        assertTrue(preserve > replacement);
        assertTrue(clearProbe > preserve);
        assertTrue(replace > clearProbe);
    }

    @Test
    void replacementFlushCannotCrossASurfaceExcursionSessionBoundary() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String observer = method(source, "private void observeSurfaceReturnTrail(");
        String recorder = method(source, "private void appendSurfaceReturnDescentSegment(");

        int admit = observer.indexOf("surfaceReturnTrailStore.admitDescentCommand(descentCommandId)");
        int synchronize = observer.indexOf("synchronizeSurfaceReturnFrontier(", admit);
        assertTrue(admit >= 0);
        assertTrue(synchronize > admit);

        int ownership = recorder.indexOf("surfaceReturnTrailStore.ownsDescentCommand(commandId)");
        int perception = recorder.indexOf("surfaceReturnPerceptionForCells(client.world, segment)");
        assertTrue(ownership >= 0);
        assertTrue(perception > ownership);
    }

    @Test
    void terminalWorkspaceTraversalIsMergedBeforeCompletedDescentRecording() throws IOException {
        String descent = Files.readString(Path.of(
            "src", "main", "java", "com", "mcbot", "fabricclient", "DescentExecutor.java"
        ));
        String workspace = Files.readString(Path.of(
            "src", "main", "java", "com", "mcbot", "fabricclient", "MiningWorkspaceController.java"
        ));
        String resolver = method(descent, "private ControlDecision resolveMiningWorkspace(");
        String complete = method(descent, "private ControlDecision completeDescent(");
        String workspaceResolve = method(workspace, "Outcome resolve(");
        String readyRoute = method(workspace, "List<VoxelCell> readyRouteFor(");

        assertTrue(resolver.contains("if (workspace.ready())"));
        assertTrue(resolver.contains("miningWorkspaceController.readyRouteFor(run.commandId)"));
        assertTrue(resolver.contains("run.reachedFeet.addAll(merged)"));
        assertTrue(complete.contains("shell.recordCompletedDescentPath("));
        assertTrue(complete.contains("run.reachedFeet"));
        assertTrue(complete.contains("run.direction"));
        assertTrue(complete.contains("run.objectiveReason"));
        assertTrue(workspaceResolve.indexOf("observeVerifiedTraversal(client, player, descentTrail)")
            < workspaceResolve.indexOf("if (run.phase == Phase.PLAN)"));
        assertTrue(readyRoute.contains("active.ready"));
        assertTrue(readyRoute.contains("return active.plan.route()"));
    }

    @Test
    void exactFrontierCanRestoreAvailabilityAndDeviationGetsOneHandoff() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String sync = method(source, "private void synchronizeSurfaceReturnFrontier(");
        String eligible = method(source, "private static boolean missionSurfaceReturnHandoffEligible(");

        assertFalse(sync.contains("current.equals(frontier)"));
        assertTrue(sync.contains("surfaceReturnTrailStore.appendObserved("));
        assertTrue(eligible.contains("reason.equals(\"route_deviation\")"));
    }

    @Test
    void terminalSnapshotCarriesTheAcknowledgedCommandThroughExistingContextField() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        int completed = source.indexOf(
            "String snapshotCommandContextId = currentCommandCompleted && priorIntent != null"
        );
        int snapshot = source.indexOf("ClientSnapshot snapshot = ClientSnapshot.from(", completed);
        String construction = source.substring(completed, source.indexOf("snapshotJson = GSON.toJson(snapshot)", snapshot));

        assertTrue(completed >= 0);
        assertTrue(construction.contains("? priorIntent.commandId()"));
        assertTrue(construction.contains(": activeNavigationCommandId"));
        assertTrue(construction.contains("snapshotCommandContextId,"));
    }

    @Test
    void arrivalAndEveryTerminalPathClearTheCanonicalController() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String mission = method(source, "private ControlDecision resolveMissionSurfaceReturnControl(");
        String failure = method(source, "private ControlDecision failReturnStaircase(");
        String cleanup = method(source, "private void clearSurfaceReturnExecutionState(");
        String observer = method(source, "private void observeSurfaceReturnTrail(");

        int finish = mission.indexOf("surfaceReturnTrailStore.finishAtAnchor(");
        int complete = mission.indexOf("completeMissionSurfaceReturn(effective, run, player, nowMs)", finish);
        assertTrue(finish >= 0);
        assertTrue(mission.contains("run.surfaceTrailSessionRevision"));
        assertTrue(mission.contains("voxelFeet(player)"));
        assertTrue(mission.contains("player.isOnGround()"));
        assertTrue(complete > finish);
        int handoffOutcome = mission.indexOf(
            "if (step.outcome() == ReturnStaircaseTraversalController.Outcome.HANDOFF_REQUIRED)",
            complete
        );
        String finishFailureTail = mission.substring(complete, handoffOutcome);
        assertTrue(finishFailureTail.contains("return failReturnStaircase("));
        assertFalse(finishFailureTail.contains("beginMissionSurfaceReturnHandoff("));
        assertTrue(mission.contains("return failReturnStaircase("));
        assertTrue(mission.contains("\"missing_target\""));
        assertTrue(failure.contains("clearSurfaceReturnExecutionState(run)"));
        assertTrue(cleanup.contains("run.traversal.clear()"));
        assertTrue(cleanup.contains("clearNavigationState()"));
        assertTrue(cleanup.contains("clearNav3dDriveState()"));
        assertTrue(observer.contains("!activeReturnStaircase.commandId.equals(effective.commandId())"));
        assertTrue(observer.contains("clearSurfaceReturnExecutionState(activeReturnStaircase)"));
    }

    @Test
    void transitionEventsUseHarnessConsumedMonotonicIndexNames() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String logger = method(source, "private void logMissionSurfaceReturnStep(");

        assertTrue(logger.contains("waypointIndex={}"));
        assertTrue(logger.contains("maximumWaypointIndex={}"));
        assertFalse(logger.contains("cursorIndex={}"));
        assertFalse(logger.contains("maximumIndex={}"));
        assertTrue(logger.contains("source=canonical_surface_trail anchor={} currentCell={} routeLength={}"));
        assertTrue(logger.contains("progressAgeMs={}"));
        assertTrue(logger.contains("endpointCoverage=true"));
    }

    @Test
    void contextChangesAndInvalidRunsCompleteWithoutLaunchingFallback() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String observer = method(source, "private void observeSurfaceReturnTrail(");
        String mission = method(source, "private ControlDecision resolveMissionSurfaceReturnControl(");
        String noRunFailure = method(source, "private ControlDecision failMissionSurfaceReturnWithoutRun(");

        assertTrue(observer.contains("surfaceReturnContextChangedThisTick = contextChanged"));
        int contextGuard = mission.indexOf("if (surfaceReturnContextChangedThisTick)");
        int routeSelection = mission.indexOf("surfaceReturnTrailStore.selectReturnRoute(");
        assertTrue(contextGuard >= 0);
        assertTrue(routeSelection > contextGuard);
        assertTrue(mission.contains("\"world_or_dimension_changed\""));
        assertTrue(mission.contains("failMissionSurfaceReturnWithoutRun(effective, player, nowMs, \"run_state_invalid\")"));
        assertTrue(noRunFailure.contains("finishedReturnStaircaseCommandReasons.put(commandId, completionReason)"));
        assertTrue(noRunFailure.contains("brainLink.completeCurrentCommand(commandId, completionReason, nowMs)"));
        assertFalse(noRunFailure.contains("beginMissionSurfaceReturnHandoff("));
    }

    @Test
    void directFallbackStagesHorizontallyBeforeExactAnchorAscent() throws IOException {
        StaircaseDescentPlanner.Direction2d north =
            new StaircaseDescentPlanner.Direction2d(0, -1, "north");
        BlockPos finalOrigin = new BlockPos(322, 75, 322);
        BlockPos finalLanding = new BlockPos(322, 76, 321);
        assertTrue(McbotFabricClient.missionSurfaceReturnCommittedAscentActive(
            north, finalOrigin, finalLanding));
        assertFalse(McbotFabricClient.missionSurfaceReturnCommittedAscentActive(
            null, finalOrigin, finalLanding));
        assertFalse(McbotFabricClient.missionSurfaceReturnCommittedAscentActive(
            north, null, finalLanding));
        assertFalse(McbotFabricClient.missionSurfaceReturnCommittedAscentActive(
            north, finalOrigin, null));

        assertTrue(McbotFabricClient.missionSurfaceReturnNeedsHorizontalStage(
            new VoxelCell(300, 16, 369),
            new VoxelCell(300, 76, 300)
        ));
        assertFalse(McbotFabricClient.missionSurfaceReturnNeedsHorizontalStage(
            new VoxelCell(300, 16, 360),
            new VoxelCell(300, 76, 300)
        ));
        assertTrue(McbotFabricClient.missionSurfaceReturnNeedsHorizontalStage(
            new VoxelCell(300, 17, 360),
            new VoxelCell(300, 76, 300)
        ));

        String source = Files.readString(CLIENT_SOURCE);
        String mission = method(source, "private ControlDecision resolveMissionSurfaceReturnControl(");
        String fallback = method(source, "private ControlDecision resolveMissionSurfaceReturnFallbackControl(");
        String clearAscent = method(source, "private static void clearReturnAscendStep(");
        assertTrue(mission.contains("resolveMissionSurfaceReturnFallbackControl("));
        assertTrue(fallback.contains(
            "missionSurfaceReturnShouldStage(feet, anchor, run.fallbackAscentCommitted)"
        ));
        assertTrue(fallback.contains("selectMissionSurfaceReturnStageCell(client, feet, anchor)"));
        assertTrue(fallback.contains("return_ascend_anchor_overshot"));
        assertTrue(fallback.contains("resolveReturnAscendControl(client, player, effective, run, target, nowMs)"));
        int overshoot = fallback.indexOf("if (feet.y() > anchor.y())");
        int committedAscent = fallback.indexOf("if (missionSurfaceReturnCommittedAscentActive(");
        int activeLevelStage = fallback.indexOf("if (run.fallbackLevelTarget != null)");
        int newLevelStage = fallback.indexOf("if (missionSurfaceReturnShouldStage(");
        assertTrue(overshoot >= 0 && committedAscent > overshoot);
        assertTrue(activeLevelStage > committedAscent);
        assertTrue(newLevelStage > committedAscent);
        assertTrue(fallback.substring(committedAscent, activeLevelStage).contains(
            "return resolveReturnAscendControl(client, player, effective, run, target, nowMs);"
        ));
        assertTrue(clearAscent.contains("run.ascendDirection = null;"));
        assertTrue(clearAscent.contains("run.ascendStepAnchor = null;"));
        assertTrue(clearAscent.contains("run.ascendExpectedLanding = null;"));
    }

    @Test
    void directFallbackCommitsAscentBetweenInitialAndTerminalLevelStaging() {
        VoxelCell anchor = new VoxelCell(300, 76, 300);
        VoxelCell initial = new VoxelCell(300, 16, 369);
        VoxelCell midAscentReroute = new VoxelCell(294, 17, 354);
        VoxelCell terminalOffset = new VoxelCell(294, 76, 354);

        assertTrue(McbotFabricClient.missionSurfaceReturnShouldStage(initial, anchor, false));
        assertFalse(McbotFabricClient.missionSurfaceReturnShouldStage(midAscentReroute, anchor, true));
        assertTrue(McbotFabricClient.missionSurfaceReturnShouldStage(terminalOffset, anchor, true));
        assertFalse(McbotFabricClient.missionSurfaceReturnShouldStage(anchor, anchor, true));

        VoxelCell failedOrigin = new VoxelCell(294, 16, 354);
        assertTrue(McbotFabricClient.missionSurfaceReturnFallbackAscentCommitEligible(
            "step_up_missed", true, true, failedOrigin, failedOrigin, true));
        assertFalse(McbotFabricClient.missionSurfaceReturnFallbackAscentCommitEligible(
            "step_up_missed", true, true, new VoxelCell(294, 16, 355), failedOrigin, true));
        assertFalse(McbotFabricClient.missionSurfaceReturnFallbackAscentCommitEligible(
            "step_up_missed", true, false, failedOrigin, failedOrigin, true));
        assertFalse(McbotFabricClient.missionSurfaceReturnFallbackAscentCommitEligible(
            "step_up_missed", false, true, failedOrigin, failedOrigin, true));
        assertFalse(McbotFabricClient.missionSurfaceReturnFallbackAscentCommitEligible(
            "step_up_missed", true, true, failedOrigin, failedOrigin, false));
        assertFalse(McbotFabricClient.missionSurfaceReturnFallbackAscentCommitEligible(
            "step_up_missed", true, true, null, failedOrigin, true));
        assertFalse(McbotFabricClient.missionSurfaceReturnFallbackAscentCommitEligible(
            "route_invalidated", true, true, failedOrigin, failedOrigin, true));

        BlockPos rejectedAnchor = new BlockPos(339, 42, 338);
        StaircaseDescentPlanner.Direction2d west =
            new StaircaseDescentPlanner.Direction2d(-1, 0, "west");
        StaircaseDescentPlanner.Direction2d north =
            new StaircaseDescentPlanner.Direction2d(0, -1, "north");
        assertTrue(McbotFabricClient.returnAscendDirectionExcluded(
            rejectedAnchor, Set.of("west"), rejectedAnchor, west));
        assertFalse(McbotFabricClient.returnAscendDirectionExcluded(
            rejectedAnchor, Set.of("west"), rejectedAnchor, north));
        assertFalse(McbotFabricClient.returnAscendDirectionExcluded(
            rejectedAnchor, Set.of("west"), rejectedAnchor.east(), west));
        assertFalse(McbotFabricClient.returnAscendDirectionExcluded(
            rejectedAnchor, Set.of(), rejectedAnchor, west));
    }

    @Test
    void directFallbackRequiresExactDryStableLandingAndSettlesOneTickTransient() throws IOException {
        BlockPos expected = new BlockPos(293, 17, 354);
        BlockPos originColumnBob = new BlockPos(294, 17, 354);

        assertFalse(McbotFabricClient.returnAscendLandingEligible(
            expected, originColumnBob, true, true, true));
        assertFalse(McbotFabricClient.returnAscendLandingEligible(
            expected, expected, false, true, true));
        assertFalse(McbotFabricClient.returnAscendLandingEligible(
            expected, expected, true, false, true));
        assertFalse(McbotFabricClient.returnAscendLandingEligible(
            expected, expected, true, true, false));
        assertTrue(McbotFabricClient.returnAscendLandingEligible(
            expected, expected, true, true, true));
        assertTrue(McbotFabricClient.isReturnAscendOriginColumnTransient(
            new BlockPos(294, 16, 354), expected, originColumnBob));
        assertFalse(McbotFabricClient.isReturnAscendOriginColumnTransient(
            new BlockPos(294, 16, 354), expected, new BlockPos(294, 16, 354)));
        assertFalse(McbotFabricClient.isReturnAscendOriginColumnTransient(
            new BlockPos(294, 16, 354), expected, new BlockPos(294, 17, 355)));
        assertTrue(McbotFabricClient.returnAscendOriginColumnTransientEligible(
            new BlockPos(294, 16, 354), expected, originColumnBob,
            true, true, false, true, true));
        assertFalse(McbotFabricClient.returnAscendOriginColumnTransientEligible(
            new BlockPos(294, 16, 354), expected, originColumnBob,
            true, false, false, true, true));
        assertFalse(McbotFabricClient.returnAscendOriginColumnTransientEligible(
            new BlockPos(294, 16, 354), expected, originColumnBob,
            true, true, true, true, true));
        assertFalse(McbotFabricClient.returnAscendOriginColumnTransientEligible(
            new BlockPos(294, 16, 354), expected, originColumnBob,
            true, true, false, false, true));
        assertFalse(McbotFabricClient.returnAscendOriginColumnTransientEligible(
            new BlockPos(294, 16, 354), expected, originColumnBob,
            true, true, false, true, false));

        String source = Files.readString(CLIENT_SOURCE);
        String ascend = method(source, "private ControlDecision resolveReturnAscendControl(");
        String committed = method(source, "private ControlDecision committedReturnAscendMovement(");
        String traversalTick = method(
            source,
            "private ReturnStaircaseTraversalController.Step tickMissionSurfaceReturnTraversal("
        );
        String run = nestedClass(source, "private static final class ReturnStaircaseRun");
        String normalizedAscend = ascend.replaceAll("\\s+", " ");
        String normalizedTraversalTick = traversalTick.replaceAll("\\s+", " ");

        assertTrue(ascend.contains("run.ascendLandingStablePolls < 2"));
        assertTrue(ascend.contains("feet.equals(run.ascendStepAnchor) && dryStableCell"));
        assertTrue(ascend.indexOf("if (player.isTouchingWater())")
            < ascend.indexOf("returnAscendOriginColumnTransientEligible("));
        assertTrue(ascend.indexOf("run.ascendDepartureObserved && !frozenLandingSafe")
            < ascend.indexOf("returnAscendOriginColumnTransientEligible("));
        assertTrue(ascend.indexOf("returnAscendOriginColumnTransientEligible(")
            < ascend.indexOf("exactLanding || !dryStableCell"));
        assertTrue(ascend.contains("isSafeReturnAscendTransientBody(client, feet)"));
        assertTrue(normalizedAscend.contains(
            "if (returnAscendOriginColumnTransientEligible( run.ascendStepAnchor, "
                + "run.ascendExpectedLanding, feet, player.isOnGround(), !player.isTouchingWater(), "
                + "dryStableCell, frozenLandingSafe, isSafeReturnAscendTransientBody(client, feet) )) {"
        ));
        assertTrue(normalizedTraversalTick.contains(
            "boolean lipTransientSafe = !stable "
                + "&& isSafeReturnAscendTransientBody(client, blockPos(feet));"
        ));
        assertTrue(normalizedTraversalTick.contains(
            "stable, aligned, lipTransientSafe );"
        ));
        assertTrue(normalizedAscend.indexOf("synchronizeReturnAscendDirectionExclusions(run, feet)")
            < normalizedAscend.indexOf("for (StaircaseDescentPlanner.Direction2d candidate"));
        assertTrue(normalizedAscend.contains(
            "run.missionCanonical && returnAscendDirectionExcluded( "
                + "run.ascendExcludedDirectionAnchor, run.ascendExcludedDirections, feet, candidate )"
        ));
        assertTrue(normalizedAscend.contains(
            "\"raycast_unbreakable_occluder\".equals(result.reason())"
        ));
        assertTrue(normalizedAscend.contains("run.ascendExcludedDirections.add(dir.name())"));
        assertTrue(ascend.contains("committedReturnAscendMovement(player, effective, run, true)"));
        assertTrue(ascend.contains("committedReturnAscendMovement(player, effective, run, false)"));
        assertTrue(ascend.contains("\"return_ascend_off_target_landing\""));
        assertTrue(committed.contains("new InputState(true, false, false, false, jump, false"));
        assertTrue(run.contains("BlockPos ascendExpectedLanding = null;"));
        assertTrue(run.contains("BlockPos ascendOffTargetLandingCell = null;"));
    }

    @Test
    void strictFallbackLandingIsLimitedToCanonicalMissionReturns() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String ascend = method(source, "private ControlDecision resolveReturnAscendControl(");
        String legacy = method(source, "private ControlDecision resolveLegacyReturnAscendControl(");

        assertTrue(ascend.contains("if (!run.missionCanonical)"));
        assertTrue(ascend.contains("return resolveLegacyReturnAscendControl("));
        assertTrue(legacy.contains("feet.getY() > run.ascendStepAnchor.getY()"));
        assertTrue(legacy.contains("new InputState(\n            true,"));
        assertFalse(legacy.contains("ascendExpectedLanding"));
        assertFalse(legacy.contains("returnAscendLandingEligible"));
    }

    @Test
    void activeSuffixRepairRunsBeforeTraversalTickAndPreservesTheExistingHandoff() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String mission = method(source, "private ControlDecision resolveMissionSurfaceReturnControl(");
        String repair = method(
            source,
            "private ControlDecision resolveMissionSurfaceReturnRouteSuffixRepair("
        );
        String run = nestedClass(source, "private static final class ReturnStaircaseRun");

        int repairCall = mission.indexOf("resolveMissionSurfaceReturnRouteSuffixRepair(");
        int traversalTick = mission.indexOf("tickMissionSurfaceReturnTraversal(");
        assertTrue(repairCall >= 0);
        assertTrue(traversalTick > repairCall);
        assertTrue(repair.contains("run.traversal.routeSnapshot()"));
        assertTrue(repair.contains("run.traversal.routeSuffixRepairEligible(snapshot, nowMs)"));
        assertTrue(repair.contains("!player.isOnGround()"));
        assertTrue(repair.contains("player.isTouchingWater()"));
        assertTrue(repair.contains("feet.equals(snapshot.stableFeet())"));
        assertTrue(repair.contains("isSafeMissionSurfaceReturnCell(client, feet)"));
        assertTrue(repair.contains("run.routeSuffixRepairAttempted = true"));
        assertTrue(repair.contains("SurfaceReturnRouteSuffixPlanner.plan("));
        assertTrue(repair.contains("SurfaceReturnRouteSuffixRepair.apply("));
        assertTrue(repair.contains("handoffMissionSurfaceReturnAfterSuffixRejection("));
        assertTrue(repair.contains("InputState.stop()"));
        assertTrue(run.contains("boolean routeSuffixRepairAttempted = false;"));
        assertTrue(run.contains("long surfaceTrailRevision;"));
        assertTrue(run.contains("List<VoxelCell> canonicalSurfaceTrail;"));
    }

    @Test
    void knownBrokenCanonicalRouteIsSuppressedBeforeControllerLaunch() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String mission = method(source, "private ControlDecision resolveMissionSurfaceReturnControl(");

        int admission = mission.indexOf("surfaceReturnRouteSuffixState.admission(");
        int begin = mission.indexOf("run.traversal.begin(");
        assertTrue(admission >= 0);
        assertTrue(begin > admission);
        assertTrue(mission.contains(
            "suffixAdmission == SurfaceReturnRouteSuffixState.Admission.AVAILABLE"
        ));
        assertTrue(mission.contains(
            "suffixAdmission == SurfaceReturnRouteSuffixState.Admission.KNOWN_BROKEN"
        ));
        assertTrue(mission.contains("\"known_broken_prelaunch\""));
        assertTrue(mission.contains("beginMissionSurfaceReturnHandoff("));
    }

    @Test
    void suffixTelemetryAndCleanupExposeTheBoundedAtomicContract() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String logger = method(source, "private void logMissionSurfaceReturnRouteSuffix(");
        String clear = method(source, "private void clearSurfaceReturnState(");
        String complete = method(source, "private ControlDecision completeMissionSurfaceReturn(");

        assertTrue(logger.contains("return_staircase.traversal.route_suffix_"));
        assertTrue(logger.contains("trailRevisionBefore={}"));
        assertTrue(logger.contains("trailRevisionAfter={}"));
        assertTrue(logger.contains("source={}"));
        assertTrue(logger.contains("invalidWaypoint={}"));
        assertTrue(logger.contains("invalidWaypointIndex={}"));
        assertTrue(logger.contains("rejoinWaypointIndex={}"));
        assertTrue(logger.contains("connectorLength={}"));
        assertTrue(logger.contains("expandedCells={}"));
        assertTrue(logger.contains("computationAttempted={}"));
        assertTrue(logger.contains("admissionResult={}"));
        assertTrue(logger.contains("storeResult={}"));
        assertFalse(logger.contains("route={}"));
        assertTrue(clear.contains("synchronizeSurfaceReturnRouteSuffixState()"));
        assertTrue(complete.contains("synchronizeSurfaceReturnRouteSuffixState()"));
    }

    @Test
    void canonicalReturnTreatsProtectedSupportAsImpassable() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String safeCell = method(source, "private boolean isSafeMissionSurfaceReturnCell(");
        String repair = method(
            source,
            "private ControlDecision resolveMissionSurfaceReturnRouteSuffixRepair("
        );

        assertTrue(safeCell.contains("client.world.getBlockState(feet.down())"));
        assertTrue(safeCell.contains("client.world.getBlockState(feet)"));
        assertTrue(safeCell.contains("client.world.getBlockState(feet.up())"));
        assertTrue(repair.contains("cell -> isProtectedReturnObstruction("));
    }

    @Test
    void surfaceReturnEdgeLookaheadClampsOnlyValidatedSameLevelCanonicalSteps() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String dispatch = method(source, "private double edgeGuardLookaheadForIntent(");
        String clamp = method(source, "private double surfaceReturnEdgeGuardLookahead(");

        assertTrue(dispatch.contains("surfaceReturnEdgeGuardLookahead(client, player, intent)"));
        assertTrue(clamp.contains("!run.missionCanonical"));
        assertTrue(clamp.contains("run.fallbackActive"));
        assertTrue(clamp.contains("\"return_staircase_trail_move\".equals(intent.reason())"));
        assertTrue(clamp.contains(
            "snapshot.transitionKind() != ReturnStaircaseTraversalController.TransitionKind.NONE"
        ));
        assertTrue(clamp.contains(
            "snapshot.transitionPhase() != ReturnStaircaseTraversalController.TransitionPhase.NONE"
        ));
        assertTrue(clamp.contains("waypoint.y() != stableFeet.y()"));
        assertTrue(clamp.contains("MiningWorkspaceStore.reversible(stableFeet, waypoint)"));
        assertTrue(clamp.contains("isSafeMissionSurfaceReturnCell(client, waypoint)"));
        assertTrue(clamp.contains("MiningWorkspaceTraversal.edgeGuardLookahead("));
    }

    private static String method(String source, String signature) {
        int start = source.indexOf(signature);
        assertTrue(start >= 0, () -> "missing method: " + signature);
        return balancedBlock(source, start);
    }

    private static String methodAfter(String source, String signature, int offset) {
        int start = source.indexOf(signature, source.indexOf(signature) + offset);
        assertTrue(start >= 0, () -> "missing later method: " + signature);
        return balancedBlock(source, start);
    }

    private static String nestedClass(String source, String signature) {
        int start = source.indexOf(signature);
        assertTrue(start >= 0, () -> "missing class: " + signature);
        return balancedBlock(source, start);
    }

    private static String balancedBlock(String source, int start) {
        int open = source.indexOf('{', start);
        assertTrue(open >= 0, "missing opening brace");
        int depth = 0;
        for (int i = open; i < source.length(); i++) {
            char c = source.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}' && --depth == 0) {
                return source.substring(start, i + 1);
            }
        }
        throw new AssertionError("unterminated source block");
    }
}
