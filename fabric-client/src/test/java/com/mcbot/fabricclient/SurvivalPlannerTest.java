package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class SurvivalPlannerTest {
    private static final SurvivalPlanner.Config CFG = SurvivalPlanner.Config.defaults();

    private static SurvivalPlanner.Observation obs(
        float health, int food, boolean hasFood, boolean onGround, double hostile) {
        return new SurvivalPlanner.Observation(health, food, hasFood, onGround, hostile, false, false, 300, false);
    }

    private static SurvivalPlanner.Observation water(
        float health, boolean touching, boolean submerged, int air) {
        return water(health, touching, submerged, air, false);
    }

    private static SurvivalPlanner.Observation water(
        float health, boolean touching, boolean submerged, int air, boolean dryStable) {
        return new SurvivalPlanner.Observation(health, 20, true, false, -1.0D, touching, submerged, air, dryStable);
    }

    @Test
    void swimUpEngagesWhenSubmergedAndAirRunsLow() {
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(
            SurvivalPlanner.State.idle(), water(20f, true, true, 239), CFG);
        assertEquals(SurvivalPlanner.Action.SWIM_UP, d.action());
        assertEquals(SurvivalPlanner.Mode.SURFACING, d.state().mode());
        assertTrue(d.reason().startsWith("swim_up_start"));
    }

    @Test
    void swimUpDoesNotEngageWithAmpleAir() {
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(
            SurvivalPlanner.State.idle(), water(20f, true, true, 240), CFG);
        assertEquals(SurvivalPlanner.Action.NONE, d.action());
    }

    @Test
    void swimUpContinuesAtSurfaceUntilAirRecovers() {
        SurvivalPlanner.State surfacing = new SurvivalPlanner.State(SurvivalPlanner.Mode.SURFACING);
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(surfacing, water(20f, true, false, 289), CFG);
        assertEquals(SurvivalPlanner.Action.SWIM_UP, d.action());
        assertEquals(SurvivalPlanner.Mode.SURFACING, d.state().mode());
    }

    @Test
    void airRecoveryHandsOffToWadeOutNotToIdle() {
        SurvivalPlanner.State surfacing = new SurvivalPlanner.State(SurvivalPlanner.Mode.SURFACING);
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(surfacing, water(20f, true, false, 290), CFG);
        assertEquals(SurvivalPlanner.Action.SWIM_TO_SHORE, d.action());
        assertEquals(SurvivalPlanner.Mode.WADING_OUT, d.state().mode());
        assertTrue(d.reason().startsWith("swim_to_shore_start"));
    }

    @Test
    void leavingWaterColumnStillWadesOutUntilDryStable() {
        SurvivalPlanner.State surfacing = new SurvivalPlanner.State(SurvivalPlanner.Mode.SURFACING);
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(surfacing, water(20f, false, false, 100), CFG);
        assertEquals(SurvivalPlanner.Action.SWIM_TO_SHORE, d.action());
        assertEquals(SurvivalPlanner.Mode.WADING_OUT, d.state().mode());
    }

    @Test
    void wadeOutContinuesWhileWetOrUnstable() {
        SurvivalPlanner.State wading = new SurvivalPlanner.State(SurvivalPlanner.Mode.WADING_OUT);
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(wading, water(20f, true, false, 300, false), CFG);
        assertEquals(SurvivalPlanner.Action.SWIM_TO_SHORE, d.action());
        assertEquals(SurvivalPlanner.Mode.WADING_OUT, d.state().mode());
        assertTrue(d.reason().startsWith("swim_to_shore_continue"));
    }

    @Test
    void wadeOutCompletesOnlyOnStableDryGround() {
        SurvivalPlanner.State wading = new SurvivalPlanner.State(SurvivalPlanner.Mode.WADING_OUT);
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(wading, water(20f, false, false, 300, true), CFG);
        assertEquals(SurvivalPlanner.Action.NONE, d.action());
        assertEquals(SurvivalPlanner.Mode.IDLE, d.state().mode());
        assertTrue(d.reason().startsWith("swim_to_shore_complete"));
    }

    @Test
    void wadeOutReentersSurfacingWhenAirDropsAgain() {
        SurvivalPlanner.State wading = new SurvivalPlanner.State(SurvivalPlanner.Mode.WADING_OUT);
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(wading, water(20f, true, true, 100, false), CFG);
        assertEquals(SurvivalPlanner.Action.SWIM_UP, d.action());
        assertEquals(SurvivalPlanner.Mode.SURFACING, d.state().mode());
        assertTrue(d.reason().startsWith("swim_up_restart"));
    }

    @Test
    void swimUpOutranksHostileRetreatWhileDrowning() {
        SurvivalPlanner.Observation drowningWithHostile =
            new SurvivalPlanner.Observation(5.0f, 20, true, false, 4.0D, true, true, 50, false);
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(
            SurvivalPlanner.State.idle(), drowningWithHostile, CFG);
        assertEquals(SurvivalPlanner.Action.SWIM_UP, d.action());
    }

    @Test
    void criticalHealthLogoutStillOutranksSwimUp() {
        SurvivalPlanner.Observation drowningCritical =
            new SurvivalPlanner.Observation(3.8f, 20, false, false, -1.0D, true, true, 0, false);
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(
            SurvivalPlanner.State.idle(), drowningCritical, CFG);
        assertEquals(SurvivalPlanner.Action.LOGOUT, d.action());
    }

    @Test
    void healthyAndFedDoesNothing() {
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(
            SurvivalPlanner.State.idle(), obs(20f, 20, true, true, -1.0D), CFG);
        assertEquals(SurvivalPlanner.Action.NONE, d.action());
        assertEquals(SurvivalPlanner.Mode.IDLE, d.state().mode());
    }

    @Test
    void startsEatingAtOrBelowStartThresholdWhenSafe() {
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(
            SurvivalPlanner.State.idle(), obs(20f, 16, true, true, -1.0D), CFG);
        assertEquals(SurvivalPlanner.Action.EAT, d.action());
        assertEquals(SurvivalPlanner.Mode.EATING, d.state().mode());
        assertTrue(d.reason().startsWith("eat_start"));
    }

    @Test
    void doesNotStartEatingJustAboveStartThreshold() {
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(
            SurvivalPlanner.State.idle(), obs(20f, 17, true, true, -1.0D), CFG);
        assertEquals(SurvivalPlanner.Action.NONE, d.action());
        assertEquals(SurvivalPlanner.Mode.IDLE, d.state().mode());
    }

    @Test
    void eatingContinuesThroughHysteresisBandThenCompletes() {
        SurvivalPlanner.State eating = new SurvivalPlanner.State(SurvivalPlanner.Mode.EATING);

        SurvivalPlanner.Decision cont = SurvivalPlanner.decide(eating, obs(20f, 17, true, true, -1.0D), CFG);
        assertEquals(SurvivalPlanner.Action.EAT, cont.action());
        assertTrue(cont.reason().startsWith("eat_continue"));

        SurvivalPlanner.Decision done = SurvivalPlanner.decide(eating, obs(20f, 18, true, true, -1.0D), CFG);
        assertEquals(SurvivalPlanner.Action.NONE, done.action());
        assertEquals(SurvivalPlanner.Mode.IDLE, done.state().mode());
        assertTrue(done.reason().startsWith("eat_complete"));
    }

    @Test
    void doesNotStartEatingWhenHostileNear() {
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(
            SurvivalPlanner.State.idle(), obs(20f, 10, true, true, 5.0D), CFG);
        assertEquals(SurvivalPlanner.Action.NONE, d.action());
    }

    @Test
    void interruptsEatingWhenHostileApproaches() {
        SurvivalPlanner.State eating = new SurvivalPlanner.State(SurvivalPlanner.Mode.EATING);
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(eating, obs(20f, 10, true, true, 4.0D), CFG);
        assertEquals(SurvivalPlanner.Action.NONE, d.action());
        assertEquals(SurvivalPlanner.Mode.IDLE, d.state().mode());
        assertTrue(d.reason().startsWith("eat_interrupt_hostile"));
    }

    @Test
    void pausesEatingWhileAirborneButStaysInEatingMode() {
        SurvivalPlanner.State eating = new SurvivalPlanner.State(SurvivalPlanner.Mode.EATING);
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(eating, obs(20f, 10, true, false, -1.0D), CFG);
        assertEquals(SurvivalPlanner.Action.NONE, d.action());
        assertEquals(SurvivalPlanner.Mode.EATING, d.state().mode());
        assertTrue(d.reason().startsWith("eat_pause_airborne"));
    }

    @Test
    void retreatsWhenLowHealthAndHostileInRange() {
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(
            SurvivalPlanner.State.idle(), obs(5f, 12, true, true, 5.0D), CFG);
        assertEquals(SurvivalPlanner.Action.RETREAT, d.action());
        assertEquals(SurvivalPlanner.Mode.RETREATING, d.state().mode());
    }

    @Test
    void doesNotRetreatWhenHostileOutOfRange() {
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(
            SurvivalPlanner.State.idle(), obs(5f, 20, true, true, 20.0D), CFG);
        assertEquals(SurvivalPlanner.Action.NONE, d.action());
    }

    @Test
    void logsOutWhenCriticalHealthAndHostile() {
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(
            SurvivalPlanner.State.idle(), obs(4f, 12, true, true, 5.0D), CFG);
        assertEquals(SurvivalPlanner.Action.LOGOUT, d.action());
        assertTrue(d.reason().contains("critical_health_hostile"));
    }

    @Test
    void logsOutWhenCriticalHealthAndNoFood() {
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(
            SurvivalPlanner.State.idle(), obs(4f, 3, false, true, -1.0D), CFG);
        assertEquals(SurvivalPlanner.Action.LOGOUT, d.action());
        assertTrue(d.reason().contains("critical_health_no_food"));
    }

    @Test
    void prefersEatingOverLogoutWhenCriticalHealthButFoodAvailableAndSafe() {
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(
            SurvivalPlanner.State.idle(), obs(4f, 6, true, true, -1.0D), CFG);
        assertEquals(SurvivalPlanner.Action.EAT, d.action());
    }

    @Test
    void logoutTakesPriorityOverRetreatAndEat() {
        SurvivalPlanner.Decision d = SurvivalPlanner.decide(
            SurvivalPlanner.State.idle(), obs(3f, 4, true, true, 4.0D), CFG);
        assertEquals(SurvivalPlanner.Action.LOGOUT, d.action());
    }
}
