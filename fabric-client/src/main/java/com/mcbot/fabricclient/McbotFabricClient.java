package com.mcbot.fabricclient;

import com.google.gson.Gson;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.OptionalInt;
import java.util.Queue;
import java.util.Set;
import java.util.UUID;
import java.util.function.BiPredicate;
import java.util.function.Predicate;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.fabricmc.fabric.api.client.rendering.v1.WorldRenderContext;
import net.fabricmc.fabric.api.client.rendering.v1.WorldRenderEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.gui.Element;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.input.Input;
import net.minecraft.client.input.KeyboardInput;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.render.Camera;
import net.minecraft.client.render.RenderLayer;
import net.minecraft.client.render.VertexConsumer;
import net.minecraft.client.render.VertexConsumerProvider;
import net.minecraft.client.util.InputUtil;
import net.minecraft.client.util.math.MatrixStack;
import net.minecraft.block.BedBlock;
import net.minecraft.entity.Entity;
import net.minecraft.entity.passive.SheepEntity;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.mob.HostileEntity;
import net.minecraft.component.DataComponentTypes;
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
import org.joml.Matrix4f;
import org.lwjgl.glfw.GLFW;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class McbotFabricClient implements ClientModInitializer, ShellServices {
    private static final Logger LOGGER = LoggerFactory.getLogger("mcbot-fabric-client");
    private static final Gson GSON = new Gson();
    private static final long BRAIN_MIN_INTERVAL_MS = 100L;
    private static final long BRAIN_MAX_TTL_MS =
        resolveLong("mcbot.brainMaxTtlMs", "MCBOT_FABRIC_BRAIN_MAX_TTL_MS", 500L);
    private static final long BRAIN_HTTP_TIMEOUT_MS =
        resolveLong("mcbot.brainHttpTimeoutMs", "MCBOT_FABRIC_BRAIN_HTTP_TIMEOUT_MS", 10_000L);
    // 12 -> 9 deg/tick: at 12 the camera reads as robotic whips on block
    // re-targets; 9 with the proportional-decel easing lands soft and still clears a 90-degree
    // swing in ~half a second.
    private static final double LOOK_MAX_DEG_PER_TICK = 9.0D;
    private static final double NAV3D_FORWARD_YAW_TOLERANCE_DEG = 25.0D;
    private static final long NAV3D_DIG_AFTER_STUCK_MS = 1_200L;
    private static final long NAV3D_COLLECT_DROP_TIMEOUT_MS = 60_000L;
    private static final long NEARBY_IRON_DROP_TIMEOUT_MS = 30_000L;
    // Dev per-tick movement trace (MCBOT_FABRIC_NAV3D_TRACE=1): logs the applied InputState + velocity + onGround
    // every tick so the "bot does not move" failure can be diagnosed (is forward applied? is velocity produced?
    // does survival override?). Off by default -> zero overhead.
    private static final boolean NAV3D_TRACE = "1".equals(System.getenv("MCBOT_FABRIC_NAV3D_TRACE"));
    static final int NAVIGATION_PERCEPTION_MARGIN = 12;
    private static final int NAVIGATION_DIAGNOSTIC_MARGIN = 48;
    private static final int NAVIGATION_DIAGNOSTIC_SCAN_UP = 24;
    private static final int NAVIGATION_DIAGNOSTIC_SCAN_DOWN = 48;
    private static final int LOG_SCAN_RADIUS = 16;
    private static final int LOG_SCAN_DOWN = 16;
    private static final int LOG_SCAN_UP = 8;
    private static final int LOG_SCAN_LIMIT = 24;
    private static final int LOG_FALLBACK_SCAN_RADIUS = 32;
    private static final int LOG_FALLBACK_SCAN_DOWN = 32;
    private static final int LOG_FALLBACK_SCAN_UP = 16;
    private static final int LOG_FALLBACK_SCAN_LIMIT = 64;
    private static final int LOG_SEED_RAW_SCAN_MULTIPLIER = 8;
    private static final double BLOCK_LOOK_TOLERANCE_DEG = 7.0D;
    static final double WORKSTATION_PLACE_LOOK_TOLERANCE_DEG = 0.75D;
    static final double GATHER_ARRIVE_EPSILON = 0.65D;
    static final long GATHER_PICKUP_SETTLE_MS = 300L;
    static final long GATHER_COLLECT_TIMEOUT_MS = 8_000L;
    private static final long GATHER_ADJACENT_MOVE_STALL_MS = 2_500L;
    private static final long GATHER_ADJACENT_MOVE_LONG_ROUTE_STALL_MS = 8_000L;
    private static final int GATHER_ADJACENT_MOVE_LONG_ROUTE_MIN_LENGTH = 12;
    private static final double GATHER_ADJACENT_MOVE_LONG_ROUTE_MIN_DISTANCE = 6.0D;
    static final double GATHER_ADJACENT_MOVE_IMPROVEMENT = 0.05D;
    static final double GATHER_ADJACENT_MOVE_MOVEMENT = 0.05D;
    private static final int GATHER_ADJACENT_NAV_UNSTICK_JUMP_TICKS = 4;
    private static final double GATHER_ADJACENT_NAV_ARC_JUMP_DISTANCE = 3.0D;
    private static final double GATHER_ADJACENT_NAV_ARC_PROGRESS_TOLERANCE = 0.03D;
    private static final int GATHER_TREE_CONTINUATION_ROUTE_FALLBACK_DISTANCE_SQUARED = 64;
    private static final int GATHER_TREE_CONTINUATION_BREAK_DISTANCE_SQUARED = 16;
    private static final int GATHER_TREE_CONTINUATION_DIRECT_MAX_SURFACE_DELTA = 1;
    private static final int GATHER_TREE_TARGET_OUT_OF_REACH_REPOSITIONS = 2;
    private static final long GATHER_TREE_SEARCH_TIMEOUT_MS = 28_000L;
    private static final int GATHER_TREE_SEARCH_MAX_ROUTE_ATTEMPTS = 3;
    // R0b·3: on a barren/sparse spawn routeAttempts stays ~0 (no routable tree is ever found), so
    // relocation otherwise waits the full 28 s timeout (such spawns wasted 30+ min in live runs).
    // Relocate (march to new ground) after this many consecutive route-UNAVAILABLE scans
    // (~1/s gate) -- ~12 s. Conservative: the march is bounded (GATHER_SEARCH_RELOCATION_LIMIT) and
    // re-searches after each leg, so it just covers ground faster when nothing routable is here.
    private static final int GATHER_TREE_SEARCH_MAX_ROUTE_UNAVAILABLE = 12;
    private static final int GATHER_TREE_SEARCH_MAX_SURFACE_DROP = 6;
    private static final double GATHER_TREE_SEARCH_ARRIVE_EPSILON = 0.8D;
    private static final int GATHER_TREE_SEARCH_LOG_SCAN_RADIUS = 48;
    private static final int GATHER_TREE_SEARCH_LOG_SCAN_DOWN = 24;
    private static final int GATHER_TREE_SEARCH_LOG_SCAN_UP = 16;
    private static final int GATHER_TREE_SEARCH_LOG_SCAN_LIMIT = 16;
    private static final int GATHER_TREE_SEARCH_LOG_RAW_SCAN_MULTIPLIER = 8;
    private static final int GATHER_TREE_SEARCH_LOG_APPROACH_RADIUS = 8;
    private static final int GATHER_TREE_SEARCH_LOCAL_FRONTIER_RADIUS = 12;
    private static final int GATHER_TREE_SEARCH_LOCAL_FRONTIER_MIN_DISTANCE = 4;
    private static final int GATHER_TREE_SEARCH_RELAXED_LOCAL_FRONTIER_MIN_DISTANCE = 2;
    private static final long GATHER_TREE_SEARCH_ROUTE_RETRY_MS = 1_000L;
    // PERF: brief memo window for the reachability-filtered next-target selection. Re-selection can
    // run on consecutive ticks (collect-rejection paths reset the current target each tick), and every
    // pass rebuilds a WorldGridPerception + grid route per remaining cluster log ON THE RENDER THREAD.
    // Inputs identical within the window are deterministic, so reuse only skips redundant work.
    private static final long GATHER_TREE_TARGET_SELECTION_CACHE_MS = 300L;
    private static final long GATHER_TREE_SEARCH_MEMORY_MS = 180_000L;
    private static final int GATHER_TREE_SEARCH_VISITED_RADIUS = 4;
    private static final int GATHER_TREE_SEARCH_RELAXED_VISITED_RADIUS = 1;
    private static final int GATHER_TREE_PARTIAL_EXHAUSTION_RETRIES = 1;
    private static final int GATHER_TREE_PARTIAL_EXHAUSTION_LOG_TARGET = 14;
    private static final int[][] GATHER_TREE_SEARCH_LOG_APPROACH_DIRECTIONS = new int[][] {
        {1, 0}, {-1, 0}, {0, 1}, {0, -1},
        {1, 1}, {-1, 1}, {1, -1}, {-1, -1}
    };
    // March-relocation (fast-surrender fix): bounded-search exhaustion on missions marches 3 legs
    // of ~20 blocks in one compass direction (rotating per relocation), then re-searches; 3
    // relocations max before honest exhaustion. Mirrors the iron relocate-and-redescend budget.
    private static final int GATHER_SEARCH_RELOCATION_LIMIT = 3;
    private static final int GATHER_SEARCH_MARCH_LEGS = 3;
    // Pit-strand detection (nav-stuck pass): the bot is stranded in a pit/ravine when a bounded lateral
    // search keeps failing while it sits >= GATHER_PIT_ESCAPE_MIN_DEPTH below the surrounding ground
    // surface (median ring heightmap, robust to the odd tall tree). Telemetry-only for now; the pillar-up
    // escape lands as a follow-up once this signal is confirmed live.
    private static final int GATHER_PIT_ESCAPE_SCAN_RADIUS = 4;
    private static final int GATHER_PIT_ESCAPE_MIN_DEPTH = 6;
    // #1 canopy break (nav-stuck pass): break the leaf blocking a step-up destination head for at most this
    // long per leaf, then give up (fall through to the normal re-aim/abandon flow) so a stuck break can't pin.
    private static final long CANOPY_BREAK_TIMEOUT_MS = 4_000L;
    private static final int[][] GATHER_SEARCH_MARCH_DIRECTIONS = new int[][] {
        {0, -20}, {20, 0}, {0, 20}, {-20, 0}
    };
    private static final int[][] GATHER_TREE_SEARCH_OFFSETS = new int[][] {
        {24, 0}, {-24, 0}, {0, 24}, {0, -24},
        {17, 17}, {-17, 17}, {17, -17}, {-17, -17}
    };
    private static final double DIRECT_COLLECT_FALLBACK_DISTANCE = 3.5D;
    private static final double DIRECT_COLLECT_ARRIVE_DISTANCE = 0.35D;
    private static final double DIRECT_COLLECT_VERTICAL_DROP_APPROACH_Y_DELTA = 1.0D;
    private static final double DIRECT_COLLECT_VERTICAL_DROP_MAX_DIRECT_Y_DELTA = 1.25D;
    private static final double DIRECT_COLLECT_VERTICAL_DROP_MIN_HORIZONTAL = 0.15D;
    private static final double DIRECT_COLLECT_UPWARD_JUMP_Y_DELTA = 0.45D;
    private static final long COLLECT_TARGET_LOG_INTERVAL_MS = 1_000L;
    private static final long DIRECT_COLLECT_LOG_INTERVAL_MS = 1_000L;
    private static final long BREAK_PROGRESS_LOG_INTERVAL_MS = 1_000L;
    private static final double GATHER_LOG_DIRECT_COLLECT_DISTANCE = 4.5D;
    private static final double GATHER_LOG_DIRECT_COLLECT_MAX_Y_DELTA = 4.0D;
    private static final double GATHER_TREE_DIRECT_COLLECT_DISTANCE = 3.5D;
    private static final double GATHER_TREE_DIRECT_COLLECT_MAX_Y_DELTA = DIRECT_COLLECT_VERTICAL_DROP_MAX_DIRECT_Y_DELTA;
    private static final double GATHER_TREE_ROW_DRIFT_DIRECT_COLLECT_DISTANCE = 6.0D;
    private static final double GATHER_TREE_ROW_DRIFT_TARGET_DISTANCE = 6.0D;
    private static final double GATHER_TREE_DIRECT_COLLECT_ARRIVE_DISTANCE = 0.35D;
    private static final double GATHER_TREE_SIDE_COLLECT_FIRST_Y_DELTA = DIRECT_COLLECT_VERTICAL_DROP_APPROACH_Y_DELTA;
    private static final int GATHER_TREE_ROW_SIDE_COLLECT_MIN_COMPLETED = 4;
    private static final double GATHER_TREE_ROW_SIDE_COLLECT_FIRST_DISTANCE = 1.5D;
    private static final double GATHER_TREE_ROW_COLLECT_DISTANCE = 3.5D;
    private static final double GATHER_TREE_ROW_COLLECT_ARRIVE_DISTANCE = 0.35D;
    private static final double GATHER_TREE_COLLECT_CELL_PICKUP_DISTANCE = 1.8D;
    private static final int GATHER_TREE_SIDE_COLLECT_UNROUTED_DISTANCE_SQUARED = 64;
    private static final long GATHER_TREE_COLLECT_NO_PROGRESS_MS = 2_500L;
    private static final double GATHER_TREE_COLLECT_PROGRESS_EPSILON = 0.08D;
    // FPS: gatherTreeSideCollectIntent (a 3x3 grid + per-cell A* on the RENDER thread) was ungated and
    // ran every tick while a drop was pending -- a top <1-FPS culprit (GPU idle at 5%, main thread
    // starved). Recompute the side-collect cell at most this often for a given drop; reuse between
    // (the bot is just walking to the same cell). Mirrors the proven 750ms nearby-stone-scan gate.
    private static final long GATHER_TREE_SIDE_COLLECT_SCAN_INTERVAL_MS = 200L;
    // R0b·2: abandon a dropped log after this many consecutive side-collect SELECTIONS that make no
    // progress (live runs churned 420-738). Conservative — any progress (pickup
    // or getting > epsilon closer) resets the streak inside SideCollectStallTracker, so a slow-but-
    // advancing approach is never abandoned (the over-abandonment regression guard).
    private static final int GATHER_TREE_SIDE_COLLECT_CHURN_STREAK = 48;
    private static final double DIRECT_COLLECT_UPWARD_FALLBACK_MAX_DISTANCE = 1.25D;
    private static final double GATHER_DROPPED_LOG_SEARCH_RADIUS = 6.0D;
    private static final double GATHER_DROPPED_LOG_SEARCH_Y = 8.0D;
    private static final int GATHER_TREE_CLUSTER_RADIUS = 8;
    private static final int GATHER_TREE_CLUSTER_LIMIT = 32;
    private static final int GATHER_TREE_MAX_BROKEN_LOGS = 24;
    static final int PLAYER_CRAFTING_RESULT_SLOT = 0;
    static final int PLAYER_CRAFTING_INPUT_START = 1;
    static final int PLAYER_CRAFTING_INPUT_END = 5;
    static final int PLAYER_INVENTORY_SCREEN_START = 9;
    static final int PLAYER_HOTBAR_SCREEN_END = 45;
    private static final int TABLE_CRAFTING_RESULT_SLOT = 0;
    private static final int TABLE_CRAFTING_INPUT_START = 1;
    private static final int TABLE_CRAFTING_INPUT_END = 10;
    static final double TABLE_INTERACTION_REACH_BLOCKS = 4.8D;
    static final long CRAFT_CLICK_SETTLE_MS = 150L;
    private static final long CRAFT_TABLE_OPEN_RETRY_MS = 750L;
    private static final int CRAFT_TABLE_OPEN_MAX_ATTEMPTS = 4;
    static final long CRAFT_RESULT_WAIT_MS = 2_000L;
    static final long CRAFT_VERIFY_WAIT_MS = 2_000L;
    static final long CRAFT_TOTAL_TIMEOUT_MS = 8_000L;
    private static final long WORKSTATION_CONTAINER_TRANSITION_SETTLE_MS = 300L;
    private static final long R5_CONTAINER_TRANSITION_SETTLE_MS = 300L;
    private static final long FURNACE_SMELT_TOTAL_TIMEOUT_MS = 90_000L;
    private static final long FURNACE_OUTPUT_WAIT_MS = 30_000L;
    private static final long MAKE_CHARCOAL_TOTAL_TIMEOUT_MS = 140_000L;
    private static final int DESCENT_MAX_DEPTH = (int) resolveLong("mcbot.r2MaxDepth", "MCBOT_FABRIC_R2_MAX_DEPTH", 20L);
    private static final int DESCENT_DEEP_MAX_DEPTH = (int) resolveLong("mcbot.deepMaxDepth", "MCBOT_FABRIC_DEEP_MAX_DEPTH", 128L);
    private static final long DESCENT_STEP_TIMEOUT_MS = 12_000L;
    private static final long DESCENT_BASE_TIMEOUT_MS = 15_000L;
    private static final long DESCENT_MOVE_STALL_MS = 2_500L;
    private static final double DESCENT_STEP_ARRIVE_EPSILON = 0.42D;
    private static final double DESCENT_MOVE_YAW_TOLERANCE_DEG = 24.0D;
    private static final double DESCENT_MOVE_PROGRESS_EPSILON = 0.05D;
    private static final int DESCENT_OVERSHOT_RESYNC_MAX_DROP = 3;
    private static final double DESCENT_OVERSHOT_RESYNC_MAX_HORIZONTAL_DRIFT = 2.25D;
    private static final int DESCENT_MAX_REROUTES = 12;
    // Max cobblestone-bridge placements per descent command (caps cobble spend + guards against a
    // pathological place->re-evaluate loop). Scaled up to the run depth like the reroute budget.
    private static final int DESCENT_MAX_SUPPORT_BRIDGES = 8;
    // How long to sneak-shuffle toward a gap edge trying to clear the line of sight to the bridge
    // foundation before giving up and rerouting (the bot's own step occludes a steep downward view).
    private static final long DESCENT_BRIDGE_NUDGE_TIMEOUT_MS = 2_500L;
    private static final double DESCENT_HOSTILE_ABORT_RADIUS = 8.0D;
    private static final int DESCENT_MAX_IRON_CLEANUP_BLOCKS = 12;
    private static final int DESCENT_IRON_CLEANUP_BOOTSTRAP_UNITS = 3;
    // Missions need ~27 iron units (24 armor ingots + 3 pickaxe), so descent legs keep grabbing
    // visible iron until that bank is full — early runs had the bot walk past deepslate iron
    // because the 3-unit bootstrap cap (pickaxe-era design; an equipped iron pickaxe alone counts as
    // 3) declared cleanup satisfied. Non-mission/harness commands keep the bootstrap semantics. The
    // per-descent 12-block budget still bounds each leg's detour.
    private static final int DESCENT_IRON_CLEANUP_MISSION_UNITS = 27;

    static int descentIronCleanupTargetUnits(boolean missionCommand) {
        return missionCommand ? DESCENT_IRON_CLEANUP_MISSION_UNITS : DESCENT_IRON_CLEANUP_BOOTSTRAP_UNITS;
    }
    private static final long DESCENT_IRON_CLEANUP_COLLECT_TIMEOUT_MS = 2_500L;
    private static final int NEARBY_STONE_TARGET_COBBLESTONE = 5;
    private static final int NEARBY_STONE_PROBE_RADIUS = 2;
    private static final int NEARBY_STONE_PROBE_MAX_DEPTH = 6;
    private static final int NEARBY_STONE_PROBE_MAX_BLOCKS = 24;
    private static final int NEARBY_STONE_PROBE_MAX_BLOCKS_PER_COLUMN = 6;
    private static final int NEARBY_STONE_PROBE_BREAK_FAILURE_DESCENT_THRESHOLD = 2;
    private static final long NEARBY_STONE_PROBE_BREAK_TIMEOUT_MS = 6_000L;
    private static final long NEARBY_STONE_SOURCE_BREAK_TIMEOUT_MS = 8_000L;
    private static final int NEARBY_STONE_EXPOSED_SCAN_RADIUS = 20;
    private static final int NEARBY_STONE_EXPOSED_SCAN_DOWN = 8;
    private static final int NEARBY_STONE_EXPOSED_SCAN_UP = 12;
    private static final int NEARBY_STONE_EXPOSED_SCAN_LIMIT = 48;
    // PERF: the exposed-stone fallback scans a 41x41 column volume plus up to 48 candidate grid routes;
    // running that every tick while no stone target is selected stalls the render thread. The scan only
    // exists to escape a stall, so a sub-second cadence loses nothing.
    private static final long NEARBY_STONE_EXPOSED_SCAN_INTERVAL_MS = 750L;
    private static final int NEARBY_STONE_EXPOSED_MAX_ROUTE_LENGTH = 8;
    private static final int NEARBY_STONE_EXPOSED_MAX_APPROACH_STALLS = 2;
    private static final int NEARBY_STONE_DESCENT_FALLBACK_PROBE_THRESHOLD = 8;
    private static final int NEARBY_STONE_DESCENT_FALLBACK_MAX = 1;
    private static final double MINE_NEARBY_STONE_DIRECT_COLLECT_DISTANCE = 1.25D;
    private static final long NEARBY_STONE_TIMEOUT_MS = 60_000L;
    private static final int NEARBY_IRON_TARGET_RAW_IRON = 3;
    private static final int NEARBY_IRON_MAX_TARGET_RAW_IRON = 8;
    private static final long NEARBY_IRON_TIMEOUT_MS = 150_000L;
    private static final int NEARBY_IRON_MAX_PROSPECT_BLOCKS = 64;
    private static final int NEARBY_IRON_MAX_TOOL_RECOVERY_ATTEMPTS = 4;
    private static final int NEARBY_IRON_PICKAXE_RESTOCK_REMAINING = 32;
    private static final int NEARBY_DIAMOND_TARGET_DIAMONDS = 3;
    private static final long NEARBY_DIAMOND_TIMEOUT_MS = 180_000L;
    private static final int NEARBY_DIAMOND_MAX_PROSPECT_BLOCKS = 80;
    private static final int NEARBY_DIAMOND_MIN_LAST_IRON_PICKAXE_REMAINING = 64;
    private static final long RETURN_STAIRCASE_TIMEOUT_MS = 35_000L;
    private static final long RETURN_STAIRCASE_STEP_TIMEOUT_MS = 3_500L;
    private static final long RETURN_STAIRCASE_WAYPOINT_STUCK_MS = 10_000L;
    private static final double RETURN_STAIRCASE_JUMP_DISTANCE_BLOCKS = 0.92D;
    private static final double RETURN_STAIRCASE_STEP_UP_DISTANCE_BLOCKS = 2.25D;
    private static final double RETURN_STAIRCASE_PILLAR_DISTANCE_BLOCKS = 4.0D;
    private static final int RETURN_STAIRCASE_PILLAR_MAX_VERTICAL_GAP = 6;
    private static final long R2_MINE_STONE_RETURN_TIMEOUT_MS = 180_000L;
    private static final long R5_IRON_CHAIN_TIMEOUT_MS = 660_000L;
    private static final long R5_IRON_CHAIN_FIXTURE_SETTLE_MS = 750L;
    private static final int MISSION_EAT_COMPLETE_FOOD_LEVEL = 7;

    private final String instanceId = resolveInstanceId();
    private final URI brainUri = URI.create(resolveBrainUrl());
    private final boolean autoSingleplayer = resolveBoolean("mcbot.autoSingleplayer", "MCBOT_FABRIC_AUTO_SINGLEPLAYER");
    private final boolean autoCreateNewWorld = resolveBoolean("mcbot.createNewWorld", "MCBOT_FABRIC_CREATE_NEW_WORLD");
    private final boolean autoRespawn = resolveBoolean("mcbot.autoRespawn", "MCBOT_FABRIC_AUTO_RESPAWN");
    private final boolean terrainColumnProbe = resolveBoolean("mcbot.terrainColumnProbe", "MCBOT_FABRIC_TERRAIN_COLUMN_PROBE");
    private final boolean prospectStrategyEnabled =
        resolveBoolean("mcbot.prospectStrategy", "MCBOT_FABRIC_PROSPECT_STRATEGY");
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
    private boolean activeNavigationSuppliedRoute = false;
    private Set<Integer> activeNavigationJumpWaypointIndexes = Set.of();
    // R0 (escalation reflex), navigation arm: a skipped jump waypoint is re-aimed every tick; if the
    // bot physically cannot reach it the retry spins forever (~70 s until the watchdog).
    // After NAVIGATION_JUMP_RETRY_ABANDON_STREAK consecutive re-aims at the SAME waypoint, give up on
    // it and let the follower proceed forward (the natural command already advanced past it).
    private final FailureStreak navigationJumpRetryStreak = new FailureStreak();
    private String abandonedJumpWaypointKey = "";
    private static final int NAVIGATION_JUMP_RETRY_ABANDON_STREAK = 40;
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
    private final ArmorController armorController = new ArmorController(instanceId);
    private final BlockPlaceController blockPlaceController = new BlockPlaceController();
    // Strangler seam (PR-0): registry of objectives lifted out of this god class, plus a reused
    // per-tick context. tickContext is reset() once per onClientTick before resolveControl; it is
    // never allocated per tick (20Hz hot loop). The registry is consulted at the top of
    // resolveControl — empty in PR-0, so all dispatch still flows through the unchanged chain.
    private final ObjectiveRegistry objectiveRegistry = new ObjectiveRegistry();
    private final TickContext tickContext = new TickContext(this);
    private final MineStoneExecutor mineStoneExecutor = new MineStoneExecutor(this);
    private final RetrieveTableExecutor retrieveTableExecutor = new RetrieveTableExecutor(this);
    private final UseBedExecutor useBedExecutor = new UseBedExecutor(this);
    private final Craft2x2Executor craft2x2Executor = new Craft2x2Executor(this);
    private final HuntSheepExecutor huntSheepExecutor = new HuntSheepExecutor(this);
    private final GatherLogExecutor gatherLogExecutor = new GatherLogExecutor(this);
    private final PlaceWorkstationExecutor placeWorkstationExecutor = new PlaceWorkstationExecutor(this);
    private String lastBlockBreakLogKey = "";
    private String lastGatherCollectItemLogKey = "";
    private GatherTreeRun activeGatherTree = null;
    private GatherTreeSearchRun activeGatherTreeSearch = null;
    private final Set<GridCell> recentGatherTreeSearchGoals = new HashSet<>();
    private long recentGatherTreeSearchUpdatedAtMs = 0L;
    private final Set<GridCell> ignoredGatherTreeColumns = new HashSet<>();
    private final Set<GridCell> attemptedGatherTreeIgnoredSeedSalvageColumns = new HashSet<>();
    private DescentRun activeDescent = null;
    private MineNearbyStoneRun activeMineNearbyStone = null;
    private MineNearbyIronRun activeMineNearbyIron = null;
    private MineNearbyIronRun activeMineNearbyDiamond = null;
    private MineNearbyIronRun activeMineNearbyCoal = null;
    private ReturnStaircaseRun activeReturnStaircase = null;
    private R2MineStoneReturnRun activeR2MineStoneReturn = null;
    private R5IronChainRun activeR5IronChain = null;
    private Craft3x3Run activeCraft3x3 = null;
    private SmeltCharcoalRun activeSmeltCharcoal = null;
    private MakeCharcoalRun activeMakeCharcoal = null;
    private long workstationContainerTransitionSettleUntilMs = 0L;
    private long lastWorkstationContainerTransitionSettleLogAtMs = 0L;
    private String workstationContainerTransitionReason = "";
    private final Set<String> completedGatherTreeCommandIds = new HashSet<>();
    private final Map<String, String> finishedGatherTreeCommandReasons = new HashMap<>();
    private final Map<String, String> finishedDescentCommandReasons = new HashMap<>();
    private final Map<String, List<BlockPos>> completedDescentPaths = new HashMap<>();
    // Wood-need-at-depth (tool_unavailable:pickaxe_required x738) usually means the
    // pickaxes are DEAD, so a digging ascend cannot work — but the staircase the bot walked down
    // still exists. Mission return commands (fresh ids, no per-command breadcrumbs) fall back to
    // the latest completed descent's trail: walking back up needs zero tools.
    private List<BlockPos> lastCompletedDescentPath = List.of();
    private final Map<String, String> finishedMineNearbyStoneCommandReasons = new HashMap<>();
    private final Map<String, String> finishedMineNearbyIronCommandReasons = new HashMap<>();
    private final Map<String, String> finishedMineNearbyDiamondCommandReasons = new HashMap<>();
    private final Map<String, String> finishedMineNearbyCoalCommandReasons = new HashMap<>();
    private final Map<String, String> finishedReturnStaircaseCommandReasons = new HashMap<>();
    private final Map<String, String> finishedR2MineStoneReturnCommandReasons = new HashMap<>();
    private final Map<String, String> finishedR5IronChainCommandReasons = new HashMap<>();
    private final Set<String> completedBreakBlockCommandIds = new HashSet<>();
    private final Set<String> completedCraft3x3CommandIds = new HashSet<>();
    private final Map<String, String> finishedCraft3x3CommandReasons = new HashMap<>();
    private final Set<String> completedSmeltCharcoalCommandIds = new HashSet<>();
    private final Map<String, String> finishedSmeltCommandReasons = new HashMap<>();
    private final Set<String> completedMakeCharcoalCommandIds = new HashSet<>();
    private final Map<String, String> finishedMakeCharcoalCommandReasons = new HashMap<>();
    private final Map<String, String> finishedEquipArmorCommandReasons = new HashMap<>();
    private final Map<String, String> finishedEatCommandReasons = new HashMap<>();

    // Observability cockpit (additive; read by the HUD render callback on the same client thread).
    // controlEnabled is the master Toggle-Bot: default ON so autonomous/harness runs are unaffected.
    private boolean controlEnabled = true;
    private boolean cockpitHudEnabled = true;
    private BrainLink.Diagnostics hudDiagnostics;
    private BrainLink.Intent hudEffective;
    private String hudLastControlReason = "";
    private String hudActiveLayer = "idle";
    private boolean pathOverlayEnabled = false;
    private long nextRawRightProbeLogMs = 0L;
    private long lastEdgeGuardLogAtMs = 0L;
    private long lastStepUpSuppressLogAtMs = 0L;
    private BlockPos canopyBreakTarget = null;
    private long canopyBreakStartedAtMs = 0L;
    private int gatherSearchRelocations = 0;
    private int gatherSearchDescendRelocations = 0;
    private int gatherSearchMarchLegsRemaining = 0;
    private int[] gatherSearchMarchDirection = null;
    private long lastScreenCloseGuardLogMs = 0L;
    private final Map<GridCell, Long> vetoedEdgeCells = new HashMap<>();
    private final FailureStreak edgeVetoStreak = new FailureStreak();
    private boolean hasAcceptedLook = false;
    private String acceptedLookCommandId = "";
    private double acceptedLookYaw = 0.0D;
    private double acceptedLookPitch = 0.0D;
    private long lastLookSwapAtMs = 0L;
    private CockpitLayout cockpitLayout;
    private KeyBinding toggleBotKey;
    private KeyBinding toggleHudKey;
    private KeyBinding togglePathKey;
    private KeyBinding openEditorKey;

    @Override
    public void onInitializeClient() {
        // Register lifted objective executors before the tick loop starts. Only MineStone is lifted
        // so far; every other action falls through to the unchanged resolveControl chain.
        objectiveRegistry.register(mineStoneExecutor);
        objectiveRegistry.register(retrieveTableExecutor);
        objectiveRegistry.register(useBedExecutor);
        objectiveRegistry.register(craft2x2Executor);
        objectiveRegistry.register(huntSheepExecutor);
        objectiveRegistry.register(gatherLogExecutor);
        objectiveRegistry.register(placeWorkstationExecutor);
        LOGGER.info("MCBot Fabric spike loaded. instanceId={} brainUrl={}", instanceId, brainUri);
        LOGGER.info("IPC protocol invariant: first request line is instanceId:{}", instanceId);
        cockpitLayout = CockpitLayout.load(cockpitConfigPath());
        ClientTickEvents.END_CLIENT_TICK.register(this::onClientTick);
        ClientLifecycleEvents.CLIENT_STOPPING.register((client) -> {
            brainLink.shutdown();
            LOGGER.info("MCBot Fabric spike stopped. instanceId={}", instanceId);
        });
        // Observability cockpit: hotkeys (UNBOUND by default — bind them in vanilla Controls)
        // + the status HUD. Purely additive; the HUD render is fail-safe (see renderCockpitHud).
        toggleBotKey = KeyBindingHelper.registerKeyBinding(new KeyBinding(
            "key.mcbot.toggle_bot", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_UNKNOWN, "category.mcbot"));
        toggleHudKey = KeyBindingHelper.registerKeyBinding(new KeyBinding(
            "key.mcbot.toggle_hud", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_UNKNOWN, "category.mcbot"));
        togglePathKey = KeyBindingHelper.registerKeyBinding(new KeyBinding(
            "key.mcbot.toggle_path", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_UNKNOWN, "category.mcbot"));
        openEditorKey = KeyBindingHelper.registerKeyBinding(new KeyBinding(
            "key.mcbot.open_editor", InputUtil.Type.KEYSYM, GLFW.GLFW_KEY_UNKNOWN, "category.mcbot"));
        // Boot-time observability for a dead path-overlay key: log what each
        // cockpit binding actually resolved to (a silently-unbound binding shows up here instantly).
        ClientTickEvents.END_CLIENT_TICK.register(new net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents.EndTick() {
            private boolean logged = false;

            @Override
            public void onEndTick(MinecraftClient client) {
                if (logged || client == null) {
                    return;
                }
                logged = true;
                LOGGER.info(
                    "cockpit.keybinds_resolved instanceId={} bot={} hud={} path={} editor={}",
                    instanceId,
                    toggleBotKey.getBoundKeyLocalizedText().getString(),
                    toggleHudKey.getBoundKeyLocalizedText().getString(),
                    togglePathKey.getBoundKeyLocalizedText().getString(),
                    openEditorKey.getBoundKeyLocalizedText().getString()
                );
            }
        });
        HudRenderCallback.EVENT.register((drawContext, tickCounter) -> renderCockpitHud(drawContext));
        WorldRenderEvents.AFTER_TRANSLUCENT.register(this::renderPathOverlay);
    }

    // PERF: the snapshot's reachable-logs scan (16-radius sweep + a route probe per found log) is the
    // dominant cost of a dispatch tick. The brain only needs it fresh enough for objective selection,
    // so reuse the last result briefly and re-scan when the player has actually moved.
    private static final long SNAPSHOT_LOG_SCAN_CACHE_MS = 2_000L;
    // 8 blocks: at walking speed (~4.3 blocks/s) a 4-block tolerance invalidated on nearly every
    // ~1/s dispatch while traveling, so the cache never engaged exactly when the scan is least
    // useful (mid-travel). Half the 16-block scan radius keeps the staleness immaterial.
    private static final double SNAPSHOT_LOG_SCAN_CACHE_MOVE_SQ = 64.0D; // 8 blocks
    private List<LogTarget> snapshotLogsCache = List.of();
    private long snapshotLogsCacheAtMs = 0L;
    private BlockPos snapshotLogsCachePos = null;

    private List<LogTarget> snapshotNearbyLogsCached(MinecraftClient client, ClientPlayerEntity player, long nowMs) {
        BlockPos pos = player.getBlockPos();
        if (snapshotLogsCachePos != null
            && nowMs - snapshotLogsCacheAtMs < SNAPSHOT_LOG_SCAN_CACHE_MS
            && snapshotLogsCachePos.getSquaredDistance(pos) <= SNAPSHOT_LOG_SCAN_CACHE_MOVE_SQ) {
            return snapshotLogsCache;
        }
        List<LogTarget> scanned = LogPerception.nearbyReachableLogs(
            client.world,
            player,
            LOG_SCAN_RADIUS,
            LOG_SCAN_DOWN,
            LOG_SCAN_UP,
            LOG_SCAN_LIMIT
        );
        // A wild-world run looped (119 commands in 113 s): the snapshot kept advertising a log whose column the
        // zero-cluster guard had ignored, so the orchestrator re-hinted it every command. Ignored
        // columns never re-enter the snapshot — the loop is cut at the source.
        if (!ignoredGatherTreeColumns.isEmpty() && !scanned.isEmpty()) {
            List<LogTarget> filtered = new ArrayList<>(scanned.size());
            for (LogTarget logTarget : scanned) {
                if (!ignoredGatherTreeColumns.contains(new GridCell(logTarget.x(), logTarget.z()))) {
                    filtered.add(logTarget);
                }
            }
            scanned = filtered;
        }
        snapshotLogsCache = scanned;
        snapshotLogsCacheAtMs = nowMs;
        snapshotLogsCachePos = pos.toImmutable();
        return snapshotLogsCache;
    }

    // ----- ShellServices accessors (PR-0 seam) -----
    // These expose shell-owned state to extracted ObjectiveExecutors. Visibility-only / thin
    // accessors; no behavior change.
    @Override
    public Logger logger() {
        return LOGGER;
    }

    @Override
    public String instanceId() {
        return instanceId;
    }

    @Override
    public BlockBreakController blockBreakController() {
        return blockBreakController;
    }

    @Override
    public BlockPlaceController blockPlaceController() {
        return blockPlaceController;
    }

    @Override
    public void completeCurrentCommand(String commandId, String reason, long nowMs) {
        brainLink.completeCurrentCommand(commandId, reason, nowMs);
    }

    private void onClientTick(MinecraftClient client) {
        long tickStartNs = System.nanoTime();
        long nowMs = System.currentTimeMillis();
        ClientPlayerEntity player = client.player;
        if (player == null || client.world == null) {
            maybeDriveAutoSingleplayerMenu(client, nowMs);
            return;
        }

        // Cockpit hotkeys are polled BEFORE the singleplayer/death early-returns: the HUD/path overlay
        // (and the bot itself) must be toggleable while watching a Paper-server session
        // too — previously the !isInSingleplayer() return above this made every cockpit key dead on the
        // local server.
        pollCockpitKeybinds();

        // Harness runs never need the real cursor (camera and clicks are programmatic) — vanilla
        // re-grabs the system pointer at launch and after every screen close, yanking the
        // mouse while you work in other windows. With MCBOT_NO_CURSOR_GRAB=1 (set by
        // live-gather-log.ps1) any grab is undone the same tick.
        // V1: only release the pointer while the bot is DRIVING (controlEnabled) -- it steers via
        // programmatic yaw/pitch and doesn't need the cursor, so releasing it keeps the
        // mouse free for other windows. When toggled OFF for manual control, leave the grab alone so
        // you get normal mouse-look (the toggle-off path re-locks it; see restoreManualInput).
        SUPPRESS_CURSOR_GRAB = NO_CURSOR_GRAB && controlEnabled;
        if (NO_CURSOR_GRAB && controlEnabled && client.mouse != null && client.mouse.isCursorLocked()) {
            client.mouse.unlockCursor();
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

        // Cockpit master toggle: when the bot is toggled OFF, hand input BACK to the player (restore
        // vanilla KeyboardInput) and skip the brain poll + control so it can't drift the mission state.
        // The bot's Input is (re)installed only while running. Default ON.
        if (!controlEnabled) {
            restoreManualInput(player, client);
            hudActiveLayer = "stopped";
            return;
        }
        ensureControlledInput(player);

        // The command the client has been executing (from the last poll); whether it has finished lets
        // the brain reuse the same commandId while a multi-tick command runs and mint a fresh id only
        // once it is done.
        BrainLink.Intent priorIntent = brainLink.effectiveIntent(nowMs);
        boolean currentCommandCompleted = priorIntent != null && isCommandCompleted(priorIntent.commandId(), priorIntent.action());
        String currentCommandCompletionReason = currentCommandCompleted
            ? commandCompletionReason(priorIntent)
            : "";
        if (currentCommandCompleted && !"stop".equals(priorIntent.action())) {
            brainLink.completeCurrentCommand(priorIntent.commandId(), currentCommandCompletionReason, nowMs);
        }

        // Snapshot is built on the client thread; BrainLink dispatches the brain call
        // off-thread and never blocks this tick.
        // PERF: build + serialize ONLY on ticks where BrainLink will actually dispatch — poll()
        // discards the payload otherwise. ClientSnapshot.from runs a nearby-reachable-logs world
        // scan (plus inventory sweeps + JSON serialization); paying that every tick was the
        // dominant render-thread tax (sustained 80-340 ms ticks, worst in forests).
        String snapshotJson = null;
        if (brainLink.wouldDispatch(nowMs)) {
            ClientSnapshot snapshot = ClientSnapshot.from(
                instanceId,
                player,
                nowMs,
                currentInputState,
                activeNavigationCommandId,
                currentCommandCompleted,
                currentCommandCompletionReason,
                activeNavigationRouteComputed,
                activeNavigationWaypoints,
                activeNavigationWaypointIndex,
                client.world,
                terrainColumnProbe,
                snapshotNearbyLogsCached(client, player, nowMs)
            );
            snapshotJson = GSON.toJson(snapshot);
        }
        brainLink.poll(snapshotJson, nowMs);
        BrainLink.Intent effective = brainLink.effectiveIntent(nowMs);
        BrainLink.Diagnostics brainDiagnostics = brainLink.diagnostics(nowMs);
        hudDiagnostics = brainDiagnostics;
        hudEffective = effective;
        logTtlExpiry(effective, brainDiagnostics);
        applyServerCommands(client, effective);
        // R7 combat reflex: highest-priority fast-loop guard. Threat response (engage/flee/logout)
        // preempts everything else — the bot fights or bails before it eats or runs its normal task.
        CombatController.Result combat = combatController.tick(client, player, nowMs);
        if (combat.active()) {
            currentInputState = combat.input();
            applyInputState(player.input, currentInputState);
            client.options.sprintKey.setPressed(false);
            hudActiveLayer = "combat";
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
            client.options.sprintKey.setPressed(false);
            traceNav3dTick(player, currentInputState, survival.reason(), true);
            hudActiveLayer = "survival";
            logBrainTiming(nowMs, tickStartNs, brainDiagnostics);
            return;
        }
        // Reuse the per-tick context for the objective registry (PR-0 scaffolding: reset every tick
        // before dispatch; the registry is empty in PR-0 so resolveControl behavior is unchanged).
        tickContext.reset(client, player, nowMs, effective);
        ControlDecision decision = resolveControl(client, player, effective, nowMs);
        currentInputState = decision.input();
        // GLOBAL edge-guard (a wild-world run died when a routed search leg walked into a natural
        // shaft mouth and fell 44 blocks — the per-path guard only covered direct fallbacks). Any
        // full-forward, on-ground, non-sneaking walk now gets the >3-drop lookahead as a final-line
        // reflex regardless of which code path drives it: staircase steps (1-drop) and water
        // landings remain allowed by the guard itself; sneak work (bridging overhang) is exempt.
        if (currentInputState.pressingForward()
            && !currentInputState.sneaking()
            && player.isOnGround()
            && !player.isTouchingWater()
            && !isStaircaseDrivenIntent(decision.intent())
            && edgeGuardBlocksForward(client, player, player.getYaw())) {
            currentInputState = InputState.stop();
            // Veto-FEEDBACK (live runs showed machinery retrying into the veto for up to 189
            // ticks): record the refused cells so route perception blocks them, and after a short
            // streak force the active route to recompute — it then paths around the edge, or fails
            // into the existing target_rejected_no_path / abandon flows.
            recordEdgeVeto(player, nowMs);
            String vetoCommandId = decision.intent().commandId() == null ? "" : decision.intent().commandId();
            int edgeVetoCount = edgeVetoStreak.record(vetoCommandId);
            if (edgeVetoCount % EDGE_VETO_REROUTE_STREAK == 0) {
                clearNavigationState();
                LOGGER.warn(
                    "navigation.edge_guard_feedback instanceId={} commandId={} streak={} vetoedCells={}",
                    instanceId,
                    vetoCommandId,
                    edgeVetoCount,
                    vetoedEdgeCells.size()
                );
            }
            // Channel 2 — LAST RESORT (an earlier regression at 10 ticks killed legitimate tree
            // approaches; 7 clusters found, 0 logs gathered). Only after ~3 s of continuous veto,
            // when rerouting demonstrably did not help, abandon the gather target so selection
            // replaces it.
            if (edgeVetoCount % EDGE_VETO_ABANDON_STREAK == 0
                && activeGatherTree != null
                && vetoCommandId.startsWith(activeGatherTree.commandId)) {
                if (activeGatherTree.currentTarget != null) {
                    activeGatherTree.abandonedTargets.add(activeGatherTree.currentTarget);
                    LOGGER.warn(
                        "navigation.edge_guard_abandon instanceId={} commandId={} target={} streak={}",
                        instanceId,
                        vetoCommandId,
                        activeGatherTree.currentTarget.toShortString(),
                        edgeVetoCount
                    );
                }
                resetGatherTreeCurrentTarget(activeGatherTree);
            }
            if (nowMs - lastEdgeGuardLogAtMs > 1_000L) {
                lastEdgeGuardLogAtMs = nowMs;
                LOGGER.warn(
                    "navigation.edge_guard_global instanceId={} commandId={} reason={} x={} y={} z={}",
                    instanceId,
                    decision.intent().commandId(),
                    decision.intent().reason(),
                    (int) Math.floor(player.getX()),
                    (int) Math.floor(player.getY()),
                    (int) Math.floor(player.getZ())
                );
            }
        } else {
            edgeVetoStreak.reset();
        }
        // Vanilla-parity fairness guard (early runs had the bot walking with a crafting GUI open —
        // impossible for a human, whose movement keys go to the GUI). Any movement intent while a
        // container screen is open closes the screen FIRST (what a human does: ESC, then walk) and
        // stands still for this tick. Craft/smelt flows are stationary while their screens are open,
        // so this only fires on the leaky transitions that forgot to close.
        if (inputWantsMovement(currentInputState)
            && client.currentScreen instanceof net.minecraft.client.gui.screen.ingame.HandledScreen) {
            player.closeHandledScreen();
            currentInputState = InputState.stop();
            if (nowMs - lastScreenCloseGuardLogMs > 1_000L) {
                lastScreenCloseGuardLogMs = nowMs;
                LOGGER.warn(
                    "fairness.screen_close_before_move instanceId={} commandId={} reason={}",
                    instanceId,
                    decision.intent().commandId(),
                    decision.intent().reason()
                );
            }
        }
        applyInputState(player.input, currentInputState);
        updateSprintKey(client, decision.intent().reason(), currentInputState);
        traceNav3dTick(player, currentInputState, decision.intent().reason(), false);
        hudActiveLayer = "control";
        hudLastControlReason = decision.intent().reason();
        logIntentTransition(decision.intent(), brainDiagnostics);
        applyLookControl(player, decision.intent(), nowMs);
        logBrainTiming(nowMs, tickStartNs, brainDiagnostics);
    }

    private void pollCockpitKeybinds() {
        if (toggleBotKey != null) {
            while (toggleBotKey.wasPressed()) {
                controlEnabled = !controlEnabled;
                LOGGER.info("cockpit.toggle_bot instanceId={} controlEnabled={}", instanceId, controlEnabled);
            }
        }
        if (toggleHudKey != null) {
            while (toggleHudKey.wasPressed()) {
                cockpitHudEnabled = !cockpitHudEnabled;
                LOGGER.info("cockpit.toggle_hud instanceId={} enabled={}", instanceId, cockpitHudEnabled);
            }
        }
        if (togglePathKey != null) {
            while (togglePathKey.wasPressed()) {
                pathOverlayEnabled = !pathOverlayEnabled;
                LOGGER.info("cockpit.toggle_path instanceId={} enabled={}", instanceId, pathOverlayEnabled);
            }
        }
        // Pipeline-split diagnostic for the dead overlay key: when the PHYSICAL right-arrow is down,
        // log it (1/s). Raw hit + no toggle log above = the vanilla keybind layer lost the binding;
        // no raw hit = the press never reaches the game window (focus). Remove once diagnosed.
        MinecraftClient diagClient = MinecraftClient.getInstance();
        if (diagClient != null && diagClient.getWindow() != null) {
            long nowDiagMs = System.currentTimeMillis();
            if (nowDiagMs >= nextRawRightProbeLogMs
                && InputUtil.isKeyPressed(diagClient.getWindow().getHandle(), GLFW.GLFW_KEY_RIGHT)) {
                nextRawRightProbeLogMs = nowDiagMs + 1000L;
                LOGGER.info("cockpit.raw_right_arrow_down instanceId={}", instanceId);
            }
        }
        if (openEditorKey != null) {
            while (openEditorKey.wasPressed()) {
                MinecraftClient mc = MinecraftClient.getInstance();
                if (mc != null && cockpitLayout != null) {
                    mc.setScreen(new CockpitScreen(cockpitLayout, cockpitConfigPath()));
                    LOGGER.info("cockpit.open_editor instanceId={}", instanceId);
                }
            }
        }
    }

    // Fail-safe status HUD: a top-left panel of what the bot + brain are doing. Reads only hoisted state +
    // the live player (same client thread as the tick), and is fully wrapped so a render error can NEVER
    // crash the client or a normal run — on any throw it disables itself and logs once. Respects F1.
    private void renderCockpitHud(DrawContext context) {
        try {
            if (!cockpitHudEnabled || context == null) {
                return;
            }
            MinecraftClient client = MinecraftClient.getInstance();
            if (client == null || client.player == null || client.textRenderer == null) {
                return;
            }
            if (client.options != null && client.options.hudHidden) {
                return;
            }
            // A menu/editor is open: the in-play HUD must NOT draw behind it. (HudRenderCallback still
            // fires while a Screen is open, which otherwise renders the live HUD as ghost text behind the
            // cockpit editor's dimmed background.)
            if (client.currentScreen != null) {
                return;
            }
            ClientPlayerEntity player = client.player;
            BrainLink.Diagnostics d = hudDiagnostics;
            // Debounce the "thinking" indicator: flag it only when a brain call has actually been
            // outstanding a while, so the panels don't flicker THINKING/ok on every fast local poll.
            boolean brainThinking = controlEnabled && d != null && d.inFlight() && d.currentRequestAgeMs() >= 250L;
            CockpitHud.Status status = new CockpitHud.Status(
                controlEnabled,
                hudActiveLayer,
                d == null ? "" : d.currentAction(),
                d == null ? "" : d.currentReason(),
                hudLastControlReason,
                brainThinking,
                d == null ? 0L : d.currentIntentRemainingTtlMs(),
                d == null ? -1L : d.lastRoundTripMs(),
                d == null ? "" : d.currentCommandId(),
                player.getHealth(),
                (int) Math.floor(player.getY()),
                d == null ? -1L : d.msSinceResponseMs()
            );
            renderCockpitPanel(context, client, CockpitLayout.STATUS,
                CockpitHud.lines(status), controlEnabled ? 0xFF55FF55 : 0xFFFF5555);
            renderCockpitPanel(context, client, CockpitLayout.DEEPSEEK,
                CockpitHud.deepSeekLines(
                    d == null ? "none" : d.planSource(),
                    d == null ? "" : d.planReason(),
                    brainThinking),
                0xFF55FFFF);
        } catch (Throwable t) {
            cockpitHudEnabled = false;
            LOGGER.warn("cockpit.hud_render_failed instanceId={} disabling reason={}", instanceId, String.valueOf(t));
        }
    }

    /** Draw a layout panel at its configured position/scale, honoring collapsed (title-only) + enabled. */
    private void renderCockpitPanel(DrawContext context, MinecraftClient client, String panelId, List<String> lines, int headerColor) {
        if (cockpitLayout == null) {
            return;
        }
        CockpitLayout.PanelConfig cfg = cockpitLayout.get(panelId);
        if (cfg == null || !cfg.enabled) {
            return;
        }
        List<String> shown = cfg.collapsed && !lines.isEmpty() ? List.of(lines.get(0)) : lines;
        MatrixStack matrices = context.getMatrices();
        matrices.push();
        matrices.translate(cfg.x, cfg.y, 0.0);
        float scale = cfg.clampedScale();
        if (scale != 1.0f) {
            matrices.scale(scale, scale, 1.0f);
        }
        drawCockpitPanel(context, client, 0, 0, shown, headerColor);
        matrices.pop();
    }

    private Path cockpitConfigPath() {
        try {
            return FabricLoader.getInstance().getConfigDir().resolve("mcbot_cockpit.json");
        } catch (Throwable t) {
            return null; // CockpitLayout.load(null) -> defaults
        }
    }

    /** Draw one labeled HUD panel (translucent backing + colored header line); returns its bottom Y. */
    private int drawCockpitPanel(DrawContext context, MinecraftClient client, int x, int y, List<String> lines, int headerColor) {
        int lineHeight = client.textRenderer.fontHeight + 2;
        int width = 0;
        for (String line : lines) {
            width = Math.max(width, client.textRenderer.getWidth(line));
        }
        context.fill(x - 2, y - 2, x + width + 2, y + lines.size() * lineHeight, 0x90000000);
        int cursorY = y;
        for (int i = 0; i < lines.size(); i++) {
            context.drawText(client.textRenderer, lines.get(i), x, cursorY, i == 0 ? headerColor : 0xFFFFFFFF, true);
            cursorY += lineHeight;
        }
        return y + lines.size() * lineHeight;
    }

    // Fail-safe world-space path overlay (default OFF): the bot's nav waypoints drawn as a translucent
    // cyan line ribbon at feet level — an ORIGINAL visual, not a Baritone clone. Waypoints are 2-D grid
    // cells (x,z); the path height is the player's feet Y. Fully wrapped so a wrong/blind render transform
    // can never crash the client — on any throw it disables itself and logs once.
    private void renderPathOverlay(WorldRenderContext context) {
        try {
            if (!pathOverlayEnabled || context == null) {
                return;
            }
            // Render the path the bot actually follows: the client-computed A* route in
            // activeNavigationWaypoints. The brain intent's waypoints() are almost always empty (the route is
            // computed locally from a target, not sent by the brain), so reading hudEffective.waypoints() left
            // the overlay with nothing to draw every frame -- the "completely invisible" path.
            // Prefer the live 3-D collect route (populated while the 3-D nav drives); else the 2-D A* route.
            // activeNavigationWaypoints is empty during a 3-D collect, which is why the overlay had no data.
            List<GridCell> waypoints =
                nav3dOverlayWaypoints.size() >= 2 ? nav3dOverlayWaypoints : activeNavigationWaypoints;
            if (waypoints == null || waypoints.size() < 2) {
                return;
            }
            MatrixStack matrices = context.matrixStack();
            VertexConsumerProvider consumers = context.consumers();
            Camera camera = context.camera();
            MinecraftClient client = MinecraftClient.getInstance();
            if (matrices == null || consumers == null || camera == null || client == null || client.player == null) {
                return;
            }
            Vec3d cam = camera.getPos();
            double pathY = Math.floor(client.player.getY()) + 0.05D;
            VertexConsumer buffer = consumers.getBuffer(RenderLayer.getLines());
            MatrixStack.Entry entry = matrices.peek();
            Matrix4f positionMatrix = entry.getPositionMatrix();
            for (int i = 0; i < waypoints.size() - 1; i++) {
                GridCell a = waypoints.get(i);
                GridCell b = waypoints.get(i + 1);
                float ax = (float) (a.x() + 0.5D - cam.x);
                float ay = (float) (pathY - cam.y);
                float az = (float) (a.z() + 0.5D - cam.z);
                float bx = (float) (b.x() + 0.5D - cam.x);
                float by = (float) (pathY - cam.y);
                float bz = (float) (b.z() + 0.5D - cam.z);
                float nx = bx - ax;
                float ny = by - ay;
                float nz = bz - az;
                float len = (float) Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (len <= 0.0001F) {
                    continue;
                }
                nx /= len;
                ny /= len;
                nz /= len;
                buffer.vertex(positionMatrix, ax, ay, az).color(80, 230, 255, 170).normal(entry, nx, ny, nz);
                buffer.vertex(positionMatrix, bx, by, bz).color(80, 230, 255, 170).normal(entry, nx, ny, nz);
            }
            // AFTER_TRANSLUCENT does not reliably auto-flush the lines layer, so draw it explicitly -- this is why
            // the overlay had real data + a valid render context yet stayed completely invisible.
            if (consumers instanceof VertexConsumerProvider.Immediate immediate) {
                immediate.draw(RenderLayer.getLines());
            }
        } catch (Throwable t) {
            pathOverlayEnabled = false;
            LOGGER.warn("cockpit.path_overlay_failed instanceId={} disabling reason={}", instanceId, String.valueOf(t));
        }
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

    /** Hand control back to the human: swap the bot's Input out for vanilla keyboard input so the player
     * can walk/look normally while the bot is toggled OFF. No-op once already on vanilla input. */
    private void restoreManualInput(ClientPlayerEntity player, MinecraftClient client) {
        if (player.input instanceof McbotControlledInput && client.options != null) {
            player.input = new KeyboardInput(client.options);
            currentInputState = InputState.stop();
            // V1: re-grab the pointer so you get mouse-look in manual mode -- the bot-driving
            // ticks released it (NO_CURSOR_GRAB). Fires once on the toggle-off transition (the guard
            // above no-ops once already on vanilla input); vanilla maintains the grab afterward.
            if (client.mouse != null) {
                client.mouse.lockCursor();
            }
            LOGGER.info("input.restore instanceId={} mode=manual_keyboard", instanceId);
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

        boolean pressed = autoCreateNewWorld
            ? pressButton(screen, "Singleplayer") || pressButton(screen, "Create New World")
            : pressButton(screen, "Singleplayer")
                || pressButton(screen, "Play Selected World")
                || pressButton(screen, "Create New World");
        if (pressed) {
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

    // Whether a brain command (by id) has FINISHED — completed or failed (both are recorded). Lets the
    // brain reuse the same commandId while a multi-tick command runs (the client continues a command on
    // the same id but RESTARTS on a new id) and mint a fresh id only once it is done — fixing 2x2-craft
    // restart spam and repeated-action dedup. Uses recorded completions (not transient "active" state)
    // so a craft that finishes within a single tick, between brain polls, is still detected.
    private boolean isCommandCompleted(String commandId) {
        if (commandId == null || commandId.isEmpty()) {
            return false;
        }
        return gatherLogExecutor.isFinished(commandId)
            || completedGatherTreeCommandIds.contains(commandId)
            || mineStoneExecutor.isFinished(commandId)
            || completedBreakBlockCommandIds.contains(commandId)
            || craft2x2Executor.isFinished(commandId)
            || completedCraft3x3CommandIds.contains(commandId)
            || completedSmeltCharcoalCommandIds.contains(commandId)
            || completedMakeCharcoalCommandIds.contains(commandId)
            || placeWorkstationExecutor.isFinishedTable(commandId)
            || placeWorkstationExecutor.isFinishedFurnace(commandId)
            || retrieveTableExecutor.isFinished(commandId)
            || finishedEquipArmorCommandReasons.containsKey(commandId)
            || finishedEatCommandReasons.containsKey(commandId)
            || finishedDescentCommandReasons.containsKey(commandId)
            || finishedMineNearbyStoneCommandReasons.containsKey(commandId)
            || finishedMineNearbyIronCommandReasons.containsKey(commandId)
            || finishedMineNearbyDiamondCommandReasons.containsKey(commandId)
            || finishedMineNearbyCoalCommandReasons.containsKey(commandId)
            || finishedReturnStaircaseCommandReasons.containsKey(commandId)
            || finishedR2MineStoneReturnCommandReasons.containsKey(commandId)
            || finishedR5IronChainCommandReasons.containsKey(commandId)
            || huntSheepExecutor.isFinished(commandId)
            || useBedExecutor.isFinished(commandId);
    }

    private boolean isCommandCompleted(String commandId, String action) {
        if (commandId == null || commandId.isEmpty()) {
            return false;
        }
        String normalizedAction = action == null ? "" : action;
        if (normalizedAction.isBlank() || "stop".equals(normalizedAction)) {
            return isCommandCompleted(commandId);
        }
        if ("break_block".equals(normalizedAction)) {
            return completedBreakBlockCommandIds.contains(commandId);
        }
        if ("gather_log".equals(normalizedAction)) {
            return gatherLogExecutor.isFinished(commandId);
        }
        if ("gather_tree".equals(normalizedAction)) {
            return completedGatherTreeCommandIds.contains(commandId);
        }
        if ("mine_stone".equals(normalizedAction)) {
            return mineStoneExecutor.isFinished(commandId);
        }
        if ("descend_staircase".equals(normalizedAction)) {
            return finishedDescentCommandReasons.containsKey(commandId);
        }
        if ("mine_nearby_stone".equals(normalizedAction)) {
            return finishedMineNearbyStoneCommandReasons.containsKey(commandId);
        }
        if ("mine_nearby_iron".equals(normalizedAction)) {
            return finishedMineNearbyIronCommandReasons.containsKey(commandId);
        }
        if ("mine_nearby_diamond".equals(normalizedAction)) {
            return finishedMineNearbyDiamondCommandReasons.containsKey(commandId);
        }
        if ("mine_nearby_coal".equals(normalizedAction)) {
            return finishedMineNearbyCoalCommandReasons.containsKey(commandId);
        }
        if ("return_staircase".equals(normalizedAction)) {
            return finishedReturnStaircaseCommandReasons.containsKey(commandId);
        }
        if (Craft2x2RecipePlanner.isCraftAction(normalizedAction)) {
            return craft2x2Executor.isFinished(commandId);
        }
        if (Craft3x3RecipePlanner.isCraftAction(normalizedAction)) {
            return completedCraft3x3CommandIds.contains(commandId);
        }
        if (FurnaceSmeltRecipe.fromAction(normalizedAction) != null) {
            return completedSmeltCharcoalCommandIds.contains(commandId);
        }
        if ("make_charcoal".equals(normalizedAction)) {
            return completedMakeCharcoalCommandIds.contains(commandId);
        }
        if ("place_table".equals(normalizedAction)) {
            return placeWorkstationExecutor.isFinishedTable(commandId);
        }
        if ("place_furnace".equals(normalizedAction)) {
            return placeWorkstationExecutor.isFinishedFurnace(commandId);
        }
        if ("retrieve_table".equals(normalizedAction)) {
            return retrieveTableExecutor.isFinished(commandId);
        }
        if ("equip_armor".equals(normalizedAction)) {
            return finishedEquipArmorCommandReasons.containsKey(commandId);
        }
        if ("eat".equals(normalizedAction)) {
            return finishedEatCommandReasons.containsKey(commandId);
        }
        if ("r2_mine_stone_return".equals(normalizedAction)) {
            return finishedR2MineStoneReturnCommandReasons.containsKey(commandId);
        }
        if ("r5_iron_chain".equals(normalizedAction)) {
            return finishedR5IronChainCommandReasons.containsKey(commandId);
        }
        if ("hunt_sheep".equals(normalizedAction)) {
            return huntSheepExecutor.isFinished(commandId);
        }
        if ("use_bed".equals(normalizedAction)) {
            return useBedExecutor.isFinished(commandId);
        }
        return isCommandCompleted(commandId);
    }

    private String commandCompletionReason(String commandId, String fallbackAction) {
        String fallback = fallbackAction == null || fallbackAction.isBlank()
            ? "command_complete"
            : fallbackAction + "_recorded_complete";
        if (commandId == null || commandId.isEmpty()) {
            return fallback;
        }
        String action = fallbackAction == null ? "" : fallbackAction;
        if (!action.isBlank() && !"stop".equals(action)) {
            String actionReason = commandCompletionReasonForAction(commandId, action);
            return actionReason == null || actionReason.isBlank() ? fallback : actionReason;
        }
        String gatherReason = gatherLogExecutor.finishedReason(commandId);
        if (gatherReason != null && !gatherReason.isBlank()) {
            return gatherReason;
        }
        String gatherTreeReason = finishedGatherTreeCommandReasons.get(commandId);
        if (gatherTreeReason != null && !gatherTreeReason.isBlank()) {
            return gatherTreeReason;
        }
        String craft2x2Reason = craft2x2Executor.finishedReason(commandId);
        if (craft2x2Reason != null && !craft2x2Reason.isBlank()) {
            return craft2x2Reason;
        }
        String craft3x3Reason = finishedCraft3x3CommandReasons.get(commandId);
        if (craft3x3Reason != null && !craft3x3Reason.isBlank()) {
            return craft3x3Reason;
        }
        String smeltReason = finishedSmeltCommandReasons.get(commandId);
        if (smeltReason != null && !smeltReason.isBlank()) {
            return smeltReason;
        }
        String makeCharcoalReason = finishedMakeCharcoalCommandReasons.get(commandId);
        if (makeCharcoalReason != null && !makeCharcoalReason.isBlank()) {
            return makeCharcoalReason;
        }
        String placeTableReason = placeWorkstationExecutor.finishedReasonTable(commandId);
        if (placeTableReason != null && !placeTableReason.isBlank()) {
            return placeTableReason;
        }
        String placeFurnaceReason = placeWorkstationExecutor.finishedReasonFurnace(commandId);
        if (placeFurnaceReason != null && !placeFurnaceReason.isBlank()) {
            return placeFurnaceReason;
        }
        String retrieveTableReason = retrieveTableExecutor.finishedReason(commandId);
        if (retrieveTableReason != null && !retrieveTableReason.isBlank()) {
            return retrieveTableReason;
        }
        String equipArmorReason = finishedEquipArmorCommandReasons.get(commandId);
        if (equipArmorReason != null && !equipArmorReason.isBlank()) {
            return equipArmorReason;
        }
        String descentReason = finishedDescentCommandReasons.get(commandId);
        if (descentReason != null && !descentReason.isBlank()) {
            return descentReason;
        }
        String stoneReason = finishedMineNearbyStoneCommandReasons.get(commandId);
        if (stoneReason != null && !stoneReason.isBlank()) {
            return stoneReason;
        }
        String ironReason = finishedMineNearbyIronCommandReasons.get(commandId);
        if (ironReason != null && !ironReason.isBlank()) {
            return ironReason;
        }
        String diamondReason = finishedMineNearbyDiamondCommandReasons.get(commandId);
        if (diamondReason != null && !diamondReason.isBlank()) {
            return diamondReason;
        }
        String returnReason = finishedReturnStaircaseCommandReasons.get(commandId);
        if (returnReason != null && !returnReason.isBlank()) {
            return returnReason;
        }
        String r2Reason = finishedR2MineStoneReturnCommandReasons.get(commandId);
        if (r2Reason != null && !r2Reason.isBlank()) {
            return r2Reason;
        }
        String r5Reason = finishedR5IronChainCommandReasons.get(commandId);
        if (r5Reason != null && !r5Reason.isBlank()) {
            return r5Reason;
        }
        String eatReason = finishedEatCommandReasons.get(commandId);
        if (eatReason != null && !eatReason.isBlank()) {
            return eatReason;
        }
        return fallback;
    }

    private String commandCompletionReason(BrainLink.Intent priorIntent) {
        if (priorIntent == null) {
            return "command_complete";
        }
        String action = priorIntent.action();
        String reason = priorIntent.reason();
        if ("stop".equals(action) && isRecordedCompletionReason(reason)) {
            return reason;
        }
        return commandCompletionReason(priorIntent.commandId(), action);
    }

    static boolean isRecordedCompletionReason(String reason) {
        if (reason == null || reason.isBlank()) {
            return false;
        }
        return reason.contains("_complete") || reason.contains("_failed");
    }

    private String commandCompletionReasonForAction(String commandId, String action) {
        if ("gather_log".equals(action)) {
            return gatherLogExecutor.finishedReason(commandId);
        }
        if ("hunt_sheep".equals(action)) {
            return huntSheepExecutor.finishedReason(commandId);
        }
        if ("use_bed".equals(action)) {
            return useBedExecutor.finishedReason(commandId);
        }
        if ("gather_tree".equals(action)) {
            return finishedGatherTreeCommandReasons.get(commandId);
        }
        if (Craft2x2RecipePlanner.isCraftAction(action)) {
            return craft2x2Executor.finishedReason(commandId);
        }
        if (Craft3x3RecipePlanner.isCraftAction(action)) {
            return finishedCraft3x3CommandReasons.get(commandId);
        }
        if (FurnaceSmeltRecipe.fromAction(action) != null) {
            return finishedSmeltCommandReasons.get(commandId);
        }
        if ("make_charcoal".equals(action)) {
            return finishedMakeCharcoalCommandReasons.get(commandId);
        }
        if ("place_table".equals(action)) {
            return placeWorkstationExecutor.finishedReasonTable(commandId);
        }
        if ("place_furnace".equals(action)) {
            return placeWorkstationExecutor.finishedReasonFurnace(commandId);
        }
        if ("retrieve_table".equals(action)) {
            return retrieveTableExecutor.finishedReason(commandId);
        }
        if ("equip_armor".equals(action)) {
            return finishedEquipArmorCommandReasons.get(commandId);
        }
        if ("descend_staircase".equals(action)) {
            return finishedDescentCommandReasons.get(commandId);
        }
        if ("mine_nearby_stone".equals(action)) {
            return finishedMineNearbyStoneCommandReasons.get(commandId);
        }
        if ("mine_nearby_iron".equals(action)) {
            return finishedMineNearbyIronCommandReasons.get(commandId);
        }
        if ("mine_nearby_diamond".equals(action)) {
            return finishedMineNearbyDiamondCommandReasons.get(commandId);
        }
        if ("mine_nearby_coal".equals(action)) {
            return finishedMineNearbyCoalCommandReasons.get(commandId);
        }
        if ("return_staircase".equals(action)) {
            return finishedReturnStaircaseCommandReasons.get(commandId);
        }
        if ("r2_mine_stone_return".equals(action)) {
            return finishedR2MineStoneReturnCommandReasons.get(commandId);
        }
        if ("r5_iron_chain".equals(action)) {
            return finishedR5IronChainCommandReasons.get(commandId);
        }
        if ("eat".equals(action)) {
            return finishedEatCommandReasons.get(commandId);
        }
        return null;
    }

    private String finishMakeCharcoalCommand(String commandId, String completionReason) {
        recordFinishedCommand(completedMakeCharcoalCommandIds, finishedMakeCharcoalCommandReasons, commandId, completionReason);
        return completionReason;
    }

    private String finishEquipArmorCommand(String commandId, String completionReason) {
        if (commandId != null && !commandId.isBlank() && completionReason != null && !completionReason.isBlank()) {
            finishedEquipArmorCommandReasons.put(commandId, completionReason);
        }
        return completionReason;
    }

    private void recordFinishedCommand(
        Set<String> completedIds,
        Map<String, String> finishedReasons,
        String commandId,
        String completionReason
    ) {
        completedIds.add(commandId);
        if (commandId != null && !commandId.isBlank() && completionReason != null && !completionReason.isBlank()) {
            finishedReasons.put(commandId, completionReason);
        }
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

    // Perf backstop: the control loop and its world scans run inside the client tick on the render
    // thread, so a slow tick here IS a frame stall. Warn (throttled) whenever the bot's tick work
    // exceeds the budget, independent of brain in-flight state, so scan regressions like the
    // gather-search one are visible in any run's log instead of needing a profiler.
    private static final long TICK_BUDGET_WARN_MS = 50L;
    private long nextTickBudgetWarnAtMs = 0L;

    private void logBrainTiming(long nowMs, long tickStartNs, BrainLink.Diagnostics diagnostics) {
        long budgetTickMs = Math.max(0L, (System.nanoTime() - tickStartNs) / 1_000_000L);
        if (budgetTickMs >= TICK_BUDGET_WARN_MS && nowMs >= nextTickBudgetWarnAtMs) {
            nextTickBudgetWarnAtMs = nowMs + 1_000L;
            LOGGER.warn(
                "mcbot.tick_budget_exceeded instanceId={} tickMs={} budgetMs={}",
                instanceId,
                budgetTickMs,
                TICK_BUDGET_WARN_MS
            );
        }
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
        // Strangler dispatch: objectives lifted into the registry are consulted first. tickContext was
        // reset() earlier this tick (in onClientTick) before resolveControl ran. Unregistered actions
        // return null and fall through to the unchanged if/return chain below — identical behavior.
        ObjectiveExecutor ex = effective == null ? null : objectiveRegistry.forAction(effective.action());
        if (ex != null) {
            return ex.tick(tickContext);
        }
        if (isBreakBlock(effective)) {
            return resolveBreakBlockControl(client, player, effective, nowMs);
        }
        if (isGatherTree(effective)) {
            return resolveGatherTreeControl(client, player, effective, nowMs);
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
        if (isMineNearbyCoal(effective)) {
            return resolveMineNearbyOreControl(client, player, effective, nowMs, OreKind.COAL);
        }
        if (isMineNearbyDiamond(effective)) {
            return resolveMineNearbyDiamondControl(client, player, effective, nowMs);
        }
        if (isReturnStaircase(effective)) {
            return resolveReturnStaircaseControl(client, player, effective, nowMs);
        }
        if (isNav3dDriveTest(effective)) {
            return resolveNav3dDriveTestControl(client, player, effective, nowMs);
        }
        if (isR2MineStoneReturn(effective)) {
            return resolveR2MineStoneReturnControl(client, player, effective, nowMs);
        }
        if (isCraft3x3(effective)) {
            return resolveCraft3x3Control(client, player, effective, nowMs);
        }
        if (isEquipArmor(effective)) {
            return resolveEquipArmorControl(client, player, effective, nowMs);
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
        if (isEat(effective)) {
            return resolveEatControl(player, effective);
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

    private boolean isGatherTree(BrainLink.Intent intent) {
        return intent != null && "gather_tree".equals(intent.action());
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

    private boolean isMineNearbyCoal(BrainLink.Intent intent) {
        return intent != null && "mine_nearby_coal".equals(intent.action());
    }

    private boolean isMineNearbyDiamond(BrainLink.Intent intent) {
        return intent != null && "mine_nearby_diamond".equals(intent.action());
    }

    private boolean isReturnStaircase(BrainLink.Intent intent) {
        return intent != null && "return_staircase".equals(intent.action());
    }

    private boolean isNav3dDriveTest(BrainLink.Intent intent) {
        return intent != null && "nav3d_drive_test".equals(intent.action());
    }

    // Dev-only forced mine-through test: drive the 3-D nav at an ABSOLUTE target (the stub brain handles setup +
    // arrival). The target is walled off, so tryNav3dDriveToward finds no route and falls into nav3dDigTunnelToward
    // -- this PROVES the mine-through (the bot must dig to reach it).
    private ControlDecision resolveNav3dDriveTestControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        Double tx = effective.targetX();
        Double ty = effective.targetY();
        Double tz = effective.targetZ();
        if (tx == null || ty == null || tz == null) {
            return new ControlDecision(stopFrom(effective, "nav3d_test_no_target"), InputState.stop());
        }
        Vec3d target = new Vec3d(tx + 0.5D, ty, tz + 0.5D);
        ControlDecision drive = tryNav3dDriveToward(client, player, effective, target, "nav3d_test", commandId, nowMs);
        if (drive != null) {
            return drive;
        }
        return new ControlDecision(stopFrom(effective, "nav3d_test_blocked"), InputState.stop());
    }

    private boolean isR2MineStoneReturn(BrainLink.Intent intent) {
        return intent != null && "r2_mine_stone_return".equals(intent.action());
    }

    private boolean isCraft3x3(BrainLink.Intent intent) {
        return intent != null && Craft3x3RecipePlanner.isCraftAction(intent.action());
    }

    private boolean isEquipArmor(BrainLink.Intent intent) {
        return intent != null && "equip_armor".equals(intent.action());
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

    private boolean isEat(BrainLink.Intent intent) {
        return intent != null && "eat".equals(intent.action());
    }

    private ControlDecision resolveEatControl(ClientPlayerEntity player, BrainLink.Intent effective) {
        activeNavigationCommandId = "";
        activeNavigationWaypointIndex = 0;
        activeNavigationProgress = PathFollower.Progress.initial();
        activeNavigationWaypoints = List.of();
        activeNavigationRouteComputed = false;
        activeNavigationSuppliedRoute = false;
        activeNavigationJumpWaypointIndexes = Set.of();

        String commandId = effective.commandId() == null ? "" : effective.commandId();
        int foodLevel = player.getHungerManager().getFoodLevel();
        if (!commandId.isBlank() && foodLevel >= MISSION_EAT_COMPLETE_FOOD_LEVEL) {
            finishedEatCommandReasons.put(commandId, "eat_complete:food=" + foodLevel);
            return new ControlDecision(stopFrom(effective, "eat_complete"), InputState.stop());
        }
        if (!commandId.isBlank() && !ClientSnapshot.hasHotbarEdibleFood(player)) {
            finishedEatCommandReasons.put(commandId, "eat_failed:no_hotbar_food");
            return new ControlDecision(stopFrom(effective, "eat_no_hotbar_food"), InputState.stop());
        }
        return new ControlDecision(effective, InputState.stop());
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
        activeNavigationSuppliedRoute = false;
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
            // Live runs showed a retry descent start one block from the
            // previous no_safe_reroute failure and dig straight back into the same cavern. Near a
            // recent failure, rotate the heading 90 degrees so the new staircase takes a different
            // line; full multi-block cavern scaffolding remains the queued real fix.
            if (lastDescentFailurePos != null
                && nowMs - lastDescentFailureAtMs < DESCENT_RETRY_ROTATE_WINDOW_MS
                && startFeet.getSquaredDistance(lastDescentFailurePos) <= DESCENT_RETRY_ROTATE_RADIUS_SQ) {
                StaircaseDescentPlanner.Direction2d rotated = rotateDescentDirection(direction);
                LOGGER.info(
                    "descent.retry_heading_rotated instanceId={} commandId={} from={} to={} failurePos={}",
                    instanceId,
                    commandId,
                    direction.name(),
                    rotated.name(),
                    lastDescentFailurePos.toShortString()
                );
                direction = rotated;
            }
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
                new DescentControlPlanner.StepObservation(true, false, false, false, false, null, false, false, false, false, false)
            );
            if (stepDecision.action() == DescentControlPlanner.Action.RUN_IRON_CLEANUP) {
                return ironCleanupDecision;
            }
        }

        boolean complete = descentComplete(client, player, run);
        StaircaseDescentPlanner.Step step = complete ? null : StaircaseDescentPlanner.stepFrom(run.currentFeet, run.direction, run.stepIndex);
        ControlDecision clearanceRecovery = maybeResolveDescentClearanceRecovery(
            client,
            player,
            effective,
            run,
            step,
            nowMs
        );
        if (clearanceRecovery != null) {
            return clearanceRecovery;
        }
        boolean reachedStep = step != null && reachedDescentStep(player, step.nextFeet());
        String unsafeReason = step == null || reachedStep ? null : descentStepUnsafeReason(client, step);
        boolean moveStalled = step != null
            && !reachedStep
            && run.stage == DescentControlPlanner.Stage.MOVE_TO_STEP
            && descentMoveStalled(player, run, step, nowMs);
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
                step != null && unsafeReason == null && client.world.getBlockState(step.lowerClear()).isAir(),
                moveStalled,
                canBridgeDescentSupport(client, player, run, step, unsafeReason)
            )
        );
        if (stepDecision.action() == DescentControlPlanner.Action.COMPLETE) {
            return completeDescent(effective, run, player, nowMs, stepDecision.reason());
        }
        if (stepDecision.action() == DescentControlPlanner.Action.FAIL_SELF_SUPPORT) {
            return failDescent(effective, run, nowMs, stepDecision.reason());
        }
        if (stepDecision.action() == DescentControlPlanner.Action.FAIL_OVERSHOT_STEP) {
            ControlDecision resync = maybeResyncDescentOvershot(client, player, effective, run, step, nowMs);
            if (resync != null) {
                return resync;
            }
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
            clearDescentMoveProgress(run);
            applyDescentControlDecision(run, stepDecision);
            return new ControlDecision(stopFrom(effective, "descent_step_reached"), InputState.stop());
        }
        if (stepDecision.action() == DescentControlPlanner.Action.PLACE_SUPPORT) {
            return placeDescentSupport(client, player, effective, run, step, nowMs, stepDecision.reason());
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
        InventoryCounter.InventoryItemSnapshot rawIronInventory = InventoryCounter.countPlayerItem(player, "raw_iron");
        InventoryCounter.InventoryItemSnapshot ironIngotsInventory = InventoryCounter.countPlayerItem(player, "iron_ingot");
        InventoryCounter.InventoryItemSnapshot ironPickaxesInventory = InventoryCounter.countPlayerItem(player, "iron_pickaxe");
        int availableIronUnits = rawIronInventory.itemCount()
            + ironIngotsInventory.itemCount()
            + (ironPickaxesInventory.itemCount() * 3);
        if (availableIronUnits >= descentIronCleanupTargetUnits(isMissionCommandId(run.commandId))) {
            if (run.ironCleanupTarget != null || run.ironCleanupCollectStartedAtMs > 0L || run.ironCleanupBlocksBroken > 0) {
                LOGGER.info(
                    "descent.iron_cleanup_satisfied instanceId={} commandId={} availableIronUnits={} rawIron={} ironIngots={} ironPickaxes={} blocksBroken={}",
                    instanceId,
                    run.commandId,
                    availableIronUnits,
                    rawIronInventory.itemCount(),
                    ironIngotsInventory.itemCount(),
                    ironPickaxesInventory.itemCount(),
                    run.ironCleanupBlocksBroken
                );
            }
            run.ironCleanupTarget = null;
            run.lastIronCleanupTarget = null;
            run.ironCleanupCollectStartedAtMs = 0L;
            return null;
        }

        if (run.ironCleanupCollectStartedAtMs > 0L) {
            if (nowMs - run.ironCleanupCollectStartedAtMs < GATHER_PICKUP_SETTLE_MS) {
                return new ControlDecision(stopFrom(effective, "descent_iron_cleanup_wait_pickup"), InputState.stop());
            }
            Vec3d droppedRawIron = nearestDroppedItemPosition(
                client,
                player,
                run.lastIronCleanupTarget == null ? player.getBlockPos() : run.lastIronCleanupTarget,
                (stack, itemId) -> "raw_iron".equalsIgnoreCase(itemId) || "coal".equalsIgnoreCase(itemId)
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
        int pickaxeSlot = findIronHarvestPickaxeHotbarSlot(player);
        if (pickaxeSlot < 0) {
            run.ironCleanupTarget = null;
            run.ironCleanupBlocksBroken = DESCENT_MAX_IRON_CLEANUP_BLOCKS;
            LOGGER.warn(
                "descent.iron_cleanup_skip instanceId={} commandId={} reason=no_stone_or_better_pickaxe_hotbar target={} selectedItem={}",
                instanceId,
                run.commandId,
                target.toShortString(),
                selectedItemId(player)
            );
            return new ControlDecision(stopFrom(effective, "descent_iron_cleanup_skip_no_stone_or_better_pickaxe"), InputState.stop());
        }
        if (player.getInventory().selectedSlot != pickaxeSlot) {
            player.getInventory().selectedSlot = pickaxeSlot;
            LOGGER.info(
                "descent.iron_cleanup_tool_selected instanceId={} commandId={} target={} hotbarSlot={} selectedItem={}",
                instanceId,
                run.commandId,
                target.toShortString(),
                pickaxeSlot,
                selectedItemId(player)
            );
            return new ControlDecision(stopFrom(effective, "descent_iron_cleanup_select_tool"), InputState.stop());
        }
        if (!isLookingAtBlock(player, target)) {
            return new ControlDecision(lookIntentForBlock(effective, player, target, "descent_iron_cleanup_face"), InputState.stop());
        }
        // breakTerrainOccluders: ore embedded in a wall is mined THROUGH the plain stone/dirt in front
        // of it instead of reposition-cycling when the eye-ray clips the occluding edge.
        BlockBreakController.Result result = blockBreakController.tick(
            client, player, target, run.commandId + ":descent:iron_cleanup", nowMs, false, 0L, true);
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

    // Coal banked during iron cleanup tops out here — enough for a full armor grind's smelts
    // (8 ingots/coal-piece of furnace time is irrelevant; 1 coal smelts 8 items) without turning
    // descents into coal expeditions.
    private static final int DESCENT_COAL_BANK_CAP = 12;
    private static final int NEARBY_COAL_TARGET_COAL = 8;
    private static final long NEARBY_COAL_TIMEOUT_MS = 120_000L;
    private static final int NEARBY_COAL_MAX_PROSPECT_BLOCKS = 32;

    private BlockPos selectVisibleDescentIronCleanupTarget(MinecraftClient client, ClientPlayerEntity player, DescentRun run) {
        Set<BlockPos> excluded = new HashSet<>(run.abandonedIronCleanupTargets);
        while (excluded.size() < run.abandonedIronCleanupTargets.size() + 32) {
            BlockPos candidate = selectVisibleIronTarget(client, player, excluded);
            if (candidate == null) {
                break;
            }
            if (isSafeDescentIronCleanupTarget(client, player, run, candidate)) {
                return candidate;
            }
            excluded.add(candidate);
        }
        // Coal rider REVERTED (a live run hit a pathology of 9198 target selections in 13 min —
        // cleanup satisfaction is IRON-unit keyed, so coal banking never satisfied it and the
        // descent starved until the mission aborted). The fuel fix needs its own completion
        // semantics (banked-coal target with a dedicated satisfied gate) — daytime redesign; the
        // coal-drop pickup in the collect predicate stays, and selectVisibleCoalTarget/
        // isCoalOreBlock remain for that redesign.
        return null;
    }

    private boolean isCoalOreBlock(BlockState state) {
        return state != null && (state.isOf(Blocks.COAL_ORE) || state.isOf(Blocks.DEEPSLATE_COAL_ORE));
    }

    private BlockPos selectVisibleCoalTarget(MinecraftClient client, ClientPlayerEntity player, Set<BlockPos> excluded) {
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
                    if (!isCoalOreBlock(client.world.getBlockState(candidate))) {
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

        ToolSelectionPlanner.Decision targetToolDecision = ToolSelectionPlanner.decideForBlockId(blockId(targetState));
        if (targetToolDecision.requirement() == ToolSelectionPlanner.Requirement.PICKAXE_REQUIRED) {
            int pickaxeSlot = findStoneMiningPickaxeHotbarSlot(player);
            if (pickaxeSlot < 0) {
                // GUI crafting can leave every pickaxe in MAIN inventory; the hotbar-only tool search
                // then aborted the whole descent with tool_unavailable (repro:
                // 2 stone pickaxes crafted, selectedItem=empty at step 1). Pull one into the hotbar
                // exactly like the bridge-filler flow does, then retry next tick; if the inventory
                // truly has no pickaxe, fall through to the existing tool_unavailable failure.
                int hotbarMove = moveStoneMiningPickaxeToHotbar(client, player, run.commandId, "descent_break_tool");
                if (hotbarMove >= 0 || hotbarMove == -2) {
                    return new ControlDecision(stopFrom(effective, "descent_break_tool_hotbar_move:" + phase), InputState.stop());
                }
            }
            if (pickaxeSlot >= 0 && player.getInventory().selectedSlot != pickaxeSlot) {
                player.getInventory().selectedSlot = pickaxeSlot;
                LOGGER.info(
                    "descent.tool_selected instanceId={} commandId={} step={} phase={} hotbarSlot={} selectedItem={}",
                    instanceId,
                    run.commandId,
                    step.index(),
                    phase,
                    pickaxeSlot,
                    selectedItemId(player)
                );
                return new ControlDecision(stopFrom(effective, "descent_select_tool:" + phase), InputState.stop());
            }
        }

        if (!isLookingAtBlock(player, target)) {
            return new ControlDecision(lookIntentForBlock(effective, player, target, "descent_face_" + phase), InputState.stop());
        }
        BlockBreakController.Result result = blockBreakController.tick(client, player, target, run.commandId + ":step:" + step.index() + ":" + phase, nowMs);
        logBlockBreakResult(run.commandId + ":descent:" + step.index() + ":" + phase, target, result);
        LOGGER.info(
            "descent.break_progress instanceId={} commandId={} step={} phase={} target={} targetBlock={} selectedItem={} status={} reason={} hitBlock={} hitBlockId={} actedBlock={} elapsedMs={}",
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
            result.hitBlock() == null ? "" : blockId(client.world.getBlockState(result.hitBlock())),
            formatBlockPos(result.actedBlock()),
            result.elapsedMs()
        );
        if (result.status() == BlockBreakController.Status.BROKEN) {
            clearMatchingDescentClearanceRecovery(run, target);
            run.stage = switch (phase) {
                case "sight" -> DescentControlPlanner.Stage.BREAK_UPPER;
                case "upper" -> DescentControlPlanner.Stage.BREAK_LOWER;
                default -> DescentControlPlanner.Stage.MOVE_TO_STEP;
            };
            return new ControlDecision(stopFrom(effective, "descent_break_done:" + phase), InputState.stop());
        }
        if (result.status() == BlockBreakController.Status.REPOSITION) {
            String hazardReason = descentBreakHazardReason(client, player, target, result.reason());
            if (hazardReason == null && result.hitBlock() != null) {
                hazardReason = descentBreakHazardReason(client, player, result.hitBlock(), result.reason());
            }
            if (hazardReason != null) {
                return failDescent(effective, run, nowMs, hazardReason);
            }
            String recoveryPhase = descentRecoveryPhaseForOccludingClearance(step, phase, result.hitBlock(), result.reason());
            if (recoveryPhase != null) {
                run.recoveryClearTarget = descentTargetForPhase(step, recoveryPhase);
                run.recoveryClearPhase = recoveryPhase;
                run.stage = descentStageForPhase(recoveryPhase);
                LOGGER.warn(
                    "descent.clearance_recovery instanceId={} commandId={} step={} phase={} target={} hitBlock={} recoveryPhase={} recoveryTarget={} reason={}",
                    instanceId,
                    run.commandId,
                    step.index(),
                    phase,
                    target.toShortString(),
                    formatBlockPos(result.hitBlock()),
                    recoveryPhase,
                    formatBlockPos(run.recoveryClearTarget),
                    result.reason()
                );
                return new ControlDecision(stopFrom(effective, "descent_clearance_recovery:" + phase + ":" + recoveryPhase), InputState.stop());
            }
            if (shouldRerouteDescentBreakReposition(result.reason(), recoveryPhase)) {
                return rerouteOrFailDescent(effective, client, run, step, nowMs, "descent_break_reposition:" + result.reason());
            }
            return failDescent(effective, run, nowMs, "descent_break_reposition:" + result.reason());
        }
        if (result.status() == BlockBreakController.Status.FAILED) {
            return failDescent(effective, run, nowMs, "descent_break_failed:" + result.reason());
        }
        return new ControlDecision(lookIntentForBlock(effective, player, target, "descent_breaking_" + phase + ":" + result.reason()), InputState.stop());
    }

    private ControlDecision maybeResolveDescentClearanceRecovery(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        long nowMs
    ) {
        if (client == null
            || client.world == null
            || run == null
            || run.recoveryClearTarget == null
            || run.recoveryClearPhase == null
            || run.recoveryClearPhase.isBlank()) {
            return null;
        }
        if (step == null) {
            clearDescentClearanceRecovery(run);
            return null;
        }
        BlockPos target = run.recoveryClearTarget;
        String phase = run.recoveryClearPhase;
        if (client.world.getBlockState(target).isAir()) {
            clearDescentClearanceRecovery(run);
            run.stage = descentStageAfterPhase(phase);
            LOGGER.info(
                "descent.clearance_recovery_cleared instanceId={} commandId={} step={} phase={} target={} reason=already_air",
                instanceId,
                run.commandId,
                step.index(),
                phase,
                target.toShortString()
            );
            return new ControlDecision(stopFrom(effective, "descent_clearance_recovery_cleared:" + phase), InputState.stop());
        }
        run.stage = descentStageForPhase(phase);
        return breakDescentBlock(client, player, effective, run, step, target, phase, nowMs);
    }

    static String descentRecoveryPhaseForOccludingClearance(
        StaircaseDescentPlanner.Step step,
        String phase,
        BlockPos hitBlock,
        String breakReason
    ) {
        if (step == null
            || phase == null
            || hitBlock == null
            || !"raycast_occluded_reposition".equals(breakReason)) {
            return null;
        }
        if ("lower".equals(phase)) {
            if (hitBlock.equals(step.upperClear())) {
                return "upper";
            }
            if (hitBlock.equals(step.sightClear())) {
                return "sight";
            }
        }
        if ("upper".equals(phase) && hitBlock.equals(step.sightClear())) {
            return "sight";
        }
        return null;
    }

    static boolean shouldRerouteDescentBreakReposition(String breakReason, String recoveryPhase) {
        return "raycast_occluded_reposition".equals(breakReason)
            && (recoveryPhase == null || recoveryPhase.isBlank());
    }

    private static BlockPos descentTargetForPhase(StaircaseDescentPlanner.Step step, String phase) {
        if (step == null || phase == null) {
            return null;
        }
        return switch (phase) {
            case "sight" -> step.sightClear();
            case "upper" -> step.upperClear();
            case "lower" -> step.lowerClear();
            default -> null;
        };
    }

    private static DescentControlPlanner.Stage descentStageForPhase(String phase) {
        return switch (phase == null ? "" : phase) {
            case "sight" -> DescentControlPlanner.Stage.BREAK_SIGHT;
            case "upper" -> DescentControlPlanner.Stage.BREAK_UPPER;
            case "lower" -> DescentControlPlanner.Stage.BREAK_LOWER;
            default -> DescentControlPlanner.Stage.BREAK_SIGHT;
        };
    }

    private static DescentControlPlanner.Stage descentStageAfterPhase(String phase) {
        return switch (phase == null ? "" : phase) {
            case "sight" -> DescentControlPlanner.Stage.BREAK_UPPER;
            case "upper" -> DescentControlPlanner.Stage.BREAK_LOWER;
            case "lower" -> DescentControlPlanner.Stage.MOVE_TO_STEP;
            default -> DescentControlPlanner.Stage.BREAK_SIGHT;
        };
    }

    private static void clearMatchingDescentClearanceRecovery(DescentRun run, BlockPos target) {
        if (run != null && target != null && target.equals(run.recoveryClearTarget)) {
            clearDescentClearanceRecovery(run);
        }
    }

    private static void clearDescentClearanceRecovery(DescentRun run) {
        if (run == null) {
            return;
        }
        run.recoveryClearTarget = null;
        run.recoveryClearPhase = "";
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
        if (DescentControlPlanner.shouldSettleIntoStep(
            distance,
            DESCENT_STEP_ARRIVE_EPSILON,
            player.getY(),
            step.nextFeet().getY()
        )) {
            BrainLink.Intent intent = lookIntentForAngles(
                effective,
                yawForDescentDirection(run.direction),
                8.0D,
                "descent_step_drop_settle:" + step.index()
            );
            InputState input = new InputState(true, false, false, false, false, false, 1.0F, 0.0F);
            return new ControlDecision(intent, input);
        }
        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        double yawError = LookController.normalizeYaw(yaw - player.getYaw());
        if (DescentControlPlanner.shouldHoldMoveForYaw(yawError, DESCENT_MOVE_YAW_TOLERANCE_DEG)) {
            BrainLink.Intent intent = lookIntentForAngles(effective, yaw, 8.0D, "descent_face_step:" + step.index());
            return new ControlDecision(intent, InputState.stop());
        }
        BrainLink.Intent intent = lookIntentForAngles(effective, yaw, 8.0D, "descent_move_step:" + step.index());
        InputState input = new InputState(true, false, false, false, false, false, 1.0F, 0.0F);
        return new ControlDecision(intent, input);
    }

    static double yawForDescentDirection(StaircaseDescentPlanner.Direction2d direction) {
        if (direction == null) {
            return 0.0D;
        }
        if (direction.dx() > 0) {
            return -90.0D;
        }
        if (direction.dx() < 0) {
            return 90.0D;
        }
        if (direction.dz() < 0) {
            return 180.0D;
        }
        return 0.0D;
    }

    private boolean descentMoveStalled(ClientPlayerEntity player, DescentRun run, StaircaseDescentPlanner.Step step, long nowMs) {
        BlockPos target = step.nextFeet().toImmutable();
        double distance = descentStepHorizontalDistance(player, target);
        if (!target.equals(run.moveTargetFeet)) {
            run.moveTargetFeet = target;
            run.moveStartedAtMs = nowMs;
            run.moveLastProgressAtMs = nowMs;
            run.moveBestDistance = distance;
            LOGGER.info(
                "descent.move_start instanceId={} commandId={} step={} target={} position={} distance={}",
                instanceId,
                run.commandId,
                step.index(),
                target.toShortString(),
                player.getBlockPos().toShortString(),
                formatDistance(distance)
            );
            return false;
        }
        if (distance + DESCENT_MOVE_PROGRESS_EPSILON < run.moveBestDistance) {
            run.moveBestDistance = distance;
            run.moveLastProgressAtMs = nowMs;
            return false;
        }
        long stagnantMs = Math.max(0L, nowMs - run.moveLastProgressAtMs);
        if (stagnantMs >= DESCENT_MOVE_STALL_MS && distance > DESCENT_STEP_ARRIVE_EPSILON) {
            LOGGER.warn(
                "descent.move_stall instanceId={} commandId={} step={} target={} position={} distance={} bestDistance={} stagnantMs={} moveStartedMs={} stage={}",
                instanceId,
                run.commandId,
                step.index(),
                target.toShortString(),
                player.getBlockPos().toShortString(),
                formatDistance(distance),
                formatDistance(run.moveBestDistance),
                stagnantMs,
                Math.max(0L, nowMs - run.moveStartedAtMs),
                run.stage
            );
            return true;
        }
        return false;
    }

    private double descentStepHorizontalDistance(ClientPlayerEntity player, BlockPos nextFeet) {
        return Math.hypot((nextFeet.getX() + 0.5D) - player.getX(), (nextFeet.getZ() + 0.5D) - player.getZ());
    }

    private void clearDescentMoveProgress(DescentRun run) {
        run.moveTargetFeet = null;
        run.moveStartedAtMs = 0L;
        run.moveLastProgressAtMs = 0L;
        run.moveBestDistance = Double.POSITIVE_INFINITY;
    }

    private static String formatDistance(double value) {
        return String.format(Locale.ROOT, "%.3f", value);
    }

    private int resolveDescentDepth(BrainLink.Intent effective, int startY) {
        return resolveDescentDepthForTargetY(effective.targetY(), startY);
    }

    static int resolveDescentDepthForTargetY(Double targetY, int startY) {
        int requestedDepth = 6;
        if (targetY != null) {
            requestedDepth = startY - (int) Math.floor(targetY);
        }
        return StaircaseDescentPlanner.boundedDepth(requestedDepth, descentDepthCapForTargetY(targetY));
    }

    private static int descentDepthCapForTargetY(Double targetY) {
        if (targetY != null && Math.floor(targetY) < 0.0D) {
            return Math.max(DESCENT_MAX_DEPTH, DESCENT_DEEP_MAX_DEPTH);
        }
        return DESCENT_MAX_DEPTH;
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

    private ControlDecision maybeResyncDescentOvershot(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        long nowMs
    ) {
        if (client == null || player == null || run == null || step == null) {
            return null;
        }
        BlockPos actualFeet = player.getBlockPos().toImmutable();
        if (!shouldResyncDescentOvershot(run.currentFeet, actualFeet, step.nextFeet(), run.depthReached, run.depth)) {
            return null;
        }
        if (!isStableDescentSupport(client, actualFeet.down())) {
            return null;
        }
        int depthDelta = Math.max(1, run.currentFeet.getY() - actualFeet.getY());
        BlockPos previousFeet = run.currentFeet;
        run.currentFeet = actualFeet;
        run.depthReached = Math.min(run.depth, run.depthReached + depthDelta);
        run.stepIndex += depthDelta;
        run.stage = DescentControlPlanner.Stage.BREAK_SIGHT;
        run.reachedFeet.add(actualFeet);
        clearDescentMoveProgress(run);
        LOGGER.warn(
            "descent.overshot_resync instanceId={} commandId={} previousFeet={} plannedNextFeet={} actualFeet={} depthDelta={} depthReached={} step={} elapsedMs={}",
            instanceId,
            run.commandId,
            previousFeet.toShortString(),
            step.nextFeet().toShortString(),
            actualFeet.toShortString(),
            depthDelta,
            run.depthReached,
            run.stepIndex,
            Math.max(0L, nowMs - run.startedAtMs)
        );
        return new ControlDecision(stopFrom(effective, "descent_overshot_resynced"), InputState.stop());
    }

    static boolean shouldResyncDescentOvershot(
        BlockPos currentFeet,
        BlockPos actualFeet,
        BlockPos plannedNextFeet,
        int depthReached,
        int depth
    ) {
        if (currentFeet == null || actualFeet == null || plannedNextFeet == null) {
            return false;
        }
        int depthDelta = currentFeet.getY() - actualFeet.getY();
        if (depthDelta <= 0 || depthDelta > DESCENT_OVERSHOT_RESYNC_MAX_DROP) {
            return false;
        }
        int remainingDepth = Math.max(0, depth - depthReached);
        if (depthDelta > remainingDepth) {
            return false;
        }
        double horizontalDrift = Math.hypot(
            (plannedNextFeet.getX() + 0.5D) - (actualFeet.getX() + 0.5D),
            (plannedNextFeet.getZ() + 0.5D) - (actualFeet.getZ() + 0.5D)
        );
        return horizontalDrift <= DESCENT_OVERSHOT_RESYNC_MAX_HORIZONTAL_DRIFT;
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
        BlockPos adjacentLava = firstAdjacentLavaBlock(client, List.of(feet, feet.up()));
        if (adjacentLava != null) {
            return "descent_player_lava_adjacent:" + adjacentLava.toShortString();
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
        if (step == null) {
            return null;
        }
        return firstAdjacentLavaBlock(client, List.of(step.sightClear(), step.upperClear(), step.lowerClear(), step.support()));
    }

    private BlockPos firstAdjacentLavaBlock(MinecraftClient client, List<BlockPos> origins) {
        if (client == null || client.world == null || origins == null) {
            return null;
        }
        for (BlockPos origin : origins) {
            if (origin == null) {
                continue;
            }
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
                if (!shouldCheckDescentAdjacentWater(step, origin, direction)) {
                    continue;
                }
                BlockPos adjacent = origin.offset(direction);
                if (isWaterBlockState(client.world.getBlockState(adjacent))) {
                    if (shouldIgnoreSealedDescentAdjacentWater(client, step, origin, direction, adjacent)) {
                        continue;
                    }
                    return adjacent.toImmutable();
                }
            }
        }
        return null;
    }

    static boolean shouldCheckDescentAdjacentWater(
        StaircaseDescentPlanner.Step step,
        BlockPos origin,
        Direction direction
    ) {
        if (step == null || origin == null || direction == null) {
            return false;
        }
        // Water directly below a solid support floor is sealed off from the player. Keep checking
        // horizontal/upper water exposure, but do not reject an otherwise solid stair over water.
        return !origin.equals(step.support()) || direction != Direction.DOWN;
    }

    private boolean shouldIgnoreSealedDescentAdjacentWater(
        MinecraftClient client,
        StaircaseDescentPlanner.Step step,
        BlockPos origin,
        Direction direction,
        BlockPos waterPos
    ) {
        if (client == null || client.world == null || waterPos == null) {
            return false;
        }
        return isSealedDescentAdjacentSupportWater(
            step,
            origin,
            direction,
            waterPos,
            isStableDescentSupport(client, waterPos.up())
        );
    }

    static boolean isSealedDescentAdjacentSupportWater(
        StaircaseDescentPlanner.Step step,
        BlockPos origin,
        Direction direction,
        BlockPos waterPos,
        boolean blockAboveWaterStable
    ) {
        return step != null
            && origin != null
            && direction != null
            && waterPos != null
            && blockAboveWaterStable
            && origin.equals(step.support())
            && direction.getAxis().isHorizontal()
            && waterPos.getY() == step.support().getY();
    }

    // True when a missing-support step is an open-air gap the bot can bridge in place: it has a
    // solid filler block available, the floor cell is genuinely air (not fluid/occupied), a
    // reachable+raycast-clear adjacent face exists to build from, and we are under the per-run
    // bridge budget. Cheap checks first; the face raycast is the only costly part and runs last.
    private boolean canBridgeDescentSupport(
        MinecraftClient client,
        ClientPlayerEntity player,
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        String unsafeReason
    ) {
        if (client == null || client.world == null || player == null || run == null || step == null) {
            return false;
        }
        boolean supportMissing = unsafeReason != null && unsafeReason.startsWith("descent_next_support_missing");
        boolean waterAdjacent = unsafeReason != null && unsafeReason.startsWith("descent_water_adjacent:");
        if (!supportMissing && !waterAdjacent) {
            return false;
        }
        // WATER-SEAL (live runs aborted on this repeatedly): the offending
        // water cell is sealable by the SAME placement flow — water is replaceable, so a top-place
        // onto its (stable) floor fills the cell. Slice 1 is top-seal only; the shared bridge budget
        // bounds pool edges; lava near the seal cell disqualifies as usual.
        if (waterAdjacent) {
            BlockPos sealCell = firstAdjacentWaterBlock(client, step);
            return sealCell != null
                && run.supportBridges < Math.max(DESCENT_MAX_SUPPORT_BRIDGES, run.depth)
                && hasDescentSupportFillerItem(player)
                && firstAdjacentLavaBlock(client, sealCell) == null
                && isStableDescentSupport(client, sealCell.down());
        }
        if (run.supportBridges >= Math.max(DESCENT_MAX_SUPPORT_BRIDGES, run.depth)) {
            logBridgeGateReject(run, step, "bridge_budget_exhausted:" + run.supportBridges);
            return false;
        }
        // Bridge whenever the FLOOR cell is missing. The body cell may be air (open cave mouth) or
        // diggable solid (the L-NOTCH: a floor hole behind a wall — seen in granite and stone,
        // both aborted descent_recovery_exhausted because the old gate demanded an open gap): the
        // support fill is correct in both shapes, and the normal step machinery digs the wall once
        // the floor exists. Only a FLUID body cell disqualifies (never open a face into liquid).
        if (!client.world.getBlockState(step.support()).isAir()) {
            logBridgeGateReject(run, step, "support_not_air:"
                + blockId(client.world.getBlockState(step.support())));
            return false;
        }
        if (!client.world.getBlockState(step.nextFeet()).getFluidState().isEmpty()) {
            logBridgeGateReject(run, step, "gap_fluid:nextFeet="
                + blockId(client.world.getBlockState(step.nextFeet())));
            return false;
        }
        if (!hasDescentSupportFillerItem(player)) {
            logBridgeGateReject(run, step, "no_filler_item");
            return false;
        }
        // Never bridge into a cell touching lava (either mode).
        BlockPos gateLava = firstAdjacentLavaBlock(client, step.support());
        if (gateLava != null) {
            logBridgeGateReject(run, step, "lava_adjacent:" + gateLava.toShortString());
            return false;
        }
        // TOP mode: a solid block directly beneath the gap to place the bridge block on top of.
        if (isStableDescentSupport(client, step.support().down())) {
            return true;
        }
        // SIDE mode (deep gap / cave mouth, a recurring abort family in live runs): the classic player
        // bridge — place the filler against the direction-facing vertical face of the block beneath
        // the bot's OWN standing block (= the gap cell's rear neighbor). Requires that rear block to
        // be solid; placeDescentSupport sneaks to an overhang so the eye-ray clears the edge.
        if (isStableDescentSupport(client, descentSideBridgeSource(step, run.direction))) {
            return true;
        }
        // Column repair (reject side_source_unstable:air): the bot stands on an overhang lip —
        // the side-source cell is itself air with solid one deeper. Eligible: top-place INTO the
        // side-source cell first; the side bridge then proceeds off the repaired block.
        BlockPos gateSideSource = descentSideBridgeSource(step, run.direction);
        if (client.world.getBlockState(gateSideSource).isAir()
            && isStableDescentSupport(client, gateSideSource.down())) {
            return true;
        }
        logBridgeGateReject(run, step, "side_source_unstable:"
            + blockId(client.world.getBlockState(gateSideSource))
            + ":below=" + blockId(client.world.getBlockState(gateSideSource.down())));
        return false;
    }

    // A descent abort (descent_next_support_missing:no_safe_reroute at depth 20 with ZERO bridge
    // attempts) showed the bridge gate declining silently — every rejection now says which
    // predicate failed, throttled, only in the support-missing context that reaches these checks.
    private long nextBridgeGateLogMs = 0L;

    private void logBridgeGateReject(DescentRun run, StaircaseDescentPlanner.Step step, String why) {
        long nowMs = System.currentTimeMillis();
        if (nowMs < nextBridgeGateLogMs) {
            return;
        }
        nextBridgeGateLogMs = nowMs + 1_000L;
        LOGGER.info(
            "descent.bridge_gate_reject instanceId={} commandId={} step={} support={} why={}",
            instanceId,
            run == null ? "" : run.commandId,
            step == null ? -1 : step.index(),
            step == null ? "none" : step.support().toShortString(),
            why
        );
    }

    // The block sharing the direction-facing vertical face with the missing support cell: one cell
    // back toward the bot, i.e. directly beneath the bot's standing block.
    private static BlockPos descentSideBridgeSource(StaircaseDescentPlanner.Step step, StaircaseDescentPlanner.Direction2d direction) {
        return step.support().add(-direction.dx(), 0, -direction.dz());
    }

    // Aim/raycast point for the side bridge: just INSIDE the gap-facing face (0.45 toward it from
    // center) and in the LOWER half of the face (-0.3). Inside matters because the eye is on the
    // SAME side as the face — a point 0.001 outside ends the ray in air and never registers a hit
    // (every attempt died bridge_no_line_of_sight on exactly this). The low bias
    // shrinks the sneak-overhang needed for the ray to clear the standing block's underside from
    // ~0.23 to ~0.14 of the ~0.29 sneak allows.
    private static Vec3d sideBridgeFacePoint(BlockPos sideSource, StaircaseDescentPlanner.Direction2d direction) {
        return Vec3d.ofCenter(sideSource).add(direction.dx() * 0.45D, -0.3D, direction.dz() * 0.45D);
    }

    // Aim/LOS point for the column repair: the gap-side edge region of the repair foundation's TOP
    // face. From the sneak-overhang the eye-ray passes under the standing block's underside and
    // re-enters the bot's own column below it — a centre aim would be occluded by the standing
    // block itself.
    private static Vec3d columnRepairAimPoint(BlockPos repairFoundation, StaircaseDescentPlanner.Direction2d direction) {
        return new Vec3d(
            repairFoundation.getX() + 0.5D + direction.dx() * 0.45D,
            repairFoundation.getY() + 1.0D,
            repairFoundation.getZ() + 0.5D + direction.dz() * 0.45D
        );
    }

    private boolean hasClearLineToDescentColumnRepair(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos repairFoundation,
        StaircaseDescentPlanner.Direction2d direction
    ) {
        if (client == null || client.world == null || player == null || repairFoundation == null || direction == null) {
            return false;
        }
        Vec3d eye = player.getEyePos();
        // End the ray just INSIDE the top face so it crosses the surface and registers the hit
        // (a point outside the face ends the ray in air).
        Vec3d point = columnRepairAimPoint(repairFoundation, direction).add(0.0D, -0.05D, 0.0D);
        double reach = Math.min(TABLE_INTERACTION_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
        if (eye.squaredDistanceTo(point) > reach * reach) {
            return false;
        }
        BlockHitResult hit = client.world.raycast(new RaycastContext(
            eye, point, RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
        return hit != null && hit.getType() == HitResult.Type.BLOCK
            && repairFoundation.equals(hit.getBlockPos())
            && hit.getSide() == Direction.UP;
    }

    // Clear eye-line to the gap-facing vertical face of the side-bridge source block: the raycast
    // must enter exactly that block through exactly that face (sneak-overhang at the edge achieves
    // this — the eye clears the standing block's boundary while sneak prevents falling).
    // Side-bridge aim v2 (descent census 06-12: side-mode LOS timeouts were 8 of the last 10
    // bridge failures): one fixed face point often stays occluded within the sneak overhang the
    // stance allows. Candidates run deepest-low first (least overhang needed), then the original
    // height, then shallower and lateral points — the first whose ray verifiably hits the
    // gap-facing face becomes the aim.
    private Vec3d selectSideBridgeAim(MinecraftClient client, ClientPlayerEntity player, BlockPos sideSource, StaircaseDescentPlanner.Direction2d direction, Direction face) {
        if (client == null || client.world == null || player == null || sideSource == null || direction == null || face == null) {
            return null;
        }
        Vec3d eye = player.getEyePos();
        double reach = Math.min(TABLE_INTERACTION_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
        double[][] offsets = {
            {0.0D, -0.45D, 0.0D},
            {0.0D, -0.3D, 0.0D},
            {0.0D, -0.15D, 0.0D},
            {-direction.dz() * 0.3D, -0.3D, direction.dx() * 0.3D},
            {direction.dz() * 0.3D, -0.3D, -direction.dx() * 0.3D},
        };
        for (double[] o : offsets) {
            Vec3d point = Vec3d.ofCenter(sideSource).add(direction.dx() * 0.45D + o[0], o[1], direction.dz() * 0.45D + o[2]);
            if (eye.squaredDistanceTo(point) > reach * reach) {
                continue;
            }
            BlockHitResult hit = client.world.raycast(new RaycastContext(
                eye, point, RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
            if (hit != null && hit.getType() == HitResult.Type.BLOCK && sideSource.equals(hit.getBlockPos()) && hit.getSide() == face) {
                return point;
            }
        }
        return null;
    }

    private boolean hasClearLineToDescentSideFace(MinecraftClient client, ClientPlayerEntity player, BlockPos sideSource, StaircaseDescentPlanner.Direction2d direction, Direction face) {
        if (client == null || client.world == null || player == null || sideSource == null || direction == null || face == null) {
            return false;
        }
        Vec3d eye = player.getEyePos();
        Vec3d point = sideBridgeFacePoint(sideSource, direction);
        double reach = Math.min(TABLE_INTERACTION_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
        if (eye.squaredDistanceTo(point) > reach * reach) {
            return false;
        }
        BlockHitResult hit = client.world.raycast(new RaycastContext(
            eye, point, RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
        return hit != null && hit.getType() == HitResult.Type.BLOCK && sideSource.equals(hit.getBlockPos()) && hit.getSide() == face;
    }

    private BlockPlaceController.PlaceSpec descentSupportPlaceSpec(ClientPlayerEntity player) {
        if (player == null) {
            return null;
        }
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            String itemId = net.minecraft.registry.Registries.ITEM.getId(stack.getItem()).getPath();
            BlockPlaceController.PlaceSpec spec = descentSupportPlaceSpecForItem(itemId);
            if (spec != null) {
                return spec;
            }
        }
        return null;
    }

    private boolean hasDescentSupportFillerItem(ClientPlayerEntity player) {
        if (player == null) {
            return false;
        }
        int end = Math.min(36, player.getInventory().size());
        for (int slot = 0; slot < end; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty()) {
                continue;
            }
            if (isDescentSupportFillerItem(itemId(stack))) {
                return true;
            }
        }
        return false;
    }

    static BlockPlaceController.PlaceSpec descentSupportPlaceSpecForItem(String itemId) {
        if (!isDescentSupportFillerItem(itemId)) {
            return null;
        }
        String normalized = itemId.trim().toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case "cobblestone" -> BlockPlaceController.PlaceSpec.cobblestone();
            case "dirt" -> BlockPlaceController.PlaceSpec.supportBlock("dirt", Blocks.DIRT);
            case "coarse_dirt" -> BlockPlaceController.PlaceSpec.supportBlock("coarse_dirt", Blocks.COARSE_DIRT);
            case "rooted_dirt" -> BlockPlaceController.PlaceSpec.supportBlock("rooted_dirt", Blocks.ROOTED_DIRT);
            case "oak_planks" -> BlockPlaceController.PlaceSpec.supportBlock("oak_planks", Blocks.OAK_PLANKS);
            case "spruce_planks" -> BlockPlaceController.PlaceSpec.supportBlock("spruce_planks", Blocks.SPRUCE_PLANKS);
            case "birch_planks" -> BlockPlaceController.PlaceSpec.supportBlock("birch_planks", Blocks.BIRCH_PLANKS);
            case "jungle_planks" -> BlockPlaceController.PlaceSpec.supportBlock("jungle_planks", Blocks.JUNGLE_PLANKS);
            case "acacia_planks" -> BlockPlaceController.PlaceSpec.supportBlock("acacia_planks", Blocks.ACACIA_PLANKS);
            case "dark_oak_planks" -> BlockPlaceController.PlaceSpec.supportBlock("dark_oak_planks", Blocks.DARK_OAK_PLANKS);
            case "mangrove_planks" -> BlockPlaceController.PlaceSpec.supportBlock("mangrove_planks", Blocks.MANGROVE_PLANKS);
            case "cherry_planks" -> BlockPlaceController.PlaceSpec.supportBlock("cherry_planks", Blocks.CHERRY_PLANKS);
            case "bamboo_planks" -> BlockPlaceController.PlaceSpec.supportBlock("bamboo_planks", Blocks.BAMBOO_PLANKS);
            case "crimson_planks" -> BlockPlaceController.PlaceSpec.supportBlock("crimson_planks", Blocks.CRIMSON_PLANKS);
            case "warped_planks" -> BlockPlaceController.PlaceSpec.supportBlock("warped_planks", Blocks.WARPED_PLANKS);
            default -> null;
        };
    }

    static boolean isDescentSupportFillerItem(String itemId) {
        if (itemId == null) {
            return false;
        }
        return switch (itemId.trim().toLowerCase(Locale.ROOT)) {
            case "cobblestone",
                "dirt",
                "coarse_dirt",
                "rooted_dirt",
                "oak_planks",
                "spruce_planks",
                "birch_planks",
                "jungle_planks",
                "acacia_planks",
                "dark_oak_planks",
                "mangrove_planks",
                "cherry_planks",
                "bamboo_planks",
                "crimson_planks",
                "warped_planks" -> true;
            default -> false;
        };
    }

    // Confirm the bot can see/reach the foundation block from its current eye position. Raycasts to
    // the block CENTRE (so the ray enters the block rather than stopping just above its top face, the
    // way an offset face-point would when looking steeply down from above) and requires the first hit
    // to be the foundation within interaction reach. Rejects gaps walled off by unbroken blocks and
    // avoids committing to a placement that would otherwise stall the run waiting for an unreachable face.
    private boolean hasClearLineToDescentFoundation(MinecraftClient client, ClientPlayerEntity player, BlockPos foundation) {
        if (client == null || client.world == null || player == null || foundation == null) {
            return false;
        }
        Vec3d eye = player.getEyePos();
        Vec3d center = Vec3d.ofCenter(foundation);
        double reach = Math.min(TABLE_INTERACTION_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
        if (eye.squaredDistanceTo(center) > reach * reach) {
            return false;
        }
        BlockHitResult hit = client.world.raycast(new RaycastContext(
            eye, center, RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
        return hit != null && hit.getType() == HitResult.Type.BLOCK && foundation.equals(hit.getBlockPos());
    }

    // Bridge a missing descent support by placing a solid filler block in the open floor cell (step.support()),
    // reusing the proven BlockPlaceController. The bot's own step occludes a steep downward view of the
    // block below the gap, so we first sneak to the gap edge (sneak prevents stepping off) until the
    // line of sight clears, then place ON TOP of that block (supportOverride = step.support().down())
    // so the new block lands in the missing floor cell. On success the next tick re-evaluates the same
    // step with a solid floor; if we cannot get a clear line / a placement face, we reroute/fail.
    private ControlDecision placeDescentSupport(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        DescentRun run,
        StaircaseDescentPlanner.Step step,
        long nowMs,
        String reason
    ) {
        BlockPos supportCell = step.support();
        BlockPos foundation = supportCell.down();
        BlockPlaceController.PlaceSpec supportSpec = descentSupportPlaceSpec(player);
        if (supportSpec == null) {
            int hotbarMove = moveInventoryItemToHotbar(
                client,
                player,
                McbotFabricClient::isDescentSupportFillerItem,
                run.commandId,
                "descent_support"
            );
            if (hotbarMove >= 0 || hotbarMove == -2) {
                return new ControlDecision(stopFrom(effective, "descent_support_hotbar_move:" + step.index()), InputState.stop());
            }
            return rerouteOrFailDescent(effective, client, run, step, nowMs, reason + ":bridge_no_support_block_hotbar");
        }
        String commandId = run.commandId + ":support:" + step.index();
        boolean awaitingVerification = blockPlaceController.isAwaitingVerification(commandId);
        // Hold sneak while at the gap edge so aiming/placing never walks the bot off into the gap.
        InputState sneakStop = new InputState(false, false, false, false, false, true, 0.0F, 0.0F);

        // WATER-SEAL: for descent_water_adjacent the placement target IS the water cell — placing
        // against any solid neighbor face that points into it replaces the water. v2 (from
        // the first live seal: the bot's eye sits nearly LEVEL with the underwater floor's top
        // face, so the top-only ray grazed the lip and never connected): try the floor face first,
        // then the four horizontal neighbor faces — first face with a verified raycast hit wins,
        // the use_bed candidate lesson applied to placement.
        boolean waterSeal = reason != null && reason.startsWith("descent_water_adjacent:");
        Vec3d sealAim = null;
        if (waterSeal) {
            BlockPos sealCell = firstAdjacentWaterBlock(client, step);
            if (sealCell == null) {
                // Water gone (current shifted / already sealed): let the step re-evaluate.
                return new ControlDecision(stopFrom(effective, "descent_water_seal_clear"), InputState.stop());
            }
            supportCell = sealCell;
            foundation = null;
            BlockPos[] sealNeighbors = {
                sealCell.down(), sealCell.north(), sealCell.south(), sealCell.east(), sealCell.west()
            };
            for (BlockPos neighbor : sealNeighbors) {
                BlockState neighborState = client.world.getBlockState(neighbor);
                if (neighborState.getCollisionShape(client.world, neighbor).isEmpty()
                    || isHazardBlockState(neighborState)) {
                    continue;
                }
                // Shared-face centre, endpoint 0.05 INSIDE the neighbor (a point
                // outside the block ends the ray in air/water and never registers).
                Vec3d toSeal = new Vec3d(
                    sealCell.getX() - neighbor.getX(),
                    sealCell.getY() - neighbor.getY(),
                    sealCell.getZ() - neighbor.getZ());
                Vec3d candidate = new Vec3d(
                    neighbor.getX() + 0.5D + toSeal.x * 0.45D,
                    neighbor.getY() + 0.5D + toSeal.y * 0.45D,
                    neighbor.getZ() + 0.5D + toSeal.z * 0.45D);
                BlockHitResult sealHit = client.world.raycast(new RaycastContext(
                    player.getEyePos(), candidate,
                    RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
                if (sealHit != null && sealHit.getType() == HitResult.Type.BLOCK
                    && neighbor.equals(sealHit.getBlockPos())) {
                    foundation = neighbor;
                    sealAim = candidate;
                    break;
                }
            }
            if (foundation == null) {
                // No clickable face from this stance: keep the old floor-top behavior and let the
                // sneak-nudge hunt for it (the pre-v2 path).
                foundation = sealCell.down();
            }
        }
        // SIDE mode engages when the gap has no foundation directly beneath it (deep cave mouth):
        // bridge off the vertical face of the block under the bot's own standing block instead.
        // COLUMN-REPAIR mode engages when even that block is air (overhang lip): top-place into the
        // side-source cell first; the side bridge proceeds off the repaired block on a later tick.
        boolean sideBridge = !waterSeal && !isStableDescentSupport(client, foundation);
        BlockPos sideSource = sideBridge ? descentSideBridgeSource(step, run.direction) : null;
        Direction sideFace = sideBridge
            ? Direction.fromVector(run.direction.dx(), 0, run.direction.dz())
            : null;
        if (sideBridge && (sideSource == null || sideFace == null)) {
            return rerouteOrFailDescent(effective, client, run, step, nowMs, reason + ":bridge_side_invalid");
        }
        boolean columnRepair = sideBridge
            && !isStableDescentSupport(client, sideSource)
            && client.world.getBlockState(sideSource).isAir()
            && isStableDescentSupport(client, sideSource.down());

        // TOP mode tries the face centre first, then a near-edge point biased toward the player
        // (both LOS timeouts in live runs were TOP mode on steep faces — the gap walls occlude the
        // centre from the sneak stance; the near edge stays visible). The passing candidate becomes
        // the aim, so the placer's look-ray crosses the same point.
        Vec3d topAim = null;
        if (!sideBridge && !columnRepair) {
            Vec3d center = new Vec3d(foundation.getX() + 0.5D, foundation.getY() + 1.0D, foundation.getZ() + 0.5D);
            if (waterSeal && sealAim != null) {
                // Seal v2: the verified neighbor-face candidate IS the aim (raycast-checked above).
                topAim = sealAim;
            } else if (hasClearLineToDescentFoundation(client, player, foundation)) {
                topAim = center;
            } else {
                Vec3d towardPlayer = new Vec3d(
                    player.getX() - (foundation.getX() + 0.5D), 0.0D, player.getZ() - (foundation.getZ() + 0.5D));
                if (towardPlayer.lengthSquared() > 1.0E-4D) {
                    towardPlayer = towardPlayer.normalize();
                    Vec3d nearEdge = new Vec3d(
                        foundation.getX() + 0.5D + towardPlayer.x * 0.45D,
                        foundation.getY() + 0.95D,
                        foundation.getZ() + 0.5D + towardPlayer.z * 0.45D
                    );
                    BlockHitResult edgeHit = client.world.raycast(new RaycastContext(
                        player.getEyePos(), nearEdge,
                        RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
                    if (edgeHit != null && edgeHit.getType() == HitResult.Type.BLOCK
                        && foundation.equals(edgeHit.getBlockPos())
                        && edgeHit.getSide() == Direction.UP) {
                        topAim = nearEdge;
                    }
                }
            }
        }
        Vec3d sideAim = (sideBridge && !columnRepair)
            ? selectSideBridgeAim(client, player, sideSource, run.direction, sideFace)
            : null;
        boolean lineClear = columnRepair
            ? hasClearLineToDescentColumnRepair(client, player, sideSource.down(), run.direction)
            : sideBridge
                ? sideAim != null
                : topAim != null;
        if (!awaitingVerification && !lineClear) {
            if (run.bridgeNudgeStartedAtMs == 0L) {
                run.bridgeNudgeStartedAtMs = nowMs;
            }
            if (nowMs - run.bridgeNudgeStartedAtMs > DESCENT_BRIDGE_NUDGE_TIMEOUT_MS) {
                run.bridgeNudgeStartedAtMs = 0L;
                String losMode = waterSeal ? "seal" : columnRepair ? "repair" : sideBridge ? "side" : "top";
                return rerouteOrFailDescent(effective, client, run, step, nowMs, reason + ":bridge_no_line_of_sight:" + losMode);
            }
            // Sneak-shuffle toward the gap (look at the target, walk forward under sneak; sneak
            // lets the eye overhang the edge without falling — required for the side face).
            Vec3d nudgeTarget = columnRepair
                ? columnRepairAimPoint(sideSource.down(), run.direction)
                : sideBridge
                    ? sideBridgeFacePoint(sideSource, run.direction)
                    : Vec3d.ofCenter(foundation);
            LookAngles edgeLook = lookAnglesToPoint(player, nudgeTarget);
            InputState sneakForward = new InputState(true, false, false, false, false, true, 1.0F, 0.0F);
            return new ControlDecision(
                lookIntentForAngles(effective, edgeLook.yaw(), edgeLook.pitch(), "descent_support_edge:" + step.index()),
                sneakForward
            );
        }
        run.bridgeNudgeStartedAtMs = 0L;

        // TOP mode: aim at the centre of the foundation's top face (placement resolves to the gap
        // cell above via supportOverride). SIDE mode: aim at the gap-facing vertical face of the
        // side source; the generic raycast place path resolves hitBlock.offset(face) = the gap cell.
        // REPAIR mode: aim at the gap-side edge of the repair foundation's top face (centre aim
        // would be occluded by the bot's own standing block).
        Vec3d aimPoint = columnRepair
            ? columnRepairAimPoint(sideSource.down(), run.direction)
            : sideBridge
                ? (sideAim != null ? sideAim : sideBridgeFacePoint(sideSource, run.direction))
                : (topAim != null
                    ? topAim
                    : new Vec3d(foundation.getX() + 0.5D, foundation.getY() + 1.0D, foundation.getZ() + 0.5D));
        LookAngles placeLook = lookAnglesToPoint(player, aimPoint);
        boolean lookAligned = Math.abs(LookController.normalizeYaw(placeLook.yaw() - player.getYaw())) <= WORKSTATION_PLACE_LOOK_TOLERANCE_DEG
            && Math.abs(placeLook.pitch() - player.getPitch()) <= WORKSTATION_PLACE_LOOK_TOLERANCE_DEG;
        if (!awaitingVerification && !lookAligned) {
            return new ControlDecision(
                lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "descent_support_face:" + step.index()),
                sneakStop
            );
        }

        BlockPlaceController.Result result = blockPlaceController.tick(
            client, player, commandId, nowMs,
            columnRepair ? sideSource.down() : sideBridge ? null : foundation,
            supportSpec);
        LOGGER.info(
            "descent.place_support instanceId={} commandId={} step={} supportCell={} foundation={} status={} reason={} placedBlock={} selectedItem={} bridges={} elapsedMs={}",
            instanceId,
            run.commandId,
            step.index(),
            supportCell.toShortString(),
            columnRepair ? "repair:" + sideSource.toShortString()
                : sideBridge ? "side:" + sideSource.toShortString()
                : (waterSeal ? "seal:" : "top:") + foundation.toShortString(),
            result.status(),
            result.reason(),
            formatBlockPos(result.placedBlock()),
            selectedItemId(player),
            run.supportBridges,
            result.elapsedMs()
        );
        if (result.status() == BlockPlaceController.Status.PLACED) {
            if (columnRepair) {
                // The repair block must land in the side-source cell; the step support is STILL
                // missing afterwards — the planner re-enters next tick and the side bridge proceeds
                // off the repaired block.
                if (!sideSource.equals(result.placedBlock())) {
                    return rerouteOrFailDescent(effective, client, run, step, nowMs, reason + ":bridge_repair_misplaced");
                }
                run.supportBridges++;
                return new ControlDecision(stopFrom(effective, "descent_support_column_repaired:" + step.index()), sneakStop);
            }
            // SIDE mode places via the generic raycast path, so verify the block actually landed in
            // the gap cell; a drifted aim placing elsewhere must not count as a bridge.
            if (sideBridge && !supportCell.equals(result.placedBlock())) {
                return rerouteOrFailDescent(effective, client, run, step, nowMs, reason + ":bridge_side_misplaced");
            }
            run.supportBridges++;
            return new ControlDecision(stopFrom(effective, "descent_support_placed:" + step.index()), sneakStop);
        }
        if (result.status() == BlockPlaceController.Status.FAILED) {
            return rerouteOrFailDescent(effective, client, run, step, nowMs, reason + ":bridge_failed:" + result.reason());
        }
        return new ControlDecision(
            lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "descent_support_placing:" + result.reason()),
            sneakStop
        );
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
        DescentHazardMemory.HazardMarker rejectedHazard = DescentHazardMemory.parseRejectedStepHazard(reason);
        if (rejectedHazard != null) {
            run.rejectedHazards.add(rejectedHazard);
        }
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
        clearDescentMoveProgress(run);
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
        return !StaircaseDescentPlanner.targetsSelfSupport(candidate)
            && descentStepUnsafeReason(client, candidate) == null
            && !DescentHazardMemory.candidateTooCloseToKnownHazard(candidate, run.rejectedHazards);
    }

    private String descentMoveKey(BlockPos feet, StaircaseDescentPlanner.Direction2d direction) {
        return feet.toShortString() + ":" + direction.name();
    }

    @Override
    public boolean isHazardBlockState(BlockState state) {
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
        lastCompletedDescentPath = List.copyOf(run.reachedFeet);
        brainLink.completeCurrentCommand(run.commandId, "descent_complete:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, "descent_complete:" + reason), InputState.stop());
    }

    private ControlDecision failDescent(BrainLink.Intent effective, DescentRun run, long nowMs, String reason) {
        finishedDescentCommandReasons.put(run.commandId, "descent_failed:" + reason);
        // Retry-rotation memory: a follow-up descend near this point takes a 90-degree
        // rotated heading instead of re-digging the same line into the same cavern.
        lastDescentFailurePos = run.startFeet;
        lastDescentFailureAtMs = nowMs;
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
        InventoryCounter.InventoryCobblestoneSnapshot inventory = InventoryCounter.countPlayerCobblestone(player);
        if (activeMineNearbyStone == null || !commandId.equals(activeMineNearbyStone.commandId)) {
            clearNavigationState();
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
        if (run.collectStartedAtMs > 0L) {
            if (nowMs - run.collectStartedAtMs < GATHER_PICKUP_SETTLE_MS) {
                return new ControlDecision(stopFrom(effective, "mine_nearby_stone_wait_pickup"), InputState.stop());
            }
            if (run.collectBaselineCobblestone >= 0 && inventory.cobblestoneCount() > run.collectBaselineCobblestone) {
                LOGGER.info(
                    "mine_nearby_stone.collect_inventory_delta instanceId={} commandId={} inventoryCobblestoneBefore={} inventoryCobblestoneAfter={} lastBrokenTarget={}",
                    instanceId,
                    commandId,
                    run.collectBaselineCobblestone,
                    inventory.cobblestoneCount(),
                    formatBlockPos(run.lastBrokenTarget)
                );
                run.collectStartedAtMs = 0L;
                run.collectBaselineCobblestone = -1;
                run.lastBrokenTarget = null;
                clearNav3dDriveState();
                return new ControlDecision(stopFrom(effective, "mine_nearby_stone_collect_inventory_delta"), InputState.stop());
            }
            Vec3d droppedCobblestone = nearestDroppedItemPosition(
                client,
                player,
                run.lastBrokenTarget == null ? player.getBlockPos() : run.lastBrokenTarget,
                (stack, itemId) -> InventoryCounter.isCobblestoneItemId(itemId)
            );
            if (droppedCobblestone != null && nowMs - run.collectStartedAtMs > GATHER_COLLECT_TIMEOUT_MS) {
                LOGGER.warn(
                    "mine_nearby_stone.collect_timeout instanceId={} commandId={} visibleDrop=true itemX={} itemY={} itemZ={} inventoryCobblestoneBefore={} inventoryCobblestoneAfter={} lastBrokenTarget={}",
                    instanceId,
                    commandId,
                    roundForLog(droppedCobblestone.x),
                    roundForLog(droppedCobblestone.y),
                    roundForLog(droppedCobblestone.z),
                    run.collectBaselineCobblestone,
                    inventory.cobblestoneCount(),
                    formatBlockPos(run.lastBrokenTarget)
                );
                clearNavigationState();
                run.collectStartedAtMs = 0L;
                run.collectBaselineCobblestone = -1;
                run.lastBrokenTarget = null;
                clearNav3dDriveState();
                return new ControlDecision(stopFrom(effective, "mine_nearby_stone_collect_timeout"), InputState.stop());
            }
            if (droppedCobblestone != null) {
                String collectItemLogKey = "mine-nearby-stone:" + commandId + ":" + roundForLog(droppedCobblestone.x)
                    + ":" + roundForLog(droppedCobblestone.y) + ":" + roundForLog(droppedCobblestone.z);
                if (!collectItemLogKey.equals(run.lastCollectItemLogKey)
                    || nowMs - run.lastCollectItemLogAtMs >= COLLECT_TARGET_LOG_INTERVAL_MS) {
                    LOGGER.info(
                        "mine_nearby_stone.collect_item_target instanceId={} commandId={} itemX={} itemY={} itemZ={}",
                        instanceId,
                        commandId,
                        roundForLog(droppedCobblestone.x),
                        roundForLog(droppedCobblestone.y),
                        roundForLog(droppedCobblestone.z)
                    );
                    run.lastCollectItemLogKey = collectItemLogKey;
                    run.lastCollectItemLogAtMs = nowMs;
                }
                double collectDx = droppedCobblestone.x - player.getX();
                double collectDz = droppedCobblestone.z - player.getZ();
                double horizontalDistance = Math.hypot(collectDx, collectDz);
                double verticalDistance = Math.abs(droppedCobblestone.y - player.getY());
                boolean upwardPickup = droppedCobblestone.y > player.getY() + DIRECT_COLLECT_UPWARD_JUMP_Y_DELTA;
                boolean belowPickupHeight = droppedCobblestone.y < player.getY() - DIRECT_COLLECT_VERTICAL_DROP_APPROACH_Y_DELTA;
                boolean lowerDropDirectReachable = !belowPickupHeight
                    || verticalDistance <= DIRECT_COLLECT_VERTICAL_DROP_MAX_DIRECT_Y_DELTA;
                boolean directCollectEligible = lowerDropDirectReachable
                    && verticalDistance <= COLLECT_DIRECT_APPROACH_MAX_RISE
                    && (horizontalDistance <= MINE_NEARBY_STONE_DIRECT_COLLECT_DISTANCE
                        || belowPickupHeight && horizontalDistance <= COLLECT_DIRECT_APPROACH_RADIUS);
                if (directCollectEligible) {
                    LookAngles collectLook = directCollectApproachLook(player, droppedCobblestone, belowPickupHeight);
                    boolean forward = horizontalDistance > DIRECT_COLLECT_ARRIVE_DISTANCE
                        || belowPickupHeight && horizontalDistance > DIRECT_COLLECT_VERTICAL_DROP_MIN_HORIZONTAL
                        || upwardPickup && horizontalDistance > DIRECT_COLLECT_VERTICAL_DROP_MIN_HORIZONTAL;
                    boolean collectJump = upwardPickup;
                    String directCollectLogKey = collectItemLogKey + ":" + roundForLog(horizontalDistance)
                        + ":" + roundForLog(verticalDistance) + ":" + belowPickupHeight + ":" + forward + ":" + collectJump;
                    if (!directCollectLogKey.equals(run.lastDirectCollectLogKey)
                        || nowMs - run.lastDirectCollectLogAtMs >= DIRECT_COLLECT_LOG_INTERVAL_MS) {
                        LOGGER.info(
                            "mine_nearby_stone.direct_collect instanceId={} commandId={} itemX={} itemY={} itemZ={} distance={} yDelta={} belowPickupHeight={} forward={} jump={}",
                            instanceId,
                            commandId,
                            roundForLog(droppedCobblestone.x),
                            roundForLog(droppedCobblestone.y),
                            roundForLog(droppedCobblestone.z),
                            roundForLog(horizontalDistance),
                            roundForLog(verticalDistance),
                            belowPickupHeight,
                            forward,
                            collectJump
                        );
                        run.lastDirectCollectLogKey = directCollectLogKey;
                        run.lastDirectCollectLogAtMs = nowMs;
                    }
                    InputState collectInput = new InputState(forward, false, false, false, collectJump, false, forward ? 1.0F : 0.0F, 0.0F);
                    BrainLink.Intent collectDirect = lookIntentForAngles(
                        effective, collectLook.yaw(), collectLook.pitch(), "mine_nearby_stone_collect_direct");
                    return new ControlDecision(collectDirect, collectInput);
                }
                if (shouldUseMineNearbyStoneNav3dCollect(player.getY(), droppedCobblestone.y)) {
                    ControlDecision nav3dCollect = tryNav3dDriveToward(
                        client,
                        player,
                        effective,
                        droppedCobblestone,
                        "mine_nearby_stone_collect",
                        commandId,
                        nowMs
                    );
                    if (nav3dCollect != null) {
                        return nav3dCollect;
                    }
                }
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
            run.collectBaselineCobblestone = -1;
            run.lastBrokenTarget = null;
            clearNav3dDriveState();
        }

        if (!player.isOnGround()) {
            return new ControlDecision(stopFrom(effective, "mine_nearby_stone_waiting_on_ground"), InputState.stop());
        }

        if (run.descentFallbackActive) {
            return resolveMineNearbyStoneDescentFallback(client, player, effective, run, inventory, nowMs);
        }

        if (run.currentTarget != null) {
            BlockState currentTargetState = client.world.getBlockState(run.currentTarget);
            if (run.currentTargetDropsCobblestone) {
                MineNearbyStoneTargetPlanner.Decision currentTargetDecision = MineNearbyStoneTargetPlanner.decideCurrentTarget(
                    true,
                    isMineNearbyCobblestoneSource(currentTargetState)
                );
                if (currentTargetDecision.action() == MineNearbyStoneTargetPlanner.Action.TARGET_CLEARED) {
                    BlockPos completedTarget = run.currentTarget;
                    run.lastBrokenTarget = completedTarget;
                    run.currentTarget = null;
                    run.currentTargetDropsCobblestone = true;
                    clearMineNearbyStoneApproach(run);
                    run.collectStartedAtMs = nowMs;
                    run.collectBaselineCobblestone = run.targetBaselineCobblestone >= 0 ? run.targetBaselineCobblestone : inventory.cobblestoneCount();
                    run.targetBaselineCobblestone = -1;
                    LOGGER.info(
                        "mine_nearby_stone.target_cleared instanceId={} commandId={} target={} reason={} blockId={} inventoryCobblestoneDelta={}",
                        instanceId,
                        commandId,
                        completedTarget.toShortString(),
                        currentTargetDecision.reason(),
                        blockId(currentTargetState),
                        delta
                    );
                    return new ControlDecision(stopFrom(effective, currentTargetDecision.reason()), InputState.stop());
                }
            } else if (!isMineNearbyStoneProbeBlock(currentTargetState)) {
                BlockPos completedTarget = run.currentTarget;
                if (currentTargetState.isAir()) {
                    recordMineNearbyStoneProbeCleared(run, completedTarget);
                }
                run.currentTarget = null;
                run.currentTargetDropsCobblestone = true;
                clearMineNearbyStoneApproach(run);
                run.targetBaselineCobblestone = -1;
                LOGGER.info(
                    "mine_nearby_stone.probe_cleared instanceId={} commandId={} target={} blockId={} probeBlocksBroken={}",
                    instanceId,
                    commandId,
                    completedTarget.toShortString(),
                    blockId(currentTargetState),
                    run.probeBlocksBroken
                );
                return new ControlDecision(stopFrom(effective, "mine_nearby_stone_probe_cleared"), InputState.stop());
            }
        }

        if (run.currentTarget == null) {
            run.currentTarget = selectVisibleStoneTarget(client, player, run.abandonedTargets);
            if (run.currentTarget == null) {
                MineNearbyStoneApproachPlan exposedPlan = selectApproachableExposedStoneTarget(client, player, run);
                if (exposedPlan != null) {
                    run.currentTarget = exposedPlan.target();
                    run.currentTargetDropsCobblestone = true;
                    run.currentAdjacentCell = exposedPlan.cell();
                    run.currentAdjacentRoute = exposedPlan.route();
                    run.currentAdjacentReached = false;
                    run.currentAdjacentProgress.reset();
                    LOGGER.info(
                        "mine_nearby_stone.approach_selected instanceId={} commandId={} target={} adjacent={} routeLength={} reason={} probeBlocksBroken={}",
                        instanceId,
                        commandId,
                        run.currentTarget.toShortString(),
                        run.currentAdjacentCell,
                        run.currentAdjacentRoute.size(),
                        exposedPlan.reason(),
                        run.probeBlocksBroken
                    );
                }
            }
            if (run.currentTarget == null) {
                if (shouldStartMineNearbyStoneDescentFallback(
                    run.probeBlocksBroken,
                    run.probeBreakFailures,
                    run.descentFallbacks,
                    run.currentTarget != null,
                    isMissionCommandId(run.commandId)
                )) {
                    return startMineNearbyStoneDescentFallback(
                        client,
                        player,
                        effective,
                        run,
                        inventory,
                        nowMs,
                        mineNearbyStoneDescentFallbackReason(run.probeBlocksBroken, run.probeBreakFailures, isMissionCommandId(run.commandId))
                    );
                }
                if (mineNearbyStoneProbeAttempts(run.probeBlocksBroken, run.probeBreakFailures) >= NEARBY_STONE_PROBE_MAX_BLOCKS) {
                    ControlDecision fallback = startMineNearbyStoneDescentFallback(
                        client,
                        player,
                        effective,
                        run,
                        inventory,
                        nowMs,
                        "probe_exhausted"
                    );
                    if (fallback != null) {
                        return fallback;
                    }
                    return failMineNearbyStone(effective, run, inventory, nowMs, "mine_nearby_stone_probe_exhausted");
                }
                String probeSource = "new_column";
                if (run.activeProbeColumn != null) {
                    run.currentTarget = selectStoneProbeTargetInColumn(client, player, run.activeProbeColumn, run.abandonedTargets);
                    if (run.currentTarget == null) {
                        run.exhaustedProbeColumns.add(run.activeProbeColumn);
                        run.activeProbeColumn = null;
                        run.activeProbeColumnClears = 0;
                    } else {
                        probeSource = "active_column";
                    }
                }
                if (run.currentTarget == null) {
                    run.currentTarget = selectStoneProbeTarget(client, player, run.abandonedTargets, run.exhaustedProbeColumns);
                    if (run.currentTarget != null) {
                        run.activeProbeColumn = probeColumn(run.currentTarget);
                        run.activeProbeColumnClears = 0;
                    }
                }
                run.currentTargetDropsCobblestone = false;
                if (run.currentTarget == null) {
                    ControlDecision fallback = startMineNearbyStoneDescentFallback(
                        client,
                        player,
                        effective,
                        run,
                        inventory,
                        nowMs,
                        "no_visible_probe"
                    );
                    if (fallback != null) {
                        return fallback;
                    }
                    return failMineNearbyStone(effective, run, inventory, nowMs, "mine_nearby_stone_no_visible_stone");
                }
                LOGGER.info(
                    "mine_nearby_stone.probe_selected instanceId={} commandId={} target={} source={} column={} columnClears={} probeBlocksBroken={} probeBreakFailures={} probeAttempts={}",
                    instanceId,
                    commandId,
                    run.currentTarget.toShortString(),
                    probeSource,
                    run.activeProbeColumn,
                    run.activeProbeColumnClears,
                    run.probeBlocksBroken,
                    run.probeBreakFailures,
                    mineNearbyStoneProbeAttempts(run.probeBlocksBroken, run.probeBreakFailures)
                );
            } else {
                if (run.currentAdjacentCell == null) {
                    clearMineNearbyStoneApproach(run);
                }
                run.currentTargetDropsCobblestone = true;
                LOGGER.info(
                    "mine_nearby_stone.target_selected instanceId={} commandId={} target={} inventoryCobblestoneDelta={}",
                    instanceId,
                    commandId,
                    run.currentTarget.toShortString(),
                    delta
                );
            }
            run.targetBaselineCobblestone = inventory.cobblestoneCount();
        }

        if (run.currentTargetDropsCobblestone) {
            int pickaxeSlot = findStoneMiningPickaxeHotbarSlot(player);
            if (pickaxeSlot < 0) {
                int hotbarMove = moveStoneMiningPickaxeToHotbar(client, player, commandId, "mine_nearby_stone");
                if (hotbarMove >= 0 || hotbarMove == -2) {
                    return new ControlDecision(stopFrom(effective, "mine_nearby_stone_hotbar_move"), InputState.stop());
                }
                return failMineNearbyStone(effective, run, inventory, nowMs, "mine_nearby_stone_no_pickaxe_hotbar");
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
        }

        BlockPos target = run.currentTarget;
        if (run.currentTargetDropsCobblestone && run.currentAdjacentCell != null) {
            ControlDecision nav = navigateToMineNearbyStoneAdjacentCell(client, player, effective, run, nowMs);
            if (nav != null) {
                return nav;
            }
        }
        Vec3d targetAimPoint = visibleBlockAimPoint(client, player, target);
        if (targetAimPoint == null) {
            run.abandonedTargets.add(target);
            run.currentTarget = null;
            run.currentTargetDropsCobblestone = true;
            clearMineNearbyStoneApproach(run);
            run.targetBaselineCobblestone = -1;
            return new ControlDecision(stopFrom(effective, "mine_nearby_stone_reselect:not_visible"), InputState.stop());
        }
        if (!isLookRaycastHittingBlock(client, player, target)) {
            return new ControlDecision(lookIntentForPoint(effective, player, targetAimPoint, "mine_nearby_stone_face"), InputState.stop());
        }
        long breakTimeoutMs = mineNearbyStoneBreakTimeoutMs(run.currentTargetDropsCobblestone);
        BlockBreakController.Result result =
            blockBreakController.tick(client, player, target, commandId + ":nearstone", nowMs, false, breakTimeoutMs);
        logBlockBreakResult(commandId + ":nearstone", target, result);
        logMineNearbyStoneBreakProgress(run, commandId, target, client.world.getBlockState(target), selectedItemId(player), breakTimeoutMs, result, nowMs);
        if (result.status() == BlockBreakController.Status.BROKEN) {
            if (!run.currentTargetDropsCobblestone) {
                recordMineNearbyStoneProbeCleared(run, target);
                run.currentTarget = null;
                run.currentTargetDropsCobblestone = true;
                clearMineNearbyStoneApproach(run);
                run.targetBaselineCobblestone = -1;
                return new ControlDecision(stopFrom(effective, "mine_nearby_stone_probe_break_done"), InputState.stop());
            }
            run.lastBrokenTarget = target;
            run.currentTarget = null;
            run.currentTargetDropsCobblestone = true;
            clearMineNearbyStoneApproach(run);
            run.collectStartedAtMs = nowMs;
            run.collectBaselineCobblestone = run.targetBaselineCobblestone >= 0 ? run.targetBaselineCobblestone : inventory.cobblestoneCount();
            run.targetBaselineCobblestone = -1;
            return new ControlDecision(stopFrom(effective, "mine_nearby_stone_break_done"), InputState.stop());
        }
        if (result.status() == BlockBreakController.Status.REPOSITION) {
            ControlDecision occluderRetarget = maybeRetargetMineNearbyStoneVisibleOccluder(
                client,
                player,
                effective,
                run,
                target,
                result,
                inventory.cobblestoneCount()
            );
            if (occluderRetarget != null) {
                return occluderRetarget;
            }
            run.abandonedTargets.add(target);
            run.currentTarget = null;
            run.currentTargetDropsCobblestone = true;
            clearMineNearbyStoneApproach(run);
            run.targetBaselineCobblestone = -1;
            return new ControlDecision(stopFrom(effective, "mine_nearby_stone_reselect:" + result.reason()), InputState.stop());
        }
        if (result.status() == BlockBreakController.Status.FAILED) {
            if (!run.currentTargetDropsCobblestone) {
                recordMineNearbyStoneProbeFailed(run, target);
                run.currentTarget = null;
                run.currentTargetDropsCobblestone = true;
                clearMineNearbyStoneApproach(run);
                run.targetBaselineCobblestone = -1;
                if (shouldStartMineNearbyStoneDescentFallback(
                    run.probeBlocksBroken,
                    run.probeBreakFailures,
                    run.descentFallbacks,
                    false,
                    isMissionCommandId(run.commandId)
                )) {
                    return startMineNearbyStoneDescentFallback(
                        client,
                        player,
                        effective,
                        run,
                        inventory,
                        nowMs,
                        mineNearbyStoneDescentFallbackReason(run.probeBlocksBroken, run.probeBreakFailures, isMissionCommandId(run.commandId))
                    );
                }
                return new ControlDecision(stopFrom(effective, "mine_nearby_stone_probe_failed:" + result.reason()), InputState.stop());
            }
            run.abandonedTargets.add(target);
            run.currentTarget = null;
            run.currentTargetDropsCobblestone = true;
            clearMineNearbyStoneApproach(run);
            run.targetBaselineCobblestone = -1;
            return new ControlDecision(stopFrom(effective, "mine_nearby_stone_reselect_failed:" + result.reason()), InputState.stop());
        }
        return new ControlDecision(lookIntentForBlock(effective, player, target, "mine_nearby_stone_breaking:" + result.reason()), InputState.stop());
    }

    private ControlDecision maybeRetargetMineNearbyStoneVisibleOccluder(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        MineNearbyStoneRun run,
        BlockPos target,
        BlockBreakController.Result result,
        int baselineCobblestone
    ) {
        if (client == null
            || client.world == null
            || player == null
            || run == null
            || target == null
            || result == null
            || result.hitBlock() == null
            || !"raycast_occluded_reposition".equals(result.reason())) {
            return null;
        }
        BlockPos occluder = result.hitBlock().toImmutable();
        if (occluder.equals(target)
            || occluder.equals(player.getBlockPos().down())
            || run.abandonedTargets.contains(occluder)) {
            return null;
        }
        BlockState state = client.world.getBlockState(occluder);
        boolean dropsCobblestone = isMineNearbyCobblestoneSource(state);
        boolean probeBlock = !dropsCobblestone && isMineNearbyStoneProbeBlock(state);
        if (!dropsCobblestone && !probeBlock) {
            return null;
        }
        if (probeBlock && run.probeBlocksBroken >= NEARBY_STONE_PROBE_MAX_BLOCKS) {
            return null;
        }
            if (!BlockBreakController.withinReach(player.getEyePos(), occluder, TABLE_INTERACTION_REACH_BLOCKS)) {
            return null;
        }
        GridCell previousProbeColumn = run.activeProbeColumn;
        run.currentTarget = occluder;
        run.currentTargetDropsCobblestone = dropsCobblestone;
        clearMineNearbyStoneApproach(run);
        run.targetBaselineCobblestone = baselineCobblestone;
        if (probeBlock) {
            GridCell column = probeColumn(occluder);
            run.activeProbeColumn = column;
            if (!column.equals(previousProbeColumn)) {
                run.activeProbeColumnClears = 0;
            }
        }
        LOGGER.info(
            "mine_nearby_stone.retarget_visible_occluder instanceId={} commandId={} previousTarget={} occluder={} blockId={} dropsCobblestone={} reason={}",
            instanceId,
            run.commandId,
            target.toShortString(),
            occluder.toShortString(),
            blockId(state),
            dropsCobblestone,
            result.reason()
        );
        return new ControlDecision(stopFrom(effective, "mine_nearby_stone_retarget_visible_occluder"), InputState.stop());
    }

    private long mineNearbyStoneExposedScanGateMs = 0L;

    private MineNearbyStoneApproachPlan selectApproachableExposedStoneTarget(
        MinecraftClient client,
        ClientPlayerEntity player,
        MineNearbyStoneRun run
    ) {
        if (client == null || client.world == null || player == null || run == null) {
            return null;
        }
        if (!shouldTryMineNearbyStoneExposedApproach(run.currentAdjacentMoveStalls)) {
            return null;
        }
        long nowMs = System.currentTimeMillis();
        // Instance-level gate (NOT per-run): a no-visible-stone failure mints a fresh command and a
        // fresh run object every retry, which reset a per-run gate and paid the full 41x41 sweep +
        // route probes on every reselect tick (1.6 s worst tick in that loop).
        if (nowMs < mineNearbyStoneExposedScanGateMs) {
            return null;
        }
        mineNearbyStoneExposedScanGateMs = nowMs + NEARBY_STONE_EXPOSED_SCAN_INTERVAL_MS;
        BlockPos origin = player.getBlockPos();
        BlockPos currentSupport = origin.down();
        List<BlockPos> candidates = new ArrayList<>();
        for (int dy = -NEARBY_STONE_EXPOSED_SCAN_DOWN; dy <= NEARBY_STONE_EXPOSED_SCAN_UP; dy++) {
            for (int dx = -NEARBY_STONE_EXPOSED_SCAN_RADIUS; dx <= NEARBY_STONE_EXPOSED_SCAN_RADIUS; dx++) {
                for (int dz = -NEARBY_STONE_EXPOSED_SCAN_RADIUS; dz <= NEARBY_STONE_EXPOSED_SCAN_RADIUS; dz++) {
                    BlockPos candidate = origin.add(dx, dy, dz);
                    if (candidate.equals(currentSupport) || run.abandonedTargets.contains(candidate)) {
                        continue;
                    }
                    BlockState state = client.world.getBlockState(candidate);
                    if (!isMineNearbyCobblestoneSource(state) || !isExposedStoneTarget(client.world, candidate)) {
                        continue;
                    }
                    candidates.add(candidate.toImmutable());
                }
            }
        }
        if (candidates.isEmpty()) {
            return null;
        }
        Vec3d eye = player.getEyePos();
        candidates.sort(Comparator
            .comparingDouble((BlockPos candidate) -> eye.squaredDistanceTo(Vec3d.ofCenter(candidate)))
            .thenComparingInt(BlockPos::getY)
            .thenComparingInt(BlockPos::getZ)
            .thenComparingInt(BlockPos::getX));

        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        int referenceFeetY = (int) Math.floor(player.getY());
        int margin = NAVIGATION_PERCEPTION_MARGIN;
        WorldGridPerception perception = new WorldGridPerception(
            client.world,
            referenceFeetY,
            start.x() - NEARBY_STONE_EXPOSED_SCAN_RADIUS - margin,
            start.x() + NEARBY_STONE_EXPOSED_SCAN_RADIUS + margin,
            start.z() - NEARBY_STONE_EXPOSED_SCAN_RADIUS - margin,
            start.z() + NEARBY_STONE_EXPOSED_SCAN_RADIUS + margin
        );
        GridPerception routePerception = maybeAnchorCurrentStart(client.world, perception, start, referenceFeetY, true);
        MineNearbyStoneApproachPlan best = null;
        double bestScore = Double.MAX_VALUE;
        int considered = 0;
        for (BlockPos candidate : candidates) {
            if (considered++ >= NEARBY_STONE_EXPOSED_SCAN_LIMIT) {
                break;
            }
            GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
                routePerception,
                start,
                candidate.getX(),
                candidate.getY(),
                candidate.getZ(),
                Set.of()
            );
            if (plan.cell() == null || plan.route().isEmpty()) {
                continue;
            }
            if (!acceptsMineNearbyStoneExposedRouteLength(plan.route().size())) {
                continue;
            }
            double dx = candidate.getX() - player.getX();
            double dz = candidate.getZ() - player.getZ();
            double horizontalDistanceSquared = dx * dx + dz * dz;
            double score = plan.route().size() * 16.0D
                + horizontalDistanceSquared
                + Math.abs(candidate.getY() - player.getY()) * 2.0D;
            if (score < bestScore) {
                bestScore = score;
                best = new MineNearbyStoneApproachPlan(
                    candidate,
                    plan.cell(),
                    List.copyOf(plan.route()),
                    "exposed_stone:" + plan.reason()
                );
            }
        }
        return best;
    }

    static boolean shouldTryMineNearbyStoneExposedApproach(int approachStalls) {
        return approachStalls < NEARBY_STONE_EXPOSED_MAX_APPROACH_STALLS;
    }

    static boolean acceptsMineNearbyStoneExposedRouteLength(int routeLength) {
        return routeLength > 0 && routeLength <= NEARBY_STONE_EXPOSED_MAX_ROUTE_LENGTH;
    }

    static long mineNearbyStoneBreakTimeoutMs(boolean currentTargetDropsCobblestone) {
        return currentTargetDropsCobblestone
            ? NEARBY_STONE_SOURCE_BREAK_TIMEOUT_MS
            : NEARBY_STONE_PROBE_BREAK_TIMEOUT_MS;
    }

    static long mineNearbyStoneTimeoutMs() {
        return NEARBY_STONE_TIMEOUT_MS;
    }

    static int mineNearbyStoneProbeAttempts(int probeBlocksBroken, int probeBreakFailures) {
        return Math.max(0, probeBlocksBroken) + Math.max(0, probeBreakFailures);
    }

    static boolean shouldUseMineNearbyStoneNav3dCollect(double playerY, double dropY) {
        return Double.isFinite(playerY)
            && Double.isFinite(dropY)
            && dropY < playerY - DIRECT_COLLECT_VERTICAL_DROP_MAX_DIRECT_Y_DELTA;
    }

    private boolean isExposedStoneTarget(BlockView world, BlockPos candidate) {
        if (world == null || candidate == null) {
            return false;
        }
        for (Direction direction : List.of(Direction.UP, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST)) {
            BlockState neighbor = world.getBlockState(candidate.offset(direction));
            if (neighbor.isAir() || !neighbor.getFluidState().isEmpty()) {
                return true;
            }
        }
        return false;
    }

    private ControlDecision navigateToMineNearbyStoneAdjacentCell(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        MineNearbyStoneRun run,
        long nowMs
    ) {
        if (run == null || run.currentTarget == null || run.currentAdjacentCell == null) {
            return null;
        }
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        double distance = Math.hypot(
            PathFollower.center(run.currentAdjacentCell.x()) - player.getX(),
            PathFollower.center(run.currentAdjacentCell.z()) - player.getZ()
        );
        if (run.currentAdjacentReached) {
            return null;
        }
        if (start.equals(run.currentAdjacentCell) || distance <= GATHER_ARRIVE_EPSILON) {
            run.currentAdjacentReached = true;
            run.currentAdjacentProgress.reset();
            LOGGER.info(
                "mine_nearby_stone.adjacent_latched instanceId={} commandId={} target={} adjacent={} centerDistance={}",
                instanceId,
                run.commandId,
                run.currentTarget.toShortString(),
                run.currentAdjacentCell,
                roundForLog(distance)
            );
            return null;
        }
        AdjacentMoveProgressTracker.Result progress = run.currentAdjacentProgress.update(
            run.currentAdjacentCell,
            distance,
            player.getX(),
            player.getZ(),
            nowMs,
            gatherAdjacentMoveStallMs(run.currentAdjacentRoute, distance),
            GATHER_ADJACENT_MOVE_IMPROVEMENT,
            GATHER_ADJACENT_MOVE_MOVEMENT
        );
        if (progress.stalled()) {
            BlockPos target = run.currentTarget;
            run.currentAdjacentMoveStalls++;
            run.abandonedTargets.add(target);
            run.currentTarget = null;
            run.currentTargetDropsCobblestone = true;
            run.targetBaselineCobblestone = -1;
            clearMineNearbyStoneApproach(run);
            clearNavigationState();
            LOGGER.warn(
                "mine_nearby_stone.adjacent_move_stall instanceId={} commandId={} target={} distance={} bestDistance={} stalledMs={} stalls={}",
                instanceId,
                run.commandId,
                target.toShortString(),
                roundForLog(distance),
                roundForLog(progress.bestDistance()),
                progress.stalledMs(),
                run.currentAdjacentMoveStalls
            );
            return new ControlDecision(stopFrom(effective, "mine_nearby_stone_adjacent_move_stall_reselect"), InputState.stop());
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
            run.currentAdjacentRoute,
            List.of(),
            GATHER_ARRIVE_EPSILON,
            List.of(),
            effective.expiresAtMs(),
            "mine_nearby_stone_nav_adjacent",
            run.commandId + ":stone:adjacent"
        );
        return resolveNavigationControl(client, player, navIntent);
    }

    private void clearMineNearbyStoneApproach(MineNearbyStoneRun run) {
        if (run == null) {
            return;
        }
        run.currentAdjacentCell = null;
        run.currentAdjacentRoute = List.of();
        run.currentAdjacentReached = false;
        run.currentAdjacentProgress.reset();
    }

    // Mission commands skip the surface scatter-probe entirely and staircase from the start: the
    // probe digs a glitchy-looking pattern around the bot AND early runs failed on
    // two probe-churn timeouts — 30 target selections for ~1 block of progress. Staircase digging is
    // mechanically guaranteed stone. A hazard-abandoned staircase still falls back to probing
    // (descentFallbacks budget unchanged), and non-mission/harness commands keep probe-first.
    static boolean isMissionCommandId(String commandId) {
        return commandId != null && commandId.startsWith("mission-");
    }

    // Sprint via the real sprint key during full-forward travel (route walking, search legs, item
    // collection). Precision work (face/adjacent/edge/bridge/descend/place/carve) never matches the
    // reason allowlist, so close-quarters control stays at walk speed; the edge-guard zeroes forward
    // at cliff lips so a sprint can never carry the bot off one. Vanilla itself refuses to sprint
    // below 7 food — no need to duplicate that gate here.
    static boolean sprintEligibleReason(String reason) {
        if (reason == null) {
            return false;
        }
        return reason.startsWith("navigate")
            || reason.startsWith("hunt_")
            || reason.contains("search")
            || reason.contains("collect")
            || reason.contains("route");
    }

    // Look damping knobs: swaps beyond this angle within one command are rate-limited to one
    // per interval; the previous aim keeps easing meanwhile.
    // Feel pass (early runs looked shaky, switching between targeted blocks): adjacent
    // block re-targets are 10-25 degrees and sailed under the old 25-degree gate every 350 ms —
    // exactly the visible churn. 10 degrees / 500 ms damps block-to-block whips while sub-10-degree
    // tracking (drop-seek, micro-corrections) stays continuous.
    private static final double LOOK_SWAP_ANGLE_DEG = 10.0D;
    private static final long LOOK_SWAP_MIN_INTERVAL_MS = 500L;
    // QoL: harness runs release any cursor grab every tick (see the tick hook).
    private static final boolean NO_CURSOR_GRAB = "1".equals(System.getenv("MCBOT_NO_CURSOR_GRAB"));
    // V1.1: true while the bot is actively driving in a NO_CURSOR_GRAB harness run -- read by
    // MouseCursorGrabMixin to cancel vanilla's click-to-capture grab, so clicking the MC window no
    // longer snaps the cursor to centre. Updated each tick; false when the bot is toggled
    // OFF, so manual mouse-look (restoreManualInput's lockCursor) still works normally.
    private static volatile boolean SUPPRESS_CURSOR_GRAB = false;

    public static boolean suppressCursorGrab() {
        return SUPPRESS_CURSOR_GRAB;
    }

    static double wrapDegreesDelta(double degrees) {
        double wrapped = (degrees + 180.0D) % 360.0D;
        if (wrapped < 0.0D) {
            wrapped += 360.0D;
        }
        return wrapped - 180.0D;
    }

    // The global guard's 2-cell lookahead sees PAST the staircase's current 1-drop step
    // into the gap beyond and froze descents (descent_move_stalled x2 on the relocations). The
    // staircase machinery has its own, stronger step-safety stack and predates the guard — exempt it.
    private static boolean isStaircaseDrivenIntent(BrainLink.Intent intent) {
        if (intent == null) {
            return false;
        }
        String action = intent.action() == null ? "" : intent.action();
        return "descend_staircase".equals(action) || "return_staircase".equals(action);
    }

    static boolean inputWantsMovement(InputState input) {
        return input != null
            && (input.pressingForward() || input.pressingBack() || input.pressingLeft()
                || input.pressingRight() || input.jumping()
                || Math.abs(input.movementForward()) > 0.01F
                || Math.abs(input.movementSideways()) > 0.01F);
    }

    private void updateSprintKey(MinecraftClient client, String reason, InputState input) {
        boolean sprint = input != null
            && input.pressingForward()
            && !input.sneaking()
            && !input.pressingBack()
            && input.movementForward() >= 0.99F
            && sprintEligibleReason(reason);
        client.options.sprintKey.setPressed(sprint);
    }

    static boolean shouldStartMineNearbyStoneDescentFallback(
        int probeBlocksBroken,
        int probeBreakFailures,
        int descentFallbacks,
        boolean hasCurrentTarget,
        boolean missionDescentFirst
    ) {
        if (hasCurrentTarget || descentFallbacks >= NEARBY_STONE_DESCENT_FALLBACK_MAX) {
            return false;
        }
        if (missionDescentFirst) {
            return true;
        }
        return probeBlocksBroken >= NEARBY_STONE_DESCENT_FALLBACK_PROBE_THRESHOLD
            || probeBreakFailures >= NEARBY_STONE_PROBE_BREAK_FAILURE_DESCENT_THRESHOLD
            || mineNearbyStoneProbeAttempts(probeBlocksBroken, probeBreakFailures) >= NEARBY_STONE_DESCENT_FALLBACK_PROBE_THRESHOLD;
    }

    static String mineNearbyStoneDescentFallbackReason(int probeBlocksBroken, int probeBreakFailures, boolean missionDescentFirst) {
        if (missionDescentFirst
            && probeBreakFailures < NEARBY_STONE_PROBE_BREAK_FAILURE_DESCENT_THRESHOLD
            && probeBlocksBroken < NEARBY_STONE_DESCENT_FALLBACK_PROBE_THRESHOLD) {
            return "mission_descent_first";
        }
        if (probeBreakFailures >= NEARBY_STONE_PROBE_BREAK_FAILURE_DESCENT_THRESHOLD) {
            return "probe_break_failures";
        }
        if (mineNearbyStoneProbeAttempts(probeBlocksBroken, probeBreakFailures) >= NEARBY_STONE_PROBE_MAX_BLOCKS) {
            return "probe_exhausted";
        }
        return "probe_threshold";
    }

    static boolean shouldAbandonMineNearbyStoneDescentFallback(String reason) {
        if (reason == null) {
            return false;
        }
        return reason.startsWith("descent_failed:descent_hazard_in_step:")
            || reason.startsWith("descent_failed:descent_water_adjacent:")
            || reason.startsWith("descent_failed:descent_lava_adjacent:")
            || reason.startsWith("descent_failed:descent_player_in_hazard:water:");
    }

    private ControlDecision startMineNearbyStoneDescentFallback(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        MineNearbyStoneRun run,
        InventoryCounter.InventoryCobblestoneSnapshot inventory,
        long nowMs,
        String reason
    ) {
        if (run == null || run.descentFallbacks >= NEARBY_STONE_DESCENT_FALLBACK_MAX) {
            return null;
        }
        run.descentFallbackActive = true;
        run.descentFallbacks++;
        run.descentFallbackStartedAtMs = nowMs;
        run.currentTarget = null;
        run.currentTargetDropsCobblestone = true;
        run.targetBaselineCobblestone = -1;
        run.activeProbeColumn = null;
        run.activeProbeColumnClears = 0;
        clearMineNearbyStoneApproach(run);
        clearNavigationState();
        LOGGER.warn(
            "mine_nearby_stone.descent_fallback_start instanceId={} commandId={} reason={} probeBlocksBroken={} probeBreakFailures={} probeAttempts={} fallbacks={} start={}",
            instanceId,
            run.commandId,
            reason,
            run.probeBlocksBroken,
            run.probeBreakFailures,
            mineNearbyStoneProbeAttempts(run.probeBlocksBroken, run.probeBreakFailures),
            run.descentFallbacks,
            player.getBlockPos().toShortString()
        );
        return resolveMineNearbyStoneDescentFallback(client, player, effective, run, inventory, nowMs);
    }

    private ControlDecision resolveMineNearbyStoneDescentFallback(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        MineNearbyStoneRun run,
        InventoryCounter.InventoryCobblestoneSnapshot inventory,
        long nowMs
    ) {
        String descentCommandId = run.commandId + ":descent:" + run.descentFallbacks;
        BrainLink.Intent subIntent = phaseIntent(
            effective,
            "descend_staircase",
            null,
            "mine_nearby_stone_descent_fallback",
            descentCommandId
        );
        ControlDecision decision = resolveDescendStaircaseControl(client, player, subIntent, nowMs);
        String reason = decision.intent() == null ? "" : decision.intent().reason();
        if (reason != null && reason.startsWith("descent_complete:")) {
            long fallbackElapsedMs = Math.max(0L, nowMs - run.descentFallbackStartedAtMs);
            run.descentFallbackActive = false;
            run.descentFallbackStartedAtMs = 0L;
            run.currentTarget = null;
            run.currentTargetDropsCobblestone = true;
            run.targetBaselineCobblestone = -1;
            run.activeProbeColumn = null;
            run.activeProbeColumnClears = 0;
            clearMineNearbyStoneApproach(run);
            clearNavigationState();
            LOGGER.info(
                "mine_nearby_stone.descent_fallback_complete instanceId={} commandId={} descentCommandId={} final={} probeBlocksBroken={} elapsedMs={}",
                instanceId,
                run.commandId,
                descentCommandId,
                player.getBlockPos().toShortString(),
                run.probeBlocksBroken,
                fallbackElapsedMs
            );
            return new ControlDecision(stopFrom(effective, "mine_nearby_stone_descent_fallback_complete"), InputState.stop());
        }
        if (reason != null && reason.startsWith("descent_failed:")) {
            run.descentFallbackActive = false;
            run.descentFallbackStartedAtMs = 0L;
            if (shouldAbandonMineNearbyStoneDescentFallback(reason)) {
                clearMineNearbyStoneApproach(run);
                clearNavigationState();
                LOGGER.warn(
                    "mine_nearby_stone.descent_fallback_abandoned instanceId={} commandId={} descentCommandId={} reason={} probeBlocksBroken={} fallbacks={} inventoryCobblestoneBefore={} inventoryCobblestoneAfter={}",
                    instanceId,
                    run.commandId,
                    descentCommandId,
                    reason,
                    run.probeBlocksBroken,
                    run.descentFallbacks,
                    run.baselineCobblestone,
                    inventory.cobblestoneCount()
                );
                return new ControlDecision(stopFrom(effective, "mine_nearby_stone_descent_fallback_abandoned:" + reason), InputState.stop());
            }
            return failMineNearbyStone(effective, run, inventory, nowMs, "mine_nearby_stone_descent_fallback_failed:" + reason);
        }
        return decision;
    }

    private boolean isMineNearbyCobblestoneSource(BlockState state) {
        return state != null && state.isOf(Blocks.STONE);
    }

    private BlockPos selectVisibleStoneTarget(MinecraftClient client, ClientPlayerEntity player, Set<BlockPos> excluded) {
        BlockPos origin = player.getBlockPos();
        BlockPos currentSupport = origin.down();
        BlockPos best = null;
        double bestDistance = Double.MAX_VALUE;
        for (int dy = -NEARBY_STONE_PROBE_MAX_DEPTH; dy <= 3; dy++) {
            for (int dx = -4; dx <= 4; dx++) {
                for (int dz = -4; dz <= 4; dz++) {
                    if (dx == 0 && dz == 0 && dy < 2) {
                        continue;
                    }
                    BlockPos candidate = origin.add(dx, dy, dz);
                    if (candidate.equals(currentSupport) || (excluded != null && excluded.contains(candidate))) {
                        continue;
                    }
                    if (!isMineNearbyCobblestoneSource(client.world.getBlockState(candidate))) {
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

    private BlockPos selectStoneProbeTarget(
        MinecraftClient client,
        ClientPlayerEntity player,
        Set<BlockPos> excluded,
        Set<GridCell> excludedColumns
    ) {
        BlockPos origin = player.getBlockPos();
        BlockPos currentSupport = origin.down();
        BlockPos best = null;
        double bestScore = Double.MAX_VALUE;
        for (int dy = -1; dy >= -NEARBY_STONE_PROBE_MAX_DEPTH; dy--) {
            for (int dx = -NEARBY_STONE_PROBE_RADIUS; dx <= NEARBY_STONE_PROBE_RADIUS; dx++) {
                for (int dz = -NEARBY_STONE_PROBE_RADIUS; dz <= NEARBY_STONE_PROBE_RADIUS; dz++) {
                    if (dx == 0 && dz == 0) {
                        continue;
                    }
                    BlockPos candidate = origin.add(dx, dy, dz);
                    if (candidate.equals(currentSupport) || (excluded != null && excluded.contains(candidate))) {
                        continue;
                    }
                    GridCell column = probeColumn(candidate);
                    if (excludedColumns != null && excludedColumns.contains(column)) {
                        continue;
                    }
                    BlockState state = client.world.getBlockState(candidate);
                    if (!isMineNearbyStoneProbeBlock(state) || visibleBlockAimPoint(client, player, candidate) == null) {
                        continue;
                    }
                    int manhattan = Math.abs(dx) + Math.abs(dz);
                    if (manhattan == 0 || manhattan > NEARBY_STONE_PROBE_RADIUS + 1) {
                        continue;
                    }
                    int depth = -dy;
                    double score = manhattan * 8.0D - depth;
                    if (score < bestScore) {
                        bestScore = score;
                        best = candidate.toImmutable();
                    }
                }
            }
        }
        return best;
    }

    private BlockPos selectStoneProbeTargetInColumn(
        MinecraftClient client,
        ClientPlayerEntity player,
        GridCell column,
        Set<BlockPos> excluded
    ) {
        if (column == null) {
            return null;
        }
        BlockPos origin = player.getBlockPos();
        BlockPos currentSupport = origin.down();
        BlockPos best = null;
        int deepest = Integer.MIN_VALUE;
        for (int dy = -1; dy >= -NEARBY_STONE_PROBE_MAX_DEPTH; dy--) {
            BlockPos candidate = new BlockPos(column.x(), origin.getY() + dy, column.z());
            if (candidate.equals(currentSupport) || (excluded != null && excluded.contains(candidate))) {
                continue;
            }
            BlockState state = client.world.getBlockState(candidate);
            if (!isMineNearbyStoneProbeBlock(state) || visibleBlockAimPoint(client, player, candidate) == null) {
                continue;
            }
            int depth = -dy;
            if (depth > deepest) {
                deepest = depth;
                best = candidate.toImmutable();
            }
        }
        return best;
    }

    private GridCell probeColumn(BlockPos pos) {
        return new GridCell(pos.getX(), pos.getZ());
    }

    private void recordMineNearbyStoneProbeCleared(MineNearbyStoneRun run, BlockPos target) {
        run.probeBlocksBroken++;
        GridCell column = target == null ? null : probeColumn(target);
        if (target != null) {
            run.abandonedTargets.add(target.toImmutable());
        }
        if (column != null && run.activeProbeColumn != null && run.activeProbeColumn.equals(column)) {
            run.activeProbeColumnClears++;
            if (run.activeProbeColumnClears >= NEARBY_STONE_PROBE_MAX_BLOCKS_PER_COLUMN) {
                run.exhaustedProbeColumns.add(run.activeProbeColumn);
                run.activeProbeColumn = null;
                run.activeProbeColumnClears = 0;
            }
        }
    }

    private void recordMineNearbyStoneProbeFailed(MineNearbyStoneRun run, BlockPos target) {
        if (run == null) {
            return;
        }
        run.probeBreakFailures++;
        GridCell column = target == null ? null : probeColumn(target);
        if (target != null) {
            run.abandonedTargets.add(target.toImmutable());
        }
        if (column != null) {
            run.exhaustedProbeColumns.add(column);
            if (run.activeProbeColumn != null && run.activeProbeColumn.equals(column)) {
                run.activeProbeColumn = null;
                run.activeProbeColumnClears = 0;
            }
        }
    }

    private boolean isMineNearbyStoneProbeBlock(BlockState state) {
        if (state == null || state.isAir()) {
            return false;
        }
        return isMineNearbyStoneProbeBlockId(blockId(state));
    }

    static boolean isMineNearbyStoneProbeBlockId(String id) {
        if (id == null || id.isBlank()) {
            return false;
        }
        String normalized = id.trim().toLowerCase(Locale.ROOT);
        int colon = normalized.indexOf(':');
        if (colon >= 0) {
            normalized = normalized.substring(colon + 1);
        }
        if (isMineNearbyStoneTerracottaProbeBlockId(normalized)) {
            return true;
        }
        return switch (normalized) {
            case "grass_block",
                "dirt",
                "coarse_dirt",
                "rooted_dirt",
                "podzol",
                "mycelium",
                "sand",
                "red_sand",
                "gravel",
                "clay",
                "sandstone",
                "chiseled_sandstone",
                "cut_sandstone",
                "smooth_sandstone",
                "red_sandstone",
                "chiseled_red_sandstone",
                "cut_red_sandstone",
                "smooth_red_sandstone" -> true;
            default -> false;
        };
    }

    private static boolean isMineNearbyStoneTerracottaProbeBlockId(String normalized) {
        return "terracotta".equals(normalized)
            || normalized.endsWith("_terracotta") && !normalized.endsWith("_glazed_terracotta");
    }

    private boolean visibleStoneTarget(MinecraftClient client, ClientPlayerEntity player, BlockPos candidate) {
        return visibleBlockAimPoint(client, player, candidate) != null;
    }

    private boolean centerVisibleStoneTarget(MinecraftClient client, ClientPlayerEntity player, BlockPos candidate) {
        if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(candidate)) > TABLE_INTERACTION_REACH_BLOCKS * TABLE_INTERACTION_REACH_BLOCKS) {
            return false;
        }
        BlockHitResult hit = raycastToBlockSample(player, client, Vec3d.ofCenter(candidate));
        return hit != null && hit.getType() == HitResult.Type.BLOCK && candidate.equals(hit.getBlockPos());
    }

    private Vec3d visibleBlockAimPoint(MinecraftClient client, ClientPlayerEntity player, BlockPos candidate) {
        if (client == null || client.world == null || player == null || candidate == null) {
            return null;
        }
        if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(candidate)) > TABLE_INTERACTION_REACH_BLOCKS * TABLE_INTERACTION_REACH_BLOCKS) {
            return null;
        }
        for (Vec3d sample : blockVisibilitySamples(candidate)) {
            BlockHitResult hit = raycastToBlockSample(player, client, sample);
            if (hit != null && hit.getType() == HitResult.Type.BLOCK && candidate.equals(hit.getBlockPos())) {
                return sample;
            }
        }
        return null;
    }

    private Vec3d[] blockVisibilitySamples(BlockPos target) {
        return new Vec3d[] {
            Vec3d.ofCenter(target),
            new Vec3d(target.getX() + 0.5D, target.getY() + 0.95D, target.getZ() + 0.5D),
            new Vec3d(target.getX() + 0.5D, target.getY() + 0.5D, target.getZ() + 0.05D),
            new Vec3d(target.getX() + 0.5D, target.getY() + 0.5D, target.getZ() + 0.95D),
            new Vec3d(target.getX() + 0.05D, target.getY() + 0.5D, target.getZ() + 0.5D),
            new Vec3d(target.getX() + 0.95D, target.getY() + 0.5D, target.getZ() + 0.5D)
        };
    }

    private BlockHitResult raycastToBlockSample(ClientPlayerEntity player, MinecraftClient client, Vec3d target) {
        Vec3d eye = player.getEyePos();
        return client.world.raycast(new RaycastContext(
            eye,
            target,
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
        return resolveMineNearbyOreControl(client, player, effective, nowMs, OreKind.IRON);
    }

    private ControlDecision resolveMineNearbyDiamondControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        return resolveMineNearbyOreControl(client, player, effective, nowMs, OreKind.DIAMOND);
    }

    private ControlDecision resolveMineNearbyOreControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs, OreKind oreKind) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        String finishedReason = finishedMineNearbyOreCommandReasons(oreKind).get(commandId);
        if (finishedReason != null) {
            return new ControlDecision(stopFrom(effective, finishedReason), InputState.stop());
        }
        InventoryCounter.InventoryItemSnapshot inventory = InventoryCounter.countPlayerItem(player, oreKind.dropItemId);
        MineNearbyIronRun activeRun = activeMineNearbyOreRun(oreKind);
        if (activeRun == null || !commandId.equals(activeRun.commandId)) {
            int targetDelta = mineNearbyOreTargetDelta(oreKind, player);
            activeRun = new MineNearbyIronRun(commandId, inventory.itemCount(), targetDelta, nowMs);
            setActiveMineNearbyOreRun(oreKind, activeRun);
            LOGGER.info(
                "{}.start instanceId={} commandId={} inventoryBefore={} targetDelta={} itemsByItem={}",
                oreKind.action,
                instanceId,
                commandId,
                inventory.itemCount(),
                activeRun.targetDelta,
                inventory.itemsByItem()
            );
        }
        MineNearbyIronRun run = activeRun;
        int delta = inventory.itemCount() - run.baselineRawIron;
        if (delta >= run.targetDelta) {
            return completeMineNearbyOre(effective, run, inventory, nowMs, oreKind, oreKind.dropItemId + "_delta_verified");
        }
        // Mission time cap rises with the mission block budget (live runs broke 79 of 96 prospect
        // blocks when the unraised 150 s cap fired — the +50% block budget was being time-starved).
        long oreTimeoutMs = isMissionCommandId(run.commandId)
            ? oreKind.timeoutMs + oreKind.timeoutMs / 2
            : oreKind.timeoutMs;
        if (nowMs - run.startedAtMs > oreTimeoutMs) {
            return failMineNearbyOre(effective, run, inventory, nowMs, oreKind, oreKind.action + "_timeout");
        }
        if (run.prospectSettleUntilMs > nowMs) {
            return new ControlDecision(stopFrom(effective, oreKind.action + "_prospect_settle"), InputState.stop());
        }

        if (oreKind == OreKind.IRON && (run.fieldKitRecoveryActive || run.fieldKitRetrieveTablePending)) {
            ControlDecision recoveryDecision = resolveMineNearbyIronToolRecovery(client, player, effective, run, inventory, nowMs, true);
            if (recoveryDecision != null) {
                return recoveryDecision;
            }
        }

        if (oreKind == OreKind.IRON) {
            ControlDecision proactiveToolRecovery = maybeResolveProactiveMineNearbyIronToolRecovery(client, player, effective, run, inventory, nowMs);
            if (proactiveToolRecovery != null) {
                return proactiveToolRecovery;
            }
        }

        if (run.collectStartedAtMs > 0L) {
            if (nowMs - run.collectStartedAtMs < GATHER_PICKUP_SETTLE_MS) {
                return new ControlDecision(stopFrom(effective, oreKind.action + "_wait_pickup"), InputState.stop());
            }
            if (run.collectBaselineItemCount >= 0 && inventory.itemCount() > run.collectBaselineItemCount) {
                LOGGER.info(
                    "{}.collect_delta instanceId={} commandId={} target={} inventoryBeforeTarget={} inventoryAfterTarget={} overallDelta={} targetDelta={}",
                    oreKind.action,
                    instanceId,
                    commandId,
                    run.lastBrokenTarget == null ? "none" : run.lastBrokenTarget.toShortString(),
                    run.collectBaselineItemCount,
                    inventory.itemCount(),
                    delta,
                    run.targetDelta
                );
                run.collectStartedAtMs = 0L;
                run.collectBaselineItemCount = -1;
                run.lastBrokenTarget = null;
                nav3dCollectRoute = List.of();
                nav3dCollectRouteDrop = null;
                nav3dOverlayWaypoints = List.of();
                nav3dLastProgressPos = null;
                nav3dLastProgressMs = 0L;
                nav3dLastTunnelDigTarget = null;
                return new ControlDecision(stopFrom(effective, oreKind.action + "_collect_delta"), InputState.stop());
            }
            Vec3d droppedRawIron = nearestDroppedItemPosition(
                client,
                player,
                run.lastBrokenTarget == null ? player.getBlockPos() : run.lastBrokenTarget,
                (stack, itemId) -> oreKind.dropItemId.equalsIgnoreCase(itemId),
                true
            );
            if (droppedRawIron != null && nowMs - run.collectStartedAtMs < oreKind.collectDropTimeoutMs) {
                LOGGER.info(
                    "{}.collect_item_target instanceId={} commandId={} itemX={} itemY={} itemZ={}",
                    oreKind.action,
                    instanceId,
                    commandId,
                    roundForLog(droppedRawIron.x),
                    roundForLog(droppedRawIron.y),
                    roundForLog(droppedRawIron.z)
                );
                maybeRecordCollectStall(client, player, run, oreKind, droppedRawIron, commandId, nowMs);
                maybeRecordNav3DCollect(client, player, oreKind, droppedRawIron, commandId);
                if (nav3dCollectEnabled) {
                    // 3-D nav gets first crack: a close-but-below drop (on a ledge/pit) is within the
                    // direct-approach radius yet unreachable by a straight walk, so the direct-approach would
                    // intercept and stall on it. The 3-D route descends to it. Falls through to the
                    // direct-approach + 2-D collect when the 3-D nav finds no route.
                    ControlDecision nav3dCollect = tryNav3dDriveToward(
                        client, player, effective, droppedRawIron, oreKind.action + "_collect", commandId, nowMs);
                    if (nav3dCollect != null) {
                        return nav3dCollect;
                    }
                }
                double collectDx = droppedRawIron.x - player.getX();
                double collectDz = droppedRawIron.z - player.getZ();
                if (Math.hypot(collectDx, collectDz) <= COLLECT_DIRECT_APPROACH_RADIUS
                    && Math.abs(droppedRawIron.y - player.getY()) <= COLLECT_DIRECT_APPROACH_MAX_RISE) {
                    // Drop is close: the 2-D cell nav can leave the bot just outside pickup range, or route to
                    // an overhang above the item. Walk DIRECTLY at the drop's exact position (jumping if it
                    // sits above) to close the final sub-cell gap.
                    LookAngles collectLook = lookAnglesToPoint(player, droppedRawIron);
                    boolean collectJump = droppedRawIron.y > player.getY() + 0.5D;
                    InputState collectInput = new InputState(true, false, false, false, collectJump, false, 1.0F, 0.0F);
                    BrainLink.Intent collectDirect = lookIntentForAngles(
                        effective, collectLook.yaw(), collectLook.pitch(), oreKind.action + "_collect_direct");
                    return new ControlDecision(collectDirect, collectInput);
                }
                BrainLink.Intent collectIntent = gatherCollectIntent(
                    effective,
                    droppedRawIron.x,
                    droppedRawIron.y,
                    droppedRawIron.z,
                    oreKind.action + "_collect_item",
                    ":" + oreKind.commandSuffix + ":collect"
                );
                return resolveOreCollectNavigation(client, player, effective, run, oreKind, collectIntent, nowMs);
            }
            if (nowMs - run.collectStartedAtMs < GATHER_COLLECT_TIMEOUT_MS) {
                BrainLink.Intent collectIntent = gatherCollectIntent(
                    effective,
                    run.lastBrokenTarget == null ? player.getX() : run.lastBrokenTarget.getX() + 0.5D,
                    run.lastBrokenTarget == null ? player.getZ() : run.lastBrokenTarget.getZ() + 0.5D,
                    oreKind.action + "_collect_drop",
                    ":" + oreKind.commandSuffix + ":collect"
                );
                return resolveOreCollectNavigation(client, player, effective, run, oreKind, collectIntent, nowMs);
            }
            if (run.lastBrokenTarget != null) {
                run.abandonedTargets.add(run.lastBrokenTarget);
                LOGGER.info(
                    "{}.drop_abandoned instanceId={} commandId={} target={} reason=collect_timeout elapsedMs={} inventoryDelta={} targetDelta={}",
                    oreKind.action,
                    instanceId,
                    commandId,
                    run.lastBrokenTarget.toShortString(),
                    nowMs - run.collectStartedAtMs,
                    delta,
                    run.targetDelta
                );
            }
            run.collectStartedAtMs = 0L;
            run.collectBaselineItemCount = -1;
            run.lastBrokenTarget = null;
            nav3dCollectRoute = List.of();
            nav3dCollectRouteDrop = null;
            nav3dOverlayWaypoints = List.of();
            nav3dLastProgressPos = null;
            nav3dLastProgressMs = 0L;
            nav3dLastTunnelDigTarget = null;
        }

        if (!player.isOnGround()) {
            return new ControlDecision(stopFrom(effective, oreKind.action + "_waiting_on_ground"), InputState.stop());
        }

        if (run.currentTarget != null) {
            FieldKitRecoveryPlanner.Decision protectRecoveryTableDecision = FieldKitRecoveryPlanner.protectMiningTarget(
                fieldKitRecoveryState(run),
                run.fieldKitAlcoveCell != null && run.currentTarget.equals(run.fieldKitAlcoveCell)
            );
            if (protectRecoveryTableDecision.action() == FieldKitRecoveryPlanner.Action.PROTECT_RECOVERY_TABLE) {
                run.currentTarget = null;
                run.currentProspectCell = null;
                LOGGER.info(
                    "mine_nearby_iron.fieldkit_table_protected instanceId={} commandId={} table={} reason=target_refused",
                    instanceId,
                    commandId,
                    formatBlockPos(run.fieldKitAlcoveCell)
                );
                return new ControlDecision(stopFrom(effective, "mine_nearby_iron_fieldkit_table_protected"), InputState.stop());
            }
            BlockState currentTargetState = client.world.getBlockState(run.currentTarget);
            boolean stillTargetable = run.currentTargetIron
                ? isOreBlock(oreKind, currentTargetState)
                : isProspectableMiningBlock(client, run.currentTarget, currentTargetState);
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
                    run.collectBaselineItemCount = inventory.itemCount();
                } else {
                    run.prospectBlocksBroken++;
                    // 250 -> 50 ms (live runs showed 437 settle-stops per iron phase, with
                    // the bot visibly stop-starting between every prospect block; one tick is enough
                    // for the cleared cell's client state to refresh — cobble drops get vacuumed by
                    // walking, only IRON drops need a collect beat and they keep their own flow).
                    run.prospectSettleUntilMs = nowMs + 50L;
                    LOGGER.info(
                        "{}.prospect_block_cleared instanceId={} commandId={} target={} prospectBlocksBroken={} blockNow={}",
                        oreKind.action,
                        instanceId,
                        commandId,
                        completedTarget.toShortString(),
                        run.prospectBlocksBroken,
                        blockId(currentTargetState)
                    );
                }
                run.currentTarget = null;
                run.currentProspectCell = null;
                return new ControlDecision(stopFrom(effective, oreReason(oreKind, currentTargetDecision.reason())), InputState.stop());
            }
        }

        if (run.currentTarget == null) {
            run.currentTarget = selectVisibleOreTarget(client, player, run.abandonedTargets, oreKind);
            MineNearbyIronTargetPlanner.Decision visibleIronDecision = MineNearbyIronTargetPlanner.decideVisibleIronSelection(run.currentTarget != null);
            run.currentTargetIron = visibleIronDecision.action() == MineNearbyIronTargetPlanner.Action.SELECT_IRON_TARGET;
            if (visibleIronDecision.action() == MineNearbyIronTargetPlanner.Action.PROSPECT_REQUIRED) {
                // Mission prospect budget +50% (live runs hit honest iron_search_exhausted with
                // all 4 relocations used — dry pockets need more branch-mining per pocket before the
                // relocation is spent; harness/fixture commands keep the baseline budget).
                int prospectBudget = isMissionCommandId(run.commandId)
                    ? oreKind.maxProspectBlocks + oreKind.maxProspectBlocks / 2
                    : oreKind.maxProspectBlocks;
                MineNearbyIronTargetPlanner.Decision prospectLimitDecision = MineNearbyIronTargetPlanner.decideProspectLimit(
                    run.prospectBlocksBroken,
                    prospectBudget
                );
                if (prospectLimitDecision.action() == MineNearbyIronTargetPlanner.Action.FAIL_PROSPECT_LIMIT) {
                    return failMineNearbyOre(effective, run, inventory, nowMs, oreKind, oreReason(oreKind, prospectLimitDecision.reason()));
                }
                ControlDecision directionalProspect = selectOrAdvanceDirectionalIronProspect(client, player, effective, run, oreKind);
                if (directionalProspect != null) {
                    return directionalProspect;
                }
                if (run.currentTarget == null) {
                    run.currentTarget = selectVisibleOreProspectTarget(client, player, run.abandonedTargets);
                    run.currentProspectCell = null;
                    if (run.currentTarget != null) {
                        LOGGER.info(
                            "{}.local_prospect_fallback instanceId={} commandId={} target={} prospectBlocksBroken={} block={}",
                            oreKind.action,
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
                    return failMineNearbyOre(effective, run, inventory, nowMs, oreKind, oreReason(oreKind, localProspectDecision.reason()));
                }
            }
            LOGGER.info(
                "{}.target_selected instanceId={} commandId={} target={} targetKind={} inventoryDelta={} prospectBlocksBroken={} block={}",
                oreKind.action,
                instanceId,
                commandId,
                run.currentTarget.toShortString(),
                run.currentTargetIron ? oreKind.targetKind : "prospect",
                delta,
                run.prospectBlocksBroken,
                blockId(client.world.getBlockState(run.currentTarget))
            );
        }

        if (oreKind == OreKind.DIAMOND) {
            InventoryCounter.InventoryItemSnapshot ironPickaxeInventory = InventoryCounter.countPlayerItem(player, "iron_pickaxe");
            int bestRemaining = bestIronPickaxeRemainingDurability(player);
            if (ironPickaxeInventory.itemCount() <= 1
                && bestRemaining >= 0
                && bestRemaining < NEARBY_DIAMOND_MIN_LAST_IRON_PICKAXE_REMAINING) {
                LOGGER.warn(
                    "mine_nearby_diamond.abort instanceId={} commandId={} reason=low_last_iron_pickaxe_durability ironPickaxes={} bestRemaining={} threshold={}",
                    instanceId,
                    commandId,
                    ironPickaxeInventory.itemCount(),
                    bestRemaining,
                    NEARBY_DIAMOND_MIN_LAST_IRON_PICKAXE_REMAINING
                );
                return failMineNearbyOre(
                    effective,
                    run,
                    inventory,
                    nowMs,
                    oreKind,
                    "mine_nearby_diamond_abort_low_last_iron_pickaxe_durability"
                );
            }
        }

        int pickaxeSlot = oreKind == OreKind.DIAMOND
            ? findBestHotbarSlotByRemaining(player, InventoryCounter::isIronPickaxeItemId)
            : findIronHarvestPickaxeHotbarSlot(player);
        if (pickaxeSlot < 0) {
            if (oreKind == OreKind.DIAMOND) {
                return failMineNearbyOre(effective, run, inventory, nowMs, oreKind, "mine_nearby_diamond_no_iron_pickaxe_hotbar");
            }
            applyFieldKitRecoveryDecision(run, FieldKitRecoveryPlanner.activate(fieldKitRecoveryState(run)));
            return resolveMineNearbyIronToolRecovery(client, player, effective, run, inventory, nowMs, true);
        }
        if (player.getInventory().selectedSlot != pickaxeSlot) {
            player.getInventory().selectedSlot = pickaxeSlot;
            LOGGER.info(
                "{}.tool_selected instanceId={} commandId={} hotbarSlot={}",
                oreKind.action,
                instanceId,
                commandId,
                pickaxeSlot
            );
            return new ControlDecision(stopFrom(effective, oreKind.action + "_select_tool"), InputState.stop());
        }

        BlockPos target = run.currentTarget;
        if (!isLookingAtBlock(player, target)) {
            return new ControlDecision(lookIntentForBlock(effective, player, target, oreKind.action + "_face"), InputState.stop());
        }
        // breakTerrainOccluders: same mine-through-to-the-ore policy as the descent iron cleanup.
        BlockBreakController.Result result = blockBreakController.tick(
            client, player, target, commandId + ":" + oreKind.commandSuffix, nowMs, false, 0L, true);
        logBlockBreakResult(commandId + ":" + oreKind.commandSuffix, target, result);
        LOGGER.info(
            "{}.break_progress instanceId={} commandId={} target={} targetKind={} status={} reason={} hitBlock={} actedBlock={} elapsedMs={}",
            oreKind.action,
            instanceId,
            commandId,
            target.toShortString(),
            run.currentTargetIron ? oreKind.targetKind : "prospect",
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
                run.collectBaselineItemCount = inventory.itemCount();
            } else {
                run.prospectBlocksBroken++;
                run.prospectSettleUntilMs = nowMs + 50L;
            }
            return new ControlDecision(stopFrom(effective, oreReason(oreKind, breakDecision.reason())), InputState.stop());
        }
        if (breakDecision.action() == MineNearbyIronTargetPlanner.Action.BREAK_RESELECT) {
            run.abandonedTargets.add(target);
            run.currentTarget = null;
            run.currentProspectCell = null;
            return new ControlDecision(stopFrom(effective, oreReason(oreKind, breakDecision.reason())), InputState.stop());
        }
        if (breakDecision.action() == MineNearbyIronTargetPlanner.Action.BREAK_RESELECT_FAILED) {
            run.abandonedTargets.add(target);
            run.currentTarget = null;
            run.currentProspectCell = null;
            return new ControlDecision(stopFrom(effective, oreReason(oreKind, breakDecision.reason())), InputState.stop());
        }
        return new ControlDecision(lookIntentForBlock(effective, player, target, oreReason(oreKind, breakDecision.reason())), InputState.stop());
    }

    // Decision-latency fix (early runs froze 4x ~30 s). The 2-D nav latches a terminal state
    // (target_rejected_no_path, or path_complete with the item still unreachable below a ledge) for
    // the collect sub-command, and the run then re-returned that stop every tick until the parent
    // intent's TTL expired and the brain re-issued it — a full TTL of frozen bot per occurrence.
    // Instead: give the pickup magnet a short grace, then abandon this drop and let the run continue
    // mining on the very next tick. The brain is never needed for this decision.
    private static final long ORE_COLLECT_NAV_TERMINAL_GRACE_MS = 2_000L;

    private ControlDecision resolveOreCollectNavigation(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        MineNearbyIronRun run,
        OreKind oreKind,
        BrainLink.Intent collectIntent,
        long nowMs
    ) {
        ControlDecision decision = resolveNavigationControl(client, player, collectIntent);
        String reason = decision.intent() == null ? "" : decision.intent().reason();
        boolean terminal = "target_rejected_no_path".equals(reason) || "path_complete".equals(reason);
        if (!terminal) {
            run.collectNavTerminalReason = null;
            run.collectNavTerminalSinceMs = 0L;
            return decision;
        }
        if (run.collectNavTerminalSinceMs == 0L || !reason.equals(run.collectNavTerminalReason)) {
            run.collectNavTerminalReason = reason;
            run.collectNavTerminalSinceMs = nowMs;
            return decision;
        }
        if (nowMs - run.collectNavTerminalSinceMs < ORE_COLLECT_NAV_TERMINAL_GRACE_MS) {
            return decision;
        }
        if (run.lastBrokenTarget != null) {
            run.abandonedTargets.add(run.lastBrokenTarget);
        }
        LOGGER.info(
            "{}.collect_leg_terminal instanceId={} commandId={} navReason={} abandonedDrop={} graceMs={}",
            oreKind.action,
            instanceId,
            run.commandId,
            reason,
            run.lastBrokenTarget == null ? "none" : run.lastBrokenTarget.toShortString(),
            nowMs - run.collectNavTerminalSinceMs
        );
        run.collectNavTerminalReason = null;
        run.collectNavTerminalSinceMs = 0L;
        run.collectStartedAtMs = 0L;
        run.collectBaselineItemCount = -1;
        run.lastBrokenTarget = null;
        nav3dCollectRoute = List.of();
        nav3dCollectRouteDrop = null;
        nav3dOverlayWaypoints = List.of();
        nav3dLastProgressPos = null;
        nav3dLastProgressMs = 0L;
        nav3dLastTunnelDigTarget = null;
        clearNavigationState();
        return new ControlDecision(stopFrom(effective, oreKind.action + "_collect_leg_terminal_continue"), InputState.stop());
    }

    static int findHotbarSlotByItemId(ClientPlayerEntity player, String itemId) {
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack != null && !stack.isEmpty()
                && itemId.equals(net.minecraft.registry.Registries.ITEM.getId(stack.getItem()).getPath())) {
                return slot;
            }
        }
        return -1;
    }

    private MineNearbyIronRun activeMineNearbyOreRun(OreKind oreKind) {
        return switch (oreKind) {
            case DIAMOND -> activeMineNearbyDiamond;
            case COAL -> activeMineNearbyCoal;
            case IRON -> activeMineNearbyIron;
        };
    }

    private void setActiveMineNearbyOreRun(OreKind oreKind, MineNearbyIronRun run) {
        switch (oreKind) {
            case DIAMOND -> activeMineNearbyDiamond = run;
            case COAL -> activeMineNearbyCoal = run;
            case IRON -> activeMineNearbyIron = run;
        }
    }

    private Map<String, String> finishedMineNearbyOreCommandReasons(OreKind oreKind) {
        return switch (oreKind) {
            case DIAMOND -> finishedMineNearbyDiamondCommandReasons;
            case COAL -> finishedMineNearbyCoalCommandReasons;
            case IRON -> finishedMineNearbyIronCommandReasons;
        };
    }

    private String oreReason(OreKind oreKind, String reason) {
        if (oreKind == OreKind.IRON || reason == null) {
            return reason;
        }
        return reason
            .replace("mine_nearby_iron", oreKind.action)
            .replace("_no_iron_", "_no_" + oreKind.targetKind + "_")
            .replace("_visible_iron_", "_visible_" + oreKind.targetKind + "_");
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
        // Livelock pin: this trigger keys on the STONE pickaxe's durability while the
        // field-kit's satisfaction keys on ANY hotbar pickaxe — with a healthy IRON pickaxe in hand
        // and a worn stone spare in the bag, the pair ping-ponged every tick for a full 150 s
        // (proactive_tool_recovery <-> fieldkit_pickaxe_already_hotbar) until the watchdog killed
        // the mission. A healthy iron pickaxe makes the stone spare moot for this command.
        if (bestIronPickaxeRemainingDurability(player) > NEARBY_IRON_PICKAXE_RESTOCK_REMAINING) {
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
        MineNearbyIronRun run,
        OreKind oreKind
    ) {
        if (run.prospectDirection == null) {
            run.prospectDirection = resolveMineNearbyIronProspectDirection(effective, player);
            LOGGER.info(
                "{}.prospect_direction instanceId={} commandId={} direction={} targetHint={} playerYaw={}",
                oreKind.action,
                instanceId,
                run.commandId,
                run.prospectDirection.name(),
                formatTargetHint(effective),
                player.getYaw()
            );
        }
        if (prospectStrategyEnabled && !run.prospectStrategyDisabledLogged) {
            run.prospectStrategyDisabledLogged = true;
            LOGGER.info(
                "{}.strategy_flag_disabled instanceId={} commandId={} reason=faithful_sim_retracted_probe_bore fallback=inline_branch_loop",
                oreKind.action,
                instanceId,
                run.commandId
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
            // Corridor spacing (live runs showed direction flips carving lanes directly
            // beside lanes already dug, re-exposing walls already seen): candidates parallel-adjacent
            // (perpendicular offsets 1 AND 2) to this command's corridor are skipped — 2-block walls
            // = the every-3rd-lane pattern, each wall face exposed exactly once. Visible ore is
            // selected upstream of prospecting, so vein chasing is unaffected.
            StaircaseDescentPlanner.Direction2d perp = rotateDescentDirection(direction);
            boolean adjacentCorridor =
                run.prospectCorridorCells.contains(nextFeet.add(perp.dx(), 0, perp.dz()))
                || run.prospectCorridorCells.contains(nextFeet.add(perp.dx() * 2, 0, perp.dz() * 2))
                || run.prospectCorridorCells.contains(nextFeet.add(-perp.dx(), 0, -perp.dz()))
                || run.prospectCorridorCells.contains(nextFeet.add(-perp.dx() * 2, 0, -perp.dz() * 2));
            if (adjacentCorridor) {
                if (firstBlockedReason.isBlank()) {
                    firstBlockedReason = "branch_skip_adjacent_corridor";
                    firstBlockedCell = nextFeet;
                }
                continue;
            }
            String unsafeReason = ironProspectCellUnsafeReason(client, nextFeet);
            BlockPos upper = nextFeet.up();
            BlockState upperState = client.world.getBlockState(upper);
            BlockState lowerState = client.world.getBlockState(nextFeet);
            boolean upperExcluded = run.abandonedTargets.contains(upper);
            boolean lowerExcluded = run.abandonedTargets.contains(nextFeet);
            boolean upperProspectable = isProspectableMiningBlock(client, upper, upperState);
            boolean lowerProspectable = isProspectableMiningBlock(client, nextFeet, lowerState);
            boolean lowerHardOccluded = lowerProspectable
                && !upperState.isAir()
                && (upperExcluded || (!upperProspectable && !isCheapMiningOccluder(upperState)));
            MineNearbyIronTargetPlanner.Decision branchDecision = MineNearbyIronTargetPlanner.decideBranchCandidate(
                unsafeReason,
                upperProspectable,
                lowerProspectable,
                upperState.isAir() && lowerState.isAir(),
                blockId(lowerState),
                blockId(upperState),
                upperExcluded,
                lowerExcluded,
                lowerHardOccluded
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
                run.prospectCorridorCells.add(currentFeet);
                run.prospectCorridorCells.add(nextFeet);
                LOGGER.info(
                    "{}.branch_target_selected instanceId={} commandId={} cell={} target={} phase=upper direction={} prospectBlocksBroken={} block={}",
                    oreKind.action,
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
                run.prospectCorridorCells.add(currentFeet);
                run.prospectCorridorCells.add(nextFeet);
                LOGGER.info(
                    "{}.branch_target_selected instanceId={} commandId={} cell={} target={} phase=lower direction={} prospectBlocksBroken={} block={}",
                    oreKind.action,
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
                return moveToIronProspectCell(player, effective, run, nextFeet, direction, oreKind);
            }
            if (firstBlockedReason.isBlank()) {
                firstBlockedReason = branchDecision.reason();
                firstBlockedCell = nextFeet;
            }
        }

        LOGGER.info(
            "{}.branch_blocked instanceId={} commandId={} reason={} cell={} direction={} prospectBlocksBroken={}",
            oreKind.action,
            instanceId,
            run.commandId,
            firstBlockedReason.isBlank() ? "no_branch_candidate" : firstBlockedReason,
            formatBlockPos(firstBlockedCell),
            run.prospectDirection.name(),
            run.prospectBlocksBroken
        );
        return null;
    }

    private ControlDecision selectOrAdvanceStrategyIronProspect(
        MinecraftClient client,
        ClientPlayerEntity player,
        MineNearbyIronRun run
    ) {
        if (run.prospectStrategyOrigin == null) {
            run.prospectStrategyOrigin = player.getBlockPos().toImmutable();
        }
        Map<ProspectStrategyPlanner.Pos, ProspectStrategyPlanner.BlockKind> visible = visibleProspectStrategyBlocks(
            client,
            player,
            run
        );
        ProspectStrategyPlanner.Decision decision = ProspectStrategyPlanner.decide(
            ProspectStrategyPlanner.StrategyKind.BASELINE_STRAIGHT_TUNNEL,
            run.prospectStrategyState,
            new ProspectStrategyPlanner.Observation(
                Math.max(0, NEARBY_IRON_MAX_PROSPECT_BLOCKS - run.prospectBlocksBroken),
                visible
            )
        );
        run.prospectStrategyState = decision.state();
        if (decision.target().isEmpty()) {
            return null;
        }
        ProspectStrategyPlanner.Pos strategyTarget = decision.target().get();
        BlockPos target = strategyToWorldPos(run.prospectStrategyOrigin, run.prospectDirection, strategyTarget);
        run.currentTarget = target.toImmutable();
        run.currentTargetIron = decision.targetIron();
        run.currentProspectCell = strategyToWorldPos(
            run.prospectStrategyOrigin,
            run.prospectDirection,
            new ProspectStrategyPlanner.Pos(0, 0, Math.max(1, strategyTarget.z()))
        );
        LOGGER.info(
            "mine_nearby_iron.strategy_target_selected instanceId={} commandId={} target={} targetKind={} strategy={} state={} reason={} prospectBlocksBroken={} visibleBlocks={}",
            instanceId,
            run.commandId,
            target.toShortString(),
            run.currentTargetIron ? "iron" : "prospect",
            "baseline_straight_tunnel",
            decision.state(),
            decision.reason(),
            run.prospectBlocksBroken,
            visible.size()
        );
        return null;
    }

    private Map<ProspectStrategyPlanner.Pos, ProspectStrategyPlanner.BlockKind> visibleProspectStrategyBlocks(
        MinecraftClient client,
        ClientPlayerEntity player,
        MineNearbyIronRun run
    ) {
        Map<ProspectStrategyPlanner.Pos, ProspectStrategyPlanner.BlockKind> visible = new HashMap<>();
        BlockPos origin = player.getBlockPos();
        BlockPos support = origin.down();
        for (int dy = -2; dy <= 4; dy++) {
            for (int dx = -5; dx <= 5; dx++) {
                for (int dz = -5; dz <= 5; dz++) {
                    BlockPos candidate = origin.add(dx, dy, dz);
                    if (candidate.equals(support) || run.abandonedTargets.contains(candidate)) {
                        continue;
                    }
                    BlockState state = client.world.getBlockState(candidate);
                    ProspectStrategyPlanner.BlockKind kind = null;
                    if (isIronOreBlock(state)) {
                        kind = ProspectStrategyPlanner.BlockKind.IRON_ORE;
                    } else if (isProspectableIronMiningBlock(client, candidate, state)) {
                        kind = ProspectStrategyPlanner.BlockKind.STONE;
                    }
                    if (kind == null || !visibleStoneTarget(client, player, candidate)) {
                        continue;
                    }
                    ProspectStrategyPlanner.Pos relative = worldToStrategyPos(
                        run.prospectStrategyOrigin == null ? origin : run.prospectStrategyOrigin,
                        run.prospectDirection,
                        candidate
                    );
                    if (relative.z() >= 1) {
                        visible.put(relative, kind);
                    }
                }
            }
        }
        return visible;
    }

    private static ProspectStrategyPlanner.Pos worldToStrategyPos(
        BlockPos origin,
        StaircaseDescentPlanner.Direction2d direction,
        BlockPos pos
    ) {
        int dx = pos.getX() - origin.getX();
        int dz = pos.getZ() - origin.getZ();
        int rightX = -direction.dz();
        int rightZ = direction.dx();
        int lateral = dx * rightX + dz * rightZ;
        int forward = dx * direction.dx() + dz * direction.dz();
        return new ProspectStrategyPlanner.Pos(lateral, pos.getY() - origin.getY(), forward);
    }

    private static BlockPos strategyToWorldPos(
        BlockPos origin,
        StaircaseDescentPlanner.Direction2d direction,
        ProspectStrategyPlanner.Pos pos
    ) {
        int rightX = -direction.dz();
        int rightZ = direction.dx();
        return origin.add(
            direction.dx() * pos.z() + rightX * pos.x(),
            pos.y(),
            direction.dz() * pos.z() + rightZ * pos.x()
        ).toImmutable();
    }

    private ControlDecision moveToIronProspectCell(
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        MineNearbyIronRun run,
        BlockPos nextFeet,
        StaircaseDescentPlanner.Direction2d direction,
        OreKind oreKind
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
                "{}.branch_cell_reached instanceId={} commandId={} cell={} direction={} cellsAdvanced={} prospectBlocksBroken={}",
                oreKind.action,
                instanceId,
                run.commandId,
                nextFeet.toShortString(),
                direction.name(),
                run.branchCellsAdvanced,
                run.prospectBlocksBroken
            );
            return new ControlDecision(stopFrom(effective, oreReason(oreKind, moveDecision.reason())), InputState.stop());
        }
        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        BrainLink.Intent intent = lookIntentForAngles(effective, yaw, 6.0D, oreReason(oreKind, "mine_nearby_iron_branch_move") + ":" + direction.name());
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
            ControlDecision retrieveDecision = retrieveTableExecutor.resolve(
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
        boolean nonPlayerScreenOpen = player.currentScreenHandler != null && player.currentScreenHandler != player.playerScreenHandler;
        boolean proactiveRestock = proactive && run.proactiveToolRecoveryLogged;
        boolean allowStonePickaxe = !proactiveRestock;
        Predicate<String> acceptablePickaxe = allowStonePickaxe
            ? McbotFabricClient::isIronHarvestPickaxeItemId
            : McbotFabricClient::isBetterThanStoneIronHarvestPickaxeItemId;
        int existingHotbarSlot = allowStonePickaxe
            ? findIronHarvestPickaxeHotbarSlot(player)
            : findBetterThanStoneIronHarvestPickaxeHotbarSlot(player);
        if (existingHotbarSlot >= 0 && !nonPlayerScreenOpen) {
            FieldKitRecoveryPlanner.Decision hotbarDecision = applyFieldKitRecoveryDecision(run,
                FieldKitRecoveryPlanner.afterHotbarMove(fieldKitRecoveryState(run), false, existingHotbarSlot));
            if (hotbarDecision.action() == FieldKitRecoveryPlanner.Action.HOTBAR_PICKAXE_MOVED) {
                LOGGER.info(
                    "mine_nearby_iron.fieldkit_pickaxe_already_hotbar instanceId={} commandId={} hotbarSlot={} allowStonePickaxe={} recoveryAttempts={}",
                    instanceId,
                    run.commandId,
                    existingHotbarSlot,
                    allowStonePickaxe,
                    run.toolRecoveryAttempts
                );
                return new ControlDecision(stopFrom(effective, "mine_nearby_iron_fieldkit_pickaxe_already_hotbar"), InputState.stop());
            }
        }
        if (findInventorySlot(player, acceptablePickaxe, true) >= 0 && nonPlayerScreenOpen) {
            String previousHandler = player.currentScreenHandler.getClass().getSimpleName();
            player.closeHandledScreen();
            LOGGER.info(
                "mine_nearby_iron.fieldkit_pickaxe_screen_closed instanceId={} commandId={} handler={} allowStonePickaxe={} recoveryAttempts={}",
                instanceId,
                run.commandId,
                previousHandler,
                allowStonePickaxe,
                run.toolRecoveryAttempts
            );
            return new ControlDecision(stopFrom(effective, "mine_nearby_iron_fieldkit_close_screen_before_pickaxe"), InputState.stop());
        }
        if (!nonPlayerScreenOpen && allowStonePickaxe) {
            int movedHotbarSlot = movePreferredIronHarvestPickaxeToHotbar(client, player, true, run.commandId, "mine_nearby_iron");
            FieldKitRecoveryPlanner.Decision hotbarDecision = applyFieldKitRecoveryDecision(run,
                FieldKitRecoveryPlanner.afterHotbarMove(fieldKitRecoveryState(run), false, movedHotbarSlot));
            if (hotbarDecision.action() == FieldKitRecoveryPlanner.Action.HOTBAR_PICKAXE_MOVED) {
                return new ControlDecision(stopFrom(effective, "mine_nearby_iron_fieldkit_pickaxe_moved_hotbar"), InputState.stop());
            }
            if (hotbarDecision.action() == FieldKitRecoveryPlanner.Action.CLOSE_SCREEN_BEFORE_HOTBAR_MOVE) {
                return new ControlDecision(stopFrom(effective, "mine_nearby_iron_fieldkit_close_screen_before_hotbar_move"), InputState.stop());
            }
        } else if (!nonPlayerScreenOpen && proactiveRestock) {
            int movedHotbarSlot = movePreferredIronHarvestPickaxeToHotbar(client, player, false, run.commandId, "mine_nearby_iron");
            FieldKitRecoveryPlanner.Decision hotbarDecision = applyFieldKitRecoveryDecision(run,
                FieldKitRecoveryPlanner.afterHotbarMove(fieldKitRecoveryState(run), false, movedHotbarSlot));
            if (hotbarDecision.action() == FieldKitRecoveryPlanner.Action.HOTBAR_PICKAXE_MOVED) {
                return new ControlDecision(stopFrom(effective, "mine_nearby_iron_fieldkit_better_pickaxe_moved_hotbar"), InputState.stop());
            }
            LOGGER.info(
                "mine_nearby_iron.fieldkit_hotbar_move_skipped instanceId={} commandId={} reason=proactive_craft_required recoveryAttempts={}",
                instanceId,
                run.commandId,
                run.toolRecoveryAttempts
            );
        } else if (nonPlayerScreenOpen) {
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
                "mine_nearby_iron.fieldkit_state instanceId={} commandId={} recoveryActive={} retrievePending={} tablePlacedByRecovery={} craftingScreenOpen={} alcove={} cobblestone={} sticks={} tables={} hotbarPickaxeSlot={} hotbarIronPickaxeSlot={} hotbarStonePickaxeSlot={} recoveryAttempts={} proactive={} proactiveRestock={}",
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
                findIronHarvestPickaxeHotbarSlot(player),
                findBestHotbarSlotByRemaining(player, InventoryCounter::isIronPickaxeItemId),
                findBestHotbarSlotByRemaining(player, InventoryCounter::isStonePickaxeItemId),
                run.toolRecoveryAttempts,
                proactive,
                proactiveRestock
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
            // Live repro: 273 cobblestone + 3 sticks at depth but no table anywhere
            // (left behind, e.g. via the retrieve skip) -> terminal abort. A table is a 2x2
            // INVENTORY-GRID craft from 4 planks, so bootstrap a fresh one before surrendering;
            // the next pass then takes the normal PLACE_TABLE_REQUIRED -> craft-pickaxe route.
            InventoryCounter.InventoryPlankSnapshot fieldKitPlanks = InventoryCounter.countPlayerPlanks(player);
            if (fieldKitPlanks.plankCount() >= 4) {
                String tableCraftCommandId = run.toolCraftTableCommandId();
                ControlDecision tableCraftDecision = craft2x2Executor.resolve(
                    client,
                    player,
                    makeSubIntent(effective, "craft_table", tableCraftCommandId, "mine_nearby_iron_fieldkit_craft_table"),
                    nowMs
                );
                String tableCraftReason = tableCraftDecision.intent() == null ? "" : tableCraftDecision.intent().reason();
                if (tableCraftReason.startsWith("craft_table_complete:")) {
                    LOGGER.info(
                        "mine_nearby_iron.fieldkit_table_crafted instanceId={} commandId={} subCommandId={} reason={} recoveryAttempts={}",
                        instanceId,
                        run.commandId,
                        tableCraftCommandId,
                        tableCraftReason,
                        run.toolRecoveryAttempts
                    );
                    return new ControlDecision(stopFrom(effective, "mine_nearby_iron_fieldkit_table_crafted"), InputState.stop());
                }
                if (!tableCraftReason.startsWith("craft_table_failed:")) {
                    return tableCraftDecision;
                }
                // craft failed -> fall through to the original terminal failure.
            }
            LOGGER.warn(
                "mine_nearby_iron.fieldkit_failed instanceId={} commandId={} reason=no_table_available cobblestone={} sticks={} planks={} recoveryAttempts={}",
                instanceId,
                run.commandId,
                craftInventory.cobblestone.cobblestoneCount(),
                craftInventory.sticks.stickCount(),
                fieldKitPlanks.plankCount(),
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
            ControlDecision placeDecision = placeWorkstationExecutor.resolvePlaceTable(
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
        if (findIronHarvestPickaxeHotbarSlot(player) < 0) {
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
        return selectVisibleOreTarget(client, player, excluded, OreKind.IRON);
    }

    private BlockPos selectVisibleOreTarget(MinecraftClient client, ClientPlayerEntity player, Set<BlockPos> excluded, OreKind oreKind) {
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
                    if (!isOreBlock(oreKind, client.world.getBlockState(candidate))) {
                        continue;
                    }
                    if (oreKind == OreKind.DIAMOND && firstAdjacentLavaBlock(client, candidate) != null) {
                        LOGGER.info(
                            "{}.target_refused instanceId={} target={} reason=lava_adjacent",
                            oreKind.action,
                            instanceId,
                            candidate.toShortString()
                        );
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
        return selectVisibleOreProspectTarget(client, player, excluded);
    }

    private BlockPos selectVisibleOreProspectTarget(MinecraftClient client, ClientPlayerEntity player, Set<BlockPos> excluded) {
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
                    if (!isProspectableMiningBlock(client, candidate, state)) {
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

    private boolean isDiamondOreBlock(BlockState state) {
        return state != null && (state.isOf(Blocks.DIAMOND_ORE) || state.isOf(Blocks.DEEPSLATE_DIAMOND_ORE));
    }

    private boolean isOreBlock(OreKind oreKind, BlockState state) {
        return switch (oreKind) {
            case DIAMOND -> isDiamondOreBlock(state);
            case COAL -> isCoalOreBlock(state);
            case IRON -> isIronOreBlock(state);
        };
    }

    private boolean isProspectableIronMiningBlock(MinecraftClient client, BlockPos pos, BlockState state) {
        return isProspectableMiningBlock(client, pos, state);
    }

    private boolean isProspectableMiningBlock(MinecraftClient client, BlockPos pos, BlockState state) {
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

    private boolean isCheapMiningOccluder(BlockState state) {
        if (state == null || state.isAir()) {
            return false;
        }
        if (state.isIn(BlockTags.LEAVES)) {
            return true;
        }
        return BlockBreakController.isCheapOccluderBlockId(blockId(state));
    }

    @Override
    public BlockPos firstAdjacentLavaBlock(MinecraftClient client, BlockPos origin) {
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

    private int mineNearbyOreTargetDelta(OreKind oreKind, ClientPlayerEntity player) {
        if (oreKind != OreKind.IRON) {
            return oreKind.targetDelta;
        }
        CraftInventorySnapshot inventory = captureCraftInventory(player);
        IronMiningTargetDeltaPlanner.ArmorState armor = new IronMiningTargetDeltaPlanner.ArmorState(
            isEquippedArmorItem(player, ArmorPlanner.ArmorSlot.HELMET),
            isEquippedArmorItem(player, ArmorPlanner.ArmorSlot.CHESTPLATE),
            isEquippedArmorItem(player, ArmorPlanner.ArmorSlot.LEGGINGS),
            isEquippedArmorItem(player, ArmorPlanner.ArmorSlot.BOOTS),
            inventory.ironHelmets.itemCount(),
            inventory.ironChestplates.itemCount(),
            inventory.ironLeggings.itemCount(),
            inventory.ironBoots.itemCount()
        );
        return IronMiningTargetDeltaPlanner.targetDelta(
            inventory.rawIron.itemCount(),
            inventory.ironIngots.itemCount(),
            inventory.ironPickaxes.itemCount(),
            armor,
            oreKind.targetDelta,
            NEARBY_IRON_MAX_TARGET_RAW_IRON
        );
    }

    private boolean isEquippedArmorItem(ClientPlayerEntity player, ArmorPlanner.ArmorSlot slot) {
        return ArmorController.itemId(ArmorController.currentArmorStack(player, slot)).equals(slot.itemId());
    }

    private ControlDecision completeMineNearbyIron(
        BrainLink.Intent effective,
        MineNearbyIronRun run,
        InventoryCounter.InventoryItemSnapshot inventory,
        long nowMs,
        String reason
    ) {
        return completeMineNearbyOre(effective, run, inventory, nowMs, OreKind.IRON, reason);
    }

    private ControlDecision completeMineNearbyOre(
        BrainLink.Intent effective,
        MineNearbyIronRun run,
        InventoryCounter.InventoryItemSnapshot inventory,
        long nowMs,
        OreKind oreKind,
        String reason
    ) {
        finishedMineNearbyOreCommandReasons(oreKind).put(run.commandId, oreKind.action + "_complete:" + reason);
        LOGGER.info(
            "{}.complete instanceId={} commandId={} reason={} inventoryBefore={} inventoryAfter={} targetDelta={} prospectBlocksBroken={} itemsByItem={} elapsedMs={}",
            oreKind.action,
            instanceId,
            run.commandId,
            reason,
            run.baselineRawIron,
            inventory.itemCount(),
            run.targetDelta,
            run.prospectBlocksBroken,
            inventory.itemsByItem(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        setActiveMineNearbyOreRun(oreKind, null);
        brainLink.completeCurrentCommand(run.commandId, oreKind.action + "_complete:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, oreKind.action + "_complete:" + reason), InputState.stop());
    }

    private ControlDecision failMineNearbyIron(
        BrainLink.Intent effective,
        MineNearbyIronRun run,
        InventoryCounter.InventoryItemSnapshot inventory,
        long nowMs,
        String reason
    ) {
        return failMineNearbyOre(effective, run, inventory, nowMs, OreKind.IRON, reason);
    }

    private ControlDecision failMineNearbyOre(
        BrainLink.Intent effective,
        MineNearbyIronRun run,
        InventoryCounter.InventoryItemSnapshot inventory,
        long nowMs,
        OreKind oreKind,
        String reason
    ) {
        finishedMineNearbyOreCommandReasons(oreKind).put(run.commandId, oreKind.action + "_failed:" + reason);
        LOGGER.warn(
            "{}.failed instanceId={} commandId={} reason={} inventoryBefore={} inventoryAfter={} prospectBlocksBroken={} target={} elapsedMs={}",
            oreKind.action,
            instanceId,
            run.commandId,
            reason,
            run.baselineRawIron,
            inventory.itemCount(),
            run.prospectBlocksBroken,
            formatBlockPos(run.currentTarget),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        setActiveMineNearbyOreRun(oreKind, null);
        brainLink.completeCurrentCommand(run.commandId, oreKind.action + "_failed:" + reason, nowMs);
        return new ControlDecision(stopFrom(effective, oreKind.action + "_failed:" + reason), InputState.stop());
    }

    // B1 ascend-staircase knobs: engage above this vertical delta (below it, nav3d/pillar handles
    // the hop); per-step dig+climb budget; direction reroute cap before an honest failure.
    private static final double RETURN_ASCEND_MIN_DELTA = 4.0D;
    private static final long RETURN_ASCEND_STEP_TIMEOUT_MS = 8_000L;
    private static final int RETURN_ASCEND_MAX_REROUTES = 8;

    private static boolean isFallingBlockId(String blockId) {
        return blockId != null && (blockId.endsWith("gravel") || blockId.endsWith("sand"));
    }

    // One ascending stair step from feet toward direction d: the bot lands on supportCell (at its
    // own Y), passing through bodyCell/headCell (Y+1/Y+2 ahead). ceilingCell is what breaking the
    // head exposes — fluids or falling blocks there veto the direction BEFORE anything is opened.
    private boolean returnAscendDirectionSafe(MinecraftClient client, BlockPos feet, StaircaseDescentPlanner.Direction2d dir) {
        BlockPos support = feet.add(dir.dx(), 0, dir.dz());
        BlockPos body = support.up();
        BlockPos head = body.up();
        BlockPos ceiling = head.up();
        BlockState supportState = client.world.getBlockState(support);
        if (supportState.getCollisionShape(client.world, support).isEmpty() || isHazardBlockState(supportState)) {
            return false;
        }
        for (BlockPos cell : new BlockPos[] { body, head, ceiling }) {
            BlockState state = client.world.getBlockState(cell);
            if (!state.getFluidState().isEmpty()) {
                return false;
            }
        }
        return !isFallingBlockId(blockId(client.world.getBlockState(ceiling)));
    }

    private ControlDecision resolveReturnAscendControl(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        ReturnStaircaseRun run,
        BlockPos target,
        long nowMs
    ) {
        BlockPos feet = player.getBlockPos().toImmutable();
        // Step complete: the bot stands one block above the previous anchor. Re-derive everything.
        if (run.ascendStepAnchor != null && feet.getY() > run.ascendStepAnchor.getY()) {
            run.ascendSteps++;
            run.ascendDirection = null;
            run.ascendStepAnchor = null;
        }
        if (run.ascendDirection == null) {
            // Greedy: cardinals ordered by horizontal progress toward the target, first safe wins.
            double dx = target.getX() + 0.5D - player.getX();
            double dz = target.getZ() + 0.5D - player.getZ();
            List<StaircaseDescentPlanner.Direction2d> candidates = new ArrayList<>(List.of(
                new StaircaseDescentPlanner.Direction2d(1, 0, "east"),
                new StaircaseDescentPlanner.Direction2d(-1, 0, "west"),
                new StaircaseDescentPlanner.Direction2d(0, 1, "south"),
                new StaircaseDescentPlanner.Direction2d(0, -1, "north")
            ));
            candidates.sort((a, b) -> Double.compare(b.dx() * dx + b.dz() * dz, a.dx() * dx + a.dz() * dz));
            for (StaircaseDescentPlanner.Direction2d candidate : candidates) {
                if (returnAscendDirectionSafe(client, feet, candidate)) {
                    run.ascendDirection = candidate;
                    break;
                }
            }
            if (run.ascendDirection == null) {
                run.ascendReroutes++;
                if (run.ascendReroutes > RETURN_ASCEND_MAX_REROUTES) {
                    return failReturnStaircase(effective, run, player, nowMs, "return_ascend_no_safe_direction");
                }
                return new ControlDecision(stopFrom(effective, "return_ascend_blocked"), InputState.stop());
            }
            run.ascendStepAnchor = feet;
            run.ascendStepStartedAtMs = nowMs;
            LOGGER.info(
                "return_staircase.ascend_step instanceId={} commandId={} step={} feet={} direction={} reroutes={}",
                instanceId,
                run.commandId,
                run.ascendSteps,
                feet.toShortString(),
                run.ascendDirection.name(),
                run.ascendReroutes
            );
        }
        if (nowMs - run.ascendStepStartedAtMs > RETURN_ASCEND_STEP_TIMEOUT_MS) {
            // Step wedged: drop the direction and re-select (counts toward the reroute cap).
            run.ascendDirection = null;
            run.ascendStepAnchor = null;
            run.ascendReroutes++;
            if (run.ascendReroutes > RETURN_ASCEND_MAX_REROUTES) {
                return failReturnStaircase(effective, run, player, nowMs, "return_ascend_step_timeout");
            }
            return new ControlDecision(stopFrom(effective, "return_ascend_step_retry"), InputState.stop());
        }
        StaircaseDescentPlanner.Direction2d dir = run.ascendDirection;
        BlockPos anchor = run.ascendStepAnchor;
        BlockPos support = anchor.add(dir.dx(), 0, dir.dz());
        BlockPos body = support.up();
        BlockPos head = body.up();
        // Safety re-check every tick (a current may have moved fluid in since selection). Counts
        // toward the reroute cap — an uncounted reset loops forever (see the lesson below).
        if (!returnAscendDirectionSafe(client, anchor, dir)) {
            run.ascendDirection = null;
            run.ascendStepAnchor = null;
            run.ascendReroutes++;
            if (run.ascendReroutes > RETURN_ASCEND_MAX_REROUTES) {
                return failReturnStaircase(effective, run, player, nowMs, "return_ascend_unsafe_recheck");
            }
            return new ControlDecision(stopFrom(effective, "return_ascend_unsafe_recheck"), InputState.stop());
        }
        // Dig order: HEAD first (exposes the ceiling while the bot still stands clear), then body.
        for (BlockPos digTarget : new BlockPos[] { head, body }) {
            BlockState state = client.world.getBlockState(digTarget);
            if (state.isAir() || state.getCollisionShape(client.world, digTarget).isEmpty()) {
                continue;
            }
            BrainLink.Intent lookIntent = lookIntentForBlock(effective, player, digTarget, "return_ascend_face");
            if (!isLookingAtBlock(player, digTarget)) {
                return new ControlDecision(lookIntent, InputState.stop());
            }
            // Terrain-occluder mode (reason raycast_unbreakable_occluder x589): an
            // upward eye-ray from inside a shaft constantly clips other blocks first — those ARE
            // part of digging upward. Same mode as the iron mine-through digs.
            BlockBreakController.Result result = blockBreakController.tick(
                client, player, digTarget, run.commandId + ":ascend:" + run.ascendSteps, nowMs, false, 0L, true);
            if (result.status() == BlockBreakController.Status.FAILED) {
                // An instant controller FAILURE here cycled select->fail 1022 times —
                // the reset never counted toward the cap and the reason was swallowed. Count it,
                // log it, and fail honestly at the cap with the reason visible.
                run.ascendDirection = null;
                run.ascendStepAnchor = null;
                run.ascendReroutes++;
                LOGGER.warn(
                    "return_staircase.ascend_dig_failed instanceId={} commandId={} target={} reason={} reroutes={}",
                    instanceId,
                    run.commandId,
                    digTarget.toShortString(),
                    result.reason(),
                    run.ascendReroutes
                );
                if (run.ascendReroutes > RETURN_ASCEND_MAX_REROUTES) {
                    return failReturnStaircase(effective, run, player, nowMs, "return_ascend_dig_failed:" + result.reason());
                }
                return new ControlDecision(stopFrom(effective, "return_ascend_dig_failed"), InputState.stop());
            }
            return new ControlDecision(lookIntent, InputState.stop());
        }
        // Both cells clear: walk into the step with the jump assist; arrival is detected by the
        // anchor-Y check at the top of the next tick.
        double stepX = support.getX() + 0.5D;
        double stepZ = support.getZ() + 0.5D;
        double yaw = Math.toDegrees(Math.atan2(-(stepX - player.getX()), stepZ - player.getZ()));
        BrainLink.Intent moveIntent = lookIntentForAngles(effective, yaw, -20.0D, "return_ascend_climb");
        InputState input = new InputState(true, false, false, false, true, false, 1.0F, 0.0F);
        return new ControlDecision(moveIntent, input);
    }

    private ControlDecision resolveReturnStaircaseControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        List<BlockPos> returnPath = directReturnPathForCommand(completedDescentPaths, commandId);
        if (returnPath.isEmpty() && !lastCompletedDescentPath.isEmpty()) {
            returnPath = lastCompletedDescentPath;
        }
        return resolveReturnStaircaseControl(
            client,
            player,
            effective,
            nowMs,
            returnPath
        );
    }

    static List<BlockPos> directReturnPathForCommand(Map<String, List<BlockPos>> completedDescentPaths, String commandId) {
        if (completedDescentPaths == null || commandId == null || commandId.isBlank()) {
            return List.of();
        }
        return completedDescentPaths.getOrDefault(commandId, List.of());
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
        // No-breadcrumb deep returns scale with the actual climb (live runs timed out 14/15 returns
        // at the flat 35 s trying to ascend ~48 blocks): vertical blocks are dig-and-step work
        // (~5 s each budgeted), lateral blocks are walk work.
        long timeoutMs;
        if (run.returnPath.isEmpty()) {
            long vertical = Math.max(0L, target.getY() - (long) Math.floor(player.getY()));
            long horizontal = (long) Math.hypot(target.getX() + 0.5D - player.getX(), target.getZ() + 0.5D - player.getZ());
            timeoutMs = Math.max(RETURN_STAIRCASE_TIMEOUT_MS, vertical * 5_000L + horizontal * 400L);
        } else {
            timeoutMs = Math.max(RETURN_STAIRCASE_TIMEOUT_MS, (long) run.returnPath.size() * RETURN_STAIRCASE_STEP_TIMEOUT_MS);
        }
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
            return resolveReturnStaircaseBreadcrumbControl(client, player, effective, run, nowMs);
        }
        // B1 (live runs timed out 14/15 no-breadcrumb returns jump-climbing a 48-block ascent):
        // when the target is well ABOVE, dig an upward staircase toward it — the descent mirrored —
        // instead of asking 3-D nav to climb. Lateral/shallow legs keep the nav3d + walk path.
        if (target.getY() - player.getY() > RETURN_ASCEND_MIN_DELTA) {
            ControlDecision ascend = resolveReturnAscendControl(client, player, effective, run, target, nowMs);
            if (ascend != null) {
                return ascend;
            }
        }
        if (nav3dCollectEnabled) {
            // With no breadcrumb trail, fall back to the 3-D nav (+ mine-through) toward the final surface target.
            // When a recorded trail exists, it must drive the waypoint sequence; aiming straight at the final
            // surface cell turns a staircase return into an unsafe vertical tunnel/jump loop.
            ControlDecision nav3dReturn = tryNav3dDriveToward(
                client, player, effective, new Vec3d(targetX, target.getY(), targetZ), "return_staircase", commandId, nowMs);
            if (nav3dReturn != null) {
                return nav3dReturn;
            }
        }
        double dx = targetX - player.getX();
        double dz = targetZ - player.getZ();
        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        BrainLink.Intent intent = lookIntentForAngles(effective, yaw, 0.0D, "return_staircase_move");
        InputState input = new InputState(true, false, false, false, true, false, 1.0F, 0.0F);
        return new ControlDecision(intent, input);
    }

    private ControlDecision resolveReturnStaircaseBreadcrumbControl(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        ReturnStaircaseRun run,
        long nowMs
    ) {
        ReturnStaircasePlanner.Decision pathDecision = ReturnStaircasePlanner.decideBreadcrumbPathSize(run.returnPath.size());
        if (pathDecision.action() == ReturnStaircasePlanner.Action.FAIL_BREADCRUMB_PATH_TOO_SHORT) {
            return failReturnStaircase(effective, run, player, nowMs, pathDecision.reason());
        }
        if (run.waypointIndex < 0) {
            int nearestIndex = nearestReturnPathIndex(player, run.returnPath);
            boolean nearestReached = reachedReturnWaypoint(player, run.returnPath.get(nearestIndex));
            run.waypointIndex = ReturnStaircasePlanner.initialWaypointIndex(nearestIndex, nearestReached, run.returnPath.size());
            run.progressWaypointIndex = -1;
            run.nav3dWaypointIndex = -1;
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
            run.nav3dWaypointIndex = -1;
            run.pillarWaypointIndex = -1;
            run.pillarFailedWaypointIndex = -1;
            run.pillarLandingMinFloorY = Integer.MIN_VALUE;
            run.pillarPlacedAtMs = 0L;
            run.pillarAttemptStartedAtMs = 0L;
            run.pillarFoundation = null;
            run.pillarPlacementCell = null;
            run.lastPillarLogMs = 0L;
            blockPlaceController.reset();
            return new ControlDecision(stopFrom(effective, reachedDecision.reason()), InputState.stop());
        }

        double distanceSq = returnWaypointDistanceSq(player, waypoint);
        double dx = (waypoint.getX() + 0.5D) - player.getX();
        double dz = (waypoint.getZ() + 0.5D) - player.getZ();
        double horizontalDistanceSq = (dx * dx) + (dz * dz);
        int verticalGap = waypoint.getY() - (int) Math.floor(player.getY());
        ControlDecision pillarRecovery = resolveReturnStaircasePillarRecoveryControl(
            client,
            player,
            effective,
            run,
            waypoint,
            verticalGap,
            horizontalDistanceSq,
            nowMs
        );
        if (pillarRecovery != null) {
            return pillarRecovery;
        }

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

        if (ReturnStaircasePlanner.shouldStepUpToWaypoint(
            verticalGap,
            player.isOnGround(),
            player.horizontalCollision,
            horizontalDistanceSq,
            RETURN_STAIRCASE_STEP_UP_DISTANCE_BLOCKS
        )) {
            LookAngles climbLook = lookAnglesToPoint(
                player,
                new Vec3d(waypoint.getX() + 0.5D, waypoint.getY(), waypoint.getZ() + 0.5D)
            );
            InputState climbInput = new InputState(true, false, false, false, true, false, 1.0F, 0.0F);
            return new ControlDecision(
                lookIntentForAngles(effective, climbLook.yaw(), climbLook.pitch(), "return_staircase_breadcrumb_step_up:" + run.waypointIndex),
                climbInput
            );
        }

        if (verticalGap == 0 && horizontalDistanceSq <= 16.0D) {
            LookAngles levelLook = lookAnglesToPoint(
                player,
                new Vec3d(waypoint.getX() + 0.5D, waypoint.getY(), waypoint.getZ() + 0.5D)
            );
            if (!player.isOnGround()) {
                return new ControlDecision(
                    lookIntentForAngles(effective, levelLook.yaw(), levelLook.pitch(), "return_staircase_breadcrumb_wait_level_ground:" + run.waypointIndex),
                    InputState.stop()
                );
            }
            InputState levelInput = new InputState(true, false, false, false, player.horizontalCollision, false, 1.0F, 0.0F);
            return new ControlDecision(
                lookIntentForAngles(effective, levelLook.yaw(), levelLook.pitch(), "return_staircase_breadcrumb_level_move:" + run.waypointIndex),
                levelInput
            );
        }

        if (nav3dCollectEnabled) {
            if (run.nav3dWaypointIndex != run.waypointIndex) {
                clearNav3dDriveState();
                run.nav3dWaypointIndex = run.waypointIndex;
            }
            ControlDecision nav3dWaypoint = tryNav3dDriveToward(
                client,
                player,
                effective,
                new Vec3d(waypoint.getX() + 0.5D, waypoint.getY(), waypoint.getZ() + 0.5D),
                "return_staircase_breadcrumb",
                run.commandId,
                nowMs,
                true
            );
            if (nav3dWaypoint != null) {
                return nav3dWaypoint;
            }
        }

        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        BrainLink.Intent intent = lookIntentForAngles(effective, yaw, 0.0D, "return_staircase_breadcrumb_move:" + run.waypointIndex);
        InputState input = new InputState(true, false, false, false, jump, false, 1.0F, 0.0F);
        return new ControlDecision(intent, input);
    }

    private ControlDecision resolveReturnStaircasePillarRecoveryControl(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        ReturnStaircaseRun run,
        BlockPos waypoint,
        int verticalGap,
        double horizontalDistanceSq,
        long nowMs
    ) {
        boolean recovering = run.pillarWaypointIndex == run.waypointIndex;
        boolean failedAtWaypoint = run.pillarFailedWaypointIndex == run.waypointIndex;
        boolean shouldRecover = ReturnStaircasePlanner.shouldPillarRecover(
            recovering,
            failedAtWaypoint,
            verticalGap,
            horizontalDistanceSq,
            RETURN_STAIRCASE_PILLAR_DISTANCE_BLOCKS,
            RETURN_STAIRCASE_PILLAR_MAX_VERTICAL_GAP
        );
        if (!shouldRecover) {
            if (recovering) {
                blockPlaceController.reset();
                run.pillarWaypointIndex = -1;
                run.pillarLandingMinFloorY = Integer.MIN_VALUE;
                run.pillarPlacedAtMs = 0L;
                run.pillarAttemptStartedAtMs = 0L;
                run.pillarFoundation = null;
                run.pillarPlacementCell = null;
                run.lastPillarLogMs = 0L;
            }
            return null;
        }
        if (client == null || client.world == null || player == null) {
            return null;
        }

        BlockPos feet = player.getBlockPos().toImmutable();
        if (recovering && verticalGap == 1 && horizontalDistanceSq <= 2.25D && player.isOnGround()) {
            blockPlaceController.reset();
            run.pillarWaypointIndex = -1;
            run.pillarLandingMinFloorY = Integer.MIN_VALUE;
            run.pillarPlacedAtMs = 0L;
            run.pillarAttemptStartedAtMs = 0L;
            run.pillarFoundation = null;
            run.pillarPlacementCell = null;
            run.lastPillarLogMs = 0L;
            LOGGER.info(
                "return_staircase.pillar_release instanceId={} commandId={} waypointIndex={} waypoint={} current={} reason=near_one_block_step verticalGap={} distance={} placements={}",
                instanceId,
                run.commandId,
                run.waypointIndex,
                waypoint.toShortString(),
                feet.toShortString(),
                verticalGap,
                roundForLog(Math.sqrt(horizontalDistanceSq)),
                run.pillarPlacements
            );
            return null;
        }
        BlockPos candidateFoundation = feet.down().toImmutable();
        if (!recovering || run.pillarFoundation == null || run.pillarPlacementCell == null) {
            run.pillarFoundation = candidateFoundation;
            run.pillarPlacementCell = candidateFoundation.up().toImmutable();
            run.pillarAttemptStartedAtMs = nowMs;
        }
        BlockPos foundation = run.pillarFoundation;
        BlockPos placementCell = run.pillarPlacementCell;
        if (!isStableDescentSupport(client, foundation)) {
            if (run.lastPillarLogMs <= 0L || nowMs - run.lastPillarLogMs >= 1_000L) {
                run.lastPillarLogMs = nowMs;
                LOGGER.info(
                    "return_staircase.pillar_skipped instanceId={} commandId={} waypointIndex={} waypoint={} current={} reason=unstable_foundation foundation={} verticalGap={} distance={}",
                    instanceId,
                    run.commandId,
                    run.waypointIndex,
                    waypoint.toShortString(),
                    feet.toShortString(),
                    foundation.toShortString(),
                    verticalGap,
                    roundForLog(Math.sqrt(horizontalDistanceSq))
                );
            }
            if (recovering) {
                blockPlaceController.reset();
                run.pillarWaypointIndex = -1;
                run.pillarFoundation = null;
                run.pillarPlacementCell = null;
                run.pillarAttemptStartedAtMs = 0L;
            }
            return null;
        }

        if (!recovering) {
            blockPlaceController.reset();
            run.pillarWaypointIndex = run.waypointIndex;
            run.lastPillarLogMs = 0L;
            LOGGER.info(
                "return_staircase.pillar_start instanceId={} commandId={} waypointIndex={} waypoint={} current={} foundation={} verticalGap={} distance={}",
                instanceId,
                run.commandId,
                run.waypointIndex,
                waypoint.toShortString(),
                feet.toShortString(),
                foundation.toShortString(),
                verticalGap,
                roundForLog(Math.sqrt(horizontalDistanceSq))
            );
        }

        Vec3d supportTop = new Vec3d(foundation.getX() + 0.5D, foundation.getY() + 1.0D, foundation.getZ() + 0.5D);
        LookAngles placeLook = lookAnglesToPoint(player, supportTop);
        if (player.isOnGround()) {
            double anchorDx = (placementCell.getX() + 0.5D) - player.getX();
            double anchorDz = (placementCell.getZ() + 0.5D) - player.getZ();
            double anchorDistanceSq = (anchorDx * anchorDx) + (anchorDz * anchorDz);
            if (anchorDistanceSq > 4.0D) {
                blockPlaceController.reset();
                run.pillarWaypointIndex = -1;
                run.pillarFoundation = null;
                run.pillarPlacementCell = null;
                run.pillarAttemptStartedAtMs = 0L;
                return null;
            }
            if (anchorDistanceSq > 0.25D) {
                double centerYaw = Math.toDegrees(Math.atan2(-anchorDx, anchorDz));
                return new ControlDecision(
                    lookIntentForAngles(effective, centerYaw, placeLook.pitch(), "return_staircase_pillar_center:" + run.waypointIndex),
                    new InputState(true, false, false, false, false, false, 1.0F, 0.0F)
                );
            }
        }
        run.lastWaypointProgressMs = nowMs;
        run.progressWaypointIndex = run.waypointIndex;
        run.bestWaypointDistanceSq = Math.min(run.bestWaypointDistanceSq, returnWaypointDistanceSq(player, waypoint));
        if (player.isOnGround()) {
            BlockPos headroomTarget = returnPillarHeadroomTarget(client, feet);
            if (headroomTarget != null) {
                BlockBreakController.Result clearResult = blockBreakController.tick(
                    client,
                    player,
                    headroomTarget,
                    run.commandId + ":return_pillar_headroom:" + run.waypointIndex,
                    nowMs
                );
                if (clearResult.status() == BlockBreakController.Status.BROKEN) {
                    run.lastWaypointProgressMs = nowMs;
                    LOGGER.info(
                        "return_staircase.pillar_headroom_broke instanceId={} commandId={} waypointIndex={} target={} reason={} elapsedMs={}",
                        instanceId,
                        run.commandId,
                        run.waypointIndex,
                        headroomTarget.toShortString(),
                        clearResult.reason(),
                        clearResult.elapsedMs()
                    );
                    return new ControlDecision(stopFrom(effective, "return_staircase_pillar_headroom_broke:" + run.waypointIndex), InputState.stop());
                }
                if (run.lastPillarLogMs <= 0L || nowMs - run.lastPillarLogMs >= 500L || clearResult.status() != BlockBreakController.Status.RUNNING) {
                    run.lastPillarLogMs = nowMs;
                    LOGGER.info(
                        "return_staircase.pillar_headroom_clear instanceId={} commandId={} waypointIndex={} waypoint={} current={} target={} status={} reason={} hitBlock={} actedBlock={} elapsedMs={}",
                        instanceId,
                        run.commandId,
                        run.waypointIndex,
                        waypoint.toShortString(),
                        feet.toShortString(),
                        headroomTarget.toShortString(),
                        clearResult.status(),
                        clearResult.reason(),
                        formatBlockPos(clearResult.hitBlock()),
                        formatBlockPos(clearResult.actedBlock()),
                        clearResult.elapsedMs()
                    );
                }
                if (clearResult.status() == BlockBreakController.Status.FAILED && "break_timeout".equals(clearResult.reason())) {
                    run.pillarFailedWaypointIndex = run.waypointIndex;
                    run.pillarWaypointIndex = -1;
                    run.pillarAttemptStartedAtMs = 0L;
                    run.pillarFoundation = null;
                    run.pillarPlacementCell = null;
                    blockBreakController.reset();
                    LOGGER.warn(
                        "return_staircase.pillar_headroom_failed instanceId={} commandId={} waypointIndex={} waypoint={} current={} target={} reason={} verticalGap={} distance={} placements={}",
                        instanceId,
                        run.commandId,
                        run.waypointIndex,
                        waypoint.toShortString(),
                        feet.toShortString(),
                        headroomTarget.toShortString(),
                        clearResult.reason(),
                        verticalGap,
                        roundForLog(Math.sqrt(horizontalDistanceSq)),
                        run.pillarPlacements
                    );
                    return null;
                }
                return new ControlDecision(
                    lookIntentForBlock(effective, player, headroomTarget, "return_staircase_pillar_headroom_clear:" + run.waypointIndex + ":" + clearResult.reason()),
                    InputState.stop()
                );
            }
            InventoryCounter.InventoryCobblestoneSnapshot cobblestone = InventoryCounter.countPlayerCobblestone(player);
            if (cobblestone.cobblestoneCount() <= 0) {
                blockPlaceController.reset();
                run.pillarWaypointIndex = -1;
                run.pillarLandingMinFloorY = Integer.MIN_VALUE;
                run.pillarPlacedAtMs = 0L;
                run.pillarAttemptStartedAtMs = 0L;
                run.pillarFoundation = null;
                run.pillarPlacementCell = null;
                LOGGER.info(
                    "return_staircase.pillar_no_support_blocks instanceId={} commandId={} waypointIndex={} waypoint={} current={} verticalGap={} distance={} placements={}",
                    instanceId,
                    run.commandId,
                    run.waypointIndex,
                    waypoint.toShortString(),
                    player.getBlockPos().toShortString(),
                    verticalGap,
                    roundForLog(Math.sqrt(horizontalDistanceSq)),
                    run.pillarPlacements
                );
                return null;
            }
        }
        if (findHotbarSlot(player, InventoryCounter::isCobblestoneItemId) < 0) {
            int movedHotbarSlot = moveInventoryItemToHotbar(
                client,
                player,
                InventoryCounter::isCobblestoneItemId,
                run.commandId,
                "return_staircase"
            );
            if (movedHotbarSlot == -2) {
                return new ControlDecision(stopFrom(effective, "return_staircase_pillar_close_screen_before_hotbar_move"), InputState.stop());
            }
            if (movedHotbarSlot >= 0) {
                LOGGER.info(
                    "return_staircase.pillar_hotbar_move instanceId={} commandId={} waypointIndex={} hotbarSlot={} cobblestone={} current={}",
                    instanceId,
                    run.commandId,
                    run.waypointIndex,
                    movedHotbarSlot,
                    InventoryCounter.countPlayerCobblestone(player).cobblestoneCount(),
                    player.getBlockPos().toShortString()
                );
                return new ControlDecision(stopFrom(effective, "return_staircase_pillar_hotbar_move:" + run.waypointIndex), InputState.stop());
            }
        }
        if (run.pillarLandingMinFloorY > Integer.MIN_VALUE) {
            int floorY = (int) Math.floor(player.getY());
            if (player.isOnGround() && floorY >= run.pillarLandingMinFloorY) {
                run.pillarLandingMinFloorY = Integer.MIN_VALUE;
                run.pillarPlacedAtMs = 0L;
            } else if (nowMs - run.pillarPlacedAtMs < 1_500L) {
                return new ControlDecision(
                    lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "return_staircase_pillar_landing:" + run.waypointIndex),
                    InputState.stop()
                );
            } else {
                run.pillarLandingMinFloorY = Integer.MIN_VALUE;
                run.pillarPlacedAtMs = 0L;
            }
        }
        if (player.isOnGround()) {
            InputState jumpInput = new InputState(false, false, false, false, true, false, 0.0F, 0.0F);
            return new ControlDecision(
                lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "return_staircase_pillar_jump:" + run.waypointIndex),
                jumpInput
            );
        }
        BlockPlaceController.Result result = blockPlaceController.tick(
            client,
            player,
            run.commandId + ":return_pillar:" + run.waypointIndex,
            nowMs,
            foundation,
            BlockPlaceController.PlaceSpec.cobblestone()
        );
        if (run.lastPillarLogMs <= 0L || nowMs - run.lastPillarLogMs >= 500L || result.status() != BlockPlaceController.Status.RUNNING) {
            run.lastPillarLogMs = nowMs;
            LOGGER.info(
                "return_staircase.pillar_progress instanceId={} commandId={} waypointIndex={} waypoint={} current={} reason={} hitBlock={} hitSide={} placedBlock={} selectedHotbarSlot={} elapsedMs={}",
                instanceId,
                run.commandId,
                run.waypointIndex,
                waypoint.toShortString(),
                player.getBlockPos().toShortString(),
                result.reason(),
                formatBlockPos(result.hitBlock()),
                result.hitSide() == null ? "none" : result.hitSide().asString(),
                formatBlockPos(result.placedBlock()),
                result.selectedHotbarSlot(),
                result.elapsedMs()
            );
        }
        if (result.status() == BlockPlaceController.Status.PLACED) {
            run.pillarPlacements++;
            run.pillarFailedWaypointIndex = -1;
            run.pillarPlacedAtMs = nowMs;
            run.pillarLandingMinFloorY = foundation.getY() + 2;
            run.pillarAttemptStartedAtMs = 0L;
            run.pillarFoundation = null;
            run.pillarPlacementCell = null;
            run.lastWaypointProgressMs = nowMs;
            clearNav3dDriveState();
            return new ControlDecision(stopFrom(effective, "return_staircase_pillar_placed:" + run.waypointIndex), InputState.stop());
        }
        if (result.status() == BlockPlaceController.Status.FAILED) {
            run.pillarFailedWaypointIndex = run.waypointIndex;
            run.pillarWaypointIndex = -1;
            run.pillarAttemptStartedAtMs = 0L;
            run.pillarFoundation = null;
            run.pillarPlacementCell = null;
            blockPlaceController.reset();
            LOGGER.warn(
                "return_staircase.pillar_failed instanceId={} commandId={} waypointIndex={} waypoint={} current={} reason={} verticalGap={} distance={} placements={}",
                instanceId,
                run.commandId,
                run.waypointIndex,
                waypoint.toShortString(),
                player.getBlockPos().toShortString(),
                result.reason(),
                verticalGap,
                roundForLog(Math.sqrt(horizontalDistanceSq)),
                run.pillarPlacements
            );
            return null;
        }

        boolean keepJumping = "placement_cell_occupied_by_player".equals(result.reason());
        InputState holdInput = new InputState(false, false, false, false, keepJumping, false, 0.0F, 0.0F);
        return new ControlDecision(
            lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "return_staircase_pillar_place:" + run.waypointIndex + ":" + result.reason()),
            holdInput
        );
    }

    private BlockPos returnPillarHeadroomTarget(MinecraftClient client, BlockPos feet) {
        if (client == null || client.world == null || feet == null) {
            return null;
        }
        for (int dy : new int[] { 1, 2 }) {
            BlockPos target = feet.up(dy).toImmutable();
            BlockState state = client.world.getBlockState(target);
            if (state == null || state.isAir() || state.getCollisionShape(client.world, target).isEmpty()) {
                continue;
            }
            if (isHazardBlockState(state)) {
                return null;
            }
            return target;
        }
        return null;
    }

    private int nearestReturnPathIndex(ClientPlayerEntity player, List<BlockPos> path) {
        int bestIndex = Math.max(0, path.size() - 1);
        double bestDistanceSq = Double.POSITIVE_INFINITY;
        int floorY = (int) Math.floor(player.getY());
        int deepestIndex = Math.max(0, path.size() - 1);
        int deepestY = Integer.MAX_VALUE;
        for (int index = 0; index < path.size(); index++) {
            int y = path.get(index).getY();
            if (y <= deepestY) {
                deepestY = y;
                deepestIndex = index;
            }
        }
        if (floorY < deepestY - 1) {
            return deepestIndex;
        }
        boolean foundStepReachableHeight = false;
        for (int index = 0; index < path.size(); index++) {
            BlockPos waypoint = path.get(index);
            if (waypoint.getY() > floorY + 1) {
                continue;
            }
            foundStepReachableHeight = true;
            double distanceSq = returnWaypointDistanceSq(player, waypoint);
            if (distanceSq <= bestDistanceSq) {
                bestDistanceSq = distanceSq;
                bestIndex = index;
            }
        }
        if (foundStepReachableHeight) {
            return bestIndex;
        }
        for (int index = 0; index < path.size(); index++) {
            double distanceSq = returnWaypointDistanceSq(player, path.get(index));
            if (distanceSq <= bestDistanceSq) {
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
            BrainLink.Intent subIntent = phaseIntent(effective, "descend_staircase", target, "r2_descend_staircase", run.descentCommandId());
            ControlDecision decision = resolveDescendStaircaseControl(client, player, subIntent, nowMs);
            String reason = decision.intent().reason();
            if (reason != null && reason.startsWith("descent_complete:")) {
                run.returnPath = completedDescentPaths.getOrDefault(run.descentCommandId(), List.of());
                run.phase = R2MineStoneReturnPhase.MINE;
                LOGGER.info(
                    "r2_mine_stone_return.phase instanceId={} commandId={} phase=mine cobblestoneBaseline={} returnPathCount={} returnPathStart={} returnPathEnd={} elapsedMs={}",
                    instanceId,
                    run.commandId,
                    InventoryCounter.countPlayerCobblestone(player).cobblestoneCount(),
                    run.returnPath.size(),
                    run.returnPath.isEmpty() ? "none" : run.returnPath.get(0).toShortString(),
                    run.returnPath.isEmpty() ? "none" : run.returnPath.get(run.returnPath.size() - 1).toShortString(),
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

        BrainLink.Intent subIntent = phaseIntent(effective, "return_staircase", run.startFeet, "r2_return_staircase", run.returnCommandId());
        ControlDecision decision = resolveReturnStaircaseControl(client, player, subIntent, nowMs, run.returnPath);
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
            ControlDecision decision = placeWorkstationExecutor.resolvePlaceTable(
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
            ControlDecision decision = placeWorkstationExecutor.resolvePlaceFurnace(
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
                if (run.containerTransitionSettleUntilMs > nowMs) {
                    return new ControlDecision(stopFrom(effective, "r5_iron_chain_container_settle_before_craft"), InputState.stop());
                }
                if (client.currentScreen != null) {
                    Screen currentScreen = client.currentScreen;
                    ScreenHandler currentHandler = player.currentScreenHandler;
                    if (currentHandler != null && currentHandler != player.playerScreenHandler) {
                        player.closeHandledScreen();
                    }
                    client.setScreen(null);
                    run.containerTransitionSettleUntilMs = nowMs + R5_CONTAINER_TRANSITION_SETTLE_MS;
                    LOGGER.info(
                        "r5_iron_chain.close_screen instanceId={} commandId={} reason=before_craft screen={} handler={}",
                        instanceId,
                        run.commandId,
                        currentScreen.getClass().getSimpleName(),
                        currentHandler == null ? "none" : currentHandler.getClass().getSimpleName()
                    );
                    return new ControlDecision(stopFrom(effective, "r5_iron_chain_close_screen_before_craft"), InputState.stop());
                }
                if (player.currentScreenHandler != null && player.currentScreenHandler != player.playerScreenHandler) {
                    String handler = player.currentScreenHandler.getClass().getSimpleName();
                    player.closeHandledScreen();
                    run.containerTransitionSettleUntilMs = nowMs + R5_CONTAINER_TRANSITION_SETTLE_MS;
                    LOGGER.info(
                        "r5_iron_chain.close_screen instanceId={} commandId={} reason=before_craft handler={}",
                        instanceId,
                        run.commandId,
                        handler
                    );
                    return new ControlDecision(stopFrom(effective, "r5_iron_chain_close_screen_before_craft"), InputState.stop());
                }
                run.containerTransitionSettleUntilMs = 0L;
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
            if (run.containerTransitionSettleUntilMs > nowMs) {
                return new ControlDecision(stopFrom(effective, "r5_iron_chain_container_settle_before_craft"), InputState.stop());
            }
            if (player.currentScreenHandler != null
                && player.currentScreenHandler != player.playerScreenHandler
                && !(player.currentScreenHandler instanceof CraftingScreenHandler)) {
                String handler = player.currentScreenHandler.getClass().getSimpleName();
                player.closeHandledScreen();
                run.containerTransitionSettleUntilMs = nowMs + R5_CONTAINER_TRANSITION_SETTLE_MS;
                LOGGER.info(
                    "r5_iron_chain.close_screen instanceId={} commandId={} reason=before_craft handler={}",
                    instanceId,
                    run.commandId,
                    handler
                );
                return new ControlDecision(stopFrom(effective, "r5_iron_chain_close_screen_before_craft"), InputState.stop());
            }
            run.containerTransitionSettleUntilMs = 0L;
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
            return new ControlDecision(
                stopFrom(effective, finishedGatherTreeCommandReasons.getOrDefault(commandId, "gather_tree_complete")),
                InputState.stop()
            );
        }
        BlockPos seed = preserveActiveGatherTreeSeedForCommand(
            commandId,
            targetBlockPos(effective),
            activeGatherTree == null ? null : activeGatherTree.commandId,
            activeGatherTree == null ? null : activeGatherTree.seed
        );
        if (seed != null && isIgnoredGatherTreeSeed(seed)) {
            GridCell rejectedColumn = new GridCell(seed.getX(), seed.getZ());
            // Loop fix: a re-hinted ignored seed must never instant-complete the command —
            // the orchestrator treats complete+no-wood as "reissue", which spun 119 one-second
            // commands. Whether or not this column's salvage was already attempted, route to a
            // fresh live seed (selection respects the ignore list) or to the search legs: the
            // command always does real work.
            if (!attemptedGatherTreeIgnoredSeedSalvageColumns.contains(rejectedColumn)) {
                attemptedGatherTreeIgnoredSeedSalvageColumns.add(rejectedColumn);
            } else {
                LOGGER.warn(
                    "gather_tree.ignored_seed_salvage_skipped instanceId={} commandId={} rejectedSeed={} reason=salvage_already_attempted_reroute",
                    instanceId,
                    commandId,
                    seed.toShortString()
                );
            }
            LiveGatherTreeSeed replacement = selectLiveGatherTreeSeed(client, player);
            if (replacement != null) {
                LOGGER.info(
                    "gather_tree.seed_replaced instanceId={} commandId={} rejectedSeed={} replacement={} source={} candidates={}",
                    instanceId,
                    commandId,
                    seed.toShortString(),
                    replacement.pos().toShortString(),
                    replacement.source(),
                    replacement.candidates()
                );
                seed = replacement.pos();
                activeGatherTreeSearch = null;
            } else {
                LOGGER.warn(
                    "gather_tree.ignored_seed_search instanceId={} commandId={} rejectedSeed={} reason=no_live_replacement",
                    instanceId,
                    commandId,
                    seed.toShortString()
                );
                return resolveGatherTreeSearchControl(client, player, effective, nowMs);
            }
        }
        if (seed == null) {
            LiveGatherTreeSeed liveSeed = selectLiveGatherTreeSeed(client, player);
            if (liveSeed != null) {
                seed = liveSeed.pos();
                activeGatherTreeSearch = null;
                LOGGER.info(
                    "gather_tree.seed_selected instanceId={} commandId={} seed={} source={} candidates={}",
                    instanceId,
                    commandId,
                    seed.toShortString(),
                    liveSeed.source(),
                    liveSeed.candidates()
                );
            }
        }
        if (seed == null) {
            return resolveGatherTreeSearchControl(client, player, effective, nowMs);
        }
        if (activeGatherTree == null || !commandId.equals(activeGatherTree.commandId)) {
            InventoryCounter.InventoryLogSnapshot inventory = InventoryCounter.countPlayerLogs(player);
            Set<BlockPos> cluster = discoverTreeLogCluster(client.world, seed);
            activeGatherTreeSearch = null;
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
            if (!cluster.isEmpty()) {
                // Real harvesting is beginning: the relocation budgets refresh — the next sparse
                // area gets its own marches and descents.
                gatherSearchRelocations = 0;
                gatherSearchDescendRelocations = 0;
                gatherSearchMarchLegsRemaining = 0;
                gatherSearchMarchDirection = null;
            }
            if (cluster.isEmpty()) {
                // Hint-treadmill guard: a brain hint that resolves to NO cluster
                // must be ignored like any other unusable seed, or the next hint lands one block over
                // and the mission burns its whole progress window on instant seed_not_log completions
                // (W26 repro: hints marched x=-6..-11 along a harvested oak's leftover branch line).
                // Ignoring the column routes repeated hints into the existing salvage/search path.
                ignoredGatherTreeColumns.add(new GridCell(seed.getX(), seed.getZ()));
                LOGGER.warn(
                    "gather_tree.zero_cluster_seed_ignored instanceId={} commandId={} seed={}",
                    instanceId,
                    commandId,
                    seed.toShortString()
                );
                completedGatherTreeCommandIds.add(commandId);
                finishedGatherTreeCommandReasons.put(commandId, "gather_tree_complete:seed_not_log");
                activeGatherTree = null;
                return new ControlDecision(stopFrom(effective, "gather_tree_complete:seed_not_log"), InputState.stop());
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
            TreeGatherPlanner.Selection selection = selectNextTreeTarget(client, player, run, nowMs);
            if (selection.target() == null) {
                // Vertical-harvest slice (gather family fix, tall-spruce repro): logs left
                // 2-5 blocks DIRECTLY overhead are breakable from where the bot stands — the side
                // adjacent-cell model just can't represent them (no standable cell at log height).
                // Target the lowest such log and break upward from the current stance; the breaker's
                // own raycast/reach gates rule, and an occluded attempt abandons normally. The +6-and-
                // above remainder needs true pillar work (still ledgered).
                BlockPos overhead = selectGatherTreeOverheadTarget(client, player, run);
                if (overhead != null) {
                    run.currentTarget = overhead.toImmutable();
                    run.currentAdjacentCell = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
                    run.currentAdjacentRoute = List.of();
                    run.currentAdjacentReached = true;
                    run.currentAdjacentLatchLogged = false;
                    run.currentAdjacentLatchHoldLogged = false;
                    run.targetOutOfReachRepositions = 0;
                    run.breakDone = false;
                    run.breakStarted = false;
                    run.collectStartedAtMs = 0L;
                    run.currentAdjacentProgress.reset();
                    LOGGER.info(
                        "gather_tree.overhead_target instanceId={} commandId={} target={} playerFeetY={} reason=vertical_harvest",
                        instanceId,
                        commandId,
                        run.currentTarget.toShortString(),
                        (int) Math.floor(player.getY())
                    );
                    return new ControlDecision(stopFrom(effective, "gather_tree_overhead_target"), InputState.stop());
                }
                if (shouldRetryPartialGatherTreeExhaustion(
                    selection.reason(),
                    inventory.logCount(),
                    run.baselineLogCount,
                    run.partialExhaustionRetries
                )) {
                    run.partialExhaustionRetries++;
                    run.abandonedTargets.clear();
                    run.excludedAdjacentCells.clear();
                    run.currentAdjacentProgress.reset();
                    clearNavigationState();
                    LOGGER.warn(
                        "gather_tree.partial_exhaustion_retry instanceId={} commandId={} reason={} inventoryLogsBefore={} inventoryLogsAfter={} retries={} targetLogs={}",
                        instanceId,
                        commandId,
                        selection.reason(),
                        run.baselineLogCount,
                        inventory.logCount(),
                        run.partialExhaustionRetries,
                        GATHER_TREE_PARTIAL_EXHAUSTION_LOG_TARGET
                    );
                    return new ControlDecision(stopFrom(effective, "gather_tree_partial_exhaustion_retry"), InputState.stop());
                }
                return completeGatherTree(client, inventory, effective, run, nowMs, selection.reason());
            }
            run.currentTarget = selection.target().toImmutable();
            run.currentAdjacentCell = null;
            run.currentAdjacentRoute = List.of();
            run.currentAdjacentReached = false;
            run.currentAdjacentLatchLogged = false;
            run.currentAdjacentLatchHoldLogged = false;
            run.targetOutOfReachRepositions = 0;
            run.breakDone = false;
            run.breakStarted = false;
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
            boolean directBreakAllowed = run.breakStarted
                || (run.excludedAdjacentCells.isEmpty() && isDirectGatherTreeBreakReach(player, target));
            if (directBreakAllowed) {
                ControlDecision directBreak = resolveGatherTreeBreakControl(client, player, effective, run, target, nowMs);
                if (directBreak != null) {
                    return directBreak;
                }
            }
            ControlDecision nav = navigateToGatherTreeAdjacentCell(client, player, effective, run, nowMs);
            if (nav != null) {
                return nav;
            }
            ControlDecision breakDecision = resolveGatherTreeBreakControl(client, player, effective, run, target, nowMs);
            if (breakDecision != null) {
                return breakDecision;
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
            ControlDecision stalledDrop = maybeAbandonGatherTreeCollectNoProgress(
                player,
                effective,
                run,
                inventory,
                target,
                droppedLogPosition,
                nowMs
            );
            if (stalledDrop != null) {
                return stalledDrop;
            }
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
            boolean preferSideCollect = shouldPreferGatherTreeSideCollectBeforeDirect(player, run, droppedLogPosition);
            if (!preferSideCollect) {
                ControlDecision directCollect = maybeResolveGatherTreeDroppedLogDirectCollect(
                    client,
                    player,
                    effective,
                    run,
                    droppedLogPosition
                );
                if (directCollect != null) {
                    return directCollect;
                }
            }
            // FPS: throttle the every-tick side-collect scan (3x3 grid + per-cell A* on the render
            // thread). Recompute at most every GATHER_TREE_SIDE_COLLECT_SCAN_INTERVAL_MS per drop cell;
            // reuse the last result between (the bot is just walking to the same cell). The R0b·2
            // escalation below still runs every tick on the cached/fresh intent, so its streak is unchanged.
            String sideCollectScanKey = roundForLog(droppedLogPosition.x) + ":" + roundForLog(droppedLogPosition.z);
            BrainLink.Intent sideCollectIntent;
            if (sideCollectScanKey.equals(run.sideCollectCacheKey)
                && nowMs - run.sideCollectCacheAtMs < GATHER_TREE_SIDE_COLLECT_SCAN_INTERVAL_MS) {
                sideCollectIntent = run.sideCollectCacheIntent;
            } else {
                sideCollectIntent = gatherTreeSideCollectIntent(client, player, effective, run, droppedLogPosition);
                run.sideCollectCacheKey = sideCollectScanKey;
                run.sideCollectCacheAtMs = nowMs;
                run.sideCollectCacheIntent = sideCollectIntent;
            }
            if (sideCollectIntent != null) {
                // R0b·2: guard the side-collect cycling livelock. Count consecutive side-collect
                // selections for this drop that make no progress (no inventory gain, no net distance
                // improvement) and abandon at the streak limit; any progress resets the streak inside
                // the tracker, so a slow-but-advancing approach is never abandoned (06-11 regression).
                double sideCollectDropDistance = Math.hypot(
                    droppedLogPosition.x - player.getX(), droppedLogPosition.z - player.getZ());
                String sideChurnKey = target.toShortString() + ":" + roundForLog(droppedLogPosition.x) + ":"
                    + roundForLog(droppedLogPosition.y) + ":" + roundForLog(droppedLogPosition.z);
                if (run.sideCollectStall.shouldEscalate(sideChurnKey, inventory.logCount(), sideCollectDropDistance)) {
                    run.collectTimeouts++;
                    run.abandonedTargets.add(target);
                    LOGGER.warn(
                        "gather_tree.collect_side_churn_abandon instanceId={} commandId={} target={} dropDistance={} streak={} collectTimeouts={}",
                        instanceId,
                        commandId,
                        target.toShortString(),
                        roundForLog(sideCollectDropDistance),
                        GATHER_TREE_SIDE_COLLECT_CHURN_STREAK,
                        run.collectTimeouts
                    );
                    resetGatherTreeCurrentTarget(run);
                    return new ControlDecision(stopFrom(effective, "gather_tree_collect_side_churn_abandon_continue"), InputState.stop());
                }
                collectIntent = sideCollectIntent;
            } else {
                if (shouldAbandonGatherTreeUnreachableDrop(player.getY(), droppedLogPosition.y, false)) {
                    run.collectTimeouts++;
                    run.abandonedTargets.add(target);
                    LOGGER.warn(
                        "gather_tree.collect_drop_unreachable instanceId={} commandId={} target={} itemY={} playerY={} collectTimeouts={}",
                        instanceId,
                        commandId,
                        target.toShortString(),
                        roundForLog(droppedLogPosition.y),
                        roundForLog(player.getY()),
                        run.collectTimeouts
                    );
                    resetGatherTreeCurrentTarget(run);
                    return new ControlDecision(stopFrom(effective, "gather_tree_collect_drop_unreachable_continue"), InputState.stop());
                }
                collectIntent = gatherCollectIntent(
                    effective,
                    droppedLogPosition.x,
                    droppedLogPosition.y,
                    droppedLogPosition.z,
                    "gather_tree_collect_item",
                    ":tree:collect:item"
                );
            }
        } else {
            collectIntent = gatherCollectIntent(effective, target, run.currentAdjacentCell);
        }
        ControlDecision collectDecision = resolveNavigationControl(client, player, collectIntent);
        String collectDecisionReason = collectDecision == null || collectDecision.intent() == null
            ? ""
            : collectDecision.intent().reason();
        if (shouldAbandonGatherTreeCollectRouteRejection(
            collectIntent.reason(),
            collectIntent.commandId(),
            collectDecisionReason
        )) {
            run.collectTimeouts++;
            run.abandonedTargets.add(target);
            LOGGER.warn(
                "gather_tree.collect_item_rejected instanceId={} commandId={} target={} reason={} inventoryLogsBefore={} inventoryLogsAfter={} collectTimeouts={}",
                instanceId,
                commandId,
                target.toShortString(),
                collectDecisionReason,
                run.baselineLogCount,
                inventory.logCount(),
                run.collectTimeouts
            );
            resetGatherTreeCurrentTarget(run);
            clearNavigationState();
            return new ControlDecision(stopFrom(effective, "gather_tree_collect_item_rejected_continue"), InputState.stop());
        }
        return collectDecision;
    }

    private TreeGatherPlanner.Selection selectNextTreeTarget(MinecraftClient client, ClientPlayerEntity player, GatherTreeRun run, long nowMs) {
        Set<BlockPos> liveCluster = liveTreeCluster(client.world, run.cluster);
        BlockPos playerPos = player.getBlockPos();
        long cacheKey = gatherTreeSelectionCacheKey(
            playerPos.getX(),
            playerPos.getY(),
            playerPos.getZ(),
            liveCluster.size(),
            run.completedTargets.size(),
            run.abandonedTargets.size(),
            run.excludedAdjacentCells.size()
        );
        if (run.cachedTargetSelection != null
            && cacheKey == run.targetSelectionCacheKey
            && nowMs - run.targetSelectionCachedAtMs < GATHER_TREE_TARGET_SELECTION_CACHE_MS) {
            return run.cachedTargetSelection;
        }
        List<LogTarget> reachableLogs = reachableTreeLogsForLiveCluster(client, player, run, liveCluster);
        // Live runs showed 8 unreachable logs burn 55 s of serial fallback approaches before the command
        // concluded — the global watchdog won the race. Once NOTHING is reachable the fallback
        // regime gets a bounded window; after it, the command concludes no_reachable_tree_logs and
        // the search machinery moves on.
        boolean fallbackWindowOpen = run.noReachableFallbackSinceMs == 0L
            || nowMs - run.noReachableFallbackSinceMs < GATHER_TREE_FALLBACK_WINDOW_MS;
        BlockPos fallbackAnchor = fallbackWindowOpen
            ? gatherTreeContinuationFallbackAnchor(player, run, liveCluster)
            : null;
        TreeGatherPlanner.Selection selection;
        if (fallbackAnchor != null) {
            selection = TreeGatherPlanner.chooseNext(
                liveCluster,
                reachableLogs,
                run.completedTargets,
                run.abandonedTargets,
                fallbackAnchor
            );
        } else {
            selection = TreeGatherPlanner.chooseNext(liveCluster, reachableLogs, run.completedTargets, run.abandonedTargets);
        }
        if (selection.reachableCandidates() > 0) {
            run.noReachableFallbackSinceMs = 0L;
        } else if (run.noReachableFallbackSinceMs == 0L) {
            run.noReachableFallbackSinceMs = nowMs;
        }
        run.cachedTargetSelection = selection;
        run.targetSelectionCacheKey = cacheKey;
        run.targetSelectionCachedAtMs = nowMs;
        return selection;
    }

    // B2 pillar-up constants: bounded placements per gather command; an engagement that makes no
    // placement progress inside the timeout gives up (budget marked spent) so the normal
    // no_reachable conclusion proceeds.
    private static final int GATHER_PILLAR_MAX_PLACEMENTS = 3;
    private static final long GATHER_PILLAR_ENGAGE_TIMEOUT_MS = 30_000L;

    // Lowest unharvested cluster log nearly directly overhead (horizontal <=1) at rise 3-8: above
    // the overhead-harvest envelope (2-5) but recoverable by pillaring 1-3 blocks.
    private BlockPos selectGatherPillarOverheadLog(MinecraftClient client, ClientPlayerEntity player, GatherTreeRun run) {
        if (client == null || client.world == null || player == null || run == null) {
            return null;
        }
        Set<BlockPos> liveCluster = liveTreeCluster(client.world, run.cluster);
        BlockPos feet = player.getBlockPos();
        BlockPos best = null;
        for (BlockPos log : liveCluster) {
            if (log == null || run.completedTargets.contains(log) || run.abandonedTargets.contains(log)) {
                continue;
            }
            int rise = log.getY() - feet.getY();
            if (rise < 3 || rise > 8) {
                continue;
            }
            if (Math.abs(log.getX() - feet.getX()) > 1 || Math.abs(log.getZ() - feet.getZ()) > 1) {
                continue;
            }
            if (best == null || log.getY() < best.getY()) {
                best = log.toImmutable();
            }
        }
        return best;
    }

    // Pillar material for the gather pillar (the first fire gave up no_cobblestone — tall
    // canopies are a WOOD-PHASE problem, before any stone exists): cobblestone when held, else the
    // bot's own logs/planks (the BlockItem resolves the verification block type). Null = nothing
    // placeable.
    private BlockPlaceController.PlaceSpec gatherPillarPlaceSpec(ClientPlayerEntity player) {
        if (InventoryCounter.countPlayerCobblestone(player).cobblestoneCount() > 0) {
            return BlockPlaceController.PlaceSpec.cobblestone();
        }
        for (int slot = 0; slot < player.getInventory().size(); slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack.isEmpty()) {
                continue;
            }
            String stackItemId = itemId(stack);
            if ((InventoryCounter.isLogItemId(stackItemId) || InventoryCounter.isPlankItemId(stackItemId))
                && stack.getItem() instanceof BlockItem blockItem) {
                return BlockPlaceController.PlaceSpec.supportBlock(stackItemId, blockItem.getBlock());
            }
        }
        return null;
    }

    // B2 pillar-up cycle: headroom -> jump -> place beneath (the proven return-staircase pillar
    // mechanics, contained to the gather run). Null = nothing pillarable or budget spent; the
    // caller's normal completion proceeds.
    private ControlDecision maybeResolveGatherPillarUp(MinecraftClient client, BrainLink.Intent effective, GatherTreeRun run, long nowMs) {
        ClientPlayerEntity player = client == null ? null : client.player;
        if (player == null || client.world == null) {
            return null;
        }
        if (run.pillarPlacements >= GATHER_PILLAR_MAX_PLACEMENTS) {
            return null;
        }
        // The normal overhead harvest can already take something: no pillar needed (also the
        // mid-engagement exit — each placement raises the bot until this fires).
        if (selectGatherTreeOverheadTarget(client, player, run) != null) {
            run.pillarEngagedAtMs = 0L;
            return null;
        }
        BlockPos pillarLog = selectGatherPillarOverheadLog(client, player, run);
        if (pillarLog == null) {
            run.pillarEngagedAtMs = 0L;
            return null;
        }
        if (run.pillarEngagedAtMs <= 0L) {
            run.pillarEngagedAtMs = nowMs;
            LOGGER.info(
                "gather_tree.pillar_start instanceId={} commandId={} target={} feet={} placementsSoFar={}",
                instanceId,
                run.commandId,
                pillarLog.toShortString(),
                player.getBlockPos().toShortString(),
                run.pillarPlacements
            );
        } else if (nowMs - run.pillarEngagedAtMs > GATHER_PILLAR_ENGAGE_TIMEOUT_MS) {
            run.pillarPlacements = GATHER_PILLAR_MAX_PLACEMENTS;
            LOGGER.warn(
                "gather_tree.pillar_gave_up instanceId={} commandId={} target={} placements={} reason=engage_timeout",
                instanceId,
                run.commandId,
                pillarLog.toShortString(),
                run.pillarPlacements
            );
            return null;
        }
        BlockPos feet = player.getBlockPos().toImmutable();
        // Headroom above the jump arc (leaves are the usual occupant under a canopy — cheap break).
        if (player.isOnGround()) {
            BlockPos headroomTarget = returnPillarHeadroomTarget(client, feet);
            if (headroomTarget != null) {
                BlockBreakController.Result clearResult = blockBreakController.tick(
                    client, player, headroomTarget, run.commandId + ":gather_pillar_headroom", nowMs);
                if (clearResult.status() == BlockBreakController.Status.FAILED) {
                    run.pillarPlacements = GATHER_PILLAR_MAX_PLACEMENTS;
                    blockBreakController.reset();
                    LOGGER.warn(
                        "gather_tree.pillar_gave_up instanceId={} commandId={} target={} reason=headroom:{}",
                        instanceId,
                        run.commandId,
                        pillarLog.toShortString(),
                        clearResult.reason()
                    );
                    return null;
                }
                return new ControlDecision(
                    lookIntentForBlock(effective, player, headroomTarget, "gather_pillar_headroom"),
                    InputState.stop()
                );
            }
        }
        BlockPlaceController.PlaceSpec pillarSpec = gatherPillarPlaceSpec(player);
        if (pillarSpec == null) {
            run.pillarPlacements = GATHER_PILLAR_MAX_PLACEMENTS;
            LOGGER.info(
                "gather_tree.pillar_gave_up instanceId={} commandId={} target={} reason=no_pillar_material",
                instanceId,
                run.commandId,
                pillarLog.toShortString()
            );
            return null;
        }
        if (findHotbarSlot(player, stackItemId -> pillarSpec.itemId().equals(stackItemId)) < 0) {
            int moved = moveInventoryItemToHotbar(client, player, stackItemId -> pillarSpec.itemId().equals(stackItemId), run.commandId, "gather_pillar");
            if (moved == -2) {
                return new ControlDecision(stopFrom(effective, "gather_pillar_close_screen_before_hotbar_move"), InputState.stop());
            }
            if (moved >= 0) {
                return new ControlDecision(stopFrom(effective, "gather_pillar_hotbar_move"), InputState.stop());
            }
        }
        // Landing settle after a placement (mirrors the return pillar: wait to stand on the new block).
        if (run.pillarLandingMinFloorY > Integer.MIN_VALUE) {
            int floorY = (int) Math.floor(player.getY());
            if (player.isOnGround() && floorY >= run.pillarLandingMinFloorY) {
                run.pillarLandingMinFloorY = Integer.MIN_VALUE;
                run.pillarPlacedAtMs = 0L;
            } else if (nowMs - run.pillarPlacedAtMs < 1_500L) {
                return new ControlDecision(stopFrom(effective, "gather_pillar_landing"), InputState.stop());
            } else {
                run.pillarLandingMinFloorY = Integer.MIN_VALUE;
                run.pillarPlacedAtMs = 0L;
            }
        }
        if (player.isOnGround()) {
            run.pillarFoundation = feet.down().toImmutable();
            if (!isStableDescentSupport(client, run.pillarFoundation)) {
                run.pillarPlacements = GATHER_PILLAR_MAX_PLACEMENTS;
                return null;
            }
            Vec3d supportTop = new Vec3d(run.pillarFoundation.getX() + 0.5D, run.pillarFoundation.getY() + 1.0D, run.pillarFoundation.getZ() + 0.5D);
            LookAngles placeLook = lookAnglesToPoint(player, supportTop);
            InputState jumpInput = new InputState(false, false, false, false, true, false, 0.0F, 0.0F);
            return new ControlDecision(
                lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "gather_pillar_jump"),
                jumpInput
            );
        }
        if (run.pillarFoundation == null) {
            return new ControlDecision(stopFrom(effective, "gather_pillar_settle"), InputState.stop());
        }
        BlockPlaceController.Result result = blockPlaceController.tick(
            client,
            player,
            run.commandId + ":gather_pillar:" + run.pillarPlacements,
            nowMs,
            run.pillarFoundation,
            pillarSpec
        );
        if (run.lastGatherPillarLogMs <= 0L || nowMs - run.lastGatherPillarLogMs >= 500L || result.status() != BlockPlaceController.Status.RUNNING) {
            run.lastGatherPillarLogMs = nowMs;
            LOGGER.info(
                "gather_tree.pillar_progress instanceId={} commandId={} target={} reason={} placedBlock={} placements={}",
                instanceId,
                run.commandId,
                pillarLog.toShortString(),
                result.reason(),
                formatBlockPos(result.placedBlock()),
                run.pillarPlacements
            );
        }
        if (result.status() == BlockPlaceController.Status.PLACED) {
            run.pillarPlacements++;
            run.pillarPlacedAtMs = nowMs;
            run.pillarLandingMinFloorY = run.pillarFoundation.getY() + 2;
            run.pillarEngagedAtMs = nowMs; // fresh window per placed block
            run.pillarFoundation = null;
            LOGGER.info(
                "gather_tree.pillar_placed instanceId={} commandId={} target={} placements={}",
                instanceId,
                run.commandId,
                pillarLog.toShortString(),
                run.pillarPlacements
            );
            return new ControlDecision(stopFrom(effective, "gather_pillar_placed:" + run.pillarPlacements), InputState.stop());
        }
        if (result.status() == BlockPlaceController.Status.FAILED) {
            run.pillarPlacements = GATHER_PILLAR_MAX_PLACEMENTS;
            blockPlaceController.reset();
            LOGGER.warn(
                "gather_tree.pillar_gave_up instanceId={} commandId={} target={} reason=place:{}",
                instanceId,
                run.commandId,
                pillarLog.toShortString(),
                result.reason()
            );
            return null;
        }
        return new ControlDecision(stopFrom(effective, "gather_pillar_placing"), InputState.stop());
    }

    // Lowest unharvested cluster log hanging 2-5 blocks overhead within the bot's horizontal reach
    // envelope: breakable by looking up from the current stance (vertical-harvest slice). Requires
    // air or leaves directly beneath the log so it is the bottom of the remaining floating segment —
    // a lower solid log would itself be the better candidate.
    private BlockPos selectGatherTreeOverheadTarget(MinecraftClient client, ClientPlayerEntity player, GatherTreeRun run) {
        if (client == null || client.world == null || player == null || run == null) {
            return null;
        }
        Set<BlockPos> liveCluster = liveTreeCluster(client.world, run.cluster);
        int feetY = (int) Math.floor(player.getY());
        BlockPos best = null;
        double bestDistance = Double.MAX_VALUE;
        for (BlockPos log : liveCluster) {
            if (log == null || run.completedTargets.contains(log) || run.abandonedTargets.contains(log)) {
                continue;
            }
            int rise = log.getY() - feetY;
            if (rise < 2 || rise > 5) {
                continue;
            }
            double dx = (log.getX() + 0.5D) - player.getX();
            double dz = (log.getZ() + 0.5D) - player.getZ();
            double horizontal = Math.sqrt(dx * dx + dz * dz);
            if (horizontal > 4.0D) {
                continue;
            }
            BlockState below = client.world.getBlockState(log.down());
            if (!below.isAir() && !below.isIn(BlockTags.LEAVES)) {
                continue;
            }
            if (best == null || log.getY() < best.getY() || (log.getY() == best.getY() && horizontal < bestDistance)) {
                best = log;
                bestDistance = horizontal;
            }
        }
        return best;
    }

    // The selection inputs that can change its outcome, folded to one key: same key within the memo
    // window means the (expensive) reachability pass would recompute an identical answer.
    static long gatherTreeSelectionCacheKey(
        int playerX,
        int playerY,
        int playerZ,
        int liveClusterSize,
        int completedCount,
        int abandonedCount,
        int excludedAdjacentCount
    ) {
        long key = playerX;
        key = key * 31L + playerY;
        key = key * 31L + playerZ;
        key = key * 31L + liveClusterSize;
        key = key * 31L + completedCount;
        key = key * 31L + abandonedCount;
        key = key * 31L + excludedAdjacentCount;
        return key;
    }

    private static BlockPos gatherTreeContinuationFallbackAnchor(
        ClientPlayerEntity player,
        GatherTreeRun run,
        Set<BlockPos> liveCluster
    ) {
        boolean rowCluster = run != null
            && (isSingleAxisGatherTreeCluster(liveCluster) || isSingleAxisGatherTreeCluster(run.cluster));
        if (player == null
            || run == null
            || run.completedTargets.isEmpty()
            || !rowCluster) {
            return null;
        }
        return player.getBlockPos().toImmutable();
    }

    private static boolean isSingleAxisGatherTreeCluster(Set<BlockPos> cluster) {
        if (cluster == null || cluster.size() < 4) {
            return false;
        }
        Map<Integer, Set<Integer>> xsByZ = new HashMap<>();
        Map<Integer, Set<Integer>> zsByX = new HashMap<>();
        for (BlockPos log : cluster) {
            if (log == null) {
                continue;
            }
            xsByZ.computeIfAbsent(log.getZ(), ignored -> new HashSet<>()).add(log.getX());
            zsByX.computeIfAbsent(log.getX(), ignored -> new HashSet<>()).add(log.getZ());
        }
        for (Set<Integer> xs : xsByZ.values()) {
            if (xs.size() >= 4) {
                return true;
            }
        }
        for (Set<Integer> zs : zsByX.values()) {
            if (zs.size() >= 4) {
                return true;
            }
        }
        return false;
    }

    private List<LogTarget> reachableTreeLogsForLiveCluster(
        MinecraftClient client,
        ClientPlayerEntity player,
        GatherTreeRun run,
        Set<BlockPos> liveCluster
    ) {
        if (client == null || client.world == null || player == null || run == null || liveCluster == null || liveCluster.isEmpty()
        ) {
            return List.of();
        }
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        int referenceFeetY = (int) Math.floor(player.getY());
        Set<GridCell> excludedBreakCells = gatherTreeBreakNavigationExclusions(client.world, run);
        List<LogTarget> filtered = new ArrayList<>();
        // FPS: one surface-scan cache shared across every per-log perception below. Each live log builds
        // a bounded perception anchored at the bot, so the columns near the bot overlap heavily; without a
        // shared cache they were re-scanned once per log, making this an O(live-logs) render-thread world
        // scan -- the dominant "worst in forests" tick-budget tax (sustained 145-365 ms ticks). surfaceY is
        // identical across these instances, so sharing is behavior-preserving (bounds still gate inBounds).
        Map<GridCell, OptionalInt> sharedSurfaceCache = new HashMap<>();
        for (BlockPos target : liveCluster) {
            if (target == null || run.completedTargets.contains(target) || run.abandonedTargets.contains(target)) {
                continue;
            }
            WorldGridPerception perception = new WorldGridPerception(
                client.world,
                referenceFeetY,
                Math.min(start.x(), target.getX()) - NAVIGATION_PERCEPTION_MARGIN,
                Math.max(start.x(), target.getX()) + NAVIGATION_PERCEPTION_MARGIN,
                Math.min(start.z(), target.getZ()) - NAVIGATION_PERCEPTION_MARGIN,
                Math.max(start.z(), target.getZ()) + NAVIGATION_PERCEPTION_MARGIN,
                sharedSurfaceCache
            );
            GridPerception routePerception = maybeAnchorCurrentStart(client.world, perception, start, referenceFeetY, true);
            GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
                routePerception,
                start,
                target.getX(),
                target.getY(),
                target.getZ(),
                excludedBreakCells
            );
            if (plan.cell() != null) {
                double dx = (target.getX() + 0.5D) - player.getX();
                double dy = (target.getY() + 0.5D) - player.getEyeY();
                double dz = (target.getZ() + 0.5D) - player.getZ();
                double distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
                filtered.add(new LogTarget(
                    blockId(client.world.getBlockState(target)),
                    target.getX(),
                    target.getY(),
                    target.getZ(),
                    distance
                ));
            }
        }
        return List.copyOf(filtered);
    }

    private List<LogTarget> reachableLiveGatherTreeSeeds(
        MinecraftClient client,
        ClientPlayerEntity player,
        int radius,
        int scanDown,
        int scanUp,
        int limit
    ) {
        if (client == null || client.world == null || player == null) {
            return List.of();
        }
        List<LogTarget> raw = LogPerception.nearbyLogs(
            client.world,
            player,
            radius,
            scanDown,
            scanUp,
            Math.max(limit * LOG_SEED_RAW_SCAN_MULTIPLIER, limit)
        );
        if (raw.isEmpty()) {
            return List.of();
        }
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        int referenceFeetY = (int) Math.floor(player.getY());
        List<LogTarget> filtered = new ArrayList<>();
        // FPS: share one surface-scan cache across every per-seed perception (same O(N) dedup as
        // reachableTreeLogsForLiveCluster) -- the columns near the bot overlap across seeds.
        Map<GridCell, OptionalInt> sharedSurfaceCache = new HashMap<>();
        for (LogTarget log : raw) {
            if (log == null) {
                continue;
            }
            BlockPos candidate = new BlockPos(log.x(), log.y(), log.z());
            if (isIgnoredGatherTreeSeed(candidate)) {
                continue;
            }
            WorldGridPerception perception = new WorldGridPerception(
                client.world,
                referenceFeetY,
                Math.min(start.x(), log.x()) - NAVIGATION_PERCEPTION_MARGIN,
                Math.max(start.x(), log.x()) + NAVIGATION_PERCEPTION_MARGIN,
                Math.min(start.z(), log.z()) - NAVIGATION_PERCEPTION_MARGIN,
                Math.max(start.z(), log.z()) + NAVIGATION_PERCEPTION_MARGIN,
                sharedSurfaceCache
            );
            GridPerception routePerception = maybeAnchorCurrentStart(client.world, perception, start, referenceFeetY, true);
            GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
                routePerception,
                start,
                log.x(),
                log.y(),
                log.z(),
                Set.of()
            );
            if (plan.cell() == null) {
                continue;
            }
            filtered.add(log);
            if (filtered.size() >= limit) {
                break;
            }
        }
        return List.copyOf(filtered);
    }

    static BlockPos preserveActiveGatherTreeSeedForCommand(
        String commandId,
        BlockPos candidateSeed,
        String activeCommandId,
        BlockPos activeSeed
    ) {
        String normalizedCommandId = commandId == null ? "" : commandId;
        String normalizedActiveCommandId = activeCommandId == null ? "" : activeCommandId;
        if (activeSeed != null && normalizedCommandId.equals(normalizedActiveCommandId)) {
            return activeSeed.toImmutable();
        }
        if (candidateSeed != null) {
            return candidateSeed.toImmutable();
        }
        return null;
    }

    private LiveGatherTreeSeed selectLiveGatherTreeSeed(MinecraftClient client, ClientPlayerEntity player) {
        if (client == null || client.world == null || player == null) {
            return null;
        }
        List<LogTarget> reachableLogs = reachableLiveGatherTreeSeeds(
            client,
            player,
            LOG_SCAN_RADIUS,
            LOG_SCAN_DOWN,
            LOG_SCAN_UP,
            LOG_SCAN_LIMIT
        );
        String source = "live_scan";
        if (reachableLogs.isEmpty()) {
            reachableLogs = reachableLiveGatherTreeSeeds(
                client,
                player,
                LOG_FALLBACK_SCAN_RADIUS,
                LOG_FALLBACK_SCAN_DOWN,
                LOG_FALLBACK_SCAN_UP,
                LOG_FALLBACK_SCAN_LIMIT
            );
            source = "live_scan_expanded";
        }
        if (reachableLogs.isEmpty()) {
            return null;
        }
        LogTarget target = reachableLogs.getFirst();
        return new LiveGatherTreeSeed(new BlockPos(target.x(), target.y(), target.z()), source, reachableLogs.size());
    }

    private record LiveGatherTreeSeed(BlockPos pos, String source, int candidates) {
    }

    private ControlDecision resolveGatherTreeSearchControl(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        long nowMs
    ) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (activeGatherTreeSearch == null || !commandId.equals(activeGatherTreeSearch.commandId)) {
            expireRecentGatherTreeSearchGoals(nowMs);
            GridCell origin = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
            int originFeetY = (int) Math.floor(player.getY());
            activeGatherTreeSearch = new GatherTreeSearchRun(commandId, origin, originFeetY, nowMs);
            activeGatherTreeSearch.visitedGoals.addAll(recentGatherTreeSearchGoals);
            rememberGatherTreeSearchGoal(origin, nowMs);
            LOGGER.warn(
                "gather_tree.search_start instanceId={} commandId={} origin={} originFeetY={} minSurfaceY={} reason=missing_live_seed",
                instanceId,
                commandId,
                origin,
                originFeetY,
                gatherTreeSearchMinSurfaceY(originFeetY)
            );
        }

        GatherTreeSearchRun run = activeGatherTreeSearch;
        long elapsedMs = Math.max(0L, nowMs - run.startedAtMs);
        if (elapsedMs > GATHER_TREE_SEARCH_TIMEOUT_MS
            || run.goal == null && shouldCompleteGatherTreeSearch(elapsedMs, run.routeAttempts, run.routeUnavailableStreak)) {
            String reason = elapsedMs > GATHER_TREE_SEARCH_TIMEOUT_MS
                ? "search_timeout"
                : "route_attempt_limit";
            // Pit-strand detection (nav-stuck pass): a bounded lateral search that keeps failing while the
            // bot sits well BELOW the surrounding ground is stranded in a pit the 2-D search can't climb
            // out of (observed: feet-Y 75 under ~85 surface, never ascended -> mission abort). Surface =
            // median ring heightmap. Telemetry-only for now; the pillar-up escape lands next on this signal.
            int pitSurfaceY = surroundingGroundSurfaceY(client, player);
            int pitFeetY = (int) Math.floor(player.getY());
            if (pitSurfaceY != Integer.MIN_VALUE && pitSurfaceY - pitFeetY >= GATHER_PIT_ESCAPE_MIN_DEPTH) {
                LOGGER.warn(
                    "gather_tree.pit_stranded instanceId={} commandId={} botFeetY={} surroundingSurfaceY={} depth={} searchReason={}",
                    instanceId,
                    commandId,
                    pitFeetY,
                    pitSurfaceY,
                    pitSurfaceY - pitFeetY,
                    reason
                );
            }
            // Fast surrender (168 s mission abort on a sparse spawn): the bounded ring search
            // exhausted and the mission gave up after ONE such completion. Missions instead MARCH —
            // 3 legs of ~20 blocks in one compass direction (rotating per relocation, 3 relocations
            // max), then re-run the bounded search on the new area. Mirrors the iron-phase
            // relocate-and-redescend budget; live-seed checks still run between legs via the
            // existing rescan flow.
            if (("route_attempt_limit".equals(reason) || "search_timeout".equals(reason))
                && isMissionCommandId(commandId)
                && gatherSearchRelocations < GATHER_SEARCH_RELOCATION_LIMIT) {
                gatherSearchMarchDirection = GATHER_SEARCH_MARCH_DIRECTIONS[gatherSearchRelocations % GATHER_SEARCH_MARCH_DIRECTIONS.length];
                gatherSearchMarchLegsRemaining = GATHER_SEARCH_MARCH_LEGS;
                gatherSearchRelocations++;
                GridCell relocOrigin = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
                activeGatherTreeSearch = new GatherTreeSearchRun(commandId, relocOrigin, (int) Math.floor(player.getY()), nowMs);
                LOGGER.warn(
                    "gather_tree.search_relocate instanceId={} commandId={} relocation={} direction={},{} legs={}",
                    instanceId,
                    commandId,
                    gatherSearchRelocations,
                    gatherSearchMarchDirection[0],
                    gatherSearchMarchDirection[1],
                    GATHER_SEARCH_MARCH_LEGS
                );
                return new ControlDecision(stopFrom(effective, "gather_tree_search_relocating:" + gatherSearchRelocations), InputState.stop());
            }
            return completeGatherTreeSearch(effective, run, nowMs, reason);
        }
        if (player.getY() < gatherTreeSearchMinSurfaceY(run.originFeetY) - 0.25D) {
            return completeGatherTreeSearch(effective, run, nowMs, "surface_bound_exceeded");
        }

        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        if (run.goal != null) {
            double distance = Math.hypot(PathFollower.center(run.goal.x()) - player.getX(), PathFollower.center(run.goal.z()) - player.getZ());
            if (start.equals(run.goal) || distance <= GATHER_TREE_SEARCH_ARRIVE_EPSILON) {
                LOGGER.info(
                    "gather_tree.search_reached instanceId={} commandId={} goal={} distance={} attempts={}",
                    instanceId,
                    commandId,
                    run.goal,
                    roundForLog(distance),
                    run.routeAttempts
                );
                run.visitedGoals.add(run.goal);
                rememberGatherTreeSearchGoal(run.goal, nowMs);
                run.goal = null;
                run.route = List.of();
                clearNavigationState();
                return new ControlDecision(stopFrom(effective, "gather_tree_search_rescan"), InputState.stop());
            }
        }

        if (run.goal == null || run.route.isEmpty()) {
            // PERF: when the previous selection attempt found no route, the retry timer must gate the
            // SCAN itself, not just the warn line. Target selection runs a 48-radius log sweep plus
            // per-candidate grid routing and a frontier BFS on the render thread; re-running it every
            // tick while no route exists was the 200-990 ms tick stall (1 FPS) seen live in search.
            if (run.noRouteLogged && nowMs < run.nextRouteRetryAtMs) {
                return new ControlDecision(stopFrom(effective, "gather_tree_search_wait_route"), InputState.stop());
            }
            run.visitedGoals.add(start);
            rememberGatherTreeSearchGoal(start, nowMs);
            GatherTreeSearchTarget target = selectGatherTreeSearchTarget(client, player, run);
            if (target == null) {
                // CLIFF-LOCKED SEARCH (4 spawns in one session alone: nothing routable from a plateau
                // lip; vetoes bounded the stall but walking cannot convert the world): relocate
                // VERTICALLY by driving the battle-tested staircase machinery ~8 blocks down as a
                // search sub-command — every descent guard (bridges, seals, hazard reroutes) rides
                // along — then resume the search at the cliff base. Slice 1 of terrain mobility.
                if (isMissionCommandId(commandId)
                    && gatherSearchDescendRelocations < GATHER_SEARCH_DESCEND_RELOCATION_LIMIT) {
                    String descendId = commandId + ":search:descend:" + gatherSearchDescendRelocations;
                    BrainLink.Intent descendIntent = makeDescendRelocateIntent(client, effective, descendId, player);
                    ControlDecision descendDecision = resolveDescendStaircaseControl(client, player, descendIntent, nowMs);
                    String descendReason = descendDecision.intent() == null ? "" : descendDecision.intent().reason();
                    if (descendReason.startsWith("descent_complete") || descendReason.startsWith("descent_failed")) {
                        gatherSearchDescendRelocations++;
                        activeGatherTreeSearch = new GatherTreeSearchRun(
                            commandId,
                            new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ())),
                            (int) Math.floor(player.getY()),
                            nowMs
                        );
                        LOGGER.warn(
                            "gather_tree.search_descend_relocated instanceId={} commandId={} outcome={} relocations={}",
                            instanceId,
                            commandId,
                            descendReason,
                            gatherSearchDescendRelocations
                        );
                        return new ControlDecision(stopFrom(effective, "gather_tree_search_descend_relocated:" + gatherSearchDescendRelocations), InputState.stop());
                    }
                    return descendDecision;
                }
                if (!run.noRouteLogged || nowMs >= run.nextRouteRetryAtMs) {
                    run.noRouteLogged = true;
                    run.nextRouteRetryAtMs = nowMs + GATHER_TREE_SEARCH_ROUTE_RETRY_MS;
                    run.routeUnavailableStreak++;
                    LOGGER.warn(
                        "gather_tree.search_route_unavailable instanceId={} commandId={} origin={} originFeetY={} minSurfaceY={} attempts={} retryMs={}",
                        instanceId,
                        commandId,
                        run.origin,
                        run.originFeetY,
                        gatherTreeSearchMinSurfaceY(run.originFeetY),
                        run.routeAttempts,
                        GATHER_TREE_SEARCH_ROUTE_RETRY_MS
                    );
                }
                return new ControlDecision(stopFrom(effective, "gather_tree_search_wait_route"), InputState.stop());
            }
            run.goal = target.goal();
            run.route = target.route();
            run.routeAttempts++;
            run.routeUnavailableStreak = 0;
            run.noRouteLogged = false;
            run.nextRouteRetryAtMs = 0L;
            clearNavigationState();
            LOGGER.info(
                "gather_tree.search_selected instanceId={} commandId={} start={} goal={} routeLength={} attempts={} reason={}",
                instanceId,
                commandId,
                start,
                run.goal,
                run.route.size(),
                run.routeAttempts,
                target.reason()
            );
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
            PathFollower.center(run.goal.x()),
            PathFollower.center(run.goal.z()),
            run.route,
            List.of(),
            GATHER_TREE_SEARCH_ARRIVE_EPSILON,
            List.of(),
            effective.expiresAtMs(),
            "gather_tree_search",
            commandId + ":tree:search"
        );
        return resolveNavigationControl(client, player, navIntent);
    }

    private GatherTreeSearchTarget selectGatherTreeSearchTarget(
        MinecraftClient client,
        ClientPlayerEntity player,
        GatherTreeSearchRun run
    ) {
        if (client == null || client.world == null || player == null || run == null) {
            return null;
        }
        GatherTreeSearchTarget loadedLogTarget = selectGatherTreeLoadedLogSearchTarget(client, player, run);
        if (loadedLogTarget != null) {
            return loadedLogTarget;
        }
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        int referenceFeetY = (int) Math.floor(player.getY());
        // March-relocation leg takes priority over the local ring (visible logs above still win):
        // keep walking the chosen compass direction until the legs are spent, then the ring pattern
        // scans the new area. An unroutable march goal falls through to the ring for this leg.
        if (gatherSearchMarchLegsRemaining > 0
            && gatherSearchMarchDirection != null
            && isMissionCommandId(run.commandId)) {
            GridCell marchGoal = new GridCell(
                start.x() + gatherSearchMarchDirection[0],
                start.z() + gatherSearchMarchDirection[1]
            );
            WorldGridPerception marchPerception = new WorldGridPerception(
                client.world,
                referenceFeetY,
                start,
                marchGoal,
                NAVIGATION_PERCEPTION_MARGIN
            );
            GridPerception marchRoutePerception = gatherTreeSearchRoutePerception(
                client.world,
                marchPerception,
                start,
                referenceFeetY,
                run
            );
            GridRouteDiagnostic marchDiagnostic = GridAStar.diagnose(marchRoutePerception, start, marchGoal);
            if (marchDiagnostic.routeFound() && marchDiagnostic.route().size() >= 2) {
                gatherSearchMarchLegsRemaining--;
                LOGGER.info(
                    "gather_tree.search_march instanceId={} commandId={} goal={} legsRemaining={} relocation={}",
                    instanceId,
                    run.commandId,
                    marchGoal,
                    gatherSearchMarchLegsRemaining,
                    gatherSearchRelocations
                );
                return new GatherTreeSearchTarget(marchGoal, marchDiagnostic.route(), "march_leg");
            }
        }
        for (int i = 0; i < GATHER_TREE_SEARCH_OFFSETS.length; i++) {
            int[] offset = GATHER_TREE_SEARCH_OFFSETS[(run.routeAttempts + i) % GATHER_TREE_SEARCH_OFFSETS.length];
            GridCell goal = new GridCell(start.x() + offset[0], start.z() + offset[1]);
            if (isGatherTreeSearchGoalVisited(run, goal)) {
                continue;
            }
            WorldGridPerception perception = new WorldGridPerception(
                client.world,
                referenceFeetY,
                start,
                goal,
                NAVIGATION_PERCEPTION_MARGIN
            );
            GridPerception routePerception = gatherTreeSearchRoutePerception(
                client.world,
                perception,
                start,
                referenceFeetY,
                run
            );
            GridRouteDiagnostic diagnostic = GridAStar.diagnose(routePerception, start, goal);
            if (!diagnostic.routeFound() || diagnostic.route().size() < 2) {
                continue;
            }
            return new GatherTreeSearchTarget(goal, diagnostic.route(), "surface_route_found");
        }
        return selectGatherTreeLocalFrontierSearchTarget(client, player, run, start, referenceFeetY);
    }

    private GatherTreeSearchTarget selectGatherTreeLocalFrontierSearchTarget(
        MinecraftClient client,
        ClientPlayerEntity player,
        GatherTreeSearchRun run,
        GridCell start,
        int referenceFeetY
    ) {
        if (client == null || client.world == null || player == null || run == null || start == null) {
            return null;
        }
        WorldGridPerception perception = new WorldGridPerception(
            client.world,
            referenceFeetY,
            start.x() - GATHER_TREE_SEARCH_LOCAL_FRONTIER_RADIUS,
            start.x() + GATHER_TREE_SEARCH_LOCAL_FRONTIER_RADIUS,
            start.z() - GATHER_TREE_SEARCH_LOCAL_FRONTIER_RADIUS,
            start.z() + GATHER_TREE_SEARCH_LOCAL_FRONTIER_RADIUS
        );
        GridPerception routePerception = gatherTreeSearchRoutePerception(
            client.world,
            perception,
            start,
            referenceFeetY,
            run
        );
        List<GridCell> route = gatherTreeLocalFrontierRoute(
            routePerception,
            start,
            run.origin,
            run.visitedGoals,
            recentGatherTreeSearchGoals,
            GATHER_TREE_SEARCH_LOCAL_FRONTIER_MIN_DISTANCE,
            GATHER_TREE_SEARCH_VISITED_RADIUS,
            GATHER_TREE_SEARCH_LOCAL_FRONTIER_RADIUS
        );
        if (route.size() >= 2) {
            return new GatherTreeSearchTarget(route.getLast(), route, "local_frontier_route");
        }
        route = gatherTreeLocalFrontierRoute(
            routePerception,
            start,
            run.origin,
            run.visitedGoals,
            recentGatherTreeSearchGoals,
            GATHER_TREE_SEARCH_RELAXED_LOCAL_FRONTIER_MIN_DISTANCE,
            GATHER_TREE_SEARCH_RELAXED_VISITED_RADIUS,
            GATHER_TREE_SEARCH_LOCAL_FRONTIER_RADIUS
        );
        if (route.size() >= 2) {
            return new GatherTreeSearchTarget(route.getLast(), route, "local_frontier_relaxed_route");
        }
        return null;
    }

    static List<GridCell> gatherTreeLocalFrontierRoute(
        GridPerception routePerception,
        GridCell start,
        GridCell origin,
        Set<GridCell> visitedGoals,
        Set<GridCell> recentGoals,
        int minDistance,
        int visitedRadius,
        int maxDistance
    ) {
        if (routePerception == null || start == null || routePerception.isBlocked(start.x(), start.z())) {
            return List.of();
        }
        Queue<GridCell> open = new ArrayDeque<>();
        Set<GridCell> closed = new HashSet<>();
        Map<GridCell, GridCell> cameFrom = new HashMap<>();
        Map<GridCell, Integer> distanceFromStart = new HashMap<>();
        GridCell best = null;
        int bestOriginDistance = Integer.MIN_VALUE;
        int bestStartDistance = Integer.MIN_VALUE;
        open.add(start);
        distanceFromStart.put(start, 0);

        while (!open.isEmpty()) {
            GridCell cell = open.poll();
            if (!closed.add(cell)) {
                continue;
            }
            int startDistance = distanceFromStart.getOrDefault(cell, 0);
            if (!cell.equals(start)
                && startDistance >= minDistance
                && !isGatherTreeSearchGoalVisited(cell, visitedGoals, recentGoals, visitedRadius)) {
                int originDistance = manhattanDistance(cell, origin);
                if (originDistance > bestOriginDistance
                    || originDistance == bestOriginDistance && startDistance > bestStartDistance) {
                    best = cell;
                    bestOriginDistance = originDistance;
                    bestStartDistance = startDistance;
                }
            }
            if (startDistance >= maxDistance) {
                continue;
            }
            for (GridCell next : gatherTreeSearchNeighbors(cell)) {
                if (closed.contains(next)
                    || distanceFromStart.containsKey(next)
                    || !routePerception.inBounds(next.x(), next.z())
                    || !routePerception.canTraverse(cell, next)) {
                    continue;
                }
                cameFrom.put(next, cell);
                distanceFromStart.put(next, startDistance + 1);
                open.add(next);
            }
        }
        if (best == null) {
            return List.of();
        }
        List<GridCell> route = reconstructGatherTreeSearchRoute(cameFrom, start, best);
        if (route.size() < 2) {
            return List.of();
        }
        return route;
    }

    private GatherTreeSearchTarget selectGatherTreeLoadedLogSearchTarget(
        MinecraftClient client,
        ClientPlayerEntity player,
        GatherTreeSearchRun run
    ) {
        List<LogTarget> logs = LogPerception.nearbyLogs(
            client.world,
            player,
            GATHER_TREE_SEARCH_LOG_SCAN_RADIUS,
            GATHER_TREE_SEARCH_LOG_SCAN_DOWN,
            GATHER_TREE_SEARCH_LOG_SCAN_UP,
            Math.max(
                GATHER_TREE_SEARCH_LOG_SCAN_LIMIT * GATHER_TREE_SEARCH_LOG_RAW_SCAN_MULTIPLIER,
                GATHER_TREE_SEARCH_LOG_SCAN_LIMIT
            )
        );
        if (logs.isEmpty()) {
            return null;
        }
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        int referenceFeetY = (int) Math.floor(player.getY());
        // FPS: share one surface-scan cache across the whole log x candidate sweep below. This per-tick
        // O(N-logs x M-candidates) render-thread scan was the 6.3s/tick freeze when the bot is stranded
        // far from any reachable tree; the candidate regions overlap heavily near the bot.
        Map<GridCell, OptionalInt> sharedSurfaceCache = new HashMap<>();
        for (LogTarget log : logs) {
            if (log == null) {
                continue;
            }
            BlockPos candidate = new BlockPos(log.x(), log.y(), log.z());
            if (isIgnoredGatherTreeSeed(candidate)) {
                continue;
            }
            for (GridCell goal : gatherTreeLogApproachCandidates(log)) {
                if (run.visitedGoals.contains(goal)) {
                    continue;
                }
                WorldGridPerception perception = new WorldGridPerception(
                    client.world,
                    referenceFeetY,
                    start,
                    goal,
                    NAVIGATION_PERCEPTION_MARGIN,
                    sharedSurfaceCache
                );
                GridPerception routePerception = gatherTreeSearchRoutePerception(
                    client.world,
                    perception,
                    start,
                    referenceFeetY,
                    run
                );
                GridRouteDiagnostic diagnostic = GridAStar.diagnose(routePerception, start, goal);
                if (!diagnostic.routeFound() || diagnostic.route().size() < 2) {
                    continue;
                }
                return new GatherTreeSearchTarget(goal, diagnostic.route(), "loaded_log_approach");
            }
        }
        return null;
    }

    private static List<GridCell> gatherTreeLogApproachCandidates(LogTarget log) {
        if (log == null) {
            return List.of();
        }
        List<GridCell> candidates = new ArrayList<>();
        for (int radius = 1; radius <= GATHER_TREE_SEARCH_LOG_APPROACH_RADIUS; radius++) {
            for (int[] direction : GATHER_TREE_SEARCH_LOG_APPROACH_DIRECTIONS) {
                candidates.add(new GridCell(log.x() + direction[0] * radius, log.z() + direction[1] * radius));
            }
        }
        return List.copyOf(candidates);
    }

    private static List<GridCell> gatherTreeSearchNeighbors(GridCell cell) {
        return List.of(
            new GridCell(cell.x() + 1, cell.z()),
            new GridCell(cell.x() - 1, cell.z()),
            new GridCell(cell.x(), cell.z() + 1),
            new GridCell(cell.x(), cell.z() - 1)
        );
    }

    private static List<GridCell> reconstructGatherTreeSearchRoute(Map<GridCell, GridCell> cameFrom, GridCell start, GridCell goal) {
        if (start == null || goal == null) {
            return List.of();
        }
        ArrayDeque<GridCell> reversed = new ArrayDeque<>();
        GridCell cursor = goal;
        reversed.addFirst(cursor);
        while (!cursor.equals(start)) {
            cursor = cameFrom.get(cursor);
            if (cursor == null) {
                return List.of();
            }
            reversed.addFirst(cursor);
        }
        return new ArrayList<>(reversed);
    }

    private void expireRecentGatherTreeSearchGoals(long nowMs) {
        if (recentGatherTreeSearchUpdatedAtMs <= 0L
            || nowMs - recentGatherTreeSearchUpdatedAtMs <= GATHER_TREE_SEARCH_MEMORY_MS) {
            return;
        }
        recentGatherTreeSearchGoals.clear();
        recentGatherTreeSearchUpdatedAtMs = 0L;
    }

    private void rememberGatherTreeSearchGoal(GridCell goal, long nowMs) {
        if (goal == null) {
            return;
        }
        recentGatherTreeSearchGoals.add(goal);
        recentGatherTreeSearchUpdatedAtMs = nowMs;
    }

    private boolean isGatherTreeSearchGoalVisited(GatherTreeSearchRun run, GridCell goal) {
        return isGatherTreeSearchGoalVisited(
            goal,
            run == null ? Set.of() : run.visitedGoals,
            recentGatherTreeSearchGoals,
            GATHER_TREE_SEARCH_VISITED_RADIUS
        );
    }

    private static boolean isGatherTreeSearchGoalVisited(
        GridCell goal,
        Set<GridCell> visitedGoals,
        Set<GridCell> recentGoals,
        int radius
    ) {
        if (goal == null) {
            return true;
        }
        if (isNearGatherTreeSearchGoal(goal, visitedGoals, radius)) {
            return true;
        }
        return isNearGatherTreeSearchGoal(goal, recentGoals, radius);
    }

    private static boolean isNearGatherTreeSearchGoal(GridCell goal, Set<GridCell> visited) {
        return isNearGatherTreeSearchGoal(goal, visited, GATHER_TREE_SEARCH_VISITED_RADIUS);
    }

    private static boolean isNearGatherTreeSearchGoal(GridCell goal, Set<GridCell> visited, int radius) {
        if (goal == null || visited == null || visited.isEmpty()) {
            return false;
        }
        radius = Math.max(0, radius);
        for (GridCell cell : visited) {
            if (cell != null
                && Math.abs(goal.x() - cell.x()) <= radius
                && Math.abs(goal.z() - cell.z()) <= radius) {
                return true;
            }
        }
        return false;
    }

    private static int manhattanDistance(GridCell first, GridCell second) {
        if (first == null || second == null) {
            return 0;
        }
        return Math.abs(first.x() - second.x()) + Math.abs(first.z() - second.z());
    }

    private ControlDecision completeGatherTreeSearch(
        BrainLink.Intent effective,
        GatherTreeSearchRun run,
        long nowMs,
        String reason
    ) {
        String commandId = run == null ? "" : run.commandId;
        String completionReason = "gather_tree_complete:bounded_search_exhausted:" + reason;
        completedGatherTreeCommandIds.add(commandId);
        finishedGatherTreeCommandReasons.put(commandId, completionReason);
        activeGatherTreeSearch = null;
        clearNavigationState();
        LOGGER.warn(
            "gather_tree.search_complete instanceId={} commandId={} reason={} origin={} originFeetY={} minSurfaceY={} attempts={} elapsedMs={}",
            instanceId,
            commandId,
            reason,
            run == null ? null : run.origin,
            run == null ? 0 : run.originFeetY,
            run == null ? 0 : gatherTreeSearchMinSurfaceY(run.originFeetY),
            run == null ? 0 : run.routeAttempts,
            run == null ? 0L : Math.max(0L, nowMs - run.startedAtMs)
        );
        return new ControlDecision(stopFrom(effective, completionReason), InputState.stop());
    }

    static boolean shouldCompleteGatherTreeSearch(long elapsedMs, int routeAttempts, int routeUnavailableStreak) {
        return elapsedMs > GATHER_TREE_SEARCH_TIMEOUT_MS
            || routeAttempts >= GATHER_TREE_SEARCH_MAX_ROUTE_ATTEMPTS
            || routeUnavailableStreak >= GATHER_TREE_SEARCH_MAX_ROUTE_UNAVAILABLE;
    }

    private static int gatherTreeSearchMinSurfaceY(int originFeetY) {
        return originFeetY - GATHER_TREE_SEARCH_MAX_SURFACE_DROP;
    }

    // Median ground-surface height (motion-blocking, leaves excluded) over a ring around the bot, used to
    // tell if the bot is stranded BELOW the surrounding terrain (a pit/ravine). The median is robust to a
    // few tall trees on the ring inflating a max. Returns Integer.MIN_VALUE when unavailable.
    private int surroundingGroundSurfaceY(MinecraftClient client, ClientPlayerEntity player) {
        if (client == null || client.world == null || player == null) {
            return Integer.MIN_VALUE;
        }
        int bx = (int) Math.floor(player.getX());
        int bz = (int) Math.floor(player.getZ());
        int r = GATHER_PIT_ESCAPE_SCAN_RADIUS;
        int[] tops = new int[8 * r];
        int n = 0;
        for (int dx = -r; dx <= r; dx++) {
            for (int dz = -r; dz <= r; dz++) {
                if (Math.abs(dx) != r && Math.abs(dz) != r) {
                    continue; // ring perimeter only
                }
                tops[n++] = client.world.getTopY(
                    net.minecraft.world.Heightmap.Type.MOTION_BLOCKING_NO_LEAVES,
                    bx + dx,
                    bz + dz
                );
            }
        }
        if (n == 0) {
            return Integer.MIN_VALUE;
        }
        java.util.Arrays.sort(tops, 0, n);
        return tops[n / 2];
    }

    static GridPerception gatherTreeSurfaceBoundedPerception(GridPerception perception, int originFeetY) {
        if (perception == null) {
            return null;
        }
        return new SurfaceFloorGridPerception(perception, gatherTreeSearchMinSurfaceY(originFeetY));
    }

    private GridPerception gatherTreeSearchRoutePerception(
        BlockView world,
        WorldGridPerception perception,
        GridCell start,
        int referenceFeetY,
        GatherTreeSearchRun run
    ) {
        GridPerception anchored = maybeAnchorCurrentStart(world, perception, start, referenceFeetY, true);
        GridPerception bounded = gatherTreeSurfaceBoundedPerception(anchored, run == null ? referenceFeetY : run.originFeetY);
        // Veto-feedback: search/march legs route around edge-guard-refused cells (standoff fix).
        return vetoAware(bounded, System.currentTimeMillis());
    }

    private record GatherTreeSearchTarget(GridCell goal, List<GridCell> route, String reason) {
    }

    private static boolean shouldPreferGatherTreeSideCollectBeforeDirect(
        ClientPlayerEntity player,
        GatherTreeRun run,
        Vec3d droppedLogPosition
    ) {
        if (player == null || droppedLogPosition == null) {
            return false;
        }
        double dx = droppedLogPosition.x - player.getX();
        double dz = droppedLogPosition.z - player.getZ();
        double horizontalDistance = Math.hypot(dx, dz);
        double verticalDistance = Math.abs(droppedLogPosition.y - player.getY());
        if (verticalDistance > GATHER_TREE_SIDE_COLLECT_FIRST_Y_DELTA
            && horizontalDistance > GATHER_TREE_DIRECT_COLLECT_ARRIVE_DISTANCE) {
            return true;
        }
        return shouldPreferGatherTreeRowTailSideCollect(run, player, droppedLogPosition, horizontalDistance, verticalDistance);
    }

    static boolean shouldAbandonGatherTreeUnreachableDrop(double playerY, double dropY, boolean sideCollectAvailable) {
        return !sideCollectAvailable && Math.abs(dropY - playerY) > GATHER_LOG_DIRECT_COLLECT_MAX_Y_DELTA;
    }

    static boolean shouldAbandonGatherTreeCollectRouteRejection(
        String collectReason,
        String collectCommandId,
        String decisionReason
    ) {
        String reason = collectReason == null ? "" : collectReason;
        String commandId = collectCommandId == null ? "" : collectCommandId;
        return "target_rejected_no_path".equals(decisionReason)
            && ("gather_tree_collect_item".equals(reason) || commandId.contains(":tree:collect:item"));
    }

    private ControlDecision maybeAbandonGatherTreeCollectNoProgress(
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        GatherTreeRun run,
        InventoryCounter.InventoryLogSnapshot inventory,
        BlockPos target,
        Vec3d droppedLogPosition,
        long nowMs
    ) {
        if (player == null || effective == null || run == null || inventory == null || target == null || droppedLogPosition == null
            || run.collectStartedAtMs <= 0L
            || nowMs - run.collectStartedAtMs < GATHER_PICKUP_SETTLE_MS) {
            return null;
        }
        double horizontalDistance = Math.hypot(droppedLogPosition.x - player.getX(), droppedLogPosition.z - player.getZ());
        String dropKey = target.toShortString() + ":" + roundForLog(droppedLogPosition.x) + ":"
            + roundForLog(droppedLogPosition.y) + ":" + roundForLog(droppedLogPosition.z);
        if (!run.collectProgress.stalled(dropKey, horizontalDistance, nowMs)) {
            return null;
        }
        run.collectTimeouts++;
        run.abandonedTargets.add(target);
        LOGGER.warn(
            "gather_tree.collect_no_progress instanceId={} commandId={} target={} itemX={} itemY={} itemZ={} distance={} bestDistance={} elapsedMs={} inventoryLogsBefore={} inventoryLogsAfter={} collectTimeouts={}",
            instanceId,
            run.commandId,
            target.toShortString(),
            roundForLog(droppedLogPosition.x),
            roundForLog(droppedLogPosition.y),
            roundForLog(droppedLogPosition.z),
            roundForLog(horizontalDistance),
            roundForLog(run.collectProgress.bestHorizontalDistance()),
            run.collectProgress.noProgressElapsedMs(nowMs),
            run.baselineLogCount,
            inventory.logCount(),
            run.collectTimeouts
        );
        resetGatherTreeCurrentTarget(run);
        clearNavigationState();
        return new ControlDecision(stopFrom(effective, "gather_tree_collect_no_progress_continue"), InputState.stop());
    }

    private static boolean shouldPreferGatherTreeRowTailSideCollect(
        GatherTreeRun run,
        ClientPlayerEntity player,
        Vec3d droppedLogPosition,
        double horizontalDistance,
        double verticalDistance
    ) {
        if (run == null
            || player == null
            || droppedLogPosition == null
            || run.currentTarget == null
            || gatherTreeRowSideCollectProgress(run) < GATHER_TREE_ROW_SIDE_COLLECT_MIN_COMPLETED
            || horizontalDistance <= GATHER_TREE_ROW_SIDE_COLLECT_FIRST_DISTANCE
            || verticalDistance > GATHER_LOG_DIRECT_COLLECT_MAX_Y_DELTA) {
            return false;
        }
        GridCell targetCell = new GridCell(run.currentTarget.getX(), run.currentTarget.getZ());
        GridCell dropCell = new GridCell((int) Math.floor(droppedLogPosition.x), (int) Math.floor(droppedLogPosition.z));
        return isGatherTreeRowAxisCell(run, targetCell)
            && isGatherTreeRowAxisCell(run, dropCell)
            && isSameGatherTreeRowAxis(run, targetCell, dropCell);
    }

    private static int gatherTreeRowSideCollectProgress(GatherTreeRun run) {
        if (run == null) {
            return 0;
        }
        return run.completedTargets.size() + Math.max(0, run.baselineLogCount);
    }

    private ControlDecision maybeResolveGatherTreeDroppedLogDirectCollect(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        GatherTreeRun run,
        Vec3d droppedLogPosition
    ) {
        ControlDecision directCollect = maybeResolveDroppedLogDirectCollect(
            effective,
            player,
            droppedLogPosition,
            "gather_tree_collect_direct",
            GATHER_TREE_DIRECT_COLLECT_DISTANCE,
            GATHER_TREE_DIRECT_COLLECT_MAX_Y_DELTA,
            GATHER_TREE_DIRECT_COLLECT_ARRIVE_DISTANCE
        );
        if (directCollect != null) {
            return directCollect;
        }
        ControlDecision rowDirectCollect = maybeResolveGatherTreeRowDropCollect(
            client,
            player,
            effective,
            run,
            droppedLogPosition
        );
        if (rowDirectCollect != null) {
            return rowDirectCollect;
        }
        return maybeResolveGatherTreeRowDriftDirectCollect(
            player,
            effective,
            run,
            droppedLogPosition
        );
    }

    private ControlDecision maybeResolveGatherTreeRowDropCollect(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        GatherTreeRun run,
        Vec3d droppedLogPosition
    ) {
        if (client == null || client.world == null || player == null || effective == null || run == null || droppedLogPosition == null) {
            return null;
        }
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        GridCell drop = new GridCell((int) Math.floor(droppedLogPosition.x), (int) Math.floor(droppedLogPosition.z));
        if (!isGatherTreeRowAxisCell(run, start)
            || !isGatherTreeRowAxisCell(run, drop)
            || !isSameGatherTreeRowAxis(run, start, drop)
            || !isGatherTreeRowApproachClear(client.world, run, start, drop)) {
            return null;
        }
        return maybeResolveDroppedLogDirectCollect(
            effective,
            player,
            droppedLogPosition,
            "gather_tree_collect_row_direct",
            GATHER_TREE_ROW_COLLECT_DISTANCE,
            GATHER_TREE_DIRECT_COLLECT_MAX_Y_DELTA,
            GATHER_TREE_ROW_COLLECT_ARRIVE_DISTANCE
        );
    }

    private ControlDecision maybeResolveGatherTreeRowDriftDirectCollect(
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        GatherTreeRun run,
        Vec3d droppedLogPosition
    ) {
        if (player == null || effective == null || run == null || run.currentTarget == null || droppedLogPosition == null) {
            return null;
        }
        if (run.completedTargets.size() < 4 || !isSingleAxisGatherTreeCluster(run.cluster)) {
            return null;
        }
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        GridCell target = new GridCell(run.currentTarget.getX(), run.currentTarget.getZ());
        if (!isGatherTreeRowAxisCell(run, start) || !isGatherTreeRowAxisCell(run, target)) {
            return null;
        }
        double targetDistance = Math.hypot(
            droppedLogPosition.x - PathFollower.center(target.x()),
            droppedLogPosition.z - PathFollower.center(target.z())
        );
        if (targetDistance > GATHER_TREE_ROW_DRIFT_TARGET_DISTANCE) {
            return null;
        }
        return maybeResolveDroppedLogDirectCollect(
            effective,
            player,
            droppedLogPosition,
            "gather_tree_collect_row_drift_direct",
            GATHER_TREE_ROW_DRIFT_DIRECT_COLLECT_DISTANCE,
            GATHER_TREE_DIRECT_COLLECT_MAX_Y_DELTA,
            GATHER_TREE_DIRECT_COLLECT_ARRIVE_DISTANCE
        );
    }

    private BrainLink.Intent gatherTreeSideCollectIntent(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        GatherTreeRun run,
        Vec3d droppedLogPosition
    ) {
        if (client == null || client.world == null || player == null || effective == null || run == null || droppedLogPosition == null) {
            return null;
        }
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        int dropX = (int) Math.floor(droppedLogPosition.x);
        int dropZ = (int) Math.floor(droppedLogPosition.z);
        int referenceFeetY = (int) Math.floor(player.getY());
        WorldGridPerception perception = new WorldGridPerception(
            client.world,
            referenceFeetY,
            Math.min(start.x(), dropX) - NAVIGATION_PERCEPTION_MARGIN,
            Math.max(start.x(), dropX) + NAVIGATION_PERCEPTION_MARGIN,
            Math.min(start.z(), dropZ) - NAVIGATION_PERCEPTION_MARGIN,
            Math.max(start.z(), dropZ) + NAVIGATION_PERCEPTION_MARGIN
        );
        GridPerception routePerception = maybeAnchorCurrentStart(client.world, perception, start, referenceFeetY, true);
        Set<GridCell> excluded = gatherTreeBreakCellExclusions(run);
        GridCell bestCell = null;
        List<GridCell> bestRoute = List.of();
        double bestPickupDistance = Double.MAX_VALUE;
        int bestRouteLength = Integer.MAX_VALUE;
        int excludedRejected = 0;
        int rowAxisRejected = 0;
        int boundsRejected = 0;
        int blockedRejected = 0;
        int surfaceRejected = 0;
        int pickupRejected = 0;
        int routeRejected = 0;
        int candidates = 0;
        for (int x = dropX - 1; x <= dropX + 1; x++) {
            for (int z = dropZ - 1; z <= dropZ + 1; z++) {
                GridCell cell = new GridCell(x, z);
                if (excluded.contains(cell)) {
                    excludedRejected++;
                    continue;
                }
                if (isGatherTreeRowAxisCell(run, cell)) {
                    rowAxisRejected++;
                    continue;
                }
                if (!routePerception.inBounds(x, z)) {
                    boundsRejected++;
                    continue;
                }
                if (routePerception.isBlocked(x, z)) {
                    blockedRejected++;
                    continue;
                }
                var surface = routePerception.surfaceY(x, z);
                if (surface.isEmpty() || Math.abs(surface.getAsInt() - droppedLogPosition.y) > GATHER_LOG_DIRECT_COLLECT_MAX_Y_DELTA) {
                    surfaceRejected++;
                    continue;
                }
                double pickupDistance = Math.hypot(PathFollower.center(x) - droppedLogPosition.x, PathFollower.center(z) - droppedLogPosition.z);
                if (pickupDistance > GATHER_TREE_COLLECT_CELL_PICKUP_DISTANCE) {
                    pickupRejected++;
                    continue;
                }
                List<GridCell> route = GridAStar.route(routePerception, start, cell);
                if (route.isEmpty()) {
                    int dx = start.x() - cell.x();
                    int dz = start.z() - cell.z();
                    if (dx * dx + dz * dz > GATHER_TREE_SIDE_COLLECT_UNROUTED_DISTANCE_SQUARED) {
                        routeRejected++;
                        continue;
                    }
                    route = List.of(cell);
                }
                candidates++;
                if (bestCell == null
                    || pickupDistance < bestPickupDistance
                    || pickupDistance == bestPickupDistance && route.size() < bestRouteLength) {
                    bestCell = cell;
                    bestRoute = route;
                    bestPickupDistance = pickupDistance;
                    bestRouteLength = route.size();
                }
            }
        }
        if (bestCell == null) {
            logGatherTreeSideCollectUnavailable(
                run,
                start,
                new GridCell(dropX, dropZ),
                droppedLogPosition,
                candidates,
                excludedRejected,
                rowAxisRejected,
                boundsRejected,
                blockedRejected,
                surfaceRejected,
                pickupRejected,
                routeRejected
            );
            return null;
        }
        LOGGER.info(
            "gather_tree.collect_side_selected instanceId={} commandId={} target={} cell={} routeLength={} pickupDistance={}",
            instanceId,
            run.commandId,
            run.currentTarget == null ? "null" : run.currentTarget.toShortString(),
            bestCell,
            bestRouteLength,
            roundForLog(bestPickupDistance)
        );
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
            PathFollower.center(bestCell.x()),
            PathFollower.center(bestCell.z()),
            bestRoute,
            List.of(),
            GATHER_ARRIVE_EPSILON,
            List.of(),
            effective.expiresAtMs(),
            "gather_tree_collect_side",
            run.commandId + ":tree:collect:side:" + bestCell.x() + ":" + bestCell.z()
        );
    }

    private void logGatherTreeSideCollectUnavailable(
        GatherTreeRun run,
        GridCell start,
        GridCell dropCell,
        Vec3d droppedLogPosition,
        int candidates,
        int excludedRejected,
        int rowAxisRejected,
        int boundsRejected,
        int blockedRejected,
        int surfaceRejected,
        int pickupRejected,
        int routeRejected
    ) {
        if (run == null || dropCell == null || droppedLogPosition == null) {
            return;
        }
        String key = run.commandId + ":" + (run.currentTarget == null ? "null" : run.currentTarget.toShortString())
            + ":" + dropCell.x() + ":" + dropCell.z() + ":" + roundForLog(droppedLogPosition.y);
        if (key.equals(run.lastSideCollectUnavailableKey)) {
            return;
        }
        run.lastSideCollectUnavailableKey = key;
        LOGGER.info(
            "gather_tree.collect_side_unavailable instanceId={} commandId={} target={} start={} dropCell={} dropY={} progress={} candidates={} excludedRejected={} rowAxisRejected={} boundsRejected={} blockedRejected={} surfaceRejected={} pickupRejected={} routeRejected={}",
            instanceId,
            run.commandId,
            run.currentTarget == null ? "null" : run.currentTarget.toShortString(),
            start,
            dropCell,
            roundForLog(droppedLogPosition.y),
            gatherTreeRowSideCollectProgress(run),
            candidates,
            excludedRejected,
            rowAxisRejected,
            boundsRejected,
            blockedRejected,
            surfaceRejected,
            pickupRejected,
            routeRejected
        );
    }

    private ControlDecision resolveGatherTreeBreakControl(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        GatherTreeRun run,
        BlockPos target,
        long nowMs
    ) {
        String commandId = run.commandId;
        BrainLink.Intent lookIntent = lookIntentForBlock(effective, player, target, "gather_tree_face");
        if (!isLookingAtBlock(player, target)) {
            return new ControlDecision(lookIntent, InputState.stop());
        }
        BlockBreakController.Result result = blockBreakController.tick(
            client,
            player,
            target,
            commandId + ":" + run.completedTargets.size(),
            nowMs,
            true
        );
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
        ControlDecision occluderRetarget = maybeRetargetGatherTreeClusterOccluder(
            effective,
            run,
            target,
            result,
            nowMs
        );
        if (occluderRetarget != null) {
            return occluderRetarget;
        }
        if (result.status() == BlockBreakController.Status.BROKEN) {
            run.breakStarted = false;
            run.breakDone = true;
            run.collectStartedAtMs = nowMs;
            LOGGER.info(
                "gather_tree.break_done instanceId={} commandId={} target={} elapsedMs={}",
                instanceId,
                commandId,
                target.toShortString(),
                Math.max(0L, nowMs - run.startedAtMs)
            );
            return null;
        }
        if (result.status() == BlockBreakController.Status.REPOSITION) {
            if (run.currentAdjacentCell != null) {
                run.excludedAdjacentCells.add(run.currentAdjacentCell);
            }
            run.occlusionRepositions++;
            clearNavigationState();
            run.currentAdjacentCell = null;
            run.currentAdjacentRoute = List.of();
            run.currentAdjacentReached = false;
            run.currentAdjacentLatchLogged = false;
            run.currentAdjacentLatchHoldLogged = false;
            run.breakStarted = false;
            run.currentAdjacentProgress.reset();
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
        }
        if (result.status() == BlockBreakController.Status.FAILED) {
            if (result.reason().startsWith("raycast_")) {
                run.occlusionAbandons++;
            }
            if (shouldRetryGatherTreeTargetOutOfReach(result.reason(), run.targetOutOfReachRepositions)) {
                GridCell failedAdjacent = run.currentAdjacentCell;
                if (failedAdjacent != null) {
                    run.excludedAdjacentCells.add(failedAdjacent);
                }
                run.targetOutOfReachRepositions++;
                clearNavigationState();
                run.currentAdjacentCell = null;
                run.currentAdjacentRoute = List.of();
                run.currentAdjacentReached = false;
                run.currentAdjacentLatchLogged = false;
                run.currentAdjacentLatchHoldLogged = false;
                run.breakStarted = false;
                run.currentAdjacentProgress.reset();
                LOGGER.warn(
                    "gather_tree.break_reposition instanceId={} commandId={} target={} failedAdjacent={} repositions={} reason={}",
                    instanceId,
                    commandId,
                    target.toShortString(),
                    failedAdjacent,
                    run.targetOutOfReachRepositions,
                    result.reason()
                );
                return new ControlDecision(stopFrom(effective, "gather_tree_break_reposition:" + result.reason()), InputState.stop());
            }
            if ("break_timeout".equals(result.reason()) && run.occlusionRepositions < 2) {
                if (run.currentAdjacentCell != null) {
                    run.excludedAdjacentCells.add(run.currentAdjacentCell);
                }
                run.occlusionRepositions++;
                clearNavigationState();
                run.currentAdjacentCell = null;
                run.currentAdjacentRoute = List.of();
                run.currentAdjacentReached = false;
                run.currentAdjacentLatchLogged = false;
                run.currentAdjacentLatchHoldLogged = false;
                run.breakStarted = false;
                run.currentAdjacentProgress.reset();
                LOGGER.warn(
                    "gather_tree.break_timeout_reposition instanceId={} commandId={} target={} repositions={} reason={}",
                    instanceId,
                    commandId,
                    target.toShortString(),
                    run.occlusionRepositions,
                    result.reason()
                );
                return new ControlDecision(stopFrom(effective, "gather_tree_break_timeout_reposition"), InputState.stop());
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
        }
        if (result.actedBlock() != null) {
            run.breakStarted = true;
        }
        return new ControlDecision(lookIntentForBlock(effective, player, target, "gather_tree_breaking:" + result.reason()), InputState.stop());
    }

    private ControlDecision maybeRetargetGatherTreeClusterOccluder(
        BrainLink.Intent effective,
        GatherTreeRun run,
        BlockPos target,
        BlockBreakController.Result result,
        long nowMs
    ) {
        if (run == null || target == null || result == null || result.actedBlock() == null) {
            return null;
        }
        BlockPos occluder = result.actedBlock().toImmutable();
        if (occluder.equals(target) || !run.cluster.contains(occluder)) {
            return null;
        }
        boolean activelyBreakingClusterLog = result.reason() != null
            && result.reason().startsWith("raycast_breaking_occluder:");
        boolean clearedClusterLog = "occluder_cleared".equals(result.reason());
        if (!activelyBreakingClusterLog && !clearedClusterLog) {
            return null;
        }
        if (activelyBreakingClusterLog && run.abandonedTargets.contains(occluder)) {
            if (!shouldRetryAbandonedGatherTreeOccluder(run, target, occluder)) {
                LOGGER.info(
                    "gather_tree.skip_abandoned_cluster_occluder instanceId={} commandId={} target={} occluder={} reason={}",
                    instanceId,
                    run.commandId,
                    target.toShortString(),
                    occluder.toShortString(),
                    result.reason()
                );
                return null;
            }
            LOGGER.info(
                "gather_tree.retry_abandoned_cluster_occluder instanceId={} commandId={} target={} occluder={} reason={}",
                instanceId,
                run.commandId,
                target.toShortString(),
                occluder.toShortString(),
                result.reason()
            );
        }
        run.currentTarget = occluder;
        run.abandonedTargets.remove(occluder);
        run.currentAdjacentCell = null;
        run.currentAdjacentRoute = List.of();
        run.currentAdjacentReached = false;
        run.currentAdjacentLatchLogged = false;
        run.currentAdjacentLatchHoldLogged = false;
        run.targetOutOfReachRepositions = 0;
        run.currentAdjacentProgress.reset();
        run.excludedAdjacentCells.clear();
        run.breakStarted = false;
        run.breakDone = clearedClusterLog;
        run.collectStartedAtMs = clearedClusterLog ? nowMs : 0L;
        clearNavigationState();
        LOGGER.info(
            "gather_tree.retarget_cluster_occluder instanceId={} commandId={} previousTarget={} occluder={} reason={} cleared={}",
            instanceId,
            run.commandId,
            target.toShortString(),
            occluder.toShortString(),
            result.reason(),
            clearedClusterLog
        );
        return new ControlDecision(stopFrom(effective, "gather_tree_retarget_cluster_occluder"), InputState.stop());
    }

    private static boolean shouldRetryAbandonedGatherTreeOccluder(GatherTreeRun run, BlockPos target, BlockPos occluder) {
        if (run == null || target == null || occluder == null || !isSingleAxisGatherTreeCluster(run.cluster)) {
            return false;
        }
        GridCell targetCell = new GridCell(target.getX(), target.getZ());
        GridCell occluderCell = new GridCell(occluder.getX(), occluder.getZ());
        return isSameGatherTreeRowAxis(run, targetCell, occluderCell)
            && continuationBreakDistanceSquared(targetCell, occluderCell) <= GATHER_TREE_CONTINUATION_BREAK_DISTANCE_SQUARED;
    }

    static boolean shouldRetryGatherTreeTargetOutOfReach(String reason, int repositions) {
        return "target_out_of_reach".equals(reason)
            && repositions < GATHER_TREE_TARGET_OUT_OF_REACH_REPOSITIONS;
    }

    private static boolean isDirectGatherTreeBreakReach(ClientPlayerEntity player, BlockPos target) {
        if (player == null || target == null) {
            return false;
        }
        return player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(target)) <= 4.8D * 4.8D;
    }

    static boolean canRecoverCraftCursorIntoSlot(
        String cursorItemId,
        int cursorCount,
        String slotItemId,
        int slotCount,
        int slotMaxCount
    ) {
        if (cursorItemId == null || cursorItemId.isBlank() || cursorCount <= 0) {
            return false;
        }
        if (slotItemId == null || slotItemId.isBlank() || slotCount <= 0) {
            return true;
        }
        return cursorItemId.equals(slotItemId) && slotCount < slotMaxCount;
    }

    @Override
    public CraftInventorySnapshot captureCraftInventory(ClientPlayerEntity player) {
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
            InventoryCounter.countPlayerItem(player, "iron_pickaxe"),
            InventoryCounter.countPlayerItem(player, "diamond"),
            InventoryCounter.countPlayerItem(player, "diamond_pickaxe"),
            InventoryCounter.countPlayerItem(player, "iron_helmet"),
            InventoryCounter.countPlayerItem(player, "iron_chestplate"),
            InventoryCounter.countPlayerItem(player, "iron_leggings"),
            InventoryCounter.countPlayerItem(player, "iron_boots"),
            InventoryCounter.countPlayerItem(player, "white_bed")
        );
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
            if (!Craft3x3RecipePlanner.canStart(recipe, inventory.planks.plankCount(), inventory.cobblestone.cobblestoneCount(), inventory.sticks.stickCount(), inventory.ironIngots.itemCount(), inventory.diamonds.itemCount(), InventoryCounter.countPlayerWool(player))) {
                return failCraft3x3(effective, activeCraft3x3, inventory, nowMs, action + "_missing_inputs");
            }
        }

        Craft3x3Run run = activeCraft3x3;
        CraftInventorySnapshot inventory = captureCraftInventory(player);
        int currentResultCount = craft3x3ResultCount(inventory, run.recipe);
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
                run.baselineDiamonds,
                inventory.diamonds.itemCount(),
                run.baselineResult,
                currentResultCount
            ) || Craft3x3RecipePlanner.hasExpectedOutputDelta(run.recipe, run.baselineResult, currentResultCount),
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
                beginWorkstationContainerTransitionSettle(action, commandId, nowMs, "craft_close_screen_before_open:" + currentScreen.getClass().getSimpleName());
                run.tableOpenInteractedAtMs = 0L;
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
                String handler = currentHandler.getClass().getSimpleName();
                player.closeHandledScreen();
                beginWorkstationContainerTransitionSettle(action, commandId, nowMs, "craft_close_handler_before_open:" + handler);
                run.tableOpenInteractedAtMs = 0L;
                run.tableOpenTarget = null;
                run.lastTableOpenWaitLogAtMs = 0L;
                LOGGER.info(
                    "{}.close_handler_before_open instanceId={} commandId={} handler={} elapsedMs={}",
                    action,
                    instanceId,
                    commandId,
                    handler,
                    Math.max(0L, nowMs - run.startedAtMs)
                );
                return new ControlDecision(stopFrom(effective, action + "_close_handler_before_open"), InputState.stop());
            }
            if (workstationContainerTransitionSettling(action, commandId, nowMs)) {
                return new ControlDecision(stopFrom(effective, action + "_container_transition_settle"), InputState.stop());
            }
            BlockPos table = selectNearbyCraftingTable(client, player);
            if (table == null) {
                return failCraft3x3(effective, run, inventory, nowMs, action + "_no_nearby_table");
            }
            BlockPos standTarget = selectCraftingTableStandTarget(client, player, table);
            boolean tableWithinReach = withinInteractionReach(player, Vec3d.ofCenter(table));
            if (standTarget != null && !tableWithinReach && player.getBlockPos().getManhattanDistance(table) > 1) {
                BrainLink.Intent returnToTable = new BrainLink.Intent(
                    "navigate_to_point",
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    null,
                    null,
                    standTarget.getX() + 0.5D,
                    (double) standTarget.getY(),
                    standTarget.getZ() + 0.5D,
                    List.of(),
                    effective.blockedCells() == null ? List.of() : effective.blockedCells(),
                    0.35D,
                    List.of(),
                    effective.expiresAtMs(),
                    action + "_return_to_table",
                    commandId + ":table"
                );
                return resolveNavigationControl(client, player, returnToTable);
            }
            clearNavigationState();
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
                if (withinInteractionReach(player, target) && run.tableOpenAttempts < CRAFT_TABLE_OPEN_MAX_ATTEMPTS) {
                    currentInputState = InputState.stop();
                    applyInputState(player.input, currentInputState);
                    player.setSneaking(false);
                    int openerSlot = selectTableOpenHotbarSlot(player);
                    run.tableOpenAttempts++;
                    run.tableOpenInteractedAtMs = nowMs;
                    run.tableOpenTarget = table;
                    run.lastTableOpenWaitLogAtMs = 0L;
                    BlockHitResult directHit = new BlockHitResult(target, Direction.UP, table, false);
                    ActionResult result = client.interactionManager.interactBlock(player, Hand.MAIN_HAND, directHit);
                    player.swingHand(Hand.MAIN_HAND);
                    LOGGER.info(
                        "{}.open_direct_interact instanceId={} commandId={} attempt={} result={} table={} raycastHit={} raycastSide={} selectedHotbarSlot={} selectedItem={} elapsedMs={}",
                        action,
                        instanceId,
                        commandId,
                        run.tableOpenAttempts,
                        result,
                        formatBlockPos(table),
                        formatBlockPos(hitBlock),
                        hit == null || hit.getSide() == null ? "none" : hit.getSide().asString(),
                        openerSlot,
                        selectedItemId(player),
                        Math.max(0L, nowMs - run.startedAtMs)
                    );
                    return new ControlDecision(stopFrom(effective, action + "_opening_table_direct:" + result), InputState.stop());
                }
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
        String completionReason = run.recipe.action() + "_complete:" + reason;
        finishedCraft3x3CommandReasons.put(run.commandId, completionReason);
        brainLink.completeCurrentCommand(run.commandId, completionReason, nowMs);
        return new ControlDecision(stopFrom(effective, completionReason), InputState.stop());
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
        String completionReason = run.recipe.action() + "_failed:" + reason;
        finishedCraft3x3CommandReasons.put(run.commandId, completionReason);
        brainLink.completeCurrentCommand(run.commandId, completionReason, nowMs);
        return new ControlDecision(stopFrom(effective, completionReason), InputState.stop());
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
            case DIAMOND -> "diamond".equalsIgnoreCase(itemId == null ? "" : itemId.trim());
            case IRON_INGOT -> "iron_ingot".equalsIgnoreCase(itemId == null ? "" : itemId.trim());
            case PLANK -> InventoryCounter.isPlankItemId(itemId);
            case STICK -> InventoryCounter.isStickItemId(itemId);
            // Any color stack works: the group is sourced from ONE stack, so same-color is
            // guaranteed by stack identity (the recipe result id stays white_bed for slice 2).
            case WOOL -> itemId != null && itemId.trim().endsWith("_wool");
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
            case "diamond_pickaxe" -> inventory.diamondPickaxes.itemCount();
            case "iron_helmet" -> inventory.ironHelmets.itemCount();
            case "iron_chestplate" -> inventory.ironChestplates.itemCount();
            case "iron_leggings" -> inventory.ironLeggings.itemCount();
            case "iron_boots" -> inventory.ironBoots.itemCount();
            case "white_bed" -> inventory.whiteBeds.itemCount();
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
            case "diamond_pickaxe" -> inventory.diamondPickaxes.itemsByItem();
            case "iron_helmet" -> inventory.ironHelmets.itemsByItem();
            case "iron_chestplate" -> inventory.ironChestplates.itemsByItem();
            case "iron_leggings" -> inventory.ironLeggings.itemsByItem();
            case "iron_boots" -> inventory.ironBoots.itemsByItem();
            case "white_bed" -> inventory.whiteBeds.itemsByItem();
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

    @Override
    public BlockPos selectNearbyCraftingTable(MinecraftClient client, ClientPlayerEntity player) {
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

    private BlockPos selectCraftingTableStandTarget(MinecraftClient client, ClientPlayerEntity player, BlockPos table) {
        if (client == null || client.world == null || player == null || table == null) {
            return null;
        }
        BlockPos selected = null;
        double bestDistance = Double.MAX_VALUE;
        for (Direction direction : List.of(Direction.NORTH, Direction.SOUTH, Direction.WEST, Direction.EAST)) {
            BlockPos candidate = table.offset(direction);
            if (!isClearStandCell(client, candidate)) {
                continue;
            }
            double distance = player.squaredDistanceTo(candidate.getX() + 0.5D, candidate.getY(), candidate.getZ() + 0.5D);
            if (distance < bestDistance) {
                bestDistance = distance;
                selected = candidate.toImmutable();
            }
        }
        return selected;
    }

    private boolean isClearStandCell(MinecraftClient client, BlockPos feet) {
        if (client == null || client.world == null || feet == null) {
            return false;
        }
        BlockPos support = feet.down();
        BlockState supportState = client.world.getBlockState(support);
        BlockState feetState = client.world.getBlockState(feet);
        BlockState headState = client.world.getBlockState(feet.up());
        return !supportState.getCollisionShape(client.world, support).isEmpty()
            && !isHazardBlockState(supportState)
            && feetState.getCollisionShape(client.world, feet).isEmpty()
            && headState.getCollisionShape(client.world, feet.up()).isEmpty()
            && !isHazardBlockState(feetState)
            && !isHazardBlockState(headState);
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
            activeSmeltCharcoal.desiredInputCount = desiredSmeltInputCount(recipe, inventory);
            LOGGER.info(
                "{}.start instanceId={} commandId={} outputItem={} desiredInputCount={} inventoryInputBefore={} inventoryOutputBefore={} inventoryLogsBefore={} inventoryPlanksBefore={} inventoryCharcoalBefore={} inventoryCoalBefore={} inventoryRawIronBefore={} inventoryIronIngotsBefore={} logsByItem={} planksByItem={} charcoalByItem={} coalByItem={} rawIronByItem={} ironIngotsByItem={}",
                action,
                instanceId,
                commandId,
                recipe.outputItemId(),
                activeSmeltCharcoal.desiredInputCount,
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
            FurnaceSmeltPlanner.completedByInventoryDelta(smeltBaselineOutput(run), smeltOutputCount(inventory, recipe), run.desiredInputCount),
            nowMs - run.startedAtMs > FURNACE_SMELT_TOTAL_TIMEOUT_MS,
            client.interactionManager != null
        );
        if (preflight.action() == SmeltControlPlanner.Action.COMPLETE_TYPED_DELTA) {
            return completeSmeltCharcoal(player, effective, run, inventory, nowMs, action + "_" + preflight.reason());
        }
        if (preflight.action() == SmeltControlPlanner.Action.FAIL_TOTAL_TIMEOUT
            || preflight.action() == SmeltControlPlanner.Action.FAIL_MISSING_INTERACTION_MANAGER) {
            return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_" + preflight.reason());
        }

        ScreenHandler currentHandler = player.currentScreenHandler;
        if (run.stage == SmeltControlPlanner.Stage.WAIT_OUTPUT
            && !(currentHandler instanceof AbstractFurnaceScreenHandler)
            && (currentHandler == null || currentHandler == player.playerScreenHandler)
            && run.outputWaitStartedAtMs > 0L
            && FurnaceSmeltPlanner.shouldWaitWithFurnaceScreenClosed(nowMs - run.outputWaitStartedAtMs, run.desiredInputCount)) {
            return new ControlDecision(stopFrom(effective, action + "_waiting_for_output_screen_closed"), InputState.stop());
        }
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
            BlockPos furnace = run.furnaceTarget;
            if (furnace == null || !client.world.getBlockState(furnace).isOf(Blocks.FURNACE)) {
                furnace = selectNearbyFurnace(client, player);
                run.furnaceTarget = furnace;
                run.furnaceInteractionCell = null;
                run.excludedFurnaceInteractionCells.clear();
            }
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
                if (withinInteractionReach(player, target) && run.directFurnaceOpenAttempts < 3) {
                    run.directFurnaceOpenAttempts++;
                    BlockHitResult directHit = new BlockHitResult(target, Direction.UP, furnace, false);
                    ActionResult result = client.interactionManager.interactBlock(player, Hand.MAIN_HAND, directHit);
                    player.swingHand(Hand.MAIN_HAND);
                    LOGGER.info(
                        "{}.open_direct_interact instanceId={} commandId={} result={} furnace={} attempt={} elapsedMs={}",
                        action,
                        instanceId,
                        commandId,
                        result,
                        furnace.toShortString(),
                        run.directFurnaceOpenAttempts,
                        Math.max(0L, nowMs - run.startedAtMs)
                    );
                    return new ControlDecision(stopFrom(effective, action + "_opening_furnace_direct:" + result), InputState.stop());
                }
                ControlDecision reposition = navigateToFurnaceInteractionCell(client, player, effective, run, furnace, nowMs, action);
                if (reposition != null) {
                    return reposition;
                }
                return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_furnace_raycast_blocked_no_adjacent");
            }
            if (!withinInteractionReach(player, hit.getPos())) {
                return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_furnace_out_of_reach");
            }
            run.furnaceInteractionCell = null;
            run.excludedFurnaceInteractionCells.clear();
            run.directFurnaceOpenAttempts = 0;
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
            ItemStack inputSlotStack = furnaceHandler.getSlot(FurnaceSmeltPlanner.INPUT_SLOT).getStack();
            ItemStack fuelSlotStack = furnaceHandler.getSlot(FurnaceSmeltPlanner.FUEL_SLOT).getStack();
            ItemStack outputSlotStack = furnaceHandler.getSlot(FurnaceSmeltPlanner.OUTPUT_SLOT).getStack();
            String inputSlotItemId = itemId(inputSlotStack);
            String loadedFuelItemId = itemId(fuelSlotStack);
            String outputSlotItemId = itemId(outputSlotStack);
            boolean loadedInputCompatible = !inputSlotStack.isEmpty() && matchesSmeltInput(recipe, inputSlotStack, inputSlotItemId);
            boolean loadedFuelValid = !fuelSlotStack.isEmpty() && isSmeltFuelItem(fuelSlotStack, loadedFuelItemId);
            boolean loadedFuelCompatible = loadedFuelValid
                && loadedFuelCoversBatch(fuelSlotStack, loadedFuelItemId, run.desiredInputCount);
            boolean expectedOutputPresent = FurnaceSmeltPlanner.isExpectedOutput(
                outputSlotItemId,
                outputSlotStack.getCount(),
                recipe.outputItemId(),
                1
            );
            LOGGER.info(
                "{}.furnace_opened instanceId={} commandId={} handler={} syncId={} inputSlot={} inputItem={} inputCount={} inputCompatible={} fuelSlot={} fuelItem={} fuelCount={} fuelCompatible={} outputSlot={} outputItem={} outputCount={} expectedOutputPresent={}",
                action,
                instanceId,
                commandId,
                furnaceHandler.getClass().getSimpleName(),
                furnaceHandler.syncId,
                FurnaceSmeltPlanner.INPUT_SLOT,
                inputSlotItemId,
                inputSlotStack.getCount(),
                loadedInputCompatible,
                FurnaceSmeltPlanner.FUEL_SLOT,
                loadedFuelItemId,
                fuelSlotStack.getCount(),
                loadedFuelCompatible,
                FurnaceSmeltPlanner.OUTPUT_SLOT,
                outputSlotItemId,
                outputSlotStack.getCount(),
                expectedOutputPresent
            );
            SmeltControlPlanner.Decision furnaceOpened = SmeltControlPlanner.decideFurnaceOpened(
                smeltControlState(run),
                furnaceHandler.getCursorStack().isEmpty(),
                inputSlotStack.isEmpty(),
                // Valid-but-short fuel reads as needs-more-fuel, so a loaded input routes to the
                // SELECT_FUEL top-up instead of failing closed; junk in the slot still fails.
                fuelSlotStack.isEmpty() || (loadedFuelValid && !loadedFuelCompatible),
                outputSlotStack.isEmpty(),
                loadedInputCompatible,
                loadedFuelCompatible,
                expectedOutputPresent
            );
            if (furnaceOpened.action() == SmeltControlPlanner.Action.FAIL_CURSOR_NOT_EMPTY
                || furnaceOpened.action() == SmeltControlPlanner.Action.FAIL_FURNACE_NOT_EMPTY) {
                return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_" + furnaceOpened.reason());
            }
            if (furnaceOpened.action() == SmeltControlPlanner.Action.OUTPUT_READY) {
                run.desiredInputCount = Math.max(1, Math.min(run.desiredInputCount, outputSlotStack.getCount()));
                run.outputWaitStartedAtMs = nowMs;
                LOGGER.info(
                    "{}.resume_output_ready instanceId={} commandId={} output={} count={} desiredInputCount={}",
                    action,
                    instanceId,
                    commandId,
                    outputSlotItemId,
                    outputSlotStack.getCount(),
                    run.desiredInputCount
                );
            }
            if (furnaceOpened.action() == SmeltControlPlanner.Action.RESUME_LOADED_INPUT
                || furnaceOpened.action() == SmeltControlPlanner.Action.RESUME_LOADED_INPUT_NEEDS_FUEL) {
                run.inputItemId = inputSlotItemId;
                run.desiredInputCount = Math.max(1, Math.min(run.desiredInputCount, inputSlotStack.getCount()));
                if (furnaceOpened.action() == SmeltControlPlanner.Action.RESUME_LOADED_INPUT) {
                    run.outputWaitStartedAtMs = nowMs;
                }
                LOGGER.info(
                    "{}.resume_loaded_input instanceId={} commandId={} input={} inputCount={} fuel={} fuelCount={} desiredInputCount={} nextStage={}",
                    action,
                    instanceId,
                    commandId,
                    inputSlotItemId,
                    inputSlotStack.getCount(),
                    loadedFuelItemId,
                    fuelSlotStack.getCount(),
                    run.desiredInputCount,
                    furnaceOpened.state().stage()
                );
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
            int loadedInputCount = smeltInputSlotCount(furnaceHandler, recipe);
            if (loadedInputCount >= run.desiredInputCount) {
                transitionSmeltCharcoalStage(run, SmeltControlPlanner.Stage.RETURN_INPUT_REMAINDER, nowMs);
            } else {
                if (furnaceHandler.getCursorStack().isEmpty()) {
                    return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_cursor_empty_before_input");
                }
                clickSmeltSlot(client, player, furnaceHandler, run, FurnaceSmeltPlanner.INPUT_SLOT, 1, SlotActionType.PICKUP, "place_input_batch", nowMs);
                return new ControlDecision(stopFrom(effective, action + "_place_input_batch"), InputState.stop());
            }
        }

        if (run.stage == SmeltControlPlanner.Stage.RETURN_INPUT_REMAINDER) {
            ItemStack loadedFuel = furnaceHandler.getSlot(FurnaceSmeltPlanner.FUEL_SLOT).getStack();
            String loadedFuelItemId = itemId(loadedFuel);
            boolean loadedFuelCompatible = !loadedFuel.isEmpty() && isSmeltFuelItem(loadedFuel, loadedFuelItemId)
                && loadedFuelCoversBatch(loadedFuel, loadedFuelItemId, run.desiredInputCount);
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
            int sourceSlot = findFurnaceFuelSourceScreenSlot(furnaceHandler, run.desiredInputCount);
            SmeltControlPlanner.Decision fuelSource = SmeltControlPlanner.decideFuelSource(smeltControlState(run), sourceSlot >= 0);
            if (fuelSource.action() == SmeltControlPlanner.Action.FAIL_FUEL_SOURCE_MISSING) {
                return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_" + fuelSource.reason());
            }
            run.fuelSourceSlot = sourceSlot;
            run.fuelItemId = itemId(furnaceHandler.getSlot(sourceSlot).getStack());
            run.desiredFuelCount = desiredSmeltFuelItemCount(run.desiredInputCount, run.fuelItemId);
            LOGGER.info(
                "{}.source_slot_selected instanceId={} commandId={} label=fuel slot={} item={} desiredFuelCount={}",
                action,
                instanceId,
                commandId,
                sourceSlot,
                run.fuelItemId,
                run.desiredFuelCount
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
            int loadedFuelCount = smeltFuelSlotCount(furnaceHandler);
            if (loadedFuelCount >= run.desiredFuelCount) {
                transitionSmeltCharcoalStage(run, SmeltControlPlanner.Stage.RETURN_FUEL_REMAINDER, nowMs);
            } else {
                if (furnaceHandler.getCursorStack().isEmpty()) {
                    if (run.fuelItemId != null && !run.fuelItemId.isBlank()) {
                        run.outputWaitStartedAtMs = nowMs;
                        transitionSmeltCharcoalStage(run, SmeltControlPlanner.Stage.WAIT_OUTPUT, nowMs);
                        LOGGER.info(
                            "{}.fuel_inserted_cursor_empty instanceId={} commandId={} fuelItem={} loadedFuelCount={} desiredFuelCount={}",
                            action,
                            instanceId,
                            commandId,
                            run.fuelItemId,
                            loadedFuelCount,
                            run.desiredFuelCount
                        );
                    } else {
                        return failSmeltCharcoal(effective, run, inventory, nowMs, action + "_cursor_empty_before_fuel");
                    }
                } else {
                    clickSmeltSlot(client, player, furnaceHandler, run, FurnaceSmeltPlanner.FUEL_SLOT, 1, SlotActionType.PICKUP, "place_fuel_batch", nowMs);
                    return new ControlDecision(stopFrom(effective, action + "_place_fuel_batch"), InputState.stop());
                }
            }
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
                if (FurnaceSmeltPlanner.shouldWaitWithFurnaceScreenClosed(nowMs - run.outputWaitStartedAtMs, run.desiredInputCount)) {
                    closeHandledScreenForTransition(player, action, run.commandId, "wait_output_screen_closed", nowMs);
                    return new ControlDecision(stopFrom(effective, action + "_waiting_for_output_screen_closed"), InputState.stop());
                }
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
        ClientPlayerEntity player,
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
        closeHandledScreenForTransition(player, action, run.commandId, "complete", nowMs);
        String completionReason = action + "_complete:" + reason;
        finishedSmeltCommandReasons.put(run.commandId, completionReason);
        brainLink.completeCurrentCommand(run.commandId, completionReason, nowMs);
        return new ControlDecision(stopFrom(effective, completionReason), InputState.stop());
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
        String completionReason = action + "_failed:" + reason;
        finishedSmeltCommandReasons.put(run.commandId, completionReason);
        brainLink.completeCurrentCommand(run.commandId, completionReason, nowMs);
        return new ControlDecision(stopFrom(effective, completionReason), InputState.stop());
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
        boolean loadedFuelCompatible = !loadedFuel.isEmpty() && isSmeltFuelItem(loadedFuel, loadedFuelItemId)
            && loadedFuelCoversBatch(loadedFuel, loadedFuelItemId, run.desiredInputCount);
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
            Math.max(1, run.desiredInputCount),
            nowMs - run.outputWaitStartedAtMs > smeltOutputWaitMs(run),
            nowMs - run.stageStartedAtMs > CRAFT_VERIFY_WAIT_MS
        );
    }

    private int desiredSmeltInputCount(FurnaceSmeltRecipe recipe, CraftInventorySnapshot inventory) {
        if (recipe == FurnaceSmeltRecipe.RAW_IRON) {
            int rawIron = inventory == null ? 0 : inventory.rawIron.itemCount();
            int ironIngots = inventory == null ? 0 : inventory.ironIngots.itemCount();
            int ironPickaxes = inventory == null ? 0 : inventory.ironPickaxes.itemCount();
            return Math.max(1, FurnaceSmeltPlanner.desiredRawIronBatchSize(rawIron, ironIngots, ironPickaxes));
        }
        return 1;
    }

    private int desiredSmeltFuelItemCount(int inputCount, String fuelItemId) {
        return FurnaceSmeltPlanner.desiredFuelItemCount(inputCount, fuelItemId);
    }

    // "compatible" must also mean "covers the batch" — one leftover plank (1.5 items of
    // burn) was reused for a 3-item smelt; the furnace went cold and the output window expired.
    private boolean loadedFuelCoversBatch(ItemStack stack, String itemId, int desiredInputCount) {
        return stack.getCount() >= desiredSmeltFuelItemCount(desiredInputCount, itemId);
    }

    private long smeltOutputWaitMs(SmeltCharcoalRun run) {
        // A legitimate single-item smelt died at 15.8 s — 15 s/item is too tight against
        // the 10 s/item vanilla burn plus lighting/tick latency. 20 s/item gives 2x headroom; the
        // 90 s total command budget still bounds the whole smelt.
        return Math.max(FURNACE_OUTPUT_WAIT_MS, 20_000L * Math.max(1, run.desiredInputCount));
    }

    private int smeltInputSlotCount(AbstractFurnaceScreenHandler furnaceHandler, FurnaceSmeltRecipe recipe) {
        ItemStack stack = furnaceHandler.getSlot(FurnaceSmeltPlanner.INPUT_SLOT).getStack();
        String itemId = itemId(stack);
        return !stack.isEmpty() && matchesSmeltInput(recipe, stack, itemId) ? stack.getCount() : 0;
    }

    private int smeltFuelSlotCount(AbstractFurnaceScreenHandler furnaceHandler) {
        ItemStack stack = furnaceHandler.getSlot(FurnaceSmeltPlanner.FUEL_SLOT).getStack();
        String itemId = itemId(stack);
        return !stack.isEmpty() && isSmeltFuelItem(stack, itemId) ? stack.getCount() : 0;
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

    private void closeHandledScreenForTransition(ClientPlayerEntity player, String action, String commandId, String reason, long nowMs) {
        if (player == null || player.currentScreenHandler == null || player.currentScreenHandler == player.playerScreenHandler) {
            return;
        }
        String handler = player.currentScreenHandler.getClass().getSimpleName();
        player.closeHandledScreen();
        beginWorkstationContainerTransitionSettle(action, commandId, nowMs, "close_screen_transition:" + reason + ":" + handler);
        LOGGER.info(
            "{}.close_screen_transition instanceId={} commandId={} reason={} handler={}",
            action,
            instanceId,
            commandId == null ? "" : commandId,
            reason == null ? "" : reason,
            handler
        );
    }

    private void beginWorkstationContainerTransitionSettle(String action, String commandId, long nowMs, String reason) {
        workstationContainerTransitionSettleUntilMs = Math.max(
            workstationContainerTransitionSettleUntilMs,
            nowMs + WORKSTATION_CONTAINER_TRANSITION_SETTLE_MS
        );
        workstationContainerTransitionReason = reason == null ? "" : reason;
        lastWorkstationContainerTransitionSettleLogAtMs = 0L;
        LOGGER.info(
            "{}.container_transition_settle_start instanceId={} commandId={} reason={} settleMs={}",
            action == null ? "workstation" : action,
            instanceId,
            commandId == null ? "" : commandId,
            workstationContainerTransitionReason,
            WORKSTATION_CONTAINER_TRANSITION_SETTLE_MS
        );
    }

    private boolean workstationContainerTransitionSettling(String action, String commandId, long nowMs) {
        if (workstationContainerTransitionSettleUntilMs <= 0L) {
            return false;
        }
        if (nowMs >= workstationContainerTransitionSettleUntilMs) {
            workstationContainerTransitionSettleUntilMs = 0L;
            lastWorkstationContainerTransitionSettleLogAtMs = 0L;
            workstationContainerTransitionReason = "";
            return false;
        }
        if (lastWorkstationContainerTransitionSettleLogAtMs <= 0L
            || nowMs - lastWorkstationContainerTransitionSettleLogAtMs >= 250L) {
            lastWorkstationContainerTransitionSettleLogAtMs = nowMs;
            LOGGER.info(
                "{}.container_transition_settle_wait instanceId={} commandId={} remainingMs={} reason={}",
                action == null ? "workstation" : action,
                instanceId,
                commandId == null ? "" : commandId,
                Math.max(0L, workstationContainerTransitionSettleUntilMs - nowMs),
                workstationContainerTransitionReason
            );
        }
        return true;
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
        return findFurnaceFuelSourceScreenSlot(handler, 1);
    }

    private int findFurnaceFuelSourceScreenSlot(ScreenHandler handler, int desiredInputCount) {
        int desiredWoodFuelCount = FurnaceSmeltPlanner.desiredWoodFuelItemCount(desiredInputCount);
        int sourceSlot = findFurnaceSourceScreenSlot(
            handler,
            (stack, itemId) -> isCharcoalOrCoalFuel(itemId)
        );
        if (sourceSlot >= 0) {
            return sourceSlot;
        }
        sourceSlot = findFurnaceSourceScreenSlot(
            handler,
            (stack, itemId) -> (stack.isIn(ItemTags.LOGS) || InventoryCounter.isLogItemId(itemId)) && stack.getCount() >= desiredWoodFuelCount
        );
        if (sourceSlot >= 0) {
            return sourceSlot;
        }
        sourceSlot = findFurnaceSourceScreenSlot(
            handler,
            (stack, itemId) -> InventoryCounter.isPlankItemId(itemId) && stack.getCount() >= desiredWoodFuelCount
        );
        if (sourceSlot >= 0) {
            return sourceSlot;
        }
        sourceSlot = findFurnaceSourceScreenSlot(
            handler,
            (stack, itemId) -> stack.isIn(ItemTags.LOGS) || InventoryCounter.isLogItemId(itemId)
        );
        if (sourceSlot >= 0) {
            return sourceSlot;
        }
        return findFurnaceSourceScreenSlot(handler, (stack, itemId) -> InventoryCounter.isPlankItemId(itemId));
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

    private ControlDecision navigateToFurnaceInteractionCell(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        SmeltCharcoalRun run,
        BlockPos furnace,
        long nowMs,
        String action
    ) {
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        if (run.furnaceInteractionCell != null) {
            double distance = Math.hypot(
                PathFollower.center(run.furnaceInteractionCell.x()) - player.getX(),
                PathFollower.center(run.furnaceInteractionCell.z()) - player.getZ()
            );
            if (distance <= GATHER_ARRIVE_EPSILON) {
                run.excludedFurnaceInteractionCells.add(run.furnaceInteractionCell);
                run.furnaceInteractionCell = null;
            }
        }
        if (run.furnaceInteractionCell == null) {
            int referenceFeetY = (int) Math.floor(player.getY());
            WorldGridPerception perception = new WorldGridPerception(
                client.world,
                referenceFeetY,
                Math.min(start.x(), furnace.getX()) - NAVIGATION_PERCEPTION_MARGIN,
                Math.max(start.x(), furnace.getX()) + NAVIGATION_PERCEPTION_MARGIN,
                Math.min(start.z(), furnace.getZ()) - NAVIGATION_PERCEPTION_MARGIN,
                Math.max(start.z(), furnace.getZ()) + NAVIGATION_PERCEPTION_MARGIN
            );
            GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseAdjacent(
                perception,
                start,
                furnace.getX(),
                furnace.getZ(),
                run.excludedFurnaceInteractionCells
            );
            if (plan.cell() == null) {
                LOGGER.warn(
                    "{}.furnace_reposition_failed instanceId={} commandId={} furnace={} reason={} excludedCells={}",
                    action,
                    instanceId,
                    run.commandId,
                    furnace.toShortString(),
                    plan.reason(),
                    run.excludedFurnaceInteractionCells
                );
                return null;
            }
            run.furnaceInteractionCell = plan.cell();
            LOGGER.info(
                "{}.furnace_reposition_selected instanceId={} commandId={} furnace={} adjacent={} routeLength={} reason={} excludedCells={}",
                action,
                instanceId,
                run.commandId,
                furnace.toShortString(),
                run.furnaceInteractionCell,
                plan.route().size(),
                plan.reason(),
                run.excludedFurnaceInteractionCells
            );
        }
        String navCommandId = run.commandId
            + ":furnace:"
            + run.furnaceInteractionCell.x()
            + ":"
            + run.furnaceInteractionCell.z();
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
            PathFollower.center(run.furnaceInteractionCell.x()),
            null,
            PathFollower.center(run.furnaceInteractionCell.z()),
            List.of(),
            List.of(),
            GATHER_ARRIVE_EPSILON,
            List.of(),
            effective.expiresAtMs(),
            action + "_reposition_for_furnace_raycast",
            navCommandId
        );
        return resolveNavigationControl(client, player, navIntent);
    }

    private ControlDecision resolveMakeCharcoalControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (completedMakeCharcoalCommandIds.contains(commandId)) {
            return new ControlDecision(stopFrom(effective, finishedMakeCharcoalCommandReasons.getOrDefault(commandId, "make_charcoal_complete")), InputState.stop());
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
                if (!placeWorkstationExecutor.isFinishedFurnace(run.placeFurnaceCommandId())) {
                    return placeWorkstationExecutor.resolvePlaceFurnace(client, player, makeSubIntent(effective, "place_furnace", run.placeFurnaceCommandId(), "make_charcoal_place_furnace"), nowMs);
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
            if (placeWorkstationExecutor.isFinishedFurnace(run.placeFurnaceCommandId())) {
                return failMakeCharcoal(effective, run, inventory, nowMs, "make_charcoal_place_furnace_no_world_delta");
            }
            return placeWorkstationExecutor.resolvePlaceFurnace(client, player, makeSubIntent(effective, "place_furnace", run.placeFurnaceCommandId(), "make_charcoal_place_furnace"), nowMs);
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
        String completionReason = finishMakeCharcoalCommand(run.commandId, "make_charcoal_complete:" + reason);
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
        brainLink.completeCurrentCommand(run.commandId, completionReason, nowMs);
        return new ControlDecision(stopFrom(effective, completionReason), InputState.stop());
    }

    private ControlDecision failMakeCharcoal(
        BrainLink.Intent effective,
        MakeCharcoalRun run,
        CraftInventorySnapshot inventory,
        long nowMs,
        String reason
    ) {
        String completionReason = finishMakeCharcoalCommand(run.commandId, "make_charcoal_failed:" + reason);
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
        brainLink.completeCurrentCommand(run.commandId, completionReason, nowMs);
        return new ControlDecision(stopFrom(effective, completionReason), InputState.stop());
    }

    private void transitionMakeCharcoalPhase(MakeCharcoalRun run, MakeCharcoalPhase phase, long nowMs) {
        run.phase = phase;
        run.phaseStartedAtMs = nowMs;
    }

    // Search descend-relocation budget: short staircases down a cliff face when nothing is routable
    // from the current level. Two per mission segment alongside the three marches.
    private static final int GATHER_SEARCH_DESCEND_RELOCATION_LIMIT = 2;
    private static final int GATHER_SEARCH_DESCEND_RELOCATION_DEPTH = 8;
    // Bounded window for the nothing-reachable fallback regime (live runs showed 55 s of serial fallback
    // approaches lose the race with the 45 s global watchdog).
    private static final long GATHER_TREE_FALLBACK_WINDOW_MS = 20_000L;
    // Descent retry-rotation: retries within this radius/window of the previous failure
    // take a 90-degree rotated heading instead of re-digging into the same cavern.
    private static final long DESCENT_RETRY_ROTATE_WINDOW_MS = 60_000L;
    private static final double DESCENT_RETRY_ROTATE_RADIUS_SQ = 144.0D;
    private BlockPos lastDescentFailurePos = null;
    private long lastDescentFailureAtMs = 0L;

    private static StaircaseDescentPlanner.Direction2d rotateDescentDirection(StaircaseDescentPlanner.Direction2d direction) {
        // (dx, dz) -> (-dz, dx): a quarter turn; axis names follow the rotated deltas.
        int dx = -direction.dz();
        int dz = direction.dx();
        String name = dx > 0 ? "east" : dx < 0 ? "west" : dz > 0 ? "south" : "north";
        return new StaircaseDescentPlanner.Direction2d(dx, dz, name);
    }

    private BrainLink.Intent makeDescendRelocateIntent(MinecraftClient client, BrainLink.Intent source, String commandId, ClientPlayerEntity player) {
        // Lesson from live runs: both descents failed AT the cliff lip (overshot; unbridgeable gap) — the
        // staircase descends THROUGH ground, so aim it into the most-SOLID cardinal (dig through the
        // plateau interior; vertical relocation is the goal, horizontal direction is secondary).
        BlockPos feet = player.getBlockPos();
        int[][] cardinals = { {1, 0}, {-1, 0}, {0, 1}, {0, -1} };
        int[] best = cardinals[0];
        int bestScore = -1;
        for (int[] dir : cardinals) {
            int score = 0;
            for (int d = 2; d <= 5; d++) {
                BlockPos ahead = feet.add(dir[0] * d, 0, dir[1] * d);
                BlockState body = client.world.getBlockState(ahead);
                BlockState floor = client.world.getBlockState(ahead.down());
                if (!floor.getCollisionShape(client.world, ahead.down()).isEmpty()) {
                    score++;
                }
                if (!body.getCollisionShape(client.world, ahead).isEmpty()) {
                    score++; // solid at body height = genuinely digging into the hillside
                }
            }
            if (score > bestScore) {
                bestScore = score;
                best = dir;
            }
        }
        int targetY = (int) Math.floor(player.getY()) - GATHER_SEARCH_DESCEND_RELOCATION_DEPTH;
        return new BrainLink.Intent(
            "descend_staircase",
            false, false, false, false, false, false,
            null,
            null,
            (double) (feet.getX() + best[0] * GATHER_SEARCH_DESCEND_RELOCATION_DEPTH),
            (double) targetY,
            (double) (feet.getZ() + best[1] * GATHER_SEARCH_DESCEND_RELOCATION_DEPTH),
            List.of(),
            List.of(),
            null,
            List.of(),
            source.expiresAtMs(),
            "gather_tree_search_descend_relocate",
            commandId
        );
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

    private ControlDecision resolveEquipArmorControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (finishedEquipArmorCommandReasons.containsKey(commandId)) {
            return new ControlDecision(stopFrom(effective, finishedEquipArmorCommandReasons.getOrDefault(commandId, "equip_armor_complete")), InputState.stop());
        }
        ArmorController.Result result = armorController.tick(client, player, commandId, nowMs);
        if (result.status() == ArmorController.Status.COMPLETE) {
            String completionReason = finishEquipArmorCommand(commandId, "equip_armor_complete:" + result.reason());
            brainLink.completeCurrentCommand(commandId, completionReason, nowMs);
            return new ControlDecision(stopFrom(effective, completionReason), InputState.stop());
        }
        if (result.status() == ArmorController.Status.FAILED) {
            String completionReason = finishEquipArmorCommand(commandId, "equip_armor_failed:" + result.reason());
            brainLink.completeCurrentCommand(commandId, completionReason, nowMs);
            return new ControlDecision(stopFrom(effective, completionReason), InputState.stop());
        }
        return new ControlDecision(stopFrom(effective, "equip_armor_" + result.reason()), result.input());
    }

    static boolean hasCraftingTableReplacementMaterial(int logCount, int plankCount) {
        return Math.max(0, logCount) >= 1 || Math.max(0, plankCount) >= 4;
    }

    @Override
    public boolean isAnyOreBlockState(BlockState state) {
        return isIronOreBlock(state) || isCoalOreBlock(state) || isDiamondOreBlock(state);
    }

    static int[] cardinalOffset(float yaw) {
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

    static boolean isReplaceablePlacementOccluder(BlockState state) {
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

    @Override
    public String itemId(ItemStack stack) {
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
        return bestPickaxeRemainingDurability(player, InventoryCounter::isStonePickaxeItemId);
    }

    private int bestIronPickaxeRemainingDurability(ClientPlayerEntity player) {
        return bestPickaxeRemainingDurability(player, InventoryCounter::isIronPickaxeItemId);
    }

    static boolean isIronHarvestPickaxeItemId(String itemId) {
        return InventoryCounter.isStonePickaxeItemId(itemId)
            || isBetterThanStoneIronHarvestPickaxeItemId(itemId);
    }

    static boolean isBetterThanStoneIronHarvestPickaxeItemId(String itemId) {
        String normalized = itemId == null ? "" : itemId.trim().toLowerCase(Locale.ROOT);
        return "netherite_pickaxe".equals(normalized)
            || "diamond_pickaxe".equals(normalized)
            || InventoryCounter.isIronPickaxeItemId(normalized);
    }

    private int findIronHarvestPickaxeHotbarSlot(ClientPlayerEntity player) {
        int netheriteSlot = findBestHotbarSlotByRemaining(player, (id) -> "netherite_pickaxe".equalsIgnoreCase(id));
        if (netheriteSlot >= 0) {
            return netheriteSlot;
        }
        int diamondSlot = findBestHotbarSlotByRemaining(player, (id) -> "diamond_pickaxe".equalsIgnoreCase(id));
        if (diamondSlot >= 0) {
            return diamondSlot;
        }
        int ironSlot = findBestHotbarSlotByRemaining(player, InventoryCounter::isIronPickaxeItemId);
        if (ironSlot >= 0) {
            return ironSlot;
        }
        return findBestHotbarSlotByRemaining(player, InventoryCounter::isStonePickaxeItemId);
    }

    private int findBetterThanStoneIronHarvestPickaxeHotbarSlot(ClientPlayerEntity player) {
        int netheriteSlot = findBestHotbarSlotByRemaining(player, (id) -> "netherite_pickaxe".equalsIgnoreCase(id));
        if (netheriteSlot >= 0) {
            return netheriteSlot;
        }
        int diamondSlot = findBestHotbarSlotByRemaining(player, (id) -> "diamond_pickaxe".equalsIgnoreCase(id));
        if (diamondSlot >= 0) {
            return diamondSlot;
        }
        return findBestHotbarSlotByRemaining(player, InventoryCounter::isIronPickaxeItemId);
    }

    private int movePreferredIronHarvestPickaxeToHotbar(
        MinecraftClient client,
        ClientPlayerEntity player,
        boolean includeStone,
        String commandId,
        String logPrefix
    ) {
        int movedHotbarSlot = moveInventoryItemToHotbar(client, player, (id) -> "netherite_pickaxe".equalsIgnoreCase(id), commandId, logPrefix);
        if (movedHotbarSlot != -1) {
            return movedHotbarSlot;
        }
        movedHotbarSlot = moveInventoryItemToHotbar(client, player, (id) -> "diamond_pickaxe".equalsIgnoreCase(id), commandId, logPrefix);
        if (movedHotbarSlot != -1) {
            return movedHotbarSlot;
        }
        movedHotbarSlot = moveInventoryItemToHotbar(client, player, InventoryCounter::isIronPickaxeItemId, commandId, logPrefix);
        if (movedHotbarSlot != -1 || !includeStone) {
            return movedHotbarSlot;
        }
        return moveInventoryItemToHotbar(client, player, InventoryCounter::isStonePickaxeItemId, commandId, logPrefix);
    }

    @Override
    public int findStoneMiningPickaxeHotbarSlot(ClientPlayerEntity player) {
        int stoneOrBetterSlot = findIronHarvestPickaxeHotbarSlot(player);
        if (stoneOrBetterSlot >= 0) {
            return stoneOrBetterSlot;
        }
        return findBestHotbarSlotByRemaining(player, InventoryCounter::isWoodenPickaxeItemId);
    }

    @Override
    public int moveStoneMiningPickaxeToHotbar(
        MinecraftClient client,
        ClientPlayerEntity player,
        String commandId,
        String logPrefix
    ) {
        int movedHotbarSlot = movePreferredIronHarvestPickaxeToHotbar(client, player, true, commandId, logPrefix);
        if (movedHotbarSlot != -1) {
            return movedHotbarSlot;
        }
        return moveInventoryItemToHotbar(client, player, InventoryCounter::isWoodenPickaxeItemId, commandId, logPrefix);
    }

    private int bestPickaxeRemainingDurability(ClientPlayerEntity player, Predicate<String> itemPredicate) {
        if (player == null) {
            return -1;
        }
        int best = -1;
        int end = Math.min(36, player.getInventory().size());
        for (int slot = 0; slot < end; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty() || !itemPredicate.test(itemId(stack))) {
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

    @Override
    public String blockId(BlockState state) {
        if (state == null || state.isAir()) {
            return "air";
        }
        return net.minecraft.registry.Registries.BLOCK.getId(state.getBlock()).getPath();
    }

    @Override
    public int findHotbarSlot(ClientPlayerEntity player, Predicate<String> itemPredicate) {
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

    private int findBestHotbarSlotByRemaining(ClientPlayerEntity player, Predicate<String> itemPredicate) {
        if (player == null || itemPredicate == null) {
            return -1;
        }
        int bestSlot = -1;
        int bestRemaining = -1;
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack == null || stack.isEmpty() || !itemPredicate.test(itemId(stack))) {
                continue;
            }
            int remaining = remainingDurability(stack);
            if (remaining > bestRemaining) {
                bestRemaining = remaining;
                bestSlot = slot;
            }
        }
        return bestSlot;
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

    @Override
    public int moveInventoryItemToHotbar(
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
        // B2 pillar-up: before concluding "nothing reachable" with cluster logs still overhead
        // (a tall-canopy class seen in live runs), try a bounded pillar to bring the lowest one into
        // the overhead-harvest envelope. Returns null when there is nothing pillarable / budget
        // spent, and the normal conclusion proceeds.
        if ("no_reachable_tree_logs".equals(reason)) {
            ControlDecision pillar = maybeResolveGatherPillarUp(client, effective, run, nowMs);
            if (pillar != null) {
                return pillar;
            }
        }
        Set<BlockPos> liveCluster = liveTreeCluster(client.world, run.cluster);
        int inventoryDelta = Math.max(0, inventory.logCount() - run.baselineLogCount);
        int leftUnreached = liveCluster.size();
        String completionReason = "gather_tree_complete:" + reason;
        if (inventoryDelta == 0 && leftUnreached > 0) {
            completionReason = "gather_tree_failed:" + reason + ":left_unreached=" + leftUnreached;
        }
        rememberUnusableGatherTreeCluster(run, liveCluster, reason, inventoryDelta, leftUnreached);
        completedGatherTreeCommandIds.add(run.commandId);
        finishedGatherTreeCommandReasons.put(run.commandId, completionReason);
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
            leftUnreached,
            run.abandonedTargets.size(),
            run.collectTimeouts,
            run.occludersBroken,
            run.occlusionRepositions,
            run.occlusionAbandons,
            Math.max(0L, nowMs - run.startedAtMs),
            inventory.logsByItem()
        );
        activeGatherTree = null;
        return new ControlDecision(stopFrom(effective, completionReason), InputState.stop());
    }

    private void rememberUnusableGatherTreeCluster(
        GatherTreeRun run,
        Set<BlockPos> liveCluster,
        String reason,
        int inventoryDelta,
        int leftUnreached
    ) {
        if (run == null
            || liveCluster == null
            || leftUnreached <= 0
            || !shouldIgnoreUnusableGatherTreeCluster(run.cluster, reason)) {
            return;
        }
        int before = ignoredGatherTreeColumns.size();
        for (BlockPos log : run.cluster) {
            if (log != null) {
                ignoredGatherTreeColumns.add(new GridCell(log.getX(), log.getZ()));
            }
        }
        int added = ignoredGatherTreeColumns.size() - before;
        if (added > 0) {
            LOGGER.warn(
                "gather_tree.cluster_ignored instanceId={} commandId={} seed={} reason={} inventoryDelta={} leftUnreached={} clusterSize={} columnsAdded={}",
                instanceId,
                run.commandId,
                run.seed.toShortString(),
                reason,
                inventoryDelta,
                leftUnreached,
                run.cluster.size(),
                added
            );
        }
    }

    static boolean shouldIgnoreUnusableGatherTreeCluster(Set<BlockPos> cluster, String reason) {
        return isLargeMultiColumnTree(cluster)
            || "no_reachable_tree_logs".equals(reason)
            || "tree_exhausted".equals(reason);
    }

    static boolean shouldRetryPartialGatherTreeExhaustion(
        String reason,
        int inventoryLogCount,
        int baselineLogCount,
        int retries
    ) {
        return "tree_exhausted".equals(reason)
            && retries < GATHER_TREE_PARTIAL_EXHAUSTION_RETRIES
            && inventoryLogCount > baselineLogCount
            && inventoryLogCount < GATHER_TREE_PARTIAL_EXHAUSTION_LOG_TARGET;
    }

    private static boolean isLargeMultiColumnTree(Set<BlockPos> cluster) {
        if (cluster == null || cluster.size() < 16) {
            return false;
        }
        Set<GridCell> columns = new HashSet<>();
        for (BlockPos log : cluster) {
            if (log != null) {
                columns.add(new GridCell(log.getX(), log.getZ()));
            }
        }
        return columns.size() >= 4;
    }

    private boolean isIgnoredGatherTreeSeed(BlockPos seed) {
        return seed != null && ignoredGatherTreeColumns.contains(new GridCell(seed.getX(), seed.getZ()));
    }

    private void resetGatherTreeCurrentTarget(GatherTreeRun run) {
        run.currentTarget = null;
        run.currentAdjacentCell = null;
        run.currentAdjacentRoute = List.of();
        run.currentAdjacentReached = false;
        run.currentAdjacentLatchLogged = false;
        run.currentAdjacentLatchHoldLogged = false;
        run.targetOutOfReachRepositions = 0;
        run.currentAdjacentProgress.reset();
        run.excludedAdjacentCells.clear();
        run.breakStarted = false;
        run.breakDone = false;
        run.collectStartedAtMs = 0L;
        run.collectProgress.reset();
        run.sideCollectStall.reset();
        clearNavigationState();
    }

    @Override
    public void clearNavigationState() {
        activeNavigationCommandId = "";
        activeNavigationWaypointIndex = 0;
        activeNavigationProgress = PathFollower.Progress.initial();
        activeNavigationWaypoints = List.of();
        activeNavigationRouteComputed = false;
        activeNavigationSuppliedRoute = false;
        activeNavigationJumpWaypointIndexes = Set.of();
        navigationJumpRetryStreak.reset();
        abandonedJumpWaypointKey = "";
    }

    private void clearNav3dDriveState() {
        nav3dCollectRoute = List.of();
        nav3dCollectRouteDrop = null;
        nav3dCollectRouteComputedMs = 0L;
        nav3dOverlayWaypoints = List.of();
        nav3dLastProgressPos = null;
        nav3dLastProgressMs = 0L;
        nav3dLastTunnelDigTarget = null;
        nav3dLastTunnelBreakLogged = false;
    }

    private ControlDecision navigateToGatherTreeAdjacentCell(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        GatherTreeRun run,
        long nowMs
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
            GridPerception routePerception = maybeAnchorCurrentStart(client.world, perception, start, referenceFeetY, true);
            if (routePerception != perception) {
                LOGGER.info(
                    "navigation.start_anchored instanceId={} commandId={} reason=gather_tree_adjacent start={} referenceFeetY={} perceivedSurface={} anchoredSurface={}",
                    instanceId,
                    run.commandId,
                    start,
                    referenceFeetY,
                    formatSurface(perception, start),
                    referenceFeetY
                );
            }
            Set<GridCell> excludedBreakCells = gatherTreeBreakNavigationExclusions(client.world, run);
            GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
                routePerception,
                start,
                targetX,
                run.currentTarget.getY(),
                targetZ,
                excludedBreakCells
            );
            if (plan.cell() == null) {
                GatherLogPlanner.AdjacentPlan continuationPlan = chooseGatherTreeContinuationBreakCell(
                    client.world,
                    routePerception,
                    start,
                    run,
                    excludedBreakCells
                );
                if (continuationPlan != null && continuationPlan.cell() != null) {
                    LOGGER.info(
                        "gather_tree.adjacent_continuation_fallback instanceId={} commandId={} target={} previousReason={} adjacent={} routeLength={} reason={}",
                        instanceId,
                        run.commandId,
                        run.currentTarget.toShortString(),
                        plan.reason(),
                        continuationPlan.cell(),
                        continuationPlan.route().size(),
                        continuationPlan.reason()
                    );
                    plan = continuationPlan;
                }
            }
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
            run.currentAdjacentRoute = plan.route();
            run.currentAdjacentReached = false;
            run.currentAdjacentLatchLogged = false;
            run.currentAdjacentLatchHoldLogged = false;
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
        if (run.currentAdjacentReached) {
            if (!run.currentAdjacentLatchHoldLogged && !start.equals(run.currentAdjacentCell)) {
                run.currentAdjacentLatchHoldLogged = true;
                LOGGER.info(
                    "gather_tree.adjacent_latch_hold instanceId={} commandId={} target={} adjacent={} centerDistance={}",
                    instanceId,
                    run.commandId,
                    run.currentTarget.toShortString(),
                    run.currentAdjacentCell,
                    roundForLog(distance)
                );
            }
            return null;
        }
        if (start.equals(run.currentAdjacentCell) || distance <= GATHER_ARRIVE_EPSILON) {
            run.currentAdjacentReached = true;
            run.currentAdjacentProgress.reset();
            if (!run.currentAdjacentLatchLogged) {
                run.currentAdjacentLatchLogged = true;
                LOGGER.info(
                    "gather_tree.adjacent_latched instanceId={} commandId={} target={} adjacent={} centerDistance={}",
                    instanceId,
                    run.commandId,
                    run.currentTarget.toShortString(),
                    run.currentAdjacentCell,
                    roundForLog(distance)
                );
            }
            if (start.equals(run.currentAdjacentCell) && distance > GATHER_ARRIVE_EPSILON) {
                LOGGER.info(
                    "gather_tree.adjacent_arrived_by_cell instanceId={} commandId={} target={} adjacent={} centerDistance={}",
                    instanceId,
                    run.commandId,
                    run.currentTarget.toShortString(),
                    run.currentAdjacentCell,
                    roundForLog(distance)
                );
            }
            return null;
        }
        AdjacentMoveProgressTracker.Result progress = run.currentAdjacentProgress.updateDistanceOnly(
            run.currentAdjacentCell,
            distance,
            nowMs,
            gatherAdjacentMoveStallMs(run.currentAdjacentRoute, distance),
            GATHER_ADJACENT_MOVE_IMPROVEMENT
        );
        if (progress.stalled()) {
            run.excludedAdjacentCells.add(run.currentAdjacentCell);
            run.currentAdjacentMoveStalls++;
            LOGGER.warn(
                "gather_tree.adjacent_move_stall instanceId={} commandId={} target={} adjacent={} distance={} bestDistance={} stalledMs={} stalls={}",
                instanceId,
                run.commandId,
                run.currentTarget.toShortString(),
                run.currentAdjacentCell,
                roundForLog(distance),
                roundForLog(progress.bestDistance()),
                progress.stalledMs(),
                run.currentAdjacentMoveStalls
            );
            run.currentAdjacentCell = null;
            run.currentAdjacentRoute = List.of();
            run.currentAdjacentReached = false;
            run.currentAdjacentLatchLogged = false;
            run.currentAdjacentLatchHoldLogged = false;
            run.currentAdjacentProgress.reset();
            clearNavigationState();
            return new ControlDecision(stopFrom(effective, "gather_tree_adjacent_move_stall_reposition"), InputState.stop());
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
            run.currentAdjacentRoute,
            List.of(),
            GATHER_ARRIVE_EPSILON,
            List.of(),
            effective.expiresAtMs(),
            "gather_tree_nav_adjacent",
            run.commandId + ":tree:adjacent"
        );
        return resolveNavigationControl(client, player, navIntent);
    }

    private GatherLogPlanner.AdjacentPlan chooseGatherTreeContinuationBreakCell(
        BlockView world,
        GridPerception routePerception,
        GridCell start,
        GatherTreeRun run,
        Set<GridCell> excludedBreakCells
    ) {
        if (world == null
            || routePerception == null
            || start == null
            || run == null
            || run.currentTarget == null
            || run.completedTargets.isEmpty()
            || !isSingleAxisGatherTreeCluster(liveTreeCluster(world, run.cluster))) {
            return null;
        }
        Set<GridCell> skipped = excludedBreakCells == null ? Set.of() : excludedBreakCells;
        GridCell targetCell = new GridCell(run.currentTarget.getX(), run.currentTarget.getZ());
        List<GatherTreeContinuationCandidate> routedCandidates = new ArrayList<>();
        List<GatherTreeContinuationCandidate> directCandidates = new ArrayList<>();
        for (BlockPos completed : run.completedTargets) {
            if (completed == null) {
                continue;
            }
            GridCell completedCell = new GridCell(completed.getX(), completed.getZ());
            if (completedCell.equals(targetCell)
                || continuationBreakDistanceSquared(completedCell, targetCell) > GATHER_TREE_CONTINUATION_BREAK_DISTANCE_SQUARED
                || !isSameGatherTreeRowAxis(run, completedCell, targetCell)) {
                continue;
            }
            if (shouldUseGatherTreeRowAxisContinuationCell(
                routePerception,
                start,
                completedCell,
                targetCell,
                run.currentTarget.getY(),
                true,
                isGatherTreeRowApproachClear(world, run, completedCell, targetCell),
                skipped
            )) {
                List<GridCell> route = GridAStar.route(routePerception, start, completedCell);
                if (!route.isEmpty()) {
                    routedCandidates.add(new GatherTreeContinuationCandidate(
                        completedCell,
                        route,
                        "completed_row_axis_break_cell"
                    ));
                } else if (shouldUseGatherTreeContinuationDirectRoute(
                    routePerception,
                    start,
                    completedCell,
                    run.currentTarget.getY()
                )) {
                    directCandidates.add(new GatherTreeContinuationCandidate(
                        completedCell,
                        fallbackContinuationRoute(start, completedCell),
                        "completed_row_axis_direct_route"
                    ));
                }
            }
            for (GridCell cell : gatherTreeContinuationSideCells(run, completedCell)) {
                if (cell.equals(targetCell)
                    || skipped.contains(cell)
                    || isGatherTreeRowAxisCell(run, cell)
                    || !routePerception.inBounds(cell.x(), cell.z())
                    || routePerception.isBlocked(cell.x(), cell.z())
                    || continuationBreakDistanceSquared(cell, targetCell) > GATHER_TREE_CONTINUATION_BREAK_DISTANCE_SQUARED) {
                    continue;
                }
                List<GridCell> route = GridAStar.route(routePerception, start, cell);
                if (!route.isEmpty()) {
                    routedCandidates.add(new GatherTreeContinuationCandidate(cell, route, "completed_row_side_break_cell"));
                } else if (shouldUseGatherTreeContinuationDirectRoute(
                    routePerception,
                    start,
                    cell,
                    run.currentTarget.getY()
                )) {
                    directCandidates.add(new GatherTreeContinuationCandidate(
                        cell,
                        fallbackContinuationRoute(start, cell),
                        "completed_row_side_direct_route"
                    ));
                }
            }
        }
        if (!routedCandidates.isEmpty()) {
            routedCandidates.sort(Comparator
                .comparingInt((GatherTreeContinuationCandidate candidate) -> continuationBreakDistanceSquared(candidate.cell(), targetCell))
                .thenComparingInt((GatherTreeContinuationCandidate candidate) -> continuationBreakDistanceSquared(start, candidate.cell())));
            GatherTreeContinuationCandidate best = routedCandidates.getFirst();
            return new GatherLogPlanner.AdjacentPlan(best.cell(), best.route(), best.reason());
        }
        if (!directCandidates.isEmpty()) {
            directCandidates.sort(Comparator
                .comparingInt((GatherTreeContinuationCandidate candidate) -> continuationBreakDistanceSquared(candidate.cell(), targetCell))
                .thenComparingInt((GatherTreeContinuationCandidate candidate) -> continuationBreakDistanceSquared(start, candidate.cell())));
            GatherTreeContinuationCandidate best = directCandidates.getFirst();
            return new GatherLogPlanner.AdjacentPlan(best.cell(), best.route(), best.reason());
        }
        return null;
    }

    static boolean shouldUseGatherTreeRowAxisContinuationCell(
        GridPerception routePerception,
        GridCell start,
        GridCell cell,
        GridCell target,
        int targetY,
        boolean sameRowAxis,
        boolean approachClear,
        Set<GridCell> skipped
    ) {
        if (routePerception == null || start == null || cell == null || target == null) {
            return false;
        }
        if (!sameRowAxis || !approachClear || cell.equals(target)) {
            return false;
        }
        if (skipped != null && skipped.contains(cell)) {
            return false;
        }
        if (continuationBreakDistanceSquared(cell, target) > GATHER_TREE_CONTINUATION_BREAK_DISTANCE_SQUARED
            || continuationBreakDistanceSquared(start, cell) > GATHER_TREE_CONTINUATION_ROUTE_FALLBACK_DISTANCE_SQUARED) {
            return false;
        }
        if (!routePerception.inBounds(cell.x(), cell.z()) || routePerception.isBlocked(cell.x(), cell.z())) {
            return false;
        }
        OptionalInt surface = routePerception.surfaceY(cell.x(), cell.z());
        return surface.isPresent()
            && Math.abs(surface.getAsInt() - targetY) <= GATHER_TREE_CONTINUATION_DIRECT_MAX_SURFACE_DELTA;
    }

    static boolean shouldUseGatherTreeContinuationDirectRoute(
        GridPerception routePerception,
        GridCell start,
        GridCell cell,
        int targetY
    ) {
        if (routePerception == null || start == null || cell == null) {
            return false;
        }
        if (continuationBreakDistanceSquared(start, cell) > GATHER_TREE_CONTINUATION_ROUTE_FALLBACK_DISTANCE_SQUARED) {
            return false;
        }
        OptionalInt surface = routePerception.surfaceY(cell.x(), cell.z());
        return surface.isPresent()
            && Math.abs(surface.getAsInt() - targetY) <= GATHER_TREE_CONTINUATION_DIRECT_MAX_SURFACE_DELTA;
    }

    private static List<GridCell> gatherTreeContinuationSideCells(GatherTreeRun run, GridCell rowCell) {
        if (run == null || rowCell == null) {
            return List.of();
        }
        Map<Integer, Set<Integer>> xsByZ = new HashMap<>();
        Map<Integer, Set<Integer>> zsByX = new HashMap<>();
        for (BlockPos log : run.cluster) {
            if (log != null) {
                xsByZ.computeIfAbsent(log.getZ(), ignored -> new HashSet<>()).add(log.getX());
                zsByX.computeIfAbsent(log.getX(), ignored -> new HashSet<>()).add(log.getZ());
            }
        }
        List<GridCell> cells = new ArrayList<>();
        Set<Integer> rowXs = xsByZ.get(rowCell.z());
        if (rowXs != null && rowXs.size() >= 2) {
            cells.add(new GridCell(rowCell.x(), rowCell.z() - 1));
            cells.add(new GridCell(rowCell.x(), rowCell.z() + 1));
        }
        Set<Integer> columnZs = zsByX.get(rowCell.x());
        if (columnZs != null && columnZs.size() >= 2) {
            cells.add(new GridCell(rowCell.x() - 1, rowCell.z()));
            cells.add(new GridCell(rowCell.x() + 1, rowCell.z()));
        }
        return cells;
    }

    private record GatherTreeContinuationCandidate(GridCell cell, List<GridCell> route, String reason) {
    }

    private static List<GridCell> fallbackContinuationRoute(GridCell start, GridCell cell) {
        if (start == null || cell == null) {
            return List.of();
        }
        if (start.equals(cell)) {
            return List.of(start);
        }
        List<GridCell> route = new ArrayList<>();
        if (start.z() == cell.z()) {
            int step = Integer.compare(cell.x(), start.x());
            for (int x = start.x() + step; step != 0 && x != cell.x() + step; x += step) {
                route.add(new GridCell(x, start.z()));
            }
            return route;
        }
        if (start.x() == cell.x()) {
            int step = Integer.compare(cell.z(), start.z());
            for (int z = start.z() + step; step != 0 && z != cell.z() + step; z += step) {
                route.add(new GridCell(start.x(), z));
            }
            return route;
        }
        return List.of(cell);
    }

    private static int continuationBreakDistanceSquared(GridCell a, GridCell b) {
        int dx = a.x() - b.x();
        int dz = a.z() - b.z();
        return dx * dx + dz * dz;
    }

    private static Set<GridCell> gatherTreeBreakCellExclusions(GatherTreeRun run) {
        if (run == null) {
            return Set.of();
        }
        Set<GridCell> excluded = new HashSet<>(run.excludedAdjacentCells);
        Map<Integer, Set<Integer>> xsByZ = new HashMap<>();
        Map<Integer, Set<Integer>> zsByX = new HashMap<>();
        for (BlockPos log : run.cluster) {
            if (log != null) {
                excluded.add(new GridCell(log.getX(), log.getZ()));
                xsByZ.computeIfAbsent(log.getZ(), ignored -> new HashSet<>()).add(log.getX());
                zsByX.computeIfAbsent(log.getX(), ignored -> new HashSet<>()).add(log.getZ());
            }
        }
        for (Map.Entry<Integer, Set<Integer>> entry : xsByZ.entrySet()) {
            Set<Integer> xs = entry.getValue();
            if (xs.size() < 2) {
                continue;
            }
            int min = xs.stream().mapToInt(Integer::intValue).min().orElse(0);
            int max = xs.stream().mapToInt(Integer::intValue).max().orElse(0);
            for (int x = min - 1; x <= max + 1; x++) {
                excluded.add(new GridCell(x, entry.getKey()));
            }
        }
        for (Map.Entry<Integer, Set<Integer>> entry : zsByX.entrySet()) {
            Set<Integer> zs = entry.getValue();
            if (zs.size() < 2) {
                continue;
            }
            int min = zs.stream().mapToInt(Integer::intValue).min().orElse(0);
            int max = zs.stream().mapToInt(Integer::intValue).max().orElse(0);
            for (int z = min - 1; z <= max + 1; z++) {
                excluded.add(new GridCell(entry.getKey(), z));
            }
        }
        return excluded;
    }

    private Set<GridCell> gatherTreeBreakNavigationExclusions(BlockView world, GatherTreeRun run) {
        if (run == null) {
            return Set.of();
        }
        Set<GridCell> excluded = new HashSet<>(run.excludedAdjacentCells);
        for (BlockPos log : liveTreeCluster(world, run.cluster)) {
            if (log != null) {
                excluded.add(new GridCell(log.getX(), log.getZ()));
            }
        }
        return excluded;
    }

    private static boolean isGatherTreeRowAxisCell(GatherTreeRun run, GridCell cell) {
        if (run == null || cell == null) {
            return false;
        }
        Map<Integer, Set<Integer>> xsByZ = new HashMap<>();
        Map<Integer, Set<Integer>> zsByX = new HashMap<>();
        for (BlockPos log : run.cluster) {
            if (log != null) {
                xsByZ.computeIfAbsent(log.getZ(), ignored -> new HashSet<>()).add(log.getX());
                zsByX.computeIfAbsent(log.getX(), ignored -> new HashSet<>()).add(log.getZ());
            }
        }
        for (Map.Entry<Integer, Set<Integer>> entry : xsByZ.entrySet()) {
            if (entry.getKey() == cell.z() && entry.getValue().size() >= 2) {
                return true;
            }
        }
        for (Map.Entry<Integer, Set<Integer>> entry : zsByX.entrySet()) {
            if (entry.getKey() == cell.x() && entry.getValue().size() >= 2) {
                return true;
            }
        }
        return false;
    }

    private static boolean isSameGatherTreeRowAxis(GatherTreeRun run, GridCell start, GridCell drop) {
        if (run == null || start == null || drop == null) {
            return false;
        }
        Map<Integer, Set<Integer>> xsByZ = new HashMap<>();
        Map<Integer, Set<Integer>> zsByX = new HashMap<>();
        for (BlockPos log : run.cluster) {
            if (log != null) {
                xsByZ.computeIfAbsent(log.getZ(), ignored -> new HashSet<>()).add(log.getX());
                zsByX.computeIfAbsent(log.getX(), ignored -> new HashSet<>()).add(log.getZ());
            }
        }
        Set<Integer> row = xsByZ.get(start.z());
        if (start.z() == drop.z() && row != null && row.size() >= 2) {
            return true;
        }
        Set<Integer> column = zsByX.get(start.x());
        return start.x() == drop.x() && column != null && column.size() >= 2;
    }

    private boolean isGatherTreeRowApproachClear(BlockView world, GatherTreeRun run, GridCell start, GridCell drop) {
        if (world == null || run == null || start == null || drop == null) {
            return false;
        }
        Set<GridCell> liveLogCells = new HashSet<>();
        for (BlockPos log : liveTreeCluster(world, run.cluster)) {
            if (log != null) {
                liveLogCells.add(new GridCell(log.getX(), log.getZ()));
            }
        }
        if (start.z() == drop.z()) {
            int step = Integer.compare(drop.x(), start.x());
            for (int x = start.x() + step; step != 0 && x != drop.x(); x += step) {
                if (liveLogCells.contains(new GridCell(x, start.z()))) {
                    return false;
                }
            }
            return true;
        }
        if (start.x() == drop.x()) {
            int step = Integer.compare(drop.z(), start.z());
            for (int z = start.z() + step; step != 0 && z != drop.z(); z += step) {
                if (liveLogCells.contains(new GridCell(start.x(), z))) {
                    return false;
                }
            }
            return true;
        }
        return false;
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

    @Override
    public BrainLink.Intent gatherCollectIntent(BrainLink.Intent effective, BlockPos target, GridCell adjacentCell) {
        double targetX = adjacentCell == null ? target.getX() + 0.5D : PathFollower.center(adjacentCell.x());
        double targetZ = adjacentCell == null ? target.getZ() + 0.5D : PathFollower.center(adjacentCell.z());
        return gatherCollectIntent(effective, targetX, targetZ, "gather_log_collect_drop", ":collect");
    }

    @Override
    public BrainLink.Intent gatherCollectIntent(
        BrainLink.Intent effective,
        double targetX,
        double targetZ,
        String reason,
        String commandSuffix
    ) {
        return gatherCollectIntent(effective, targetX, null, targetZ, reason, commandSuffix);
    }

    @Override
    public BrainLink.Intent gatherCollectIntent(
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

    @Override
    public Vec3d nearestDroppedLogItemPosition(MinecraftClient client, ClientPlayerEntity player, BlockPos target) {
        return nearestDroppedItemPosition(
            client,
            player,
            target,
            (stack, itemId) -> stack.isIn(ItemTags.LOGS) || InventoryCounter.isLogItemId(itemId)
        );
    }

    @Override
    public String lastGatherCollectItemLogKey() {
        return lastGatherCollectItemLogKey;
    }

    @Override
    public void setLastGatherCollectItemLogKey(String key) {
        lastGatherCollectItemLogKey = key;
    }

    @Override
    public Vec3d nearestDroppedItemPosition(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos target,
        BiPredicate<ItemStack, String> itemPredicate
    ) {
        return nearestDroppedItemPosition(client, player, target, itemPredicate, false);
    }

    private Vec3d nearestDroppedItemPosition(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos target,
        BiPredicate<ItemStack, String> itemPredicate,
        boolean preferTargetProximity
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
        Vec3d targetCenter = Vec3d.ofCenter(target);
        Vec3d nearest = null;
        double nearestPrimaryDistanceSquared = Double.POSITIVE_INFINITY;
        double nearestPlayerDistanceSquared = Double.POSITIVE_INFINITY;
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
            double playerDistanceSquared = itemPos.squaredDistanceTo(playerPos);
            double primaryDistanceSquared = preferTargetProximity ? itemPos.squaredDistanceTo(targetCenter) : playerDistanceSquared;
            if (primaryDistanceSquared < nearestPrimaryDistanceSquared
                || (Math.abs(primaryDistanceSquared - nearestPrimaryDistanceSquared) <= 0.0001D
                    && playerDistanceSquared < nearestPlayerDistanceSquared)) {
                nearestPrimaryDistanceSquared = primaryDistanceSquared;
                nearestPlayerDistanceSquared = playerDistanceSquared;
                nearest = itemPos;
            }
        }
        return nearest;
    }

    static double roundForLog(double value) {
        return Math.round(value * 1000.0D) / 1000.0D;
    }

    @Override
    public BlockPos targetBlockPos(BrainLink.Intent intent) {
        if (intent == null || intent.targetX() == null || intent.targetY() == null || intent.targetZ() == null) {
            return null;
        }
        return new BlockPos(
            (int) Math.floor(intent.targetX()),
            (int) Math.floor(intent.targetY()),
            (int) Math.floor(intent.targetZ())
        );
    }

    @Override
    public BrainLink.Intent lookIntentForBlock(BrainLink.Intent source, ClientPlayerEntity player, BlockPos target, String reason) {
        LookAngles angles = lookAnglesToBlock(player, target);
        return lookIntentForAngles(source, angles.yaw(), angles.pitch(), reason);
    }

    private BrainLink.Intent lookIntentForPoint(BrainLink.Intent source, ClientPlayerEntity player, Vec3d target, String reason) {
        LookAngles angles = lookAnglesToPoint(player, target);
        return lookIntentForAngles(source, angles.yaw(), angles.pitch(), reason);
    }

    @Override
    public BrainLink.Intent lookIntentForAngles(BrainLink.Intent source, double yaw, double pitch, String reason) {
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

    @Override
    public LookAngles lookAnglesToPoint(ClientPlayerEntity player, Vec3d target) {
        Vec3d eye = player.getEyePos();
        double dx = target.x - eye.x;
        double dy = target.y - eye.y;
        double dz = target.z - eye.z;
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        double pitch = Math.toDegrees(Math.atan2(-dy, horizontal));
        return new LookAngles(yaw, pitch);
    }

    private LookAngles directCollectApproachLook(ClientPlayerEntity player, Vec3d target, boolean belowPickupHeight) {
        double dx = target.x - player.getX();
        double dz = target.z - player.getZ();
        double horizontal = Math.hypot(dx, dz);
        double yaw = horizontal <= 0.001D ? player.getYaw() : Math.toDegrees(Math.atan2(-dx, dz));
        return new LookAngles(yaw, belowPickupHeight ? 20.0D : 0.0D);
    }

    @Override
    public BrainLink.Intent stopFrom(BrainLink.Intent source, String reason) {
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

    @Override
    public void logBlockBreakResult(String commandId, BlockPos target, BlockBreakController.Result result) {
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

    private void logMineNearbyStoneBreakProgress(
        MineNearbyStoneRun run,
        String commandId,
        BlockPos target,
        BlockState targetState,
        String selectedItem,
        long breakTimeoutMs,
        BlockBreakController.Result result,
        long nowMs
    ) {
        String logKey = target.toShortString()
            + ":" + blockId(targetState)
            + ":" + selectedItem
            + ":" + result.status()
            + ":" + result.reason()
            + ":" + formatBlockPos(result.hitBlock())
            + ":" + formatBlockPos(result.actedBlock())
            + ":" + (result.elapsedMs() / 1000L);
        if (result.status() == BlockBreakController.Status.RUNNING
            && logKey.equals(run.lastBreakProgressLogKey)
            && nowMs - run.lastBreakProgressLogAtMs < BREAK_PROGRESS_LOG_INTERVAL_MS) {
            return;
        }
        LOGGER.info(
            "mine_nearby_stone.break_progress instanceId={} commandId={} target={} blockId={} selectedItem={} timeoutMs={} status={} reason={} hitBlock={} actedBlock={} elapsedMs={}",
            instanceId,
            commandId,
            target.toShortString(),
            blockId(targetState),
            selectedItem,
            breakTimeoutMs,
            result.status(),
            result.reason(),
            formatBlockPos(result.hitBlock()),
            formatBlockPos(result.actedBlock()),
            result.elapsedMs()
        );
        run.lastBreakProgressLogKey = logKey;
        run.lastBreakProgressLogAtMs = nowMs;
    }

    static String formatBlockPos(BlockPos pos) {
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

    @Override
    public boolean isLookingAtBlock(ClientPlayerEntity player, BlockPos target) {
        LookAngles angles = lookAnglesToBlock(player, target);
        double yawError = Math.abs(LookController.normalizeYaw(angles.yaw() - player.getYaw()));
        double pitchError = Math.abs(angles.pitch() - player.getPitch());
        return yawError <= BLOCK_LOOK_TOLERANCE_DEG && pitchError <= BLOCK_LOOK_TOLERANCE_DEG;
    }

    private boolean isLookRaycastHittingBlock(MinecraftClient client, ClientPlayerEntity player, BlockPos target) {
        if (client == null || client.world == null || player == null || target == null) {
            return false;
        }
        double reach = Math.min(4.8D, Math.max(1.0D, player.getBlockInteractionRange()));
        Vec3d eye = player.getEyePos();
        Vec3d end = eye.add(player.getRotationVec(1.0F).multiply(reach));
        BlockHitResult hit = client.world.raycast(new RaycastContext(
            eye,
            end,
            RaycastContext.ShapeType.OUTLINE,
            RaycastContext.FluidHandling.NONE,
            player
        ));
        return hit != null && hit.getType() == HitResult.Type.BLOCK && target.equals(hit.getBlockPos());
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
            activeNavigationSuppliedRoute = false;
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

    static GridPerception maybeAnchorCurrentStart(
        BlockView world,
        WorldGridPerception perception,
        GridCell start,
        int referenceFeetY,
        boolean anchorAllowed
    ) {
        if (world == null || perception == null || start == null) {
            return perception;
        }
        if (!anchorAllowed) {
            return perception;
        }
        OptionalInt perceived = perception.surfaceY(start.x(), start.z());
        if (perceived.isPresent() && Math.abs(perceived.getAsInt() - referenceFeetY) <= 1) {
            return perception;
        }
        return StartAnchoredGridPerception.anchor(perception, start, referenceFeetY);
    }

    private static boolean isGatherAdjacentNavigation(BrainLink.Intent effective) {
        if (effective == null) {
            return false;
        }
        String reason = effective.reason() == null ? "" : effective.reason();
        return "gather_log_nav_adjacent".equals(reason)
            || "gather_tree_nav_adjacent".equals(reason)
            || "gather_tree_search".equals(reason);
    }

    @Override
    public ControlDecision resolveNavigationControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (!commandId.equals(activeNavigationCommandId)) {
            activeNavigationCommandId = commandId;
            activeNavigationWaypointIndex = 0;
        activeNavigationProgress = PathFollower.Progress.initial();
        activeNavigationWaypoints = List.of();
        activeNavigationRouteComputed = false;
        activeNavigationSuppliedRoute = false;
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
        int followerInIndex = activeNavigationWaypointIndex;
        PathFollower.Progress followerInProgress = activeNavigationProgress;
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
        int skippedJumpWaypoint = skippedUnreachedJumpWaypoint(
            followerInIndex,
            command.waypointIndex(),
            activeNavigationJumpWaypointIndexes,
            waypoints,
            player.getX(),
            player.getZ(),
            arriveEpsilon
        );
        if (skippedJumpWaypoint >= 0) {
            // R0: re-aim at the skipped jump waypoint -- but only until the streak limit. A jump the
            // bot physically cannot re-reach would otherwise be retried every tick forever.
            String jumpKey = commandId + ":" + skippedJumpWaypoint;
            boolean alreadyAbandoned = jumpKey.equals(abandonedJumpWaypointKey);
            if (!alreadyAbandoned && navigationJumpRetryStreak.record(jumpKey) >= NAVIGATION_JUMP_RETRY_ABANDON_STREAK) {
                LOGGER.warn(
                    "navigation.jump_waypoint_abandon instanceId={} commandId={} retryIndex={} streak={} -- proceeding forward past it",
                    instanceId,
                    commandId,
                    skippedJumpWaypoint,
                    NAVIGATION_JUMP_RETRY_ABANDON_STREAK
                );
                abandonedJumpWaypointKey = jumpKey;
                navigationJumpRetryStreak.reset();
                alreadyAbandoned = true;
            }
            if (!alreadyAbandoned) {
                LOGGER.info(
                    "navigation.retry_skipped_jump_waypoint instanceId={} commandId={} reason={} fromIndex={} toIndex={} retryIndex={} distance={} jumpWaypoints={}",
                    instanceId,
                    commandId,
                    effective.reason(),
                    followerInIndex,
                    command.waypointIndex(),
                    skippedJumpWaypoint,
                    roundForLog(distanceToWaypointCenter(waypoints.get(skippedJumpWaypoint), player.getX(), player.getZ())),
                    activeNavigationJumpWaypointIndexes
                );
                command = PathFollower.follow(
                    waypoints,
                    skippedJumpWaypoint,
                    PathFollower.Progress.initial(),
                    player.getX(),
                    player.getZ(),
                    player.getYaw(),
                    arriveEpsilon,
                    LOOK_MAX_DEG_PER_TICK
                );
            }
            // When abandoned, fall through with the natural forward command (it already advanced past
            // the skipped jump); the global edge-guard still vetoes any unsafe drop ahead.
        } else {
            navigationJumpRetryStreak.reset();
        }
        activeNavigationWaypointIndex = command.waypointIndex();
        activeNavigationProgress = command.progress();
        boolean stepAssistJump = shouldJumpForStepUp(client, command.waypointIndex(), player, waypoints);
        if (!stepAssistJump) {
            // #1 canopy break: shouldJumpForStepUp refuses a +1 step-up when the destination head is solid.
            // When that solid is a breakable LEAF (the bot routed under canopy), clear it instead of looping
            // on retry_skipped_jump_waypoint; the mount then proceeds next tick. A real ceiling stays suppressed.
            BlockPos canopyLeaf = stepUpCanopyBreakTarget(client, command.waypointIndex(), player, waypoints);
            if (canopyLeaf != null) {
                ControlDecision canopyBreak = resolveCanopyLeafBreakControl(client, player, effective, canopyLeaf, commandId);
                if (canopyBreak != null) {
                    return canopyBreak;
                }
            }
        }
        boolean unstickJump = shouldJumpForNavigationUnstick(effective, command, player, waypoints);
        boolean navigationJump = stepAssistJump || unstickJump;
        maybeRecordFollowerStall(player, waypoints, followerInIndex, followerInProgress, command, navigationJump, arriveEpsilon);
        InputState input = navigationInputWithJump(command.input(), navigationJump, unstickJump || stepAssistJump);

        BrainLink.Intent intent = new BrainLink.Intent(
            command.intent().action(),
            command.intent().forward(),
            command.intent().back(),
            command.intent().left(),
            command.intent().right(),
            command.intent().jump() || navigationJump,
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

    // Edge-guard for route-less direct walking: refuse forward when the ground along the
    // immediate walk line has no floor within EDGE_GUARD_MAX_DROP below feet level — an early death
    // was a full-health fall during exactly this kind of collect chase. Two probe columns (~0.8 and
    // ~1.6 blocks ahead) so one sprint tick cannot step past the check; water counts as floor
    // (landing in water is safe); airborne/swimming ticks are exempt so the guard never fights the
    // descent, jump, or wade paths. A drop of <=3 is allowed (zero fall damage).
    private static final int EDGE_GUARD_MAX_DROP = 3;
    // Veto-feedback knobs: refused cells stay blocked in route perception for the TTL; a streak of
    // vetoes on one command forces a route recompute (which then avoids the cells or fails into the
    // existing rejection/abandon flows).
    // Regression lesson: channel-2 (target abandonment) at 10 ticks killed legitimate tree
    // approaches that merely grazed an edge for half a second (7 clusters found, 0 logs gathered,
    // 4 abandons), and 60 s cells poisoned the re-approaches. Reroute stays cheap and early (10);
    // ABANDONMENT is a last resort (60 ticks ~ 3 s of continuous veto, i.e. rerouting demonstrably
    // did not help); cells expire in 15 s — cheap to re-record if the edge is real.
    private static final long EDGE_VETO_CELL_TTL_MS = 15_000L;
    private static final int EDGE_VETO_REROUTE_STREAK = 10;
    private static final int EDGE_VETO_ABANDON_STREAK = 60;

    private void recordEdgeVeto(ClientPlayerEntity player, long nowMs) {
        double yawRad = Math.toRadians(player.getYaw());
        double dirX = -Math.sin(yawRad);
        double dirZ = Math.cos(yawRad);
        for (double ahead = 0.8D; ahead <= 1.7D; ahead += 0.8D) {
            GridCell cell = new GridCell(
                (int) Math.floor(player.getX() + dirX * ahead),
                (int) Math.floor(player.getZ() + dirZ * ahead)
            );
            vetoedEdgeCells.put(cell, nowMs + EDGE_VETO_CELL_TTL_MS);
        }
    }

    // Overlay the live veto set on any route perception (expired entries pruned on the way).
    private GridPerception vetoAware(GridPerception base, long nowMs) {
        vetoedEdgeCells.values().removeIf(expiry -> expiry <= nowMs);
        if (vetoedEdgeCells.isEmpty()) {
            return base;
        }
        return new VetoAwareGridPerception(base, Set.copyOf(vetoedEdgeCells.keySet()));
    }

    @Override
    public boolean edgeGuardBlocksForward(MinecraftClient client, ClientPlayerEntity player, double yawDegrees) {
        if (client == null || client.world == null || player == null) {
            return false;
        }
        if (!player.isOnGround() || player.isTouchingWater()) {
            return false;
        }
        double yawRad = Math.toRadians(yawDegrees);
        double dirX = -Math.sin(yawRad);
        double dirZ = Math.cos(yawRad);
        int feetY = (int) Math.floor(player.getY());
        for (double ahead = 0.8D; ahead <= 1.7D; ahead += 0.8D) {
            int cx = (int) Math.floor(player.getX() + dirX * ahead);
            int cz = (int) Math.floor(player.getZ() + dirZ * ahead);
            BlockPos col = new BlockPos(cx, feetY, cz);
            BlockState bodyState = client.world.getBlockState(col);
            if (!bodyState.getCollisionShape(client.world, col).isEmpty()) {
                continue; // step-up or wall ahead — not an edge
            }
            boolean floorFound = false;
            for (int drop = 1; drop <= EDGE_GUARD_MAX_DROP + 1; drop++) {
                BlockPos probe = col.down(drop);
                BlockState state = client.world.getBlockState(probe);
                if (!state.getCollisionShape(client.world, probe).isEmpty() || !state.getFluidState().isEmpty()) {
                    floorFound = drop <= EDGE_GUARD_MAX_DROP;
                    break;
                }
            }
            if (!floorFound) {
                return true;
            }
        }
        return false;
    }

    private ControlDecision maybeResolveDirectCollectFallback(ClientPlayerEntity player, BrainLink.Intent effective) {
        if (!isCollectNavigationIntent(effective) || effective.targetX() == null || effective.targetZ() == null) {
            return null;
        }
        if (isGatherTreeCollectItemNavigation(effective)) {
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
        if (effective.targetY() != null
            && effective.targetY() < player.getY() - DIRECT_COLLECT_VERTICAL_DROP_MAX_DIRECT_Y_DELTA) {
            return null;
        }

        double targetY = effective.targetY() == null ? player.getY() : effective.targetY();
        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        if (!shouldUseDirectCollectFallback(horizontalDistance, effective.targetY(), player.getY())) {
            return null;
        }
        boolean upwardPickup = effective.targetY() != null && effective.targetY() > player.getY() + DIRECT_COLLECT_UPWARD_JUMP_Y_DELTA;
        boolean belowPickupHeight = targetY < player.getY() - DIRECT_COLLECT_VERTICAL_DROP_APPROACH_Y_DELTA;
        boolean forward = horizontalDistance > DIRECT_COLLECT_ARRIVE_DISTANCE
            || upwardPickup && horizontalDistance > DIRECT_COLLECT_VERTICAL_DROP_MIN_HORIZONTAL
            || belowPickupHeight && horizontalDistance > DIRECT_COLLECT_VERTICAL_DROP_MIN_HORIZONTAL;
        boolean jump = upwardPickup;
        double pitch = belowPickupHeight ? 20.0D : 0.0D;
        long nowMs = System.currentTimeMillis();
        if (forward && edgeGuardBlocksForward(MinecraftClient.getInstance(), player, yaw)) {
            // Cliff lip on the walk line: stand still (keep aiming) and let the command's own
            // timeout/abandon machinery give up on the item — never walk off after it.
            forward = false;
            jump = false;
            if (nowMs - lastEdgeGuardLogAtMs > 1_000L) {
                lastEdgeGuardLogAtMs = nowMs;
                LOGGER.warn(
                    "navigation.edge_guard_stop instanceId={} commandId={} targetX={} targetY={} targetZ={} yaw={}",
                    instanceId,
                    effective.commandId() == null ? "" : effective.commandId(),
                    roundForLog(effective.targetX()),
                    roundForLog(targetY),
                    roundForLog(effective.targetZ()),
                    roundForLog(yaw)
                );
            }
        }
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

    static boolean shouldUseDirectCollectFallback(double horizontalDistance, Double targetY, double playerY) {
        if (!Double.isFinite(horizontalDistance) || horizontalDistance > DIRECT_COLLECT_FALLBACK_DISTANCE) {
            return false;
        }
        if (targetY != null
            && targetY > playerY + 0.8D
            && horizontalDistance > DIRECT_COLLECT_UPWARD_FALLBACK_MAX_DISTANCE) {
            return false;
        }
        return true;
    }

    private static boolean isGatherTreeCollectItemNavigation(BrainLink.Intent effective) {
        if (effective == null) {
            return false;
        }
        String reason = effective.reason() == null ? "" : effective.reason();
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        return "gather_tree_collect_item".equals(reason) || commandId.contains(":tree:collect:item");
    }

    @Override
    public ControlDecision maybeResolveDroppedLogDirectCollect(
        BrainLink.Intent effective,
        ClientPlayerEntity player,
        Vec3d droppedLogPosition,
        String reason
    ) {
        return maybeResolveDroppedLogDirectCollect(
            effective,
            player,
            droppedLogPosition,
            reason,
            GATHER_LOG_DIRECT_COLLECT_DISTANCE,
            GATHER_LOG_DIRECT_COLLECT_MAX_Y_DELTA,
            DIRECT_COLLECT_ARRIVE_DISTANCE
        );
    }

    private ControlDecision maybeResolveDroppedLogDirectCollect(
        BrainLink.Intent effective,
        ClientPlayerEntity player,
        Vec3d droppedLogPosition,
        String reason,
        double maxHorizontalDistance,
        double maxVerticalDistance,
        double arriveDistance
    ) {
        if (droppedLogPosition == null) {
            return null;
        }
        double dx = droppedLogPosition.x - player.getX();
        double dz = droppedLogPosition.z - player.getZ();
        double horizontalDistance = Math.hypot(dx, dz);
        double verticalDistance = Math.abs(droppedLogPosition.y - player.getY());
        if (horizontalDistance > maxHorizontalDistance
            || verticalDistance > maxVerticalDistance) {
            return null;
        }

        boolean belowPickupHeight = droppedLogPosition.y < player.getY() - DIRECT_COLLECT_VERTICAL_DROP_APPROACH_Y_DELTA;
        LookAngles collectLook = directCollectApproachLook(player, droppedLogPosition, belowPickupHeight);
        boolean forward = horizontalDistance > arriveDistance
            || belowPickupHeight && horizontalDistance > DIRECT_COLLECT_VERTICAL_DROP_MIN_HORIZONTAL;
        boolean jump = player.isOnGround() && droppedLogPosition.y > player.getY() + 0.5D;
        long nowMs = System.currentTimeMillis();
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        String logKey = "dropped-log:" + commandId + ":" + reason + ":" + roundForLog(droppedLogPosition.x)
            + ":" + roundForLog(droppedLogPosition.y) + ":" + roundForLog(droppedLogPosition.z);
        if (!logKey.equals(lastDirectCollectFallbackLogKey) || nowMs - lastDirectCollectFallbackLogAtMs > 1_000L) {
            LOGGER.info(
                "dropped_log.direct_collect instanceId={} commandId={} reason={} itemX={} itemY={} itemZ={} distance={} yDelta={} forward={} jump={}",
                instanceId,
                commandId,
                reason,
                roundForLog(droppedLogPosition.x),
                roundForLog(droppedLogPosition.y),
                roundForLog(droppedLogPosition.z),
                roundForLog(horizontalDistance),
                roundForLog(verticalDistance),
                forward,
                jump
            );
            lastDirectCollectFallbackLogKey = logKey;
            lastDirectCollectFallbackLogAtMs = nowMs;
        }

        BrainLink.Intent collectDirect = lookIntentForAngles(effective, collectLook.yaw(), collectLook.pitch(), reason);
        InputState collectInput = new InputState(forward, false, false, false, jump, false, forward ? 1.0F : 0.0F, 0.0F);
        return new ControlDecision(collectDirect, collectInput);
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
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        if (activeNavigationWaypoints != null && !activeNavigationWaypoints.isEmpty()) {
            if (activeNavigationSuppliedRoute
                && shouldRefreshSuppliedRouteFromCurrentStart(start, activeNavigationWaypoints, effective)) {
                LOGGER.info(
                    "navigation.supplied_route_stale instanceId={} commandId={} reason={} start={} routeLength={} waypoints={}",
                    instanceId,
                    activeNavigationCommandId,
                    effective.reason(),
                    start,
                    activeNavigationWaypoints.size(),
                    activeNavigationWaypoints
                );
                activeNavigationWaypoints = List.of();
                activeNavigationRouteComputed = false;
                activeNavigationSuppliedRoute = false;
                activeNavigationJumpWaypointIndexes = Set.of();
                activeNavigationWaypointIndex = 0;
                activeNavigationProgress = PathFollower.Progress.initial();
            } else {
                return activeNavigationWaypoints;
            }
        }
        if (activeNavigationRouteComputed) {
            return activeNavigationWaypoints;
        }
        if (effective.waypoints() != null && !effective.waypoints().isEmpty()) {
            List<GridCell> suppliedRoute = List.copyOf(effective.waypoints());
            if (shouldRefreshSuppliedRouteFromCurrentStart(start, suppliedRoute, effective)) {
                LOGGER.info(
                    "navigation.supplied_route_ignored instanceId={} commandId={} reason={} start={} routeLength={} waypoints={}",
                    instanceId,
                    activeNavigationCommandId,
                    effective.reason(),
                    start,
                    suppliedRoute.size(),
                    suppliedRoute
                );
            } else {
                activeNavigationWaypoints = suppliedRoute;
                activeNavigationRouteComputed = true;
                activeNavigationSuppliedRoute = true;
                activeNavigationJumpWaypointIndexes = jumpWaypointIndexesForSuppliedRoute(client, player, activeNavigationWaypoints, effective);
                LOGGER.info(
                    "navigation.supplied_route instanceId={} commandId={} reason={} routeLength={} jumpWaypoints={} waypoints={}",
                    instanceId,
                    activeNavigationCommandId,
                    effective.reason(),
                    activeNavigationWaypoints.size(),
                    activeNavigationJumpWaypointIndexes,
                    activeNavigationWaypoints
                );
                return activeNavigationWaypoints;
            }
        }
        if (effective.targetX() == null || effective.targetZ() == null) {
            activeNavigationWaypoints = List.of();
            activeNavigationRouteComputed = true;
            activeNavigationSuppliedRoute = false;
            return activeNavigationWaypoints;
        }
        GridCell goal = new GridCell((int) Math.floor(effective.targetX()), (int) Math.floor(effective.targetZ()));
        if (effective.blockedCells() != null && !effective.blockedCells().isEmpty()) {
            Set<GridCell> blocked = new HashSet<>(effective.blockedCells());
            GridPerception perception = vetoAware(new StaticGridPerception(blocked, start, goal), System.currentTimeMillis());
            activeNavigationWaypoints = GridAStar.route(perception, start, goal);
            activeNavigationJumpWaypointIndexes = jumpWaypointIndexes(activeNavigationWaypoints, perception);
            activeNavigationRouteComputed = true;
            activeNavigationSuppliedRoute = false;
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

        int referenceFeetY = (int) Math.floor(player.getY());
        WorldGridPerception perception = new WorldGridPerception(client.world, referenceFeetY, start, goal, NAVIGATION_PERCEPTION_MARGIN);
        GridPerception routePerception = maybeAnchorCurrentStart(
            client.world,
            perception,
            start,
            referenceFeetY,
            isGatherAdjacentNavigation(effective)
        );
        routePerception = vetoAware(routePerception, System.currentTimeMillis());
        if (routePerception != perception) {
            LOGGER.info(
                "navigation.start_anchored instanceId={} commandId={} reason=navigate_to_point start={} goal={} referenceFeetY={} perceivedSurface={} anchoredSurface={}",
                instanceId,
                activeNavigationCommandId,
                start,
                goal,
                referenceFeetY,
                formatSurface(perception, start),
                referenceFeetY
            );
        }
        if (isCollectNavigationIntent(effective)) {
            CollectNavigationTargetPlanner.TargetPlan collectPlan =
                CollectNavigationTargetPlanner.chooseTarget(routePerception, start, goal, effective.targetY());
            if (collectPlan.cell() != null) {
                activeNavigationWaypoints = collectPlan.route();
                activeNavigationJumpWaypointIndexes = jumpWaypointIndexes(activeNavigationWaypoints, routePerception);
                activeNavigationRouteComputed = true;
                activeNavigationSuppliedRoute = false;
                LOGGER.info(
                    "navigation.collect_route instanceId={} commandId={} start={} requestedGoal={} selectedGoal={} reason={} referenceFeetY={} surfaces={} routeLength={} jumpWaypoints={} waypoints={}",
                    instanceId,
                    activeNavigationCommandId,
                    start,
                    goal,
                    collectPlan.cell(),
                    collectPlan.reason(),
                    referenceFeetY,
                    perception.surfaceSummary(start, goal, collectPlan.cell()),
                    activeNavigationWaypoints.size(),
                    activeNavigationJumpWaypointIndexes,
                    activeNavigationWaypoints
                );
                return activeNavigationWaypoints;
            }
        }
        GridRouteDiagnostic diagnostic = GridAStar.diagnose(routePerception, start, goal);
        activeNavigationWaypoints = diagnostic.route();
        activeNavigationJumpWaypointIndexes = jumpWaypointIndexes(activeNavigationWaypoints, routePerception);
        activeNavigationRouteComputed = true;
        activeNavigationSuppliedRoute = false;
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
            // Record the default-scan A* no_path BEFORE the scan-window fallback may rescue the nav: the
            // failed default perception is itself a replayable path-finding artifact worth studying.
            maybeRecordNavFailure(start, goal, referenceFeetY, perception, diagnostic);
            if (tryScanWindowFallback(client, start, goal, referenceFeetY, perception, diagnostic)) {
                return activeNavigationWaypoints;
            }
            logNoPathDiagnostic(client, start, goal, referenceFeetY, perception, diagnostic);
        }
        return activeNavigationWaypoints;
    }

    private boolean shouldRefreshSuppliedRouteFromCurrentStart(
        GridCell start,
        List<GridCell> waypoints,
        BrainLink.Intent effective
    ) {
        if (start == null || waypoints == null || waypoints.isEmpty() || effective == null) {
            return false;
        }
        if (!isGatherAdjacentNavigation(effective) && !isCollectNavigationIntent(effective)) {
            return false;
        }
        for (GridCell waypoint : waypoints) {
            if (start.equals(waypoint)) {
                return false;
            }
        }
        return true;
    }

    private Set<Integer> jumpWaypointIndexesForSuppliedRoute(
        MinecraftClient client,
        ClientPlayerEntity player,
        List<GridCell> waypoints,
        BrainLink.Intent effective
    ) {
        if (client == null || client.world == null || player == null || waypoints == null || waypoints.isEmpty()) {
            return Set.of();
        }
        GridCell start = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        int referenceFeetY = (int) Math.floor(player.getY());
        int minX = start.x();
        int maxX = start.x();
        int minZ = start.z();
        int maxZ = start.z();
        for (GridCell waypoint : waypoints) {
            minX = Math.min(minX, waypoint.x());
            maxX = Math.max(maxX, waypoint.x());
            minZ = Math.min(minZ, waypoint.z());
            maxZ = Math.max(maxZ, waypoint.z());
        }
        WorldGridPerception perception = new WorldGridPerception(
            client.world,
            referenceFeetY,
            minX - 2,
            maxX + 2,
            minZ - 2,
            maxZ + 2
        );
        GridPerception routePerception = maybeAnchorCurrentStart(
            client.world,
            perception,
            start,
            referenceFeetY,
            isGatherAdjacentNavigation(effective)
        );
        Set<Integer> indexes = new HashSet<>(jumpWaypointIndexes(waypoints, routePerception));
        GridCell first = waypoints.get(0);
        if ("gather_tree_nav_adjacent".equals(effective.reason()) && isShortStraightSuppliedRoute(start, waypoints)) {
            for (int i = 0; i < waypoints.size(); i++) {
                indexes.add(i);
            }
        }
        if (!start.equals(first)) {
            var startSurface = routePerception.surfaceY(start.x(), start.z());
            var firstSurface = routePerception.surfaceY(first.x(), first.z());
            if (startSurface.isPresent() && firstSurface.isPresent()
                && firstSurface.getAsInt() - startSurface.getAsInt() == 1) {
                indexes.add(0);
            }
        }
        return Set.copyOf(indexes);
    }

    private static boolean isShortStraightSuppliedRoute(GridCell start, List<GridCell> waypoints) {
        if (start == null || waypoints == null || waypoints.isEmpty() || waypoints.size() > 6) {
            return false;
        }
        GridCell last = waypoints.get(waypoints.size() - 1);
        boolean sameX = start.x() == last.x();
        boolean sameZ = start.z() == last.z();
        if (!sameX && !sameZ) {
            return false;
        }
        GridCell previous = start;
        for (GridCell waypoint : waypoints) {
            if (waypoint == null) {
                return false;
            }
            int dx = Math.abs(waypoint.x() - previous.x());
            int dz = Math.abs(waypoint.z() - previous.z());
            if (dx + dz == 0) {
                previous = waypoint;
                continue;
            }
            if (dx + dz != 1 || sameX && waypoint.x() != start.x() || sameZ && waypoint.z() != start.z()) {
                return false;
            }
            previous = waypoint;
        }
        return true;
    }

    // Dev-only (MCBOT_FABRIC_NAV_RECORD=1): capture a failed WorldGridPerception route as a replayable
    // NavReplayRecording so the EXACT no_path can be reproduced + debugged offline (Phase 1 of the
    // pathing-hardening plan). Fail-safe + gated off by default; never affects a normal run.
    private final java.util.Set<String> recordedNavFailureSignatures = new java.util.HashSet<>();

    private void maybeRecordNavFailure(
        GridCell start,
        GridCell goal,
        int referenceFeetY,
        WorldGridPerception perception,
        GridRouteDiagnostic diagnostic
    ) {
        if (!"1".equals(System.getenv("MCBOT_FABRIC_NAV_RECORD"))) {
            return;
        }
        // Dedupe: a stuck command re-attempts the same route every tick. Capture each distinct failure once.
        String signature = start + ">" + goal + "@" + perception.minX() + "," + perception.maxX()
            + "," + perception.minZ() + "," + perception.maxZ();
        if (!recordedNavFailureSignatures.add(signature)) {
            return;
        }
        try {
            NavReplayRecording recording =
                NavReplayRecording.capture(perception, referenceFeetY, start, goal, diagnostic);
            Path file = FabricLoader.getInstance().getConfigDir()
                .resolve("mcbot-nav-recordings")
                .resolve("nav-fail-" + instanceId + "-" + System.currentTimeMillis() + ".json");
            recording.save(file);
            LOGGER.info("navigation.recorded instanceId={} file={} {}", instanceId, file, recording.summary());
        } catch (Throwable t) {
            LOGGER.warn("navigation.record_failed instanceId={} reason={}", instanceId, String.valueOf(t));
        }
    }

    private static final int FOLLOWER_STALL_TICKS = 16;
    private static final int FOLLOWER_TRAIL_MAX = 24;
    private static final int FOLLOWER_STALL_PERCEPTION_MARGIN = 6;
    private final java.util.Deque<FollowerStallRecording.PoseSample> followerPoseTrail = new java.util.ArrayDeque<>();
    private final java.util.Set<String> recordedFollowerStallSignatures = new java.util.HashSet<>();
    private GridCell followerTrackedGoal = null;
    private double followerBestGoalDistance = Double.POSITIVE_INFINITY;
    private int followerNoProgressTicks = 0;
    private static final long COLLECT_STALL_MS = 6000L;
    // A drop within this horizontal radius and vertical rise is collected by walking DIRECTLY at it (closing
    // the sub-cell gap the 2-D cell nav leaves), instead of routing to a cell whose surfaceY may be an
    // overhang above the item.
    private static final double COLLECT_DIRECT_APPROACH_RADIUS = 2.0D;
    private static final double COLLECT_DIRECT_APPROACH_MAX_RISE = 3.0D;
    private final java.util.Set<String> recordedCollectStallSignatures = new java.util.HashSet<>();
    private final java.util.Set<String> recordedNav3DCollectSignatures = new java.util.HashSet<>();
    private final boolean nav3dCollectEnabled = "1".equals(System.getenv("MCBOT_FABRIC_NAV3D_COLLECT"));
    private long lastNav3dCollectLogMs = 0L;
    private java.util.List<VoxelCell> nav3dCollectRoute = java.util.List.of();
    private Vec3d nav3dCollectRouteDrop = null;
    private long nav3dCollectRouteComputedMs = 0L;
    // The 3-D collect route projected to x/z, for the world-space path overlay (the 2-D activeNavigationWaypoints
    // is empty during a 3-D collect, which is why the overlay had nothing to draw). Volatile: render thread reads.
    private volatile java.util.List<GridCell> nav3dOverlayWaypoints = java.util.List.of();
    private Vec3d nav3dLastProgressPos = null;
    private long nav3dLastProgressMs = 0L;
    private long nav3dTunnelDigLogMs = 0L;
    private BlockPos nav3dLastTunnelDigTarget = null;
    private boolean nav3dLastTunnelBreakLogged = false;

    // Dev-only (MCBOT_FABRIC_NAV_RECORD=1): when the path follower stalls (route found but the bot stops
    // advancing -- the "stuck jumping" failure), capture the replayable follow() decision + a recent-pose
    // trail + the local world so it can be reproduced + diagnosed offline (Phase 1.5). Fail-safe; deduped.
    private void maybeRecordFollowerStall(
        ClientPlayerEntity player,
        List<GridCell> waypoints,
        int inIndex,
        PathFollower.Progress inProgress,
        PathFollower.Command command,
        boolean stepAssistJump,
        double arriveEpsilon
    ) {
        if (!"1".equals(System.getenv("MCBOT_FABRIC_NAV_RECORD")) || player == null || command == null) {
            return;
        }
        int feetY = (int) Math.floor(player.getY());
        followerPoseTrail.addLast(new FollowerStallRecording.PoseSample(
            player.getX(), player.getZ(), feetY, player.getYaw(),
            command.waypointIndex(), command.progress().stagnantTicks(),
            command.intent().jump() || stepAssistJump));
        while (followerPoseTrail.size() > FOLLOWER_TRAIL_MAX) {
            followerPoseTrail.removeFirst();
        }
        GridCell goalCell = (waypoints == null || waypoints.isEmpty()) ? null : waypoints.get(waypoints.size() - 1);
        if (command.finished() || goalCell == null) {
            followerTrackedGoal = null;
            followerBestGoalDistance = Double.POSITIVE_INFINITY;
            followerNoProgressTicks = 0;
            return;
        }
        // Command-independent goal-progress tracking: the "stuck jumping" loop re-plans every tick (so the
        // follower's own stagnant counter resets) and oscillates between adjacent cells, so detect the stall
        // as "no net approach to the goal for FOLLOWER_STALL_TICKS ticks".
        double goalDistance = Math.hypot(
            PathFollower.center(goalCell.x()) - player.getX(),
            PathFollower.center(goalCell.z()) - player.getZ());
        if (!goalCell.equals(followerTrackedGoal)) {
            followerTrackedGoal = goalCell;
            followerBestGoalDistance = goalDistance;
            followerNoProgressTicks = 0;
        } else if (goalDistance < followerBestGoalDistance - 0.1D) {
            followerBestGoalDistance = goalDistance;
            followerNoProgressTicks = 0;
        } else {
            followerNoProgressTicks++;
        }
        boolean stagnant = command.progress().stagnantTicks() >= FOLLOWER_STALL_TICKS;
        boolean noProgress = followerNoProgressTicks >= FOLLOWER_STALL_TICKS;
        if (!stagnant && !noProgress) {
            return;
        }
        String stallReason = noProgress ? "follower_no_goal_progress" : "follower_stagnant";
        int targetIndex = Math.max(0, Math.min(command.waypointIndex(), waypoints.size() - 1));
        GridCell botCell = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        GridCell targetCell = waypoints.get(targetIndex);
        String signature = botCell + ">" + targetCell + "@" + feetY;
        if (!recordedFollowerStallSignatures.add(signature)) {
            return;
        }
        try {
            FollowerStallRecording recording = buildFollowerStallRecording(
                player, waypoints, inIndex, inProgress, command, stepAssistJump, arriveEpsilon, botCell, targetCell, feetY, stallReason);
            if (recording == null) {
                return;
            }
            Path file = FabricLoader.getInstance().getConfigDir()
                .resolve("mcbot-nav-recordings")
                .resolve("follower-stall-" + instanceId + "-" + System.currentTimeMillis() + ".json");
            recording.save(file);
            LOGGER.info("navigation.follower_stall_recorded instanceId={} file={} {}", instanceId, file, recording.summary());
        } catch (Throwable t) {
            LOGGER.warn("navigation.follower_stall_record_failed instanceId={} reason={}", instanceId, String.valueOf(t));
        }
    }

    private FollowerStallRecording buildFollowerStallRecording(
        ClientPlayerEntity player,
        List<GridCell> waypoints,
        int inIndex,
        PathFollower.Progress inProgress,
        PathFollower.Command command,
        boolean stepAssistJump,
        double arriveEpsilon,
        GridCell botCell,
        GridCell targetCell,
        int feetY,
        String stallReason
    ) {
        MinecraftClient mc = MinecraftClient.getInstance();
        if (mc == null || mc.world == null) {
            return null;
        }
        PathFollower.Progress progress = inProgress == null ? PathFollower.Progress.initial() : inProgress;
        FollowerStallRecording recording = new FollowerStallRecording();
        recording.commandId = activeNavigationCommandId == null ? "" : activeNavigationCommandId;
        recording.reason = stallReason;
        for (GridCell cell : waypoints) {
            recording.waypoints.add(FollowerStallRecording.cellKey(cell));
        }
        recording.arriveEpsilon = arriveEpsilon;
        recording.maxTurnDegPerTick = LOOK_MAX_DEG_PER_TICK;
        recording.inWaypointIndex = inIndex;
        recording.progressWaypointIndex = progress.waypointIndex();
        recording.progressClosestDistance = Double.isFinite(progress.closestDistance()) ? progress.closestDistance() : null;
        recording.progressLastX = Double.isFinite(progress.lastX()) ? progress.lastX() : null;
        recording.progressLastZ = Double.isFinite(progress.lastZ()) ? progress.lastZ() : null;
        recording.progressStagnantTicks = progress.stagnantTicks();
        recording.x = player.getX();
        recording.z = player.getZ();
        recording.yaw = player.getYaw();
        recording.feetY = feetY;
        recording.outWaypointIndex = command.waypointIndex();
        recording.outFinished = command.finished();
        recording.outReason = command.intent().reason();
        recording.stepAssistJump = stepAssistJump;
        recording.trail = new java.util.ArrayList<>(followerPoseTrail);
        WorldGridPerception perception = new WorldGridPerception(
            mc.world, feetY, botCell, targetCell, FOLLOWER_STALL_PERCEPTION_MARGIN);
        GridRouteDiagnostic diagnostic = GridAStar.diagnose(perception, botCell, targetCell);
        recording.perception = NavReplayRecording.capture(perception, feetY, botCell, targetCell, diagnostic);
        return recording;
    }

    // Dev-only (MCBOT_FABRIC_NAV_RECORD=1): when the collect-item pickup loops without acquiring the drop
    // (classically a drop that fell BELOW the bot into dug terrain), capture the drop + bot 3-D positions
    // and the route to the drop's cell, so the vertical mismatch the 2-D collect ignores is reproducible
    // offline (Phase 1.6). Deduped, fail-safe; never affects a normal run.
    private void maybeRecordCollectStall(
        MinecraftClient client,
        ClientPlayerEntity player,
        MineNearbyIronRun run,
        OreKind oreKind,
        Vec3d drop,
        String commandId,
        long nowMs
    ) {
        if (!"1".equals(System.getenv("MCBOT_FABRIC_NAV_RECORD"))
            || client == null || client.world == null || player == null || drop == null || run == null) {
            return;
        }
        if (run.collectStartedAtMs <= 0L || nowMs - run.collectStartedAtMs < COLLECT_STALL_MS) {
            return;
        }
        int feetY = (int) Math.floor(player.getY());
        GridCell botCell = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        GridCell dropCell = new GridCell((int) Math.floor(drop.x), (int) Math.floor(drop.z));
        String signature = botCell + ">" + dropCell + "@" + feetY;
        if (!recordedCollectStallSignatures.add(signature)) {
            return;
        }
        try {
            WorldGridPerception perception = new WorldGridPerception(
                client.world, feetY, botCell, dropCell, FOLLOWER_STALL_PERCEPTION_MARGIN);
            GridRouteDiagnostic diagnostic = GridAStar.diagnose(perception, botCell, dropCell);
            CollectStallRecording recording = new CollectStallRecording();
            recording.commandId = commandId == null ? "" : commandId;
            recording.dropItemId = oreKind.dropItemId;
            recording.dropX = drop.x;
            recording.dropY = drop.y;
            recording.dropZ = drop.z;
            recording.botX = player.getX();
            recording.botY = player.getY();
            recording.botZ = player.getZ();
            recording.botYaw = player.getYaw();
            recording.botFeetY = feetY;
            recording.collectElapsedMs = nowMs - run.collectStartedAtMs;
            recording.route = NavReplayRecording.capture(perception, feetY, botCell, dropCell, diagnostic);
            Path file = FabricLoader.getInstance().getConfigDir()
                .resolve("mcbot-nav-recordings")
                .resolve("collect-stall-" + instanceId + "-" + System.currentTimeMillis() + ".json");
            recording.save(file);
            LOGGER.info("navigation.collect_stall_recorded instanceId={} file={} {}", instanceId, file, recording.summary());
        } catch (Throwable t) {
            LOGGER.warn("navigation.collect_stall_record_failed instanceId={} reason={}", instanceId, String.valueOf(t));
        }
    }

    // Dev-only (MCBOT_FABRIC_NAV3D_RECORD=1): capture the 3-D voxel collect problem beside the live
    // collect site. Record-only: it computes/saves the 3-D planner result but never changes live behavior.
    private void maybeRecordNav3DCollect(
        MinecraftClient client,
        ClientPlayerEntity player,
        OreKind oreKind,
        Vec3d drop,
        String commandId
    ) {
        if (!"1".equals(System.getenv("MCBOT_FABRIC_NAV3D_RECORD"))
            || client == null || client.world == null || player == null || drop == null || oreKind == null) {
            return;
        }
        int feetY = (int) Math.floor(player.getY());
        VoxelCell start = new VoxelCell((int) Math.floor(player.getX()), feetY, (int) Math.floor(player.getZ()));
        VoxelCell dropCell = new VoxelCell((int) Math.floor(drop.x), (int) Math.floor(drop.y), (int) Math.floor(drop.z));
        String signature = start + ">" + dropCell + ":" + oreKind.dropItemId;
        if (!recordedNav3DCollectSignatures.add(signature)) {
            return;
        }
        try {
            WorldVoxelPerception perception = new WorldVoxelPerception(
                client.world,
                start,
                dropCell,
                FOLLOWER_STALL_PERCEPTION_MARGIN,
                FOLLOWER_STALL_PERCEPTION_MARGIN
            );
            CollectTarget3DPlanner.TargetPlan plan =
                CollectTarget3DPlanner.chooseTarget(perception, start, drop.x, drop.y, drop.z);
            Nav3DRecording recording = Nav3DRecording.captureCollect(perception, start, drop.x, drop.y, drop.z, plan);
            Path file = FabricLoader.getInstance().getConfigDir()
                .resolve("mcbot-nav3d-recordings")
                .resolve("nav3d-collect-" + instanceId + "-" + System.currentTimeMillis() + ".json");
            recording.save(file);
            LOGGER.info(
                "navigation.nav3d_collect_recorded instanceId={} commandId={} dropItem={} file={} planCell={} planRouteLength={} planReason={} {}",
                instanceId,
                commandId == null ? "" : commandId,
                oreKind.dropItemId,
                file,
                plan.cell(),
                plan.route().size(),
                plan.reason(),
                recording.summary()
            );
        } catch (Throwable t) {
            LOGGER.warn("navigation.nav3d_collect_record_failed instanceId={} reason={}", instanceId, String.valueOf(t));
        }
    }

    // Dev-only (MCBOT_FABRIC_NAV3D_COLLECT=1): drive the bot toward a 3-D target point via the proven 3-D
    // traversal nav, MINING THROUGH walls when wedged. Used for the collect (target = the dropped item) and the
    // return climb (target = the surface). Returns a control decision that follows the 3-D route + digs when
    // blocked, or null to fall back to the caller's existing path. Fail-safe: any miss / throw / empty route
    // defers, so with the flag off (default) live behavior is byte-for-byte unchanged.
    private ControlDecision tryNav3dDriveToward(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        Vec3d drop,
        String reasonPrefix,
        String commandId,
        long nowMs
    ) {
        return tryNav3dDriveToward(client, player, effective, drop, reasonPrefix, commandId, nowMs, false);
    }

    private ControlDecision tryNav3dDriveToward(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        Vec3d drop,
        String reasonPrefix,
        String commandId,
        long nowMs,
        boolean exactTargetCell
    ) {
        if (client == null || client.world == null || player == null || drop == null || reasonPrefix == null) {
            return null;
        }
        try {
            // Persist the route across ticks. Per-tick replanning is fragile mid-collect: the bot stands on
            // uneven dug terrain, so isStandable(start) and the reachable set flicker, which made an earlier
            // version drive ONE tick then fall back to the (stuck) 2-D path. Compute once, then FOLLOW that
            // route; only recompute when the drop moves, the bot strays off the route, or it goes stale -- and
            // if a refresh fails mid-descent, keep following the cached route rather than reverting to 2-D.
            List<VoxelCell> route = nav3dCollectRoute;
            boolean nearOldRoute = !route.isEmpty()
                && nav3dCollectRouteDrop != null
                && drop.squaredDistanceTo(nav3dCollectRouteDrop) <= 2.25D
                && nav3dBotNearRoute(player, route);
            boolean stale = nowMs - nav3dCollectRouteComputedMs >= 1500L;
            if (!nearOldRoute || stale) {
                int feetY = (int) Math.floor(player.getY());
                VoxelCell start = new VoxelCell((int) Math.floor(player.getX()), feetY, (int) Math.floor(player.getZ()));
                VoxelCell dropCell = new VoxelCell((int) Math.floor(drop.x), (int) Math.floor(drop.y), (int) Math.floor(drop.z));
                WorldVoxelPerception perception = new WorldVoxelPerception(
                    client.world, start, dropCell, FOLLOWER_STALL_PERCEPTION_MARGIN, FOLLOWER_STALL_PERCEPTION_MARGIN);
                CollectTarget3DPlanner.TargetPlan plan = null;
                if (perception.isStandable(start.x(), start.y(), start.z())) {
                    if (exactTargetCell) {
                        Nav3DRouteDiagnostic diagnostic = VoxelAStar.diagnose(perception, start, dropCell);
                        if (diagnostic.routeFound()) {
                            plan = new CollectTarget3DPlanner.TargetPlan(dropCell, diagnostic.route(), "exact_target_cell");
                        }
                    } else {
                        plan = CollectTarget3DPlanner.chooseTarget(perception, start, drop.x, drop.y, drop.z);
                    }
                }
                if (plan != null && plan.cell() != null && !plan.route().isEmpty()) {
                    route = plan.route();
                    nav3dCollectRoute = route;
                    nav3dCollectRouteDrop = drop;
                    nav3dCollectRouteComputedMs = nowMs;
                } else if (nearOldRoute) {
                    nav3dCollectRouteComputedMs = nowMs; // refresh failed but the cached route is still usable
                } else {
                    nav3dCollectRoute = List.of();
                    nav3dCollectRouteDrop = null;
                    // No traversal route to the target (it is WALLED OFF) -> MINE A TUNNEL straight toward it.
                    // This is the real "mine through to reach it": the diamond-behind-a-wall case where the
                    // traversal planner finds nothing, so the bot would otherwise just abandon the target.
                    return nav3dDigTunnelToward(client, player, effective, drop, reasonPrefix, commandId, nowMs);
                }
            }
            java.util.List<GridCell> overlay = new java.util.ArrayList<>(route.size());
            for (VoxelCell cell : route) {
                overlay.add(new GridCell(cell.x(), cell.z()));
            }
            nav3dOverlayWaypoints = List.copyOf(overlay);
            VoxelCell target = nav3dNextWaypoint(route, player);
            boolean pickupCell = target.equals(route.getLast());
            Vec3d aim = pickupCell ? drop : new Vec3d(target.x() + 0.5D, target.y(), target.z() + 0.5D);
            LookAngles look = lookAnglesToPoint(player, aim);
            // Turn-then-move: only drive forward once roughly facing the aim. Pressing forward every tick while
            // still rotating (the look is rate-limited at LOOK_MAX_DEG_PER_TICK) walked the bot the WRONG way into
            // the slot walls -- the live look/forward bug the kinematic sim could not see. Rotate first, move once
            // aligned. Jump when facing + grounded + wanting up: do NOT gate on horizontalCollision -- the trace
            // showed it stays FALSE when the bot is exactly flush against the step (vel=0, no move registers), so a
            // horizontalCollision-gated jump never fired and the bot wedged in place while facing the right way.
            double yawError = wrapDegrees180(look.yaw() - player.getYaw());
            boolean facingAim = Math.abs(yawError) <= NAV3D_FORWARD_YAW_TOLERANCE_DEG;
            boolean wantUp = pickupCell ? drop.y > player.getY() + 0.5D : target.y() > Math.floor(player.getY());
            boolean jump = facingAim && wantUp && player.isOnGround();
            InputState input = new InputState(facingAim, false, false, false, jump, false, facingAim ? 1.0F : 0.0F, 0.0F);
            if (nowMs - lastNav3dCollectLogMs > 500L) {
                lastNav3dCollectLogMs = nowMs;
                Vec3d vel = player.getVelocity();
                LOGGER.info(
                    "navigation.nav3d_collect_drive instanceId={} routeLen={} target={} pickupCell={} exactTarget={} reused={} bot=({},{},{}) aim=({},{}) yaw={} yawErr={} facing={} jump={} onGround={} hColl={} vel=({},{})",
                    instanceId,
                    route.size(),
                    target,
                    pickupCell,
                    exactTargetCell,
                    nearOldRoute,
                    roundForLog(player.getX()),
                    roundForLog(player.getY()),
                    roundForLog(player.getZ()),
                    roundForLog(aim.x),
                    roundForLog(aim.z),
                    roundForLog(player.getYaw()),
                    roundForLog(yawError),
                    facingAim,
                    jump,
                    player.isOnGround(),
                    player.horizontalCollision,
                    roundForLog(vel.x),
                    roundForLog(vel.z)
                );
            }
            // Stuck -> MINE THROUGH (reach the drop, don't abandon it). Track REAL progress (the bot moving). If
            // it stops moving for a while while collecting, the route is physically blocked -- mine the blocking
            // block toward the aim so the 3-D nav re-routes through the gap, tunneling TOWARD the drop. Reaching
            // the drop is the goal (a single diamond drop can't be abandoned); abandon is only the far-off last
            // resort (NAV3D_COLLECT_DROP_TIMEOUT_MS), for a drop that is genuinely unreachable even by digging.
            Vec3d pos = player.getPos();
            if (nav3dLastProgressPos == null || pos.squaredDistanceTo(nav3dLastProgressPos) > 0.16D) {
                nav3dLastProgressPos = pos;
                nav3dLastProgressMs = nowMs;
            }
            if (nowMs - nav3dLastProgressMs >= NAV3D_DIG_AFTER_STUCK_MS) {
                BlockPos obstacle = nav3dBlockingObstacle(client, player, aim);
                if (obstacle != null) {
                    BlockBreakController.Result dig = blockBreakController.tick(client, player, obstacle, commandId, nowMs);
                    if (dig.status() == BlockBreakController.Status.BROKEN) {
                        LOGGER.info("navigation.nav3d_collect_dig_broke instanceId={} obstacle={}", instanceId, obstacle.toShortString());
                        nav3dLastProgressPos = null; // the break IS progress; re-plan through the opened gap
                        nav3dLastProgressMs = nowMs;
                        nav3dCollectRoute = List.of();
                        nav3dCollectRouteDrop = null;
                    } else if (dig.status() == BlockBreakController.Status.FAILED) {
                        nav3dLastProgressMs = nowMs; // can't break this one; back off, the outer timeout abandons
                    } else {
                        return new ControlDecision(
                            lookIntentForBlock(effective, player, obstacle, reasonPrefix + "_dig"),
                            InputState.stop());
                    }
                } else {
                    nav3dLastProgressMs = nowMs; // nothing solid in front to dig; let the normal drive keep trying
                }
            }
            return new ControlDecision(
                lookIntentForAngles(effective, look.yaw(), look.pitch(), reasonPrefix + "_nav3d"),
                input
            );
        } catch (Throwable t) {
            LOGGER.warn("navigation.nav3d_collect_control_failed instanceId={} reason={}", instanceId, String.valueOf(t));
            return null;
        }
    }

    /** No traversal route to the target -> MINE A TUNNEL straight toward it (the walled-off / diamond case): look
     * at the target, break the block directly ahead if solid, REFUSE to mine into a hazard, otherwise step toward
     * it. Returns null only when a hazard blocks the tunnel or a break fails, so the caller's outer timeout can
     * abandon a genuinely impossible target rather than dig forever. */
    private ControlDecision nav3dDigTunnelToward(
            MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective,
            Vec3d target, String reasonPrefix, String commandId, long nowMs) {
        nav3dOverlayWaypoints = List.of();
        LookAngles look = lookAnglesToPoint(player, target);
        boolean facingTarget = Math.abs(wrapDegrees180(look.yaw() - player.getYaw())) <= NAV3D_FORWARD_YAW_TOLERANCE_DEG;
        int feetY = (int) Math.floor(player.getY());
        int cx = (int) Math.floor(player.getX());
        int cz = (int) Math.floor(player.getZ());
        boolean preserveReturnTargetSupport = reasonPrefix != null && reasonPrefix.startsWith("return_staircase_breadcrumb");
        BlockPos returnTargetSupport = null;
        if (preserveReturnTargetSupport) {
            returnTargetSupport = new BlockPos(
                (int) Math.floor(target.x),
                (int) Math.floor(target.y) - 1,
                (int) Math.floor(target.z)
            );
        }
        double dirX = target.x - player.getX();
        double dirZ = target.z - player.getZ();
        int stepX = 0;
        int stepZ = 0;
        if (Math.abs(dirX) >= Math.abs(dirZ)) {
            stepX = dirX >= 0 ? 1 : -1;
        } else {
            stepZ = dirZ >= 0 ? 1 : -1;
        }
        maybeLogNav3dTunnelCleared(client, target, nowMs);
        BlockPos toDig = null;
        int[] dyOrder;
        double dirY = target.y - player.getY();
        if (dirY > 1.25D) {
            dyOrder = new int[] { 3, 2 };
        } else if (dirY > 0.25D) {
            dyOrder = new int[] { 2, 1 };
        } else {
            // Dig the HEAD block (dy=1) BEFORE the feet block (dy=0): the bot's eye (~y+1.6) looks slightly DOWN at the
            // feet block, so the head block OCCLUDES it -- the raycast hits the head, BlockBreakController returns
            // REPOSITION, the dig wedges and never breaks (tunnel_broke=0). The head block sits at eye level with a
            // clear line, so break it first; once it is air the feet block is unoccluded and breaks normally.
            dyOrder = new int[] { 1, 0 };
        }
        for (int dy : dyOrder) {
            BlockPos pos = new BlockPos(cx + stepX, feetY + dy, cz + stepZ);
            BlockState state = client.world.getBlockState(pos);
            if (WorldGridPerception.isHazard(state)) {
                return null; // a hazard blocks the tunnel -> never mine into it; let the outer timeout abandon
            }
            if (preserveReturnTargetSupport && pos.equals(returnTargetSupport) && isStableDescentSupport(client, pos)) {
                continue;
            }
            if (toDig == null && !state.isAir() && !state.getCollisionShape(client.world, pos).isEmpty()) {
                toDig = pos;
            }
        }
        if (toDig != null) {
            if (!toDig.equals(nav3dLastTunnelDigTarget)) {
                nav3dLastTunnelDigTarget = toDig.toImmutable();
                nav3dLastTunnelBreakLogged = false;
            }
            BlockBreakController.Result dig = blockBreakController.tick(client, player, toDig, commandId, nowMs);
            if (dig.status() == BlockBreakController.Status.BROKEN) {
                logNav3dTunnelBroke(toDig, target, nowMs, "block_break_broken");
                nav3dLastProgressPos = null;
                nav3dLastProgressMs = nowMs;
                // fall through to step into the opened gap toward the target
            } else {
                // RUNNING or FAILED: keep LOOKING at the block and breaking. Bailing to null on a transient FAILED
                // made the bot alternate dig/stop, so the look never stabilized on the block and the break never
                // completed (tunnel_broke=0). Sustaining the look is what lets the break finish.
                if (NAV3D_TRACE && nowMs - nav3dTunnelDigLogMs > 400L) {
                    nav3dTunnelDigLogMs = nowMs;
                    LOGGER.info(
                        "nav3d_tunnel_dig_trace instanceId={} toDig={} status={} reason={} raycastHit={} bot=({},{},{}) yaw={} pitch={}",
                        instanceId, toDig.toShortString(), dig.status(), dig.reason(),
                        dig.hitBlock() == null ? "null" : dig.hitBlock().toShortString(),
                        roundForLog(player.getX()), roundForLog(player.getY()), roundForLog(player.getZ()),
                        roundForLog(player.getYaw()), roundForLog(player.getPitch()));
                }
                return new ControlDecision(
                    lookIntentForBlock(effective, player, toDig, reasonPrefix + "_tunnel_dig"), InputState.stop());
            }
        } else if (nav3dLastTunnelBreakLogged) {
            nav3dLastTunnelDigTarget = null;
            nav3dLastTunnelBreakLogged = false;
        }
        boolean jump = facingTarget && player.isOnGround() && target.y > player.getY() + 0.5D;
        if (nowMs - lastNav3dCollectLogMs > 500L) {
            lastNav3dCollectLogMs = nowMs;
            LOGGER.info(
                "navigation.nav3d_tunnel_drive instanceId={} target=({},{},{}) bot=({},{},{}) facing={} brokeThrough={}",
                instanceId, roundForLog(target.x), roundForLog(target.y), roundForLog(target.z),
                roundForLog(player.getX()), roundForLog(player.getY()), roundForLog(player.getZ()), facingTarget, toDig != null);
        }
        InputState input = new InputState(
            facingTarget, false, false, false, jump, false, facingTarget ? 1.0F : 0.0F, 0.0F);
        return new ControlDecision(
            lookIntentForAngles(effective, look.yaw(), look.pitch(), reasonPrefix + "_tunnel"), input);
    }

    private boolean maybeLogNav3dTunnelCleared(MinecraftClient client, Vec3d target, long nowMs) {
        if (client == null || client.world == null || nav3dLastTunnelDigTarget == null || nav3dLastTunnelBreakLogged) {
            return false;
        }
        BlockState state = client.world.getBlockState(nav3dLastTunnelDigTarget);
        if (!state.isAir() && !state.getCollisionShape(client.world, nav3dLastTunnelDigTarget).isEmpty()) {
            return false;
        }
        logNav3dTunnelBroke(nav3dLastTunnelDigTarget, target, nowMs, "tracked_block_cleared");
        return true;
    }

    private void logNav3dTunnelBroke(BlockPos obstacle, Vec3d target, long nowMs, String reason) {
        if (obstacle == null) {
            return;
        }
        if (obstacle.equals(nav3dLastTunnelDigTarget) && nav3dLastTunnelBreakLogged) {
            return;
        }
        nav3dLastTunnelDigTarget = obstacle.toImmutable();
        nav3dLastTunnelBreakLogged = true;
        nav3dLastProgressPos = null;
        nav3dLastProgressMs = nowMs;
        LOGGER.info("navigation.nav3d_tunnel_broke instanceId={} obstacle={} target=({},{},{}) reason={}",
            instanceId,
            obstacle.toShortString(),
            roundForLog(target.x),
            roundForLog(target.y),
            roundForLog(target.z),
            reason == null ? "" : reason);
    }

    /** The solid, non-hazard block directly in front of the bot (toward {@code aim}) at feet or head level -- the
     * wall to mine through when the 3-D collect is wedged. Null if there is no diggable block there. */
    private static BlockPos nav3dBlockingObstacle(MinecraftClient client, ClientPlayerEntity player, Vec3d aim) {
        if (client == null || client.world == null) {
            return null;
        }
        int feetY = (int) Math.floor(player.getY());
        int cx = (int) Math.floor(player.getX());
        int cz = (int) Math.floor(player.getZ());
        double dirX = aim.x - player.getX();
        double dirY = aim.y - player.getY();
        double dirZ = aim.z - player.getZ();
        if (Math.abs(dirX) < 0.1D && Math.abs(dirZ) < 0.1D) {
            Vec3d forward = player.getRotationVec(1.0F);
            dirX = forward.x;
            dirZ = forward.z;
        }
        int stepX = 0;
        int stepZ = 0;
        if (Math.abs(dirX) >= Math.abs(dirZ)) {
            stepX = dirX >= 0 ? 1 : -1;
        } else {
            stepZ = dirZ >= 0 ? 1 : -1;
        }
        int[] dyOrder;
        if (dirY > 1.25D) {
            // When climbing toward a higher standable cell, the intervening lower block is often the
            // destination support. Clear the future head/feet space, but do not mine the ledge out.
            dyOrder = new int[] { 3, 2 };
        } else if (dirY > 0.25D) {
            dyOrder = new int[] { 2, 1 };
        } else if (dirY < -0.75D) {
            dyOrder = new int[] { 0, -1, 1 };
        } else {
            dyOrder = new int[] { 1, 0 };
        }
        for (int dy : dyOrder) {
            BlockPos pos = new BlockPos(cx + stepX, feetY + dy, cz + stepZ);
            BlockState state = client.world.getBlockState(pos);
            if (WorldGridPerception.isHazard(state)) {
                return null;
            }
            if (!state.isAir()
                && !state.getCollisionShape(client.world, pos).isEmpty()) {
                return pos;
            }
        }
        return null;
    }

    /** Signed smallest angle from one yaw to another, wrapped to [-180, 180). */
    private static double wrapDegrees180(double degrees) {
        double d = degrees % 360.0D;
        if (d >= 180.0D) {
            d -= 360.0D;
        }
        if (d < -180.0D) {
            d += 360.0D;
        }
        return d;
    }

    /** Follow the 3-D route: aim at the waypoint one past the bot's nearest route cell (the pickup cell if at the end). */
    private static VoxelCell nav3dNextWaypoint(List<VoxelCell> route, ClientPlayerEntity player) {
        double bx = player.getX();
        double bz = player.getZ();
        int closest = 0;
        double closestDistSq = Double.MAX_VALUE;
        for (int i = 0; i < route.size(); i++) {
            VoxelCell cell = route.get(i);
            double dx = (cell.x() + 0.5D) - bx;
            double dz = (cell.z() + 0.5D) - bz;
            double distSq = dx * dx + dz * dz;
            if (distSq <= closestDistSq) {
                closestDistSq = distSq;
                closest = i;
            }
        }
        return route.get(Math.min(closest + 1, route.size() - 1));
    }

    /** True while the bot is within ~2.5 blocks (horizontal) of some route cell -- i.e. still on the cached route. */
    private static boolean nav3dBotNearRoute(ClientPlayerEntity player, List<VoxelCell> route) {
        double bx = player.getX();
        double bz = player.getZ();
        for (VoxelCell cell : route) {
            double dx = (cell.x() + 0.5D) - bx;
            double dz = (cell.z() + 0.5D) - bz;
            if (dx * dx + dz * dz <= 6.25D) {
                return true;
            }
        }
        return false;
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
        activeNavigationSuppliedRoute = false;
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

    static String formatSurface(GridPerception perception, GridCell cell) {
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

    // #1 canopy break: the block above a +1 step-up DESTINATION (target cell, feetY+2) that the bot must
    // clear to mount. Returns it ONLY when it's a breakable LEAF (the bot routed under canopy); a non-leaf
    // solid (a real ceiling) returns null so shouldJumpForStepUp's suppression stands. Mirrors the gate's geometry.
    private BlockPos stepUpCanopyBreakTarget(MinecraftClient client, int waypointIndex, ClientPlayerEntity player, List<GridCell> waypoints) {
        if (client == null || client.world == null
            || waypointIndex < 0 || waypointIndex >= waypoints.size()
            || !activeNavigationJumpWaypointIndexes.contains(waypointIndex)) {
            return null;
        }
        GridCell target = waypoints.get(waypointIndex);
        if (distanceToWaypointCenter(target, player.getX(), player.getZ()) > 1.35D) {
            return null;
        }
        BlockPos destinationHead = new BlockPos(target.x(), player.getBlockPos().getY() + 2, target.z());
        BlockState state = client.world.getBlockState(destinationHead);
        return state.isIn(net.minecraft.registry.tag.BlockTags.LEAVES) ? destinationHead : null;
    }

    // Break the canopy leaf blocking a step-up mount, bounded to CANOPY_BREAK_TIMEOUT_MS per leaf. Returns
    // the break control (look at + mine the leaf) while breaking; null once it's broken OR the budget is
    // spent, so the caller falls through to the normal step-up / re-aim / abandon flow.
    private ControlDecision resolveCanopyLeafBreakControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, BlockPos leaf, String commandId) {
        long nowMs = System.currentTimeMillis();
        if (!leaf.equals(canopyBreakTarget)) {
            canopyBreakTarget = leaf.toImmutable();
            canopyBreakStartedAtMs = nowMs;
            blockBreakController.reset();
            LOGGER.info("navigation.canopy_break_start instanceId={} commandId={} leaf={}", instanceId, commandId, leaf.toShortString());
        }
        if (nowMs - canopyBreakStartedAtMs > CANOPY_BREAK_TIMEOUT_MS) {
            canopyBreakTarget = null;
            blockBreakController.reset();
            return null;
        }
        BlockBreakController.Result dig = blockBreakController.tick(client, player, leaf, commandId + ":canopy", nowMs);
        if (dig.status() == BlockBreakController.Status.BROKEN) {
            LOGGER.info("navigation.canopy_break_broken instanceId={} commandId={} leaf={}", instanceId, commandId, leaf.toShortString());
            canopyBreakTarget = null;
            blockBreakController.reset();
            return null;
        }
        return new ControlDecision(lookIntentForBlock(effective, player, leaf, "canopy_clear"), InputState.stop());
    }

    private boolean shouldJumpForStepUp(MinecraftClient client, int waypointIndex, ClientPlayerEntity player, List<GridCell> waypoints) {
        if (waypointIndex < 0 || waypointIndex >= waypoints.size() || !activeNavigationJumpWaypointIndexes.contains(waypointIndex)) {
            return false;
        }
        GridCell target = waypoints.get(waypointIndex);
        double distance = distanceToWaypointCenter(target, player.getX(), player.getZ());
        if (distance > 1.35D) {
            return false;
        }
        // Head-clearance gate (Bug 1, narrowed for the canopy edge case): a +1 step-up is mounted by
        // jumping, which needs headroom at the DESTINATION cell being mounted -- NOT above the bot's
        // current cell. The original gate checked player.up(2) (current overhead), which wrongly
        // suppressed legit step-ups toward a tree while the bot stood under canopy (leaves/logs have
        // collision -> the "jump loop under leaves"). A 1-block step-up only needs ~1 block of rise, so a
        // block above the CURRENT head is fine; the mount is blocked only by a solid block at the
        // DESTINATION head (target cell, feetY+2). In a 2-tall corridor that destination overhead is the
        // same continuous ceiling, so the spurious-hop suppression is preserved. Live world = real pos.
        if (client != null && client.world != null) {
            BlockPos destinationHead = new BlockPos(target.x(), player.getBlockPos().getY() + 2, target.z());
            if (!client.world.getBlockState(destinationHead).getCollisionShape(client.world, destinationHead).isEmpty()) {
                long nowMs = System.currentTimeMillis();
                if (nowMs - lastStepUpSuppressLogAtMs > 1_000L) {
                    lastStepUpSuppressLogAtMs = nowMs;
                    LOGGER.info(
                        "navigation.step_up_suppressed instanceId={} commandId={} target={} destinationHead={} block={}",
                        instanceId,
                        activeNavigationCommandId,
                        target,
                        destinationHead,
                        blockId(client.world.getBlockState(destinationHead))
                    );
                }
                return false;
            }
        }
        return true;
    }

    private static int skippedUnreachedJumpWaypoint(
        int fromIndex,
        int toIndex,
        Set<Integer> jumpWaypointIndexes,
        List<GridCell> waypoints,
        double x,
        double z,
        double arriveEpsilon
    ) {
        if (jumpWaypointIndexes == null
            || jumpWaypointIndexes.isEmpty()
            || waypoints == null
            || waypoints.isEmpty()
            || toIndex <= fromIndex) {
            return -1;
        }
        int first = Math.max(0, fromIndex);
        int lastExclusive = Math.min(toIndex, waypoints.size());
        for (int i = first; i < lastExclusive; i++) {
            if (jumpWaypointIndexes.contains(i)
                && distanceToWaypointCenter(waypoints.get(i), x, z) > arriveEpsilon) {
                return i;
            }
        }
        return -1;
    }

    private static double distanceToWaypointCenter(GridCell target, double x, double z) {
        return Math.hypot(PathFollower.center(target.x()) - x, PathFollower.center(target.z()) - z);
    }

    private boolean shouldJumpForNavigationUnstick(
        BrainLink.Intent effective,
        PathFollower.Command command,
        ClientPlayerEntity player,
        List<GridCell> waypoints
    ) {
        if (!isGatherAdjacentNavigation(effective) || command == null || player == null) {
            return false;
        }
        InputState input = command.input();
        if (command.finished() || input == null || !input.pressingForward() || command.progress() == null) {
            return false;
        }
        String reason = command.intent() == null || command.intent().reason() == null ? "" : command.intent().reason();
        if (!"arcing_to_target".equals(reason) && !"navigate_forward".equals(reason)) {
            return false;
        }
        int stagnantTicks = command.progress().stagnantTicks();
        if (stagnantTicks >= GATHER_ADJACENT_NAV_UNSTICK_JUMP_TICKS) {
            return true;
        }
        if (!"arcing_to_target".equals(reason)
            || waypoints == null
            || command.waypointIndex() < 0
            || command.waypointIndex() >= waypoints.size()) {
            return false;
        }
        GridCell target = waypoints.get(command.waypointIndex());
        double distance = Math.hypot(PathFollower.center(target.x()) - player.getX(), PathFollower.center(target.z()) - player.getZ());
        boolean forceArcJump = shouldForceGatherNavigationArcJump(
            reason,
            true,
            distance,
            command.progress().closestDistance(),
            stagnantTicks
        );
        boolean canPulseJump = player.isOnGround()
            || player.horizontalCollision
            || forceArcJump;
        if (!canPulseJump || distance > GATHER_ADJACENT_NAV_ARC_JUMP_DISTANCE) {
            return false;
        }
        boolean lostWaypointProgress =
            command.progress().closestDistance() + GATHER_ADJACENT_NAV_ARC_PROGRESS_TOLERANCE < distance;
        return forceArcJump
            || player.horizontalCollision
            || stagnantTicks > 0
                && command.progress().closestDistance() <= distance + GATHER_ADJACENT_NAV_ARC_PROGRESS_TOLERANCE
            || lostWaypointProgress;
    }

    static boolean shouldForceGatherNavigationArcJump(
        String reason,
        boolean waypointValid,
        double distance,
        double closestDistance,
        int stagnantTicks
    ) {
        if (!"arcing_to_target".equals(reason) || !waypointValid || distance > GATHER_ADJACENT_NAV_ARC_JUMP_DISTANCE) {
            return false;
        }
        boolean lostWaypointProgress = closestDistance + GATHER_ADJACENT_NAV_ARC_PROGRESS_TOLERANCE < distance;
        boolean stalledNearWaypoint = stagnantTicks > 0
            && closestDistance <= distance + GATHER_ADJACENT_NAV_ARC_PROGRESS_TOLERANCE;
        return stalledNearWaypoint || lostWaypointProgress;
    }

    static InputState navigationInputWithJump(InputState input, boolean jump, boolean boostForward) {
        if (!jump || input == null) {
            return input;
        }
        boolean pressingForward = input.pressingForward() || boostForward;
        float movementForward = pressingForward && boostForward
            ? Math.max(input.movementForward(), 1.0F)
            : input.movementForward();
        return new InputState(
            pressingForward,
            input.pressingBack(),
            input.pressingLeft(),
            input.pressingRight(),
            true,
            input.sneaking(),
            movementForward,
            input.movementSideways()
        );
    }

    static long gatherAdjacentMoveStallMs(List<GridCell> route, double distance) {
        if (route != null
            && route.size() >= GATHER_ADJACENT_MOVE_LONG_ROUTE_MIN_LENGTH
            && distance >= GATHER_ADJACENT_MOVE_LONG_ROUTE_MIN_DISTANCE) {
            return GATHER_ADJACENT_MOVE_LONG_ROUTE_STALL_MS;
        }
        return GATHER_ADJACENT_MOVE_STALL_MS;
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

    private record SurfaceFloorGridPerception(GridPerception delegate, int minSurfaceY) implements GridPerception {
        @Override
        public boolean isBlocked(int x, int z) {
            return surfaceY(x, z).isEmpty();
        }

        @Override
        public OptionalInt surfaceY(int x, int z) {
            OptionalInt surface = delegate.surfaceY(x, z);
            if (surface.isEmpty() || surface.getAsInt() < minSurfaceY) {
                return OptionalInt.empty();
            }
            return surface;
        }

        @Override
        public int minX() {
            return delegate.minX();
        }

        @Override
        public int maxX() {
            return delegate.maxX();
        }

        @Override
        public int minZ() {
            return delegate.minZ();
        }

        @Override
        public int maxZ() {
            return delegate.maxZ();
        }

        @Override
        public TraversalIssue traversalIssue(GridCell from, GridCell to) {
            if (from == null || to == null) {
                return TraversalIssue.INVALID_REQUEST;
            }
            if (!inBounds(to.x(), to.z())) {
                return TraversalIssue.OUT_OF_BOUNDS;
            }
            if (surfaceY(from.x(), from.z()).isEmpty()) {
                return TraversalIssue.FROM_BLOCKED;
            }
            if (surfaceY(to.x(), to.z()).isEmpty()) {
                return TraversalIssue.TO_BLOCKED;
            }
            return delegate.traversalIssue(from, to);
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
            hasAcceptedLook = false;
            return;
        }

        double targetYaw = effective.targetYaw() == null ? player.getYaw() : effective.targetYaw();
        double targetPitch = effective.targetPitch() == null ? player.getPitch() : effective.targetPitch();
        // Target-swap damping (the view glitched back and forth while mining): easing
        // below smooths MOTION, but flows alternating sub-aims several times a second whip the
        // smoothed camera A->B->A. Within one command a target jump beyond LOOK_SWAP_ANGLE_DEG is
        // accepted at most once per LOOK_SWAP_MIN_INTERVAL_MS; meanwhile the camera keeps easing
        // toward the previously accepted target (<=350 ms deferral — invisible to multi-second
        // command timeouts; the breaker's own aim gates still rule actual breaking). Small deltas
        // track continuously; a command change accepts immediately.
        String lookCommandId = effective.commandId() == null ? "" : effective.commandId();
        // Feel pass 2 (a regression caused 21 collect timeouts, wait_pickup at 18 s — the damper
        // deferred re-aims at DRIFTING item drops, so the bot chased stale aim points): the swap
        // gate applies ONLY to block-face/placement aims, where the A->B->A whip lives. Drop-seek,
        // navigation, and scan looks track continuously (easing + deadband still smooth them).
        String lookReason = effective.reason() == null ? "" : effective.reason();
        boolean dampEligible = lookReason.contains("face") || lookReason.contains("aim") || lookReason.contains("place");
        if (dampEligible && hasAcceptedLook && lookCommandId.equals(acceptedLookCommandId)) {
            double yawDelta = Math.abs(wrapDegreesDelta(targetYaw - acceptedLookYaw));
            double pitchDelta = Math.abs(targetPitch - acceptedLookPitch);
            if (yawDelta > LOOK_SWAP_ANGLE_DEG || pitchDelta > LOOK_SWAP_ANGLE_DEG) {
                if (nowMs - lastLookSwapAtMs < LOOK_SWAP_MIN_INTERVAL_MS) {
                    targetYaw = acceptedLookYaw;
                    targetPitch = acceptedLookPitch;
                } else {
                    lastLookSwapAtMs = nowMs;
                    acceptedLookYaw = targetYaw;
                    acceptedLookPitch = targetPitch;
                }
            } else {
                acceptedLookYaw = targetYaw;
                acceptedLookPitch = targetPitch;
            }
        } else {
            hasAcceptedLook = true;
            acceptedLookCommandId = lookCommandId;
            acceptedLookYaw = targetYaw;
            acceptedLookPitch = targetPitch;
            lastLookSwapAtMs = nowMs;
        }
        // Micro-deadband: once the camera is within ~0.7 degrees of the accepted target, stop
        // writing per-tick corrections — recomputed aim points shimmy by fractions of a degree and
        // the constant micro-writes read as shake.
        double yawErr = Math.abs(wrapDegreesDelta(targetYaw - player.getYaw()));
        double pitchErr = Math.abs(targetPitch - player.getPitch());
        if (yawErr < 0.7D && pitchErr < 0.7D) {
            return;
        }
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

    private void traceNav3dTick(ClientPlayerEntity player, InputState state, String reason, boolean survival) {
        if (!NAV3D_TRACE || state == null || player == null) {
            return;
        }
        Vec3d v = player.getVelocity();
        LOGGER.info(
            "nav3d_trace instanceId={} layer={} reason={} fwd={} mvF={} jump={} vel=({},{}) onGround={} hColl={} yaw={}",
            instanceId, survival ? "survival" : "control", reason,
            state.pressingForward(), state.movementForward(), state.jumping(),
            roundForLog(v.x), roundForLog(v.z), player.isOnGround(), player.horizontalCollision, roundForLog(player.getYaw()));
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
        int partialExhaustionRetries = 0;
        BlockPos currentTarget = null;
        GridCell currentAdjacentCell = null;
        List<GridCell> currentAdjacentRoute = List.of();
        final AdjacentMoveProgressTracker currentAdjacentProgress = new AdjacentMoveProgressTracker();
        int currentAdjacentMoveStalls = 0;
        boolean currentAdjacentReached = false;
        boolean currentAdjacentLatchLogged = false;
        boolean currentAdjacentLatchHoldLogged = false;
        int targetOutOfReachRepositions = 0;
        boolean breakStarted = false;
        boolean breakDone = false;
        long collectStartedAtMs = 0L;
        String lastSideCollectUnavailableKey = "";
        TreeGatherPlanner.Selection cachedTargetSelection = null;
        long targetSelectionCacheKey = Long.MIN_VALUE;
        long targetSelectionCachedAtMs = 0L;
        long noReachableFallbackSinceMs = 0L;
        // B2 pillar-up (tall canopies): bounded jump-and-place to bring overhead logs into the
        // overhead-harvest envelope before concluding no_reachable.
        int pillarPlacements = 0;
        long pillarPlacedAtMs = 0L;
        int pillarLandingMinFloorY = Integer.MIN_VALUE;
        long pillarEngagedAtMs = 0L;
        long lastGatherPillarLogMs = 0L;
        BlockPos pillarFoundation = null;
        final CollectProgressTracker collectProgress =
            new CollectProgressTracker(GATHER_TREE_COLLECT_NO_PROGRESS_MS, GATHER_TREE_COLLECT_PROGRESS_EPSILON);
        final SideCollectStallTracker sideCollectStall =
            new SideCollectStallTracker(GATHER_TREE_SIDE_COLLECT_CHURN_STREAK, GATHER_TREE_COLLECT_PROGRESS_EPSILON);
        // FPS: cache for the throttled side-collect scan (GATHER_TREE_SIDE_COLLECT_SCAN_INTERVAL_MS).
        String sideCollectCacheKey = "";
        long sideCollectCacheAtMs = 0L;
        BrainLink.Intent sideCollectCacheIntent = null;

        GatherTreeRun(String commandId, BlockPos seed, int baselineLogCount, long startedAtMs, Set<BlockPos> cluster) {
            this.commandId = commandId == null ? "" : commandId;
            this.seed = seed.toImmutable();
            this.baselineLogCount = baselineLogCount;
            this.lastVerifiedLogCount = baselineLogCount;
            this.startedAtMs = startedAtMs;
            this.cluster = cluster == null ? Set.of() : Set.copyOf(cluster);
        }
    }

    private static final class GatherTreeSearchRun {
        final String commandId;
        final GridCell origin;
        final int originFeetY;
        final long startedAtMs;
        GridCell goal = null;
        List<GridCell> route = List.of();
        final Set<GridCell> visitedGoals = new HashSet<>();
        int routeAttempts = 0;
        int routeUnavailableStreak = 0;
        boolean noRouteLogged = false;
        long nextRouteRetryAtMs = 0L;

        GatherTreeSearchRun(String commandId, GridCell origin, int originFeetY, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.origin = origin == null ? new GridCell(0, 0) : origin;
            this.originFeetY = originFeetY;
            this.startedAtMs = startedAtMs;
        }
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

    private enum OreKind {
        IRON(
            "mine_nearby_iron",
            "neariron",
            "raw_iron",
            "iron",
            NEARBY_IRON_TARGET_RAW_IRON,
            NEARBY_IRON_TIMEOUT_MS,
            NEARBY_IRON_MAX_PROSPECT_BLOCKS,
            NEARBY_IRON_DROP_TIMEOUT_MS
        ),
        DIAMOND(
            "mine_nearby_diamond",
            "neardiamond",
            "diamond",
            "diamond",
            NEARBY_DIAMOND_TARGET_DIAMONDS,
            NEARBY_DIAMOND_TIMEOUT_MS,
            NEARBY_DIAMOND_MAX_PROSPECT_BLOCKS,
            NAV3D_COLLECT_DROP_TIMEOUT_MS
        ),
        // Fuel v2 (the coal-rider lesson): coal acquisition is a FIRST-CLASS goal with delta-based
        // completion, chosen deliberately by the oracle when smelt fuel is short at depth — never a
        // rider on another loop's satisfaction.
        COAL(
            "mine_nearby_coal",
            "nearcoal",
            "coal",
            "coal",
            NEARBY_COAL_TARGET_COAL,
            NEARBY_COAL_TIMEOUT_MS,
            NEARBY_COAL_MAX_PROSPECT_BLOCKS,
            NEARBY_IRON_DROP_TIMEOUT_MS
        );

        final String action;
        final String commandSuffix;
        final String dropItemId;
        final String targetKind;
        final int targetDelta;
        final long timeoutMs;
        final int maxProspectBlocks;
        final long collectDropTimeoutMs;

        OreKind(
            String action,
            String commandSuffix,
            String dropItemId,
            String targetKind,
            int targetDelta,
            long timeoutMs,
            int maxProspectBlocks,
            long collectDropTimeoutMs
        ) {
            this.action = action;
            this.commandSuffix = commandSuffix;
            this.dropItemId = dropItemId;
            this.targetKind = targetKind;
            this.targetDelta = targetDelta;
            this.timeoutMs = timeoutMs;
            this.maxProspectBlocks = maxProspectBlocks;
            this.collectDropTimeoutMs = collectDropTimeoutMs;
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

    record CraftInventorySnapshot(
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
        InventoryCounter.InventoryItemSnapshot ironPickaxes,
        InventoryCounter.InventoryItemSnapshot diamonds,
        InventoryCounter.InventoryItemSnapshot diamondPickaxes,
        InventoryCounter.InventoryItemSnapshot ironHelmets,
        InventoryCounter.InventoryItemSnapshot ironChestplates,
        InventoryCounter.InventoryItemSnapshot ironLeggings,
        InventoryCounter.InventoryItemSnapshot ironBoots,
        InventoryCounter.InventoryItemSnapshot whiteBeds
    ) {
    }

    private static final class Craft3x3Run {
        final String commandId;
        final Craft3x3RecipePlanner.Recipe recipe;
        final int baselinePlanks;
        final int baselineCobblestone;
        final int baselineSticks;
        final int baselineIronIngots;
        final int baselineDiamonds;
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
            this.baselineDiamonds = inventory.diamonds.itemCount();
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
        int desiredInputCount = 1;
        int desiredFuelCount = 1;
        String inputItemId = "";
        String fuelItemId = "";
        BlockPos furnaceTarget = null;
        GridCell furnaceInteractionCell = null;
        final Set<GridCell> excludedFurnaceInteractionCells = new HashSet<>();
        int directFurnaceOpenAttempts = 0;

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

    private static final class DescentRun {
        final String commandId;
        final BlockPos startFeet;
        final int depth;
        final long startedAtMs;
        final float healthBefore;
        final Set<String> rejectedMoves = new HashSet<>();
        final Set<DescentHazardMemory.HazardMarker> rejectedHazards = new HashSet<>();
        final List<BlockPos> reachedFeet = new ArrayList<>();
        BlockPos currentFeet;
        StaircaseDescentPlanner.Direction2d direction;
        int stepIndex = 1;
        int depthReached = 0;
        int reroutes = 0;
        int openAirReroutes = 0;
        int hazardReroutes = 0;
        int supportBridges = 0;
        long bridgeNudgeStartedAtMs = 0L;
        DescentControlPlanner.Stage stage = DescentControlPlanner.Stage.BREAK_SIGHT;
        BlockPos recoveryClearTarget = null;
        String recoveryClearPhase = "";
        BlockPos moveTargetFeet = null;
        long moveStartedAtMs = 0L;
        long moveLastProgressAtMs = 0L;
        double moveBestDistance = Double.POSITIVE_INFINITY;
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
        final Set<GridCell> exhaustedProbeColumns = new HashSet<>();
        BlockPos currentTarget = null;
        BlockPos lastBrokenTarget = null;
        GridCell activeProbeColumn = null;
        boolean currentTargetDropsCobblestone = true;
        GridCell currentAdjacentCell = null;
        List<GridCell> currentAdjacentRoute = List.of();
        boolean currentAdjacentReached = false;
        final AdjacentMoveProgressTracker currentAdjacentProgress = new AdjacentMoveProgressTracker();
        int currentAdjacentMoveStalls = 0;
        long collectStartedAtMs = 0L;
        int targetBaselineCobblestone = -1;
        int collectBaselineCobblestone = -1;
        int probeBlocksBroken = 0;
        int probeBreakFailures = 0;
        int activeProbeColumnClears = 0;
        boolean descentFallbackActive = false;
        int descentFallbacks = 0;
        long descentFallbackStartedAtMs = 0L;
        String lastCollectItemLogKey = "";
        long lastCollectItemLogAtMs = 0L;
        String lastDirectCollectLogKey = "";
        long lastDirectCollectLogAtMs = 0L;
        String lastBreakProgressLogKey = "";
        long lastBreakProgressLogAtMs = 0L;

        MineNearbyStoneRun(String commandId, int baselineCobblestone, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.baselineCobblestone = baselineCobblestone;
            this.startedAtMs = startedAtMs;
        }
    }

    private record MineNearbyStoneApproachPlan(
        BlockPos target,
        GridCell cell,
        List<GridCell> route,
        String reason
    ) {
    }

    private static final class MineNearbyIronRun {
        final String commandId;
        final int baselineRawIron;
        final int targetDelta;
        final long startedAtMs;
        final Set<BlockPos> abandonedTargets = new HashSet<>();
        // Corridor cells dug this command — branch candidates parallel-adjacent (offset 1-2) to
        // them are skipped, so prospecting digs spaced lanes instead of re-exposing seen walls.
        final Set<BlockPos> prospectCorridorCells = new HashSet<>();
        BlockPos currentTarget = null;
        boolean currentTargetIron = false;
        BlockPos lastBrokenTarget = null;
        BlockPos currentProspectCell = null;
        StaircaseDescentPlanner.Direction2d prospectDirection = null;
        BlockPos prospectStrategyOrigin = null;
        ProspectStrategyPlanner.State prospectStrategyState = ProspectStrategyPlanner.State.initial();
        long collectStartedAtMs = 0L;
        int collectBaselineItemCount = -1;
        String collectNavTerminalReason = null;
        long collectNavTerminalSinceMs = 0L;
        long prospectSettleUntilMs = 0L;
        int prospectBlocksBroken = 0;
        int branchCellsAdvanced = 0;
        int toolRecoveryAttempts = 0;
        boolean proactiveToolRecoveryLogged = false;
        boolean prospectStrategyDisabledLogged = false;
        boolean fieldKitRecoveryActive = false;
        BlockPos fieldKitAlcoveCell = null;
        boolean fieldKitTablePlacedByRecovery = false;
        boolean fieldKitRetrieveTablePending = false;
        long lastFieldKitStateLogAtMs = 0L;

        MineNearbyIronRun(String commandId, int baselineRawIron, int targetDelta, long startedAtMs) {
            this.commandId = commandId == null ? "" : commandId;
            this.baselineRawIron = baselineRawIron;
            this.targetDelta = Math.max(0, targetDelta);
            this.startedAtMs = startedAtMs;
        }

        String toolPlaceTableCommandId() {
            return commandId + ":neariron:fieldkit:place_table:" + toolRecoveryAttempts;
        }

        String toolCraftPickaxeCommandId() {
            return commandId + ":neariron:fieldkit:craft_stone_pickaxe:" + toolRecoveryAttempts;
        }

        String toolCraftTableCommandId() {
            return commandId + ":neariron:fieldkit:craft_table:" + toolRecoveryAttempts;
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
        int nav3dWaypointIndex = -1;
        int pillarWaypointIndex = -1;
        int pillarFailedWaypointIndex = -1;
        int pillarPlacements = 0;
        int pillarLandingMinFloorY = Integer.MIN_VALUE;
        double bestWaypointDistanceSq = Double.POSITIVE_INFINITY;
        long lastWaypointProgressMs;
        long lastWaypointLogMs = 0L;
        long lastPillarLogMs = 0L;
        long pillarPlacedAtMs = 0L;
        long pillarAttemptStartedAtMs = 0L;
        BlockPos pillarFoundation = null;
        BlockPos pillarPlacementCell = null;
        // B1 ascend-staircase state (no-breadcrumb deep returns): the descent mirrored upward.
        StaircaseDescentPlanner.Direction2d ascendDirection = null;
        BlockPos ascendStepAnchor = null;
        int ascendSteps = 0;
        int ascendReroutes = 0;
        long ascendStepStartedAtMs = 0L;

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
        List<BlockPos> returnPath = List.of();

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

        String descentCommandId() {
            return commandId + ":descend";
        }

        String returnCommandId() {
            return commandId + ":return";
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
        long containerTransitionSettleUntilMs = 0L;
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

    record LookAngles(double yaw, double pitch) {
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
        int foodLevel,
        boolean hasFood,
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
        int inventoryBestStonePickaxeRemainingDurability,
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
        int inventoryBestIronPickaxeRemainingDurability,
        int inventoryDiamondCount,
        Map<String, Integer> inventoryDiamondsByItem,
        int inventoryDiamondPickaxeCount,
        Map<String, Integer> inventoryDiamondPickaxesByItem,
        int inventoryIronHelmetCount,
        Map<String, Integer> inventoryIronHelmetsByItem,
        int inventoryIronChestplateCount,
        Map<String, Integer> inventoryIronChestplatesByItem,
        int inventoryIronLeggingsCount,
        Map<String, Integer> inventoryIronLeggingsByItem,
        int inventoryIronBootsCount,
        Map<String, Integer> inventoryIronBootsByItem,
        String equippedHelmetItem,
        int equippedHelmetDamage,
        int equippedHelmetMaxDamage,
        double equippedHelmetRemainingFraction,
        String equippedChestplateItem,
        int equippedChestplateDamage,
        int equippedChestplateMaxDamage,
        double equippedChestplateRemainingFraction,
        String equippedLeggingsItem,
        int equippedLeggingsDamage,
        int equippedLeggingsMaxDamage,
        double equippedLeggingsRemainingFraction,
        String equippedBootsItem,
        int equippedBootsDamage,
        int equippedBootsMaxDamage,
        double equippedBootsRemainingFraction,
        List<LogTarget> nearbyLogs,
        boolean craftingTableInReach,
        boolean furnaceInReach,
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
        boolean currentCommandCompleted,
        String currentCommandCompletionReason,
        boolean navigationRouteComputed,
        int navigationRouteLength,
        int navigationWaypointIndex,
        Integer navigationWaypointX,
        Integer navigationWaypointZ,
        Double navigationWaypointDistance,
        TerrainProbe terrainProbe
    ) {
        private static boolean hasNearbyBlock(BlockView world, BlockPos origin, net.minecraft.block.Block block, int radius) {
            if (world == null || origin == null) {
                return false;
            }
            for (int dx = -radius; dx <= radius; dx++) {
                for (int dy = -1; dy <= 2; dy++) {
                    for (int dz = -radius; dz <= radius; dz++) {
                        if (world.getBlockState(origin.add(dx, dy, dz)).isOf(block)) {
                            return true;
                        }
                    }
                }
            }
            return false;
        }

        private static int bestInventoryDurability(ClientPlayerEntity player, Predicate<String> itemPredicate) {
            if (player == null || itemPredicate == null) {
                return -1;
            }
            int best = -1;
            int end = Math.min(36, player.getInventory().size());
            for (int slot = 0; slot < end; slot++) {
                ItemStack stack = player.getInventory().getStack(slot);
                if (stack == null || stack.isEmpty() || !itemPredicate.test(snapshotItemId(stack))) {
                    continue;
                }
                int remaining = stack.isDamageable()
                    ? Math.max(0, stack.getMaxDamage() - stack.getDamage())
                    : Integer.MAX_VALUE;
                best = Math.max(best, remaining);
            }
            return best;
        }

        private static String snapshotItemId(ItemStack stack) {
            if (stack == null || stack.isEmpty()) {
                return "";
            }
            return net.minecraft.registry.Registries.ITEM.getId(stack.getItem()).getPath();
        }

        private static boolean hasHotbarEdibleFood(ClientPlayerEntity player) {
            if (player == null || player.getHungerManager().getFoodLevel() >= 20) {
                return false;
            }
            for (int slot = 0; slot < 9; slot++) {
                ItemStack stack = player.getInventory().getStack(slot);
                if (stack != null && !stack.isEmpty() && stack.contains(DataComponentTypes.FOOD)) {
                    return true;
                }
            }
            return false;
        }

        static ClientSnapshot from(
            String instanceId,
            ClientPlayerEntity player,
            long nowMs,
            InputState input,
            String activeNavigationCommandId,
            boolean currentCommandCompleted,
            String currentCommandCompletionReason,
            boolean navigationRouteComputed,
            List<GridCell> activeNavigationWaypoints,
            int activeNavigationWaypointIndex,
            BlockView world,
            boolean includeTerrainColumns,
            List<LogTarget> nearbyLogs
        ) {
            nearbyLogs = nearbyLogs == null ? List.of() : nearbyLogs;
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
            int bestStonePickaxeRemaining = bestInventoryDurability(player, InventoryCounter::isStonePickaxeItemId);
            InventoryCounter.InventoryItemSnapshot stoneAxeInventory = InventoryCounter.countPlayerItem(player, "stone_axe");
            InventoryCounter.InventoryItemSnapshot stoneSwordInventory = InventoryCounter.countPlayerItem(player, "stone_sword");
            InventoryCounter.InventoryItemSnapshot furnaceInventory = InventoryCounter.countPlayerItem(player, "furnace");
            InventoryCounter.InventoryItemSnapshot charcoalInventory = InventoryCounter.countPlayerItem(player, "charcoal");
            InventoryCounter.InventoryItemSnapshot coalInventory = InventoryCounter.countPlayerItem(player, "coal");
            InventoryCounter.InventoryItemSnapshot rawIronInventory = InventoryCounter.countPlayerItem(player, "raw_iron");
            InventoryCounter.InventoryItemSnapshot ironIngotInventory = InventoryCounter.countPlayerItem(player, "iron_ingot");
            InventoryCounter.InventoryItemSnapshot ironPickaxeInventory = InventoryCounter.countPlayerItem(player, "iron_pickaxe");
            int bestIronPickaxeRemaining = bestInventoryDurability(player, InventoryCounter::isIronPickaxeItemId);
            InventoryCounter.InventoryItemSnapshot diamondInventory = InventoryCounter.countPlayerItem(player, "diamond");
            InventoryCounter.InventoryItemSnapshot diamondPickaxeInventory = InventoryCounter.countPlayerItem(player, "diamond_pickaxe");
            InventoryCounter.InventoryItemSnapshot ironHelmetInventory = InventoryCounter.countPlayerItem(player, "iron_helmet");
            InventoryCounter.InventoryItemSnapshot ironChestplateInventory = InventoryCounter.countPlayerItem(player, "iron_chestplate");
            InventoryCounter.InventoryItemSnapshot ironLeggingsInventory = InventoryCounter.countPlayerItem(player, "iron_leggings");
            InventoryCounter.InventoryItemSnapshot ironBootsInventory = InventoryCounter.countPlayerItem(player, "iron_boots");
            ItemStack equippedHelmet = ArmorController.currentArmorStack(player, ArmorPlanner.ArmorSlot.HELMET);
            ItemStack equippedChestplate = ArmorController.currentArmorStack(player, ArmorPlanner.ArmorSlot.CHESTPLATE);
            ItemStack equippedLeggings = ArmorController.currentArmorStack(player, ArmorPlanner.ArmorSlot.LEGGINGS);
            ItemStack equippedBoots = ArmorController.currentArmorStack(player, ArmorPlanner.ArmorSlot.BOOTS);
            // nearbyLogs is supplied by the caller (snapshotNearbyLogsCached): the reachable-logs
            // scan is the dominant dispatch-tick cost, so it is cached briefly across dispatches
            // instead of recomputed inside every snapshot.
            boolean craftingTableInReach = hasNearbyBlock(world, player.getBlockPos(), Blocks.CRAFTING_TABLE, 3);
            boolean furnaceInReach = hasNearbyBlock(world, player.getBlockPos(), Blocks.FURNACE, 3);
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
                player.getHungerManager().getFoodLevel(),
                hasHotbarEdibleFood(player),
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
                bestStonePickaxeRemaining,
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
                bestIronPickaxeRemaining,
                diamondInventory.itemCount(),
                diamondInventory.itemsByItem(),
                diamondPickaxeInventory.itemCount(),
                diamondPickaxeInventory.itemsByItem(),
                ironHelmetInventory.itemCount(),
                ironHelmetInventory.itemsByItem(),
                ironChestplateInventory.itemCount(),
                ironChestplateInventory.itemsByItem(),
                ironLeggingsInventory.itemCount(),
                ironLeggingsInventory.itemsByItem(),
                ironBootsInventory.itemCount(),
                ironBootsInventory.itemsByItem(),
                ArmorController.itemId(equippedHelmet),
                equippedHelmet == null || equippedHelmet.isEmpty() ? -1 : equippedHelmet.getDamage(),
                ArmorController.maxDurability(equippedHelmet),
                ArmorController.remainingFraction(equippedHelmet),
                ArmorController.itemId(equippedChestplate),
                equippedChestplate == null || equippedChestplate.isEmpty() ? -1 : equippedChestplate.getDamage(),
                ArmorController.maxDurability(equippedChestplate),
                ArmorController.remainingFraction(equippedChestplate),
                ArmorController.itemId(equippedLeggings),
                equippedLeggings == null || equippedLeggings.isEmpty() ? -1 : equippedLeggings.getDamage(),
                ArmorController.maxDurability(equippedLeggings),
                ArmorController.remainingFraction(equippedLeggings),
                ArmorController.itemId(equippedBoots),
                equippedBoots == null || equippedBoots.isEmpty() ? -1 : equippedBoots.getDamage(),
                ArmorController.maxDurability(equippedBoots),
                ArmorController.remainingFraction(equippedBoots),
                nearbyLogs,
                craftingTableInReach,
                furnaceInReach,
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
                currentCommandCompleted,
                currentCommandCompletionReason == null ? "" : currentCommandCompletionReason,
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
