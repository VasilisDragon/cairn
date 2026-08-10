package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

final class MiningWorkspaceController {
    private static final long TIMEOUT_MS = 30_000L;
    private final ShellServices shell;
    private final MiningWorkspaceSiteTraversalController siteTraversal =
        new MiningWorkspaceSiteTraversalController();
    private Run active;

    MiningWorkspaceController(ShellServices shell) {
        this.shell = shell;
    }

    Outcome resolve(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        StaircaseDescentPlanner.Direction2d direction,
        List<BlockPos> descentTrail,
        long nowMs
    ) {
        String commandId = effective.commandId() == null ? "" : effective.commandId();
        if (active == null || !active.commandId.equals(commandId)) {
            siteTraversal.clear();
            active = new Run(commandId, nowMs);
        }
        Run run = active;
        if (client == null || client.world == null || player == null) {
            return reject(effective, run, nowMs, "lost_world_state");
        }
        observeVerifiedTraversal(client, player, descentTrail);
        run.actualFeetY = player.getBlockPos().getY();
        if (run.phase != Phase.ROUTE && nowMs - run.startedAtMs >= TIMEOUT_MS) {
            return reject(effective, run, nowMs, "timeout");
        }
        if (run.ready) {
            return new Outcome(new ControlDecision(shell.stopFrom(effective, "mining_workspace_ready"), InputState.stop()), true, "");
        }
        if (run.failureReason != null) {
            return new Outcome(new ControlDecision(shell.stopFrom(effective, "mining_workspace_rejected:" + run.failureReason), InputState.stop()), false, run.failureReason);
        }

        if (run.phase == Phase.PLAN) {
            Outcome planned = plan(client, player, effective, direction, descentTrail, run, nowMs);
            if (planned != null) {
                return planned;
            }
        }
        if (run.phase == Phase.CARVE) {
            Outcome carve = carve(client, player, effective, run, nowMs);
            if (carve != null) {
                return carve;
            }
            if (run.phase == Phase.PLAN) {
                Outcome planned = plan(client, player, effective, direction, descentTrail, run, nowMs);
                if (planned != null) {
                    return planned;
                }
            }
        }
        if (run.phase == Phase.ROUTE) {
            return followRoute(client, player, effective, run, nowMs);
        }
        if (run.phase == Phase.CENTER_STANCE) {
            return centerStance(client, player, effective, run, nowMs);
        }
        if (run.phase == Phase.PLACE_TABLE) {
            BlockPos support = blockPos(run.plan.tableSupport());
            BrainLink.Intent subIntent = shell.makeSubIntent(
                effective,
                "place_table",
                commandId + ":workspace:place_table",
                "mining_workspace_place_table"
            );
            ControlDecision decision = shell.resolveRecoveryPlaceTable(client, player, subIntent, nowMs, support);
            String reason = decision.intent() == null ? "" : decision.intent().reason();
            if (reason.startsWith("place_table_failed:")) {
                return reject(effective, run, nowMs, "table_placement:" + reason);
            }
            if (reason.startsWith("place_table_complete:")) {
                run.phase = Phase.PLACE_FURNACE;
                return new Outcome(
                    new ControlDecision(shell.stopFrom(effective, "mining_workspace_table_ready"), InputState.stop()),
                    false,
                    ""
                );
            }
            return new Outcome(decision, false, "");
        }
        if (run.phase == Phase.PLACE_FURNACE) {
            BlockPos support = blockPos(run.plan.furnaceSupport());
            BrainLink.Intent subIntent = shell.makeSubIntent(
                effective,
                "place_furnace",
                commandId + ":workspace:place_furnace",
                "mining_workspace_place_furnace"
            );
            ControlDecision decision = shell.resolveRecoveryPlaceFurnace(client, player, subIntent, nowMs, support);
            String reason = decision.intent() == null ? "" : decision.intent().reason();
            if (reason.startsWith("place_furnace_failed:")) {
                return reject(effective, run, nowMs, "furnace_placement:" + reason);
            }
            if (reason.startsWith("place_furnace_complete:")) {
                run.phase = Phase.VERIFY;
                return new Outcome(
                    new ControlDecision(shell.stopFrom(effective, "mining_workspace_furnace_ready"), InputState.stop()),
                    false,
                    ""
                );
            }
            return new Outcome(decision, false, "");
        }
        if (run.phase == Phase.VERIFY) {
            BlockPos table = blockPos(run.plan.tablePlacement());
            BlockPos furnace = blockPos(run.plan.furnacePlacement());
            if (!"crafting_table".equals(shell.blockId(client.world.getBlockState(table)))
                || !"furnace".equals(shell.blockId(client.world.getBlockState(furnace)))) {
                return reject(effective, run, nowMs, "placement_verification");
            }
            run.ready = true;
            shell.recordMiningWorkspace(new MiningWorkspaceStore.Workspace(
                run.plan.workspaceId(),
                run.plan.stance(),
                run.plan.tableSupport(),
                run.plan.tablePlacement(),
                run.plan.furnaceSupport(),
                run.plan.furnacePlacement()
            ));
            shell.logger().info(
                "mining.workspace.ready instanceId={} commandId={} workspaceId={} stance={} tableSupport={} tablePlacement={} furnaceSupport={} furnacePlacement={} routeLength={} carveLength={} elapsedMs={} targetY={} actualY={} atTargetDepth={}",
                shell.instanceId(),
                run.commandId,
                run.plan.workspaceId(),
                run.plan.stance(),
                run.plan.tableSupport(),
                run.plan.tablePlacement(),
                run.plan.furnaceSupport(),
                run.plan.furnacePlacement(),
                run.plan.route().size(),
                run.carveBlocks.size(),
                Math.max(0L, nowMs - run.startedAtMs),
                effective.targetY(),
                player.getBlockPos().getY(),
                MiningWorkspaceDepthPolicy.workspaceStanceAllowed(run.plan.stance(), effective.targetY())
            );
            return new Outcome(
                new ControlDecision(shell.stopFrom(effective, "mining_workspace_ready"), InputState.stop()),
                true,
                ""
            );
        }
        return reject(effective, run, nowMs, "invalid_phase");
    }

    private Outcome plan(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        StaircaseDescentPlanner.Direction2d direction,
        List<BlockPos> descentTrail,
        Run run,
        long nowMs
    ) {
        if (run.plannerComputations >= 2) {
            return reject(effective, run, nowMs, "planner_computation_limit");
        }
        run.plannerComputations++;
        VoxelCell start = feet(player);
        WorldVoxelPerception perception = new WorldVoxelPerception(
            client.world,
            start.x() - 6,
            start.x() + 6,
            start.y() - 3,
            start.y() + 4,
            start.z() - 6,
            start.z() + 6
        );
        MiningWorkspacePlanner.Result result = MiningWorkspacePlanner.plan(
            perception,
            start,
            sites(client, perception, descentTrail, effective.targetY()),
            Math.min(4.8D, Math.max(1.0D, player.getBlockInteractionRange())),
            run.excludedWorkspaceIds
        );
        if (!result.found()) {
            if (run.plannerComputations == 1 && run.carveBlocks.isEmpty()) {
                List<BlockPos> carve = carvePlan(client, player.getBlockPos(), direction);
                MiningWorkspacePlanner.CarveResult validated = MiningWorkspacePlanner.validateCarve(
                    new MiningWorkspacePlanner.CarveOption(
                        carve.stream().map(MiningWorkspaceController::voxel).toList(),
                        carve.stream().noneMatch(pos -> shell.isAnyOreBlockState(client.world.getBlockState(pos))),
                        carve.stream().noneMatch(pos -> pos.getY() < player.getBlockPos().getY()),
                        carve.stream().allMatch(pos -> fluidBoundaryClosed(client, pos)),
                        carve.stream().allMatch(pos -> hazardBoundaryClosed(client, pos))
                    )
                );
                if (validated.accepted()) {
                    run.carveBlocks = carve;
                    run.phase = Phase.CARVE;
                    shell.logger().info(
                        "mining.workspace.carve_started instanceId={} commandId={} trigger={} start={} carveLength={} plannerAttempt={} elapsedMs={} reason={}",
                        shell.instanceId(),
                        run.commandId,
                        "no_open_workspace",
                        start,
                        carve.size(),
                        run.plannerComputations,
                        Math.max(0L, nowMs - run.startedAtMs),
                        result.failureReason()
                    );
                    return new Outcome(
                        new ControlDecision(shell.stopFrom(effective, "mining_workspace_carve_selected"), InputState.stop()),
                        false,
                        ""
                    );
                }
            }
            return reject(effective, run, nowMs, result.failureReason());
        }
        run.plan = result.plan();
        if (!MiningWorkspaceDepthPolicy.workspaceStanceAllowed(run.plan.stance(), effective.targetY())) {
            return reject(effective, run, nowMs, "outside_target_depth");
        }
        if (!siteTraversal.begin(
            run.plan.route(),
            start,
            nowMs,
            run.startedAtMs + TIMEOUT_MS
        )) {
            return reject(effective, run, nowMs, "site_route_invalid");
        }
        run.phase = Phase.ROUTE;
        shell.logger().info(
            "mining.workspace.selected instanceId={} commandId={} workspaceId={} trigger={} start={} stance={} tableSupport={} tablePlacement={} furnaceSupport={} furnacePlacement={} routeLength={} plannerAttempt={} expandedCells={} interactionDistance={} verticalDelta={} sneakRequired={} carveLength={} elapsedMs={} targetY={} actualY={} atTargetDepth={}",
            shell.instanceId(),
            run.commandId,
            run.plan.workspaceId(),
            run.carveBlocks.isEmpty() ? "open_workspace" : "post_carve",
            start,
            run.plan.stance(),
            run.plan.tableSupport(),
            run.plan.tablePlacement(),
            run.plan.furnaceSupport(),
            run.plan.furnacePlacement(),
            run.plan.route().size(),
            run.plannerComputations,
            run.plan.expandedCells(),
            String.format(Locale.ROOT, "%.3f", run.plan.interactionDistance()),
            run.plan.verticalDelta(),
            run.plan.furnaceSneakRequired(),
            run.carveBlocks.size(),
            Math.max(0L, nowMs - run.startedAtMs),
            effective.targetY(),
            player.getBlockPos().getY(),
            MiningWorkspaceDepthPolicy.workspaceStanceAllowed(run.plan.stance(), effective.targetY())
        );
        return new Outcome(
            new ControlDecision(shell.stopFrom(effective, "mining_workspace_selected"), InputState.stop()),
            false,
            ""
        );
    }

    private Outcome carve(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        Run run,
        long nowMs
    ) {
        while (run.carveIndex < run.carveBlocks.size()
            && client.world.getBlockState(run.carveBlocks.get(run.carveIndex)).isAir()) {
            run.carveIndex++;
        }
        if (run.carveIndex >= run.carveBlocks.size()) {
            run.phase = Phase.PLAN;
            shell.blockBreakController().reset();
            return null;
        }
        BlockPos target = run.carveBlocks.get(run.carveIndex);
        BlockPos requestedConflict = firstCanonicalCarveConflict(
            target,
            null,
            null,
            shell::isCanonicalDescentTrailSupport,
            shell::isOnRecordedDescentTrail
        );
        if (requestedConflict != null) {
            shell.blockBreakController().reset();
            logCanonicalCarveVeto(run, target, requestedConflict, "requested_cell", nowMs);
            return reject(
                effective,
                run,
                nowMs,
                "carve_canonical_surface_trail:" + requestedConflict.toShortString()
            );
        }
        BlockState state = client.world.getBlockState(target);
        if (state.getHardness(client.world, target) < 0.0F
            || shell.isAnyOreBlockState(state)
            || shell.isHazardBlockState(state)
            || !state.getFluidState().isEmpty()
            || !fluidBoundaryClosed(client, target)
            || !hazardBoundaryClosed(client, target)) {
            return reject(effective, run, nowMs, "unsafe_carve_cell:" + target.toShortString());
        }
        BlockPos approach = carveApproachCell(client, player, target);
        if (approach != null
            && horizontalDistanceSquared(player.getPos(), Vec3d.ofBottomCenter(approach)) > 0.35D) {
            shell.blockBreakController().reset();
            Vec3d aim = new Vec3d(approach.getX() + 0.5D, player.getEyeY(), approach.getZ() + 0.5D);
            McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(player, aim);
            boolean facing = Math.abs(LookController.normalizeYaw(look.yaw() - player.getYaw())) <= 25.0D;
            return new Outcome(
                new ControlDecision(
                    shell.lookIntentForAngles(effective, look.yaw(), look.pitch(), "mining_workspace_carve_approach"),
                    new InputState(
                        facing,
                        false,
                        false,
                        false,
                        false,
                        false,
                        facing ? 1.0F : 0.0F,
                        0.0F
                    )
                ),
                false,
                ""
            );
        }
        Vec3d breakAim = new Vec3d(target.getX() + 0.5D, target.getY() + 0.8D, target.getZ() + 0.5D);
        McbotFabricClient.LookAngles breakLook = shell.lookAnglesToPoint(player, breakAim);
        boolean aimed = Math.abs(LookController.normalizeYaw(breakLook.yaw() - player.getYaw())) <= 4.0D
            && Math.abs(breakLook.pitch() - player.getPitch()) <= 4.0D;
        if (!aimed) {
            return new Outcome(
                new ControlDecision(
                    shell.lookIntentForAngles(
                        effective,
                        breakLook.yaw(),
                        breakLook.pitch(),
                        "mining_workspace_carve_face"
                    ),
                    InputState.stop()
                ),
                false,
                ""
            );
        }
        String breakCommand = run.commandId + ":workspace:carve:" + run.carveIndex;
        BlockBreakController.Result broken = shell.blockBreakController().tick(
            client,
            player,
            target,
            breakCommand,
            nowMs,
            false,
            12_000L,
            true
        );
        shell.logBlockBreakResult(breakCommand, target, broken);
        BlockPos redirectedConflict = firstCanonicalCarveConflict(
            null,
            broken.hitBlock(),
            broken.actedBlock(),
            shell::isCanonicalDescentTrailSupport,
            shell::isOnRecordedDescentTrail
        );
        if (redirectedConflict != null) {
            // BlockBreakController only describes the interaction here. The central interaction
            // authority applies it after this controller returns, so dropping the interaction
            // result and resetting the breaker prevents even the first damage tick on the leased
            // trail cell.
            shell.blockBreakController().reset();
            logCanonicalCarveVeto(run, target, redirectedConflict, "redirected_raycast", nowMs);
            return reject(
                effective,
                run,
                nowMs,
                "carve_canonical_surface_trail_redirect:" + redirectedConflict.toShortString()
            );
        }
        if (broken.status() == BlockBreakController.Status.FAILED) {
            return withInteraction(
                reject(effective, run, nowMs, "carve_failed:" + broken.reason()),
                broken
            );
        }
        if (broken.status() == BlockBreakController.Status.BROKEN) {
            run.carveIndex++;
        }
        return new Outcome(
            withInteraction(
                new ControlDecision(shell.stopFrom(effective, "mining_workspace_carving:" + broken.reason()), InputState.stop()),
                broken
            ),
            false,
            ""
        );
    }

    static BlockPos firstCanonicalCarveConflict(
        BlockPos requested,
        BlockPos hit,
        BlockPos acted,
        Predicate<BlockPos> isCanonicalSupport,
        Predicate<BlockPos> isCanonicalOccupancy
    ) {
        BlockPos[] candidates = {requested, acted, hit};
        for (BlockPos candidate : candidates) {
            if (candidate == null) {
                continue;
            }
            if ((isCanonicalSupport != null && isCanonicalSupport.test(candidate))
                || (isCanonicalOccupancy != null && isCanonicalOccupancy.test(candidate))) {
                return candidate;
            }
        }
        return null;
    }

    private void logCanonicalCarveVeto(
        Run run,
        BlockPos requested,
        BlockPos conflict,
        String phase,
        long nowMs
    ) {
        shell.logger().warn(
            "mining.workspace.carve_rejected instanceId={} commandId={} workspaceId={} phase={} requested={} conflict={} elapsedMs={} reason=canonical_surface_trail_lease",
            shell.instanceId(),
            run == null ? "" : run.commandId,
            run == null || run.plan == null ? "" : run.plan.workspaceId(),
            phase,
            requested == null ? "unknown" : requested.toShortString(),
            conflict == null ? "unknown" : conflict.toShortString(),
            run == null ? 0L : Math.max(0L, nowMs - run.startedAtMs)
        );
    }

    private BlockPos carveApproachCell(
        MinecraftClient client,
        ClientPlayerEntity player,
        BlockPos target
    ) {
        BlockPos best = null;
        double bestDistance = Double.MAX_VALUE;
        int feetY = player.getBlockPos().getY();
        for (Direction direction : List.of(Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST)) {
            BlockPos candidate = new BlockPos(
                target.getX() + direction.getOffsetX(),
                feetY,
                target.getZ() + direction.getOffsetZ()
            );
            if (!client.world.getBlockState(candidate).isAir()
                || !client.world.getBlockState(candidate.up()).isAir()
                || !shell.isStableDescentSupport(client, candidate.down())) {
                continue;
            }
            double distance = horizontalDistanceSquared(player.getPos(), Vec3d.ofBottomCenter(candidate));
            if (distance < bestDistance) {
                bestDistance = distance;
                best = candidate.toImmutable();
            }
        }
        return best;
    }

    private static double horizontalDistanceSquared(Vec3d first, Vec3d second) {
        double dx = first.x - second.x;
        double dz = first.z - second.z;
        return (dx * dx) + (dz * dz);
    }

    private Outcome followRoute(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        Run run,
        long nowMs
    ) {
        VoxelCell feet = feet(player);
        VoxelCell waypoint = siteTraversal.activeWaypoint();
        VoxelCell perceptionGoal = waypoint == null ? run.plan.stance() : waypoint;
        WorldVoxelPerception perception = new WorldVoxelPerception(
            client.world,
            feet,
            perceptionGoal,
            8,
            4
        );
        Predicate<VoxelCell> waypointValidator = cell ->
            SurfaceReturnTrailGapPlanner.safeCell(perception, cell);
        boolean currentSafe = waypointValidator.test(feet);
        McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(
            player,
            new Vec3d(
                perceptionGoal.x() + 0.5D,
                perceptionGoal.y(),
                perceptionGoal.z() + 0.5D
            )
        );
        boolean aligned = Math.abs(
            LookController.normalizeYaw(look.yaw() - player.getYaw())
        ) <= 24.0D;
        MiningWorkspaceSiteTraversalController.Step step = siteTraversal.tick(
            new MiningWorkspaceSiteTraversalController.Observation(
                feet,
                player.getX(),
                player.getY(),
                player.getZ(),
                player.isOnGround(),
                aligned,
                !player.isTouchingWater() && currentSafe,
                currentSafe,
                currentSafe
            ),
            waypointValidator,
            nowMs
        );
        emitSiteTraversalEvents(run, feet, step);

        if (step.outcome() == MiningWorkspaceSiteTraversalController.Outcome.REJECTED) {
            return reject(effective, run, nowMs, step.reason());
        }
        if (step.outcome() == MiningWorkspaceSiteTraversalController.Outcome.REACHED) {
            run.phase = Phase.CENTER_STANCE;
            return new Outcome(
                new ControlDecision(
                    shell.stopFrom(effective, "mining_workspace_site_traversal_stance_reached"),
                    InputState.stop()
                ),
                false,
                ""
            );
        }
        if (step.outcome() == MiningWorkspaceSiteTraversalController.Outcome.IDLE
            || step.waypoint() == null) {
            return reject(effective, run, nowMs, "site_route_inactive");
        }

        VoxelCell driveTarget = step.waypoint();
        McbotFabricClient.LookAngles driveLook = shell.lookAnglesToPoint(
            player,
            new Vec3d(
                driveTarget.x() + 0.5D,
                driveTarget.y(),
                driveTarget.z() + 0.5D
            )
        );
        String driveReason = step.descentExempt()
            ? "mining_workspace_site_traversal_nav3d_descend"
            : "mining_workspace_site_traversal_nav3d";
        InputState input = new InputState(
            step.forward(),
            false,
            false,
            false,
            step.jump(),
            false,
            step.forward() ? 1.0F : 0.0F,
            0.0F
        );
        return new Outcome(
            new ControlDecision(
                shell.lookIntentForAnglesAtBlock(
                    effective,
                    driveLook.yaw(),
                    driveLook.pitch(),
                    blockPos(driveTarget),
                    driveReason
                ),
                input
            ),
            false,
            ""
        );
    }

    private Outcome centerStance(
        MinecraftClient client,
        ClientPlayerEntity player,
        BrainLink.Intent effective,
        Run run,
        long nowMs
    ) {
        VoxelCell feet = feet(player);
        WorldVoxelPerception perception = new WorldVoxelPerception(
            client.world,
            feet,
            run.plan.stance(),
            1,
            2
        );
        if (!feet.equals(run.plan.stance())
            || !SurfaceReturnTrailGapPlanner.safeCell(perception, feet)) {
            return reject(effective, run, nowMs, "final_stance_invalidated");
        }
        Vec3d center = new Vec3d(feet.x() + 0.5D, player.getY(), feet.z() + 0.5D);
        if (horizontalDistanceSquared(player.getPos(), center) > 0.0225D) {
            McbotFabricClient.LookAngles look = shell.lookAnglesToPoint(player, center);
            boolean facing = Math.abs(
                LookController.normalizeYaw(look.yaw() - player.getYaw())
            ) <= 25.0D;
            return new Outcome(
                new ControlDecision(
                    shell.lookIntentForAnglesAtBlock(
                        effective,
                        look.yaw(),
                        look.pitch(),
                        blockPos(feet),
                        "mining_workspace_stance_center"
                    ),
                    new InputState(
                        facing,
                        false,
                        false,
                        false,
                        false,
                        false,
                        facing ? 1.0F : 0.0F,
                        0.0F
                    )
                ),
                false,
                ""
            );
        }
        run.phase = Phase.PLACE_TABLE;
        return new Outcome(
            new ControlDecision(
                shell.stopFrom(effective, "mining_workspace_stance_centered"),
                InputState.stop()
            ),
            false,
            ""
        );
    }

    private void emitSiteTraversalEvents(
        Run run,
        VoxelCell actualFeet,
        MiningWorkspaceSiteTraversalController.Step step
    ) {
        if (step.waypointAdvanced()) {
            logSiteTraversalEvent(
                "progress",
                run,
                actualFeet,
                step,
                step.forwardResynchronized()
                    ? "forward_resynchronization"
                    : "waypoint_reached"
            );
        }
        if (step.stepUpStarted()) {
            logSiteTraversalEvent("step_up_started", run, actualFeet, step, step.reason());
        }
        if (step.stepUpCompleted()) {
            logSiteTraversalEvent("step_up_landed", run, actualFeet, step, step.reason());
        }
        if (step.descentSelected()) {
            logSiteTraversalEvent("descent_selected", run, actualFeet, step, step.reason());
        }
        if (step.descentStarted()) {
            logSiteTraversalEvent("descent_started", run, actualFeet, step, step.reason());
        }
        if (step.descentDeparted()) {
            logSiteTraversalEvent("descent_departed", run, actualFeet, step, step.reason());
        }
        if (step.descentLanded()) {
            logSiteTraversalEvent("descent_landed", run, actualFeet, step, step.reason());
        }
        if (step.stanceReached()
            || step.outcome() == MiningWorkspaceSiteTraversalController.Outcome.REACHED) {
            logSiteTraversalEvent("stance_reached", run, actualFeet, step, step.reason());
        }
        if (step.outcome() == MiningWorkspaceSiteTraversalController.Outcome.REJECTED) {
            logSiteTraversalEvent("rejected", run, actualFeet, step, step.reason());
        }
    }

    private void logSiteTraversalEvent(
        String event,
        Run run,
        VoxelCell actualFeet,
        MiningWorkspaceSiteTraversalController.Step step,
        String reason
    ) {
        shell.logger().info(
            "mining.workspace.site_traversal." + event
                + " instanceId={} commandId={} workspaceId={} routeAttempt={} routeLength={}"
                + " waypoint={} waypointIndex={} remainingCells={} stableFeet={} actualFeet={}"
                + " maximumWaypointIndex={} progressAgeMs={} stepUpPhase={} descentPhase={}"
                + " elapsedMs={} remainingDeadlineMs={} reason={}",
            shell.instanceId(),
            run.commandId,
            run.plan == null ? "" : run.plan.workspaceId(),
            run.plannerComputations,
            run.plan == null ? 0 : run.plan.route().size(),
            step.waypoint(),
            step.waypointIndex(),
            step.remainingCells(),
            step.stableFeet(),
            actualFeet,
            step.maximumWaypointIndex(),
            step.lastProgressAgeMs(),
            step.stepUpPhase(),
            step.descentPhase(),
            step.elapsedMs(),
            step.remainingDeadlineMs(),
            reason
        );
    }

    private Outcome reject(BrainLink.Intent effective, Run run, long nowMs, String reason) {
        VoxelCell rejectionFeet = siteTraversal.stableFeet();
        run.failureReason = reason == null || reason.isBlank() ? "unknown" : reason;
        shell.blockBreakController().reset();
        shell.logger().warn(
            "mining.workspace.rejected instanceId={} commandId={} workspaceId={} start={} stance={} tableSupport={} tablePlacement={} furnaceSupport={} furnacePlacement={} routeLength={} plannerAttempts={} carveLength={} elapsedMs={} targetY={} actualY={} atTargetDepth={} reason={}",
            shell.instanceId(),
            run.commandId,
            run.plan == null ? "" : run.plan.workspaceId(),
            rejectionFeet,
            run.plan == null ? null : run.plan.stance(),
            run.plan == null ? null : run.plan.tableSupport(),
            run.plan == null ? null : run.plan.tablePlacement(),
            run.plan == null ? null : run.plan.furnaceSupport(),
            run.plan == null ? null : run.plan.furnacePlacement(),
            run.plan == null ? 0 : run.plan.route().size(),
            run.plannerComputations,
            run.carveBlocks.size(),
            Math.max(0L, nowMs - run.startedAtMs),
            effective.targetY(),
            run.actualFeetY,
            run.plan != null && MiningWorkspaceDepthPolicy.workspaceStanceAllowed(run.plan.stance(), effective.targetY()),
            run.failureReason
        );
        siteTraversal.clear();
        return new Outcome(
            new ControlDecision(shell.stopFrom(effective, "mining_workspace_rejected:" + run.failureReason), InputState.stop()),
            false,
            run.failureReason
        );
    }

    private List<MiningWorkspacePlanner.Site> sites(
        MinecraftClient client,
        WorldVoxelPerception perception,
        List<BlockPos> descentTrail,
        Double targetY
    ) {
        Set<BlockPos> trail = new HashSet<>();
        if (descentTrail != null) {
            for (BlockPos feet : descentTrail) {
                if (feet != null) {
                    trail.add(feet);
                    trail.add(feet.up());
                }
            }
        }
        List<MiningWorkspacePlanner.Site> sites = new ArrayList<>();
        for (int y = perception.minY(); y < perception.maxY(); y++) {
            for (int z = perception.minZ(); z <= perception.maxZ(); z++) {
                for (int x = perception.minX(); x <= perception.maxX(); x++) {
                    BlockPos support = new BlockPos(x, y, z);
                    BlockPos placement = support.up();
                    if (!MiningWorkspaceDepthPolicy.workspaceStanceAllowed(voxel(placement), targetY)) {
                        continue;
                    }
                    BlockState supportState = client.world.getBlockState(support);
                    BlockState placementState = client.world.getBlockState(placement);
                    boolean open = placementState.isAir()
                        || McbotFabricClient.isReplaceablePlacementOccluder(placementState);
                    if (supportState.getCollisionShape(client.world, support).isEmpty() || !open) {
                        continue;
                    }
                    sites.add(new MiningWorkspacePlanner.Site(
                        voxel(support),
                        voxel(placement),
                        true,
                        shell.isAnyOreBlockState(supportState),
                        trail.contains(placement) || shell.isOnRecordedDescentTrail(placement),
                        !supportState.getFluidState().isEmpty() || !placementState.getFluidState().isEmpty(),
                        shell.firstAdjacentLavaBlock(client, placement) != null,
                        gravityBlock(shell.blockId(supportState)),
                        interactiveBlock(shell.blockId(supportState)),
                        adjacentInteractive(client, placement)
                    ));
                }
            }
        }
        return sites;
    }

    private List<BlockPos> carvePlan(
        MinecraftClient client,
        BlockPos start,
        StaircaseDescentPlanner.Direction2d direction
    ) {
        if (direction == null) {
            return List.of();
        }
        int firstBlocked = -1;
        for (int distance = 1; distance <= 6; distance++) {
            BlockPos feet = start.add(direction.dx() * distance, 0, direction.dz() * distance);
            if (!client.world.getBlockState(feet).isAir() || !client.world.getBlockState(feet.up()).isAir()) {
                firstBlocked = distance;
                break;
            }
        }
        if (firstBlocked < 0) {
            return List.of();
        }
        int end = Math.min(6, firstBlocked + 1);
        List<BlockPos> carve = new ArrayList<>();
        for (int distance = firstBlocked; distance <= end; distance++) {
            BlockPos feet = start.add(direction.dx() * distance, 0, direction.dz() * distance);
            if (!client.world.getBlockState(feet.up()).isAir()) {
                carve.add(feet.up().toImmutable());
            }
            if (!client.world.getBlockState(feet).isAir()) {
                carve.add(feet.toImmutable());
            }
        }
        BlockPos stance = start.add(direction.dx() * end, 0, direction.dz() * end);
        int sideX = -direction.dz();
        int sideZ = direction.dx();
        for (int sign : new int[] { -1, 1 }) {
            BlockPos placement = stance.add(sideX * sign, 0, sideZ * sign);
            if (!client.world.getBlockState(placement.up()).isAir()) {
                carve.add(placement.up().toImmutable());
            }
            if (!client.world.getBlockState(placement).isAir()) {
                carve.add(placement.toImmutable());
            }
        }
        return carve.size() <= MiningWorkspacePlanner.MAX_CARVE_BLOCKS ? List.copyOf(carve) : List.of();
    }

    private boolean fluidBoundaryClosed(MinecraftClient client, BlockPos cell) {
        for (Direction direction : Direction.values()) {
            if (!client.world.getBlockState(cell.offset(direction)).getFluidState().isEmpty()) {
                return false;
            }
        }
        return true;
    }

    private boolean hazardBoundaryClosed(MinecraftClient client, BlockPos cell) {
        for (Direction direction : Direction.values()) {
            if (shell.isHazardBlockState(client.world.getBlockState(cell.offset(direction)))) {
                return false;
            }
        }
        return true;
    }

    private boolean adjacentInteractive(MinecraftClient client, BlockPos placement) {
        for (Direction direction : Direction.values()) {
            if (interactiveBlock(shell.blockId(client.world.getBlockState(placement.offset(direction))))) {
                return true;
            }
        }
        return false;
    }

    private static boolean gravityBlock(String id) {
        return id != null && (
            id.endsWith("sand")
                || "gravel".equals(id)
                || id.endsWith("concrete_powder")
        );
    }

    private static boolean interactiveBlock(String id) {
        return id != null && (
            id.contains("crafting_table")
                || id.contains("furnace")
                || id.contains("chest")
                || id.contains("barrel")
                || id.contains("shulker_box")
        );
    }

    private static VoxelCell feet(ClientPlayerEntity player) {
        return voxel(player.getBlockPos());
    }

    private static VoxelCell voxel(BlockPos pos) {
        return new VoxelCell(pos.getX(), pos.getY(), pos.getZ());
    }

    private static BlockPos blockPos(VoxelCell cell) {
        return new BlockPos(cell.x(), cell.y(), cell.z());
    }

    record Outcome(ControlDecision decision, boolean ready, String failureReason) {
    }

    boolean activeFor(String commandId) {
        return active != null
            && active.commandId.equals(commandId == null ? "" : commandId)
            && !active.ready
            && active.failureReason == null;
    }

    /**
     * The planner-owned, true-Y route that was physically completed before the workspace became
     * ready. Descent uses this to extend its canonical surface trail across terminal workspace
     * establishment; callers receive no route until readiness is verified.
     */
    List<VoxelCell> readyRouteFor(String commandId) {
        String expected = commandId == null ? "" : commandId;
        if (active == null
            || !active.commandId.equals(expected)
            || !active.ready
            || active.plan == null) {
            return List.of();
        }
        return active.plan.route();
    }

    private static void observeVerifiedTraversal(
        MinecraftClient client,
        ClientPlayerEntity player,
        List<BlockPos> descentTrail
    ) {
        if (client == null || client.world == null || player == null || descentTrail == null) {
            return;
        }
        VoxelCell current = feet(player);
        VoxelCell previous = descentTrail.isEmpty()
            ? current
            : voxel(descentTrail.getLast());
        WorldVoxelPerception perception = new WorldVoxelPerception(
            client.world,
            previous,
            current,
            2,
            3
        );
        appendVerifiedTraversal(
            descentTrail,
            perception,
            current,
            player.isOnGround() && !player.isTouchingWater()
        );
    }

    /**
     * Record the actual dry, grounded workspace-establishment walk. The planner route begins only
     * after a carve has opened a site, so it cannot by itself account for movement made while
     * carving toward that site. Keeping this canonical trace lets the enclosing descent append one
     * continuous surface-return segment instead of leaving a gap at the terminal workspace.
     */
    static boolean appendVerifiedTraversal(
        List<BlockPos> traversed,
        GatherWoodLocalEgressPerception perception,
        VoxelCell current,
        boolean groundedAndDry
    ) {
        if (traversed == null
            || perception == null
            || current == null
            || !groundedAndDry
            || !SurfaceReturnTrailGapPlanner.safeCell(perception, current)) {
            return false;
        }
        if (traversed.isEmpty()) {
            traversed.add(blockPos(current));
            return true;
        }
        VoxelCell frontier = voxel(traversed.getLast());
        if (current.equals(frontier)) {
            return false;
        }
        BlockPos currentBlock = blockPos(current);
        int existing = traversed.indexOf(currentBlock);
        if (existing >= 0) {
            traversed.subList(existing + 1, traversed.size()).clear();
            return true;
        }
        if (frontier.x() == current.x() && frontier.z() == current.z()) {
            return false;
        }
        if (SurfaceReturnTrailGapPlanner.reversibleStep(perception, frontier, current)) {
            traversed.add(currentBlock);
            return true;
        }
        List<VoxelCell> immutableTrail = traversed.stream()
            .map(MiningWorkspaceController::voxel)
            .toList();
        SurfaceReturnTrailGapPlanner.Result gap = SurfaceReturnTrailGapPlanner.plan(
            perception,
            frontier,
            current,
            immutableTrail
        );
        if (!gap.found()) {
            return false;
        }
        for (VoxelCell cell : gap.connector().subList(1, gap.connector().size())) {
            traversed.add(blockPos(cell));
        }
        return true;
    }

    void clear() {
        active = null;
        siteTraversal.clear();
        shell.blockBreakController().reset();
    }

    private static Outcome withInteraction(
        Outcome outcome,
        BlockBreakController.Result result
    ) {
        if (outcome == null) {
            return null;
        }
        return new Outcome(
            withInteraction(outcome.decision(), result),
            outcome.ready(),
            outcome.failureReason()
        );
    }

    private static ControlDecision withInteraction(
        ControlDecision decision,
        BlockBreakController.Result result
    ) {
        if (decision == null || result == null) {
            return decision;
        }
        return new ControlDecision(
            decision.intent(),
            decision.input(),
            decision.lookDemand(),
            decision.legacyLookDemand(),
            decision.locomotionDemand(),
            result.interactionDemand(),
            result.interactionPayload()
        );
    }

    private enum Phase {
        PLAN,
        CARVE,
        ROUTE,
        CENTER_STANCE,
        PLACE_TABLE,
        PLACE_FURNACE,
        VERIFY
    }

    private static final class Run {
        final String commandId;
        final long startedAtMs;
        final Set<String> excludedWorkspaceIds = new HashSet<>();
        Phase phase = Phase.PLAN;
        MiningWorkspacePlanner.Plan plan;
        List<BlockPos> carveBlocks = List.of();
        int carveIndex;
        int plannerComputations;
        boolean ready;
        String failureReason;
        int actualFeetY;

        Run(String commandId, long startedAtMs) {
            this.commandId = commandId;
            this.startedAtMs = startedAtMs;
        }
    }
}
