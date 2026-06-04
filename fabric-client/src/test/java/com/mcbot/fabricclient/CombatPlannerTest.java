package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class CombatPlannerTest {
    private static final CombatPlanner.Config CFG = CombatPlanner.Config.defaults();

    private static CombatPlanner.Observation obs(
        float health, int count, double dist, CombatPlanner.ThreatKind kind, boolean armed) {
        return new CombatPlanner.Observation(health, count, dist, kind, armed, true);
    }

    private static CombatPlanner.Decision decide(CombatPlanner.Observation o) {
        return CombatPlanner.decide(CombatPlanner.State.idle(), o, CFG);
    }

    @Test
    void noThreatWhenNoHostile() {
        CombatPlanner.Decision d = decide(obs(20f, 0, -1.0D, CombatPlanner.ThreatKind.NONE, true));
        assertEquals(CombatPlanner.Action.NONE, d.action());
        assertEquals(CombatPlanner.Mode.IDLE, d.state().mode());
    }

    @Test
    void noThreatWhenHostileOutsideEngageRadius() {
        CombatPlanner.Decision d = decide(obs(20f, 1, 20.0D, CombatPlanner.ThreatKind.MELEE, true));
        assertEquals(CombatPlanner.Action.NONE, d.action());
    }

    @Test
    void engagesSingleMeleeHostileWhenArmedAndHealthy() {
        CombatPlanner.Decision d = decide(obs(20f, 1, 5.0D, CombatPlanner.ThreatKind.MELEE, true));
        assertEquals(CombatPlanner.Action.ENGAGE, d.action());
        assertEquals(CombatPlanner.Mode.ENGAGING, d.state().mode());
        assertTrue(d.reason().startsWith("engage"));
    }

    @Test
    void engagesRangedHostile() {
        CombatPlanner.Decision d = decide(obs(20f, 1, 10.0D, CombatPlanner.ThreatKind.RANGED, true));
        assertEquals(CombatPlanner.Action.ENGAGE, d.action());
    }

    @Test
    void fleesWhenLowHealth() {
        CombatPlanner.Decision d = decide(obs(8f, 1, 5.0D, CombatPlanner.ThreatKind.MELEE, true));
        assertEquals(CombatPlanner.Action.FLEE, d.action());
        assertEquals(CombatPlanner.Mode.FLEEING, d.state().mode());
        assertTrue(d.reason().startsWith("flee:low_health"));
    }

    @Test
    void engagesJustAboveFleeHealthBoundary() {
        CombatPlanner.Decision d = decide(obs(9f, 1, 5.0D, CombatPlanner.ThreatKind.MELEE, true));
        assertEquals(CombatPlanner.Action.ENGAGE, d.action());
    }

    @Test
    void engagesSmallGroupWithinLimit() {
        CombatPlanner.Decision d = decide(obs(20f, 3, 5.0D, CombatPlanner.ThreatKind.MELEE, true));
        assertEquals(CombatPlanner.Action.ENGAGE, d.action());
    }

    @Test
    void fleesWhenOutnumbered() {
        CombatPlanner.Decision d = decide(obs(20f, 4, 5.0D, CombatPlanner.ThreatKind.MELEE, true));
        assertEquals(CombatPlanner.Action.FLEE, d.action());
        assertTrue(d.reason().startsWith("flee:outnumbered"));
    }

    @Test
    void fleesWhenUnarmed() {
        CombatPlanner.Decision d = decide(obs(20f, 1, 5.0D, CombatPlanner.ThreatKind.MELEE, false));
        assertEquals(CombatPlanner.Action.FLEE, d.action());
        assertTrue(d.reason().startsWith("flee:unarmed"));
    }

    @Test
    void fleesFromCreeper() {
        CombatPlanner.Decision d = decide(obs(20f, 1, 5.0D, CombatPlanner.ThreatKind.EXPLOSIVE, true));
        assertEquals(CombatPlanner.Action.FLEE, d.action());
        assertTrue(d.reason().startsWith("flee:explosive"));
    }

    @Test
    void logsOutWhenCriticalHealthWithHostile() {
        CombatPlanner.Decision d = decide(obs(4f, 1, 5.0D, CombatPlanner.ThreatKind.MELEE, true));
        assertEquals(CombatPlanner.Action.LOGOUT, d.action());
        assertTrue(d.reason().contains("critical_health"));
    }

    @Test
    void logoutTakesPriorityOverFlee() {
        // critically low health AND outnounted/unarmed -> still logout (highest priority)
        CombatPlanner.Decision d = decide(obs(3f, 3, 5.0D, CombatPlanner.ThreatKind.EXPLOSIVE, false));
        assertEquals(CombatPlanner.Action.LOGOUT, d.action());
    }

    @Test
    void criticalHealthButNoHostileInRangeStandsDown() {
        // the no-threat gate wins: an out-of-range hostile means no combat reaction at all
        CombatPlanner.Decision d = decide(obs(3f, 1, 30.0D, CombatPlanner.ThreatKind.MELEE, true));
        assertEquals(CombatPlanner.Action.NONE, d.action());
    }
}
