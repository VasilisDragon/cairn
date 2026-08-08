package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class RespawnVerificationTrackerTest {
    @Test
    void absenceOfAConfirmationIsUnknownRatherThanFalse() {
        RespawnVerificationTracker tracker = new RespawnVerificationTracker();

        RespawnVerificationTracker.Snapshot snapshot = tracker.snapshot("world-a");

        assertNull(snapshot.verifiedRespawnSet());
        assertEquals("unknown", snapshot.state());
        assertEquals("none", snapshot.evidence());
    }

    @Test
    void onlyTheExactServerConfirmationKeyVerifiesASetRespawn() {
        RespawnVerificationTracker tracker = new RespawnVerificationTracker();

        assertFalse(tracker.observeServerGameMessage("world-a", "literal:Respawn point set"));
        assertFalse(tracker.observeServerGameMessage("world-a", "block.minecraft.set_spawn.fake"));
        assertNull(tracker.snapshot("world-a").verifiedRespawnSet());

        assertTrue(tracker.observeServerGameMessage(
            "world-a",
            RespawnVerificationTracker.SET_CONFIRMATION_TRANSLATION_KEY
        ));
        RespawnVerificationTracker.Snapshot snapshot = tracker.snapshot("world-a");
        assertEquals(Boolean.TRUE, snapshot.verifiedRespawnSet());
        assertEquals("verified_set", snapshot.state());
        assertEquals(
            "server_game_message:block.minecraft.set_spawn",
            snapshot.evidence()
        );

        assertFalse(tracker.observeServerGameMessage(
            "world-a",
            RespawnVerificationTracker.SET_CONFIRMATION_TRANSLATION_KEY
        ));
    }

    @Test
    void aWorldIdentityChangeFailsBackToUnknown() {
        RespawnVerificationTracker tracker = new RespawnVerificationTracker();
        assertTrue(tracker.observeServerGameMessage(
            "world-a",
            RespawnVerificationTracker.SET_CONFIRMATION_TRANSLATION_KEY
        ));

        RespawnVerificationTracker.Snapshot changed = tracker.snapshot("world-b");

        assertNull(changed.verifiedRespawnSet());
        assertEquals("unknown", changed.state());
    }

    @Test
    void anUnboundConfirmationCannotLeakIntoTheNextWorld() {
        RespawnVerificationTracker tracker = new RespawnVerificationTracker();

        assertFalse(tracker.observeServerGameMessage(
            "",
            RespawnVerificationTracker.SET_CONFIRMATION_TRANSLATION_KEY
        ));
        assertNull(tracker.snapshot("world-a").verifiedRespawnSet());

        tracker.observeServerGameMessage(
            "world-a",
            RespawnVerificationTracker.SET_CONFIRMATION_TRANSLATION_KEY
        );
        tracker.clear();
        assertNull(tracker.snapshot("world-a").verifiedRespawnSet());
    }
}
