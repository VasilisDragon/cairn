package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class TargetPriorityPlannerTest {
    @Test
    void picksLowerHealthTargetBeforeNearestTarget() {
        var selected = TargetPriorityPlanner.pick(List.of(
            new TargetPriorityPlanner.Candidate(0, 5.0D, 20.0F, CombatPlanner.ThreatKind.MELEE),
            new TargetPriorityPlanner.Candidate(1, 9.0D, 4.0F, CombatPlanner.ThreatKind.MELEE)
        ), 16.0D);

        assertTrue(selected.isPresent());
        assertEquals(1, selected.get().index());
    }

    @Test
    void usesThreatKindAsTieBreakerAfterHealth() {
        var selected = TargetPriorityPlanner.pick(List.of(
            new TargetPriorityPlanner.Candidate(0, 4.0D, 10.0F, CombatPlanner.ThreatKind.MELEE),
            new TargetPriorityPlanner.Candidate(1, 7.0D, 10.0F, CombatPlanner.ThreatKind.RANGED)
        ), 16.0D);

        assertTrue(selected.isPresent());
        assertEquals(1, selected.get().index());
    }

    @Test
    void ignoresTargetsOutsideEngageRadius() {
        var selected = TargetPriorityPlanner.pick(List.of(
            new TargetPriorityPlanner.Candidate(0, 20.0D, 1.0F, CombatPlanner.ThreatKind.MELEE),
            new TargetPriorityPlanner.Candidate(1, 6.0D, 10.0F, CombatPlanner.ThreatKind.MELEE)
        ), 16.0D);

        assertTrue(selected.isPresent());
        assertEquals(1, selected.get().index());
    }
}
