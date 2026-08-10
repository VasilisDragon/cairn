package com.mcbot.fabricclient;

import java.util.Locale;

/**
 * Session-local truth for the player's respawn point.
 *
 * <p>The client player does not receive {@code ServerPlayerEntity}'s stored spawn position.  In
 * particular, an accepted client-side bed interaction is only a prediction and is not evidence that
 * the server committed the respawn point.  Vanilla does, however, send the translatable game
 * message {@code block.minecraft.set_spawn} after that server-side commit.  This tracker consumes
 * only that exact server game-message key.  Until it is observed, the snapshot reports UNKNOWN—not
 * false—because a player may have joined with a respawn point established before this client session.
 */
final class RespawnVerificationTracker {
    static final String SET_CONFIRMATION_TRANSLATION_KEY = "block.minecraft.set_spawn";

    enum State {
        UNKNOWN,
        VERIFIED_SET;

        String wireName() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    record Snapshot(Boolean verifiedRespawnSet, String state, String evidence) {
        static Snapshot unknown() {
            return new Snapshot(null, State.UNKNOWN.wireName(), "none");
        }
    }

    private String worldIdentity = "";
    private State state = State.UNKNOWN;

    /**
     * Observe an exact translation key from Fabric's server-game-message event.
     *
     * @return true only for the transition from unknown to authoritatively verified set
     */
    synchronized boolean observeServerGameMessage(String currentWorldIdentity, String translationKey) {
        bindWorld(currentWorldIdentity);
        if (worldIdentity.isEmpty()
            || !SET_CONFIRMATION_TRANSLATION_KEY.equals(translationKey)
            || state == State.VERIFIED_SET) {
            return false;
        }
        state = State.VERIFIED_SET;
        return true;
    }

    synchronized Snapshot snapshot(String currentWorldIdentity) {
        bindWorld(currentWorldIdentity);
        if (state != State.VERIFIED_SET) {
            return Snapshot.unknown();
        }
        return new Snapshot(
            Boolean.TRUE,
            state.wireName(),
            "server_game_message:" + SET_CONFIRMATION_TRANSLATION_KEY
        );
    }

    synchronized void clear() {
        worldIdentity = "";
        state = State.UNKNOWN;
    }

    private void bindWorld(String currentWorldIdentity) {
        String normalized = currentWorldIdentity == null ? "" : currentWorldIdentity.trim();
        if (normalized.equals(worldIdentity)) {
            return;
        }
        worldIdentity = normalized;
        state = State.UNKNOWN;
    }
}
