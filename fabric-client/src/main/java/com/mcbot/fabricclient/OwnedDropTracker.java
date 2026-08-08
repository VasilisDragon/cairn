package com.mcbot.fabricclient;

import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;

class OwnedDropTracker {
    static final long ACQUIRE_TIMEOUT_MS = 2_000L;
    static final long SETTLE_TIMEOUT_MS = 4_000L;
    static final double MAX_HORIZONTAL_DISTANCE = 12.0D;
    static final double MAX_VERTICAL_DISTANCE = 24.0D;
    static final double ATTRIBUTION_DISTANCE = 3.0D;
    static final double REACQUISITION_DISTANCE = 1.5D;
    static final double STABLE_EPSILON = 0.05D;
    static final int STABLE_OBSERVATIONS = 3;
    static final int MAX_REACQUISITIONS = 1;
    static final int MAX_ROUTE_ATTEMPTS = 2;

    enum Phase {
        IDLE,
        ARMED,
        ACQUIRING,
        AIRBORNE,
        SETTLED,
        REJECTED
    }

    record Position(double x, double y, double z) {
        double squaredDistanceTo(Position other) {
            if (other == null) {
                return Double.POSITIVE_INFINITY;
            }
            double dx = x - other.x;
            double dy = y - other.y;
            double dz = z - other.z;
            return dx * dx + dy * dy + dz * dz;
        }

        double horizontalDistanceTo(Position other) {
            return other == null ? Double.POSITIVE_INFINITY : Math.hypot(x - other.x, z - other.z);
        }
    }

    record Observation(UUID entityId, int stackCount, Position position, boolean alive, boolean onGround) {
        Observation {
            stackCount = Math.max(0, stackCount);
        }
    }

    record Update(
        Phase phase,
        Observation observation,
        Position initialPosition,
        Position settledPosition,
        String reason,
        boolean latchedNow,
        boolean settledNow,
        boolean reacquiredNow
    ) {
    }

    private Map<UUID, Integer> baseline = Map.of();
    private Position breakPosition;
    private long armedAtMs;
    private long latchedAtMs;
    private Phase phase = Phase.IDLE;
    private UUID entityId;
    private Position initialPosition;
    private Position lastPosition;
    private Position settledPosition;
    private int stableObservations;
    private int reacquisitions;
    private int routeAttempts;
    /**
     * Exact portion of the latched stack attributable to the owned drop.
     *
     * <p>The observed entity stack may later merge with an unrelated stack.  Keep the original
     * delta rather than silently promoting the whole merged stack to owned inventory.
     */
    private int attributedStackDelta;
    private String rejectionReason = "";

    void arm(Map<UUID, Integer> baselineCounts, Position brokenBlockCenter, long nowMs) {
        reset();
        baseline = baselineCounts == null ? Map.of() : Map.copyOf(baselineCounts);
        breakPosition = brokenBlockCenter;
        armedAtMs = 0L;
        phase = Phase.ARMED;
    }

    void beginAcquisition(long nowMs) {
        if (phase == Phase.ARMED) {
            armedAtMs = nowMs;
            phase = Phase.ACQUIRING;
        }
    }

    /**
     * Adopt an identity that a producing subsystem already attributed from its exact pre-event
     * snapshot. This is intentionally narrower than ordinary acquisition: it does not search or
     * infer ownership, it preserves the caller-supplied owned-unit count, and it still enforces the
     * original break-position distance envelope.
     */
    Update adoptAttributed(Observation observation, int exactAttributedDelta, long nowMs) {
        if (phase != Phase.ACQUIRING) {
            reject("attributed_adoption_invalid_phase");
            return currentUpdate(null, false, false, false);
        }
        if (observation == null
            || !observation.alive()
            || observation.entityId() == null
            || observation.position() == null) {
            reject("attributed_adoption_invalid_observation");
            return currentUpdate(observation, false, false, false);
        }
        int ownedUnits = Math.max(0, exactAttributedDelta);
        if (ownedUnits <= 0 || observation.stackCount() < ownedUnits) {
            reject("attributed_adoption_invalid_delta");
            return currentUpdate(observation, false, false, false);
        }
        if (!withinBounds(observation.position())) {
            reject("distance_limit");
            return currentUpdate(observation, false, false, false);
        }
        entityId = observation.entityId();
        attributedStackDelta = ownedUnits;
        initialPosition = observation.position();
        lastPosition = observation.position();
        latchedAtMs = nowMs;
        phase = Phase.AIRBORNE;
        stableObservations = 0;
        return currentUpdate(observation, true, false, false);
    }

    /**
     * Move the attribution origin while the tracker is armed but before the producing event is
     * confirmed.  Combat uses this to snapshot before the first hit and then bind the drop search
     * to the exact death position without discarding the pre-attack entity baseline.
     */
    boolean rebaseArmedOrigin(Position origin) {
        if (phase != Phase.ARMED || origin == null) {
            return false;
        }
        breakPosition = origin;
        return true;
    }

    Update update(List<Observation> values, long nowMs) {
        List<Observation> observations = values == null ? List.of() : values.stream()
            .filter(value -> value != null && value.alive() && value.entityId() != null && value.position() != null)
            .toList();
        if (phase == Phase.IDLE || phase == Phase.ARMED || phase == Phase.REJECTED) {
            return currentUpdate(null, false, false, false);
        }
        boolean latchedNow = false;
        boolean settledNow = false;
        boolean reacquiredNow = false;
        Observation owned = ownedObservation(observations);
        if (entityId == null) {
            if (nowMs - armedAtMs > ACQUIRE_TIMEOUT_MS) {
                reject("acquisition_timeout");
                return currentUpdate(null, false, false, false);
            }
            owned = attributable(observations, breakPosition);
            if (owned == null) {
                return currentUpdate(null, false, false, false);
            }
            latch(owned, nowMs);
            latchedNow = true;
        } else if (owned == null) {
            if (reacquisitions >= MAX_REACQUISITIONS) {
                reject("reacquisition_limit");
                return currentUpdate(null, false, false, false);
            }
            owned = attributable(observations, lastPosition, attributedStackDelta);
            if (owned == null || owned.position().horizontalDistanceTo(lastPosition) > REACQUISITION_DISTANCE
                || Math.abs(owned.position().y() - lastPosition.y()) > REACQUISITION_DISTANCE) {
                reject("despawned");
                return currentUpdate(null, false, false, false);
            }
            entityId = owned.entityId();
            reacquisitions++;
            reacquiredNow = true;
        }
        if (!withinBounds(owned.position())) {
            reject("distance_limit");
            return currentUpdate(owned, latchedNow, false, reacquiredNow);
        }
        if (phase == Phase.SETTLED) {
            lastPosition = owned.position();
            return currentUpdate(owned, latchedNow, false, reacquiredNow);
        }
        if (nowMs - latchedAtMs > SETTLE_TIMEOUT_MS) {
            reject("settle_timeout");
            return currentUpdate(owned, latchedNow, false, reacquiredNow);
        }
        boolean stable = !latchedNow && (owned.onGround()
            || (lastPosition != null
                && owned.position().squaredDistanceTo(lastPosition) <= STABLE_EPSILON * STABLE_EPSILON));
        stableObservations = stable ? stableObservations + 1 : 0;
        lastPosition = owned.position();
        if (stableObservations >= STABLE_OBSERVATIONS) {
            phase = Phase.SETTLED;
            settledPosition = owned.position();
            settledNow = true;
        }
        return currentUpdate(owned, latchedNow, settledNow, reacquiredNow);
    }

    boolean armed() {
        return phase != Phase.IDLE;
    }

    boolean settled() {
        return phase == Phase.SETTLED;
    }

    UUID entityId() {
        return entityId;
    }

    Position initialPosition() {
        return initialPosition;
    }

    Position settledPosition() {
        return settledPosition;
    }

    int reacquisitions() {
        return reacquisitions;
    }

    int routeAttempts() {
        return routeAttempts;
    }

    int attributedStackDelta() {
        return attributedStackDelta;
    }

    boolean recordRouteAttempt() {
        if (routeAttempts >= MAX_ROUTE_ATTEMPTS) {
            return false;
        }
        routeAttempts++;
        return true;
    }

    void moveSettledPosition(Position position) {
        if (phase == Phase.SETTLED && position != null) {
            settledPosition = position;
            lastPosition = position;
        }
    }

    void reset() {
        baseline = Map.of();
        breakPosition = null;
        armedAtMs = 0L;
        latchedAtMs = 0L;
        phase = Phase.IDLE;
        entityId = null;
        initialPosition = null;
        lastPosition = null;
        settledPosition = null;
        stableObservations = 0;
        reacquisitions = 0;
        routeAttempts = 0;
        attributedStackDelta = 0;
        rejectionReason = "";
    }

    private void latch(Observation observation, long nowMs) {
        entityId = observation.entityId();
        attributedStackDelta = attributableDelta(observation);
        initialPosition = observation.position();
        lastPosition = observation.position();
        latchedAtMs = nowMs;
        phase = Phase.AIRBORNE;
        stableObservations = 0;
    }

    private Observation ownedObservation(List<Observation> observations) {
        if (entityId == null) {
            return null;
        }
        return observations.stream().filter(value -> entityId.equals(value.entityId())).findFirst().orElse(null);
    }

    private Observation attributable(List<Observation> observations, Position origin) {
        return attributable(observations, origin, 1);
    }

    private Observation attributable(
        List<Observation> observations,
        Position origin,
        int minimumAttributedDelta
    ) {
        if (origin == null) {
            return null;
        }
        int requiredDelta = Math.max(1, minimumAttributedDelta);
        return observations.stream()
            .filter(value -> value.position().squaredDistanceTo(origin) <= ATTRIBUTION_DISTANCE * ATTRIBUTION_DISTANCE)
            .filter(value -> attributableDelta(value) >= requiredDelta)
            .min(Comparator
                .comparingDouble((Observation value) -> value.position().squaredDistanceTo(origin))
                .thenComparing(value -> value.entityId().toString()))
            .orElse(null);
    }

    private int attributableDelta(Observation observation) {
        if (observation == null || observation.entityId() == null) {
            return 0;
        }
        return Math.max(
            0,
            observation.stackCount() - baseline.getOrDefault(observation.entityId(), 0)
        );
    }

    private boolean withinBounds(Position position) {
        return breakPosition != null
            && position.horizontalDistanceTo(breakPosition) <= MAX_HORIZONTAL_DISTANCE
            && Math.abs(position.y() - breakPosition.y()) <= MAX_VERTICAL_DISTANCE;
    }

    private void reject(String reason) {
        phase = Phase.REJECTED;
        rejectionReason = reason;
    }

    private Update currentUpdate(Observation observation, boolean latchedNow, boolean settledNow, boolean reacquiredNow) {
        return new Update(
            phase,
            observation,
            initialPosition,
            settledPosition,
            rejectionReason,
            latchedNow,
            settledNow,
            reacquiredNow
        );
    }
}
