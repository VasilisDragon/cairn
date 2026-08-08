package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

final class VillageOpportunityExecutorIntegrationSourceTest {
    private static final Path EXECUTOR = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient",
        "VillageOpportunityExecutor.java");
    private static final Path CLIENT = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient",
        "McbotFabricClient.java");
    private static final Path BRAIN_LINK = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient",
        "BrainLink.java");
    private static final Path RETRIEVE_TABLE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient",
        "RetrieveTableExecutor.java");
    private static final Path USE_BED = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient",
        "UseBedExecutor.java");
    private static final Path CRAFT_2X2 = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient",
        "Craft2x2Executor.java");
    private static final Path ROUTE_SELECTOR = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient",
        "VillageRoutePlanSelector.java");

    @Test
    void heldTravelPublishesOneTerminalReceiptAndCompletionReason() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String client = Files.readString(CLIENT);
        String brain = Files.readString(BRAIN_LINK);
        String finish = method(executor, "private ControlDecision finish(");

        assertTrue(brain.contains("\"village_travel\".equals(action)"));
        assertTrue(client.contains("objectiveRegistry.register(villageOpportunityExecutor)"));
        assertTrue(client.contains("return villageOpportunityExecutor.isFinished(commandId)"));
        assertTrue(finish.indexOf("receipts.record(") < finish.lastIndexOf("clearActiveRun();"));
        assertTrue(finish.indexOf("ledger.markComplete(run.commandId, reason)")
            < finish.indexOf("shell.completeCurrentCommand(run.commandId, reason, nowMs)"));
    }

    @Test
    void receiptEchoesEveryCodeOwnedCorrelationFieldExactly() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String finish = method(executor, "private ControlDecision finish(");

        assertTrue(finish.contains("scope.worldId(),"));
        assertTrue(finish.contains("scope.dimension(),"));
        assertTrue(finish.contains("scope.mission(),"));
        assertTrue(finish.contains("session.detourId,"));
        assertTrue(finish.contains("run.detourStageSeq,"));
        assertTrue(finish.contains("run.commandId,"));
        assertTrue(finish.contains("run.action,"));
        assertTrue(finish.contains("run.opportunityId,"));
        assertTrue(finish.contains("run.opportunityRevision,"));
        assertTrue(finish.contains("run.stage,"));
    }

    @Test
    void inspectionRequiresTwoStablePollsBeforePublishingContents() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String stable = method(executor, "private static Map<String, Integer> stableContainerContents(");

        assertTrue(stable.contains("run.containerStablePolls = 1"));
        assertTrue(stable.contains("run.containerStablePolls += 1"));
        assertTrue(stable.contains("run.containerStablePolls >= 2 ? contents : null"));
    }

    @Test
    void acceptedContainerUseWaitsForHandlerBeforeRetrying() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String open = method(executor, "private ControlDecision openContainer(");
        String receipt = method(executor, "void observeInteractionReceipt(");

        int grace = open.indexOf("nowMs - run.containerUseAcceptedAtMs < CONTAINER_OPEN_GRACE_MS");
        int retryReset = open.indexOf("run.containerUseApplied = false");
        int allocate = open.indexOf("run.pendingUseRequestId = \"village-container:\"");
        assertTrue(grace >= 0 && retryReset > grace && allocate > retryReset);
        assertTrue(open.contains("village_container_wait_screen_open"));
        assertTrue(receipt.contains("run.containerUseAcceptedAtMs = run.containerUseApplied"));
        assertTrue(receipt.contains("receipt.timestampMs()"));
    }

    @Test
    void withdrawalAttributesOnlyTheExactPostInspectionTransfer() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String withdraw = method(executor, "private ControlDecision tickWithdraw(");
        String finish = method(executor, "private ControlDecision finish(");

        int stableRead = withdraw.indexOf("stableContainerContents(handler, run, nowMs)");
        int freezeBaseline = withdraw.indexOf("run.withdrawInventoryBaseline = inventoryCount(player, itemId)");
        assertTrue(stableRead >= 0 && freezeBaseline > stableRead);
        assertTrue(withdraw.contains("run.requestedCount - run.withdrawTransferred"));
        assertFalse(withdraw.contains("run.requestedCount - Math.max(0, gained)"));
        assertTrue(withdraw.contains("run.withdrawTransferred == run.requestedCount"));
        assertTrue(withdraw.contains("liveGain >= run.requestedCount"));
        assertFalse(withdraw.contains("gained == run.requestedCount"));
        assertTrue(withdraw.contains("removed != run.withdrawTransferred"));
        assertTrue(withdraw.contains(
            "run.authoritativeInventoryDelta = Map.of(itemId, run.requestedCount)"));
        assertTrue(finish.contains("run.authoritativeInventoryDelta != null"));
    }

    @Test
    void multiHayHarvestAdvancesOnlyAfterVerifiedInventoryGain() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String harvest = method(executor, "private ControlDecision tickHarvest(");
        String recovery = method(executor,
            "private ControlDecision tickHarvestOwnedDrop(");
        String accepted = method(executor,
            "private ControlDecision acceptHarvestInventoryGain(");
        String next = method(executor, "private boolean planNextHarvestTarget(");

        int targetAir = harvest.indexOf("boolean targetAir = state.isAir()");
        int ownedAirGate = harvest.indexOf(
            "if (!valid && (!run.segmentStarted || !targetAir))");
        int exactLook = harvest.indexOf("shell.lookIntentForBlock(");
        int exactDemand = harvest.indexOf("LookDemand.fromNormalDecision(");
        int confirmingAir = harvest.indexOf(
            "boolean confirmingOwnedAir = run.segmentStarted && targetAir");
        int aimGate = harvest.indexOf("shell.isLookingAtBlock(player, run.target)");
        int segmentStart = harvest.indexOf("run.segmentStarted = true");
        int breakTick = harvest.indexOf("shell.blockBreakController().tick(");
        int repositionFailure = harvest.indexOf(
            "result.status() == BlockBreakController.Status.REPOSITION");
        assertTrue(targetAir >= 0 && ownedAirGate > targetAir && exactLook > ownedAirGate);
        assertTrue(exactDemand > exactLook && confirmingAir > exactDemand && aimGate > confirmingAir);
        assertTrue(segmentStart > aimGate && breakTick > segmentStart);
        assertTrue(harvest.contains(
            "if (!confirmingOwnedAir && !shell.isLookingAtBlock(player, run.target))"));
        assertTrue(repositionFailure > breakTick);
        assertTrue(harvest.contains(
            "return new ControlDecision(look, InputState.stop(), lookDemand)"));
        assertTrue(harvest.contains("\"village_harvest_hay_break\""));
        assertTrue(harvest.contains("\"village_collect_bed_break\""));
        assertTrue(recovery.contains("targetInventory > run.segmentBaselineInventory"));
        assertTrue(accepted.contains("run.harvestAttributedCount += 1"));
        assertTrue(accepted.contains("run.consumedTargets.add(run.target.toImmutable())"));
        assertTrue(accepted.contains("planNextHarvestTarget(client, player, run, nowMs, hay)"));
        assertTrue(next.contains("run.consumedTargets.size() >= run.requestedCount"));
        assertTrue(next.contains("for (int dx = -8; dx <= 8; dx++)"));
        assertTrue(next.contains("for (int dy = -3; dy <= 3; dy++)"));
        assertTrue(next.contains("for (int dz = -8; dz <= 8; dz++)"));
        assertTrue(next.contains(".limit(VillageInteractionStancePlanner.MAX_AGGREGATE_TARGETS)"));
        assertTrue(next.contains("VillageInteractionStancePlanner.planAnyHarvest("));
        assertFalse(next.contains("for (BlockPos candidate : candidates)"));
    }

    @Test
    void hayAndBedDropsUseExactOwnedAttributionAndTraversalOnlyRecovery()
        throws IOException {
        String executor = Files.readString(EXECUTOR);
        String harvest = method(executor, "private ControlDecision tickHarvest(");
        String recovery = method(executor,
            "private ControlDecision tickHarvestOwnedDrop(");
        String plan = method(executor,
            "private ControlDecision selectHarvestDropRoute(");
        String observations = method(executor,
            "private static List<OwnedDropTracker.Observation> harvestItemObservations(");
        String clear = method(executor, "private void clearActiveRun()");

        assertTrue(harvest.contains("harvestItemSnapshot("));
        assertTrue(harvest.indexOf("harvestItemSnapshot(")
            < harvest.indexOf("shell.blockBreakController().tick("));
        assertTrue(harvest.contains("run.harvestDropTracker.beginAcquisition(nowMs)"));
        assertTrue(recovery.indexOf("targetInventory > run.segmentBaselineInventory")
            < recovery.indexOf("run.harvestDropTracker.update("));
        assertTrue(recovery.contains("VillageHarvestOwnedDropRecovery.decide("));
        assertTrue(plan.contains("CollectTarget3DPlanner.chooseTarget("));
        assertTrue(plan.contains("run.harvestDropTracker.recordRouteAttempt()"));
        assertTrue(plan.contains("run.startedAtMs + ACTION_TIMEOUT_MS"));
        assertTrue(plan.contains("session.replans += 1"));
        assertTrue(observations.contains(
            "VillageHarvestOwnedDropRecovery.exactItem(expectedItemId, itemId)"));
        assertTrue(clear.contains("activeRun.harvestDropTracker.reset()"));
        assertTrue(clear.contains("activeRun.harvestDropRouteController.clear()"));
        assertFalse(recovery.contains("resolveNavigationControl("));
        assertFalse(recovery.contains("tryNav3dDriveToward"));
        assertFalse(recovery.contains("blockBreakController().tick("));
        assertFalse(plan.contains("Constructive"));
    }

    @Test
    void lifecycleCleanupResetsRunSessionReceiptsLedgerAndNestedCrafts() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String clear = method(executor, "private void clearLifecycleState()");
        String manual = method(executor, "boolean prepareForManualTakeover(");
        String lifecycle = method(executor, "void clearForLifecycle(\n");
        String cleanup = method(executor, "private boolean prepareTerminalCleanup(");

        assertTrue(clear.contains("clearActiveRun();"));
        assertTrue(clear.contains("clearSession();"));
        assertTrue(clear.contains("receipts.clear();"));
        assertTrue(clear.contains("ledger.clear();"));
        assertTrue(manual.contains("prepareTerminalCleanup(client, player, activeRun, nowMs)"));
        assertTrue(manual.contains("TERMINAL_CLEANUP_TIMEOUT_MS"));
        assertTrue(manual.contains("MAX_TERMINAL_CLEANUP_ATTEMPTS"));
        assertTrue(manual.contains("player.closeHandledScreen()"));
        assertTrue(manual.contains("clearLifecycleState();"));
        assertTrue(lifecycle.contains("prepareTerminalCleanup(client, player, activeRun, nowMs)"));
        assertTrue(lifecycle.contains("player.closeHandledScreen()"));
        assertTrue(lifecycle.indexOf("prepareTerminalCleanup(")
            < lifecycle.indexOf("clearLifecycleState();"));
        assertTrue(cleanup.contains("terminal_cursor_return"));
        assertTrue(cleanup.contains("player.closeHandledScreen()"));
        assertTrue(cleanup.contains("shell.clearVillageCraftState(client, player, nowMs)"));
        assertTrue(executor.contains("TERMINAL_CLEANUP_TIMEOUT_MS"));
        assertTrue(executor.contains("MAX_TERMINAL_CLEANUP_ATTEMPTS"));
    }

    @Test
    void executorCannotReachGenericConstructionOrPerTickEntityScanning() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String safety = method(executor,
            "private String safetyFailure(MinecraftClient client, ClientPlayerEntity player)");

        assertFalse(executor.contains("tryNav3dDriveToward"));
        assertFalse(executor.contains("Constructive"));
        assertFalse(executor.contains("pillar"));
        assertFalse(executor.contains("bridge"));
        assertFalse(executor.contains("tunnel"));
        assertFalse(safety.contains("getEntitiesByClass"));
        assertFalse(safety.contains("iterateEntities"));
        assertTrue(safety.contains("liveScope.nearbyHostileCount() > 0"));
    }

    @Test
    void preReflexBookkeepingPrecedesBothSafetyControllersAndRollsBackCursor() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String client = Files.readString(CLIENT);
        String tick = method(client, "private void onClientTick(MinecraftClient client)");
        String preempt = method(executor, "void preemptForReflex(");

        int bookkeeping = tick.indexOf(
            "villageOpportunityExecutor.enforceInventoryTerminalBeforeReflex(");
        int combat = tick.indexOf("combatController.tick(client, player, nowMs)");
        int survival = tick.indexOf("survivalController.tick(client, player, nowMs)");
        assertTrue(bookkeeping >= 0 && bookkeeping < combat && combat < survival);
        assertTrue(tick.contains(
            "villageOpportunityExecutor.preemptForReflex(\n                client, player, effective, nowMs, \"combat\")"));
        assertTrue(tick.contains(
            "villageOpportunityExecutor.preemptForReflex(\n                client, player, effective, nowMs, \"survival\")"));
        assertTrue(preempt.contains("findCursorReturnSlot(handler, activeRun, cursor)"));
        assertTrue(preempt.contains("reflex_cursor_rollback"));
        assertTrue(preempt.contains("activeRun.terminalResult != null"));
        assertTrue(preempt.contains("nowMs - activeRun.lastClickAtMs >= GUI_CLICK_SETTLE_MS"));
        assertTrue(preempt.contains("activeRun.terminalResult = VillageOpportunityReceiptStore.Result.UNSAFE"));
    }

    @Test
    void lowFoodOutputsTerminalizeBeforeSurvivalWithoutPhysicalTableRecovery() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String client = Files.readString(CLIENT);
        String preReflex = method(executor, "void enforceInventoryTerminalBeforeReflex(");
        String preempt = method(executor, "void preemptForReflex(");
        String screenCleanup = method(executor,
            "private boolean prepareVerifiedBreadScreen(");
        String tick = method(client, "private void onClientTick(MinecraftClient client)");

        assertTrue(preReflex.contains("breadGain >= 1"));
        assertTrue(preReflex.contains(
            "shell.resolveVillageCraft3x3(client, player, subIntent, nowMs)"));
        assertTrue(preReflex.contains("recordVerifiedBread(activeRun, player)"));
        assertTrue(preReflex.indexOf("prepareVerifiedBreadScreen(")
            < preReflex.indexOf("recordVerifiedBread(activeRun, player)"));
        assertTrue(preReflex.indexOf("recordVerifiedBread(activeRun, player)")
            < preReflex.indexOf("ensureActionHotbar("));
        assertTrue(preReflex.contains(
            "activeRun.terminalResult = VillageOpportunityReceiptStore.Result.CRAFTED"));
        assertTrue(preReflex.contains(
            "Exact table retrieval is physical block breaking"));
        assertFalse(preReflex.contains("resolveVillageRetrieveTable("));
        assertFalse(preReflex.contains("blockBreakController().tick("));
        assertTrue(screenCleanup.contains("handler instanceof CraftingScreenHandler"));
        assertTrue(screenCleanup.contains("handler.getCursorStack().isEmpty()"));
        assertTrue(screenCleanup.contains("player.closeHandledScreen()"));
        assertTrue(screenCleanup.contains("shell.clearVillageCraftState(client, player, nowMs)"));
        assertTrue(screenCleanup.contains(
            "run.terminalResult = VillageOpportunityReceiptStore.Result.UNSAFE"));
        assertFalse(screenCleanup.contains("resolveVillageRetrieveTable("));
        assertFalse(screenCleanup.contains("blockBreakController().tick("));
        assertTrue(tick.indexOf("enforceInventoryTerminalBeforeReflex(")
            < tick.indexOf("survivalController.tick(client, player, nowMs)"));

        assertTrue(preReflex.contains("activeRun.withdrawPlayerGainVerified = true"));
        assertTrue(preempt.contains("activeRun.withdrawPlayerGainVerified"));
        assertTrue(preempt.contains(
            "exact player-side gain is already frozen"));
        assertTrue(preempt.contains("activeRun.breadCraftVerified"));
        assertTrue(preempt.contains("!activeRun.hotbarStagingVerified"));
    }

    @Test
    void physicalVillageActionsRequireActiveModeBeforeRunAdmission() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String client = Files.readString(CLIENT);
        String tick = method(executor, "public ControlDecision tick(TickContext ctx)");

        int gate = tick.indexOf("!executionEnabled.getAsBoolean()");
        int start = tick.indexOf("activeRun = startRun(intent, client, player, nowMs)");
        assertTrue(gate >= 0 && start > gate);
        assertTrue(tick.substring(gate, start).contains("opportunity_unavailable"));
        assertTrue(client.contains("() -> opportunityMode.executes()"));
    }

    @Test
    void onePhysicalReplanAndTypedTerminalEventsAreObservable() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String route = method(executor, "private ControlDecision tickRoute(");
        String finish = method(executor, "private ControlDecision finish(");
        String eventStem = method(executor, "private static String eventStem(String action)");

        assertTrue(route.contains("session.replans < 1"));
        assertTrue(route.contains("opportunity.detour.replanned"));
        assertTrue(route.contains("session.replans += 1"));
        assertTrue(route.indexOf("session.replans += 1")
            < route.indexOf("boolean replanned = planRoute("));
        assertTrue(route.contains("replanned ? \"accepted\" : \"rejected\""));
        assertTrue(finish.contains("village.opportunity.{}.{}"));
        assertTrue(finish.contains("targetItemId={}"));
        assertTrue(finish.contains("targetCount={}"));
        assertTrue(eventStem.contains("case \"village_withdraw_item\" -> \"withdraw\""));
        assertTrue(eventStem.contains("case \"village_harvest_hay\" -> \"hay\""));
        assertTrue(eventStem.contains("case \"village_craft_bread\" -> \"bread\""));
        assertTrue(eventStem.contains("case \"village_collect_bed\" -> \"bed\""));
    }

    @Test
    void travelUsesOpportunitySpecificStancesForPartialAndInteractiveBlocks() {
        assertEquals(
            VillageInteractionStancePlanner.Mode.EXACT_TRAVEL,
            VillageOpportunityExecutor.routeMode(
                "village_travel", "village_marker_cluster:root"));
        assertEquals(
            VillageInteractionStancePlanner.Mode.INTERACT_BLOCK,
            VillageOpportunityExecutor.routeMode(
                "village_travel", "container:chest"));
        assertEquals(
            VillageInteractionStancePlanner.Mode.HARVEST_BLOCK,
            VillageOpportunityExecutor.routeMode(
                "village_travel", "hay:bale"));
        assertEquals(
            VillageInteractionStancePlanner.Mode.HARVEST_BLOCK,
            VillageOpportunityExecutor.routeMode(
                "village_travel", "bed:red"));
        assertEquals(
            VillageInteractionStancePlanner.Mode.HARVEST_BLOCK,
            VillageOpportunityExecutor.routeMode(
                "village_collect_bed", "bed:red"));
    }

    @Test
    void occupiedTravelAnchorFallbackIsBoundedAndDoesNotSpendPhysicalReplan() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String selector = Files.readString(ROUTE_SELECTOR);
        String planRoute = method(executor, "private boolean planRoute(");

        assertTrue(planRoute.contains("VillageRoutePlanSelector.select("));
        assertTrue(planRoute.contains("run.routeComputations += selection.computations()"));
        assertTrue(selector.contains(
            "goalMode == VillageInteractionStancePlanner.Mode.EXACT_TRAVEL"));
        assertTrue(selector.contains("\"no_safe_stance\".equals(primary.reason())"));
        assertTrue(selector.contains(
            "VillageInteractionStancePlanner.Mode.INTERACT_BLOCK"));
        assertFalse(planRoute.contains("session.replans += 1"));
        assertTrue(planRoute.contains("\"village_travel\".equals(run.action),\n            true"));
    }

    @Test
    void remoteMemberFrontiersPreserveFinalModeAndCannotInteractEarly() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String selector = Files.readString(ROUTE_SELECTOR);
        String route = method(executor, "private ControlDecision tickRoute(");
        String plan = method(executor, "private boolean planRoute(");

        assertTrue(plan.contains("VillageRoutePlanSelector.Selection selection"));
        assertTrue(plan.contains("run.routeSelection == null"));
        assertTrue(plan.contains("run.routeSelection.goalMode()"));
        assertTrue(plan.contains("\"village_travel\".equals(run.action)"));
        assertTrue(route.contains("run.routeSelection.frontierStage()"));
        assertTrue(route.contains("run.routeSelection.goalMode()"));
        assertTrue(route.indexOf("run.routeSelection.frontierStage()")
            < route.indexOf("return stopped(intent, \"village_opportunity_route_reached\")"));
        assertTrue(selector.contains("boolean frontierStage"));
        assertTrue(selector.contains("return accepted() && !frontierStage"));
        assertTrue(selector.contains("boolean staged = travel.accepted()"));
    }

    @Test
    void revalidationForcesOneLiveTargetChunkBeforeAcceptingDiscovery() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String client = Files.readString(CLIENT);
        String start = method(executor, "private Run startRun(");
        String revalidate = method(executor, "private ControlDecision tickRevalidate(");
        String matches = method(executor, "private boolean discoveryMatches(Run run, DiscoveryFact fact)");
        String force = method(client,
            "private VillageOpportunityExecutor.DiscoveryFact forceRefreshVillageOpportunity(");

        assertTrue(revalidate.indexOf("discoveries.refresh(")
            < revalidate.indexOf("discoveryMatches(run, refreshed)"));
        assertTrue(revalidate.contains("run.opportunityId, run.rootTarget"));
        assertTrue(start.contains("canDeferMissingRevalidation("));
        assertTrue(start.contains("session.frozenTravelArrival"));
        assertTrue(force.contains("BlockPos frozenTarget"));
        assertTrue(force.contains("frozenTarget.toImmutable()"));
        assertTrue(force.contains("target.getX()"));
        assertTrue(force.contains("target.getZ()"));
        assertTrue(force.contains("getWorldChunk("));
        assertTrue(force.contains("chunkX, chunkZ, false"));
        assertTrue(force.contains("opportunityObservationCollector.forceChunkRefresh("));
        assertTrue(force.indexOf("opportunityObservationCollector.forceChunkRefresh(")
            < force.indexOf("refreshVillageOpportunitySnapshot(client, player, nowMs)"));
        assertTrue(force.indexOf("refreshVillageOpportunitySnapshot(client, player, nowMs)")
            < force.lastIndexOf("lookupVillageOpportunity(opportunityId)"));
        assertFalse(force.contains("cached.anchor()"));
        assertFalse(force.contains("for ("));
        assertFalse(force.contains("getEntities"));
        assertTrue(matches.contains("run.opportunityId.equals(fact.id())"));
        assertTrue(matches.contains("fact.safelyExecutable()"));
        assertTrue(matches.contains("fact.anchor().equals(run.target)"));
    }

    @Test
    void missingDiscoveryAdmissionRequiresTheExactProvenTravelArrival() {
        BlockPos target = new BlockPos(12, 64, -4);
        VillageOpportunityExecutor.FrozenTravelArrival primary =
            new VillageOpportunityExecutor.FrozenTravelArrival(
                "village-one", 7L, target, 3, "travel");
        VillageOpportunityExecutor.FrozenTravelArrival edge =
            new VillageOpportunityExecutor.FrozenTravelArrival(
                "hay-one", 11L, target, 8, "travel_edge");

        assertTrue(VillageOpportunityExecutor.canDeferMissingRevalidation(
            "village_revalidate", null, primary,
            "village-one", 7L, target, 4, "revalidate"));
        assertTrue(VillageOpportunityExecutor.canDeferMissingRevalidation(
            "village_revalidate", null, edge,
            "hay-one", 11L, target, 9, "revalidate_edge"));

        VillageOpportunityExecutor.DiscoveryFact unsafe =
            new VillageOpportunityExecutor.DiscoveryFact(
                "village-one", 8L, "village", target, "invalidated", false, List.of());
        assertFalse(VillageOpportunityExecutor.canDeferMissingRevalidation(
            "village_revalidate", unsafe, primary,
            "village-one", 7L, target, 4, "revalidate"));
        assertFalse(VillageOpportunityExecutor.canDeferMissingRevalidation(
            "village_travel", null, primary,
            "village-one", 7L, target, 4, "revalidate"));
        assertFalse(VillageOpportunityExecutor.canDeferMissingRevalidation(
            "village_revalidate", null, null,
            "village-one", 7L, target, 4, "revalidate"));
        assertFalse(VillageOpportunityExecutor.canDeferMissingRevalidation(
            "village_revalidate", null, primary,
            "village-two", 7L, target, 4, "revalidate"));
        assertFalse(VillageOpportunityExecutor.canDeferMissingRevalidation(
            "village_revalidate", null, primary,
            "village-one", 8L, target, 4, "revalidate"));
        assertFalse(VillageOpportunityExecutor.canDeferMissingRevalidation(
            "village_revalidate", null, primary,
            "village-one", 7L, target.east(), 4, "revalidate"));
        assertFalse(VillageOpportunityExecutor.canDeferMissingRevalidation(
            "village_revalidate", null, primary,
            "village-one", 7L, target, 5, "revalidate"));
        assertFalse(VillageOpportunityExecutor.canDeferMissingRevalidation(
            "village_revalidate", null, primary,
            "village-one", 7L, target, 4, "revalidate_edge"));
    }

    @Test
    void remoteRouteProofIsAcceptedOnlyForVillageRoots() {
        BlockPos target = new BlockPos(372, 64, 0);
        VillageOpportunityExecutor.DiscoveryFact village =
            new VillageOpportunityExecutor.DiscoveryFact(
                "village-one",
                1L,
                "village",
                target,
                "verified",
                true,
                List.of("route_reachable", "hazard_free"));
        VillageOpportunityExecutor.DiscoveryFact hay =
            new VillageOpportunityExecutor.DiscoveryFact(
                "hay-one",
                1L,
                "hay",
                target,
                "verified",
                true,
                List.of("route_reachable", "hazard_free"));
        VillageOpportunityExecutor.DiscoveryFact localHay =
            new VillageOpportunityExecutor.DiscoveryFact(
                "hay-one",
                1L,
                "hay",
                target,
                "verified",
                true,
                List.of("access_proven", "hazard_free"));

        assertTrue(village.safelyExecutable());
        assertFalse(hay.safelyExecutable());
        assertTrue(localHay.safelyExecutable());
    }

    @Test
    void missingInitialTravelDiscoveryRequiresAnExplicitlyTruncatedCatalog() {
        BlockPos target = new BlockPos(12, 64, -4);
        VillageOpportunityExecutor.DiscoveryFact invalidated =
            new VillageOpportunityExecutor.DiscoveryFact(
                "village-one", 8L, "village", target, "invalidated", false, List.of());

        assertTrue(VillageOpportunityExecutor.canDeferMissingTravel(
            "village_travel", null, true, target, "travel"));
        assertTrue(VillageOpportunityExecutor.canDeferMissingTravel(
            "village_travel", null, true, target, "travel_edge"));
        assertFalse(VillageOpportunityExecutor.canDeferMissingTravel(
            "village_travel", null, false, target, "travel"));
        assertFalse(VillageOpportunityExecutor.canDeferMissingTravel(
            "village_travel", invalidated, true, target, "travel"));
        assertFalse(VillageOpportunityExecutor.canDeferMissingTravel(
            "village_revalidate", null, true, target, "revalidate"));
        assertFalse(VillageOpportunityExecutor.canDeferMissingTravel(
            "village_travel", null, true, null, "travel"));
        assertFalse(VillageOpportunityExecutor.canDeferMissingTravel(
            "village_travel", null, true, target, "harvest_hay"));
    }

    @Test
    void travelProvenanceIsRecordedOnlyForArrivalAndClearedByRevalidation() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String finish = method(executor, "private ControlDecision finish(");

        assertTrue(finish.contains("\"village_travel\".equals(run.action)"));
        assertTrue(finish.contains(
            "result == VillageOpportunityReceiptStore.Result.ARRIVED"));
        assertTrue(finish.contains("new FrozenTravelArrival("));
        assertTrue(finish.contains("\"village_revalidate\".equals(run.action)"));
        assertTrue(finish.contains("session.frozenTravelArrival = null"));
    }

    @Test
    void prelaunchStageSequenceIsConsumedOnlyAfterCorrelatedOutcome() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String start = method(executor, "private Run startRun(");

        int runCreated = start.indexOf("Run run = new Run(");
        int firstStageCommit = start.indexOf("session.lastStageSeq = requestedStageSeq");
        assertTrue(runCreated >= 0 && firstStageCommit > runCreated);
        assertTrue(start.contains("run.terminalResult = VillageOpportunityReceiptStore.Result.INVALIDATED"));
        assertTrue(start.contains("run.terminalResult = VillageOpportunityReceiptStore.Result.UNAVAILABLE"));
    }

    @Test
    void breadStageBatchesOneToEightExactVerifiedNestedCrafts() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String start = method(executor, "private Run startRun(");
        String bread = method(executor, "private ControlDecision tickCraftBread(");
        String breadInFlight = method(
            executor, "private ControlDecision tickBreadCraftInFlight(");
        String breadTerminal = method(
            executor, "private ControlDecision finishBreadCraftInFlight(");
        String preReflex = method(
            executor, "void enforceInventoryTerminalBeforeReflex(");
        String next = method(executor, "private void prepareNextBreadBatchIteration(");
        String attribution = method(executor, "private static void recordVerifiedBread(");

        assertTrue(start.contains("\"village_craft_bread\".equals(action) && requested > 8"));
        int wheatInFlight = bread.indexOf("if (run.wheatCraftInFlight)");
        int hayAvailability = bread.indexOf(
            "inventoryCount(player, \"minecraft:hay_block\") <= 0");
        assertTrue(wheatInFlight >= 0 && wheatInFlight < hayAvailability);
        assertTrue(bread.contains("run.wheatCraftInFlight = true"));
        assertTrue(bread.contains("run.wheatCraftInFlight = false"));
        int breadLatch = bread.indexOf("if (run.breadCraftInFlight)");
        assertTrue(breadLatch >= 0 && breadLatch < hayAvailability);
        assertTrue(bread.contains("run.breadCraftInFlight = true"));
        assertTrue(breadInFlight.contains("shell.villageCraft3x3Finished(subcommand)"));
        assertTrue(breadInFlight.contains("shell.resolveVillageCraft3x3("));
        assertTrue(breadTerminal.contains("run.breadCraftInFlight = false"));
        assertTrue(preReflex.contains("activeRun.breadCraftInFlight = false"));
        assertTrue(breadTerminal.contains(
            "recordVerifiedBreadAndFinish(client, player, intent, run, nowMs)"));
        assertTrue(next.contains("run.craftSequence += 1"));
        assertTrue(next.contains("run.breadCraftInFlight = false"));
        assertTrue(next.contains("run.breadInventoryBaselineFrozen = false"));
        assertTrue(next.contains("run.breadBetweenCrafts = true"));
        assertTrue(attribution.contains("run.breadProducedCount + 1"));
        assertTrue(attribution.contains(
            "\"minecraft:bread\", run.breadProducedCount"));
    }

    @Test
    void temporaryFieldKitTableIsRecoveredBeforeBreadReceipt() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String bread = method(executor, "private ControlDecision tickCraftBread(");
        String verified = method(executor, "private ControlDecision recordVerifiedBreadAndFinish(");
        String finishVerified = method(executor, "private ControlDecision finishVerifiedBread(");
        String attribution = method(executor, "private static void recordVerifiedBread(");
        String recovery = method(executor, "private ControlDecision prepareTemporaryTableRecovery(");
        String finish = method(executor, "private ControlDecision finish(");

        assertTrue(bread.contains("run.temporaryTablePos = placedTable.toImmutable()"));
        assertTrue(bread.contains("run.temporaryTablePlacedCount = 1"));
        assertTrue(verified.contains("recordVerifiedBread(run, player)"));
        assertTrue(attribution.contains(
            "run.authoritativeInventoryDelta = Map.of("));
        assertTrue(attribution.contains("run.breadProducedCount"));
        assertTrue(finishVerified.contains("ensureActionHotbar("));
        assertTrue(finishVerified.indexOf("ensureActionHotbar(")
            < finishVerified.indexOf("run.phase = Phase.RETRIEVE_TABLE"));
        assertTrue(recovery.contains("shell.resolveVillageRetrieveTable("));
        assertTrue(recovery.contains(
            "reason.startsWith(\"retrieve_table_complete:table_item_delta_verified\")"));
        assertTrue(recovery.contains("inventoryTables >= baselineTables"));
        assertTrue(recovery.contains("exactBlockRemoved"));
        assertTrue(finish.indexOf("prepareTemporaryTableRecovery(")
            < finish.indexOf("receipts.record("));
        assertTrue(finish.contains("temporaryTablePlacedCount={}"));
        assertTrue(finish.contains("temporaryTableRecoveredCount={}"));
        assertTrue(finish.contains("inventoryTablesAfter={}"));
        assertTrue(finish.contains("reservedTablePreserved={}"));
    }

    @Test
    void exactTableRetrievalCannotSkipOrSelectAnotherTable() throws IOException {
        String retrieve = Files.readString(RETRIEVE_TABLE);
        String exact = method(retrieve, "public ControlDecision resolveExact(");
        String internal = method(retrieve, "private ControlDecision resolveInternal(");

        assertTrue(exact.contains(
            "resolveInternal(client, player, effective, nowMs, exactTable, true)"));
        assertTrue(internal.contains("exactRequired ? exactTable : null"));
        assertTrue(internal.contains("if (!run.exactRequired)"));
        assertTrue(internal.contains("retrieve_table_exact_reposition_required"));
        assertTrue(internal.contains("retrieve_table_exact_drop_outside_pickup"));
        int forcedTarget = internal.indexOf("exactRequired ? exactTable : null");
        int nearbySelection = internal.indexOf("shell.selectNearbyCraftingTable(client, player)");
        assertTrue(forcedTarget >= 0 && nearbySelection > forcedTarget);
    }

    @Test
    void actionCriticalVillageItemsAreHotbarVerifiedBeforeSuccessReceipt() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String withdraw = method(executor, "private ControlDecision tickWithdraw(");
        String bread = method(executor, "private ControlDecision finishVerifiedBread(");
        String harvest = method(executor, "private ControlDecision finishHarvest(");
        String staging = method(executor, "private HotbarStagingResult ensureActionHotbar(");

        assertTrue(executor.contains("\"minecraft:bread\""));
        assertTrue(executor.contains("\"minecraft:apple\""));
        assertTrue(executor.contains("\"minecraft:golden_apple\""));
        assertTrue(executor.contains("\"minecraft:iron_pickaxe\""));
        assertTrue(executor.contains("\"minecraft:water_bucket\""));
        assertTrue(executor.contains("\"minecraft:flint_and_steel\""));
        assertTrue(executor.contains("\"minecraft:shield\""));
        assertTrue(executor.contains("\"minecraft:bow\""));
        assertTrue(executor.contains("itemId.endsWith(\"_bed\")"));

        assertTrue(withdraw.indexOf("ensureActionHotbar(")
            < withdraw.indexOf("run.authoritativeInventoryDelta = Map.of"));
        assertTrue(bread.indexOf("ensureActionHotbar(")
            < bread.indexOf("VillageOpportunityReceiptStore.Result.CRAFTED"));
        assertTrue(harvest.indexOf("ensureActionHotbar(")
            < harvest.indexOf("VillageOpportunityReceiptStore.Result.COLLECTED"));
        assertTrue(harvest.indexOf("run.targetItemId = canonicalItem(run.segmentTargetItemId)")
            < harvest.indexOf("ensureActionHotbar("));
        assertTrue(staging.contains("shell.findHotbarSlot("));
        assertTrue(staging.contains("shell.moveInventoryItemToHotbarSlot("));
        assertTrue(staging.contains("run.hotbarMoveAttempted"));
        assertTrue(staging.contains("inventoryContainsAtLeast("));
        assertTrue(staging.contains("hotbarSlot == run.hotbarDestinationSlot"));
        assertTrue(staging.contains("return HotbarStagingResult.PENDING"));
        assertTrue(staging.contains("return HotbarStagingResult.FAILED"));
    }

    @Test
    void exactFullHotbarSwapConservesDisplacedStackAndNeverUsesContainer() throws IOException {
        String client = Files.readString(CLIENT);
        String exact = method(client, "public int moveInventoryItemToHotbarSlot(");

        assertTrue(exact.contains("findInventorySlot(player, itemPredicate, false)"));
        assertTrue(exact.contains("player.playerScreenHandler.syncId"));
        assertTrue(exact.contains("SlotActionType.SWAP"));
        assertTrue(exact.contains("displacedItemId"));
        assertTrue(exact.contains("displacedCount"));
        assertFalse(exact.contains("GenericContainerScreenHandler"));
        assertFalse(exact.contains("SlotActionType.THROW"));
        assertFalse(exact.contains("drop"));
    }

    @Test
    void routeReplanCountIsPublishedFromThePhysicalSession() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String finish = method(executor, "private ControlDecision finish(");

        assertTrue(finish.contains("run.containerRevision,\n            session.replans,"));
        assertTrue(finish.contains("routeReplanCount={}"));
    }

    @Test
    void stagedVillageBedIsUsableRegardlessOfColor() throws IOException {
        String useBed = Files.readString(USE_BED);
        String tick = method(useBed, "public ControlDecision tick(TickContext ctx)");

        assertTrue(tick.contains("itemId.endsWith(\"_bed\")"));
        assertTrue(tick.contains("bedStack.getItem() instanceof BlockItem bedItem"));
        assertTrue(tick.contains("bedItem.getBlock() instanceof BedBlock"));
        assertTrue(tick.contains("bedItem.getBlock(), false, true"));
        assertFalse(tick.contains("findHotbarSlotByItemId(player, \"white_bed\")"));
    }

    @Test
    void effectiveIntentReplacementIsLatchedBeforeReflexAndBlocksBaselineDispatch()
        throws IOException {
        String executor = Files.readString(EXECUTOR);
        String client = Files.readString(CLIENT);
        String tick = method(client, "private void onClientTick(MinecraftClient client)");
        String observe = method(executor, "void observeEffectiveIntentHandoff(");
        String cleanup = method(executor, "ControlDecision resolveEffectiveIntentHandoffCleanup(");
        String terminal = method(executor, "private ControlDecision completeHandoffBarrier(");
        String executorTick = method(executor, "public ControlDecision tick(TickContext ctx)");

        int effective = tick.indexOf("BrainLink.Intent effective = brainLink.effectiveIntent(nowMs)");
        int latch = tick.indexOf("villageOpportunityExecutor.observeEffectiveIntentHandoff(");
        int combat = tick.indexOf("combatController.tick(client, player, nowMs)");
        int survival = tick.indexOf("survivalController.tick(client, player, nowMs)");
        int physicalCleanup = tick.indexOf(
            "villageOpportunityExecutor.resolveEffectiveIntentHandoffCleanup(");
        int baseline = tick.indexOf("resolveControl(client, player, effective, nowMs)");
        assertTrue(effective >= 0 && latch > effective && latch < combat);
        assertTrue(combat < survival && survival < physicalCleanup && physicalCleanup < baseline);
        assertTrue(tick.contains("if (!villageHandoffPending)"));
        assertTrue(tick.contains("villageHandoffCleanup != null"));

        assertTrue(observe.contains("sameEffectiveIntent(run, effective)"));
        assertTrue(observe.contains("run.handoffCleanupPhase = HandoffCleanupPhase.GUI_AND_NESTED_CRAFT"));
        assertFalse(observe.contains("clickSlot("));
        assertFalse(observe.contains("prepareTemporaryTableRecovery("));
        assertTrue(cleanup.contains("prepareTerminalCleanup(client, player, run, nowMs)"));
        assertTrue(cleanup.contains("prepareTemporaryTableRecovery("));
        assertTrue(cleanup.contains("return completeHandoffBarrier("));
        assertTrue(terminal.contains("clearActiveRun();"));
        assertTrue(terminal.contains("clearSession();"));
        assertTrue(terminal.contains("receipts.clear();"));
        assertFalse(terminal.contains("ledger.clear();"));
        assertFalse(terminal.contains("completeCurrentCommand("));
        assertTrue(executorTick.contains("observeEffectiveIntentHandoff("));
        assertFalse(executorTick.substring(
            executorTick.indexOf("if (activeRun != null && !sameEffectiveIntent"),
            executorTick.indexOf("if (activeRun == null)")).contains("clearActiveRun();"));
    }

    @Test
    void handoffCleanupSerializesNestedCraftRollbackBeforeGenericStateClear()
        throws IOException {
        String executor = Files.readString(EXECUTOR);
        String client = Files.readString(CLIENT);
        String craft2x2 = Files.readString(CRAFT_2X2);
        String cleanup = method(executor, "private boolean prepareTerminalCleanup(");
        String rollback = method(craft2x2,
            "VillageNestedCraftCleanupResult prepareAbortCleanup(");
        String shell = method(client,
            "public VillageNestedCraftCleanupResult prepareVillageNestedCraftCleanup(");
        String tableRollback = method(client,
            "private VillageNestedCraftCleanupResult prepareCraft3x3AbortCleanup(");

        int nested = cleanup.indexOf("shell.prepareVillageNestedCraftCleanup(");
        int cursor = cleanup.indexOf("terminal_cursor_return", nested);
        int outerSettle = cleanup.indexOf(
            "nowMs - run.lastClickAtMs < GUI_CLICK_SETTLE_MS", nested);
        int clear = cleanup.lastIndexOf("shell.clearVillageCraftState(client, player, nowMs)");
        assertTrue(nested >= 0 && cursor > nested && outerSettle > nested && clear > cursor);
        assertTrue(cleanup.substring(nested, cursor)
            .contains("nested.status() == VillageNestedCraftCleanupResult.Status.PENDING"));
        String reflex = method(executor, "void preemptForReflex(");
        assertTrue(reflex.indexOf("shell.prepareVillageNestedCraftCleanup(")
            < reflex.indexOf("reflex_cursor_rollback"));
        assertTrue(reflex.contains("!nestedRollbackOwnsTick"));
        assertTrue(reflex.contains("if (!nestedRollbackOwnsTick\n"
            + "            && handler != null && handler != player.playerScreenHandler"));
        assertTrue(rollback.indexOf("handler.getCursorStack()")
            < rollback.indexOf("PLAYER_CRAFTING_INPUT_START"));
        assertTrue(rollback.contains("handoff_return_cursor"));
        assertTrue(rollback.contains("handoff_return_input"));
        assertTrue(rollback.contains("SlotActionType.QUICK_MOVE"));
        assertTrue(rollback.contains("CRAFT_CLICK_SETTLE_MS"));
        assertTrue(shell.indexOf("prepareCraft3x3AbortCleanup(")
            < shell.indexOf("craft2x2Executor.prepareAbortCleanup("));
        assertTrue(shell.contains("craft2x2Executor.prepareAbortCleanup("));
        assertTrue(tableRollback.indexOf("CRAFT_CLICK_SETTLE_MS")
            < tableRollback.indexOf("handoff_return_cursor"));
        assertTrue(tableRollback.indexOf("handoff_return_cursor")
            < tableRollback.indexOf("TABLE_CRAFTING_INPUT_START"));
        assertTrue(tableRollback.contains("handoff_return_input"));
        assertTrue(tableRollback.contains("SlotActionType.QUICK_MOVE"));
        assertTrue(tableRollback.indexOf("occupiedCraft3x3Inputs(handler)")
            < tableRollback.indexOf("player.closeHandledScreen()"));
    }

    @Test
    void switchTickTablePlacementCorrelationSurvivesDelayedWorldAndInventorySettle()
        throws IOException {
        String executor = Files.readString(EXECUTOR);
        String freeze = method(executor, "private void freezeSwitchTickTableCorrelation(");
        String reconcile = method(executor,
            "private void reconcileSwitchTickTemporaryTable(");
        String cleanup = method(executor, "ControlDecision resolveEffectiveIntentHandoffCleanup(");

        assertTrue(freeze.contains("isAwaitingVerification(tableCommand)"));
        assertTrue(freeze.contains("run.handoffTablePlacementCorrelated = true"));
        assertTrue(freeze.contains("run.handoffTablePlacementPos = exactTable.toImmutable()"));
        assertFalse(freeze.contains("getBlockState(exactTable)"));
        assertTrue(reconcile.contains("run.handoffTablePlacementCorrelated"));
        assertTrue(reconcile.contains("getBlockState(exactTable).isOf(Blocks.CRAFTING_TABLE)"));
        assertTrue(reconcile.contains("inventoryTables + 1 <= baselineTables"));
        assertTrue(reconcile.contains("run.temporaryTablePlacedCount = 1"));
        assertTrue(cleanup.contains("village_opportunity_handoff_table_settle"));
        assertTrue(cleanup.indexOf("reconcileSwitchTickTemporaryTable(")
            < cleanup.indexOf("prepareTemporaryTableRecovery("));
    }

    @Test
    void handoffPreemptionLetsReflexWinWithoutClearingNestedRecovery() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String preempt = method(executor, "void preemptForReflex(");

        assertTrue(preempt.contains("handoffPending"));
        assertTrue(preempt.contains("if (!matching && !handoffPending)"));
        assertTrue(preempt.contains("reflex_cursor_rollback"));
        assertFalse(preempt.contains("shell.clearVillageCraftState("));
        assertFalse(preempt.contains("prepareTemporaryTableRecovery("));
    }

    @Test
    void breadReceiptCarriesExactProducedBatchDespiteObservedConsumption()
        throws IOException {
        String executor = Files.readString(EXECUTOR);
        String finish = method(executor, "private ControlDecision finish(");
        String record = method(executor, "private static void recordVerifiedBread(");
        String between = method(executor, "private void prepareNextBreadBatchIteration(");

        assertTrue(record.contains("run.breadProducedCount"));
        assertTrue(record.contains("run.authoritativeInventoryDelta = Map.of("));
        assertTrue(record.contains("\"minecraft:bread\", run.breadProducedCount"));
        assertTrue(between.contains("run.breadBetweenCrafts = true"));
        assertTrue(finish.contains("producedCount={}"));
        assertTrue(finish.contains("observedBreadDelta={}"));
        assertTrue(finish.contains("foodLevelGain={}"));
        assertTrue(finish.contains("survivalConsumptionObserved={}"));
        assertTrue(finish.contains("run.authoritativeInventoryDelta != null"));
    }

    private static String method(String source, String signature) {
        int start = source.indexOf(signature);
        assertTrue(start >= 0, "missing source block " + signature);
        int open = source.indexOf('{', start);
        assertTrue(open >= 0, "missing source block body " + signature);
        int depth = 0;
        for (int index = open; index < source.length(); index++) {
            char value = source.charAt(index);
            if (value == '{') {
                depth += 1;
            } else if (value == '}') {
                depth -= 1;
                if (depth == 0) {
                    return source.substring(start, index + 1);
                }
            }
        }
        throw new AssertionError("unterminated source block " + signature);
    }
}
