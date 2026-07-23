package com.mcbot.fabricclient;

import java.util.List;
import java.util.Set;
import java.util.function.BiPredicate;
import java.util.function.Predicate;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;
import org.slf4j.Logger;

/**
 * The back-channel an extracted {@link ObjectiveExecutor} uses to reach shell helpers and state that
 * have NOT (yet) been lifted out of {@code McbotFabricClient}.
 *
 * <p>Implemented by {@code McbotFabricClient} itself. The surface is intentionally minimal: it
 * declares exactly the INSTANCE helpers the extracted executors need, with their real signatures.
 * Pure static helpers ({@code formatBlockPos}, {@code roundForLog}) are NOT here — executors call
 * {@code McbotFabricClient.foo(...)} directly. As more objectives are lifted this surface will grow,
 * then shrink again as shared helpers are themselves extracted into collaborators.
 *
 * <p>This surface was derived by reading {@code resolveMineStoneControl} / {@code failMineStone} and
 * enumerating every instance helper, field accessor, and logger they touch.
 */
public interface ShellServices {

    /** The shared mod logger (name {@code mcbot-fabric-client}); keeps extracted log lines identical. */
    Logger logger();

    /** Stable per-process instance id used as the {@code instanceId=} field in structured logs. */
    String instanceId();

    /** The shell's single shared block-break controller (stateful across ticks). */
    BlockBreakController blockBreakController();

    /** Build a {@code stop} intent carrying the given reason, preserving the source's target/expiry. */
    BrainLink.Intent stopFrom(BrainLink.Intent source, String reason);

    /** Floor the intent's target X/Y/Z into a {@link BlockPos}, or {@code null} if any is missing. */
    BlockPos targetBlockPos(BrainLink.Intent intent);

    /** Build a look intent that faces {@code target} from the player's eyes, carrying {@code reason}. */
    BrainLink.Intent lookIntentForBlock(BrainLink.Intent source, ClientPlayerEntity player, BlockPos target, String reason);

    /** Whether the player's current yaw/pitch is within tolerance of facing {@code target}. */
    boolean isLookingAtBlock(ClientPlayerEntity player, BlockPos target);

    /** Hotbar slot holding a usable stone-mining pickaxe, or a negative sentinel if none. */
    int findStoneMiningPickaxeHotbarSlot(ClientPlayerEntity player);

    /** Attempt to move a stone-mining pickaxe into the hotbar; returns the slot or a negative sentinel. */
    int moveStoneMiningPickaxeToHotbar(MinecraftClient client, ClientPlayerEntity player, String commandId, String logPrefix);

    /** Emit the rate-limited block-break progress log line for the given result (mutates shell log state). */
    void logBlockBreakResult(String commandId, BlockPos target, BlockBreakController.Result result);

    /** Nearest dropped item near {@code target} matching {@code itemPredicate}, or {@code null}. */
    Vec3d nearestDroppedItemPosition(MinecraftClient client, ClientPlayerEntity player, BlockPos target, BiPredicate<ItemStack, String> itemPredicate);

    /** Nearest dropped log/log-item near {@code target}, or {@code null} (gather log/tree collect scan). */
    Vec3d nearestDroppedLogItemPosition(MinecraftClient client, ClientPlayerEntity player, BlockPos target);

    /** Close-in direct-collect decision for a nearby dropped log (within the direct-collect envelope), or {@code null}. */
    ControlDecision maybeResolveDroppedLogDirectCollect(BrainLink.Intent effective, ClientPlayerEntity player, Vec3d droppedLogPosition, String reason);

    /** Build a navigate-to-point collect intent at (x, y, z) with the given reason and command suffix. */
    BrainLink.Intent gatherCollectIntent(BrainLink.Intent effective, double targetX, Double targetY, double targetZ, String reason, String commandSuffix);

    /** Build a navigate-to-point collect intent at (x, z) with the given reason and command suffix. */
    BrainLink.Intent gatherCollectIntent(BrainLink.Intent effective, double targetX, double targetZ, String reason, String commandSuffix);

    /** Build a gather-log collect-drop intent aimed at the adjacent cell (or the target block if none). */
    BrainLink.Intent gatherCollectIntent(BrainLink.Intent effective, BlockPos target, GridCell adjacentCell);

    /** Drive navigation for the given intent and return the control decision (shared with the nav path). */
    ControlDecision resolveNavigationControl(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective);

    /** Flag-gated 3-D collect drive toward a dropped item (Phase D): only acts when MCBOT_FABRIC_NAV3D_COLLECT
     * is on; returns {@code null} (caller falls back to its 2-D collect) when off or when the 3-D drive finds no
     * route / abandons the drop. Lets the extracted collect executors reuse the gather_tree D1a wiring. */
    ControlDecision tryNav3dCollectDrive(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, Vec3d drop, String reasonPrefix, String commandId, long nowMs);

    /** Reset the shell's active navigation latch/progress state (used when an objective repositions). */
    void clearNavigationState();

    /** The shared dedup key for the last logged gather-collect item target ({@code ""} initially). */
    String lastGatherCollectItemLogKey();

    /** Store the shared dedup key for the last logged gather-collect item target. */
    void setLastGatherCollectItemLogKey(String key);

    /** Nearest placed crafting-table block within reach of the player, or {@code null} if none. */
    BlockPos selectNearbyCraftingTable(MinecraftClient client, ClientPlayerEntity player);

    /** Notify the brain link that the current command finished with the given reason (wire contract). */
    void completeCurrentCommand(String commandId, String reason, long nowMs);

    /** The shell's single shared block-place controller (stateful across ticks). */
    BlockPlaceController blockPlaceController();

    /** Yaw/pitch (degrees) that aims the player's eyes at {@code target}. */
    McbotFabricClient.LookAngles lookAnglesToPoint(ClientPlayerEntity player, Vec3d target);

    /** Build a look intent carrying the given yaw/pitch and reason, preserving the source's target/expiry. */
    BrainLink.Intent lookIntentForAngles(BrainLink.Intent source, double yaw, double pitch, String reason);

    /** Whether an edge-guard veto blocks a forward step at the given yaw (fall/hazard ahead). */
    boolean edgeGuardBlocksForward(MinecraftClient client, ClientPlayerEntity player, double yawDegrees);

    /** Snapshot of the player's craft-relevant inventory counts (shared across crafting objectives). */
    McbotFabricClient.CraftInventorySnapshot captureCraftInventory(ClientPlayerEntity player);

    /** The registry path of a stack's item ({@code ""} for null/empty); e.g. {@code "oak_planks"}. */
    String itemId(ItemStack stack);

    /** The registry path of a block state ({@code "air"} for null/air); e.g. {@code "crafting_table"}. */
    String blockId(BlockState state);

    /** Whether the block state is an immediate hazard (water/lava/fire/cactus/magma/campfire). */
    boolean isHazardBlockState(BlockState state);

    /** Whether the state is any minable ore (iron/coal/diamond) the bot must not bury under a placement. */
    boolean isAnyOreBlockState(BlockState state);

    /** A lava block directly adjacent to {@code origin} (6 faces), or {@code null} if none. */
    BlockPos firstAdjacentLavaBlock(MinecraftClient client, BlockPos origin);

    /** Hotbar slot (0-8) holding an item whose id satisfies {@code itemPredicate}, or {@code -1}. */
    int findHotbarSlot(ClientPlayerEntity player, Predicate<String> itemPredicate);

    /** Swap an inventory item matching {@code itemPredicate} into the hotbar; returns the slot, {@code -1}, or {@code -2} (closed a foreign screen first). */
    int moveInventoryItemToHotbar(MinecraftClient client, ClientPlayerEntity player, Predicate<String> itemPredicate, String commandId, String logPrefix);

    // --- Descent (descend_staircase) surface ---

    /** Record the completed descent trail (shell trail store read by Return/R2/R5). */
    void recordCompletedDescentPath(String commandId, List<BlockPos> path);

    /**
     * Whether {@code cell} is a recorded descent-trail feet cell or its head cell. Placement flows
     * consult this so a workstation can never occupy the corridor the breadcrumb return must
     * re-walk (repro: the smelt furnace was placed ON the return staircase and the mission
     * exhausted on breadcrumb_stuck).
     */
    boolean isOnRecordedDescentTrail(BlockPos cell);

    /** Fluid-breach reflex activation after a dig opened {@code brokenCell}; null when no fluid found. */
    ControlDecision maybeActivateFluidBreachReflex(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, BlockPos brokenCell, Set<BlockPos> blacklist, String logPrefix, long nowMs);

    /** Continues an active fluid-breach reflex (seal or retreat); null when the reflex is idle. */
    ControlDecision maybeContinueFluidBreachReflex(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, Set<BlockPos> blacklist, String logPrefix, long nowMs);

    /** Whether {@code support} is a non-hazard, collidable block the bot can stand on (descent floor check). */
    boolean isStableDescentSupport(MinecraftClient client, BlockPos support);

    /** First hazard block across the step's clearance/support cells, or {@code null} (shared hazard scan). */
    McbotFabricClient.HazardBlock firstHazardBlockDetail(MinecraftClient client, StaircaseDescentPlanner.Step step);

    /** First hazard block across the given positions, or {@code null} (shared hazard scan). */
    McbotFabricClient.HazardBlock firstHazardBlockDetail(MinecraftClient client, List<BlockPos> positions);

    /** Whether the block state is lava (block or fluid tag). */
    boolean isLavaBlockState(BlockState state);

    /** Whether the state is iron ore (iron/deepslate-iron). */
    boolean isIronOreBlock(BlockState state);

    /** The registry path of the player's currently selected item ({@code "empty"} when none). */
    String selectedItemId(ClientPlayerEntity player);

    /** Hotbar slot holding a stone-or-better pickaxe usable to harvest iron, or a negative sentinel. */
    int findIronHarvestPickaxeHotbarSlot(ClientPlayerEntity player);

    /** Nearest visible iron-ore target within reach excluding {@code excluded}, or {@code null}. */
    BlockPos selectVisibleIronTarget(MinecraftClient client, ClientPlayerEntity player, Set<BlockPos> excluded);

    // --- Descent field-kit tool recovery surface (ported from the iron in-mine recovery) ---

    /** Build a sub-command intent (action/commandId/reason) preserving the source's target/expiry. */
    BrainLink.Intent makeSubIntent(BrainLink.Intent source, String action, String commandId, String reason);

    /** Drive the retrieve-table executor for the field-kit recovery (forwards {@code RetrieveTableExecutor.resolve}). */
    ControlDecision resolveRecoveryRetrieveTable(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent subIntent, long nowMs);

    /** Drive the 2x2 craft-table executor for the field-kit recovery (forwards {@code Craft2x2Executor.resolve}). */
    ControlDecision resolveRecoveryCraftTable(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent subIntent, long nowMs);

    ControlDecision resolveRecoveryCraftSticks(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent subIntent, long nowMs);

    /** Drive the place-workstation table flow for the field-kit recovery (forwards {@code PlaceWorkstationExecutor.resolvePlaceTable}). */
    ControlDecision resolveRecoveryPlaceTable(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent subIntent, long nowMs, BlockPos explicitSupport);

    /** Drive the 3x3 craft flow to craft a stone pickaxe for the field-kit recovery (forwards {@code resolveCraft3x3Control}). */
    ControlDecision resolveRecoveryCraftStonePickaxe(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent subIntent, long nowMs);

    /** Highest remaining durability across the player's usable stone pickaxes, or a negative sentinel if none. */
    int bestStonePickaxeRemainingDurability(ClientPlayerEntity player);
}
