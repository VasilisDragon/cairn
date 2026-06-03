package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class SurvivalPlannerTest {
    private static final SurvivalPlanner.Config CFG = SurvivalPlanner.Config.defaults();

    private static SurvivalPlanner.Observation obs(
        float health, int food, boolean hasFood, boolean onGround, double hostile) {
        return new SurvivalPlanner.Observation(health, food, hasFood, onGround, hostile);
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
