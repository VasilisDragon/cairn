package com.mcbot.fabricclient;

import java.util.Locale;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.Entity;
import net.minecraft.entity.mob.HostileEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.text.Text;
import net.minecraft.util.Hand;
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

    private final String instanceId;
    private final SurvivalPlanner.Config config;

    private SurvivalPlanner.State state = SurvivalPlanner.State.idle();
    private long eatStartedMs = 0L;
    private int foodAtEatStart = -1;
    private boolean ateFoodLogged = false;
    private SurvivalPlanner.Action lastLoggedAction = SurvivalPlanner.Action.NONE;
    private long lastHeartbeatMs = 0L;

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
        float health
    ) {
        static Result inactive() {
            return new Result(false, InputState.stop(), SurvivalPlanner.Action.NONE, "ok", 0, 0.0F);
        }
    }

    Result tick(MinecraftClient client, ClientPlayerEntity player, long nowMs) {
        if (client == null || client.world == null || client.interactionManager == null || player == null) {
            state = SurvivalPlanner.State.idle();
            return Result.inactive();
        }

        // Default each tick to "not holding use"; only the EAT path re-presses it below, so the
        // consume key releases the instant we stop eating (or switch to retreat/logout).
        client.options.useKey.setPressed(false);

        float health = player.getHealth();
        int foodLevel = player.getHungerManager().getFoodLevel();
        int foodSlot = findFoodSlot(player);
        boolean hasEdibleFood = foodSlot >= 0 && foodLevel < 20;
        boolean onGround = player.isOnGround();
        double hostile = nearestHostileDistance(client, player);

        SurvivalPlanner.Observation obs =
            new SurvivalPlanner.Observation(health, foodLevel, hasEdibleFood, onGround, hostile);
        SurvivalPlanner.Mode prevMode = state.mode();
        SurvivalPlanner.Decision decision = SurvivalPlanner.decide(state, obs, config);
        state = decision.state();

        switch (decision.action()) {
            case EAT -> {
                if (prevMode != SurvivalPlanner.Mode.EATING) {
                    eatStartedMs = nowMs;
                    foodAtEatStart = foodLevel;
                    ateFoodLogged = false;
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
                executeEat(client, player, foodSlot);
                lastLoggedAction = SurvivalPlanner.Action.EAT;
                return new Result(true, InputState.stop(), SurvivalPlanner.Action.EAT, decision.reason(), foodLevel, health);
            }
            case RETREAT -> {
                if (lastLoggedAction != SurvivalPlanner.Action.RETREAT) {
                    log("retreat", foodLevel, health, decision.reason());
                }
                lastLoggedAction = SurvivalPlanner.Action.RETREAT;
                return new Result(true, retreatInput(), SurvivalPlanner.Action.RETREAT, decision.reason(), foodLevel, health);
            }
            case LOGOUT -> {
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

    /** Select the food slot, then begin/continue a single real consume via the interaction manager. */
    private static void executeEat(MinecraftClient client, ClientPlayerEntity player, int foodSlot) {
        if (foodSlot >= 0 && player.getInventory().selectedSlot != foodSlot) {
            player.getInventory().selectedSlot = foodSlot;
            return; // let the hotbar swap settle one tick before using the item
        }
        // Look up so the use-item ray clears any block in front (consume path, not a block
        // interaction). Holding the use key lets MinecraftClient drive — and crucially not cancel —
        // the consume each tick, exactly like a human holding right-click. Calling interactItem once
        // would be cancelled by the key-release handler on the next tick before the bite completes.
        player.setPitch(-75.0F);
        client.options.useKey.setPressed(true);
    }

    /** Back-pedal to create distance while keeping the threat in view. R7 combat refines this. */
    private static InputState retreatInput() {
        return new InputState(false, true, false, false, false, false, -1.0F, 0.0F);
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
