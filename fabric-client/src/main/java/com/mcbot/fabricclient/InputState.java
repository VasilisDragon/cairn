package com.mcbot.fabricclient;

/**
 * Minecraft-independent input snapshot for the on-tick applier.
 *
 * <p>This mirrors the fields the Fabric glue copies onto {@code net.minecraft}
 * input, but keeps the decision/mapping logic unit-testable without MC classes.
 */
public record InputState(
    boolean pressingForward,
    boolean pressingBack,
    boolean pressingLeft,
    boolean pressingRight,
    boolean jumping,
    boolean sneaking,
    float movementForward,
    float movementSideways
) {
    public static InputState stop() {
        return new InputState(false, false, false, false, false, false, 0.0F, 0.0F);
    }
}
