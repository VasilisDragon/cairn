package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;

class CombatThreatAdmissionTest {
    @Test void nonVanillaNamesAndExpandedSensingDoNotExpandDeferralPermission() {
        assertEquals(CombatPlanner.ThreatKind.NONE,
            CombatThreatAdmission.deferralKind("other:zombie", CombatPlanner.ThreatKind.MELEE));
        assertEquals(CombatPlanner.ThreatKind.MELEE,
            CombatThreatAdmission.deferralKind("minecraft:zombie", CombatPlanner.ThreatKind.MELEE));
        assertFalse(CombatThreatAdmission.defer(new CombatThreatAdmission.Observation(
            CombatPlanner.ThreatKind.MELEE, 16.001, 32,
            CombatThreatAdmission.Visibility.BLOCKED, CombatThreatAdmission.Visibility.BLOCKED,
            true, true, 20, 8, 5_000)));
    }
    private static CombatThreatAdmission.Observation observation(CombatPlanner.ThreatKind kind, double distance,
        CombatThreatAdmission.Visibility eye, CombatThreatAdmission.Visibility torso,
        boolean grounded, boolean dry, float health, long quiet) {
        return new CombatThreatAdmission.Observation(kind, distance, 16, eye, torso, grounded, dry, health, 8, quiet);
    }
    private static final CombatThreatAdmission.Visibility BLOCKED = CombatThreatAdmission.Visibility.BLOCKED;
    private static final CombatThreatAdmission.Visibility CLEAR = CombatThreatAdmission.Visibility.CLEAR;
    private static final CombatThreatAdmission.Visibility UNKNOWN = CombatThreatAdmission.Visibility.UNKNOWN;
    private static CombatThreatAdmission.Observation screened(double distance) {
        return observation(CombatPlanner.ThreatKind.MELEE, distance, BLOCKED, BLOCKED, true, true, 20, 5_000);
    }

    @Test void defersPositivelyScreenedDistantMelee() { assertTrue(CombatThreatAdmission.defer(screened(12))); }
    @Test void eightBlockBoundaryIsActionable() { assertFalse(CombatThreatAdmission.defer(screened(8))); }
    @Test void justAboveEightCanDefer() { assertTrue(CombatThreatAdmission.defer(screened(8.001))); }
    @Test void sensingBoundaryCanDefer() { assertTrue(CombatThreatAdmission.defer(screened(16))); }
    @Test void outsideSensingRangeCannotEstablishDeferral() { assertFalse(CombatThreatAdmission.defer(screened(16.001))); }
    @Test void invalidDistanceCannotDefer() {
        for (double distance : new double[]{Double.NaN, Double.POSITIVE_INFINITY, -1}) assertFalse(CombatThreatAdmission.defer(screened(distance)));
    }
    @Test void visibleEyeImmediatelyReacquires() { assertFalse(CombatThreatAdmission.defer(observation(CombatPlanner.ThreatKind.MELEE, 12, CLEAR, BLOCKED, true, true, 20, 5_000))); }
    @Test void visibleTorsoImmediatelyReacquires() { assertFalse(CombatThreatAdmission.defer(observation(CombatPlanner.ThreatKind.MELEE, 12, BLOCKED, CLEAR, true, true, 20, 5_000))); }
    @Test void unknownVisibilityIsActionable() {
        for (CombatThreatAdmission.Visibility visibility : new CombatThreatAdmission.Visibility[]{UNKNOWN, null}) {
            assertFalse(CombatThreatAdmission.defer(observation(CombatPlanner.ThreatKind.MELEE, 12, visibility, BLOCKED, true, true, 20, 5_000)));
            assertFalse(CombatThreatAdmission.defer(observation(CombatPlanner.ThreatKind.MELEE, 12, BLOCKED, visibility, true, true, 20, 5_000)));
        }
    }
    @Test void unsupportedPlayerCannotDefer() { assertFalse(CombatThreatAdmission.defer(observation(CombatPlanner.ThreatKind.MELEE, 12, BLOCKED, BLOCKED, false, true, 20, 5_000))); }
    @Test void wetPlayerCannotDefer() { assertFalse(CombatThreatAdmission.defer(observation(CombatPlanner.ThreatKind.MELEE, 12, BLOCKED, BLOCKED, true, false, 20, 5_000))); }
    @Test void lowAndUnknownHealthCannotDefer() {
        for (float health : new float[]{8, 4, Float.NaN}) assertFalse(CombatThreatAdmission.defer(observation(CombatPlanner.ThreatKind.MELEE, 12, BLOCKED, BLOCKED, true, true, health, 5_000)));
    }
    @Test void damageQuietBoundaryIsExact() {
        assertFalse(CombatThreatAdmission.defer(observation(CombatPlanner.ThreatKind.MELEE, 12, BLOCKED, BLOCKED, true, true, 20, 4_999)));
        assertTrue(CombatThreatAdmission.defer(screened(12)));
    }
    @Test void rangedAndExplosiveNeverDefer() {
        for (CombatPlanner.ThreatKind kind : new CombatPlanner.ThreatKind[]{CombatPlanner.ThreatKind.RANGED, CombatPlanner.ThreatKind.EXPLOSIVE, CombatPlanner.ThreatKind.NONE}) {
            assertFalse(CombatThreatAdmission.defer(observation(kind, 12, BLOCKED, BLOCKED, true, true, 20, 5_000)));
        }
    }
    @Test void missingObservationIsActionable() { assertFalse(CombatThreatAdmission.defer(null)); }
    @Test void legacyMeleeFallbackIsNotPositiveThreatClassification() {
        for (String type : new String[]{"witch", "drowned", "evoker", "unknown_modded_hostile", null}) {
            assertEquals(CombatPlanner.ThreatKind.NONE, CombatThreatAdmission.deferralKind(type, CombatPlanner.ThreatKind.MELEE));
        }
        assertEquals(CombatPlanner.ThreatKind.MELEE, CombatThreatAdmission.deferralKind("zombie", CombatPlanner.ThreatKind.MELEE));
        assertEquals(CombatPlanner.ThreatKind.NONE, CombatThreatAdmission.deferralKind("zombie", CombatPlanner.ThreatKind.RANGED));
    }
    @Test void reasonDistinguishesScreeningFromUnknownVisibilityAndBudget() {
        assertEquals("both_colliders_blocked", CombatThreatAdmission.reason(screened(12), false));
        assertEquals("probe_budget", CombatThreatAdmission.reason(screened(12), true));
        assertEquals("unknown_visibility", CombatThreatAdmission.reason(observation(CombatPlanner.ThreatKind.MELEE, 12, UNKNOWN, UNKNOWN, true, true, 20, 5_000), false));
    }
    @Test void unprobedCandidateFailsClosedAndProbeBudgetIsEight() {
        assertEquals(8, CombatThreatAdmission.MAX_PROBES_PER_TICK);
        assertFalse(CombatThreatAdmission.defer(observation(CombatPlanner.ThreatKind.MELEE, 12, UNKNOWN, UNKNOWN, true, true, 20, 5_000)));
    }
    @Test void existingOutnumberedAndCriticalHealthRulesRemainInForce() {
        var config = CombatPlanner.Config.defaults();
        assertEquals(CombatPlanner.Action.FLEE, CombatPlanner.decide(CombatPlanner.State.idle(),
            new CombatPlanner.Observation(20, 4, 10, CombatPlanner.ThreatKind.MELEE, true, true), config).action());
        assertEquals(CombatPlanner.Action.LOGOUT, CombatPlanner.decide(CombatPlanner.State.idle(),
            new CombatPlanner.Observation(4, 1, 10, CombatPlanner.ThreatKind.MELEE, true, true), config).action());
    }
    @Test void eightEligibleProbesExhaustTheTickAndTheNextTickStartsFresh() {
        var budget = new CombatThreatAdmission.ProbeBudget();
        for (int i = 0; i < 8; i++) assertTrue(budget.acquire(screened(12)));
        for (int i = 0; i < 12; i++) assertFalse(budget.acquire(screened(12)));
        assertEquals(8, budget.used());
        assertTrue(new CombatThreatAdmission.ProbeBudget().acquire(screened(12)));
    }
    @Test void IneligibleCandidatesDoNotSpendTheVisibilityProbeBudget() {
        var budget = new CombatThreatAdmission.ProbeBudget();
        assertFalse(budget.acquire(screened(8)));
        assertFalse(budget.acquire(null));
        assertEquals(0, budget.used());
        assertTrue(budget.acquire(screened(12)));
    }
}
