package com.mcbot.fabricclient;

import java.util.Locale;
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

    private final String instanceId;
    private final CombatPlanner.Config config;

    private CombatPlanner.State state = CombatPlanner.State.idle();
    private Entity target;
    private long lastAttackMs = 0L;
    private long lastHeartbeatMs = 0L;
    private CombatPlanner.Action lastLoggedAction = CombatPlanner.Action.NONE;
    private boolean fleeSafeLogged = false;

    CombatController(String instanceId) {
        this(instanceId, CombatPlanner.Config.defaults());
    }

    CombatController(String instanceId, CombatPlanner.Config config) {
        this.instanceId = instanceId == null ? "" : instanceId;
        this.config = config == null ? CombatPlanner.Config.defaults() : config;
    }

    record Result(boolean active, InputState input, CombatPlanner.Action action, String reason) {
        static Result inactive() {
            return new Result(false, InputState.stop(), CombatPlanner.Action.NONE, "no_threat");
        }
    }

    Result tick(MinecraftClient client, ClientPlayerEntity player, long nowMs) {
        if (client == null || client.world == null || client.interactionManager == null || player == null) {
            state = CombatPlanner.State.idle();
            target = null;
            return Result.inactive();
        }

        // Default each tick to "not sprinting"; the flee path re-presses it when running away.
        client.options.sprintKey.setPressed(false);

        // Acquire the nearest live hostile and count hostiles within the engage radius.
        Entity nearest = null;
        double nearestSquared = Double.POSITIVE_INFINITY;
        int hostileCount = 0;
        double engageRadius = config.engageRadius();
        double engageRadiusSquared = engageRadius * engageRadius;
        for (Entity entity : client.world.getEntities()) {
            if (entity instanceof HostileEntity && entity.isAlive()) {
                double distSquared = entity.squaredDistanceTo(player);
                if (distSquared <= engageRadiusSquared) {
                    hostileCount++;
                }
                if (distSquared < nearestSquared) {
                    nearestSquared = distSquared;
                    nearest = entity;
                }
            }
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

        switch (decision.action()) {
            case ENGAGE -> {
                if (target == null || !target.isAlive()) {
                    target = nearest;
                }
                if (lastLoggedAction != CombatPlanner.Action.ENGAGE) {
                    log("engage", health, decision.reason());
                }
                lastLoggedAction = CombatPlanner.Action.ENGAGE;
                return new Result(true, executeEngage(client, player, nowMs), CombatPlanner.Action.ENGAGE, decision.reason());
            }
            case FLEE -> {
                target = null;
                if (lastLoggedAction != CombatPlanner.Action.FLEE) {
                    log("flee", health, decision.reason());
                    fleeSafeLogged = false;
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
                return new Result(true, fleeInput(client, player, nearest), CombatPlanner.Action.FLEE, decision.reason());
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

    private InputState executeEngage(MinecraftClient client, ClientPlayerEntity player, long nowMs) {
        Entity t = target;
        if (t == null) {
            return InputState.stop();
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
        player.setYaw((float) look.yaw());
        player.setPitch((float) look.pitch());

        double distance = Math.sqrt(t.squaredDistanceTo(player));
        boolean aligned = Math.abs(LookController.shortestYawDelta(look.yaw(), targetYaw)) <= ATTACK_ALIGN_DEG
            && Math.abs(look.pitch() - targetPitch) <= ATTACK_ALIGN_DEG;

        if (distance <= MELEE_REACH) {
            // In range: hold position; swing only when truly aligned, line-of-sight is clear, and a
            // human-plausible cadence has elapsed.
            if (aligned
                && hasLineOfSight(client, player, t)
                && nowMs - lastAttackMs >= ATTACK_INTERVAL_MS) {
                client.interactionManager.attackEntity(player, t);
                player.swingHand(Hand.MAIN_HAND);
                lastAttackMs = nowMs;
                log("attack", player.getHealth(), "dist=" + String.format(Locale.ROOT, "%.1f", distance));
            }
            return InputState.stop();
        }
        // Out of range: face the target and walk toward it.
        return new InputState(true, false, false, false, false, false, 1.0F, 0.0F);
    }

    private InputState fleeInput(MinecraftClient client, ClientPlayerEntity player, Entity nearest) {
        if (nearest == null) {
            return new InputState(false, true, false, false, true, false, -1.0F, 0.0F);
        }
        Vec3d eye = player.getEyePos();
        Vec3d targetEye = nearest.getEyePos();
        double dx = targetEye.x - eye.x;
        double dz = targetEye.z - eye.z;
        double towardYaw = Math.toDegrees(Math.atan2(-dx, dz));
        double awayYaw = LookController.normalizeYaw(towardYaw + 180.0D);
        // Turn to face directly away so we can sprint (sprint is forward-only). Sprint-jump is the
        // fastest ground movement and clears the 1-block terrain steps that trap a plain back-pedal.
        LookController.Look look = LookController.nextLook(player.getYaw(), player.getPitch(), awayYaw, 0.0D, LOOK_MAX_DEG_PER_TICK);
        player.setYaw((float) look.yaw());
        player.setPitch((float) look.pitch());
        if (Math.abs(LookController.shortestYawDelta(look.yaw(), awayYaw)) <= 90.0D) {
            // Facing away enough: sprint-jump forward to outrun the threat (sprint > mob walk speed).
            client.options.sprintKey.setPressed(true);
            return new InputState(true, false, false, false, true, false, 1.0F, 0.0F);
        }
        // Still turning to face away: back-pedal (moves away while we're still facing the threat).
        return new InputState(false, true, false, false, true, false, -1.0F, 0.0F);
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
        if (id.contains("skeleton") || id.equals("stray") || id.equals("bogged")) {
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
