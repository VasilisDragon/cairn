package com.mcbot.fabricclient;

import com.google.gson.Gson;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Queue;
import java.util.Set;
import java.util.UUID;
import java.util.function.BiPredicate;
import java.util.function.Predicate;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.gui.Element;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.input.Input;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.Entity;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.mob.HostileEntity;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.item.BlockItem;
import net.minecraft.item.ItemStack;
import net.minecraft.screen.AbstractFurnaceScreenHandler;
import net.minecraft.screen.CraftingScreenHandler;
import net.minecraft.screen.PlayerScreenHandler;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.util.ActionResult;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.BlockView;
import net.minecraft.world.RaycastContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class McbotFabricClient implements ClientModInitializer {
    private static final Logger LOGGER = LoggerFactory.getLogger("mcbot-fabric-client");
    private static final Gson GSON = new Gson();
    private static final long BRAIN_MIN_INTERVAL_MS = 100L;
    private static final long BRAIN_MAX_TTL_MS =
        resolveLong("mcbot.brainMaxTtlMs", "MCBOT_FABRIC_BRAIN_MAX_TTL_MS", 500L);
    private static final long BRAIN_HTTP_TIMEOUT_MS =
        resolveLong("mcbot.brainHttpTimeoutMs", "MCBOT_FABRIC_BRAIN_HTTP_TIMEOUT_MS", 10_000L);
    private static final double LOOK_MAX_DEG_PER_TICK = 12.0D;
    private static final int NAVIGATION_PERCEPTION_MARGIN = 12;
    private static final int NAVIGATION_DIAGNOSTIC_MARGIN = 48;
    private static final int NAVIGATION_DIAGNOSTIC_SCAN_UP = 24;
    private static final int NAVIGATION_DIAGNOSTIC_SCAN_DOWN = 48;
    private static final int LOG_SCAN_RADIUS = 12;
    private static final int LOG_SCAN_DOWN = 3;
    private static final int LOG_SCAN_UP = 8;
    private static final int LOG_SCAN_LIMIT = 24;
    private static final double BLOCK_LOOK_TOLERANCE_DEG = 7.0D;
    private static final double WORKSTATION_PLACE_LOOK_TOLERANCE_DEG = 0.75D;
    private static final double GATHER_ARRIVE_EPSILON = 0.65D;
    private static final long GATHER_PICKUP_SETTLE_MS = 300L;
    private static final long GATHER_COLLECT_TIMEOUT_MS = 8_000L;
    private static final double DIRECT_COLLECT_FALLBACK_DISTANCE = 3.5D;
    private static final double DIRECT_COLLECT_ARRIVE_DISTANCE = 0.35D;
    private static final double GATHER_DROPPED_LOG_SEARCH_RADIUS = 4.0D;
    private static final double GATHER_DROPPED_LOG_SEARCH_Y = 8.0D;
    private static final int GATHER_TREE_CLUSTER_RADIUS = 8;
    private static final int GATHER_TREE_CLUSTER_LIMIT = 32;
    private static final int GATHER_TREE_MAX_BROKEN_LOGS = 24;
    private static final int PLAYER_CRAFTING_RESULT_SLOT = 0;
    private static final int PLAYER_CRAFTING_INPUT_START = 1;
    private static final int PLAYER_CRAFTING_INPUT_END = 5;
    private static final int PLAYER_INVENTORY_SCREEN_START = 9;
    private static final int PLAYER_HOTBAR_SCREEN_END = 45;
    private static final int TABLE_CRAFTING_RESULT_SLOT = 0;
    private static final int TABLE_CRAFTING_INPUT_START = 1;
    private static final int TABLE_CRAFTING_INPUT_END = 10;
    private static final double TABLE_INTERACTION_REACH_BLOCKS = 4.8D;
    private static final long CRAFT_CLICK_SETTLE_MS = 150L;
    private static final long CRAFT_TABLE_OPEN_RETRY_MS = 750L;
    private static final int CRAFT_TABLE_OPEN_MAX_ATTEMPTS = 4;
    private static final long CRAFT_RESULT_WAIT_MS = 2_000L;
    private static final long CRAFT_VERIFY_WAIT_MS = 2_000L;
    private static final long CRAFT_TOTAL_TIMEOUT_MS = 8_000L;
    private static final long FURNACE_SMELT_TOTAL_TIMEOUT_MS = 90_000L;
    private static final long FURNACE_OUTPUT_WAIT_MS = 30_000L;
    private static final long MAKE_CHARCOAL_TOTAL_TIMEOUT_MS = 140_000L;
    private static final int DESCENT_MAX_DEPTH = (int) resolveLong("mcbot.r2MaxDepth", "MCBOT_FABRIC_R2_MAX_DEPTH", 20L);
    private static final long DESCENT_STEP_TIMEOUT_MS = 12_000L;
    private static final long DESCENT_BASE_TIMEOUT_MS = 15_000L;
    private static final double DESCENT_STEP_ARRIVE_EPSILON = 0.42D;
    private static final int DESCENT_MAX_REROUTES = 12;
    private static final double DESCENT_HOSTILE_ABORT_RADIUS = 8.0D;
    private static final int DESCENT_MAX_IRON_CLEANUP_BLOCKS = 12;
    private static final long DESCENT_IRON_CLEANUP_COLLECT_TIMEOUT_MS = 2_500L;
    private static final int NEARBY_STONE_TARGET_COBBLESTONE = 10;
    private static final long NEARBY_STONE_TIMEOUT_MS = 45_000L;
    private static final int NEARBY_IRON_TARGET_RAW_IRON = 3;
    private static final long NEARBY_IRON_TIMEOUT_MS = 150_000L;
    private static final int NEARBY_IRON_MAX_PROSPECT_BLOCKS = 64;
    private static final int NEARBY_IRON_MAX_TOOL_RECOVERY_ATTEMPTS = 4;
    private static final int NEARBY_IRON_PICKAXE_RESTOCK_REMAINING = 32;
    private static final long RETURN_STAIRCASE_TIMEOUT_MS = 35_000L;
    private static final long RETURN_STAIRCASE_STEP_TIMEOUT_MS = 3_500L;
    private static final long RETURN_STAIRCASE_WAYPOINT_STUCK_MS = 10_000L;
    private static final double RETURN_STAIRCASE_JUMP_DISTANCE_BLOCKS = 0.92D;
    private static final long R2_MINE_STONE_RETURN_TIMEOUT_MS = 180_000L;
    private static final long R5_IRON_CHAIN_TIMEOUT_MS = 660_000L;
    private static final long R5_IRON_CHAIN_FIXTURE_SETTLE_MS = 750L;

    private final String instanceId = resolveInstanceId();
    private final URI brainUri = URI.create(resolveBrainUrl());
    private final boolean autoSingleplayer = resolveBoolean("mcbot.autoSingleplayer", "MCBOT_FABRIC_AUTO_SINGLEPLAYER");
    private final boolean autoRespawn = resolveBoolean("mcbot.autoRespawn", "MCBOT_FABRIC_AUTO_RESPAWN");
    private final boolean terrainColumnProbe = resolveBoolean("mcbot.terrainColumnProbe", "MCBOT_FABRIC_TERRAIN_COLUMN_PROBE");
    private final HttpClient httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofMillis(250))
        .build();
    private final BrainLink brainLink =
        new BrainLink(instanceId, this::sendToBrain, BRAIN_MIN_INTERVAL_MS, BRAIN_MAX_TTL_MS);
    private long lastAutoSingleplayerStepMs = 0L;
    private String lastAppliedAction = "initial";
    private String lastLookTarget = "";
    private long lastLookLogMs = 0L;
    private InputState currentInputState = InputState.stop();
    private String activeNavigationCommandId = "";
    private int activeNavigationWaypointIndex = 0;
    private PathFollower.Progress activeNavigationProgress = PathFollower.Progress.initial();
    private List<GridCell> activeNavigationWaypoints = List.of();
    private boolean activeNavigationRouteComputed = false;
    private Set<Integer> activeNavigationJumpWaypointIndexes = Set.of();
    private String lastServerCommandBatchId = "";
    private long lastRespawnRequestMs = 0L;
    private long lastBrainTimingLogMs = 0L;
    private String lastTtlExpiryKey = "";
    private String lastNavigationTargetRejectionKey = "";
    private String lastDirectCollectFallbackLogKey = "";
    private long lastDirectCollectFallbackLogAtMs = 0L;
    private final BlockBreakController blockBreakController = new BlockBreakController();
    private final SurvivalController survivalController = new SurvivalController(instanceId);
    private final CombatController combatController = new CombatController(instanceId);
    private final BlockPlaceController blockPlaceController = new BlockPlaceController();
    private String lastBlockBreakLogKey = "";
    private String lastGatherCollectItemLogKey = "";
    private GatherLogRun activeGatherLog = null;
    private GatherTreeRun activeGatherTree = null;
    private MineStoneRun activeMineStone = null;
    private DescentRun activeDescent = null;
    private MineNearbyStoneRun activeMineNearbyStone = null;
    private MineNearbyIronRun activeMineNearbyIron = null;
    private ReturnStaircaseRun activeReturnStaircase = null;
    private R2MineStoneReturnRun activeR2MineStoneReturn = null;
    private R5IronChainRun activeR5IronChain = null;
    private Craft2x2Run activeCraft2x2 = null;
    private Craft3x3Run activeCraft3x3 = null;
    private SmeltCharcoalRun activeSmeltCharcoal = null;
    private MakeCharcoalRun activeMakeCharcoal = null;
    private RetrieveTableRun activeRetrieveTable = null;
    private String activePlaceTableCommandId = "";
    private int activePlaceTableBaselineTables = 0;
    private BlockPos activePlaceTableSupportTarget = null;
    private String activePlaceFurnaceCommandId = "";
    private int activePlaceFurnaceBaselineFurnaces = 0;
    private boolean activePlaceFurnaceSneakRequired = false;
    private BlockPos activePlaceFurnaceSupportTarget = null;
    private final Set<String> completedGatherLogCommandIds = new HashSet<>();
    private final Set<String> completedGatherTreeCommandIds = new HashSet<>();
    private final Set<String> completedMineStoneCommandIds = new HashSet<>();
    private final Map<String, String> finishedDescentCommandReasons = new HashMap<>();
    private final Map<String, List<BlockPos>> completedDescentPaths = new HashMap<>();
    private final Map<String, String> finishedMineNearbyStoneCommandReasons = new HashMap<>();
    private final Map<String, String> finishedMineNearbyIronCommandReasons = new HashMap<>();
    private final Map<String, String> finishedReturnStaircaseCommandReasons = new HashMap<>();
    private final Map<String, String> finishedR2MineStoneReturnCommandReasons = new HashMap<>();
    private final Map<String, String> finishedR5IronChainCommandReasons = new HashMap<>();
    private final Set<String> completedBreakBlockCommandIds = new HashSet<>();
    private final Set<String> completedCraft2x2CommandIds = new HashSet<>();
    private final Set<String> completedCraft3x3CommandIds = new HashSet<>();
    private final Set<String> completedSmeltCharcoalCommandIds = new HashSet<>();
    private final Set<String> completedMakeCharcoalCommandIds = new HashSet<>();
    private final Set<String> completedPlaceTableCommandIds = new HashSet<>();
    private final Set<String> completedPlaceFurnaceCommandIds = new HashSet<>();
    private final Set<String> completedRetrieveTableCommandIds = new HashSet<>();

    @Override
    public void onInitializeClient() {
        LOGGER.info("MCBot Fabric spike loaded. instanceId={} brainUrl={}", instanceId, brainUri);
        LOGGER.info("IPC protocol invariant: first request line is instanceId:{}", instanceId);
        ClientTickEvents.END_CLIENT_TICK.register(this::onClientTick);
        ClientLifecycleEvents.CLIENT_STOPPING.register((client) -> {
            brainLink.shutdown();
            LOGGER.info("MCBot Fabric spike stopped. instanceId={}", instanceId);
        });
    }

    private void onClientTick(MinecraftClient client) {
        long tickStartNs = System.nanoTime();
        long nowMs = System.currentTimeMillis();
        ClientPlayerEntity player = client.player;
        if (player == null || client.world == null) {
            maybeDriveAutoSingleplayerMenu(client, nowMs);
            return;
        }

        if (!client.isInSingleplayer()) {
            if (player.input instanceof McbotControlledInput) {
                releaseAllInputs(player.input);
            }
            return;
        }

        if (player.getHealth() <= 0.0F || player.isDead()) {
            if (autoRespawn) {
                maybeRequestRespawn(player, nowMs);
            } else {
                currentInputState = InputState.stop();
                releaseAllInputs(player.input);
            }
            return;
        }

        ensureControlledInput(player);

        // Snapshot is built on the client thread; BrainLink dispatches the brain call
        // off-thread and never blocks this tick.
        ClientSnapshot snapshot = ClientSnapshot.from(
            instanceId,
            player,
            nowMs,
            currentInputState,
            activeNavigationCommandId,
            activeNavigationRouteComputed,
            activeNavigationWaypoints,
            activeNavigationWaypointIndex,
            client.world,
            terrainColumnProbe
        );
        brainLink.poll(GSON.toJson(snapshot), nowMs);
        BrainLink.Intent effective = brainLink.effectiveIntent(nowMs);
        BrainLink.Diagnostics brainDiagnostics = brainLink.diagnostics(nowMs);
        logTtlExpiry(effective, brainDiagnostics);
        applyServerCommands(client, effective);
        // R7 combat reflex: highest-priority fast-loop guard. Threat response (engage/flee/logout)
        // preempts everything else — the bot fights or bails before it eats or runs its normal task.
        CombatController.Result combat = combatController.tick(client, player, nowMs);
        if (combat.active()) {
            currentInputState = combat.input();
            applyInputState(player.input, currentInputState);
            logBrainTiming(nowMs, tickStartNs, brainDiagnostics);
            return;
        }
        // R6 survival reflex: a fast-loop guard that preempts normal control when the bot must
        // eat, retreat, or log out. Brain polling above still runs so intent stays warm; we only
        // override the control output for this tick. Same preempt-and-return shape as the respawn
        // guard earlier in this method.
        SurvivalController.Result survival = survivalController.tick(client, player, nowMs);
        if (survival.active()) {
            currentInputState = survival.input();
            applyInputState(player.input, currentInputState);
            logBrainTiming(nowMs, tickStartNs, brainDiagnostics);
            return;
        }
        ControlDecision decision = resolveControl(client, player, effective, nowMs);
        currentInputState = decision.input();
        applyInputState(player.input, currentInputState);
        logIntentTransition(decision.intent(), brainDiagnostics);
        applyLookControl(player, decision.intent(), nowMs);
        logBrainTiming(nowMs, tickStartNs, brainDiagnostics);
    }

    /** Real HTTP transport for {@link BrainLink}. Runs on the brain-ipc thread, not the client thread. */
    private String sendToBrain(String body) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(brainUri)
            .timeout(Duration.ofMillis(BRAIN_HTTP_TIMEOUT_MS))
            .header("content-type", "text/plain; charset=utf-8")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
        return httpClient.send(request, HttpResponse.BodyHandlers.ofString()).body();
    }

    private void ensureControlledInput(ClientPlayerEntity player) {
        if (!(player.input instanceof McbotControlledInput)) {
            player.input = new McbotControlledInput();
            LOGGER.info("input.install instanceId={} mode=direct_state_control", instanceId);
        }
    }

    private void maybeDriveAutoSingleplayerMenu(MinecraftClient client, long nowMs) {
        if (!autoSingleplayer || nowMs - lastAutoSingleplayerStepMs < 1000L) {
            return;
        }
        Screen screen = client.currentScreen;
        if (screen == null) {
            return;
        }

        if (
            pressButton(screen, "Singleplayer")
                || pressButton(screen, "Play Selected World")
                || pressButton(screen, "Create New World")
        ) {
            lastAutoSingleplayerStepMs = nowMs;
        }
    }

    private boolean pressButton(Screen screen, String label) {
        for (Element child : screen.children()) {
            if (child instanceof ButtonWidget button
                && button.active
                && button.visible
                && label.equals(button.getMessage().getString())) {
                LOGGER.info("auto_singleplayer.press screen={} button={}", screen.getTitle().getString(), label);
                button.onPress();
                return true;
            }
        }
        return false;
    }

    private void maybeRequestRespawn(ClientPlayerEntity player, long nowMs) {
        if (nowMs - lastRespawnRequestMs < 1000L) {
            return;
        }
        lastRespawnRequestMs = nowMs;
        currentInputState = InputState.stop();
        releaseAllInputs(player.input);
        player.requestRespawn();
        LOGGER.warn("player.respawn_request instanceId={} reason=dead_or_zero_health", instanceId);
    }

    private void logIntentTransition(BrainLink.Intent effective, BrainLink.Diagnostics diagnostics) {
        String state = effective.action() + ":" + effective.reason();
        if (!state.equals(lastAppliedAction)) {
            LOGGER.info(
                "intent.apply instanceId={} action={} reason={} commandId={} intentAgeMs={} remainingTtlMs={} inFlight={} lastBrainRoundTripMs={}",
                instanceId,
                effective.action(),
                effective.reason(),
                effective.commandId(),
                diagnostics.currentIntentAgeMs(),
                diagnostics.currentIntentRemainingTtlMs(),
                diagnostics.inFlight(),
                diagnostics.lastRoundTripMs()
            );
            lastAppliedAction = state;
        }
    }

    private void logTtlExpiry(BrainLink.Intent effective, BrainLink.Diagnostics diagnostics) {
        if (!"stop".equals(effective.action()) || !"intent_expired".equals(effective.reason())) {
            lastTtlExpiryKey = "";
            return;
        }
        String key = diagnostics.currentCommandId()
            + ":"
            + diagnostics.currentAction()
            + ":"
            + diagnostics.currentReason()
            + ":"
            + diagnostics.completedRequestCount();
        if (key.equals(lastTtlExpiryKey)) {
            return;
        }
        lastTtlExpiryKey = key;
        LOGGER.warn(
            "brain.ttl_expired instanceId={} staleAction={} staleReason={} commandId={} intentAgeMs={} remainingTtlMs={} inFlight={} requestAgeMs={} lastBrainRoundTripMs={}",
            instanceId,
            diagnostics.currentAction(),
            diagnostics.currentReason(),
            diagnostics.currentCommandId(),
            diagnostics.currentIntentAgeMs(),
            diagnostics.currentIntentRemainingTtlMs(),
            diagnostics.inFlight(),
            diagnostics.currentRequestAgeMs(),
            diagnostics.lastRoundTripMs()
        );
    }

    private void logBrainTiming(long nowMs, long tickStartNs, BrainLink.Diagnostics diagnostics) {
        if (!diagnostics.inFlight() || nowMs - lastBrainTimingLogMs < 1000L) {
            return;
        }
        lastBrainTimingLogMs = nowMs;
        long tickMs = Math.max(0L, (System.nanoTime() - tickStartNs) / 1_000_000L);
        LOGGER.info(
            "brain.tick_timing instanceId={} tickMs={} inFlight={} requestAgeMs={} dispatched={} completed={} currentIntentAgeMs={} remainingTtlMs={} lastBrainRoundTripMs={}",
            instanceId,
            tickMs,
            diagnostics.inFlight(),
            diagnostics.currentRequestAgeMs(),
            diagnostics.dispatchedRequestCount(),
            diagnostics.completedRequestCount(),
            diagnostics.currentIntentAgeMs(),
            diagnostics.currentIntentRemainingTtlMs(),
            diagnostics.lastRoundTripMs()
        );
    }

    private ControlDecision resolveControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        if (isBreakBlock(effective)) {
            return resolveBreakBlockControl(client, player, effective, nowMs);
        }
        if (isGatherLog(effective)) {
            return resolveGatherLogControl(client, player, effective, nowMs);
        }
        if (isGatherTree(effective)) {
            return resolveGatherTreeControl(client, player, effective, nowMs);
        }
        if (isMineStone(effective)) {
            return resolveMineStoneControl(client, player, effective, nowMs);
        }
        if (isDescendStaircase(effective)) {
            return resolveDescendStaircaseControl(client, player, effective, nowMs);
        }
        if (isMineNearbyStone(effective)) {
            return resolveMineNearbyStoneControl(client, player, effective, nowMs);
        }
        if (isMineNearbyIron(effective)) {
            return resolveMineNearbyIronControl(client, player, effective, nowMs);
        }
        if (isReturnStaircase(effective)) {
            return resolveReturnStaircaseControl(client, player, effective, nowMs);
        }
        if (isR2MineStoneReturn(effective)) {
            return resolveR2MineStoneReturnControl(client, player, effective, nowMs);
        }
        if (isCraft2x2(effective)) {
            return resolveCraft2x2Control(client, player, effective, nowMs);
        }
        if (isCraft3x3(effective)) {
            return resolveCraft3x3Control(client, player, effective, nowMs);
        }
        if (isSmelt(effective)) {
            return resolveSmeltCharcoalControl(client, player, effective, nowMs);
        }
        if (isMakeCharcoal(effective)) {
            return resolveMakeCharcoalControl(client, player, effective, nowMs);
        }
        if (isR5IronChain(effective)) {
            return resolveR5IronChainControl(client, player, effective, nowMs);
        }
        if (isPlaceTable(effective)) {
            return resolvePlaceTableControl(client, player, effective, nowMs);
        }
        if (isPlaceFurnace(effective)) {
            return resolvePlaceFurnaceControl(client, player, effective, nowMs);
        }
        if (isRetrieveTable(effective)) {
            return resolveRetrieveTableControl(client, player, effective, nowMs);
        }
        if (isNavigationProbe(effective)) {
            return resolveNavigationProbeControl(client, player, effective);
        }
        if (hasNavigation(effective)) {
            return resolveNavigationControl(client, player, effective);
        }
        activeNavigationCommandId = "";
        activeNavigationWaypointIndex = 0;
        activeNavigationProgress = PathFollower.Progress.initial();
        return new ControlDecision(effective, BrainLink.inputStateFor(effective));
    }

    private boolean isBreakBlock(BrainLink.Intent intent) {
        return intent != null && "break_block".equals(intent.action());
    }

    private boolean isGatherLog(BrainLink.Intent intent) {
        return intent != null && "gather_log".equals(intent.action());
    }

    private boolean isGatherTree(BrainLink.Intent intent) {
        return intent != null && "gather_tree".equals(intent.action());
    }

    private boolean isMineStone(BrainLink.Intent intent) {
        return intent != null && "mine_stone".equals(intent.action());
    }

    private boolean isDescendStaircase(BrainLink.Intent intent) {
        return intent != null && "descend_staircase".equals(intent.action());
    }

    private boolean isMineNearbyStone(BrainLink.Intent intent) {
        return intent != null && "mine_nearby_stone".equals(intent.action());
    }

    private boolean isMineNearbyIron(BrainLink.Intent intent) {
        return intent != null && "mine_nearby_iron".equals(intent.action());
    }

    private boolean isReturnStaircase(BrainLink.Intent intent) {
        return intent != null && "return_staircase".equals(intent.action());
    }

    private boolean isR2MineStoneReturn(BrainLink.Intent intent) {
        return intent != null && "r2_mine_stone_return".equals(intent.action());
    }

    private boolean isCraft2x2(BrainLink.Intent intent) {
        return intent != null && Craft2x2RecipePlanner.isCraftAction(intent.action());
    }

    private boolean isCraft3x3(BrainLink.Intent intent) {
        return intent != null && Craft3x3RecipePlanner.isCraftAction(intent.action());
    }

    private boolean isSmelt(BrainLink.Intent intent) {
        return intent != null && FurnaceSmeltRecipe.fromAction(intent.action()) != null;
    }

    private boolean isMakeCharcoal(BrainLink.Intent intent) {
        return intent != null && "make_charcoal".equals(intent.action());
    }

    private boolean isR5IronChain(BrainLink.Intent intent) {
        return intent != null && "r5_iron_chain".equals(intent.action());
    }

    private boolean isPlaceTable(BrainLink.Intent intent) {
        return intent != null && "place_table".equals(intent.action());
    }

    private boolean isPlaceFurnace(BrainLink.Intent intent) {
        return intent != null && "place_furnace".equals(intent.action());
    }

    private boolean isRetrieveTable(BrainLink.Intent intent) {
        return intent != null && "retrieve_table".equals(intent.action());
    }

    private ControlDecision resolveBreakBlockControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (completedBreakBlockCommandIds.contains(commandId)) {
            return new ControlDecision(stopFrom(effective, "break_block_complete"), InputState.stop());
        }
        BlockPos target = targetBlockPos(effective);
        if (target == null) {
            completedBreakBlockCommandIds.add(commandId);
            return new ControlDecision(stopFrom(effective, "break_block_missing_target"), InputState.stop());
        }
        activeNavigationCommandId = "";
        activeNavigationWaypointIndex = 0;
        activeNavigationProgress = PathFollower.Progress.initial();
        activeNavigationWaypoints = List.of();
        activeNavigationRouteComputed = false;
        activeNavigationJumpWaypointIndexes = Set.of();

        BrainLink.Intent lookIntent = lookIntentForBlock(effective, player, target, "break_block_face");
        if (!isLookingAtBlock(player, target)) {
            return new ControlDecision(lookIntent, InputState.stop());
        }

        BlockBreakController.Result result = blockBreakController.tick(client, player, target, commandId, nowMs);
        logBlockBreakResult(commandId, target, result);
        if (result.status() == BlockBreakController.Status.BROKEN) {
            completedBreakBlockCommandIds.add(commandId);
            LOGGER.info(
                "block_break.done instanceId={} commandId={} target={} reason={} elapsedMs={}",
                instanceId,
                commandId,
                target.toShortString(),
                result.reason(),
                result.elapsedMs()
            );
            return new ControlDecision(stopFrom(effective, "break_block_complete"), InputState.stop());
        }
        if (result.status() == BlockBreakController.Status.REPOSITION) {
            completedBreakBlockCommandIds.add(commandId);
            LOGGER.warn(
                "block_break.reposition_required instanceId={} commandId={} target={} hitBlock={} reason={} elapsedMs={}",
                instanceId,
                commandId,
                target.toShortString(),
                formatBlockPos(result.hitBlock()),
                result.reason(),
                result.elapsedMs()
            );
            return new ControlDecision(stopFrom(effective, "break_block_failed:" + result.reason()), InputState.stop());
        }
        if (result.status() == BlockBreakController.Status.FAILED) {
            completedBreakBlockCommandIds.add(commandId);
            LOGGER.warn(
                "block_break.failed instanceId={} commandId={} target={} reason={} elapsedMs={}",
                instanceId,
                commandId,
                target.toShortString(),
                result.reason(),
                result.elapsedMs()
            );
            return new ControlDecision(stopFrom(effective, "break_block_failed:" + result.reason()), InputState.stop());
        }
        return new ControlDecision(lookIntentForBlock(effective, player, target, "break_blocking:" + result.reason()), InputState.stop());
    }

    private ControlDecision resolveGatherLogControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (completedGatherLogCommandIds.contains(commandId)) {
            return new ControlDecision(stopFrom(effective, "gather_log_complete"), InputState.stop());
        }
        BlockPos target = targetBlockPos(effective);
        if (target == null) {
            completedGatherLogCommandIds.add(commandId);
            return new ControlDecision(stopFrom(effective, "gather_log_missing_target"), InputState.stop());
        }
        if (activeGatherLog == null || !commandId.equals(activeGatherLog.commandId)) {
            InventoryCounter.InventoryLogSnapshot inventory = InventoryCounter.countPlayerLogs(player);
            activeGatherLog = new GatherLogRun(commandId, target, inventory.logCount(), nowMs);
            LOGGER.info(
                "gather_log.start instanceId={} commandId={} target={} inventoryLogsBefore={} logsByItem={}",
                instanceId,
                commandId,
                target.toShortString(),
                inventory.logCount(),
                inventory.logsByItem()
            );
            if (inventory.logCount() != 0) {
                completedGatherLogCommandIds.add(commandId);
                activeGatherLog = null;
                return new ControlDecision(stopFrom(effective, "gather_log_start_logs_not_zero"), InputState.stop());
            }
        }

        InventoryCounter.InventoryLogSnapshot inventory = InventoryCounter.countPlayerLogs(player);
        if (inventory.logCount() > activeGatherLog.baselineLogCount) {
            completedGatherLogCommandIds.add(commandId);
            LOGGER.info(
                "gather_log.complete instanceId={} commandId={} target={} inventoryLogsBefore={} inventoryLogsAfter={} elapsedMs={} logsByItem={}",
                instanceId,
                commandId,
                target.toShortString(),
                activeGatherLog.baselineLogCount,
                inventory.logCount(),
                Math.max(0L, nowMs - activeGatherLog.startedAtMs),
                inventory.logsByItem()
            );
            activeGatherLog = null;
            return new ControlDecision(stopFrom(effective, "gather_log_complete"), InputState.stop());
        }

        if (!activeGatherLog.breakDone) {
            BlockState targetState = client.world.getBlockState(target);
            if (targetState.isAir()) {
                activeGatherLog.breakDone = true;
                activeGatherLog.collectStartedAtMs = nowMs;
            } else if (!targetState.isIn(BlockTags.LOGS)) {
                completedGatherLogCommandIds.add(commandId);
                activeGatherLog = null;
                return new ControlDecision(stopFrom(effective, "gather_log_target_not_log"), InputState.stop());
            }
        }

        if (!activeGatherLog.breakDone) {
            ControlDecision nav = navigateToGatherAdjacentCell(client, player, effective, activeGatherLog);
            if (nav != null) {
                return nav;
            }
            BrainLink.Intent lookIntent = lookIntentForBlock(effective, player, target, "gather_log_face");
            if (!isLookingAtBlock(player, target)) {
                return new ControlDecision(lookIntent, InputState.stop());
            }
            BlockBreakController.Result result = blockBreakController.tick(client, player, target, commandId, nowMs);
            logBlockBreakResult(commandId, target, result);
            if ("occluder_cleared".equals(result.reason())) {
                activeGatherLog.occludersBroken++;
                LOGGER.info(
                    "gather_log.occluder_broken instanceId={} commandId={} target={} occluder={} occludersBroken={}",
                    instanceId,
                    commandId,
                    target.toShortString(),
                    formatBlockPos(result.actedBlock()),
                    activeGatherLog.occludersBroken
                );
            }
            if (result.status() == BlockBreakController.Status.BROKEN) {
                activeGatherLog.breakDone = true;
                activeGatherLog.collectStartedAtMs = nowMs;
                LOGGER.info(
                    "gather_log.break_done instanceId={} commandId={} target={} elapsedMs={}",
                    instanceId,
                    commandId,
                    target.toShortString(),
                    Math.max(0L, nowMs - activeGatherLog.startedAtMs)
                );
            } else if (result.status() == BlockBreakController.Status.REPOSITION) {
                if (activeGatherLog.adjacentCell != null) {
                    activeGatherLog.excludedAdjacentCells.add(activeGatherLog.adjacentCell);
                }
                activeGatherLog.occlusionRepositions++;
                clearNavigationState();
                activeGatherLog.adjacentCell = null;
                LOGGER.warn(
                    "gather_log.occlusion_reposition instanceId={} commandId={} target={} hitBlock={} repositions={} reason={}",
                    instanceId,
                    commandId,
                    target.toShortString(),
                    formatBlockPos(result.hitBlock()),
                    activeGatherLog.occlusionRepositions,
                    result.reason()
                );
                return new ControlDecision(stopFrom(effective, "gather_log_occlusion_reposition"), InputState.stop());
            } else if (result.status() == BlockBreakController.Status.FAILED) {
                if (result.reason().startsWith("raycast_")) {
                    activeGatherLog.occlusionAbandons++;
                }
                completedGatherLogCommandIds.add(commandId);
                activeGatherLog = null;
                return new ControlDecision(stopFrom(effective, "gather_log_break_failed:" + result.reason()), InputState.stop());
            } else {
                return new ControlDecision(lookIntentForBlock(effective, player, target, "gather_log_breaking:" + result.reason()), InputState.stop());
            }
        }

        if (activeGatherLog.collectStartedAtMs > 0L && nowMs - activeGatherLog.collectStartedAtMs > GATHER_COLLECT_TIMEOUT_MS) {
            completedGatherLogCommandIds.add(commandId);
            LOGGER.warn(
                "gather_log.collect_timeout instanceId={} commandId={} target={} inventoryLogsBefore={} inventoryLogsAfter={}",
                instanceId,
                commandId,
                target.toShortString(),
                activeGatherLog.baselineLogCount,
                inventory.logCount()
            );
            activeGatherLog = null;
            return new ControlDecision(stopFrom(effective, "gather_log_collect_timeout"), InputState.stop());
        }

        if (activeGatherLog.collectStartedAtMs > 0L && nowMs - activeGatherLog.collectStartedAtMs < GATHER_PICKUP_SETTLE_MS) {
            return new ControlDecision(stopFrom(effective, "gather_log_wait_pickup"), InputState.stop());
        }

        Vec3d droppedLogPosition = nearestDroppedLogItemPosition(client, player, target);
        BrainLink.Intent collectIntent;
        if (droppedLogPosition != null) {
            String logKey = commandId + ":" + roundForLog(droppedLogPosition.x) + ":" + roundForLog(droppedLogPosition.y)
                + ":" + roundForLog(droppedLogPosition.z);
            if (!logKey.equals(lastGatherCollectItemLogKey)) {
                lastGatherCollectItemLogKey = logKey;
                LOGGER.info(
                    "gather_log.collect_item_target instanceId={} commandId={} target={} itemX={} itemY={} itemZ={}",
                    instanceId,
                    commandId,
                    target.toShortString(),
                    roundForLog(droppedLogPosition.x),
                    roundForLog(droppedLogPosition.y),
                    roundForLog(droppedLogPosition.z)
                );
            }
            collectIntent = gatherCollectIntent(
                effective,
                droppedLogPosition.x,
                droppedLogPosition.y,
                droppedLogPosition.z,
                "gather_log_collect_item",
                ":collect:item"
            );
        } else {
            collectIntent = gatherCollectIntent(effective, target, activeGatherLog.adjacentCell);
        }
        return resolveNavigationControl(client, player, collectIntent);
    }

    private ControlDecision resolveMineStoneControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (completedMineStoneCommandIds.contains(commandId)) {
            return new ControlDecision(stopFrom(effective, "mine_stone_complete"), InputState.stop());
        }
        BlockPos target = targetBlockPos(effective);
        if (target == null) {
            completedMineStoneCommandIds.add(commandId);
            return new ControlDecision(stopFrom(effective, "mine_stone_missing_target"), InputState.stop());
        }
        if (activeMineStone == null || !commandId.equals(activeMineStone.commandId)) {
            InventoryCounter.InventoryCobblestoneSnapshot inventory = InventoryCounter.countPlayerCobblestone(player);
            activeMineStone = new MineStoneRun(commandId, target, inventory.cobblestoneCount(), nowMs);
            LOGGER.info(
                "mine_stone.start instanceId={} commandId={} target={} inventoryCobblestoneBefore={} cobblestoneByItem={}",
                instanceId,
                commandId,
                target.toShortString(),
                inventory.cobblestoneCount(),
                inventory.cobblestoneByItem()
            );
        }

        MineStoneRun run = activeMineStone;
        InventoryCounter.InventoryCobblestoneSnapshot inventory = InventoryCounter.countPlayerCobblestone(player);
        if (inventory.cobblestoneCount() > run.baselineCobblestone) {
            completedMineStoneCommandIds.add(commandId);
            LOGGER.info(
                "mine_stone.complete instanceId={} commandId={} target={} inventoryCobblestoneBefore={} inventoryCobblestoneAfter={} elapsedMs={} cobblestoneByItem={}",
                instanceId,
                commandId,
                target.toShortString(),
                run.baselineCobblestone,
                inventory.cobblestoneCount(),
                Math.max(0L, nowMs - run.startedAtMs),
                inventory.cobblestoneByItem()
            );
            activeMineStone = null;
            return new ControlDecision(stopFrom(effective, "mine_stone_complete"), InputState.stop());
        }

        if (nowMs - run.startedAtMs > CRAFT_TOTAL_TIMEOUT_MS + GATHER_COLLECT_TIMEOUT_MS) {
            return failMineStone(effective, run, inventory, nowMs, "mine_stone_timeout");
        }

        if (!run.breakDone) {
            BlockState targetState = client.world.getBlockState(target);
            if (targetState.isAir()) {
                run.breakDone = true;
                run.collectStartedAtMs = nowMs;
            } else if (!targetState.isOf(Blocks.STONE)) {
                return failMineStone(effective, run, inventory, nowMs, "mine_stone_target_not_stone");
            }
        }

        if (!run.breakDone) {
            int pickaxeSlot = findHotbarSlot(player, InventoryCounter::isWoodenPickaxeItemId);
            if (pickaxeSlot < 0) {
                return failMineStone(effective, run, inventory, nowMs, "mine_stone_no_wooden_pickaxe_hotbar");
            }
            if (player.getInventory().selectedSlot != pickaxeSlot) {
                player.getInventory().selectedSlot = pickaxeSlot;
                LOGGER.info(
                    "mine_stone.tool_selected instanceId={} commandId={} hotbarSlot={}",
                    instanceId,
                    commandId,
                    pickaxeSlot
                );
                return new ControlDecision(stopFrom(effective, "mine_stone_select_tool"), InputState.stop());
            }
            BrainLink.Intent lookIntent = lookIntentForBlock(effective, player, target, "mine_stone_face");
            if (!isLookingAtBlock(player, target)) {
                return new ControlDecision(lookIntent, InputState.stop());
            }
            BlockBreakController.Result result = blockBreakController.tick(client, player, target, commandId, nowMs);
            logBlockBreakResult(commandId, target, result);
            LOGGER.info(
                "mine_stone.break_progress instanceId={} commandId={} target={} status={} reason={} elapsedMs={}",
                instanceId,
                commandId,
                target.toShortString(),
                result.status(),
                result.reason(),
                result.elapsedMs()
            );
            if (result.status() == BlockBreakController.Status.BROKEN) {
                run.breakDone = true;
                run.collectStartedAtMs = nowMs;
                return new ControlDecision(stopFrom(effective, "mine_stone_break_done"), InputState.stop());
            }
            if (result.status() == BlockBreakController.Status.REPOSITION) {
                return failMineStone(effective, run, inventory, nowMs, "mine_stone_break_reposition:" + result.reason());
            }
            if (result.status() == BlockBreakController.Status.FAILED) {
                return failMineStone(effective, run, inventory, nowMs, "mine_stone_break_failed:" + result.reason());
            }
            return new ControlDecision(lookIntentForBlock(effective, player, target, "mine_stone_breaking:" + result.reason()), InputState.stop());
        }

        if (run.collectStartedAtMs <= 0L) {
            run.collectStartedAtMs = nowMs;
        }
        if (nowMs - run.collectStartedAtMs < GATHER_PICKUP_SETTLE_MS) {
            return new ControlDecision(stopFrom(effective, "mine_stone_wait_pickup"), InputState.stop());
        }
        Vec3d droppedCobblestone = nearestDroppedItemPosition(
            client,
            player,
            target,
            (stack, itemId) -> InventoryCounter.isCobblestoneItemId(itemId)
        );
        if (droppedCobblestone != null) {
            LOGGER.info(
                "mine_stone.collect_item_target instanceId={} commandId={} target={} itemX={} itemY={} itemZ={}",
                instanceId,
                commandId,
                target.toShortString(),
                roundForLog(droppedCobblestone.x),
                roundForLog(droppedCobblestone.y),
                roundForLog(droppedCobblestone.z)
            );
            BrainLink.Intent collectIntent = gatherCollectIntent(
                effective,
                droppedCobblestone.x,
                droppedCobblestone.y,
                droppedCobblestone.z,
                "mine_stone_collect_item",
                ":mine:collect"
            );
            return resolveNavigationControl(client, player, collectIntent);
        }
        if (nowMs - run.collectStartedAtMs > GATHER_COLLECT_TIMEOUT_MS) {
            return failMineStone(effective, run, inventory, nowMs, "mine_stone_collect_timeout");
        }
        BrainLink.Intent collectIntent = gatherCollectIntent(effective, target.getX() + 0.5D, target.getZ() + 0.5D, "mine_stone_collect_drop", ":mine:collect");
        return resolveNavigationControl(client, player, collectIntent);
    }

    private ControlDecision failMineStone(
        BrainLink.Intent effective,
        MineStoneRun run,
        InventoryCounter.InventoryCobblestoneSnapshot inventory,
        long nowMs,
        String reason
    ) {
        completedMineStoneCommandIds.add(run.commandId);
        LOGGER.warn(
            "mine_stone.failed instanceId={} commandId={} reason={} target={} breakDone={} inventoryCobblestoneBefore={} inventoryCobblestoneAfter={} cobblestoneByItem={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            formatBlockPos(run.target),
            run.breakDone,
            run.baselineCobblestone,
            inventory.cobblestoneCount(),
            inventory.cobblestoneByItem(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeMineStone = null;
        return new ControlDecision(stopFrom(effective, "mine_stone_failed:" + reason), InputState.stop());
    }

    private DescentControlPlanner.State descentControlState(DescentRun run) {
        return new DescentControlPlanner.State(run.stepIndex, run.depthReached, run.stage);
    }

    private void applyDescentControlDecision(DescentRun run, DescentControlPlanner.Decision decision) {
        run.stepIndex = decision.state().stepIndex();
        run.depthReached = decision.state().depthReached();
        run.stage = decision.state().stage();
    }

    private ControlDecision resolveDescendStaircaseControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        String finishedReason = finishedDescentCommandReasons.get(commandId);
        if (finishedReason != null) {
            return new ControlDecision(stopFrom(effective, finishedReason), InputState.stop());
        }
        clearNavigationState();

        if (activeDescent == null || !commandId.equals(activeDescent.commandId)) {
            BlockPos startFeet = player.getBlockPos().toImmutable();
            int requestedDepth = resolveDescentDepth(effective, startFeet.getY());
            StaircaseDescentPlanner.Direction2d direction = resolveDescentDirection(effective, startFeet, player.getYaw());
            activeDescent = new DescentRun(commandId, startFeet, direction, requestedDepth, nowMs, player.getHealth());
            LOGGER.info(
                "descent.start instanceId={} commandId={} start={} direction={} depth={} healthBefore={} targetY={}",
                instanceId,
                commandId,
                startFeet.toShortString(),
                direction.name(),
                requestedDepth,
                player.getHealth(),
                startFeet.getY() - requestedDepth
            );
        }

        DescentRun run = activeDescent;
        long elapsedMs = Math.max(0L, nowMs - run.startedAtMs);
        String currentHazardReason = currentPlayerDescentHazardReason(client, player);
        boolean onGround = player.isOnGround();
        DescentControlPlanner.Decision preflightDecision = DescentControlPlanner.decidePreflight(
            descentControlState(run),
            new DescentControlPlanner.PreflightObservation(
                elapsedMs,
                DESCENT_BASE_TIMEOUT_MS + (long) run.depth * DESCENT_STEP_TIMEOUT_MS,
                run.healthBefore,
                player.getHealth(),
                currentHazardReason,
                onGround,
                onGround ? nearestHostileDistance(client, player) : -1.0D,
                DESCENT_HOSTILE_ABORT_RADIUS
            )
        );
        if (preflightDecision.action() == DescentControlPlanner.Action.FAIL_TIMEOUT
            || preflightDecision.action() == DescentControlPlanner.Action.FAIL_HEALTH_LOST
            || preflightDecision.action() == DescentControlPlanner.Action.FAIL_PLAYER_HAZARD
            || preflightDecision.action() == DescentControlPlanner.Action.FAIL_HOSTILE_NEARBY) {
            return failDescent(effective, run, nowMs, preflightDecision.reason());
        }
        if (preflightDecision.action() == DescentControlPlanner.Action.WAIT_ON_GROUND) {
            return new ControlDecision(stopFrom(effective, preflightDecision.reason()), InputState.stop());
        }
        ControlDecision ironCleanupDecision = maybeResolveDescentIronCleanup(client, player, effective, run, nowMs);
        if (ironCleanupDecision != null) {
            DescentControlPlanner.Decision stepDecision = DescentControlPlanner.decideStep(
                descentControlState(run),
                new DescentControlPlanner.StepObservation(true, false, false, false, false, null, false, false, false)
            );
            if (stepDecision.action() == DescentControlPlanner.Action.RUN_IRON_CLEANUP) {
                return ironCleanupDecision;
            }
        }

        boolean complete = descentComplete(client, player, run);
        StaircaseDescentPlanner.Step step = complete ? null : StaircaseDescentPlanner.stepFrom(run.currentFeet, run.direction, run.stepIndex);
        boolean reachedStep = step != null && reachedDescentStep(player, step.nextFeet());
        String unsafeReason = step == null || reachedStep ? null : descentStepUnsafeReason(client, step);
        DescentControlPlanner.Decision stepDecision = DescentControlPlanner.decideStep(
            descentControlState(run),
            new DescentControlPlanner.StepObservation(
                false,
                complete,
                step != null && StaircaseDescentPlanner.targetsSelfSupport(step),
                step != null && player.getY() < step.nextFeet().getY() - 0.25D,
                reachedStep,
                unsafeReason,
                step != null && unsafeReason == null && client.world.getBlockState(step.sightClear()).isAir(),
                step != null && unsafeReason == null && client.world.getBlockState(step.upperClear()).isAir(),
                step != null && unsafeReason == null && client.world.getBlockState(step.lowerClear()).isAir()
            )
        );
        if (stepDecision.action() == DescentControlPlanner.Action.COMPLETE) {
            return completeDescent(effective, run, player, nowMs, stepDecision.reason());
        }
        if (stepDecision.action() == DescentControlPlanner.Action.FAIL_SELF_SUPPORT
            || stepDecision.action() == DescentControlPlanner.Action.FAIL_OVERSHOT_STEP) {
            return failDescent(effective, run, nowMs, stepDecision.reason());
        }
        if (stepDecision.action() == DescentControlPlanner.Action.STEP_REACHED) {
            LOGGER.info(
                "descent.step_reached instanceId={} commandId={} step={} position={} health={}",
                instanceId,
                run.commandId,
                run.stepIndex,
                player.getBlockPos().toShortString(),
                player.getHealth()
            );
            BlockPos reached = step.nextFeet().toImmutable();
            run.currentFeet = reached;
            run.reachedFeet.add(reached);
            applyDescentControlDecision(run, stepDecision);
            return new ControlDecision(stopFrom(effective, "descent_step_reached"), InputState.stop());
        }
        if (stepDecision.action() == DescentControlPlanner.Action.REROUTE_OR_FAIL) {
            return rerouteOrFailDescent(effective, client, run, step, nowMs, stepDecision.reason());
        }

        applyDescentControlDecision(run, stepDecision);
        if (stepDecision.action() == DescentControlPlanner.Action.BREAK_SIGHT) {
            return breakDescentBlock(client, player, effective, run, step, step.sightClear(), "sight", nowMs);
        }
        if (stepDecision.action() == DescentControlPlanner.Action.BREAK_UPPER) {
            return breakDescentBlock(client, player, effective, run, step, step.upperClear(), "upper", nowMs);
        }
        if (stepDecision.action() == DescentControlPlanner.Action.BREAK_LOWER) {
            return breakDescentBlock(client, player, effective, run, step, step.lowerClear(), "lower", nowMs);
        }
        return moveToDescentStep(player, effective, run, step);
    }

    private ControlDecision maybeResolveDescentIronCleanup(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        long nowMs
    ) {
        if (run.ironCleanupCollectStartedAtMs > 0L) {
            if (nowMs - run.ironCleanupCollectStartedAtMs < GATHER_PICKUP_SETTLE_MS) {
                return new ControlDecision(stopFrom(effective, "descent_iron_cleanup_wait_pickup"), InputState.stop());
            }
            Vec3d droppedRawIron = nearestDroppedItemPosition(
                client,
                player,
                run.lastIronCleanupTarget == null ? player.getBlockPos() : run.lastIronCleanupTarget,
                (stack, itemId) -> "raw_iron".equalsIgnoreCase(itemId)
            );
            if (droppedRawIron != null && nowMs - run.ironCleanupCollectStartedAtMs < DESCENT_IRON_CLEANUP_COLLECT_TIMEOUT_MS) {
                LOGGER.info(
                    "descent.iron_cleanup_collect_target instanceId={} commandId={} itemX={} itemY={} itemZ={}",
                    instanceId,
                    run.commandId,
                    roundForLog(droppedRawIron.x),
                    roundForLog(droppedRawIron.y),
                    roundForLog(droppedRawIron.z)
                );
                BrainLink.Intent collectIntent = gatherCollectIntent(
                    effective,
                    droppedRawIron.x,
                    droppedRawIron.y,
                    droppedRawIron.z,
                    "descent_iron_cleanup_collect_item",
                    ":descent:iron:collect"
                );
                return resolveNavigationControl(client, player, collectIntent);
            }
            run.ironCleanupCollectStartedAtMs = 0L;
            run.lastIronCleanupTarget = null;
            return new ControlDecision(stopFrom(effective, "descent_iron_cleanup_collect_done"), InputState.stop());
        }

        if (run.ironCleanupTarget == null && run.ironCleanupBlocksBroken < DESCENT_MAX_IRON_CLEANUP_BLOCKS) {
            run.ironCleanupTarget = selectVisibleDescentIronCleanupTarget(client, player, run);
            if (run.ironCleanupTarget != null) {
                LOGGER.info(
                    "descent.iron_cleanup_target instanceId={} commandId={} target={} blocksBroken={} depthReached={} block={}",
                    instanceId,
                    run.commandId,
                    run.ironCleanupTarget.toShortString(),
                    run.ironCleanupBlocksBroken,
                    run.depthReached,
                    blockId(client.world.getBlockState(run.ironCleanupTarget))
                );
            }
        }
        if (run.ironCleanupTarget == null) {
            return null;
        }

        BlockPos target = run.ironCleanupTarget;
        BlockState targetState = client.world.getBlockState(target);
        if (!isIronOreBlock(targetState)) {
            run.ironCleanupTarget = null;
            return new ControlDecision(stopFrom(effective, "descent_iron_cleanup_target_cleared"), InputState.stop());
        }
        if (!isLookingAtBlock(player, target)) {
            return new ControlDecision(lookIntentForBlock(effective, player, target, "descent_iron_cleanup_face"), InputState.stop());
        }
        BlockBreakController.Result result = blockBreakController.tick(client, player, target, run.commandId + ":descent:iron_cleanup", nowMs);
        logBlockBreakResult(run.commandId + ":descent:iron_cleanup", target, result);
        LOGGER.info(
            "descent.iron_cleanup_progress instanceId={} commandId={} target={} status={} reason={} hitBlock={} actedBlock={} selectedItem={} elapsedMs={}",
            instanceId,
            run.commandId,
            target.toShortString(),
            result.status(),
            result.reason(),
            formatBlockPos(result.hitBlock()),
            formatBlockPos(result.actedBlock()),
            selectedItemId(player),
            result.elapsedMs()
        );
        if (result.status() == BlockBreakController.Status.BROKEN) {
            run.ironCleanupBlocksBroken++;
            run.lastIronCleanupTarget = target;
            run.ironCleanupTarget = null;
            run.ironCleanupCollectStartedAtMs = nowMs;
            return new ControlDecision(stopFrom(effective, "descent_iron_cleanup_break_done"), InputState.stop());
        }
        if (result.status() == BlockBreakController.Status.REPOSITION || result.status() == BlockBreakController.Status.FAILED) {
            run.abandonedIronCleanupTargets.add(target);
            run.ironCleanupTarget = null;
            return new ControlDecision(stopFrom(effective, "descent_iron_cleanup_reselect:" + result.reason()), InputState.stop());
        }
        return new ControlDecision(lookIntentForBlock(effective, player, target, "descent_iron_cleanup_breaking:" + result.reason()), InputState.stop());
    }

    private BlockPos selectVisibleDescentIronCleanupTarget(MinecraftClient client, ClientPlayerEntity player, DescentRun run) {
        Set<BlockPos> excluded = new HashSet<>(run.abandonedIronCleanupTargets);
        while (excluded.size() < run.abandonedIronCleanupTargets.size() + 32) {
            BlockPos candidate = selectVisibleIronTarget(client, player, excluded);
            if (candidate == null) {
                return null;
            }
            if (isSafeDescentIronCleanupTarget(client, player, run, candidate)) {
                return candidate;
            }
            excluded.add(candidate);
        }
        return null;
    }

    private boolean isSafeDescentIronCleanupTarget(MinecraftClient client, ClientPlayerEntity player, DescentRun run, BlockPos candidate) {
        if (client == null || client.world == null || player == null || run == null || candidate == null) {
            return false;
        }
        BlockPos feet = player.getBlockPos();
        if (candidate.getY() < feet.getY()) {
            return false;
        }
        if (candidate.equals(feet) || candidate.equals(feet.up()) || candidate.equals(feet.down())) {
            return false;
        }
        if (candidate.equals(run.currentFeet.down())) {
            return false;
        }
        StaircaseDescentPlanner.Step step = StaircaseDescentPlanner.stepFrom(run.currentFeet, run.direction, run.stepIndex);
        if (candidate.equals(step.support())) {
            return false;
        }
        return firstAdjacentLavaBlock(client, candidate) == null;
    }

    private ControlDecision breakDescentBlock(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        BlockPos target,
        String phase,
        long nowMs
    ) {
        BlockState targetState = client.world.getBlockState(target);

        if (!isLookingAtBlock(player, target)) {
            return new ControlDecision(lookIntentForBlock(effective, player, target, "descent_face_" + phase), InputState.stop());
        }
        BlockBreakController.Result result = blockBreakController.tick(client, player, target, run.commandId + ":step:" + step.index() + ":" + phase, nowMs);
        logBlockBreakResult(run.commandId + ":descent:" + step.index() + ":" + phase, target, result);
        LOGGER.info(
            "descent.break_progress instanceId={} commandId={} step={} phase={} target={} targetBlock={} selectedItem={} status={} reason={} hitBlock={} actedBlock={} elapsedMs={}",
            instanceId,
            run.commandId,
            step.index(),
            phase,
            target.toShortString(),
            blockId(targetState),
            selectedItemId(player),
            result.status(),
            result.reason(),
            formatBlockPos(result.hitBlock()),
            formatBlockPos(result.actedBlock()),
            result.elapsedMs()
        );
        if (result.status() == BlockBreakController.Status.BROKEN) {
            run.stage = switch (phase) {
                case "sight" -> DescentControlPlanner.Stage.BREAK_UPPER;
                case "upper" -> DescentControlPlanner.Stage.BREAK_LOWER;
                default -> DescentControlPlanner.Stage.MOVE_TO_STEP;
            };
            return new ControlDecision(stopFrom(effective, "descent_break_done:" + phase), InputState.stop());
        }
        if (result.status() == BlockBreakController.Status.REPOSITION) {
            String hazardReason = descentBreakHazardReason(client, player, target, result.reason());
            if (hazardReason != null) {
                return failDescent(effective, run, nowMs, hazardReason);
            }
            return failDescent(effective, run, nowMs, "descent_break_reposition:" + result.reason());
        }
        if (result.status() == BlockBreakController.Status.FAILED) {
            return failDescent(effective, run, nowMs, "descent_break_failed:" + result.reason());
        }
        return new ControlDecision(lookIntentForBlock(effective, player, target, "descent_breaking_" + phase + ":" + result.reason()), InputState.stop());
    }

    private ControlDecision moveToDescentStep(ClientPlayerEntity player, BrainLink.Intent effective, DescentRun run, StaircaseDescentPlanner.Step step) {
        double targetX = step.nextFeet().getX() + 0.5D;
        double targetZ = step.nextFeet().getZ() + 0.5D;
        double dx = targetX - player.getX();
        double dz = targetZ - player.getZ();
        double distance = Math.hypot(dx, dz);
        if (distance <= DESCENT_STEP_ARRIVE_EPSILON && Math.floor(player.getY()) <= step.nextFeet().getY()) {
            run.stepIndex++;
            run.stage = DescentControlPlanner.Stage.BREAK_SIGHT;
            return new ControlDecision(stopFrom(effective, "descent_step_arrived"), InputState.stop());
        }
        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        BrainLink.Intent intent = lookIntentForAngles(effective, yaw, 8.0D, "descent_move_step:" + step.index());
        InputState input = new InputState(true, false, false, false, false, false, 1.0F, 0.0F);
        return new ControlDecision(intent, input);
    }

    private int resolveDescentDepth(BrainLink.Intent effective, int startY) {
        int requestedDepth = 6;
        if (effective.targetY() != null) {
            requestedDepth = startY - (int) Math.floor(effective.targetY());
        }
        return StaircaseDescentPlanner.boundedDepth(requestedDepth, DESCENT_MAX_DEPTH);
    }

    private StaircaseDescentPlanner.Direction2d resolveDescentDirection(BrainLink.Intent effective, BlockPos startFeet, float yaw) {
        StaircaseDescentPlanner.Direction2d fallback = directionFromYaw(yaw);
        if (effective.targetX() == null || effective.targetZ() == null) {
            return fallback;
        }
        return StaircaseDescentPlanner.cardinalFromDelta(
            effective.targetX() - startFeet.getX(),
            effective.targetZ() - startFeet.getZ(),
            fallback
        );
    }

    private StaircaseDescentPlanner.Direction2d directionFromYaw(float yaw) {
        int[] offset = cardinalOffset(yaw);
        if (offset[0] > 0) return StaircaseDescentPlanner.east();
        if (offset[0] < 0) return StaircaseDescentPlanner.west();
        if (offset[1] > 0) return StaircaseDescentPlanner.south();
        return StaircaseDescentPlanner.north();
    }

    private boolean descentComplete(MinecraftClient client, ClientPlayerEntity player, DescentRun run) {
        return run.depthReached >= run.depth
            && player.isOnGround()
            && isStableDescentSupport(client, player.getBlockPos().down());
    }

    private boolean reachedDescentStep(ClientPlayerEntity player, BlockPos nextFeet) {
        return Math.floor(player.getY()) <= nextFeet.getY()
            && Math.hypot((nextFeet.getX() + 0.5D) - player.getX(), (nextFeet.getZ() + 0.5D) - player.getZ()) <= DESCENT_STEP_ARRIVE_EPSILON;
    }

    private boolean isStableDescentSupport(MinecraftClient client, BlockPos support) {
        if (client == null || client.world == null || support == null) {
            return false;
        }
        BlockState state = client.world.getBlockState(support);
        return !isHazardBlockState(state) && !state.getCollisionShape(client.world, support).isEmpty();
    }

    private String descentStepUnsafeReason(MinecraftClient client, StaircaseDescentPlanner.Step step) {
        if (client == null || client.world == null || step == null) {
            return "descent_missing_client_state";
        }
        if (!isStableDescentSupport(client, step.support())) {
            return "descent_next_support_missing:" + step.support().toShortString();
        }
        HazardBlock hazard = firstHazardBlockDetail(client, step);
        if (hazard != null) {
            return "descent_hazard_in_step:" + hazard.kind() + ":" + hazard.pos().toShortString();
        }
        BlockPos waterAdjacent = firstAdjacentWaterBlock(client, step);
        if (waterAdjacent != null) {
            return "descent_water_adjacent:" + waterAdjacent.toShortString();
        }
        BlockPos lavaAdjacent = firstAdjacentLavaBlock(client, step);
        if (lavaAdjacent != null) {
            return "descent_lava_adjacent:" + lavaAdjacent.toShortString();
        }
        return null;
    }

    private String currentPlayerDescentHazardReason(MinecraftClient client, ClientPlayerEntity player) {
        if (client == null || client.world == null || player == null) {
            return null;
        }
        BlockPos feet = player.getBlockPos().toImmutable();
        HazardBlock hazard = firstHazardBlockDetail(client, List.of(feet, feet.up()));
        if (hazard != null) {
            return "descent_player_in_hazard:" + hazard.kind() + ":" + hazard.pos().toShortString();
        }
        if (player.isTouchingWater()) {
            return "descent_player_in_hazard:water:" + feet.toShortString();
        }
        return null;
    }

    private String descentBreakHazardReason(MinecraftClient client, ClientPlayerEntity player, BlockPos target, String breakReason) {
        if (client == null || client.world == null || player == null || target == null) {
            return null;
        }
        String currentHazardReason = currentPlayerDescentHazardReason(client, player);
        if (currentHazardReason != null) {
            return currentHazardReason + ":during_break:" + breakReason;
        }
        HazardBlock hazard = firstHazardBlockDetail(client, List.of(target));
        if (hazard != null) {
            return "descent_break_reposition_hazard:" + hazard.kind() + ":" + hazard.pos().toShortString() + ":" + breakReason;
        }
        return null;
    }

    private BlockPos firstHazardBlock(MinecraftClient client, StaircaseDescentPlanner.Step step) {
        HazardBlock hazard = firstHazardBlockDetail(client, step);
        return hazard == null ? null : hazard.pos();
    }

    private BlockPos firstHazardBlock(MinecraftClient client, List<BlockPos> positions) {
        HazardBlock hazard = firstHazardBlockDetail(client, positions);
        return hazard == null ? null : hazard.pos();
    }

    private HazardBlock firstHazardBlockDetail(MinecraftClient client, StaircaseDescentPlanner.Step step) {
        if (step == null) {
            return null;
        }
        return firstHazardBlockDetail(client, List.of(step.sightClear(), step.upperClear(), step.lowerClear(), step.support()));
    }

    private HazardBlock firstHazardBlockDetail(MinecraftClient client, List<BlockPos> positions) {
        if (client == null || client.world == null || positions == null) {
            return null;
        }
        for (BlockPos pos : positions) {
            if (pos != null) {
                BlockState state = client.world.getBlockState(pos);
                if (isHazardBlockState(state)) {
                    return new HazardBlock(pos.toImmutable(), hazardKind(state));
                }
            }
        }
        return null;
    }

    private BlockPos firstAdjacentLavaBlock(MinecraftClient client, StaircaseDescentPlanner.Step step) {
        for (BlockPos origin : List.of(step.sightClear(), step.upperClear(), step.lowerClear(), step.support())) {
            for (Direction direction : Direction.values()) {
                BlockPos adjacent = origin.offset(direction);
                if (isLavaBlockState(client.world.getBlockState(adjacent))) {
                    return adjacent.toImmutable();
                }
            }
        }
        return null;
    }

    private BlockPos firstAdjacentWaterBlock(MinecraftClient client, StaircaseDescentPlanner.Step step) {
        if (client == null || client.world == null || step == null) {
            return null;
        }
        for (BlockPos origin : List.of(step.sightClear(), step.upperClear(), step.lowerClear(), step.support())) {
            for (Direction direction : Direction.values()) {
                BlockPos adjacent = origin.offset(direction);
                if (isWaterBlockState(client.world.getBlockState(adjacent))) {
                    return adjacent.toImmutable();
                }
            }
        }
        return null;
    }

    private ControlDecision rerouteOrFailDescent(
        BrainLink.Intent effective,
        MinecraftClient client,
        DescentRun run,
        StaircaseDescentPlanner.Step rejectedStep,
        long nowMs,
        String reason
    ) {
        run.rejectedMoves.add(descentMoveKey(run.currentFeet, run.direction));
        if (run.reroutes >= Math.max(DESCENT_MAX_REROUTES, run.depth)) {
            return failDescent(effective, run, nowMs, reason + ":reroute_limit");
        }
        StaircaseDescentPlanner.Direction2d reroute = StaircaseDescentPlanner.chooseReroute(
            run.direction,
            direction -> isDescentRerouteCandidateSafe(client, run, direction)
        );
        if (reroute == null) {
            return failDescent(effective, run, nowMs, reason + ":no_safe_reroute");
        }
        StaircaseDescentPlanner.Direction2d previous = run.direction;
        run.direction = reroute;
        run.reroutes++;
        if (reason.startsWith("descent_next_support_missing")) {
            run.openAirReroutes++;
        } else if (reason.startsWith("descent_hazard") || reason.startsWith("descent_lava") || reason.startsWith("descent_water")) {
            run.hazardReroutes++;
        }
        run.stage = DescentControlPlanner.Stage.BREAK_SIGHT;
        LOGGER.info(
            "descent.reroute instanceId={} commandId={} step={} depthReached={} currentFeet={} previousDirection={} newDirection={} rejectedNextFeet={} rejectedSupport={} reason={} reroutes={} openAirReroutes={} hazardReroutes={}",
            instanceId,
            run.commandId,
            run.stepIndex,
            run.depthReached,
            run.currentFeet.toShortString(),
            previous.name(),
            reroute.name(),
            rejectedStep.nextFeet().toShortString(),
            rejectedStep.support().toShortString(),
            reason,
            run.reroutes,
            run.openAirReroutes,
            run.hazardReroutes
        );
        return new ControlDecision(stopFrom(effective, "descent_reroute:" + reason + ":" + reroute.name()), InputState.stop());
    }

    private boolean isDescentRerouteCandidateSafe(MinecraftClient client, DescentRun run, StaircaseDescentPlanner.Direction2d direction) {
        if (run.rejectedMoves.contains(descentMoveKey(run.currentFeet, direction))) {
            return false;
        }
        StaircaseDescentPlanner.Step candidate = StaircaseDescentPlanner.stepFrom(run.currentFeet, direction, run.stepIndex);
        return !StaircaseDescentPlanner.targetsSelfSupport(candidate) && descentStepUnsafeReason(client, candidate) == null;
    }

    private String descentMoveKey(BlockPos feet, StaircaseDescentPlanner.Direction2d direction) {
        return feet.toShortString() + ":" + direction.name();
    }

    private boolean isHazardBlockState(BlockState state) {
        return state != null
            && (state.isOf(Blocks.WATER)
                || state.isOf(Blocks.LAVA)
                || state.isOf(Blocks.FIRE)
                || state.isOf(Blocks.SOUL_FIRE)
                || state.isOf(Blocks.CACTUS)
                || state.isOf(Blocks.MAGMA_BLOCK)
                || state.isOf(Blocks.CAMPFIRE)
                || state.isOf(Blocks.SOUL_CAMPFIRE)
                || state.getFluidState().isIn(FluidTags.WATER)
                || state.getFluidState().isIn(FluidTags.LAVA));
    }

    private String hazardKind(BlockState state) {
        if (state == null) {
            return "unknown";
        }
        if (state.isOf(Blocks.WATER) || state.getFluidState().isIn(FluidTags.WATER)) {
            return "water";
        }
        if (state.isOf(Blocks.LAVA) || state.getFluidState().isIn(FluidTags.LAVA)) {
            return "lava";
        }
        if (state.isOf(Blocks.FIRE) || state.isOf(Blocks.SOUL_FIRE)) {
            return "fire";
        }
        if (state.isOf(Blocks.CACTUS)) {
            return "cactus";
        }
        if (state.isOf(Blocks.MAGMA_BLOCK)) {
            return "magma";
        }
        if (state.isOf(Blocks.CAMPFIRE) || state.isOf(Blocks.SOUL_CAMPFIRE)) {
            return "campfire";
        }
        return blockId(state);
    }

    private boolean isLavaBlockState(BlockState state) {
        return state != null && (state.isOf(Blocks.LAVA) || state.getFluidState().isIn(FluidTags.LAVA));
    }

    private boolean isWaterBlockState(BlockState state) {
        return state != null && (state.isOf(Blocks.WATER) || state.getFluidState().isIn(FluidTags.WATER));
    }

    private double nearestHostileDistance(MinecraftClient client, ClientPlayerEntity player) {
        if (client == null || client.world == null || player == null) {
            return -1.0D;
        }
        double nearestSquared = Double.POSITIVE_INFINITY;
        for (Entity entity : client.world.getEntities()) {
            if (entity instanceof HostileEntity && entity.isAlive()) {
                nearestSquared = Math.min(nearestSquared, entity.squaredDistanceTo(player));
            }
        }
        return Double.isFinite(nearestSquared) ? Math.sqrt(nearestSquared) : -1.0D;
    }

    private ControlDecision completeDescent(BrainLink.Intent effective, DescentRun run, ClientPlayerEntity player, long nowMs, String reason) {
        finishedDescentCommandReasons.put(run.commandId, "descent_complete:" + reason);
        LOGGER.info(
            "descent.complete instanceId={} commandId={} reason={} start={} final={} depth={} depthReached={} reroutes={} openAirReroutes={} hazardReroutes={} healthBefore={} healthAfter={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            run.startFeet.toShortString(),
            player.getBlockPos().toShortString(),
            run.depth,
            run.depthReached,
            run.reroutes,
            run.openAirReroutes,
            run.hazardReroutes,
            run.healthBefore,
            player.getHealth(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeDescent = null;
        completedDescentPaths.put(run.commandId, List.copyOf(run.reachedFeet));
        brainLink.completeCurrentCommand(run.commandId, "descent_complete:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "descent_complete:" + reason), InputState.stop());
    }

    private ControlDecision failDescent(BrainLink.Intent effective, DescentRun run, long nowMs, String reason) {
        finishedDescentCommandReasons.put(run.commandId, "descent_failed:" + reason);
        LOGGER.warn(
            "descent.failed instanceId={} commandId={} reason={} start={} step={} depth={} depthReached={} reroutes={} openAirReroutes={} hazardReroutes={} stage={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            run.startFeet.toShortString(),
            run.stepIndex,
            run.depth,
            run.depthReached,
            run.reroutes,
            run.openAirReroutes,
            run.hazardReroutes,
            run.stage,
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeDescent = null;
        brainLink.completeCurrentCommand(run.commandId, "descent_failed:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "descent_failed:" + reason), InputState.stop());
    }

    private ControlDecision resolveMineNearbyStoneControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        String finishedReason = finishedMineNearbyStoneCommandReasons.get(commandId);
        if (finishedReason != null) {
            return new ControlDecision(stopFrom(effective, finishedReason), InputState.stop());
        }
        clearNavigationState();
        InventoryCounter.InventoryCobblestoneSnapshot inventory = InventoryCounter.countPlayerCobblestone(player);
        if (activeMineNearbyStone == null || !commandId.equals(activeMineNearbyStone.commandId)) {
            activeMineNearbyStone = new MineNearbyStoneRun(commandId, inventory.cobblestoneCount(), nowMs);
            LOGGER.info(
                "mine_nearby_stone.start instanceId={} commandId={} inventoryCobblestoneBefore={} targetDelta={} cobblestoneByItem={}",
                instanceId,
                commandId,
                inventory.cobblestoneCount(),
                NEARBY_STONE_TARGET_COBBLESTONE,
                inventory.cobblestoneByItem()
            );
        }
        MineNearbyStoneRun run = activeMineNearbyStone;
        int delta = inventory.cobblestoneCount() - run.baselineCobblestone;
        if (delta >= NEARBY_STONE_TARGET_COBBLESTONE) {
            return completeMineNearbyStone(effective, run, inventory, nowMs, "cobblestone_delta_verified");
        }
        if (nowMs - run.startedAtMs > NEARBY_STONE_TIMEOUT_MS) {
            return failMineNearbyStone(effective, run, inventory, nowMs, "mine_nearby_stone_timeout");
        }
        if (!player.isOnGround()) {
            return new ControlDecision(stopFrom(effective, "mine_nearby_stone_waiting_on_ground"), InputState.stop());
        }

        if (run.collectStartedAtMs > 0L) {
            if (nowMs - run.collectStartedAtMs < GATHER_PICKUP_SETTLE_MS) {
                return new ControlDecision(stopFrom(effective, "mine_nearby_stone_wait_pickup"), InputState.stop());
            }
            Vec3d droppedCobblestone = nearestDroppedItemPosition(
                client,
                player,
                run.lastBrokenTarget == null ? player.getBlockPos() : run.lastBrokenTarget,
                (stack, itemId) -> InventoryCounter.isCobblestoneItemId(itemId)
            );
            if (droppedCobblestone != null) {
                LOGGER.info(
                    "mine_nearby_stone.collect_item_target instanceId={} commandId={} itemX={} itemY={} itemZ={}",
                    instanceId,
                    commandId,
                    roundForLog(droppedCobblestone.x),
                    roundForLog(droppedCobblestone.y),
                    roundForLog(droppedCobblestone.z)
                );
                BrainLink.Intent collectIntent = gatherCollectIntent(
                    effective,
                    droppedCobblestone.x,
                    droppedCobblestone.y,
                    droppedCobblestone.z,
                    "mine_nearby_stone_collect_item",
                    ":nearstone:collect"
                );
                return resolveNavigationControl(client, player, collectIntent);
            }
            if (nowMs - run.collectStartedAtMs < GATHER_COLLECT_TIMEOUT_MS) {
                BrainLink.Intent collectIntent = gatherCollectIntent(
                    effective,
                    run.lastBrokenTarget == null ? player.getX() : run.lastBrokenTarget.getX() + 0.5D,
                    run.lastBrokenTarget == null ? player.getZ() : run.lastBrokenTarget.getZ() + 0.5D,
                    "mine_nearby_stone_collect_drop",
                    ":nearstone:collect"
                );
                return resolveNavigationControl(client, player, collectIntent);
            }
            run.collectStartedAtMs = 0L;
            run.lastBrokenTarget = null;
        }

        if (run.currentTarget == null || !client.world.getBlockState(run.currentTarget).isOf(Blocks.STONE)) {
            run.currentTarget = selectVisibleStoneTarget(client, player, run.abandonedTargets);
            if (run.currentTarget == null) {
                return failMineNearbyStone(effective, run, inventory, nowMs, "mine_nearby_stone_no_visible_stone");
            }
            LOGGER.info(
                "mine_nearby_stone.target_selected instanceId={} commandId={} target={} inventoryCobblestoneDelta={}",
                instanceId,
                commandId,
                run.currentTarget.toShortString(),
                delta
            );
        }

        int pickaxeSlot = findHotbarSlot(player, InventoryCounter::isWoodenPickaxeItemId);
        if (pickaxeSlot < 0) {
            return failMineNearbyStone(effective, run, inventory, nowMs, "mine_nearby_stone_no_wooden_pickaxe_hotbar");
        }
        if (player.getInventory().selectedSlot != pickaxeSlot) {
            player.getInventory().selectedSlot = pickaxeSlot;
            LOGGER.info(
                "mine_nearby_stone.tool_selected instanceId={} commandId={} hotbarSlot={}",
                instanceId,
                commandId,
                pickaxeSlot
            );
            return new ControlDecision(stopFrom(effective, "mine_nearby_stone_select_tool"), InputState.stop());
        }

        BlockPos target = run.currentTarget;
        if (!isLookingAtBlock(player, target)) {
            return new ControlDecision(lookIntentForBlock(effective, player, target, "mine_nearby_stone_face"), InputState.stop());
        }
        BlockBreakController.Result result = blockBreakController.tick(client, player, target, commandId + ":nearstone", nowMs);
        logBlockBreakResult(commandId + ":nearstone", target, result);
        LOGGER.info(
            "mine_nearby_stone.break_progress instanceId={} commandId={} target={} status={} reason={} hitBlock={} actedBlock={} elapsedMs={}",
            instanceId,
            commandId,
            target.toShortString(),
            result.status(),
            result.reason(),
            formatBlockPos(result.hitBlock()),
            formatBlockPos(result.actedBlock()),
            result.elapsedMs()
        );
        if (result.status() == BlockBreakController.Status.BROKEN) {
            run.lastBrokenTarget = target;
            run.currentTarget = null;
            run.collectStartedAtMs = nowMs;
            return new ControlDecision(stopFrom(effective, "mine_nearby_stone_break_done"), InputState.stop());
        }
        if (result.status() == BlockBreakController.Status.REPOSITION) {
            run.abandonedTargets.add(target);
            run.currentTarget = null;
            return new ControlDecision(stopFrom(effective, "mine_nearby_stone_reselect:" + result.reason()), InputState.stop());
        }
        if (result.status() == BlockBreakController.Status.FAILED) {
            run.abandonedTargets.add(target);
            run.currentTarget = null;
            return new ControlDecision(stopFrom(effective, "mine_nearby_stone_reselect_failed:" + result.reason()), InputState.stop());
        }
        return new ControlDecision(lookIntentForBlock(effective, player, target, "mine_nearby_stone_breaking:" + result.reason()), InputState.stop());
    }

    private BlockPos selectVisibleStoneTarget(MinecraftClient client, ClientPlayerEntity player, Set<BlockPos> excluded) {
        BlockPos origin = player.getBlockPos();
        BlockPos currentSupport = origin.down();
        BlockPos best = null;
        double bestDistance = Double.MAX_VALUE;
        for (int dy = 0; dy <= 3; dy++) {
            for (int dx = -4; dx <= 4; dx++) {
                for (int dz = -4; dz <= 4; dz++) {
                    if (dx == 0 && dz == 0 && dy < 2) {
                        continue;
                    }
                    BlockPos candidate = origin.add(dx, dy, dz);
                    if (candidate.equals(currentSupport) || (excluded != null && excluded.contains(candidate))) {
                        continue;
                    }
                    if (!client.world.getBlockState(candidate).isOf(Blocks.STONE)) {
                        continue;
                    }
                    if (!visibleStoneTarget(client, player, candidate)) {
                        continue;
                    }
                    double distance = player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(candidate));
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = candidate.toImmutable();
                    }
                }
            }
        }
        return best;
    }

    private boolean visibleStoneTarget(MinecraftClient client, ClientPlayerEntity player, BlockPos candidate) {
        if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(candidate)) > TABLE_INTERACTION_REACH_BLOCKS * TABLE_INTERACTION_REACH_BLOCKS) {
            return false;
        }
        BlockHitResult hit = raycastToBlockCenter(player, client, candidate);
        return hit != null && hit.getType() == HitResult.Type.BLOCK && candidate.equals(hit.getBlockPos());
    }

    private BlockHitResult raycastToBlockCenter(ClientPlayerEntity player, MinecraftClient client, BlockPos target) {
        Vec3d eye = player.getEyePos();
        Vec3d center = Vec3d.ofCenter(target);
        return client.world.raycast(new RaycastContext(
            eye,
            center,
            RaycastContext.ShapeType.OUTLINE,
            RaycastContext.FluidHandling.NONE,
            player
        ));
    }

    private ControlDecision completeMineNearbyStone(
        BrainLink.Intent effective,
        MineNearbyStoneRun run,
        InventoryCounter.InventoryCobblestoneSnapshot inventory,
        long nowMs,
        String reason
    ) {
        finishedMineNearbyStoneCommandReasons.put(run.commandId, "mine_nearby_stone_complete:" + reason);
        LOGGER.info(
            "mine_nearby_stone.complete instanceId={} commandId={} reason={} inventoryCobblestoneBefore={} inventoryCobblestoneAfter={} targetDelta={} cobblestoneByItem={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            run.baselineCobblestone,
            inventory.cobblestoneCount(),
            NEARBY_STONE_TARGET_COBBLESTONE,
            inventory.cobblestoneByItem(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeMineNearbyStone = null;
        brainLink.completeCurrentCommand(run.commandId, "mine_nearby_stone_complete:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "mine_nearby_stone_complete:" + reason), InputState.stop());
    }

    private ControlDecision failMineNearbyStone(
        BrainLink.Intent effective,
        MineNearbyStoneRun run,
        InventoryCounter.InventoryCobblestoneSnapshot inventory,
        long nowMs,
        String reason
    ) {
        finishedMineNearbyStoneCommandReasons.put(run.commandId, "mine_nearby_stone_failed:" + reason);
        LOGGER.warn(
            "mine_nearby_stone.failed instanceId={} commandId={} reason={} inventoryCobblestoneBefore={} inventoryCobblestoneAfter={} target={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            run.baselineCobblestone,
            inventory.cobblestoneCount(),
            formatBlockPos(run.currentTarget),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeMineNearbyStone = null;
        brainLink.completeCurrentCommand(run.commandId, "mine_nearby_stone_failed:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "mine_nearby_stone_failed:" + reason), InputState.stop());
    }

    private ControlDecision resolveMineNearbyIronControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        String finishedReason = finishedMineNearbyIronCommandReasons.get(commandId);
        if (finishedReason != null) {
            return new ControlDecision(stopFrom(effective, finishedReason), InputState.stop());
        }
        clearNavigationState();
        InventoryCounter.InventoryItemSnapshot inventory = InventoryCounter.countPlayerItem(player, "raw_iron");
        if (activeMineNearbyIron == null || !commandId.equals(activeMineNearbyIron.commandId)) {
            activeMineNearbyIron = new MineNearbyIronRun(commandId, inventory.itemCount(), nowMs);
            LOGGER.info(
                "mine_nearby_iron.start instanceId={} commandId={} inventoryRawIronBefore={} targetDelta={} rawIronByItem={}",
                instanceId,
                commandId,
                inventory.itemCount(),
                NEARBY_IRON_TARGET_RAW_IRON,
                inventory.itemsByItem()
            );
        }
        MineNearbyIronRun run = activeMineNearbyIron;
        int delta = inventory.itemCount() - run.baselineRawIron;
        if (delta >= NEARBY_IRON_TARGET_RAW_IRON) {
            return completeMineNearbyIron(effective, run, inventory, nowMs, "raw_iron_delta_verified");
        }
        if (nowMs - run.startedAtMs > NEARBY_IRON_TIMEOUT_MS) {
            return failMineNearbyIron(effective, run, inventory, nowMs, "mine_nearby_iron_timeout");
        }
        if (!player.isOnGround()) {
            return new ControlDecision(stopFrom(effective, "mine_nearby_iron_waiting_on_ground"), InputState.stop());
        }
        if (run.prospectSettleUntilMs > nowMs) {
            return new ControlDecision(stopFrom(effective, "mine_nearby_iron_prospect_settle"), InputState.stop());
        }

        if (run.fieldKitRecoveryActive || run.fieldKitRetrieveTablePending) {
            ControlDecision recoveryDecision = resolveMineNearbyIronToolRecovery(client, player, effective, run, inventory, nowMs, true);
            if (recoveryDecision != null) {
                return recoveryDecision;
            }
        }

        ControlDecision proactiveToolRecovery = maybeResolveProactiveMineNearbyIronToolRecovery(client, player, effective, run, inventory, nowMs);
        if (proactiveToolRecovery != null) {
            return proactiveToolRecovery;
        }

        if (run.collectStartedAtMs > 0L) {
            if (nowMs - run.collectStartedAtMs < GATHER_PICKUP_SETTLE_MS) {
                return new ControlDecision(stopFrom(effective, "mine_nearby_iron_wait_pickup"), InputState.stop());
            }
            Vec3d droppedRawIron = nearestDroppedItemPosition(
                client,
                player,
                run.lastBrokenTarget == null ? player.getBlockPos() : run.lastBrokenTarget,
                (stack, itemId) -> "raw_iron".equalsIgnoreCase(itemId)
            );
            if (droppedRawIron != null) {
                LOGGER.info(
                    "mine_nearby_iron.collect_item_target instanceId={} commandId={} itemX={} itemY={} itemZ={}",
                    instanceId,
                    commandId,
                    roundForLog(droppedRawIron.x),
                    roundForLog(droppedRawIron.y),
                    roundForLog(droppedRawIron.z)
                );
                BrainLink.Intent collectIntent = gatherCollectIntent(
                    effective,
                    droppedRawIron.x,
                    droppedRawIron.y,
                    droppedRawIron.z,
                    "mine_nearby_iron_collect_item",
                    ":neariron:collect"
                );
                return resolveNavigationControl(client, player, collectIntent);
            }
            if (nowMs - run.collectStartedAtMs < GATHER_COLLECT_TIMEOUT_MS) {
                BrainLink.Intent collectIntent = gatherCollectIntent(
                    effective,
                    run.lastBrokenTarget == null ? player.getX() : run.lastBrokenTarget.getX() + 0.5D,
                    run.lastBrokenTarget == null ? player.getZ() : run.lastBrokenTarget.getZ() + 0.5D,
                    "mine_nearby_iron_collect_drop",
                    ":neariron:collect"
                );
                return resolveNavigationControl(client, player, collectIntent);
            }
            run.collectStartedAtMs = 0L;
            run.lastBrokenTarget = null;
        }

        if (run.currentTarget != null) {
            BlockState currentTargetState = client.world.getBlockState(run.currentTarget);
            boolean stillTargetable = run.currentTargetIron
                ? isIronOreBlock(currentTargetState)
                : isProspectableIronMiningBlock(client, run.currentTarget, currentTargetState);
            MineNearbyIronTargetPlanner.Decision currentTargetDecision = MineNearbyIronTargetPlanner.decideCurrentTarget(
                true,
                run.currentTargetIron,
                stillTargetable
            );
            if (currentTargetDecision.action() == MineNearbyIronTargetPlanner.Action.TARGET_CLEARED_IRON
                || currentTargetDecision.action() == MineNearbyIronTargetPlanner.Action.TARGET_CLEARED_PROSPECT) {
                BlockPos completedTarget = run.currentTarget;
                if (currentTargetDecision.action() == MineNearbyIronTargetPlanner.Action.TARGET_CLEARED_IRON) {
                    run.lastBrokenTarget = completedTarget;
                    run.collectStartedAtMs = nowMs;
                } else {
                    run.prospectBlocksBroken++;
                    run.prospectSettleUntilMs = nowMs + 250L;
                    LOGGER.info(
                        "mine_nearby_iron.prospect_block_cleared instanceId={} commandId={} target={} prospectBlocksBroken={} blockNow={}",
                        instanceId,
                        commandId,
                        completedTarget.toShortString(),
                        run.prospectBlocksBroken,
                        blockId(currentTargetState)
                    );
                }
                run.currentTarget = null;
                run.currentProspectCell = null;
                return new ControlDecision(stopFrom(effective, currentTargetDecision.reason()), InputState.stop());
            }
        }

        if (run.currentTarget == null) {
            run.currentTarget = selectVisibleIronTarget(client, player, run.abandonedTargets);
            MineNearbyIronTargetPlanner.Decision visibleIronDecision = MineNearbyIronTargetPlanner.decideVisibleIronSelection(run.currentTarget != null);
            run.currentTargetIron = visibleIronDecision.action() == MineNearbyIronTargetPlanner.Action.SELECT_IRON_TARGET;
            if (visibleIronDecision.action() == MineNearbyIronTargetPlanner.Action.PROSPECT_REQUIRED) {
                MineNearbyIronTargetPlanner.Decision prospectLimitDecision = MineNearbyIronTargetPlanner.decideProspectLimit(
                    run.prospectBlocksBroken,
                    NEARBY_IRON_MAX_PROSPECT_BLOCKS
                );
                if (prospectLimitDecision.action() == MineNearbyIronTargetPlanner.Action.FAIL_PROSPECT_LIMIT) {
                    return failMineNearbyIron(effective, run, inventory, nowMs, prospectLimitDecision.reason());
                }
                ControlDecision directionalProspect = selectOrAdvanceDirectionalIronProspect(client, player, effective, run);
                if (directionalProspect != null) {
                    return directionalProspect;
                }
                if (run.currentTarget == null) {
                    run.currentTarget = selectVisibleIronProspectTarget(client, player, run.abandonedTargets);
                    run.currentProspectCell = null;
                    if (run.currentTarget != null) {
                        LOGGER.info(
                            "mine_nearby_iron.local_prospect_fallback instanceId={} commandId={} target={} prospectBlocksBroken={} block={}",
                            instanceId,
                            commandId,
                            run.currentTarget.toShortString(),
                            run.prospectBlocksBroken,
                            blockId(client.world.getBlockState(run.currentTarget))
                        );
                    }
                }
                MineNearbyIronTargetPlanner.Decision localProspectDecision = MineNearbyIronTargetPlanner.decideLocalProspectFallback(run.currentTarget != null);
                if (localProspectDecision.action() == MineNearbyIronTargetPlanner.Action.FAIL_NO_VISIBLE_TARGET) {
                    return failMineNearbyIron(effective, run, inventory, nowMs, localProspectDecision.reason());
                }
            }
            LOGGER.info(
                "mine_nearby_iron.target_selected instanceId={} commandId={} target={} targetKind={} inventoryRawIronDelta={} prospectBlocksBroken={} block={}",
                instanceId,
                commandId,
                run.currentTarget.toShortString(),
                run.currentTargetIron ? "iron" : "prospect",
                delta,
                run.prospectBlocksBroken,
                blockId(client.world.getBlockState(run.currentTarget))
            );
        }

        int pickaxeSlot = findHotbarSlot(player, InventoryCounter::isStonePickaxeItemId);
        if (pickaxeSlot < 0) {
            applyFieldKitRecoveryDecision(run, FieldKitRecoveryPlanner.activate(fieldKitRecoveryState(run)));
            return resolveMineNearbyIronToolRecovery(client, player, effective, run, inventory, nowMs, true);
        }
        if (player.getInventory().selectedSlot != pickaxeSlot) {
            player.getInventory().selectedSlot = pickaxeSlot;
            LOGGER.info(
                "mine_nearby_iron.tool_selected instanceId={} commandId={} hotbarSlot={}",
                instanceId,
                commandId,
                pickaxeSlot
            );
            return new ControlDecision(stopFrom(effective, "mine_nearby_iron_select_tool"), InputState.stop());
        }

        BlockPos target = run.currentTarget;
        if (!isLookingAtBlock(player, target)) {
            return new ControlDecision(lookIntentForBlock(effective, player, target, "mine_nearby_iron_face"), InputState.stop());
        }
        BlockBreakController.Result result = blockBreakController.tick(client, player, target, commandId + ":neariron", nowMs);
        logBlockBreakResult(commandId + ":neariron", target, result);
        LOGGER.info(
            "mine_nearby_iron.break_progress instanceId={} commandId={} target={} targetKind={} status={} reason={} hitBlock={} actedBlock={} elapsedMs={}",
            instanceId,
            commandId,
            target.toShortString(),
            run.currentTargetIron ? "iron" : "prospect",
            result.status(),
            result.reason(),
            formatBlockPos(result.hitBlock()),
            formatBlockPos(result.actedBlock()),
            result.elapsedMs()
        );
        MineNearbyIronTargetPlanner.Decision breakDecision = MineNearbyIronTargetPlanner.decideBreakResult(
            result.status(),
            run.currentTargetIron,
            result.reason()
        );
        if (breakDecision.action() == MineNearbyIronTargetPlanner.Action.BREAK_DONE_IRON
            || breakDecision.action() == MineNearbyIronTargetPlanner.Action.BREAK_DONE_PROSPECT) {
            run.lastBrokenTarget = target;
            run.currentTarget = null;
            run.currentProspectCell = null;
            if (breakDecision.action() == MineNearbyIronTargetPlanner.Action.BREAK_DONE_IRON) {
                run.collectStartedAtMs = nowMs;
            } else {
                run.prospectBlocksBroken++;
                run.prospectSettleUntilMs = nowMs + 250L;
            }
            return new ControlDecision(stopFrom(effective, breakDecision.reason()), InputState.stop());
        }
        if (breakDecision.action() == MineNearbyIronTargetPlanner.Action.BREAK_RESELECT) {
            run.abandonedTargets.add(target);
            run.currentTarget = null;
            run.currentProspectCell = null;
            return new ControlDecision(stopFrom(effective, breakDecision.reason()), InputState.stop());
        }
        if (breakDecision.action() == MineNearbyIronTargetPlanner.Action.BREAK_RESELECT_FAILED) {
            run.abandonedTargets.add(target);
            run.currentTarget = null;
            run.currentProspectCell = null;
            return new ControlDecision(stopFrom(effective, breakDecision.reason()), InputState.stop());
        }
        return new ControlDecision(lookIntentForBlock(effective, player, target, breakDecision.reason()), InputState.stop());
    }

    private ControlDecision maybeResolveProactiveMineNearbyIronToolRecovery(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        MineNearbyIronRun run,
        InventoryCounter.InventoryItemSnapshot rawIronInventory,
        long nowMs
    ) {
        int bestRemaining = bestStonePickaxeRemainingDurability(player);
        if (bestRemaining < 0 || bestRemaining > NEARBY_IRON_PICKAXE_RESTOCK_REMAINING) {
            return null;
        }
        CraftInventorySnapshot craftInventory = captureCraftInventory(player);
        if (craftInventory.cobblestone.cobblestoneCount() < 3
            || craftInventory.sticks.stickCount() < 2
            || (craftInventory.tables.craftingTableCount() < 1 && selectNearbyCraftingTable(client, player) == null)) {
            return null;
        }
        if (!run.proactiveToolRecoveryLogged) {
            run.proactiveToolRecoveryLogged = true;
            LOGGER.info(
                "mine_nearby_iron.proactive_tool_recovery instanceId={} commandId={} bestStonePickaxeRemaining={} threshold={} cobblestone={} sticks={} tables={} nearbyTable={}",
                instanceId,
                run.commandId,
                bestRemaining,
                NEARBY_IRON_PICKAXE_RESTOCK_REMAINING,
                craftInventory.cobblestone.cobblestoneCount(),
                craftInventory.sticks.stickCount(),
                craftInventory.tables.craftingTableCount(),
                formatBlockPos(selectNearbyCraftingTable(client, player))
            );
        }
        applyFieldKitRecoveryDecision(run, FieldKitRecoveryPlanner.activate(fieldKitRecoveryState(run)));
        return resolveMineNearbyIronToolRecovery(client, player, effective, run, rawIronInventory, nowMs, true);
    }

    private ControlDecision selectOrAdvanceDirectionalIronProspect(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        MineNearbyIronRun run
    ) {
        if (run.prospectDirection == null) {
            run.prospectDirection = resolveMineNearbyIronProspectDirection(effective, player);
            LOGGER.info(
                "mine_nearby_iron.prospect_direction instanceId={} commandId={} direction={} targetHint={} playerYaw={}",
                instanceId,
                run.commandId,
                run.prospectDirection.name(),
                formatTargetHint(effective),
                player.getYaw()
            );
        }

        BlockPos currentFeet = player.getBlockPos().toImmutable();
        List<StaircaseDescentPlanner.Direction2d> directions = new ArrayList<>();
        directions.add(run.prospectDirection);
        for (StaircaseDescentPlanner.Direction2d candidate : StaircaseDescentPlanner.rerouteCandidates(run.prospectDirection)) {
            if (!directions.contains(candidate)) {
                directions.add(candidate);
            }
        }

        String firstBlockedReason = "";
        BlockPos firstBlockedCell = null;
        for (StaircaseDescentPlanner.Direction2d direction : directions) {
            BlockPos nextFeet = currentFeet.add(direction.dx(), 0, direction.dz()).toImmutable();
            String unsafeReason = ironProspectCellUnsafeReason(client, nextFeet);
            BlockPos upper = nextFeet.up();
            BlockState upperState = client.world.getBlockState(upper);
            BlockState lowerState = client.world.getBlockState(nextFeet);
            MineNearbyIronTargetPlanner.Decision branchDecision = MineNearbyIronTargetPlanner.decideBranchCandidate(
                unsafeReason,
                isProspectableIronMiningBlock(client, upper, upperState),
                isProspectableIronMiningBlock(client, nextFeet, lowerState),
                upperState.isAir() && lowerState.isAir(),
                blockId(lowerState),
                blockId(upperState)
            );
            if (branchDecision.action() == MineNearbyIronTargetPlanner.Action.BRANCH_SKIP_UNSAFE) {
                if (firstBlockedReason.isBlank()) {
                    firstBlockedReason = branchDecision.reason();
                    firstBlockedCell = nextFeet;
                }
                continue;
            }

            if (branchDecision.action() == MineNearbyIronTargetPlanner.Action.BRANCH_SELECT_UPPER) {
                run.prospectDirection = direction;
                run.currentTarget = upper;
                run.currentTargetIron = false;
                run.currentProspectCell = nextFeet;
                LOGGER.info(
                    "mine_nearby_iron.branch_target_selected instanceId={} commandId={} cell={} target={} phase=upper direction={} prospectBlocksBroken={} block={}",
                    instanceId,
                    run.commandId,
                    nextFeet.toShortString(),
                    upper.toShortString(),
                    direction.name(),
                    run.prospectBlocksBroken,
                    blockId(upperState)
                );
                return null;
            }
            if (branchDecision.action() == MineNearbyIronTargetPlanner.Action.BRANCH_SELECT_LOWER) {
                run.prospectDirection = direction;
                run.currentTarget = nextFeet;
                run.currentTargetIron = false;
                run.currentProspectCell = nextFeet;
                LOGGER.info(
                    "mine_nearby_iron.branch_target_selected instanceId={} commandId={} cell={} target={} phase=lower direction={} prospectBlocksBroken={} block={}",
                    instanceId,
                    run.commandId,
                    nextFeet.toShortString(),
                    nextFeet.toShortString(),
                    direction.name(),
                    run.prospectBlocksBroken,
                    blockId(lowerState)
                );
                return null;
            }
            if (branchDecision.action() == MineNearbyIronTargetPlanner.Action.BRANCH_MOVE_TO_CELL) {
                run.prospectDirection = direction;
                return moveToIronProspectCell(player, effective, run, nextFeet, direction);
            }
            if (firstBlockedReason.isBlank()) {
                firstBlockedReason = branchDecision.reason();
                firstBlockedCell = nextFeet;
            }
        }

        LOGGER.info(
            "mine_nearby_iron.branch_blocked instanceId={} commandId={} reason={} cell={} direction={} prospectBlocksBroken={}",
            instanceId,
            run.commandId,
            firstBlockedReason.isBlank() ? "no_branch_candidate" : firstBlockedReason,
            formatBlockPos(firstBlockedCell),
            run.prospectDirection.name(),
            run.prospectBlocksBroken
        );
        return null;
    }

    private ControlDecision moveToIronProspectCell(
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        MineNearbyIronRun run,
        BlockPos nextFeet,
        StaircaseDescentPlanner.Direction2d direction
    ) {
        double targetX = nextFeet.getX() + 0.5D;
        double targetZ = nextFeet.getZ() + 0.5D;
        double dx = targetX - player.getX();
        double dz = targetZ - player.getZ();
        double distance = Math.hypot(dx, dz);
        MineNearbyIronTargetPlanner.Decision moveDecision = MineNearbyIronTargetPlanner.decideProspectCellMove(
            distance,
            DESCENT_STEP_ARRIVE_EPSILON
        );
        if (moveDecision.action() == MineNearbyIronTargetPlanner.Action.BRANCH_CELL_REACHED) {
            run.branchCellsAdvanced++;
            LOGGER.info(
                "mine_nearby_iron.branch_cell_reached instanceId={} commandId={} cell={} direction={} cellsAdvanced={} prospectBlocksBroken={}",
                instanceId,
                run.commandId,
                nextFeet.toShortString(),
                direction.name(),
                run.branchCellsAdvanced,
                run.prospectBlocksBroken
            );
            return new ControlDecision(stopFrom(effective, moveDecision.reason()), InputState.stop());
        }
        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        BrainLink.Intent intent = lookIntentForAngles(effective, yaw, 6.0D, "mine_nearby_iron_branch_move:" + direction.name());
        InputState input = new InputState(true, false, false, false, false, false, 1.0F, 0.0F);
        return new ControlDecision(intent, input);
    }

    private StaircaseDescentPlanner.Direction2d resolveMineNearbyIronProspectDirection(BrainLink.Intent effective, ClientPlayerEntity player) {
        BlockPos feet = player.getBlockPos();
        if (effective != null && effective.targetX() != null && effective.targetZ() != null) {
            return StaircaseDescentPlanner.cardinalFromDelta(
                effective.targetX() - feet.getX(),
                effective.targetZ() - feet.getZ(),
                directionFromYaw(player.getYaw())
            );
        }
        return directionFromYaw(player.getYaw());
    }

    private String ironProspectCellUnsafeReason(MinecraftClient client, BlockPos nextFeet) {
        if (client == null || client.world == null || nextFeet == null) {
            return "missing_client_state";
        }
        BlockPos support = nextFeet.down();
        if (!isStableDescentSupport(client, support)) {
            return "support_missing:" + support.toShortString();
        }
        BlockPos hazard = firstHazardBlock(client, List.of(nextFeet, nextFeet.up(), support));
        if (hazard != null) {
            return "hazard:" + hazard.toShortString();
        }
        BlockPos lavaAdjacent = firstAdjacentLavaBlock(client, nextFeet);
        if (lavaAdjacent == null) {
            lavaAdjacent = firstAdjacentLavaBlock(client, nextFeet.up());
        }
        if (lavaAdjacent != null) {
            return "lava_adjacent:" + lavaAdjacent.toShortString();
        }
        return null;
    }

    private FieldKitRecoveryPlanner.State fieldKitRecoveryState(MineNearbyIronRun run) { return new FieldKitRecoveryPlanner.State(run.fieldKitRecoveryActive, run.fieldKitRetrieveTablePending, run.fieldKitTablePlacedByRecovery, run.fieldKitAlcoveCell != null, run.proactiveToolRecoveryLogged, run.toolRecoveryAttempts); }
    private FieldKitRecoveryPlanner.Decision applyFieldKitRecoveryDecision(MineNearbyIronRun run, FieldKitRecoveryPlanner.Decision decision) {
        FieldKitRecoveryPlanner.State state = decision.state();
        run.fieldKitRecoveryActive = state.active(); run.fieldKitRetrieveTablePending = state.retrieveTablePending();
        run.fieldKitTablePlacedByRecovery = state.tablePlacedByRecovery(); run.proactiveToolRecoveryLogged = state.proactiveLogged();
        run.toolRecoveryAttempts = state.attempts();
        if (!state.alcoveKnown()) run.fieldKitAlcoveCell = null;
        if (decision.clearMiningTargets()) { run.currentTarget = null; run.currentProspectCell = null; }
        return decision;
    }
    private ControlDecision resolveMineNearbyIronToolRecovery(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        MineNearbyIronRun run,
        InventoryCounter.InventoryItemSnapshot rawIronInventory,
        long nowMs,
        boolean proactive
    ) {
        FieldKitRecoveryPlanner.Decision tickDecision = applyFieldKitRecoveryDecision(run,
            FieldKitRecoveryPlanner.tick(fieldKitRecoveryState(run), NEARBY_IRON_MAX_TOOL_RECOVERY_ATTEMPTS));
        if (tickDecision.action() == FieldKitRecoveryPlanner.Action.RECOVERY_LIMIT_REACHED) {
            return failMineNearbyIron(effective, run, rawIronInventory, nowMs, "mine_nearby_iron_tool_recovery_limit");
        }

        if (tickDecision.action() == FieldKitRecoveryPlanner.Action.RETRIEVE_TABLE) {
            String retrieveCommandId = run.toolRetrieveTableCommandId();
            ControlDecision retrieveDecision = resolveRetrieveTableControl(
                client,
                player,
                makeSubIntent(effective, "retrieve_table", retrieveCommandId, "mine_nearby_iron_retrieve_table"),
                nowMs
            );
            String reason = retrieveDecision.intent() == null ? "" : retrieveDecision.intent().reason();
            FieldKitRecoveryPlanner.Decision retrieveTransition = applyFieldKitRecoveryDecision(run,
                FieldKitRecoveryPlanner.afterRetrieve(fieldKitRecoveryState(run), reason));
            if (retrieveTransition.action() == FieldKitRecoveryPlanner.Action.RETRIEVE_TABLE_FAILED) {
                return failMineNearbyIron(effective, run, rawIronInventory, nowMs, "mine_nearby_iron_retrieve_table_failed:" + reason);
            }
            if (retrieveTransition.action() == FieldKitRecoveryPlanner.Action.RETRIEVE_TABLE_COMPLETE) {
                LOGGER.info(
                    "mine_nearby_iron.fieldkit_table_retrieved instanceId={} commandId={} subCommandId={} reason={} recoveryAttempts={}",
                    instanceId,
                    run.commandId,
                    retrieveCommandId,
                    reason,
                    run.toolRecoveryAttempts
                );
                return new ControlDecision(stopFrom(effective, "mine_nearby_iron_fieldkit_table_retrieved"), InputState.stop());
            }
            return retrieveDecision;
        }

        boolean craftingScreenOpen = player.currentScreenHandler != null && player.currentScreenHandler instanceof CraftingScreenHandler;
        if (!craftingScreenOpen) {
            int movedHotbarSlot = moveInventoryItemToHotbar(
                client,
                player,
                InventoryCounter::isStonePickaxeItemId,
                run.commandId,
                "mine_nearby_iron"
            );
            FieldKitRecoveryPlanner.Decision hotbarDecision = applyFieldKitRecoveryDecision(run,
                FieldKitRecoveryPlanner.afterHotbarMove(fieldKitRecoveryState(run), false, movedHotbarSlot));
            if (hotbarDecision.action() == FieldKitRecoveryPlanner.Action.HOTBAR_PICKAXE_MOVED) {
                return new ControlDecision(stopFrom(effective, "mine_nearby_iron_fieldkit_pickaxe_moved_hotbar"), InputState.stop());
            }
            if (hotbarDecision.action() == FieldKitRecoveryPlanner.Action.CLOSE_SCREEN_BEFORE_HOTBAR_MOVE) {
                return new ControlDecision(stopFrom(effective, "mine_nearby_iron_fieldkit_close_screen_before_hotbar_move"), InputState.stop());
            }
        } else {
            applyFieldKitRecoveryDecision(run, FieldKitRecoveryPlanner.afterHotbarMove(fieldKitRecoveryState(run), true, -1));
            LOGGER.info(
                "mine_nearby_iron.fieldkit_hotbar_move_skipped instanceId={} commandId={} reason=crafting_screen_open recoveryAttempts={}",
                instanceId,
                run.commandId,
                run.toolRecoveryAttempts
            );
        }

        CraftInventorySnapshot craftInventory = captureCraftInventory(player);
        if (run.lastFieldKitStateLogAtMs <= 0L || nowMs - run.lastFieldKitStateLogAtMs >= 1000L) {
            run.lastFieldKitStateLogAtMs = nowMs;
            LOGGER.info(
                "mine_nearby_iron.fieldkit_state instanceId={} commandId={} recoveryActive={} retrievePending={} tablePlacedByRecovery={} craftingScreenOpen={} alcove={} cobblestone={} sticks={} tables={} hotbarPickaxeSlot={} recoveryAttempts={} proactive={}",
                instanceId,
                run.commandId,
                run.fieldKitRecoveryActive,
                run.fieldKitRetrieveTablePending,
                run.fieldKitTablePlacedByRecovery,
                craftingScreenOpen,
                formatBlockPos(run.fieldKitAlcoveCell),
                craftInventory.cobblestone.cobblestoneCount(),
                craftInventory.sticks.stickCount(),
                craftInventory.tables.craftingTableCount(),
                findHotbarSlot(player, InventoryCounter::isStonePickaxeItemId),
                run.toolRecoveryAttempts,
                proactive
            );
        }
        BlockPos table = selectNearbyCraftingTable(client, player);
        FieldKitRecoveryPlanner.Decision inventoryDecision = applyFieldKitRecoveryDecision(run, FieldKitRecoveryPlanner.afterInventory(
            fieldKitRecoveryState(run),
            new FieldKitRecoveryPlanner.InventoryObservation(craftingScreenOpen, craftInventory.cobblestone.cobblestoneCount(),
                craftInventory.sticks.stickCount(), craftInventory.tables.craftingTableCount(), table != null,
                table != null && run.fieldKitAlcoveCell != null && table.equals(run.fieldKitAlcoveCell))
        ));
        if (inventoryDecision.action() == FieldKitRecoveryPlanner.Action.MISSING_PICKAXE_INPUTS) {
            LOGGER.warn(
                "mine_nearby_iron.fieldkit_failed instanceId={} commandId={} reason=missing_stone_pickaxe_inputs cobblestone={} sticks={} tables={} recoveryAttempts={}",
                instanceId,
                run.commandId,
                craftInventory.cobblestone.cobblestoneCount(),
                craftInventory.sticks.stickCount(),
                craftInventory.tables.craftingTableCount(),
                run.toolRecoveryAttempts
            );
            return failMineNearbyIron(effective, run, rawIronInventory, nowMs, "mine_nearby_iron_no_stone_pickaxe_hotbar:missing_fieldkit_inputs");
        }

        if (inventoryDecision.action() == FieldKitRecoveryPlanner.Action.NO_CRAFTING_TABLE) {
            LOGGER.warn(
                "mine_nearby_iron.fieldkit_failed instanceId={} commandId={} reason=no_table_available cobblestone={} sticks={} recoveryAttempts={}",
                instanceId,
                run.commandId,
                craftInventory.cobblestone.cobblestoneCount(),
                craftInventory.sticks.stickCount(),
                run.toolRecoveryAttempts
            );
            return failMineNearbyIron(effective, run, rawIronInventory, nowMs, "mine_nearby_iron_no_stone_pickaxe_hotbar:no_crafting_table");
        }

        if (inventoryDecision.action() == FieldKitRecoveryPlanner.Action.PLACE_TABLE_REQUIRED) {
            ControlDecision alcoveDecision = proactive
                ? resolveMineNearbyIronFieldKitAlcove(client, player, effective, run, rawIronInventory, nowMs)
                : null;
            if (alcoveDecision != null) {
                return alcoveDecision;
            }
            String placeCommandId = run.toolPlaceTableCommandId();
            BlockPos explicitSupport = isFieldKitAlcoveReady(client, run.fieldKitAlcoveCell) ? run.fieldKitAlcoveCell.down() : null;
            ControlDecision placeDecision = resolvePlaceTableControl(
                client,
                player,
                makeSubIntent(effective, "place_table", placeCommandId, "mine_nearby_iron_place_table"),
                nowMs,
                explicitSupport
            );
            String reason = placeDecision.intent() == null ? "" : placeDecision.intent().reason();
            FieldKitRecoveryPlanner.Decision placeTransition = applyFieldKitRecoveryDecision(run,
                FieldKitRecoveryPlanner.afterPlaceTable(fieldKitRecoveryState(run), reason));
            if (placeTransition.action() == FieldKitRecoveryPlanner.Action.PLACE_TABLE_FAILED) {
                return failMineNearbyIron(effective, run, rawIronInventory, nowMs, "mine_nearby_iron_place_table_failed:" + reason);
            }
            if (placeTransition.action() == FieldKitRecoveryPlanner.Action.PLACE_TABLE_COMPLETE) {
                LOGGER.info(
                    "mine_nearby_iron.fieldkit_table_placed instanceId={} commandId={} subCommandId={} reason={} recoveryAttempts={}",
                    instanceId,
                    run.commandId,
                    placeCommandId,
                    reason,
                    run.toolRecoveryAttempts
                );
                return new ControlDecision(stopFrom(effective, "mine_nearby_iron_fieldkit_table_placed"), InputState.stop());
            }
            return placeDecision;
        }

        String craftCommandId = run.toolCraftPickaxeCommandId();
        ControlDecision craftDecision = resolveCraft3x3Control(
            client,
            player,
            makeSubIntent(effective, "craft_stone_pickaxe", craftCommandId, "mine_nearby_iron_craft_stone_pickaxe"),
            nowMs
        );
        String reason = craftDecision.intent() == null ? "" : craftDecision.intent().reason();
        FieldKitRecoveryPlanner.Decision craftTransition = applyFieldKitRecoveryDecision(run,
            FieldKitRecoveryPlanner.afterCraftPickaxe(fieldKitRecoveryState(run), reason));
        if (craftTransition.action() == FieldKitRecoveryPlanner.Action.CRAFT_PICKAXE_FAILED) {
            return failMineNearbyIron(effective, run, rawIronInventory, nowMs, "mine_nearby_iron_craft_stone_pickaxe_failed:" + reason);
        }
        if (craftTransition.action() == FieldKitRecoveryPlanner.Action.CRAFT_PICKAXE_COMPLETE) {
            if (player.currentScreenHandler != null && player.currentScreenHandler != player.playerScreenHandler) {
                player.closeHandledScreen();
            }
            LOGGER.info(
                "mine_nearby_iron.fieldkit_pickaxe_crafted instanceId={} commandId={} subCommandId={} reason={} recoveryAttempts={} cobblestoneAfter={} sticksAfter={}",
                instanceId,
                run.commandId,
                craftCommandId,
                reason,
                run.toolRecoveryAttempts,
                captureCraftInventory(player).cobblestone.cobblestoneCount(),
                captureCraftInventory(player).sticks.stickCount()
            );
            return new ControlDecision(stopFrom(effective, "mine_nearby_iron_fieldkit_pickaxe_crafted"), InputState.stop());
        }
        return craftDecision;
    }

    private ControlDecision resolveMineNearbyIronFieldKitAlcove(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        MineNearbyIronRun run,
        InventoryCounter.InventoryItemSnapshot rawIronInventory,
        long nowMs
    ) {
        if (findHotbarSlot(player, InventoryCounter::isStonePickaxeItemId) < 0) {
            return null;
        }
        if (!isFieldKitAlcoveUsable(client, player, run.fieldKitAlcoveCell)) {
            run.fieldKitAlcoveCell = selectFieldKitAlcoveCell(client, player, run);
            if (run.fieldKitAlcoveCell != null) {
                LOGGER.info(
                    "mine_nearby_iron.fieldkit_alcove_selected instanceId={} commandId={} cell={} support={} direction={}",
                    instanceId,
                    run.commandId,
                    run.fieldKitAlcoveCell.toShortString(),
                    run.fieldKitAlcoveCell.down().toShortString(),
                    run.prospectDirection == null ? "unknown" : run.prospectDirection.name()
                );
            }
        }
        if (run.fieldKitAlcoveCell == null) {
            return null;
        }
        BlockPos target = fieldKitAlcoveClearTarget(client, run.fieldKitAlcoveCell);
        if (target == null) {
            return null;
        }
        if (!isLookingAtBlock(player, target)) {
            return new ControlDecision(lookIntentForBlock(effective, player, target, "mine_nearby_iron_fieldkit_alcove_face"), InputState.stop());
        }
        String clearCommandId = run.commandId + ":neariron:fieldkit:alcove:" + target.toShortString();
        BlockBreakController.Result result = blockBreakController.tick(client, player, target, clearCommandId, nowMs);
        logBlockBreakResult(clearCommandId, target, result);
        LOGGER.info(
            "mine_nearby_iron.fieldkit_alcove_progress instanceId={} commandId={} target={} status={} reason={} hitBlock={} actedBlock={} elapsedMs={}",
            instanceId,
            run.commandId,
            target.toShortString(),
            result.status(),
            result.reason(),
            formatBlockPos(result.hitBlock()),
            formatBlockPos(result.actedBlock()),
            result.elapsedMs()
        );
        if (result.status() == BlockBreakController.Status.BROKEN) {
            run.prospectSettleUntilMs = nowMs + 150L;
            return new ControlDecision(stopFrom(effective, "mine_nearby_iron_fieldkit_alcove_cleared"), InputState.stop());
        }
        if (result.status() == BlockBreakController.Status.FAILED) {
            return failMineNearbyIron(effective, run, rawIronInventory, nowMs, "mine_nearby_iron_fieldkit_alcove_failed:" + result.reason());
        }
        if (result.status() == BlockBreakController.Status.REPOSITION) {
            run.fieldKitAlcoveCell = null;
            return new ControlDecision(stopFrom(effective, "mine_nearby_iron_fieldkit_alcove_reselect:" + result.reason()), InputState.stop());
        }
        return new ControlDecision(lookIntentForBlock(effective, player, target, "mine_nearby_iron_fieldkit_alcove_breaking:" + result.reason()), InputState.stop());
    }

    private BlockPos selectFieldKitAlcoveCell(MinecraftClient client, ClientPlayerEntity player, MineNearbyIronRun run) {
        if (client == null || client.world == null || player == null) {
            return null;
        }
        BlockPos feet = player.getBlockPos();
        List<StaircaseDescentPlanner.Direction2d> candidates = fieldKitAlcoveDirections(run.prospectDirection, player.getYaw());
        for (StaircaseDescentPlanner.Direction2d direction : candidates) {
            BlockPos cell = feet.add(direction.dx(), 0, direction.dz()).toImmutable();
            if (isFieldKitAlcoveUsable(client, player, cell)) {
                return cell;
            }
        }
        return null;
    }

    private List<StaircaseDescentPlanner.Direction2d> fieldKitAlcoveDirections(StaircaseDescentPlanner.Direction2d prospectDirection, float yaw) {
        if (prospectDirection == null) {
            int[] forward = cardinalOffset(yaw);
            prospectDirection = new StaircaseDescentPlanner.Direction2d(forward[0], forward[1], "yaw");
        }
        StaircaseDescentPlanner.Direction2d right = new StaircaseDescentPlanner.Direction2d(-prospectDirection.dz(), prospectDirection.dx(), "right");
        StaircaseDescentPlanner.Direction2d left = new StaircaseDescentPlanner.Direction2d(prospectDirection.dz(), -prospectDirection.dx(), "left");
        StaircaseDescentPlanner.Direction2d back = new StaircaseDescentPlanner.Direction2d(-prospectDirection.dx(), -prospectDirection.dz(), "back");
        return List.of(right, left, back);
    }

    private boolean isFieldKitAlcoveUsable(MinecraftClient client, ClientPlayerEntity player, BlockPos cell) {
        if (client == null || client.world == null || player == null || cell == null) {
            return false;
        }
        BlockPos support = cell.down();
        BlockState supportState = client.world.getBlockState(support);
        if (supportState.getCollisionShape(client.world, support).isEmpty() || isHazardBlockState(supportState)) {
            return false;
        }
        if (new Box(cell).intersects(player.getBoundingBox())) {
            return false;
        }
        if (!isFieldKitAlcoveClearable(client, cell) || !isFieldKitAlcoveClearable(client, cell.up())) {
            return false;
        }
        return firstAdjacentLavaBlock(client, cell) == null && firstAdjacentLavaBlock(client, cell.up()) == null;
    }

    private boolean isFieldKitAlcoveReady(MinecraftClient client, BlockPos cell) {
        if (client == null || client.world == null || cell == null) {
            return false;
        }
        BlockPos support = cell.down();
        BlockState supportState = client.world.getBlockState(support);
        return !supportState.getCollisionShape(client.world, support).isEmpty()
            && !isHazardBlockState(supportState)
            && fieldKitAlcoveCellReady(client.world.getBlockState(cell))
            && fieldKitAlcoveCellReady(client.world.getBlockState(cell.up()));
    }

    private boolean fieldKitAlcoveCellReady(BlockState state) {
        return state == null || state.isAir() || isReplaceablePlacementOccluder(state);
    }

    private BlockPos fieldKitAlcoveClearTarget(MinecraftClient client, BlockPos cell) {
        if (client == null || client.world == null || cell == null) {
            return null;
        }
        BlockPos head = cell.up();
        if (fieldKitAlcoveNeedsClearing(client.world.getBlockState(head))) {
            return head.toImmutable();
        }
        if (fieldKitAlcoveNeedsClearing(client.world.getBlockState(cell))) {
            return cell.toImmutable();
        }
        return null;
    }

    private boolean fieldKitAlcoveNeedsClearing(BlockState state) {
        return state != null && !state.isAir() && !isReplaceablePlacementOccluder(state);
    }

    private boolean isFieldKitAlcoveClearable(MinecraftClient client, BlockPos pos) {
        BlockState state = client.world.getBlockState(pos);
        return fieldKitAlcoveCellReady(state) || isProspectableIronMiningBlock(client, pos, state);
    }

    private BlockPos selectVisibleIronTarget(MinecraftClient client, ClientPlayerEntity player, Set<BlockPos> excluded) {
        BlockPos origin = player.getBlockPos();
        BlockPos currentSupport = origin.down();
        BlockPos best = null;
        double bestDistance = Double.MAX_VALUE;
        for (int dy = -2; dy <= 4; dy++) {
            for (int dx = -5; dx <= 5; dx++) {
                for (int dz = -5; dz <= 5; dz++) {
                    BlockPos candidate = origin.add(dx, dy, dz);
                    if (candidate.equals(currentSupport) || (excluded != null && excluded.contains(candidate))) {
                        continue;
                    }
                    if (!isIronOreBlock(client.world.getBlockState(candidate))) {
                        continue;
                    }
                    if (!visibleStoneTarget(client, player, candidate)) {
                        continue;
                    }
                    double distance = player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(candidate));
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = candidate.toImmutable();
                    }
                }
            }
        }
        return best;
    }

    private BlockPos selectVisibleIronProspectTarget(MinecraftClient client, ClientPlayerEntity player, Set<BlockPos> excluded) {
        BlockPos origin = player.getBlockPos();
        BlockPos currentSupport = origin.down();
        BlockPos best = null;
        double bestDistance = Double.MAX_VALUE;
        for (int dy = -1; dy <= 3; dy++) {
            for (int dx = -4; dx <= 4; dx++) {
                for (int dz = -4; dz <= 4; dz++) {
                    if (dx == 0 && dz == 0 && dy < 2) {
                        continue;
                    }
                    BlockPos candidate = origin.add(dx, dy, dz);
                    if (candidate.equals(currentSupport) || (excluded != null && excluded.contains(candidate))) {
                        continue;
                    }
                    BlockState state = client.world.getBlockState(candidate);
                    if (!isProspectableIronMiningBlock(client, candidate, state)) {
                        continue;
                    }
                    if (!visibleStoneTarget(client, player, candidate)) {
                        continue;
                    }
                    double distance = player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(candidate));
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = candidate.toImmutable();
                    }
                }
            }
        }
        return best;
    }

    private boolean isIronOreBlock(BlockState state) {
        return state != null && (state.isOf(Blocks.IRON_ORE) || state.isOf(Blocks.DEEPSLATE_IRON_ORE));
    }

    private boolean isProspectableIronMiningBlock(MinecraftClient client, BlockPos pos, BlockState state) {
        if (client == null || client.world == null || pos == null || state == null || state.isAir()) {
            return false;
        }
        if (!(state.isOf(Blocks.STONE)
            || state.isOf(Blocks.DEEPSLATE)
            || state.isOf(Blocks.TUFF)
            || state.isOf(Blocks.ANDESITE)
            || state.isOf(Blocks.DIORITE)
            || state.isOf(Blocks.GRANITE))) {
            return false;
        }
        if (isHazardBlockState(state)) {
            return false;
        }
        return firstAdjacentLavaBlock(client, pos) == null;
    }

    private BlockPos firstAdjacentLavaBlock(MinecraftClient client, BlockPos origin) {
        if (client == null || client.world == null || origin == null) {
            return null;
        }
        for (Direction direction : Direction.values()) {
            BlockPos adjacent = origin.offset(direction);
            if (isLavaBlockState(client.world.getBlockState(adjacent))) {
                return adjacent.toImmutable();
            }
        }
        return null;
    }

    private ControlDecision completeMineNearbyIron(
        BrainLink.Intent effective,
        MineNearbyIronRun run,
        InventoryCounter.InventoryItemSnapshot inventory,
        long nowMs,
        String reason
    ) {
        finishedMineNearbyIronCommandReasons.put(run.commandId, "mine_nearby_iron_complete:" + reason);
        LOGGER.info(
            "mine_nearby_iron.complete instanceId={} commandId={} reason={} inventoryRawIronBefore={} inventoryRawIronAfter={} targetDelta={} prospectBlocksBroken={} rawIronByItem={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            run.baselineRawIron,
            inventory.itemCount(),
            NEARBY_IRON_TARGET_RAW_IRON,
            run.prospectBlocksBroken,
            inventory.itemsByItem(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeMineNearbyIron = null;
        brainLink.completeCurrentCommand(run.commandId, "mine_nearby_iron_complete:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "mine_nearby_iron_complete:" + reason), InputState.stop());
    }

    private ControlDecision failMineNearbyIron(
        BrainLink.Intent effective,
        MineNearbyIronRun run,
        InventoryCounter.InventoryItemSnapshot inventory,
        long nowMs,
        String reason
    ) {
        finishedMineNearbyIronCommandReasons.put(run.commandId, "mine_nearby_iron_failed:" + reason);
        LOGGER.warn(
            "mine_nearby_iron.failed instanceId={} commandId={} reason={} inventoryRawIronBefore={} inventoryRawIronAfter={} prospectBlocksBroken={} target={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            run.baselineRawIron,
            inventory.itemCount(),
            run.prospectBlocksBroken,
            formatBlockPos(run.currentTarget),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeMineNearbyIron = null;
        brainLink.completeCurrentCommand(run.commandId, "mine_nearby_iron_failed:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "mine_nearby_iron_failed:" + reason), InputState.stop());
    }

    private ControlDecision resolveReturnStaircaseControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        return resolveReturnStaircaseControl(client, player, effective, nowMs, List.of());
    }

    private ControlDecision resolveReturnStaircaseControl(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        long nowMs,
        List<BlockPos> returnPath
    ) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        String finishedReason = finishedReturnStaircaseCommandReasons.get(commandId);
        if (finishedReason != null) {
            return new ControlDecision(stopFrom(effective, finishedReason), InputState.stop());
        }
        BlockPos target = targetBlockPos(effective);
        ReturnStaircasePlanner.Decision targetDecision = ReturnStaircasePlanner.decideTargetPresent(target != null);
        if (targetDecision.action() == ReturnStaircasePlanner.Action.FAIL_MISSING_TARGET) {
            finishedReturnStaircaseCommandReasons.put(commandId, targetDecision.reason());
            return new ControlDecision(stopFrom(effective, targetDecision.reason()), InputState.stop());
        }
        if (activeReturnStaircase == null || !commandId.equals(activeReturnStaircase.commandId)) {
            activeReturnStaircase = new ReturnStaircaseRun(commandId, target, nowMs, player.getHealth(), returnPath);
            LOGGER.info(
                "return_staircase.start instanceId={} commandId={} start={} target={} healthBefore={} breadcrumbCount={}",
                instanceId,
                commandId,
                player.getBlockPos().toShortString(),
                target.toShortString(),
                player.getHealth(),
                activeReturnStaircase.returnPath.size()
            );
        }
        ReturnStaircaseRun run = activeReturnStaircase;
        long timeoutMs = run.returnPath.isEmpty()
            ? RETURN_STAIRCASE_TIMEOUT_MS
            : Math.max(RETURN_STAIRCASE_TIMEOUT_MS, (long) run.returnPath.size() * RETURN_STAIRCASE_STEP_TIMEOUT_MS);
        ReturnStaircasePlanner.Decision preflightDecision = ReturnStaircasePlanner.decidePreflight(
            nowMs - run.startedAtMs,
            timeoutMs,
            run.healthBefore,
            player.getHealth()
        );
        if (preflightDecision.action() == ReturnStaircasePlanner.Action.FAIL_TIMEOUT
            || preflightDecision.action() == ReturnStaircasePlanner.Action.FAIL_HEALTH_LOST) {
            return failReturnStaircase(effective, run, player, nowMs, preflightDecision.reason());
        }
        double targetX = target.getX() + 0.5D;
        double targetZ = target.getZ() + 0.5D;
        double distance = Math.hypot(targetX - player.getX(), targetZ - player.getZ());
        ReturnStaircasePlanner.Decision surfaceDecision = ReturnStaircasePlanner.decideSurfaceReached(
            distance,
            Math.floor(player.getY()),
            target.getY()
        );
        if (surfaceDecision.action() == ReturnStaircasePlanner.Action.COMPLETE_SURFACE_REACHED) {
            finishedReturnStaircaseCommandReasons.put(commandId, surfaceDecision.reason());
            LOGGER.info(
                "return_staircase.complete instanceId={} commandId={} target={} final={} healthBefore={} healthAfter={} elapsedMs={}",
                instanceId,
                commandId,
                target.toShortString(),
                player.getBlockPos().toShortString(),
                run.healthBefore,
                player.getHealth(),
                Math.max(0L, nowMs - run.startedAtMs)
            );
            activeReturnStaircase = null;
            brainLink.completeCurrentCommand(commandId, surfaceDecision.reason(), nowMs);
            return new ControlDecision(stopFrom(effective, surfaceDecision.reason()), InputState.stop());
        }
        if (!run.returnPath.isEmpty()) {
            return resolveReturnStaircaseBreadcrumbControl(player, effective, run, nowMs);
        }
        double dx = targetX - player.getX();
        double dz = targetZ - player.getZ();
        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        BrainLink.Intent intent = lookIntentForAngles(effective, yaw, 0.0D, "return_staircase_move");
        InputState input = new InputState(true, false, false, false, true, false, 1.0F, 0.0F);
        return new ControlDecision(intent, input);
    }

    private ControlDecision resolveReturnStaircaseBreadcrumbControl(ClientPlayerEntity player, BrainLink.Intent effective, ReturnStaircaseRun run, long nowMs) {
        ReturnStaircasePlanner.Decision pathDecision = ReturnStaircasePlanner.decideBreadcrumbPathSize(run.returnPath.size());
        if (pathDecision.action() == ReturnStaircasePlanner.Action.FAIL_BREADCRUMB_PATH_TOO_SHORT) {
            return failReturnStaircase(effective, run, player, nowMs, pathDecision.reason());
        }
        if (run.waypointIndex < 0) {
            int nearestIndex = nearestReturnPathIndex(player, run.returnPath);
            boolean nearestReached = reachedReturnWaypoint(player, run.returnPath.get(nearestIndex));
            run.waypointIndex = ReturnStaircasePlanner.initialWaypointIndex(nearestIndex, nearestReached, run.returnPath.size());
            run.progressWaypointIndex = -1;
            LOGGER.info(
                "return_staircase.breadcrumb_start instanceId={} commandId={} nearestIndex={} firstTargetIndex={} pathCount={} current={} target={}",
                instanceId,
                run.commandId,
                nearestIndex,
                run.waypointIndex,
                run.returnPath.size(),
                player.getBlockPos().toShortString(),
                run.returnPath.get(run.waypointIndex).toShortString()
            );
        }

        BlockPos waypoint = run.returnPath.get(Math.max(0, Math.min(run.waypointIndex, run.returnPath.size() - 1)));
        int nextWaypointIndex = Math.max(0, run.waypointIndex - 1);
        ReturnStaircasePlanner.Decision reachedDecision = ReturnStaircasePlanner.decideWaypointReached(
            reachedReturnWaypoint(player, waypoint),
            nextWaypointIndex
        );
        if (reachedDecision.action() == ReturnStaircasePlanner.Action.BREADCRUMB_REACHED) {
            LOGGER.info(
                "return_staircase.breadcrumb_reached instanceId={} commandId={} waypointIndex={} waypoint={} current={}",
                instanceId,
                run.commandId,
                run.waypointIndex,
                waypoint.toShortString(),
                player.getBlockPos().toShortString()
            );
            run.waypointIndex = nextWaypointIndex;
            run.progressWaypointIndex = -1;
            return new ControlDecision(stopFrom(effective, reachedDecision.reason()), InputState.stop());
        }

        double distanceSq = returnWaypointDistanceSq(player, waypoint);
        ReturnStaircasePlanner.Decision progressDecision = ReturnStaircasePlanner.decideWaypointProgress(
            run.progressWaypointIndex,
            run.waypointIndex,
            distanceSq,
            run.bestWaypointDistanceSq,
            nowMs - run.lastWaypointProgressMs,
            RETURN_STAIRCASE_WAYPOINT_STUCK_MS
        );
        if (progressDecision.action() == ReturnStaircasePlanner.Action.RECORD_BREADCRUMB_PROGRESS) {
            run.progressWaypointIndex = run.waypointIndex;
            run.bestWaypointDistanceSq = distanceSq;
            run.lastWaypointProgressMs = nowMs;
        } else if (progressDecision.action() == ReturnStaircasePlanner.Action.FAIL_BREADCRUMB_STUCK) {
            return failReturnStaircase(
                effective,
                run,
                player,
                nowMs,
                "return_staircase_breadcrumb_stuck:" + run.waypointIndex + ":" + waypoint.toShortString()
            );
        }

        double dx = (waypoint.getX() + 0.5D) - player.getX();
        double dz = (waypoint.getZ() + 0.5D) - player.getZ();
        double horizontalDistanceSq = (dx * dx) + (dz * dz);
        boolean uphillStep = waypoint.getY() > Math.floor(player.getY());
        boolean jump = ReturnStaircasePlanner.shouldJumpToWaypoint(
            uphillStep,
            player.isOnGround(),
            horizontalDistanceSq,
            RETURN_STAIRCASE_JUMP_DISTANCE_BLOCKS
        );

        if (run.lastLoggedWaypointIndex != run.waypointIndex || nowMs - run.lastWaypointLogMs > 1_000L) {
            LOGGER.info(
                "return_staircase.breadcrumb_target instanceId={} commandId={} waypointIndex={} pathCount={} waypoint={} current={} distance={} jump={}",
                instanceId,
                run.commandId,
                run.waypointIndex,
                run.returnPath.size(),
                waypoint.toShortString(),
                player.getBlockPos().toShortString(),
                roundForLog(Math.sqrt(distanceSq)),
                jump
            );
            run.lastLoggedWaypointIndex = run.waypointIndex;
            run.lastWaypointLogMs = nowMs;
        }

        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        BrainLink.Intent intent = lookIntentForAngles(effective, yaw, 0.0D, "return_staircase_breadcrumb_move:" + run.waypointIndex);
        InputState input = new InputState(true, false, false, false, jump, false, 1.0F, 0.0F);
        return new ControlDecision(intent, input);
    }

    private int nearestReturnPathIndex(ClientPlayerEntity player, List<BlockPos> path) {
        int bestIndex = Math.max(0, path.size() - 1);
        double bestDistanceSq = Double.POSITIVE_INFINITY;
        for (int index = 0; index < path.size(); index++) {
            double distanceSq = returnWaypointDistanceSq(player, path.get(index));
            if (distanceSq < bestDistanceSq) {
                bestDistanceSq = distanceSq;
                bestIndex = index;
            }
        }
        return bestIndex;
    }

    private double returnWaypointDistanceSq(ClientPlayerEntity player, BlockPos waypoint) {
        double dx = (waypoint.getX() + 0.5D) - player.getX();
        double dz = (waypoint.getZ() + 0.5D) - player.getZ();
        double dy = waypoint.getY() - player.getY();
        return dx * dx + dz * dz + dy * dy;
    }

    private boolean reachedReturnWaypoint(ClientPlayerEntity player, BlockPos waypoint) {
        double dx = (waypoint.getX() + 0.5D) - player.getX();
        double dz = (waypoint.getZ() + 0.5D) - player.getZ();
        return Math.hypot(dx, dz) <= 0.65D && Math.floor(player.getY()) >= waypoint.getY();
    }

    private ControlDecision failReturnStaircase(BrainLink.Intent effective, ReturnStaircaseRun run, ClientPlayerEntity player, long nowMs, String reason) {
        finishedReturnStaircaseCommandReasons.put(run.commandId, "return_staircase_failed:" + reason);
        LOGGER.warn(
            "return_staircase.failed instanceId={} commandId={} reason={} target={} final={} healthBefore={} healthAfter={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            run.target.toShortString(),
            player.getBlockPos().toShortString(),
            run.healthBefore,
            player.getHealth(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeReturnStaircase = null;
        brainLink.completeCurrentCommand(run.commandId, "return_staircase_failed:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "return_staircase_failed:" + reason), InputState.stop());
    }

    private ControlDecision resolveR2MineStoneReturnControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        String finishedReason = finishedR2MineStoneReturnCommandReasons.get(commandId);
        if (finishedReason != null) {
            return new ControlDecision(stopFrom(effective, finishedReason), InputState.stop());
        }

        if (activeR2MineStoneReturn == null || !commandId.equals(activeR2MineStoneReturn.commandId)) {
            BlockPos startFeet = player.getBlockPos().toImmutable();
            int depth = resolveDescentDepth(effective, startFeet.getY());
            StaircaseDescentPlanner.Direction2d direction = resolveDescentDirection(effective, startFeet, player.getYaw());
            activeR2MineStoneReturn = new R2MineStoneReturnRun(commandId, startFeet, direction, depth, nowMs, player.getHealth());
            LOGGER.info(
                "r2_mine_stone_return.start instanceId={} commandId={} start={} direction={} depth={} healthBefore={} targetY={}",
                instanceId,
                commandId,
                startFeet.toShortString(),
                direction.name(),
                depth,
                player.getHealth(),
                startFeet.getY() - depth
            );
        }

        R2MineStoneReturnRun run = activeR2MineStoneReturn;
        if (nowMs - run.startedAtMs > R2_MINE_STONE_RETURN_TIMEOUT_MS) {
            return failR2MineStoneReturn(effective, run, player, nowMs, "r2_mine_stone_return_timeout");
        }
        if (player.getHealth() + 0.1F < run.healthBefore) {
            return failR2MineStoneReturn(effective, run, player, nowMs, "r2_mine_stone_return_health_lost");
        }

        if (run.phase == R2MineStoneReturnPhase.DESCEND) {
            BlockPos target = run.descentTarget();
            BrainLink.Intent subIntent = phaseIntent(effective, "descend_staircase", target, "r2_descend_staircase", run.commandId + ":descend");
            ControlDecision decision = resolveDescendStaircaseControl(client, player, subIntent, nowMs);
            String reason = decision.intent().reason();
            if (reason != null && reason.startsWith("descent_complete:")) {
                run.phase = R2MineStoneReturnPhase.MINE;
                LOGGER.info(
                    "r2_mine_stone_return.phase instanceId={} commandId={} phase=mine cobblestoneBaseline={} elapsedMs={}",
                    instanceId,
                    run.commandId,
                    InventoryCounter.countPlayerCobblestone(player).cobblestoneCount(),
                    Math.max(0L, nowMs - run.startedAtMs)
                );
                return new ControlDecision(stopFrom(effective, "r2_phase_mine"), InputState.stop());
            }
            if (reason != null && reason.startsWith("descent_failed:")) {
                return failR2MineStoneReturn(effective, run, player, nowMs, reason);
            }
            return decision;
        }

        if (run.phase == R2MineStoneReturnPhase.MINE) {
            BrainLink.Intent subIntent = phaseIntent(effective, "mine_nearby_stone", null, "r2_mine_nearby_stone", run.commandId + ":mine");
            ControlDecision decision = resolveMineNearbyStoneControl(client, player, subIntent, nowMs);
            String reason = decision.intent().reason();
            if (reason != null && reason.startsWith("mine_nearby_stone_complete:")) {
                run.phase = R2MineStoneReturnPhase.RETURN;
                LOGGER.info(
                    "r2_mine_stone_return.phase instanceId={} commandId={} phase=return cobblestone={} elapsedMs={}",
                    instanceId,
                    run.commandId,
                    InventoryCounter.countPlayerCobblestone(player).cobblestoneCount(),
                    Math.max(0L, nowMs - run.startedAtMs)
                );
                return new ControlDecision(stopFrom(effective, "r2_phase_return"), InputState.stop());
            }
            if (reason != null && reason.startsWith("mine_nearby_stone_failed:")) {
                return failR2MineStoneReturn(effective, run, player, nowMs, reason);
            }
            return decision;
        }

        BrainLink.Intent subIntent = phaseIntent(effective, "return_staircase", run.startFeet, "r2_return_staircase", run.commandId + ":return");
        ControlDecision decision = resolveReturnStaircaseControl(client, player, subIntent, nowMs);
        String reason = decision.intent().reason();
        if (reason != null && reason.startsWith("return_staircase_complete:")) {
            return completeR2MineStoneReturn(effective, run, player, nowMs, reason);
        }
        if (reason != null && reason.startsWith("return_staircase_failed:")) {
            return failR2MineStoneReturn(effective, run, player, nowMs, reason);
        }
        return decision;
    }

    private BrainLink.Intent phaseIntent(BrainLink.Intent source, String action, BlockPos target, String reason, String commandId) {
        return new BrainLink.Intent(
            action,
            false,
            false,
            false,
            false,
            false,
            false,
            null,
            null,
            target == null ? null : (double) target.getX(),
            target == null ? null : (double) target.getY(),
            target == null ? null : (double) target.getZ(),
            List.of(),
            List.of(),
            null,
            List.of(),
            source.expiresAtMs(),
            reason,
            commandId
        );
    }

    private ControlDecision completeR2MineStoneReturn(BrainLink.Intent effective, R2MineStoneReturnRun run, ClientPlayerEntity player, long nowMs, String reason) {
        finishedR2MineStoneReturnCommandReasons.put(run.commandId, "r2_mine_stone_return_complete:" + reason);
        InventoryCounter.InventoryCobblestoneSnapshot inventory = InventoryCounter.countPlayerCobblestone(player);
        LOGGER.info(
            "r2_mine_stone_return.complete instanceId={} commandId={} reason={} start={} final={} depth={} healthBefore={} healthAfter={} cobblestone={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            run.startFeet.toShortString(),
            player.getBlockPos().toShortString(),
            run.depth,
            run.healthBefore,
            player.getHealth(),
            inventory.cobblestoneCount(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeR2MineStoneReturn = null;
        brainLink.completeCurrentCommand(run.commandId, "r2_mine_stone_return_complete:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "r2_mine_stone_return_complete:" + reason), InputState.stop());
    }

    private ControlDecision failR2MineStoneReturn(BrainLink.Intent effective, R2MineStoneReturnRun run, ClientPlayerEntity player, long nowMs, String reason) {
        finishedR2MineStoneReturnCommandReasons.put(run.commandId, "r2_mine_stone_return_failed:" + reason);
        LOGGER.warn(
            "r2_mine_stone_return.failed instanceId={} commandId={} reason={} phase={} start={} final={} healthBefore={} healthAfter={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            run.phase,
            run.startFeet.toShortString(),
            player.getBlockPos().toShortString(),
            run.healthBefore,
            player.getHealth(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeR2MineStoneReturn = null;
        brainLink.completeCurrentCommand(run.commandId, "r2_mine_stone_return_failed:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "r2_mine_stone_return_failed:" + reason), InputState.stop());
    }

    private ControlDecision resolveR5IronChainControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        String finishedReason = finishedR5IronChainCommandReasons.get(commandId);
        if (finishedReason != null) {
            return new ControlDecision(stopFrom(effective, finishedReason), InputState.stop());
        }

        if (activeR5IronChain == null || !commandId.equals(activeR5IronChain.commandId)) {
            BlockPos startFeet = player.getBlockPos().toImmutable();
            int depth = resolveDescentDepth(effective, startFeet.getY());
            StaircaseDescentPlanner.Direction2d direction = resolveDescentDirection(effective, startFeet, player.getYaw());
            CraftInventorySnapshot inventory = captureCraftInventory(player);
            activeR5IronChain = new R5IronChainRun(commandId, startFeet, direction, depth, inventory, nowMs, player.getHealth());
            LOGGER.info(
                "r5_iron_chain.start instanceId={} commandId={} start={} direction={} depth={} target={} healthBefore={} rawIronBefore={} ironIngotsBefore={} ironPickaxesBefore={} stonePickaxes={} tables={} furnaces={} sticks={} charcoal={} coal={}",
                instanceId,
                commandId,
                startFeet.toShortString(),
                direction.name(),
                depth,
                activeR5IronChain.descentTarget().toShortString(),
                player.getHealth(),
                inventory.rawIron.itemCount(),
                inventory.ironIngots.itemCount(),
                inventory.ironPickaxes.itemCount(),
                inventory.stonePickaxes.itemCount(),
                inventory.tables.craftingTableCount(),
                inventory.furnaces.itemCount(),
                inventory.sticks.stickCount(),
                inventory.charcoal.itemCount(),
                inventory.coal.itemCount()
            );
            String preconditionFailure = validateR5IronChainStart(inventory);
            if (preconditionFailure != null) {
                return failR5IronChain(effective, activeR5IronChain, player, nowMs, preconditionFailure);
            }
        }

        R5IronChainRun run = activeR5IronChain;
        if (nowMs - run.startedAtMs > R5_IRON_CHAIN_TIMEOUT_MS) {
            return failR5IronChain(effective, run, player, nowMs, "r5_iron_chain_timeout");
        }
        if (player.getHealth() + 0.1F < run.healthBefore) {
            return failR5IronChain(effective, run, player, nowMs, "r5_iron_chain_health_lost");
        }

        CraftInventorySnapshot inventory = captureCraftInventory(player);
        if (inventory.ironPickaxes.itemCount() - run.baselineIronPickaxes >= 1) {
            return completeR5IronChain(effective, run, player, inventory, nowMs, "r5_iron_pickaxe_typed_delta_verified");
        }

        if (run.phase == R5IronChainPhase.DESCEND) {
            ControlDecision decision = resolveDescendStaircaseControl(
                client,
                player,
                phaseIntent(effective, "descend_staircase", run.descentTarget(), "r5_iron_chain_descend", run.descentCommandId()),
                nowMs
            );
            String reason = decision.intent().reason();
            if (reason != null && reason.startsWith("descent_complete:")) {
                run.returnPath = completedDescentPaths.getOrDefault(run.descentCommandId(), List.of());
                LOGGER.info(
                    "r5_iron_chain.return_path instanceId={} commandId={} pathCount={} start={} end={}",
                    instanceId,
                    run.commandId,
                    run.returnPath.size(),
                    run.returnPath.isEmpty() ? "none" : run.returnPath.get(0).toShortString(),
                    run.returnPath.isEmpty() ? "none" : run.returnPath.get(run.returnPath.size() - 1).toShortString()
                );
                transitionR5IronChainPhase(run, R5IronChainPhase.MINE_IRON, player, inventory, nowMs, reason);
                return new ControlDecision(stopFrom(effective, "r5_iron_chain_phase_mine_iron"), InputState.stop());
            }
            if (reason != null && reason.startsWith("descent_failed:")) {
                return failR5IronChain(effective, run, player, nowMs, reason);
            }
            return decision;
        }

        if (run.phase == R5IronChainPhase.MINE_IRON) {
            ControlDecision fixtureDecision = maybePlaceR5EndpointIronFixture(client, player, effective, run, nowMs);
            if (fixtureDecision != null) {
                return fixtureDecision;
            }
            ControlDecision decision = resolveMineNearbyIronControl(
                client,
                player,
                phaseIntent(effective, "mine_nearby_iron", run.descentTarget(), "r5_iron_chain_mine_iron", run.mineIronCommandId()),
                nowMs
            );
            String reason = decision.intent().reason();
            if (reason != null && reason.startsWith("mine_nearby_iron_complete:")) {
                CraftInventorySnapshot afterMine = captureCraftInventory(player);
                if (afterMine.rawIron.itemCount() - run.baselineRawIron < 3) {
                    return failR5IronChain(effective, run, player, nowMs, "r5_iron_chain_raw_iron_delta_short");
                }
                transitionR5IronChainPhase(run, R5IronChainPhase.RETURN_SURFACE, player, afterMine, nowMs, reason);
                return new ControlDecision(stopFrom(effective, "r5_iron_chain_phase_return_surface"), InputState.stop());
            }
            if (reason != null && reason.startsWith("mine_nearby_iron_failed:")) {
                CraftInventorySnapshot afterMineFailure = captureCraftInventory(player);
                if (afterMineFailure.rawIron.itemCount() - run.baselineRawIron >= 3) {
                    transitionR5IronChainPhase(run, R5IronChainPhase.RETURN_SURFACE, player, afterMineFailure, nowMs, reason + ":raw_iron_total_satisfied");
                    return new ControlDecision(stopFrom(effective, "r5_iron_chain_phase_return_surface"), InputState.stop());
                }
                return failR5IronChain(effective, run, player, nowMs, reason);
            }
            return decision;
        }

        if (run.phase == R5IronChainPhase.RETURN_SURFACE) {
            ControlDecision decision = resolveReturnStaircaseControl(
                client,
                player,
                phaseIntent(effective, "return_staircase", run.startFeet, "r5_iron_chain_return", run.returnCommandId()),
                nowMs,
                run.returnPath
            );
            String reason = decision.intent().reason();
            if (reason != null && reason.startsWith("return_staircase_complete:")) {
                transitionR5IronChainPhase(run, R5IronChainPhase.PLACE_TABLE, player, captureCraftInventory(player), nowMs, reason);
                return new ControlDecision(stopFrom(effective, "r5_iron_chain_phase_place_table"), InputState.stop());
            }
            if (reason != null && reason.startsWith("return_staircase_failed:")) {
                return failR5IronChain(effective, run, player, nowMs, reason);
            }
            return decision;
        }

        if (run.phase == R5IronChainPhase.PLACE_TABLE) {
            ControlDecision decision = resolvePlaceTableControl(
                client,
                player,
                makeSubIntent(effective, "place_table", run.placeTableCommandId(), "r5_iron_chain_place_table"),
                nowMs
            );
            String reason = decision.intent().reason();
            if (reason != null && reason.startsWith("place_table_complete:")) {
                transitionR5IronChainPhase(run, R5IronChainPhase.PLACE_FURNACE, player, captureCraftInventory(player), nowMs, reason);
                return new ControlDecision(stopFrom(effective, "r5_iron_chain_phase_place_furnace"), InputState.stop());
            }
            if (reason != null && reason.startsWith("place_table_failed:")) {
                return failR5IronChain(effective, run, player, nowMs, reason);
            }
            return decision;
        }

        if (run.phase == R5IronChainPhase.PLACE_FURNACE) {
            ControlDecision decision = resolvePlaceFurnaceControl(
                client,
                player,
                makeSubIntent(effective, "place_furnace", run.placeFurnaceCommandId(), "r5_iron_chain_place_furnace"),
                nowMs
            );
            String reason = decision.intent().reason();
            if (reason != null && reason.startsWith("place_furnace_complete:")) {
                transitionR5IronChainPhase(run, R5IronChainPhase.SMELT_RAW_IRON, player, captureCraftInventory(player), nowMs, reason);
                return new ControlDecision(stopFrom(effective, "r5_iron_chain_phase_smelt_raw_iron"), InputState.stop());
            }
            if (reason != null && reason.startsWith("place_furnace_failed:")) {
                return failR5IronChain(effective, run, player, nowMs, reason);
            }
            return decision;
        }

        if (run.phase == R5IronChainPhase.SMELT_RAW_IRON) {
            int ironIngotDelta = inventory.ironIngots.itemCount() - run.baselineIronIngots;
            if (ironIngotDelta >= 3) {
                if (player.currentScreenHandler != null && player.currentScreenHandler != player.playerScreenHandler) {
                    String handler = player.currentScreenHandler.getClass().getSimpleName();
                    player.closeHandledScreen();
                    LOGGER.info(
                        "r5_iron_chain.close_screen instanceId={} commandId={} reason=before_craft handler={}",
                        instanceId,
                        run.commandId,
                        handler
                    );
                    return new ControlDecision(stopFrom(effective, "r5_iron_chain_close_screen_before_craft"), InputState.stop());
                }
                transitionR5IronChainPhase(run, R5IronChainPhase.CRAFT_IRON_PICKAXE, player, inventory, nowMs, "iron_ingots_ready");
                return new ControlDecision(stopFrom(effective, "r5_iron_chain_phase_craft_iron_pickaxe"), InputState.stop());
            }
            ControlDecision decision = resolveSmeltCharcoalControl(
                client,
                player,
                makeSubIntent(effective, "smelt_raw_iron", run.smeltRawIronCommandId(), "r5_iron_chain_smelt_raw_iron"),
                nowMs
            );
            String reason = decision.intent().reason();
            if (reason != null && reason.startsWith("smelt_raw_iron_complete:")) {
                run.smeltAttempts++;
                return new ControlDecision(stopFrom(effective, "r5_iron_chain_smelt_raw_iron_complete"), InputState.stop());
            }
            if (reason != null && reason.startsWith("smelt_raw_iron_failed:")) {
                return failR5IronChain(effective, run, player, nowMs, reason);
            }
            return decision;
        }

        if (run.phase == R5IronChainPhase.CRAFT_IRON_PICKAXE) {
            if (player.currentScreenHandler != null
                && player.currentScreenHandler != player.playerScreenHandler
                && !(player.currentScreenHandler instanceof CraftingScreenHandler)) {
                String handler = player.currentScreenHandler.getClass().getSimpleName();
                player.closeHandledScreen();
                LOGGER.info(
                    "r5_iron_chain.close_screen instanceId={} commandId={} reason=before_craft handler={}",
                    instanceId,
                    run.commandId,
                    handler
                );
                return new ControlDecision(stopFrom(effective, "r5_iron_chain_close_screen_before_craft"), InputState.stop());
            }
            ControlDecision decision = resolveCraft3x3Control(
                client,
                player,
                makeSubIntent(effective, "craft_iron_pickaxe", run.craftIronPickaxeCommandId(), "r5_iron_chain_craft_iron_pickaxe"),
                nowMs
            );
            String reason = decision.intent().reason();
            if (reason != null && reason.startsWith("craft_iron_pickaxe_complete:")) {
                return completeR5IronChain(effective, run, player, captureCraftInventory(player), nowMs, reason);
            }
            if (reason != null && reason.startsWith("craft_iron_pickaxe_failed:")) {
                return failR5IronChain(effective, run, player, nowMs, reason);
            }
            return decision;
        }

        return failR5IronChain(effective, run, player, nowMs, "r5_iron_chain_unknown_phase");
    }

    private ControlDecision maybePlaceR5EndpointIronFixture(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        R5IronChainRun run,
        long nowMs
    ) {
        if (run.endpointFixturePlaced) {
            if (nowMs < run.endpointFixtureSettleUntilMs) {
                return new ControlDecision(stopFrom(effective, "r5_iron_chain_fixture_settle"), InputState.stop());
            }
            return null;
        }
        if (!client.isIntegratedServerRunning() || client.getServer() == null) {
            return failR5IronChain(effective, run, player, nowMs, "r5_iron_chain_fixture_no_integrated_server");
        }

        List<BlockPos> fixturePositions = selectR5EndpointIronFixturePositions(client, player);
        if (fixturePositions.isEmpty()) {
            return failR5IronChain(effective, run, player, nowMs, "r5_iron_chain_fixture_no_safe_positions");
        }

        MinecraftServer server = client.getServer();
        List<BlockPos> immutablePositions = fixturePositions.stream().map(BlockPos::toImmutable).toList();
        run.endpointFixturePlaced = true;
        run.endpointFixturePositions = immutablePositions;
        run.endpointFixtureSettleUntilMs = nowMs + R5_IRON_CHAIN_FIXTURE_SETTLE_MS;
        server.execute(() -> {
            ServerCommandSource source = server.getCommandSource().withSilent();
            for (BlockPos pos : immutablePositions) {
                String command = "/setblock " + pos.getX() + " " + pos.getY() + " " + pos.getZ() + " minecraft:iron_ore replace";
                LOGGER.info("r5_iron_chain.fixture_command instanceId={} commandId={} command={}", instanceId, run.commandId, command);
                server.getCommandManager().executeWithPrefix(source, command);
            }
        });
        LOGGER.info(
            "r5_iron_chain.fixture_placed instanceId={} commandId={} endpoint={} positions={} rawIronBefore={} elapsedMs={}",
            instanceId,
            run.commandId,
            player.getBlockPos().toShortString(),
            formatBlockPositions(immutablePositions),
            captureCraftInventory(player).rawIron.itemCount(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        return new ControlDecision(stopFrom(effective, "r5_iron_chain_fixture_placed"), InputState.stop());
    }

    private List<BlockPos> selectR5EndpointIronFixturePositions(MinecraftClient client, ClientPlayerEntity player) {
        if (client == null || client.world == null || player == null) {
            return List.of();
        }
        BlockPos feet = player.getBlockPos();
        Direction facing = player.getHorizontalFacing();
        Direction[] preferred = new Direction[] {
            facing.rotateYClockwise(),
            facing.rotateYCounterclockwise(),
            facing,
            facing.getOpposite()
        };
        for (Direction direction : preferred) {
            List<BlockPos> positions = List.of(
                feet.offset(direction),
                feet.offset(direction).up(),
                feet.offset(direction, 2),
                feet.offset(direction, 2).up()
            );
            if (positions.stream().allMatch(pos -> isSafeR5EndpointFixturePosition(client, feet, pos))) {
                return positions;
            }
        }
        return List.of();
    }

    private boolean isSafeR5EndpointFixturePosition(MinecraftClient client, BlockPos feet, BlockPos pos) {
        if (client == null || client.world == null || feet == null || pos == null) {
            return false;
        }
        if (pos.equals(feet) || pos.equals(feet.up()) || pos.equals(feet.down())) {
            return false;
        }
        BlockState state = client.world.getBlockState(pos);
        if (isHazardBlockState(state) || firstAdjacentLavaBlock(client, pos) != null) {
            return false;
        }
        return true;
    }

    private String formatBlockPositions(List<BlockPos> positions) {
        if (positions == null || positions.isEmpty()) {
            return "[]";
        }
        List<String> formatted = new ArrayList<>();
        for (BlockPos pos : positions) {
            formatted.add(pos.toShortString());
        }
        return "[" + String.join(";", formatted) + "]";
    }

    private String validateR5IronChainStart(CraftInventorySnapshot inventory) {
        if (inventory.stonePickaxes.itemCount() < 4) {
            return "r5_iron_chain_need_four_stone_pickaxes";
        }
        if (inventory.tables.craftingTableCount() < 1) {
            return "r5_iron_chain_no_crafting_table";
        }
        if (inventory.furnaces.itemCount() < 1) {
            return "r5_iron_chain_no_furnace";
        }
        if (inventory.sticks.stickCount() < 2) {
            return "r5_iron_chain_no_sticks";
        }
        if (smeltFuelCount(inventory) < 3) {
            return "r5_iron_chain_no_fuel";
        }
        if (inventory.rawIron.itemCount() > 0 || inventory.ironIngots.itemCount() > 0 || inventory.ironPickaxes.itemCount() > 0) {
            return "r5_iron_chain_iron_inventory_not_empty";
        }
        return null;
    }

    private void transitionR5IronChainPhase(R5IronChainRun run, R5IronChainPhase phase, ClientPlayerEntity player, CraftInventorySnapshot inventory, long nowMs, String reason) {
        run.phase = phase;
        LOGGER.info(
            "r5_iron_chain.phase instanceId={} commandId={} phase={} reason={} final={} rawIron={} ironIngots={} ironPickaxes={} elapsedMs={}",
            instanceId,
            run.commandId,
            phase.name().toLowerCase(Locale.ROOT),
            reason,
            player.getBlockPos().toShortString(),
            inventory.rawIron.itemCount(),
            inventory.ironIngots.itemCount(),
            inventory.ironPickaxes.itemCount(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
    }

    private ControlDecision completeR5IronChain(BrainLink.Intent effective, R5IronChainRun run, ClientPlayerEntity player, CraftInventorySnapshot inventory, long nowMs, String reason) {
        finishedR5IronChainCommandReasons.put(run.commandId, "r5_iron_chain_complete:" + reason);
        LOGGER.info(
            "r5_iron_chain.complete instanceId={} commandId={} reason={} start={} final={} depth={} healthBefore={} healthAfter={} rawIronBefore={} rawIronAfter={} ironIngotsBefore={} ironIngotsAfter={} ironPickaxesBefore={} ironPickaxesAfter={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            run.startFeet.toShortString(),
            player.getBlockPos().toShortString(),
            run.depth,
            run.healthBefore,
            player.getHealth(),
            run.baselineRawIron,
            inventory.rawIron.itemCount(),
            run.baselineIronIngots,
            inventory.ironIngots.itemCount(),
            run.baselineIronPickaxes,
            inventory.ironPickaxes.itemCount(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeR5IronChain = null;
        brainLink.completeCurrentCommand(run.commandId, "r5_iron_chain_complete:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "r5_iron_chain_complete:" + reason), InputState.stop());
    }

    private ControlDecision failR5IronChain(BrainLink.Intent effective, R5IronChainRun run, ClientPlayerEntity player, long nowMs, String reason) {
        CraftInventorySnapshot inventory = captureCraftInventory(player);
        finishedR5IronChainCommandReasons.put(run.commandId, "r5_iron_chain_failed:" + reason);
        LOGGER.warn(
            "r5_iron_chain.failed instanceId={} commandId={} reason={} phase={} start={} final={} healthBefore={} healthAfter={} rawIronBefore={} rawIronAfter={} ironIngotsBefore={} ironIngotsAfter={} ironPickaxesBefore={} ironPickaxesAfter={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            run.phase,
            run.startFeet.toShortString(),
            player.getBlockPos().toShortString(),
            run.healthBefore,
            player.getHealth(),
            run.baselineRawIron,
            inventory.rawIron.itemCount(),
            run.baselineIronIngots,
            inventory.ironIngots.itemCount(),
            run.baselineIronPickaxes,
            inventory.ironPickaxes.itemCount(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeR5IronChain = null;
        brainLink.completeCurrentCommand(run.commandId, "r5_iron_chain_failed:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "r5_iron_chain_failed:" + reason), InputState.stop());
    }

    private ControlDecision resolveGatherTreeControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (completedGatherTreeCommandIds.contains(commandId)) {
            return new ControlDecision(stopFrom(effective, "gather_tree_complete"), InputState.stop());
        }
        BlockPos seed = targetBlockPos(effective);
        if (seed == null) {
            completedGatherTreeCommandIds.add(commandId);
            return new ControlDecision(stopFrom(effective, "gather_tree_missing_target"), InputState.stop());
        }
        if (activeGatherTree == null || !commandId.equals(activeGatherTree.commandId)) {
            InventoryCounter.InventoryLogSnapshot inventory = InventoryCounter.countPlayerLogs(player);
            Set<BlockPos> cluster = discoverTreeLogCluster(client.world, seed);
            activeGatherTree = new GatherTreeRun(commandId, seed, inventory.logCount(), nowMs, cluster);
            LOGGER.info(
                "gather_tree.start instanceId={} commandId={} seed={} inventoryLogsBefore={} clusterSize={} logsByItem={}",
                instanceId,
                commandId,
                seed.toShortString(),
                inventory.logCount(),
                cluster.size(),
                inventory.logsByItem()
            );
            if (inventory.logCount() != 0) {
                completedGatherTreeCommandIds.add(commandId);
                activeGatherTree = null;
                return new ControlDecision(stopFrom(effective, "gather_tree_start_logs_not_zero"), InputState.stop());
            }
            if (cluster.isEmpty()) {
                completedGatherTreeCommandIds.add(commandId);
                activeGatherTree = null;
                return new ControlDecision(stopFrom(effective, "gather_tree_seed_not_log"), InputState.stop());
            }
        }

        GatherTreeRun run = activeGatherTree;
        InventoryCounter.InventoryLogSnapshot inventory = InventoryCounter.countPlayerLogs(player);
        if (run.currentTarget != null && inventory.logCount() > run.lastVerifiedLogCount) {
            run.completedTargets.add(run.currentTarget);
            int delta = inventory.logCount() - run.lastVerifiedLogCount;
            run.lastVerifiedLogCount = inventory.logCount();
            LOGGER.info(
                "gather_tree.log_collected instanceId={} commandId={} target={} delta={} inventoryLogsAfter={} logsByItem={}",
                instanceId,
                commandId,
                run.currentTarget.toShortString(),
                delta,
                inventory.logCount(),
                inventory.logsByItem()
            );
            resetGatherTreeCurrentTarget(run);
        }

        if (run.completedTargets.size() >= GATHER_TREE_MAX_BROKEN_LOGS) {
            return completeGatherTree(client, inventory, effective, run, nowMs, "gather_tree_log_limit");
        }

        if (run.currentTarget == null) {
            TreeGatherPlanner.Selection selection = selectNextTreeTarget(client, player, run);
            if (selection.target() == null) {
                return completeGatherTree(client, inventory, effective, run, nowMs, selection.reason());
            }
            run.currentTarget = selection.target().toImmutable();
            run.currentAdjacentCell = null;
            run.breakDone = false;
            run.collectStartedAtMs = 0L;
            LOGGER.info(
                "gather_tree.next_log instanceId={} commandId={} target={} reachableCandidates={} leftUnreachable={} reason={}",
                instanceId,
                commandId,
                run.currentTarget.toShortString(),
                selection.reachableCandidates(),
                selection.leftUnreachable(),
                selection.reason()
            );
        }

        BlockPos target = run.currentTarget;
        if (!run.breakDone) {
            BlockState targetState = client.world.getBlockState(target);
            if (targetState.isAir()) {
                run.breakDone = true;
                run.collectStartedAtMs = nowMs;
            } else if (!targetState.isIn(BlockTags.LOGS)) {
                run.abandonedTargets.add(target);
                LOGGER.warn(
                    "gather_tree.target_not_log instanceId={} commandId={} target={} state={}",
                    instanceId,
                    commandId,
                    target.toShortString(),
                    net.minecraft.registry.Registries.BLOCK.getId(targetState.getBlock()).getPath()
                );
                resetGatherTreeCurrentTarget(run);
                return new ControlDecision(stopFrom(effective, "gather_tree_target_not_log_continue"), InputState.stop());
            }
        }

        if (!run.breakDone) {
            ControlDecision nav = navigateToGatherTreeAdjacentCell(client, player, effective, run);
            if (nav != null) {
                return nav;
            }
            BrainLink.Intent lookIntent = lookIntentForBlock(effective, player, target, "gather_tree_face");
            if (!isLookingAtBlock(player, target)) {
                return new ControlDecision(lookIntent, InputState.stop());
            }
            BlockBreakController.Result result = blockBreakController.tick(client, player, target, commandId + ":" + run.completedTargets.size(), nowMs);
            logBlockBreakResult(commandId, target, result);
            if ("occluder_cleared".equals(result.reason())) {
                run.occludersBroken++;
                LOGGER.info(
                    "gather_tree.occluder_broken instanceId={} commandId={} target={} occluder={} occludersBroken={}",
                    instanceId,
                    commandId,
                    target.toShortString(),
                    formatBlockPos(result.actedBlock()),
                    run.occludersBroken
                );
            }
            if (result.status() == BlockBreakController.Status.BROKEN) {
                run.breakDone = true;
                run.collectStartedAtMs = nowMs;
                LOGGER.info(
                    "gather_tree.break_done instanceId={} commandId={} target={} elapsedMs={}",
                    instanceId,
                    commandId,
                    target.toShortString(),
                    Math.max(0L, nowMs - run.startedAtMs)
                );
            } else if (result.status() == BlockBreakController.Status.REPOSITION) {
                if (run.currentAdjacentCell != null) {
                    run.excludedAdjacentCells.add(run.currentAdjacentCell);
                }
                run.occlusionRepositions++;
                clearNavigationState();
                run.currentAdjacentCell = null;
                LOGGER.warn(
                    "gather_tree.occlusion_reposition instanceId={} commandId={} target={} hitBlock={} repositions={} reason={}",
                    instanceId,
                    commandId,
                    target.toShortString(),
                    formatBlockPos(result.hitBlock()),
                    run.occlusionRepositions,
                    result.reason()
                );
                return new ControlDecision(stopFrom(effective, "gather_tree_occlusion_reposition"), InputState.stop());
            } else if (result.status() == BlockBreakController.Status.FAILED) {
                if (result.reason().startsWith("raycast_")) {
                    run.occlusionAbandons++;
                }
                run.abandonedTargets.add(target);
                LOGGER.warn(
                    "gather_tree.break_failed instanceId={} commandId={} target={} reason={} elapsedMs={}",
                    instanceId,
                    commandId,
                    target.toShortString(),
                    result.reason(),
                    result.elapsedMs()
                );
                resetGatherTreeCurrentTarget(run);
                return new ControlDecision(stopFrom(effective, "gather_tree_break_failed_continue:" + result.reason()), InputState.stop());
            } else {
                return new ControlDecision(lookIntentForBlock(effective, player, target, "gather_tree_breaking:" + result.reason()), InputState.stop());
            }
        }

        if (run.collectStartedAtMs > 0L && nowMs - run.collectStartedAtMs > GATHER_COLLECT_TIMEOUT_MS) {
            run.collectTimeouts++;
            run.abandonedTargets.add(target);
            LOGGER.warn(
                "gather_tree.collect_timeout instanceId={} commandId={} target={} inventoryLogsBefore={} inventoryLogsAfter={} collectTimeouts={}",
                instanceId,
                commandId,
                target.toShortString(),
                run.baselineLogCount,
                inventory.logCount(),
                run.collectTimeouts
            );
            resetGatherTreeCurrentTarget(run);
            return new ControlDecision(stopFrom(effective, "gather_tree_collect_timeout_continue"), InputState.stop());
        }

        if (run.collectStartedAtMs > 0L && nowMs - run.collectStartedAtMs < GATHER_PICKUP_SETTLE_MS) {
            return new ControlDecision(stopFrom(effective, "gather_tree_wait_pickup"), InputState.stop());
        }

        Vec3d droppedLogPosition = nearestDroppedLogItemPosition(client, player, target);
        BrainLink.Intent collectIntent;
        if (droppedLogPosition != null) {
            String logKey = commandId + ":" + roundForLog(droppedLogPosition.x) + ":" + roundForLog(droppedLogPosition.y)
                + ":" + roundForLog(droppedLogPosition.z);
            if (!logKey.equals(lastGatherCollectItemLogKey)) {
                lastGatherCollectItemLogKey = logKey;
                LOGGER.info(
                    "gather_tree.collect_item_target instanceId={} commandId={} target={} itemX={} itemY={} itemZ={}",
                    instanceId,
                    commandId,
                    target.toShortString(),
                    roundForLog(droppedLogPosition.x),
                    roundForLog(droppedLogPosition.y),
                    roundForLog(droppedLogPosition.z)
                );
            }
            collectIntent = gatherCollectIntent(
                effective,
                droppedLogPosition.x,
                droppedLogPosition.y,
                droppedLogPosition.z,
                "gather_tree_collect_item",
                ":tree:collect:item"
            );
        } else {
            collectIntent = gatherCollectIntent(effective, target, run.currentAdjacentCell);
        }
        return resolveNavigationControl(client, player, collectIntent);
    }

    private TreeGatherPlanner.Selection selectNextTreeTarget(MinecraftClient client, ClientPlayerEntity player, GatherTreeRun run) {
        Set<BlockPos> liveCluster = liveTreeCluster(client.world, run.cluster);
        List<LogTarget> reachableLogs = LogPerception.nearbyReachableLogs(
            client.world,
            player,
            LOG_SCAN_RADIUS,
            LOG_SCAN_DOWN,
            LOG_SCAN_UP,
            LOG_SCAN_LIMIT
        );
        return TreeGatherPlanner.chooseNext(liveCluster, reachableLogs, run.completedTargets, run.abandonedTargets);
    }

    private ControlDecision resolveCraft2x2Control(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        Craft2x2RecipePlanner.Recipe recipe = Craft2x2RecipePlanner.fromAction(effective.action());
        if (recipe == null) {
            return new ControlDecision(stopFrom(effective, "craft_2x2_unknown_recipe"), InputState.stop());
        }
        String action = recipe.action();
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (completedCraft2x2CommandIds.contains(commandId)) {
            return new ControlDecision(stopFrom(effective, action + "_complete"), InputState.stop());
        }
        if (activeCraft2x2 == null || !commandId.equals(activeCraft2x2.commandId) || activeCraft2x2.recipe != recipe) {
            CraftInventorySnapshot inventory = captureCraftInventory(player);
            activeCraft2x2 = new Craft2x2Run(commandId, recipe, inventory, nowMs);
            LOGGER.info(
                "{}.start instanceId={} commandId={} inventoryLogsBefore={} inventoryPlanksBefore={} inventorySticksBefore={} inventoryTablesBefore={} logsByItem={} planksByItem={} sticksByItem={} tablesByItem={}",
                action,
                instanceId,
                commandId,
                inventory.logs.logCount(),
                inventory.planks.plankCount(),
                inventory.sticks.stickCount(),
                inventory.tables.craftingTableCount(),
                inventory.logs.logsByItem(),
                inventory.planks.planksByItem(),
                inventory.sticks.sticksByItem(),
                inventory.tables.craftingTablesByItem()
            );
            if (!Craft2x2RecipePlanner.canStart(recipe, inventory.logs.logCount(), inventory.planks.plankCount())) {
                return failCraft2x2(effective, activeCraft2x2, inventory, nowMs, action + "_missing_inputs");
            }
        }

        Craft2x2Run run = activeCraft2x2;
        CraftInventorySnapshot inventory = captureCraftInventory(player);
        if (Craft2x2RecipePlanner.isComplete(
            run.recipe,
            run.baselineLogs,
            inventory.logs.logCount(),
            run.baselinePlanks,
            inventory.planks.plankCount(),
            run.baselineSticks,
            inventory.sticks.stickCount(),
            run.baselineTables,
            inventory.tables.craftingTableCount()
        )) {
            return completeCraft2x2(effective, run, inventory, nowMs, action + "_delta_verified");
        }
        if (nowMs - run.startedAtMs > CRAFT_TOTAL_TIMEOUT_MS) {
            return failCraft2x2(effective, run, inventory, nowMs, action + "_timeout");
        }

        PlayerScreenHandler handler = player.playerScreenHandler;
        if (handler == null || client.interactionManager == null) {
            return failCraft2x2(effective, run, inventory, nowMs, action + "_no_screen_handler");
        }

        if (run.stage == Craft2x2Stage.START) {
            if (!handler.getCursorStack().isEmpty()) {
                return failCraft2x2(effective, run, inventory, nowMs, action + "_cursor_not_empty");
            }
            if (!craftingInputEmpty(handler)) {
                return failCraft2x2(effective, run, inventory, nowMs, action + "_input_not_empty");
            }
            int sourceSlot = findCraftSourceScreenSlot(handler, recipe);
            if (sourceSlot < 0) {
                return failCraft2x2(effective, run, inventory, nowMs, action + "_source_slot_missing");
            }
            run.sourceScreenSlot = sourceSlot;
            transitionCraftStage(run, Craft2x2Stage.PICK_SOURCE_STACK, nowMs);
            LOGGER.info(
                "{}.source_slot_selected instanceId={} commandId={} slot={} ingredient={} inputCount={}",
                action,
                instanceId,
                commandId,
                sourceSlot,
                recipe.ingredient(),
                recipe.inputCount()
            );
        }

        if (run.lastClickAtMs > 0L && nowMs - run.lastClickAtMs < CRAFT_CLICK_SETTLE_MS) {
            return new ControlDecision(stopFrom(effective, action + "_click_settle"), InputState.stop());
        }

        if (run.stage == Craft2x2Stage.PICK_SOURCE_STACK) {
            clickCraftSlot(client, player, handler, run, run.sourceScreenSlot, 0, SlotActionType.PICKUP, "pick_source_stack", nowMs);
            transitionCraftStage(run, Craft2x2Stage.PLACE_INPUTS, nowMs);
            return new ControlDecision(stopFrom(effective, action + "_pick_source"), InputState.stop());
        }
        if (run.stage == Craft2x2Stage.PLACE_INPUTS) {
            if (handler.getCursorStack().isEmpty()) {
                return failCraft2x2(effective, run, inventory, nowMs, action + "_cursor_empty_before_place");
            }
            int inputSlot = recipe.inputSlots().get(run.nextInputIndex);
            clickCraftSlot(client, player, handler, run, inputSlot, 1, SlotActionType.PICKUP, "place_input_" + run.nextInputIndex, nowMs);
            run.nextInputIndex++;
            if (run.nextInputIndex >= recipe.inputSlots().size()) {
                transitionCraftStage(run, Craft2x2Stage.RETURN_REMAINDER, nowMs);
            }
            return new ControlDecision(stopFrom(effective, action + "_place_input"), InputState.stop());
        }
        if (run.stage == Craft2x2Stage.RETURN_REMAINDER) {
            if (!handler.getCursorStack().isEmpty()) {
                clickCraftSlot(client, player, handler, run, run.sourceScreenSlot, 0, SlotActionType.PICKUP, "return_remainder", nowMs);
            }
            transitionCraftStage(run, Craft2x2Stage.WAIT_RESULT, nowMs);
            return new ControlDecision(stopFrom(effective, action + "_return_remainder"), InputState.stop());
        }
        if (run.stage == Craft2x2Stage.WAIT_RESULT) {
            ItemStack result = handler.getSlot(PLAYER_CRAFTING_RESULT_SLOT).getStack();
            String resultId = itemId(result);
            if (Craft2x2RecipePlanner.isExpectedResult(recipe, resultId, result.getCount())) {
                LOGGER.info(
                    "{}.result_ready instanceId={} commandId={} result={} count={}",
                    action,
                    instanceId,
                    commandId,
                    resultId,
                    result.getCount()
                );
                transitionCraftStage(run, Craft2x2Stage.TAKE_RESULT, nowMs);
            } else if (nowMs - run.stageStartedAtMs > CRAFT_RESULT_WAIT_MS) {
                return failCraft2x2(effective, run, inventory, nowMs, action + "_result_missing");
            } else {
                return new ControlDecision(stopFrom(effective, action + "_wait_result"), InputState.stop());
            }
        }
        if (run.stage == Craft2x2Stage.TAKE_RESULT) {
            clickCraftSlot(client, player, handler, run, PLAYER_CRAFTING_RESULT_SLOT, 0, SlotActionType.QUICK_MOVE, "take_result", nowMs);
            transitionCraftStage(run, Craft2x2Stage.VERIFY, nowMs);
            return new ControlDecision(stopFrom(effective, action + "_take_result"), InputState.stop());
        }
        if (run.stage == Craft2x2Stage.VERIFY) {
            if (nowMs - run.stageStartedAtMs > CRAFT_VERIFY_WAIT_MS) {
                return failCraft2x2(effective, run, inventory, nowMs, action + "_delta_missing");
            }
            return new ControlDecision(stopFrom(effective, action + "_verify_delta"), InputState.stop());
        }

        return failCraft2x2(effective, run, inventory, nowMs, action + "_unknown_stage");
    }

    private ControlDecision completeCraft2x2(
        BrainLink.Intent effective,
        Craft2x2Run run,
        CraftInventorySnapshot inventory,
        long nowMs,
        String reason
    ) {
        completedCraft2x2CommandIds.add(run.commandId);
        LOGGER.info(
            "{}.complete instanceId={} commandId={} reason={} inventoryLogsBefore={} inventoryLogsAfter={} inventoryPlanksBefore={} inventoryPlanksAfter={} inventorySticksBefore={} inventorySticksAfter={} inventoryTablesBefore={} inventoryTablesAfter={} logsByItem={} planksByItem={} sticksByItem={} tablesByItem={} elapsedMs={}",
            run.recipe.action(),
            instanceId,
            run.commandId,
            reason,
            run.baselineLogs,
            inventory.logs.logCount(),
            run.baselinePlanks,
            inventory.planks.plankCount(),
            run.baselineSticks,
            inventory.sticks.stickCount(),
            run.baselineTables,
            inventory.tables.craftingTableCount(),
            inventory.logs.logsByItem(),
            inventory.planks.planksByItem(),
            inventory.sticks.sticksByItem(),
            inventory.tables.craftingTablesByItem(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeCraft2x2 = null;
        brainLink.completeCurrentCommand(run.commandId, run.recipe.action() + "_complete:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, run.recipe.action() + "_complete:" + reason), InputState.stop());
    }

    private ControlDecision failCraft2x2(
        BrainLink.Intent effective,
        Craft2x2Run run,
        CraftInventorySnapshot inventory,
        long nowMs,
        String reason
    ) {
        completedCraft2x2CommandIds.add(run.commandId);
        LOGGER.warn(
            "{}.failed instanceId={} commandId={} reason={} stage={} inventoryLogsBefore={} inventoryLogsAfter={} inventoryPlanksBefore={} inventoryPlanksAfter={} inventorySticksBefore={} inventorySticksAfter={} inventoryTablesBefore={} inventoryTablesAfter={} logsByItem={} planksByItem={} sticksByItem={} tablesByItem={} elapsedMs={}",
            run.recipe.action(),
            instanceId,
            run.commandId,
            reason,
            run.stage,
            run.baselineLogs,
            inventory.logs.logCount(),
            run.baselinePlanks,
            inventory.planks.plankCount(),
            run.baselineSticks,
            inventory.sticks.stickCount(),
            run.baselineTables,
            inventory.tables.craftingTableCount(),
            inventory.logs.logsByItem(),
            inventory.planks.planksByItem(),
            inventory.sticks.sticksByItem(),
            inventory.tables.craftingTablesByItem(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeCraft2x2 = null;
        brainLink.completeCurrentCommand(run.commandId, run.recipe.action() + "_failed:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, run.recipe.action() + "_failed:" + reason), InputState.stop());
    }

    private void transitionCraftStage(Craft2x2Run run, Craft2x2Stage stage, long nowMs) {
        run.stage = stage;
        run.stageStartedAtMs = nowMs;
    }

    private void clickCraftSlot(
        MinecraftClient client,
        ClientPlayerEntity player,
        ScreenHandler handler,
        Craft2x2Run run,
        int slot,
        int button,
        SlotActionType action,
        String label,
        long nowMs
    ) {
        client.interactionManager.clickSlot(handler.syncId, slot, button, action, player);
        run.lastClickAtMs = nowMs;
        LOGGER.info(
            "{}.click instanceId={} commandId={} label={} slot={} button={} action={}",
            run.recipe.action(),
            instanceId,
            run.commandId,
            label,
            slot,
            button,
            action
        );
    }

    private int findCraftSourceScreenSlot(PlayerScreenHandler handler, Craft2x2RecipePlanner.Recipe recipe) {
        int end = Math.min(PLAYER_HOTBAR_SCREEN_END, handler.slots.size());
        for (int slot = PLAYER_INVENTORY_SCREEN_START; slot < end; slot++) {
            ItemStack stack = handler.getSlot(slot).getStack();
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            if (stack.getCount() < recipe.inputCount()) {
                continue;
            }
            String id = itemId(stack);
            if (recipe.ingredient() == Craft2x2RecipePlanner.Ingredient.LOG
                && (stack.isIn(ItemTags.LOGS) || InventoryCounter.isLogItemId(id))) {
                return slot;
            }
            if (recipe.ingredient() == Craft2x2RecipePlanner.Ingredient.PLANK
                && InventoryCounter.isPlankItemId(id)) {
                return slot;
            }
        }
        return -1;
    }

    private CraftInventorySnapshot captureCraftInventory(ClientPlayerEntity player) {
        return new CraftInventorySnapshot(
            InventoryCounter.countPlayerLogs(player),
            InventoryCounter.countPlayerPlanks(player),
            InventoryCounter.countPlayerSticks(player),
            InventoryCounter.countPlayerCraftingTables(player),
            InventoryCounter.countPlayerWoodenPickaxes(player),
            InventoryCounter.countPlayerCobblestone(player),
            InventoryCounter.countPlayerItem(player, "stone_pickaxe"),
            InventoryCounter.countPlayerItem(player, "stone_axe"),
            InventoryCounter.countPlayerItem(player, "stone_sword"),
            InventoryCounter.countPlayerItem(player, "furnace"),
            InventoryCounter.countPlayerItem(player, "charcoal"),
            InventoryCounter.countPlayerItem(player, "coal"),
            InventoryCounter.countPlayerItem(player, "raw_iron"),
            InventoryCounter.countPlayerItem(player, "iron_ingot"),
            InventoryCounter.countPlayerItem(player, "iron_pickaxe")
        );
    }

    private boolean craftingInputEmpty(PlayerScreenHandler handler) {
        int end = Math.min(PLAYER_CRAFTING_INPUT_END, handler.slots.size());
        for (int slot = PLAYER_CRAFTING_INPUT_START; slot < end; slot++) {
            ItemStack stack = handler.getSlot(slot).getStack();
            if (stack != null && !stack.isEmpty()) {
                return false;
            }
        }
        return true;
    }

    private ControlDecision resolveCraft3x3Control(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        Craft3x3RecipePlanner.Recipe recipe = Craft3x3RecipePlanner.fromAction(effective.action());
        if (recipe == null) {
            return new ControlDecision(stopFrom(effective, "craft_3x3_unknown_recipe"), InputState.stop());
        }
        String action = recipe.action();
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (completedCraft3x3CommandIds.contains(commandId)) {
            return new ControlDecision(stopFrom(effective, action + "_complete"), InputState.stop());
        }
        if (activeCraft3x3 == null || !commandId.equals(activeCraft3x3.commandId) || activeCraft3x3.recipe != recipe) {
            CraftInventorySnapshot inventory = captureCraftInventory(player);
            activeCraft3x3 = new Craft3x3Run(commandId, recipe, inventory, nowMs);
            LOGGER.info(
                "{}.start instanceId={} commandId={} resultItem={} inventoryPlanksBefore={} inventoryCobblestoneBefore={} inventorySticksBefore={} inventoryIronIngotsBefore={} inventoryWoodenPickaxesBefore={} inventoryResultBefore={} inventoryStonePickaxesBefore={} inventoryStoneAxesBefore={} inventoryStoneSwordsBefore={} inventoryFurnacesBefore={} inventoryIronPickaxesBefore={} planksByItem={} cobblestoneByItem={} sticksByItem={} ironIngotsByItem={} woodenPickaxesByItem={} resultByItem={}",
                action,
                instanceId,
                commandId,
                recipe.resultItemId(),
                inventory.planks.plankCount(),
                inventory.cobblestone.cobblestoneCount(),
                inventory.sticks.stickCount(),
                inventory.ironIngots.itemCount(),
                inventory.woodenPickaxes.woodenPickaxeCount(),
                craft3x3ResultCount(inventory, recipe),
                inventory.stonePickaxes.itemCount(),
                inventory.stoneAxes.itemCount(),
                inventory.stoneSwords.itemCount(),
                inventory.furnaces.itemCount(),
                inventory.ironPickaxes.itemCount(),
                inventory.planks.planksByItem(),
                inventory.cobblestone.cobblestoneByItem(),
                inventory.sticks.sticksByItem(),
                inventory.ironIngots.itemsByItem(),
                inventory.woodenPickaxes.woodenPickaxesByItem(),
                craft3x3ResultByItem(inventory, recipe)
            );
            if (!Craft3x3RecipePlanner.canStart(recipe, inventory.planks.plankCount(), inventory.cobblestone.cobblestoneCount(), inventory.sticks.stickCount(), inventory.ironIngots.itemCount())) {
                return failCraft3x3(effective, activeCraft3x3, inventory, nowMs, action + "_missing_inputs");
            }
        }

        Craft3x3Run run = activeCraft3x3;
        CraftInventorySnapshot inventory = captureCraftInventory(player);
        Craft3x3ControlPlanner.Decision preflight = Craft3x3ControlPlanner.decidePreflight(
            craft3x3ControlState(run),
            Craft3x3RecipePlanner.isComplete(
                run.recipe,
                run.baselinePlanks,
                inventory.planks.plankCount(),
                run.baselineCobblestone,
                inventory.cobblestone.cobblestoneCount(),
                run.baselineSticks,
                inventory.sticks.stickCount(),
                run.baselineIronIngots,
                inventory.ironIngots.itemCount(),
                run.baselineResult,
                craft3x3ResultCount(inventory, run.recipe)
            ),
            nowMs - run.startedAtMs > CRAFT_TOTAL_TIMEOUT_MS,
            client.interactionManager != null
        );
        if (preflight.action() == Craft3x3ControlPlanner.Action.COMPLETE_TYPED_DELTA) {
            return completeCraft3x3(effective, run, inventory, nowMs, action + "_" + preflight.reason());
        }
        if (preflight.action() == Craft3x3ControlPlanner.Action.FAIL_TOTAL_TIMEOUT
            || preflight.action() == Craft3x3ControlPlanner.Action.FAIL_MISSING_INTERACTION_MANAGER) {
            return failCraft3x3(effective, run, inventory, nowMs, action + "_" + preflight.reason());
        }

        ScreenHandler currentHandler = player.currentScreenHandler;
        if (!(currentHandler instanceof CraftingScreenHandler tableHandler)) {
            Screen currentScreen = client.currentScreen;
            if (run.tableOpenInteractedAtMs > 0L) {
                long waitedMs = Math.max(0L, nowMs - run.tableOpenInteractedAtMs);
                if (waitedMs < CRAFT_TABLE_OPEN_RETRY_MS) {
                    if (run.lastTableOpenWaitLogAtMs <= 0L || nowMs - run.lastTableOpenWaitLogAtMs >= 250L) {
                        run.lastTableOpenWaitLogAtMs = nowMs;
                        LOGGER.info(
                            "{}.open_wait instanceId={} commandId={} attempt={} target={} waitedMs={} screen={} handler={} elapsedMs={}",
                            action,
                            instanceId,
                            commandId,
                            run.tableOpenAttempts,
                            run.tableOpenTarget == null ? "unknown" : formatBlockPos(run.tableOpenTarget),
                            waitedMs,
                            currentScreen == null ? "none" : currentScreen.getClass().getSimpleName(),
                            currentHandler == null ? "none" : currentHandler.getClass().getSimpleName(),
                            Math.max(0L, nowMs - run.startedAtMs)
                        );
                    }
                    return new ControlDecision(stopFrom(effective, action + "_waiting_for_table_open"), InputState.stop());
                }
                run.tableOpenInteractedAtMs = 0L;
                run.tableOpenTarget = null;
                run.lastTableOpenWaitLogAtMs = 0L;
                if (run.tableOpenAttempts >= CRAFT_TABLE_OPEN_MAX_ATTEMPTS) {
                    return failCraft3x3(effective, run, inventory, nowMs, action + "_table_open_timeout");
                }
            }
            if (currentScreen != null) {
                if (currentHandler != null && currentHandler != player.playerScreenHandler) {
                    player.closeHandledScreen();
                }
                client.setScreen(null);
                run.tableOpenTarget = null;
                run.lastTableOpenWaitLogAtMs = 0L;
                LOGGER.info(
                    "{}.close_screen_before_open instanceId={} commandId={} screen={} handler={} elapsedMs={}",
                    action,
                    instanceId,
                    commandId,
                    currentScreen.getClass().getSimpleName(),
                    currentHandler == null ? "none" : currentHandler.getClass().getSimpleName(),
                    Math.max(0L, nowMs - run.startedAtMs)
                );
                return new ControlDecision(stopFrom(effective, action + "_close_screen_before_open"), InputState.stop());
            }
            if (currentHandler != null && currentHandler != player.playerScreenHandler) {
                return failCraft3x3(effective, run, inventory, nowMs, action + "_wrong_screen_handler");
            }
            BlockPos table = selectNearbyCraftingTable(client, player);
            if (table == null) {
                return failCraft3x3(effective, run, inventory, nowMs, action + "_no_nearby_table");
            }
            Vec3d target = Vec3d.ofCenter(table);
            LookAngles tableLook = lookAnglesToPoint(player, target);
            if (Math.abs(LookController.normalizeYaw(tableLook.yaw() - player.getYaw())) > 4.0D
                || Math.abs(tableLook.pitch() - player.getPitch()) > 4.0D) {
                return new ControlDecision(lookIntentForAngles(effective, tableLook.yaw(), tableLook.pitch(), action + "_look_at_table"), InputState.stop());
            }
            BlockHitResult hit = raycastForInteraction(player, client);
            boolean blockHit = hit != null && hit.getType() == HitResult.Type.BLOCK;
            BlockPos hitBlock = blockHit ? hit.getBlockPos().toImmutable() : null;
            if (!blockHit || hitBlock == null || !client.world.getBlockState(hitBlock).isOf(Blocks.CRAFTING_TABLE)) {
                return new ControlDecision(stopFrom(effective, action + "_waiting_for_table_raycast"), InputState.stop());
            }
            if (!withinInteractionReach(player, hit.getPos())) {
                return failCraft3x3(effective, run, inventory, nowMs, action + "_table_out_of_reach");
            }
            currentInputState = InputState.stop();
            applyInputState(player.input, currentInputState);
            player.setSneaking(false);
            int openerSlot = selectTableOpenHotbarSlot(player);
            run.tableOpenAttempts++;
            run.tableOpenInteractedAtMs = nowMs;
            run.tableOpenTarget = hitBlock;
            run.lastTableOpenWaitLogAtMs = 0L;
            ActionResult result = client.interactionManager.interactBlock(player, Hand.MAIN_HAND, hit);
            player.swingHand(Hand.MAIN_HAND);
            LOGGER.info(
                "{}.open_interact instanceId={} commandId={} attempt={} result={} hitBlock={} hitSide={} selectedHotbarSlot={} selectedItem={} sneaking={} inputSneaking={} elapsedMs={}",
                action,
                instanceId,
                commandId,
                run.tableOpenAttempts,
                result,
                formatBlockPos(hitBlock),
                hit.getSide() == null ? "none" : hit.getSide().asString(),
                openerSlot,
                selectedItemId(player),
                player.isSneaking(),
                player.input.sneaking,
                Math.max(0L, nowMs - run.startedAtMs)
            );
            return new ControlDecision(stopFrom(effective, action + "_opening_table:" + result), InputState.stop());
        }

        if (run.stage == Craft3x3ControlPlanner.Stage.START) {
            run.tableOpenInteractedAtMs = 0L;
            run.tableOpenTarget = null;
            run.tableOpenAttempts = 0;
            run.lastTableOpenWaitLogAtMs = 0L;
            LOGGER.info(
                "{}.table_opened instanceId={} commandId={} handler={} syncId={} inputSlots={} resultSlot={}",
                action,
                instanceId,
                commandId,
                tableHandler.getClass().getSimpleName(),
                tableHandler.syncId,
                TABLE_CRAFTING_INPUT_START + "-" + (TABLE_CRAFTING_INPUT_END - 1),
                TABLE_CRAFTING_RESULT_SLOT
            );
            Craft3x3ControlPlanner.Decision tableOpened = Craft3x3ControlPlanner.decideTableOpened(
                craft3x3ControlState(run),
                tableHandler.getCursorStack().isEmpty(),
                tableCraftingInputEmpty(tableHandler)
            );
            if (tableOpened.action() == Craft3x3ControlPlanner.Action.FAIL_CURSOR_NOT_EMPTY
                || tableOpened.action() == Craft3x3ControlPlanner.Action.FAIL_INPUT_NOT_EMPTY) {
                return failCraft3x3(effective, run, inventory, nowMs, action + "_" + tableOpened.reason());
            }
            applyCraft3x3ControlDecision(run, tableOpened, nowMs);
        }

        Craft3x3ControlPlanner.Decision clickSettle = Craft3x3ControlPlanner.decideClickSettle(
            craft3x3ControlState(run),
            run.lastClickAtMs > 0L && nowMs - run.lastClickAtMs < CRAFT_CLICK_SETTLE_MS
        );
        if (clickSettle.action() == Craft3x3ControlPlanner.Action.WAIT_CLICK_SETTLE) {
            return new ControlDecision(stopFrom(effective, action + "_" + clickSettle.reason()), InputState.stop());
        }

        if (run.stage == Craft3x3ControlPlanner.Stage.SELECT_SOURCE) {
            Craft3x3RecipePlanner.IngredientGroup group = currentCraft3x3Group(run);
            int sourceSlot = group == null ? -1 : findCraft3x3SourceScreenSlot(tableHandler, group);
            Craft3x3ControlPlanner.Decision sourceSelection = Craft3x3ControlPlanner.decideSourceSelection(
                craft3x3ControlState(run),
                group != null,
                sourceSlot >= 0,
                group == null ? null : group.ingredient().name()
            );
            if (sourceSelection.action() == Craft3x3ControlPlanner.Action.INPUTS_PLACED) {
                applyCraft3x3ControlDecision(run, sourceSelection, nowMs);
                return new ControlDecision(stopFrom(effective, action + "_" + sourceSelection.reason()), InputState.stop());
            }
            if (sourceSelection.action() == Craft3x3ControlPlanner.Action.FAIL_SOURCE_SLOT_MISSING) {
                return failCraft3x3(effective, run, inventory, nowMs, action + "_" + sourceSelection.reason());
            }
            run.sourceScreenSlot = sourceSlot;
            LOGGER.info(
                "{}.source_slot_selected instanceId={} commandId={} slot={} ingredient={} inputCount={}",
                action,
                instanceId,
                commandId,
                sourceSlot,
                group.ingredient(),
                group.inputCount()
            );
            applyCraft3x3ControlDecision(run, sourceSelection, nowMs);
        }

        if (run.stage == Craft3x3ControlPlanner.Stage.PICK_SOURCE_STACK) {
            Craft3x3ControlPlanner.Decision pickSource = Craft3x3ControlPlanner.decidePickSource(craft3x3ControlState(run));
            clickCraft3x3Slot(client, player, tableHandler, run, run.sourceScreenSlot, 0, SlotActionType.PICKUP, "pick_source_stack", nowMs);
            applyCraft3x3ControlDecision(run, pickSource, nowMs);
            return new ControlDecision(stopFrom(effective, action + "_pick_source"), InputState.stop());
        }

        if (run.stage == Craft3x3ControlPlanner.Stage.PLACE_INPUTS) {
            Craft3x3RecipePlanner.IngredientGroup group = currentCraft3x3Group(run);
            Craft3x3ControlPlanner.Decision placeInput = Craft3x3ControlPlanner.decidePlaceInput(
                craft3x3ControlState(run),
                tableHandler.getCursorStack().isEmpty(),
                group != null,
                run.inputIndexInGroup,
                group == null ? 0 : group.inputCount()
            );
            if (placeInput.action() == Craft3x3ControlPlanner.Action.FAIL_CURSOR_EMPTY_BEFORE_PLACE
                || placeInput.action() == Craft3x3ControlPlanner.Action.FAIL_MISSING_CURRENT_GROUP) {
                return failCraft3x3(effective, run, inventory, nowMs, action + "_" + placeInput.reason());
            }
            int inputSlot = group.inputSlots().get(run.inputIndexInGroup);
            clickCraft3x3Slot(client, player, tableHandler, run, inputSlot, 1, SlotActionType.PICKUP, "place_input_" + run.groupIndex + "_" + run.inputIndexInGroup, nowMs);
            run.inputIndexInGroup++;
            applyCraft3x3ControlDecision(run, placeInput, nowMs);
            return new ControlDecision(stopFrom(effective, action + "_place_input"), InputState.stop());
        }

        if (run.stage == Craft3x3ControlPlanner.Stage.RETURN_REMAINDER) {
            Craft3x3ControlPlanner.Decision returnRemainder = Craft3x3ControlPlanner.decideReturnRemainder(craft3x3ControlState(run));
            if (!tableHandler.getCursorStack().isEmpty()) {
                clickCraft3x3Slot(client, player, tableHandler, run, run.sourceScreenSlot, 0, SlotActionType.PICKUP, "return_remainder", nowMs);
            }
            run.groupIndex++;
            run.inputIndexInGroup = 0;
            run.sourceScreenSlot = -1;
            applyCraft3x3ControlDecision(run, returnRemainder, nowMs);
            return new ControlDecision(stopFrom(effective, action + "_return_remainder"), InputState.stop());
        }

        if (run.stage == Craft3x3ControlPlanner.Stage.WAIT_RESULT) {
            ItemStack result = tableHandler.getSlot(TABLE_CRAFTING_RESULT_SLOT).getStack();
            String resultId = itemId(result);
            Craft3x3ControlPlanner.Decision waitResult = Craft3x3ControlPlanner.decideWaitResult(
                craft3x3ControlState(run),
                Craft3x3RecipePlanner.isExpectedResult(recipe, resultId, result.getCount()),
                nowMs - run.stageStartedAtMs > CRAFT_RESULT_WAIT_MS
            );
            if (waitResult.action() == Craft3x3ControlPlanner.Action.RESULT_READY) {
                LOGGER.info(
                    "{}.result_ready instanceId={} commandId={} handler={} result={} count={}",
                    action,
                    instanceId,
                    commandId,
                    tableHandler.getClass().getSimpleName(),
                    resultId,
                    result.getCount()
                );
                applyCraft3x3ControlDecision(run, waitResult, nowMs);
            } else if (waitResult.action() == Craft3x3ControlPlanner.Action.FAIL_RESULT_MISSING) {
                return failCraft3x3(effective, run, inventory, nowMs, action + "_" + waitResult.reason());
            } else {
                return new ControlDecision(stopFrom(effective, action + "_" + waitResult.reason()), InputState.stop());
            }
        }

        if (run.stage == Craft3x3ControlPlanner.Stage.TAKE_RESULT) {
            Craft3x3ControlPlanner.Decision takeResult = Craft3x3ControlPlanner.decideTakeResult(craft3x3ControlState(run));
            clickCraft3x3Slot(client, player, tableHandler, run, TABLE_CRAFTING_RESULT_SLOT, 0, SlotActionType.QUICK_MOVE, "take_result", nowMs);
            applyCraft3x3ControlDecision(run, takeResult, nowMs);
            return new ControlDecision(stopFrom(effective, action + "_take_result"), InputState.stop());
        }

        if (run.stage == Craft3x3ControlPlanner.Stage.VERIFY) {
            Craft3x3ControlPlanner.Decision verify = Craft3x3ControlPlanner.decideVerify(
                craft3x3ControlState(run),
                nowMs - run.stageStartedAtMs > CRAFT_VERIFY_WAIT_MS
            );
            if (verify.action() == Craft3x3ControlPlanner.Action.FAIL_TYPED_DELTA_MISSING) {
                return failCraft3x3(effective, run, inventory, nowMs, action + "_" + verify.reason());
            }
            return new ControlDecision(stopFrom(effective, action + "_" + verify.reason()), InputState.stop());
        }

        return failCraft3x3(effective, run, inventory, nowMs, action + "_unknown_stage");
    }

    private ControlDecision completeCraft3x3(
        BrainLink.Intent effective,
        Craft3x3Run run,
        CraftInventorySnapshot inventory,
        long nowMs,
        String reason
    ) {
        completedCraft3x3CommandIds.add(run.commandId);
        LOGGER.info(
            "{}.complete instanceId={} commandId={} reason={} handler=CraftingScreenHandler resultItem={} inventoryPlanksBefore={} inventoryPlanksAfter={} inventoryCobblestoneBefore={} inventoryCobblestoneAfter={} inventorySticksBefore={} inventorySticksAfter={} inventoryIronIngotsBefore={} inventoryIronIngotsAfter={} inventoryWoodenPickaxesBefore={} inventoryWoodenPickaxesAfter={} inventoryResultBefore={} inventoryResultAfter={} inventoryStonePickaxesBefore={} inventoryStonePickaxesAfter={} inventoryStoneAxesBefore={} inventoryStoneAxesAfter={} inventoryStoneSwordsBefore={} inventoryStoneSwordsAfter={} inventoryFurnacesBefore={} inventoryFurnacesAfter={} inventoryIronPickaxesBefore={} inventoryIronPickaxesAfter={} planksByItem={} cobblestoneByItem={} sticksByItem={} ironIngotsByItem={} woodenPickaxesByItem={} resultByItem={} elapsedMs={}",
            run.recipe.action(),
            instanceId,
            run.commandId,
            reason,
            run.recipe.resultItemId(),
            run.baselinePlanks,
            inventory.planks.plankCount(),
            run.baselineCobblestone,
            inventory.cobblestone.cobblestoneCount(),
            run.baselineSticks,
            inventory.sticks.stickCount(),
            run.baselineIronIngots,
            inventory.ironIngots.itemCount(),
            run.baselineWoodenPickaxes,
            inventory.woodenPickaxes.woodenPickaxeCount(),
            run.baselineResult,
            craft3x3ResultCount(inventory, run.recipe),
            run.baselineStonePickaxes,
            inventory.stonePickaxes.itemCount(),
            run.baselineStoneAxes,
            inventory.stoneAxes.itemCount(),
            run.baselineStoneSwords,
            inventory.stoneSwords.itemCount(),
            run.baselineFurnaces,
            inventory.furnaces.itemCount(),
            run.baselineIronPickaxes,
            inventory.ironPickaxes.itemCount(),
            inventory.planks.planksByItem(),
            inventory.cobblestone.cobblestoneByItem(),
            inventory.sticks.sticksByItem(),
            inventory.ironIngots.itemsByItem(),
            inventory.woodenPickaxes.woodenPickaxesByItem(),
            craft3x3ResultByItem(inventory, run.recipe),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeCraft3x3 = null;
        brainLink.completeCurrentCommand(run.commandId, run.recipe.action() + "_complete:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, run.recipe.action() + "_complete:" + reason), InputState.stop());
    }

    private ControlDecision failCraft3x3(
        BrainLink.Intent effective,
        Craft3x3Run run,
        CraftInventorySnapshot inventory,
        long nowMs,
        String reason
    ) {
        completedCraft3x3CommandIds.add(run.commandId);
        LOGGER.warn(
            "{}.failed instanceId={} commandId={} reason={} stage={} handler={} resultItem={} inventoryPlanksBefore={} inventoryPlanksAfter={} inventoryCobblestoneBefore={} inventoryCobblestoneAfter={} inventorySticksBefore={} inventorySticksAfter={} inventoryIronIngotsBefore={} inventoryIronIngotsAfter={} inventoryWoodenPickaxesBefore={} inventoryWoodenPickaxesAfter={} inventoryResultBefore={} inventoryResultAfter={} inventoryStonePickaxesBefore={} inventoryStonePickaxesAfter={} inventoryStoneAxesBefore={} inventoryStoneAxesAfter={} inventoryStoneSwordsBefore={} inventoryStoneSwordsAfter={} inventoryFurnacesBefore={} inventoryFurnacesAfter={} inventoryIronPickaxesBefore={} inventoryIronPickaxesAfter={} planksByItem={} cobblestoneByItem={} sticksByItem={} ironIngotsByItem={} woodenPickaxesByItem={} resultByItem={} elapsedMs={}",
            run.recipe.action(),
            instanceId,
            run.commandId,
            reason,
            run.stage,
            effective == null ? "unknown" : "runtime",
            run.recipe.resultItemId(),
            run.baselinePlanks,
            inventory.planks.plankCount(),
            run.baselineCobblestone,
            inventory.cobblestone.cobblestoneCount(),
            run.baselineSticks,
            inventory.sticks.stickCount(),
            run.baselineIronIngots,
            inventory.ironIngots.itemCount(),
            run.baselineWoodenPickaxes,
            inventory.woodenPickaxes.woodenPickaxeCount(),
            run.baselineResult,
            craft3x3ResultCount(inventory, run.recipe),
            run.baselineStonePickaxes,
            inventory.stonePickaxes.itemCount(),
            run.baselineStoneAxes,
            inventory.stoneAxes.itemCount(),
            run.baselineStoneSwords,
            inventory.stoneSwords.itemCount(),
            run.baselineFurnaces,
            inventory.furnaces.itemCount(),
            run.baselineIronPickaxes,
            inventory.ironPickaxes.itemCount(),
            inventory.planks.planksByItem(),
            inventory.cobblestone.cobblestoneByItem(),
            inventory.sticks.sticksByItem(),
            inventory.ironIngots.itemsByItem(),
            inventory.woodenPickaxes.woodenPickaxesByItem(),
            craft3x3ResultByItem(inventory, run.recipe),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeCraft3x3 = null;
        brainLink.completeCurrentCommand(run.commandId, run.recipe.action() + "_failed:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, run.recipe.action() + "_failed:" + reason), InputState.stop());
    }

    private Craft3x3ControlPlanner.State craft3x3ControlState(Craft3x3Run run) {
        return new Craft3x3ControlPlanner.State(run.stage);
    }

    private void applyCraft3x3ControlDecision(Craft3x3Run run, Craft3x3ControlPlanner.Decision decision, long nowMs) {
        Craft3x3ControlPlanner.Stage nextStage = decision.state().stage();
        if (nextStage != run.stage) {
            transitionCraft3x3Stage(run, nextStage, nowMs);
        }
    }

    private void transitionCraft3x3Stage(Craft3x3Run run, Craft3x3ControlPlanner.Stage stage, long nowMs) {
        run.stage = stage;
        run.stageStartedAtMs = nowMs;
    }

    private void clickCraft3x3Slot(
        MinecraftClient client,
        ClientPlayerEntity player,
        ScreenHandler handler,
        Craft3x3Run run,
        int slot,
        int button,
        SlotActionType action,
        String label,
        long nowMs
    ) {
        client.interactionManager.clickSlot(handler.syncId, slot, button, action, player);
        run.lastClickAtMs = nowMs;
        LOGGER.info(
            "{}.click instanceId={} commandId={} label={} slot={} button={} action={} handler={} syncId={}",
            run.recipe.action(),
            instanceId,
            run.commandId,
            label,
            slot,
            button,
            action,
            handler.getClass().getSimpleName(),
            handler.syncId
        );
    }

    private Craft3x3RecipePlanner.IngredientGroup currentCraft3x3Group(Craft3x3Run run) {
        if (run.groupIndex < 0 || run.groupIndex >= run.recipe.ingredientGroups().size()) {
            return null;
        }
        return run.recipe.ingredientGroups().get(run.groupIndex);
    }

    private int findCraft3x3SourceScreenSlot(ScreenHandler handler, Craft3x3RecipePlanner.IngredientGroup group) {
        int end = Math.min(handler.slots.size(), 46);
        for (int slot = TABLE_CRAFTING_INPUT_END; slot < end; slot++) {
            ItemStack stack = handler.getSlot(slot).getStack();
            if (stack == null || stack.isEmpty() || stack.getCount() < group.inputCount()) {
                continue;
            }
            if (matchesCraft3x3Ingredient(group.ingredient(), itemId(stack))) {
                return slot;
            }
        }
        return -1;
    }

    private boolean matchesCraft3x3Ingredient(Craft3x3RecipePlanner.Ingredient ingredient, String itemId) {
        return switch (ingredient) {
            case COBBLESTONE -> InventoryCounter.isCobblestoneItemId(itemId);
            case IRON_INGOT -> "iron_ingot".equalsIgnoreCase(itemId == null ? "" : itemId.trim());
            case PLANK -> InventoryCounter.isPlankItemId(itemId);
            case STICK -> InventoryCounter.isStickItemId(itemId);
        };
    }

    private static int craft3x3ResultCount(CraftInventorySnapshot inventory, Craft3x3RecipePlanner.Recipe recipe) {
        if (inventory == null || recipe == null) {
            return 0;
        }
        return switch (recipe.resultItemId()) {
            case "wooden_pickaxe" -> inventory.woodenPickaxes.woodenPickaxeCount();
            case "stone_pickaxe" -> inventory.stonePickaxes.itemCount();
            case "stone_axe" -> inventory.stoneAxes.itemCount();
            case "stone_sword" -> inventory.stoneSwords.itemCount();
            case "furnace" -> inventory.furnaces.itemCount();
            case "iron_pickaxe" -> inventory.ironPickaxes.itemCount();
            default -> 0;
        };
    }

    private static Map<String, Integer> craft3x3ResultByItem(CraftInventorySnapshot inventory, Craft3x3RecipePlanner.Recipe recipe) {
        if (inventory == null || recipe == null) {
            return Map.of();
        }
        return switch (recipe.resultItemId()) {
            case "wooden_pickaxe" -> inventory.woodenPickaxes.woodenPickaxesByItem();
            case "stone_pickaxe" -> inventory.stonePickaxes.itemsByItem();
            case "stone_axe" -> inventory.stoneAxes.itemsByItem();
            case "stone_sword" -> inventory.stoneSwords.itemsByItem();
            case "furnace" -> inventory.furnaces.itemsByItem();
            case "iron_pickaxe" -> inventory.ironPickaxes.itemsByItem();
            default -> Map.of();
        };
    }

    private boolean tableCraftingInputEmpty(ScreenHandler handler) {
        int end = Math.min(TABLE_CRAFTING_INPUT_END, handler.slots.size());
        for (int slot = TABLE_CRAFTING_INPUT_START; slot < end; slot++) {
            ItemStack stack = handler.getSlot(slot).getStack();
            if (stack != null && !stack.isEmpty()) {
                return false;
            }
        }
        return true;
    }

    private BlockPos selectNearbyCraftingTable(MinecraftClient client, ClientPlayerEntity player) {
        BlockPos origin = player.getBlockPos();
        BlockPos selected = null;
        double bestDistance = Double.MAX_VALUE;
        for (int dy = -1; dy <= 2; dy++) {
            for (int dx = -4; dx <= 4; dx++) {
                for (int dz = -4; dz <= 4; dz++) {
                    BlockPos pos = origin.add(dx, dy, dz);
                    if (!client.world.getBlockState(pos).isOf(Blocks.CRAFTING_TABLE)) {
                        continue;
                    }
                    double distance = player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(pos));
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        selected = pos.toImmutable();
                    }
                }
            }
        }
        return selected;
    }

    private BlockHitResult raycastForInteraction(ClientPlayerEntity player, MinecraftClient client) {
        double reach = Math.min(TABLE_INTERACTION_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
        Vec3d eye = player.getEyePos();
        Vec3d end = eye.add(player.getRotationVec(1.0F).multiply(reach));
        return client.world.raycast(new RaycastContext(
            eye,
            end,
            RaycastContext.ShapeType.OUTLINE,
            RaycastContext.FluidHandling.NONE,
            player
        ));
    }

    private boolean withinInteractionReach(ClientPlayerEntity player, Vec3d hitPos) {
        return hitPos != null && player.getEyePos().squaredDistanceTo(hitPos) <= TABLE_INTERACTION_REACH_BLOCKS * TABLE_INTERACTION_REACH_BLOCKS;
    }

    private ControlDecision resolveSmeltCharcoalControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        FurnaceSmeltRecipe recipe = FurnaceSmeltRecipe.fromAction(effective.action());
        if (recipe == null) {
            return new ControlDecision(stopFrom(effective, "smelt_unknown_recipe"), InputState.stop());
        }
        String action = recipe.action();
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (completedSmeltCharcoalCommandIds.contains(commandId)) {
            return new ControlDecision(stopFrom(effective, action + "_complete"), InputState.stop());
        }
        if (activeSmeltCharcoal == null || !commandId.equals(activeSmeltCharcoal.commandId) || activeSmeltCharcoal.recipe != recipe) {
            CraftInventorySnapshot inventory = captureCraftInventory(player);
            activeSmeltCharcoal = new SmeltCharcoalRun(commandId, recipe, inventory, nowMs);
            LOGGER.info(
                "{}.start instanceId={} commandId={} outputItem={} inventoryInputBefore={} inventoryOutputBefore={} inventoryLogsBefore={} inventoryPlanksBefore={} inventoryCharcoalBefore={} inventoryCoalBefore={} inventoryRawIronBefore={} inventoryIronIngotsBefore={} logsByItem={} planksByItem={} charcoalByItem={} coalByItem={} rawIronByItem={} ironIngotsByItem={}",
                action,
                instanceId,
                commandId,
                recipe.outputItemId(),
                smeltInputCount(inventory, recipe),
                smeltOutputCount(inventory, recipe),
                inventory.logs.logCount(),
                inventory.planks.plankCount(),
                inventory.charcoal.itemCount(),
                inventory.coal.itemCount(),
                inventory.rawIron.itemCount(),
                inventory.ironIngots.itemCount(),
                inventory.logs.logsByItem(),
                inventory.planks.planksByItem(),
                inventory.charcoal.itemsByItem(),
                inventory.coal.itemsByItem(),
                inventory.rawIron.itemsByItem(),
                inventory.ironIngots.itemsByItem()
            );
            String validationFailure = validateSmeltRecipeInputs(inventory, recipe);
            if (validationFailure != null) {
                return failSmeltCharcoal(effective, activeSmeltCharcoal, inventory, nowMs, validationFailure);
            }
        }

        SmeltCharcoalRun run = activeSmeltCharcoal;
        CraftInventorySnapshot inventory = captureCraftInventory(player);
        SmeltControlPlanner.Decision preflight = SmeltControlPlanner.decidePreflight(
            smeltControlState(run),
            FurnaceSmeltPlanner.completedByInventoryDelta(smeltBaselineOutput(run), smeltOutputCount(inventory, recipe), 1),
            nowMs - run.startedAtMs > FURNACE_SMELT_TOTAL_TIMEOUT_MS,
            client.interactionManager != null
        );
        if (preflight.action() == SmeltControlPlanner.Action.COMPLETE_TYPED_DELTA) {
            return completeSmeltCharcoal(effective, run, inventory, nowMs, action + "_" + preflight.reason());
        }
        if (preflight.action() == SmeltControlPlanner.Action.FAIL_TOTAL_TIMEOUT
            || preflight.action() == SmeltControlPlanner.Action.FAIL_MISSING_INTERACTION_MANAGER) {
            return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_" + preflight.reason());
        }

        ScreenHandler currentHandler = player.currentScreenHandler;
        if (!(currentHandler instanceof AbstractFurnaceScreenHandler furnaceHandler)) {
            if (currentHandler != null && currentHandler != player.playerScreenHandler) {
                String previousHandler = currentHandler.getClass().getSimpleName();
                player.closeHandledScreen();
                LOGGER.info(
                    "{}.close_screen instanceId={} commandId={} handler={}",
                    action,
                    instanceId,
                    commandId,
                    previousHandler
                );
                return new ControlDecision(stopFrom(effective, action + "_close_screen_before_open"), InputState.stop());
            }
            BlockPos furnace = selectNearbyFurnace(client, player);
            if (furnace == null) {
                return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_no_nearby_furnace");
            }
            Vec3d target = Vec3d.ofCenter(furnace);
            LookAngles furnaceLook = lookAnglesToPoint(player, target);
            if (Math.abs(LookController.normalizeYaw(furnaceLook.yaw() - player.getYaw())) > 4.0D
                || Math.abs(furnaceLook.pitch() - player.getPitch()) > 4.0D) {
                return new ControlDecision(lookIntentForAngles(effective, furnaceLook.yaw(), furnaceLook.pitch(), action + "_look_at_furnace"), InputState.stop());
            }
            BlockHitResult hit = raycastForInteraction(player, client);
            boolean blockHit = hit != null && hit.getType() == HitResult.Type.BLOCK;
            BlockPos hitBlock = blockHit ? hit.getBlockPos().toImmutable() : null;
            if (!blockHit || hitBlock == null || !client.world.getBlockState(hitBlock).isOf(Blocks.FURNACE)) {
                return new ControlDecision(stopFrom(effective, action + "_waiting_for_furnace_raycast"), InputState.stop());
            }
            if (!withinInteractionReach(player, hit.getPos())) {
                return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_furnace_out_of_reach");
            }
            ActionResult result = client.interactionManager.interactBlock(player, Hand.MAIN_HAND, hit);
            player.swingHand(Hand.MAIN_HAND);
            LOGGER.info(
                "{}.open_interact instanceId={} commandId={} result={} hitBlock={} hitSide={} elapsedMs={}",
                action,
                instanceId,
                commandId,
                result,
                formatBlockPos(hitBlock),
                hit.getSide() == null ? "none" : hit.getSide().asString(),
                Math.max(0L, nowMs - run.startedAtMs)
            );
            return new ControlDecision(stopFrom(effective, action + "_opening_furnace:" + result), InputState.stop());
        }

        if (run.stage == SmeltControlPlanner.Stage.START) {
            LOGGER.info(
                "{}.furnace_opened instanceId={} commandId={} handler={} syncId={} inputSlot={} fuelSlot={} outputSlot={}",
                action,
                instanceId,
                commandId,
                furnaceHandler.getClass().getSimpleName(),
                furnaceHandler.syncId,
                FurnaceSmeltPlanner.INPUT_SLOT,
                FurnaceSmeltPlanner.FUEL_SLOT,
                FurnaceSmeltPlanner.OUTPUT_SLOT
            );
            ItemStack inputSlotStack = furnaceHandler.getSlot(FurnaceSmeltPlanner.INPUT_SLOT).getStack();
            ItemStack fuelSlotStack = furnaceHandler.getSlot(FurnaceSmeltPlanner.FUEL_SLOT).getStack();
            ItemStack outputSlotStack = furnaceHandler.getSlot(FurnaceSmeltPlanner.OUTPUT_SLOT).getStack();
            String loadedFuelItemId = itemId(fuelSlotStack);
            boolean loadedFuelCompatible = !fuelSlotStack.isEmpty() && isSmeltFuelItem(fuelSlotStack, loadedFuelItemId);
            SmeltControlPlanner.Decision furnaceOpened = SmeltControlPlanner.decideFurnaceOpened(
                smeltControlState(run),
                furnaceHandler.getCursorStack().isEmpty(),
                inputSlotStack.isEmpty(),
                fuelSlotStack.isEmpty(),
                outputSlotStack.isEmpty(),
                loadedFuelCompatible
            );
            if (furnaceOpened.action() == SmeltControlPlanner.Action.FAIL_CURSOR_NOT_EMPTY
                || furnaceOpened.action() == SmeltControlPlanner.Action.FAIL_FURNACE_NOT_EMPTY) {
                return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_" + furnaceOpened.reason());
            }
            if (loadedFuelCompatible) {
                run.fuelItemId = loadedFuelItemId;
                LOGGER.info(
                    "{}.loaded_fuel_reusable instanceId={} commandId={} fuelItem={} fuelCount={}",
                    action,
                    instanceId,
                    commandId,
                    loadedFuelItemId,
                    fuelSlotStack.getCount()
                );
            }
            applySmeltControlDecision(run, furnaceOpened, nowMs);
        }

        SmeltControlPlanner.Decision clickSettle = SmeltControlPlanner.decideClickSettle(
            smeltControlState(run),
            run.lastClickAtMs > 0L && nowMs - run.lastClickAtMs < CRAFT_CLICK_SETTLE_MS
        );
        if (clickSettle.action() == SmeltControlPlanner.Action.WAIT_CLICK_SETTLE) {
            return new ControlDecision(stopFrom(effective, action + "_" + clickSettle.reason()), InputState.stop());
        }

        if (run.stage == SmeltControlPlanner.Stage.SELECT_INPUT) {
            int sourceSlot = findFurnaceSourceScreenSlot(
                furnaceHandler,
                (stack, itemId) -> matchesSmeltInput(recipe, stack, itemId)
            );
            SmeltControlPlanner.Decision inputSource = SmeltControlPlanner.decideInputSource(smeltControlState(run), sourceSlot >= 0);
            if (inputSource.action() == SmeltControlPlanner.Action.FAIL_INPUT_SOURCE_MISSING) {
                return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_" + inputSource.reason());
            }
            run.inputSourceSlot = sourceSlot;
            run.inputItemId = itemId(furnaceHandler.getSlot(sourceSlot).getStack());
            LOGGER.info(
                "{}.source_slot_selected instanceId={} commandId={} label=input slot={} item={}",
                action,
                instanceId,
                commandId,
                sourceSlot,
                run.inputItemId
            );
            applySmeltControlDecision(run, inputSource, nowMs);
        }

        if (run.stage == SmeltControlPlanner.Stage.PICK_INPUT_STACK) {
            SmeltControlPlanner.Decision pickInput = SmeltControlPlanner.decideStage(smeltControlState(run), smeltObservation(furnaceHandler, recipe, run, nowMs));
            clickSmeltSlot(client, player, furnaceHandler, run, run.inputSourceSlot, 0, SlotActionType.PICKUP, "pick_input_stack", nowMs);
            applySmeltControlDecision(run, pickInput, nowMs);
            return new ControlDecision(stopFrom(effective, action + "_pick_input"), InputState.stop());
        }

        if (run.stage == SmeltControlPlanner.Stage.PLACE_INPUT) {
            SmeltControlPlanner.Decision placeInput = SmeltControlPlanner.decideStage(smeltControlState(run), smeltObservation(furnaceHandler, recipe, run, nowMs));
            if (placeInput.action() == SmeltControlPlanner.Action.FAIL_CURSOR_EMPTY_BEFORE_INPUT) {
                return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_" + placeInput.reason());
            }
            clickSmeltSlot(client, player, furnaceHandler, run, FurnaceSmeltPlanner.INPUT_SLOT, 1, SlotActionType.PICKUP, "place_one_input", nowMs);
            applySmeltControlDecision(run, placeInput, nowMs);
            return new ControlDecision(stopFrom(effective, action + "_place_input"), InputState.stop());
        }

        if (run.stage == SmeltControlPlanner.Stage.RETURN_INPUT_REMAINDER) {
            ItemStack loadedFuel = furnaceHandler.getSlot(FurnaceSmeltPlanner.FUEL_SLOT).getStack();
            String loadedFuelItemId = itemId(loadedFuel);
            boolean loadedFuelCompatible = !loadedFuel.isEmpty() && isSmeltFuelItem(loadedFuel, loadedFuelItemId);
            SmeltControlPlanner.Decision returnInput = SmeltControlPlanner.decideStage(
                smeltControlState(run),
                smeltObservation(furnaceHandler, recipe, run, nowMs, loadedFuelCompatible)
            );
            if (returnInput.action() == SmeltControlPlanner.Action.RETURN_INPUT_REMAINDER) {
                clickSmeltSlot(client, player, furnaceHandler, run, run.inputSourceSlot, 0, SlotActionType.PICKUP, "return_input_remainder", nowMs);
                return new ControlDecision(stopFrom(effective, action + "_return_input_remainder"), InputState.stop());
            }
            if (returnInput.action() == SmeltControlPlanner.Action.REUSE_LOADED_FUEL) {
                run.fuelItemId = loadedFuelItemId;
                LOGGER.info(
                    "{}.reuse_loaded_fuel instanceId={} commandId={} fuelItem={} fuelCount={}",
                    action,
                    instanceId,
                    commandId,
                    loadedFuelItemId,
                    loadedFuel.getCount()
                );
                run.outputWaitStartedAtMs = nowMs;
            }
            applySmeltControlDecision(run, returnInput, nowMs);
        }

        if (run.stage == SmeltControlPlanner.Stage.SELECT_FUEL) {
            int sourceSlot = findFurnaceFuelSourceScreenSlot(furnaceHandler);
            SmeltControlPlanner.Decision fuelSource = SmeltControlPlanner.decideFuelSource(smeltControlState(run), sourceSlot >= 0);
            if (fuelSource.action() == SmeltControlPlanner.Action.FAIL_FUEL_SOURCE_MISSING) {
                return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_" + fuelSource.reason());
            }
            run.fuelSourceSlot = sourceSlot;
            run.fuelItemId = itemId(furnaceHandler.getSlot(sourceSlot).getStack());
            LOGGER.info(
                "{}.source_slot_selected instanceId={} commandId={} label=fuel slot={} item={}",
                action,
                instanceId,
                commandId,
                sourceSlot,
                run.fuelItemId
            );
            applySmeltControlDecision(run, fuelSource, nowMs);
        }

        if (run.stage == SmeltControlPlanner.Stage.PICK_FUEL_STACK) {
            SmeltControlPlanner.Decision pickFuel = SmeltControlPlanner.decideStage(smeltControlState(run), smeltObservation(furnaceHandler, recipe, run, nowMs));
            clickSmeltSlot(client, player, furnaceHandler, run, run.fuelSourceSlot, 0, SlotActionType.PICKUP, "pick_fuel_stack", nowMs);
            applySmeltControlDecision(run, pickFuel, nowMs);
            return new ControlDecision(stopFrom(effective, action + "_pick_fuel"), InputState.stop());
        }

        if (run.stage == SmeltControlPlanner.Stage.PLACE_FUEL) {
            SmeltControlPlanner.Decision placeFuel = SmeltControlPlanner.decideStage(smeltControlState(run), smeltObservation(furnaceHandler, recipe, run, nowMs));
            if (placeFuel.action() == SmeltControlPlanner.Action.FAIL_CURSOR_EMPTY_BEFORE_FUEL) {
                return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_" + placeFuel.reason());
            }
            clickSmeltSlot(client, player, furnaceHandler, run, FurnaceSmeltPlanner.FUEL_SLOT, 1, SlotActionType.PICKUP, "place_one_fuel", nowMs);
            applySmeltControlDecision(run, placeFuel, nowMs);
            return new ControlDecision(stopFrom(effective, action + "_place_fuel"), InputState.stop());
        }

        if (run.stage == SmeltControlPlanner.Stage.RETURN_FUEL_REMAINDER) {
            SmeltControlPlanner.Decision returnFuel = SmeltControlPlanner.decideStage(smeltControlState(run), smeltObservation(furnaceHandler, recipe, run, nowMs));
            if (returnFuel.action() == SmeltControlPlanner.Action.RETURN_FUEL_REMAINDER) {
                clickSmeltSlot(client, player, furnaceHandler, run, run.fuelSourceSlot, 0, SlotActionType.PICKUP, "return_fuel_remainder", nowMs);
                return new ControlDecision(stopFrom(effective, action + "_return_fuel_remainder"), InputState.stop());
            }
            run.outputWaitStartedAtMs = nowMs;
            applySmeltControlDecision(run, returnFuel, nowMs);
        }

        if (run.stage == SmeltControlPlanner.Stage.WAIT_OUTPUT) {
            ItemStack output = furnaceHandler.getSlot(FurnaceSmeltPlanner.OUTPUT_SLOT).getStack();
            String outputId = itemId(output);
            SmeltControlPlanner.Decision outputDecision = SmeltControlPlanner.decideStage(smeltControlState(run), smeltObservation(furnaceHandler, recipe, run, nowMs));
            if (outputDecision.action() == SmeltControlPlanner.Action.FAIL_WRONG_OUTPUT
                || outputDecision.action() == SmeltControlPlanner.Action.FAIL_OUTPUT_TIMEOUT) {
                return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_" + outputDecision.reason());
            }
            if (outputDecision.action() == SmeltControlPlanner.Action.OUTPUT_READY) {
                LOGGER.info(
                    "{}.output_ready instanceId={} commandId={} output={} count={} waitMs={}",
                    action,
                    instanceId,
                    commandId,
                    outputId,
                    output.getCount(),
                    Math.max(0L, nowMs - run.outputWaitStartedAtMs)
                );
                applySmeltControlDecision(run, outputDecision, nowMs);
            } else {
                return new ControlDecision(stopFrom(effective, action + "_" + outputDecision.reason()), InputState.stop());
            }
        }

        if (run.stage == SmeltControlPlanner.Stage.TAKE_OUTPUT) {
            SmeltControlPlanner.Decision takeOutput = SmeltControlPlanner.decideStage(smeltControlState(run), smeltObservation(furnaceHandler, recipe, run, nowMs));
            clickSmeltSlot(client, player, furnaceHandler, run, FurnaceSmeltPlanner.OUTPUT_SLOT, 0, SlotActionType.QUICK_MOVE, "take_output", nowMs);
            applySmeltControlDecision(run, takeOutput, nowMs);
            return new ControlDecision(stopFrom(effective, action + "_take_output"), InputState.stop());
        }

        if (run.stage == SmeltControlPlanner.Stage.VERIFY) {
            SmeltControlPlanner.Decision verify = SmeltControlPlanner.decideStage(smeltControlState(run), smeltObservation(furnaceHandler, recipe, run, nowMs));
            if (verify.action() == SmeltControlPlanner.Action.FAIL_TYPED_DELTA_MISSING) {
                return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_" + verify.reason());
            }
            return new ControlDecision(stopFrom(effective, action + "_" + verify.reason()), InputState.stop());
        }

        return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_unknown_stage");
    }

    private ControlDecision completeSmeltCharcoal(
        BrainLink.Intent effective,
        SmeltCharcoalRun run,
        CraftInventorySnapshot inventory,
        long nowMs,
        String reason
    ) {
        completedSmeltCharcoalCommandIds.add(run.commandId);
        String action = run.recipe.action();
        LOGGER.info(
            "{}.complete instanceId={} commandId={} reason={} inputItem={} fuelItem={} outputItem={} inventoryInputBefore={} inventoryInputAfter={} inventoryOutputBefore={} inventoryOutputAfter={} inventoryLogsBefore={} inventoryLogsAfter={} inventoryPlanksBefore={} inventoryPlanksAfter={} inventoryCharcoalBefore={} inventoryCharcoalAfter={} inventoryCoalAfter={} inventoryRawIronBefore={} inventoryRawIronAfter={} inventoryIronIngotsBefore={} inventoryIronIngotsAfter={} logsByItem={} planksByItem={} charcoalByItem={} coalByItem={} rawIronByItem={} ironIngotsByItem={} elapsedMs={}",
            action,
            instanceId,
            run.commandId,
            reason,
            run.inputItemId,
            run.fuelItemId,
            run.recipe.outputItemId(),
            smeltBaselineInput(run),
            smeltInputCount(inventory, run.recipe),
            smeltBaselineOutput(run),
            smeltOutputCount(inventory, run.recipe),
            run.baselineLogs,
            inventory.logs.logCount(),
            run.baselinePlanks,
            inventory.planks.plankCount(),
            run.baselineCharcoal,
            inventory.charcoal.itemCount(),
            inventory.coal.itemCount(),
            run.baselineRawIron,
            inventory.rawIron.itemCount(),
            run.baselineIronIngots,
            inventory.ironIngots.itemCount(),
            inventory.logs.logsByItem(),
            inventory.planks.planksByItem(),
            inventory.charcoal.itemsByItem(),
            inventory.coal.itemsByItem(),
            inventory.rawIron.itemsByItem(),
            inventory.ironIngots.itemsByItem(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeSmeltCharcoal = null;
        brainLink.completeCurrentCommand(run.commandId, action + "_complete:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, action + "_complete:" + reason), InputState.stop());
    }

    private ControlDecision failSmeltCharcoal(
        BrainLink.Intent effective,
        SmeltCharcoalRun run,
        CraftInventorySnapshot inventory,
        long nowMs,
        String reason
    ) {
        completedSmeltCharcoalCommandIds.add(run.commandId);
        String action = run.recipe.action();
        LOGGER.warn(
            "{}.failed instanceId={} commandId={} reason={} stage={} inputItem={} fuelItem={} outputItem={} inventoryInputBefore={} inventoryInputAfter={} inventoryOutputBefore={} inventoryOutputAfter={} inventoryLogsBefore={} inventoryLogsAfter={} inventoryPlanksBefore={} inventoryPlanksAfter={} inventoryCharcoalBefore={} inventoryCharcoalAfter={} inventoryCoalAfter={} inventoryRawIronBefore={} inventoryRawIronAfter={} inventoryIronIngotsBefore={} inventoryIronIngotsAfter={} logsByItem={} planksByItem={} charcoalByItem={} coalByItem={} rawIronByItem={} ironIngotsByItem={} elapsedMs={}",
            action,
            instanceId,
            run.commandId,
            reason,
            run.stage,
            run.inputItemId,
            run.fuelItemId,
            run.recipe.outputItemId(),
            smeltBaselineInput(run),
            smeltInputCount(inventory, run.recipe),
            smeltBaselineOutput(run),
            smeltOutputCount(inventory, run.recipe),
            run.baselineLogs,
            inventory.logs.logCount(),
            run.baselinePlanks,
            inventory.planks.plankCount(),
            run.baselineCharcoal,
            inventory.charcoal.itemCount(),
            inventory.coal.itemCount(),
            run.baselineRawIron,
            inventory.rawIron.itemCount(),
            run.baselineIronIngots,
            inventory.ironIngots.itemCount(),
            inventory.logs.logsByItem(),
            inventory.planks.planksByItem(),
            inventory.charcoal.itemsByItem(),
            inventory.coal.itemsByItem(),
            inventory.rawIron.itemsByItem(),
            inventory.ironIngots.itemsByItem(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeSmeltCharcoal = null;
        brainLink.completeCurrentCommand(run.commandId, action + "_failed:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, action + "_failed:" + reason), InputState.stop());
    }

    private SmeltControlPlanner.State smeltControlState(SmeltCharcoalRun run) {
        return new SmeltControlPlanner.State(run.stage);
    }

    private void applySmeltControlDecision(SmeltCharcoalRun run, SmeltControlPlanner.Decision decision, long nowMs) {
        SmeltControlPlanner.Stage nextStage = decision.state().stage();
        if (nextStage != run.stage) {
            transitionSmeltCharcoalStage(run, nextStage, nowMs);
        }
    }

    private SmeltControlPlanner.StageObservation smeltObservation(
        AbstractFurnaceScreenHandler furnaceHandler,
        FurnaceSmeltRecipe recipe,
        SmeltCharcoalRun run,
        long nowMs
    ) {
        ItemStack loadedFuel = furnaceHandler.getSlot(FurnaceSmeltPlanner.FUEL_SLOT).getStack();
        String loadedFuelItemId = itemId(loadedFuel);
        boolean loadedFuelCompatible = !loadedFuel.isEmpty() && isSmeltFuelItem(loadedFuel, loadedFuelItemId);
        return smeltObservation(furnaceHandler, recipe, run, nowMs, loadedFuelCompatible);
    }

    private SmeltControlPlanner.StageObservation smeltObservation(
        AbstractFurnaceScreenHandler furnaceHandler,
        FurnaceSmeltRecipe recipe,
        SmeltCharcoalRun run,
        long nowMs,
        boolean loadedFuelCompatible
    ) {
        ItemStack output = furnaceHandler.getSlot(FurnaceSmeltPlanner.OUTPUT_SLOT).getStack();
        return new SmeltControlPlanner.StageObservation(
            furnaceHandler.getCursorStack().isEmpty(),
            loadedFuelCompatible,
            itemId(output),
            output.getCount(),
            recipe.outputItemId(),
            nowMs - run.outputWaitStartedAtMs > FURNACE_OUTPUT_WAIT_MS,
            nowMs - run.stageStartedAtMs > CRAFT_VERIFY_WAIT_MS
        );
    }

    private void transitionSmeltCharcoalStage(SmeltCharcoalRun run, SmeltControlPlanner.Stage stage, long nowMs) {
        run.stage = stage;
        run.stageStartedAtMs = nowMs;
    }

    private void clickSmeltSlot(
        MinecraftClient client,
        ClientPlayerEntity player,
        ScreenHandler handler,
        SmeltCharcoalRun run,
        int slot,
        int button,
        SlotActionType action,
        String label,
        long nowMs
    ) {
        client.interactionManager.clickSlot(handler.syncId, slot, button, action, player);
        run.lastClickAtMs = nowMs;
        LOGGER.info(
            "{}.click instanceId={} commandId={} label={} slot={} button={} action={} handler={} syncId={}",
            run.recipe.action(),
            instanceId,
            run.commandId,
            label,
            slot,
            button,
            action,
            handler.getClass().getSimpleName(),
            handler.syncId
        );
    }

    private String validateSmeltRecipeInputs(CraftInventorySnapshot inventory, FurnaceSmeltRecipe recipe) {
        if (smeltInputCount(inventory, recipe) < 1) {
            return recipe.action() + "_no_input";
        }
        if (recipe == FurnaceSmeltRecipe.CHARCOAL
            && inventory.planks.plankCount() < 1
            && inventory.logs.logCount() < 2
            && inventory.charcoal.itemCount() < 1
            && inventory.coal.itemCount() < 1) {
            return recipe.action() + "_no_fuel";
        }
        if (recipe == FurnaceSmeltRecipe.RAW_IRON && smeltFuelCount(inventory) < 1) {
            return recipe.action() + "_no_fuel";
        }
        return null;
    }

    private int smeltBaselineInput(SmeltCharcoalRun run) {
        return switch (run.recipe) {
            case CHARCOAL -> run.baselineLogs;
            case RAW_IRON -> run.baselineRawIron;
        };
    }

    private int smeltBaselineOutput(SmeltCharcoalRun run) {
        return switch (run.recipe) {
            case CHARCOAL -> run.baselineCharcoal;
            case RAW_IRON -> run.baselineIronIngots;
        };
    }

    private int smeltInputCount(CraftInventorySnapshot inventory, FurnaceSmeltRecipe recipe) {
        if (inventory == null || recipe == null) {
            return 0;
        }
        return switch (recipe) {
            case CHARCOAL -> inventory.logs.logCount();
            case RAW_IRON -> inventory.rawIron.itemCount();
        };
    }

    private int smeltOutputCount(CraftInventorySnapshot inventory, FurnaceSmeltRecipe recipe) {
        if (inventory == null || recipe == null) {
            return 0;
        }
        return switch (recipe) {
            case CHARCOAL -> inventory.charcoal.itemCount();
            case RAW_IRON -> inventory.ironIngots.itemCount();
        };
    }

    private int smeltFuelCount(CraftInventorySnapshot inventory) {
        if (inventory == null) {
            return 0;
        }
        return inventory.charcoal.itemCount()
            + inventory.coal.itemCount()
            + inventory.planks.plankCount()
            + inventory.logs.logCount();
    }

    private boolean matchesSmeltInput(FurnaceSmeltRecipe recipe, ItemStack stack, String itemId) {
        return switch (recipe) {
            case CHARCOAL -> stack.isIn(ItemTags.LOGS) || InventoryCounter.isLogItemId(itemId);
            case RAW_IRON -> "raw_iron".equalsIgnoreCase(itemId == null ? "" : itemId.trim());
        };
    }

    private int findFurnaceFuelSourceScreenSlot(ScreenHandler handler) {
        int sourceSlot = findFurnaceSourceScreenSlot(
            handler,
            (stack, itemId) -> isCharcoalOrCoalFuel(itemId)
        );
        if (sourceSlot >= 0) {
            return sourceSlot;
        }
        sourceSlot = findFurnaceSourceScreenSlot(handler, (stack, itemId) -> InventoryCounter.isPlankItemId(itemId));
        if (sourceSlot >= 0) {
            return sourceSlot;
        }
        return findFurnaceSourceScreenSlot(
            handler,
            (stack, itemId) -> stack.isIn(ItemTags.LOGS) || InventoryCounter.isLogItemId(itemId)
        );
    }

    private boolean isCharcoalOrCoalFuel(String itemId) {
        String id = itemId == null ? "" : itemId.trim();
        return "charcoal".equalsIgnoreCase(id)
            || "coal".equalsIgnoreCase(id);
    }

    private boolean isSmeltFuelItem(ItemStack stack, String itemId) {
        if (isCharcoalOrCoalFuel(itemId)) {
            return true;
        }
        if (InventoryCounter.isPlankItemId(itemId)) {
            return true;
        }
        return (stack != null && stack.isIn(ItemTags.LOGS))
            || InventoryCounter.isLogItemId(itemId);
    }

    private int findFurnaceSourceScreenSlot(ScreenHandler handler, BiPredicate<ItemStack, String> predicate) {
        int end = Math.min(handler.slots.size(), 46);
        for (int slot = FurnaceSmeltPlanner.PLAYER_INVENTORY_START_SLOT; slot < end; slot++) {
            ItemStack stack = handler.getSlot(slot).getStack();
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String id = itemId(stack);
            if (predicate.test(stack, id)) {
                return slot;
            }
        }
        return -1;
    }

    private BlockPos selectNearbyFurnace(MinecraftClient client, ClientPlayerEntity player) {
        BlockPos origin = player.getBlockPos();
        BlockPos selected = null;
        double bestDistance = Double.MAX_VALUE;
        for (int dy = -1; dy <= 2; dy++) {
            for (int dx = -4; dx <= 4; dx++) {
                for (int dz = -4; dz <= 4; dz++) {
                    BlockPos pos = origin.add(dx, dy, dz);
                    if (!client.world.getBlockState(pos).isOf(Blocks.FURNACE)) {
                        continue;
                    }
                    double distance = player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(pos));
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        selected = pos.toImmutable();
                    }
                }
            }
        }
        return selected;
    }

    private ControlDecision resolveMakeCharcoalControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (completedMakeCharcoalCommandIds.contains(commandId)) {
            return new ControlDecision(stopFrom(effective, "make_charcoal_complete"), InputState.stop());
        }
        if (activeMakeCharcoal == null || !commandId.equals(activeMakeCharcoal.commandId)) {
            CraftInventorySnapshot inventory = captureCraftInventory(player);
            activeMakeCharcoal = new MakeCharcoalRun(commandId, inventory, nowMs);
            LOGGER.info(
                "make_charcoal.start instanceId={} commandId={} inventoryCobblestoneBefore={} inventoryLogsBefore={} inventoryPlanksBefore={} inventoryFurnacesBefore={} inventoryCharcoalBefore={} cobblestoneByItem={} logsByItem={} planksByItem={} furnacesByItem={} charcoalByItem={}",
                instanceId,
                commandId,
                inventory.cobblestone.cobblestoneCount(),
                inventory.logs.logCount(),
                inventory.planks.plankCount(),
                inventory.furnaces.itemCount(),
                inventory.charcoal.itemCount(),
                inventory.cobblestone.cobblestoneByItem(),
                inventory.logs.logsByItem(),
                inventory.planks.planksByItem(),
                inventory.furnaces.itemsByItem(),
                inventory.charcoal.itemsByItem()
            );
            if (inventory.cobblestone.cobblestoneCount() < 8) {
                return failMakeCharcoal(effective, activeMakeCharcoal, inventory, nowMs, "make_charcoal_no_cobblestone");
            }
            if (inventory.logs.logCount() < 1) {
                return failMakeCharcoal(effective, activeMakeCharcoal, inventory, nowMs, "make_charcoal_no_log_input");
            }
            if (inventory.planks.plankCount() < 1 && inventory.logs.logCount() < 2) {
                return failMakeCharcoal(effective, activeMakeCharcoal, inventory, nowMs, "make_charcoal_no_fuel");
            }
            if (selectNearbyCraftingTable(client, player) == null) {
                return failMakeCharcoal(effective, activeMakeCharcoal, inventory, nowMs, "make_charcoal_no_nearby_table");
            }
        }

        MakeCharcoalRun run = activeMakeCharcoal;
        CraftInventorySnapshot inventory = captureCraftInventory(player);
        if (FurnaceSmeltPlanner.completedByInventoryDelta(run.baselineCharcoal, inventory.charcoal.itemCount(), 1)
            && completedSmeltCharcoalCommandIds.contains(run.smeltCharcoalCommandId())) {
            return completeMakeCharcoal(effective, run, inventory, nowMs, "make_charcoal_typed_delta_verified");
        }
        if (nowMs - run.startedAtMs > MAKE_CHARCOAL_TOTAL_TIMEOUT_MS) {
            return failMakeCharcoal(effective, run, inventory, nowMs, "make_charcoal_timeout");
        }

        if (run.phase == MakeCharcoalPhase.CRAFT_FURNACE) {
            if (inventory.furnaces.itemCount() > run.baselineFurnaces) {
                if (!completedCraft3x3CommandIds.contains(run.craftFurnaceCommandId())) {
                    return resolveCraft3x3Control(client, player, makeSubIntent(effective, "craft_furnace", run.craftFurnaceCommandId(), "make_charcoal_craft_furnace"), nowMs);
                }
                run.placeBaselineFurnaces = inventory.furnaces.itemCount();
                transitionMakeCharcoalPhase(run, MakeCharcoalPhase.PLACE_FURNACE, nowMs);
                LOGGER.info(
                    "make_charcoal.phase instanceId={} commandId={} phase=place_furnace inventoryFurnaces={}",
                    instanceId,
                    run.commandId,
                    inventory.furnaces.itemCount()
                );
                return new ControlDecision(stopFrom(effective, "make_charcoal_phase_place_furnace"), InputState.stop());
            }
            if (completedCraft3x3CommandIds.contains(run.craftFurnaceCommandId())) {
                return failMakeCharcoal(effective, run, inventory, nowMs, "make_charcoal_craft_furnace_no_delta");
            }
            return resolveCraft3x3Control(client, player, makeSubIntent(effective, "craft_furnace", run.craftFurnaceCommandId(), "make_charcoal_craft_furnace"), nowMs);
        }

        if (run.phase == MakeCharcoalPhase.PLACE_FURNACE) {
            if (run.placeBaselineFurnaces < 0) {
                run.placeBaselineFurnaces = inventory.furnaces.itemCount();
            }
            if (inventory.furnaces.itemCount() < run.placeBaselineFurnaces && selectNearbyFurnace(client, player) != null) {
                if (!completedPlaceFurnaceCommandIds.contains(run.placeFurnaceCommandId())) {
                    return resolvePlaceFurnaceControl(client, player, makeSubIntent(effective, "place_furnace", run.placeFurnaceCommandId(), "make_charcoal_place_furnace"), nowMs);
                }
                transitionMakeCharcoalPhase(run, MakeCharcoalPhase.SMELT_CHARCOAL, nowMs);
                LOGGER.info(
                    "make_charcoal.phase instanceId={} commandId={} phase=smelt_charcoal inventoryFurnaces={}",
                    instanceId,
                    run.commandId,
                    inventory.furnaces.itemCount()
                );
                return new ControlDecision(stopFrom(effective, "make_charcoal_phase_smelt_charcoal"), InputState.stop());
            }
            if (completedPlaceFurnaceCommandIds.contains(run.placeFurnaceCommandId())) {
                return failMakeCharcoal(effective, run, inventory, nowMs, "make_charcoal_place_furnace_no_world_delta");
            }
            return resolvePlaceFurnaceControl(client, player, makeSubIntent(effective, "place_furnace", run.placeFurnaceCommandId(), "make_charcoal_place_furnace"), nowMs);
        }

        if (run.phase == MakeCharcoalPhase.SMELT_CHARCOAL) {
            if (FurnaceSmeltPlanner.completedByInventoryDelta(run.baselineCharcoal, inventory.charcoal.itemCount(), 1)) {
                if (!completedSmeltCharcoalCommandIds.contains(run.smeltCharcoalCommandId())) {
                    return resolveSmeltCharcoalControl(client, player, makeSubIntent(effective, "smelt_charcoal", run.smeltCharcoalCommandId(), "make_charcoal_smelt_charcoal"), nowMs);
                }
                return completeMakeCharcoal(effective, run, inventory, nowMs, "make_charcoal_typed_delta_verified");
            }
            if (completedSmeltCharcoalCommandIds.contains(run.smeltCharcoalCommandId())
                && !FurnaceSmeltPlanner.completedByInventoryDelta(run.baselineCharcoal, inventory.charcoal.itemCount(), 1)) {
                return failMakeCharcoal(effective, run, inventory, nowMs, "make_charcoal_smelt_no_charcoal_delta");
            }
            return resolveSmeltCharcoalControl(client, player, makeSubIntent(effective, "smelt_charcoal", run.smeltCharcoalCommandId(), "make_charcoal_smelt_charcoal"), nowMs);
        }

        return failMakeCharcoal(effective, run, inventory, nowMs, "make_charcoal_unknown_phase");
    }

    private ControlDecision completeMakeCharcoal(
        BrainLink.Intent effective,
        MakeCharcoalRun run,
        CraftInventorySnapshot inventory,
        long nowMs,
        String reason
    ) {
        completedMakeCharcoalCommandIds.add(run.commandId);
        LOGGER.info(
            "make_charcoal.complete instanceId={} commandId={} reason={} phase={} inventoryCobblestoneBefore={} inventoryCobblestoneAfter={} inventoryLogsBefore={} inventoryLogsAfter={} inventoryPlanksBefore={} inventoryPlanksAfter={} inventoryFurnacesBefore={} inventoryFurnacesAfter={} inventoryCharcoalBefore={} inventoryCharcoalAfter={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            run.phase,
            run.baselineCobblestone,
            inventory.cobblestone.cobblestoneCount(),
            run.baselineLogs,
            inventory.logs.logCount(),
            run.baselinePlanks,
            inventory.planks.plankCount(),
            run.baselineFurnaces,
            inventory.furnaces.itemCount(),
            run.baselineCharcoal,
            inventory.charcoal.itemCount(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeMakeCharcoal = null;
        brainLink.completeCurrentCommand(run.commandId, "make_charcoal_complete:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "make_charcoal_complete:" + reason), InputState.stop());
    }

    private ControlDecision failMakeCharcoal(
        BrainLink.Intent effective,
        MakeCharcoalRun run,
        CraftInventorySnapshot inventory,
        long nowMs,
        String reason
    ) {
        completedMakeCharcoalCommandIds.add(run.commandId);
        LOGGER.warn(
            "make_charcoal.failed instanceId={} commandId={} reason={} phase={} inventoryCobblestoneBefore={} inventoryCobblestoneAfter={} inventoryLogsBefore={} inventoryLogsAfter={} inventoryPlanksBefore={} inventoryPlanksAfter={} inventoryFurnacesBefore={} inventoryFurnacesAfter={} inventoryCharcoalBefore={} inventoryCharcoalAfter={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            run.phase,
            run.baselineCobblestone,
            inventory.cobblestone.cobblestoneCount(),
            run.baselineLogs,
            inventory.logs.logCount(),
            run.baselinePlanks,
            inventory.planks.plankCount(),
            run.baselineFurnaces,
            inventory.furnaces.itemCount(),
            run.baselineCharcoal,
            inventory.charcoal.itemCount(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeMakeCharcoal = null;
        brainLink.completeCurrentCommand(run.commandId, "make_charcoal_failed:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "make_charcoal_failed:" + reason), InputState.stop());
    }

    private void transitionMakeCharcoalPhase(MakeCharcoalRun run, MakeCharcoalPhase phase, long nowMs) {
        run.phase = phase;
        run.phaseStartedAtMs = nowMs;
    }

    private BrainLink.Intent makeSubIntent(BrainLink.Intent source, String action, String commandId, String reason) {
        return new BrainLink.Intent(
            action,
            false,
            false,
            false,
            false,
            false,
            false,
            null,
            null,
            source.targetX(),
            source.targetY(),
            source.targetZ(),
            List.of(),
            List.of(),
            null,
            List.of(),
            source.expiresAtMs(),
            reason,
            commandId
        );
    }

    private ControlDecision resolvePlaceTableControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        return resolvePlaceTableControl(client, player, effective, nowMs, null);
    }

    private ControlDecision resolvePlaceTableControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs, BlockPos supportOverride) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (completedPlaceTableCommandIds.contains(commandId)) {
            return new ControlDecision(stopFrom(effective, "place_table_complete"), InputState.stop());
        }
        InventoryCounter.InventoryCraftingTableSnapshot tables = InventoryCounter.countPlayerCraftingTables(player);
        if (!commandId.equals(activePlaceTableCommandId)) {
            activePlaceTableCommandId = commandId;
            activePlaceTableBaselineTables = tables.craftingTableCount();
            activePlaceTableSupportTarget = null;
        }
        boolean awaitingPlacementVerification = blockPlaceController.isAwaitingVerification(commandId);
        PlaceWorkstationPlanner.Decision inventoryDecision = PlaceWorkstationPlanner.decideInventory(
            tables.craftingTableCount() >= 1,
            awaitingPlacementVerification,
            "place_table_no_table"
        );
        if (inventoryDecision.action() == PlaceWorkstationPlanner.Action.FAIL_MISSING_ITEM) {
            completedPlaceTableCommandIds.add(commandId);
            LOGGER.warn(
                "place_table.failed instanceId={} commandId={} reason=place_table_no_table inventoryTables={}",
                instanceId,
                commandId,
                tables.craftingTableCount()
            );
            brainLink.completeCurrentCommand(commandId, "place_table_failed:place_table_no_table", nowMs);
            resetPlaceTableRun();
            return new ControlDecision(stopFrom(effective, "place_table_failed:place_table_no_table"), InputState.stop());
        }

        clearNavigationState();
        BlockPos supportTarget = null;
        if (!awaitingPlacementVerification) {
            if (supportOverride != null) {
                supportTarget = supportOverride.toImmutable();
                activePlaceTableSupportTarget = supportTarget;
            } else {
                if (!isValidPlaceSupport(client, player, activePlaceTableSupportTarget)) {
                    activePlaceTableSupportTarget = selectPlaceTableSupport(client, player);
                }
                supportTarget = activePlaceTableSupportTarget;
            }
        }
        PlaceWorkstationPlanner.Decision supportDecision = PlaceWorkstationPlanner.decideSupport(
            awaitingPlacementVerification,
            supportTarget != null,
            "place_table_no_adjacent_support"
        );
        if (supportDecision.action() == PlaceWorkstationPlanner.Action.FAIL_NO_ADJACENT_SUPPORT) {
            completedPlaceTableCommandIds.add(commandId);
            LOGGER.warn(
                "place_table.failed instanceId={} commandId={} reason=place_table_no_adjacent_support inventoryTables={}",
                instanceId,
                commandId,
                tables.craftingTableCount()
            );
            brainLink.completeCurrentCommand(commandId, "place_table_failed:place_table_no_adjacent_support", nowMs);
            resetPlaceTableRun();
            return new ControlDecision(stopFrom(effective, "place_table_failed:place_table_no_adjacent_support"), InputState.stop());
        }
        LookAngles placeLook = new LookAngles(player.getYaw(), player.getPitch());
        if (!awaitingPlacementVerification) {
            BlockPos placementCell = supportTarget.up();
            BlockState placementState = client.world.getBlockState(placementCell);
            if (isReplaceablePlacementOccluder(placementState)) {
                boolean lookingAtPlacementCell = isLookingAtBlock(player, placementCell);
                PlaceWorkstationPlanner.Decision faceClearDecision = PlaceWorkstationPlanner.decideClearSpace(
                    awaitingPlacementVerification,
                    true,
                    lookingAtPlacementCell,
                    BlockBreakController.Status.RUNNING,
                    ""
                );
                if (faceClearDecision.action() == PlaceWorkstationPlanner.Action.FACE_CLEAR_SPACE) {
                    return new ControlDecision(lookIntentForBlock(effective, player, placementCell, "place_table_clear_replaceable_face"), InputState.stop());
                }
                String clearCommandId = commandId + ":clear_place_space";
                BlockBreakController.Result clearResult = blockBreakController.tick(client, player, placementCell, clearCommandId, nowMs);
                logBlockBreakResult(clearCommandId, placementCell, clearResult);
                PlaceWorkstationPlanner.Decision clearDecision = PlaceWorkstationPlanner.decideClearSpace(
                    awaitingPlacementVerification,
                    true,
                    true,
                    clearResult.status(),
                    clearResult.reason()
                );
                if (clearDecision.action() == PlaceWorkstationPlanner.Action.CLEAR_SPACE_BROKEN) {
                    LOGGER.info(
                        "place_table.clear_space instanceId={} commandId={} target={} reason={} elapsedMs={}",
                        instanceId,
                        commandId,
                        placementCell.toShortString(),
                        clearResult.reason(),
                        clearResult.elapsedMs()
                    );
                    return new ControlDecision(stopFrom(effective, "place_table_clear_space:" + clearResult.reason()), InputState.stop());
                }
                if (clearDecision.action() == PlaceWorkstationPlanner.Action.FAIL_CLEAR_SPACE) {
                    completedPlaceTableCommandIds.add(commandId);
                    LOGGER.warn(
                        "place_table.failed instanceId={} commandId={} reason=place_table_clear_space_failed:{} target={} elapsedMs={}",
                        instanceId,
                        commandId,
                        clearResult.reason(),
                        placementCell.toShortString(),
                        clearResult.elapsedMs()
                    );
                    brainLink.completeCurrentCommand(commandId, "place_table_failed:place_table_clear_space_failed:" + clearResult.reason(), nowMs);
                    resetPlaceTableRun();
                    return new ControlDecision(stopFrom(effective, "place_table_failed:place_table_clear_space_failed:" + clearResult.reason()), InputState.stop());
                }
                return new ControlDecision(lookIntentForBlock(effective, player, placementCell, "place_table_clearing_space:" + clearResult.reason()), InputState.stop());
            }
            Vec3d placementAim = placementAimPointForCell(client, player, placementCell);
            Vec3d supportTop = placementAim == null
                ? new Vec3d(supportTarget.getX() + 0.5D, supportTarget.getY() + 1.0D, supportTarget.getZ() + 0.5D)
                : placementAim;
            placeLook = lookAnglesToPoint(player, supportTop);
            boolean lookAligned = Math.abs(LookController.normalizeYaw(placeLook.yaw() - player.getYaw())) <= WORKSTATION_PLACE_LOOK_TOLERANCE_DEG
                && Math.abs(placeLook.pitch() - player.getPitch()) <= WORKSTATION_PLACE_LOOK_TOLERANCE_DEG;
            PlaceWorkstationPlanner.Decision lookDecision = PlaceWorkstationPlanner.decideLookAlignment(awaitingPlacementVerification, lookAligned);
            if (lookDecision.action() == PlaceWorkstationPlanner.Action.FACE_GROUND) {
                return new ControlDecision(lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "place_table_face_ground"), InputState.stop());
            }
        }

        BlockPlaceController.Result result = blockPlaceController.tick(client, player, commandId, nowMs, supportTarget);
        LOGGER.info(
            "place_table.progress instanceId={} commandId={} reason={} hitBlock={} hitSide={} placedBlock={} selectedHotbarSlot={} elapsedMs={}",
            instanceId,
            commandId,
            result.reason(),
            formatBlockPos(result.hitBlock()),
            result.hitSide() == null ? "none" : result.hitSide().asString(),
            formatBlockPos(result.placedBlock()),
            result.selectedHotbarSlot(),
            result.elapsedMs()
        );
        PlaceWorkstationPlanner.Decision placementDecision = PlaceWorkstationPlanner.decidePlacementResult(result.status(), result.reason());
        if (placementDecision.action() == PlaceWorkstationPlanner.Action.PLACED) {
            InventoryCounter.InventoryCraftingTableSnapshot after = InventoryCounter.countPlayerCraftingTables(player);
            completedPlaceTableCommandIds.add(commandId);
            LOGGER.info(
                "place_table.complete instanceId={} commandId={} reason={} placedBlock={} inventoryTablesBefore={} inventoryTablesAfter={} elapsedMs={}",
                instanceId,
                commandId,
                result.reason(),
                formatBlockPos(result.placedBlock()),
                activePlaceTableBaselineTables,
                after.craftingTableCount(),
                result.elapsedMs()
            );
            brainLink.completeCurrentCommand(commandId, "place_table_complete:" + result.reason(), nowMs);
            resetPlaceTableRun();
            return new ControlDecision(stopFrom(effective, "place_table_complete:" + result.reason()), InputState.stop());
        }
        if (placementDecision.action() == PlaceWorkstationPlanner.Action.FAILED) {
            completedPlaceTableCommandIds.add(commandId);
            LOGGER.warn(
                "place_table.failed instanceId={} commandId={} reason={} hitBlock={} hitSide={} placedBlock={} inventoryTables={} elapsedMs={}",
                instanceId,
                commandId,
                result.reason(),
                formatBlockPos(result.hitBlock()),
                result.hitSide() == null ? "none" : result.hitSide().asString(),
                formatBlockPos(result.placedBlock()),
                tables.craftingTableCount(),
                result.elapsedMs()
            );
            brainLink.completeCurrentCommand(commandId, "place_table_failed:" + result.reason(), nowMs);
            resetPlaceTableRun();
            return new ControlDecision(stopFrom(effective, "place_table_failed:" + result.reason()), InputState.stop());
        }
        return new ControlDecision(lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "place_table_placing:" + result.reason()), InputState.stop());
    }

    private ControlDecision resolvePlaceFurnaceControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (completedPlaceFurnaceCommandIds.contains(commandId)) {
            return new ControlDecision(stopFrom(effective, "place_furnace_complete"), InputState.stop());
        }
        InventoryCounter.InventoryItemSnapshot furnaces = InventoryCounter.countPlayerItem(player, "furnace");
        if (!commandId.equals(activePlaceFurnaceCommandId)) {
            activePlaceFurnaceCommandId = commandId;
            activePlaceFurnaceBaselineFurnaces = furnaces.itemCount();
            activePlaceFurnaceSneakRequired = false;
            activePlaceFurnaceSupportTarget = null;
        }
        boolean awaitingPlacementVerification = blockPlaceController.isAwaitingVerification(commandId);
        PlaceWorkstationPlanner.Decision inventoryDecision = PlaceWorkstationPlanner.decideInventory(
            furnaces.itemCount() >= 1,
            awaitingPlacementVerification,
            "place_furnace_no_furnace"
        );
        if (inventoryDecision.action() == PlaceWorkstationPlanner.Action.FAIL_MISSING_ITEM) {
            completedPlaceFurnaceCommandIds.add(commandId);
            LOGGER.warn(
                "place_furnace.failed instanceId={} commandId={} reason=place_furnace_no_furnace inventoryFurnaces={}",
                instanceId,
                commandId,
                furnaces.itemCount()
            );
            brainLink.completeCurrentCommand(commandId, "place_furnace_failed:place_furnace_no_furnace", nowMs);
            resetPlaceFurnaceRun();
            return new ControlDecision(stopFrom(effective, "place_furnace_failed:place_furnace_no_furnace"), InputState.stop());
        }

        if (player.currentScreenHandler != null && player.currentScreenHandler != player.playerScreenHandler) {
            String handler = player.currentScreenHandler.getClass().getSimpleName();
            PlaceWorkstationPlanner.Decision screenDecision = PlaceWorkstationPlanner.decideOpenScreen(
                true,
                awaitingPlacementVerification,
                handler
            );
            if (screenDecision.action() == PlaceWorkstationPlanner.Action.FAIL_UNEXPECTED_SCREEN_OPENED) {
                completedPlaceFurnaceCommandIds.add(commandId);
                LOGGER.warn(
                    "place_furnace.failed instanceId={} commandId={} reason=place_furnace_unexpected_screen_opened handler={} inventoryFurnaces={}",
                    instanceId,
                    commandId,
                    handler,
                    furnaces.itemCount()
                );
                brainLink.completeCurrentCommand(commandId, "place_furnace_failed:place_furnace_unexpected_screen_opened:" + handler, nowMs);
                resetPlaceFurnaceRun();
                return new ControlDecision(stopFrom(effective, "place_furnace_failed:place_furnace_unexpected_screen_opened:" + handler), InputState.stop());
            }
            player.closeHandledScreen();
            LOGGER.info(
                "place_furnace.close_screen instanceId={} commandId={} handler={}",
                instanceId,
                commandId,
                handler
            );
            return new ControlDecision(stopFrom(effective, "place_furnace_close_screen_before_place"), InputState.stop());
        }

        clearNavigationState();
        BlockPos supportTarget = null;
        if (!awaitingPlacementVerification) {
            if (!isValidPlaceSupport(client, player, activePlaceFurnaceSupportTarget)) {
                activePlaceFurnaceSupportTarget = selectPlaceFurnaceSupport(client, player);
            }
            supportTarget = activePlaceFurnaceSupportTarget;
        }
        PlaceWorkstationPlanner.Decision supportDecision = PlaceWorkstationPlanner.decideSupport(
            awaitingPlacementVerification,
            supportTarget != null,
            "place_furnace_no_adjacent_support"
        );
        if (supportDecision.action() == PlaceWorkstationPlanner.Action.FAIL_NO_ADJACENT_SUPPORT) {
            completedPlaceFurnaceCommandIds.add(commandId);
            LOGGER.warn(
                "place_furnace.failed instanceId={} commandId={} reason=place_furnace_no_adjacent_support inventoryFurnaces={}",
                instanceId,
                commandId,
                furnaces.itemCount()
            );
            brainLink.completeCurrentCommand(commandId, "place_furnace_failed:place_furnace_no_adjacent_support", nowMs);
            resetPlaceFurnaceRun();
            return new ControlDecision(stopFrom(effective, "place_furnace_failed:place_furnace_no_adjacent_support"), InputState.stop());
        }
        LookAngles placeLook = new LookAngles(player.getYaw(), player.getPitch());
        if (!awaitingPlacementVerification) {
            BlockPos placementCell = supportTarget.up();
            BlockState placementState = client.world.getBlockState(placementCell);
            if (isReplaceablePlacementOccluder(placementState)) {
                boolean lookingAtPlacementCell = isLookingAtBlock(player, placementCell);
                PlaceWorkstationPlanner.Decision faceClearDecision = PlaceWorkstationPlanner.decideClearSpace(
                    awaitingPlacementVerification,
                    true,
                    lookingAtPlacementCell,
                    BlockBreakController.Status.RUNNING,
                    ""
                );
                if (faceClearDecision.action() == PlaceWorkstationPlanner.Action.FACE_CLEAR_SPACE) {
                    return new ControlDecision(lookIntentForBlock(effective, player, placementCell, "place_furnace_clear_replaceable_face"), InputState.stop());
                }
                String clearCommandId = commandId + ":clear_place_space";
                BlockBreakController.Result clearResult = blockBreakController.tick(client, player, placementCell, clearCommandId, nowMs);
                logBlockBreakResult(clearCommandId, placementCell, clearResult);
                PlaceWorkstationPlanner.Decision clearDecision = PlaceWorkstationPlanner.decideClearSpace(
                    awaitingPlacementVerification,
                    true,
                    true,
                    clearResult.status(),
                    clearResult.reason()
                );
                if (clearDecision.action() == PlaceWorkstationPlanner.Action.CLEAR_SPACE_BROKEN) {
                    LOGGER.info(
                        "place_furnace.clear_space instanceId={} commandId={} target={} reason={} elapsedMs={}",
                        instanceId,
                        commandId,
                        placementCell.toShortString(),
                        clearResult.reason(),
                        clearResult.elapsedMs()
                    );
                    return new ControlDecision(stopFrom(effective, "place_furnace_clear_space:" + clearResult.reason()), InputState.stop());
                }
                if (clearDecision.action() == PlaceWorkstationPlanner.Action.FAIL_CLEAR_SPACE) {
                    completedPlaceFurnaceCommandIds.add(commandId);
                    LOGGER.warn(
                        "place_furnace.failed instanceId={} commandId={} reason=place_furnace_clear_space_failed:{} target={} elapsedMs={}",
                        instanceId,
                        commandId,
                        clearResult.reason(),
                        placementCell.toShortString(),
                        clearResult.elapsedMs()
                    );
                    brainLink.completeCurrentCommand(commandId, "place_furnace_failed:place_furnace_clear_space_failed:" + clearResult.reason(), nowMs);
                    resetPlaceFurnaceRun();
                    return new ControlDecision(stopFrom(effective, "place_furnace_failed:place_furnace_clear_space_failed:" + clearResult.reason()), InputState.stop());
                }
                return new ControlDecision(lookIntentForBlock(effective, player, placementCell, "place_furnace_clearing_space:" + clearResult.reason()), InputState.stop());
            }
            Vec3d placementAim = placementAimPointForCell(client, player, placementCell);
            Vec3d supportTop = placementAim == null
                ? new Vec3d(supportTarget.getX() + 0.5D, supportTarget.getY() + 1.0D, supportTarget.getZ() + 0.5D)
                : placementAim;
            placeLook = lookAnglesToPoint(player, supportTop);
            boolean lookAligned = Math.abs(LookController.normalizeYaw(placeLook.yaw() - player.getYaw())) <= WORKSTATION_PLACE_LOOK_TOLERANCE_DEG
                && Math.abs(placeLook.pitch() - player.getPitch()) <= WORKSTATION_PLACE_LOOK_TOLERANCE_DEG;
            PlaceWorkstationPlanner.Decision lookDecision = PlaceWorkstationPlanner.decideLookAlignment(awaitingPlacementVerification, lookAligned);
            if (lookDecision.action() == PlaceWorkstationPlanner.Action.FACE_GROUND) {
                InputState placementPrepInput = activePlaceFurnaceSneakRequired ? sneakOnly() : InputState.stop();
                return new ControlDecision(lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "place_furnace_face_ground"), placementPrepInput);
            }
        }

        BlockPlaceController.Result result = blockPlaceController.tick(
            client,
            player,
            commandId,
            nowMs,
            supportTarget,
            BlockPlaceController.PlaceSpec.furnace()
        );
        activePlaceFurnaceSneakRequired = activePlaceFurnaceSneakRequired || result.sneakRequired();
        LOGGER.info(
            "place_furnace.progress instanceId={} commandId={} reason={} hitBlock={} hitSide={} placedBlock={} selectedHotbarSlot={} sneakRequired={} elapsedMs={}",
            instanceId,
            commandId,
            result.reason(),
            formatBlockPos(result.hitBlock()),
            result.hitSide() == null ? "none" : result.hitSide().asString(),
            formatBlockPos(result.placedBlock()),
            result.selectedHotbarSlot(),
            result.sneakRequired(),
            result.elapsedMs()
        );
        PlaceWorkstationPlanner.Decision placementDecision = PlaceWorkstationPlanner.decidePlacementResult(result.status(), result.reason());
        if (placementDecision.action() == PlaceWorkstationPlanner.Action.PLACED) {
            InventoryCounter.InventoryItemSnapshot after = InventoryCounter.countPlayerItem(player, "furnace");
            completedPlaceFurnaceCommandIds.add(commandId);
            LOGGER.info(
                "place_furnace.complete instanceId={} commandId={} reason={} placedBlock={} verifiedBlock=furnace inventoryFurnacesBefore={} inventoryFurnacesAfter={} sneakRequired={} elapsedMs={}",
                instanceId,
                commandId,
                result.reason(),
                formatBlockPos(result.placedBlock()),
                activePlaceFurnaceBaselineFurnaces,
                after.itemCount(),
                activePlaceFurnaceSneakRequired,
                result.elapsedMs()
            );
            brainLink.completeCurrentCommand(commandId, "place_furnace_complete:" + result.reason(), nowMs);
            resetPlaceFurnaceRun();
            return new ControlDecision(stopFrom(effective, "place_furnace_complete:" + result.reason()), InputState.stop());
        }
        if (placementDecision.action() == PlaceWorkstationPlanner.Action.FAILED) {
            completedPlaceFurnaceCommandIds.add(commandId);
            LOGGER.warn(
                "place_furnace.failed instanceId={} commandId={} reason={} hitBlock={} hitSide={} placedBlock={} inventoryFurnaces={} sneakRequired={} elapsedMs={}",
                instanceId,
                commandId,
                result.reason(),
                formatBlockPos(result.hitBlock()),
                result.hitSide() == null ? "none" : result.hitSide().asString(),
                formatBlockPos(result.placedBlock()),
                furnaces.itemCount(),
                activePlaceFurnaceSneakRequired || result.sneakRequired(),
                result.elapsedMs()
            );
            brainLink.completeCurrentCommand(commandId, "place_furnace_failed:" + result.reason(), nowMs);
            resetPlaceFurnaceRun();
            return new ControlDecision(stopFrom(effective, "place_furnace_failed:" + result.reason()), InputState.stop());
        }
        InputState input = result.sneakRequired() ? sneakOnly() : InputState.stop();
        return new ControlDecision(lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "place_furnace_placing:" + result.reason()), input);
    }

    private ControlDecision resolveRetrieveTableControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (completedRetrieveTableCommandIds.contains(commandId)) {
            return new ControlDecision(stopFrom(effective, "retrieve_table_complete"), InputState.stop());
        }
        InventoryCounter.InventoryCraftingTableSnapshot tables = InventoryCounter.countPlayerCraftingTables(player);
        if (activeRetrieveTable == null || !commandId.equals(activeRetrieveTable.commandId)) {
            activeRetrieveTable = new RetrieveTableRun(commandId, tables.craftingTableCount(), nowMs);
            LOGGER.info(
                "retrieve_table.start instanceId={} commandId={} inventoryTablesBefore={} tablesByItem={}",
                instanceId,
                commandId,
                activeRetrieveTable.baselineTables,
                tables.craftingTablesByItem()
            );
        }

        RetrieveTableRun run = activeRetrieveTable;
        if (tables.craftingTableCount() - run.baselineTables >= 1) {
            completedRetrieveTableCommandIds.add(commandId);
            LOGGER.info(
                "retrieve_table.complete instanceId={} commandId={} reason=table_item_delta_verified inventoryTablesBefore={} inventoryTablesAfter={} tablesByItem={} elapsedMs={}",
                instanceId,
                commandId,
                run.baselineTables,
                tables.craftingTableCount(),
                tables.craftingTablesByItem(),
                Math.max(0L, nowMs - run.startedAtMs)
            );
            activeRetrieveTable = null;
            brainLink.completeCurrentCommand(commandId, "retrieve_table_complete:table_item_delta_verified", nowMs);
            return new ControlDecision(stopFrom(effective, "retrieve_table_complete:table_item_delta_verified"), InputState.stop());
        }
        if (nowMs - run.startedAtMs > CRAFT_TOTAL_TIMEOUT_MS + GATHER_COLLECT_TIMEOUT_MS) {
            return failRetrieveTable(effective, run, tables, nowMs, "retrieve_table_timeout");
        }

        if (player.currentScreenHandler != null && player.currentScreenHandler != player.playerScreenHandler) {
            String previousHandler = player.currentScreenHandler.getClass().getSimpleName();
            player.closeHandledScreen();
            LOGGER.info(
                "retrieve_table.close_screen instanceId={} commandId={} handler={}",
                instanceId,
                commandId,
                previousHandler
            );
            return new ControlDecision(stopFrom(effective, "retrieve_table_close_screen"), InputState.stop());
        }

        if (run.target == null) {
            BlockPos target = selectNearbyCraftingTable(client, player);
            if (target == null) {
                return failRetrieveTable(effective, run, tables, nowMs, "retrieve_table_no_nearby_table");
            }
            run.target = target;
            LOGGER.info(
                "retrieve_table.target_selected instanceId={} commandId={} target={}",
                instanceId,
                commandId,
                target.toShortString()
            );
        }

        if (!run.breakDone && client.world.getBlockState(run.target).isOf(Blocks.CRAFTING_TABLE)) {
            BlockBreakController.Result result = blockBreakController.tick(client, player, run.target, commandId + ":break", nowMs);
            logBlockBreakResult(commandId, run.target, result);
            LOGGER.info(
                "retrieve_table.break_progress instanceId={} commandId={} target={} status={} reason={} elapsedMs={}",
                instanceId,
                commandId,
                run.target.toShortString(),
                result.status(),
                result.reason(),
                result.elapsedMs()
            );
            if (result.status() == BlockBreakController.Status.BROKEN) {
                run.breakDone = true;
                run.collectStartedAtMs = nowMs;
                return new ControlDecision(stopFrom(effective, "retrieve_table_break_done"), InputState.stop());
            }
            if (result.status() == BlockBreakController.Status.REPOSITION) {
                BrainLink.Intent navIntent = gatherCollectIntent(effective, run.target.getX() + 0.5D, run.target.getZ() + 0.5D, "retrieve_table_reposition", ":retrieve:reposition");
                return resolveNavigationControl(client, player, navIntent);
            }
            if (result.status() == BlockBreakController.Status.FAILED) {
                return failRetrieveTable(effective, run, tables, nowMs, "retrieve_table_break_failed:" + result.reason());
            }
            return new ControlDecision(stopFrom(effective, "retrieve_table_breaking:" + result.reason()), InputState.stop());
        }

        run.breakDone = true;
        if (run.collectStartedAtMs <= 0L) {
            run.collectStartedAtMs = nowMs;
        }
        if (nowMs - run.collectStartedAtMs < GATHER_PICKUP_SETTLE_MS) {
            return new ControlDecision(stopFrom(effective, "retrieve_table_wait_pickup"), InputState.stop());
        }
        Vec3d droppedTable = nearestDroppedItemPosition(
            client,
            player,
            run.target,
            (stack, itemId) -> InventoryCounter.isCraftingTableItemId(itemId)
        );
        if (droppedTable != null) {
            LOGGER.info(
                "retrieve_table.collect_item_target instanceId={} commandId={} target={} itemX={} itemY={} itemZ={}",
                instanceId,
                commandId,
                run.target.toShortString(),
                roundForLog(droppedTable.x),
                roundForLog(droppedTable.y),
                roundForLog(droppedTable.z)
            );
            BrainLink.Intent collectIntent = gatherCollectIntent(
                effective,
                droppedTable.x,
                droppedTable.y,
                droppedTable.z,
                "retrieve_table_collect_item",
                ":retrieve:collect"
            );
            return resolveNavigationControl(client, player, collectIntent);
        }
        if (nowMs - run.collectStartedAtMs > GATHER_COLLECT_TIMEOUT_MS) {
            return failRetrieveTable(effective, run, tables, nowMs, "retrieve_table_collect_timeout");
        }
        BrainLink.Intent collectIntent = gatherCollectIntent(effective, run.target.getX() + 0.5D, run.target.getZ() + 0.5D, "retrieve_table_collect_drop", ":retrieve:collect");
        return resolveNavigationControl(client, player, collectIntent);
    }

    private ControlDecision failRetrieveTable(
        BrainLink.Intent effective,
        RetrieveTableRun run,
        InventoryCounter.InventoryCraftingTableSnapshot tables,
        long nowMs,
        String reason
    ) {
        completedRetrieveTableCommandIds.add(run.commandId);
        LOGGER.warn(
            "retrieve_table.failed instanceId={} commandId={} reason={} target={} breakDone={} inventoryTablesBefore={} inventoryTablesAfter={} tablesByItem={} elapsedMs={}",
            instanceId,
            run.commandId,
            reason,
            formatBlockPos(run.target),
            run.breakDone,
            run.baselineTables,
            tables.craftingTableCount(),
            tables.craftingTablesByItem(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        activeRetrieveTable = null;
        brainLink.completeCurrentCommand(run.commandId, "retrieve_table_failed:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "retrieve_table_failed:" + reason), InputState.stop());
    }

    private void resetPlaceTableRun() {
        activePlaceTableCommandId = "";
        activePlaceTableBaselineTables = 0;
        activePlaceTableSupportTarget = null;
    }

    private void resetPlaceFurnaceRun() {
        activePlaceFurnaceCommandId = "";
        activePlaceFurnaceBaselineFurnaces = 0;
        activePlaceFurnaceSneakRequired = false;
        activePlaceFurnaceSupportTarget = null;
        blockPlaceController.reset();
    }

    private BlockPos selectPlaceTableSupport(MinecraftClient client, ClientPlayerEntity player) {
        return selectPlaceSupport(client, player, false, false, false);
    }

    private BlockPos selectPlaceFurnaceSupport(MinecraftClient client, ClientPlayerEntity player) {
        return selectPlaceSupport(client, player, true, true, true);
    }

    private BlockPos selectPlaceSupport(MinecraftClient client, ClientPlayerEntity player, boolean preferNonInteractiveAdjacency, boolean includeAboveFeet, boolean avoidInteractiveSupport) {
        int baseX = (int) Math.floor(player.getX());
        int baseY = (int) Math.floor(player.getY());
        int baseZ = (int) Math.floor(player.getZ());
        int[][] offsets = placementOffsets(player.getYaw());
        int startY = includeAboveFeet ? baseY + 1 : baseY;
        BlockPos visibleSurfaceInteractiveFallback = null;
        BlockPos airVisibleInteractiveFallback = null;
        BlockPos airInteractiveFallback = null;
        BlockPos replaceableVisibleFallback = null;
        BlockPos replaceableFallback = null;
        BlockPos replaceableVisibleInteractiveFallback = null;
        BlockPos replaceableInteractiveFallback = null;
        BlockPos visibleFallback = null;
        for (int y = startY; y >= baseY - 2; y--) {
            for (int[] offset : offsets) {
                BlockPos support = new BlockPos(baseX + offset[0], y, baseZ + offset[1]);
                BlockPos place = support.up();
                BlockState supportState = client.world.getBlockState(support);
                BlockState placeState = client.world.getBlockState(place);
                if (supportState.getCollisionShape(client.world, support).isEmpty()) {
                    continue;
                }
                if (avoidInteractiveSupport && isInteractiveBlock(supportState)) {
                    continue;
                }
                if (!placeState.isAir() && !isReplaceablePlacementOccluder(placeState)) {
                    continue;
                }
                if (new Box(place).intersects(player.getBoundingBox())) {
                    continue;
                }
                boolean interactiveAdjacent = isAdjacentToInteractiveBlock(client, place);
                boolean visibleSupportTop = canRaycastPlacementSupportTop(client, player, support);
                boolean surfaceOrAboveSupport = y >= baseY;
                if (visibleSupportTop
                    && preferNonInteractiveAdjacency
                    && interactiveAdjacent
                    && surfaceOrAboveSupport
                    && visibleSurfaceInteractiveFallback == null) {
                    visibleSurfaceInteractiveFallback = support.toImmutable();
                }
                if (placeState.isAir()) {
                    if (visibleSupportTop && (!preferNonInteractiveAdjacency || !interactiveAdjacent)) {
                        if (preferNonInteractiveAdjacency && !surfaceOrAboveSupport && visibleSurfaceInteractiveFallback != null) {
                            if (airVisibleInteractiveFallback == null) {
                                airVisibleInteractiveFallback = support.toImmutable();
                            }
                            if (airInteractiveFallback == null) {
                                airInteractiveFallback = support.toImmutable();
                            }
                            continue;
                        }
                        return support.toImmutable();
                    }
                    if (visibleSupportTop && airVisibleInteractiveFallback == null) {
                        airVisibleInteractiveFallback = support.toImmutable();
                    }
                    if (airInteractiveFallback == null) {
                        airInteractiveFallback = support.toImmutable();
                    }
                    continue;
                }
                if (visibleSupportTop && (!preferNonInteractiveAdjacency || !interactiveAdjacent)) {
                    if (preferNonInteractiveAdjacency && !surfaceOrAboveSupport && visibleSurfaceInteractiveFallback != null) {
                        if (replaceableVisibleFallback == null) {
                            replaceableVisibleFallback = support.toImmutable();
                        }
                        continue;
                    }
                    if (replaceableVisibleFallback == null) {
                        replaceableVisibleFallback = support.toImmutable();
                    }
                    continue;
                }
                if (!preferNonInteractiveAdjacency || !interactiveAdjacent) {
                    if (replaceableFallback == null) {
                        replaceableFallback = support.toImmutable();
                    }
                    continue;
                }
                if (visibleSupportTop && replaceableVisibleInteractiveFallback == null) {
                    replaceableVisibleInteractiveFallback = support.toImmutable();
                }
                if (replaceableInteractiveFallback == null) {
                    replaceableInteractiveFallback = support.toImmutable();
                }
                if (visibleSupportTop && visibleFallback == null) {
                    visibleFallback = support.toImmutable();
                }
            }
        }
        if (visibleSurfaceInteractiveFallback != null) {
            return visibleSurfaceInteractiveFallback;
        }
        if (airVisibleInteractiveFallback != null) {
            return airVisibleInteractiveFallback;
        }
        if (replaceableVisibleFallback != null) {
            return replaceableVisibleFallback;
        }
        if (replaceableVisibleInteractiveFallback != null) {
            return replaceableVisibleInteractiveFallback;
        }
        if (visibleFallback != null) {
            return visibleFallback;
        }
        if (airInteractiveFallback != null) {
            return airInteractiveFallback;
        }
        if (replaceableFallback != null) {
            return replaceableFallback;
        }
        return replaceableInteractiveFallback;
    }

    private boolean isValidPlaceSupport(MinecraftClient client, ClientPlayerEntity player, BlockPos support) {
        if (client == null || client.world == null || player == null || support == null) {
            return false;
        }
        BlockPos place = support.up();
        BlockState supportState = client.world.getBlockState(support);
        BlockState placeState = client.world.getBlockState(place);
        return !supportState.getCollisionShape(client.world, support).isEmpty()
            && (placeState.isAir() || isReplaceablePlacementOccluder(placeState))
            && !new Box(place).intersects(player.getBoundingBox())
            && isWithinPlaceSupportReach(player, support);
    }

    private boolean canRaycastPlacementSupportTop(MinecraftClient client, ClientPlayerEntity player, BlockPos support) {
        if (client == null || client.world == null || player == null || support == null) {
            return false;
        }
        Vec3d eye = player.getEyePos();
        Vec3d topCenter = new Vec3d(support.getX() + 0.5D, support.getY() + 1.0D, support.getZ() + 0.5D);
        if (!isWithinPlaceSupportReach(player, support)) {
            return false;
        }
        BlockHitResult hit = client.world.raycast(new RaycastContext(
            eye,
            topCenter,
            RaycastContext.ShapeType.OUTLINE,
            RaycastContext.FluidHandling.NONE,
            player
        ));
        return hit != null
            && hit.getType() == HitResult.Type.BLOCK
            && support.equals(hit.getBlockPos())
            && hit.getSide() == Direction.UP;
    }

    private Vec3d placementAimPointForCell(MinecraftClient client, ClientPlayerEntity player, BlockPos placeCell) {
        if (client == null || client.world == null || player == null || placeCell == null) {
            return null;
        }
        Direction[] sides = {
            Direction.UP,
            Direction.NORTH,
            Direction.SOUTH,
            Direction.EAST,
            Direction.WEST,
            Direction.DOWN
        };
        for (Direction side : sides) {
            BlockPos hitBlock = placeCell.offset(side.getOpposite());
            BlockState hitState = client.world.getBlockState(hitBlock);
            if (hitState.getCollisionShape(client.world, hitBlock).isEmpty()) {
                continue;
            }
            Vec3d facePoint = Vec3d.ofCenter(hitBlock).add(
                side.getOffsetX() * 0.501D,
                side.getOffsetY() * 0.501D,
                side.getOffsetZ() * 0.501D
            );
            double reach = Math.min(TABLE_INTERACTION_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
            if (player.getEyePos().squaredDistanceTo(facePoint) > reach * reach) {
                continue;
            }
            BlockHitResult hit = client.world.raycast(new RaycastContext(
                player.getEyePos(),
                facePoint,
                RaycastContext.ShapeType.OUTLINE,
                RaycastContext.FluidHandling.NONE,
                player
            ));
            if (hit != null
                && hit.getType() == HitResult.Type.BLOCK
                && hitBlock.equals(hit.getBlockPos())
                && hit.getSide() == side) {
                return facePoint;
            }
        }
        return null;
    }

    private boolean isWithinPlaceSupportReach(ClientPlayerEntity player, BlockPos support) {
        if (player == null || support == null) {
            return false;
        }
        Vec3d topCenter = new Vec3d(support.getX() + 0.5D, support.getY() + 1.0D, support.getZ() + 0.5D);
        double reach = Math.min(TABLE_INTERACTION_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
        return player.getEyePos().squaredDistanceTo(topCenter) <= reach * reach;
    }

    private static int[][] placementOffsets(float yaw) {
        int[] forward = cardinalOffset(yaw);
        int[] right = new int[] { -forward[1], forward[0] };
        int[] left = new int[] { forward[1], -forward[0] };
        int[] back = new int[] { -forward[0], -forward[1] };
        return new int[][] {
            forward,
            new int[] { forward[0] + right[0], forward[1] + right[1] },
            new int[] { forward[0] + left[0], forward[1] + left[1] },
            right,
            left,
            back,
            new int[] { back[0] * 2, back[1] * 2 },
            new int[] { (back[0] * 2) + right[0], (back[1] * 2) + right[1] },
            new int[] { (back[0] * 2) + left[0], (back[1] * 2) + left[1] }
        };
    }

    private static int[] cardinalOffset(float yaw) {
        double normalized = yaw % 360.0D;
        if (normalized >= 180.0D) {
            normalized -= 360.0D;
        }
        if (normalized < -180.0D) {
            normalized += 360.0D;
        }
        if (normalized >= -45.0D && normalized <= 45.0D) {
            return new int[] { 0, 1 };
        }
        if (normalized > 45.0D && normalized <= 135.0D) {
            return new int[] { -1, 0 };
        }
        if (normalized < -45.0D && normalized >= -135.0D) {
            return new int[] { 1, 0 };
        }
        return new int[] { 0, -1 };
    }

    private static boolean isReplaceablePlacementOccluder(BlockState state) {
        if (state == null || state.isAir()) {
            return false;
        }
        String id = net.minecraft.registry.Registries.BLOCK.getId(state.getBlock()).getPath();
        return id.equals("short_grass")
            || id.equals("tall_grass")
            || id.equals("fern")
            || id.equals("large_fern")
            || id.equals("dead_bush")
            || id.equals("vine")
            || id.endsWith("_vine")
            || id.endsWith("_vines");
    }

    private static boolean isAdjacentToInteractiveBlock(MinecraftClient client, BlockPos pos) {
        if (client == null || client.world == null || pos == null) {
            return false;
        }
        for (Direction direction : Direction.values()) {
            if (isInteractiveBlock(client.world.getBlockState(pos.offset(direction)))) {
                return true;
            }
        }
        return false;
    }

    private static boolean isInteractiveBlock(BlockState state) {
        return state != null && (
            state.isOf(Blocks.CRAFTING_TABLE)
                || state.isOf(Blocks.FURNACE)
                || state.isOf(Blocks.BLAST_FURNACE)
                || state.isOf(Blocks.SMOKER)
                || state.isOf(Blocks.CHEST)
                || state.isOf(Blocks.TRAPPED_CHEST)
                || state.isOf(Blocks.BARREL)
        );
    }

    private String itemId(ItemStack stack) {
        if (stack == null || stack.isEmpty()) {
            return "";
        }
        return net.minecraft.registry.Registries.ITEM.getId(stack.getItem()).getPath();
    }

    private String selectedItemId(ClientPlayerEntity player) {
        if (player == null) {
            return "empty";
        }
        String id = itemId(player.getMainHandStack());
        return id.isEmpty() ? "empty" : id;
    }

    private int bestStonePickaxeRemainingDurability(ClientPlayerEntity player) {
        if (player == null) {
            return -1;
        }
        int best = -1;
        int end = Math.min(36, player.getInventory().size());
        for (int slot = 0; slot < end; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty() || !InventoryCounter.isStonePickaxeItemId(itemId(stack))) {
                continue;
            }
            best = Math.max(best, remainingDurability(stack));
        }
        return best;
    }

    private int remainingDurability(ItemStack stack) {
        if (stack == null || stack.isEmpty()) {
            return -1;
        }
        if (!stack.isDamageable()) {
            return Integer.MAX_VALUE;
        }
        return Math.max(0, stack.getMaxDamage() - stack.getDamage());
    }

    private String blockId(BlockState state) {
        if (state == null || state.isAir()) {
            return "air";
        }
        return net.minecraft.registry.Registries.BLOCK.getId(state.getBlock()).getPath();
    }

    private int findHotbarSlot(ClientPlayerEntity player, Predicate<String> itemPredicate) {
        if (player == null || itemPredicate == null) {
            return -1;
        }
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            if (itemPredicate.test(itemId(stack))) {
                return slot;
            }
        }
        return -1;
    }

    private int selectTableOpenHotbarSlot(ClientPlayerEntity player) {
        if (player == null) {
            return -1;
        }
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                player.getInventory().selectedSlot = slot;
                return slot;
            }
        }
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack != null && !stack.isEmpty() && !(stack.getItem() instanceof BlockItem)) {
                player.getInventory().selectedSlot = slot;
                return slot;
            }
        }
        return player.getInventory().selectedSlot;
    }

    private int moveInventoryItemToHotbar(
        MinecraftClient client,
        ClientPlayerEntity player,
        Predicate<String> itemPredicate,
        String commandId,
        String logPrefix
    ) {
        if (client == null || client.interactionManager == null || player == null || itemPredicate == null) {
            return -1;
        }
        if (player.currentScreenHandler != null && player.currentScreenHandler != player.playerScreenHandler) {
            String previousHandler = player.currentScreenHandler.getClass().getSimpleName();
            player.closeHandledScreen();
            LOGGER.info(
                "{}.hotbar_move_close_screen instanceId={} commandId={} handler={}",
                logPrefix,
                instanceId,
                commandId,
                previousHandler
            );
            return -2;
        }
        int sourceInventorySlot = findInventorySlot(player, itemPredicate, false);
        if (sourceInventorySlot < 0) {
            return -1;
        }
        int hotbarSlot = firstEmptyHotbarSlot(player);
        if (hotbarSlot < 0) {
            hotbarSlot = Math.max(0, Math.min(8, player.getInventory().selectedSlot));
        }
        int sourceScreenSlot = playerInventoryScreenSlot(sourceInventorySlot);
        client.interactionManager.clickSlot(player.playerScreenHandler.syncId, sourceScreenSlot, hotbarSlot, SlotActionType.SWAP, player);
        LOGGER.info(
            "{}.hotbar_move instanceId={} commandId={} sourceInventorySlot={} sourceScreenSlot={} hotbarSlot={}",
            logPrefix,
            instanceId,
            commandId,
            sourceInventorySlot,
            sourceScreenSlot,
            hotbarSlot
        );
        return hotbarSlot;
    }

    private int findInventorySlot(ClientPlayerEntity player, Predicate<String> itemPredicate, boolean includeHotbar) {
        if (player == null || itemPredicate == null) {
            return -1;
        }
        int start = includeHotbar ? 0 : 9;
        int end = Math.min(36, player.getInventory().size());
        for (int slot = start; slot < end; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            if (itemPredicate.test(itemId(stack))) {
                return slot;
            }
        }
        return -1;
    }

    private int firstEmptyHotbarSlot(ClientPlayerEntity player) {
        if (player == null) {
            return -1;
        }
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                return slot;
            }
        }
        return -1;
    }

    private static int playerInventoryScreenSlot(int inventorySlot) {
        if (inventorySlot >= 0 && inventorySlot < 9) {
            return 36 + inventorySlot;
        }
        return inventorySlot;
    }

    private ControlDecision completeGatherTree(
        MinecraftClient client,
        InventoryCounter.InventoryLogSnapshot inventory,
        BrainLink.Intent effective,
        GatherTreeRun run,
        long nowMs,
        String reason
    ) {
        Set<BlockPos> liveCluster = liveTreeCluster(client.world, run.cluster);
        int inventoryDelta = Math.max(0, inventory.logCount() - run.baselineLogCount);
        completedGatherTreeCommandIds.add(run.commandId);
        LOGGER.info(
            "gather_tree.complete instanceId={} commandId={} seed={} reason={} inventoryLogsBefore={} inventoryLogsAfter={} logsGathered={} brokenLogs={} leftUnreached={} abandoned={} collectTimeouts={} occludersBroken={} occlusionRepositions={} occlusionAbandons={} elapsedMs={} logsByItem={}",
            instanceId,
            run.commandId,
            run.seed.toShortString(),
            reason,
            run.baselineLogCount,
            inventory.logCount(),
            inventoryDelta,
            run.completedTargets.size(),
            liveCluster.size(),
            run.abandonedTargets.size(),
            run.collectTimeouts,
            run.occludersBroken,
            run.occlusionRepositions,
            run.occlusionAbandons,
            Math.max(0L, nowMs - run.startedAtMs),
            inventory.logsByItem()
        );
        activeGatherTree = null;
        return new ControlDecision(stopFrom(effective, "gather_tree_complete:" + reason), InputState.stop());
    }

    private void resetGatherTreeCurrentTarget(GatherTreeRun run) {
        run.currentTarget = null;
        run.currentAdjacentCell = null;
        run.excludedAdjacentCells.clear();
        run.breakDone = false;
        run.collectStartedAtMs = 0L;
        clearNavigationState();
    }

    private void clearNavigationState() {
        activeNavigationCommandId = "";
        activeNavigationWaypointIndex = 0;
        activeNavigationProgress = PathFollower.Progress.initial();
        activeNavigationWaypoints = List.of();
        activeNavigationRouteComputed = false;
        activeNavigationJumpWaypointIndexes = Set.of();
    }

    private ControlDecision navigateToGatherTreeAdjacentCell(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        GatherTreeRun run
    ) {
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        if (run.currentAdjacentCell == null) {
            int referenceFeetY = (int) Math.floor(player.getY());
            int targetX = run.currentTarget.getX();
            int targetZ = run.currentTarget.getZ();
            WorldGridPerception perception = new WorldGridPerception(
                client.world,
                referenceFeetY,
                Math.min(start.x(), targetX) - NAVIGATION_PERCEPTION_MARGIN,
                Math.max(start.x(), targetX) + NAVIGATION_PERCEPTION_MARGIN,
                Math.min(start.z(), targetZ) - NAVIGATION_PERCEPTION_MARGIN,
                Math.max(start.z(), targetZ) + NAVIGATION_PERCEPTION_MARGIN
            );
            GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseAdjacent(perception, start, targetX, targetZ, run.excludedAdjacentCells);
            if (plan.cell() == null) {
                run.abandonedTargets.add(run.currentTarget);
                LOGGER.warn(
                    "gather_tree.no_adjacent_path instanceId={} commandId={} target={} reason={}",
                    instanceId,
                    run.commandId,
                    run.currentTarget.toShortString(),
                    plan.reason()
                );
                resetGatherTreeCurrentTarget(run);
                return new ControlDecision(stopFrom(effective, "gather_tree_no_adjacent_path_continue"), InputState.stop());
            }
            run.currentAdjacentCell = plan.cell();
            LOGGER.info(
                "gather_tree.adjacent_selected instanceId={} commandId={} target={} adjacent={} routeLength={} reason={}",
                instanceId,
                run.commandId,
                run.currentTarget.toShortString(),
                run.currentAdjacentCell,
                plan.route().size(),
                plan.reason()
            );
        }
        double distance = Math.hypot(PathFollower.center(run.currentAdjacentCell.x()) - player.getX(), PathFollower.center(run.currentAdjacentCell.z()) - player.getZ());
        if (distance <= GATHER_ARRIVE_EPSILON) {
            return null;
        }
        BrainLink.Intent navIntent = new BrainLink.Intent(
            "navigate_to_point",
            false,
            false,
            false,
            false,
            false,
            false,
            null,
            null,
            PathFollower.center(run.currentAdjacentCell.x()),
            PathFollower.center(run.currentAdjacentCell.z()),
            List.of(),
            List.of(),
            GATHER_ARRIVE_EPSILON,
            List.of(),
            effective.expiresAtMs(),
            "gather_tree_nav_adjacent",
            run.commandId + ":tree:adjacent"
        );
        return resolveNavigationControl(client, player, navIntent);
    }

    private Set<BlockPos> discoverTreeLogCluster(BlockView world, BlockPos seed) {
        if (world == null || seed == null || !world.getBlockState(seed).isIn(BlockTags.LOGS)) {
            return Set.of();
        }
        Set<BlockPos> cluster = new HashSet<>();
        Queue<BlockPos> queue = new ArrayDeque<>();
        BlockPos immutableSeed = seed.toImmutable();
        cluster.add(immutableSeed);
        queue.add(immutableSeed);
        while (!queue.isEmpty() && cluster.size() < GATHER_TREE_CLUSTER_LIMIT) {
            BlockPos current = queue.remove();
            for (BlockPos neighbor : logNeighbors(current)) {
                if (cluster.size() >= GATHER_TREE_CLUSTER_LIMIT) {
                    break;
                }
                if (Math.abs(neighbor.getX() - seed.getX()) > GATHER_TREE_CLUSTER_RADIUS
                    || Math.abs(neighbor.getY() - seed.getY()) > GATHER_TREE_CLUSTER_RADIUS
                    || Math.abs(neighbor.getZ() - seed.getZ()) > GATHER_TREE_CLUSTER_RADIUS) {
                    continue;
                }
                BlockPos candidate = neighbor.toImmutable();
                if (cluster.contains(candidate) || !world.getBlockState(candidate).isIn(BlockTags.LOGS)) {
                    continue;
                }
                cluster.add(candidate);
                queue.add(candidate);
            }
        }
        return Set.copyOf(cluster);
    }

    private Set<BlockPos> liveTreeCluster(BlockView world, Set<BlockPos> cluster) {
        if (world == null || cluster == null || cluster.isEmpty()) {
            return Set.of();
        }
        Set<BlockPos> live = new HashSet<>();
        for (BlockPos pos : cluster) {
            if (pos != null && world.getBlockState(pos).isIn(BlockTags.LOGS)) {
                live.add(pos.toImmutable());
            }
        }
        return Set.copyOf(live);
    }

    private List<BlockPos> logNeighbors(BlockPos pos) {
        return List.of(
            pos.up(),
            pos.down(),
            pos.north(),
            pos.south(),
            pos.east(),
            pos.west()
        );
    }

    private ControlDecision navigateToGatherAdjacentCell(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        GatherLogRun run
    ) {
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        if (run.adjacentCell == null) {
            int referenceFeetY = (int) Math.floor(player.getY());
            int targetX = run.target.getX();
            int targetZ = run.target.getZ();
            WorldGridPerception perception = new WorldGridPerception(
                client.world,
                referenceFeetY,
                Math.min(start.x(), targetX) - NAVIGATION_PERCEPTION_MARGIN,
                Math.max(start.x(), targetX) + NAVIGATION_PERCEPTION_MARGIN,
                Math.min(start.z(), targetZ) - NAVIGATION_PERCEPTION_MARGIN,
                Math.max(start.z(), targetZ) + NAVIGATION_PERCEPTION_MARGIN
            );
            GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseAdjacent(perception, start, targetX, targetZ, run.excludedAdjacentCells);
            if (plan.cell() == null) {
                completedGatherLogCommandIds.add(run.commandId);
                activeGatherLog = null;
                return new ControlDecision(stopFrom(effective, "gather_log_no_adjacent_path"), InputState.stop());
            }
            run.adjacentCell = plan.cell();
            LOGGER.info(
                "gather_log.adjacent_selected instanceId={} commandId={} target={} adjacent={} routeLength={} reason={}",
                instanceId,
                run.commandId,
                run.target.toShortString(),
                run.adjacentCell,
                plan.route().size(),
                plan.reason()
            );
        }
        double distance = Math.hypot(PathFollower.center(run.adjacentCell.x()) - player.getX(), PathFollower.center(run.adjacentCell.z()) - player.getZ());
        if (distance <= GATHER_ARRIVE_EPSILON) {
            return null;
        }
        BrainLink.Intent navIntent = new BrainLink.Intent(
            "navigate_to_point",
            false,
            false,
            false,
            false,
            false,
            false,
            null,
            null,
            PathFollower.center(run.adjacentCell.x()),
            PathFollower.center(run.adjacentCell.z()),
            List.of(),
            List.of(),
            GATHER_ARRIVE_EPSILON,
            List.of(),
            effective.expiresAtMs(),
            "gather_log_nav_adjacent",
            run.commandId + ":adjacent"
        );
        return resolveNavigationControl(client, player, navIntent);
    }

    private BrainLink.Intent gatherCollectIntent(BrainLink.Intent effective, BlockPos target, GridCell adjacentCell) {
        double targetX = adjacentCell == null ? target.getX() + 0.5D : PathFollower.center(adjacentCell.x());
        double targetZ = adjacentCell == null ? target.getZ() + 0.5D : PathFollower.center(adjacentCell.z());
        return gatherCollectIntent(effective, targetX, targetZ, "gather_log_collect_drop", ":collect");
    }

    private BrainLink.Intent gatherCollectIntent(
        BrainLink.Intent effective,
        double targetX,
        double targetZ,
        String reason,
        String commandSuffix
    ) {
        return gatherCollectIntent(effective, targetX, null, targetZ, reason, commandSuffix);
    }

    private BrainLink.Intent gatherCollectIntent(
        BrainLink.Intent effective,
        double targetX,
        Double targetY,
        double targetZ,
        String reason,
        String commandSuffix
    ) {
        return new BrainLink.Intent(
            "navigate_to_point",
            false,
            false,
            false,
            false,
            false,
            false,
            null,
            null,
            targetX,
            targetY,
            targetZ,
            List.of(),
            List.of(),
            GATHER_ARRIVE_EPSILON,
            List.of(),
            effective.expiresAtMs(),
            reason,
            (effective.commandId() == null ? "" : effective.commandId()) + commandSuffix
        );
    }

    private Vec3d nearestDroppedLogItemPosition(MinecraftClient client, ClientPlayerEntity player, BlockPos target) {
        return nearestDroppedItemPosition(
            client,
            player,
            target,
            (stack, itemId) -> stack.isIn(ItemTags.LOGS) || InventoryCounter.isLogItemId(itemId)
        );
    }

    private Vec3d nearestDroppedItemPosition(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos target,
        BiPredicate<ItemStack, String> itemPredicate
    ) {
        if (client.world == null || player == null || target == null) {
            return null;
        }
        Box searchBox = new Box(
            target.getX() - GATHER_DROPPED_LOG_SEARCH_RADIUS,
            target.getY() - GATHER_DROPPED_LOG_SEARCH_Y,
            target.getZ() - GATHER_DROPPED_LOG_SEARCH_RADIUS,
            target.getX() + 1.0D + GATHER_DROPPED_LOG_SEARCH_RADIUS,
            target.getY() + 1.0D + GATHER_DROPPED_LOG_SEARCH_Y,
            target.getZ() + 1.0D + GATHER_DROPPED_LOG_SEARCH_RADIUS
        );
        Vec3d playerPos = player.getPos();
        Vec3d nearest = null;
        double nearestDistanceSquared = Double.POSITIVE_INFINITY;
        for (ItemEntity item : client.world.getEntitiesByClass(ItemEntity.class, searchBox, ItemEntity::isAlive)) {
            ItemStack stack = item.getStack();
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String itemId = net.minecraft.registry.Registries.ITEM.getId(stack.getItem()).getPath();
            if (!itemPredicate.test(stack, itemId)) {
                continue;
            }
            Vec3d itemPos = item.getPos();
            double distanceSquared = itemPos.squaredDistanceTo(playerPos);
            if (distanceSquared < nearestDistanceSquared) {
                nearestDistanceSquared = distanceSquared;
                nearest = itemPos;
            }
        }
        return nearest;
    }

    private static double roundForLog(double value) {
        return Math.round(value * 1000.0D) / 1000.0D;
    }

    private BlockPos targetBlockPos(BrainLink.Intent intent) {
        if (intent == null || intent.targetX() == null || intent.targetY() == null || intent.targetZ() == null) {
            return null;
        }
        return new BlockPos(
            (int) Math.floor(intent.targetX()),
            (int) Math.floor(intent.targetY()),
            (int) Math.floor(intent.targetZ())
        );
    }

    private BrainLink.Intent lookIntentForBlock(BrainLink.Intent source, ClientPlayerEntity player, BlockPos target, String reason) {
        LookAngles angles = lookAnglesToBlock(player, target);
        return lookIntentForAngles(source, angles.yaw(), angles.pitch(), reason);
    }

    private BrainLink.Intent lookIntentForAngles(BrainLink.Intent source, double yaw, double pitch, String reason) {
        return new BrainLink.Intent(
            reason,
            false,
            false,
            false,
            false,
            false,
            false,
            yaw,
            pitch,
            source.targetX(),
            source.targetY(),
            source.targetZ(),
            List.of(),
            List.of(),
            null,
            List.of(),
            source.expiresAtMs(),
            reason,
            source.commandId()
        );
    }

    private LookAngles lookAnglesToPoint(ClientPlayerEntity player, Vec3d target) {
        Vec3d eye = player.getEyePos();
        double dx = target.x - eye.x;
        double dy = target.y - eye.y;
        double dz = target.z - eye.z;
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        double pitch = Math.toDegrees(Math.atan2(-dy, horizontal));
        return new LookAngles(yaw, pitch);
    }

    private BrainLink.Intent stopFrom(BrainLink.Intent source, String reason) {
        return new BrainLink.Intent(
            "stop",
            false,
            false,
            false,
            false,
            false,
            false,
            null,
            null,
            source == null ? null : source.targetX(),
            source == null ? null : source.targetY(),
            source == null ? null : source.targetZ(),
            List.of(),
            List.of(),
            null,
            List.of(),
            source == null ? 0L : source.expiresAtMs(),
            reason,
            source == null || source.commandId() == null ? "" : source.commandId()
        );
    }

    private static InputState sneakOnly() {
        return new InputState(false, false, false, false, false, true, 0.0F, 0.0F);
    }

    private void logBlockBreakResult(String commandId, BlockPos target, BlockBreakController.Result result) {
        if (result.status() != BlockBreakController.Status.RUNNING) {
            lastBlockBreakLogKey = "";
            return;
        }
        String key = commandId
            + ":" + target.toShortString()
            + ":" + result.reason()
            + ":" + formatBlockPos(result.hitBlock())
            + ":" + formatBlockPos(result.actedBlock())
            + ":" + (result.elapsedMs() / 1000L);
        if (key.equals(lastBlockBreakLogKey)) {
            return;
        }
        lastBlockBreakLogKey = key;
        if ("occluder_cleared".equals(result.reason())) {
            LOGGER.info(
                "block_break.occluder_cleared instanceId={} commandId={} target={} occluder={} occludersBroken={} elapsedMs={}",
                instanceId,
                commandId,
                target.toShortString(),
                formatBlockPos(result.actedBlock()),
                result.occludersBroken(),
                result.elapsedMs()
            );
            return;
        }
        LOGGER.info(
            "block_break.progress instanceId={} commandId={} target={} hitBlock={} actedBlock={} reason={} elapsedMs={}",
            instanceId,
            commandId,
            target.toShortString(),
            formatBlockPos(result.hitBlock()),
            formatBlockPos(result.actedBlock()),
            result.reason(),
            result.elapsedMs()
        );
    }

    private static String formatBlockPos(BlockPos pos) {
        return pos == null ? "none" : pos.toShortString();
    }

    private String formatTargetHint(BrainLink.Intent intent) {
        if (intent == null || intent.targetX() == null || intent.targetY() == null || intent.targetZ() == null) {
            return "none";
        }
        return String.format(
            java.util.Locale.ROOT,
            "%.1f,%.1f,%.1f",
            intent.targetX(),
            intent.targetY(),
            intent.targetZ()
        );
    }

    private boolean isLookingAtBlock(ClientPlayerEntity player, BlockPos target) {
        LookAngles angles = lookAnglesToBlock(player, target);
        double yawError = Math.abs(LookController.normalizeYaw(angles.yaw() - player.getYaw()));
        double pitchError = Math.abs(angles.pitch() - player.getPitch());
        return yawError <= BLOCK_LOOK_TOLERANCE_DEG && pitchError <= BLOCK_LOOK_TOLERANCE_DEG;
    }

    private static LookAngles lookAnglesToBlock(ClientPlayerEntity player, BlockPos target) {
        Vec3d eye = player.getEyePos();
        Vec3d center = Vec3d.ofCenter(target);
        double dx = center.x - eye.x;
        double dy = center.y - eye.y;
        double dz = center.z - eye.z;
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        double pitch = -Math.toDegrees(Math.atan2(dy, horizontal));
        return new LookAngles(yaw, Math.max(-90.0D, Math.min(90.0D, pitch)));
    }

    private boolean hasNavigation(BrainLink.Intent intent) {
        return intent != null
            && ((intent.targetX() != null && intent.targetZ() != null)
                || (intent.waypoints() != null && !intent.waypoints().isEmpty()));
    }

    private boolean isNavigationProbe(BrainLink.Intent intent) {
        return intent != null && "probe_navigation".equals(intent.action()) && intent.targetX() != null && intent.targetZ() != null;
    }

    private ControlDecision resolveNavigationProbeControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (!commandId.equals(activeNavigationCommandId)) {
            activeNavigationCommandId = commandId;
            activeNavigationWaypointIndex = 0;
            activeNavigationProgress = PathFollower.Progress.initial();
            activeNavigationWaypoints = List.of();
            activeNavigationRouteComputed = false;
            activeNavigationJumpWaypointIndexes = Set.of();
        }
        if (!activeNavigationRouteComputed) {
            GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
            GridCell goal = new GridCell((int) Math.floor(effective.targetX()), (int) Math.floor(effective.targetZ()));
            int referenceFeetY = (int) Math.floor(player.getY());
            WorldGridPerception perception = new WorldGridPerception(client.world, referenceFeetY, start, goal, NAVIGATION_PERCEPTION_MARGIN);
            StartPlacementValidator.Issue startIssue = classifyStartPlacement(client.world, start, referenceFeetY, perception);
            if (startIssue != StartPlacementValidator.Issue.NONE) {
                LOGGER.info(
                    "navigation.probe_result instanceId={} commandId={} routeFound={} category={} reason={} source={} start={} goal={} referenceFeetY={} surfaces={} blocked={}/{} hazards={} rejects={} rejectSamples={} routeLength={}",
                    instanceId,
                    commandId,
                    false,
                    "start_invalid",
                    startIssue.reason(),
                    "start_validation",
                    start,
                    goal,
                    referenceFeetY,
                    perception.surfaceSummary(start, goal),
                    perception.blockedCount(),
                    perception.cellCount(),
                    perception.hazardCount(),
                    "{}",
                    "none",
                    0
                );
                activeNavigationRouteComputed = true;
                return stopProbe(effective, commandId);
            }
            GridRouteDiagnostic diagnostic = GridAStar.diagnose(perception, start, goal);
            String source = "default";
            if (!diagnostic.routeFound() && perception.surfaceY(start.x(), start.z()).isPresent()) {
                WorldGridPerception expandedScan = new WorldGridPerception(
                    client.world,
                    referenceFeetY,
                    start,
                    goal,
                    NAVIGATION_PERCEPTION_MARGIN,
                    WorldGridPerception.FALLBACK_SURFACE_SCAN_UP,
                    WorldGridPerception.FALLBACK_SURFACE_SCAN_DOWN
                );
                GridRouteDiagnostic expandedScanDiagnostic = GridAStar.diagnose(expandedScan, start, goal);
                if (expandedScanDiagnostic.routeFound()) {
                    perception = expandedScan;
                    diagnostic = expandedScanDiagnostic;
                    source = "fallback_scan";
                }
            }
            String reason = diagnostic.routeFound()
                ? "route_found"
                : categorizeNoPathReason(
                    perception,
                    diagnostic,
                    diagnostic,
                    diagnostic,
                    diagnostic,
                    goal
                );
            String category = diagnostic.routeFound() ? "valid_reachable" : categorizeNoPath(reason);
            LOGGER.info(
                "navigation.probe_result instanceId={} commandId={} routeFound={} category={} reason={} source={} start={} goal={} referenceFeetY={} surfaces={} blocked={}/{} hazards={} rejects={} rejectSamples={} routeLength={}",
                instanceId,
                commandId,
                diagnostic.routeFound(),
                category,
                reason,
                source,
                start,
                goal,
                referenceFeetY,
                perception.surfaceSummary(start, goal),
                perception.blockedCount(),
                perception.cellCount(),
                perception.hazardCount(),
                formatRejects(diagnostic),
                formatRejectSamples(diagnostic),
                diagnostic.routeLength()
            );
            activeNavigationRouteComputed = true;
        }
        BrainLink.Intent stop = new BrainLink.Intent(
            "stop",
            false,
            false,
            false,
            false,
            false,
            false,
            null,
            null,
            effective.targetX(),
            effective.targetZ(),
            List.of(),
            List.of(),
            effective.arriveEpsilon(),
            List.of(),
            effective.expiresAtMs(),
            "probe_complete",
            commandId
        );
        return new ControlDecision(stop, InputState.stop());
    }

    private ControlDecision stopProbe(BrainLink.Intent effective, String commandId) {
        BrainLink.Intent stop = new BrainLink.Intent(
            "stop",
            false,
            false,
            false,
            false,
            false,
            false,
            null,
            null,
            effective.targetX(),
            effective.targetZ(),
            List.of(),
            List.of(),
            effective.arriveEpsilon(),
            List.of(),
            effective.expiresAtMs(),
            "probe_complete",
            commandId
        );
        return new ControlDecision(stop, InputState.stop());
    }

    private static StartPlacementValidator.Issue classifyStartPlacement(
        BlockView world,
        GridCell start,
        int referenceFeetY,
        WorldGridPerception perception
    ) {
        BlockState feet = world.getBlockState(new BlockPos(start.x(), referenceFeetY, start.z()));
        BlockState head = world.getBlockState(new BlockPos(start.x(), referenceFeetY + 1, start.z()));
        return StartPlacementValidator.classify(
            referenceFeetY,
            perception.surfaceY(start.x(), start.z()),
            blockHasCollision(world, start.x(), referenceFeetY, start.z()),
            blockHasCollision(world, start.x(), referenceFeetY + 1, start.z()),
            isVegetationBodyBlock(feet),
            isVegetationBodyBlock(head)
        );
    }

    private static boolean isVegetationBodyBlock(BlockState state) {
        return state.isIn(BlockTags.LEAVES) || state.isIn(BlockTags.LOGS);
    }

    private static boolean blockHasCollision(BlockView world, int x, int y, int z) {
        BlockPos pos = new BlockPos(x, y, z);
        BlockState state = world.getBlockState(pos);
        return !state.getCollisionShape(world, pos).isEmpty();
    }

    private ControlDecision resolveNavigationControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (!commandId.equals(activeNavigationCommandId)) {
            activeNavigationCommandId = commandId;
            activeNavigationWaypointIndex = 0;
            activeNavigationProgress = PathFollower.Progress.initial();
            activeNavigationWaypoints = List.of();
            activeNavigationRouteComputed = false;
            activeNavigationJumpWaypointIndexes = Set.of();
        }

        List<GridCell> waypoints = resolveNavigationWaypoints(client, player, effective);
        if (waypoints.isEmpty() && effective.targetX() != null && effective.targetZ() != null) {
            ControlDecision directCollect = maybeResolveDirectCollectFallback(player, effective);
            if (directCollect != null) {
                return directCollect;
            }
            logNavigationTargetRejected(commandId, effective, "no_path");
            BrainLink.Intent stop = new BrainLink.Intent(
                "stop",
                false,
                false,
                false,
                false,
                false,
                false,
                null,
                null,
                effective.targetX(),
                effective.targetZ(),
                List.of(),
                effective.blockedCells() == null ? List.of() : effective.blockedCells(),
                effective.arriveEpsilon(),
                List.of(),
                effective.expiresAtMs(),
                "target_rejected_no_path",
                commandId
            );
            return new ControlDecision(stop, InputState.stop());
        }
        double arriveEpsilon = effective.arriveEpsilon() == null ? 0.45D : effective.arriveEpsilon();
        PathFollower.Command command = PathFollower.follow(
            waypoints,
            activeNavigationWaypointIndex,
            activeNavigationProgress,
            player.getX(),
            player.getZ(),
            player.getYaw(),
            arriveEpsilon,
            LOOK_MAX_DEG_PER_TICK
        );
        activeNavigationWaypointIndex = command.waypointIndex();
        activeNavigationProgress = command.progress();
        boolean stepAssistJump = shouldJumpForStepUp(command.waypointIndex(), player, waypoints);
        InputState input = withJump(command.input(), stepAssistJump);

        BrainLink.Intent intent = new BrainLink.Intent(
            command.intent().action(),
            command.intent().forward(),
            command.intent().back(),
            command.intent().left(),
            command.intent().right(),
            command.intent().jump() || stepAssistJump,
            command.intent().sneak(),
            command.look().yaw(),
            command.look().pitch(),
            effective.targetX(),
            effective.targetZ(),
            waypoints,
            effective.blockedCells() == null ? List.of() : effective.blockedCells(),
            arriveEpsilon,
            List.of(),
            effective.expiresAtMs(),
            command.intent().reason(),
            commandId
        );
        return new ControlDecision(intent, input);
    }

    private ControlDecision maybeResolveDirectCollectFallback(ClientPlayerEntity player, BrainLink.Intent effective) {
        if (!isCollectNavigationIntent(effective) || effective.targetX() == null || effective.targetZ() == null) {
            return null;
        }
        double dx = effective.targetX() - player.getX();
        double dz = effective.targetZ() - player.getZ();
        double horizontalDistance = Math.hypot(dx, dz);
        if (horizontalDistance > DIRECT_COLLECT_FALLBACK_DISTANCE) {
            return null;
        }
        if (effective.targetY() != null && Math.abs(effective.targetY() - player.getY()) > 3.0D) {
            return null;
        }

        double targetY = effective.targetY() == null ? player.getY() : effective.targetY();
        double dy = targetY - player.getEyeY();
        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        double pitch = Math.toDegrees(Math.atan2(-dy, Math.max(0.001D, horizontalDistance)));
        boolean forward = horizontalDistance > DIRECT_COLLECT_ARRIVE_DISTANCE;
        boolean jump = effective.targetY() != null && effective.targetY() > Math.floor(player.getY()) + 0.2D;
        long nowMs = System.currentTimeMillis();
        String logKey = (effective.commandId() == null ? "" : effective.commandId()) + ":" + roundForLog(effective.targetX())
            + ":" + roundForLog(targetY) + ":" + roundForLog(effective.targetZ());
        if (!logKey.equals(lastDirectCollectFallbackLogKey) || nowMs - lastDirectCollectFallbackLogAtMs > 1_000L) {
            LOGGER.info(
                "navigation.direct_collect_fallback instanceId={} commandId={} reason={} targetX={} targetY={} targetZ={} distance={} forward={} jump={}",
                instanceId,
                effective.commandId() == null ? "" : effective.commandId(),
                effective.reason(),
                roundForLog(effective.targetX()),
                roundForLog(targetY),
                roundForLog(effective.targetZ()),
                roundForLog(horizontalDistance),
                forward,
                jump
            );
            lastDirectCollectFallbackLogKey = logKey;
            lastDirectCollectFallbackLogAtMs = nowMs;
        }

        BrainLink.Intent intent = new BrainLink.Intent(
            "navigate_to_point",
            forward,
            false,
            false,
            false,
            jump,
            false,
            yaw,
            Math.max(-60.0D, Math.min(60.0D, pitch)),
            effective.targetX(),
            effective.targetY(),
            effective.targetZ(),
            List.of(),
            effective.blockedCells() == null ? List.of() : effective.blockedCells(),
            effective.arriveEpsilon(),
            List.of(),
            effective.expiresAtMs(),
            "direct_collect_fallback:" + (effective.reason() == null ? "" : effective.reason()),
            effective.commandId() == null ? "" : effective.commandId()
        );
        InputState input = new InputState(forward, false, false, false, jump, false, forward ? 1.0F : 0.0F, 0.0F);
        return new ControlDecision(intent, input);
    }

    private boolean isCollectNavigationIntent(BrainLink.Intent effective) {
        if (effective == null || !"navigate_to_point".equals(effective.action())) {
            return false;
        }
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        String reason = effective.reason() == null ? "" : effective.reason();
        return commandId.contains(":collect") || reason.contains("collect");
    }

    private void logNavigationTargetRejected(String commandId, BrainLink.Intent effective, String reason) {
        String key = commandId + ":" + effective.targetX() + ":" + effective.targetZ() + ":" + reason;
        if (key.equals(lastNavigationTargetRejectionKey)) {
            return;
        }
        lastNavigationTargetRejectionKey = key;
        LOGGER.warn(
            "navigation.target_rejected instanceId={} commandId={} reason={} targetX={} targetZ={} action=safe_stop",
            instanceId,
            commandId,
            reason,
            effective.targetX(),
            effective.targetZ()
        );
    }

    private List<GridCell> resolveNavigationWaypoints(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective) {
        if (activeNavigationWaypoints != null && !activeNavigationWaypoints.isEmpty()) {
            return activeNavigationWaypoints;
        }
        if (activeNavigationRouteComputed) {
            return activeNavigationWaypoints;
        }
        if (effective.waypoints() != null && !effective.waypoints().isEmpty()) {
            activeNavigationWaypoints = effective.waypoints();
            activeNavigationRouteComputed = true;
            activeNavigationJumpWaypointIndexes = Set.of();
            return activeNavigationWaypoints;
        }
        if (effective.targetX() == null || effective.targetZ() == null) {
            activeNavigationWaypoints = List.of();
            activeNavigationRouteComputed = true;
            return activeNavigationWaypoints;
        }
        GridCell goal = new GridCell((int) Math.floor(effective.targetX()), (int) Math.floor(effective.targetZ()));
        if (effective.blockedCells() != null && !effective.blockedCells().isEmpty()) {
            GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
            Set<GridCell> blocked = new HashSet<>(effective.blockedCells());
            StaticGridPerception perception = new StaticGridPerception(blocked, start, goal);
            activeNavigationWaypoints = GridAStar.route(perception, start, goal);
            activeNavigationJumpWaypointIndexes = jumpWaypointIndexes(activeNavigationWaypoints, perception);
            activeNavigationRouteComputed = true;
            LOGGER.info(
                "navigation.route instanceId={} commandId={} start={} goal={} blocked={} waypoints={}",
                instanceId,
                activeNavigationCommandId,
                start,
                goal,
                blocked,
                activeNavigationWaypoints
            );
            return activeNavigationWaypoints;
        }

        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        int referenceFeetY = (int) Math.floor(player.getY());
        WorldGridPerception perception = new WorldGridPerception(client.world, referenceFeetY, start, goal, NAVIGATION_PERCEPTION_MARGIN);
        GridRouteDiagnostic diagnostic = GridAStar.diagnose(perception, start, goal);
        activeNavigationWaypoints = diagnostic.route();
        activeNavigationJumpWaypointIndexes = jumpWaypointIndexes(activeNavigationWaypoints, perception);
        activeNavigationRouteComputed = true;
        LOGGER.info(
            "navigation.perception_route instanceId={} commandId={} start={} goal={} referenceFeetY={} surfaces={} bounds=[{},{}]x[{},{}] blocked={}/{} jumpWaypoints={} waypoints={}",
            instanceId,
            activeNavigationCommandId,
            start,
            goal,
            referenceFeetY,
            perception.surfaceSummary(start, goal),
            perception.minX(),
            perception.maxX(),
            perception.minZ(),
            perception.maxZ(),
            perception.blockedCount(),
            perception.cellCount(),
            activeNavigationJumpWaypointIndexes,
            activeNavigationWaypoints
        );
        if (activeNavigationWaypoints.isEmpty()) {
            if (tryScanWindowFallback(client, start, goal, referenceFeetY, perception, diagnostic)) {
                return activeNavigationWaypoints;
            }
            logNoPathDiagnostic(client, start, goal, referenceFeetY, perception, diagnostic);
        }
        return activeNavigationWaypoints;
    }

    private boolean tryScanWindowFallback(
        MinecraftClient client,
        GridCell start,
        GridCell goal,
        int referenceFeetY,
        WorldGridPerception current,
        GridRouteDiagnostic currentDiagnostic
    ) {
        if (current.surfaceY(start.x(), start.z()).isEmpty()) {
            return false;
        }
        WorldGridPerception expandedScan = new WorldGridPerception(
            client.world,
            referenceFeetY,
            start,
            goal,
            NAVIGATION_PERCEPTION_MARGIN,
            WorldGridPerception.FALLBACK_SURFACE_SCAN_UP,
            WorldGridPerception.FALLBACK_SURFACE_SCAN_DOWN
        );
        GridRouteDiagnostic expandedScanDiagnostic = GridAStar.diagnose(expandedScan, start, goal);
        if (!expandedScanDiagnostic.routeFound()) {
            return false;
        }
        activeNavigationWaypoints = expandedScanDiagnostic.route();
        activeNavigationJumpWaypointIndexes = jumpWaypointIndexes(activeNavigationWaypoints, expandedScan);
        LOGGER.info(
            "navigation.scan_window_fallback instanceId={} commandId={} reason=expanded_vertical_scan_route_found currentFailure={} currentStartSurface={} currentGoalSurface={} fallbackStartSurface={} fallbackGoalSurface={} fallbackLength={} jumpWaypoints={} waypoints={}",
            instanceId,
            activeNavigationCommandId,
            currentDiagnostic.failureReason(),
            formatSurface(current, start),
            formatSurface(current, goal),
            formatSurface(expandedScan, start),
            formatSurface(expandedScan, goal),
            expandedScanDiagnostic.routeLength(),
            activeNavigationJumpWaypointIndexes,
            activeNavigationWaypoints
        );
        return true;
    }

    private void logNoPathDiagnostic(
        MinecraftClient client,
        GridCell start,
        GridCell goal,
        int referenceFeetY,
        WorldGridPerception current,
        GridRouteDiagnostic currentDiagnostic
    ) {
        WorldGridPerception expandedBounds = new WorldGridPerception(
            client.world,
            referenceFeetY,
            start,
            goal,
            NAVIGATION_DIAGNOSTIC_MARGIN
        );
        GridRouteDiagnostic expandedBoundsDiagnostic = GridAStar.diagnose(expandedBounds, start, goal);
        WorldGridPerception expandedScan = new WorldGridPerception(
            client.world,
            referenceFeetY,
            start,
            goal,
            NAVIGATION_PERCEPTION_MARGIN,
            NAVIGATION_DIAGNOSTIC_SCAN_UP,
            NAVIGATION_DIAGNOSTIC_SCAN_DOWN
        );
        GridRouteDiagnostic expandedScanDiagnostic = GridAStar.diagnose(expandedScan, start, goal);
        WorldGridPerception expandedFull = new WorldGridPerception(
            client.world,
            referenceFeetY,
            start,
            goal,
            NAVIGATION_DIAGNOSTIC_MARGIN,
            NAVIGATION_DIAGNOSTIC_SCAN_UP,
            NAVIGATION_DIAGNOSTIC_SCAN_DOWN
        );
        GridRouteDiagnostic expandedFullDiagnostic = GridAStar.diagnose(expandedFull, start, goal);

        String reason = categorizeNoPathReason(
            current,
            currentDiagnostic,
            expandedBoundsDiagnostic,
            expandedScanDiagnostic,
            expandedFullDiagnostic,
            goal
        );
        String category = categorizeNoPath(reason);
        LOGGER.info(
            "navigation.no_path_diagnostic instanceId={} commandId={} category={} reason={} currentFailure={} currentVisited={} currentStartSurface={} currentGoalSurface={} currentBlocked={}/{} currentHazards={} currentRejects={} currentRejectSamples={} expandedBoundsRoute={} expandedBoundsLength={} expandedBoundsBlocked={}/{} expandedScanRoute={} expandedScanLength={} expandedScanStartSurface={} expandedScanGoalSurface={} expandedFullRoute={} expandedFullLength={}",
            instanceId,
            activeNavigationCommandId,
            category,
            reason,
            currentDiagnostic.failureReason(),
            currentDiagnostic.visitedCells(),
            formatSurface(current, start),
            formatSurface(current, goal),
            current.blockedCount(),
            current.cellCount(),
            current.hazardCount(),
            formatRejects(currentDiagnostic),
            formatRejectSamples(currentDiagnostic),
            expandedBoundsDiagnostic.routeFound(),
            expandedBoundsDiagnostic.routeLength(),
            expandedBounds.blockedCount(),
            expandedBounds.cellCount(),
            expandedScanDiagnostic.routeFound(),
            expandedScanDiagnostic.routeLength(),
            formatSurface(expandedScan, start),
            formatSurface(expandedScan, goal),
            expandedFullDiagnostic.routeFound(),
            expandedFullDiagnostic.routeLength()
        );
    }

    private static String categorizeNoPathReason(
        WorldGridPerception current,
        GridRouteDiagnostic currentDiagnostic,
        GridRouteDiagnostic expandedBoundsDiagnostic,
        GridRouteDiagnostic expandedScanDiagnostic,
        GridRouteDiagnostic expandedFullDiagnostic,
        GridCell goal
    ) {
        if (expandedBoundsDiagnostic.routeFound()) {
            return "expanded_bounds_route_found";
        }
        if (expandedScanDiagnostic.routeFound()) {
            return "expanded_vertical_scan_route_found";
        }
        if (expandedFullDiagnostic.routeFound()) {
            return "expanded_bounds_and_scan_route_found";
        }
        if (current.columnHasHazard(goal.x(), goal.z())) {
            return "goal_hazard";
        }
        int elevationRejections = currentDiagnostic.rejectionCount(TraversalIssue.RISE_TOO_HIGH)
            + currentDiagnostic.rejectionCount(TraversalIssue.DROP_TOO_FAR);
        if (elevationRejections > 0) {
            return "elevation_transition_blocked";
        }
        if (currentDiagnostic.failureReason().equals("goal_blocked")) {
            return "goal_blocked";
        }
        if (current.hazardCount() > 0 && currentDiagnostic.rejectionCount(TraversalIssue.TO_BLOCKED) > 0) {
            return "hazard_or_water_barrier";
        }
        return currentDiagnostic.failureReason().isBlank() ? "open_exhausted" : currentDiagnostic.failureReason();
    }

    private static String categorizeNoPath(String reason) {
        return switch (reason) {
            case "expanded_bounds_route_found", "expanded_vertical_scan_route_found", "expanded_bounds_and_scan_route_found" -> "scan_window_limited";
            case "elevation_transition_blocked" -> "multi_block_elevation";
            case "goal_hazard", "hazard_or_water_barrier" -> "water_or_hazard";
            default -> "unreachable_or_blocked_target";
        };
    }

    private static String formatSurface(GridPerception perception, GridCell cell) {
        var surface = perception.surfaceY(cell.x(), cell.z());
        return surface.isPresent() ? Integer.toString(surface.getAsInt()) : "blocked";
    }

    private static String formatRejects(GridRouteDiagnostic diagnostic) {
        StringBuilder builder = new StringBuilder();
        for (TraversalIssue issue : TraversalIssue.values()) {
            int count = diagnostic.rejectionCount(issue);
            if (count <= 0) {
                continue;
            }
            if (builder.length() > 0) {
                builder.append(',');
            }
            builder.append(issue.name().toLowerCase()).append(':').append(count);
        }
        return builder.length() == 0 ? "none" : builder.toString();
    }

    private static String formatRejectSamples(GridRouteDiagnostic diagnostic) {
        StringBuilder builder = new StringBuilder();
        for (GridRejectionSample sample : diagnostic.rejectionSamples()) {
            if (builder.length() > 0) {
                builder.append(',');
            }
            builder
                .append(sample.issue().name().toLowerCase())
                .append(':')
                .append(formatCell(sample.from()))
                .append('>')
                .append(formatCell(sample.to()))
                .append('@')
                .append(sample.fromSurfaceY() == null ? "blocked" : sample.fromSurfaceY())
                .append('>')
                .append(sample.toSurfaceY() == null ? "blocked" : sample.toSurfaceY());
        }
        return builder.length() == 0 ? "none" : builder.toString();
    }

    private static String formatCell(GridCell cell) {
        return cell.x() + "," + cell.z();
    }

    private boolean shouldJumpForStepUp(int waypointIndex, ClientPlayerEntity player, List<GridCell> waypoints) {
        if (waypointIndex <= 0 || waypointIndex >= waypoints.size() || !activeNavigationJumpWaypointIndexes.contains(waypointIndex)) {
            return false;
        }
        GridCell target = waypoints.get(waypointIndex);
        double distance = Math.hypot(PathFollower.center(target.x()) - player.getX(), PathFollower.center(target.z()) - player.getZ());
        return distance <= 1.35D;
    }

    private static InputState withJump(InputState input, boolean jump) {
        if (!jump || input == null || !input.pressingForward()) {
            return input;
        }
        return new InputState(
            input.pressingForward(),
            input.pressingBack(),
            input.pressingLeft(),
            input.pressingRight(),
            true,
            input.sneaking(),
            input.movementForward(),
            input.movementSideways()
        );
    }

    private static Set<Integer> jumpWaypointIndexes(List<GridCell> waypoints, GridPerception perception) {
        if (waypoints == null || waypoints.size() < 2 || perception == null) {
            return Set.of();
        }
        Map<GridCell, Integer> surfaces = new HashMap<>();
        for (GridCell waypoint : waypoints) {
            var surface = perception.surfaceY(waypoint.x(), waypoint.z());
            if (surface.isPresent()) {
                surfaces.put(waypoint, surface.getAsInt());
            }
        }
        Set<Integer> indexes = new HashSet<>();
        for (int i = 1; i < waypoints.size(); i++) {
            Integer previous = surfaces.get(waypoints.get(i - 1));
            Integer next = surfaces.get(waypoints.get(i));
            if (previous != null && next != null && next - previous == 1) {
                indexes.add(i);
            }
        }
        return Set.copyOf(indexes);
    }

    private record StaticGridPerception(Set<GridCell> blocked, int minX, int maxX, int minZ, int maxZ) implements GridPerception {
        StaticGridPerception(Set<GridCell> blocked, GridCell start, GridCell goal) {
            this(
                Set.copyOf(blocked),
                Math.min(minCoordinate(blocked, start.x(), goal.x(), true), Math.min(start.x(), goal.x())) - 4,
                Math.max(maxCoordinate(blocked, start.x(), goal.x(), true), Math.max(start.x(), goal.x())) + 4,
                Math.min(minCoordinate(blocked, start.z(), goal.z(), false), Math.min(start.z(), goal.z())) - 4,
                Math.max(maxCoordinate(blocked, start.z(), goal.z(), false), Math.max(start.z(), goal.z())) + 4
            );
        }

        @Override
        public boolean isBlocked(int x, int z) {
            return !inBounds(x, z) || blocked.contains(new GridCell(x, z));
        }

        private static int minCoordinate(Set<GridCell> cells, int fallbackA, int fallbackB, boolean xAxis) {
            int min = Math.min(fallbackA, fallbackB);
            for (GridCell cell : cells) {
                min = Math.min(min, xAxis ? cell.x() : cell.z());
            }
            return min;
        }

        private static int maxCoordinate(Set<GridCell> cells, int fallbackA, int fallbackB, boolean xAxis) {
            int max = Math.max(fallbackA, fallbackB);
            for (GridCell cell : cells) {
                max = Math.max(max, xAxis ? cell.x() : cell.z());
            }
            return max;
        }
    }

    private void applyServerCommands(MinecraftClient client, BrainLink.Intent effective) {
        if (effective == null || effective.serverCommands() == null || effective.serverCommands().isEmpty()) {
            return;
        }
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        String batchId = commandId + ":" + effective.serverCommands().hashCode();
        if (batchId.equals(lastServerCommandBatchId)) {
            return;
        }
        MinecraftServer server = client.getServer();
        if (!client.isIntegratedServerRunning() || server == null) {
            LOGGER.warn("server_command.skip instanceId={} commandId={} reason=no_integrated_server", instanceId, commandId);
            lastServerCommandBatchId = batchId;
            return;
        }
        lastServerCommandBatchId = batchId;
        List<String> commands = List.copyOf(effective.serverCommands());
        server.execute(() -> {
            ServerCommandSource source = server.getCommandSource().withSilent();
            for (String command : commands) {
                String normalized = command.startsWith("/") ? command : "/" + command;
                LOGGER.info("server_command.apply instanceId={} commandId={} command={}", instanceId, commandId, normalized);
                server.getCommandManager().executeWithPrefix(source, normalized);
            }
        });
    }

    private void applyLookControl(ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        if (effective == null || (effective.targetYaw() == null && effective.targetPitch() == null)) {
            lastLookTarget = "";
            return;
        }

        double targetYaw = effective.targetYaw() == null ? player.getYaw() : effective.targetYaw();
        double targetPitch = effective.targetPitch() == null ? player.getPitch() : effective.targetPitch();
        LookController.Look next = LookController.nextLook(
            player.getYaw(),
            player.getPitch(),
            targetYaw,
            targetPitch,
            LOOK_MAX_DEG_PER_TICK
        );
        player.setYaw((float) next.yaw());
        player.setPitch((float) next.pitch());

        String targetKey = effective.commandId() + ":" + targetYaw + ":" + targetPitch;
        if (!targetKey.equals(lastLookTarget) || nowMs - lastLookLogMs >= 1000L) {
            LOGGER.info(
                "look.apply instanceId={} commandId={} targetYaw={} targetPitch={} yaw={} pitch={}",
                instanceId,
                effective.commandId(),
                targetYaw,
                targetPitch,
                next.yaw(),
                next.pitch()
            );
            lastLookTarget = targetKey;
            lastLookLogMs = nowMs;
        }
    }

    private static void releaseAllInputs(Input input) {
        applyInputState(input, InputState.stop());
    }

    private static void applyInputState(Input input, InputState state) {
        input.pressingForward = state.pressingForward();
        input.pressingBack = state.pressingBack();
        input.pressingLeft = state.pressingLeft();
        input.pressingRight = state.pressingRight();
        input.jumping = state.jumping();
        input.sneaking = state.sneaking();
        input.movementForward = state.movementForward();
        input.movementSideways = state.movementSideways();
    }

    private final class McbotControlledInput extends Input {
        @Override
        public void tick(boolean slowDown, float slowDownFactor) {
            applyInputState(this, currentInputState);
        }
    }

    private record ControlDecision(BrainLink.Intent intent, InputState input) {
    }

    private static final class GatherLogRun {
        final String commandId;
        final BlockPos target;
        final int baselineLogCount;
        final long startedAtMs;
        final Set<GridCell> excludedAdjacentCells = new HashSet<>();
        GridCell adjacentCell = null;
        boolean breakDone = false;
        long collectStartedAtMs = 0L;
        int occludersBroken = 0;
        int occlusionRepositions = 0;
        int occlusionAbandons = 0;

        GatherLogRun(String commandId, BlockPos target, int baselineLogCount, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.target = target.toImmutable();
            this.baselineLogCount = baselineLogCount;
            this.startedAtMs = startedAtMs;
        }
    }

    private static final class GatherTreeRun {
        final String commandId;
        final BlockPos seed;
        final int baselineLogCount;
        final long startedAtMs;
        final Set<BlockPos> cluster;
        final Set<BlockPos> completedTargets = new HashSet<>();
        final Set<BlockPos> abandonedTargets = new HashSet<>();
        final Set<GridCell> excludedAdjacentCells = new HashSet<>();
        int lastVerifiedLogCount;
        int collectTimeouts = 0;
        int occludersBroken = 0;
        int occlusionRepositions = 0;
        int occlusionAbandons = 0;
        BlockPos currentTarget = null;
        GridCell currentAdjacentCell = null;
        boolean breakDone = false;
        long collectStartedAtMs = 0L;

        GatherTreeRun(String commandId, BlockPos seed, int baselineLogCount, long startedAtMs, Set<BlockPos> cluster) {
            this.commandId = commandId == null ? "" : commandId;
            this.seed = seed.toImmutable();
            this.baselineLogCount = baselineLogCount;
            this.lastVerifiedLogCount = baselineLogCount;
            this.startedAtMs = startedAtMs;
            this.cluster = cluster == null ? Set.of() : Set.copyOf(cluster);
        }
    }

    private enum Craft2x2Stage {
        START,
        PICK_SOURCE_STACK,
        PLACE_INPUTS,
        RETURN_REMAINDER,
        WAIT_RESULT,
        TAKE_RESULT,
        VERIFY
    }

    private enum FurnaceSmeltRecipe {
        CHARCOAL("smelt_charcoal", "charcoal"),
        RAW_IRON("smelt_raw_iron", "iron_ingot");

        private final String action;
        private final String outputItemId;

        FurnaceSmeltRecipe(String action, String outputItemId) {
            this.action = action;
            this.outputItemId = outputItemId;
        }

        String action() {
            return action;
        }

        String outputItemId() {
            return outputItemId;
        }

        static FurnaceSmeltRecipe fromAction(String action) {
            if (action == null) {
                return null;
            }
            for (FurnaceSmeltRecipe recipe : values()) {
                if (recipe.action.equals(action)) {
                    return recipe;
                }
            }
            return null;
        }
    }

    private enum MakeCharcoalPhase {
        CRAFT_FURNACE,
        PLACE_FURNACE,
        SMELT_CHARCOAL
    }

    private enum R2MineStoneReturnPhase {
        DESCEND,
        MINE,
        RETURN
    }

    private enum R5IronChainPhase {
        DESCEND,
        MINE_IRON,
        RETURN_SURFACE,
        PLACE_TABLE,
        PLACE_FURNACE,
        SMELT_RAW_IRON,
        CRAFT_IRON_PICKAXE
    }

    private record CraftInventorySnapshot(
        InventoryCounter.InventoryLogSnapshot logs,
        InventoryCounter.InventoryPlankSnapshot planks,
        InventoryCounter.InventoryStickSnapshot sticks,
        InventoryCounter.InventoryCraftingTableSnapshot tables,
        InventoryCounter.InventoryWoodenPickaxeSnapshot woodenPickaxes,
        InventoryCounter.InventoryCobblestoneSnapshot cobblestone,
        InventoryCounter.InventoryItemSnapshot stonePickaxes,
        InventoryCounter.InventoryItemSnapshot stoneAxes,
        InventoryCounter.InventoryItemSnapshot stoneSwords,
        InventoryCounter.InventoryItemSnapshot furnaces,
        InventoryCounter.InventoryItemSnapshot charcoal,
        InventoryCounter.InventoryItemSnapshot coal,
        InventoryCounter.InventoryItemSnapshot rawIron,
        InventoryCounter.InventoryItemSnapshot ironIngots,
        InventoryCounter.InventoryItemSnapshot ironPickaxes
    ) {
    }

    private static final class Craft2x2Run {
        final String commandId;
        final Craft2x2RecipePlanner.Recipe recipe;
        final int baselineLogs;
        final int baselinePlanks;
        final int baselineSticks;
        final int baselineTables;
        final long startedAtMs;
        Craft2x2Stage stage = Craft2x2Stage.START;
        long stageStartedAtMs;
        long lastClickAtMs = 0L;
        int sourceScreenSlot = -1;
        int nextInputIndex = 0;

        Craft2x2Run(String commandId, Craft2x2RecipePlanner.Recipe recipe, CraftInventorySnapshot inventory, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.recipe = recipe;
            this.baselineLogs = inventory.logs.logCount();
            this.baselinePlanks = inventory.planks.plankCount();
            this.baselineSticks = inventory.sticks.stickCount();
            this.baselineTables = inventory.tables.craftingTableCount();
            this.startedAtMs = startedAtMs;
            this.stageStartedAtMs = startedAtMs;
        }
    }

    private static final class Craft3x3Run {
        final String commandId;
        final Craft3x3RecipePlanner.Recipe recipe;
        final int baselinePlanks;
        final int baselineCobblestone;
        final int baselineSticks;
        final int baselineIronIngots;
        final int baselineWoodenPickaxes;
        final int baselineResult;
        final int baselineStonePickaxes;
        final int baselineStoneAxes;
        final int baselineStoneSwords;
        final int baselineFurnaces;
        final int baselineIronPickaxes;
        final long startedAtMs;
        Craft3x3ControlPlanner.Stage stage = Craft3x3ControlPlanner.Stage.START;
        long stageStartedAtMs;
        long lastClickAtMs = 0L;
        long tableOpenInteractedAtMs = 0L;
        long lastTableOpenWaitLogAtMs = 0L;
        BlockPos tableOpenTarget = null;
        int tableOpenAttempts = 0;
        int sourceScreenSlot = -1;
        int groupIndex = 0;
        int inputIndexInGroup = 0;

        Craft3x3Run(String commandId, Craft3x3RecipePlanner.Recipe recipe, CraftInventorySnapshot inventory, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.recipe = recipe;
            this.baselinePlanks = inventory.planks.plankCount();
            this.baselineCobblestone = inventory.cobblestone.cobblestoneCount();
            this.baselineSticks = inventory.sticks.stickCount();
            this.baselineIronIngots = inventory.ironIngots.itemCount();
            this.baselineWoodenPickaxes = inventory.woodenPickaxes.woodenPickaxeCount();
            this.baselineResult = craft3x3ResultCount(inventory, recipe);
            this.baselineStonePickaxes = inventory.stonePickaxes.itemCount();
            this.baselineStoneAxes = inventory.stoneAxes.itemCount();
            this.baselineStoneSwords = inventory.stoneSwords.itemCount();
            this.baselineFurnaces = inventory.furnaces.itemCount();
            this.baselineIronPickaxes = inventory.ironPickaxes.itemCount();
            this.startedAtMs = startedAtMs;
            this.stageStartedAtMs = startedAtMs;
        }
    }

    private static final class SmeltCharcoalRun {
        final String commandId;
        final FurnaceSmeltRecipe recipe;
        final int baselineLogs;
        final int baselinePlanks;
        final int baselineCharcoal;
        final int baselineRawIron;
        final int baselineIronIngots;
        final long startedAtMs;
        SmeltControlPlanner.Stage stage = SmeltControlPlanner.Stage.START;
        long stageStartedAtMs;
        long lastClickAtMs = 0L;
        long outputWaitStartedAtMs = 0L;
        int inputSourceSlot = -1;
        int fuelSourceSlot = -1;
        String inputItemId = "";
        String fuelItemId = "";

        SmeltCharcoalRun(String commandId, FurnaceSmeltRecipe recipe, CraftInventorySnapshot inventory, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.recipe = recipe == null ? FurnaceSmeltRecipe.CHARCOAL : recipe;
            this.baselineLogs = inventory.logs.logCount();
            this.baselinePlanks = inventory.planks.plankCount();
            this.baselineCharcoal = inventory.charcoal.itemCount();
            this.baselineRawIron = inventory.rawIron.itemCount();
            this.baselineIronIngots = inventory.ironIngots.itemCount();
            this.startedAtMs = startedAtMs;
            this.stageStartedAtMs = startedAtMs;
        }
    }

    private static final class MakeCharcoalRun {
        final String commandId;
        final int baselineCobblestone;
        final int baselineLogs;
        final int baselinePlanks;
        final int baselineFurnaces;
        final int baselineCharcoal;
        final long startedAtMs;
        MakeCharcoalPhase phase = MakeCharcoalPhase.CRAFT_FURNACE;
        long phaseStartedAtMs;
        int placeBaselineFurnaces = -1;

        MakeCharcoalRun(String commandId, CraftInventorySnapshot inventory, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.baselineCobblestone = inventory.cobblestone.cobblestoneCount();
            this.baselineLogs = inventory.logs.logCount();
            this.baselinePlanks = inventory.planks.plankCount();
            this.baselineFurnaces = inventory.furnaces.itemCount();
            this.baselineCharcoal = inventory.charcoal.itemCount();
            this.startedAtMs = startedAtMs;
            this.phaseStartedAtMs = startedAtMs;
        }

        String craftFurnaceCommandId() {
            return commandId + ":craft_furnace";
        }

        String placeFurnaceCommandId() {
            return commandId + ":place_furnace";
        }

        String smeltCharcoalCommandId() {
            return commandId + ":smelt_charcoal";
        }
    }

    private static final class RetrieveTableRun {
        final String commandId;
        final int baselineTables;
        final long startedAtMs;
        BlockPos target = null;
        boolean breakDone = false;
        long collectStartedAtMs = 0L;

        RetrieveTableRun(String commandId, int baselineTables, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.baselineTables = baselineTables;
            this.startedAtMs = startedAtMs;
        }
    }

    private static final class MineStoneRun {
        final String commandId;
        final BlockPos target;
        final int baselineCobblestone;
        final long startedAtMs;
        boolean breakDone = false;
        long collectStartedAtMs = 0L;

        MineStoneRun(String commandId, BlockPos target, int baselineCobblestone, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.target = target == null ? null : target.toImmutable();
            this.baselineCobblestone = baselineCobblestone;
            this.startedAtMs = startedAtMs;
        }
    }

    private static final class DescentRun {
        final String commandId;
        final BlockPos startFeet;
        final int depth;
        final long startedAtMs;
        final float healthBefore;
        final Set<String> rejectedMoves = new HashSet<>();
        final List<BlockPos> reachedFeet = new ArrayList<>();
        BlockPos currentFeet;
        StaircaseDescentPlanner.Direction2d direction;
        int stepIndex = 1;
        int depthReached = 0;
        int reroutes = 0;
        int openAirReroutes = 0;
        int hazardReroutes = 0;
        DescentControlPlanner.Stage stage = DescentControlPlanner.Stage.BREAK_SIGHT;
        final Set<BlockPos> abandonedIronCleanupTargets = new HashSet<>();
        BlockPos ironCleanupTarget = null;
        BlockPos lastIronCleanupTarget = null;
        long ironCleanupCollectStartedAtMs = 0L;
        int ironCleanupBlocksBroken = 0;

        DescentRun(
            String commandId,
            BlockPos startFeet,
            StaircaseDescentPlanner.Direction2d direction,
            int depth,
            long startedAtMs,
            float healthBefore
        ) {
            this.commandId = commandId == null ? "" : commandId;
            this.startFeet = startFeet.toImmutable();
            this.currentFeet = startFeet.toImmutable();
            this.direction = direction;
            this.depth = depth;
            this.startedAtMs = startedAtMs;
            this.healthBefore = healthBefore;
            this.reachedFeet.add(this.startFeet);
        }
    }

    private static final class MineNearbyStoneRun {
        final String commandId;
        final int baselineCobblestone;
        final long startedAtMs;
        final Set<BlockPos> abandonedTargets = new HashSet<>();
        BlockPos currentTarget = null;
        BlockPos lastBrokenTarget = null;
        long collectStartedAtMs = 0L;

        MineNearbyStoneRun(String commandId, int baselineCobblestone, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.baselineCobblestone = baselineCobblestone;
            this.startedAtMs = startedAtMs;
        }
    }

    private static final class MineNearbyIronRun {
        final String commandId;
        final int baselineRawIron;
        final long startedAtMs;
        final Set<BlockPos> abandonedTargets = new HashSet<>();
        BlockPos currentTarget = null;
        boolean currentTargetIron = false;
        BlockPos lastBrokenTarget = null;
        BlockPos currentProspectCell = null;
        StaircaseDescentPlanner.Direction2d prospectDirection = null;
        long collectStartedAtMs = 0L;
        long prospectSettleUntilMs = 0L;
        int prospectBlocksBroken = 0;
        int branchCellsAdvanced = 0;
        int toolRecoveryAttempts = 0;
        boolean proactiveToolRecoveryLogged = false;
        boolean fieldKitRecoveryActive = false;
        BlockPos fieldKitAlcoveCell = null;
        boolean fieldKitTablePlacedByRecovery = false;
        boolean fieldKitRetrieveTablePending = false;
        long lastFieldKitStateLogAtMs = 0L;

        MineNearbyIronRun(String commandId, int baselineRawIron, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.baselineRawIron = baselineRawIron;
            this.startedAtMs = startedAtMs;
        }

        String toolPlaceTableCommandId() {
            return commandId + ":neariron:fieldkit:place_table:" + toolRecoveryAttempts;
        }

        String toolCraftPickaxeCommandId() {
            return commandId + ":neariron:fieldkit:craft_stone_pickaxe:" + toolRecoveryAttempts;
        }

        String toolRetrieveTableCommandId() {
            return commandId + ":neariron:fieldkit:retrieve_table:" + toolRecoveryAttempts;
        }
    }

    private static final class ReturnStaircaseRun {
        final String commandId;
        final BlockPos target;
        final long startedAtMs;
        final float healthBefore;
        final List<BlockPos> returnPath;
        int waypointIndex = -1;
        int progressWaypointIndex = -1;
        int lastLoggedWaypointIndex = -1;
        double bestWaypointDistanceSq = Double.POSITIVE_INFINITY;
        long lastWaypointProgressMs;
        long lastWaypointLogMs = 0L;

        ReturnStaircaseRun(String commandId, BlockPos target, long startedAtMs, float healthBefore, List<BlockPos> returnPath) {
            this.commandId = commandId == null ? "" : commandId;
            this.target = target.toImmutable();
            this.startedAtMs = startedAtMs;
            this.healthBefore = healthBefore;
            this.returnPath = returnPath == null ? List.of() : List.copyOf(returnPath);
            this.lastWaypointProgressMs = startedAtMs;
        }
    }

    private static final class R2MineStoneReturnRun {
        final String commandId;
        final BlockPos startFeet;
        final StaircaseDescentPlanner.Direction2d direction;
        final int depth;
        final long startedAtMs;
        final float healthBefore;
        R2MineStoneReturnPhase phase = R2MineStoneReturnPhase.DESCEND;

        R2MineStoneReturnRun(
            String commandId,
            BlockPos startFeet,
            StaircaseDescentPlanner.Direction2d direction,
            int depth,
            long startedAtMs,
            float healthBefore
        ) {
            this.commandId = commandId == null ? "" : commandId;
            this.startFeet = startFeet.toImmutable();
            this.direction = direction;
            this.depth = depth;
            this.startedAtMs = startedAtMs;
            this.healthBefore = healthBefore;
        }

        BlockPos descentTarget() {
            return startFeet.add(direction.dx() * depth, -depth, direction.dz() * depth);
        }
    }

    private static final class R5IronChainRun {
        final String commandId;
        final BlockPos startFeet;
        final StaircaseDescentPlanner.Direction2d direction;
        final int depth;
        final long startedAtMs;
        final float healthBefore;
        final int baselineRawIron;
        final int baselineIronIngots;
        final int baselineIronPickaxes;
        R5IronChainPhase phase = R5IronChainPhase.DESCEND;
        int smeltAttempts = 0;
        boolean endpointFixturePlaced = false;
        long endpointFixtureSettleUntilMs = 0L;
        List<BlockPos> endpointFixturePositions = List.of();
        List<BlockPos> returnPath = List.of();

        R5IronChainRun(
            String commandId,
            BlockPos startFeet,
            StaircaseDescentPlanner.Direction2d direction,
            int depth,
            CraftInventorySnapshot inventory,
            long startedAtMs,
            float healthBefore
        ) {
            this.commandId = commandId == null ? "" : commandId;
            this.startFeet = startFeet.toImmutable();
            this.direction = direction;
            this.depth = depth;
            this.startedAtMs = startedAtMs;
            this.healthBefore = healthBefore;
            this.baselineRawIron = inventory.rawIron.itemCount();
            this.baselineIronIngots = inventory.ironIngots.itemCount();
            this.baselineIronPickaxes = inventory.ironPickaxes.itemCount();
        }

        BlockPos descentTarget() {
            return startFeet.add(direction.dx() * depth, -depth, direction.dz() * depth);
        }

        String descentCommandId() {
            return commandId + ":descend";
        }

        String mineIronCommandId() {
            return commandId + ":mine_iron";
        }

        String returnCommandId() {
            return commandId + ":return";
        }

        String placeTableCommandId() {
            return commandId + ":place_table";
        }

        String placeFurnaceCommandId() {
            return commandId + ":place_furnace";
        }

        String smeltRawIronCommandId() {
            return commandId + ":smelt_raw_iron:" + (smeltAttempts + 1);
        }

        String craftIronPickaxeCommandId() {
            return commandId + ":craft_iron_pickaxe";
        }
    }

    private record LookAngles(double yaw, double pitch) {
    }

    private record HazardBlock(BlockPos pos, String kind) {
    }

    private static String resolveInstanceId() {
        String configured = System.getProperty("mcbot.instanceId");
        if (configured == null || configured.isBlank()) {
            configured = System.getenv("MCBOT_FABRIC_INSTANCE_ID");
        }
        if (configured == null || configured.isBlank()) {
            configured = "fabric-spike-" + UUID.randomUUID();
        }
        return configured.trim();
    }

    private static boolean resolveBoolean(String propertyName, String envName) {
        String configured = System.getProperty(propertyName);
        if (configured == null || configured.isBlank()) {
            configured = System.getenv(envName);
        }
        return "1".equals(configured) || "true".equalsIgnoreCase(configured);
    }

    private static long resolveLong(String propertyName, String envName, long defaultValue) {
        String configured = System.getProperty(propertyName);
        if (configured == null || configured.isBlank()) {
            configured = System.getenv(envName);
        }
        if (configured == null || configured.isBlank()) {
            return defaultValue;
        }
        try {
            long parsed = Long.parseLong(configured.trim());
            return parsed > 0L ? parsed : defaultValue;
        } catch (NumberFormatException ignored) {
            return defaultValue;
        }
    }

    private static String resolveBrainUrl() {
        String configured = System.getProperty("mcbot.brainUrl");
        if (configured == null || configured.isBlank()) {
            configured = System.getenv("MCBOT_FABRIC_BRAIN_URL");
        }
        if (configured == null || configured.isBlank()) {
            configured = "http://127.0.0.1:8765/intent";
        }
        return configured.trim();
    }

    private record TerrainProbe(
        int currentCellX,
        int currentCellZ,
        int referenceFeetY,
        boolean currentFeetSolid,
        boolean currentHeadSolid,
        boolean currentHazard,
        Integer currentSurfaceY,
        int aheadCellX,
        int aheadCellZ,
        String aheadDirection,
        boolean aheadFeetSolid,
        boolean aheadHeadSolid,
        boolean aheadHazard,
        Integer aheadSurfaceY,
        Integer aheadStepDelta,
        boolean perceptionAheadWalkable,
        String perceptionAheadIssue,
        Integer perceptionAheadSurfaceY,
        Integer waypointCellX,
        Integer waypointCellZ,
        Boolean waypointFeetSolid,
        Boolean waypointHeadSolid,
        Boolean waypointHazard,
        Integer waypointSurfaceY,
        Integer waypointStepDelta,
        Boolean perceptionWaypointWalkable,
        String perceptionWaypointIssue,
        Integer perceptionWaypointSurfaceY,
        ColumnProbe currentColumn,
        ColumnProbe aheadColumn,
        ColumnProbe waypointColumn
    ) {
        static TerrainProbe capture(
            BlockView world,
            ClientPlayerEntity player,
            List<GridCell> waypoints,
            int waypointIndex,
            boolean includeColumns
        ) {
            int currentX = (int) Math.floor(player.getX());
            int currentZ = (int) Math.floor(player.getZ());
            int referenceFeetY = (int) Math.floor(player.getY());
            GridCell current = new GridCell(currentX, currentZ);
            GridCell ahead = aheadCell(current, player.getYaw());
            GridCell waypoint = waypoints != null && waypointIndex >= 0 && waypointIndex < waypoints.size()
                ? waypoints.get(waypointIndex)
                : null;
            int minX = Math.min(current.x(), Math.min(ahead.x(), waypoint == null ? current.x() : waypoint.x())) - 2;
            int maxX = Math.max(current.x(), Math.max(ahead.x(), waypoint == null ? current.x() : waypoint.x())) + 2;
            int minZ = Math.min(current.z(), Math.min(ahead.z(), waypoint == null ? current.z() : waypoint.z())) - 2;
            int maxZ = Math.max(current.z(), Math.max(ahead.z(), waypoint == null ? current.z() : waypoint.z())) + 2;
            WorldGridPerception perception = new WorldGridPerception(world, referenceFeetY, minX, maxX, minZ, maxZ);
            Integer currentSurface = surfaceOrNull(perception, current);
            Integer aheadSurface = surfaceOrNull(perception, ahead);
            TraversalIssue aheadIssue = perception.traversalIssue(current, ahead);
            Integer waypointSurface = waypoint == null ? null : surfaceOrNull(perception, waypoint);
            TraversalIssue waypointIssue = waypoint == null ? null : perception.traversalIssue(current, waypoint);

            return new TerrainProbe(
                current.x(),
                current.z(),
                referenceFeetY,
                hasCollision(world, current.x(), referenceFeetY, current.z()),
                hasCollision(world, current.x(), referenceFeetY + 1, current.z()),
                hasHazard(world, current.x(), referenceFeetY, current.z()),
                currentSurface,
                ahead.x(),
                ahead.z(),
                directionName(current, ahead),
                hasCollision(world, ahead.x(), referenceFeetY, ahead.z()),
                hasCollision(world, ahead.x(), referenceFeetY + 1, ahead.z()),
                hasHazard(world, ahead.x(), referenceFeetY, ahead.z()),
                aheadSurface,
                stepDelta(currentSurface, aheadSurface),
                aheadIssue == TraversalIssue.NONE,
                aheadIssue.name(),
                aheadSurface,
                waypoint == null ? null : waypoint.x(),
                waypoint == null ? null : waypoint.z(),
                waypoint == null ? null : hasCollision(world, waypoint.x(), referenceFeetY, waypoint.z()),
                waypoint == null ? null : hasCollision(world, waypoint.x(), referenceFeetY + 1, waypoint.z()),
                waypoint == null ? null : hasHazard(world, waypoint.x(), referenceFeetY, waypoint.z()),
                waypointSurface,
                stepDelta(currentSurface, waypointSurface),
                waypointIssue == null ? null : waypointIssue == TraversalIssue.NONE,
                waypointIssue == null ? null : waypointIssue.name(),
                waypointSurface,
                includeColumns ? ColumnProbe.capture(world, current.x(), current.z(), referenceFeetY) : null,
                includeColumns ? ColumnProbe.capture(world, ahead.x(), ahead.z(), referenceFeetY) : null,
                includeColumns && waypoint != null ? ColumnProbe.capture(world, waypoint.x(), waypoint.z(), referenceFeetY) : null
            );
        }

        private static GridCell aheadCell(GridCell current, float yaw) {
            double normalized = LookController.normalizeYaw(yaw);
            if (normalized >= -45.0D && normalized <= 45.0D) {
                return new GridCell(current.x(), current.z() + 1);
            }
            if (normalized > 45.0D && normalized <= 135.0D) {
                return new GridCell(current.x() - 1, current.z());
            }
            if (normalized < -45.0D && normalized >= -135.0D) {
                return new GridCell(current.x() + 1, current.z());
            }
            return new GridCell(current.x(), current.z() - 1);
        }

        private static String directionName(GridCell current, GridCell ahead) {
            int dx = ahead.x() - current.x();
            int dz = ahead.z() - current.z();
            if (dx > 0) return "east";
            if (dx < 0) return "west";
            if (dz > 0) return "south";
            if (dz < 0) return "north";
            return "current";
        }

        private static Integer surfaceOrNull(GridPerception perception, GridCell cell) {
            var surface = perception.surfaceY(cell.x(), cell.z());
            return surface.isPresent() ? surface.getAsInt() : null;
        }

        private static Integer stepDelta(Integer fromSurfaceY, Integer toSurfaceY) {
            return fromSurfaceY == null || toSurfaceY == null ? null : toSurfaceY - fromSurfaceY;
        }

        private static boolean hasCollision(BlockView world, int x, int y, int z) {
            BlockPos pos = new BlockPos(x, y, z);
            BlockState state = world.getBlockState(pos);
            return !state.getCollisionShape(world, pos).isEmpty();
        }

        private static boolean hasHazard(BlockView world, int x, int feetY, int z) {
            return isHazard(world.getBlockState(new BlockPos(x, feetY - 1, z)))
                || isHazard(world.getBlockState(new BlockPos(x, feetY, z)))
                || isHazard(world.getBlockState(new BlockPos(x, feetY + 1, z)));
        }

        private static boolean isHazard(BlockState state) {
            return state.isOf(Blocks.WATER)
                || state.isOf(Blocks.LAVA)
                || state.isOf(Blocks.FIRE)
                || state.isOf(Blocks.SOUL_FIRE)
                || state.isOf(Blocks.CACTUS)
                || state.isOf(Blocks.MAGMA_BLOCK)
                || state.isOf(Blocks.CAMPFIRE)
                || state.isOf(Blocks.SOUL_CAMPFIRE)
                || state.getFluidState().isIn(FluidTags.WATER)
                || state.getFluidState().isIn(FluidTags.LAVA);
        }
    }

    private record ColumnProbe(
        int x,
        int z,
        int referenceY,
        int scanUp,
        int scanDown,
        int scanMinY,
        int scanMaxY,
        Integer surfaceY,
        String surfaceReason,
        List<BlockProbe> blocks
    ) {
        static ColumnProbe capture(BlockView world, int x, int z, int referenceY) {
            int scanUp = WorldGridPerception.DEFAULT_SURFACE_SCAN_UP;
            int scanDown = WorldGridPerception.DEFAULT_SURFACE_SCAN_DOWN;
            WorldGridPerception perception = new WorldGridPerception(world, referenceY, x, x, z, z, scanUp, scanDown);
            Integer surface = TerrainProbe.surfaceOrNull(perception, new GridCell(x, z));
            List<BlockProbe> blocks = new ArrayList<>();
            for (int y = referenceY - 10; y <= referenceY + 5; y++) {
                blocks.add(BlockProbe.capture(world, x, y, z));
            }
            return new ColumnProbe(
                x,
                z,
                referenceY,
                scanUp,
                scanDown,
                referenceY - scanDown,
                referenceY + scanUp,
                surface,
                surface == null ? "none_standable_in_scan_window" : standabilityReason(world, x, surface, z),
                List.copyOf(blocks)
            );
        }

        private static String standabilityReason(BlockView world, int x, int feetY, int z) {
            boolean floorSolid = TerrainProbe.hasCollision(world, x, feetY - 1, z);
            boolean feetSolid = TerrainProbe.hasCollision(world, x, feetY, z);
            boolean headSolid = TerrainProbe.hasCollision(world, x, feetY + 1, z);
            boolean hazard = TerrainProbe.hasHazard(world, x, feetY, z);
            return "floorSolid=" + floorSolid
                + ",feetSolid=" + feetSolid
                + ",headSolid=" + headSolid
                + ",hazard=" + hazard;
        }
    }

    private record BlockProbe(
        int y,
        String block,
        boolean collision,
        boolean hazard
    ) {
        static BlockProbe capture(BlockView world, int x, int y, int z) {
            BlockPos pos = new BlockPos(x, y, z);
            BlockState state = world.getBlockState(pos);
            return new BlockProbe(
                y,
                state.getBlock().toString(),
                !state.getCollisionShape(world, pos).isEmpty(),
                TerrainProbe.isHazard(state)
            );
        }
    }

    private record ClientSnapshot(
        String instanceId,
        long capturedAtMs,
        double x,
        double y,
        double z,
        float yaw,
        float pitch,
        boolean onGround,
        boolean touchingWater,
        float health,
        int inventoryLogCount,
        Map<String, Integer> inventoryLogsByItem,
        int inventoryPlankCount,
        Map<String, Integer> inventoryPlanksByItem,
        int inventoryStickCount,
        Map<String, Integer> inventorySticksByItem,
        int inventoryCraftingTableCount,
        Map<String, Integer> inventoryCraftingTablesByItem,
        int inventoryWoodenPickaxeCount,
        Map<String, Integer> inventoryWoodenPickaxesByItem,
        int inventoryCobblestoneCount,
        Map<String, Integer> inventoryCobblestoneByItem,
        int inventoryStonePickaxeCount,
        Map<String, Integer> inventoryStonePickaxesByItem,
        int inventoryStoneAxeCount,
        Map<String, Integer> inventoryStoneAxesByItem,
        int inventoryStoneSwordCount,
        Map<String, Integer> inventoryStoneSwordsByItem,
        int inventoryFurnaceCount,
        Map<String, Integer> inventoryFurnacesByItem,
        int inventoryCharcoalCount,
        Map<String, Integer> inventoryCharcoalByItem,
        int inventoryCoalCount,
        Map<String, Integer> inventoryCoalByItem,
        int inventoryRawIronCount,
        Map<String, Integer> inventoryRawIronByItem,
        int inventoryIronIngotCount,
        Map<String, Integer> inventoryIronIngotsByItem,
        int inventoryIronPickaxeCount,
        Map<String, Integer> inventoryIronPickaxesByItem,
        List<LogTarget> nearbyLogs,
        int age,
        boolean inputForward,
        boolean inputBack,
        boolean inputLeft,
        boolean inputRight,
        boolean inputJump,
        boolean inputSneak,
        float movementForward,
        float movementSideways,
        String activeNavigationCommandId,
        boolean navigationRouteComputed,
        int navigationRouteLength,
        int navigationWaypointIndex,
        Integer navigationWaypointX,
        Integer navigationWaypointZ,
        Double navigationWaypointDistance,
        TerrainProbe terrainProbe
    ) {
        static ClientSnapshot from(
            String instanceId,
            ClientPlayerEntity player,
            long nowMs,
            InputState input,
            String activeNavigationCommandId,
            boolean navigationRouteComputed,
            List<GridCell> activeNavigationWaypoints,
            int activeNavigationWaypointIndex,
            BlockView world,
            boolean includeTerrainColumns
        ) {
            GridCell waypoint = activeNavigationWaypoints != null
                && activeNavigationWaypointIndex >= 0
                && activeNavigationWaypointIndex < activeNavigationWaypoints.size()
                    ? activeNavigationWaypoints.get(activeNavigationWaypointIndex)
                    : null;
            Double waypointDistance = waypoint == null
                ? null
                : Math.hypot(PathFollower.center(waypoint.x()) - player.getX(), PathFollower.center(waypoint.z()) - player.getZ());
            InventoryCounter.InventoryLogSnapshot logInventory = InventoryCounter.countPlayerLogs(player);
            InventoryCounter.InventoryPlankSnapshot plankInventory = InventoryCounter.countPlayerPlanks(player);
            InventoryCounter.InventoryStickSnapshot stickInventory = InventoryCounter.countPlayerSticks(player);
            InventoryCounter.InventoryCraftingTableSnapshot tableInventory = InventoryCounter.countPlayerCraftingTables(player);
            InventoryCounter.InventoryWoodenPickaxeSnapshot woodenPickaxeInventory = InventoryCounter.countPlayerWoodenPickaxes(player);
            InventoryCounter.InventoryCobblestoneSnapshot cobblestoneInventory = InventoryCounter.countPlayerCobblestone(player);
            InventoryCounter.InventoryItemSnapshot stonePickaxeInventory = InventoryCounter.countPlayerItem(player, "stone_pickaxe");
            InventoryCounter.InventoryItemSnapshot stoneAxeInventory = InventoryCounter.countPlayerItem(player, "stone_axe");
            InventoryCounter.InventoryItemSnapshot stoneSwordInventory = InventoryCounter.countPlayerItem(player, "stone_sword");
            InventoryCounter.InventoryItemSnapshot furnaceInventory = InventoryCounter.countPlayerItem(player, "furnace");
            InventoryCounter.InventoryItemSnapshot charcoalInventory = InventoryCounter.countPlayerItem(player, "charcoal");
            InventoryCounter.InventoryItemSnapshot coalInventory = InventoryCounter.countPlayerItem(player, "coal");
            InventoryCounter.InventoryItemSnapshot rawIronInventory = InventoryCounter.countPlayerItem(player, "raw_iron");
            InventoryCounter.InventoryItemSnapshot ironIngotInventory = InventoryCounter.countPlayerItem(player, "iron_ingot");
            InventoryCounter.InventoryItemSnapshot ironPickaxeInventory = InventoryCounter.countPlayerItem(player, "iron_pickaxe");
            List<LogTarget> nearbyLogs = LogPerception.nearbyReachableLogs(
                world,
                player,
                LOG_SCAN_RADIUS,
                LOG_SCAN_DOWN,
                LOG_SCAN_UP,
                LOG_SCAN_LIMIT
            );
            return new ClientSnapshot(
                instanceId,
                nowMs,
                player.getX(),
                player.getY(),
                player.getZ(),
                player.getYaw(),
                player.getPitch(),
                player.isOnGround(),
                player.isTouchingWater(),
                player.getHealth(),
                logInventory.logCount(),
                logInventory.logsByItem(),
                plankInventory.plankCount(),
                plankInventory.planksByItem(),
                stickInventory.stickCount(),
                stickInventory.sticksByItem(),
                tableInventory.craftingTableCount(),
                tableInventory.craftingTablesByItem(),
                woodenPickaxeInventory.woodenPickaxeCount(),
                woodenPickaxeInventory.woodenPickaxesByItem(),
                cobblestoneInventory.cobblestoneCount(),
                cobblestoneInventory.cobblestoneByItem(),
                stonePickaxeInventory.itemCount(),
                stonePickaxeInventory.itemsByItem(),
                stoneAxeInventory.itemCount(),
                stoneAxeInventory.itemsByItem(),
                stoneSwordInventory.itemCount(),
                stoneSwordInventory.itemsByItem(),
                furnaceInventory.itemCount(),
                furnaceInventory.itemsByItem(),
                charcoalInventory.itemCount(),
                charcoalInventory.itemsByItem(),
                coalInventory.itemCount(),
                coalInventory.itemsByItem(),
                rawIronInventory.itemCount(),
                rawIronInventory.itemsByItem(),
                ironIngotInventory.itemCount(),
                ironIngotInventory.itemsByItem(),
                ironPickaxeInventory.itemCount(),
                ironPickaxeInventory.itemsByItem(),
                nearbyLogs,
                player.age,
                input.pressingForward(),
                input.pressingBack(),
                input.pressingLeft(),
                input.pressingRight(),
                input.jumping(),
                input.sneaking(),
                input.movementForward(),
                input.movementSideways(),
                activeNavigationCommandId == null ? "" : activeNavigationCommandId,
                navigationRouteComputed,
                activeNavigationWaypoints == null ? 0 : activeNavigationWaypoints.size(),
                activeNavigationWaypointIndex,
                waypoint == null ? null : waypoint.x(),
                waypoint == null ? null : waypoint.z(),
                waypointDistance,
                TerrainProbe.capture(world, player, activeNavigationWaypoints, activeNavigationWaypointIndex, includeTerrainColumns)
            );
        }
    }
}
