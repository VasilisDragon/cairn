package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import net.minecraft.block.BedBlock;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.passive.IronGolemEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.screen.GenericContainerScreenHandler;
import net.minecraft.screen.CraftingScreenHandler;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

/**
 * Deterministic, bounded village opportunity actions.
 *
 * <p>Every action is a neutral detour transaction stage. It never grants route, dig, build, or
 * inventory authority: routes are local safe voxel routes, harvesting names exact hay/bed blocks,
 * GUI withdrawal is limited to a code-owned value allowlist, and completion always verifies a live
 * inventory or world delta.
 */
final class VillageOpportunityExecutor implements ObjectiveExecutor {
    static final long ACTION_TIMEOUT_MS = 45_000L;
    static final long TERMINAL_CLEANUP_TIMEOUT_MS = 2_000L;
    static final long HANDOFF_CLEANUP_TIMEOUT_MS = 12_000L;
    static final int MAX_TERMINAL_CLEANUP_ATTEMPTS = 8;
    static final long GUI_CLICK_SETTLE_MS = 100L;
    static final long CONTAINER_OPEN_GRACE_MS = 750L;
    static final int MAX_INSPECTED_CONTAINERS = 2;
    static final int MAX_HARVEST_COUNT = 16;
    static final int MAX_BED_COUNT = 4;
    static final double MAX_SESSION_RADIUS = 384.0D;
    static final double MIN_SAFE_HEALTH = 12.0D;
    static final double HOSTILE_RADIUS = 16.0D;

    private static final Set<String> ACTIONS = Set.of(
        "village_travel",
        "village_revalidate",
        "village_inspect_container",
        "village_withdraw_item",
        "village_harvest_hay",
        "village_craft_bread",
        "village_collect_bed",
        "village_defeat_iron_golem"
    );

    private static final Set<String> POSITIVE_LEDGER_ITEMS = Set.of(
        "minecraft:iron_ingot",
        "minecraft:raw_iron",
        "minecraft:coal",
        "minecraft:charcoal",
        "minecraft:iron_pickaxe",
        "minecraft:iron_sword",
        "minecraft:iron_axe",
        "minecraft:iron_helmet",
        "minecraft:iron_chestplate",
        "minecraft:iron_leggings",
        "minecraft:iron_boots",
        "minecraft:diamond",
        "minecraft:gold_ingot",
        "minecraft:golden_apple",
        "minecraft:obsidian",
        "minecraft:bread",
        "minecraft:apple",
        "minecraft:wheat",
        "minecraft:hay_block",
        "minecraft:bucket",
        "minecraft:water_bucket",
        "minecraft:flint_and_steel",
        "minecraft:shield",
        "minecraft:bow",
        "minecraft:arrow",
        "minecraft:saddle"
    );

    /** Village-acquired items whose existing downstream executors are hotbar-only. */
    private static final Set<String> ACTION_HOTBAR_ITEMS = Set.of(
        "minecraft:bread",
        "minecraft:apple",
        "minecraft:golden_apple",
        "minecraft:iron_pickaxe",
        "minecraft:iron_axe",
        "minecraft:iron_sword",
        "minecraft:water_bucket",
        "minecraft:flint_and_steel",
        "minecraft:shield",
        "minecraft:bow"
    );

    private static final Set<String> VILLAGE_EDIBLE_ITEMS = Set.of(
        "minecraft:bread",
        "minecraft:apple",
        "minecraft:golden_apple"
    );

    private static final Set<String> PROTECTED_HOTBAR_ITEMS = Set.of(
        "minecraft:crafting_table",
        "minecraft:furnace",
        "minecraft:water_bucket",
        "minecraft:bucket",
        "minecraft:shield",
        "minecraft:flint_and_steel",
        "minecraft:bow",
        "minecraft:cobblestone",
        "minecraft:dirt"
    );

    interface DiscoveryLookup {
        DiscoveryFact find(String opportunityId);

        /** Resolve the exact event-cached entity behind an opaque discovery id. */
        default IronGolemEntity resolveExactIronGolem(
            net.minecraft.client.world.ClientWorld world,
            String opportunityId
        ) {
            return null;
        }

        default boolean truncated() {
            return false;
        }

        default DiscoveryFact refresh(
            String opportunityId,
            BlockPos frozenTarget,
            MinecraftClient client,
            ClientPlayerEntity player,
            long nowMs
        ) {
            return find(opportunityId);
        }
    }

    record FrozenTravelArrival(
        String opportunityId,
        long opportunityRevision,
        BlockPos target,
        int detourStageSeq,
        String travelStage
    ) {
        FrozenTravelArrival {
            opportunityId = stable(opportunityId);
            target = target == null ? null : target.toImmutable();
            travelStage = normalize(travelStage);
        }

        boolean matches(
            String candidateOpportunityId,
            long candidateRevision,
            BlockPos candidateTarget,
            int candidateStageSeq,
            String revalidationStage
        ) {
            if (target == null || candidateTarget == null
                || detourStageSeq == Integer.MAX_VALUE
                || !opportunityId.equals(stable(candidateOpportunityId))
                || opportunityRevision != candidateRevision
                || !target.equals(candidateTarget)
                || candidateStageSeq != detourStageSeq + 1) {
                return false;
            }
            String expectedStage = "travel_edge".equals(travelStage)
                ? "revalidate_edge" : "revalidate";
            return expectedStage.equals(normalize(revalidationStage));
        }
    }

    interface WorldScopeLookup {
        WorldScope current();
    }

    record WorldScope(
        String worldId,
        String dimension,
        String mission,
        int nearbyHostileCount
    ) {
        WorldScope(String worldId, String dimension, String mission) {
            this(worldId, dimension, mission, 0);
        }

        WorldScope {
            worldId = stable(worldId);
            dimension = normalize(dimension);
            mission = normalize(mission);
            nearbyHostileCount = Math.max(0, nearbyHostileCount);
        }
    }

    record DiscoveryFact(
        String id,
        long revision,
        String type,
        BlockPos anchor,
        String status,
        boolean executorReady,
        List<String> signals
    ) {
        DiscoveryFact {
            id = stable(id);
            type = normalize(type);
            anchor = anchor == null ? null : anchor.toImmutable();
            status = normalize(status);
            signals = signals == null ? List.of() : signals.stream()
                .map(VillageOpportunityExecutor::normalize)
                .filter(value -> !value.isBlank())
                .toList();
        }

        boolean safelyExecutable() {
            boolean accessProven = signals.contains("access_proven")
                || "village".equals(type) && signals.contains("route_reachable");
            return "verified".equals(status)
                && executorReady
                && accessProven
                && signals.contains("hazard_free");
        }
    }

    private enum Phase {
        ROUTE,
        AT_STANCE,
        OPENING_CONTAINER,
        WAIT_CONTAINER,
        WITHDRAW_PICK_SOURCE,
        WITHDRAW_DEPOSIT,
        WITHDRAW_RETURN_REMAINDER,
        WITHDRAW_VERIFY,
        BREAKING,
        WAIT_INVENTORY,
        CRAFT_WHEAT,
        PLACE_TABLE,
        CRAFT_BREAD,
        RETRIEVE_TABLE
    }

    private enum HotbarStagingResult {
        READY,
        PENDING,
        FAILED
    }

    private enum HandoffCleanupPhase {
        NONE,
        GUI_AND_NESTED_CRAFT,
        TEMPORARY_TABLE,
        FINAL_BARRIER
    }

    private final ShellServices shell;
    private final VillageOpportunityReceiptStore receipts;
    private final DiscoveryLookup discoveries;
    private final WorldScopeLookup worldScope;
    private final BooleanSupplier executionEnabled;
    private final CommandLedger ledger = new CommandLedger(64);
    private final LinkedHashMap<String, Boolean> handoffAbortedCommands = new LinkedHashMap<>();
    private final VillageLocalRouteController routeController = new VillageLocalRouteController();
    private final IronGolemOpportunityExecutor ironGolemExecutor;
    private Run activeRun;
    private Session session;
    private long nextSessionId;
    private long containerRevision;

    VillageOpportunityExecutor(
        ShellServices shell,
        VillageOpportunityReceiptStore receipts,
        DiscoveryLookup discoveries,
        WorldScopeLookup worldScope
    ) {
        this(shell, receipts, discoveries, worldScope, () -> false);
    }

    VillageOpportunityExecutor(
        ShellServices shell,
        VillageOpportunityReceiptStore receipts,
        DiscoveryLookup discoveries,
        WorldScopeLookup worldScope,
        BooleanSupplier executionEnabled
    ) {
        this.shell = shell;
        this.receipts = receipts;
        this.discoveries = discoveries;
        this.worldScope = worldScope;
        this.executionEnabled = executionEnabled == null ? () -> false : executionEnabled;
        this.ironGolemExecutor = new IronGolemOpportunityExecutor(
            shell,
            (client, opportunityId) -> discoveries == null || client == null
                || client.world == null
                    ? null
                    : discoveries.resolveExactIronGolem(client.world, opportunityId));
    }

    @Override
    public boolean handles(String action) {
        return ACTIONS.contains(action);
    }

    @Override
    public ControlDecision tick(TickContext ctx) {
        MinecraftClient client = ctx.client();
        ClientPlayerEntity player = ctx.player();
        BrainLink.Intent intent = ctx.intent();
        long nowMs = ctx.nowMs();
        String action = intent == null ? "" : normalize(intent.action());
        String commandId = intent == null ? "" : stable(intent.commandId());

        if (handoffAbortedCommands.containsKey(commandId)) {
            return stopped(intent, "village_opportunity_handoff_aborted");
        }

        String completed = ledger.reason(commandId);
        if (completed != null) {
            return stopped(intent, completed);
        }
        if (!handles(action)) {
            return stopped(intent, "village_opportunity_unhandled");
        }
        if (!executionEnabled.getAsBoolean()) {
            String reason = action + "_complete:opportunity_unavailable";
            ledger.markComplete(commandId, reason);
            shell.completeCurrentCommand(commandId, reason, nowMs);
            return stopped(intent, reason);
        }
        if (client == null || client.world == null || player == null) {
            return finish(intent, ensureRun(intent, client, player, nowMs),
                VillageOpportunityReceiptStore.Result.UNAVAILABLE, "unavailable", nowMs, Map.of());
        }

        if (session != null && session.world != client.world) {
            clearActiveRun();
            clearSession();
        }
        if (activeRun != null && !sameEffectiveIntent(activeRun, intent)) {
            observeEffectiveIntentHandoff(client, player, intent, nowMs);
            return stopped(intent, "village_opportunity_handoff_cleanup");
        }
        if (activeRun == null) {
            activeRun = startRun(intent, client, player, nowMs);
            if (activeRun == null) {
                Run rejected = new Run(intent, commandId, action, stable(intent.opportunityId()),
                    safeRevision(intent.opportunityRevision()),
                    normalize(intent.opportunityStage()), target(intent),
                    Math.max(1, intent.targetItemCount() == null ? 1 : intent.targetItemCount()),
                    nowMs, captureInventoryCounts(player));
                rejected.detourStageSeq = intent.detourStageSeq() == null
                    ? -1 : intent.detourStageSeq();
                rejected.targetItemId = targetItemForRun(intent, action);
                return finish(intent, rejected,
                    VillageOpportunityReceiptStore.Result.INVALIDATED,
                    "invalidated", nowMs, Map.of());
            }
        }
        Run run = activeRun;

        if (session == null) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.INVALIDATED,
                "invalidated", nowMs, Map.of());
        }
        if (run.terminalResult != null) {
            return finish(
                intent, run, run.terminalResult, run.terminalSuffix,
                nowMs, run.terminalContents);
        }

        session.observe(player);
        if (nowMs - session.startedAtMs >= 420_000L
            || session.groundedTravelBlocks > MAX_SESSION_RADIUS
            || session.failures >= 2) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                "unavailable", nowMs, Map.of());
        }

        String safety = safetyFailure(client, player);
        if (!safety.isBlank()
            && !("village_defeat_iron_golem".equals(action)
                && ironGolemExecutor.engaged())) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.UNSAFE,
                "unsafe", nowMs, Map.of());
        }
        if (!"village_travel".equals(action)
            && !"village_defeat_iron_golem".equals(action)
            && nowMs - run.startedAtMs >= ACTION_TIMEOUT_MS) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                "unavailable", nowMs, Map.of());
        }
        if (!sessionAllows(client, run)) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.INVALIDATED,
                "invalidated", nowMs, Map.of());
        }

        return switch (action) {
            case "village_travel" -> tickTravel(client, player, intent, run, nowMs);
            case "village_revalidate" -> tickRevalidate(client, player, intent, run, nowMs);
            case "village_inspect_container" -> tickInspect(client, player, intent, run, nowMs);
            case "village_withdraw_item" -> tickWithdraw(client, player, intent, run, nowMs);
            case "village_harvest_hay" -> tickHarvest(client, player, intent, run, nowMs, true);
            case "village_collect_bed" -> tickHarvest(client, player, intent, run, nowMs, false);
            case "village_craft_bread" -> tickCraftBread(client, player, intent, run, nowMs);
            case "village_defeat_iron_golem" ->
                tickDefeatIronGolem(client, player, intent, run, nowMs);
            default -> finish(intent, run, VillageOpportunityReceiptStore.Result.INVALIDATED,
                "invalidated", nowMs, Map.of());
        };
    }

    private Run startRun(
        BrainLink.Intent intent,
        MinecraftClient client,
        ClientPlayerEntity player,
        long nowMs
    ) {
        String action = normalize(intent.action());
        String commandId = stable(intent.commandId());
        String opportunityId = stable(intent.opportunityId());
        long revision = safeRevision(intent.opportunityRevision());
        BlockPos target = target(intent);
        int requested = Math.max(1, intent.targetItemCount() == null ? 1 : intent.targetItemCount());
        if (commandId.isBlank() || opportunityId.isBlank() || revision < 0L) {
            return null;
        }
        if (!"village_craft_bread".equals(action)
            && !"village_defeat_iron_golem".equals(action)
            && target == null) {
            return null;
        }
        if ("village_harvest_hay".equals(action) && requested > MAX_HARVEST_COUNT
            || "village_collect_bed".equals(action) && requested > MAX_BED_COUNT
            || "village_withdraw_item".equals(action) && requested > 64
            || "village_craft_bread".equals(action) && requested > 8) {
            return null;
        }
        if ("village_withdraw_item".equals(action)
            && !POSITIVE_LEDGER_ITEMS.contains(canonicalItem(intent.targetItemId()))) {
            return null;
        }
        String detourId = stable(intent.detourId());
        Integer requestedStageSeq = intent.detourStageSeq();
        String requestedStage = normalize(intent.opportunityStage());
        String requestedMission = normalize(intent.opportunityMission());
        if (detourId.isBlank() || requestedStageSeq == null || requestedStageSeq < 0
            || requestedMission.isBlank() || !stageAllowed(action, requestedStage)) {
            return null;
        }
        if (opensSessionAtActionAdmission(action)) {
            DiscoveryFact root = discoveries == null ? null : discoveries.find(opportunityId);
            if (session == null || !session.detourId.equals(detourId)) {
                WorldScope scope = worldScope == null ? null : worldScope.current();
                if (scope == null || scope.worldId().isBlank() || scope.dimension().isBlank()) {
                    return null;
                }
                BlockPos rootPosition = root == null || root.anchor() == null
                    ? target : root.anchor();
                if (rootPosition == null) {
                    return null;
                }
                scope = new WorldScope(
                    scope.worldId(), scope.dimension(), requestedMission,
                    scope.nearbyHostileCount());
                session = new Session(++nextSessionId, client.world, detourId,
                    stable(intent.resumeToken()), opportunityId, revision,
                    rootPosition,
                    player.getPos(), player.getHealth(), scope, nowMs);
            }
        }
        if (session == null || !session.detourId.equals(detourId)
            || requestedStageSeq <= session.lastStageSeq
            || !session.scope.mission().equals(requestedMission)
            || (!session.resumeToken.isBlank()
                && !session.resumeToken.equals(stable(intent.resumeToken())))) {
            return null;
        }
        Run run = new Run(
            intent, commandId, action, opportunityId, revision, requestedStage, target,
            requested, nowMs, captureInventoryCounts(player));
        run.foodLevelBefore = player.getHungerManager().getFoodLevel();
        run.maximumObservedFoodLevel = run.foodLevelBefore;
        run.targetItemId = targetItemForRun(intent, action);
        run.foodConsumptionTracker = VillageFoodConsumptionTracker.create(
            run.targetItemId,
            inventoryCount(player, run.targetItemId),
            run.foodLevelBefore);
        run.detourStageSeq = requestedStageSeq;
        DiscoveryFact admissionFact = discoveries == null
            ? null : discoveries.find(run.opportunityId);
        boolean deferredMissingRevalidation = discoveries != null
            && canDeferMissingRevalidation(
                action,
                admissionFact,
                session == null ? null : session.frozenTravelArrival,
                run.opportunityId,
                run.opportunityRevision,
                run.rootTarget,
                run.detourStageSeq,
                run.stage);
        boolean deferredMissingTravel = discoveries != null
            && canDeferMissingTravel(
                action,
                admissionFact,
                discoveries.truncated(),
                run.target,
                run.stage);
        if (requiresDiscovery(action)
            && !discoveryMatches(run, admissionFact)
            && !deferredMissingRevalidation
            && !deferredMissingTravel) {
            run.terminalResult = VillageOpportunityReceiptStore.Result.INVALIDATED;
            run.terminalSuffix = "invalidated";
            session.lastStageSeq = requestedStageSeq;
            return run;
        }
        if ("village_travel".equals(action)) {
            session.frozenTravelArrival = null;
        }
        if (requiresRoute(action)) {
            VillageInteractionStancePlanner.Mode mode = routeMode(action, run.opportunityId);
            if (!planRoute(client, player, run, mode, nowMs, false)) {
                run.terminalResult = VillageOpportunityReceiptStore.Result.UNAVAILABLE;
                run.terminalSuffix = "unavailable";
                session.lastStageSeq = requestedStageSeq;
                return run;
            }
        } else {
            run.phase = Phase.AT_STANCE;
        }
        // Admission and terminal-correlated prelaunch rejection are the only operations that
        // consume a stage sequence. Failed malformed requests above never mutate the session.
        session.lastStageSeq = requestedStageSeq;
        shell.logger().info(
            "village.opportunity.{}.started instanceId={} commandId={} opportunityId={} opportunityRevision={} stage={} target={} requested={} session={} routeLength={} expandedCells={}",
            eventStem(action), shell.instanceId(), commandId, opportunityId, revision,
            run.stage, format(target), requested, session == null ? 0L : session.id,
            run.plan == null ? 0 : run.plan.route().size(),
            run.plan == null ? 0 : run.plan.expandedCells());
        return run;
    }

    private ControlDecision tickTravel(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs
    ) {
        ControlDecision route = tickRoute(client, player, intent, run, nowMs);
        if (route != null) {
            return route;
        }
        return finish(intent, run, VillageOpportunityReceiptStore.Result.ARRIVED,
            "arrived", nowMs, Map.of());
    }

    private ControlDecision tickRevalidate(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs
    ) {
        ControlDecision route = tickRoute(client, player, intent, run, nowMs);
        if (route != null) {
            return route;
        }
        DiscoveryFact refreshed = discoveries == null
            ? null : discoveries.refresh(
                run.opportunityId, run.rootTarget, client, player, nowMs);
        if (!discoveryMatches(run, refreshed)) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.INVALIDATED,
                "invalidated", nowMs, Map.of());
        }
        return finish(intent, run, VillageOpportunityReceiptStore.Result.VERIFIED,
            "verified", nowMs, Map.of());
    }

    private ControlDecision tickInspect(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs
    ) {
        ControlDecision route = tickRoute(client, player, intent, run, nowMs);
        if (route != null) {
            return route;
        }
        if (session == null || (!session.inspectedContainers.contains(run.target)
            && session.inspectedContainers.size() >= MAX_INSPECTED_CONTAINERS)) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                "unavailable", nowMs, Map.of());
        }
        if (!(player.currentScreenHandler instanceof GenericContainerScreenHandler handler)) {
            return openContainer(client, player, intent, run, nowMs);
        }
        if (!run.containerUseApplied) {
            player.closeHandledScreen();
            return finish(intent, run, VillageOpportunityReceiptStore.Result.INVALIDATED,
                "invalidated", nowMs, Map.of());
        }
        if (!handler.getCursorStack().isEmpty() || !containerStillCorrelated(client, player, run)) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.UNSAFE,
                "unsafe", nowMs, Map.of());
        }
        Map<String, Integer> contents = stableContainerContents(handler, run, nowMs);
        if (contents == null) {
            return stopped(intent, "village_container_stable_read");
        }
        player.closeHandledScreen();
        session.inspectedContainers.add(run.target.toImmutable());
        session.knownContainers.put(run.target.toImmutable(), contents);
        long revision = ++containerRevision;
        run.containerRevision = revision;
        shell.logger().info(
            "village.opportunity.container.inspected instanceId={} commandId={} opportunityId={} target={} distinctItems={} itemCount={} containerRevision={} inspectedContainers={}",
            shell.instanceId(), run.commandId, run.opportunityId, format(run.target),
            contents.size(), contents.values().stream().mapToInt(Integer::intValue).sum(),
            revision, session.inspectedContainers.size());
        return finish(intent, run, VillageOpportunityReceiptStore.Result.INSPECTED,
            "inspected", nowMs, contents);
    }

    private ControlDecision tickWithdraw(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs
    ) {
        String itemId = canonicalItem(intent.targetItemId());
        int liveGain = run.withdrawBaselineFrozen
            ? inventoryCount(player, itemId) - run.withdrawInventoryBaseline
            : 0;
        if (run.withdrawBaselineFrozen && liveGain >= run.requestedCount) {
            run.withdrawPlayerGainVerified = true;
        }
        if (run.withdrawTransferred > run.requestedCount) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.INVALIDATED,
                "invalidated", nowMs, Map.of());
        }
        if (run.withdrawRemovalVerified
            && run.withdrawTransferred == run.requestedCount
            && run.withdrawPlayerGainVerified
            && run.withdrawCursorReturned) {
            if (player.currentScreenHandler != player.playerScreenHandler) {
                player.closeHandledScreen();
            }
            HotbarStagingResult hotbarStaging = ensureActionHotbar(
                client, player, run, itemId, nowMs);
            if (hotbarStaging == HotbarStagingResult.PENDING) {
                return stopped(intent, "village_withdraw_action_hotbar_verify");
            }
            if (hotbarStaging == HotbarStagingResult.FAILED) {
                return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                    "unavailable", nowMs, Map.of());
            }
            run.authoritativeInventoryDelta = Map.of(itemId, run.requestedCount);
            return finish(intent, run, VillageOpportunityReceiptStore.Result.WITHDRAWN,
                "withdrawn", nowMs, session == null ? Map.of()
                    : session.knownContainers.getOrDefault(run.target, Map.of()));
        }
        if (run.withdrawRemovalVerified
            && run.withdrawTransferred == run.requestedCount
            && run.withdrawCursorReturned) {
            if (nowMs - run.startedAtMs >= ACTION_TIMEOUT_MS) {
                return finish(intent, run, VillageOpportunityReceiptStore.Result.INVALIDATED,
                    "invalidated", nowMs, Map.of());
            }
            return stopped(intent, "village_withdraw_inventory_sync");
        }
        ControlDecision route = tickRoute(client, player, intent, run, nowMs);
        if (route != null) {
            return route;
        }
        if (session == null || !session.inspectedContainers.contains(run.target)
            || !POSITIVE_LEDGER_ITEMS.contains(itemId)) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                "unavailable", nowMs, Map.of());
        }
        if (!(player.currentScreenHandler instanceof GenericContainerScreenHandler handler)) {
            return openContainer(client, player, intent, run, nowMs);
        }
        if (!run.containerUseApplied) {
            player.closeHandledScreen();
            return finish(intent, run, VillageOpportunityReceiptStore.Result.INVALIDATED,
                "invalidated", nowMs, Map.of());
        }
        if (run.phase == Phase.WITHDRAW_VERIFY && run.withdrawCursorReturned) {
            if (!handler.getCursorStack().isEmpty()
                || !containerStillCorrelated(client, player, run)) {
                return finish(intent, run, VillageOpportunityReceiptStore.Result.UNSAFE,
                    "unsafe", nowMs, Map.of());
            }
            Map<String, Integer> verified = stableContainerContents(handler, run, nowMs);
            if (verified == null) {
                return stopped(intent, "village_withdraw_removal_verify");
            }
            int removed = run.withdrawContainerBaselineCount
                - verified.getOrDefault(itemId, 0);
            if (removed != run.withdrawTransferred) {
                return finish(intent, run, VillageOpportunityReceiptStore.Result.INVALIDATED,
                    "invalidated", nowMs, verified);
            }
            session.knownContainers.put(run.target.toImmutable(), verified);
            if (run.withdrawTransferred == run.requestedCount) {
                run.withdrawRemovalVerified = true;
                return stopped(intent, "village_withdraw_inventory_sync");
            }
            resetWithdrawalBatch(run);
            run.phase = Phase.WAIT_CONTAINER;
            return stopped(intent, "village_withdraw_continue");
        }
        if (!run.containerReadVerified) {
            if (!handler.getCursorStack().isEmpty()
                || !containerStillCorrelated(client, player, run)) {
                return finish(intent, run, VillageOpportunityReceiptStore.Result.UNSAFE,
                    "unsafe", nowMs, Map.of());
            }
            Map<String, Integer> reopened = stableContainerContents(handler, run, nowMs);
            if (reopened == null) {
                return stopped(intent, "village_withdraw_stable_reread");
            }
            run.containerReadVerified = true;
            session.knownContainers.put(run.target.toImmutable(), reopened);
            if (!run.withdrawBaselineFrozen) {
                // Freeze attribution only after the inspected container has been reopened,
                // correlated, and observed stable. Items acquired while travelling here are
                // deliberately outside the withdrawal receipt.
                run.withdrawInventoryBaseline = inventoryCount(player, itemId);
                run.withdrawContainerBaselineCount = reopened.getOrDefault(itemId, 0);
                run.withdrawBaselineFrozen = true;
            }
        }
        if (run.lastClickAtMs > 0L && nowMs - run.lastClickAtMs < GUI_CLICK_SETTLE_MS) {
            return stopped(intent, "village_withdraw_click_settle");
        }
        int containerSlots = handler.getRows() * 9;
        if (run.phase == Phase.WAIT_CONTAINER || run.phase == Phase.AT_STANCE
            || run.phase == Phase.OPENING_CONTAINER) {
            run.sourceSlot = findContainerSlot(handler, containerSlots, itemId);
            if (run.sourceSlot < 0) {
                player.closeHandledScreen();
                return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                    "unavailable", nowMs, captureContainer(handler));
            }
            int available = handler.getSlot(run.sourceSlot).getStack().getCount();
            int desired = Math.min(run.requestedCount - run.withdrawTransferred, available);
            if (desired <= 0) {
                player.closeHandledScreen();
                return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                    "unavailable", nowMs, captureContainer(handler));
            }
            run.withdrawDesired = desired;
            run.destinationSlot = findPlayerDestinationSlot(handler, containerSlots, itemId);
            if (run.destinationSlot < 0) {
                player.closeHandledScreen();
                return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                    "unavailable", nowMs, captureContainer(handler));
            }
            ItemStack destination = handler.getSlot(run.destinationSlot).getStack();
            int capacity = destination == null || destination.isEmpty()
                ? handler.getSlot(run.sourceSlot).getStack().getMaxCount()
                : Math.max(0, destination.getMaxCount() - destination.getCount());
            run.withdrawDesired = Math.min(run.withdrawDesired, capacity);
            if (run.withdrawDesired <= 0) {
                player.closeHandledScreen();
                return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                    "unavailable", nowMs, captureContainer(handler));
            }
            if (available <= run.withdrawDesired) {
                if (!clickSlot(client, player, handler, run, run.sourceSlot, 0,
                    SlotActionType.QUICK_MOVE, "withdraw_full", nowMs)) {
                    return finish(intent, run, VillageOpportunityReceiptStore.Result.UNSAFE,
                        "unsafe", nowMs, Map.of());
                }
                run.withdrawTransferred += available;
                run.withdrawCursorReturned = true;
                beginWithdrawalVerification(run);
                stableContainerContents(handler, run, nowMs);
                run.phase = Phase.WITHDRAW_VERIFY;
                return stopped(intent, "village_withdraw_verify");
            }
            run.phase = Phase.WITHDRAW_PICK_SOURCE;
        }
        if (run.phase == Phase.WITHDRAW_PICK_SOURCE) {
            if (!clickSlot(client, player, handler, run, run.sourceSlot, 0,
                SlotActionType.PICKUP, "withdraw_pick_source", nowMs)) {
                return finish(intent, run, VillageOpportunityReceiptStore.Result.UNSAFE,
                    "unsafe", nowMs, Map.of());
            }
            run.phase = Phase.WITHDRAW_DEPOSIT;
            return stopped(intent, "village_withdraw_pick_source");
        }
        if (run.phase == Phase.WITHDRAW_DEPOSIT) {
            ItemStack cursor = handler.getCursorStack();
            if (cursor == null || cursor.isEmpty()) {
                return finish(intent, run, VillageOpportunityReceiptStore.Result.INVALIDATED,
                    "invalidated", nowMs, captureContainer(handler));
            }
            if (run.withdrawCursorInitial <= 0) {
                run.withdrawCursorInitial = cursor.getCount();
            }
            run.withdrawDeposited = Math.max(
                0, run.withdrawCursorInitial - cursor.getCount());
            if (run.withdrawDeposited < run.withdrawDesired) {
                if (!clickSlot(client, player, handler, run, run.destinationSlot, 1,
                    SlotActionType.PICKUP, "withdraw_deposit_one", nowMs)) {
                    return finish(intent, run, VillageOpportunityReceiptStore.Result.UNSAFE,
                        "unsafe", nowMs, Map.of());
                }
                return stopped(intent, "village_withdraw_deposit");
            }
            run.phase = Phase.WITHDRAW_RETURN_REMAINDER;
        }
        if (run.phase == Phase.WITHDRAW_RETURN_REMAINDER) {
            if (!handler.getCursorStack().isEmpty()) {
                if (!clickSlot(client, player, handler, run, run.sourceSlot, 0,
                    SlotActionType.PICKUP, "withdraw_return_remainder", nowMs)) {
                    return finish(intent, run, VillageOpportunityReceiptStore.Result.UNSAFE,
                        "unsafe", nowMs, Map.of());
                }
                return stopped(intent, "village_withdraw_return_remainder");
            }
            run.withdrawTransferred += run.withdrawDeposited;
            run.withdrawCursorReturned = true;
            beginWithdrawalVerification(run);
            stableContainerContents(handler, run, nowMs);
            run.phase = Phase.WITHDRAW_VERIFY;
            return stopped(intent, "village_withdraw_verify");
        }
        return stopped(intent, "village_withdraw_wait_delta");
    }

    private static void beginWithdrawalVerification(Run run) {
        run.containerReadVerified = false;
        run.containerFingerprint = "";
        run.containerStablePolls = 0;
    }

    private static void resetWithdrawalBatch(Run run) {
        beginWithdrawalVerification(run);
        run.sourceSlot = -1;
        run.destinationSlot = -1;
        run.withdrawDesired = 0;
        run.withdrawDeposited = 0;
        run.withdrawCursorInitial = 0;
        run.withdrawCursorReturned = false;
    }

    private ControlDecision tickHarvest(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs,
        boolean hay
    ) {
        if (run.harvestAttributedCount == run.requestedCount) {
            return finishHarvest(client, player, intent, run, nowMs, hay);
        }
        if (run.breakVerified) {
            return tickHarvestOwnedDrop(client, player, intent, run, nowMs, hay);
        }
        ControlDecision route = tickRoute(client, player, intent, run, nowMs);
        if (route != null) {
            return route;
        }
        BlockState state = client.world.getBlockState(run.target);
        boolean valid = hay ? state.isOf(Blocks.HAY_BLOCK) : state.getBlock() instanceof BedBlock;
        boolean targetAir = state.isAir();
        if (!valid && (!run.segmentStarted || !targetAir)) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.INVALIDATED,
                "invalidated", nowMs, Map.of());
        }
        String breakReason = hay
            ? "village_harvest_hay_break" : "village_collect_bed_break";
        BrainLink.Intent look = shell.lookIntentForBlock(
            intent, player, run.target, breakReason);
        LookDemand lookDemand = LookDemand.fromNormalDecision(
            look, InputState.stop(), player.getYaw(), player.getPitch());
        // Once this executor has started the exact segment, air is the break controller's
        // nonterminal verification state. Let its existing 150 ms stable-air confirmation
        // reach BROKEN even if the raycast has already moved off the vanished block. Before
        // segment ownership is established, disappearance remains an invalidated opportunity.
        boolean confirmingOwnedAir = run.segmentStarted && targetAir;
        if (!confirmingOwnedAir && !shell.isLookingAtBlock(player, run.target)) {
            return new ControlDecision(look, InputState.stop(), lookDemand);
        }
        if (!run.segmentStarted) {
            run.segmentStarted = true;
            run.segmentTargetItemId = Registries.BLOCK.getId(state.getBlock()).toString();
            run.segmentBaselineInventory = inventoryCount(player, run.segmentTargetItemId);
            run.harvestDropTracker.arm(
                harvestItemSnapshot(client, run.target, run.segmentTargetItemId),
                dropPosition(run.target),
                nowMs);
        }
        BlockBreakController.Result result = shell.blockBreakController().tick(
            client, player, run.target, run.commandId + ":harvest", nowMs,
            false, 12_000L, false);
        shell.logBlockBreakResult(run.commandId, run.target, result);
        if (result.status() == BlockBreakController.Status.BROKEN) {
            run.breakVerified = true;
            run.breakVerifiedAtMs = nowMs;
            run.harvestDropTrackingStartedAtMs = nowMs;
            run.harvestDropCollectionStartedAtMs = 0L;
            run.harvestDropTracker.beginAcquisition(nowMs);
            run.phase = Phase.WAIT_INVENTORY;
        } else if (result.status() == BlockBreakController.Status.FAILED
            || result.status() == BlockBreakController.Status.REPOSITION) {
            return withInteraction(
                finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                    "unavailable", nowMs, Map.of()), result);
        }
        return withInteraction(
            new ControlDecision(look, InputState.stop(), lookDemand), result);
    }

    private ControlDecision tickHarvestOwnedDrop(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs,
        boolean hay
    ) {
        int targetInventory = inventoryCount(player, run.segmentTargetItemId);
        if (targetInventory > run.segmentBaselineInventory) {
            return acceptHarvestInventoryGain(client, player, intent, run, nowMs, hay);
        }

        List<OwnedDropTracker.Observation> observations = harvestItemObservations(
            client, run.target, run.segmentTargetItemId);
        UUID trackedEntity = run.harvestDropTracker.entityId();
        boolean trackedEntityLive = trackedEntity == null || observations.stream()
            .anyMatch(observation -> trackedEntity.equals(observation.entityId()));
        OwnedDropTracker.Update update;
        if (trackedEntity != null && !trackedEntityLive && observations.isEmpty()) {
            if (run.harvestDropDisappearedAtMs <= 0L) {
                run.harvestDropDisappearedAtMs = nowMs;
            }
            update = new OwnedDropTracker.Update(
                OwnedDropTracker.Phase.SETTLED,
                null,
                run.harvestDropTracker.initialPosition(),
                run.harvestDropTracker.settledPosition(),
                "entity_missing",
                false,
                false,
                false);
        } else {
            update = run.harvestDropTracker.update(observations, nowMs);
            if (update.observation() != null) {
                run.harvestDropLastObservation = update.observation();
                run.harvestDropDisappearedAtMs = 0L;
                trackedEntityLive = true;
            } else if (run.harvestDropTracker.entityId() != null) {
                trackedEntityLive = false;
                if (run.harvestDropDisappearedAtMs <= 0L) {
                    run.harvestDropDisappearedAtMs = nowMs;
                }
            }
            logHarvestDropTrackerTransitions(run, update, nowMs);
        }

        VillageHarvestOwnedDropRecovery.Decision recovery =
            VillageHarvestOwnedDropRecovery.decide(
                targetInventory,
                run.segmentBaselineInventory,
                update.phase(),
                !run.harvestDropRoute.isEmpty(),
                run.harvestDropReachedAtMs,
                trackedEntityLive,
                run.harvestDropCollectionStartedAtMs,
                run.harvestDropDisappearedAtMs,
                nowMs);
        return switch (recovery.action()) {
            case INVENTORY_GAIN ->
                acceptHarvestInventoryGain(client, player, intent, run, nowMs, hay);
            case HOLD_STATIONARY, WAIT_DISAPPEARANCE -> stopped(
                intent, hay ? "village_hay_wait_owned_drop" : "village_bed_wait_owned_drop");
            case WAIT_AT_PICKUP -> stopped(
                intent, hay ? "village_hay_wait_pickup" : "village_bed_wait_pickup");
            case SELECT_ROUTE -> selectHarvestDropRoute(
                client, player, intent, run, nowMs, false);
            case DRIVE_ROUTE -> tickHarvestDropRoute(
                client, player, intent, run, nowMs);
            case REJECT -> rejectHarvestDrop(intent, run, nowMs,
                update.phase() == OwnedDropTracker.Phase.REJECTED
                    && update.reason() != null && !update.reason().isBlank()
                        ? update.reason() : recovery.reason());
        };
    }

    private ControlDecision acceptHarvestInventoryGain(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs,
        boolean hay
    ) {
        run.consumedTargets.add(run.target.toImmutable());
        run.harvestAttributedCount += 1;
        run.attributedInventoryDelta.merge(run.segmentTargetItemId, 1, Integer::sum);
        shell.logger().info(
            "village.opportunity.harvest_owned_drop.recovered instanceId={} commandId={} opportunityId={} stage={} target={} targetItemId={} entityId={} initialPosition={} settledPosition={} routeLength={} routeAttempt={} elapsedMs={} reason=inventory_delta",
            shell.instanceId(), run.commandId, run.opportunityId, run.stage,
            format(run.target), run.segmentTargetItemId,
            run.harvestDropTracker.entityId(),
            formatDropPosition(run.harvestDropTracker.initialPosition()),
            formatDropPosition(run.harvestDropTracker.settledPosition()),
            run.harvestDropRoute.size(), run.harvestDropTracker.routeAttempts(),
            harvestDropElapsed(run, nowMs));
        resetHarvestDrop(run);
        shell.blockBreakController().reset();
        if (run.harvestAttributedCount == run.requestedCount) {
            return finishHarvest(client, player, intent, run, nowMs, hay);
        }
        if (!planNextHarvestTarget(client, player, run, nowMs, hay)) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                "unavailable", nowMs, Map.of());
        }
        return stopped(intent, hay
            ? "village_hay_next_target" : "village_bed_next_target");
    }

    private ControlDecision selectHarvestDropRoute(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs,
        boolean replan
    ) {
        OwnedDropTracker.Observation observation = run.harvestDropLastObservation;
        if (replan && (session == null || session.replans >= 1)) {
            return rejectHarvestDrop(intent, run, nowMs, "detour_replan_limit");
        }
        if (observation == null || observation.position() == null
            || !run.harvestDropTracker.recordRouteAttempt()) {
            return rejectHarvestDrop(intent, run, nowMs, "route_attempt_limit");
        }
        if (replan) {
            // Drop displacement/route invalidation consumes the same one-replan transaction
            // allowance as every other physical village route. It cannot create a hidden retry.
            session.replans += 1;
        }
        OwnedDropTracker.Position settled = observation.position();
        run.harvestDropTracker.moveSettledPosition(settled);
        VoxelCell start = feet(player);
        VoxelCell dropCell = new VoxelCell(
            (int) Math.floor(settled.x()),
            (int) Math.floor(settled.y()),
            (int) Math.floor(settled.z()));
        WorldVoxelPerception perception = new WorldVoxelPerception(
            client.world, start, dropCell, 4, 4);
        CollectTarget3DPlanner.TargetPlan plan = safeCell(client, start)
            ? CollectTarget3DPlanner.chooseTarget(
                perception, start, settled.x(), settled.y(), settled.z())
            : new CollectTarget3DPlanner.TargetPlan(null, List.of(), "start_unstandable");
        if (plan.cell() == null || plan.route().isEmpty()
            || plan.route().size() > VillageInteractionStancePlanner.MAX_ROUTE_CELLS
            || !CollectTarget3DPlanner.withinPickupRange(
                plan.cell(), settled.x(), settled.y(), settled.z())) {
            return rejectHarvestDrop(intent, run, nowMs, plan.reason());
        }
        boolean installed = replan
            ? run.harvestDropRouteController.replan(plan.route(), start, nowMs)
            : run.harvestDropRouteController.begin(
                run.commandId, plan.route(), start, nowMs,
                run.startedAtMs + ACTION_TIMEOUT_MS);
        if (!installed) {
            return rejectHarvestDrop(intent, run, nowMs, "route_install_rejected");
        }
        run.harvestDropRoute = plan.route();
        run.harvestDropRouteEntityId = run.harvestDropTracker.entityId();
        run.harvestDropRoutePosition = settled;
        run.harvestDropPickupCell = plan.cell();
        run.harvestDropReachedAtMs = 0L;
        shell.logger().info(
            "village.opportunity.harvest_owned_drop.route_selected instanceId={} commandId={} opportunityId={} stage={} target={} targetItemId={} entityId={} initialPosition={} settledPosition={} pickupCell={} routeLength={} routeAttempt={} elapsedMs={} reason={}",
            shell.instanceId(), run.commandId, run.opportunityId, run.stage,
            format(run.target), run.segmentTargetItemId,
            run.harvestDropTracker.entityId(),
            formatDropPosition(run.harvestDropTracker.initialPosition()),
            formatDropPosition(settled), plan.cell(), plan.route().size(),
            run.harvestDropTracker.routeAttempts(),
            harvestDropElapsed(run, nowMs),
            replan ? "displaced_or_invalidated_replan" : plan.reason());
        return stopped(intent, "village_harvest_owned_drop_route_selected");
    }

    private ControlDecision tickHarvestDropRoute(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs
    ) {
        OwnedDropTracker.Observation observation = run.harvestDropLastObservation;
        if (observation == null || run.harvestDropTracker.entityId() == null) {
            return rejectHarvestDrop(intent, run, nowMs, "owned_entity_missing");
        }
        if (!run.harvestDropTracker.entityId().equals(run.harvestDropRouteEntityId)) {
            return selectHarvestDropRoute(client, player, intent, run, nowMs, true);
        }
        boolean nearRoute = harvestDropPlayerNearRoute(player, run.harvestDropRoute);
        if (OwnedDropTraversal.needsReplan(
            run.harvestDropRouteEntityId,
            run.harvestDropTracker.entityId(),
            run.harvestDropRoutePosition,
            observation.position(),
            run.harvestDropRoute,
            nearRoute,
            run.harvestDropTracker.routeAttempts())) {
            return selectHarvestDropRoute(client, player, intent, run, nowMs, true);
        }

        VoxelCell currentFeet = feet(player);
        VoxelCell waypoint = run.harvestDropRouteController.activeWaypoint();
        Vec3d aim = waypoint == null ? player.getPos()
            : new Vec3d(waypoint.x() + 0.5D, waypoint.y(), waypoint.z() + 0.5D);
        McbotFabricClient.LookAngles angles = shell.lookAnglesToPoint(player, aim);
        boolean aligned = Math.abs(McbotFabricClient.wrapDegreesDelta(
            angles.yaw() - player.getYaw())) <= 24.0D;
        boolean safeFeet = safeCell(client, currentFeet);
        MiningWorkspaceSiteTraversalController.Observation routeObservation =
            new MiningWorkspaceSiteTraversalController.Observation(
                currentFeet, player.getX(), player.getY(), player.getZ(),
                player.isOnGround(), aligned, !player.isTouchingWater(),
                safeFeet, safeFeet);
        MiningWorkspaceSiteTraversalController.Step step =
            run.harvestDropRouteController.tick(
                run.commandId, routeObservation, cell -> safeCell(client, cell), nowMs);
        if (step == null) {
            return rejectHarvestDrop(intent, run, nowMs, "route_state_missing");
        }
        if (step.outcome() == MiningWorkspaceSiteTraversalController.Outcome.REACHED) {
            run.harvestDropReachedAtMs = nowMs;
            shell.logger().info(
                "village.opportunity.harvest_owned_drop.route_reached instanceId={} commandId={} opportunityId={} stage={} target={} targetItemId={} entityId={} pickupCell={} routeLength={} routeAttempt={} elapsedMs={} reason=pickup_cell",
                shell.instanceId(), run.commandId, run.opportunityId, run.stage,
                format(run.target), run.segmentTargetItemId,
                run.harvestDropTracker.entityId(), run.harvestDropPickupCell,
                run.harvestDropRoute.size(), run.harvestDropTracker.routeAttempts(),
                harvestDropElapsed(run, nowMs));
            return stopped(intent, "village_harvest_owned_drop_route_reached");
        }
        if (step.outcome() == MiningWorkspaceSiteTraversalController.Outcome.REJECTED) {
            // Structural rejection is not evidence that the item moved. Replaying the same
            // route would only disguise a stall as a bounded replan.
            return rejectHarvestDrop(intent, run, nowMs, step.reason());
        }
        VoxelCell active = step.waypoint();
        Vec3d target = active == null ? player.getPos()
            : new Vec3d(active.x() + 0.5D, active.y(), active.z() + 0.5D);
        McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(player, target);
        String reason = step.descentExempt()
            ? "village_harvest_owned_drop_nav3d_descend"
            : "village_harvest_owned_drop_nav3d";
        InputState input = new InputState(
            step.forward(), false, false, false, step.jump(), false,
            step.forward() ? 1.0F : 0.0F, 0.0F);
        return new ControlDecision(
            shell.lookIntentForAngles(intent, look.yaw(), look.pitch(), reason), input);
    }

    private ControlDecision rejectHarvestDrop(
        BrainLink.Intent intent,
        Run run,
        long nowMs,
        String reason
    ) {
        String classified = normalize(reason).isBlank() ? "unavailable" : normalize(reason);
        shell.logger().warn(
            "village.opportunity.harvest_owned_drop.rejected instanceId={} commandId={} opportunityId={} stage={} target={} targetItemId={} entityId={} initialPosition={} settledPosition={} pickupCell={} routeLength={} routeAttempt={} elapsedMs={} reason={}",
            shell.instanceId(), run.commandId, run.opportunityId, run.stage,
            format(run.target), run.segmentTargetItemId,
            run.harvestDropTracker.entityId(),
            formatDropPosition(run.harvestDropTracker.initialPosition()),
            formatDropPosition(run.harvestDropTracker.settledPosition()),
            run.harvestDropPickupCell, run.harvestDropRoute.size(),
            run.harvestDropTracker.routeAttempts(),
            harvestDropElapsed(run, nowMs), classified);
        resetHarvestDrop(run);
        return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
            "unavailable", nowMs, Map.of());
    }

    private void logHarvestDropTrackerTransitions(
        Run run,
        OwnedDropTracker.Update update,
        long nowMs
    ) {
        if (update.latchedNow()) {
            shell.logger().info(
                "village.opportunity.harvest_owned_drop.latched instanceId={} commandId={} opportunityId={} stage={} target={} targetItemId={} entityId={} initialPosition={} elapsedMs={}",
                shell.instanceId(), run.commandId, run.opportunityId, run.stage,
                format(run.target), run.segmentTargetItemId,
                update.observation().entityId(), formatDropPosition(update.initialPosition()),
                harvestDropElapsed(run, nowMs));
        }
        if (update.settledNow()) {
            run.harvestDropCollectionStartedAtMs = nowMs;
            shell.logger().info(
                "village.opportunity.harvest_owned_drop.settled instanceId={} commandId={} opportunityId={} stage={} target={} targetItemId={} entityId={} initialPosition={} settledPosition={} elapsedMs={}",
                shell.instanceId(), run.commandId, run.opportunityId, run.stage,
                format(run.target), run.segmentTargetItemId,
                run.harvestDropTracker.entityId(), formatDropPosition(update.initialPosition()),
                formatDropPosition(update.settledPosition()),
                harvestDropElapsed(run, nowMs));
        }
    }

    private static Map<UUID, Integer> harvestItemSnapshot(
        MinecraftClient client,
        BlockPos target,
        String expectedItemId
    ) {
        Map<UUID, Integer> snapshot = new HashMap<>();
        for (OwnedDropTracker.Observation observation
            : harvestItemObservations(client, target, expectedItemId)) {
            snapshot.put(observation.entityId(), observation.stackCount());
        }
        return Map.copyOf(snapshot);
    }

    private static List<OwnedDropTracker.Observation> harvestItemObservations(
        MinecraftClient client,
        BlockPos target,
        String expectedItemId
    ) {
        if (client == null || client.world == null || target == null
            || expectedItemId == null || expectedItemId.isBlank()) {
            return List.of();
        }
        double horizontal = OwnedDropTracker.MAX_HORIZONTAL_DISTANCE;
        double vertical = OwnedDropTracker.MAX_VERTICAL_DISTANCE;
        Box box = new Box(
            target.getX() - horizontal,
            target.getY() - vertical,
            target.getZ() - horizontal,
            target.getX() + 1.0D + horizontal,
            target.getY() + 1.0D + vertical,
            target.getZ() + 1.0D + horizontal);
        List<OwnedDropTracker.Observation> observations = new ArrayList<>();
        for (ItemEntity item : client.world.getEntitiesByClass(
            ItemEntity.class, box, ItemEntity::isAlive)) {
            ItemStack stack = item.getStack();
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String itemId = Registries.ITEM.getId(stack.getItem()).toString();
            if (!VillageHarvestOwnedDropRecovery.exactItem(expectedItemId, itemId)) {
                continue;
            }
            Vec3d position = item.getPos();
            observations.add(new OwnedDropTracker.Observation(
                item.getUuid(), stack.getCount(),
                new OwnedDropTracker.Position(position.x, position.y, position.z),
                item.isAlive(), item.isOnGround()));
        }
        return List.copyOf(observations);
    }

    private static OwnedDropTracker.Position dropPosition(BlockPos target) {
        return target == null ? null : new OwnedDropTracker.Position(
            target.getX() + 0.5D, target.getY() + 0.5D, target.getZ() + 0.5D);
    }

    private static boolean harvestDropPlayerNearRoute(
        ClientPlayerEntity player,
        List<VoxelCell> route
    ) {
        if (player == null || route == null || route.isEmpty()) {
            return false;
        }
        for (VoxelCell cell : route) {
            double dx = cell.x() + 0.5D - player.getX();
            double dz = cell.z() + 0.5D - player.getZ();
            if (dx * dx + dz * dz <= 6.25D) {
                return true;
            }
        }
        return false;
    }

    private static String formatDropPosition(OwnedDropTracker.Position position) {
        return position == null ? "none"
            : String.format(Locale.ROOT, "%.3f,%.3f,%.3f",
                position.x(), position.y(), position.z());
    }

    private static long harvestDropElapsed(Run run, long nowMs) {
        long startedAtMs = run.harvestDropTrackingStartedAtMs > 0L
            ? run.harvestDropTrackingStartedAtMs : run.breakVerifiedAtMs;
        return startedAtMs <= 0L ? 0L : Math.max(0L, nowMs - startedAtMs);
    }

    private static void resetHarvestDrop(Run run) {
        run.breakVerified = false;
        run.segmentStarted = false;
        run.harvestDropTracker.reset();
        run.harvestDropRouteController.clear();
        run.harvestDropLastObservation = null;
        run.harvestDropRoute = List.of();
        run.harvestDropRouteEntityId = null;
        run.harvestDropRoutePosition = null;
        run.harvestDropPickupCell = null;
        run.harvestDropTrackingStartedAtMs = 0L;
        run.harvestDropCollectionStartedAtMs = 0L;
        run.harvestDropDisappearedAtMs = 0L;
        run.harvestDropReachedAtMs = 0L;
    }

    private ControlDecision finishHarvest(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs,
        boolean hay
    ) {
        if (!hay) {
            // The run begins with the aggregate "#beds" requirement, but the terminal receipt and
            // hotbar proof must name the exact legally collected bed that downstream UseBed can use.
            run.targetItemId = canonicalItem(run.segmentTargetItemId);
            HotbarStagingResult hotbarStaging = ensureActionHotbar(
                client, player, run, run.segmentTargetItemId, nowMs);
            if (hotbarStaging == HotbarStagingResult.PENDING) {
                return stopped(intent, "village_collect_bed_action_hotbar_verify");
            }
            if (hotbarStaging == HotbarStagingResult.FAILED) {
                return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                    "unavailable", nowMs, Map.of());
            }
        }
        run.authoritativeInventoryDelta = Map.copyOf(run.attributedInventoryDelta);
        return finish(intent, run,
            hay ? VillageOpportunityReceiptStore.Result.HARVESTED
                : VillageOpportunityReceiptStore.Result.COLLECTED,
            hay ? "harvested" : "collected", nowMs, Map.of());
    }

    private boolean planNextHarvestTarget(
        MinecraftClient client,
        ClientPlayerEntity player,
        Run run,
        long nowMs,
        boolean hay
    ) {
        if (run.rootTarget == null || run.consumedTargets.size() >= run.requestedCount) {
            return false;
        }
        List<BlockPos> candidates = new ArrayList<>();
        for (int dx = -8; dx <= 8; dx++) {
            for (int dy = -3; dy <= 3; dy++) {
                for (int dz = -8; dz <= 8; dz++) {
                    BlockPos candidate = run.rootTarget.add(dx, dy, dz);
                    if (run.consumedTargets.contains(candidate)) {
                        continue;
                    }
                    BlockState state = client.world.getBlockState(candidate);
                    if (hay ? state.isOf(Blocks.HAY_BLOCK) : state.getBlock() instanceof BedBlock) {
                        candidates.add(candidate.toImmutable());
                    }
                }
            }
        }
        candidates.sort(Comparator
            .comparingDouble((BlockPos candidate) -> candidate.getSquaredDistance(
                player.getX(), player.getY(), player.getZ()))
            .thenComparingInt(BlockPos::getY)
            .thenComparingInt(BlockPos::getZ)
            .thenComparingInt(BlockPos::getX));
        List<BlockPos> bounded = candidates.stream()
            .limit(VillageInteractionStancePlanner.MAX_AGGREGATE_TARGETS)
            .toList();
        if (bounded.isEmpty()
            || run.harvestRouteComputations >= run.requestedCount + 1) {
            run.target = run.rootTarget;
            return false;
        }
        VoxelCell start = feet(player);
        int minX = Math.min(start.x(), bounded.stream().mapToInt(BlockPos::getX).min().orElse(start.x())) - 4;
        int maxX = Math.max(start.x(), bounded.stream().mapToInt(BlockPos::getX).max().orElse(start.x())) + 4;
        int minY = Math.min(start.y(), bounded.stream().mapToInt(BlockPos::getY).min().orElse(start.y())) - 4;
        int maxY = Math.max(start.y(), bounded.stream().mapToInt(BlockPos::getY).max().orElse(start.y())) + 4;
        int minZ = Math.min(start.z(), bounded.stream().mapToInt(BlockPos::getZ).min().orElse(start.z())) - 4;
        int maxZ = Math.max(start.z(), bounded.stream().mapToInt(BlockPos::getZ).max().orElse(start.z())) + 4;
        WorldVoxelPerception perception = new WorldVoxelPerception(
            client.world, minX, maxX, minY, maxY, minZ, maxZ);
        run.harvestRouteComputations += 1;
        run.routeComputations += 1;
        VillageInteractionStancePlanner.TargetPlan selected =
            VillageInteractionStancePlanner.planAnyHarvest(
                perception,
                start,
                bounded.stream()
                    .map(pos -> new VoxelCell(pos.getX(), pos.getY(), pos.getZ()))
                    .toList());
        if (selected.accepted()) {
            run.target = new BlockPos(
                selected.target().x(), selected.target().y(), selected.target().z());
            boolean installed = routeController.begin(
                run.commandId, selected.plan().route(), start, nowMs);
            if (installed) {
                run.plan = selected.plan();
                run.phase = Phase.ROUTE;
                return true;
            }
        }
        run.target = run.rootTarget;
        return false;
    }

    private ControlDecision tickCraftBread(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs
    ) {
        run.maximumObservedFoodLevel = Math.max(
            run.maximumObservedFoodLevel, player.getHungerManager().getFoodLevel());
        if (run.breadCraftVerified) {
            return finishVerifiedBread(client, player, intent, run, nowMs);
        }
        run.breadBetweenCrafts = false;
        if (run.wheatCraftInFlight) {
            String subcommand = run.commandId + ":wheat:" + run.craftSequence;
            BrainLink.Intent subIntent = shell.makeSubIntent(
                intent, "craft_wheat", subcommand, "village_craft_bread_wheat");
            if (shell.villageCraft2x2Finished(subcommand)) {
                String reason = shell.villageCraft2x2Reason(subcommand);
                run.wheatCraftInFlight = false;
                if (reason == null || reason.contains("_failed:")) {
                    return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                        "unavailable", nowMs, Map.of());
                }
                run.craftSequence += 1;
                return stopped(intent, "village_craft_bread_wheat_verified");
            }
            run.phase = Phase.CRAFT_WHEAT;
            return shell.resolveVillageCraft2x2(client, player, subIntent, nowMs);
        }
        if (run.breadCraftInFlight) {
            return tickBreadCraftInFlight(client, player, intent, run, nowMs);
        }
        int wheat = inventoryCount(player, "minecraft:wheat");
        if (wheat < 3) {
            if (inventoryCount(player, "minecraft:hay_block") <= 0) {
                return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                    "unavailable", nowMs, Map.of());
            }
            String subcommand = run.commandId + ":wheat:" + run.craftSequence;
            BrainLink.Intent subIntent = shell.makeSubIntent(
                intent, "craft_wheat", subcommand, "village_craft_bread_wheat");
            run.wheatCraftInFlight = true;
            run.phase = Phase.CRAFT_WHEAT;
            return shell.resolveVillageCraft2x2(client, player, subIntent, nowMs);
        }
        if (run.phase == Phase.PLACE_TABLE) {
            String tableCommand = run.commandId + ":table";
            if (shell.villagePlaceTableFinished(tableCommand)) {
                String reason = shell.villagePlaceTableReason(tableCommand);
                if (reason == null || reason.contains("_failed:")) {
                    return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                        "unavailable", nowMs, Map.of());
                }
                BlockPos placedTable = run.tableSupport == null
                    ? null : run.tableSupport.up();
                if (placedTable == null
                    || !client.world.getBlockState(placedTable).isOf(Blocks.CRAFTING_TABLE)) {
                    return finish(intent, run, VillageOpportunityReceiptStore.Result.INVALIDATED,
                        "invalidated", nowMs, Map.of());
                }
                run.temporaryTablePos = placedTable.toImmutable();
                run.temporaryTablePlacedCount = 1;
                run.phase = Phase.CRAFT_BREAD;
                return stopped(intent, "village_craft_bread_table_verified");
            }
            BrainLink.Intent tableIntent = shell.makeSubIntent(
                intent, "place_table", tableCommand, "village_craft_bread_place_table");
            return shell.resolveVillagePlaceTable(
                client, player, tableIntent, nowMs, run.tableSupport);
        }
        if (!nearbyCraftingTable(client, player)) {
            String tableCommand = run.commandId + ":table";
            if (shell.captureCraftInventory(player).tables().craftingTableCount() <= 0) {
                return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                    "unavailable", nowMs, Map.of());
            }
            if (run.tableSupport == null) {
                run.tableSupport = selectVillageTableSupport(client, player);
            }
            if (run.tableSupport == null) {
                return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                    "unavailable", nowMs, Map.of());
            }
            BrainLink.Intent tableIntent = shell.makeSubIntent(
                intent, "place_table", tableCommand, "village_craft_bread_place_table");
            run.phase = Phase.PLACE_TABLE;
            return shell.resolveVillagePlaceTable(
                client, player, tableIntent, nowMs, run.tableSupport);
        }
        if (!run.breadInventoryBaselineFrozen) {
            run.breadInventoryBaseline = inventoryCount(player, "minecraft:bread");
            run.breadInventoryBaselineFrozen = true;
        }
        run.phase = Phase.CRAFT_BREAD;
        run.breadCraftInFlight = true;
        return tickBreadCraftInFlight(client, player, intent, run, nowMs);
    }

    /**
     * Retains ownership of one exact 3x3 bread command while its source wheat is temporarily in
     * the crafting cursor/grid. Inventory observations are not authoritative during that window:
     * only the correlated nested executor terminal may release this latch.
     */
    private ControlDecision tickBreadCraftInFlight(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs
    ) {
        String subcommand = run.commandId + ":bread:" + run.craftSequence;
        BrainLink.Intent subIntent = shell.makeSubIntent(
            intent, "craft_bread", subcommand, "village_craft_bread_recipe");
        if (shell.villageCraft3x3Finished(subcommand)) {
            return finishBreadCraftInFlight(client, player, intent, run, subcommand, nowMs);
        }
        ControlDecision nested = shell.resolveVillageCraft3x3(
            client, player, subIntent, nowMs);
        // The nested executor can terminalize during this call. Publish the outer receipt on that
        // same tick, before the next tick's SurvivalController can consume the new bread.
        if (shell.villageCraft3x3Finished(subcommand)) {
            return finishBreadCraftInFlight(client, player, intent, run, subcommand, nowMs);
        }
        return nested;
    }

    private ControlDecision finishBreadCraftInFlight(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        String subcommand,
        long nowMs
    ) {
        run.breadCraftInFlight = false;
        String reason = shell.villageCraft3x3Reason(subcommand);
        if (reason == null || reason.contains("_failed:")) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                "unavailable", nowMs, Map.of());
        }
        // The nested executor has already verified this exact typed output. Accumulate it
        // immediately so Survival consuming bread between batch iterations cannot erase the
        // outer transaction's authoritative production count.
        return recordVerifiedBreadAndFinish(client, player, intent, run, nowMs);
    }

    private ControlDecision recordVerifiedBreadAndFinish(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs
    ) {
        if (!prepareVerifiedBreadScreen(client, player, run, nowMs)) {
            return stopped(intent, "village_craft_bread_terminal_cleanup");
        }
        recordVerifiedBread(run, player);
        return finishVerifiedBread(client, player, intent, run, nowMs);
    }

    private ControlDecision finishVerifiedBread(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs
    ) {
        if (!prepareVerifiedBreadScreen(client, player, run, nowMs)) {
            return stopped(intent, "village_craft_bread_terminal_cleanup");
        }
        HotbarStagingResult hotbarStaging = ensureActionHotbar(
            client, player, run, "minecraft:bread", nowMs);
        if (hotbarStaging == HotbarStagingResult.PENDING) {
            return stopped(intent, "village_craft_bread_action_hotbar_verify");
        }
        if (hotbarStaging == HotbarStagingResult.FAILED) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                "unavailable", nowMs, Map.of());
        }
        if (run.breadProducedCount < run.requestedCount) {
            prepareNextBreadBatchIteration(run, player, nowMs);
            return stopped(intent, "village_craft_bread_batch_progress");
        }
        if (run.temporaryTablePlacedCount > run.temporaryTableRecoveredCount) {
            run.phase = Phase.RETRIEVE_TABLE;
        }
        return finish(intent, run, VillageOpportunityReceiptStore.Result.CRAFTED,
            "crafted", nowMs, Map.of());
    }

    private static void recordVerifiedBread(Run run, ClientPlayerEntity player) {
        if (run.breadCraftVerified) {
            return;
        }
        // The nested executor already verified this exact typed output. Preserve that authority
        // while the transaction retrieves any table it temporarily placed; Survival may consume
        // the bread meanwhile, but cannot erase the verified production receipt.
        run.breadCraftVerified = true;
        run.breadProducedCount = Math.min(run.requestedCount, run.breadProducedCount + 1);
        if (player != null) {
            run.maximumObservedFoodLevel = Math.max(
                run.maximumObservedFoodLevel, player.getHungerManager().getFoodLevel());
        }
        run.authoritativeInventoryDelta = Map.of(
            "minecraft:bread", run.breadProducedCount);
    }

    private void prepareNextBreadBatchIteration(
        Run run,
        ClientPlayerEntity player,
        long nowMs
    ) {
        run.craftSequence += 1;
        run.breadCraftInFlight = false;
        run.breadCraftVerified = false;
        run.breadBetweenCrafts = true;
        run.breadInventoryBaselineFrozen = false;
        shell.logger().info(
            "village.opportunity.bread.batch_progress instanceId={} commandId={} opportunityId={} targetCount={} producedCount={} remainingCount={} craftSequence={} foodLevelBefore={} foodLevelNow={} foodLevelGain={} elapsedMs={}",
            shell.instanceId(), run.commandId, run.opportunityId, run.requestedCount,
            run.breadProducedCount, run.requestedCount - run.breadProducedCount,
            run.craftSequence, run.foodLevelBefore,
            player == null ? run.maximumObservedFoodLevel
                : player.getHungerManager().getFoodLevel(),
            Math.max(0, run.maximumObservedFoodLevel - run.foodLevelBefore),
            Math.max(0L, nowMs - run.startedAtMs));
    }

    /**
     * Drives exact recovery of a transaction-owned temporary table before any terminal receipt.
     * Returning {@code null} means either no temporary table existed or conservation has been
     * authoritatively verified; a non-null decision keeps terminalization pending.
     */
    private ControlDecision prepareTemporaryTableRecovery(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs
    ) {
        if (run.temporaryTablePlacedCount <= run.temporaryTableRecoveredCount
            || run.temporaryTableRecoveryFailed) {
            return null;
        }
        if (client == null || client.world == null || player == null
            || run.temporaryTablePos == null) {
            run.temporaryTableRecoveryFailed = true;
            return null;
        }
        String retrieveCommand = run.commandId + ":retrieve_table";
        if (shell.villageRetrieveTableFinished(retrieveCommand)) {
            String reason = shell.villageRetrieveTableReason(retrieveCommand);
            int inventoryTables = inventoryCount(player, "minecraft:crafting_table");
            int baselineTables = run.baselineInventory.getOrDefault(
                "minecraft:crafting_table", 0);
            boolean exactBlockRemoved = !client.world.getBlockState(run.temporaryTablePos)
                .isOf(Blocks.CRAFTING_TABLE);
            if (reason != null
                && reason.startsWith("retrieve_table_complete:table_item_delta_verified")
                && exactBlockRemoved
                && inventoryTables >= baselineTables) {
                run.temporaryTableRecoveredCount = run.temporaryTablePlacedCount;
                run.phase = Phase.CRAFT_BREAD;
                return null;
            }
            run.temporaryTableRecoveryFailed = true;
            return null;
        }
        run.phase = Phase.RETRIEVE_TABLE;
        BrainLink.Intent retrieveIntent = shell.makeSubIntent(
            intent,
            "retrieve_table",
            retrieveCommand,
            "village_craft_bread_retrieve_table"
        );
        ControlDecision decision = shell.resolveVillageRetrieveTable(
            client, player, retrieveIntent, nowMs, run.temporaryTablePos);
        // An adjacent table can break and auto-pick up during this call. Consume the nested
        // terminal result immediately so the outer typed event preserves exact chronology.
        if (shell.villageRetrieveTableFinished(retrieveCommand)) {
            return prepareTemporaryTableRecovery(client, player, intent, run, nowMs);
        }
        return decision;
    }

    private BlockPos selectVillageTableSupport(
        MinecraftClient client,
        ClientPlayerEntity player
    ) {
        if (client == null || client.world == null || player == null) {
            return null;
        }
        BlockPos feet = player.getBlockPos();
        int[][] offsets = { { 0, -1 }, { 1, 0 }, { 0, 1 }, { -1, 0 } };
        for (int[] offset : offsets) {
            BlockPos support = feet.down().add(offset[0], 0, offset[1]);
            BlockPos placement = support.up();
            BlockState supportState = client.world.getBlockState(support);
            BlockState placementState = client.world.getBlockState(placement);
            if (supportState.getCollisionShape(client.world, support).isEmpty()
                || !placementState.isAir()
                || shell.isAnyOreBlockState(supportState)
                || shell.isAnyOreBlockState(placementState)
                || shell.isHazardBlockState(supportState)
                || shell.isHazardBlockState(placementState)
                || shell.firstAdjacentLavaBlock(client, placement) != null
                || shell.isOnRecordedDescentTrail(placement)
                || new net.minecraft.util.math.Box(placement)
                    .intersects(player.getBoundingBox())) {
                continue;
            }
            return support.toImmutable();
        }
        return null;
    }

    private ControlDecision tickRoute(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs
    ) {
        if (run.phase != Phase.ROUTE) {
            return null;
        }
        VoxelCell feet = feet(player);
        boolean safeFeet = safeCell(client, feet);
        if (routeController.replanPending()) {
            VillageLocalRouteController.ReplanReadiness readiness =
                routeController.observeReplanReadiness(
                    player.isOnGround() && !player.isTouchingWater() && safeFeet,
                    nowMs);
            if (readiness == VillageLocalRouteController.ReplanReadiness.WAITING) {
                return stopped(intent, "village_opportunity_route_replan_settling");
            }
            if (readiness == VillageLocalRouteController.ReplanReadiness.READY
                && routeController.computations()
                    < VillageLocalRouteController.MAX_COMPUTATIONS
                && session != null && session.replans < 1) {
                String motorReason = routeController.rejectedReason();
                session.replans += 1;
                boolean replanned = planRoute(
                    client, player, run,
                    routeMode(run.action, run.opportunityId), nowMs, true);
                shell.logger().info(
                    "opportunity.detour.replanned instanceId={} detourId={} session={} commandId={} action={} stage={} replanCount={} routeLength={} elapsedMs={} motorReason={} result={}",
                    shell.instanceId(), session.detourId, session.id, run.commandId,
                    run.action, run.stage, session.replans,
                    run.plan == null ? 0 : run.plan.route().size(),
                    Math.max(0L, nowMs - session.startedAtMs), motorReason,
                    replanned ? "accepted" : "rejected");
                if (replanned) {
                    return stopped(intent, "village_opportunity_route_replanned");
                }
            }
            return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                "unavailable", nowMs, Map.of());
        }
        VoxelCell waypoint = routeController.activeWaypoint();
        Vec3d aim = waypoint == null ? player.getPos()
            : new Vec3d(waypoint.x() + 0.5D, waypoint.y(), waypoint.z() + 0.5D);
        McbotFabricClient.LookAngles angles = shell.lookAnglesToPoint(player, aim);
        boolean aligned = Math.abs(McbotFabricClient.wrapDegreesDelta(
            angles.yaw() - player.getYaw())) <= 24.0D;
        MiningWorkspaceSiteTraversalController.Observation observation =
            new MiningWorkspaceSiteTraversalController.Observation(
                feet, player.getX(), player.getY(), player.getZ(), player.isOnGround(), aligned,
                !player.isTouchingWater(), safeFeet, safeFeet);
        MiningWorkspaceSiteTraversalController.Step step = routeController.tick(
            run.commandId, observation, cell -> safeCell(client, cell), nowMs);
        if (step == null) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.INVALIDATED,
                "invalidated", nowMs, Map.of());
        }
        if (step.outcome() == MiningWorkspaceSiteTraversalController.Outcome.REACHED) {
            routeController.clear();
            run.phase = Phase.AT_STANCE;
            shell.logger().info(
                "village.opportunity.route.reached instanceId={} commandId={} opportunityId={} stage={} target={} stance={} routeLength={} elapsedMs={}",
                shell.instanceId(), run.commandId, run.opportunityId, run.stage,
                format(run.target), run.plan == null ? "none" : run.plan.stance(),
                run.plan == null ? 0 : run.plan.route().size(),
                Math.max(0L, nowMs - run.startedAtMs));
            if ("village_travel".equals(run.action)
                && run.routeSelection != null
                && run.routeSelection.frontierStage()) {
                run.routeSegments += 1;
                if (!planRoute(
                    client, player, run,
                    run.routeSelection.goalMode(),
                    nowMs, false)) {
                    return finish(intent, run,
                        VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                        "unavailable", nowMs, Map.of());
                }
                return stopped(intent, "village_opportunity_route_frontier_reached");
            }
            return stopped(intent, "village_opportunity_route_reached");
        }
        if (step.outcome() == MiningWorkspaceSiteTraversalController.Outcome.REJECTED) {
            shell.logger().warn(
                "village.opportunity.route.motor_rejected instanceId={} commandId={} opportunityId={} stage={} target={} reason={} feet={} onGround={} safeFeet={} stableFeet={} waypoint={} waypointIndex={} remainingCells={} stepUpPhase={} descentPhase={} elapsedMs={}",
                shell.instanceId(), run.commandId, run.opportunityId, run.stage,
                format(run.target), step.reason(), feet, player.isOnGround(), safeFeet,
                step.stableFeet(), step.waypoint(), step.waypointIndex(), step.remainingCells(),
                step.stepUpPhase(), step.descentPhase(),
                Math.max(0L, nowMs - run.startedAtMs));
            if (routeController.computations() < VillageLocalRouteController.MAX_COMPUTATIONS
                && session != null && session.replans < 1) {
                routeController.deferReplan(step.reason(), nowMs);
                return stopped(intent, "village_opportunity_route_replan_settling");
            }
            return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                "unavailable", nowMs, Map.of());
        }
        VoxelCell active = step.waypoint();
        Vec3d target = active == null ? player.getPos()
            : new Vec3d(active.x() + 0.5D, active.y(), active.z() + 0.5D);
        McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(player, target);
        VillageRouteMovementPolicy.Output movement =
            VillageRouteMovementPolicy.apply(step, feet);
        String reason = step.descentExempt()
            ? movement.landingColumnCaptured()
                ? "village_opportunity_route_nav3d_descend_column_captured"
                : "village_opportunity_route_nav3d_descend"
            : "village_opportunity_route_move";
        InputState input = new InputState(
            movement.forward(), false, false, false, movement.jump(), false,
            movement.forward() ? 1.0F : 0.0F, 0.0F);
        BrainLink.Intent movementIntent =
            shell.lookIntentForAngles(intent, look.yaw(), look.pitch(), reason);
        LocomotionDemand locomotionDemand = LocomotionDemand.passthrough(
            LookDemand.Owner.NORMAL,
            input,
            movement.sprintRequested(),
            intent.commandId(),
            reason);
        return new ControlDecision(
            movementIntent, input, null, null, locomotionDemand);
    }

    private ControlDecision tickDefeatIronGolem(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs
    ) {
        WorldScope scope = worldScope == null ? null : worldScope.current();
        int nearbyHostiles = scope == null ? Integer.MAX_VALUE : scope.nearbyHostileCount();
        IronGolemOpportunityExecutor.Step step = ironGolemExecutor.tick(
            client, player, intent, nearbyHostiles, nowMs);
        if (step.phase() != run.lastGolemPhase) {
            shell.logger().info(
                "village.opportunity.golem.phase instanceId={} commandId={} opportunityId={} opportunityRevision={} stage={} phase={} outcome={} exactTarget={} reason={} elapsedMs={}",
                shell.instanceId(), run.commandId, run.opportunityId,
                run.opportunityRevision, run.stage,
                step.phase().name().toLowerCase(Locale.ROOT),
                step.outcome().name().toLowerCase(Locale.ROOT),
                step.exactEntityIdentity(), step.reason(),
                Math.max(0L, nowMs - run.startedAtMs));
            run.lastGolemPhase = step.phase();
        }
        if (!step.terminal()) {
            return step.decision();
        }
        VillageOpportunityReceiptStore.Result result = switch (step.outcome()) {
            case COLLECTED -> VillageOpportunityReceiptStore.Result.COLLECTED;
            case UNSAFE -> VillageOpportunityReceiptStore.Result.UNSAFE;
            case INVALIDATED -> VillageOpportunityReceiptStore.Result.INVALIDATED;
            case UNAVAILABLE, ACTIVE -> VillageOpportunityReceiptStore.Result.UNAVAILABLE;
        };
        String suffix = result == VillageOpportunityReceiptStore.Result.COLLECTED
            ? "collected"
            : result == VillageOpportunityReceiptStore.Result.UNSAFE
                ? "unsafe"
                : result == VillageOpportunityReceiptStore.Result.INVALIDATED
                    ? "invalidated" : "unavailable";
        if (result == VillageOpportunityReceiptStore.Result.COLLECTED) {
            run.authoritativeInventoryDelta = step.authoritativeInventoryDelta();
        }
        return finish(intent, run, result, suffix, nowMs, Map.of());
    }

    private boolean planRoute(
        MinecraftClient client,
        ClientPlayerEntity player,
        Run run,
        VillageInteractionStancePlanner.Mode mode,
        long nowMs,
        boolean replan
    ) {
        VoxelCell start = feet(player);
        VoxelCell target = new VoxelCell(
            run.target.getX(), run.target.getY(), run.target.getZ());
        WorldVoxelPerception perception = new WorldVoxelPerception(
            client.world, start, target, 4, 4);
        VillageInteractionStancePlanner.Mode goalMode = run.routeSelection == null
            ? mode : run.routeSelection.goalMode();
        VillageRoutePlanSelector.Selection selection = VillageRoutePlanSelector.select(
            perception,
            start,
            target,
            goalMode,
            "village_travel".equals(run.action),
            true);
        run.routeComputations += selection.computations();
        VillageInteractionStancePlanner.Plan plan = selection.plan();
        if (!selection.accepted()) {
            shell.logger().warn(
                "village.opportunity.route.rejected instanceId={} commandId={} opportunityId={} stage={} target={} goalMode={} installedMode={} frontierStage={} reason={} expandedCells={} routeComputations={} replan={}",
                shell.instanceId(), run.commandId, run.opportunityId, run.stage,
                format(run.target), selection.goalMode(), selection.installedMode(),
                selection.frontierStage(), plan.reason(), plan.expandedCells(),
                run.routeComputations, replan);
            return false;
        }
        boolean installed = replan
            ? routeController.replan(plan.route(), start, nowMs)
            : routeController.begin(run.commandId, plan.route(), start, nowMs);
        if (!installed) {
            return false;
        }
        run.routeSelection = selection;
        run.plan = plan;
        run.phase = Phase.ROUTE;
        return true;
    }

    private ControlDecision openContainer(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        Run run,
        long nowMs
    ) {
        if (player.currentScreenHandler != null
            && !player.currentScreenHandler.getCursorStack().isEmpty()) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.UNSAFE,
                "unsafe", nowMs, Map.of());
        }
        if (!isContainer(client.world.getBlockState(run.target))) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.INVALIDATED,
                "invalidated", nowMs, Map.of());
        }
        BlockHitResult hit = raycastBlock(client, player, run.target);
        if (hit == null) {
            return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                "unavailable", nowMs, Map.of());
        }
        if (run.containerUseApplied
            && nowMs - run.containerUseAcceptedAtMs < CONTAINER_OPEN_GRACE_MS) {
            return stopped(intent, "village_container_wait_screen_open");
        }
        if (run.containerUseApplied) {
            // The accepted pulse did not produce a container handler inside its bounded grace.
            // Only now may the executor spend its second and final open attempt.
            run.containerUseApplied = false;
        }
        if (selectEmptyMainHandSlot(player) < 0) {
            return finish(
                intent,
                run,
                VillageOpportunityReceiptStore.Result.UNSAFE,
                "unsafe",
                nowMs,
                Map.of()
            );
        }
        if (run.pendingUseRequestId.isBlank()) {
            if (run.openAttempts >= 2) {
                return finish(intent, run, VillageOpportunityReceiptStore.Result.UNAVAILABLE,
                    "unavailable", nowMs, Map.of());
            }
            run.pendingUseRequestId = "village-container:" + run.commandId + ":" + run.openAttempts;
            run.openAttempts += 1;
        }
        run.phase = Phase.OPENING_CONTAINER;
        InteractionDemand demand = InteractionDemand.useBlock(
            run.pendingUseRequestId,
            LookDemand.Owner.NORMAL,
            run.commandId,
            run.stage,
            "container:" + run.target.toShortString(),
            hit.getSide().asString(),
            "village_container_open");
        McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(player, hit.getPos());
        return new ControlDecision(
            shell.lookIntentForAngles(intent, look.yaw(), look.pitch(), "village_container_open"),
            InputState.stop(), null, null, null, demand,
            FabricInteractionAuthority.Payload.blockUse(
                hit,
                Hand.MAIN_HAND,
                FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor()
            ));
    }

    void observeInteractionReceipt(InteractionAppliedReceipt receipt) {
        ironGolemExecutor.observeInteractionReceipt(receipt);
        Run run = activeRun;
        if (run == null || receipt == null || run.pendingUseRequestId.isBlank()
            || !run.pendingUseRequestId.equals(receipt.requestId())
            || receipt.action() != InteractionDemand.Action.USE_BLOCK
            || receipt.disposition() == InteractionAppliedReceipt.Disposition.DEFERRED) {
            return;
        }
        String acceptedRequestId = run.pendingUseRequestId;
        run.pendingUseRequestId = "";
        run.containerUseApplied = receipt.applied()
            && receipt.actionResult() != null
            && receipt.actionResult().isAccepted();
        run.containerUseAcceptedAtMs = run.containerUseApplied
            ? receipt.timestampMs() : 0L;
        run.containerAccessRequestId = run.containerUseApplied
            ? acceptedRequestId : "";
        run.phase = Phase.WAIT_CONTAINER;
        if (run.containerUseApplied) {
            shell.logger().info(
                "village.opportunity.container.opened instanceId={} commandId={} opportunityId={} target={} stage={}",
                shell.instanceId(), run.commandId, run.opportunityId,
                format(run.target), run.stage);
        }
    }

    private static int selectEmptyMainHandSlot(ClientPlayerEntity player) {
        if (player == null) {
            return -1;
        }
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack != null && stack.isEmpty()) {
                player.getInventory().selectedSlot = slot;
                return slot;
            }
        }
        return -1;
    }

    VillageOpportunityReceiptStore.Receipt receiptSnapshot() {
        return receipts.latest();
    }

    boolean handoffCleanupPending() {
        return activeRun != null
            && (activeRun.handoffCleanupPhase != HandoffCleanupPhase.NONE
                || activeRun.golemHandoffBarrier);
    }

    /**
     * Latches a command replacement before combat/survival arbitration. This method may inspect
     * and freeze ownership evidence, but it never clicks, routes, breaks, or places a block.
     */
    void observeEffectiveIntentHandoff(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        long nowMs
    ) {
        Run run = activeRun;
        if (run == null || run.handoffCleanupPhase != HandoffCleanupPhase.NONE
            || sameEffectiveIntent(run, effective)) {
            return;
        }
        if ("village_defeat_iron_golem".equals(run.action)
            && (ironGolemExecutor.engaged() || ironGolemExecutor.ownsSafetyEscape())) {
            if (!run.golemHandoffBarrier) {
                run.golemHandoffBarrier = true;
                run.handoffCleanupStartedAtMs = nowMs;
                run.handoffReplacementCommandId = effective == null
                    ? "" : stable(effective.commandId());
                run.handoffReplacementAction = effective == null
                    ? "" : normalize(effective.action());
                run.handoffReason = "effective_intent_changed_while_engaged";
                ironGolemExecutor.requestSafeHandoff(run.handoffReason, nowMs);
                shell.logger().warn(
                    "village.opportunity.golem.handoff_barrier.started instanceId={} oldCommandId={} newCommandId={} newAction={} engaged=true reason={} elapsedMs=0",
                    shell.instanceId(), run.commandId,
                    run.handoffReplacementCommandId, run.handoffReplacementAction,
                    run.handoffReason);
            }
            return;
        }
        freezeSwitchTickTableCorrelation(client, run);
        reconcileSwitchTickTemporaryTable(client, player, run);
        run.handoffCleanupPhase = HandoffCleanupPhase.GUI_AND_NESTED_CRAFT;
        run.handoffCleanupStartedAtMs = nowMs;
        run.handoffReplacementCommandId = effective == null
            ? "" : stable(effective.commandId());
        run.handoffReplacementAction = effective == null
            ? "" : normalize(effective.action());
        run.handoffReason = "effective_intent_changed";
        run.pendingUseRequestId = "";
        routeController.clear();
        shell.blockBreakController().reset();
        shell.logger().warn(
            "village.opportunity.handoff_cleanup.started instanceId={} oldCommandId={} oldAction={} newCommandId={} newAction={} phase={} cursorEmpty={} craftingInputSlots={} screen={} temporaryTablePlacedCount={} temporaryTableRecoveredCount={} elapsedMs=0 attempts=0 reason=effective_intent_changed",
            shell.instanceId(), run.commandId, run.action,
            run.handoffReplacementCommandId, run.handoffReplacementAction, run.phase,
            cursorEmpty(player), occupiedPlayerCraftingInputs(player), screenName(player),
            run.temporaryTablePlacedCount, run.temporaryTableRecoveredCount);
    }

    /**
     * Resolves a latched replacement after urgent reflexes have declined the tick. A non-null
     * decision is a physical dispatch barrier; the replacement intent may run only on a later tick.
     */
    ControlDecision resolveEffectiveIntentHandoffCleanup(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        long nowMs
    ) {
        Run run = activeRun;
        if (run == null) {
            return null;
        }
        if (run.golemHandoffBarrier) {
            WorldScope scope = worldScope == null ? null : worldScope.current();
            int nearbyHostiles = scope == null
                ? Integer.MAX_VALUE : scope.nearbyHostileCount();
            IronGolemOpportunityExecutor.Step step = ironGolemExecutor.tick(
                client, player, run.admittedIntent, nearbyHostiles, nowMs);
            if (!step.terminal()) {
                return step.decision();
            }
            VillageOpportunityReceiptStore.Result result = switch (step.outcome()) {
                case COLLECTED -> VillageOpportunityReceiptStore.Result.COLLECTED;
                case UNSAFE -> VillageOpportunityReceiptStore.Result.UNSAFE;
                case INVALIDATED -> VillageOpportunityReceiptStore.Result.INVALIDATED;
                case UNAVAILABLE, ACTIVE -> VillageOpportunityReceiptStore.Result.UNAVAILABLE;
            };
            String suffix = result == VillageOpportunityReceiptStore.Result.COLLECTED
                ? "collected"
                : result == VillageOpportunityReceiptStore.Result.UNSAFE
                    ? "unsafe"
                    : result == VillageOpportunityReceiptStore.Result.INVALIDATED
                        ? "invalidated" : "unavailable";
            if (result == VillageOpportunityReceiptStore.Result.COLLECTED) {
                run.authoritativeInventoryDelta = step.authoritativeInventoryDelta();
            }
            shell.logger().info(
                "village.opportunity.golem.handoff_barrier.released instanceId={} oldCommandId={} newCommandId={} newAction={} outcome={} reason={} elapsedMs={}",
                shell.instanceId(), run.commandId,
                run.handoffReplacementCommandId, run.handoffReplacementAction,
                step.outcome().name().toLowerCase(Locale.ROOT), step.reason(),
                Math.max(0L, nowMs - run.handoffCleanupStartedAtMs));
            run.golemHandoffBarrier = false;
            return finish(run.admittedIntent, run, result, suffix, nowMs, Map.of());
        }
        if (run.handoffCleanupPhase == HandoffCleanupPhase.NONE) {
            return null;
        }
        BrainLink.Intent barrierIntent = effective == null ? run.admittedIntent : effective;
        long elapsed = Math.max(0L, nowMs - run.handoffCleanupStartedAtMs);
        if (elapsed >= HANDOFF_CLEANUP_TIMEOUT_MS) {
            run.handoffRejected = true;
            run.handoffReason = "cleanup_timeout";
            forceCloseAndClearNested(client, player, run, nowMs);
            return completeHandoffBarrier(barrierIntent, run, nowMs);
        }

        reconcileSwitchTickTemporaryTable(client, player, run);
        if (run.handoffCleanupPhase == HandoffCleanupPhase.GUI_AND_NESTED_CRAFT) {
            if (!prepareTerminalCleanup(client, player, run, nowMs)) {
                if (run.nestedCraftCleanupRejected
                    || run.terminalCleanupAttempts >= MAX_TERMINAL_CLEANUP_ATTEMPTS) {
                    run.handoffRejected = true;
                    run.handoffReason = run.nestedCraftCleanupRejected
                        ? "nested_craft_cleanup_rejected" : "cleanup_attempt_limit";
                    forceCloseAndClearNested(client, player, run, nowMs);
                    return completeHandoffBarrier(barrierIntent, run, nowMs);
                }
                return stopped(barrierIntent, "village_opportunity_handoff_cleanup");
            }
            run.handoffCleanupPhase = HandoffCleanupPhase.TEMPORARY_TABLE;
            return stopped(barrierIntent, "village_opportunity_handoff_cleanup");
        }

        if (run.handoffCleanupPhase == HandoffCleanupPhase.TEMPORARY_TABLE) {
            if (run.handoffTablePlacementCorrelated
                && run.temporaryTablePlacedCount <= 0) {
                return stopped(barrierIntent, "village_opportunity_handoff_table_settle");
            }
            if (run.temporaryTablePlacedCount > run.temporaryTableRecoveredCount
                && !run.temporaryTableRecoveryFailed) {
                ControlDecision recovery = prepareTemporaryTableRecovery(
                    client, player, run.admittedIntent, run, nowMs);
                if (recovery != null) {
                    return recovery;
                }
            }
            if (run.temporaryTableRecoveryFailed
                || run.temporaryTablePlacedCount > run.temporaryTableRecoveredCount) {
                run.handoffRejected = true;
                run.handoffReason = "temporary_table_recovery_failed";
            }
            run.handoffCleanupPhase = HandoffCleanupPhase.FINAL_BARRIER;
            return completeHandoffBarrier(barrierIntent, run, nowMs);
        }
        return completeHandoffBarrier(barrierIntent, run, nowMs);
    }

    private ControlDecision completeHandoffBarrier(
        BrainLink.Intent barrierIntent,
        Run run,
        long nowMs
    ) {
        boolean rejected = run.handoffRejected;
        String event = rejected ? "rejected" : "completed";
        ClientPlayerEntity player = MinecraftClient.getInstance() == null
            ? null : MinecraftClient.getInstance().player;
        String pattern =
            "village.opportunity.handoff_cleanup.{} instanceId={} oldCommandId={} oldAction={} newCommandId={} newAction={} phase={} cursorEmpty={} craftingInputSlots={} screen={} temporaryTablePlacedCount={} temporaryTableRecoveredCount={} elapsedMs={} attempts={} reason={}";
        Object[] args = {
            event, shell.instanceId(), run.commandId, run.action,
            run.handoffReplacementCommandId, run.handoffReplacementAction, run.phase,
            cursorEmpty(player), occupiedPlayerCraftingInputs(player), screenName(player),
            run.temporaryTablePlacedCount, run.temporaryTableRecoveredCount,
            Math.max(0L, nowMs - run.handoffCleanupStartedAtMs),
            run.terminalCleanupAttempts,
            run.handoffReason.isBlank() ? "clean" : run.handoffReason
        };
        if (rejected) {
            shell.logger().warn(pattern, args);
        } else {
            shell.logger().info(pattern, args);
        }
        rememberHandoffAbort(run.commandId);
        clearActiveRun();
        clearSession();
        receipts.clear();
        return stopped(
            barrierIntent,
            rejected
                ? "village_opportunity_handoff_cleanup_rejected"
                : "village_opportunity_handoff_cleanup_completed");
    }

    /**
     * Bookkeeping-only terminal reconciliation that runs before combat/survival reflexes. It may
     * verify a GUI/inventory result and publish a receipt, but can never route, attack, or harvest.
     */
    void enforceInventoryTerminalBeforeReflex(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        long nowMs
    ) {
        if (activeRun == null || intent == null || player == null
            || activeRun.handoffCleanupPhase != HandoffCleanupPhase.NONE
            || !sameEffectiveIntent(activeRun, intent)) {
            return;
        }
        observeTargetFoodConsumption(activeRun, player);
        if (activeRun.terminalResult != null) {
            if (activeRun.temporaryTablePlacedCount
                > activeRun.temporaryTableRecoveredCount) {
                if (activeRun.terminalCleanupStartedAtMs > 0L) {
                    // A malformed nonempty crafting cursor is failed closed, but the same bounded
                    // GUI rollback remains eligible on later pre-reflex ticks. This never invokes
                    // table retrieval or any other block interaction.
                    prepareTerminalCleanup(client, player, activeRun, nowMs);
                }
                // Exact table retrieval is physical block breaking. Leave it to the ordinary
                // executor path after combat/survival releases this tick.
                return;
            }
            finish(
                intent, activeRun, activeRun.terminalResult, activeRun.terminalSuffix,
                nowMs, activeRun.terminalContents);
            return;
        }
        if ("village_withdraw_item".equals(activeRun.action)) {
            String itemId = activeRun.targetItemId;
            if (activeRun.withdrawBaselineFrozen
                && inventoryCount(player, itemId) - activeRun.withdrawInventoryBaseline
                    >= activeRun.requestedCount) {
                activeRun.withdrawPlayerGainVerified = true;
            }
            boolean canVerify = activeRun.withdrawRemovalVerified
                || (activeRun.phase == Phase.WITHDRAW_VERIFY
                    && activeRun.withdrawCursorReturned
                    && player.currentScreenHandler instanceof GenericContainerScreenHandler);
            if (canVerify) {
                tickWithdraw(client, player, intent, activeRun, nowMs);
            }
            return;
        }
        if (("village_harvest_hay".equals(activeRun.action)
            || "village_collect_bed".equals(activeRun.action))
            && activeRun.breakVerified
            && activeRun.harvestAttributedCount + 1 >= activeRun.requestedCount
            && inventoryCount(player, activeRun.segmentTargetItemId)
                > activeRun.segmentBaselineInventory) {
            tickHarvest(
                client, player, intent, activeRun, nowMs,
                "village_harvest_hay".equals(activeRun.action));
            return;
        }
        if ("village_craft_bread".equals(activeRun.action)
            && (activeRun.phase == Phase.CRAFT_BREAD || activeRun.breadCraftVerified)) {
            activeRun.maximumObservedFoodLevel = Math.max(
                activeRun.maximumObservedFoodLevel,
                player.getHungerManager().getFoodLevel());
            if (!activeRun.breadCraftVerified) {
                String subcommand = activeRun.commandId + ":bread:" + activeRun.craftSequence;
                int breadGain = activeRun.breadInventoryBaselineFrozen
                    ? inventoryCount(player, "minecraft:bread")
                        - activeRun.breadInventoryBaseline
                    : 0;
                if (!shell.villageCraft3x3Finished(subcommand) && breadGain >= 1) {
                    BrainLink.Intent subIntent = shell.makeSubIntent(
                        intent, "craft_bread", subcommand, "village_craft_bread_recipe");
                    // A live bread gain means TAKE_RESULT already happened. This resolve can only
                    // advance the nested executor's typed VERIFY stage; its returned physical
                    // output is deliberately ignored in this pre-reflex hook.
                    shell.resolveVillageCraft3x3(client, player, subIntent, nowMs);
                }
                if (!shell.villageCraft3x3Finished(subcommand)) {
                    return;
                }
                activeRun.breadCraftInFlight = false;
                String reason = shell.villageCraft3x3Reason(subcommand);
                if (reason == null || reason.contains("_failed:")) {
                    activeRun.terminalResult = VillageOpportunityReceiptStore.Result.UNAVAILABLE;
                    activeRun.terminalSuffix = "unavailable";
                    activeRun.terminalContents = Map.of();
                    return;
                }
                if (!prepareVerifiedBreadScreen(client, player, activeRun, nowMs)) {
                    return;
                }
                recordVerifiedBread(activeRun, player);
            }

            if (!prepareVerifiedBreadScreen(client, player, activeRun, nowMs)) {
                return;
            }
            HotbarStagingResult hotbarStaging = ensureActionHotbar(
                client, player, activeRun, "minecraft:bread", nowMs);
            if (hotbarStaging == HotbarStagingResult.PENDING) {
                return;
            }
            if (hotbarStaging == HotbarStagingResult.FAILED) {
                activeRun.terminalResult = VillageOpportunityReceiptStore.Result.UNAVAILABLE;
                activeRun.terminalSuffix = "unavailable";
                activeRun.terminalContents = Map.of();
                return;
            }
            if (activeRun.breadProducedCount < activeRun.requestedCount) {
                prepareNextBreadBatchIteration(activeRun, player, nowMs);
                return;
            }
            if (activeRun.temporaryTablePlacedCount
                > activeRun.temporaryTableRecoveredCount) {
                activeRun.phase = Phase.RETRIEVE_TABLE;
                // Retrieval breaks a block and therefore cannot run in this pre-reflex hook.
                // The terminal latch prevents Survival from invalidating the verified craft;
                // normal executor control retrieves the table after the reflex releases.
                activeRun.terminalResult = VillageOpportunityReceiptStore.Result.CRAFTED;
                activeRun.terminalSuffix = "crafted";
                activeRun.terminalContents = Map.of();
                return;
            }
            finish(intent, activeRun, VillageOpportunityReceiptStore.Result.CRAFTED,
                "crafted", nowMs, Map.of());
        }
    }

    /**
     * Releases only the owned 3x3 crafting GUI after typed bread verification. A clean close is
     * bookkeeping necessary for Survival to use the hotbar bread; physical table retrieval stays
     * deferred to normal executor control. Unexpected cursor state fails closed into the existing
     * bounded rollback path.
     */
    private boolean prepareVerifiedBreadScreen(
        MinecraftClient client,
        ClientPlayerEntity player,
        Run run,
        long nowMs
    ) {
        ScreenHandler handler = player == null ? null : player.currentScreenHandler;
        if (handler == null || handler == player.playerScreenHandler) {
            shell.clearVillageCraftState(client, player, nowMs);
            return true;
        }
        if (!(handler instanceof CraftingScreenHandler)
            || handler.getCursorStack() == null
            || !handler.getCursorStack().isEmpty()) {
            run.terminalResult = VillageOpportunityReceiptStore.Result.UNSAFE;
            run.terminalSuffix = "unsafe";
            run.terminalContents = Map.of();
            if (run.terminalCleanupStartedAtMs <= 0L) {
                run.terminalCleanupStartedAtMs = nowMs;
            }
            prepareTerminalCleanup(client, player, run, nowMs);
            return false;
        }
        player.closeHandledScreen();
        shell.clearVillageCraftState(client, player, nowMs);
        shell.logger().info(
            "village.opportunity.bread.pre_reflex_screen_closed instanceId={} commandId={} opportunityId={} cursorEmpty=true",
            shell.instanceId(), run.commandId, run.opportunityId);
        return true;
    }

    /** Roll back an in-flight GUI cursor before a higher-priority physical reflex takes control. */
    ControlDecision resolveEngagedGolemSafetyBeforeReflex(
        MinecraftClient client,
        ClientPlayerEntity player,
        long nowMs
    ) {
        Run run = activeRun;
        if (run == null || !"village_defeat_iron_golem".equals(run.action)
            || run.terminalResult != null) {
            return null;
        }
        WorldScope scope = worldScope == null ? null : worldScope.current();
        int nearbyHostiles = scope == null ? Integer.MAX_VALUE : scope.nearbyHostileCount();
        if (!ironGolemExecutor.needsPreReflexSafetyBarrier(player, nearbyHostiles)) {
            return null;
        }
        ironGolemExecutor.requestPostEngagementEscape(player, nearbyHostiles, nowMs);
        IronGolemOpportunityExecutor.Step step = ironGolemExecutor.tick(
            client, player, run.admittedIntent, nearbyHostiles, nowMs);
        if (!step.terminal()) {
            return step.decision();
        }
        VillageOpportunityReceiptStore.Result result = switch (step.outcome()) {
            case COLLECTED -> VillageOpportunityReceiptStore.Result.COLLECTED;
            case UNSAFE -> VillageOpportunityReceiptStore.Result.UNSAFE;
            case INVALIDATED -> VillageOpportunityReceiptStore.Result.INVALIDATED;
            case UNAVAILABLE, ACTIVE -> VillageOpportunityReceiptStore.Result.UNAVAILABLE;
        };
        String suffix = result == VillageOpportunityReceiptStore.Result.COLLECTED
            ? "collected"
            : result == VillageOpportunityReceiptStore.Result.UNSAFE
                ? "unsafe"
                : result == VillageOpportunityReceiptStore.Result.INVALIDATED
                    ? "invalidated" : "unavailable";
        if (result == VillageOpportunityReceiptStore.Result.COLLECTED) {
            run.authoritativeInventoryDelta = step.authoritativeInventoryDelta();
        }
        return finish(run.admittedIntent, run, result, suffix, nowMs, Map.of());
    }

    /** Roll back an in-flight GUI cursor before a higher-priority physical reflex takes control. */
    void preemptForReflex(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent intent,
        long nowMs,
        String reason
    ) {
        if (activeRun == null || player == null) {
            return;
        }
        if ("village_defeat_iron_golem".equals(activeRun.action)
            && (ironGolemExecutor.engaged() || ironGolemExecutor.ownsSafetyEscape())) {
            return;
        }
        boolean matching = intent != null && sameEffectiveIntent(activeRun, intent);
        boolean handoffPending =
            activeRun.handoffCleanupPhase != HandoffCleanupPhase.NONE;
        if (!matching && !handoffPending) {
            return;
        }
        if (activeRun.terminalResult != null && !handoffPending) {
            return;
        }
        ScreenHandler handler = player.currentScreenHandler;
        ItemStack cursor = handler == null ? ItemStack.EMPTY : handler.getCursorStack();
        VillageNestedCraftCleanupResult nested =
            shell.prepareVillageNestedCraftCleanup(client, player, nowMs);
        boolean nestedRollbackOwnsTick = nested.clickIssued()
            || nested.status() != VillageNestedCraftCleanupResult.Status.CLEAN;
        if (nested.clickIssued()) {
            activeRun.terminalCleanupAttempts += 1;
        }
        if (nested.status() == VillageNestedCraftCleanupResult.Status.REJECTED) {
            activeRun.nestedCraftCleanupRejected = true;
        }
        handler = player.currentScreenHandler;
        cursor = handler == null ? ItemStack.EMPTY : handler.getCursorStack();
        if ("village_craft_bread".equals(activeRun.action)
            && activeRun.breadBetweenCrafts
            && activeRun.breadProducedCount < activeRun.requestedCount
            && handler == player.playerScreenHandler
            && (cursor == null || cursor.isEmpty())) {
            activeRun.maximumObservedFoodLevel = Math.max(
                activeRun.maximumObservedFoodLevel,
                player.getHungerManager().getFoodLevel());
            // The prior typed loaf is already authoritative and all GUI state is clean. Let an
            // urgent eater consume it, then continue the same bounded batch when Survival releases.
            return;
        }
        if ("village_withdraw_item".equals(activeRun.action)
            && activeRun.withdrawTransferred == activeRun.requestedCount
            && activeRun.withdrawCursorReturned
            && activeRun.withdrawPlayerGainVerified
            && (cursor == null || cursor.isEmpty())) {
            // The exact player-side gain is already frozen. Keep the neutral bookkeeping alive
            // across an urgent eat while the correlated container-removal poll settles.
            return;
        }
        if ("village_craft_bread".equals(activeRun.action)
            && activeRun.breadCraftVerified
            && !activeRun.hotbarStagingVerified
            && (cursor == null || cursor.isEmpty())) {
            // The exact typed craft is verified, but its one bounded main-inventory-to-hotbar
            // handoff may need the next client observation. Survival must not invalidate the
            // outer receipt while that conservation check is pending.
            return;
        }
        if ("village_collect_bed".equals(activeRun.action)
            && activeRun.harvestAttributedCount == activeRun.requestedCount
            && !activeRun.hotbarStagingVerified
            && (cursor == null || cursor.isEmpty())) {
            return;
        }
        if (!nestedRollbackOwnsTick
            && cursor != null && !cursor.isEmpty() && handler != null) {
            int slot = findCursorReturnSlot(handler, activeRun, cursor);
            if (slot >= 0 && client != null && client.interactionManager != null
                && (activeRun.lastClickAtMs <= 0L
                    || nowMs - activeRun.lastClickAtMs >= GUI_CLICK_SETTLE_MS)) {
                if (clickSlot(client, player, handler, activeRun, slot, 0,
                    SlotActionType.PICKUP, "reflex_cursor_rollback", nowMs)) {
                    activeRun.terminalCleanupAttempts += 1;
                }
            }
        }
        if (!nestedRollbackOwnsTick
            && handler != null && handler != player.playerScreenHandler
            && handler.getCursorStack().isEmpty()) {
            player.closeHandledScreen();
        }
        if (!handoffPending) {
            activeRun.terminalResult = VillageOpportunityReceiptStore.Result.UNSAFE;
            activeRun.terminalSuffix = "unsafe";
            activeRun.terminalContents = Map.of();
            if (activeRun.terminalCleanupStartedAtMs <= 0L) {
                activeRun.terminalCleanupStartedAtMs = nowMs;
            }
        }
        routeController.clear();
        shell.blockBreakController().reset();
        shell.logger().warn(
            "village.opportunity.preempted instanceId={} commandId={} action={} stage={} reason={} cursorEmpty={}",
            shell.instanceId(), activeRun.commandId, activeRun.action, activeRun.stage,
            normalize(reason), handler == null || handler.getCursorStack().isEmpty());
    }

    /**
     * Bounded cleanup for manual takeover.  The disabled-control branch calls this every tick, so
     * a cursor rollback is allowed to wait for the normal GUI acknowledgement interval without
     * issuing duplicate clicks.  Physical village state is forgotten only after the cursor is
     * empty and the owned screen has closed.
     */
    boolean prepareForManualTakeover(
        MinecraftClient client,
        ClientPlayerEntity player,
        long nowMs
    ) {
        if (activeRun == null) {
            return true;
        }
        if (activeRun.terminalResult == null) {
            activeRun.terminalResult = VillageOpportunityReceiptStore.Result.UNSAFE;
            activeRun.terminalSuffix = "unsafe";
            activeRun.terminalContents = Map.of();
        }
        if (activeRun.terminalCleanupStartedAtMs <= 0L) {
            activeRun.terminalCleanupStartedAtMs = nowMs;
        }
        if (!prepareTerminalCleanup(client, player, activeRun, nowMs)) {
            if (nowMs - activeRun.terminalCleanupStartedAtMs
                    < TERMINAL_CLEANUP_TIMEOUT_MS
                && activeRun.terminalCleanupAttempts
                    < MAX_TERMINAL_CLEANUP_ATTEMPTS) {
                return false;
            }
            if (player != null && player.currentScreenHandler != null
                && player.currentScreenHandler != player.playerScreenHandler) {
                player.closeHandledScreen();
            }
            shell.clearVillageCraftState(client, player, nowMs);
        }
        shell.logger().warn(
            "village.opportunity.lifecycle_aborted instanceId={} commandId={} action={} reason=manual_takeover cursorEmpty=true",
            shell.instanceId(), activeRun.commandId, activeRun.action);
        clearLifecycleState();
        return true;
    }

    /** Best-effort rollback plus fail-closed screen close when no future client tick is guaranteed. */
    void clearForLifecycle(
        MinecraftClient client,
        ClientPlayerEntity player,
        long nowMs,
        String reason
    ) {
        if (activeRun != null && player != null) {
            boolean clean = prepareTerminalCleanup(client, player, activeRun, nowMs);
            if (!clean && player.currentScreenHandler != null
                && player.currentScreenHandler != player.playerScreenHandler) {
                player.closeHandledScreen();
            }
            shell.clearVillageCraftState(client, player, nowMs);
            shell.logger().warn(
                "village.opportunity.lifecycle_aborted instanceId={} commandId={} action={} reason={} cursorEmpty={}",
                shell.instanceId(), activeRun.commandId, activeRun.action, normalize(reason),
                player.currentScreenHandler == null
                    || player.currentScreenHandler.getCursorStack().isEmpty());
        }
        clearLifecycleState();
    }

    void clearForLifecycle() {
        MinecraftClient client = MinecraftClient.getInstance();
        clearForLifecycle(
            client,
            client == null ? null : client.player,
            System.currentTimeMillis(),
            "lifecycle"
        );
    }

    private void clearLifecycleState() {
        clearActiveRun();
        clearSession();
        receipts.clear();
        ledger.clear();
        handoffAbortedCommands.clear();
    }

    private void rememberHandoffAbort(String commandId) {
        String stableCommand = stable(commandId);
        if (stableCommand.isBlank()) {
            return;
        }
        handoffAbortedCommands.remove(stableCommand);
        handoffAbortedCommands.put(stableCommand, Boolean.TRUE);
        while (handoffAbortedCommands.size() > 64) {
            String oldest = handoffAbortedCommands.keySet().iterator().next();
            handoffAbortedCommands.remove(oldest);
        }
    }

    private ControlDecision finish(
        BrainLink.Intent intent,
        Run run,
        VillageOpportunityReceiptStore.Result result,
        String suffix,
        long nowMs,
        Map<String, Integer> contents
    ) {
        if (run == null) {
            return stopped(intent, "village_opportunity_complete:opportunity_" + suffix);
        }
        MinecraftClient minecraft = MinecraftClient.getInstance();
        ClientPlayerEntity livePlayer = minecraft == null ? null : minecraft.player;
        run.terminalResult = result;
        run.terminalSuffix = suffix;
        run.terminalContents = contents == null ? Map.of() : Map.copyOf(contents);
        if (run.terminalCleanupStartedAtMs <= 0L) {
            run.terminalCleanupStartedAtMs = nowMs;
        }
        if (!prepareTerminalCleanup(minecraft, livePlayer, run, nowMs)) {
            run.terminalResult = result;
            run.terminalSuffix = suffix;
            run.terminalContents = contents == null ? Map.of() : Map.copyOf(contents);
            if (nowMs - run.terminalCleanupStartedAtMs < TERMINAL_CLEANUP_TIMEOUT_MS
                && run.terminalCleanupAttempts < MAX_TERMINAL_CLEANUP_ATTEMPTS) {
                return stopped(intent, "village_opportunity_terminal_cleanup");
            }
            // Vanilla screen close is the final bounded safety primitive: the server returns the
            // cursor stack to inventory when possible and otherwise materializes it rather than
            // silently deleting it. Never hold a command forever on an unreturnable cursor.
            forceCloseAndClearNested(minecraft, livePlayer, run, nowMs);
            result = VillageOpportunityReceiptStore.Result.UNSAFE;
            suffix = "unsafe";
            contents = Map.of();
            run.terminalResult = result;
            run.terminalSuffix = suffix;
            run.terminalContents = contents;
        }
        if (run.temporaryTablePlacedCount > run.temporaryTableRecoveredCount
            && !run.temporaryTableRecoveryFailed) {
            ControlDecision recovery = prepareTemporaryTableRecovery(
                minecraft, livePlayer, intent, run, nowMs);
            if (recovery != null) {
                return recovery;
            }
            if (run.temporaryTableRecoveryFailed) {
                result = VillageOpportunityReceiptStore.Result.UNSAFE;
                suffix = "unsafe";
                contents = Map.of();
                run.authoritativeInventoryDelta = null;
                run.terminalResult = result;
                run.terminalSuffix = suffix;
                run.terminalContents = contents;
            }
        }
        if (session != null) {
            if ("village_travel".equals(run.action)
                && result == VillageOpportunityReceiptStore.Result.ARRIVED) {
                session.frozenTravelArrival = new FrozenTravelArrival(
                    run.opportunityId,
                    run.opportunityRevision,
                    run.rootTarget,
                    run.detourStageSeq,
                    run.stage);
            } else if ("village_revalidate".equals(run.action)) {
                session.frozenTravelArrival = null;
            }
        }
        String reason = run.action + "_complete:opportunity_" + suffix;
        if ((result == VillageOpportunityReceiptStore.Result.UNAVAILABLE
            || result == VillageOpportunityReceiptStore.Result.INVALIDATED
            || result == VillageOpportunityReceiptStore.Result.UNSAFE) && session != null) {
            session.failures = Math.min(2, session.failures + 1);
        }
        ledger.markComplete(run.commandId, reason);
        WorldScope scope = session == null ? null : session.scope;
        if (scope == null || scope.worldId().isBlank() || scope.dimension().isBlank()
            || session == null || run.detourStageSeq < 0) {
            // A receipt without code-owned scope/correlation would be unsafe to consume. The
            // command still completes neutrally, but no ambiguous receipt is advertised.
            clearActiveRun();
            shell.completeCurrentCommand(run.commandId, reason, nowMs);
            return stopped(intent, reason);
        }
        Map<String, Integer> inventoryDelta = Map.of();
        if (run.authoritativeInventoryDelta != null) {
            inventoryDelta = run.authoritativeInventoryDelta;
        } else if (minecraft != null && minecraft.player != null) {
            inventoryDelta = positiveInventoryDelta(
                run.baselineInventory, captureInventoryCounts(minecraft.player));
        }
        Map<String, Integer> consumedInventoryDelta = Map.of();
        if (run.foodConsumptionTracker != null && !run.targetItemId.isBlank()) {
            int consumed = run.foodConsumptionTracker.verifiedConsumedForReceipt(
                inventoryDelta.getOrDefault(run.targetItemId, 0));
            if (consumed > 0) {
                consumedInventoryDelta = Map.of(run.targetItemId, consumed);
            }
        }
        String receiptId = session.detourId + ":" + run.detourStageSeq + ":"
            + run.commandId + ":" + result.name().toLowerCase(Locale.ROOT);
        receipts.record(new VillageOpportunityReceiptStore.Receipt(
            receiptId,
            scope.worldId(),
            scope.dimension(),
            scope.mission(),
            session.detourId,
            run.detourStageSeq,
            run.commandId,
            run.action,
            run.opportunityId,
            run.opportunityRevision,
            run.stage,
            result,
            reason,
            "village_defeat_iron_golem".equals(run.action)
                ? run.opportunityId
                : run.target == null ? run.targetItemId : "block:" + run.target.toShortString(),
            contents,
            inventoryDelta,
            consumedInventoryDelta,
            run.containerRevision,
            session.replans,
            nowMs));
        String terminalEvent = terminalEvent(run.action, result);
        int inventoryTablesAfter = livePlayer == null
            ? 0 : inventoryCount(livePlayer, "minecraft:crafting_table");
        int inventoryTablesBefore = run.baselineInventory.getOrDefault(
            "minecraft:crafting_table", 0);
        boolean reservedTablePreserved =
            run.temporaryTablePlacedCount == run.temporaryTableRecoveredCount
                && inventoryTablesAfter >= inventoryTablesBefore;
        int foodLevelAfter = livePlayer == null
            ? run.maximumObservedFoodLevel : livePlayer.getHungerManager().getFoodLevel();
        run.maximumObservedFoodLevel = Math.max(
            run.maximumObservedFoodLevel, foodLevelAfter);
        int foodLevelGain = Math.max(
            0, run.maximumObservedFoodLevel - run.foodLevelBefore);
        int observedBreadDelta = livePlayer == null ? 0 : Math.max(
            0,
            inventoryCount(livePlayer, "minecraft:bread")
                - run.baselineInventory.getOrDefault("minecraft:bread", 0));
        boolean survivalConsumptionObserved = !consumedInventoryDelta.isEmpty();
        if (!(result == VillageOpportunityReceiptStore.Result.INSPECTED
            && "inspected".equals(terminalEvent))
            && !"village_defeat_iron_golem".equals(run.action)) {
            shell.logger().info(
                "village.opportunity.{}.{} instanceId={} commandId={} opportunityId={} opportunityRevision={} stage={} target={} targetItemId={} targetCount={} requested={} producedCount={} inventoryDelta={} observedBreadDelta={} foodLevelBefore={} foodLevelAfter={} foodLevelGain={} survivalConsumptionObserved={} travelBlocks={} routeReplanCount={} temporaryTablePlacedCount={} temporaryTableRecoveredCount={} inventoryTablesAfter={} reservedTablePreserved={} elapsedMs={} result={} reason={}",
                eventStem(run.action), terminalEvent, shell.instanceId(), run.commandId,
                run.opportunityId, run.opportunityRevision, run.stage, format(run.target),
                run.targetItemId, run.requestedCount, run.requestedCount,
                run.breadProducedCount, inventoryDelta, observedBreadDelta,
                run.foodLevelBefore, foodLevelAfter, foodLevelGain,
                survivalConsumptionObserved,
                session == null ? 0.0D : session.groundedTravelBlocks,
                session == null ? 0 : session.replans,
                run.temporaryTablePlacedCount, run.temporaryTableRecoveredCount,
                inventoryTablesAfter, reservedTablePreserved,
                Math.max(0L, nowMs - run.startedAtMs),
                result.name().toLowerCase(Locale.ROOT), reason);
        }
        shell.logger().info(
            "village.opportunity.receipt instanceId={} receiptId={} detourId={} detourStageSeq={} commandId={} action={} opportunityId={} opportunityRevision={} stage={} result={} targetItemId={} targetCount={} producedCount={} inventoryDelta={} consumedInventoryDelta={} observedBreadDelta={} foodLevelGain={} survivalConsumptionObserved={} containerRevision={} routeReplanCount={} elapsedMs={} reason={}",
            shell.instanceId(), receiptId, session.detourId, run.detourStageSeq,
            run.commandId, run.action, run.opportunityId,
            run.opportunityRevision, run.stage, result.name().toLowerCase(Locale.ROOT),
            run.targetItemId, run.requestedCount, run.breadProducedCount, inventoryDelta,
            consumedInventoryDelta,
            observedBreadDelta, foodLevelGain, survivalConsumptionObserved,
            run.containerRevision, session.replans,
            Math.max(0L, nowMs - run.startedAtMs), reason);
        clearActiveRun();
        shell.completeCurrentCommand(run.commandId, reason, nowMs);
        return stopped(intent, reason);
    }

    private static void observeTargetFoodConsumption(
        Run run,
        ClientPlayerEntity player
    ) {
        if (run == null || player == null || run.foodConsumptionTracker == null
            || run.targetItemId.isBlank()) {
            return;
        }
        run.foodConsumptionTracker.observe(
            inventoryCount(player, run.targetItemId),
            player.getHungerManager().getFoodLevel());
    }

    private boolean prepareTerminalCleanup(
        MinecraftClient client,
        ClientPlayerEntity player,
        Run run,
        long nowMs
    ) {
        if (run != null && run.nestedCraftCleanupComplete) {
            return true;
        }
        if (client == null || player == null || player.currentScreenHandler == null) {
            shell.clearVillageCraftState(client, player, nowMs);
            if (run != null) {
                run.nestedCraftCleanupComplete = true;
            }
            return true;
        }
        ScreenHandler handler = player.currentScreenHandler;
        // A live player-grid or crafting-table craft owns both its cursor and its click-settle
        // clock. Let that executor return the cursor and input grid before the outer village
        // transaction attempts generic rollback. Otherwise an intent switch immediately after a
        // nested PICKUP can issue a second, unacknowledged click using Run.lastClickAtMs.
        VillageNestedCraftCleanupResult nested =
            shell.prepareVillageNestedCraftCleanup(client, player, nowMs);
        if (nested.clickIssued()) {
            run.terminalCleanupAttempts += 1;
        }
        if (nested.status() == VillageNestedCraftCleanupResult.Status.PENDING) {
            return false;
        }
        if (nested.status() == VillageNestedCraftCleanupResult.Status.REJECTED) {
            run.nestedCraftCleanupRejected = true;
            return false;
        }
        handler = player.currentScreenHandler;
        ItemStack cursor = handler.getCursorStack();
        if (cursor != null && !cursor.isEmpty()) {
            if (nowMs - run.lastClickAtMs < GUI_CLICK_SETTLE_MS) {
                return false;
            }
            int slot = findCursorReturnSlot(handler, run, cursor);
            if (slot < 0 || client.interactionManager == null) {
                return false;
            }
            if (!clickSlot(client, player, handler, run, slot, 0,
                SlotActionType.PICKUP, "terminal_cursor_return", nowMs)) {
                run.nestedCraftCleanupRejected = true;
                return false;
            }
            run.terminalCleanupAttempts += 1;
            return false;
        }
        if (handler != player.playerScreenHandler) {
            player.closeHandledScreen();
            run.terminalCleanupAttempts += 1;
            return false;
        }
        if (run.lastClickAtMs > 0L
            && nowMs - run.lastClickAtMs < GUI_CLICK_SETTLE_MS) {
            return false;
        }
        shell.clearVillageCraftState(client, player, nowMs);
        run.nestedCraftCleanupComplete = true;
        return true;
    }

    private void forceCloseAndClearNested(
        MinecraftClient client,
        ClientPlayerEntity player,
        Run run,
        long nowMs
    ) {
        if (player != null && player.currentScreenHandler != null
            && (player.currentScreenHandler != player.playerScreenHandler
                || !cursorEmpty(player)
                || occupiedPlayerCraftingInputs(player) > 0)) {
            // Vanilla close is the final bounded conservation primitive. In particular, closing
            // the player handler returns/drops any residual 2x2 inputs before its executor state is
            // discarded; merely clearing the Java run could strand those stacks in the grid.
            player.closeHandledScreen();
        }
        shell.clearVillageCraftState(client, player, nowMs);
        if (run != null) {
            run.nestedCraftCleanupComplete = true;
        }
    }

    private static int findCursorReturnSlot(
        ScreenHandler handler,
        Run run,
        ItemStack cursor
    ) {
        if (handler == null || cursor == null || cursor.isEmpty()) {
            return -1;
        }
        if (run != null && run.sourceSlot >= 0 && run.sourceSlot < handler.slots.size()) {
            ItemStack source = handler.getSlot(run.sourceSlot).getStack();
            if (source == null || source.isEmpty()
                || ItemStack.areItemsAndComponentsEqual(source, cursor)) {
                return run.sourceSlot;
            }
        }
        int start = handler instanceof GenericContainerScreenHandler container
            ? container.getRows() * 9 : 9;
        int empty = -1;
        for (int slot = Math.max(0, start); slot < handler.slots.size(); slot++) {
            ItemStack stack = handler.getSlot(slot).getStack();
            if (stack == null || stack.isEmpty()) {
                if (empty < 0) {
                    empty = slot;
                }
            } else if (ItemStack.areItemsAndComponentsEqual(stack, cursor)
                && stack.getCount() + cursor.getCount() <= stack.getMaxCount()) {
                return slot;
            }
        }
        if (empty >= 0) {
            return empty;
        }
        // A full player inventory may still safely return a cursor remainder to another compatible
        // container slot. This is preferable to relying on the bounded close fallback.
        for (int slot = 0; slot < Math.min(start, handler.slots.size()); slot++) {
            ItemStack stack = handler.getSlot(slot).getStack();
            if (stack == null || stack.isEmpty()) {
                return slot;
            }
            if (ItemStack.areItemsAndComponentsEqual(stack, cursor)
                && stack.getCount() + cursor.getCount() <= stack.getMaxCount()) {
                return slot;
            }
        }
        return -1;
    }

    private Run ensureRun(
        BrainLink.Intent intent,
        MinecraftClient client,
        ClientPlayerEntity player,
        long nowMs
    ) {
        if (activeRun != null) {
            return activeRun;
        }
        String action = intent == null ? "village_revalidate" : normalize(intent.action());
        return new Run(
            intent,
            intent == null ? "" : stable(intent.commandId()),
            action,
            intent == null ? "" : stable(intent.opportunityId()),
            intent == null ? 0L : Math.max(0L, safeRevision(intent.opportunityRevision())),
            stageFor(action),
            intent == null ? null : target(intent),
            1,
            nowMs,
            player == null ? Map.of() : captureInventoryCounts(player));
    }

    private boolean discoveryMatches(Run run) {
        return discoveryMatches(
            run, discoveries == null ? null : discoveries.find(run.opportunityId));
    }

    private boolean discoveryMatches(Run run, DiscoveryFact fact) {
        if (fact == null || !run.opportunityId.equals(fact.id())
            || !fact.safelyExecutable()) {
            return false;
        }
        if (run.target == null || "village_travel".equals(run.action)
            || "village_defeat_iron_golem".equals(run.action)) {
            return true;
        }
        return fact.anchor() != null && fact.anchor().equals(run.target);
    }

    static boolean canDeferMissingRevalidation(
        String action,
        DiscoveryFact fact,
        FrozenTravelArrival arrival,
        String opportunityId,
        long opportunityRevision,
        BlockPos target,
        int detourStageSeq,
        String stage
    ) {
        return fact == null
            && "village_revalidate".equals(normalize(action))
            && arrival != null
            && arrival.matches(
                opportunityId,
                opportunityRevision,
                target,
                detourStageSeq,
                stage);
    }

    static boolean canDeferMissingTravel(
        String action,
        DiscoveryFact fact,
        boolean catalogTruncated,
        BlockPos target,
        String stage
    ) {
        String normalizedStage = normalize(stage);
        return fact == null
            && catalogTruncated
            && "village_travel".equals(normalize(action))
            && target != null
            && ("travel".equals(normalizedStage) || "travel_edge".equals(normalizedStage));
    }

    private boolean sessionAllows(MinecraftClient client, Run run) {
        if (session == null || client == null || client.world != session.world) {
            return false;
        }
        WorldScope liveScope = worldScope == null ? null : worldScope.current();
        if (liveScope == null || !session.scope.worldId().equals(liveScope.worldId())
            || !session.scope.dimension().equals(liveScope.dimension())) {
            return false;
        }
        if (run.target == null || session.rootPosition == null) {
            return true;
        }
        return Math.hypot(
            run.target.getX() - session.rootPosition.getX(),
            run.target.getZ() - session.rootPosition.getZ()) <= MAX_SESSION_RADIUS;
    }

    private String safetyFailure(MinecraftClient client, ClientPlayerEntity player) {
        if (player.getHealth() < MIN_SAFE_HEALTH) {
            return "low_health";
        }
        if (session != null && player.getHealth() + 0.001F < session.healthBaseline) {
            return "health_loss";
        }
        if (player.isTouchingWater()) {
            return "wet";
        }
        long dayTime = Math.floorMod(client.world.getTimeOfDay(), 24_000L);
        if (dayTime >= 13_000L && dayTime < 23_000L) {
            return "night";
        }
        WorldScope liveScope = worldScope == null ? null : worldScope.current();
        if (liveScope == null || liveScope.nearbyHostileCount() > 0) {
            return "nearby_hostile";
        }
        // The scope count is computed from the bounded entity-event cache; it is not a world scan.
        // CombatController still preempts this normal executor immediately on the same tick.
        return "";
    }

    private static boolean requiresDiscovery(String action) {
        return !"village_craft_bread".equals(action);
    }

    private static boolean requiresRoute(String action) {
        return !"village_craft_bread".equals(action)
            && !"village_defeat_iron_golem".equals(action);
    }

    static boolean opensSessionAtActionAdmission(String action) {
        String normalized = normalize(action);
        return "village_travel".equals(normalized)
            || "village_defeat_iron_golem".equals(normalized);
    }

    static VillageInteractionStancePlanner.Mode routeMode(
        String action,
        String opportunityId
    ) {
        if ("village_travel".equals(action)) {
            String id = stable(opportunityId);
            if (id.startsWith("bed:") || id.startsWith("hay:")) {
                // Beds have a partial-height collision shape, so exact travel can appear valid
                // while leaving canonical feet inside the block. Travel to the same code-owned
                // stance the eventual harvest will use instead.
                return VillageInteractionStancePlanner.Mode.HARVEST_BLOCK;
            }
            if (id.startsWith("container:")) {
                return VillageInteractionStancePlanner.Mode.INTERACT_BLOCK;
            }
            return VillageInteractionStancePlanner.Mode.EXACT_TRAVEL;
        }
        if ("village_harvest_hay".equals(action) || "village_collect_bed".equals(action)) {
            return VillageInteractionStancePlanner.Mode.HARVEST_BLOCK;
        }
        return VillageInteractionStancePlanner.Mode.INTERACT_BLOCK;
    }

    private static String targetItemForRun(BrainLink.Intent intent, String action) {
        return switch (action) {
            case "village_withdraw_item" -> canonicalItem(intent.targetItemId());
            case "village_harvest_hay" -> "#bed_hay";
            case "village_collect_bed" -> "#beds";
            case "village_craft_bread" -> "minecraft:bread";
            case "village_defeat_iron_golem" -> "minecraft:iron_ingot";
            default -> "";
        };
    }

    private static boolean safeCell(MinecraftClient client, VoxelCell cell) {
        if (client == null || client.world == null || cell == null) {
            return false;
        }
        WorldVoxelPerception perception = new WorldVoxelPerception(
            client.world, cell.x() - 1, cell.x() + 1, cell.y() - 2, cell.y() + 2,
            cell.z() - 1, cell.z() + 1);
        return VillageInteractionStancePlanner.safeStance(perception, cell);
    }

    private static VoxelCell feet(ClientPlayerEntity player) {
        return new VoxelCell(
            (int) Math.floor(player.getX()),
            (int) Math.floor(player.getY() + 0.001D),
            (int) Math.floor(player.getZ()));
    }

    private static BlockHitResult raycastBlock(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos target
    ) {
        if (client == null || client.world == null || player == null || target == null) {
            return null;
        }
        Vec3d center = Vec3d.ofCenter(target);
        if (player.getEyePos().distanceTo(center) > VillageInteractionStancePlanner.INTERACTION_REACH) {
            return null;
        }
        BlockHitResult hit = client.world.raycast(new RaycastContext(
            player.getEyePos(), center, RaycastContext.ShapeType.OUTLINE,
            RaycastContext.FluidHandling.NONE, player));
        return hit != null && hit.getType() == HitResult.Type.BLOCK
            && hit.getBlockPos().equals(target) ? hit : null;
    }

    private static boolean isContainer(BlockState state) {
        return state != null && (state.isOf(Blocks.CHEST)
            || state.isOf(Blocks.TRAPPED_CHEST)
            || state.isOf(Blocks.BARREL));
    }

    private static Map<String, Integer> captureContainer(GenericContainerScreenHandler handler) {
        if (handler == null) {
            return Map.of();
        }
        Map<String, Integer> counts = new java.util.TreeMap<>();
        int slots = Math.min(handler.slots.size(), handler.getRows() * 9);
        for (int slot = 0; slot < slots; slot++) {
            ItemStack stack = handler.getSlot(slot).getStack();
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            counts.merge(Registries.ITEM.getId(stack.getItem()).toString(),
                stack.getCount(), Integer::sum);
        }
        return Map.copyOf(counts);
    }

    private static Map<String, Integer> stableContainerContents(
        GenericContainerScreenHandler handler,
        Run run,
        long nowMs
    ) {
        Map<String, Integer> contents = captureContainer(handler);
        String fingerprint = contents.toString();
        if (!fingerprint.equals(run.containerFingerprint)) {
            run.containerFingerprint = fingerprint;
            run.containerStablePolls = 1;
            run.containerFirstObservedAtMs = nowMs;
            return null;
        }
        run.containerStablePolls += 1;
        return run.containerStablePolls >= 2 ? contents : null;
    }

    private static boolean containerStillCorrelated(
        MinecraftClient client,
        ClientPlayerEntity player,
        Run run
    ) {
        return run != null && run.target != null
            && isContainer(client.world.getBlockState(run.target))
            && player.getEyePos().distanceTo(Vec3d.ofCenter(run.target))
                <= VillageInteractionStancePlanner.INTERACTION_REACH
            && raycastBlock(client, player, run.target) != null;
    }

    private static int findContainerSlot(
        GenericContainerScreenHandler handler,
        int containerSlots,
        String itemId
    ) {
        for (int slot = 0; slot < Math.min(containerSlots, handler.slots.size()); slot++) {
            ItemStack stack = handler.getSlot(slot).getStack();
            if (stack != null && !stack.isEmpty()
                && canonicalItem(Registries.ITEM.getId(stack.getItem()).toString()).equals(itemId)) {
                return slot;
            }
        }
        return -1;
    }

    private static int findPlayerDestinationSlot(
        ScreenHandler handler,
        int containerSlots,
        String itemId
    ) {
        int empty = -1;
        for (int slot = Math.max(0, containerSlots); slot < handler.slots.size(); slot++) {
            ItemStack stack = handler.getSlot(slot).getStack();
            if (stack == null || stack.isEmpty()) {
                if (empty < 0) {
                    empty = slot;
                }
                continue;
            }
            if (canonicalItem(Registries.ITEM.getId(stack.getItem()).toString()).equals(itemId)
                && stack.getCount() < stack.getMaxCount()) {
                return slot;
            }
        }
        return empty;
    }

    private boolean clickSlot(
        MinecraftClient client,
        ClientPlayerEntity player,
        ScreenHandler handler,
        Run run,
        int slot,
        int button,
        SlotActionType action,
        String label,
        long nowMs
    ) {
        boolean applied = handler == player.playerScreenHandler
            ? shell.clickAuthorizedPlayerInventorySlot(
                client, player, handler, slot, button, action)
            : shell.clickAuthorizedContainerSlot(
                client,
                player,
                run.containerAccessRequestId,
                handler,
                slot,
                button,
                action
            );
        if (!applied) {
            shell.logger().warn(
                "village.opportunity.container.click_denied instanceId={} commandId={} opportunityId={} label={} handler={} syncId={}",
                shell.instanceId(), run.commandId, run.opportunityId, label,
                handler.getClass().getSimpleName(), handler.syncId);
            return false;
        }
        run.lastClickAtMs = nowMs;
        shell.logger().info(
            "village.opportunity.container.click instanceId={} commandId={} opportunityId={} label={} slot={} button={} action={}",
            shell.instanceId(), run.commandId, run.opportunityId, label, slot, button, action);
        return true;
    }

    private static boolean nearbyCraftingTable(
        MinecraftClient client,
        ClientPlayerEntity player
    ) {
        BlockPos origin = player.getBlockPos();
        for (int dx = -4; dx <= 4; dx++) {
            for (int dy = -2; dy <= 2; dy++) {
                for (int dz = -4; dz <= 4; dz++) {
                    BlockPos pos = origin.add(dx, dy, dz);
                    if (client.world.getBlockState(pos).isOf(Blocks.CRAFTING_TABLE)
                        && player.getEyePos().distanceTo(Vec3d.ofCenter(pos))
                            <= VillageInteractionStancePlanner.INTERACTION_REACH) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private static int inventoryCount(ClientPlayerEntity player, String requested) {
        if (player == null || requested == null || requested.isBlank()) {
            return 0;
        }
        int count = 0;
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String id = Registries.ITEM.getId(stack.getItem()).toString();
            if ("#beds".equals(requested) && id.endsWith("_bed")
                || "#bed_hay".equals(requested) && id.equals("minecraft:hay_block")
                || canonicalItem(requested).equals(id)) {
                count += stack.getCount();
            }
        }
        return count;
    }

    /**
     * Makes an exact village-acquired action item usable by its existing hotbar-only executor.
     * One physical swap is allowed per opportunity run. A full hotbar is safe only when the pure
     * planner identifies an unselected, unprotected displacement slot; the complete pre-swap
     * inventory multiset is checked again before the opportunity may publish a successful receipt.
     */
    private HotbarStagingResult ensureActionHotbar(
        MinecraftClient client,
        ClientPlayerEntity player,
        Run run,
        String rawItemId,
        long nowMs
    ) {
        String itemId = canonicalItem(rawItemId);
        if (!requiresActionHotbar(itemId)) {
            return HotbarStagingResult.READY;
        }
        if (client == null || player == null || run == null) {
            return HotbarStagingResult.FAILED;
        }
        if (run.hotbarStagingVerified) {
            int stillUsable = shell.findHotbarSlot(
                player, observed -> itemId.equals(canonicalItem(observed)));
            if (stillUsable >= 0) {
                return HotbarStagingResult.READY;
            }
            if ("village_craft_bread".equals(run.action)
                && run.maximumObservedFoodLevel > run.foodLevelBefore
                && inventoryCount(player, itemId) > 0) {
                resetActionHotbarStaging(run);
            } else {
                return rejectActionHotbar(
                    run, itemId, run.hotbarDestinationSlot,
                    inventoryCount(player, itemId), "prepared_item_no_longer_usable", nowMs);
            }
        }
        if (run.hotbarStagingRejectedLogged) {
            return HotbarStagingResult.FAILED;
        }

        int totalBeforeMove = inventoryCount(player, itemId);
        if (!run.inventoryBeforeHotbarStagingFrozen) {
            if (totalBeforeMove <= 0) {
                return rejectActionHotbar(run, itemId, -1, totalBeforeMove,
                    "item_missing_before_handoff", nowMs);
            }
            run.itemCountBeforeHotbarStaging = totalBeforeMove;
            run.inventoryBeforeHotbarStaging = captureInventoryCounts(player);
            run.inventoryBeforeHotbarStagingFrozen = true;
        }

        int hotbarSlot = shell.findHotbarSlot(
            player, observed -> itemId.equals(canonicalItem(observed)));
        Map<String, Integer> inventoryAfter = captureInventoryCounts(player);
        boolean conserved = inventoryContainsAtLeast(
            run.inventoryBeforeHotbarStaging, inventoryAfter);
        if (hotbarSlot >= 0) {
            if (!conserved
                || inventoryCount(player, itemId) < run.itemCountBeforeHotbarStaging) {
                if (run.hotbarMoveAttempted
                    && nowMs - run.hotbarMoveAttemptedAtMs < GUI_CLICK_SETTLE_MS) {
                    run.hotbarVerificationDeferred = true;
                    return HotbarStagingResult.PENDING;
                }
                return rejectActionHotbar(run, itemId, hotbarSlot,
                    inventoryCount(player, itemId), "inventory_not_conserved", nowMs);
            }
            run.hotbarDestinationSlot = hotbarSlot;
            run.hotbarStagingVerified = true;
            shell.logger().info(
                "village.opportunity.action_hotbar.prepared instanceId={} commandId={} opportunityId={} action={} targetItemId={} targetCount={} outcome={} hotbarSlot={} inventoryCountBefore={} inventoryCountAfter={} moveAttempted={} inventoryConserved=true verified=true elapsedMs={}",
                shell.instanceId(), run.commandId, run.opportunityId, run.action, itemId,
                run.requestedCount, VillageHotbarStagingPlanner.Outcome.ALREADY_USABLE,
                hotbarSlot, run.itemCountBeforeHotbarStaging,
                inventoryCount(player, itemId), run.hotbarMoveAttempted,
                Math.max(0L, nowMs - run.startedAtMs));
            logFoodHotbarPrepared(run, itemId, hotbarSlot, player, nowMs);
            return HotbarStagingResult.READY;
        }

        if (run.hotbarMoveAttempted) {
            if (nowMs - run.hotbarMoveAttemptedAtMs < GUI_CLICK_SETTLE_MS) {
                run.hotbarVerificationDeferred = true;
                return HotbarStagingResult.PENDING;
            }
            if (!conserved || totalBeforeMove < run.itemCountBeforeHotbarStaging) {
                return rejectActionHotbar(run, itemId, run.hotbarDestinationSlot,
                    totalBeforeMove, "inventory_not_conserved", nowMs);
            }
            return rejectActionHotbar(run, itemId, run.hotbarDestinationSlot, totalBeforeMove,
                "hotbar_swap_not_verified", nowMs);
        }
        if (!conserved || totalBeforeMove < run.itemCountBeforeHotbarStaging) {
            return rejectActionHotbar(run, itemId, -1, totalBeforeMove,
                "inventory_not_conserved", nowMs);
        }

        VillageHotbarStagingPlanner.Plan plan = planActionHotbar(player, itemId);
        if (plan.outcome() == VillageHotbarStagingPlanner.Outcome.NO_SAFE_SLOT) {
            return rejectActionHotbar(run, itemId, -1, totalBeforeMove,
                "no_safe_hotbar_slot", nowMs);
        }
        if (plan.outcome() == VillageHotbarStagingPlanner.Outcome.ALREADY_USABLE) {
            // The live shell lookup above is authoritative; disagreement fails closed.
            return rejectActionHotbar(run, itemId, plan.slot(), totalBeforeMove,
                "hotbar_plan_state_mismatch", nowMs);
        }
        run.hotbarDestinationSlot = plan.slot();
        run.hotbarPlanOutcome = plan.outcome();
        int moved = shell.moveInventoryItemToHotbarSlot(
            client, player, observed -> itemId.equals(canonicalItem(observed)),
            plan.slot(), run.commandId, "village_action_item");
        if (moved == -2) {
            // Closing a foreign/owned GUI is not a swap attempt. The next tick receives the one
            // physical attempt after the player inventory handler is authoritative again.
            return HotbarStagingResult.PENDING;
        }
        run.hotbarMoveAttempted = true;
        run.hotbarMoveAttemptedAtMs = nowMs;
        if (moved < 0) {
            return rejectActionHotbar(run, itemId, moved, totalBeforeMove,
                "no_safe_hotbar_swap", nowMs);
        }

        hotbarSlot = shell.findHotbarSlot(
            player, observed -> itemId.equals(canonicalItem(observed)));
        inventoryAfter = captureInventoryCounts(player);
        conserved = inventoryContainsAtLeast(run.inventoryBeforeHotbarStaging, inventoryAfter);
        if (hotbarSlot == run.hotbarDestinationSlot && conserved
            && inventoryCount(player, itemId) >= run.itemCountBeforeHotbarStaging) {
            run.hotbarStagingVerified = true;
            shell.logger().info(
                "village.opportunity.action_hotbar.prepared instanceId={} commandId={} opportunityId={} action={} targetItemId={} targetCount={} outcome={} hotbarSlot={} inventoryCountBefore={} inventoryCountAfter={} moveAttempted=true inventoryConserved=true verified=true elapsedMs={}",
                shell.instanceId(), run.commandId, run.opportunityId, run.action, itemId,
                run.requestedCount, run.hotbarPlanOutcome, hotbarSlot,
                run.itemCountBeforeHotbarStaging, inventoryCount(player, itemId),
                Math.max(0L, nowMs - run.startedAtMs));
            logFoodHotbarPrepared(run, itemId, hotbarSlot, player, nowMs);
            return HotbarStagingResult.READY;
        }
        run.hotbarVerificationDeferred = true;
        return HotbarStagingResult.PENDING;
    }

    private static void resetActionHotbarStaging(Run run) {
        run.inventoryBeforeHotbarStagingFrozen = false;
        run.itemCountBeforeHotbarStaging = 0;
        run.inventoryBeforeHotbarStaging = Map.of();
        run.hotbarMoveAttempted = false;
        run.hotbarMoveAttemptedAtMs = 0L;
        run.hotbarVerificationDeferred = false;
        run.hotbarStagingVerified = false;
        run.hotbarStagingRejectedLogged = false;
        run.hotbarDestinationSlot = -1;
        run.hotbarPlanOutcome = VillageHotbarStagingPlanner.Outcome.NO_SAFE_SLOT;
    }

    private HotbarStagingResult rejectActionHotbar(
        Run run,
        String itemId,
        int hotbarSlot,
        int inventoryCountAfter,
        String reason,
        long nowMs
    ) {
        if (!run.hotbarStagingRejectedLogged) {
            run.hotbarStagingRejectedLogged = true;
            shell.logger().warn(
                "village.opportunity.action_hotbar.rejected instanceId={} commandId={} opportunityId={} action={} targetItemId={} targetCount={} outcome={} hotbarSlot={} inventoryCountBefore={} inventoryCountAfter={} moveAttempted={} verificationDeferred={} verified=false elapsedMs={} reason={}",
                shell.instanceId(), run.commandId, run.opportunityId, run.action, itemId,
                run.requestedCount, run.hotbarPlanOutcome, hotbarSlot,
                run.itemCountBeforeHotbarStaging, inventoryCountAfter, run.hotbarMoveAttempted,
                run.hotbarVerificationDeferred, Math.max(0L, nowMs - run.startedAtMs),
                normalize(reason));
            if (VILLAGE_EDIBLE_ITEMS.contains(itemId)) {
                shell.logger().warn(
                    "village.opportunity.food_hotbar.rejected instanceId={} commandId={} opportunityId={} action={} targetItemId={} targetCount={} hotbarSlot={} inventoryCountBefore={} inventoryCountAfter={} moveAttempted={} verificationDeferred={} verified=false elapsedMs={} reason={}",
                    shell.instanceId(), run.commandId, run.opportunityId, run.action, itemId,
                    run.requestedCount, hotbarSlot, run.itemCountBeforeHotbarStaging,
                    inventoryCountAfter, run.hotbarMoveAttempted,
                    run.hotbarVerificationDeferred,
                    Math.max(0L, nowMs - run.startedAtMs), normalize(reason));
            }
        }
        return HotbarStagingResult.FAILED;
    }

    private void logFoodHotbarPrepared(
        Run run,
        String itemId,
        int hotbarSlot,
        ClientPlayerEntity player,
        long nowMs
    ) {
        if (!VILLAGE_EDIBLE_ITEMS.contains(itemId)) {
            return;
        }
        shell.logger().info(
            "village.opportunity.food_hotbar.prepared instanceId={} commandId={} opportunityId={} action={} targetItemId={} targetCount={} hotbarSlot={} inventoryCountBefore={} inventoryCountAfter={} moveAttempted={} inventoryConserved=true verified=true elapsedMs={}",
            shell.instanceId(), run.commandId, run.opportunityId, run.action, itemId,
            run.requestedCount, hotbarSlot, run.itemCountBeforeHotbarStaging,
            inventoryCount(player, itemId), run.hotbarMoveAttempted,
            Math.max(0L, nowMs - run.startedAtMs));
    }

    private static VillageHotbarStagingPlanner.Plan planActionHotbar(
        ClientPlayerEntity player,
        String itemId
    ) {
        List<VillageHotbarStagingPlanner.SlotState> slots = new ArrayList<>(9);
        int selectedSlot = player == null ? -1 : player.getInventory().selectedSlot;
        for (int index = 0; index < 9; index++) {
            ItemStack stack = player == null ? ItemStack.EMPTY : player.getInventory().getStack(index);
            boolean empty = stack == null || stack.isEmpty();
            String observed = empty ? "" : canonicalItem(
                Registries.ITEM.getId(stack.getItem()).toString());
            slots.add(new VillageHotbarStagingPlanner.SlotState(
                index,
                itemId.equals(observed),
                empty,
                index == selectedSlot,
                !empty && protectedHotbarStack(stack, observed)));
        }
        return VillageHotbarStagingPlanner.plan(slots);
    }

    static boolean requiresActionHotbar(String rawItemId) {
        String itemId = canonicalItem(rawItemId);
        return ACTION_HOTBAR_ITEMS.contains(itemId) || itemId.endsWith("_bed");
    }

    private static boolean protectedHotbarStack(ItemStack stack, String rawItemId) {
        if (stack == null || stack.isEmpty()) {
            return false;
        }
        String itemId = canonicalItem(rawItemId);
        if (stack.contains(DataComponentTypes.FOOD)
            || itemId.endsWith("_pickaxe")
            || itemId.endsWith("_sword")
            || itemId.endsWith("_axe")
            || itemId.endsWith("_shovel")
            || itemId.endsWith("_hoe")
            || itemId.endsWith("_bed")) {
            return true;
        }
        return PROTECTED_HOTBAR_ITEMS.contains(itemId)
            || itemId.endsWith("_planks")
            || itemId.endsWith("_log");
    }

    static boolean inventoryContainsAtLeast(
        Map<String, Integer> before,
        Map<String, Integer> after
    ) {
        if (before == null || before.isEmpty()) {
            return true;
        }
        if (after == null) {
            return false;
        }
        for (Map.Entry<String, Integer> entry : before.entrySet()) {
            if (after.getOrDefault(entry.getKey(), 0) < entry.getValue()) {
                return false;
            }
        }
        return true;
    }

    private static Map<String, Integer> captureInventoryCounts(ClientPlayerEntity player) {
        if (player == null) {
            return Map.of();
        }
        java.util.TreeMap<String, Integer> counts = new java.util.TreeMap<>();
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            counts.merge(
                canonicalItem(Registries.ITEM.getId(stack.getItem()).toString()),
                stack.getCount(), Integer::sum);
        }
        return Map.copyOf(counts);
    }

    private static Map<String, Integer> positiveInventoryDelta(
        Map<String, Integer> before,
        Map<String, Integer> after
    ) {
        java.util.TreeMap<String, Integer> delta = new java.util.TreeMap<>();
        if (after != null) {
            for (Map.Entry<String, Integer> entry : after.entrySet()) {
                int gained = Math.max(0, entry.getValue() == null ? 0 : entry.getValue())
                    - Math.max(0, before == null ? 0 : before.getOrDefault(entry.getKey(), 0));
                if (gained > 0) {
                    delta.put(entry.getKey(), gained);
                }
            }
        }
        return Map.copyOf(delta);
    }

    private static int baselineCount(Run run, String requested) {
        if (run == null || requested == null || requested.isBlank()) {
            return 0;
        }
        if ("#beds".equals(requested)) {
            return run.baselineInventory.entrySet().stream()
                .filter(entry -> entry.getKey().endsWith("_bed"))
                .mapToInt(Map.Entry::getValue)
                .sum();
        }
        if ("#bed_hay".equals(requested)) {
            return run.baselineInventory.getOrDefault("minecraft:hay_block", 0);
        }
        return run.baselineInventory.getOrDefault(canonicalItem(requested), 0);
    }

    private static BlockPos target(BrainLink.Intent intent) {
        if (intent == null || intent.targetX() == null || intent.targetY() == null
            || intent.targetZ() == null) {
            return null;
        }
        return new BlockPos(
            (int) Math.floor(intent.targetX()),
            (int) Math.floor(intent.targetY()),
            (int) Math.floor(intent.targetZ()));
    }

    private static String stageFor(String action) {
        return switch (normalize(action)) {
            case "village_travel" -> "travel";
            case "village_revalidate" -> "revalidate";
            case "village_inspect_container" -> "inspect_container";
            case "village_withdraw_item" -> "withdraw_item";
            case "village_harvest_hay" -> "harvest_hay";
            case "village_craft_bread" -> "craft_bread";
            case "village_collect_bed" -> "collect_bed";
            case "village_defeat_iron_golem" -> "defeat_golem";
            default -> "invalid";
        };
    }

    private static boolean stageAllowed(String action, String stage) {
        String normalizedAction = normalize(action);
        String normalizedStage = normalize(stage);
        if ("village_travel".equals(normalizedAction)) {
            return "travel".equals(normalizedStage) || "travel_edge".equals(normalizedStage);
        }
        if ("village_revalidate".equals(normalizedAction)) {
            return "revalidate".equals(normalizedStage)
                || "revalidate_edge".equals(normalizedStage);
        }
        return stageFor(normalizedAction).equals(normalizedStage);
    }

    private static String eventStem(String action) {
        return switch (normalize(action)) {
            case "village_travel" -> "travel";
            case "village_revalidate" -> "revalidate";
            case "village_inspect_container" -> "container";
            case "village_withdraw_item" -> "withdraw";
            case "village_harvest_hay" -> "hay";
            case "village_craft_bread" -> "bread";
            case "village_collect_bed" -> "bed";
            case "village_defeat_iron_golem" -> "golem";
            default -> "unknown";
        };
    }

    private static String terminalEvent(
        String action,
        VillageOpportunityReceiptStore.Result result
    ) {
        if (result == VillageOpportunityReceiptStore.Result.UNAVAILABLE
            || result == VillageOpportunityReceiptStore.Result.INVALIDATED
            || result == VillageOpportunityReceiptStore.Result.UNSAFE) {
            return "rejected";
        }
        return switch (normalize(action)) {
            case "village_travel" -> "arrived";
            case "village_revalidate" -> "verified";
            case "village_inspect_container" -> "inspected";
            default -> "completed";
        };
    }

    private static String canonicalItem(String value) {
        String normalized = normalize(value);
        if (normalized.isBlank() || normalized.startsWith("#")) {
            return normalized;
        }
        return normalized.indexOf(':') >= 0 ? normalized : "minecraft:" + normalized;
    }

    private static boolean sameEffectiveIntent(Run run, BrainLink.Intent intent) {
        if (run == null || intent == null || run.admittedIntent == null) {
            return false;
        }
        BrainLink.Intent admitted = run.admittedIntent;
        return run.commandId.equals(stable(intent.commandId()))
            && run.action.equals(normalize(intent.action()))
            && run.opportunityId.equals(stable(intent.opportunityId()))
            && run.opportunityRevision == safeRevision(intent.opportunityRevision())
            && normalize(admitted.opportunityStage()).equals(normalize(intent.opportunityStage()))
            && normalize(admitted.opportunityMission()).equals(normalize(intent.opportunityMission()))
            && stable(admitted.detourId()).equals(stable(intent.detourId()))
            && java.util.Objects.equals(admitted.detourStageSeq(), intent.detourStageSeq())
            && stable(admitted.resumeToken()).equals(stable(intent.resumeToken()))
            && canonicalItem(admitted.targetItemId()).equals(canonicalItem(intent.targetItemId()))
            && java.util.Objects.equals(admitted.targetItemCount(), intent.targetItemCount())
            && java.util.Objects.equals(target(admitted), target(intent));
    }

    private void reconcileSwitchTickTemporaryTable(
        MinecraftClient client,
        ClientPlayerEntity player,
        Run run
    ) {
        if (run == null || !"village_craft_bread".equals(run.action)
            || run.temporaryTablePlacedCount > 0 || run.tableSupport == null
            || !run.handoffTablePlacementCorrelated
            || client == null || client.world == null
            || player == null) {
            return;
        }
        BlockPos exactTable = run.handoffTablePlacementPos;
        if (exactTable == null) {
            return;
        }
        if (!client.world.getBlockState(exactTable).isOf(Blocks.CRAFTING_TABLE)) {
            return;
        }
        String tableCommand = run.commandId + ":table";
        String completion = shell.villagePlaceTableReason(tableCommand);
        boolean verifiedCompletion = completion != null
            && completion.startsWith("place_table_complete:");
        boolean awaitingVerification =
            shell.blockPlaceController().isAwaitingVerification(tableCommand);
        int baselineTables = run.baselineInventory.getOrDefault(
            "minecraft:crafting_table", 0);
        int inventoryTables = inventoryCount(player, "minecraft:crafting_table");
        boolean exactInventoryDebit = baselineTables > 0
            && inventoryTables + 1 <= baselineTables;
        if (!exactInventoryDebit || !run.handoffTablePlacementCorrelated) {
            return;
        }
        run.temporaryTablePos = exactTable.toImmutable();
        run.temporaryTablePlacedCount = 1;
        run.phase = Phase.RETRIEVE_TABLE;
        shell.logger().info(
            "village.opportunity.table.handoff_attributed instanceId={} commandId={} opportunityId={} exactTable={} verifiedCompletion={} awaitingVerification={} inventoryTablesBefore={} inventoryTablesAfter={} temporaryTablePlacedCount=1",
            shell.instanceId(), run.commandId, run.opportunityId, format(exactTable),
            verifiedCompletion, awaitingVerification, baselineTables, inventoryTables);
    }

    private void freezeSwitchTickTableCorrelation(MinecraftClient client, Run run) {
        if (run == null || run.handoffTablePlacementCorrelated
            || !"village_craft_bread".equals(run.action)
            || run.phase != Phase.PLACE_TABLE || run.tableSupport == null
            || client == null || client.world == null) {
            return;
        }
        BlockPos exactTable = run.tableSupport.up();
        String tableCommand = run.commandId + ":table";
        String completion = shell.villagePlaceTableReason(tableCommand);
        boolean correlated = completion != null
            && completion.startsWith("place_table_complete:")
            || shell.blockPlaceController().isAwaitingVerification(tableCommand);
        if (correlated) {
            run.handoffTablePlacementCorrelated = true;
            run.handoffTablePlacementPos = exactTable.toImmutable();
        }
    }

    private static boolean cursorEmpty(ClientPlayerEntity player) {
        return player == null || player.currentScreenHandler == null
            || player.currentScreenHandler.getCursorStack() == null
            || player.currentScreenHandler.getCursorStack().isEmpty();
    }

    private static int occupiedPlayerCraftingInputs(ClientPlayerEntity player) {
        if (player == null || player.playerScreenHandler == null) {
            return 0;
        }
        int occupied = 0;
        int end = Math.min(
            McbotFabricClient.PLAYER_CRAFTING_INPUT_END,
            player.playerScreenHandler.slots.size());
        for (int slot = McbotFabricClient.PLAYER_CRAFTING_INPUT_START; slot < end; slot++) {
            ItemStack stack = player.playerScreenHandler.getSlot(slot).getStack();
            if (stack != null && !stack.isEmpty()) {
                occupied += 1;
            }
        }
        return occupied;
    }

    private static String screenName(ClientPlayerEntity player) {
        return player == null || player.currentScreenHandler == null
            ? "none" : player.currentScreenHandler.getClass().getSimpleName();
    }

    private static long safeRevision(Long value) {
        return value == null ? -1L : value;
    }

    private static String stable(String value) {
        String normalized = value == null ? "" : value.trim();
        return normalized.length() <= 128 ? normalized : "";
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }

    private static String format(BlockPos pos) {
        return pos == null ? "none" : pos.toShortString();
    }

    private ControlDecision stopped(BrainLink.Intent intent, String reason) {
        return new ControlDecision(shell.stopFrom(intent, reason), InputState.stop());
    }

    private static ControlDecision withInteraction(
        ControlDecision decision,
        BlockBreakController.Result result
    ) {
        if (decision == null || result == null || result.interactionDemand() == null) {
            return decision;
        }
        return new ControlDecision(
            decision.intent(), decision.input(), decision.lookDemand(), decision.legacyLookDemand(),
            decision.locomotionDemand(), result.interactionDemand(), result.interactionPayload());
    }

    private void clearActiveRun() {
        routeController.clear();
        ironGolemExecutor.clear();
        shell.blockBreakController().reset();
        if (activeRun != null) {
            activeRun.harvestDropTracker.reset();
            activeRun.harvestDropRouteController.clear();
        }
        activeRun = null;
    }

    private void clearSession() {
        session = null;
    }

    @Override
    public boolean isFinished(String commandId) {
        return ledger.isFinished(commandId);
    }

    @Override
    public String finishedReason(String commandId) {
        return ledger.reason(commandId);
    }

    private static final class Session {
        final long id;
        final Object world;
        final WorldScope scope;
        final String detourId;
        final String resumeToken;
        final String rootOpportunityId;
        final long rootRevision;
        final BlockPos rootPosition;
        final Vec3d startPosition;
        final float healthBaseline;
        final long startedAtMs;
        final Set<BlockPos> inspectedContainers = new HashSet<>();
        final Map<BlockPos, Map<String, Integer>> knownContainers = new HashMap<>();
        int lastStageSeq = -1;
        int replans;
        int failures;
        double groundedTravelBlocks;
        Vec3d lastGroundedPosition;
        FrozenTravelArrival frozenTravelArrival;

        Session(
            long id,
            Object world,
            String detourId,
            String resumeToken,
            String rootOpportunityId,
            long rootRevision,
            BlockPos rootPosition,
            Vec3d startPosition,
            float healthBaseline,
            WorldScope scope,
            long startedAtMs
        ) {
            this.id = id;
            this.world = world;
            this.scope = scope;
            this.detourId = stable(detourId);
            this.resumeToken = stable(resumeToken);
            this.rootOpportunityId = rootOpportunityId;
            this.rootRevision = rootRevision;
            this.rootPosition = rootPosition == null ? null : rootPosition.toImmutable();
            this.startPosition = startPosition;
            this.healthBaseline = healthBaseline;
            this.startedAtMs = startedAtMs;
            this.lastGroundedPosition = startPosition;
        }

        void observe(ClientPlayerEntity player) {
            if (player == null || !player.isOnGround() || player.isTouchingWater()) {
                return;
            }
            Vec3d current = player.getPos();
            if (lastGroundedPosition != null) {
                groundedTravelBlocks += Math.hypot(
                    current.x - lastGroundedPosition.x,
                    current.z - lastGroundedPosition.z);
            }
            lastGroundedPosition = current;
        }
    }

    private static final class Run {
        final BrainLink.Intent admittedIntent;
        final String commandId;
        final String action;
        final String opportunityId;
        final long opportunityRevision;
        final String stage;
        final BlockPos rootTarget;
        BlockPos target;
        final int requestedCount;
        final long startedAtMs;
        final Map<String, Integer> baselineInventory;
        Phase phase = Phase.AT_STANCE;
        VillageInteractionStancePlanner.Plan plan;
        VillageRoutePlanSelector.Selection routeSelection;
        String pendingUseRequestId = "";
        boolean containerUseApplied;
        String containerAccessRequestId = "";
        long containerUseAcceptedAtMs;
        int openAttempts;
        long containerRevision;
        int sourceSlot = -1;
        int destinationSlot = -1;
        int withdrawDesired;
        int withdrawDeposited;
        int withdrawTransferred;
        int withdrawCursorInitial;
        int withdrawInventoryBaseline;
        int withdrawContainerBaselineCount;
        boolean withdrawBaselineFrozen;
        boolean withdrawRemovalVerified;
        boolean withdrawCursorReturned;
        boolean withdrawPlayerGainVerified;
        long lastClickAtMs;
        boolean breakVerified;
        long breakVerifiedAtMs;
        int craftSequence;
        boolean wheatCraftInFlight;
        boolean breadCraftInFlight;
        BlockPos tableSupport;
        BlockPos temporaryTablePos;
        int temporaryTablePlacedCount;
        int temporaryTableRecoveredCount;
        boolean temporaryTableRecoveryFailed;
        boolean breadCraftVerified;
        boolean breadBetweenCrafts;
        int breadProducedCount;
        int breadInventoryBaseline;
        boolean breadInventoryBaselineFrozen;
        int foodLevelBefore;
        int maximumObservedFoodLevel;
        boolean inventoryBeforeHotbarStagingFrozen;
        int itemCountBeforeHotbarStaging;
        Map<String, Integer> inventoryBeforeHotbarStaging = Map.of();
        boolean hotbarMoveAttempted;
        long hotbarMoveAttemptedAtMs;
        boolean hotbarVerificationDeferred;
        boolean hotbarStagingVerified;
        boolean hotbarStagingRejectedLogged;
        int hotbarDestinationSlot = -1;
        VillageHotbarStagingPlanner.Outcome hotbarPlanOutcome =
            VillageHotbarStagingPlanner.Outcome.NO_SAFE_SLOT;
        int detourStageSeq;
        String targetItemId = "";
        IronGolemOpportunityExecutor.Phase lastGolemPhase;
        int routeSegments;
        int routeComputations;
        int segmentBaselineInventory;
        int harvestAttributedCount;
        int harvestRouteComputations;
        boolean segmentStarted;
        String segmentTargetItemId = "";
        final OwnedDropTracker harvestDropTracker = new OwnedDropTracker();
        final VillageLocalRouteController harvestDropRouteController =
            new VillageLocalRouteController();
        OwnedDropTracker.Observation harvestDropLastObservation;
        List<VoxelCell> harvestDropRoute = List.of();
        UUID harvestDropRouteEntityId;
        OwnedDropTracker.Position harvestDropRoutePosition;
        VoxelCell harvestDropPickupCell;
        long harvestDropTrackingStartedAtMs;
        long harvestDropCollectionStartedAtMs;
        long harvestDropDisappearedAtMs;
        long harvestDropReachedAtMs;
        final Set<BlockPos> consumedTargets = new HashSet<>();
        final Map<String, Integer> attributedInventoryDelta = new LinkedHashMap<>();
        String containerFingerprint = "";
        int containerStablePolls;
        long containerFirstObservedAtMs;
        boolean containerReadVerified;
        VillageOpportunityReceiptStore.Result terminalResult;
        String terminalSuffix = "";
        Map<String, Integer> terminalContents = Map.of();
        Map<String, Integer> authoritativeInventoryDelta;
        VillageFoodConsumptionTracker foodConsumptionTracker;
        long terminalCleanupStartedAtMs;
        int terminalCleanupAttempts;
        boolean nestedCraftCleanupComplete;
        boolean nestedCraftCleanupRejected;
        HandoffCleanupPhase handoffCleanupPhase = HandoffCleanupPhase.NONE;
        long handoffCleanupStartedAtMs;
        String handoffReplacementCommandId = "";
        String handoffReplacementAction = "";
        boolean handoffRejected;
        boolean golemHandoffBarrier;
        String handoffReason = "";
        boolean handoffTablePlacementCorrelated;
        BlockPos handoffTablePlacementPos;

        Run(
            BrainLink.Intent admittedIntent,
            String commandId,
            String action,
            String opportunityId,
            long opportunityRevision,
            String stage,
            BlockPos target,
            int requestedCount,
            long startedAtMs,
            Map<String, Integer> baselineInventory
        ) {
            this.admittedIntent = admittedIntent;
            this.commandId = commandId;
            this.action = action;
            this.opportunityId = opportunityId;
            this.opportunityRevision = opportunityRevision;
            this.stage = stage;
            this.rootTarget = target == null ? null : target.toImmutable();
            this.target = this.rootTarget;
            this.requestedCount = requestedCount;
            this.startedAtMs = startedAtMs;
            this.baselineInventory = baselineInventory == null
                ? Map.of() : Map.copyOf(baselineInventory);
        }

        boolean matches(String expectedCommandId, String expectedAction) {
            return commandId.equals(expectedCommandId) && action.equals(expectedAction);
        }
    }
}
