package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Faithful physical/accounting proof for the bounded lane package.
 *
 * <p>This intentionally makes no ore-discovery or statistical outperformance claim. The lattice
 * is admitted only as a safe continuation when straight travel is unavailable, and this corpus
 * checks that its exact-shell efficiency remains within five percent of an equal-work straight
 * tunnel.</p>
 */
class IronExposureLaneAccountingSimulationTest {
    private static final StaircaseDescentPlanner.Direction2d SOUTH =
        new StaircaseDescentPlanner.Direction2d(0, 1, "south");

    @Test
    void productiveLanePackageIsPhysicallyValidExactlyAccountedAndBaselineEquivalent() {
        VoxelCell start = new VoxelCell(0, 14, 0);
        IronProspectAtlas planningAtlas = new IronProspectAtlas();

        AccountingPerception firstPerception = AccountingPerception.at(start);
        IronExposureLanePlanner.Result firstResult = IronExposureLanePlanner.plan(
            IronExposureLanePlanner.Request.fromAtlas(
                start,
                SOUTH,
                firstPerception,
                planningAtlas,
                false,
                false
            )
        );
        assertTrue(firstResult.selected());
        assertTrue(firstResult.plan().straightContinuation());
        assertEquals(
            IronProspectAtlas.PlanRegistrationResult.REGISTERED,
            planningAtlas.registerPlan(
                firstResult.plan().laneSignature(),
                firstResult.plan().connectorSignature(),
                firstResult.plan().connector(),
                firstResult.plan().lane()
            )
        );
        recordVerifiedRoute(planningAtlas, firstResult.plan().completeRoute());

        VoxelCell firstEndpoint = firstResult.plan().lane().getLast();
        AccountingPerception secondPerception = AccountingPerception.at(firstEndpoint);
        secondPerception.exclude(new VoxelCell(0, 14, 13));
        secondPerception.exclude(new VoxelCell(0, 15, 13));
        IronExposureLanePlanner.Result secondResult = IronExposureLanePlanner.plan(
            IronExposureLanePlanner.Request.fromAtlas(
                firstEndpoint,
                SOUTH,
                secondPerception,
                planningAtlas,
                false,
                false
            )
        );
        assertTrue(secondResult.selected());
        assertFalse(secondResult.plan().straightContinuation());
        assertEquals(3, secondResult.plan().connector().size());
        assertEquals(
            IronProspectAtlas.PlanRegistrationResult.REGISTERED,
            planningAtlas.registerPlan(
                secondResult.plan().laneSignature(),
                secondResult.plan().connectorSignature(),
                secondResult.plan().connector(),
                secondResult.plan().lane()
            )
        );

        List<VoxelCell> latticeRoute = new ArrayList<>(firstResult.plan().completeRoute());
        latticeRoute.addAll(secondResult.plan().connector());
        latticeRoute.addAll(secondResult.plan().lane());
        assertEquals(28, latticeRoute.size());

        ProspectingSimulation.Config config = new ProspectingSimulation.Config(
            -6, 6, -1, 2, -2, 30, 64, 0, 1, 1, 14
        );
        ProspectingSimulation.Result physical = ProspectingSimulation.run(
            ProspectingSimulation.World.empty(config),
            frozenRouteStrategy(latticeRoute)
        );

        assertFalse(physical.invalidAction(), physical.failureReason());
        assertFalse(physical.exhaustedBudget());
        assertEquals(54, physical.blocksBroken());
        assertEquals(27, physical.movesMade());
        assertEquals(new ProspectingSimulation.Pos(-3, 0, 0), physical.finalAgentFeet());

        IronProspectAtlas executionAtlas = new IronProspectAtlas();
        Set<IronProspectAtlas.InspectedCell> independentExpected = new HashSet<>();
        addStanceShell(independentExpected, start);
        executionAtlas.recordGroundedLaneCell(start);
        for (ProspectingSimulation.Step step : physical.steps()) {
            VoxelCell worldCell = new VoxelCell(step.target().x(), step.target().y() + 14, step.target().z());
            if (step.kind() == ProspectingSimulation.DecisionKind.BREAK) {
                addBlockFaces(independentExpected, worldCell);
                executionAtlas.recordClearedProspectBlock(worldCell);
            } else if (step.kind() == ProspectingSimulation.DecisionKind.MOVE) {
                addStanceShell(independentExpected, worldCell);
                executionAtlas.recordGroundedLaneCell(worldCell);
            }
        }
        assertEquals(independentExpected, executionAtlas.inspectedCells(),
            "atlas may credit only faces exposed by verified breaks and grounded stances");

        List<VoxelCell> straightRoute = straightRoute(start, latticeRoute.size() - 1);
        int latticeShell = independentRouteShell(latticeRoute).size();
        int straightShell = independentRouteShell(straightRoute).size();
        double latticeEfficiency = latticeShell / (double) physical.blocksBroken();
        double straightEfficiency = straightShell / (double) physical.blocksBroken();

        assertTrue(latticeEfficiency >= straightEfficiency * 0.95D,
            "safe lattice must retain at least 95% of straight unique-shell efficiency");
        assertTrue(latticeEfficiency <= straightEfficiency * 1.05D,
            "accounting equivalence is not evidence that the lattice statistically outperforms straight mining");
    }

    @Test
    void lateLaneIronIsMinedWithoutAbandoningTheFrozenStraightContinuation() {
        VoxelCell start = new VoxelCell(0, 14, 0);
        IronExposureLanePlanner.Result planned = IronExposureLanePlanner.plan(
            IronExposureLanePlanner.Request.fromAtlas(
                start,
                SOUTH,
                AccountingPerception.at(start),
                new IronProspectAtlas(),
                false,
                false
            )
        );
        assertTrue(planned.selected());
        assertTrue(planned.plan().straightContinuation());

        List<VoxelCell> route = planned.plan().completeRoute();
        ProspectingSimulation.Pos lateIron = new ProspectingSimulation.Pos(0, 1, 11);
        ProspectingSimulation.World world = ProspectingSimulation.World.empty(
            new ProspectingSimulation.Config(-1, 1, -1, 2, 0, 12, 32, 0, 1, 1, 14)
        ).withIron(lateIron);

        ProspectingSimulation.Result result = ProspectingSimulation.run(
            world,
            frozenRouteStrategy(route)
        );

        assertFalse(result.invalidAction(), result.failureReason());
        assertFalse(result.exhaustedBudget());
        assertEquals(1, result.ironFound());
        assertEquals(new ProspectingSimulation.Pos(0, 0, 12), result.finalAgentFeet());
        int ironStep = -1;
        for (int index = 0; index < result.steps().size(); index++) {
            ProspectingSimulation.Step step = result.steps().get(index);
            if (step.kind() == ProspectingSimulation.DecisionKind.BREAK
                && step.target().equals(lateIron)) {
                assertEquals(ProspectingSimulation.Block.IRON_ORE, step.blockBroken());
                ironStep = index;
                break;
            }
        }
        assertTrue(ironStep >= 0, "the late lane ore must be broken");
        assertTrue(result.steps().subList(ironStep + 1, result.steps().size()).stream()
            .anyMatch(step -> step.kind() == ProspectingSimulation.DecisionKind.MOVE
                && step.target().equals(new ProspectingSimulation.Pos(0, 0, 12))),
            "the frozen straight lane must continue after the late ore is exposed and broken");
    }

    private static ProspectingSimulation.Strategy<RouteState> frozenRouteStrategy(List<VoxelCell> route) {
        List<ProspectingSimulation.Pos> relative = route.stream()
            .map(cell -> new ProspectingSimulation.Pos(cell.x(), cell.y() - 14, cell.z()))
            .toList();
        return new ProspectingSimulation.Strategy<>() {
            @Override
            public RouteState initialState() {
                return new RouteState(1, 0);
            }

            @Override
            public ProspectingSimulation.StrategyDecision<RouteState> nextTarget(
                ProspectingSimulation.Snapshot snapshot,
                RouteState state
            ) {
                if (state.routeIndex() >= relative.size()) {
                    return ProspectingSimulation.StrategyDecision.stop(state);
                }
                ProspectingSimulation.Pos feet = relative.get(state.routeIndex());
                ProspectingSimulation.Pos head = feet.offset(0, 1, 0);
                if (state.phase() == 0) {
                    return ProspectingSimulation.StrategyDecision.breakBlock(
                        new RouteState(state.routeIndex(), 1),
                        head,
                        "lane_head"
                    );
                }
                if (state.phase() == 1) {
                    return ProspectingSimulation.StrategyDecision.breakBlock(
                        new RouteState(state.routeIndex(), 2),
                        feet,
                        "lane_feet"
                    );
                }
                if (snapshot.standableCells().contains(feet)) {
                    return ProspectingSimulation.StrategyDecision.move(
                        new RouteState(state.routeIndex() + 1, 0),
                        feet
                    );
                }
                return ProspectingSimulation.StrategyDecision.stop(state);
            }
        };
    }

    private static void recordVerifiedRoute(IronProspectAtlas atlas, List<VoxelCell> route) {
        atlas.recordGroundedLaneCell(route.getFirst());
        for (int index = 1; index < route.size(); index++) {
            VoxelCell feet = route.get(index);
            atlas.recordClearedProspectBlock(feet);
            atlas.recordClearedProspectBlock(new VoxelCell(feet.x(), feet.y() + 1, feet.z()));
            atlas.recordGroundedLaneCell(feet);
        }
    }

    private static List<VoxelCell> straightRoute(VoxelCell origin, int cells) {
        List<VoxelCell> route = new ArrayList<>(cells + 1);
        route.add(origin);
        for (int step = 1; step <= cells; step++) {
            route.add(new VoxelCell(origin.x(), origin.y(), origin.z() + step));
        }
        return List.copyOf(route);
    }

    private static Set<IronProspectAtlas.InspectedCell> independentRouteShell(List<VoxelCell> route) {
        Set<VoxelCell> air = new HashSet<>();
        for (VoxelCell feet : route) {
            air.add(feet);
            air.add(new VoxelCell(feet.x(), feet.y() + 1, feet.z()));
        }
        Set<IronProspectAtlas.InspectedCell> shell = new HashSet<>();
        for (int index = 1; index < route.size(); index++) {
            VoxelCell feet = route.get(index);
            for (VoxelCell body : List.of(feet, new VoxelCell(feet.x(), feet.y() + 1, feet.z()))) {
                for (VoxelCell face : faces(body)) {
                    if (!air.contains(face)) {
                        shell.add(inspected(face));
                    }
                }
            }
        }
        return Set.copyOf(shell);
    }

    private static void addBlockFaces(
        Set<IronProspectAtlas.InspectedCell> expected,
        VoxelCell block
    ) {
        for (VoxelCell face : faces(block)) {
            expected.add(inspected(face));
        }
    }

    private static void addStanceShell(
        Set<IronProspectAtlas.InspectedCell> expected,
        VoxelCell feet
    ) {
        VoxelCell head = new VoxelCell(feet.x(), feet.y() + 1, feet.z());
        Set<VoxelCell> body = Set.of(feet, head);
        for (VoxelCell cell : body) {
            for (VoxelCell face : faces(cell)) {
                if (!body.contains(face)) {
                    expected.add(inspected(face));
                }
            }
        }
    }

    private static List<VoxelCell> faces(VoxelCell cell) {
        return List.of(
            new VoxelCell(cell.x() + 1, cell.y(), cell.z()),
            new VoxelCell(cell.x() - 1, cell.y(), cell.z()),
            new VoxelCell(cell.x(), cell.y() + 1, cell.z()),
            new VoxelCell(cell.x(), cell.y() - 1, cell.z()),
            new VoxelCell(cell.x(), cell.y(), cell.z() + 1),
            new VoxelCell(cell.x(), cell.y(), cell.z() - 1)
        );
    }

    private static IronProspectAtlas.InspectedCell inspected(VoxelCell cell) {
        return new IronProspectAtlas.InspectedCell(cell.x(), cell.y(), cell.z());
    }

    private record RouteState(int routeIndex, int phase) {
    }

    private static final class AccountingPerception implements IronExposureLanePlanner.Perception {
        private final Set<VoxelCell> clear = new HashSet<>();
        private final Set<VoxelCell> excluded = new HashSet<>();

        static AccountingPerception at(VoxelCell feet) {
            AccountingPerception perception = new AccountingPerception();
            perception.clear.add(feet);
            perception.clear.add(new VoxelCell(feet.x(), feet.y() + 1, feet.z()));
            return perception;
        }

        void exclude(VoxelCell cell) {
            excluded.add(cell);
        }

        @Override
        public boolean isClear(VoxelCell block) {
            return clear.contains(block);
        }

        @Override
        public boolean isProspectable(VoxelCell block) {
            return !clear.contains(block) && !excluded.contains(block);
        }

        @Override
        public boolean isStableSupport(VoxelCell feet) {
            return true;
        }

        @Override
        public boolean isLiquid(VoxelCell block) {
            return false;
        }

        @Override
        public boolean isHazard(VoxelCell block) {
            return false;
        }

        @Override
        public boolean isAdjacentLava(VoxelCell feet) {
            return false;
        }

        @Override
        public boolean isExcluded(VoxelCell block) {
            return excluded.contains(block);
        }
    }
}
