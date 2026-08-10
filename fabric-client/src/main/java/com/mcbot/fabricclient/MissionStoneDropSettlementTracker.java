package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Bounded settlement memory for cobblestone entities produced by one mission-stone run.
 *
 * <p>The tracker deliberately owns no attribution, timeout, inventory, or world policy. Callers
 * admit exact entity identities and remove them after pickup or abandonment. Settlement mirrors
 * {@link OwnedDropTracker}: the latching observation establishes identity, then three consecutive
 * grounded or epsilon-stable observations are required.
 */
final class MissionStoneDropSettlementTracker {
    static final int MAX_TRACKED_ENTITIES = 8;
    static final double STABLE_EPSILON = OwnedDropTracker.STABLE_EPSILON;
    static final int STABLE_OBSERVATIONS = OwnedDropTracker.STABLE_OBSERVATIONS;

    enum Phase {
        TRACKING,
        SETTLED
    }

    record Snapshot(
        UUID entityId,
        Phase phase,
        OwnedDropTracker.Position initialPosition,
        OwnedDropTracker.Position lastPosition,
        OwnedDropTracker.Position settledPosition,
        int stableObservations
    ) {
        boolean settled() {
            return phase == Phase.SETTLED;
        }
    }

    record Update(
        Snapshot snapshot,
        boolean trackedNow,
        boolean settledNow,
        String reason
    ) {
        boolean accepted() {
            return snapshot != null;
        }
    }

    private final Map<UUID, EntityState> states = new LinkedHashMap<>();

    Update observe(UUID entityId, OwnedDropTracker.Position position, boolean onGround) {
        if (entityId == null || !finite(position)) {
            return new Update(null, false, false, "invalid_observation");
        }
        EntityState state = states.get(entityId);
        if (state == null) {
            if (states.size() >= MAX_TRACKED_ENTITIES) {
                return new Update(null, false, false, "capacity_limit");
            }
            state = new EntityState(position);
            states.put(entityId, state);
            return new Update(snapshot(entityId, state), true, false, "");
        }
        if (state.phase == Phase.SETTLED) {
            state.lastPosition = position;
            return new Update(snapshot(entityId, state), false, false, "");
        }

        boolean stable = onGround || position.squaredDistanceTo(state.lastPosition)
            <= STABLE_EPSILON * STABLE_EPSILON;
        state.stableObservations = stable ? state.stableObservations + 1 : 0;
        state.lastPosition = position;
        boolean settledNow = state.stableObservations >= STABLE_OBSERVATIONS;
        if (settledNow) {
            state.phase = Phase.SETTLED;
            state.settledPosition = position;
        }
        return new Update(snapshot(entityId, state), false, settledNow, "");
    }

    Snapshot snapshot(UUID entityId) {
        EntityState state = entityId == null ? null : states.get(entityId);
        return state == null ? null : snapshot(entityId, state);
    }

    List<Snapshot> snapshots() {
        List<Snapshot> values = new ArrayList<>(states.size());
        states.forEach((entityId, state) -> values.add(snapshot(entityId, state)));
        return List.copyOf(values);
    }

    boolean contains(UUID entityId) {
        return entityId != null && states.containsKey(entityId);
    }

    boolean settled(UUID entityId) {
        Snapshot value = snapshot(entityId);
        return value != null && value.settled();
    }

    int size() {
        return states.size();
    }

    boolean remove(UUID entityId) {
        return entityId != null && states.remove(entityId) != null;
    }

    void reset() {
        states.clear();
    }

    private static Snapshot snapshot(UUID entityId, EntityState state) {
        return new Snapshot(
            entityId,
            state.phase,
            state.initialPosition,
            state.lastPosition,
            state.settledPosition,
            state.stableObservations
        );
    }

    private static boolean finite(OwnedDropTracker.Position position) {
        return position != null
            && Double.isFinite(position.x())
            && Double.isFinite(position.y())
            && Double.isFinite(position.z());
    }

    private static final class EntityState {
        final OwnedDropTracker.Position initialPosition;
        OwnedDropTracker.Position lastPosition;
        OwnedDropTracker.Position settledPosition;
        int stableObservations;
        Phase phase = Phase.TRACKING;

        EntityState(OwnedDropTracker.Position position) {
            initialPosition = position;
            lastPosition = position;
        }
    }
}
