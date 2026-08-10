package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.passive.IronGolemEntity;
import net.minecraft.item.BlockItem;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.text.Text;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

/**
 * Bounded physical executor for one exact event-cached iron-golem opportunity.
 *
 * <p>The brain supplies only an opaque discovery id. The raw UUID is resolved locally, frozen,
 * and never accepted from the wire. Movement is restricted to planner-produced local routes, the
 * exact three-block defense pillar, its frozen escape, and a bounded owned-drop pickup route.</p>
 */
final class IronGolemOpportunityExecutor {
    static final long HARD_DEADLINE_MS = 180_000L;
    static final long COLLECTION_DEADLINE_MS = 8_000L;
    static final long TARGET_ACTIVATION_TIMEOUT_MS = 2_000L;
    // A verified multi-cell escape can end beyond the generic twelve-block drop-origin radius.
    // Keep the pickup search local and fixed while covering the bounded defense-package return.
    static final int COLLECTION_HORIZONTAL_RADIUS = 16;
    static final int COLLECTION_VERTICAL_DELTA = 4;
    static final int COLLECTION_ROUTE_MARGIN = 2;
    static final int COLLECTION_ROUTE_VERTICAL_MARGIN = 4;
    static final int COLLECTION_MAX_ROUTE_CELLS = 20;
    static final double ATTACK_ALIGNMENT_DEGREES = 7.0D;
    static final double LIVE_GOLEM_ESCAPE_MARGIN = 0.25D;

    interface Resolver {
        IronGolemEntity resolve(MinecraftClient client, String opaqueOpportunityId);
    }

    enum Outcome {
        ACTIVE,
        COLLECTED,
        UNAVAILABLE,
        INVALIDATED,
        UNSAFE
    }

    enum Phase {
        IDLE,
        ROUTE_TO_BASE,
        BUILD_DEFENSE,
        WAIT_TARGET_ACTIVE,
        ATTACK,
        ESCAPE,
        ACQUIRE_DROP,
        COLLECT_DROP,
        COMPLETE,
        REJECTED
    }

    record Step(
        ControlDecision decision,
        Outcome outcome,
        Phase phase,
        String reason,
        String opaqueTargetIdentity,
        String exactEntityIdentity,
        Map<String, Integer> authoritativeInventoryDelta
    ) {
        Step {
            reason = normalize(reason);
            opaqueTargetIdentity = stable(opaqueTargetIdentity);
            exactEntityIdentity = normalize(exactEntityIdentity);
            authoritativeInventoryDelta = authoritativeInventoryDelta == null
                ? Map.of() : Map.copyOf(authoritativeInventoryDelta);
        }

        boolean terminal() {
            return outcome != Outcome.ACTIVE;
        }
    }

    private final ShellServices shell;
    private final Resolver resolver;
    private final VillageLocalRouteController inboundRoute = new VillageLocalRouteController();
    private final VillageLocalRouteController escapeRoute = new VillageLocalRouteController();
    private final VillageLocalRouteController collectRoute = new VillageLocalRouteController();
    private final IronGolemPillarController pillar = new IronGolemPillarController();
    private final IronGolemAttackController attack = new IronGolemAttackController();
    private final OwnedDropTracker dropTracker = new OwnedDropTracker();

    private String commandId = "";
    private String opaqueOpportunityId = "";
    private String exactUuid = "";
    private UUID exactJavaUuid;
    private IronGolemEntity frozenTarget;
    private IronGolemDefensePackagePlanner.Plan plan;
    private Phase phase = Phase.IDLE;
    private long startedAtMs;
    private long collectionStartedAtMs;
    private int baselineIron;
    private int baselineFiller;
    private int verifiedIronGain;
    private double engagementHealthBaseline;
    private boolean safeHandoffRequested;
    private String safeHandoffReason = "";
    private boolean protectedFinishRequested;
    private boolean typedDeathConfirmed;
    private boolean terminalAfterEscape;
    private Outcome deferredOutcome = Outcome.UNAVAILABLE;
    private String deferredReason = "";
    private boolean escapeRouteInstalled;
    private boolean escapeArrivalPending;
    private boolean collectRouteInstalled;
    private boolean collectAtPickup;
    private BlockPlaceController.Result lastPlacementResult;
    private final Map<VoxelCell, Block> expectedPillarBlocks = new HashMap<>();
    private int loggedPillarPlacements;
    private boolean dropLatchedLogged;
    private boolean dropSettledLogged;
    private boolean rejectedLogged;
    private boolean emergencyDisconnectRequested;
    private String pendingEmergencySafetyReason = "";
    private long targetActivationStartedAtMs;
    private boolean targetActivationWaitingLogged;
    private boolean targetActivatedLogged;

    IronGolemOpportunityExecutor(ShellServices shell, Resolver resolver) {
        this.shell = shell;
        this.resolver = resolver;
    }

    Step tick(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        int nearbyHostileCount,
        long nowMs
    ) {
        if (client == null || client.world == null || player == null || intent == null) {
            return terminal(intent, Outcome.UNAVAILABLE, "missing_world_or_player");
        }
        if (!activeFor(intent)) {
            Step begun = begin(client, player, intent, nearbyHostileCount, nowMs);
            if (begun != null) {
                return begun;
            }
        }
        if (!activeFor(intent)) {
            return terminal(intent, Outcome.INVALIDATED, "command_changed");
        }
        if (nowMs - startedAtMs >= HARD_DEADLINE_MS) {
            if (attack.engaged() && !typedDeathConfirmed) {
                return emergencySafetyTerminal(
                    client, intent, "live_target_hard_deadline");
            }
            return reject(intent, Outcome.UNAVAILABLE,
                phase == Phase.ESCAPE
                    ? "safe_escape_hard_deadline" : "golem_executor_timeout");
        }

        int ironGain = inventoryCount(player, Items.IRON_INGOT) - baselineIron;
        if (typedDeathConfirmed && ironGain > 0) {
            if (ironGain < 3 || ironGain > 5
                || dropTracker.attributedStackDelta() != ironGain) {
                return failOrEscape(intent, Outcome.INVALIDATED,
                    "iron_drop_attribution_mismatch", nowMs);
            }
            verifiedIronGain = ironGain;
            if (phase != Phase.ESCAPE) {
                return completeCollection(player, intent, ironGain, nowMs);
            }
        }

        String postEngagementSafety = pendingEmergencySafetyReason.isBlank()
            ? postEngagementSafety(player, nearbyHostileCount)
            : pendingEmergencySafetyReason;
        if (!postEngagementSafety.isBlank()) {
            if (attack.engaged()) {
                return emergencySafetyTerminal(client, intent, postEngagementSafety);
            }
            return reject(intent, Outcome.UNSAFE, postEngagementSafety);
        }

        return switch (phase) {
            case ROUTE_TO_BASE -> tickRouteToBase(client, player, intent, nowMs);
            case BUILD_DEFENSE -> tickPillar(client, player, intent, nowMs);
            case WAIT_TARGET_ACTIVE -> tickTargetActivation(
                client, player, intent, nowMs);
            case ATTACK -> tickAttack(client, player, intent, nearbyHostileCount, nowMs);
            case ESCAPE -> tickEscape(
                client, player, intent, nearbyHostileCount, nowMs);
            case ACQUIRE_DROP, COLLECT_DROP -> tickDrop(client, player, intent, nowMs);
            case COMPLETE -> new Step(stopped(intent, "golem_iron_inventory_verified"),
                Outcome.COLLECTED, phase, "iron_inventory_delta_verified",
                opaqueOpportunityId, exactIdentity(),
                Map.of("minecraft:iron_ingot", Math.max(0, ironGain)));
            case REJECTED -> terminal(intent, deferredOutcome, deferredReason);
            case IDLE -> terminal(intent, Outcome.INVALIDATED, "executor_not_started");
        };
    }

    void observeInteractionReceipt(InteractionAppliedReceipt receipt) {
        if (attack.acknowledgeInteraction(receipt)) {
            shell.logger().info(
                "village.opportunity.golem.attack.pulse instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} requestId={} acknowledgedAttacks={} appliedAtMs={} result=applied",
                shell.instanceId(), commandId, opaqueOpportunityId, exactUuid,
                exactIdentity(), receipt.requestId(), attack.acknowledgedAttacks(),
                receipt.timestampMs());
        }
    }

    boolean engaged() {
        return attack.engaged();
    }

    boolean ownsSafetyEscape() {
        return attack.escapeLatched() || phase == Phase.ESCAPE;
    }

    /**
     * Convert an engaged command replacement into a physical escape lease. The caller must keep
     * ticking this executor with the admitted intent until the frozen safe endpoint is verified.
     */
    boolean requestSafeHandoff(String reason, long nowMs) {
        if (!attack.engaged() && !attack.escapeLatched()) {
            return false;
        }
        safeHandoffRequested = true;
        safeHandoffReason = normalize(reason).isBlank()
            ? "effective_intent_changed_while_engaged" : normalize(reason);
        protectedFinishRequested = phase == Phase.ATTACK && attack.engaged();
        return true;
    }

    boolean needsPreReflexSafetyBarrier(
        ClientPlayerEntity player,
        int nearbyHostileCount
    ) {
        return attack.escapeLatched()
            || phase == Phase.ESCAPE
            || safeHandoffRequested
            || attack.engaged();
    }

    void requestPostEngagementEscape(
        ClientPlayerEntity player,
        int nearbyHostileCount,
        long nowMs
    ) {
        String safety = postEngagementSafety(player, nearbyHostileCount);
        if (safety.isBlank()) {
            return;
        }
        pendingEmergencySafetyReason = safety;
    }

    void clear() {
        inboundRoute.clear();
        escapeRoute.clear();
        collectRoute.clear();
        pillar.clear();
        attack.clear();
        dropTracker.reset();
        shell.blockPlaceController().reset();
        commandId = "";
        opaqueOpportunityId = "";
        exactUuid = "";
        exactJavaUuid = null;
        frozenTarget = null;
        plan = null;
        phase = Phase.IDLE;
        startedAtMs = 0L;
        collectionStartedAtMs = 0L;
        baselineIron = 0;
        baselineFiller = 0;
        verifiedIronGain = 0;
        engagementHealthBaseline = 0.0D;
        safeHandoffRequested = false;
        safeHandoffReason = "";
        protectedFinishRequested = false;
        typedDeathConfirmed = false;
        terminalAfterEscape = false;
        deferredOutcome = Outcome.UNAVAILABLE;
        deferredReason = "";
        escapeRouteInstalled = false;
        escapeArrivalPending = false;
        collectRouteInstalled = false;
        collectAtPickup = false;
        lastPlacementResult = null;
        expectedPillarBlocks.clear();
        loggedPillarPlacements = 0;
        dropLatchedLogged = false;
        dropSettledLogged = false;
        rejectedLogged = false;
        emergencyDisconnectRequested = false;
        pendingEmergencySafetyReason = "";
        targetActivationStartedAtMs = 0L;
        targetActivationWaitingLogged = false;
        targetActivatedLogged = false;
    }

    private Step begin(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        int nearbyHostileCount,
        long nowMs
    ) {
        clear();
        commandId = stable(intent.commandId());
        opaqueOpportunityId = stable(intent.opportunityId());
        if (commandId.isBlank() || opaqueOpportunityId.isBlank() || resolver == null) {
            return reject(intent, Outcome.INVALIDATED, "missing_opaque_identity");
        }
        IronGolemEntity target = resolver.resolve(client, opaqueOpportunityId);
        if (target == null || !target.isAlive() || target.getWorld() != client.world) {
            return reject(intent, Outcome.INVALIDATED, "exact_target_unavailable");
        }
        frozenTarget = target;
        exactJavaUuid = target.getUuid();
        exactUuid = exactJavaUuid.toString();
        startedAtMs = nowMs;
        baselineIron = inventoryCount(player, Items.IRON_INGOT);
        baselineFiller = fillerCount(player);
        VoxelCell start = feet(player);
        Box box = target.getBoundingBox();
        IronGolemDefensePackagePlanner.Target plannerTarget =
            new IronGolemDefensePackagePlanner.Target(
                exactUuid,
                new IronGolemDefensePackagePlanner.EntityBounds(
                    box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ));
        IronGolemDefensePackagePlanner.Readiness readiness =
            new IronGolemDefensePackagePlanner.Readiness(
                player.getHealth(),
                player.getHungerManager().getFoodLevel(),
                qualifyingSwordDurability(player),
                fillerCount(player),
                reservedFillerCount(player),
                Math.max(0, nearbyHostileCount),
                nearbyLiveGolemCount(client, target));
        WorldVoxelPerception world = new WorldVoxelPerception(
            client.world,
            start.x() - 32, start.x() + 32,
            start.y() - 6, start.y() + 8,
            start.z() - 32, start.z() + 32);
        plan = IronGolemDefensePackagePlanner.plan(
            new LiveDefensePerception(client, world), start, plannerTarget, readiness);
        if (!plan.accepted()) {
            return reject(intent, Outcome.UNSAFE,
                plan.reason().isBlank() ? "defense_package_unavailable" : plan.reason());
        }
        dropTracker.arm(snapshotIronDrops(client, target.getPos()),
            position(target.getPos()), nowMs);
        if (!inboundRoute.begin(commandId, plan.routeToBase(), start, nowMs,
            nowMs + HARD_DEADLINE_MS)) {
            return reject(intent, Outcome.UNAVAILABLE, "defense_route_unavailable");
        }
        phase = Phase.ROUTE_TO_BASE;
        shell.logger().info(
            "village.opportunity.golem.defense.selected instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} mode={} routeLength={} pillarBlocksRequired={} escapeRouteLength={} expandedCells={} fillerBefore={}",
            shell.instanceId(), commandId, opaqueOpportunityId, exactUuid, exactIdentity(),
            plan.mode().name().toLowerCase(java.util.Locale.ROOT),
            plan.routeToBase().size(), plan.fillerRequired(), plan.escapeRoute().size(),
            plan.expandedCells(), baselineFiller);
        return new Step(stopped(intent, "golem_defense_package_selected"), Outcome.ACTIVE,
            phase, "defense_package_selected", opaqueOpportunityId,
            exactIdentity(), Map.of());
    }

    private Step tickRouteToBase(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        long nowMs
    ) {
        RouteTick route = driveRoute(client, player, intent, inboundRoute,
            "golem_route_to_defense", nowMs);
        if (route.rejected()) {
            return reject(intent, Outcome.UNAVAILABLE, route.reason());
        }
        if (!route.reached()) {
            return active(route.decision(), "route_to_defense", intent);
        }
        inboundRoute.clear();
        if (plan.mode() == IronGolemDefensePackagePlanner.Mode.THREE_BLOCK_PILLAR) {
            if (!pillar.begin(commandId, exactUuid, plan.base(), plan.placementCells(),
                plan.attackStance(), feet(player), nowMs)) {
                return reject(intent, Outcome.INVALIDATED, "pillar_begin_rejected");
            }
            phase = Phase.BUILD_DEFENSE;
            return active(stopped(intent, "golem_pillar_selected"), "pillar_selected", intent);
        }
        logDefenseReady(player, nowMs);
        return beginAttack(player, intent, nowMs);
    }

    private Step tickPillar(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        long nowMs
    ) {
        IronGolemEntity exact = resolveFrozen(client);
        boolean targetAlive = exact != null && exact.isAlive();
        VoxelCell placementCell = activePlacementCell();
        boolean placementOpen = placementCell != null
            && client.world.getBlockState(blockPos(placementCell)).isAir();
        boolean placementVerified = placementCell != null
            && !client.world.getBlockState(blockPos(placementCell)).getCollisionShape(
                client.world, blockPos(placementCell)).isEmpty();
        VoxelCell current = feet(player);
        boolean safe = safeCell(client, current);
        boolean aligned = alignedTo(player, plan.attackStance(), 24.0D);
        IronGolemPillarController.PlacementFeedback feedback =
            lastPlacementResult == null ? IronGolemPillarController.PlacementFeedback.NONE
                : lastPlacementResult.status() == BlockPlaceController.Status.FAILED
                    ? IronGolemPillarController.PlacementFeedback.REJECTED
                    : lastPlacementResult.status() == BlockPlaceController.Status.PLACED
                        ? IronGolemPillarController.PlacementFeedback.APPLIED
                        : IronGolemPillarController.PlacementFeedback.DEFERRED;
        IronGolemPillarController.Step step = pillar.tick(
            commandId,
            new IronGolemPillarController.Observation(
                current, player.getY(), player.isOnGround(), !player.isTouchingWater(),
                safe, safe, aligned, exactUuid, targetAlive,
                placementOpen, placementVerified, feedback),
            nowMs);
        logNewPillarPlacements(player, step.completedPlacements(), nowMs);
        lastPlacementResult = null;
        if (step.outcome() == IronGolemPillarController.Outcome.REJECTED) {
            return reject(intent, Outcome.UNSAFE, step.reason());
        }
        if (step.outcome() == IronGolemPillarController.Outcome.COMPLETE) {
            logNewPillarPlacements(player, step.completedPlacements(), nowMs);
            logDefenseReady(player, nowMs);
            return beginAttack(player, intent, nowMs);
        }
        if (step.requestPlacement()) {
            BlockPlaceController.PlaceSpec spec = fillerSpec(player);
            if (spec == null || step.placementCell() == null) {
                return reject(intent, Outcome.UNSAFE, "pillar_filler_unavailable");
            }
            lastPlacementResult = shell.blockPlaceController().tick(
                client, player, commandId + ":golem_pillar:" + step.cycle(), nowMs,
                blockPos(step.placementCell()).down(), spec);
            if (lastPlacementResult.status() != BlockPlaceController.Status.FAILED) {
                expectedPillarBlocks.putIfAbsent(
                    step.placementCell(), blockForSpec(spec));
            }
            if (lastPlacementResult.status() == BlockPlaceController.Status.FAILED) {
                return reject(intent, Outcome.UNSAFE, "pillar_placement_failed");
            }
            ControlDecision decision = placementDecision(intent, step, lastPlacementResult);
            return active(decision, step.reason(), intent);
        }
        InputState input = new InputState(false, false, false, false, step.jump(), step.sneak(),
            0.0F, 0.0F);
        return active(new ControlDecision(
            lookAtCell(intent, player, plan.attackStance(), step.reason()), input),
            step.reason(), intent);
    }

    private Step beginAttack(ClientPlayerEntity player, BrainLink.Intent intent, long nowMs) {
        phase = Phase.WAIT_TARGET_ACTIVE;
        if (targetActivationStartedAtMs <= 0L) {
            targetActivationStartedAtMs = nowMs;
        }
        return tickTargetActivation(
            MinecraftClient.getInstance(), player, intent, nowMs);
    }

    private Step tickTargetActivation(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        long nowMs
    ) {
        IronGolemEntity exact = resolveFrozen(client);
        if (exact == null || !exact.isAlive()) {
            return reject(intent, Outcome.INVALIDATED,
                "target_unavailable_before_activation");
        }
        if (exact.isAiDisabled()) {
            if (!targetActivationWaitingLogged) {
                targetActivationWaitingLogged = true;
                shell.logger().info(
                    "village.opportunity.golem.target_activation_waiting instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} aiDisabled=true elapsedMs={}",
                    shell.instanceId(), commandId, opaqueOpportunityId, exactUuid,
                    exactIdentity(), Math.max(0L, nowMs - startedAtMs));
            }
            if (nowMs - targetActivationStartedAtMs >= TARGET_ACTIVATION_TIMEOUT_MS) {
                return reject(intent, Outcome.UNSAFE, "target_ai_disabled");
            }
            return active(stopped(intent, "golem_target_activation_pending"),
                "target_activation_pending", intent);
        }
        if (!targetActivatedLogged) {
            targetActivatedLogged = true;
            shell.logger().info(
                "village.opportunity.golem.target_activated instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} aiDisabled=false waitMs={} elapsedMs={}",
                shell.instanceId(), commandId, opaqueOpportunityId, exactUuid,
                exactIdentity(), Math.max(0L, nowMs - targetActivationStartedAtMs),
                Math.max(0L, nowMs - startedAtMs));
        }
        int sword = ensureQualifyingSwordHotbar(MinecraftClient.getInstance(), player);
        if (sword < 0) {
            return reject(intent, Outcome.UNSAFE, "stone_sword_unavailable");
        }
        player.getInventory().selectedSlot = sword;
        if (!attack.begin(commandId, exactUuid, plan.attackStance(), plan.escapeLanding(),
            plan.escapeRoute(), player.getHealth(), nowMs)) {
            return reject(intent, Outcome.INVALIDATED, "attack_begin_rejected");
        }
        engagementHealthBaseline = player.getHealth();
        phase = Phase.ATTACK;
        shell.logger().info(
            "village.opportunity.golem.attack.started instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} attackStance={} aiDisabled=false health={} food={} elapsedMs={}",
            shell.instanceId(), commandId, opaqueOpportunityId, exactUuid, exactIdentity(),
            plan.attackStance(), player.getHealth(), player.getHungerManager().getFoodLevel(),
            Math.max(0L, nowMs - startedAtMs));
        return active(stopped(intent, "golem_attack_ready"), "attack_ready", intent);
    }

    private Step tickAttack(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        int nearbyHostileCount,
        long nowMs
    ) {
        IronGolemEntity exact = resolveFrozen(client);
        boolean exactAlive = exact != null && exact.isAlive();
        boolean typedDeath = frozenTarget != null && !frozenTarget.isAlive()
            && exactJavaUuid != null && exactJavaUuid.equals(frozenTarget.getUuid());
        Vec3d hit = closestHitPoint(player, frozenTarget);
        McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(player, hit);
        boolean gazeAligned = angularError(player, look) <= ATTACK_ALIGNMENT_DEGREES;
        boolean defenseValid = safeCell(client, feet(player))
            && feet(player).equals(plan.attackStance()) && defenseBlocksValid(client);
        boolean reach = player.getEyePos().distanceTo(hit)
            <= IronGolemDefensePackagePlanner.ENTITY_REACH;
        boolean lineOfSight = clearLineOfSight(client, player, frozenTarget, hit);
        boolean protectedFinish = protectedFinishRequested
            && safeHandoffRequested && attack.engaged();
        if (protectedFinish && !typedDeath) {
            String impossible = protectedFinishImpossibleReason(
                exactAlive, defenseValid, reach, lineOfSight);
            if (!impossible.isBlank()) {
                return emergencySafetyTerminal(client, intent,
                    "protected_finish_impossible:" + impossible);
            }
        }
        IronGolemAttackController.Step step = attack.tick(
            commandId,
            new IronGolemAttackController.Observation(
                exactAlive ? exactUuid : "", exactAlive, exactAlive,
                typedDeath ? exactUuid : "", typedDeath,
                feet(player).equals(plan.attackStance()), defenseValid, reach,
                lineOfSight, gazeAligned,
                protectedFinish ? engagementHealthBaseline : player.getHealth(),
                protectedFinish ? 0 : Math.max(0, nearbyHostileCount)),
            nowMs);
        if (step.outcome() == IronGolemAttackController.Outcome.DEATH_CONFIRMED) {
            typedDeathConfirmed = true;
            Vec3d death = frozenTarget == null ? hit : frozenTarget.getPos();
            if (!dropTracker.rebaseArmedOrigin(position(death))) {
                return failOrEscape(intent, Outcome.INVALIDATED, "drop_origin_rebase_failed", nowMs);
            }
            dropTracker.beginAcquisition(nowMs);
            shell.logger().info(
                "village.opportunity.golem.killed instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} entityType=minecraft:iron_golem acknowledgedAttacks={} deathPosition={} elapsedMs={}",
                shell.instanceId(), commandId, opaqueOpportunityId, exactUuid, exactIdentity(),
                step.acknowledgedAttacks(), death, Math.max(0L, nowMs - startedAtMs));
            observeOwnedDrop(client, nowMs);
            attack.beginEscape("typed_death_confirmed", nowMs);
            return beginEscape(client, player, intent, false,
                Outcome.UNAVAILABLE, "", nowMs);
        }
        if (step.outcome() == IronGolemAttackController.Outcome.ESCAPE) {
            return emergencySafetyTerminal(client, intent,
                (protectedFinish ? "protected_finish_impossible:" : "live_target_")
                    + step.reason());
        }
        if (step.outcome() == IronGolemAttackController.Outcome.REJECTED) {
            return reject(intent, Outcome.UNSAFE, step.reason());
        }
        LookDemand demand = new LookDemand(
            LookDemand.Owner.NORMAL, step.targetIdentity(), LookDemand.Profile.TRACKING,
            look.yaw(), look.pitch(), LookDemand.RetargetPolicy.CONTINUOUS,
            commandId, "village_golem_tracking");
        InteractionDemand interaction = step.requestAttack()
            ? InteractionDemand.attackEntity(
                step.requestId(), LookDemand.Owner.NORMAL, commandId, "defeat_golem",
                step.targetIdentity(), "village_golem_attack")
            : null;
        if (step.requestAttack()) {
            shell.logger().info(
                "village.opportunity.golem.attack.requested instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} requestId={} attackSequence={} acknowledgedAttacks={} reach={} lineOfSight={} gazeAligned={} elapsedMs={}",
                shell.instanceId(), commandId, opaqueOpportunityId, exactUuid, exactIdentity(),
                step.requestId(), step.attackSequence(), step.acknowledgedAttacks(),
                reach, lineOfSight, gazeAligned, Math.max(0L, nowMs - startedAtMs));
        }
        FabricInteractionAuthority.Payload payload = step.requestAttack() && frozenTarget != null
            ? FabricInteractionAuthority.Payload.entity(
                frozenTarget, Hand.MAIN_HAND,
                new FabricInteractionAuthority.EntityGate(
                    IronGolemDefensePackagePlanner.ENTITY_REACH,
                    look.yaw(), look.pitch(), ATTACK_ALIGNMENT_DEGREES, nowMs, true,
                    FabricInteractionAuthority.EntityReachMetric.EYE_TO_HITBOX))
            : null;
        BrainLink.Intent facing = shell.lookIntentForAngles(
            intent, look.yaw(), look.pitch(), "village_golem_tracking");
        return active(new ControlDecision(
            facing, InputState.stop(), demand, demand, null, interaction, payload),
            step.reason(), intent);
    }

    private Step beginEscape(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        boolean terminal,
        Outcome outcome,
        String reason,
        long nowMs
    ) {
        if (terminal) {
            terminalAfterEscape = true;
            deferredOutcome = outcome;
            deferredReason = reason;
        }
        List<VoxelCell> route = new ArrayList<>();
        route.add(feet(player));
        for (VoxelCell cell : plan.escapeRoute()) {
            if (!route.getLast().equals(cell)) {
                route.add(cell);
            }
        }
        if (route.size() < 2) {
            phase = Phase.ESCAPE;
            escapeArrivalPending = true;
            boolean endpointSafe = runtimeEscapeLandingSafe(client, feet(player), 0);
            IronGolemAttackController.Step arrival = attack.observeEscapeArrival(
                commandId, feet(player), player.isOnGround(), !player.isTouchingWater(),
                endpointSafe, endpointSafe, nowMs);
            return afterEscape(intent, arrival, nowMs);
        }
        if (!escapeRoute.begin(commandId, route, feet(player), nowMs,
            startedAtMs + HARD_DEADLINE_MS)) {
            return reject(intent, Outcome.UNSAFE, "safe_escape_route_unavailable");
        }
        escapeRouteInstalled = true;
        phase = Phase.ESCAPE;
        return active(stopped(intent, "golem_safe_escape_started"),
            "safe_escape_started", intent);
    }

    private Step tickEscape(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        int nearbyHostileCount,
        long nowMs
    ) {
        if (typedDeathConfirmed && verifiedIronGain <= 0) {
            OwnedDropTracker.Update drop = observeOwnedDrop(client, nowMs);
            if (drop.phase() == OwnedDropTracker.Phase.REJECTED) {
                terminalAfterEscape = true;
                deferredOutcome = Outcome.INVALIDATED;
                deferredReason = "owned_iron_" + drop.reason();
            }
        }
        if (nearbyHostileCount > 0) {
            return emergencySafetyTerminal(
                client, intent, "nearby_threats_during_post_death_escape");
        }
        VoxelCell exactEscapeCell = escapeArrivalPending
            ? feet(player) : escapeRoute.activeWaypoint();
        VoxelCell escapeEndpoint = plan == null || plan.escapeRoute().isEmpty()
            ? null : plan.escapeRoute().getLast();
        if (exactEscapeCell == null
            && escapeRoute.finalArrivalPendingAt(escapeEndpoint)) {
            exactEscapeCell = escapeEndpoint;
        }
        if (!runtimeEscapeCellSafe(client, exactEscapeCell)) {
            return reject(intent, Outcome.UNSAFE,
                "post_death_escape_geometry_invalidated");
        }
        if (escapeArrivalPending) {
            boolean endpointSafe = runtimeEscapeLandingSafe(
                client, feet(player), nearbyHostileCount);
            IronGolemAttackController.Step arrival = attack.observeEscapeArrival(
                commandId, feet(player), player.isOnGround(), !player.isTouchingWater(),
                endpointSafe, endpointSafe, nowMs);
            return afterEscape(intent, arrival, nowMs);
        }
        RouteTick route = driveRoute(client, player, intent, escapeRoute,
            "golem_safe_escape", nowMs);
        if (route.rejected()) {
            return reject(intent, Outcome.UNSAFE,
                "post_death_safe_escape_" + route.reason());
        }
        if (!route.reached()) {
            return active(route.decision(), "safe_escape", intent);
        }
        escapeRoute.clear();
        escapeRouteInstalled = false;
        escapeArrivalPending = true;
        boolean endpointSafe = runtimeEscapeLandingSafe(
            client, feet(player), nearbyHostileCount);
        IronGolemAttackController.Step arrival = attack.observeEscapeArrival(
            commandId, feet(player), player.isOnGround(), !player.isTouchingWater(),
            endpointSafe, endpointSafe, nowMs);
        return afterEscape(intent, arrival, nowMs);
    }

    private Step afterEscape(
        BrainLink.Intent intent,
        IronGolemAttackController.Step arrival,
        long nowMs
    ) {
        if (arrival.outcome() == IronGolemAttackController.Outcome.ESCAPE) {
            return active(stopped(intent, arrival.reason()), arrival.reason(), intent);
        }
        escapeArrivalPending = false;
        if (arrival.outcome() != IronGolemAttackController.Outcome.SAFE) {
            return terminal(intent, Outcome.UNSAFE, "safe_escape_rejected");
        }
        if (terminalAfterEscape) {
            return reject(intent, deferredOutcome, deferredReason);
        }
        if (!typedDeathConfirmed) {
            return reject(intent, Outcome.INVALIDATED, "escape_without_typed_death");
        }
        if (verifiedIronGain >= 3 && verifiedIronGain <= 5) {
            return completeCollection(
                MinecraftClient.getInstance().player, intent, verifiedIronGain, nowMs);
        }
        phase = dropTracker.settled() ? Phase.COLLECT_DROP : Phase.ACQUIRE_DROP;
        if (dropTracker.settled()) {
            collectionStartedAtMs = nowMs;
        }
        return active(stopped(intent, "golem_drop_acquisition"), "drop_acquisition", intent);
    }

    private Step tickDrop(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        long nowMs
    ) {
        if (collectionStartedAtMs > 0L
            && nowMs - collectionStartedAtMs >= COLLECTION_DEADLINE_MS) {
            return reject(intent, Outcome.UNAVAILABLE, "owned_iron_collection_timeout");
        }
        OwnedDropTracker.Update update = observeOwnedDrop(client, nowMs);
        if (update.phase() == OwnedDropTracker.Phase.REJECTED) {
            return reject(intent, Outcome.INVALIDATED, "owned_iron_" + update.reason());
        }
        if (!dropTracker.settled()) {
            phase = Phase.ACQUIRE_DROP;
            return active(stopped(intent, "golem_owned_drop_tracking"),
                "owned_drop_tracking", intent);
        }
        if (collectionStartedAtMs <= 0L) {
            collectionStartedAtMs = nowMs;
        }
        if (dropTracker.attributedStackDelta() < 3 || dropTracker.attributedStackDelta() > 5) {
            return reject(intent, Outcome.INVALIDATED, "owned_iron_typed_delta_invalid");
        }
        if (!collectRouteInstalled) {
            OwnedDropTracker.Position drop = dropTracker.settledPosition();
            VoxelCell start = feet(player);
            VoxelCell dropCell = new VoxelCell(
                (int) Math.floor(drop.x()),
                (int) Math.floor(drop.y()),
                (int) Math.floor(drop.z()));
            if (!collectionEndpointWithinBounds(start, dropCell)) {
                return reject(intent, Outcome.UNAVAILABLE,
                    "owned_iron_route_out_of_bounds");
            }
            WorldVoxelPerception perception = new WorldVoxelPerception(
                client.world, start, dropCell,
                COLLECTION_ROUTE_MARGIN, COLLECTION_ROUTE_VERTICAL_MARGIN);
            CollectTarget3DPlanner.TargetPlan target = CollectTarget3DPlanner.chooseTarget(
                perception, start, drop.x(), drop.y(), drop.z());
            if (target.cell() == null || !collectionRouteWithinBounds(target.route())
                || !dropTracker.recordRouteAttempt()
                || !collectRoute.begin(commandId, target.route(), start, nowMs,
                    collectionStartedAtMs + COLLECTION_DEADLINE_MS)) {
                return reject(intent, Outcome.UNAVAILABLE, "owned_iron_route_unavailable");
            }
            collectRouteInstalled = true;
            phase = Phase.COLLECT_DROP;
        }
        if (collectAtPickup) {
            return active(stopped(intent, "golem_owned_drop_wait_inventory"),
                "owned_drop_wait_inventory", intent);
        }
        RouteTick route = driveRoute(client, player, intent, collectRoute,
            "golem_owned_drop_collect", nowMs);
        if (route.rejected()) {
            return reject(intent, Outcome.UNAVAILABLE, "owned_iron_" + route.reason());
        }
        if (route.reached()) {
            collectRoute.clear();
            collectAtPickup = true;
        }
        return active(route.decision() == null
            ? stopped(intent, "golem_owned_drop_wait_inventory") : route.decision(),
            route.reached() ? "owned_drop_wait_inventory" : "owned_drop_collect", intent);
    }

    static boolean collectionEndpointWithinBounds(VoxelCell start, VoxelCell drop) {
        if (start == null || drop == null) {
            return false;
        }
        int horizontalManhattan = Math.abs(start.x() - drop.x())
            + Math.abs(start.z() - drop.z());
        return horizontalManhattan <= COLLECTION_HORIZONTAL_RADIUS
            && Math.abs(start.y() - drop.y()) <= COLLECTION_VERTICAL_DELTA;
    }

    static boolean collectionRouteWithinBounds(List<VoxelCell> route) {
        return route != null && !route.isEmpty()
            && route.size() <= COLLECTION_MAX_ROUTE_CELLS;
    }

    private RouteTick driveRoute(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        VillageLocalRouteController controller,
        String reason,
        long nowMs
    ) {
        VoxelCell current = feet(player);
        VoxelCell waypoint = controller.activeWaypoint();
        Vec3d aim = waypoint == null ? player.getPos()
            : new Vec3d(waypoint.x() + 0.5D, waypoint.y(), waypoint.z() + 0.5D);
        McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(player, aim);
        boolean aligned = Math.abs(McbotFabricClient.wrapDegreesDelta(
            look.yaw() - player.getYaw())) <= 24.0D;
        boolean safe = safeCell(client, current);
        MiningWorkspaceSiteTraversalController.Step step = controller.tick(
            commandId,
            new MiningWorkspaceSiteTraversalController.Observation(
                current, player.getX(), player.getY(), player.getZ(), player.isOnGround(),
                aligned, !player.isTouchingWater(), safe, safe),
            cell -> safeCell(client, cell), nowMs);
        if (step == null) {
            return new RouteTick(null, false, true, "route_not_active");
        }
        if (step.outcome() == MiningWorkspaceSiteTraversalController.Outcome.REACHED) {
            return new RouteTick(stopped(intent, reason + "_reached"), true, false, "reached");
        }
        if (step.outcome() == MiningWorkspaceSiteTraversalController.Outcome.REJECTED) {
            return new RouteTick(stopped(intent, reason + "_rejected"), false, true, step.reason());
        }
        VillageRouteMovementPolicy.Output movement = VillageRouteMovementPolicy.apply(step, current);
        String driveReason = routeDriveReason(reason, step.descentExempt());
        InputState input = new InputState(
            movement.forward(), false, false, false, movement.jump(), false,
            movement.forward() ? 1.0F : 0.0F, 0.0F);
        BrainLink.Intent facing = shell.lookIntentForAngles(
            intent, look.yaw(), look.pitch(), driveReason);
        LocomotionDemand locomotion = LocomotionDemand.passthrough(
            LookDemand.Owner.NORMAL, input, movement.sprintRequested(), commandId, driveReason);
        return new RouteTick(new ControlDecision(
            facing, input, null, null, locomotion), false, false, step.reason());
    }

    static String routeDriveReason(String reason, boolean descentExempt) {
        String stableReason = stable(reason);
        return descentExempt
            ? "village_opportunity_route_" + stableReason + "_nav3d_descend"
            : stableReason;
    }

    private Step failOrEscape(
        BrainLink.Intent intent,
        Outcome outcome,
        String reason,
        long nowMs
    ) {
        if (attack.engaged() && plan != null) {
            MinecraftClient client = MinecraftClient.getInstance();
            if (!typedDeathConfirmed) {
                return emergencySafetyTerminal(
                    client, intent, "live_target_" + normalize(reason));
            }
            if (phase == Phase.ESCAPE) {
                return reject(intent, outcome, reason);
            }
            attack.beginEscape(reason, nowMs);
            return beginEscape(client, client == null ? null : client.player, intent,
                true, outcome, reason, nowMs);
        }
        return reject(intent, outcome, reason);
    }

    private Step emergencySafetyTerminal(
        MinecraftClient client,
        BrainLink.Intent intent,
        String reason
    ) {
        String classified = normalize(reason).isBlank()
            ? "post_engagement_safety_invalidated" : normalize(reason);
        requestEmergencyDisconnect(client, classified);
        return reject(intent, Outcome.UNSAFE, "emergency_disconnect:" + classified);
    }

    private void requestEmergencyDisconnect(MinecraftClient client, String reason) {
        if (emergencyDisconnectRequested) {
            return;
        }
        emergencyDisconnectRequested = true;
        if (client == null) {
            return;
        }
        String disconnectCommandId = commandId;
        String disconnectOpportunityId = opaqueOpportunityId;
        String disconnectTargetUuid = targetUuidForLog();
        String disconnectEntityIdentity = exactIdentity();
        String disconnectReason = normalize(reason);
        client.execute(() -> {
            ClientPlayNetworkHandler handler = client.getNetworkHandler();
            if (handler != null) {
                handler.getConnection().disconnect(
                    Text.literal("mcbot_village_golem:" + disconnectReason));
                shell.logger().warn(
                    "village.opportunity.golem.emergency_disconnect instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} reason={}",
                    shell.instanceId(), disconnectCommandId, disconnectOpportunityId,
                    disconnectTargetUuid, disconnectEntityIdentity, disconnectReason);
            }
        });
    }

    private Step active(ControlDecision decision, String reason, BrainLink.Intent intent) {
        return new Step(decision == null ? stopped(intent, reason) : decision,
            Outcome.ACTIVE, phase, reason, opaqueOpportunityId, exactIdentity(), Map.of());
    }

    private Step reject(BrainLink.Intent intent, Outcome outcome, String reason) {
        phase = Phase.REJECTED;
        deferredOutcome = outcome;
        deferredReason = reason;
        logRejectedOnce(intent, outcome, reason);
        return terminal(intent, outcome, reason);
    }

    private void logRejectedOnce(BrainLink.Intent intent, Outcome outcome, String reason) {
        if (!rejectedLogged) {
            rejectedLogged = true;
            String logCommandId = commandId.isBlank() && intent != null
                ? stable(intent.commandId()) : commandId;
            String logOpportunityId = opaqueOpportunityId.isBlank() && intent != null
                ? stable(intent.opportunityId()) : opaqueOpportunityId;
            shell.logger().warn(
                "village.opportunity.golem.rejected instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} engaged={} pillarBlocksPlaced={} fillerBefore={} reason={} result={} elapsedMs={}",
                shell.instanceId(), logCommandId, logOpportunityId,
                targetUuidForLog(), exactIdentity(),
                attack.engaged(), pillar.completedPlacements(), baselineFiller,
                normalize(reason), outcome.name().toLowerCase(java.util.Locale.ROOT),
                startedAtMs <= 0L ? 0L
                    : Math.max(0L, System.currentTimeMillis() - startedAtMs));
        }
    }

    private Step terminal(BrainLink.Intent intent, Outcome outcome, String reason) {
        if (outcome != Outcome.ACTIVE && outcome != Outcome.COLLECTED) {
            logRejectedOnce(intent, outcome, reason);
        }
        return new Step(stopped(intent, "village_golem_" + normalize(reason)), outcome,
            phase, reason, opaqueOpportunityId, exactIdentity(), Map.of());
    }

    private ControlDecision placementDecision(
        BrainLink.Intent intent,
        IronGolemPillarController.Step step,
        BlockPlaceController.Result result
    ) {
        InputState input = new InputState(false, false, false, false, step.jump(), step.sneak(),
            0.0F, 0.0F);
        ControlDecision base = new ControlDecision(intent, input);
        if (result == null || result.interactionDemand() == null) {
            return base;
        }
        return new ControlDecision(
            base.intent(), base.input(), base.lookDemand(), base.legacyLookDemand(),
            base.locomotionDemand(), result.interactionDemand(), result.interactionPayload());
    }

    private BrainLink.Intent lookAtCell(
        BrainLink.Intent intent,
        ClientPlayerEntity player,
        VoxelCell cell,
        String reason
    ) {
        Vec3d point = new Vec3d(cell.x() + 0.5D, cell.y(), cell.z() + 0.5D);
        McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(player, point);
        return shell.lookIntentForAngles(intent, look.yaw(), look.pitch(), reason);
    }

    private boolean activeFor(BrainLink.Intent intent) {
        return phase != Phase.IDLE && intent != null
            && commandId.equals(stable(intent.commandId()))
            && opaqueOpportunityId.equals(stable(intent.opportunityId()));
    }

    private IronGolemEntity resolveFrozen(MinecraftClient client) {
        IronGolemEntity current = resolver == null ? null
            : resolver.resolve(client, opaqueOpportunityId);
        if (current != null && exactJavaUuid != null && exactJavaUuid.equals(current.getUuid())) {
            frozenTarget = current;
            return current;
        }
        return null;
    }

    private boolean defenseBlocksValid(MinecraftClient client) {
        if (plan.mode() == IronGolemDefensePackagePlanner.Mode.EXISTING_PROTECTED_STANCE) {
            return true;
        }
        for (VoxelCell cell : plan.placementCells()) {
            BlockPos pos = blockPos(cell);
            Block expected = expectedPillarBlocks.get(cell);
            if (expected == null || !client.world.getBlockState(pos).isOf(expected)) {
                return false;
            }
        }
        return true;
    }

    private String postEngagementSafety(
        ClientPlayerEntity player,
        int nearbyHostileCount
    ) {
        if (!attack.engaged() || player == null) {
            return "";
        }
        if (engagementHealthBaseline > 0.0D
            && player.getHealth() + 0.01D < engagementHealthBaseline) {
            return "player_health_lost_after_engagement";
        }
        return nearbyHostileCount > 0 ? "nearby_threats_after_engagement" : "";
    }

    static String protectedFinishImpossibleReason(
        boolean exactTargetAlive,
        boolean defenseGeometryValid,
        boolean withinHitboxReach,
        boolean lineOfSight
    ) {
        if (!exactTargetAlive) {
            return "exact_target_unavailable";
        }
        if (!defenseGeometryValid) {
            return "defense_geometry_invalidated";
        }
        if (!withinHitboxReach) {
            return "target_out_of_hitbox_reach";
        }
        return lineOfSight ? "" : "target_line_of_sight_blocked";
    }

    private boolean runtimeEscapeLandingSafe(
        MinecraftClient client,
        VoxelCell landing,
        int nearbyHostileCount
    ) {
        return nearbyHostileCount <= 0
            && landing != null
            && landing.equals(plan == null ? null : plan.escapeRoute().getLast())
            && runtimeEscapeCellSafe(client, landing);
    }

    private boolean runtimeEscapeCellSafe(
        MinecraftClient client,
        VoxelCell cell
    ) {
        if (!safeCell(client, cell) || plan == null) {
            return false;
        }
        if (typedDeathConfirmed) {
            return true;
        }
        IronGolemEntity live = resolveFrozen(client);
        if (live == null || !live.isAlive()) {
            return false;
        }
        Box bounds = live.getBoundingBox();
        return outsideLiveGolemReach(
            cell,
            new IronGolemDefensePackagePlanner.EntityBounds(
                bounds.minX, bounds.minY, bounds.minZ,
                bounds.maxX, bounds.maxY, bounds.maxZ));
    }

    static boolean outsideLiveGolemReach(
        VoxelCell cell,
        IronGolemDefensePackagePlanner.EntityBounds bounds
    ) {
        if (cell == null || bounds == null) {
            return false;
        }
        double playerMinX = cell.x() + 0.2D;
        double playerMaxX = cell.x() + 0.8D;
        double playerMinY = cell.y();
        double playerMaxY = cell.y() + 1.8D;
        double playerMinZ = cell.z() + 0.2D;
        double playerMaxZ = cell.z() + 0.8D;
        double dx = intervalGap(playerMinX, playerMaxX, bounds.minX(), bounds.maxX());
        double dy = intervalGap(playerMinY, playerMaxY, bounds.minY(), bounds.maxY());
        double dz = intervalGap(playerMinZ, playerMaxZ, bounds.minZ(), bounds.maxZ());
        double closestHitboxDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        return closestHitboxDistance
            > IronGolemDefensePackagePlanner.ENTITY_REACH + LIVE_GOLEM_ESCAPE_MARGIN;
    }

    private static double intervalGap(
        double firstMin,
        double firstMax,
        double secondMin,
        double secondMax
    ) {
        if (firstMax < secondMin) {
            return secondMin - firstMax;
        }
        return secondMax < firstMin ? firstMin - secondMax : 0.0D;
    }

    private VoxelCell activePlacementCell() {
        if (plan == null || plan.placementCells().isEmpty()) {
            return null;
        }
        int index = Math.min(pillar.completedPlacements(), plan.placementCells().size() - 1);
        return plan.placementCells().get(index);
    }

    private BlockPlaceController.PlaceSpec fillerSpec(ClientPlayerEntity player) {
        int cobblestone = inventoryCount(player, Items.COBBLESTONE);
        String[] ids = cobblestone > 3
            ? new String[] { "cobblestone", "dirt" }
            : new String[] { "dirt" };
        for (String id : ids) {
            int slot = shell.findHotbarSlot(player, item -> id.equals(item));
            if (slot < 0) {
                slot = shell.moveInventoryItemToHotbar(
                    MinecraftClient.getInstance(), player, item -> id.equals(item),
                    commandId, "village_golem_pillar");
            }
            if (slot >= 0) {
                player.getInventory().selectedSlot = slot;
                return "cobblestone".equals(id)
                    ? BlockPlaceController.PlaceSpec.cobblestone()
                    : BlockPlaceController.PlaceSpec.supportBlock("dirt", Blocks.DIRT);
            }
        }
        return null;
    }

    private static Block blockForSpec(BlockPlaceController.PlaceSpec spec) {
        return spec != null && "dirt".equals(normalize(spec.itemId()))
            ? Blocks.DIRT : Blocks.COBBLESTONE;
    }

    private int ensureQualifyingSwordHotbar(
        MinecraftClient client,
        ClientPlayerEntity player
    ) {
        int slot = shell.findHotbarSlot(
            player, IronGolemOpportunityExecutor::isQualifyingSword);
        if (slot >= 0) {
            return slot;
        }
        return shell.moveInventoryItemToHotbar(
            client, player, IronGolemOpportunityExecutor::isQualifyingSword,
            commandId, "village_golem_weapon");
    }

    private static boolean isQualifyingSword(String itemId) {
        String id = normalize(itemId);
        if (id.startsWith("minecraft:")) {
            id = id.substring("minecraft:".length());
        }
        return "stone_sword".equals(id)
            || "iron_sword".equals(id)
            || "diamond_sword".equals(id)
            || "netherite_sword".equals(id);
    }

    private static int qualifyingSwordDurability(ClientPlayerEntity player) {
        int best = 0;
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack != null && !stack.isEmpty()
                && isQualifyingSword(
                    Registries.ITEM.getId(stack.getItem()).toString())) {
                best = Math.max(best, stack.getMaxDamage() - stack.getDamage());
            }
        }
        return best;
    }

    private static int fillerCount(ClientPlayerEntity player) {
        int total = 0;
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack != null && (stack.isOf(Items.COBBLESTONE) || stack.isOf(Items.DIRT))) {
                total += stack.getCount();
            }
        }
        return total;
    }

    private static int reservedFillerCount(ClientPlayerEntity player) {
        int cobblestone = 0;
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack != null && stack.isOf(Items.COBBLESTONE)) {
                cobblestone += stack.getCount();
            }
        }
        return Math.min(3, cobblestone);
    }

    private static int inventoryCount(ClientPlayerEntity player, net.minecraft.item.Item item) {
        int count = 0;
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack != null && stack.isOf(item)) {
                count += stack.getCount();
            }
        }
        return count;
    }

    private static Map<UUID, Integer> snapshotIronDrops(
        MinecraftClient client,
        Vec3d center
    ) {
        Map<UUID, Integer> counts = new HashMap<>();
        for (OwnedDropTracker.Observation observation : ironDropObservations(client, center)) {
            counts.put(observation.entityId(), observation.stackCount());
        }
        return Map.copyOf(counts);
    }

    private OwnedDropTracker.Update observeOwnedDrop(
        MinecraftClient client,
        long nowMs
    ) {
        OwnedDropTracker.Update update = dropTracker.update(
            ironDropObservations(
                client,
                frozenTarget == null ? Vec3d.ZERO : frozenTarget.getPos()),
            nowMs);
        if (update.latchedNow() && !dropLatchedLogged) {
            dropLatchedLogged = true;
            shell.logger().info(
                "village.opportunity.golem.drop.latched instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} dropEntity={} attributedIron={} initialPosition={} elapsedMs={}",
                shell.instanceId(), commandId, opaqueOpportunityId, targetUuidForLog(), exactIdentity(),
                update.observation() == null ? "none" : update.observation().entityId(),
                dropTracker.attributedStackDelta(), update.initialPosition(),
                Math.max(0L, nowMs - startedAtMs));
        }
        if (update.settledNow() && !dropSettledLogged) {
            dropSettledLogged = true;
            shell.logger().info(
                "village.opportunity.golem.drop.settled instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} dropEntity={} attributedIron={} settledPosition={} reacquisitions={} elapsedMs={}",
                shell.instanceId(), commandId, opaqueOpportunityId, targetUuidForLog(), exactIdentity(),
                dropTracker.entityId(), dropTracker.attributedStackDelta(),
                dropTracker.settledPosition(), dropTracker.reacquisitions(),
                Math.max(0L, nowMs - startedAtMs));
        }
        return update;
    }

    private Step completeCollection(
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        int ironGain,
        long nowMs
    ) {
        phase = Phase.COMPLETE;
        int fillerAfter = player == null ? 0 : fillerCount(player);
        shell.logger().info(
            "village.opportunity.golem.drop.recovered instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} dropEntity={} attributedIron={} inventoryIronIngotBefore={} inventoryIronIngotAfter={} elapsedMs={}",
            shell.instanceId(), commandId, opaqueOpportunityId, targetUuidForLog(), exactIdentity(),
            dropTracker.entityId(), ironGain,
            baselineIron, baselineIron + ironGain, Math.max(0L, nowMs - startedAtMs));
        shell.logger().info(
            "village.opportunity.golem.completed instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} inventoryIronIngotBefore={} inventoryIronIngotAfter={} fillerBefore={} fillerAfter={} pillarBlocksPlaced={} acknowledgedAttacks={} inventoryDeltaVerified=true elapsedMs={} result=collected",
            shell.instanceId(), commandId, opaqueOpportunityId, targetUuidForLog(), exactIdentity(),
            baselineIron, baselineIron + ironGain, baselineFiller, fillerAfter,
            pillar.completedPlacements(), attack.acknowledgedAttacks(),
            Math.max(0L, nowMs - startedAtMs));
        return new Step(stopped(intent, "golem_iron_inventory_verified"), Outcome.COLLECTED,
            phase, "iron_inventory_delta_verified", opaqueOpportunityId,
            exactIdentity(), Map.of("minecraft:iron_ingot", ironGain));
    }

    private void logNewPillarPlacements(
        ClientPlayerEntity player,
        int completed,
        long nowMs
    ) {
        while (loggedPillarPlacements < completed) {
            int index = loggedPillarPlacements;
            VoxelCell cell = plan.placementCells().get(index);
            shell.logger().info(
                "village.opportunity.golem.pillar.placed instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} pillarIndex={} placementCell={} fillerAfter={} elapsedMs={}",
                shell.instanceId(), commandId, opaqueOpportunityId, targetUuidForLog(), exactIdentity(),
                index + 1, cell, fillerCount(player), Math.max(0L, nowMs - startedAtMs));
            loggedPillarPlacements += 1;
        }
    }

    private void logDefenseReady(ClientPlayerEntity player, long nowMs) {
        shell.logger().info(
            "village.opportunity.golem.defense.ready instanceId={} commandId={} opportunityId={} targetUuid={} entityIdentity={} mode={} attackStance={} escapeLanding={} pillarBlocksPlaced={} fillerAfter={} elapsedMs={}",
            shell.instanceId(), commandId, opaqueOpportunityId, exactUuid, exactIdentity(),
            plan.mode().name().toLowerCase(java.util.Locale.ROOT), plan.attackStance(),
            plan.escapeLanding(), pillar.completedPlacements(), fillerCount(player),
            Math.max(0L, nowMs - startedAtMs));
    }

    private String targetUuidForLog() {
        return exactUuid.isBlank() ? "none" : exactUuid;
    }

    private static int nearbyLiveGolemCount(
        MinecraftClient client,
        IronGolemEntity target
    ) {
        if (client == null || client.world == null || target == null) {
            return 0;
        }
        return client.world.getEntitiesByClass(
            IronGolemEntity.class,
            target.getBoundingBox().expand(32.0D, 8.0D, 32.0D),
            entity -> entity != null && entity.isAlive()).size();
    }

    private static List<OwnedDropTracker.Observation> ironDropObservations(
        MinecraftClient client,
        Vec3d center
    ) {
        if (client == null || client.world == null || center == null) {
            return List.of();
        }
        Box bounds = new Box(center, center).expand(
            OwnedDropTracker.MAX_HORIZONTAL_DISTANCE,
            OwnedDropTracker.MAX_VERTICAL_DISTANCE,
            OwnedDropTracker.MAX_HORIZONTAL_DISTANCE);
        return client.world.getEntitiesByClass(
            ItemEntity.class, bounds,
            entity -> entity != null && entity.isAlive()
                && entity.getStack() != null && entity.getStack().isOf(Items.IRON_INGOT))
            .stream()
            .map(entity -> new OwnedDropTracker.Observation(
                entity.getUuid(), entity.getStack().getCount(), position(entity.getPos()),
                entity.isAlive(), entity.isOnGround()))
            .toList();
    }

    private static Vec3d closestHitPoint(
        ClientPlayerEntity player,
        IronGolemEntity entity
    ) {
        if (entity == null) {
            return player.getEyePos();
        }
        Vec3d eye = player.getEyePos();
        Box box = entity.getBoundingBox();
        return new Vec3d(
            Math.max(box.minX, Math.min(box.maxX, eye.x)),
            Math.max(box.minY, Math.min(box.maxY, eye.y)),
            Math.max(box.minZ, Math.min(box.maxZ, eye.z)));
    }

    private static boolean clearLineOfSight(
        MinecraftClient client,
        ClientPlayerEntity player,
        IronGolemEntity entity,
        Vec3d target
    ) {
        if (entity == null) {
            return false;
        }
        HitResult hit = client.world.raycast(new RaycastContext(
            player.getEyePos(), target, RaycastContext.ShapeType.COLLIDER,
            RaycastContext.FluidHandling.NONE, player));
        return hit.getType() == HitResult.Type.MISS
            || hit.getPos().squaredDistanceTo(target) <= 0.04D;
    }

    private static double angularError(
        ClientPlayerEntity player,
        McbotFabricClient.LookAngles look
    ) {
        return Math.hypot(
            McbotFabricClient.wrapDegreesDelta(look.yaw() - player.getYaw()),
            look.pitch() - player.getPitch());
    }

    private static boolean alignedTo(
        ClientPlayerEntity player,
        VoxelCell cell,
        double tolerance
    ) {
        Vec3d target = new Vec3d(cell.x() + 0.5D, cell.y(), cell.z() + 0.5D);
        double dx = target.x - player.getX();
        double dz = target.z - player.getZ();
        double desiredYaw = Math.toDegrees(Math.atan2(-dx, dz));
        return Math.abs(McbotFabricClient.wrapDegreesDelta(
            desiredYaw - player.getYaw())) <= tolerance;
    }

    private static boolean safeCell(MinecraftClient client, VoxelCell cell) {
        if (client == null || client.world == null || cell == null) {
            return false;
        }
        WorldVoxelPerception perception = new WorldVoxelPerception(
            client.world, cell.x() - 1, cell.x() + 1,
            cell.y() - 2, cell.y() + 2,
            cell.z() - 1, cell.z() + 1);
        return VillageInteractionStancePlanner.safeStance(perception, cell);
    }

    private static VoxelCell feet(ClientPlayerEntity player) {
        return new VoxelCell(
            (int) Math.floor(player.getX()),
            (int) Math.floor(player.getY() + 0.001D),
            (int) Math.floor(player.getZ()));
    }

    private static BlockPos blockPos(VoxelCell cell) {
        return new BlockPos(cell.x(), cell.y(), cell.z());
    }

    private static OwnedDropTracker.Position position(Vec3d value) {
        return new OwnedDropTracker.Position(value.x, value.y, value.z);
    }

    private String exactIdentity() {
        return exactUuid.isBlank() ? "" : "iron_golem:" + exactUuid;
    }

    private ControlDecision stopped(BrainLink.Intent intent, String reason) {
        return new ControlDecision(shell.stopFrom(intent, reason), InputState.stop());
    }

    private record RouteTick(
        ControlDecision decision,
        boolean reached,
        boolean rejected,
        String reason
    ) {
    }

    private static final class LiveDefensePerception
        implements IronGolemDefensePackagePlanner.Perception {
        private final MinecraftClient client;
        private final WorldVoxelPerception delegate;

        LiveDefensePerception(MinecraftClient client, WorldVoxelPerception delegate) {
            this.client = client;
            this.delegate = delegate;
        }

        @Override public int minX() { return delegate.minX(); }
        @Override public int maxX() { return delegate.maxX(); }
        @Override public int minY() { return delegate.minY(); }
        @Override public int maxY() { return delegate.maxY(); }
        @Override public int minZ() { return delegate.minZ(); }
        @Override public int maxZ() { return delegate.maxZ(); }
        @Override public boolean isSolid(int x, int y, int z) {
            return delegate.isSolid(x, y, z);
        }
        @Override public boolean isHazard(int x, int y, int z) {
            return delegate.isHazard(x, y, z);
        }
        @Override public boolean isWater(int x, int y, int z) {
            return delegate.isWater(x, y, z);
        }
        @Override public boolean isLava(int x, int y, int z) {
            return delegate.isLava(x, y, z);
        }
        @Override public boolean isFullHeightSupport(int x, int y, int z) {
            return delegate.isFullHeightSupport(x, y, z);
        }
        @Override public boolean isProtectedBlock(int x, int y, int z) {
            BlockState state = client.world.getBlockState(new BlockPos(x, y, z));
            return state.isOf(Blocks.BEDROCK) || state.getHardness(client.world,
                new BlockPos(x, y, z)) < 0.0F;
        }
        @Override public boolean isContainerBlock(int x, int y, int z) {
            BlockState state = client.world.getBlockState(new BlockPos(x, y, z));
            return state.hasBlockEntity() || state.isOf(Blocks.CRAFTING_TABLE)
                || state.isOf(Blocks.FURNACE);
        }
        @Override public boolean isExistingProtectedAttackStance(
            VoxelCell stance,
            IronGolemDefensePackagePlanner.EntityBounds targetBounds
        ) {
            return false;
        }
    }

    private static String stable(String value) {
        String normalized = value == null ? "" : value.trim();
        return normalized.length() <= 128 ? normalized : "";
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
    }
}
