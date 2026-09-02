package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * Pins the mission-only authority boundary for progressive stone acquisition. These assertions
 * intentionally cover shell integration and dispatch ordering that cannot be exercised without a
 * live {@code MinecraftClient}; the pure planner, drop ledger, and execution motor have separate
 * behavioral tests.
 */
class MissionStoneIntegrationSourceTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java"
    );
    private static final Path DESCENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "DescentExecutor.java"
    );
    private static final Path SHELL_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "ShellServices.java"
    );
    private static final Path WORKSPACE_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "MiningWorkspaceController.java"
    );

    @Test
    void missionProgressiveDispatchPrecedesAndCannotFallThroughToLegacyRaster() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String resolver = method(source, "private ControlDecision resolveMineNearbyStoneControl(");
        String progressive = method(source, "private ControlDecision resolveMissionStoneProgressiveControl(");

        int missionGate = resolver.indexOf(
            "if (inventoryRequirement.enabled() && isMissionCommandId(commandId))"
        );
        int missionReturn = resolver.indexOf("return resolveMissionStoneProgressiveControl(", missionGate);
        int legacyGroundGate = resolver.indexOf("if (!player.isOnGround())", missionReturn);
        int legacyTargetSelection = resolver.indexOf("selectVisibleStoneTarget(", missionReturn);

        assertTrue(missionGate >= 0);
        assertTrue(missionReturn > missionGate);
        assertTrue(legacyGroundGate > missionReturn);
        assertTrue(legacyTargetSelection > missionReturn);
        assertFalse(progressive.contains("selectVisibleStoneTarget("));
        assertFalse(progressive.contains("selectMineNearbyStoneProbeTarget("));
        assertFalse(progressive.contains("startMineNearbyStoneDescentFallback("));
        assertFalse(progressive.contains("mine_nearby_stone.ring_selected"));
    }

    @Test
    void absoluteRequirementCannotCaptureHistoricalFixedDeltaCommands() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String resolver = method(source, "private ControlDecision resolveMineNearbyStoneControl(");
        String preReflex = method(source, "private void enforceMineNearbyStoneCompletionBeforeReflex(");

        assertTrue(resolver.contains(
            "isMissionCommandId(commandId)\n"
                + "                    ? effective.completionInventoryCobblestoneCount()\n"
                + "                    : null"
        ));
        assertTrue(preReflex.contains(
            "isMissionCommandId(commandId)\n"
                + "                    ? effective.completionInventoryCobblestoneCount()\n"
                + "                    : null"
        ));
        assertTrue(resolver.contains(
            "if (!inventoryRequirement.enabled() && delta >= NEARBY_STONE_TARGET_COBBLESTONE)"
        ));
        assertTrue(resolver.indexOf("resolveMissionStoneProgressiveControl(")
            < resolver.indexOf("selectVisibleStoneTarget("));
    }

    @Test
    void fixtureEventsMatchTheExactProgressiveChronologyContract() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String progressive = method(source, "private ControlDecision resolveMissionStoneProgressiveControl(");
        String apply = method(source, "private ControlDecision applyMissionStoneExecutionDecision(");
        String production = method(source, "private void recordMissionStoneProduction(");
        String planComplete = method(source, "private void emitMissionStonePlanComplete(");
        String preReflex = method(source, "private void enforceMineNearbyStoneCompletionBeforeReflex(");
        String dropReconciliation = method(source, "private void reconcileMissionStoneDropInventory(");
        String ownedDropReconciliation = method(
            source, "private boolean reconcileMineNearbyStoneOwnedDropInventory(");

        assertTrue(progressive.contains("mine_nearby_stone.method.selected"));
        assertTrue(progressive.contains("mine_nearby_stone.method.rejected"));
        assertTrue(dropReconciliation.contains("mine_nearby_stone.batch_drop.recovered"));
        assertTrue(apply.contains("mine_nearby_stone.progressive_staircase.step_landed"));
        assertTrue(production.contains("mine_nearby_stone.progressive_staircase.block_cleared"));
        assertTrue(production.contains("mine_nearby_stone.face_harvest.block_cleared"));
        assertTrue(planComplete.contains("mine_nearby_stone.progressive_staircase.complete"));
        assertTrue(planComplete.contains("mine_nearby_stone.face_harvest.complete"));
        assertTrue(preReflex.contains("mine_nearby_stone.inventory_requirement_satisfied"));
        assertTrue(preReflex.indexOf("reconcileMineNearbyStoneOwnedDropInventory(")
            < preReflex.indexOf("mine_nearby_stone.inventory_requirement_satisfied"));
        assertTrue(preReflex.indexOf("reconcileMissionStoneDropInventory(")
            < preReflex.indexOf("mine_nearby_stone.inventory_requirement_satisfied"));
        assertTrue(preReflex.indexOf("reconcileMissionStoneDropInventory(")
            < preReflex.indexOf("reconcileMineNearbyStoneOwnedDropInventory("));
        assertTrue(ownedDropReconciliation.contains(
            "OwnedDropTraversal.reached(playerFeet, run.ownedDropPickupCell)"));

        assertFalse(progressive.contains("MissionStoneDropBatch.reconcileInventory("),
            "the progressive executor must use the shared pre-completion reconciliation helper");
        assertTrue(progressive.indexOf("reconcileMissionStoneDropInventory(")
            < progressive.indexOf("observeMissionStoneDropEntities("));
        assertTrue(progressive.indexOf("observeMissionStoneDropEntities(")
            < progressive.indexOf("MissionStoneDropBatch.decide("));
        assertTrue(progressive.indexOf("MissionStoneDropBatch.decide(")
            < progressive.indexOf("planMissionStoneMethod("));
    }

    @Test
    void liveOwnedDropCannotBePrunedAfterPickupConfirmationTimesOut() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String traversal = method(
            source, "private ControlDecision resolveMineNearbyStoneOwnedDropTraversal(");
        String abandonment = method(
            source, "private ControlDecision abandonMineNearbyStoneOwnedDrop(");
        String recoveryRejection = method(
            source, "private ControlDecision rejectMissionStoneRecoveryEntity(");

        int confirmation = traversal.indexOf("OwnedDropTraversal.pickupConfirmation(");
        int boundedFailure = traversal.indexOf("failMineNearbyStone(", confirmation);
        assertTrue(confirmation >= 0);
        assertTrue(boundedFailure > confirmation);
        assertTrue(traversal.substring(confirmation, boundedFailure).contains(
            "OwnedDropTraversal.PickupConfirmation.WAIT"));
        assertTrue(traversal.contains("mission_stone_drop_pickup_unconfirmed"));
        assertFalse(traversal.contains("MissionStoneDropBatch.pruneDisappearedEntity("));

        assertLiveObservationGuardsPrune(abandonment);
        assertLiveObservationGuardsPrune(recoveryRejection);
    }

    @Test
    void progressiveLookDemandsPreserveTheTopLevelMineStoneActionAndCommand() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String look = method(source, "private BrainLink.Intent missionStoneLookIntent(");
        String apply = method(source, "private ControlDecision applyMissionStoneExecutionDecision(");

        assertTrue(look.contains("return new BrainLink.Intent("));
        assertTrue(look.contains("source.action(),"));
        assertTrue(look.contains("source.completionInventoryCobblestoneCount(),"));
        assertTrue(look.contains("source.expiresAtMs(),"));
        assertTrue(look.contains("source.commandId()"));
        assertFalse(look.contains("\"navigate\""));
        assertFalse(look.contains("\"descend_staircase\""));
        assertTrue(apply.contains("missionStoneLookIntent(effective,"));
    }

    @Test
    void edgeGuardExemptionIsNarrowlyTiedToCommittedProgressiveDescent() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String exemption = method(source, "private static boolean isStaircaseDrivenIntent(");
        String apply = method(source, "private ControlDecision applyMissionStoneExecutionDecision(");

        assertTrue(apply.contains(
            "String reason = decision.descentExempt()\n"
                + "                    ? \"mine_nearby_stone_progressive_nav3d_descend\"\n"
                + "                    : \"mine_nearby_stone_progressive_move\";"
        ));
        assertTrue(exemption.contains(
            "reason.startsWith(\"mine_nearby_stone_progressive\")\n"
                + "                && reason.endsWith(\"_nav3d_descend\")"
        ));
        assertFalse(exemption.contains("\"mine_nearby_stone\".equals(action)"));
        assertFalse(exemption.contains("reason.equals(\"mine_nearby_stone_progressive_move\")"));
    }

    @Test
    void staircaseStartsCanonicalTrailButFaceHarvestDeclinesTheExcursion() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String progressive = method(source, "private ControlDecision resolveMissionStoneProgressiveControl(");
        String beginTrail = method(source, "private boolean beginMissionStoneSurfaceTrail(");

        int staircaseGate = progressive.indexOf(
            "if (selected.method() == MissionStoneMethodPlanner.Method.STAIRCASE\n"
                + "            || selected.method() == MissionStoneMethodPlanner.Method.SAFE_DROP)"
        );
        int trailCall = progressive.indexOf("beginMissionStoneSurfaceTrail(client, player, run)");
        int facePlan = progressive.indexOf("MissionStoneExecutionController.FrozenPlan.face(");

        assertTrue(staircaseGate >= 0);
        assertTrue(trailCall > staircaseGate);
        assertTrue(facePlan > trailCall);
        assertTrue(progressive.substring(staircaseGate, facePlan).contains("beginMissionStoneSurfaceTrail("));
        assertFalse(progressive.substring(facePlan).contains("beginMissionStoneSurfaceTrail("));
        assertTrue(beginTrail.contains("surfaceReturnTrailStore.startSession("));
        assertTrue(beginTrail.contains("reason=mission_stone_staircase_admitted"));
    }

    @Test
    void safeDropOccupiesTheAggregatePlannerSlotAndHasADedicatedExecutor() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String planner = method(source, "private MissionStonePlanningResult planMissionStoneMethod(");
        String progressive = method(source, "private ControlDecision resolveMissionStoneProgressiveControl(");

        assertTrue(planner.contains(
            "MissionStoneSafeDropPackage safeDrop = missionStoneSafeDropPackage("
        ));
        assertTrue(planner.contains("safeDrop == null ? null : safeDrop.methodCandidate()"));
        assertTrue(progressive.contains(
            "if (selected.method() == MissionStoneMethodPlanner.Method.SAFE_DROP)"
        ));
        assertTrue(progressive.contains("planning.safeDropPackage()"));
        assertTrue(progressive.contains("return beginMissionStoneSafeDrop("));
        assertFalse(source.contains("safe_drop_executor_unavailable"));
    }

    @Test
    void committedSafeDropOwnsControlBeforeExecutionAndTheGroundedPlanningGate() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String progressive = method(source, "private ControlDecision resolveMissionStoneProgressiveControl(");

        int completion = progressive.indexOf(
            "batch.action() == MissionStoneDropBatch.Action.COMPLETE"
        );
        int departureGuard = progressive.indexOf(
            "!missionStoneCommittedMovementActive(run)", completion);
        int safeDrop = progressive.indexOf("if (run.missionStoneSafeDrop.active())", completion);
        int ordinaryExecution = progressive.indexOf("if (run.missionStoneExecution.active())", safeDrop);
        int groundedGate = progressive.indexOf("if (!player.isOnGround())", ordinaryExecution);

        assertTrue(completion >= 0);
        assertTrue(departureGuard > completion);
        assertTrue(safeDrop > departureGuard);
        assertTrue(ordinaryExecution > safeDrop);
        assertTrue(groundedGate > ordinaryExecution);
        assertTrue(progressive.substring(safeDrop, ordinaryExecution).contains(
            "return resolveMissionStoneSafeDropControl("
        ));
    }

    @Test
    void safeDropLaunchUsesQuarterForwardWithoutJumpSneakOrClearance() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String controller = Files.readString(Path.of(
            "src", "main", "java", "com", "mcbot", "fabricclient",
            "DescentSafeFallController.java"
        ));
        String packagePlanner = method(source, "private MissionStoneSafeDropPackage missionStoneSafeDropPackage(");
        String resolver = method(source, "private ControlDecision resolveMissionStoneSafeDropControl(");

        assertTrue(controller.contains("static final float LAUNCH_FORWARD_SCALE = 0.25F;"));
        assertTrue(packagePlanner.contains("fall.plan().fallDepth() != 1"));
        assertTrue(packagePlanner.contains("fall.plan().expectedDamage() != 0"));
        assertTrue(packagePlanner.contains("!fall.plan().clearanceCells().isEmpty()"));
        assertTrue(resolver.contains("DescentSafeFallController.ClearanceStatus.NONE"));
        assertTrue(resolver.contains(
            "revalidated.accepted() && revalidated.plan().clearanceCells().isEmpty()"
        ));

        int forwardCase = resolver.indexOf("case HOLD_FORWARD, HOLD_AIRBORNE ->");
        int landedCase = resolver.indexOf("case LANDED ->", forwardCase);
        String movement = resolver.substring(forwardCase, landedCase).replaceAll("\\s+", "");
        assertTrue(movement.contains(
            "newInputState(forward,false,false,false,false,false,"
                + "forward?DescentSafeFallController.LAUNCH_FORWARD_SCALE:0.0F,0.0F)"
        ));

        int clearCase = resolver.indexOf("case CLEAR_BLOCKER ->", landedCase);
        int rejectedCase = resolver.indexOf("case REJECTED ->", clearCase);
        assertTrue(clearCase > landedCase);
        assertTrue(rejectedCase > clearCase);
        assertTrue(resolver.substring(clearCase, rejectedCase).contains(
            "mission_stone_safe_drop_clearance_forbidden"
        ));
    }

    @Test
    void safeDropSurfaceSessionActivatesOnlyAtVerifiedLandingBeforeHarvest() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String progressive = method(source, "private ControlDecision resolveMissionStoneProgressiveControl(");
        String resolver = method(source, "private ControlDecision resolveMissionStoneSafeDropControl(");
        String landing = method(source, "private ControlDecision completeMissionStoneSafeDropLanding(");
        String cleanup = method(source, "private void clearUnactivatedMissionStoneSurfaceTrail(");

        int trailAdmission = progressive.indexOf("beginMissionStoneSurfaceTrail(client, player, run)");
        int fallAdmission = progressive.indexOf("return beginMissionStoneSafeDrop(", trailAdmission);
        assertTrue(trailAdmission >= 0 && fallAdmission > trailAdmission);
        assertTrue(resolver.contains(
            "case LANDED -> completeMissionStoneSafeDropLanding("
        ));

        int exactLanding = landing.indexOf(
            "!packageValue.launchPlan().landing().equals(voxelFeet(player))"
        );
        int shaftActivation = landing.indexOf("activateMissionStoneShaft(player, run)", exactLanding);
        int harvest = landing.indexOf(
            "MissionStoneExecutionController.FrozenPlan.safeDropHarvest(", shaftActivation);
        int fallClear = landing.indexOf("run.missionStoneSafeDrop.clear()", harvest);
        assertTrue(exactLanding >= 0);
        assertTrue(shaftActivation > exactLanding);
        assertTrue(harvest > shaftActivation);
        assertTrue(fallClear > harvest);

        assertTrue(cleanup.contains("!run.missionStoneSurfaceTrailStartedNewSession"));
        assertTrue(cleanup.contains("run.missionStoneSurfaceTrailActivated"));
        assertTrue(cleanup.contains("surfaceReturnTrailStore.clearSession()"));
    }

    @Test
    void preReflexCompletionCannotClearACommittedDepartedSafeDrop() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String preReflex = method(source, "private void enforceMineNearbyStoneCompletionBeforeReflex(");

        int committed = preReflex.indexOf("missionStoneCommittedMovementActive(run)");
        int earlyReturn = preReflex.indexOf("return;", committed);
        int reconcile = preReflex.indexOf(
            "reconcileMissionStoneAirConfirmationBeforeCompletion(", earlyReturn);
        int complete = preReflex.indexOf("completeMineNearbyStone(", reconcile);

        assertTrue(committed >= 0);
        assertTrue(earlyReturn > committed);
        assertTrue(reconcile > earlyReturn);
        assertTrue(complete > reconcile);
    }

    @Test
    void exactTargetOffFrontierReturnsBeforePublishingCommandCompletion() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String preReflex = method(source, "private void enforceMineNearbyStoneCompletionBeforeReflex(");
        String resume = method(source, "private ControlDecision resolveMissionStoneShaftResume(");
        String frontierFinisher = method(
            source,
            "private ControlDecision completePendingMissionStoneAtVerifiedFrontier("
        );

        int reconcile = preReflex.indexOf("reconcileMissionStoneDropInventory(");
        int completionState = preReflex.indexOf(
            "missionStoneFrontierCompletion.observe(", reconcile);
        int satisfactionEvent = preReflex.indexOf(
            "mine_nearby_stone.inventory_requirement_satisfied", completionState);
        int pendingReturn = preReflex.indexOf(
            "MissionStoneFrontierCompletionState.Decision.RETURN_TO_FRONTIER",
            satisfactionEvent
        );
        int pendingEarlyReturn = preReflex.indexOf("return;", pendingReturn);
        int ordinaryCompletion = preReflex.indexOf("completeMineNearbyStone(", pendingEarlyReturn);
        assertTrue(reconcile >= 0);
        assertTrue(completionState > reconcile);
        assertTrue(satisfactionEvent > completionState);
        assertTrue(pendingReturn > satisfactionEvent);
        assertTrue(pendingEarlyReturn > pendingReturn);
        assertTrue(ordinaryCompletion > pendingEarlyReturn);

        int pendingAdmission = resume.indexOf("missionStoneFrontierCompletion.pendingFor(");
        int activeRunBypass = resume.indexOf("activeMineNearbyStone != null", pendingAdmission);
        int pendingException = resume.indexOf("!frontierCompletionPending", activeRunBypass);
        int returned = resume.indexOf(
            "MiningWorkspaceTraversalController.Outcome.RETURNED", pendingException);
        int restore = resume.indexOf(
            "surfaceReturnTrailStore.restoreVerifiedPrefix(", returned);
        int returnedEvent = resume.indexOf(
            "mine_nearby_stone.shaft_session.returned", restore);
        int frontierFinisherCall = resume.indexOf(
            "completePendingMissionStoneAtVerifiedFrontier(", returnedEvent);
        assertTrue(pendingAdmission >= 0);
        assertTrue(activeRunBypass > pendingAdmission);
        assertTrue(pendingException > activeRunBypass);
        assertTrue(returned > pendingException);
        assertTrue(restore > returned);
        assertTrue(returnedEvent > restore);
        assertTrue(frontierFinisherCall > returnedEvent);

        int atFrontierBranch = resume.indexOf(
            "if (missionStoneShaftFrontier.equals(feet))");
        int atFrontierPreflight = resume.indexOf(
            "reason=at_frontier_full_live_trail", atFrontierBranch);
        int atFrontierPending = resume.indexOf(
            "if (frontierCompletionPending)", atFrontierPreflight);
        int atFrontierFinisher = resume.indexOf(
            "completePendingMissionStoneAtVerifiedFrontier(", atFrontierPending);
        int atFrontierFallthrough = resume.indexOf("return null;", atFrontierFinisher);
        assertTrue(atFrontierBranch >= 0);
        assertTrue(atFrontierPreflight > atFrontierBranch);
        assertTrue(atFrontierPending > atFrontierPreflight);
        assertTrue(atFrontierFinisher > atFrontierPending);
        assertTrue(atFrontierFallthrough > atFrontierFinisher);

        int verifiedFrontier = frontierFinisher.indexOf(
            "atVerifiedMissionStoneShaftFrontier(player)");
        int release = frontierFinisher.indexOf(
            "missionStoneFrontierCompletion.releaseAtVerifiedFrontier(", verifiedFrontier);
        int authoritativeInventory = frontierFinisher.indexOf(
            "InventoryCounter.countPlayerCobblestone(player)", release);
        int publishedCompletion = frontierFinisher.indexOf(
            "completeMineNearbyStone(", authoritativeInventory);
        assertTrue(verifiedFrontier >= 0);
        assertTrue(release > verifiedFrontier);
        assertTrue(authoritativeInventory > release);
        assertTrue(publishedCompletion > authoritativeInventory);
    }

    @Test
    void pendingFrontierReturnCannotExtendTheOriginalStoneDeadline() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String resume = method(source, "private ControlDecision resolveMissionStoneShaftResume(");

        int routeDeadline = resume.indexOf(
            "MiningWorkspaceTraversal.timeoutMs(route.size())");
        int runDeadline = resume.indexOf(
            "activeMineNearbyStone.startedAtMs + NEARBY_STONE_TIMEOUT_MS",
            routeDeadline
        );
        int committedDeadline = resume.indexOf(
            "missionStoneShaftResumeDeadlineAtMs = Math.min(", runDeadline);
        int deadlineGuard = resume.indexOf(
            "nowMs >= missionStoneShaftResumeDeadlineAtMs", committedDeadline);
        assertTrue(routeDeadline >= 0);
        assertTrue(runDeadline > routeDeadline);
        assertTrue(committedDeadline > runDeadline);
        assertTrue(deadlineGuard > committedDeadline);
        assertTrue(surrounding(resume, runDeadline, committedDeadline, 450).contains(
            "frontierCompletionPending"
        ));
    }

    @Test
    void frontierCompletionLatchClearsOnCommandAndTerminalLifecycle() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String dispatch = method(source, "private ControlDecision resolveControl(");
        String preReflex = method(source, "private void enforceMineNearbyStoneCompletionBeforeReflex(");
        String complete = method(source, "private ControlDecision completeMineNearbyStone(");
        String failed = method(source, "private ControlDecision failMineNearbyStone(");

        assertTrue(dispatch.contains(
            "if (!isMineNearbyStone(effective)) {\n"
                + "            missionStoneInventoryCompletion.clear();\n"
                + "            missionStoneFrontierCompletion.clear();"
        ));
        assertTrue(preReflex.contains("missionStoneFrontierCompletion.clear();"));
        assertTrue(preReflex.contains(
            "if (!inventorySatisfied) {\n"
                + "            missionStoneFrontierCompletion.observe("
        ));
        assertTrue(complete.indexOf("missionStoneFrontierCompletion.clear();")
            < complete.indexOf("activeMineNearbyStone = null"));
        assertTrue(failed.indexOf("missionStoneFrontierCompletion.clear();")
            < failed.indexOf("activeMineNearbyStone = null"));
    }

    @Test
    void outerCompletionAndDeadlineCannotPreemptCommittedSafeDropMovement() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String resolver = method(source, "private ControlDecision resolveMineNearbyStoneControl(");
        String progressive = method(source, "private ControlDecision resolveMissionStoneProgressiveControl(");

        int absoluteCompletion = resolver.indexOf(
            "MissionStoneInventoryCompletionPolicy.isSatisfied("
        );
        int completion = resolver.indexOf("completeMineNearbyStone(", absoluteCompletion);
        int timeout = resolver.indexOf("NEARBY_STONE_TIMEOUT_MS", completion);
        int timeoutFailure = resolver.indexOf("failMineNearbyStone(", timeout);

        assertTrue(absoluteCompletion >= 0);
        assertTrue(completion > absoluteCompletion);
        assertTrue(surrounding(resolver, absoluteCompletion, completion, 600).contains(
            "missionStoneCommittedMovementActive(run)"));
        assertTrue(timeout > completion && timeoutFailure > timeout);
        assertTrue(surrounding(resolver, timeout, timeoutFailure, 600).contains(
            "missionStoneCommittedMovementActive(run)"));

        int batchComplete = progressive.indexOf(
            "batch.action() == MissionStoneDropBatch.Action.COMPLETE"
        );
        int progressiveComplete = progressive.indexOf(
            "completeMineNearbyStone(", batchComplete);
        assertTrue(batchComplete >= 0);
        assertTrue(progressiveComplete > batchComplete);
        assertTrue(surrounding(progressive, batchComplete, progressiveComplete, 600).contains(
            "missionStoneCommittedMovementActive(run)"));
    }

    @Test
    void verifiedSafeDropLandingIsPublishedBeforeCompletionOrHarvestAdmission() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String landing = method(source, "private ControlDecision completeMissionStoneSafeDropLanding(");

        int exactLanding = landing.indexOf(
            "!packageValue.launchPlan().landing().equals(voxelFeet(player))"
        );
        int landingCount = landing.indexOf("run.missionStoneSafeDropLandings++", exactLanding);
        int shaftActivation = landing.indexOf("activateMissionStoneShaft(player, run)", landingCount);
        int landedEvent = landing.indexOf("mine_nearby_stone.safe_drop.landed", shaftActivation);
        int satisfied = landing.indexOf(
            "MissionStoneInventoryCompletionPolicy.isSatisfied(", landedEvent);
        int satisfiedCompletion = landing.indexOf("completeMineNearbyStone(", satisfied);
        int harvestAdmission = landing.indexOf(
            "MissionStoneExecutionController.FrozenPlan.safeDropHarvest(", satisfiedCompletion);

        assertTrue(exactLanding >= 0);
        assertTrue(landingCount > exactLanding);
        assertTrue(shaftActivation > landingCount);
        assertTrue(landedEvent > shaftActivation);
        assertTrue(satisfied > landedEvent);
        assertTrue(satisfiedCompletion > satisfied);
        assertTrue(harvestAdmission > satisfiedCompletion);
    }

    @Test
    void failedShaftActivationCannotStartPostDropMining() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String landing = method(source, "private ControlDecision completeMissionStoneSafeDropLanding(");

        int activationCall = landing.indexOf("activateMissionStoneShaft(player, run)");
        int activationFailure = landing.indexOf("return failMineNearbyStone(", activationCall);
        int harvestAdmission = landing.indexOf(
            "MissionStoneExecutionController.FrozenPlan.safeDropHarvest(", activationFailure);

        assertTrue(activationCall >= 0);
        assertTrue(activationFailure > activationCall);
        String activationGate = landing.substring(activationCall, activationFailure);
        assertTrue(
            activationGate.contains("if (!activateMissionStoneShaft(player, run))")
                || activationGate.contains("if (!shaftActivated)")
                || activationGate.contains("if (!activated)"),
            "shaft activation failure must guard the terminal return"
        );
        assertTrue(harvestAdmission > activationFailure);
    }

    @Test
    void activeProgressiveDropOrHarvestCannotBePreemptedByShaftResume() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String resume = method(source, "private ControlDecision resolveMissionStoneShaftResume(");

        int activeRun = resume.indexOf("activeMineNearbyStone");
        int safeDrop = resume.indexOf("missionStoneSafeDrop.active()", activeRun);
        int execution = resume.indexOf("missionStoneExecution.active()", activeRun);
        int defer = resume.indexOf("return null;", Math.max(safeDrop, execution));
        int shaftAdmission = resume.indexOf("missionStoneShaftActiveForCurrentSession()", defer);

        assertTrue(activeRun >= 0);
        assertTrue(safeDrop > activeRun);
        assertTrue(execution > activeRun);
        assertTrue(defer > Math.max(safeDrop, execution));
        assertTrue(shaftAdmission > defer);
    }

    @Test
    void activeCanonicalTrailProtectsPlacementAndPrimaryDescentReusesItsHeading() throws IOException {
        String client = Files.readString(CLIENT_SOURCE);
        String descent = Files.readString(DESCENT_SOURCE);
        String shell = Files.readString(SHELL_SOURCE);
        String membership = method(client, "public boolean isOnRecordedDescentTrail(");
        String preferred = method(client, "public StaircaseDescentPlanner.Direction2d preferredDescentDirection(");
        String resolveDescent = method(descent, "public ControlDecision resolve(");

        assertTrue(membership.contains("surfaceReturnTrailStore.active()"));
        assertTrue(membership.contains("for (VoxelCell feet : surfaceReturnTrailStore.trail())"));
        assertTrue(membership.contains("feet.y() == cell.getY() || feet.y() + 1 == cell.getY()"));
        assertTrue(shell.contains("default StaircaseDescentPlanner.Direction2d preferredDescentDirection("));
        assertTrue(preferred.contains("\"mission:DESCEND\".equals(intent.reason())"));
        assertTrue(preferred.contains("missionStoneShaftActiveForCurrentSession()"));
        assertTrue(preferred.contains("VoxelCell frontier = missionStoneShaftFrontier"));
        assertTrue(preferred.contains("preferred = missionStoneShaftDirection"));
        assertTrue(preferred.contains("reason=primary_descent_same_shaft"));
        assertTrue(resolveDescent.contains("shell.preferredDescentDirection("));
        assertTrue(resolveDescent.indexOf("shell.preferredDescentDirection(")
            < resolveDescent.indexOf("lastDescentFailurePos != null"));
    }

    @Test
    void planExhaustionWaitsForProducedDropsBeforeAnyNewPlanningBatch() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String progressive = method(source, "private ControlDecision resolveMissionStoneProgressiveControl(");
        String apply = method(source, "private ControlDecision applyMissionStoneExecutionDecision(");

        int reconcile = progressive.indexOf("reconcileMissionStoneDropInventory(");
        int observe = progressive.indexOf("observeMissionStoneDropEntities(");
        int decide = progressive.indexOf("MissionStoneDropBatch.decide(");
        int wait = progressive.indexOf(
            "batch.action() == MissionStoneDropBatch.Action.WAIT_FOR_ATTRIBUTION_OR_AUTO_PICKUP"
        );
        int plan = progressive.indexOf("planMissionStoneMethod(");
        assertTrue(reconcile >= 0 && observe > reconcile && decide > observe && wait > decide && plan > wait);

        int production = apply.indexOf("if (decision.stoneProducedThisTick())");
        int planExhausted = apply.indexOf("case PLAN_EXHAUSTED");
        assertTrue(production >= 0 && planExhausted > production);
        String exhaustedCase = apply.substring(
            planExhausted,
            apply.indexOf("case COMPLETE", planExhausted)
        );
        assertTrue(exhaustedCase.contains("emitMissionStonePlanComplete("));
        assertTrue(exhaustedCase.contains("run.missionStonePlan = null"));
        assertTrue(exhaustedCase.contains("run.missionStoneWaitingForDropsAtMs = nowMs"));
        assertFalse(exhaustedCase.contains("planMissionStoneMethod("));
        assertFalse(exhaustedCase.contains("completeMineNearbyStone("));
    }

    @Test
    void reachableFaceAllowanceIsCommandScopedAndSurvivesPlanExhaustion() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String planning = method(source, "private MissionStonePlanningResult planMissionStoneMethod(");
        String production = method(source, "private void recordMissionStoneProduction(");
        String apply = method(source, "private ControlDecision applyMissionStoneExecutionDecision(");

        assertTrue(source.contains(
            "final MissionStoneFaceHarvestBudget missionStoneFaceHarvestBudget ="));
        assertTrue(planning.contains(
            "run.missionStoneFaceHarvestBudget.remainingBlocks()"));
        assertTrue(production.contains(
            "run.missionStoneFaceHarvestBudget.recordVerifiedProduction(activeMethod)"));

        String exhaustedCase = apply.substring(
            apply.indexOf("case PLAN_EXHAUSTED"),
            apply.indexOf("case COMPLETE", apply.indexOf("case PLAN_EXHAUSTED"))
        );
        assertFalse(exhaustedCase.contains("missionStoneFaceHarvestBudget"),
            "finishing one face plan must not reset the command-scoped allowance");
    }

    @Test
    void attributionReplaysThePreBreakSnapshotAfterVerifiedAirConfirmation() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String apply = method(source, "private ControlDecision applyMissionStoneExecutionDecision(");
        String production = method(source, "private void recordMissionStoneProduction(");
        String attribution = method(source, "private void attributeMissionStoneProducedDrop(");

        int snapshot = apply.indexOf("run.missionStoneBreakBaselines.computeIfAbsent(");
        int physicalBreak = apply.indexOf("blockBreakController.tick(", snapshot);
        assertTrue(snapshot >= 0 && physicalBreak > snapshot);
        assertTrue(production.indexOf("MissionStoneDropBatch.recordProduced(")
            < production.indexOf("attributeMissionStoneProducedDrop("));
        assertTrue(attribution.contains("run.missionStoneBreakBaselines.remove(position)"));
        assertTrue(attribution.contains("!baseline.containsKey(observation.entityId())"));
        assertTrue(attribution.contains(
            "observation.stackCount() > baseline.getOrDefault(observation.entityId(), 0)"
        ));
        assertTrue(attribution.contains(
            "owned.stackCount() - baseline.getOrDefault(owned.entityId(), 0)"
        ));
        assertTrue(attribution.indexOf("MissionStoneDropBatch.observeEntityStackDelta(")
            < attribution.indexOf("run.missionStoneObservedEntityCounts.put("));
    }

    @Test
    void engagedProgressiveBreakBypassesInitialRaycastForTerminalAirConfirmation()
        throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String apply = method(source, "private ControlDecision applyMissionStoneExecutionDecision(");

        int engagedGate = apply.indexOf("missionStoneBreakRequiresInitialRaycast(");
        int liveRaycast = apply.indexOf("isLookRaycastHittingBlock(", engagedGate);
        int breakerTick = apply.indexOf("blockBreakController.tick(", liveRaycast);

        assertTrue(engagedGate >= 0);
        assertTrue(liveRaycast > engagedGate);
        assertTrue(breakerTick > liveRaycast);
        assertTrue(apply.substring(engagedGate, liveRaycast).contains(
            "run.missionStoneEngagedBreakTarget"
        ));
    }

    @Test
    void autoPickupEnvelopeContainsOnlyThePlayerAndUnconsumedRouteSuffix() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String envelope = method(
            source,
            "private boolean missionStoneDropInsideRouteEnvelope(\n"
                + "        ClientPlayerEntity player,\n"
                + "        MineNearbyStoneRun run,\n"
                + "        OwnedDropTracker.Position position,\n"
                + "        Box itemBox"
        );

        assertTrue(envelope.contains("run.missionStoneExecution.active()"));
        assertTrue(envelope.contains("MissionStonePickupEnvelope.currentPlayerContains("));
        assertTrue(envelope.contains("MissionStonePickupEnvelope.futureLandingContains("));
        assertTrue(envelope.contains("player.getBoundingBox(), itemBox"));
        assertFalse(envelope.contains("squaredDistanceTo(center) <= 4.0D"));
        assertFalse(envelope.contains("player.getZ())) <= 4.0D"));
        assertTrue(envelope.contains(
            "int firstFutureStep = Math.max(0, run.missionStoneExecution.staircaseStepCursor())"
        ));
        assertTrue(envelope.contains("for (int index = firstFutureStep; index < steps.size(); index++)"));
        assertFalse(envelope.contains("for (StaircaseDescentPlanner.Step step : steps)"));
        assertFalse(envelope.contains("index = 0; index < steps.size()"));
    }

    @Test
    void dropBatchUsesStableSettlementBeforePublishingRecoveryEligibility() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String attribution = method(source, "private void attributeMissionStoneProducedDrop(");
        String observation = method(source, "private void observeMissionStoneDropEntities(");
        String reconciliation = method(source, "private void reconcileMissionStoneDropInventory(");
        String recovery = method(source, "private ControlDecision beginMissionStoneOwnedDropRecovery(");
        String rejection = method(source, "private ControlDecision rejectMissionStoneRecoveryEntity(");
        String abandonment = method(source, "private ControlDecision abandonMineNearbyStoneOwnedDrop(");

        assertTrue(attribution.indexOf("run.missionStoneDropSettlements.observe(")
            < attribution.indexOf("MissionStoneDropBatch.observeEntityStackDelta("));
        assertTrue(observation.indexOf("run.missionStoneDropSettlements.observe(")
            < observation.indexOf("MissionStoneDropBatch.observeEntityStackDelta("));
        assertTrue(observation.indexOf("run.missionStoneDropSettlements.observe(")
            < observation.indexOf("MissionStoneDropBatch.observeEntityState("));
        assertTrue(observation.indexOf("if (!alreadyTracked && !attributableDelta)")
            < observation.indexOf("run.missionStoneDropSettlements.observe("));
        assertFalse(observation.contains("item.isOnGround(),\n                    insideEnvelope"));
        assertTrue(reconciliation.contains("retainMissionStoneDropSettlementIdentities(run)"));
        assertTrue(reconciliation.contains("liveMissionStoneDropEntityIds(client, run)"));
        assertTrue(reconciliation.contains("MissionStoneDropBatch.reconcileInventory("));
        assertTrue(recovery.contains("run.dropTracker.adoptAttributed("));
        assertTrue(recovery.contains("batch.recoveryUnits()"));
        assertFalse(recovery.contains("updateMineNearbyStoneOwnedDrop(\n            client"));
        assertTrue(rejection.contains("retainMissionStoneDropSettlementIdentities(run)"));
        assertTrue(abandonment.contains("retainMissionStoneDropSettlementIdentities(run)"));
    }

    @Test
    void finalAirConfirmationIsReconciledBeforeInventoryCompletionIsPublished() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String preReflex = method(source, "private void enforceMineNearbyStoneCompletionBeforeReflex(");
        String reconcile = method(source, "private void reconcileMissionStoneAirConfirmationBeforeCompletion(");

        int activeRun = preReflex.indexOf("MineNearbyStoneRun run =");
        int airConfirmation = preReflex.indexOf(
            "reconcileMissionStoneAirConfirmationBeforeCompletion(", activeRun);
        int satisfiedEvent = preReflex.indexOf(
            "mine_nearby_stone.inventory_requirement_satisfied", airConfirmation);
        int preReflexPlanComplete = preReflex.indexOf(
            "emitMissionStonePlanComplete(", satisfiedEvent);
        int complete = preReflex.indexOf("completeMineNearbyStone(", preReflexPlanComplete);
        assertTrue(activeRun >= 0 && airConfirmation > activeRun);
        assertTrue(satisfiedEvent > airConfirmation);
        assertTrue(preReflexPlanComplete > satisfiedEvent);
        assertTrue(complete > preReflexPlanComplete);
        assertTrue(preReflex.substring(satisfiedEvent, complete).contains(
            "run.missionStonePlan != null"
        ));

        int terminalTick = reconcile.indexOf(
            "new MissionStoneExecutionController.BreakFeedback("
        );
        int clearEngaged = reconcile.indexOf("run.missionStoneEngagedBreakTarget = null");
        int record = reconcile.indexOf("recordMissionStoneProduction(", clearEngaged);
        int planComplete = reconcile.indexOf("emitMissionStonePlanComplete(", record);
        assertTrue(terminalTick >= 0 && clearEngaged > terminalTick);
        assertTrue(record > clearEngaged);
        assertTrue(planComplete > record);
        assertTrue(reconcile.contains("client.world.getBlockState(target).isAir()"));
    }

    @Test
    void zeroStepMissionStoneSessionIsClearedOnEitherTerminalPath() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String cleanup = method(source, "private void clearUnactivatedMissionStoneSurfaceTrail(");
        String complete = method(source, "private ControlDecision completeMineNearbyStone(");
        String failed = method(source, "private ControlDecision failMineNearbyStone(");

        assertTrue(cleanup.contains("run.missionStoneSurfaceTrailStartedNewSession"));
        assertTrue(cleanup.contains("run.missionStoneSurfaceTrailActivated"));
        assertTrue(cleanup.contains(
            "surfaceReturnTrailStore.sessionRevision()\n"
                + "                != run.missionStoneSurfaceTrailSessionRevision"
        ));
        assertTrue(cleanup.contains("surfaceReturnTrailStore.clearSession()"));
        assertTrue(cleanup.contains("mine_nearby_stone.shaft_session.declined"));

        int completeCleanup = complete.indexOf("clearUnactivatedMissionStoneSurfaceTrail(");
        int completeDropRun = complete.indexOf("activeMineNearbyStone = null");
        int failedCleanup = failed.indexOf("clearUnactivatedMissionStoneSurfaceTrail(");
        int failedDropRun = failed.indexOf("activeMineNearbyStone = null");
        assertTrue(completeCleanup >= 0 && completeDropRun > completeCleanup);
        assertTrue(failedCleanup >= 0 && failedDropRun > failedCleanup);
    }

    @Test
    void frozenShaftDirectionCannotBeRotatedByAnArbitraryLiveTrailEdge() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String activate = method(source, "private boolean activateMissionStoneShaft(");
        String preferred = method(
            source,
            "public StaircaseDescentPlanner.Direction2d preferredDescentDirection("
        );

        assertTrue(activate.contains("missionStoneShaftDirection = run.missionStoneHeading"));
        assertTrue(activate.contains("missionStoneVerifiedShaftTrail = List.copyOf(verifiedTrail)"));
        assertTrue(preferred.contains(
            "StaircaseDescentPlanner.Direction2d preferred = missionStoneShaftDirection"
        ));
        assertFalse(preferred.contains("surfaceReturnTrailStore.trail()"));
        assertFalse(preferred.contains("trail.getLast()"));
        assertFalse(preferred.contains("cardinalFromDelta("));
    }

    @Test
    void failedShaftResumeRejectsDescentBeforeExecutorAdmission() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String descent = Files.readString(DESCENT_SOURCE);
        String dispatch = method(source, "private ControlDecision resolveControl(");
        String reject = method(source, "private ControlDecision rejectMissionStoneShaftResume(");
        String preAdmission = method(descent, "ControlDecision rejectBeforeAdmission(");

        int resume = dispatch.indexOf("resolveMissionStoneShaftResume(");
        int resumeReturn = dispatch.indexOf("if (shaftResume != null)", resume);
        int registry = dispatch.indexOf("objectiveRegistry.forAction(", resumeReturn);
        assertTrue(resume >= 0 && resumeReturn > resume && registry > resumeReturn);

        assertTrue(reject.contains("descentExecutor.rejectBeforeAdmission("));
        assertFalse(reject.contains("descentExecutor.resolve("));
        assertTrue(preAdmission.contains("ledger.markComplete("));
        assertTrue(preAdmission.contains("shell.completeCurrentCommand("));
        assertFalse(preAdmission.contains("new DescentRun("));
        assertFalse(preAdmission.contains("activeRun ="));
    }

    @Test
    void activeProgressiveMovementAndAdmittedDescentCannotSelfPreemptIntoShaftResume()
        throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String resume = method(source, "private ControlDecision resolveMissionStoneShaftResume(");

        int progressiveBypass = resume.indexOf("activeMissionStoneOwnsShaftMovement(");
        int descentLatchBypass = resume.indexOf("missionStoneShaftDescentCommandAdmitted(");
        int feetRead = resume.indexOf("VoxelCell feet = voxelFeet(player)");
        int routeSelection = resume.indexOf("missionStoneShaftResumeRoute(");

        assertTrue(progressiveBypass >= 0, "active mission-stone movement must bypass resume");
        assertTrue(descentLatchBypass >= 0, "an admitted primary descent must bypass resume");
        assertTrue(progressiveBypass < feetRead);
        assertTrue(descentLatchBypass < feetRead);
        assertTrue(feetRead < routeSelection);
    }

    @Test
    void physicallyRejectedStoneTransitionIsRememberedAcrossCommandsAndFilteredBeforePlanning()
        throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String apply = method(source, "private ControlDecision applyMissionStoneExecutionDecision(");
        String record = method(
            source,
            "private void maybeRecordRejectedMissionStoneTransition("
        );
        String planning = method(source, "private MissionStonePlanningResult planMissionStoneMethod(");
        String lookup = method(
            source,
            "private StaircaseDescentPlanner.Step firstRejectedMissionStoneTransition("
        );
        String safeDropLookup = method(
            source,
            "private boolean isRejectedMissionStoneSafeDrop("
        );
        String safeDropPlanner = method(
            source,
            "private MissionStoneSafeDropPackage missionStoneSafeDropPackage("
        );
        String context = method(
            source,
            "private void synchronizeMissionStoneRejectedTransitionContext("
        );

        assertTrue(source.contains(
            "private final MissionStoneRejectedTransitionMemory missionStoneRejectedTransitionMemory"
        ));
        assertTrue(apply.contains("maybeRecordRejectedMissionStoneTransition("));
        assertTrue(record.contains("recordPhysicalRejection("));
        assertTrue(record.contains("staircase_movement:descent_missed"));
        assertTrue(record.contains("staircase_movement:transition_deviation"));
        assertTrue(planning.contains("synchronizeMissionStoneRejectedTransitionContext(client)"));
        assertTrue(planning.indexOf("synchronizeMissionStoneRejectedTransitionContext(client)")
            < planning.indexOf("missionStoneSafeDropPackage("));
        assertTrue(safeDropPlanner.contains("for (MissionStoneSafeDropPackage candidate : ranked)"));
        assertTrue(safeDropPlanner.contains("isRejectedMissionStoneSafeDrop(candidate)"));
        assertTrue(safeDropPlanner.contains("continue;"));
        assertTrue(safeDropPlanner.indexOf("continue;")
            < safeDropPlanner.indexOf("return candidate;"));
        assertTrue(planning.contains("firstRejectedMissionStoneTransition("));
        assertTrue(planning.contains(
            "executableMissionStoneMovementSteps(headingDecision.plan())"));
        assertTrue(planning.contains(
            "for (StaircaseDescentPlanner.Direction2d heading : staircaseHeadings)"));
        assertTrue(planning.contains(
            "MissionStoneMethodPlanner.selectCandidates(decisions)"));
        assertTrue(planning.contains(
            "headingDecision = new MissionStoneMethodPlanner.Decision("));
        assertTrue(lookup.contains(
            "missionStoneRejectedTransitionMemory.firstRejectedExecutableStep(executableSteps)"
        ));
        assertTrue(safeDropLookup.contains(
            "missionStoneRejectedTransitionMemory.suppressesSafeDrop("
        ));
        assertTrue(context.contains("missionStoneShaftActiveForCurrentSession()"));
        assertTrue(context.contains("MissionStoneRejectedTransitionMemory.PRE_ACTIVATION_SESSION"));
        assertTrue(source.contains("maybeRecordRejectedMissionStoneSafeDropTransition("));
        assertTrue(source.contains(
            "mine_nearby_stone.progressive_staircase.transition_recorded"
        ));
        assertTrue(source.contains(
            "mine_nearby_stone.progressive_staircase.transition_suppressed"
        ));
    }

    @Test
    void inheritedCompletedDescentPromotesTheFrozenShaftAfterCanonicalAppend()
        throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        int compatibilityOverload = source.indexOf("public void recordCompletedDescentPath(");
        String completed = methodAfter(
            source,
            "public void recordCompletedDescentPath(",
            compatibilityOverload + 1
        );
        String promotion = method(source, "private void promoteMissionStoneShaftAfterDescentSegment(");

        int canonicalAppend = completed.indexOf("appendSurfaceReturnDescentSegment(");
        int shaftPromotion = completed.indexOf("promoteMissionStoneShaftAfterDescentSegment(");
        assertTrue(canonicalAppend >= 0);
        assertTrue(shaftPromotion > canonicalAppend);

        assertTrue(promotion.contains("missionStoneVerifiedShaftTrail"));
        assertTrue(promotion.contains("missionStoneShaftFrontier"));
        assertTrue(promotion.contains("surfaceReturnTrailStore.trail()"));
        assertTrue(promotion.contains("surfaceReturnTrailStore.sessionRevision()"));
        assertTrue(promotion.contains("\"mission:DESCEND_RECOVERY\".equals(objectiveReason)"));
        assertTrue(promotion.contains("missionStoneShaftDirection = finalDirection"));
        assertTrue(promotion.contains("missionStoneShaftRoutePreflight("));
    }

    @Test
    void shaftReplayHonorsStoreAvailabilityRouteTimeoutAndFrozenAdmissionSnapshot()
        throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String resume = method(source, "private ControlDecision resolveMissionStoneShaftResume(");
        String observer = method(source, "private void observeSurfaceReturnTrail(");

        int availability = resume.indexOf("surfaceReturnTrailStore.remoteSuffixAvailable()");
        int routeSelection = resume.indexOf("missionStoneShaftResumeRoute(");
        int routeTimeout = resume.indexOf("MiningWorkspaceTraversal.timeoutMs(route.size())");
        int snapshotFreeze = resume.indexOf("freezeMissionStoneShaftResumeSnapshot(");
        int restore = resume.indexOf("surfaceReturnTrailStore.restoreVerifiedPrefix(");
        int snapshotValidate = resume.indexOf("missionStoneShaftResumeSnapshotMatches(");
        int arrivalPreflight = resume.indexOf(
            "MissionStoneShaftRoutePreflight arrivalPreflight", snapshotValidate);
        int arrivalPreflightFailure = resume.indexOf(
            "if (!arrivalPreflight.valid())", arrivalPreflight);

        assertTrue(availability >= 0 && availability < routeSelection);
        assertTrue(routeTimeout > routeSelection);
        assertTrue(snapshotFreeze > routeSelection && snapshotFreeze < restore);
        assertTrue(snapshotValidate > snapshotFreeze && snapshotValidate < restore);
        assertTrue(arrivalPreflight > snapshotValidate && arrivalPreflight < restore);
        assertTrue(arrivalPreflightFailure > arrivalPreflight
            && arrivalPreflightFailure < restore);
        assertTrue(resume.substring(arrivalPreflightFailure, restore).contains(
            "surfaceReturnTrailStore.invalidateRemoteSuffix("
        ));
        assertTrue(observer.contains("missionStoneShaftResumeTraversal.active()"));
    }

    @Test
    void shaftPreflightTreatsUnloadedHistoryAsUnavailableAndWaitsBeforeMovement()
        throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        int compatibilityPreflight = source.indexOf(
            "static MissionStoneShaftRoutePreflight missionStoneShaftRoutePreflight("
        );
        String preflight = methodAfter(
            source,
            "static MissionStoneShaftRoutePreflight missionStoneShaftRoutePreflight(",
            compatibilityPreflight + 1
        );
        String envelope = method(
            source,
            "private static boolean missionStoneShaftEnvelopeLoaded("
        );
        String tick = methodAfter(
            source,
            "private MiningWorkspaceTraversalController.Step tickMiningWorkspaceTraversal(",
            source.indexOf("private MiningWorkspaceTraversalController.Step tickMiningWorkspaceTraversal(") + 1
        );
        String resume = method(source, "private ControlDecision resolveMissionStoneShaftResume(");
        String promotion = method(source, "private void promoteMissionStoneShaftAfterDescentSegment(");

        assertTrue(source.contains("Status.UNAVAILABLE"));
        assertTrue(source.contains("return status != Status.UNSAFE"));
        assertTrue(preflight.contains("observedEnvelope"));
        assertTrue(envelope.contains("ChunkStatus.FULL"));
        assertTrue(envelope.contains("false"));
        assertTrue(resume.contains("missionStoneShaftEnvelopeLoaded(client.world, cell)"));
        assertTrue(promotion.contains("missionStoneShaftEnvelopeLoaded(client.world, cell)"));
        int availability = tick.indexOf("missionStoneShaftEnvelopeLoaded(");
        int wait = tick.indexOf("waitForWaypointAvailability(", availability);
        int traversalTick = tick.indexOf("return traversal.tick(", wait);
        assertTrue(availability >= 0 && wait > availability && traversalTick > wait);
    }

    @Test
    void shaftReplayPreflightsEveryLiveCellAndHandsSafePrimaryDescentOffNeutrally()
        throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String resume = method(source, "private ControlDecision resolveMissionStoneShaftResume(");
        String handoff = method(
            source,
            "private ControlDecision handoffOrRejectMissionStoneShaftResumeBeforeAdmission("
        );
        String rejection = method(source, "private ControlDecision rejectMissionStoneShaftResume(");

        int liveTrail = resume.indexOf("List<VoxelCell> liveTrail = surfaceReturnTrailStore.trail()");
        int livePreflight = resume.indexOf("missionStoneShaftRoutePreflight(", liveTrail);
        int livePreflightFailure = resume.indexOf("if (!livePreflight.valid())", livePreflight);
        int atFrontier = resume.indexOf("if (missionStoneShaftFrontier.equals(feet))", livePreflightFailure);
        int composedRoute = resume.indexOf("missionStoneShaftResumeRoute(", livePreflight);
        int composedPreflight = resume.indexOf("missionStoneShaftRoutePreflight(", composedRoute);
        int controllerBegin = resume.indexOf("missionStoneShaftResumeTraversal.begin(", composedPreflight);
        assertTrue(liveTrail >= 0);
        assertTrue(livePreflight > liveTrail);
        assertTrue(livePreflightFailure > livePreflight);
        assertTrue(atFrontier > livePreflightFailure,
            "the at-frontier fast path must validate the complete live trail first");
        assertEquals(-1, resume.substring(0, livePreflight).indexOf(
            "missionStoneShaftFrontier.equals(feet)"
        ));
        assertTrue(resume.substring(atFrontier, composedRoute).contains(
            "feet.equals(liveTrail.getLast())"
        ));
        assertTrue(resume.substring(atFrontier, composedRoute).contains(
            "at_frontier_full_live_trail"
        ));
        assertTrue(composedRoute > livePreflight);
        assertTrue(composedPreflight > composedRoute);
        assertTrue(controllerBegin > composedPreflight);

        assertTrue(handoff.contains("safeLocalDescentAdmission"));
        assertTrue(handoff.contains("surfaceReturnTrailStore.remoteSuffixAvailable()"));
        assertTrue(handoff.contains(
            "storeResult != SurfaceReturnTrailStore.RemoteSuffixInvalidateResult.INVALIDATED"
        ));
        assertTrue(handoff.contains("missionStoneShaftAdmittedDescentCommandIds.add(commandId)"));
        assertTrue(handoff.contains("mission_stone_shaft_local_descent_handoff"));
        assertFalse(handoff.contains("completeCurrentCommand("));
        assertFalse(handoff.contains("rejectBeforeAdmission("));

        // Once traversal has launched, the historical fail-closed path remains authoritative.
        assertTrue(rejection.contains("descentExecutor.rejectBeforeAdmission("));
    }

    @Test
    void descentExecutorPublishesFinalDirectionAndChecksCanonicalSupportBeforeBreaking()
        throws IOException {
        String descent = Files.readString(DESCENT_SOURCE);
        String shell = Files.readString(SHELL_SOURCE);
        String complete = method(descent, "private ControlDecision completeDescent(");
        String breaking = method(descent, "private ControlDecision breakDescentBlock(");
        String rerouteSafety = method(descent, "private boolean isDescentRerouteCandidateSafe(");

        assertTrue(complete.contains("run.direction"));
        assertTrue(complete.contains("run.objectiveReason"));
        assertTrue(shell.contains("default void recordCompletedDescentPath("));
        assertTrue(shell.contains("default boolean isCanonicalDescentTrailSupport("));
        assertTrue(breaking.contains("shell.isCanonicalDescentTrailSupport(target)"));
        assertTrue(breaking.indexOf("shell.isCanonicalDescentTrailSupport(target)")
            < breaking.indexOf("shell.blockBreakController().tick("));
        assertTrue(rerouteSafety.contains("firstCanonicalSupportConflict(candidate) == null"));
    }

    @Test
    void everyDescentMutationPathChecksTheCrossCommandTrailLeaseBeforeInteraction()
        throws IOException {
        String descent = Files.readString(DESCENT_SOURCE);
        String workspace = Files.readString(WORKSPACE_SOURCE);
        String bridgeGate = method(descent, "private boolean canBridgeDescentSupport(");
        String placement = method(
            descent,
            "private ControlDecision placeDescentSupport(\n"
                + "        MinecraftClient client,\n"
                + "        ClientPlayerEntity player,\n"
                + "        BrainLink.Intent effective,\n"
                + "        DescentRun run,\n"
                + "        StaircaseDescentPlanner.Step step,\n"
                + "        long nowMs,\n"
                + "        String reason,\n"
                + "        BlockPos explicitWaterCell"
        );
        String cleanup = method(descent, "private ControlDecision maybeResolveDescentIronCleanup(");
        String carve = method(workspace, "private Outcome carve(");

        assertTrue(bridgeGate.contains("placementOccupiesCanonicalTrail("));
        assertTrue(bridgeGate.contains("descentStepWaterCell(client, step)"));
        assertTrue(bridgeGate.contains("step.support()"));

        int intendedPlacement = placement.indexOf("BlockPos intendedPlacementCell");
        int placementLease = placement.indexOf("placementOccupiesCanonicalTrail(", intendedPlacement);
        int physicalPlacement = placement.indexOf("shell.blockPlaceController().tick(", placementLease);
        assertTrue(intendedPlacement >= 0 && placementLease > intendedPlacement);
        assertTrue(physicalPlacement > placementLease,
            "normal filler, column repair, and water seals must be leased before placement");
        int predictedPlacementLease = placement.indexOf(
            "placementDemandViolationReason(", physicalPlacement);
        int placementInteraction = placement.indexOf(
            "withInteraction(", predictedPlacementLease);
        assertTrue(predictedPlacementLease > physicalPlacement);
        assertTrue(placementInteraction > predictedPlacementLease,
            "a drifted placement demand must be vetoed before interaction authority");

        int cleanupBreaker = cleanup.indexOf("shell.blockBreakController().tick(");
        int cleanupLease = cleanup.indexOf("firstCanonicalBreakInteractionConflict(", cleanupBreaker);
        int cleanupInteraction = cleanup.indexOf("withInteraction(", cleanupBreaker);
        assertTrue(cleanupBreaker >= 0 && cleanupLease > cleanupBreaker);
        assertTrue(cleanupInteraction > cleanupLease,
            "an ore occluder demand must be vetoed before it reaches the interaction authority");
        assertTrue(cleanup.substring(cleanupLease, cleanupInteraction).contains(
            "shell.blockBreakController().reset()"
        ));

        int requestedLease = carve.indexOf("firstCanonicalCarveConflict(");
        int carveBreaker = carve.indexOf("shell.blockBreakController().tick(", requestedLease);
        int redirectedLease = carve.indexOf("firstCanonicalCarveConflict(", carveBreaker);
        int carveInteraction = carve.indexOf("withInteraction(", carveBreaker);
        assertTrue(requestedLease >= 0 && requestedLease < carveBreaker);
        assertTrue(redirectedLease > carveBreaker && carveInteraction > redirectedLease);
        assertTrue(carve.substring(redirectedLease, carveInteraction).contains(
            "shell.blockBreakController().reset()"
        ));
    }

    @Test
    void progressivePlannerAdmitsAndPricesTheExactSelectedPickaxe() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String progressive = method(source, "private ControlDecision resolveMissionStoneProgressiveControl(");
        String pricing = method(source, "private long missionStoneStoneBreakMs(");

        int activeExecution = progressive.indexOf("if (run.missionStoneExecution.active())");
        int executionTick = progressive.indexOf("run.missionStoneExecution.tick(", activeExecution);
        int toolAdmission = progressive.indexOf("ensureMissionStoneBestPickaxe(");
        int planning = progressive.indexOf("planMissionStoneMethod(", toolAdmission);
        assertTrue(activeExecution >= 0 && executionTick > activeExecution);
        assertFalse(progressive.substring(activeExecution, executionTick).contains("ensureMissionStoneBestPickaxe("));
        assertTrue(toolAdmission > executionTick && planning > toolAdmission);
        assertEquals(-1, progressive.indexOf("ensureMissionStoneBestPickaxe(", toolAdmission + 1));
        assertTrue(pricing.contains("player.getMainHandStack()"));
        assertFalse(pricing.contains("player.getInventory().size()"));
    }

    @Test
    void progressiveExecutionAdmitsPickaxesOnlyForTheLiveBreakTarget() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String apply = method(source, "private ControlDecision applyMissionStoneExecutionDecision(");

        int breakCase = apply.indexOf("case BREAK_BLOCK ->");
        int targetState = apply.indexOf("client.world.getBlockState(decision.breakTarget())", breakCase);
        int classification = apply.indexOf("ToolSelectionPlanner.decideForBlockId(", targetState);
        int requirement = apply.indexOf("ToolSelectionPlanner.Requirement.PICKAXE_REQUIRED", classification);
        int toolAdmission = apply.indexOf("ensureMissionStoneBestPickaxe(", requirement);
        int breakGate = apply.indexOf("if (!mayBreakThisTick)", toolAdmission);

        assertTrue(breakCase >= 0);
        assertTrue(targetState > breakCase);
        assertTrue(classification > targetState);
        assertTrue(requirement > classification);
        assertTrue(toolAdmission > requirement && breakGate > toolAdmission);
        assertTrue(apply.substring(toolAdmission, breakGate).contains("withInteraction(toolAdmission, interaction)"));
    }

    @Test
    void zeroProgressEntryMismatchReplansBeforeTheUnchangedTerminalFailurePath() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String apply = method(source, "private ControlDecision applyMissionStoneExecutionDecision(");
        String retire = method(source, "private ControlDecision tryRetireMissionStoneEntryPlan(");

        int rejectedCase = apply.indexOf("case REJECTED ->");
        int retirementAttempt = apply.indexOf("tryRetireMissionStoneEntryPlan(", rejectedCase);
        int transitionMemory = apply.indexOf("maybeRecordRejectedMissionStoneTransition(", retirementAttempt);
        int terminalFailure = apply.indexOf("failMineNearbyStone(", transitionMemory);
        assertTrue(rejectedCase >= 0);
        assertTrue(retirementAttempt > rejectedCase);
        assertTrue(transitionMemory > retirementAttempt);
        assertTrue(terminalFailure > transitionMemory);

        assertTrue(retire.contains("MissionStoneEntryPlanRetirementPolicy.evaluate(evidence)"));
        assertTrue(retire.contains(
            "recorded != MissionStoneEntryPlanMemory.RecordResult.RECORDED"));
        assertTrue(retire.contains("run.missionStoneExecution.reset()"));
        assertTrue(retire.contains("blockBreakController.reset()"));
        assertTrue(retire.contains("run.missionStonePlanningAttempted = false"));
        assertTrue(retire.contains("mine_nearby_stone.entry_plan.retired"));
        assertTrue(retire.contains("mine_nearby_stone.entry_plan.replanned"));
        assertFalse(retire.contains("run.startedAtMs ="), "the original command deadline is immutable");
        assertFalse(retire.contains("activeMineNearbyStone = null"));
        assertFalse(retire.contains("brainLink.completeCurrentCommand"));
    }

    @Test
    void plannerSuppressesOnlyRememberedStaircaseIdentitiesBeforeGlobalSelection() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String planning = method(source, "private MissionStonePlanningResult planMissionStoneMethod(");
        String suppression = method(
            source, "private static MissionStoneMethodPlanner.Decision suppressMissionStoneEntryPlan(");

        int context = planning.indexOf("synchronizeMissionStoneEntryPlanContext(client, voxel(origin))");
        int staircaseSampling = planning.indexOf("missionStoneStaircaseCandidate(", context);
        int memoryCheck = planning.indexOf("missionStoneEntryPlanMemory.contains(", staircaseSampling);
        int suppress = planning.indexOf("suppressMissionStoneEntryPlan(", memoryCheck);
        int globalSelection = planning.indexOf("MissionStoneMethodPlanner.selectCandidates(decisions)", suppress);
        assertTrue(context >= 0);
        assertTrue(staircaseSampling > context);
        assertTrue(memoryCheck > staircaseSampling);
        assertTrue(suppress > memoryCheck);
        assertTrue(globalSelection > suppress);

        assertTrue(suppression.contains(
            "evaluation.method() == MissionStoneMethodPlanner.Method.STAIRCASE"));
        assertTrue(suppression.contains("\"entry_plan_retired\""));
        assertTrue(planning.contains("suppressedEntryPlanCount == acceptedEntryPlanCount"));
        assertFalse(planning.contains("missionStoneEntryPlanMemory.retire("),
            "sampling can suppress evidence but cannot manufacture a retirement");
    }

    private static String method(String source, String signature) {
        int start = source.indexOf(signature);
        assertTrue(start >= 0, "missing method signature: " + signature);
        int openingBrace = source.indexOf('{', start);
        assertTrue(openingBrace >= 0, "missing method body: " + signature);
        int depth = 0;
        for (int index = openingBrace; index < source.length(); index++) {
            char current = source.charAt(index);
            if (current == '{') {
                depth++;
            } else if (current == '}') {
                depth--;
                if (depth == 0) {
                    return source.substring(start, index + 1);
                }
            }
        }
        throw new AssertionError("unterminated method: " + signature);
    }

    private static void assertLiveObservationGuardsPrune(String source) {
        int observation = source.indexOf("liveMissionStoneDropEntityIds(");
        int unconfirmed = source.indexOf("failMineNearbyStone(", observation);
        int prune = source.indexOf("MissionStoneDropBatch.pruneDisappearedEntity(", observation);

        assertTrue(observation >= 0);
        assertTrue(unconfirmed > observation);
        assertTrue(prune > unconfirmed);
        assertTrue(source.substring(observation, unconfirmed).contains("!disappearanceProven"));
    }

    private static String methodAfter(String source, String signature, int after) {
        int relative = source.substring(after).indexOf(signature);
        assertTrue(relative >= 0, "missing later method signature: " + signature);
        return method(source.substring(after + relative), signature);
    }

    private static String surrounding(
        String source,
        int first,
        int second,
        int padding
    ) {
        assertTrue(first >= 0 && second >= first);
        int start = Math.max(0, first - padding);
        int end = Math.min(source.length(), second + padding);
        return source.substring(start, end);
    }
}
