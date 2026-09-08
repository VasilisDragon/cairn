package com.mcbot.fabricclient;

import java.util.Comparator;
import java.util.List;
import java.util.Optional;

final class TargetPriorityPlanner {
    private TargetPriorityPlanner() {
    }

    record Candidate(int index, double distance, float health, CombatPlanner.ThreatKind threatKind) {
    }

    static Comparator<Candidate> priorityOrder() {
        return Comparator.comparingDouble(Candidate::health)
            .thenComparing((Candidate candidate) -> -threatRank(candidate.threatKind()))
            .thenComparingDouble(Candidate::distance)
            .thenComparingInt(Candidate::index);
    }

    static Optional<Candidate> pick(List<Candidate> candidates, double engageRadius) {
        if (candidates == null || candidates.isEmpty()) {
            return Optional.empty();
        }
        return candidates.stream()
            .filter(candidate -> candidate != null && candidate.distance() >= 0.0D && candidate.distance() <= engageRadius)
            .min(priorityOrder());
    }

    private static int threatRank(CombatPlanner.ThreatKind kind) {
        return switch (kind == null ? CombatPlanner.ThreatKind.NONE : kind) {
            case EXPLOSIVE -> 4;
            case RANGED -> 3;
            case MELEE -> 2;
            case NONE -> 0;
        };
    }
}
