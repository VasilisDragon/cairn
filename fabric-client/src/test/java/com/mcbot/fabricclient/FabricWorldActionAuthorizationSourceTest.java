package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class FabricWorldActionAuthorizationSourceTest {
    @Test
    void finalBlockSinksAuthorizeAtThePhysicalBoundaryBeforeMutationOrUse()
        throws IOException {
        String source = Files.readString(sourcePath("FabricInteractionAuthority.java"));
        int dispatch = source.indexOf("private DispatchResult dispatch(");
        int breakCase = source.indexOf("case BREAK_PROGRESS -> {", dispatch);
        int breakLock = source.indexOf("synchronized (worldActionAuthorization)", breakCase);
        int breakAuthorization = source.indexOf(
            "authorizeBlockPayloadAtPhysicalBoundary(", breakLock);
        int breakSink = source.indexOf(
            "client.interactionManager.updateBlockBreakingProgress(", breakCase);
        int useCase = source.indexOf("case USE_BLOCK -> {", breakSink);
        int useLock = source.indexOf("synchronized (worldActionAuthorization)", useCase);
        int useAuthorization = source.indexOf(
            "authorizeBlockPayloadAtPhysicalBoundary(", useLock);
        int useSink = source.indexOf("client.interactionManager.interactBlock(", useCase);
        int resolver = source.indexOf(
            "private FabricWorldActionAuthorization.Decision "
                + "authorizeBlockPayloadAtPhysicalBoundary(", useSink);
        int heldItemGate = source.indexOf(
            "heldItemRequirementMatches(player, payload)", resolver);
        int currentProtection = source.indexOf(
            "targetProtection.evaluate(client, affectedPositions)", resolver);
        int capabilityGate = source.indexOf(
            "worldActionAuthorization.authorizeAtEpoch(", currentProtection);

        assertTrue(dispatch >= 0);
        assertTrue(breakCase >= 0 && breakLock >= 0 && breakAuthorization >= 0 && breakSink >= 0);
        assertTrue(useCase >= 0 && useLock >= 0 && useAuthorization >= 0 && useSink >= 0);
        assertTrue(breakCase < breakLock && breakLock < breakAuthorization);
        assertTrue(breakAuthorization < breakSink);
        assertTrue(useCase < useLock && useLock < useAuthorization);
        assertTrue(useAuthorization < useSink);
        assertTrue(useSink < resolver && resolver < heldItemGate);
        assertTrue(heldItemGate < currentProtection);
        assertTrue(currentProtection < capabilityGate);
    }

    @Test
    void productionBlockPayloadsUseExplicitCodeOwnedCapabilities() throws IOException {
        String breaker = Files.readString(sourcePath("BlockBreakController.java"));
        String placer = Files.readString(sourcePath("BlockPlaceController.java"));
        String bed = Files.readString(sourcePath("UseBedExecutor.java"));
        String village = Files.readString(sourcePath("VillageOpportunityExecutor.java"));

        assertTrue(breaker.contains("BlockAuthorization.naturalResource()"));
        assertTrue(placer.contains("BlockAuthorization.naturalAnchor()"));
        assertTrue(placer.contains("Payload.bedPlacement("));
        assertTrue(placer.contains("activeSpec.footprint() == PlacementFootprint.BED"));
        assertTrue(bed.contains("BlockAuthorization.naturalAnchor()"));
        assertTrue(bed.contains("Payload.bedUse("));
        assertTrue(bed.contains("BlockPlaceController.PlaceSpec.bed("));
        assertTrue(village.contains("BlockAuthorization.naturalAnchor()"));

        int actualBreakTarget = breaker.indexOf("BlockPos breakTarget =");
        int breakPayload = breaker.indexOf("Payload.blockBreak(", actualBreakTarget);
        int breakPayloadEnd = breaker.indexOf(");", breakPayload);
        assertTrue(actualBreakTarget >= 0 && actualBreakTarget < breakPayload);
        assertTrue(breakPayloadEnd > breakPayload);
        assertTrue(breaker.substring(breakPayload, breakPayloadEnd).contains("breakTarget"));

        assertTrue(placer.contains("Payload.blockPlacement("));
        assertTrue(placer.contains("? List.of(placePos)"));
        assertTrue(!placer.contains("affectedPlacementPositions"));
        assertTrue(!placer.contains("getHorizontalFacing()"));
    }

    @Test
    void productionProtectionIsLiveOwnedWorldScopedAndCannotBeCallerStamped() throws IOException {
        String client = Files.readString(sourcePath("McbotFabricClient.java"));
        String payload = Files.readString(sourcePath("FabricInteractionAuthority.java"));
        String authorization = Files.readString(sourcePath("FabricWorldActionAuthorization.java"));
        String protection = Files.readString(sourcePath("FabricTargetProtection.java"));

        assertTrue(client.contains("private final FabricTargetProtection targetProtection"));
        assertTrue(client.contains(
            "new FabricInteractionAuthority(instanceId, LOGGER, motionMode, targetProtection)"));
        assertTrue(protection.contains("MCBOT_FABRIC_DO_NOT_TOUCH_REGIONS"));
        assertTrue(protection.contains("observation.worldIdentity()"));
        assertTrue(protection.contains("client.world.getRegistryKey().getValue().toString()"));
        assertTrue(payload.contains("List<BlockPos> affectedBlockPositions"));
        assertTrue(!authorization.contains("boolean doNotTouch"));
        assertTrue(!authorization.contains("protectedByDoNotTouch"));
    }

    @Test
    void heldItemStartsThroughTheItemOnlyPhysicalSink() throws IOException {
        String source = Files.readString(sourcePath("FabricInteractionAuthority.java"));
        int dispatch = source.indexOf("private DispatchResult dispatch(");
        int holdCase = source.indexOf("case HOLD_ITEM -> {", dispatch);
        int itemSink = source.indexOf("client.interactionManager.interactItem(", holdCase);
        int accepted = source.indexOf("if (!actionResult.isAccepted())", itemSink);
        int held = source.indexOf("DispatchResult.applied(actionResult", accepted);

        assertTrue(holdCase >= 0 && holdCase < itemSink && itemSink < accepted && accepted < held);
        assertTrue(source.indexOf("client.interactionManager.interactBlock(", holdCase) < 0);
    }

    @Test
    void blockUseBindsTheLiveMainHandBeforeAuthorizationAndPhysicalDispatch() throws IOException {
        String authority = Files.readString(sourcePath("FabricInteractionAuthority.java"));
        String placer = Files.readString(sourcePath("BlockPlaceController.java"));
        String client = Files.readString(sourcePath("McbotFabricClient.java"));
        String bed = Files.readString(sourcePath("UseBedExecutor.java"));
        String village = Files.readString(sourcePath("VillageOpportunityExecutor.java"));

        int resolver = authority.indexOf(
            "private FabricWorldActionAuthorization.Decision authorizeBlockPayload(");
        int heldItemGate = authority.indexOf(
            "heldItemRequirementMatches(player, payload)", resolver);
        int footprint = authority.indexOf(
            "resolveAffectedBlockPositions(client, payload)", heldItemGate);
        int policy = authority.indexOf("worldActionAuthorization.authorize(", footprint);
        assertTrue(resolver >= 0 && resolver < heldItemGate);
        assertTrue(heldItemGate < footprint && footprint < policy);
        assertTrue(authority.contains("HeldItemRequirement.emptyMainHand()"));
        assertTrue(authority.contains("HeldItemRequirement.exactBlockItem(expectedBlock)"));
        assertTrue(authority.contains("HeldItemRequirement.exactBlockItem(expectedBedBlock)"));
        assertTrue(authority.contains("hand == Hand.MAIN_HAND"));

        int pending = placer.indexOf("if (pendingDemand != null) {");
        int reselect = placer.indexOf("findHotbarSlot(player, activeSpec)", pending);
        int pendingReturn = placer.indexOf("return new Result(", reselect);
        assertTrue(pending >= 0 && pending < reselect && reselect < pendingReturn);
        assertTrue(placer.contains("blockItem.getBlock() != spec.block()"));
        assertTrue(placer.contains("activeSpec.block(),"));

        assertTrue(client.contains("reason + \"_empty_main_hand_required\""));
        assertTrue(client.contains("return -1;"));
        assertTrue(bed.contains("selectEmptyMainHandSlot(player)"));
        assertTrue(village.contains("selectEmptyMainHandSlot(player)"));
    }

    @Test
    void heldUseKeyExistsOnlyInsideAValidatedStartToEndTickWindow() throws IOException {
        String source = Files.readString(sourcePath("FabricInteractionAuthority.java"));
        String client = Files.readString(sourcePath("McbotFabricClient.java"));
        int prepare = source.indexOf("void prepareItemContinuation(");
        int alreadyUsing = source.indexOf("player.isUsingItem()", prepare);
        int startPress = source.indexOf("setUsePressed(client, true);", alreadyUsing);
        int commit = source.indexOf("InteractionAppliedReceipt commit(");
        int neutralize = source.indexOf("clearSyntheticUseKey(client);", commit);
        int dispatch = source.indexOf("DispatchResult result = dispatch(", neutralize);
        int established = source.indexOf("boolean itemHoldEstablished", dispatch);
        int acknowledge = source.indexOf("legacyState =", established);

        assertTrue(prepare >= 0 && prepare < alreadyUsing && alreadyUsing < startPress);
        assertTrue(commit < neutralize && neutralize < dispatch);
        assertTrue(dispatch < established && established < acknowledge);
        assertTrue(!source.substring(dispatch, acknowledge).contains(
            "setUsePressed(client, true)"));
        assertTrue(client.contains("ClientTickEvents.START_CLIENT_TICK.register("));
        assertTrue(client.contains("interactionAuthority::prepareItemContinuation"));
    }

    @Test
    void finalLiveGeometryCoversBedsChestsAndDoubleHeightBreaks() throws IOException {
        String source = Files.readString(sourcePath("FabricInteractionAuthority.java"));
        int affectedResolverStart = source.indexOf(
            "private static List<BlockPos> resolveAffectedBlockPositions(");
        int placementResolverStart = source.indexOf(
            "static List<BlockPos> resolvePlacementFootprint(");
        int breakResolverStart = source.indexOf("static List<BlockPos> resolveBreakFootprint(");
        int useResolverStart = source.indexOf("static List<BlockPos> resolveUseFootprint(");
        String affectedResolver = source.substring(affectedResolverStart, placementResolverStart);
        String placementResolver = source.substring(placementResolverStart, breakResolverStart);
        String breakResolver = source.substring(breakResolverStart, useResolverStart);

        assertTrue(source.contains("resolveAffectedBlockPositions(client, payload)"));
        assertTrue(source.contains("case USE_LIVE, BED_USE_LIVE"));
        assertTrue(source.contains("state.contains(BedBlock.PART)"));
        assertTrue(source.contains("state.contains(ChestBlock.CHEST_TYPE)"));
        assertTrue(source.contains("Properties.DOUBLE_BLOCK_HALF"));
        assertTrue(source.contains("state.contains(Properties.DOUBLE_BLOCK_HALF)"));
        assertTrue(source.contains("counterpartState.getBlock() != state.getBlock()"));
        assertTrue(!source.contains("boolean doubleHeightPlant"));
        assertTrue(source.contains("conservativeBedPlacementFootprint("));
        assertTrue(affectedResolver.contains("conservativeLiveBedPlacementFootprint("));
        assertTrue(affectedResolver.contains("conservativeLivePlacementFootprint("));
        assertTrue(breakResolver.contains("state.getBlock() instanceof BedBlock"));
        assertTrue(breakResolver.contains(
            "resolveBedUseFootprint(stableTarget, state, stateLookup)"));
        assertTrue(breakResolver.contains("state.getBlock() instanceof ChestBlock"));
        assertTrue(breakResolver.contains(
            "resolveChestUseFootprint(stableTarget, state, stateLookup)"));
        assertTrue(breakResolver.indexOf("state.getBlock() instanceof BedBlock")
            < breakResolver.indexOf("state.contains(Properties.DOUBLE_BLOCK_HALF)"));
        assertTrue(breakResolver.indexOf("state.getBlock() instanceof ChestBlock")
            < breakResolver.indexOf("state.contains(Properties.DOUBLE_BLOCK_HALF)"));
        assertTrue(affectedResolver.contains("case PLACEMENT -> resolvePlacementFootprint("));
        assertTrue(affectedResolver.contains("case BED_PLACEMENT -> resolvePlacementFootprint("));
        assertTrue(placementResolver.contains(
            "resolveBreakFootprint(declaredPosition, stateLookup)"));
        assertTrue(placementResolver.contains("resolveUseFootprint("));
        assertTrue(placementResolver.contains("BlockTargetSemantics.USE_LIVE"));
        assertTrue(source.contains("state.contains(Properties.DOUBLE_BLOCK_HALF)"));
        assertTrue(placementResolver.contains(
            "if (breakFootprint.isEmpty() || useFootprint.isEmpty())"));
    }

    @Test
    void everyBlockMutationRechecksCountAndEpochAtThePhysicalBoundary() throws IOException {
        String source = Files.readString(sourcePath("FabricInteractionAuthority.java"));
        int commit = source.indexOf("InteractionAppliedReceipt commit(");
        int initialPlayerCount = source.indexOf(
            "synchronizeAuthoritativePlayerCount(client);",
            commit
        );
        int epochSnapshot = source.indexOf(
            "long commitAuthorizationEpoch = worldActionAuthorization.authorizationEpoch();",
            initialPlayerCount
        );
        int dispatch = source.indexOf("DispatchResult result = dispatch(", epochSnapshot);

        assertTrue(commit < initialPlayerCount && initialPlayerCount < epochSnapshot);
        assertTrue(epochSnapshot < dispatch);
        assertTrue(source.contains("server.getPlayerManager().getCurrentPlayerCount()"));

        int dispatchMethod = source.indexOf("private DispatchResult dispatch(");
        int wouldApply = source.indexOf("private boolean wouldApply(", dispatchMethod);
        String physicalDispatch = source.substring(dispatchMethod, wouldApply);
        int breakCase = physicalDispatch.indexOf("case BREAK_PROGRESS ->");
        int breakLock = physicalDispatch.indexOf(
            "synchronized (worldActionAuthorization)",
            breakCase
        );
        int breakGate = physicalDispatch.indexOf(
            "authorizeBlockPayloadAtPhysicalBoundary(",
            breakLock
        );
        int breakSink = physicalDispatch.indexOf(
            "client.interactionManager.updateBlockBreakingProgress(",
            breakGate
        );
        int useCase = physicalDispatch.indexOf("case USE_BLOCK ->");
        int useLock = physicalDispatch.indexOf(
            "synchronized (worldActionAuthorization)",
            useCase
        );
        int useGate = physicalDispatch.indexOf(
            "authorizeBlockPayloadAtPhysicalBoundary(",
            useLock
        );
        int useSink = physicalDispatch.indexOf(
            "client.interactionManager.interactBlock(",
            useGate
        );
        assertTrue(breakCase < breakLock && breakLock < breakGate && breakGate < breakSink);
        assertTrue(useCase < useLock && useLock < useGate && useGate < useSink);

        int boundary = source.indexOf(
            "authorizeBlockPayloadAtPhysicalBoundary(",
            wouldApply
        );
        int heldItem = source.indexOf(
            "private static boolean heldItemRequirementMatches(", boundary);
        String finalBoundary = source.substring(boundary, heldItem);
        int protection = finalBoundary.indexOf(
            "targetProtection.evaluate(client, affectedPositions)");
        int finalPlayerCount = finalBoundary.indexOf(
            "synchronizeAuthoritativePlayerCount(client)",
            protection
        );
        int epochAuthorize = finalBoundary.indexOf(
            "worldActionAuthorization.authorizeAtEpoch(",
            finalPlayerCount
        );
        assertTrue(protection < finalPlayerCount && finalPlayerCount < epochAuthorize);
        assertTrue(finalBoundary.contains("Thread.holdsLock(worldActionAuthorization)"));
    }

    @Test
    void unboundedCollateralEffectsAndDimensionUnsafeBedsFailClosedAtFinalSinks()
        throws IOException {
        String authority = Files.readString(sourcePath("FabricInteractionAuthority.java"));
        String protection = Files.readString(sourcePath("FabricTargetProtection.java"));
        String bed = Files.readString(sourcePath("UseBedExecutor.java"));

        int finalGate = authority.indexOf(
            "private FabricWorldActionAuthorization.Decision "
                + "authorizeBlockPayloadAtPhysicalBoundary("
        );
        int breakSink = authority.indexOf(
            "client.interactionManager.updateBlockBreakingProgress("
        );
        int useSink = authority.indexOf("client.interactionManager.interactBlock(");
        assertTrue(finalGate >= 0);
        assertTrue(authority.substring(finalGate).contains(
            "targetProtection.unboundedBlockEffectsAllowed(client)"
        ));
        assertTrue(authority.substring(finalGate).contains("bedUseDimensionSafe(client, payload)"));
        assertTrue(finalGate > breakSink && finalGate > useSink);
        assertTrue(protection.contains("regions.isEmpty()"));
        assertTrue(protection.contains("unboundedBlockEffectsAllowedContext("));
        assertTrue(bed.contains("World.OVERWORLD.equals(client.world.getRegistryKey())"));
        assertTrue(bed.contains("use_bed_failed:unsafe_dimension"));

        int containerSlot = authority.indexOf("SlotMutationResult clickContainerSlot(");
        int containerSink = authority.indexOf(
            "client.interactionManager.clickSlot(",
            containerSlot
        );
        assertTrue(containerSlot >= 0 && containerSlot < containerSink);
        assertTrue(authority.substring(containerSlot, containerSink).contains(
            "targetProtection.unboundedBlockEffectsAllowed(client)"
        ));
    }

    @Test
    void lanPublicationRevokesNaturalTrustBeforeTheListenerCanOpen() throws IOException {
        String mixin = Files.readString(Path.of(
            "src", "main", "java", "com", "mcbot", "fabricclient", "mixin",
            "IntegratedServerLanTrustMixin.java"
        ));
        String mixinConfig = Files.readString(Path.of(
            "src", "main", "resources", "mcbot_fabric_client.mixins.json"
        ));
        String client = Files.readString(sourcePath("McbotFabricClient.java"));
        String authority = Files.readString(sourcePath("FabricInteractionAuthority.java"));
        String policy = Files.readString(sourcePath("FabricWorldActionAuthorization.java"));

        int methodHead = mixin.indexOf(
            "@Inject(method = \"openToLan\", at = @At(\"HEAD\"))"
        );
        int callback = mixin.indexOf(
            "McbotFabricClient.onIntegratedServerLanOpening()",
            methodHead
        );
        int clientCallback = client.indexOf(
            "public static void onIntegratedServerLanOpening()"
        );
        int authorityCallback = client.indexOf(
            "interactionAuthority.observeIntegratedServerLanOpening()",
            clientCallback
        );
        int authorityMethod = authority.indexOf(
            "void observeIntegratedServerLanOpening()"
        );
        int policyCallback = authority.indexOf(
            "worldActionAuthorization.observeIntegratedServerLanOpening()",
            authorityMethod
        );

        assertTrue(mixin.contains("@Mixin(IntegratedServer.class)"));
        assertTrue(methodHead >= 0 && methodHead < callback);
        assertTrue(mixinConfig.contains("\"IntegratedServerLanTrustMixin\""));
        assertTrue(client.contains("private static volatile McbotFabricClient activeClient"));
        assertTrue(clientCallback >= 0 && clientCallback < authorityCallback);
        assertTrue(authorityMethod >= 0 && authorityMethod < policyCallback);
        assertTrue(policy.contains("synchronized boolean observeIntegratedServerLanOpening()"));
        assertTrue(policy.contains("integratedServerLanOpeningObserved = true"));
        assertTrue(policy.contains("&& !integratedServerLanOpeningObserved"));
    }

    @Test
    void everyExternalSlotMutationReauthorizesTheExactOpenLeaseAtTheSink()
        throws IOException {
        String authority = Files.readString(sourcePath("FabricInteractionAuthority.java"));
        String client = Files.readString(sourcePath("McbotFabricClient.java"));
        String village = Files.readString(sourcePath("VillageOpportunityExecutor.java"));

        int slotMethod = authority.indexOf("SlotMutationResult clickContainerSlot(");
        int playerSlotMethod = authority.indexOf(
            "SlotMutationResult clickPlayerInventorySlot(", slotMethod);
        String externalSlot = authority.substring(slotMethod, playerSlotMethod);
        int playerCount = externalSlot.indexOf(
            "synchronizeAuthoritativePlayerCount(client)");
        int openProvenance = externalSlot.indexOf(
            "accessRequestMatches(lease.requestId(), accessRequestId)");
        int worldIdentity = externalSlot.indexOf("worldAndPlayerIdentityMatches(");
        int handlerIdentity = externalSlot.indexOf(
            "boundContainerIdentityMatches(");
        int footprint = externalSlot.indexOf(
            "resolveAffectedBlockPositions(client, lease.payload())");
        int protection = externalSlot.indexOf(
            "targetProtection.evaluate(client, currentFootprint)");
        int authorization = externalSlot.indexOf(
            "worldActionAuthorization.preview(", protection);
        int finalAuthorization = externalSlot.indexOf(
            "authorizeContainerSlotAtPhysicalBoundary(client, lease)",
            authorization
        );
        int finalAuthorizationLock = externalSlot.lastIndexOf(
            "synchronized (worldActionAuthorization)",
            finalAuthorization
        );
        int sink = externalSlot.indexOf("client.interactionManager.clickSlot(");

        assertTrue(slotMethod >= 0 && playerSlotMethod > slotMethod);
        assertTrue(playerCount >= 0 && playerCount < openProvenance);
        assertTrue(openProvenance < worldIdentity && worldIdentity < handlerIdentity);
        assertTrue(handlerIdentity < footprint && footprint < protection);
        assertTrue(protection < authorization && authorization < finalAuthorization);
        assertTrue(authorization < finalAuthorizationLock);
        assertTrue(finalAuthorizationLock < finalAuthorization);
        assertTrue(finalAuthorization < sink);
        assertTrue(externalSlot.contains("client.player != player"));
        assertTrue(externalSlot.contains("player.currentScreenHandler != handler"));
        assertTrue(externalSlot.contains("lease.syncId(), handler.syncId"));
        assertTrue(externalSlot.contains("container_slot_handler_became_stale"));
        assertTrue(externalSlot.contains("denyContainerSlot(player, handler"));
        assertTrue(!externalSlot.contains("lease.bind(handler)"));

        int finalSlotGate = authority.indexOf(
            "authorizeContainerSlotAtPhysicalBoundary(",
            slotMethod
        );
        int playerSlotBoundary = authority.indexOf(
            "SlotMutationResult clickPlayerInventorySlot(",
            finalSlotGate
        );
        String finalSlotAuthorization = authority.substring(
            finalSlotGate,
            playerSlotBoundary
        );
        int finalSlotProtection = finalSlotAuthorization.indexOf(
            "targetProtection.evaluate(client, currentFootprint)"
        );
        int finalSlotPlayerCount = finalSlotAuthorization.indexOf(
            "synchronizeAuthoritativePlayerCount(client)",
            finalSlotProtection
        );
        int finalSlotEpoch = finalSlotAuthorization.indexOf(
            "worldActionAuthorization.authorizeAtEpoch(",
            finalSlotPlayerCount
        );
        assertTrue(finalSlotProtection < finalSlotPlayerCount);
        assertTrue(finalSlotPlayerCount < finalSlotEpoch);
        assertTrue(finalSlotAuthorization.contains("lease.authorizationEpoch()"));
        assertTrue(finalSlotAuthorization.contains("Thread.holdsLock(worldActionAuthorization)"));

        int transitionMethod = authority.indexOf(
            "void observeContainerScreenTransition(");
        int externalSlotMethod = authority.indexOf(
            "SlotMutationResult clickContainerSlot(", transitionMethod);
        String transition = authority.substring(transitionMethod, externalSlotMethod);
        int transitionPlayerCount = transition.indexOf(
            "synchronizeAuthoritativePlayerCount(client)");
        int transitionIdentity = transition.indexOf(
            "isNewExternalContainerHandler(");
        int transitionFootprint = transition.indexOf(
            "resolveAffectedBlockPositions(client, lease.payload())");
        int transitionProtection = transition.indexOf(
            "targetProtection.evaluate(client, currentFootprint)");
        int transitionAuthorization = transition.indexOf(
            "worldActionAuthorization.preview(", transitionProtection);
        int transitionBindLock = transition.indexOf(
            "synchronized (worldActionAuthorization)",
            transitionAuthorization
        );
        int transitionBind = transition.indexOf(
            "containerAccessLease = lease.bind(current)");
        assertTrue(transitionMethod >= 0 && externalSlotMethod > transitionMethod);
        assertTrue(transition.contains("client.player != player"));
        assertTrue(transitionPlayerCount >= 0 && transitionPlayerCount < transitionIdentity);
        assertTrue(transitionIdentity < transitionFootprint);
        assertTrue(transitionFootprint < transitionProtection);
        assertTrue(transitionProtection < transitionAuthorization);
        assertTrue(transitionAuthorization < transitionBindLock);
        assertTrue(transitionBindLock < transitionBind);

        assertTrue(authority.contains("rememberAuthorizedContainerOpen("));
        assertTrue(authority.contains("long authorizedEpoch"));
        int rememberCall = authority.indexOf("rememberAuthorizedContainerOpen(");
        int rememberOpen = authority.indexOf("private void rememberAuthorizedContainerOpen(");
        String rememberInvocation = authority.substring(rememberCall, rememberOpen);
        assertTrue(rememberInvocation.contains("commitAuthorizationEpoch"));
        int denySlot = authority.indexOf(
            "private SlotMutationResult denyContainerSlot(", rememberOpen);
        String rememberMethod = authority.substring(rememberOpen, denySlot);
        assertTrue(!rememberMethod.contains("worldActionAuthorization.authorizationEpoch()"));
        int leaseCreation = authority.indexOf("new ContainerAccessLease(", rememberOpen);
        int leaseEpoch = authority.indexOf("authorizedEpoch,", leaseCreation);
        assertTrue(rememberOpen >= 0 && rememberOpen < leaseCreation);
        assertTrue(leaseCreation < leaseEpoch);
        assertTrue(authority.contains(
            "player.currentScreenHandler != player.playerScreenHandler"));
        assertTrue(client.contains("run.containerAccessRequestId"));
        int tick = client.indexOf("private void onClientTick(");
        int observeTransition = client.indexOf(
            "interactionAuthority.observeContainerScreenTransition(client, player, nowMs)",
            tick);
        int resolveControl = client.indexOf("recordTrajectoryCell(player);", tick);
        assertTrue(tick >= 0 && tick < observeTransition && observeTransition < resolveControl);
        assertTrue(client.contains("interactionAuthority.clickContainerSlot("));
        assertTrue(village.contains("shell.clickAuthorizedContainerSlot("));
        assertTrue(!client.contains("client.interactionManager.clickSlot("));
        assertTrue(!village.contains("client.interactionManager.clickSlot("));
    }

    @Test
    void clientWorldTransitionsCannotClearStickyRevocation() throws IOException {
        String source = Files.readString(sourcePath("FabricInteractionAuthority.java"));
        int observe = source.indexOf("FabricWorldActionAuthorization.ObservationResult observeWorldAuthorization(");
        int fixtureGate = source.indexOf("boolean fixtureCommandsAllowed()", observe);
        String observationPath = source.substring(observe, fixtureGate);
        int synchronize = source.indexOf("private void synchronizeAuthorizationWorld(");
        int authoritativeCount = source.indexOf("private boolean synchronizeAuthoritativePlayerCount(", synchronize);
        String transitionPath = source.substring(synchronize, authoritativeCount);

        assertTrue(observationPath.contains("observeUnavailableWorld()"));
        assertTrue(!observationPath.contains("worldActionAuthorization.clear()"));
        assertTrue(!transitionPath.contains("worldActionAuthorization.clear()"));
    }

    private static Path sourcePath(String fileName) {
        return Path.of("src", "main", "java", "com", "mcbot", "fabricclient", fileName);
    }
}
