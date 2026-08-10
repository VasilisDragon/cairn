package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Pure bounded accounting for exact cobblestone units produced by a frozen mission-stone sequence.
 *
 * <p>A terminal stone-to-air observation admits one verified production unit immediately, before an item
 * entity necessarily exists. Later entity stack deltas attribute units for collection, while authoritative
 * inventory gains reconcile and prune the oldest pending productions. Consequently entity merges do not
 * undercount, and the eight-unit bound is an active batch rather than a command-lifetime limit.
 * Predicted or merely visible stone never enters this state.
 */
final class MissionStoneDropBatch {
    static final int MAX_PENDING_UNITS = 8;

    private MissionStoneDropBatch() {
    }

    enum Action {
        COMPLETE,
        CONTINUE_MINING,
        WAIT_FOR_ATTRIBUTION_OR_AUTO_PICKUP,
        RECOVER_SETTLED_DROP
    }

    /** One exact verified stone-to-air production. A Minecraft stone block produces one cobblestone unit. */
    record Production(
        String productionId,
        String entityId,
        boolean settled,
        boolean insideRoutePickupEnvelope
    ) {
        Production {
            productionId = normalize(productionId);
            entityId = normalize(entityId);
        }

        boolean attributed() {
            return !entityId.isBlank();
        }
    }

    record State(int lastAuthoritativeInventory, List<Production> pending) {
        State {
            lastAuthoritativeInventory = Math.max(0, lastAuthoritativeInventory);
            pending = normalizedProductions(pending);
        }

        static State begin(int authoritativeInventory) {
            return new State(authoritativeInventory, List.of());
        }

        int pendingUnits() {
            return pending.size();
        }

        int attributedUnits() {
            return (int) pending.stream().filter(Production::attributed).count();
        }
    }

    record Update(State state, int unitsChanged, boolean accepted, String reason) {
    }

    record Decision(
        State state,
        Action action,
        String recoveryEntityId,
        int recoveryUnits,
        int authoritativeDeficit,
        int pendingUnits,
        String reason
    ) {
    }

    /** Admit verified physical production before an entity is visible. */
    static Update recordProduced(State state, String productionId) {
        State current = state == null ? State.begin(0) : state;
        String id = normalize(productionId);
        if (id.isBlank()) {
            return new Update(current, 0, false, "invalid_production");
        }
        if (current.pending().stream().anyMatch(production -> production.productionId().equals(id))) {
            return new Update(current, 0, false, "duplicate_production");
        }
        if (current.pendingUnits() >= MAX_PENDING_UNITS) {
            return new Update(current, 0, false, "batch_full");
        }
        List<Production> next = new ArrayList<>(current.pending());
        next.add(new Production(id, "", false, false));
        return new Update(new State(current.lastAuthoritativeInventory(), next), 1, true, "produced");
    }

    /**
     * Attribute a positive observed entity stack delta to the oldest unattributed production units.
     * Multiple units may intentionally share one entity ID after vanilla merges their item stacks.
     */
    static Update observeEntityStackDelta(
        State state,
        String entityId,
        int positiveStackDelta,
        boolean settled,
        boolean insideRoutePickupEnvelope
    ) {
        State current = state == null ? State.begin(0) : state;
        String id = normalize(entityId);
        int requested = Math.max(0, positiveStackDelta);
        if (id.isBlank()) {
            return new Update(current, 0, false, "invalid_entity");
        }
        List<Production> next = new ArrayList<>(current.pending().size());
        int remaining = requested;
        int attributed = 0;
        boolean existingEntity = false;
        for (Production production : current.pending()) {
            if (production.entityId().equals(id)) {
                existingEntity = true;
                next.add(new Production(
                    production.productionId(), id, settled, insideRoutePickupEnvelope));
            } else if (!production.attributed() && remaining > 0) {
                next.add(new Production(
                    production.productionId(), id, settled, insideRoutePickupEnvelope));
                remaining--;
                attributed++;
            } else {
                next.add(production);
            }
        }
        if (requested == 0 && !existingEntity) {
            return new Update(current, 0, false, "entity_not_tracked");
        }
        if (requested > 0 && attributed == 0 && !existingEntity) {
            return new Update(current, 0, false, "no_unattributed_production");
        }
        return new Update(
            new State(current.lastAuthoritativeInventory(), next),
            attributed,
            true,
            remaining > 0 ? "stack_delta_exceeds_pending" : "entity_observed"
        );
    }

    /** Update settlement/envelope state without inventing another produced unit. */
    static Update observeEntityState(
        State state,
        String entityId,
        boolean settled,
        boolean insideRoutePickupEnvelope
    ) {
        return observeEntityStackDelta(state, entityId, 0, settled, insideRoutePickupEnvelope);
    }

    /**
     * Prune all units attributed to an entity only after the caller's bounded merge/replacement
     * reacquisition has classified it as genuinely gone. Disappearance never counts as inventory gain.
     */
    static Update pruneDisappearedEntity(State state, String entityId) {
        State current = state == null ? State.begin(0) : state;
        String id = normalize(entityId);
        if (id.isBlank()) {
            return new Update(current, 0, false, "invalid_entity");
        }
        List<Production> next = current.pending().stream()
            .filter(production -> !production.entityId().equals(id))
            .toList();
        int removed = current.pending().size() - next.size();
        return removed <= 0
            ? new Update(current, 0, false, "entity_not_tracked")
            : new Update(
                new State(current.lastAuthoritativeInventory(), next),
                removed,
                true,
                "disappeared_pruned"
            );
    }

    /**
     * Reconcile authoritative inventory increases against pending production. The live overload removes
     * attributed identities proven absent first. Units already inside a guaranteed pickup envelope follow,
     * because a later-produced drop may be collected before an older off-route drop. Unattributed units are
     * next (the entity may have been collected before its first observation), then the remaining oldest units
     * provide the deterministic fallback. Inventory decreases are ignored so a cursor transient cannot
     * fabricate a later gain; verified between-stage consumption must use
     * {@link #rebaseAfterVerifiedConsumption(State, int)} explicitly.
     */
    static Update reconcileInventory(State state, int authoritativeInventory) {
        return reconcileInventory(state, authoritativeInventory, null);
    }

    /**
     * Entity-aware reconciliation for a live inventory gain. Attributed identities that are no longer
     * alive are the strongest evidence for an out-of-order pickup and are removed before envelope and
     * deterministic fallback ordering. A {@code null} collection means live identity evidence was not
     * sampled; an empty collection means it was sampled and none of the pending identities remain alive.
     */
    static Update reconcileInventory(
        State state,
        int authoritativeInventory,
        Collection<String> liveEntityIds
    ) {
        State current = state == null ? State.begin(authoritativeInventory) : state;
        int observed = Math.max(0, authoritativeInventory);
        if (observed < current.lastAuthoritativeInventory()) {
            return new Update(current, 0, true, "inventory_decrease_ignored");
        }
        int gain = Math.max(0, observed - current.lastAuthoritativeInventory());
        int reconciled = Math.min(gain, current.pendingUnits());
        List<Production> next = reconciled == 0
            ? current.pending()
            : removeCollectedProductions(current.pending(), reconciled, liveEntityIds);
        return new Update(
            new State(observed, next),
            reconciled,
            true,
            gain > reconciled ? "inventory_gain_exceeds_pending" : "inventory_reconciled"
        );
    }

    /**
     * Rebase after a separately verified crafting/consumption transition between mission-stone
     * requirements. A live produced unit may never be discarded by rebasing; callers must first
     * reconcile or explicitly abandon it through the existing bounded drop path.
     */
    static Update rebaseAfterVerifiedConsumption(State state, int authoritativeInventory) {
        State current = state == null ? State.begin(authoritativeInventory) : state;
        if (current.pendingUnits() > 0) {
            return new Update(current, 0, false, "pending_production_prevents_rebase");
        }
        int observed = Math.max(0, authoritativeInventory);
        return new Update(
            new State(observed, List.of()),
            0,
            true,
            observed == current.lastAuthoritativeInventory() ? "inventory_baseline_unchanged" : "inventory_rebased"
        );
    }

    /** Reconciles inventory first, then decides whether another verified block may be broken. */
    static Decision decide(int authoritativeCobblestone, int completionCobblestone, State state) {
        Update reconciliation = reconcileInventory(state, authoritativeCobblestone);
        State current = reconciliation.state();
        int owned = Math.max(0, authoritativeCobblestone);
        int target = Math.max(0, completionCobblestone);
        if (target > 0 && owned >= target) {
            return new Decision(
                current,
                Action.COMPLETE,
                "",
                0,
                0,
                current.pendingUnits(),
                "inventory_requirement_satisfied"
            );
        }

        int deficit = target <= 0 ? Integer.MAX_VALUE : target - owned;
        boolean enoughVerifiedProduction = target > 0 && current.pendingUnits() >= deficit;
        boolean batchFull = current.pendingUnits() >= MAX_PENDING_UNITS;
        EntityGroup recovery = firstSettledOutsideEnvelope(current.pending());
        if ((enoughVerifiedProduction || batchFull) && recovery != null) {
            return new Decision(
                current,
                Action.RECOVER_SETTLED_DROP,
                recovery.entityId(),
                recovery.units(),
                deficit,
                current.pendingUnits(),
                enoughVerifiedProduction ? "verified_production_covers_deficit" : "drop_batch_full"
            );
        }
        if (enoughVerifiedProduction || batchFull) {
            return new Decision(
                current,
                Action.WAIT_FOR_ATTRIBUTION_OR_AUTO_PICKUP,
                "",
                0,
                deficit,
                current.pendingUnits(),
                enoughVerifiedProduction ? "verified_production_covers_deficit" : "drop_batch_full"
            );
        }
        return new Decision(
            current,
            Action.CONTINUE_MINING,
            "",
            0,
            deficit,
            current.pendingUnits(),
            "batch_has_capacity"
        );
    }

    private static EntityGroup firstSettledOutsideEnvelope(List<Production> pending) {
        Set<String> checked = new LinkedHashSet<>();
        for (Production production : pending) {
            if (!production.attributed()
                || !production.settled()
                || production.insideRoutePickupEnvelope()
                || !checked.add(production.entityId())) {
                continue;
            }
            int units = (int) pending.stream()
                .filter(candidate -> candidate.entityId().equals(production.entityId()))
                .count();
            return new EntityGroup(production.entityId(), units);
        }
        return null;
    }

    private static List<Production> removeCollectedProductions(
        List<Production> pending,
        int collectedUnits,
        Collection<String> liveEntityIds
    ) {
        boolean[] removed = new boolean[pending.size()];
        int remaining = Math.min(Math.max(0, collectedUnits), pending.size());
        Set<String> live = liveEntityIds == null
            ? null
            : liveEntityIds.stream().map(MissionStoneDropBatch::normalize)
                .filter(value -> !value.isBlank())
                .collect(java.util.stream.Collectors.toUnmodifiableSet());
        if (live != null) {
            remaining = markCollected(
                pending,
                removed,
                remaining,
                production -> production.attributed() && !live.contains(production.entityId())
            );
        }
        remaining = markCollected(
            pending, removed, remaining, production -> production.insideRoutePickupEnvelope());
        remaining = markCollected(
            pending, removed, remaining, production -> !production.attributed());
        markCollected(pending, removed, remaining, production -> true);

        List<Production> retained = new ArrayList<>(pending.size() - collectedUnits);
        for (int index = 0; index < pending.size(); index++) {
            if (!removed[index]) {
                retained.add(pending.get(index));
            }
        }
        return List.copyOf(retained);
    }

    private static int markCollected(
        List<Production> pending,
        boolean[] removed,
        int remaining,
        java.util.function.Predicate<Production> eligible
    ) {
        int left = remaining;
        for (int index = 0; index < pending.size() && left > 0; index++) {
            if (!removed[index] && eligible.test(pending.get(index))) {
                removed[index] = true;
                left--;
            }
        }
        return left;
    }

    private static List<Production> normalizedProductions(List<Production> productions) {
        if (productions == null || productions.isEmpty()) {
            return List.of();
        }
        List<Production> normalized = new ArrayList<>();
        Set<String> identities = new LinkedHashSet<>();
        for (Production production : productions) {
            if (production == null
                || production.productionId().isBlank()
                || !identities.add(production.productionId())) {
                continue;
            }
            if (normalized.size() >= MAX_PENDING_UNITS) {
                break;
            }
            normalized.add(production);
        }
        return List.copyOf(normalized);
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim();
    }

    private record EntityGroup(String entityId, int units) {
    }
}
