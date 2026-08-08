package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

final class MissionStoneDropSettlementTrackerTest {
    private final MissionStoneDropSettlementTracker tracker =
        new MissionStoneDropSettlementTracker();

    @Test
    void latchDoesNotCountAndThreeGroundedPollsSettleTheSameIdentity() {
        UUID entityId = UUID.randomUUID();

        MissionStoneDropSettlementTracker.Update latched =
            tracker.observe(entityId, position(0.5D, 65.0D, 0.5D), true);
        MissionStoneDropSettlementTracker.Update first =
            tracker.observe(entityId, position(0.5D, 64.5D, 0.5D), true);
        MissionStoneDropSettlementTracker.Update second =
            tracker.observe(entityId, position(0.5D, 64.0D, 0.5D), true);
        MissionStoneDropSettlementTracker.Update settled =
            tracker.observe(entityId, position(0.5D, 63.5D, 0.5D), true);

        assertTrue(latched.trackedNow());
        assertEquals(0, latched.snapshot().stableObservations());
        assertEquals(1, first.snapshot().stableObservations());
        assertEquals(2, second.snapshot().stableObservations());
        assertTrue(settled.settledNow());
        assertEquals(MissionStoneDropSettlementTracker.Phase.SETTLED, settled.snapshot().phase());
        assertEquals(entityId, settled.snapshot().entityId());
        assertEquals(position(0.5D, 63.5D, 0.5D), settled.snapshot().settledPosition());
    }

    @Test
    void airborneEpsilonStabilityIsThreeDimensionalAndConsecutive() {
        UUID entityId = UUID.randomUUID();
        tracker.observe(entityId, position(1.0D, 60.0D, 1.0D), false);

        tracker.observe(entityId, position(1.03D, 60.03D, 1.0D), false);
        assertEquals(1, tracker.snapshot(entityId).stableObservations());
        tracker.observe(entityId, position(1.09D, 60.03D, 1.0D), false);
        assertEquals(0, tracker.snapshot(entityId).stableObservations());

        tracker.observe(entityId, position(1.12D, 60.03D, 1.0D), false);
        tracker.observe(entityId, position(1.15D, 60.03D, 1.0D), false);
        MissionStoneDropSettlementTracker.Update settled =
            tracker.observe(entityId, position(1.18D, 60.03D, 1.0D), false);

        assertTrue(settled.settledNow());
        assertTrue(tracker.settled(entityId));
    }

    @Test
    void independentEntityStateRetainsIdentityAndDeterministicAdmissionOrder() {
        UUID firstId = new UUID(0L, 1L);
        UUID secondId = new UUID(0L, 2L);
        OwnedDropTracker.Position firstInitial = position(0.0D, 64.0D, 0.0D);
        OwnedDropTracker.Position secondInitial = position(4.0D, 70.0D, 4.0D);

        tracker.observe(firstId, firstInitial, false);
        tracker.observe(secondId, secondInitial, false);
        tracker.observe(firstId, position(10.0D, 20.0D, 10.0D), false);

        List<MissionStoneDropSettlementTracker.Snapshot> snapshots = tracker.snapshots();
        assertEquals(List.of(firstId, secondId), snapshots.stream()
            .map(MissionStoneDropSettlementTracker.Snapshot::entityId)
            .toList());
        assertEquals(firstInitial, tracker.snapshot(firstId).initialPosition());
        assertEquals(secondInitial, tracker.snapshot(secondId).initialPosition());
        assertEquals(2, tracker.size());
    }

    @Test
    void capacityIsEightAndRemovalFreesOneDeterministicSlot() {
        UUID[] ids = new UUID[MissionStoneDropSettlementTracker.MAX_TRACKED_ENTITIES + 1];
        for (int index = 0; index < ids.length; index++) {
            ids[index] = new UUID(1L, index);
        }
        for (int index = 0; index < MissionStoneDropSettlementTracker.MAX_TRACKED_ENTITIES; index++) {
            assertTrue(tracker.observe(ids[index], position(index, 64.0D, 0.0D), false).accepted());
        }

        MissionStoneDropSettlementTracker.Update rejected =
            tracker.observe(ids[8], position(8.0D, 64.0D, 0.0D), false);
        assertFalse(rejected.accepted());
        assertEquals("capacity_limit", rejected.reason());
        assertEquals(8, tracker.size());

        assertTrue(tracker.remove(ids[3]));
        assertFalse(tracker.contains(ids[3]));
        assertTrue(tracker.observe(ids[8], position(8.0D, 64.0D, 0.0D), false).accepted());
        assertEquals(8, tracker.size());
    }

    @Test
    void invalidObservationsDoNotConsumeCapacityAndResetRemovesEveryIdentity() {
        UUID valid = UUID.randomUUID();

        assertEquals("invalid_observation", tracker.observe(null, position(0.0D, 0.0D, 0.0D), false).reason());
        assertEquals("invalid_observation", tracker.observe(valid, null, false).reason());
        assertEquals("invalid_observation", tracker.observe(
            valid, position(Double.NaN, 0.0D, 0.0D), false).reason());
        assertEquals(0, tracker.size());

        tracker.observe(valid, position(0.0D, 64.0D, 0.0D), false);
        tracker.reset();

        assertEquals(0, tracker.size());
        assertTrue(tracker.snapshots().isEmpty());
        assertNull(tracker.snapshot(valid));
        assertFalse(tracker.remove(valid));
    }

    @Test
    void settledPositionIsFrozenWhileLatestObservationKeepsTheSameUuid() {
        UUID entityId = UUID.randomUUID();
        OwnedDropTracker.Position settledPosition = position(0.5D, 64.0D, 0.5D);
        tracker.observe(entityId, settledPosition, false);
        tracker.observe(entityId, settledPosition, true);
        tracker.observe(entityId, settledPosition, true);
        tracker.observe(entityId, settledPosition, true);

        OwnedDropTracker.Position laterPosition = position(1.0D, 64.0D, 0.5D);
        MissionStoneDropSettlementTracker.Update later =
            tracker.observe(entityId, laterPosition, false);

        assertFalse(later.settledNow());
        assertEquals(entityId, later.snapshot().entityId());
        assertEquals(settledPosition, later.snapshot().settledPosition());
        assertEquals(laterPosition, later.snapshot().lastPosition());
    }

    private static OwnedDropTracker.Position position(double x, double y, double z) {
        return new OwnedDropTracker.Position(x, y, z);
    }
}
