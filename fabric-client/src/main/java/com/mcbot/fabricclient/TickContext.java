package com.mcbot.fabricclient;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.world.World;

/**
 * Per-tick inputs handed to an {@link ObjectiveExecutor}, plus the {@link ShellServices} back-channel.
 *
 * <p>This holder is REUSED across ticks — a single instance lives on the shell and is mutated each
 * tick via {@link #reset}. It must NOT be allocated per tick: {@code onClientTick} runs at the 20Hz
 * hot loop and per-tick allocation here would add steady GC pressure on the render thread.
 *
 * <p>No perception snapshot is carried: executors build their own perception (MineStone needs none).
 */
public final class TickContext {

    private final ShellServices shell;

    private MinecraftClient client;
    private ClientPlayerEntity player;
    private long nowMs;
    private BrainLink.Intent intent;

    public TickContext(ShellServices shell) {
        this.shell = shell;
    }

    /** Store this tick's inputs. Called once per tick before dispatch; reuses this instance. */
    public void reset(MinecraftClient client, ClientPlayerEntity player, long nowMs, BrainLink.Intent intent) {
        this.client = client;
        this.player = player;
        this.nowMs = nowMs;
        this.intent = intent;
    }

    public MinecraftClient client() {
        return client;
    }

    public ClientPlayerEntity player() {
        return player;
    }

    public World world() {
        return client.world;
    }

    public long nowMs() {
        return nowMs;
    }

    public BrainLink.Intent intent() {
        return intent;
    }

    public ShellServices shell() {
        return shell;
    }
}
