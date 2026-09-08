package com.mcbot.fabricclient;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.Entity;
import net.minecraft.entity.mob.HostileEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.text.Text;
import net.minecraft.util.Hand;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * R6 survival reflex executor. Owns both the decision (via {@link SurvivalPlanner}) and the
 * execution (eat / retreat / logout), mirroring {@link BlockBreakController}: the god class
 * just calls {@link #tick} each client tick and, when the result is active, applies the input
 * and preempts the normal control path. This keeps survival in the fast loop (never waiting on
 * the brain) and out of the god class.
 *
 * <p>Eating uses the real interaction manager: {@code interactItem} is fired once per bite and
 * only re-fired when the player is no longer using an item, so the vanilla consume timer is
 * never reset. No inventory injection, no instant heal — fully legitimate.
 */
final class SurvivalController {
    private static final Logger LOGGER = LoggerFactory.getLogger("mcbot-fabric-survival");
    private static final long EAT_TIMEOUT_MS = 12_000L;
    // --- Water recovery constants, ported from the proven mineflayer water-escape system
    // (src/reactive/reactive.js): scored dry-land selection, stall-based target relock with an
    // avoid-list, and a dry-stable debounce so control is only released on solid ground.
    private static final int WATER_LAND_SEARCH_RADIUS = 6;
    private static final int WATER_LAND_ADJACENCY_PENALTY = 16;
    private static final int WATER_EXIT_MAX_RISE = 1;
    private static final long WATER_ESCAPE_STALL_RELOCK_MS = 2_500L;
    private static final long WATER_ESCAPE_STALLED_TARGET_TTL_MS = 10_000L;
    private static final double WATER_ESCAPE_PROGRESS_DELTA_SQ = 0.04D;
    private static final long WATER_DRY_STABLE_DEBOUNCE_MS = 800L;
    private static final long WATER_ESCAPE_GIVE_UP_MS = 30_000L;
    // Don't take the irreversible auto-logout in the first moments after connecting. A freshly loaded
    // save (or a harness world-restore) can read low health/food for a tick or two before setup
    // (heal / food / difficulty) is applied; ragequitting on the very first tick would abort the run
    // before any command could start. Eat/retreat are unaffected — only the one-way LOGOUT defers.
    private static final long LOGOUT_STARTUP_GRACE_MS = 4_000L;

    private final String instanceId;
    private final SurvivalPlanner.Config config;

    private SurvivalPlanner.State state = SurvivalPlanner.State.idle();
    private long dryStableSinceMs = 0L;
    private long wadeStartedAtMs = 0L;
    private long lastFallingLogMs = 0L;
    private BlockPos waterEscapeTarget = null;
    private GatherWoodLocalEgressPlanner.Plan waterEscapePlan = null;
    private int waterEscapeComputations = 0;
    private long waterEscapeNextScanAtMs = 0L;
    private double waterEscapeBestDistSq = Double.MAX_VALUE;
    private long waterEscapeImprovedAtMs = 0L;
    private Vec3d waterEscapeLastPos = null;
    private long waterEscapeMovedAtMs = 0L;
    private final Map<BlockPos, Long> waterEscapeAvoid = new HashMap<>();
    private long eatStartedMs = 0L;
    private int foodAtEatStart = -1;
    private boolean ateFoodLogged = false;
    private long eatEpisode = 0L;
    private String eatGestureIdentity = "";
    private SurvivalPlanner.Action lastLoggedAction = SurvivalPlanner.Action.NONE;
    private long lastHeartbeatMs = 0L;
    private long firstTickMs = 0L;
    private boolean startupGraceLogged = false;

    SurvivalController(String instanceId) {
        this(instanceId, SurvivalPlanner.Config.defaults());
    }

    SurvivalController(String instanceId, SurvivalPlanner.Config config) {
        this.instanceId = instanceId == null ? "" : instanceId;
        this.config = config == null ? SurvivalPlanner.Config.defaults() : config;
    }

    record Result(
        boolean active,
        InputState input,
        SurvivalPlanner.Action action,
        String reason,
        int foodLevel,
        float health,
        LookDemand lookDemand,
        InteractionDemand interactionDemand,
        FabricInteractionAuthority.Payload interactionPayload
    ) {
        Result(
            boolean active,
            InputState input,
            SurvivalPlanner.Action action,
            String reason,
            int foodLevel,
            float health
        ) {
            this(active, input, action, reason, foodLevel, health, null, null, null);
        }

        Result(
            boolean active,
            InputState input,
            SurvivalPlanner.Action action,
            String reason,
            int foodLevel,
            float health,
            LookDemand lookDemand
        ) {
            this(active, input, action, reason, foodLevel, health, lookDemand, null, null);
        }

        static Result inactive() {
            return new Result(false, InputState.stop(), SurvivalPlanner.Action.NONE, "ok", 0, 0.0F);
        }
    }

    Result tick(MinecraftClient client, ClientPlayerEntity player, long nowMs) {
        if (client == null || client.world == null || client.interactionManager == null || player == null) {
            state = SurvivalPlanner.State.idle();
            return Result.inactive();
        }
        if (firstTickMs == 0L) {
            firstTickMs = nowMs;
        }

        float health = player.getHealth();
        int foodLevel = player.getHungerManager().getFoodLevel();
        int foodSlot = findFoodSlot(player);
        boolean hasEdibleFood = foodSlot >= 0 && foodLevel < 20;
        boolean onGround = player.isOnGround();
        double hostile = nearestHostileDistance(client, player);

        // P0.1 falling watcher (log-only): any significant airborne fall gets a ledger entry with
        // position context, so remaining fall sources stay diagnosable even when survived.
        if (!player.isOnGround() && player.fallDistance > 10.0F && nowMs - lastFallingLogMs > 1_000L) {
            lastFallingLogMs = nowMs;
            LOGGER.warn(
                "r6_survival.falling instanceId={} fallDistance={} x={} y={} z={}",
                instanceId,
                String.format(Locale.ROOT, "%.1f", player.fallDistance),
                (int) Math.floor(player.getX()),
                (int) Math.floor(player.getY()),
                (int) Math.floor(player.getZ())
            );
        }

        // Dry-stable debounce (mineflayer waterEscapeClearStatus port): the wade-out phase only
        // releases control after the bot has been out of the water AND on the ground continuously
        // for the debounce window — a momentary surface pop no longer counts as "recovered".
        boolean dryNow = !player.isTouchingWater() && !player.isSubmergedInWater() && onGround;
        if (dryNow) {
            if (dryStableSinceMs == 0L) {
                dryStableSinceMs = nowMs;
            }
        } else {
            dryStableSinceMs = 0L;
        }
        boolean dryStable = dryStableSinceMs != 0L && nowMs - dryStableSinceMs >= WATER_DRY_STABLE_DEBOUNCE_MS;

        SurvivalPlanner.Observation obs = new SurvivalPlanner.Observation(
            health,
            foodLevel,
            hasEdibleFood,
            onGround,
            hostile,
            player.isTouchingWater(),
            player.isSubmergedInWater(),
            player.getAir(),
            dryStable
        );
        SurvivalPlanner.Mode prevMode = state.mode();
        SurvivalPlanner.Decision decision = SurvivalPlanner.decide(state, obs, config);
        state = decision.state();

        switch (decision.action()) {
            case EAT -> {
                if (prevMode != SurvivalPlanner.Mode.EATING) {
                    eatStartedMs = nowMs;
                    foodAtEatStart = foodLevel;
                    ateFoodLogged = false;
                    eatEpisode++;
                    eatGestureIdentity = "survival:eat:" + eatEpisode;
                    log("eat_start", foodLevel, health, decision.reason());
                }
                if (nowMs - eatStartedMs > EAT_TIMEOUT_MS && foodLevel <= foodAtEatStart) {
                    state = SurvivalPlanner.State.idle();
                    log("eat_timeout", foodLevel, health, "no_progress");
                    lastLoggedAction = SurvivalPlanner.Action.NONE;
                    return Result.inactive();
                }
                if (!ateFoodLogged && foodLevel > foodAtEatStart) {
                    log("ate_food", foodLevel, health, decision.reason());
                    ateFoodLogged = true;
                }
                EatInteraction eatInteraction = prepareEatInteraction(player, foodSlot);
                lastLoggedAction = SurvivalPlanner.Action.EAT;
                return new Result(
                    true,
                    InputState.stop(),
                    SurvivalPlanner.Action.EAT,
                    decision.reason(),
                    foodLevel,
                    health,
                    eatInteraction != null
                        ? criticalLook(
                            SurvivalPlanner.Action.EAT,
                            "eat",
                            player.getYaw(),
                            -75.0F,
                            "eat_use"
                        )
                        : null,
                    eatInteraction == null ? null : eatInteraction.demand(),
                    eatInteraction == null ? null : eatInteraction.payload()
                );
            }
            case RETREAT -> {
                if (lastLoggedAction != SurvivalPlanner.Action.RETREAT) {
                    log("retreat", foodLevel, health, decision.reason());
                }
                lastLoggedAction = SurvivalPlanner.Action.RETREAT;
                return new Result(true, retreatInput(), SurvivalPlanner.Action.RETREAT, decision.reason(), foodLevel, health);
            }
            case SWIM_UP -> {
                if (lastLoggedAction != SurvivalPlanner.Action.SWIM_UP) {
                    log("swim_up", foodLevel, health, decision.reason() + ":air=" + player.getAir());
                }
                lastLoggedAction = SurvivalPlanner.Action.SWIM_UP;
                return new Result(
                    true,
                    swimUpInput(),
                    SurvivalPlanner.Action.SWIM_UP,
                    decision.reason(),
                    foodLevel,
                    health,
                    criticalLook(
                        SurvivalPlanner.Action.SWIM_UP,
                        "swim_up",
                        player.getYaw(),
                        -75.0F,
                        "swim_up_surface"
                    )
                );
            }
            case SWIM_TO_SHORE -> {
                if (prevMode != SurvivalPlanner.Mode.WADING_OUT) {
                    wadeStartedAtMs = nowMs;
                    resetWaterEscapeTarget();
                    log("swim_to_shore", foodLevel, health, decision.reason());
                }
                if (nowMs - wadeStartedAtMs > WATER_ESCAPE_GIVE_UP_MS) {
                    state = SurvivalPlanner.State.idle();
                    resetWaterEscapeTarget();
                    log("swim_to_shore_give_up", foodLevel, health, "timeout_ms=" + WATER_ESCAPE_GIVE_UP_MS);
                    lastLoggedAction = SurvivalPlanner.Action.NONE;
                    return Result.inactive();
                }
                lastLoggedAction = SurvivalPlanner.Action.SWIM_TO_SHORE;
                ShoreControl control = swimToShoreControl(client, player, nowMs);
                return new Result(
                    true,
                    control.input(),
                    SurvivalPlanner.Action.SWIM_TO_SHORE,
                    decision.reason(),
                    foodLevel,
                    health,
                    control.lookDemand()
                );
            }
            case LOGOUT -> {
                if (nowMs - firstTickMs < LOGOUT_STARTUP_GRACE_MS) {
                    // Defer the one-way ragequit until the world/setup has had a moment to settle.
                    if (!startupGraceLogged) {
                        log("logout_deferred_startup_grace", foodLevel, health, decision.reason());
                        startupGraceLogged = true;
                    }
                    state = SurvivalPlanner.State.idle();
                    lastLoggedAction = SurvivalPlanner.Action.NONE;
                    return Result.inactive();
                }
                if (lastLoggedAction != SurvivalPlanner.Action.LOGOUT) {
                    log("logout", foodLevel, health, decision.reason());
                    requestLogout(client, decision.reason());
                }
                lastLoggedAction = SurvivalPlanner.Action.LOGOUT;
                return new Result(true, InputState.stop(), SurvivalPlanner.Action.LOGOUT, decision.reason(), foodLevel, health);
            }
            default -> {
                if (prevMode == SurvivalPlanner.Mode.EATING) {
                    log("complete", foodLevel, health, decision.reason());
                } else if (prevMode == SurvivalPlanner.Mode.WADING_OUT) {
                    log("swim_to_shore_complete", foodLevel, health, decision.reason());
                    resetWaterEscapeTarget();
                } else if (nowMs - lastHeartbeatMs > 2000L) {
                    lastHeartbeatMs = nowMs;
                    LOGGER.info(
                        "r6_survival.idle instanceId={} food={} health={} hasFood={} foodSlot={} hostile={}",
                        instanceId,
                        foodLevel,
                        String.format(Locale.ROOT, "%.1f", health),
                        hasEdibleFood,
                        foodSlot,
                        String.format(Locale.ROOT, "%.1f", hostile)
                    );
                }
                lastLoggedAction = SurvivalPlanner.Action.NONE;
                return Result.inactive();
            }
        }
    }

    /**
     * Select the food slot, then describe one continuous human-style right-click hold. The final
     * interaction authority applies the hold after the critical gaze commit and owns its release.
     */
    private EatInteraction prepareEatInteraction(ClientPlayerEntity player, int foodSlot) {
        if (foodSlot >= 0 && player.getInventory().selectedSlot != foodSlot) {
            player.getInventory().selectedSlot = foodSlot;
            return null; // let the hotbar swap settle one tick before using the item
        }
        if (foodSlot < 0) {
            return null;
        }
        ItemStack stack = player.getInventory().getStack(foodSlot);
        if (stack == null || stack.isEmpty() || !stack.contains(DataComponentTypes.FOOD)) {
            return null;
        }
        String itemId = net.minecraft.registry.Registries.ITEM.getId(stack.getItem()).getPath();
        String gesture = eatGestureIdentity.isBlank()
            ? "survival:eat:" + Math.max(1L, eatEpisode)
            : eatGestureIdentity;
        return new EatInteraction(
            InteractionDemand.holdItem(
                gesture + ":hold",
                LookDemand.Owner.SURVIVAL,
                "survival",
                "eat",
                gesture,
                "food:" + foodSlot + ":" + itemId,
                "eat_use"
            ),
            FabricInteractionAuthority.Payload.item(Hand.MAIN_HAND)
        );
    }

    private record EatInteraction(
        InteractionDemand demand,
        FabricInteractionAuthority.Payload payload
    ) {
    }

    /** Back-pedal to create distance while keeping the threat in view. R7 combat refines this. */
    private static InputState retreatInput() {
        return new InputState(false, true, false, false, false, false, -1.0F, 0.0F);
    }

    /** Hold jump to ascend in water (vanilla swim-up) until air recovers at the surface. */
    private static InputState swimUpInput() {
        return new InputState(false, false, false, false, true, false, 0.0F, 0.0F);
    }

    /**
     * Drive toward the locked dry-land target: face it, swim forward (jump keeps the head up while
     * in water; plain walking takes over on the shore). With no land in range, tread water and keep
     * rescanning — strictly better than handing control back to a mission that would sink the bot.
     */
    private ShoreControl swimToShoreControl(MinecraftClient client, ClientPlayerEntity player, long nowMs) {
        boolean inWater = player.isTouchingWater();
        if (inWater) {
            maintainWaterEscapeTarget(client, player, nowMs);
        }
        if (waterEscapeTarget == null) {
            return new ShoreControl(
                new InputState(false, false, false, false, inWater, false, 0.0F, 0.0F),
                criticalLook(
                    SurvivalPlanner.Action.SWIM_TO_SHORE,
                    "no_target",
                    player.getYaw(),
                    -10.0F,
                    "swim_to_shore_no_target"
                )
            );
        }
        VoxelCell feet = new VoxelCell(
            (int) Math.floor(player.getX()),
            (int) Math.floor(player.getY()),
            (int) Math.floor(player.getZ())
        );
        VoxelCell waypoint = waterEscapePlan == null
            ? new VoxelCell(waterEscapeTarget.getX(), waterEscapeTarget.getY(), waterEscapeTarget.getZ())
            : GatherWoodLocalEgressTraversal.nextWaypoint(waterEscapePlan.path(), feet);
        if (waypoint == null) {
            waypoint = new VoxelCell(waterEscapeTarget.getX(), waterEscapeTarget.getY(), waterEscapeTarget.getZ());
        }
        double dx = (waypoint.x() + 0.5D) - player.getX();
        double dz = (waypoint.z() + 0.5D) - player.getZ();
        double yaw = Math.toDegrees(Math.atan2(-dx, dz));
        // Slightly up in water (stay at the surface while swimming), slightly down on land (walk
        // naturally toward the cell instead of staring at the sky).
        double pitch = inWater ? -10.0F : 10.0F;
        return new ShoreControl(
            new InputState(true, false, false, false, inWater, false, 1.0F, 0.0F),
            criticalLook(
                SurvivalPlanner.Action.SWIM_TO_SHORE,
                blockIdentity(waterEscapeTarget) + ":via:" + waypoint,
                yaw,
                pitch,
                "swim_to_shore_locked_target"
            )
        );
    }

    private static LookDemand criticalLook(
        SurvivalPlanner.Action action,
        String targetIdentity,
        double yaw,
        double pitch,
        String reason
    ) {
        return new LookDemand(
            LookDemand.Owner.SURVIVAL,
            "survival:" + action.name().toLowerCase(Locale.ROOT) + ":" + targetIdentity,
            LookDemand.Profile.CRITICAL,
            yaw,
            pitch,
            LookDemand.RetargetPolicy.IMMEDIATE,
            "survival",
            reason
        );
    }

    private static String blockIdentity(BlockPos pos) {
        return pos.getX() + ":" + pos.getY() + ":" + pos.getZ();
    }

    private record ShoreControl(InputState input, LookDemand lookDemand) {}

    /**
     * Keep a usable dry-land target locked (mineflayer relock policy): pick the best-scored cell,
     * track horizontal progress toward it, and on stall (no improvement AND no movement for the
     * relock window) blacklist it for the avoid TTL and pick another.
     */
    private void maintainWaterEscapeTarget(MinecraftClient client, ClientPlayerEntity player, long nowMs) {
        waterEscapeAvoid.values().removeIf(expiry -> expiry <= nowMs);
        if (waterEscapeTarget != null && !isDryLandCell(client, waterEscapeTarget)) {
            waterEscapeTarget = null; // target flooded/blocked since lock
            waterEscapePlan = null;
        }
        if (waterEscapeTarget != null) {
            Vec3d pos = player.getPos();
            double tx = (waterEscapeTarget.getX() + 0.5D) - pos.getX();
            double tz = (waterEscapeTarget.getZ() + 0.5D) - pos.getZ();
            double horizontalDistSq = tx * tx + tz * tz;
            if (horizontalDistSq < waterEscapeBestDistSq - WATER_ESCAPE_PROGRESS_DELTA_SQ) {
                waterEscapeBestDistSq = horizontalDistSq;
                waterEscapeImprovedAtMs = nowMs;
            }
            if (waterEscapeLastPos == null || GatherWoodLocalEgressTraversal.movedHorizontally(
                pos.getX(),
                pos.getZ(),
                waterEscapeLastPos.getX(),
                waterEscapeLastPos.getZ(),
                WATER_ESCAPE_PROGRESS_DELTA_SQ
            )) {
                waterEscapeLastPos = pos;
                waterEscapeMovedAtMs = nowMs;
            }
            boolean stalled = nowMs - waterEscapeImprovedAtMs >= WATER_ESCAPE_STALL_RELOCK_MS
                && nowMs - waterEscapeMovedAtMs >= WATER_ESCAPE_STALL_RELOCK_MS;
            if (stalled) {
                waterEscapeAvoid.put(waterEscapeTarget, nowMs + WATER_ESCAPE_STALLED_TARGET_TTL_MS);
                LOGGER.info(
                    "r6_survival.swim_to_shore_relock instanceId={} stalledTarget={} avoided={}",
                    instanceId,
                    waterEscapeTarget.toShortString(),
                    waterEscapeAvoid.size()
                );
                waterEscapeTarget = null;
                waterEscapePlan = null;
            }
        }
        if (waterEscapeTarget == null
            && nowMs >= waterEscapeNextScanAtMs
            && GatherWoodLocalEgressTraversal.canCompute(waterEscapeComputations)) {
            GatherWoodLocalEgressPlanner.Result result = planConnectedWaterExit(client, player);
            waterEscapeComputations += 1;
            if (result.found()) {
                waterEscapePlan = result.plan();
                VoxelCell anchor = waterEscapePlan.anchor();
                waterEscapeTarget = new BlockPos(anchor.x(), anchor.y(), anchor.z());
                waterEscapeBestDistSq = Double.MAX_VALUE;
                waterEscapeImprovedAtMs = nowMs;
                waterEscapeLastPos = null;
                waterEscapeMovedAtMs = nowMs;
                LOGGER.info(
                    "r6_survival.swim_to_shore_target instanceId={} target={} mode={} pathLength={} attempt={} examinedCells={} reason={}",
                    instanceId,
                    waterEscapeTarget.toShortString(),
                    waterEscapePlan.mode().eventName(),
                    waterEscapePlan.path().size(),
                    waterEscapeComputations,
                    waterEscapePlan.examinedCells(),
                    waterEscapePlan.reason()
                );
            } else {
                waterEscapeNextScanAtMs = nowMs + 1_000L;
                LOGGER.info(
                    "r6_survival.swim_to_shore_no_path instanceId={} attempt={} examinedCells={} reason={}",
                    instanceId,
                    waterEscapeComputations,
                    result.examinedCells(),
                    result.failureReason()
                );
            }
        }
    }

    private GatherWoodLocalEgressPlanner.Result planConnectedWaterExit(
        MinecraftClient client,
        ClientPlayerEntity player
    ) {
        if (client == null || client.world == null || player == null) {
            return new GatherWoodLocalEgressPlanner.Result(null, null, 0, "invalid_request");
        }
        VoxelCell raw = new VoxelCell(
            (int) Math.floor(player.getX()),
            (int) Math.floor(player.getY()),
            (int) Math.floor(player.getZ())
        );
        int horizontal = GatherWoodLocalEgressPlanner.WATER_HORIZONTAL_RADIUS + 1;
        int vertical = GatherWoodLocalEgressPlanner.WATER_VERTICAL_RADIUS + 2;
        WorldVoxelPerception perception = new WorldVoxelPerception(
            client.world,
            raw.x() - horizontal,
            raw.x() + horizontal,
            raw.y() - vertical,
            raw.y() + vertical,
            raw.z() - horizontal,
            raw.z() + horizontal
        );
        Set<VoxelCell> excluded = new HashSet<>();
        for (BlockPos avoided : waterEscapeAvoid.keySet()) {
            excluded.add(new VoxelCell(avoided.getX(), avoided.getY(), avoided.getZ()));
        }
        return GatherWoodLocalEgressPlanner.plan(
            perception,
            raw,
            player.getY(),
            player.isOnGround(),
            player.isTouchingWater(),
            null,
            excluded
        );
    }

    /**
     * Scored dry-land scan (mineflayer findNearestDryLand port): nearest cell with solid dry
     * ground and two air blocks of body space, at most {@code WATER_EXIT_MAX_RISE} above the
     * current feet level, penalized when bordered by more water (don't exit onto a one-block
     * island), skipping cells on the stall avoid-list.
     */
    private BlockPos findNearestDryLand(MinecraftClient client, ClientPlayerEntity player, long nowMs) {
        BlockPos base = player.getBlockPos();
        BlockPos best = null;
        int bestScore = Integer.MAX_VALUE;
        for (int dx = -WATER_LAND_SEARCH_RADIUS; dx <= WATER_LAND_SEARCH_RADIUS; dx++) {
            for (int dz = -WATER_LAND_SEARCH_RADIUS; dz <= WATER_LAND_SEARCH_RADIUS; dz++) {
                for (int dy = -2; dy <= 3; dy++) {
                    if (dy > WATER_EXIT_MAX_RISE) {
                        continue;
                    }
                    BlockPos feet = base.add(dx, dy, dz);
                    Long avoidUntil = waterEscapeAvoid.get(feet);
                    if (avoidUntil != null && avoidUntil > nowMs) {
                        continue;
                    }
                    if (!isDryLandCell(client, feet)) {
                        continue;
                    }
                    int score = dx * dx + dy * dy + dz * dz + dryLandWaterAdjacencyPenalty(client, feet);
                    if (score < bestScore) {
                        bestScore = score;
                        best = feet.toImmutable();
                    }
                }
            }
        }
        return best;
    }

    private boolean isDryLandCell(MinecraftClient client, BlockPos feet) {
        if (client == null || client.world == null || feet == null) {
            return false;
        }
        BlockState ground = client.world.getBlockState(feet.down());
        BlockState feetState = client.world.getBlockState(feet);
        BlockState head = client.world.getBlockState(feet.up());
        return !ground.getCollisionShape(client.world, feet.down()).isEmpty()
            && ground.getFluidState().isEmpty()
            && feetState.isAir()
            && head.isAir();
    }

    private int dryLandWaterAdjacencyPenalty(MinecraftClient client, BlockPos feet) {
        BlockPos[] neighbors = {feet.north(), feet.south(), feet.east(), feet.west()};
        for (BlockPos neighbor : neighbors) {
            if (!client.world.getBlockState(neighbor).getFluidState().isEmpty()
                || !client.world.getBlockState(neighbor.down()).getFluidState().isEmpty()) {
                return WATER_LAND_ADJACENCY_PENALTY;
            }
        }
        return 0;
    }

    private void resetWaterEscapeTarget() {
        waterEscapeTarget = null;
        waterEscapePlan = null;
        waterEscapeComputations = 0;
        waterEscapeNextScanAtMs = 0L;
        waterEscapeBestDistSq = Double.MAX_VALUE;
        waterEscapeImprovedAtMs = 0L;
        waterEscapeLastPos = null;
        waterEscapeMovedAtMs = 0L;
        waterEscapeAvoid.clear();
    }

    private void requestLogout(MinecraftClient client, String reason) {
        client.execute(() -> {
            ClientPlayNetworkHandler handler = client.getNetworkHandler();
            if (handler != null) {
                handler.getConnection().disconnect(Text.literal("mcbot_r6_survival:" + reason));
            }
        });
    }

    private static int findFoodSlot(ClientPlayerEntity player) {
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack != null && !stack.isEmpty() && stack.contains(DataComponentTypes.FOOD)) {
                return slot;
            }
        }
        return -1;
    }

    private static double nearestHostileDistance(MinecraftClient client, ClientPlayerEntity player) {
        double nearestSquared = Double.POSITIVE_INFINITY;
        for (Entity entity : client.world.getEntities()) {
            if (entity instanceof HostileEntity && entity.isAlive()) {
                nearestSquared = Math.min(nearestSquared, entity.squaredDistanceTo(player));
            }
        }
        return Double.isFinite(nearestSquared) ? Math.sqrt(nearestSquared) : -1.0D;
    }

    private void log(String event, int foodLevel, float health, String reason) {
        LOGGER.info(
            "r6_survival.{} instanceId={} food={} health={} reason={}",
            event,
            instanceId,
            foodLevel,
            String.format(Locale.ROOT, "%.1f", health),
            reason
        );
    }
}
