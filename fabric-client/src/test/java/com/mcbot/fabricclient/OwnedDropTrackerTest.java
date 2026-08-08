package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class OwnedDropTrackerTest {
    private static final OwnedDropTracker.Position BREAK =
        new OwnedDropTracker.Position(0.5D, 65.5D, 0.5D);

    @Test
    void attributesNewAndMergedEntitiesButNotUnchangedStaleDrops() {
        UUID stale = UUID.randomUUID();
        UUID created = UUID.randomUUID();
        OwnedDropTracker newEntity = armed(Map.of(stale, 1));

        OwnedDropTracker.Update createdUpdate = newEntity.update(List.of(
            observation(stale, 1, 0.6D, 65.0D, 0.5D, false),
            observation(created, 1, 0.7D, 65.0D, 0.5D, false)
        ), 100L);

        assertTrue(createdUpdate.latchedNow());
        assertEquals(created, createdUpdate.observation().entityId());

        OwnedDropTracker merged = armed(Map.of(stale, 1));
        OwnedDropTracker.Update mergedUpdate = merged.update(
            List.of(observation(stale, 2, 0.6D, 65.0D, 0.5D, false)), 100L);

        assertTrue(mergedUpdate.latchedNow());
        assertEquals(stale, merged.entityId());
    }

    @Test
    void retainsIdentityAcrossTheFullVerticalBoundAndSettlesAfterThreeObservations() {
        UUID owned = UUID.randomUUID();
        OwnedDropTracker tracker = armed(Map.of());
        tracker.update(List.of(observation(owned, 1, 0.5D, 65.0D, 0.5D, false)), 100L);
        tracker.update(List.of(observation(owned, 1, 0.5D, 50.0D, 0.5D, false)), 200L);

        tracker.update(List.of(observation(owned, 1, 0.5D, 49.0D, 0.5D, true)), 300L);
        tracker.update(List.of(observation(owned, 1, 0.5D, 49.0D, 0.5D, true)), 350L);
        OwnedDropTracker.Update settled = tracker.update(
            List.of(observation(owned, 1, 0.5D, 49.0D, 0.5D, true)), 400L);

        assertTrue(settled.settledNow());
        assertEquals(OwnedDropTracker.Phase.SETTLED, settled.phase());
        assertEquals(new OwnedDropTracker.Position(0.5D, 49.0D, 0.5D), tracker.settledPosition());
    }

    @Test
    void permitsOneNearbyMergeReacquisitionAndBoundsRoutes() {
        UUID first = UUID.randomUUID();
        UUID replacement = UUID.randomUUID();
        OwnedDropTracker tracker = armed(Map.of(replacement, 1));
        tracker.update(List.of(observation(first, 1, 0.5D, 65.0D, 0.5D, false)), 100L);

        OwnedDropTracker.Update reacquired = tracker.update(
            List.of(observation(replacement, 2, 0.6D, 64.9D, 0.5D, false)), 200L);

        assertTrue(reacquired.reacquiredNow());
        assertEquals(1, tracker.reacquisitions());
        assertTrue(tracker.recordRouteAttempt());
        assertTrue(tracker.recordRouteAttempt());
        assertFalse(tracker.recordRouteAttempt());
    }

    @Test
    void retainsAttributedDeltaAcrossOneLargerMergeReacquisition() {
        UUID produced = UUID.randomUUID();
        UUID stale = UUID.randomUUID();
        OwnedDropTracker tracker = armed(Map.of(stale, 2));

        tracker.update(
            List.of(observation(produced, 4, 0.5D, 65.0D, 0.5D, false)),
            100L);
        assertEquals(4, tracker.attributedStackDelta());

        OwnedDropTracker.Update merged = tracker.update(
            List.of(observation(stale, 6, 0.6D, 65.0D, 0.5D, false)),
            200L);

        assertTrue(merged.reacquiredNow());
        assertEquals(stale, tracker.entityId());
        assertEquals(4, tracker.attributedStackDelta());
    }

    @Test
    void rejectsAReplacementWhoseIncreaseCannotContainTheOwnedDelta() {
        UUID produced = UUID.randomUUID();
        UUID stale = UUID.randomUUID();
        OwnedDropTracker tracker = armed(Map.of(stale, 2));
        tracker.update(
            List.of(observation(produced, 4, 0.5D, 65.0D, 0.5D, false)),
            100L);

        OwnedDropTracker.Update rejected = tracker.update(
            List.of(observation(stale, 5, 0.6D, 65.0D, 0.5D, false)),
            200L);

        assertEquals(OwnedDropTracker.Phase.REJECTED, rejected.phase());
        assertEquals("despawned", rejected.reason());
        assertEquals(4, tracker.attributedStackDelta());
    }

    @Test
    void armedOriginCanRebaseBeforeAcquisitionWithoutLosingBaseline() {
        UUID stale = UUID.randomUUID();
        UUID produced = UUID.randomUUID();
        OwnedDropTracker tracker = new OwnedDropTracker();
        tracker.arm(Map.of(stale, 2), BREAK, 0L);

        OwnedDropTracker.Position death = new OwnedDropTracker.Position(8.5D, 65.5D, 0.5D);
        assertTrue(tracker.rebaseArmedOrigin(death));
        tracker.beginAcquisition(100L);
        OwnedDropTracker.Update update = tracker.update(List.of(
            observation(stale, 2, 8.4D, 65.0D, 0.5D, true),
            observation(produced, 3, 8.5D, 65.0D, 0.5D, false)
        ), 150L);

        assertTrue(update.latchedNow());
        assertEquals(produced, tracker.entityId());
        assertEquals(3, tracker.attributedStackDelta());
        assertFalse(tracker.rebaseArmedOrigin(BREAK));
    }

    @Test
    void adoptsAnExactlyAttributedSettledIdentityOutsideTheDiscoveryRadius() {
        UUID produced = UUID.randomUUID();
        OwnedDropTracker tracker = new OwnedDropTracker();
        tracker.arm(Map.of(), BREAK, 0L);
        tracker.beginAcquisition(100L);

        OwnedDropTracker.Observation settled = observation(
            produced, 3, 0.5D, 59.0D, 0.5D, true);
        OwnedDropTracker.Update adopted = tracker.adoptAttributed(settled, 2, 150L);

        assertTrue(adopted.latchedNow());
        assertEquals(OwnedDropTracker.Phase.AIRBORNE, adopted.phase());
        assertEquals(produced, tracker.entityId());
        assertEquals(2, tracker.attributedStackDelta());
        assertEquals(settled.position(), tracker.initialPosition());

        tracker.update(List.of(settled), 200L);
        tracker.update(List.of(settled), 250L);
        OwnedDropTracker.Update stable = tracker.update(List.of(settled), 300L);
        assertTrue(stable.settledNow());
        assertEquals(OwnedDropTracker.Phase.SETTLED, stable.phase());
    }

    @Test
    void exactAttributedAdoptionRetainsDistanceAndDeltaBounds() {
        UUID produced = UUID.randomUUID();
        OwnedDropTracker tooFar = new OwnedDropTracker();
        tooFar.arm(Map.of(), BREAK, 0L);
        tooFar.beginAcquisition(100L);
        OwnedDropTracker.Update distance = tooFar.adoptAttributed(
            observation(produced, 1, 0.5D, 40.0D, 0.5D, true), 1, 150L);
        assertEquals(OwnedDropTracker.Phase.REJECTED, distance.phase());
        assertEquals("distance_limit", distance.reason());

        OwnedDropTracker excessiveDelta = new OwnedDropTracker();
        excessiveDelta.arm(Map.of(), BREAK, 0L);
        excessiveDelta.beginAcquisition(100L);
        OwnedDropTracker.Update delta = excessiveDelta.adoptAttributed(
            observation(produced, 1, 0.5D, 60.0D, 0.5D, true), 2, 150L);
        assertEquals(OwnedDropTracker.Phase.REJECTED, delta.phase());
        assertEquals("attributed_adoption_invalid_delta", delta.reason());
    }

    @Test
    void rejectsEveryBoundedFailureAndResetsForTheNextTarget() {
        UUID stale = UUID.randomUUID();
        OwnedDropTracker acquisition = armed(Map.of(stale, 1));
        assertEquals("acquisition_timeout", acquisition.update(
            List.of(observation(stale, 1, 0.5D, 65.0D, 0.5D, true)), 2_001L).reason());

        UUID far = UUID.randomUUID();
        OwnedDropTracker distance = armed(Map.of());
        distance.update(List.of(observation(far, 1, 0.5D, 65.0D, 0.5D, false)), 10L);
        assertEquals("distance_limit", distance.update(
            List.of(observation(far, 1, 13.0D, 65.0D, 0.5D, false)), 20L).reason());

        UUID falling = UUID.randomUUID();
        OwnedDropTracker settle = armed(Map.of());
        settle.update(List.of(observation(falling, 1, 0.5D, 65.0D, 0.5D, false)), 10L);
        assertEquals("settle_timeout", settle.update(
            List.of(observation(falling, 1, 0.5D, 50.0D, 0.5D, false)), 4_011L).reason());

        UUID gone = UUID.randomUUID();
        OwnedDropTracker despawn = armed(Map.of());
        despawn.update(List.of(observation(gone, 1, 0.5D, 65.0D, 0.5D, false)), 10L);
        assertEquals("despawned", despawn.update(List.of(), 20L).reason());

        despawn.reset();
        despawn.arm(Map.of(), BREAK, 1_000L);
        assertEquals(OwnedDropTracker.Phase.ARMED, despawn.update(List.of(), 9_000L).phase());
        assertEquals(0, despawn.routeAttempts());
    }

    @Test
    void gatherTreeCompatibilityAdapterUsesTheSharedStateMachine() {
        GatherTreeDropTracker tracker = new GatherTreeDropTracker();

        assertTrue(tracker instanceof OwnedDropTracker);
        tracker.arm(Map.of(), new GatherTreeDropTracker.Position(0.5D, 65.5D, 0.5D), 0L);
        tracker.beginAcquisition(0L);
        assertEquals(GatherTreeDropTracker.Phase.ACQUIRING, tracker.update(List.of(), 100L).phase());
        assertEquals(OwnedDropTracker.MAX_ROUTE_ATTEMPTS, GatherTreeDropTracker.MAX_ROUTE_ATTEMPTS);
    }

    private static OwnedDropTracker armed(Map<UUID, Integer> baseline) {
        OwnedDropTracker tracker = new OwnedDropTracker();
        tracker.arm(baseline, BREAK, 0L);
        tracker.beginAcquisition(0L);
        return tracker;
    }

    private static OwnedDropTracker.Observation observation(
        UUID id,
        int count,
        double x,
        double y,
        double z,
        boolean grounded
    ) {
        return new OwnedDropTracker.Observation(
            id,
            count,
            new OwnedDropTracker.Position(x, y, z),
            true,
            grounded
        );
    }
}
