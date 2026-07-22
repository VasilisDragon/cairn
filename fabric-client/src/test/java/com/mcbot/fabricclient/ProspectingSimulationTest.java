package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class ProspectingSimulationTest {
    @Test
    void persistentAtlasMultiCommandCorpusReducesOverlapWithoutLowerFindRate() {
        ProspectingSimulation.Config config = new ProspectingSimulation.Config(-64, 64, -1, 2, -64, 64, 384, 96, 1, 4, 14);
        List<ProspectingSimulation.ProspectLeg> baseline = List.of(
            new ProspectingSimulation.ProspectLeg(0, 0, 0, 1, 12),
            new ProspectingSimulation.ProspectLeg(0, 0, 0, 1, 12),
            new ProspectingSimulation.ProspectLeg(0, 0, 0, 1, 12),
            new ProspectingSimulation.ProspectLeg(0, 0, 0, 1, 12)
        );
        List<ProspectingSimulation.ProspectLeg> atlas = List.of(
            new ProspectingSimulation.ProspectLeg(0, 0, 0, 1, 12),
            new ProspectingSimulation.ProspectLeg(0, 0, 1, 0, 12),
            new ProspectingSimulation.ProspectLeg(0, 0, 0, -1, 12),
            new ProspectingSimulation.ProspectLeg(0, 0, -1, 0, 12)
        );
        int baselineWorldsFound = 0;
        int atlasWorldsFound = 0;
        for (long seed = 0; seed < 100; seed++) {
            ProspectingSimulation.World world = ProspectingSimulation.World.seeded(config, seed);
            ProspectingSimulation.CoverageResult baselineResult = ProspectingSimulation.corridorCoverage(world, baseline);
            ProspectingSimulation.CoverageResult atlasResult = ProspectingSimulation.corridorCoverage(world, atlas);
            assertEquals(baselineResult.totalExposures(), atlasResult.totalExposures());
            assertTrue(atlasResult.duplicateExposures() < baselineResult.duplicateExposures());
            if (baselineResult.ironFound() > 0) baselineWorldsFound++;
            if (atlasResult.ironFound() > 0) atlasWorldsFound++;
        }
        assertTrue(atlasWorldsFound >= baselineWorldsFound);
    }

    @Test
    void handPlacedReachableVeinIsFound() {
        ProspectingSimulation.Config config = smallConfig(12, 0);
        ProspectingSimulation.World world = ProspectingSimulation.World.empty(config)
            .withIron(new ProspectingSimulation.Pos(0, 1, 1));

        ProspectingSimulation.Result result = ProspectingSimulation.run(world, walkableForwardStrategy());

        assertEquals(1, result.blocksBroken());
        assertEquals(1, result.ironFound());
        assertFalse(result.invalidAction());
        assertTrue(result.foundWithinBudget());
        assertEquals(1.0D, result.blocksPerIron(), 0.001D);
    }

    @Test
    void emptyWorldYieldsZeroIronWithinBudgetWithPhysicalMovement() {
        ProspectingSimulation.Config config = smallConfig(8, 0);
        ProspectingSimulation.Result result = ProspectingSimulation.run(
            ProspectingSimulation.World.empty(config),
            walkableForwardStrategy()
        );

        assertEquals(8, result.blocksBroken());
        assertEquals(0, result.ironFound());
        assertEquals(3, result.movesMade());
        assertFalse(result.invalidAction());
        assertFalse(result.foundWithinBudget());
        assertTrue(Double.isInfinite(result.blocksPerIron()));
    }

    @Test
    void seededWorldsAreDeterministicForTheSameSeedAndStrategy() {
        ProspectingSimulation.Config config = smallConfig(24, 5);
        ProspectingSimulation.Result first = ProspectingSimulation.run(
            ProspectingSimulation.World.seeded(config, 42L),
            walkableForwardStrategy()
        );
        ProspectingSimulation.Result second = ProspectingSimulation.run(
            ProspectingSimulation.World.seeded(config, 42L),
            walkableForwardStrategy()
        );

        assertEquals(first.blocksBroken(), second.blocksBroken());
        assertEquals(first.ironFound(), second.ironFound());
        assertEquals(first.movesMade(), second.movesMade());
        assertEquals(first.finalAgentFeet(), second.finalAgentFeet());
        assertEquals(first.steps(), second.steps());
    }

    @Test
    void summaryAveragesPhysicalMetricsAcrossSeedSweep() {
        ProspectingSimulation.Config config = smallConfig(16, 4);

        ProspectingSimulation.Summary summary = ProspectingSimulation.runAcrossSeeds(
            config,
            100L,
            8,
            ignored -> walkableForwardStrategy()
        );

        assertEquals(8, summary.worlds());
        assertTrue(summary.totalBlocksBroken() > 0);
        assertTrue(summary.totalMovesMade() > 0);
        assertTrue(summary.foundRate() >= 0.0D);
    }

    @Test
    void ironDensityCurvePeaksNearY16AndDropsAtPoorDepths() {
        double y16 = ProspectingSimulation.ironDensityWeight(16);
        double y40 = ProspectingSimulation.ironDensityWeight(40);
        double y64 = ProspectingSimulation.ironDensityWeight(64);
        double y80 = ProspectingSimulation.ironDensityWeight(80);

        assertTrue(y16 > y40, "Y16 should be better than Y40 in the documented curve");
        assertTrue(y40 > y64, "Y40 should still beat high poor-depth mining");
        assertEquals(0.0D, y80, 0.0001D);
    }

    @Test
    void seededWorldsContainMoreIronAtGoodDepthThanPoorDepthAcrossTheSameSeedSweep() {
        ProspectingSimulation.Config goodDepth = new ProspectingSimulation.Config(
            -8, 8, -2, 3, 0, 48, 32, 40, 1, 4, 16
        );
        ProspectingSimulation.Config poorDepth = new ProspectingSimulation.Config(
            -8, 8, -2, 3, 0, 48, 32, 40, 1, 4, 64
        );

        int goodIron = totalSeededIron(goodDepth, 500L, 80);
        int poorIron = totalSeededIron(poorDepth, 500L, 80);

        assertTrue(goodIron > poorIron * 2, "expected depth to materially affect seeded iron: good="
            + goodIron + " poor=" + poorIron);
    }

    @Test
    void oneTallHeadOnlyBoreIsNotExecutableBecauseTheAgentCannotAdvance() {
        ProspectingSimulation.Config config = smallConfig(12, 0);

        ProspectingSimulation.Result result = ProspectingSimulation.run(
            ProspectingSimulation.World.empty(config),
            oneTallBoreThenAdvanceStrategy()
        );

        assertTrue(result.invalidAction());
        assertEquals("move_not_standable:Pos[x=0, y=0, z=1]", result.failureReason());
        assertEquals(new ProspectingSimulation.Pos(0, 0, 0), result.finalAgentFeet());
        assertEquals(1, result.blocksBroken());
        assertEquals(0, result.movesMade());
    }

    @Test
    void twoTallCorridorIsWalkable() {
        ProspectingSimulation.Config config = smallConfig(12, 0);

        ProspectingSimulation.Result result = ProspectingSimulation.run(
            ProspectingSimulation.World.empty(config),
            carveOneTwoTallCellAndMoveStrategy()
        );

        assertFalse(result.invalidAction());
        assertEquals(2, result.blocksBroken());
        assertEquals(1, result.movesMade());
        assertEquals(new ProspectingSimulation.Pos(0, 0, 1), result.finalAgentFeet());
    }

    @Test
    void outOfReachBreakIsRejected() {
        ProspectingSimulation.Config config = smallConfig(12, 0);

        ProspectingSimulation.Result result = ProspectingSimulation.run(
            ProspectingSimulation.World.empty(config)
                .withAir(new ProspectingSimulation.Pos(0, 1, 7)),
            breakFarVisibleBlockStrategy()
        );

        assertTrue(result.invalidAction());
        assertEquals("break_out_of_reach:Pos[x=0, y=1, z=8]", result.failureReason());
        assertEquals(0, result.blocksBroken());
    }

    private static ProspectingSimulation.Config smallConfig(int budget, int veins) {
        return new ProspectingSimulation.Config(-4, 4, -1, 2, 0, 24, budget, veins, 1, 3);
    }

    private static int totalSeededIron(ProspectingSimulation.Config config, long firstSeed, int seedCount) {
        int total = 0;
        for (int i = 0; i < seedCount; i++) {
            total += ProspectingSimulation.World.seeded(config, firstSeed + i).ironBlocks();
        }
        return total;
    }

    private static ProspectingSimulation.Strategy<WalkState> walkableForwardStrategy() {
        return new ProspectingSimulation.Strategy<>() {
            @Override
            public WalkState initialState() {
                return new WalkState(1, 0);
            }

            @Override
            public ProspectingSimulation.StrategyDecision<WalkState> nextTarget(
                ProspectingSimulation.Snapshot snapshot,
                WalkState state
            ) {
                if (snapshot.ironFound() > 0) {
                    return ProspectingSimulation.StrategyDecision.stop(state);
                }
                Optional<ProspectingSimulation.Pos> reachableIron = snapshot.reachableIronSorted().stream().findFirst();
                if (reachableIron.isPresent()) {
                    return ProspectingSimulation.StrategyDecision.breakBlock(state, reachableIron.get(), "visible_iron");
                }
                ProspectingSimulation.Pos feet = new ProspectingSimulation.Pos(0, 0, state.z());
                ProspectingSimulation.Pos head = new ProspectingSimulation.Pos(0, 1, state.z());
                if (state.phase() == 0 && snapshot.reachableBlocks().containsKey(head)) {
                    return ProspectingSimulation.StrategyDecision.breakBlock(new WalkState(state.z(), 1), head, "forward_head");
                }
                if (state.phase() <= 1 && snapshot.reachableBlocks().containsKey(feet)) {
                    return ProspectingSimulation.StrategyDecision.breakBlock(new WalkState(state.z(), 2), feet, "forward_feet");
                }
                if (snapshot.standableCells().contains(feet)) {
                    return ProspectingSimulation.StrategyDecision.move(new WalkState(state.z() + 1, 0), feet);
                }
                return ProspectingSimulation.StrategyDecision.stop(state);
            }
        };
    }

    private static ProspectingSimulation.Strategy<Integer> oneTallBoreThenAdvanceStrategy() {
        return new ProspectingSimulation.Strategy<>() {
            @Override
            public Integer initialState() {
                return 0;
            }

            @Override
            public ProspectingSimulation.StrategyDecision<Integer> nextTarget(
                ProspectingSimulation.Snapshot snapshot,
                Integer phase
            ) {
                ProspectingSimulation.Pos head = new ProspectingSimulation.Pos(0, 1, 1);
                if (phase == 0) {
                    return ProspectingSimulation.StrategyDecision.breakBlock(1, head, "head_only");
                }
                return ProspectingSimulation.StrategyDecision.move(phase, new ProspectingSimulation.Pos(0, 0, 1));
            }
        };
    }

    private static ProspectingSimulation.Strategy<Integer> carveOneTwoTallCellAndMoveStrategy() {
        return new ProspectingSimulation.Strategy<>() {
            @Override
            public Integer initialState() {
                return 0;
            }

            @Override
            public ProspectingSimulation.StrategyDecision<Integer> nextTarget(
                ProspectingSimulation.Snapshot snapshot,
                Integer phase
            ) {
                ProspectingSimulation.Pos feet = new ProspectingSimulation.Pos(0, 0, 1);
                ProspectingSimulation.Pos head = new ProspectingSimulation.Pos(0, 1, 1);
                if (phase == 0) {
                    return ProspectingSimulation.StrategyDecision.breakBlock(1, head, "head");
                }
                if (phase == 1) {
                    return ProspectingSimulation.StrategyDecision.breakBlock(2, feet, "feet");
                }
                if (phase == 2) {
                    return ProspectingSimulation.StrategyDecision.move(3, feet);
                }
                return ProspectingSimulation.StrategyDecision.stop(phase);
            }
        };
    }

    private static ProspectingSimulation.Strategy<Integer> breakFarVisibleBlockStrategy() {
        return new ProspectingSimulation.Strategy<>() {
            @Override
            public Integer initialState() {
                return 0;
            }

            @Override
            public ProspectingSimulation.StrategyDecision<Integer> nextTarget(
                ProspectingSimulation.Snapshot snapshot,
                Integer state
            ) {
                return ProspectingSimulation.StrategyDecision.breakBlock(
                    state,
                    new ProspectingSimulation.Pos(0, 1, 8),
                    "too_far"
                );
            }
        };
    }

    private record WalkState(int z, int phase) {
    }
}
