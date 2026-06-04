package com.mcbot.fabricclient;

import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;

final class ProspectStrategyPlanner {
    private ProspectStrategyPlanner() {
    }

    enum StrategyKind {
        BASELINE_STRAIGHT_TUNNEL
    }

    enum BlockKind {
        STONE,
        IRON_ORE
    }

    enum Action {
        STOP,
        SELECT_VISIBLE_IRON,
        BREAK_PATTERN_BLOCK
    }

    record Pos(int x, int y, int z) {
    }

    record State(int z, int phaseIndex) {
        State {
            z = Math.max(1, z);
            phaseIndex = Math.max(0, phaseIndex);
        }

        static State initial() {
            return new State(1, 0);
        }

        State nextPhase(StrategyKind strategy) {
            int nextPhase = phaseIndex + 1;
            if (nextPhase >= patternFor(strategy, z).size()) {
                return new State(z + 1, 0);
            }
            return new State(z, nextPhase);
        }
    }

    record Observation(int budgetRemaining, Map<Pos, BlockKind> visibleBlocks) {
        Observation {
            visibleBlocks = Map.copyOf(visibleBlocks);
        }

        List<Pos> visibleIronSorted() {
            return visibleBlocks.entrySet().stream()
                .filter(entry -> entry.getValue() == BlockKind.IRON_ORE)
                .map(Map.Entry::getKey)
                .sorted(POS_ORDER)
                .toList();
        }
    }

    record Decision(State state, Action action, Optional<Pos> target, String reason) {
        Decision {
            state = state == null ? State.initial() : state;
            target = target == null ? Optional.empty() : target;
            reason = reason == null ? "" : reason;
        }

        boolean targetIron() {
            return action == Action.SELECT_VISIBLE_IRON;
        }

        boolean targetProspect() {
            return action == Action.BREAK_PATTERN_BLOCK;
        }
    }

    static final Comparator<Pos> POS_ORDER = Comparator
        .comparingInt(Pos::z)
        .thenComparingInt(Pos::y)
        .thenComparingInt(Pos::x);

    static Decision decide(StrategyKind strategy, State state, Observation observation) {
        StrategyKind effectiveStrategy = strategy == null ? StrategyKind.BASELINE_STRAIGHT_TUNNEL : strategy;
        State cursor = state == null ? State.initial() : state;
        if (observation == null || observation.budgetRemaining() <= 0) {
            return new Decision(cursor, Action.STOP, Optional.empty(), "budget_exhausted");
        }

        Optional<Pos> visibleIron = observation.visibleIronSorted().stream().findFirst();
        if (visibleIron.isPresent()) {
            return new Decision(cursor, Action.SELECT_VISIBLE_IRON, visibleIron, "visible_iron");
        }

        for (int guard = 0; guard < 512; guard++) {
            List<Pos> pattern = patternFor(effectiveStrategy, cursor.z());
            if (cursor.phaseIndex() >= pattern.size()) {
                cursor = new State(cursor.z() + 1, 0);
                continue;
            }
            Pos candidate = pattern.get(cursor.phaseIndex());
            State next = cursor.nextPhase(effectiveStrategy);
            if (observation.visibleBlocks().containsKey(candidate)) {
                return new Decision(next, Action.BREAK_PATTERN_BLOCK, Optional.of(candidate), patternReason(effectiveStrategy, cursor));
            }
            cursor = next;
        }
        return new Decision(cursor, Action.STOP, Optional.empty(), "no_visible_pattern_target");
    }

    static List<Pos> patternFor(StrategyKind strategy, int z) {
        return List.of(new Pos(0, 1, z), new Pos(0, 0, z));
    }

    private static String patternReason(StrategyKind strategy, State cursor) {
        return switch (strategy) {
            case BASELINE_STRAIGHT_TUNNEL -> "baseline_tunnel:z=" + cursor.z() + ":phase=" + cursor.phaseIndex();
        };
    }
}
