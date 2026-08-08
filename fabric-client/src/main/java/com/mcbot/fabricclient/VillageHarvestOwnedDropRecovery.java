package com.mcbot.fabricclient;

/**
 * Pure admission/liveness policy for an exact village-harvest drop.
 *
 * <p>Identity and settlement remain owned by {@link OwnedDropTracker}; this policy only orders the
 * authoritative inventory check ahead of bounded tracking/traversal and makes the terminal timeout
 * explicit. It grants no movement, route, or block authority.</p>
 */
final class VillageHarvestOwnedDropRecovery {
    static final long COLLECTION_TIMEOUT_MS = 8_000L;
    static final long DISAPPEARANCE_GRACE_MS = 300L;

    enum Action {
        INVENTORY_GAIN,
        HOLD_STATIONARY,
        SELECT_ROUTE,
        DRIVE_ROUTE,
        WAIT_AT_PICKUP,
        WAIT_DISAPPEARANCE,
        REJECT
    }

    record Decision(Action action, String reason) {
        Decision {
            action = action == null ? Action.REJECT : action;
            reason = reason == null ? "" : reason;
        }
    }

    private VillageHarvestOwnedDropRecovery() {
    }

    static Decision decide(
        int currentInventory,
        int baselineInventory,
        OwnedDropTracker.Phase trackerPhase,
        boolean routeSelected,
        long pickupReachedAtMs,
        boolean ownedEntityLive,
        long collectionStartedAtMs,
        long disappearanceObservedAtMs,
        long nowMs
    ) {
        if (currentInventory > baselineInventory) {
            return new Decision(Action.INVENTORY_GAIN, "inventory_delta");
        }
        long elapsedMs = collectionStartedAtMs <= 0L
            ? 0L : Math.max(0L, nowMs - collectionStartedAtMs);
        if (collectionStartedAtMs > 0L && elapsedMs >= COLLECTION_TIMEOUT_MS) {
            return new Decision(Action.REJECT, "collection_timeout");
        }
        if (!ownedEntityLive && disappearanceObservedAtMs > 0L) {
            return nowMs - disappearanceObservedAtMs < DISAPPEARANCE_GRACE_MS
                ? new Decision(Action.WAIT_DISAPPEARANCE, "inventory_sync_grace")
                : new Decision(Action.REJECT, "pickup_unconfirmed");
        }
        if (trackerPhase == OwnedDropTracker.Phase.REJECTED) {
            return new Decision(Action.REJECT, "tracker_rejected");
        }
        if (trackerPhase == OwnedDropTracker.Phase.ACQUIRING
            || trackerPhase == OwnedDropTracker.Phase.AIRBORNE
            || trackerPhase == OwnedDropTracker.Phase.ARMED) {
            return new Decision(Action.HOLD_STATIONARY, "await_owned_drop_settlement");
        }
        if (trackerPhase != OwnedDropTracker.Phase.SETTLED) {
            return new Decision(Action.REJECT, "tracker_inactive");
        }
        if (pickupReachedAtMs > 0L) {
            OwnedDropTraversal.PickupConfirmation confirmation =
                OwnedDropTraversal.pickupConfirmation(
                    pickupReachedAtMs, nowMs, ownedEntityLive);
            if (confirmation == OwnedDropTraversal.PickupConfirmation.WAIT) {
                return new Decision(Action.WAIT_AT_PICKUP, "await_inventory_delta");
            }
            return new Decision(Action.REJECT,
                confirmation == OwnedDropTraversal.PickupConfirmation.PRUNE_DISAPPEARED
                    ? "pickup_unconfirmed" : "pickup_confirmation_timeout");
        }
        return routeSelected
            ? new Decision(Action.DRIVE_ROUTE, "traverse_to_owned_drop")
            : new Decision(Action.SELECT_ROUTE, "owned_drop_settled");
    }

    static boolean exactItem(String expectedItemId, String observedItemId) {
        return expectedItemId != null
            && !expectedItemId.isBlank()
            && expectedItemId.equals(observedItemId);
    }
}
