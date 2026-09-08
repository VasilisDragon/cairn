package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;

class CombatEncounterTrackerTest {
    private static CombatEncounterTracker.Target target(String id, double playerX, double targetX, float health) {
        return new CombatEncounterTracker.Target(id, playerX, 64, 0, targetX, 64, 0, Math.abs(targetX - playerX), health);
    }
    private static CombatEncounterTracker.Snapshot engage(CombatEncounterTracker tracker, long now, CombatEncounterTracker.Target target) {
        return tracker.tick(now, 1, true, true, target);
    }
    private static CombatEncounterTracker.Snapshot still(CombatEncounterTracker tracker, long now) {
        return engage(tracker, now, target("zombie", 0, 12, 20));
    }

    @Test void stationaryPursuitRecoversAtExactlyEightSeconds() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0);
        assertFalse(still(tracker, 7_999).recovering());
        var result = still(tracker, 8_000);
        assertTrue(result.recovering());
        assertEquals("no_progress", result.trigger());
    }
    @Test void recoveryExhaustsAtExactlyTwelveSeconds() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0); still(tracker, 8_000);
        assertFalse(tracker.tick(19_999, 1, false, true, null).exhausted());
        assertTrue(tracker.tick(20_000, 1, false, true, null).exhausted());
    }
    @Test void recoveryCannotReturnToEngageOnTheNextTick() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0); still(tracker, 8_000);
        assertTrue(engage(tracker, 8_001, target("other", 5, 6, 4)).recovering());
    }
    @Test void movingTargetDoesNotBuyProgress() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0);
        assertEquals("none", engage(tracker, 4_000, target("zombie", 0, 8, 20)).progress());
        assertTrue(engage(tracker, 8_000, target("zombie", 0, 7, 20)).recovering());
    }
    @Test void sidewaysDisplacementDoesNotBuyProgress() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0);
        var shifted = new CombatEncounterTracker.Target("zombie", 0, 64, 2, 8, 64, 0, Math.sqrt(68), 20);
        assertTrue(engage(tracker, 8_000, shifted).recovering());
    }
    @Test void genuineApproachBuysProgressButNotMoreTotalTime() {
        var tracker = new CombatEncounterTracker();
        engage(tracker, 0, target("zombie", 0, 100, 20));
        for (int second = 1; second < 30; second++) {
            var state = engage(tracker, second * 1_000, target("zombie", second, 100, 20));
            assertFalse(state.recovering());
            assertEquals("approach", state.progress());
        }
        var end = engage(tracker, 30_000, target("zombie", 30, 100, 20));
        assertTrue(end.recovering());
        assertEquals("engagement_limit", end.trigger());
    }
    @Test void subThresholdApproachAccumulatesToHalfABlock() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0);
        assertEquals("none", engage(tracker, 1_000, target("zombie", 0.49, 12, 20)).progress());
        assertEquals("approach", engage(tracker, 2_000, target("zombie", 0.5, 12, 20)).progress());
    }
    @Test void oscillationDoesNotRecreditTheSameDistance() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0);
        engage(tracker, 1_000, target("zombie", 0.5, 12, 20));
        still(tracker, 4_000);
        assertEquals("none", engage(tracker, 5_000, target("zombie", 0.5, 12, 20)).progress());
        assertTrue(engage(tracker, 9_000, target("zombie", 0.5, 12, 20)).recovering());
    }
    @Test void targetSwitchingDoesNotResetBudgets() {
        var tracker = new CombatEncounterTracker();
        for (int i = 0; i <= 8; i++) {
            var state = engage(tracker, i * 1_000, target("zombie-" + i, 0, 12, 20));
            assertEquals(i == 8, state.recovering());
        }
    }
    @Test void targetStorageIsBoundedAndOverflowNeverCreditsProgress() {
        var tracker = new CombatEncounterTracker();
        for (int i = 0; i < 40; i++) engage(tracker, i * 10, target("zombie-" + i, i, 100, 20));
        var state = engage(tracker, 8_000, target("zombie-40", 90, 100, 20));
        assertEquals(16, state.trackedTargets());
        assertTrue(state.recovering());
    }
    @Test void appliedAttackRequiresObservedDamage() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0);
        tracker.attackApplied("zombie", 20, 6_500);
        assertEquals("none", still(tracker, 7_000).progress());
        assertEquals("applied_attack_damage", engage(tracker, 7_500, target("zombie", 0, 12, 16)).progress());
        assertFalse(engage(tracker, 8_000, target("zombie", 0, 12, 16)).recovering());
    }
    @Test void uncreditedOrStaleDamageDoesNotBuyTime() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0);
        assertEquals("none", engage(tracker, 2_000, target("zombie", 0, 12, 16)).progress());
        tracker.attackApplied("zombie", 16, 2_000);
        assertTrue(engage(tracker, 8_000, target("zombie", 0, 12, 12)).recovering());
    }
    @Test void aSingleAppliedAttackCannotRepeatedlyCreditDamage() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0); tracker.attackApplied("zombie", 20, 100);
        assertEquals("applied_attack_damage", engage(tracker, 200, target("zombie", 0, 12, 16)).progress());
        assertEquals("none", engage(tracker, 300, target("zombie", 0, 12, 12)).progress());
    }
    @Test void safeDeferralPausesActiveAccountingWithoutRefundingIt() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0);
        tracker.tick(5_000, 1, false, false, null);
        var resumed = still(tracker, 25_000);
        assertEquals(5_000, resumed.activeMs());
        assertEquals(5_000, resumed.noProgressMs());
        assertTrue(still(tracker, 28_000).recovering());
    }
    @Test void onlyTwoContinuousSecondsWithoutSensedHostilesResetTheEncounter() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0); still(tracker, 8_000);
        assertTrue(tracker.tick(8_001, 0, false, false, null).recovering());
        assertTrue(tracker.tick(10_000, 0, false, false, null).recovering());
        assertFalse(tracker.tick(10_001, 0, false, false, null).recovering());
        assertFalse(still(tracker, 10_002).recovering());
    }
    @Test void shortThreatAbsenceDoesNotResetRecovery() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0); still(tracker, 8_000);
        tracker.tick(8_001, 0, false, false, null);
        assertTrue(still(tracker, 10_000).recovering());
    }
    @Test void safeReleaseDoesNotDisconnectButReacquisitionCannotRenewEscapeBudget() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0); still(tracker, 8_000);
        assertFalse(tracker.tick(20_000, 1, false, false, null).exhausted());
        assertTrue(tracker.tick(20_001, 1, false, true, null).exhausted());
    }
    @Test void genuineSessionResetClearsAllBudgetAndTargetState() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0); still(tracker, 8_000); tracker.reset();
        var result = still(tracker, 30_000);
        assertFalse(result.recovering());
        assertEquals(0, result.activeMs());
        assertEquals(1, result.trackedTargets());
    }
    @Test void invalidMeasurementsDoNotBuyProgress() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0);
        assertTrue(engage(tracker, 8_000, target("zombie", Double.NaN, 12, 20)).recovering());
    }
    @Test void clockRollbackDoesNotRefundBudget() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 1_000); still(tracker, 5_000);
        assertEquals(4_000, still(tracker, 2_000).activeMs());
        assertTrue(still(tracker, 9_000).recovering());
    }
    @Test void damageDoesNotResetTheApproachWatermarkAfterKnockback() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0);
        engage(tracker, 1000, target("zombie", 1, 12, 20));
        tracker.attackApplied("zombie", 20, 2000);
        assertEquals("applied_attack_damage", engage(tracker, 2100, target("zombie", 0, 12, 16)).progress());
        assertEquals("none", engage(tracker, 3000, target("zombie", 1, 12, 16)).progress());
        assertEquals(1, engage(tracker, 4000, target("zombie", 1, 12, 16)).approachProgressCount());
    }
    @Test void lethalDamageAfterAnAppliedAttackCountsEvenAfterTargetSelectionChanges() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0);
        tracker.attackApplied("zombie", 20, 6500);
        var result = tracker.tick(7000, 1, true, true, target("other", 0, 12, 20),
            java.util.List.of(new CombatEncounterTracker.Damage("zombie", 0)));
        assertEquals("applied_attack_damage", result.progress());
        assertEquals(0, result.noProgressMs());
        assertEquals(1, result.damageProgressCount());
        assertEquals(7000, result.activeMs());
        assertEquals(1, tracker.tick(7500, 1, true, true, target("other", 0, 12, 20),
            java.util.List.of(new CombatEncounterTracker.Damage("zombie", 0))).damageProgressCount());
    }
    @Test void UnappliedOrUnknownDeathObservationDoesNotCreditProgress() {
        var tracker = new CombatEncounterTracker();
        still(tracker, 0);
        assertTrue(tracker.tick(8000, 1, true, true, target("other", 0, 12, 20),
            java.util.List.of(new CombatEncounterTracker.Damage("zombie", 0))).recovering());
        assertEquals(0, still(tracker, 8100).damageProgressCount());
    }
}
