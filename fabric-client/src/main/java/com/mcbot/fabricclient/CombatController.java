package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.Entity;
import net.minecraft.entity.mob.HostileEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.text.Text;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * R7 combat reflex executor. Owns the decision (via {@link CombatPlanner}) and the execution
 * (engage / flee / logout), mirroring {@link SurvivalController}: the god class calls {@link #tick}
 * each client tick and, when the result is active, applies the input and preempts the normal control
 * path. Runs as a higher-priority guard than the survival/eat reflex — threat response comes first.
 *
 * <p>Engagement is legitimate: the bot faces the target with a turn-rate-limited look (no aimbot
 * snap), approaches on its own feet, and only swings when it is actually aligned on the target, has
 * clear line of sight (a real collider raycast — no through-wall hits), is within melee reach, and a
 * human-plausible swing cadence has elapsed. First slice: one weak hostile; groups/ranged/creeper
 * tactics and the late-game fights are out of scope.
 */
final class CombatController {
    private static final Logger LOGGER = LoggerFactory.getLogger("mcbot-fabric-combat");
    private static final double LOOK_MAX_DEG_PER_TICK = 12.0D;
    private static final double ATTACK_ALIGN_DEG = 12.0D;
    private static final double MELEE_REACH = 3.0D;
    private static final long ATTACK_INTERVAL_MS = 600L; // ~iron sword full-charge cadence
    private static final double FLEE_ESCAPE_DISTANCE = 12.0D; // opened a safe gap from the threat
    private static final float FLEE_SAFE_HEALTH = 16.0F;
    private static final int CORNERED_STUCK_TICKS = 8; // ~0.4s of no movement while fleeing -> cornered
    private static final double CORNERED_MOVE_EPS = 0.05D;
    private static final int ESCAPE_RADIUS = 10; // local grid half-extent for escape routing
    private static final int ESCAPE_MAX_CELLS = 1024;
    private static final long ESCAPE_RECOMPUTE_MS = 1000L;
    private static final double ESCAPE_ARRIVE_EPS = 0.45D;
    private static final double KITE_MAX_DISTANCE = 14.0D;
    private static final long KITE_SWITCH_MS = 700L;
    private static final long BOXED_LOGOUT_GRACE_MS = 12_000L;

    private final String instanceId;
    private final CombatPlanner.Config config;
    private final FabricMotionMode motionMode;

    private CombatPlanner.State state = CombatPlanner.State.idle();
    private Entity target;
    private long lastAttackMs = 0L;
    private long lastHeartbeatMs = 0L;
    private CombatPlanner.Action lastLoggedAction = CombatPlanner.Action.NONE;
    private boolean fleeSafeLogged = false;
    private double fleePrevX = 0.0D;
    private double fleePrevZ = 0.0D;
    private int fleeStuckTicks = 0;
    private List<GridCell> escapeRoute = List.of();
    private int escapeWaypointIndex = 0;
    private PathFollower.Progress escapeProgress = PathFollower.Progress.initial();
    private long escapeRouteComputedMs = 0L;
    private int kiteDirection = 1;
    private long lastKiteSwitchMs = 0L;
    private long lastKiteLogMs = 0L;
    private String lastTargetLogKey = "";
    private boolean boxedLogoutRequested = false;
    private long fleeStartedMs = 0L;
    private PendingAttack pendingAttack;
    private long attackRequestSequence = 0L;

    CombatController(String instanceId) {
        this(instanceId, CombatPlanner.Config.defaults(), FabricMotionMode.LEGACY);
    }

    CombatController(String instanceId, CombatPlanner.Config config) {
        this(instanceId, config, FabricMotionMode.LEGACY);
    }

    CombatController(String instanceId, FabricMotionMode motionMode) {
        this(instanceId, CombatPlanner.Config.defaults(), motionMode);
    }

    CombatController(String instanceId, CombatPlanner.Config config, FabricMotionMode motionMode) {
        this.instanceId = instanceId == null ? "" : instanceId;
        this.config = config == null ? CombatPlanner.Config.defaults() : config;
        this.motionMode = motionMode == null ? FabricMotionMode.LEGACY : motionMode;
    }

    record Result(
        boolean active,
        InputState input,
        CombatPlanner.Action action,
        String reason,
        LookDemand lookDemand,
        InteractionDemand interactionDemand,
        FabricInteractionAuthority.Payload interactionPayload
    ) {
        Result(boolean active, InputState input, CombatPlanner.Action action, String reason) {
            this(active, input, action, reason, null, null, null);
        }

        static Result inactive() {
            return new Result(false, InputState.stop(), CombatPlanner.Action.NONE, "no_threat");
        }
    }

    private record ActionControl(
        InputState input,
        LookDemand lookDemand,
        InteractionDemand interactionDemand,
        FabricInteractionAuthority.Payload interactionPayload
    ) {
        ActionControl(InputState input, LookDemand lookDemand) {
            this(input, lookDemand, null, null);
        }

        static ActionControl stop() {
            return new ActionControl(InputState.stop(), null);
        }
    }

    private record PendingAttack(
        String requestId,
        Entity target,
        double targetYaw,
        double targetPitch,
        double distance,
        float playerHealth
    ) {
    }

    Result tick(MinecraftClient client, ClientPlayerEntity player, long nowMs) {
        pendingAttack = null;
        if (client == null || client.world == null || client.interactionManager == null || player == null) {
            state = CombatPlanner.State.idle();
            target = null;
            return Result.inactive();
        }

        // Acquire the priority live hostile and count hostiles within the engage radius.
        Entity nearest = null;
        double nearestSquared = Double.POSITIVE_INFINITY;
        int hostileCount = 0;
        double engageRadius = config.engageRadius();
        double engageRadiusSquared = engageRadius * engageRadius;
        List<Entity> priorityEntities = new ArrayList<>();
        List<TargetPriorityPlanner.Candidate> priorityCandidates = new ArrayList<>();
        for (Entity entity : client.world.getEntities()) {
            if (entity instanceof HostileEntity hostile && entity.isAlive()) {
                double distSquared = entity.squaredDistanceTo(player);
                if (distSquared <= engageRadiusSquared) {
                    hostileCount++;
                    int index = priorityEntities.size();
                    priorityEntities.add(entity);
                    priorityCandidates.add(new TargetPriorityPlanner.Candidate(
                        index,
                        Math.sqrt(distSquared),
                        hostile.getHealth(),
                        classify(entity)
                    ));
                }
            }
        }
        Optional<TargetPriorityPlanner.Candidate> selected = TargetPriorityPlanner.pick(priorityCandidates, engageRadius);
        if (selected.isPresent()) {
            nearest = priorityEntities.get(selected.get().index());
            nearestSquared = nearest.squaredDistanceTo(player);
        }

        // Kill detection: a target we were fighting is gone or dead.
        if (target != null && (!target.isAlive() || target.isRemoved())) {
            log("kill", player.getHealth(), "hostile_defeated");
            target = null;
        }

        float health = player.getHealth();
        double nearestDistance = nearest == null ? -1.0D : Math.sqrt(nearestSquared);
        CombatPlanner.ThreatKind kind = classify(nearest);
        boolean hasWeapon = findWeaponSlot(player) >= 0;

        CombatPlanner.Observation obs = new CombatPlanner.Observation(
            health, hostileCount, nearestDistance, kind, hasWeapon, player.isOnGround());
        CombatPlanner.Decision decision = CombatPlanner.decide(state, obs, config);
        state = decision.state();
        if (nearest instanceof HostileEntity hostile && decision.action() != CombatPlanner.Action.NONE) {
            String targetLogKey = nearest.getUuidAsString() + ":" + String.format(Locale.ROOT, "%.1f", hostile.getHealth());
            if (!targetLogKey.equals(lastTargetLogKey)) {
                lastTargetLogKey = targetLogKey;
                LOGGER.info(
                    "r7_combat.target instanceId={} type={} health={} dist={} kind={} count={} reason={}",
                    instanceId,
                    Registries.ENTITY_TYPE.getId(nearest.getType()).getPath(),
                    String.format(Locale.ROOT, "%.1f", hostile.getHealth()),
                    String.format(Locale.ROOT, "%.1f", nearestDistance),
                    kind,
                    hostileCount,
                    decision.reason()
                );
            }
        }

        switch (decision.action()) {
            case ENGAGE -> {
                if (target == null || !target.isAlive() || target != nearest) {
                    target = nearest;
                }
                if (lastLoggedAction != CombatPlanner.Action.ENGAGE) {
                    log("engage", health, decision.reason());
                }
                lastLoggedAction = CombatPlanner.Action.ENGAGE;
                ActionControl control = executeEngage(client, player, nowMs);
                return new Result(
                    true,
                    control.input(),
                    CombatPlanner.Action.ENGAGE,
                    decision.reason(),
                    control.lookDemand(),
                    control.interactionDemand(),
                    control.interactionPayload()
                );
            }
            case FLEE -> {
                target = null;
                if (lastLoggedAction != CombatPlanner.Action.FLEE) {
                    log("flee", health, decision.reason());
                    fleeSafeLogged = false;
                    fleePrevX = player.getX();
                    fleePrevZ = player.getZ();
                    fleeStuckTicks = 0;
                    escapeRoute = List.of();
                    escapeWaypointIndex = 0;
                    escapeProgress = PathFollower.Progress.initial();
                    boxedLogoutRequested = false;
                    fleeStartedMs = nowMs;
                }
                lastLoggedAction = CombatPlanner.Action.FLEE;
                // The flee "succeeds" once we have opened a safe gap from the threat, health intact.
                if (!fleeSafeLogged && nearestDistance >= FLEE_ESCAPE_DISTANCE && health >= FLEE_SAFE_HEALTH) {
                    fleeSafeLogged = true;
                    log("flee_safe", health, "dist=" + String.format(Locale.ROOT, "%.1f", nearestDistance));
                } else if (nowMs - lastHeartbeatMs > 1000L) {
                    lastHeartbeatMs = nowMs;
                    LOGGER.info(
                        "r7_combat.flee_tick instanceId={} health={} dist={}",
                        instanceId,
                        String.format(Locale.ROOT, "%.1f", health),
                        String.format(Locale.ROOT, "%.1f", nearestDistance)
                    );
                }
                ActionControl control = fleeInput(client, player, nearest, nowMs);
                return new Result(
                    true,
                    control.input(),
                    CombatPlanner.Action.FLEE,
                    decision.reason(),
                    control.lookDemand(),
                    control.interactionDemand(),
                    control.interactionPayload()
                );
            }
            case LOGOUT -> {
                if (lastLoggedAction != CombatPlanner.Action.LOGOUT) {
                    log("logout", health, decision.reason());
                    requestLogout(client, decision.reason());
                }
                lastLoggedAction = CombatPlanner.Action.LOGOUT;
                return new Result(true, InputState.stop(), CombatPlanner.Action.LOGOUT, decision.reason());
            }
            default -> {
                target = null;
                lastLoggedAction = CombatPlanner.Action.NONE;
                if (nearest != null && nowMs - lastHeartbeatMs > 2000L) {
                    lastHeartbeatMs = nowMs;
                    LOGGER.info(
                        "r7_combat.idle instanceId={} health={} nearestDist={} kind={} hasWeapon={} count={}",
                        instanceId,
                        String.format(Locale.ROOT, "%.1f", health),
                        String.format(Locale.ROOT, "%.1f", nearestDistance),
                        kind,
                        hasWeapon,
                        hostileCount
                    );
                }
                return Result.inactive();
            }
        }
    }

    private ActionControl executeEngage(MinecraftClient client, ClientPlayerEntity player, long nowMs) {
        Entity t = target;
        if (t == null) {
            return ActionControl.stop();
        }
        int weaponSlot = findWeaponSlot(player);
        if (weaponSlot >= 0 && player.getInventory().selectedSlot != weaponSlot) {
            player.getInventory().selectedSlot = weaponSlot;
        }

        Vec3d eye = player.getEyePos();
        Vec3d targetEye = t.getEyePos();
        double dx = targetEye.x - eye.x;
        double dy = targetEye.y - eye.y;
        double dz = targetEye.z - eye.z;
        double horizontal = Math.sqrt(dx * dx + dz * dz);
        double targetYaw = Math.toDegrees(Math.atan2(-dx, dz));
        double targetPitch = Math.toDegrees(Math.atan2(-dy, horizontal));
        LookController.Look look = LookController.nextLook(
            player.getYaw(), player.getPitch(), targetYaw, targetPitch, LOOK_MAX_DEG_PER_TICK);
        LookDemand demand = hostileTrackingDemand(t, targetYaw, targetPitch, "engage");

        double distance = Math.sqrt(t.squaredDistanceTo(player));
        double alignmentYaw = motionMode == FabricMotionMode.SMOOTH ? player.getYaw() : look.yaw();
        double alignmentPitch = motionMode == FabricMotionMode.SMOOTH ? player.getPitch() : look.pitch();
        boolean aligned = Math.abs(LookController.shortestYawDelta(alignmentYaw, targetYaw)) <= ATTACK_ALIGN_DEG
            && Math.abs(alignmentPitch - targetPitch) <= ATTACK_ALIGN_DEG;

        if (distance <= MELEE_REACH) {
            // In range: hold position; swing only when truly aligned, line-of-sight is clear, and a
            // human-plausible cadence has elapsed.
            if (aligned
                && hasLineOfSight(client, player, t)
                && nowMs - lastAttackMs >= ATTACK_INTERVAL_MS) {
                String requestId = attackRequestId(t);
                pendingAttack = new PendingAttack(
                    requestId,
                    t,
                    targetYaw,
                    targetPitch,
                    distance,
                    player.getHealth()
                );
                InteractionDemand attackDemand = InteractionDemand.attackEntity(
                    requestId,
                    LookDemand.Owner.COMBAT,
                    combatCommandId("engage"),
                    "combat_engage_attack",
                    "hostile:" + t.getUuidAsString(),
                    "combat_attack"
                );
                FabricInteractionAuthority.Payload attackPayload =
                    FabricInteractionAuthority.Payload.entity(
                        t,
                        Hand.MAIN_HAND,
                        new FabricInteractionAuthority.EntityGate(
                            MELEE_REACH,
                            targetYaw,
                            targetPitch,
                            ATTACK_ALIGN_DEG,
                            lastAttackMs + ATTACK_INTERVAL_MS,
                            true
                        )
                    );
                return new ActionControl(
                    InputState.stop(),
                    demand,
                    attackDemand,
                    attackPayload
                );
            }
            return new ActionControl(InputState.stop(), demand);
        }
        // Out of range: face the target and move toward it; sprint-close vs ranged threats to cut
        // time under fire. Against ranged threats, add lateral movement so the close is not a
        // straight arrow lane.
        CombatPlanner.ThreatKind threatKind = classify(t);
        float sideways = 0.0F;
        boolean left = false;
        boolean right = false;
        if (threatKind == CombatPlanner.ThreatKind.RANGED) {
            KitingPlanner.Decision kite = KitingPlanner.decide(
                threatKind,
                distance,
                MELEE_REACH,
                KITE_MAX_DISTANCE,
                kiteDirection,
                nowMs,
                lastKiteSwitchMs,
                KITE_SWITCH_MS
            );
            if (kite.strafing()) {
                kiteDirection = kite.direction();
                if (kite.switched()) {
                    lastKiteSwitchMs = nowMs;
                }
                sideways = kite.direction();
                left = kite.direction() > 0;
                right = kite.direction() < 0;
                if (nowMs - lastKiteLogMs >= 500L) {
                    lastKiteLogMs = nowMs;
                    LOGGER.info(
                        "r7_combat.kite instanceId={} health={} dist={} direction={} switched={}",
                        instanceId,
                        String.format(Locale.ROOT, "%.1f", player.getHealth()),
                        String.format(Locale.ROOT, "%.1f", distance),
                        kite.direction(),
                        kite.switched()
                    );
                }
            }
        }
        return new ActionControl(
            new InputState(true, false, left, right, false, false, 1.0F, sideways),
            demand
        );
    }

    void acknowledgeInteraction(InteractionAppliedReceipt receipt) {
        PendingAttack pending = pendingAttack;
        if (pending == null
            || receipt == null
            || !receipt.applied()
            || receipt.action() != InteractionDemand.Action.ATTACK_ENTITY
            || !pending.requestId().equals(receipt.requestId())) {
            return;
        }
        pendingAttack = null;
        lastAttackMs = receipt.timestampMs();
        attackRequestSequence++;
        log(
            "attack",
            pending.playerHealth(),
            "dist=" + String.format(Locale.ROOT, "%.1f", pending.distance())
        );
    }

    private String attackRequestId(Entity entity) {
        return combatCommandId("engage")
            + ":attack:"
            + attackRequestSequence
            + ":"
            + entity.getUuidAsString();
    }

    private ActionControl fleeInput(MinecraftClient client, ClientPlayerEntity player, Entity nearest, long nowMs) {
        if (nearest == null) {
            return new ActionControl(
                new InputState(false, true, false, false, true, false, -1.0F, 0.0F),
                null
            );
        }

        // Cornered detection: if the fast sprint-jump flee isn't actually moving us (we're against a
        // wall / boxed by terrain), switch to nav-aware escape routing around the obstacle. Once a
        // route is active we follow it to completion before resuming the fast flee.
        double moved = Math.hypot(player.getX() - fleePrevX, player.getZ() - fleePrevZ);
        fleeStuckTicks = moved < CORNERED_MOVE_EPS ? fleeStuckTicks + 1 : 0;
        fleePrevX = player.getX();
        fleePrevZ = player.getZ();
        if (!escapeRoute.isEmpty() || fleeStuckTicks >= CORNERED_STUCK_TICKS) {
            ActionControl escape = navEscapeInput(client, player, nearest, nowMs);
            if (escape != null) {
                return escape;
            }
        }

        // Fast default: face directly away and sprint-jump (sprint > mob walk; jump clears 1-block steps).
        Vec3d eye = player.getEyePos();
        Vec3d targetEye = nearest.getEyePos();
        double dx = targetEye.x - eye.x;
        double dz = targetEye.z - eye.z;
        double towardYaw = Math.toDegrees(Math.atan2(-dx, dz));
        double awayYaw = LookController.normalizeYaw(towardYaw + 180.0D);
        LookController.Look look = LookController.nextLook(player.getYaw(), player.getPitch(), awayYaw, 0.0D, LOOK_MAX_DEG_PER_TICK);
        LookDemand demand = hostileTrackingDemand(nearest, awayYaw, 0.0D, "flee");
        double alignmentYaw = motionMode == FabricMotionMode.SMOOTH ? player.getYaw() : look.yaw();
        if (Math.abs(LookController.shortestYawDelta(alignmentYaw, awayYaw)) <= 90.0D) {
            return new ActionControl(
                new InputState(true, false, false, false, true, false, 1.0F, 0.0F),
                demand
            );
        }
        // Still turning to face away: back-pedal (moves away while we're still facing the threat).
        return new ActionControl(
            new InputState(false, true, false, false, true, false, -1.0F, 0.0F),
            demand
        );
    }

    /**
     * Nav-aware escape: route around terrain to the farthest reachable cell from the threat, following
     * it with {@link PathFollower}. Returns null when there is no usable route (boxed in, or the route
     * just finished) so the caller falls back to the fast sprint-jump flee.
     */
    private ActionControl navEscapeInput(MinecraftClient client, ClientPlayerEntity player, Entity nearest, long nowMs) {
        GridCell botCell = new GridCell((int) Math.floor(player.getX()), (int) Math.floor(player.getZ()));
        GridCell threatCell = new GridCell((int) Math.floor(nearest.getX()), (int) Math.floor(nearest.getZ()));
        boolean needRoute = escapeRoute.isEmpty()
            || escapeWaypointIndex >= escapeRoute.size()
            || nowMs - escapeRouteComputedMs > ESCAPE_RECOMPUTE_MS;
        if (needRoute) {
            int feetY = (int) Math.floor(player.getY());
            WorldGridPerception perception = new WorldGridPerception(
                client.world,
                feetY,
                botCell.x() - ESCAPE_RADIUS,
                botCell.x() + ESCAPE_RADIUS,
                botCell.z() - ESCAPE_RADIUS,
                botCell.z() + ESCAPE_RADIUS
            );
            Optional<GridCell> goal = EscapeTargetPlanner.pickEscapeCell(perception, botCell, threatCell, ESCAPE_MAX_CELLS);
            if (goal.isEmpty()) {
                escapeRoute = List.of();
                BoxedEscapePlanner.Action boxed = BoxedEscapePlanner.decide(
                    false,
                    false,
                    nowMs - fleeStartedMs,
                    BOXED_LOGOUT_GRACE_MS
                );
                return boxed == BoxedEscapePlanner.Action.LOGOUT
                    ? new ActionControl(boxedLogout(client, player, "no_escape_goal"), null)
                    : null;
            }
            List<GridCell> route = GridAStar.route(perception, botCell, goal.get());
            if (route.size() < 2) {
                escapeRoute = List.of();
                BoxedEscapePlanner.Action boxed = BoxedEscapePlanner.decide(
                    true,
                    false,
                    nowMs - fleeStartedMs,
                    BOXED_LOGOUT_GRACE_MS
                );
                return boxed == BoxedEscapePlanner.Action.LOGOUT
                    ? new ActionControl(boxedLogout(client, player, "no_escape_route"), null)
                    : null;
            }
            escapeRoute = route;
            escapeWaypointIndex = 0;
            escapeProgress = PathFollower.Progress.initial();
            escapeRouteComputedMs = nowMs;
            log("flee_escape_route", player.getHealth(), "goal=" + goal.get().x() + "," + goal.get().z() + " len=" + route.size());
        }

        PathFollower.Command command = PathFollower.follow(
            escapeRoute,
            escapeWaypointIndex,
            escapeProgress,
            player.getX(),
            player.getZ(),
            player.getYaw(),
            ESCAPE_ARRIVE_EPS,
            LOOK_MAX_DEG_PER_TICK
        );
        escapeWaypointIndex = command.waypointIndex();
        escapeProgress = command.progress();
        if (command.finished()) {
            escapeRoute = List.of();
            return null;
        }
        // Sprint remains disabled by the top-level movement authority in MQ-2; preserve the
        // previously effective combat behavior until combat locomotion is explicitly classified.
        InputState in = command.input();
        int waypointIndex = Math.max(0, Math.min(escapeWaypointIndex, escapeRoute.size() - 1));
        GridCell waypoint = escapeRoute.get(waypointIndex);
        LookDemand demand = new LookDemand(
            LookDemand.Owner.COMBAT,
            "combat_escape:"
                + escapeRouteComputedMs
                + ":"
                + waypointIndex
                + ":"
                + waypoint.x()
                + ":"
                + waypoint.z(),
            LookDemand.Profile.TRACKING,
            command.look().yaw(),
            command.look().pitch(),
            LookDemand.RetargetPolicy.CONTINUOUS,
            combatCommandId("flee"),
            "combat_flee_escape_route_exact"
        );
        return new ActionControl(
            new InputState(
                in.pressingForward(),
                in.pressingBack(),
                in.pressingLeft(),
                in.pressingRight(),
                true,
                in.sneaking(),
                in.movementForward(),
                in.movementSideways()
            ),
            demand
        );
    }

    private LookDemand hostileTrackingDemand(Entity hostile, double yaw, double pitch, String action) {
        return new LookDemand(
            LookDemand.Owner.COMBAT,
            "hostile:" + hostile.getUuidAsString(),
            LookDemand.Profile.TRACKING,
            yaw,
            pitch,
            LookDemand.RetargetPolicy.CONTINUOUS,
            combatCommandId(action),
            "combat_" + action + "_tracking"
        );
    }

    private String combatCommandId(String action) {
        return "combat:" + (instanceId.isBlank() ? "instance" : instanceId) + ":" + action;
    }

    private InputState boxedLogout(MinecraftClient client, ClientPlayerEntity player, String reason) {
        if (!boxedLogoutRequested) {
            boxedLogoutRequested = true;
            log("boxed_logout", player.getHealth(), reason);
            log("logout", player.getHealth(), "boxed_escape:" + reason);
            requestLogout(client, "boxed_escape:" + reason);
        }
        return InputState.stop();
    }

    private boolean hasLineOfSight(MinecraftClient client, ClientPlayerEntity player, Entity t) {
        Vec3d eye = player.getEyePos();
        Vec3d targetEye = t.getEyePos();
        HitResult hit = client.world.raycast(new RaycastContext(
            eye, targetEye, RaycastContext.ShapeType.COLLIDER, RaycastContext.FluidHandling.NONE, player));
        if (hit == null || hit.getType() == HitResult.Type.MISS) {
            return true;
        }
        // Clear if the first solid block is at/behind the target (no wall between us and it).
        return hit.getPos().squaredDistanceTo(eye) >= targetEye.squaredDistanceTo(eye) - 0.25D;
    }

    private static CombatPlanner.ThreatKind classify(Entity entity) {
        if (entity == null) {
            return CombatPlanner.ThreatKind.NONE;
        }
        String id = Registries.ENTITY_TYPE.getId(entity.getType()).getPath();
        if (id.equals("creeper")) {
            return CombatPlanner.ThreatKind.EXPLOSIVE;
        }
        if (id.contains("skeleton") || id.equals("stray") || id.equals("bogged") || id.equals("pillager")) {
            return CombatPlanner.ThreatKind.RANGED;
        }
        return CombatPlanner.ThreatKind.MELEE;
    }

    private static int findWeaponSlot(ClientPlayerEntity player) {
        for (int slot = 0; slot < 9; slot++) {
            ItemStack stack = player.getInventory().getStack(slot);
            if (stack != null && !stack.isEmpty()
                && Registries.ITEM.getId(stack.getItem()).getPath().endsWith("_sword")) {
                return slot;
            }
        }
        return -1;
    }

    private void requestLogout(MinecraftClient client, String reason) {
        client.execute(() -> {
            ClientPlayNetworkHandler handler = client.getNetworkHandler();
            if (handler != null) {
                handler.getConnection().disconnect(Text.literal("mcbot_r7_combat:" + reason));
                LOGGER.info(
                    "r7_combat.disconnect instanceId={} reason={}",
                    instanceId,
                    reason
                );
            }
        });
    }

    private void log(String event, float health, String reason) {
        LOGGER.info(
            "r7_combat.{} instanceId={} health={} reason={}",
            event,
            instanceId,
            String.format(Locale.ROOT, "%.1f", health),
            reason
        );
    }
}
