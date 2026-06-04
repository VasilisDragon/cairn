package com.mcbot.fabricclient;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

final class ProspectStrategySimulationAdapter {
    private ProspectStrategySimulationAdapter() {
    }

    record SimState(ProspectStrategyPlanner.State plannerState, Optional<ProspectingSimulation.Pos> pendingMove) {
        SimState {
            plannerState = plannerState == null ? ProspectStrategyPlanner.State.initial() : plannerState;
            pendingMove = pendingMove == null ? Optional.empty() : pendingMove;
        }

        static SimState initial() {
            return new SimState(ProspectStrategyPlanner.State.initial(), Optional.empty());
        }
    }

    static ProspectingSimulation.Strategy<SimState> strategy(ProspectStrategyPlanner.StrategyKind strategy) {
        return new ProspectingSimulation.Strategy<>() {
            @Override
            public SimState initialState() {
                return SimState.initial();
            }

            @Override
            public ProspectingSimulation.StrategyDecision<SimState> nextTarget(
                ProspectingSimulation.Snapshot snapshot,
                SimState state
            ) {
                if (snapshot.ironFound() > 0) {
                    return ProspectingSimulation.StrategyDecision.stop(state);
                }
                if (state.pendingMove().isPresent()) {
                    return ProspectingSimulation.StrategyDecision.move(
                        new SimState(state.plannerState(), Optional.empty()),
                        state.pendingMove().get()
                    );
                }
                ProspectStrategyPlanner.Decision decision = ProspectStrategyPlanner.decide(
                    strategy,
                    state.plannerState(),
                    observationFrom(snapshot.reachableBlocks(), snapshot.budgetRemaining())
                );
                if (decision.target().isEmpty()) {
                    return ProspectingSimulation.StrategyDecision.stop(new SimState(decision.state(), Optional.empty()));
                }
                ProspectingSimulation.Pos target = toSimulationPos(decision.target().get());
                Optional<ProspectingSimulation.Pos> pendingMove = target.x() == 0 && target.y() == 0 && target.z() >= 1
                    ? Optional.of(new ProspectingSimulation.Pos(0, 0, target.z()))
                    : Optional.empty();
                return ProspectingSimulation.StrategyDecision.breakBlock(
                    new SimState(decision.state(), pendingMove),
                    target,
                    decision.reason()
                );
            }
        };
    }

    static ProspectStrategyPlanner.Observation observationFrom(
        Map<ProspectingSimulation.Pos, ProspectingSimulation.Block> blocks,
        int budgetRemaining
    ) {
        Map<ProspectStrategyPlanner.Pos, ProspectStrategyPlanner.BlockKind> visible = new HashMap<>();
        for (Map.Entry<ProspectingSimulation.Pos, ProspectingSimulation.Block> entry : blocks.entrySet()) {
            ProspectStrategyPlanner.BlockKind kind = switch (entry.getValue()) {
                case IRON_ORE -> ProspectStrategyPlanner.BlockKind.IRON_ORE;
                case STONE -> ProspectStrategyPlanner.BlockKind.STONE;
                case AIR -> null;
            };
            if (kind != null) {
                ProspectingSimulation.Pos pos = entry.getKey();
                visible.put(new ProspectStrategyPlanner.Pos(pos.x(), pos.y(), pos.z()), kind);
            }
        }
        return new ProspectStrategyPlanner.Observation(budgetRemaining, visible);
    }

    private static ProspectingSimulation.Pos toSimulationPos(ProspectStrategyPlanner.Pos pos) {
        return new ProspectingSimulation.Pos(pos.x(), pos.y(), pos.z());
    }
}
