package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

/**
 * {@code place_table} + {@code place_furnace} objective family, lifted verbatim out of
 * {@code McbotFabricClient}.
 *
 * <p>Seventh concrete {@link ObjectiveExecutor} of the strangler decomposition (leaf tier 2). Both
 * actions place a workstation block (a crafting table or a furnace) on a selected adjacent support
 * cell: they share the support-selection / alcove-carve / clear-space / look-alignment / place-verify
 * machinery, so they are co-located in one executor. The control logic, the per-action flat run state,
 * the reset/finish writers, and the place-only support/placement helper subtree are moved here
 * unchanged; the edits are mechanical — source params become the {@link #resolvePlaceTable} /
 * {@link #resolvePlaceFurnace} / {@link TickContext} params, the {@code activePlace*} fields become the
 * private fields below, the {@code completed*CommandIds} sets + {@code finished*CommandReasons} maps
 * become the two {@link CommandLedger}s ({@link #tableLedger} / {@link #furnaceLedger}, one per action),
 * instance-helper calls go through {@link ShellServices}, and pure statics / constants / nested types
 * are referenced on {@link McbotFabricClient} directly.
 *
 * <p>Shared collaborators stay on the shell. {@code hasCraftingTableReplacementMaterial} (a tested
 * static used by {@code RetrieveTableExecutor}) is untouched. {@code blockId} /
 * {@code isHazardBlockState} / {@code firstAdjacentLavaBlock} are shell INSTANCE helpers with many
 * non-place callers, so they remain on the shell and are reached via {@link ShellServices}; likewise
 * {@code findHotbarSlot} / {@code moveInventoryItemToHotbar} (called by mine_nearby_stone and
 * gather_pillar) stay shell-side and are exposed through {@link ShellServices}. The pure statics
 * {@code isReplaceablePlacementOccluder} / {@code cardinalOffset} / {@code formatBlockPos} and the
 * constants {@code WORKSTATION_PLACE_LOOK_TOLERANCE_DEG} / {@code TABLE_INTERACTION_REACH_BLOCKS} stay
 * on {@link McbotFabricClient} (widened to package-private) and are called as {@code McbotFabricClient.X}.
 *
 * <p>Both {@code resolvePlace*Control} methods have additional callers besides the dispatch chain
 * (mine_nearby_iron field-kit table placement; the R5 iron-chain place phases; make_charcoal furnace
 * placement), so the logic is exposed via the public {@link #resolvePlaceTable} / {@link #resolvePlaceFurnace}
 * entries and {@link #tick(TickContext)} routes on the action; the shell rewires its internal callers
 * to {@code placeWorkstationExecutor.resolvePlaceTable(...)} / {@code .resolvePlaceFurnace(...)}.
 *
 * <p>The reason strings ({@code place_table_complete:...}, {@code place_furnace_failed:...}, etc.) are a
 * wire contract read by the brain and are preserved exactly.
 */
public final class PlaceWorkstationExecutor implements ObjectiveExecutor {

    private final ShellServices shell;
    private final CommandLedger tableLedger = new CommandLedger();
    private final CommandLedger furnaceLedger = new CommandLedger();

    private String activePlaceTableCommandId = "";
    private int activePlaceTableBaselineTables = 0;
    private BlockPos activePlaceTableSupportTarget = null;
    private String activePlaceFurnaceCommandId = "";
    private int activePlaceFurnaceBaselineFurnaces = 0;
    private boolean activePlaceFurnaceSneakRequired = false;
    private BlockPos activePlaceFurnaceSupportTarget = null;
    private PlacementSiteRun activePlacementSite = null;

    public PlaceWorkstationExecutor(ShellServices shell) {
        this.shell = shell;
    }

    @Override
    public boolean handles(String action) {
        return "place_table".equals(action) || "place_furnace".equals(action);
    }

    @Override
    public ControlDecision tick(TickContext ctx) {
        MinecraftClient client = ctx.client();
        ClientPlayerEntity player = ctx.player();
        BrainLink.Intent effective = ctx.intent();
        long nowMs = ctx.nowMs();
        if ("place_furnace".equals(effective.action())) {
            return resolvePlaceFurnace(client, player, effective, nowMs);
        }
        return resolvePlaceTable(client, player, effective, nowMs);
    }

    public ControlDecision resolvePlaceTable(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        return resolvePlaceTable(client, player, effective, nowMs, null);
    }

    public ControlDecision resolvePlaceTable(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs, BlockPos supportOverride) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (tableLedger.isFinished(commandId)) {
            return new ControlDecision(shell.stopFrom(effective, tableLedger.reasonOrDefault(commandId, "place_table_complete")), InputState.stop());
        }
        InventoryCounter.InventoryCraftingTableSnapshot tables = InventoryCounter.countPlayerCraftingTables(player);
        if (!commandId.equals(activePlaceTableCommandId)) {
            clearPlacementSiteState();
            activePlaceTableCommandId = commandId;
            activePlaceTableBaselineTables = tables.craftingTableCount();
            activePlaceTableSupportTarget = null;
        }
        boolean awaitingPlacementVerification = shell.blockPlaceController().isAwaitingVerification(commandId);
        PlaceWorkstationPlanner.Decision inventoryDecision = PlaceWorkstationPlanner.decideInventory(
            tables.craftingTableCount() >= 1,
            awaitingPlacementVerification,
            "place_table_no_table"
        );
        if (inventoryDecision.action() == PlaceWorkstationPlanner.Action.FAIL_MISSING_ITEM) {
            String completionReason = finishPlaceTableCommand(commandId, "place_table_failed:place_table_no_table");
            shell.logger().warn(
                "place_table.failed instanceId={} commandId={} reason=place_table_no_table inventoryTables={}",
                shell.instanceId(),
                commandId,
                tables.craftingTableCount()
            );
            shell.completeCurrentCommand(commandId, completionReason, nowMs);
            resetPlaceTableRun();
            return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
        }
        if (!awaitingPlacementVerification && shell.findHotbarSlot(player, id -> "crafting_table".equals(id)) < 0) {
            int hotbarMove = shell.moveInventoryItemToHotbar(client, player, id -> "crafting_table".equals(id), commandId, "place_table");
            if (hotbarMove >= 0 || hotbarMove == -2) {
                return new ControlDecision(shell.stopFrom(effective, "place_table_hotbar_move"), InputState.stop());
            }
        }

        if (player.currentScreenHandler != null && player.currentScreenHandler != player.playerScreenHandler) {
            String handler = player.currentScreenHandler.getClass().getSimpleName();
            PlaceWorkstationPlanner.Decision screenDecision = PlaceWorkstationPlanner.decideOpenScreen(
                true,
                awaitingPlacementVerification,
                handler
            );
            if (screenDecision.action() == PlaceWorkstationPlanner.Action.FAIL_UNEXPECTED_SCREEN_OPENED) {
                String completionReason = finishPlaceTableCommand(commandId, "place_table_failed:place_table_unexpected_screen_opened:" + handler);
                shell.logger().warn(
                    "place_table.failed instanceId={} commandId={} reason=place_table_unexpected_screen_opened handler={} inventoryTables={}",
                    shell.instanceId(),
                    commandId,
                    handler,
                    tables.craftingTableCount()
                );
                shell.completeCurrentCommand(commandId, completionReason, nowMs);
                resetPlaceTableRun();
                return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
            }
            player.closeHandledScreen();
            shell.logger().info(
                "place_table.close_screen instanceId={} commandId={} handler={}",
                shell.instanceId(),
                commandId,
                handler
            );
            return new ControlDecision(shell.stopFrom(effective, "place_table_close_screen_before_place"), InputState.stop());
        }

        shell.clearNavigationState();
        if (WorkstationPlacementSiteTraversal.shouldDriveRoute(awaitingPlacementVerification, activePlacementSite != null)) {
            ControlDecision activeSiteDecision = continuePlacementSiteRoute(
                client, player, effective, "place_table", commandId, nowMs);
            if (activeSiteDecision != null) {
                return activeSiteDecision;
            }
        }
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
            // Cramped-tunnel fallback (observed: MAKE_IRON_TOOLS aborted at iron depth):
            // every neighbor is solid wall, so no support has an open cell above it. CARVE a
            // one-block alcove — dig the head-level wall block; the feet-level wall beneath it then
            // qualifies as support with a freshly open placement cell on the next pass. Terrain
            // allowlist only (never ore / gravity), skipped beside lava or water.
            BlockPos alcoveTarget = selectPlaceTableAlcoveTarget(client, player);
            if (alcoveTarget != null) {
                if (!shell.isLookingAtBlock(player, alcoveTarget)) {
                    return new ControlDecision(shell.lookIntentForBlock(effective, player, alcoveTarget, "place_table_carve_alcove_face"), InputState.stop());
                }
                BlockBreakController.Result carve = shell.blockBreakController().tick(client, player, alcoveTarget, commandId + ":carve_alcove", nowMs);
                shell.logBlockBreakResult(commandId + ":carve_alcove", alcoveTarget, carve);
                if (carve.status() == BlockBreakController.Status.BROKEN) {
                    return new ControlDecision(shell.stopFrom(effective, "place_table_alcove_carved"), InputState.stop());
                }
                if (carve.status() != BlockBreakController.Status.FAILED) {
                    return new ControlDecision(shell.stopFrom(effective, "place_table_carving_alcove:" + carve.reason()), InputState.stop());
                }
                // carve FAILED -> fall through to the original no-support failure.
            }
            ControlDecision siteDecision = resolvePlacementSiteRecovery(
                client, player, effective, "place_table", commandId, "local_and_alcove_unavailable", nowMs);
            if (siteDecision != null) {
                return siteDecision;
            }
            String completionReason = finishPlaceTableCommand(commandId, "place_table_failed:place_table_no_adjacent_support");
            // Diagnostic context (observed: this fired on open W26 surface right after stone
            // mining, where BOTH normal support selection AND the alcove carve found nothing — which
            // should be impossible in a dig pit; the old log couldn't say why). Feet + 4-cardinal
            // support/head block ids let the next occurrence self-explain.
            BlockPos feetPos = player.getBlockPos();
            StringBuilder neighborSummary = new StringBuilder();
            int[][] cardinalDirs = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } };
            for (int[] dir : cardinalDirs) {
                BlockPos supportCell = feetPos.add(dir[0], 0, dir[1]);
                if (neighborSummary.length() > 0) {
                    neighborSummary.append(';');
                }
                neighborSummary
                    .append(dir[0]).append(',').append(dir[1]).append('=')
                    .append(shell.blockId(client.world.getBlockState(supportCell)))
                    .append('/')
                    .append(shell.blockId(client.world.getBlockState(supportCell.up())));
            }
            shell.logger().warn(
                "place_table.failed instanceId={} commandId={} reason=place_table_no_adjacent_support inventoryTables={} feet={} standingOn={} neighbors={}",
                shell.instanceId(),
                commandId,
                tables.craftingTableCount(),
                feetPos.toShortString(),
                shell.blockId(client.world.getBlockState(feetPos.down())),
                neighborSummary
            );
            shell.completeCurrentCommand(commandId, completionReason, nowMs);
            resetPlaceTableRun();
            return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
        }
        McbotFabricClient.LookAngles placeLook = new McbotFabricClient.LookAngles(player.getYaw(), player.getPitch());
        if (!awaitingPlacementVerification) {
            BlockPos placementCell = supportTarget.up();
            BlockState placementState = client.world.getBlockState(placementCell);
            if (McbotFabricClient.isReplaceablePlacementOccluder(placementState)) {
                boolean lookingAtPlacementCell = shell.isLookingAtBlock(player, placementCell);
                PlaceWorkstationPlanner.Decision faceClearDecision = PlaceWorkstationPlanner.decideClearSpace(
                    awaitingPlacementVerification,
                    true,
                    lookingAtPlacementCell,
                    BlockBreakController.Status.RUNNING,
                    ""
                );
                if (faceClearDecision.action() == PlaceWorkstationPlanner.Action.FACE_CLEAR_SPACE) {
                    return new ControlDecision(shell.lookIntentForBlock(effective, player, placementCell, "place_table_clear_replaceable_face"), InputState.stop());
                }
                String clearCommandId = commandId + ":clear_place_space";
                BlockBreakController.Result clearResult = shell.blockBreakController().tick(client, player, placementCell, clearCommandId, nowMs);
                shell.logBlockBreakResult(clearCommandId, placementCell, clearResult);
                PlaceWorkstationPlanner.Decision clearDecision = PlaceWorkstationPlanner.decideClearSpace(
                    awaitingPlacementVerification,
                    true,
                    true,
                    clearResult.status(),
                    clearResult.reason()
                );
                if (clearDecision.action() == PlaceWorkstationPlanner.Action.CLEAR_SPACE_BROKEN) {
                    shell.logger().info(
                        "place_table.clear_space instanceId={} commandId={} target={} reason={} elapsedMs={}",
                        shell.instanceId(),
                        commandId,
                        placementCell.toShortString(),
                        clearResult.reason(),
                        clearResult.elapsedMs()
                    );
                    return new ControlDecision(shell.stopFrom(effective, "place_table_clear_space:" + clearResult.reason()), InputState.stop());
                }
                if (clearDecision.action() == PlaceWorkstationPlanner.Action.FAIL_CLEAR_SPACE) {
                    String completionReason = finishPlaceTableCommand(commandId, "place_table_failed:place_table_clear_space_failed:" + clearResult.reason());
                    shell.logger().warn(
                        "place_table.failed instanceId={} commandId={} reason=place_table_clear_space_failed:{} target={} elapsedMs={}",
                        shell.instanceId(),
                        commandId,
                        clearResult.reason(),
                        placementCell.toShortString(),
                        clearResult.elapsedMs()
                    );
                    shell.completeCurrentCommand(commandId, completionReason, nowMs);
                    resetPlaceTableRun();
                    return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
                }
                return new ControlDecision(shell.lookIntentForBlock(effective, player, placementCell, "place_table_clearing_space:" + clearResult.reason()), InputState.stop());
            }
            Vec3d placementAim = placementAimPointForCell(client, player, placementCell);
            Vec3d supportTop = placementAim == null
                ? new Vec3d(supportTarget.getX() + 0.5D, supportTarget.getY() + 1.0D, supportTarget.getZ() + 0.5D)
                : placementAim;
            placeLook = shell.lookAnglesToPoint(player, supportTop);
            boolean lookAligned = Math.abs(LookController.normalizeYaw(placeLook.yaw() - player.getYaw())) <= McbotFabricClient.WORKSTATION_PLACE_LOOK_TOLERANCE_DEG
                && Math.abs(placeLook.pitch() - player.getPitch()) <= McbotFabricClient.WORKSTATION_PLACE_LOOK_TOLERANCE_DEG;
            PlaceWorkstationPlanner.Decision lookDecision = PlaceWorkstationPlanner.decideLookAlignment(awaitingPlacementVerification, lookAligned);
            if (lookDecision.action() == PlaceWorkstationPlanner.Action.FACE_GROUND) {
                return new ControlDecision(shell.lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "place_table_face_ground"), InputState.stop());
            }
        }

        BlockPlaceController.Result result = shell.blockPlaceController().tick(client, player, commandId, nowMs, supportTarget);
        shell.logger().info(
            "place_table.progress instanceId={} commandId={} reason={} hitBlock={} hitSide={} placedBlock={} selectedHotbarSlot={} elapsedMs={}",
            shell.instanceId(),
            commandId,
            result.reason(),
            McbotFabricClient.formatBlockPos(result.hitBlock()),
            result.hitSide() == null ? "none" : result.hitSide().asString(),
            McbotFabricClient.formatBlockPos(result.placedBlock()),
            result.selectedHotbarSlot(),
            result.elapsedMs()
        );
        PlaceWorkstationPlanner.Decision placementDecision = PlaceWorkstationPlanner.decidePlacementResult(result.status(), result.reason());
        if (placementDecision.action() == PlaceWorkstationPlanner.Action.PLACED) {
            InventoryCounter.InventoryCraftingTableSnapshot after = InventoryCounter.countPlayerCraftingTables(player);
            String completionReason = finishPlaceTableCommand(commandId, "place_table_complete:" + result.reason());
            shell.logger().info(
                "place_table.complete instanceId={} commandId={} reason={} placedBlock={} inventoryTablesBefore={} inventoryTablesAfter={} elapsedMs={}",
                shell.instanceId(),
                commandId,
                result.reason(),
                McbotFabricClient.formatBlockPos(result.placedBlock()),
                activePlaceTableBaselineTables,
                after.craftingTableCount(),
                result.elapsedMs()
            );
            shell.completeCurrentCommand(commandId, completionReason, nowMs);
            resetPlaceTableRun();
            return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
        }
        if (placementDecision.action() == PlaceWorkstationPlanner.Action.FAILED) {
            if (shouldReplanPlacementSite(commandId, "place_table", result.reason())) {
                ControlDecision replan = replanPlacementSite(
                    client, player, effective, activePlacementSite, "placement_out_of_reach", nowMs);
                if (replan != null) {
                    return replan;
                }
            }
            String completionReason = finishPlaceTableCommand(commandId, "place_table_failed:" + result.reason());
            shell.logger().warn(
                "place_table.failed instanceId={} commandId={} reason={} hitBlock={} hitSide={} placedBlock={} inventoryTables={} elapsedMs={}",
                shell.instanceId(),
                commandId,
                result.reason(),
                McbotFabricClient.formatBlockPos(result.hitBlock()),
                result.hitSide() == null ? "none" : result.hitSide().asString(),
                McbotFabricClient.formatBlockPos(result.placedBlock()),
                tables.craftingTableCount(),
                result.elapsedMs()
            );
            shell.completeCurrentCommand(commandId, completionReason, nowMs);
            resetPlaceTableRun();
            return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
        }
        return new ControlDecision(shell.lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "place_table_placing:" + result.reason()), InputState.stop());
    }

    public ControlDecision resolvePlaceFurnace(MinecraftClient client, ClientPlayerEntity player, BrainLink.Intent effective, long nowMs) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (furnaceLedger.isFinished(commandId)) {
            return new ControlDecision(shell.stopFrom(effective, furnaceLedger.reasonOrDefault(commandId, "place_furnace_complete")), InputState.stop());
        }
        InventoryCounter.InventoryItemSnapshot furnaces = InventoryCounter.countPlayerItem(player, "furnace");
        if (!commandId.equals(activePlaceFurnaceCommandId)) {
            clearPlacementSiteState();
            activePlaceFurnaceCommandId = commandId;
            activePlaceFurnaceBaselineFurnaces = furnaces.itemCount();
            activePlaceFurnaceSneakRequired = false;
            activePlaceFurnaceSupportTarget = null;
        }
        boolean awaitingPlacementVerification = shell.blockPlaceController().isAwaitingVerification(commandId);
        PlaceWorkstationPlanner.Decision inventoryDecision = PlaceWorkstationPlanner.decideInventory(
            furnaces.itemCount() >= 1,
            awaitingPlacementVerification,
            "place_furnace_no_furnace"
        );
        if (inventoryDecision.action() == PlaceWorkstationPlanner.Action.FAIL_MISSING_ITEM) {
            String completionReason = finishPlaceFurnaceCommand(commandId, "place_furnace_failed:place_furnace_no_furnace");
            shell.logger().warn(
                "place_furnace.failed instanceId={} commandId={} reason=place_furnace_no_furnace inventoryFurnaces={}",
                shell.instanceId(),
                commandId,
                furnaces.itemCount()
            );
            shell.completeCurrentCommand(commandId, completionReason, nowMs);
            resetPlaceFurnaceRun();
            return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
        }
        if (!awaitingPlacementVerification && shell.findHotbarSlot(player, id -> "furnace".equals(id)) < 0) {
            int hotbarMove = shell.moveInventoryItemToHotbar(client, player, id -> "furnace".equals(id), commandId, "place_furnace");
            if (hotbarMove >= 0 || hotbarMove == -2) {
                return new ControlDecision(shell.stopFrom(effective, "place_furnace_hotbar_move"), InputState.stop());
            }
        }

        if (player.currentScreenHandler != null && player.currentScreenHandler != player.playerScreenHandler) {
            String handler = player.currentScreenHandler.getClass().getSimpleName();
            PlaceWorkstationPlanner.Decision screenDecision = PlaceWorkstationPlanner.decideOpenScreen(
                true,
                awaitingPlacementVerification,
                handler
            );
            if (screenDecision.action() == PlaceWorkstationPlanner.Action.FAIL_UNEXPECTED_SCREEN_OPENED) {
                String completionReason = finishPlaceFurnaceCommand(commandId, "place_furnace_failed:place_furnace_unexpected_screen_opened:" + handler);
                shell.logger().warn(
                    "place_furnace.failed instanceId={} commandId={} reason=place_furnace_unexpected_screen_opened handler={} inventoryFurnaces={}",
                    shell.instanceId(),
                    commandId,
                    handler,
                    furnaces.itemCount()
                );
                shell.completeCurrentCommand(commandId, completionReason, nowMs);
                resetPlaceFurnaceRun();
                return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
            }
            player.closeHandledScreen();
            shell.logger().info(
                "place_furnace.close_screen instanceId={} commandId={} handler={}",
                shell.instanceId(),
                commandId,
                handler
            );
            return new ControlDecision(shell.stopFrom(effective, "place_furnace_close_screen_before_place"), InputState.stop());
        }

        shell.clearNavigationState();
        if (WorkstationPlacementSiteTraversal.shouldDriveRoute(awaitingPlacementVerification, activePlacementSite != null)) {
            ControlDecision activeSiteDecision = continuePlacementSiteRoute(
                client, player, effective, "place_furnace", commandId, nowMs);
            if (activeSiteDecision != null) {
                return activeSiteDecision;
            }
        }
        BlockPos supportTarget = null;
        if (!awaitingPlacementVerification) {
            if (!isValidFurnacePlaceSupport(client, player, activePlaceFurnaceSupportTarget)) {
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
            // Alcove fallback, ported from the table flow (a live run: at a fresh descent-corridor
            // bottom every open cell is a recorded trail cell — correctly excluded since Q1 — so
            // the furnace placement starved and SMELT_IRON exhausted the mission. Carving a
            // one-block wall niche yields an off-corridor support exactly like the table's
            // cramped-tunnel case.)
            BlockPos alcoveTarget = selectPlaceTableAlcoveTarget(client, player);
            if (alcoveTarget != null) {
                if (!shell.isLookingAtBlock(player, alcoveTarget)) {
                    return new ControlDecision(shell.lookIntentForBlock(effective, player, alcoveTarget, "place_furnace_carve_alcove_face"), InputState.stop());
                }
                BlockBreakController.Result carve = shell.blockBreakController().tick(client, player, alcoveTarget, commandId + ":carve_alcove", nowMs);
                shell.logBlockBreakResult(commandId + ":carve_alcove", alcoveTarget, carve);
                if (carve.status() == BlockBreakController.Status.BROKEN) {
                    return new ControlDecision(shell.stopFrom(effective, "place_furnace_alcove_carved"), InputState.stop());
                }
                if (carve.status() != BlockBreakController.Status.FAILED) {
                    return new ControlDecision(shell.stopFrom(effective, "place_furnace_carving_alcove:" + carve.reason()), InputState.stop());
                }
            }
            ControlDecision siteDecision = resolvePlacementSiteRecovery(
                client, player, effective, "place_furnace", commandId, "local_and_alcove_unavailable", nowMs);
            if (siteDecision != null) {
                return siteDecision;
            }
            String completionReason = finishPlaceFurnaceCommand(commandId, "place_furnace_failed:place_furnace_no_adjacent_support");
            shell.logger().warn(
                "place_furnace.failed instanceId={} commandId={} reason=place_furnace_no_adjacent_support inventoryFurnaces={}",
                shell.instanceId(),
                commandId,
                furnaces.itemCount()
            );
            shell.completeCurrentCommand(commandId, completionReason, nowMs);
            resetPlaceFurnaceRun();
            return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
        }
        McbotFabricClient.LookAngles placeLook = new McbotFabricClient.LookAngles(player.getYaw(), player.getPitch());
        if (!awaitingPlacementVerification) {
            BlockPos placementCell = supportTarget.up();
            BlockState placementState = client.world.getBlockState(placementCell);
            if (McbotFabricClient.isReplaceablePlacementOccluder(placementState)) {
                boolean lookingAtPlacementCell = shell.isLookingAtBlock(player, placementCell);
                PlaceWorkstationPlanner.Decision faceClearDecision = PlaceWorkstationPlanner.decideClearSpace(
                    awaitingPlacementVerification,
                    true,
                    lookingAtPlacementCell,
                    BlockBreakController.Status.RUNNING,
                    ""
                );
                if (faceClearDecision.action() == PlaceWorkstationPlanner.Action.FACE_CLEAR_SPACE) {
                    return new ControlDecision(shell.lookIntentForBlock(effective, player, placementCell, "place_furnace_clear_replaceable_face"), InputState.stop());
                }
                String clearCommandId = commandId + ":clear_place_space";
                BlockBreakController.Result clearResult = shell.blockBreakController().tick(client, player, placementCell, clearCommandId, nowMs);
                shell.logBlockBreakResult(clearCommandId, placementCell, clearResult);
                PlaceWorkstationPlanner.Decision clearDecision = PlaceWorkstationPlanner.decideClearSpace(
                    awaitingPlacementVerification,
                    true,
                    true,
                    clearResult.status(),
                    clearResult.reason()
                );
                if (clearDecision.action() == PlaceWorkstationPlanner.Action.CLEAR_SPACE_BROKEN) {
                    shell.logger().info(
                        "place_furnace.clear_space instanceId={} commandId={} target={} reason={} elapsedMs={}",
                        shell.instanceId(),
                        commandId,
                        placementCell.toShortString(),
                        clearResult.reason(),
                        clearResult.elapsedMs()
                    );
                    return new ControlDecision(shell.stopFrom(effective, "place_furnace_clear_space:" + clearResult.reason()), InputState.stop());
                }
                if (clearDecision.action() == PlaceWorkstationPlanner.Action.FAIL_CLEAR_SPACE) {
                    String completionReason = finishPlaceFurnaceCommand(commandId, "place_furnace_failed:place_furnace_clear_space_failed:" + clearResult.reason());
                    shell.logger().warn(
                        "place_furnace.failed instanceId={} commandId={} reason=place_furnace_clear_space_failed:{} target={} elapsedMs={}",
                        shell.instanceId(),
                        commandId,
                        clearResult.reason(),
                        placementCell.toShortString(),
                        clearResult.elapsedMs()
                    );
                    shell.completeCurrentCommand(commandId, completionReason, nowMs);
                    resetPlaceFurnaceRun();
                    return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
                }
                return new ControlDecision(shell.lookIntentForBlock(effective, player, placementCell, "place_furnace_clearing_space:" + clearResult.reason()), InputState.stop());
            }
            Vec3d placementAim = placementAimPointForCell(client, player, placementCell);
            Vec3d supportTop = placementAim == null
                ? new Vec3d(supportTarget.getX() + 0.5D, supportTarget.getY() + 1.0D, supportTarget.getZ() + 0.5D)
                : placementAim;
            placeLook = shell.lookAnglesToPoint(player, supportTop);
            boolean lookAligned = Math.abs(LookController.normalizeYaw(placeLook.yaw() - player.getYaw())) <= McbotFabricClient.WORKSTATION_PLACE_LOOK_TOLERANCE_DEG
                && Math.abs(placeLook.pitch() - player.getPitch()) <= McbotFabricClient.WORKSTATION_PLACE_LOOK_TOLERANCE_DEG;
            PlaceWorkstationPlanner.Decision lookDecision = PlaceWorkstationPlanner.decideLookAlignment(awaitingPlacementVerification, lookAligned);
            if (lookDecision.action() == PlaceWorkstationPlanner.Action.FACE_GROUND) {
                InputState placementPrepInput = activePlaceFurnaceSneakRequired ? sneakOnly() : InputState.stop();
                return new ControlDecision(shell.lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "place_furnace_face_ground"), placementPrepInput);
            }
        }

        BlockPlaceController.Result result = shell.blockPlaceController().tick(
            client,
            player,
            commandId,
            nowMs,
            supportTarget,
            BlockPlaceController.PlaceSpec.furnace()
        );
        activePlaceFurnaceSneakRequired = activePlaceFurnaceSneakRequired || result.sneakRequired();
        shell.logger().info(
            "place_furnace.progress instanceId={} commandId={} reason={} hitBlock={} hitSide={} placedBlock={} selectedHotbarSlot={} sneakRequired={} elapsedMs={}",
            shell.instanceId(),
            commandId,
            result.reason(),
            McbotFabricClient.formatBlockPos(result.hitBlock()),
            result.hitSide() == null ? "none" : result.hitSide().asString(),
            McbotFabricClient.formatBlockPos(result.placedBlock()),
            result.selectedHotbarSlot(),
            result.sneakRequired(),
            result.elapsedMs()
        );
        PlaceWorkstationPlanner.Decision placementDecision = PlaceWorkstationPlanner.decidePlacementResult(result.status(), result.reason());
        if (placementDecision.action() == PlaceWorkstationPlanner.Action.PLACED) {
            InventoryCounter.InventoryItemSnapshot after = InventoryCounter.countPlayerItem(player, "furnace");
            String completionReason = finishPlaceFurnaceCommand(commandId, "place_furnace_complete:" + result.reason());
            shell.logger().info(
                "place_furnace.complete instanceId={} commandId={} reason={} placedBlock={} verifiedBlock=furnace inventoryFurnacesBefore={} inventoryFurnacesAfter={} sneakRequired={} elapsedMs={}",
                shell.instanceId(),
                commandId,
                result.reason(),
                McbotFabricClient.formatBlockPos(result.placedBlock()),
                activePlaceFurnaceBaselineFurnaces,
                after.itemCount(),
                activePlaceFurnaceSneakRequired,
                result.elapsedMs()
            );
            shell.completeCurrentCommand(commandId, completionReason, nowMs);
            resetPlaceFurnaceRun();
            return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
        }
        if (placementDecision.action() == PlaceWorkstationPlanner.Action.FAILED) {
            if (shouldReplanPlacementSite(commandId, "place_furnace", result.reason())) {
                ControlDecision replan = replanPlacementSite(
                    client, player, effective, activePlacementSite, "placement_out_of_reach", nowMs);
                if (replan != null) {
                    return replan;
                }
            }
            String completionReason = finishPlaceFurnaceCommand(commandId, "place_furnace_failed:" + result.reason());
            shell.logger().warn(
                "place_furnace.failed instanceId={} commandId={} reason={} hitBlock={} hitSide={} placedBlock={} inventoryFurnaces={} sneakRequired={} elapsedMs={}",
                shell.instanceId(),
                commandId,
                result.reason(),
                McbotFabricClient.formatBlockPos(result.hitBlock()),
                result.hitSide() == null ? "none" : result.hitSide().asString(),
                McbotFabricClient.formatBlockPos(result.placedBlock()),
                furnaces.itemCount(),
                activePlaceFurnaceSneakRequired || result.sneakRequired(),
                result.elapsedMs()
            );
            shell.completeCurrentCommand(commandId, completionReason, nowMs);
            resetPlaceFurnaceRun();
            return new ControlDecision(shell.stopFrom(effective, completionReason), InputState.stop());
        }
        InputState input = result.sneakRequired() ? sneakOnly() : InputState.stop();
        return new ControlDecision(shell.lookIntentForAngles(effective, placeLook.yaw(), placeLook.pitch(), "place_furnace_placing:" + result.reason()), input);
    }

    private ControlDecision resolvePlacementSiteRecovery(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        String action,
        String commandId,
        String trigger,
        long nowMs
    ) {
        if (client == null || client.world == null || player == null) {
            rejectPlacementSite(action, commandId, trigger, "lost_world_state", nowMs, null, 0);
            return null;
        }
        if (activePlacementSite == null
            || !activePlacementSite.action.equals(action)
            || !activePlacementSite.commandId.equals(commandId)) {
            activePlacementSite = new PlacementSiteRun(action, commandId, trigger, playerFeet(player), nowMs);
        }
        PlacementSiteRun run = activePlacementSite;
        if (!run.route.isEmpty() || run.reached) {
            return continuePlacementSiteRoute(client, player, effective, action, commandId, nowMs);
        }
        if (!WorkstationPlacementSiteTraversal.canCompute(run.routeAttempts)) {
            rejectPlacementSite(action, commandId, trigger, "route_attempt_limit", nowMs, run, 0);
            return null;
        }

        run.routeAttempts++;
        VoxelCell start = playerFeet(player);
        WorldVoxelPerception perception = new WorldVoxelPerception(
            client.world,
            start.x() - 8,
            start.x() + 8,
            start.y() - 4,
            start.y() + 5,
            start.z() - 8,
            start.z() + 8
        );
        List<WorkstationPlacementSitePlanner.Site> sites = placementSites(client, perception);
        WorkstationPlacementSitePlanner.Mode mode = "place_furnace".equals(action)
            ? WorkstationPlacementSitePlanner.Mode.FURNACE
            : WorkstationPlacementSitePlanner.Mode.TABLE;
        double interactionReach = Math.min(4.8D, Math.max(1.0D, player.getBlockInteractionRange()));
        WorkstationPlacementSitePlanner.Result result = WorkstationPlacementSitePlanner.plan(
            perception,
            start,
            sites,
            mode,
            interactionReach,
            run.excludedSupports
        );
        if (!result.found()) {
            rejectPlacementSite(action, commandId, trigger, result.failureReason(), nowMs, run, result.expandedCells());
            return null;
        }
        run.plan = result.plan();
        run.route = result.plan().route();
        run.start = start;
        run.selectedAtMs = nowMs;
        run.lastProgressAtMs = nowMs;
        run.lastFeet = start;
        run.descentLanding = null;
        run.descentLaunchY = Integer.MIN_VALUE;
        shell.blockPlaceController().reset();
        shell.logger().info(
            "workstation.placement_site.selected action={} instanceId={} commandId={} trigger={} start={} stance={} support={} placementCell={} routeLength={} routeAttempt={} expandedCells={} interactionDistance={} verticalDelta={} sneakRequired={} elapsedMs={} reason=reachable_site",
            action,
            shell.instanceId(),
            commandId,
            trigger,
            start,
            run.plan.stance(),
            run.plan.support(),
            run.plan.placement(),
            run.route.size(),
            run.routeAttempts,
            run.plan.expandedCells(),
            McbotFabricClient.roundForLog(run.plan.interactionDistance()),
            run.plan.verticalDelta(),
            run.plan.sneakRequired(),
            Math.max(0L, nowMs - run.startedAtMs)
        );
        return new ControlDecision(shell.stopFrom(effective, action + "_placement_site_selected"), InputState.stop());
    }

    private ControlDecision continuePlacementSiteRoute(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        String action,
        String commandId,
        long nowMs
    ) {
        PlacementSiteRun run = activePlacementSite;
        if (run == null || !run.action.equals(action) || !run.commandId.equals(commandId)) {
            return null;
        }
        if (run.reached) {
            if (plannedSiteStillValid(client, player, run.plan, true)) {
                return null;
            }
            return replanPlacementSite(client, player, effective, run, "support_invalidated", nowMs);
        }
        if (run.plan == null || run.route.isEmpty()) {
            return null;
        }
        if (!plannedSiteStillValid(client, player, run.plan, false)) {
            return replanPlacementSite(client, player, effective, run, "support_invalidated", nowMs);
        }

        VoxelCell feet = playerFeet(player);
        if (WorkstationPlacementSiteTraversal.readyToPlace(
            feet,
            run.plan.stance(),
            isWithinPlaceSupportReach(player, blockPos(run.plan.support()))
        )) {
            run.reached = true;
            BlockPos support = blockPos(run.plan.support());
            if ("place_furnace".equals(action)) {
                activePlaceFurnaceSupportTarget = support;
                activePlaceFurnaceSneakRequired = activePlaceFurnaceSneakRequired || run.plan.sneakRequired();
            } else {
                activePlaceTableSupportTarget = support;
            }
            shell.blockPlaceController().reset();
            shell.logger().info(
                "workstation.placement_site.reached action={} instanceId={} commandId={} trigger={} start={} stance={} support={} placementCell={} routeLength={} routeAttempt={} expandedCells={} interactionDistance={} verticalDelta={} sneakRequired={} elapsedMs={} reason=stance_cell",
                action,
                shell.instanceId(),
                commandId,
                run.trigger,
                run.start,
                run.plan.stance(),
                run.plan.support(),
                run.plan.placement(),
                run.route.size(),
                run.routeAttempts,
                run.plan.expandedCells(),
                McbotFabricClient.roundForLog(run.plan.interactionDistance()),
                run.plan.verticalDelta(),
                run.plan.sneakRequired(),
                Math.max(0L, nowMs - run.selectedAtMs)
            );
            return new ControlDecision(shell.stopFrom(effective, action + "_placement_site_reached"), InputState.stop());
        }

        if (!feet.equals(run.lastFeet)) {
            run.lastFeet = feet;
            run.lastProgressAtMs = nowMs;
        }
        boolean nearRoute = botNearRoute(player, run.route);
        if (WorkstationPlacementSiteTraversal.routeDeviation(run.route, nearRoute)) {
            return replanPlacementSite(client, player, effective, run, "route_deviation", nowMs);
        }
        if (WorkstationPlacementSiteTraversal.routeStalled(run.lastProgressAtMs, nowMs)) {
            return replanPlacementSite(client, player, effective, run, "route_stall", nowMs);
        }
        if (run.descentLanding != null
            && WorkstationPlacementSiteTraversal.descentMissed(feet, run.descentLanding)) {
            return replanPlacementSite(client, player, effective, run, "descent_missed", nowMs);
        }
        if (run.descentLanding != null && player.isOnGround()
            && WorkstationPlacementSiteTraversal.descentLanded(feet, run.descentLaunchY)) {
            if (!feet.equals(run.descentLanding)) {
                return replanPlacementSite(client, player, effective, run, "descent_missed", nowMs);
            }
            run.descentLanding = null;
            run.descentLaunchY = Integer.MIN_VALUE;
            run.lastProgressAtMs = nowMs;
        }
        if (WorkstationPlacementSiteTraversal.holdAirborne(run.descentLanding, player.isOnGround())) {
            return new ControlDecision(
                shell.lookIntentForAngles(effective, player.getYaw(), player.getPitch(), action + "_placement_site_nav3d_descend"),
                new InputState(true, false, false, false, false, false, 1.0F, 0.0F)
            );
        }

        VoxelCell waypoint = run.descentLanding == null ? nextWaypoint(run.route, player) : run.descentLanding;
        VoxelCell landing = WorkstationPlacementSiteTraversal.descentLanding(feet, run.route, waypoint);
        if (run.descentLanding == null && landing != null) {
            run.descentLanding = landing;
            run.descentLaunchY = feet.y();
            waypoint = landing;
        }
        Vec3d aim = new Vec3d(waypoint.x() + 0.5D, waypoint.y(), waypoint.z() + 0.5D);
        McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(player, aim);
        boolean facing = Math.abs(LookController.normalizeYaw(look.yaw() - player.getYaw())) <= 25.0D;
        boolean descending = run.descentLanding != null
            || WorkstationPlacementSiteTraversal.validatedDescentStep(feet, run.route, waypoint);
        boolean stagingAtLip = !descending
            && WorkstationPlacementSiteTraversal.stageBeforeDescent(feet, run.route, waypoint);
        boolean jump = facing && waypoint.y() > feet.y() && player.isOnGround();
        boolean precisionSneak = WorkstationPlacementSiteTraversal.precisionSneak(feet, run.start, descending);
        InputState input = new InputState(
            facing,
            false,
            false,
            false,
            jump,
            stagingAtLip || precisionSneak,
            facing ? 1.0F : 0.0F,
            0.0F
        );
        String driveAction = action + "_placement_site" + WorkstationPlacementSiteTraversal.driveSuffix(descending);
        return new ControlDecision(shell.lookIntentForAngles(effective, look.yaw(), look.pitch(), driveAction), input);
    }

    private ControlDecision replanPlacementSite(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        PlacementSiteRun run,
        String reason,
        long nowMs
    ) {
        if (run.plan != null) {
            run.excludedSupports.add(run.plan.support());
        }
        run.plan = null;
        run.route = List.of();
        run.reached = false;
        run.descentLanding = null;
        run.descentLaunchY = Integer.MIN_VALUE;
        shell.blockPlaceController().reset();
        if ("place_furnace".equals(run.action)) {
            activePlaceFurnaceSupportTarget = null;
        } else {
            activePlaceTableSupportTarget = null;
        }
        if (!WorkstationPlacementSiteTraversal.canCompute(run.routeAttempts)) {
            rejectPlacementSite(run.action, run.commandId, run.trigger, reason, nowMs, run, 0);
            return null;
        }
        return resolvePlacementSiteRecovery(
            client, player, effective, run.action, run.commandId, reason, nowMs);
    }

    private void rejectPlacementSite(
        String action,
        String commandId,
        String trigger,
        String reason,
        long nowMs,
        PlacementSiteRun run,
        int expandedCells
    ) {
        if (run != null && run.rejectedLogged) {
            return;
        }
        if (run != null) {
            run.rejectedLogged = true;
        }
        WorkstationPlacementSitePlanner.Plan plan = run == null ? null : run.plan;
        shell.logger().warn(
            "workstation.placement_site.rejected action={} instanceId={} commandId={} trigger={} start={} stance={} support={} placementCell={} routeLength={} routeAttempt={} expandedCells={} interactionDistance={} verticalDelta={} sneakRequired={} elapsedMs={} reason={}",
            action,
            shell.instanceId(),
            commandId,
            trigger,
            run == null ? null : run.start,
            plan == null ? null : plan.stance(),
            plan == null ? null : plan.support(),
            plan == null ? null : plan.placement(),
            run == null ? 0 : run.route.size(),
            run == null ? 0 : run.routeAttempts,
            expandedCells > 0 ? expandedCells : plan == null ? 0 : plan.expandedCells(),
            plan == null ? 0.0D : McbotFabricClient.roundForLog(plan.interactionDistance()),
            plan == null ? 0 : plan.verticalDelta(),
            plan != null && plan.sneakRequired(),
            run == null ? 0L : Math.max(0L, nowMs - run.startedAtMs),
            reason
        );
    }

    private List<WorkstationPlacementSitePlanner.Site> placementSites(
        MinecraftClient client,
        WorldVoxelPerception perception
    ) {
        List<WorkstationPlacementSitePlanner.Site> sites = new ArrayList<>();
        for (int y = perception.minY(); y < perception.maxY(); y++) {
            for (int z = perception.minZ(); z <= perception.maxZ(); z++) {
                for (int x = perception.minX(); x <= perception.maxX(); x++) {
                    BlockPos support = new BlockPos(x, y, z);
                    BlockPos placement = support.up();
                    BlockState supportState = client.world.getBlockState(support);
                    BlockState placementState = client.world.getBlockState(placement);
                    boolean open = placementState.isAir()
                        || McbotFabricClient.isReplaceablePlacementOccluder(placementState);
                    if (supportState.getCollisionShape(client.world, support).isEmpty() || !open) {
                        continue;
                    }
                    sites.add(new WorkstationPlacementSitePlanner.Site(
                        voxel(support),
                        voxel(placement),
                        true,
                        shell.isAnyOreBlockState(supportState),
                        shell.isOnRecordedDescentTrail(placement),
                        !supportState.getFluidState().isEmpty() || !placementState.getFluidState().isEmpty(),
                        shell.firstAdjacentLavaBlock(client, placement) != null,
                        isInteractiveBlock(supportState),
                        isAdjacentToInteractiveBlock(client, placement)
                    ));
                }
            }
        }
        return sites;
    }

    private boolean plannedSiteStillValid(
        MinecraftClient client,
        ClientPlayerEntity player,
        WorkstationPlacementSitePlanner.Plan plan,
        boolean requireReach
    ) {
        if (client == null || client.world == null || player == null || plan == null) {
            return false;
        }
        BlockPos support = blockPos(plan.support());
        BlockPos placement = blockPos(plan.placement());
        BlockState supportState = client.world.getBlockState(support);
        BlockState placementState = client.world.getBlockState(placement);
        return !supportState.getCollisionShape(client.world, support).isEmpty()
            && !shell.isAnyOreBlockState(supportState)
            && (placementState.isAir() || McbotFabricClient.isReplaceablePlacementOccluder(placementState))
            && !shell.isOnRecordedDescentTrail(placement)
            && supportState.getFluidState().isEmpty()
            && placementState.getFluidState().isEmpty()
            && shell.firstAdjacentLavaBlock(client, placement) == null
            && !("place_table".equals(activePlacementSite.action) && isInteractiveBlock(supportState))
            && (!requireReach || isWithinPlaceSupportReach(player, support));
    }

    private static VoxelCell playerFeet(ClientPlayerEntity player) {
        return new VoxelCell(
            (int) Math.floor(player.getX()),
            (int) Math.floor(player.getY()),
            (int) Math.floor(player.getZ())
        );
    }

    private static VoxelCell voxel(BlockPos pos) {
        return new VoxelCell(pos.getX(), pos.getY(), pos.getZ());
    }

    private static BlockPos blockPos(VoxelCell cell) {
        return new BlockPos(cell.x(), cell.y(), cell.z());
    }

    private static VoxelCell nextWaypoint(List<VoxelCell> route, ClientPlayerEntity player) {
        int closest = 0;
        double closestDistance = Double.MAX_VALUE;
        for (int i = 0; i < route.size(); i++) {
            VoxelCell cell = route.get(i);
            double dx = cell.x() + 0.5D - player.getX();
            double dy = cell.y() - player.getY();
            double dz = cell.z() + 0.5D - player.getZ();
            double distance = dx * dx + dy * dy + dz * dz;
            if (distance <= closestDistance) {
                closestDistance = distance;
                closest = i;
            }
        }
        return route.get(Math.min(closest + 1, route.size() - 1));
    }

    private static boolean botNearRoute(ClientPlayerEntity player, List<VoxelCell> route) {
        for (VoxelCell cell : route) {
            double dx = cell.x() + 0.5D - player.getX();
            double dz = cell.z() + 0.5D - player.getZ();
            if (dx * dx + dz * dz <= 6.25D && Math.abs(cell.y() - player.getY()) <= 3.5D) {
                return true;
            }
        }
        return false;
    }

    private void clearPlacementSiteState() {
        activePlacementSite = null;
    }

    private boolean shouldReplanPlacementSite(String commandId, String action, String reason) {
        return activePlacementSite != null
            && activePlacementSite.reached
            && activePlacementSite.commandId.equals(commandId)
            && activePlacementSite.action.equals(action)
            && reason != null
            && reason.contains("out_of_reach")
            && WorkstationPlacementSiteTraversal.canCompute(activePlacementSite.routeAttempts);
    }

    private void resetPlaceTableRun() {
        activePlaceTableCommandId = "";
        activePlaceTableBaselineTables = 0;
        activePlaceTableSupportTarget = null;
        clearPlacementSiteState();
    }

    private void resetPlaceFurnaceRun() {
        activePlaceFurnaceCommandId = "";
        activePlaceFurnaceBaselineFurnaces = 0;
        activePlaceFurnaceSneakRequired = false;
        activePlaceFurnaceSupportTarget = null;
        clearPlacementSiteState();
        shell.blockPlaceController().reset();
    }

    private String finishPlaceTableCommand(String commandId, String completionReason) {
        tableLedger.markComplete(commandId, completionReason);
        return completionReason;
    }

    private String finishPlaceFurnaceCommand(String commandId, String completionReason) {
        furnaceLedger.markComplete(commandId, completionReason);
        return completionReason;
    }

    // A head-level wall block whose removal creates a table spot in a cramped tunnel: the feet-level
    // wall beneath it becomes a support with a freshly open cell above. Cardinal neighbors only;
    // terrain allowlist for BOTH blocks (never ore, never anything exotic); the block above the
    // alcove must not be a gravity block (it would collapse into the new pocket); and nothing
    // touching the alcove may be lava/water.
    private BlockPos selectPlaceTableAlcoveTarget(MinecraftClient client, ClientPlayerEntity player) {
        if (client == null || client.world == null || player == null) {
            return null;
        }
        BlockPos feet = player.getBlockPos();
        int[][] cardinals = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } };
        for (int[] dir : cardinals) {
            BlockPos support = feet.add(dir[0], 0, dir[1]);
            BlockPos alcove = support.up();
            BlockState supportState = client.world.getBlockState(support);
            BlockState alcoveState = client.world.getBlockState(alcove);
            if (supportState.getCollisionShape(client.world, support).isEmpty()
                || !BlockBreakController.isTerrainOccluderBlockId(shell.blockId(supportState))
                || !BlockBreakController.isTerrainOccluderBlockId(shell.blockId(alcoveState))) {
                continue;
            }
            String aboveAlcoveId = shell.blockId(client.world.getBlockState(alcove.up()));
            if (aboveAlcoveId.equals("gravel") || aboveAlcoveId.equals("sand") || aboveAlcoveId.equals("red_sand")) {
                continue;
            }
            if (shell.firstAdjacentLavaBlock(client, alcove) != null
                || shell.isHazardBlockState(client.world.getBlockState(alcove.add(dir[0], 0, dir[1])))) {
                continue;
            }
            return alcove.toImmutable();
        }
        return null;
    }

    private BlockPos selectPlaceTableSupport(MinecraftClient client, ClientPlayerEntity player) {
        return selectPlaceSupport(client, player, false, false, true);
    }

    private BlockPos selectPlaceFurnaceSupport(MinecraftClient client, ClientPlayerEntity player) {
        BlockPos support = selectPlaceSupport(client, player, true, true, true);
        if (support != null) {
            return support;
        }
        return selectCraftingTableSupportForFurnace(client, player);
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
                // Never bury an ore (observed: the furnace was placed at
                // (11,9,12) with unmined iron as its support — that vein cell became unmineable).
                // Neither the support nor the placement cell may be an ore block.
                if (shell.isAnyOreBlockState(supportState) || shell.isAnyOreBlockState(placeState)) {
                    continue;
                }
                // Never block the recorded descent corridor (repro: the smelt
                // furnace landed ON the return staircase; the breadcrumb replay has no dig, so
                // the return wedged to breadcrumb_stuck and the mission exhausted).
                if (shell.isOnRecordedDescentTrail(place)) {
                    continue;
                }
                if (!placeState.isAir() && !McbotFabricClient.isReplaceablePlacementOccluder(placeState)) {
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

    private BlockPos selectCraftingTableSupportForFurnace(MinecraftClient client, ClientPlayerEntity player) {
        if (client == null || client.world == null || player == null) {
            return null;
        }
        BlockPos origin = player.getBlockPos();
        BlockPos selected = null;
        double bestDistance = Double.MAX_VALUE;
        for (int dy = -1; dy <= 2; dy++) {
            for (int dx = -4; dx <= 4; dx++) {
                for (int dz = -4; dz <= 4; dz++) {
                    BlockPos support = origin.add(dx, dy, dz);
                    if (!client.world.getBlockState(support).isOf(Blocks.CRAFTING_TABLE)) {
                        continue;
                    }
                    BlockPos place = support.up();
                    BlockState placeState = client.world.getBlockState(place);
                    if (placeState == null || (!placeState.isAir() && !McbotFabricClient.isReplaceablePlacementOccluder(placeState))) {
                        continue;
                    }
                    if (shell.isOnRecordedDescentTrail(place)) {
                        continue;
                    }
                    if (new Box(place).intersects(player.getBoundingBox())) {
                        continue;
                    }
                    if (!isWithinPlaceSupportReach(player, support)) {
                        continue;
                    }
                    double distance = player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(support));
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        selected = support.toImmutable();
                    }
                }
            }
        }
        if (selected != null) {
            shell.logger().info(
                "place_furnace.support_fallback instanceId={} support={} supportBlock=crafting_table placedBlock={}",
                shell.instanceId(),
                selected.toShortString(),
                selected.up().toShortString()
            );
        }
        return selected;
    }

    private boolean isValidPlaceSupport(MinecraftClient client, ClientPlayerEntity player, BlockPos support) {
        if (client == null || client.world == null || player == null || support == null) {
            return false;
        }
        BlockPos place = support.up();
        BlockState supportState = client.world.getBlockState(support);
        BlockState placeState = client.world.getBlockState(place);
        return !supportState.getCollisionShape(client.world, support).isEmpty()
            && !isInteractiveBlock(supportState)
            && (placeState.isAir() || McbotFabricClient.isReplaceablePlacementOccluder(placeState))
            && !new Box(place).intersects(player.getBoundingBox())
            && isWithinPlaceSupportReach(player, support);
    }

    private boolean isValidFurnacePlaceSupport(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos support
    ) {
        if (client == null || client.world == null || player == null || support == null) {
            return false;
        }
        BlockPos place = support.up();
        BlockState supportState = client.world.getBlockState(support);
        BlockState placeState = client.world.getBlockState(place);
        return !supportState.getCollisionShape(client.world, support).isEmpty()
            && (placeState.isAir() || McbotFabricClient.isReplaceablePlacementOccluder(placeState))
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
            double reach = Math.min(McbotFabricClient.TABLE_INTERACTION_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
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
        double reach = Math.min(McbotFabricClient.TABLE_INTERACTION_REACH_BLOCKS, Math.max(1.0D, player.getBlockInteractionRange()));
        return player.getEyePos().squaredDistanceTo(topCenter) <= reach * reach;
    }

    private static int[][] placementOffsets(float yaw) {
        int[] forward = McbotFabricClient.cardinalOffset(yaw);
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
            new int[] { (back[0] * 2) + left[0], (back[1] * 2) + left[1] },
            new int[] { 0, 1 },
            new int[] { 1, 1 },
            new int[] { 1, 0 },
            new int[] { 1, -1 },
            new int[] { 0, -1 },
            new int[] { -1, -1 },
            new int[] { -1, 0 },
            new int[] { -1, 1 },
            new int[] { 0, 2 },
            new int[] { 2, 0 },
            new int[] { 0, -2 },
            new int[] { -2, 0 }
        };
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

    private static InputState sneakOnly() {
        return new InputState(false, false, false, false, false, true, 0.0F, 0.0F);
    }

    private static final class PlacementSiteRun {
        private final String action;
        private final String commandId;
        private final String trigger;
        private final long startedAtMs;
        private final Set<VoxelCell> excludedSupports = new HashSet<>();
        private WorkstationPlacementSitePlanner.Plan plan;
        private List<VoxelCell> route = List.of();
        private VoxelCell start;
        private VoxelCell lastFeet;
        private VoxelCell descentLanding;
        private int descentLaunchY = Integer.MIN_VALUE;
        private int routeAttempts;
        private long selectedAtMs;
        private long lastProgressAtMs;
        private boolean reached;
        private boolean rejectedLogged;

        private PlacementSiteRun(String action, String commandId, String trigger, VoxelCell start, long nowMs) {
            this.action = action;
            this.commandId = commandId;
            this.trigger = trigger;
            this.start = start;
            this.startedAtMs = nowMs;
        }
    }

    @Override
    public boolean isFinished(String commandId) {
        return tableLedger.isFinished(commandId) || furnaceLedger.isFinished(commandId);
    }

    @Override
    public String finishedReason(String commandId) {
        String r = tableLedger.reason(commandId);
        return r != null ? r : furnaceLedger.reason(commandId);
    }

    public boolean isFinishedTable(String id) {
        return tableLedger.isFinished(id);
    }

    public boolean isFinishedFurnace(String id) {
        return furnaceLedger.isFinished(id);
    }

    public String finishedReasonTable(String id) {
        return tableLedger.reason(id);
    }

    public String finishedReasonFurnace(String id) {
        return furnaceLedger.reason(id);
    }
}
