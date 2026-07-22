package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class GatherTreeDropTrackerTest {
    private static final GatherTreeDropTracker.Position BREAK = new GatherTreeDropTracker.Position(0.5D, 65.5D, 0.5D);

    @Test
    void latchesNewEntityAndIgnoresUnchangedStaleDrop() {
        UUID stale = UUID.randomUUID();
        UUID owned = UUID.randomUUID();
        GatherTreeDropTracker tracker = armed(Map.of(stale, 1));

        GatherTreeDropTracker.Update update = tracker.update(List.of(
            observation(stale, 1, 0.6D, 65.2D, 0.5D, false),
            observation(owned, 1, 0.7D, 65.1D, 0.5D, false)
        ), 100L);

        assertTrue(update.latchedNow());
        assertEquals(owned, update.observation().entityId());
        assertEquals(GatherTreeDropTracker.Phase.AIRBORNE, update.phase());
    }

    @Test
    void recognizesStackCountMerge() {
        UUID merged = UUID.randomUUID();
        GatherTreeDropTracker tracker = armed(Map.of(merged, 2));

        GatherTreeDropTracker.Update update = tracker.update(
            List.of(observation(merged, 3, 0.5D, 65.0D, 0.5D, false)), 100L);

        assertTrue(update.latchedNow());
        assertEquals(merged, tracker.entityId());
    }

    @Test
    void followsOwnedIdentityOutsideLegacyVerticalSearchAndSettlesDeterministically() {
        UUID owned = UUID.randomUUID();
        GatherTreeDropTracker tracker = armed(Map.of());
        tracker.update(List.of(observation(owned, 1, 0.5D, 65.0D, 0.5D, false)), 100L);
        tracker.update(List.of(observation(owned, 1, 0.5D, 55.0D, 0.5D, false)), 200L);

        assertEquals(GatherTreeDropTracker.Phase.AIRBORNE,
            tracker.update(List.of(observation(owned, 1, 0.5D, 54.0D, 0.5D, true)), 300L).phase());
        assertEquals(GatherTreeDropTracker.Phase.AIRBORNE,
            tracker.update(List.of(observation(owned, 1, 0.5D, 54.0D, 0.5D, true)), 350L).phase());
        GatherTreeDropTracker.Update settled = tracker.update(
            List.of(observation(owned, 1, 0.5D, 54.0D, 0.5D, true)), 400L);

        assertTrue(settled.settledNow());
        assertEquals(GatherTreeDropTracker.Phase.SETTLED, settled.phase());
        assertEquals(new GatherTreeDropTracker.Position(0.5D, 54.0D, 0.5D), settled.settledPosition());
    }

    @Test
    void epsilonStableAirborneObservationsAlsoSettle() {
        UUID owned = UUID.randomUUID();
        GatherTreeDropTracker tracker = armed(Map.of());
        tracker.update(List.of(observation(owned, 1, 0.5D, 64.0D, 0.5D, false)), 100L);
        tracker.update(List.of(observation(owned, 1, 0.51D, 64.0D, 0.5D, false)), 150L);
        tracker.update(List.of(observation(owned, 1, 0.52D, 64.0D, 0.5D, false)), 200L);

        GatherTreeDropTracker.Update settled = tracker.update(
            List.of(observation(owned, 1, 0.53D, 64.0D, 0.5D, false)), 250L);

        assertTrue(settled.settledNow());
        assertEquals(GatherTreeDropTracker.Phase.SETTLED, settled.phase());
    }

    @Test
    void allowsOneNearbyMergeReplacementAndRejectsAnother() {
        UUID first = UUID.randomUUID();
        UUID replacement = UUID.randomUUID();
        UUID secondReplacement = UUID.randomUUID();
        GatherTreeDropTracker tracker = armed(Map.of(replacement, 1, secondReplacement, 1));
        tracker.update(List.of(observation(first, 1, 0.5D, 65.0D, 0.5D, false)), 100L);

        GatherTreeDropTracker.Update reacquired = tracker.update(
            List.of(observation(replacement, 2, 0.6D, 64.9D, 0.5D, false)), 200L);
        GatherTreeDropTracker.Update rejected = tracker.update(
            List.of(observation(secondReplacement, 2, 0.7D, 64.8D, 0.5D, false)), 300L);

        assertTrue(reacquired.reacquiredNow());
        assertEquals(1, tracker.reacquisitions());
        assertEquals(GatherTreeDropTracker.Phase.REJECTED, rejected.phase());
        assertEquals("reacquisition_limit", rejected.reason());
    }

    @Test
    void rejectsAcquisitionTimeoutAndUnchangedStaleOnly() {
        UUID stale = UUID.randomUUID();
        GatherTreeDropTracker tracker = armed(Map.of(stale, 1));

        GatherTreeDropTracker.Update update = tracker.update(
            List.of(observation(stale, 1, 0.5D, 65.0D, 0.5D, true)), 2_001L);

        assertEquals(GatherTreeDropTracker.Phase.REJECTED, update.phase());
        assertEquals("acquisition_timeout", update.reason());
        assertNull(tracker.entityId());
    }

    @Test
    void acquisitionClockStartsWhenTheBrokenBlockBecomesAir() {
        GatherTreeDropTracker tracker = new GatherTreeDropTracker();
        tracker.arm(Map.of(), BREAK, 0L);

        assertEquals(GatherTreeDropTracker.Phase.ARMED, tracker.update(List.of(), 3_000L).phase());
        tracker.beginAcquisition(3_000L);
        assertEquals(GatherTreeDropTracker.Phase.ACQUIRING, tracker.update(List.of(), 4_999L).phase());
        assertEquals("acquisition_timeout", tracker.update(List.of(), 5_001L).reason());
    }

    @Test
    void rejectsDistanceSettleTimeoutAndDespawn() {
        UUID far = UUID.randomUUID();
        GatherTreeDropTracker distance = armed(Map.of());
        distance.update(List.of(observation(far, 1, 0.5D, 65.0D, 0.5D, false)), 10L);
        assertEquals("distance_limit", distance.update(
            List.of(observation(far, 1, 13.0D, 65.0D, 0.5D, false)), 20L).reason());

        UUID deep = UUID.randomUUID();
        GatherTreeDropTracker vertical = armed(Map.of());
        vertical.update(List.of(observation(deep, 1, 0.5D, 65.0D, 0.5D, false)), 10L);
        assertEquals("distance_limit", vertical.update(
            List.of(observation(deep, 1, 0.5D, 40.0D, 0.5D, false)), 20L).reason());

        UUID falling = UUID.randomUUID();
        GatherTreeDropTracker timeout = armed(Map.of());
        timeout.update(List.of(observation(falling, 1, 0.5D, 65.0D, 0.5D, false)), 10L);
        assertEquals("settle_timeout", timeout.update(
            List.of(observation(falling, 1, 0.5D, 50.0D, 0.5D, false)), 4_011L).reason());

        UUID gone = UUID.randomUUID();
        GatherTreeDropTracker despawn = armed(Map.of());
        despawn.update(List.of(observation(gone, 1, 0.5D, 65.0D, 0.5D, false)), 10L);
        assertEquals("despawned", despawn.update(List.of(), 20L).reason());
    }

    @Test
    void routeAttemptsAreBoundedAndResetForNextTarget() {
        GatherTreeDropTracker tracker = armed(Map.of());

        assertTrue(tracker.recordRouteAttempt());
        assertTrue(tracker.recordRouteAttempt());
        assertFalse(tracker.recordRouteAttempt());
        tracker.reset();
        tracker.arm(Map.of(), BREAK, 1_000L);

        assertEquals(0, tracker.routeAttempts());
        assertTrue(tracker.recordRouteAttempt());
    }

    private static GatherTreeDropTracker armed(Map<UUID, Integer> baseline) {
        GatherTreeDropTracker tracker = new GatherTreeDropTracker();
        tracker.arm(baseline, BREAK, 0L);
        tracker.beginAcquisition(0L);
        return tracker;
    }

    private static GatherTreeDropTracker.Observation observation(
        UUID id,
        int count,
        double x,
        double y,
        double z,
        boolean grounded
    ) {
        return new GatherTreeDropTracker.Observation(
            id,
            count,
            new GatherTreeDropTracker.Position(x, y, z),
            true,
            grounded
        );
    }
}
