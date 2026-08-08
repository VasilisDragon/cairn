package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

final class IronGolemOpportunityExecutorIntegrationSourceTest {
    private static final Path EXECUTOR = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient",
        "IronGolemOpportunityExecutor.java");
    private static final Path VILLAGE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient",
        "VillageOpportunityExecutor.java");
    private static final Path BRAIN_LINK = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient",
        "BrainLink.java");

    @Test
    void opaqueWireIdentityResolvesExactCachedGolemOnlyInsideJava() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String village = Files.readString(VILLAGE);
        String brain = Files.readString(BRAIN_LINK);

        assertTrue(village.contains("resolveExactIronGolem(client.world, opportunityId)"));
        assertTrue(executor.contains("resolver.resolve(client, opaqueOpportunityId)"));
        assertTrue(executor.contains("exactJavaUuid.equals(current.getUuid())"));
        assertTrue(executor.contains("target.getWorld() != client.world"));
        assertFalse(brain.contains("targetUuid"));
        assertFalse(brain.contains("targetIdentity"));
    }

    @Test
    void defensePackageUsesOnlyBoundedLocalRouteAndExactlyThreeVerifiedPlacements()
        throws IOException {
        String executor = Files.readString(EXECUTOR);

        assertTrue(executor.contains("IronGolemDefensePackagePlanner.plan("));
        assertTrue(executor.contains("VillageLocalRouteController inboundRoute"));
        assertTrue(executor.contains("IronGolemPillarController pillar"));
        assertTrue(executor.contains("cobblestone > 3"));
        assertTrue(executor.contains("expectedPillarBlocks.putIfAbsent("));
        assertTrue(executor.contains("client.world.getBlockState(pos).isOf(expected)"));
        assertTrue(executor.contains("village.opportunity.golem.pillar.placed"));
        assertFalse(executor.contains("resolveNavigationControl("));
        assertFalse(executor.contains("tryNav3dDriveToward"));
        assertFalse(executor.contains("blockBreakController().tick("));
    }

    @Test
    void attacksAdvanceOnlyFromAppliedMq3ReceiptsAndUseHitboxReach() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String receipt = method(executor, "void observeInteractionReceipt(");
        String activation = method(executor, "private Step tickTargetActivation(");
        String attack = method(executor, "private Step tickAttack(");

        assertTrue(executor.contains("case WAIT_TARGET_ACTIVE -> tickTargetActivation("));
        assertTrue(activation.contains("exact.isAiDisabled()"));
        assertTrue(activation.contains("TARGET_ACTIVATION_TIMEOUT_MS"));
        assertTrue(activation.contains("target_ai_disabled"));
        assertTrue(activation.contains("village.opportunity.golem.target_activated"));
        assertTrue(activation.contains("aiDisabled=false"));
        assertTrue(receipt.contains("attack.acknowledgeInteraction(receipt)"));
        assertTrue(receipt.contains("village.opportunity.golem.attack.pulse"));
        assertTrue(receipt.contains("result=applied"));
        assertFalse(attack.contains("village.opportunity.golem.attack.pulse"));
        assertTrue(attack.contains("village.opportunity.golem.attack.requested"));
        assertTrue(attack.contains("InteractionDemand.attackEntity("));
        assertTrue(attack.contains("EntityReachMetric.EYE_TO_HITBOX"));
        assertTrue(attack.contains("closestHitPoint(player, frozenTarget)"));
    }

    @Test
    void typedDeathOwnsOnlyExactThreeToFiveIronAndEscapesBeforeCollection()
        throws IOException {
        String executor = Files.readString(EXECUTOR);
        String attack = method(executor, "private Step tickAttack(");
        String drop = method(executor, "private Step tickDrop(");

        assertTrue(attack.contains("typedDeath ? exactUuid"));
        assertTrue(attack.contains("dropTracker.rebaseArmedOrigin("));
        assertTrue(attack.contains("dropTracker.beginAcquisition(nowMs)"));
        assertTrue(attack.indexOf("attack.beginEscape(\"typed_death_confirmed\"")
            < attack.indexOf("return beginEscape("));
        assertTrue(executor.contains("phase == Phase.ESCAPE"));
        assertTrue(executor.contains("observeOwnedDrop(client, nowMs)"));
        assertTrue(drop.contains("CollectTarget3DPlanner.chooseTarget("));
        assertTrue(drop.contains("collectionEndpointWithinBounds(start, dropCell)"));
        assertTrue(drop.contains("client.world, start, dropCell"));
        assertEquals(16, IronGolemOpportunityExecutor.COLLECTION_HORIZONTAL_RADIUS);
        assertTrue(executor.contains("dropTracker.attributedStackDelta() != ironGain"));
        assertTrue(executor.contains("ironGain < 3 || ironGain > 5"));
        assertTrue(executor.contains("entity.getStack().isOf(Items.IRON_INGOT)"));
        assertFalse(executor.contains("Items.POPPY"));
    }

    @Test
    void collectionEnvelopeCoversCommittedEscapeWithoutBecomingAnUnboundedScan() {
        VoxelCell start = new VoxelCell(600, 149, 600);

        assertTrue(IronGolemOpportunityExecutor.collectionEndpointWithinBounds(
            start, new VoxelCell(615, 153, 599)));
        assertFalse(IronGolemOpportunityExecutor.collectionEndpointWithinBounds(
            start, new VoxelCell(617, 149, 600)));
        assertFalse(IronGolemOpportunityExecutor.collectionEndpointWithinBounds(
            start, new VoxelCell(616, 149, 584)));
        assertFalse(IronGolemOpportunityExecutor.collectionEndpointWithinBounds(
            start, new VoxelCell(600, 154, 600)));
        assertTrue(IronGolemOpportunityExecutor.collectionRouteWithinBounds(
            java.util.Collections.nCopies(20, start)));
        assertFalse(IronGolemOpportunityExecutor.collectionRouteWithinBounds(
            java.util.Collections.nCopies(21, start)));
    }

    @Test
    void villageReceiptPublishesOpaqueTargetAndAuthoritativeIronDelta() throws IOException {
        String village = Files.readString(VILLAGE);
        String tick = method(village, "private ControlDecision tickDefeatIronGolem(");
        String finish = method(village, "private ControlDecision finish(");
        String preempt = method(village, "void preemptForReflex(");

        assertTrue(village.contains("\"village_defeat_iron_golem\""));
        assertTrue(tick.contains("run.authoritativeInventoryDelta ="));
        assertTrue(tick.contains("VillageOpportunityReceiptStore.Result.COLLECTED"));
        assertTrue(finish.contains("? run.opportunityId"));
        assertTrue(preempt.contains("ironGolemExecutor.engaged()"));
        assertTrue(preempt.contains("ironGolemExecutor.ownsSafetyEscape()"));
        assertTrue(village.contains("ironGolemExecutor.observeInteractionReceipt(receipt)"));
        assertTrue(village.contains("ironGolemExecutor.clear()"));
        assertTrue(VillageOpportunityExecutor.opensSessionAtActionAdmission(
            "village_defeat_iron_golem"));
        assertTrue(VillageOpportunityExecutor.opensSessionAtActionAdmission(
            "village_travel"));
        assertFalse(VillageOpportunityExecutor.opensSessionAtActionAdmission(
            "village_inspect_container"));
        String startRun = method(village, "private Run startRun(");
        assertTrue(startRun.contains("opensSessionAtActionAdmission(action)"));
        assertTrue(startRun.contains("session = new Session"));
    }

    @Test
    void fixtureTelemetryIsTransitionOrReceiptDrivenAndComplete() throws IOException {
        String executor = Files.readString(EXECUTOR);

        assertTrue(executor.contains("village.opportunity.golem.defense.selected"));
        assertTrue(executor.contains("village.opportunity.golem.defense.ready"));
        assertTrue(executor.contains("village.opportunity.golem.target_activated"));
        assertTrue(executor.contains("village.opportunity.golem.attack.started"));
        assertTrue(executor.contains("village.opportunity.golem.killed"));
        assertTrue(executor.contains("entityType=minecraft:iron_golem"));
        assertTrue(executor.contains("village.opportunity.golem.drop.latched"));
        assertTrue(executor.contains("village.opportunity.golem.drop.settled"));
        assertTrue(executor.contains("village.opportunity.golem.drop.recovered"));
        assertTrue(executor.contains("village.opportunity.golem.completed"));
        assertTrue(executor.contains(
            "golem.pillar.placed instanceId={} commandId={} opportunityId={} targetUuid={}"));
        assertTrue(executor.contains(
            "golem.drop.latched instanceId={} commandId={} opportunityId={} targetUuid={}"));
        assertTrue(executor.contains(
            "golem.drop.settled instanceId={} commandId={} opportunityId={} targetUuid={}"));
        assertTrue(executor.contains(
            "golem.drop.recovered instanceId={} commandId={} opportunityId={} targetUuid={}"));
        assertTrue(executor.contains(
            "golem.completed instanceId={} commandId={} opportunityId={} targetUuid={}"));
        assertTrue(executor.contains(
            "golem.rejected instanceId={} commandId={} opportunityId={} targetUuid={}"));
        assertTrue(executor.contains("dropEntity={} attributedIron={}"));
        assertTrue(executor.contains("inventoryDeltaVerified=true"));
        assertTrue(executor.contains("inventoryIronIngotBefore"));
        assertTrue(executor.contains("inventoryIronIngotAfter"));
        assertTrue(executor.contains("fillerBefore"));
        assertTrue(executor.contains("fillerAfter"));
        assertTrue(executor.contains("pillarBlocksPlaced"));
        assertTrue(executor.contains("village.opportunity.golem.rejected"));
        assertTrue(method(executor, "private Step reject(").contains(
            "logRejectedOnce(intent, outcome, reason)"));
        assertTrue(method(executor, "private Step terminal(").contains(
            "logRejectedOnce(intent, outcome, reason)"));
    }

    @Test
    void liveGolemEscapeUsesActualHitboxReachPlusMargin() {
        IronGolemDefensePackagePlanner.EntityBounds bounds =
            new IronGolemDefensePackagePlanner.EntityBounds(
                0.0D, 0.0D, 0.0D, 1.4D, 2.7D, 1.4D);

        assertFalse(IronGolemOpportunityExecutor.outsideLiveGolemReach(
            new VoxelCell(4, 0, 0), bounds));
        assertTrue(IronGolemOpportunityExecutor.outsideLiveGolemReach(
            new VoxelCell(5, 0, 0), bounds));
        assertTrue(IronGolemOpportunityExecutor.outsideLiveGolemReach(
            new VoxelCell(0, 7, 0), bounds));
    }

    @Test
    void validatedGolemRouteDescentUsesOnlyTheExistingNarrowEdgeExemption() {
        assertEquals(
            "golem_safe_escape",
            IronGolemOpportunityExecutor.routeDriveReason("golem_safe_escape", false));
        assertEquals(
            "village_opportunity_route_golem_safe_escape_nav3d_descend",
            IronGolemOpportunityExecutor.routeDriveReason("golem_safe_escape", true));
    }

    @Test
    void handoffAndEveryPostEngagementTickOwnThePreReflexBarrier() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String village = Files.readString(VILLAGE);
        String client = Files.readString(Path.of(
            "src", "main", "java", "com", "mcbot", "fabricclient",
            "McbotFabricClient.java"));
        String tick = method(client, "private void onClientTick(MinecraftClient client)");
        String barrier = method(executor, "boolean needsPreReflexSafetyBarrier(");
        String handoff = executor.substring(
            executor.indexOf("boolean requestSafeHandoff("),
            executor.indexOf("boolean needsPreReflexSafetyBarrier("));

        assertTrue(village.contains("run.golemHandoffBarrier = true"));
        assertTrue(village.contains("ironGolemExecutor.requestSafeHandoff("));
        assertTrue(village.contains("resolveEngagedGolemSafetyBeforeReflex("));
        assertTrue(barrier.contains("|| attack.engaged()"));
        assertFalse(handoff.contains("attack.beginEscape("));
        assertTrue(executor.contains("requestPostEngagementEscape("));
        int barrierIndex = tick.indexOf("resolveEngagedGolemSafetyBeforeReflex(");
        int combat = tick.indexOf("combatController.tick(client, player, nowMs)");
        int survival = tick.indexOf("survivalController.tick(client, player, nowMs)");
        assertTrue(barrierIndex >= 0 && barrierIndex < combat && combat < survival);
        assertTrue(tick.contains("if (engagedGolemSafetyBarrier == null)"));
    }

    @Test
    void benignHandoffFinishesExactTargetWhileTrueSafetyFailuresDisconnectOnce()
        throws IOException {
        String executor = Files.readString(EXECUTOR);
        String attack = method(executor, "private Step tickAttack(");
        String escape = method(executor, "private Step tickEscape(");
        String emergency = method(executor, "private Step emergencySafetyTerminal(");
        String disconnect = method(executor, "private void requestEmergencyDisconnect(");
        String handoff = executor.substring(
            executor.indexOf("boolean requestSafeHandoff("),
            executor.indexOf("boolean needsPreReflexSafetyBarrier("));
        String safety = executor.substring(
            executor.indexOf("void requestPostEngagementEscape("),
            executor.indexOf("void clear()"));

        assertTrue(handoff.contains("protectedFinishRequested = phase == Phase.ATTACK"));
        assertFalse(handoff.contains("terminalAfterEscape = true"));
        assertTrue(attack.contains("protectedFinishRequested"));
        assertTrue(attack.contains("protectedFinish ? engagementHealthBaseline"));
        assertTrue(attack.contains("protectedFinish ? 0 : Math.max(0, nearbyHostileCount)"));
        assertTrue(attack.contains("protected_finish_impossible:"));
        assertTrue(attack.contains("attack.beginEscape(\"typed_death_confirmed\""));
        assertFalse(safety.contains("attack.beginEscape("));
        assertTrue(safety.contains("pendingEmergencySafetyReason = safety"));

        assertTrue(emergency.contains("requestEmergencyDisconnect(client, classified)"));
        assertTrue(disconnect.contains("if (emergencyDisconnectRequested)"));
        assertTrue(disconnect.contains("emergencyDisconnectRequested = true"));
        assertTrue(disconnect.contains("handler.getConnection().disconnect("));
        assertFalse(escape.contains("golem_safe_escape_threat_barrier"));
        assertFalse(escape.contains("golem_safe_escape_geometry_barrier"));
        assertFalse(escape.contains("golem_safe_escape_route_barrier"));
        assertTrue(escape.contains("post_death_escape_geometry_invalidated"));
        assertTrue(escape.contains("plan.escapeRoute().getLast()"));
        assertTrue(escape.contains("escapeRoute.finalArrivalPendingAt(escapeEndpoint)"));
        assertTrue(escape.contains("post_death_safe_escape_"));
    }

    @Test
    void protectedFinishFeasibilityFailsClosedByExactRuntimeCause() {
        assertEquals("exact_target_unavailable",
            IronGolemOpportunityExecutor.protectedFinishImpossibleReason(
                false, true, true, true));
        assertEquals("defense_geometry_invalidated",
            IronGolemOpportunityExecutor.protectedFinishImpossibleReason(
                true, false, true, true));
        assertEquals("target_out_of_hitbox_reach",
            IronGolemOpportunityExecutor.protectedFinishImpossibleReason(
                true, true, false, true));
        assertEquals("target_line_of_sight_blocked",
            IronGolemOpportunityExecutor.protectedFinishImpossibleReason(
                true, true, true, false));
        assertEquals("",
            IronGolemOpportunityExecutor.protectedFinishImpossibleReason(
                true, true, true, true));
    }

    @Test
    void runtimeWeaponSelectionMatchesStoneOrBetterAdmission() throws IOException {
        String executor = Files.readString(EXECUTOR);
        String selector = method(executor, "private static boolean isQualifyingSword(");

        assertTrue(selector.contains("stone_sword"));
        assertTrue(selector.contains("iron_sword"));
        assertTrue(selector.contains("diamond_sword"));
        assertTrue(selector.contains("netherite_sword"));
        assertFalse(selector.contains("wooden_sword"));
        assertFalse(selector.contains("golden_sword"));
        assertTrue(executor.contains("qualifyingSwordDurability(player)"));
        assertTrue(executor.contains("ensureQualifyingSwordHotbar("));
    }

    private static String method(String source, String signature) {
        int start = source.indexOf(signature);
        if (start < 0) {
            return "";
        }
        int next = source.indexOf("\n    private ", start + signature.length());
        if (next < 0) {
            next = source.indexOf("\n    static ", start + signature.length());
        }
        return next < 0 ? source.substring(start) : source.substring(start, next);
    }
}
