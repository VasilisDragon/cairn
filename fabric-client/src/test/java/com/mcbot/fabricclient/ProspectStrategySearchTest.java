package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class ProspectStrategySearchTest {
    private static final long FIRST_SEED = 2_000L;
    private static final int SEED_COUNT = 160;

    @Test
    void boundedPhysicalSearchReportsAnHonestPareto() {
        List<Candidate> candidates = List.of(
            new Candidate("baseline_y16", configAtY(16), config -> baselineSummary(config)),
            new Candidate("baseline_y40", configAtY(40), config -> baselineSummary(config)),
            new Candidate("baseline_y64", configAtY(64), config -> baselineSummary(config)),
            new Candidate("side_probe_spacing_2_y16", configAtY(16), config -> sideProbeSummary(config, 2)),
            new Candidate("side_probe_spacing_3_y16", configAtY(16), config -> sideProbeSummary(config, 3)),
            new Candidate("side_probe_spacing_4_y16", configAtY(16), config -> sideProbeSummary(config, 4))
        );

        String table = measureTable(candidates);

        assertEquals("""
            baseline_y16|found=37/160|blocks=8963|moves=4332|iron=37|blocksPerIron=242.24324|movesPerIron=117.08108|foundRate=0.23125
            baseline_y40|found=27/160|blocks=9376|moves=4536|iron=27|blocksPerIron=347.25926|movesPerIron=168.00000|foundRate=0.16875
            baseline_y64|found=22/160|blocks=9496|moves=4592|iron=22|blocksPerIron=431.63636|movesPerIron=208.72727|foundRate=0.13750
            side_probe_spacing_2_y16|found=31/160|blocks=9177|moves=2145|iron=31|blocksPerIron=296.03226|movesPerIron=69.19355|foundRate=0.19375
            side_probe_spacing_3_y16|found=32/160|blocks=9152|moves=2702|iron=32|blocksPerIron=286.00000|movesPerIron=84.43750|foundRate=0.20000
            side_probe_spacing_4_y16|found=31/160|blocks=9136|moves=2990|iron=31|blocksPerIron=294.70968|movesPerIron=96.45161|foundRate=0.19375
            """, table);
    }

    private static String measureTable(List<Candidate> candidates) {
        StringBuilder out = new StringBuilder();
        for (Candidate candidate : candidates) {
            ProspectingSimulation.Summary summary = candidate.runner().run(candidate.config());
            assertEquals(0, summary.invalidWorlds(), candidate.name() + " invalid in faithful sim: " + summary);
            out.append(candidate.name())
                .append("|found=").append(summary.worldsFound()).append('/').append(summary.worlds())
                .append("|blocks=").append(summary.totalBlocksBroken())
                .append("|moves=").append(summary.totalMovesMade())
                .append("|iron=").append(summary.totalIronFound())
                .append("|blocksPerIron=").append(round(summary.blocksPerIron()))
                .append("|movesPerIron=").append(round(summary.movesPerIron()))
                .append("|foundRate=").append(round(summary.foundRate()))
                .append('\n');
        }
        return out.toString();
    }

    private static ProspectingSimulation.Config configAtY(int worldYOrigin) {
        return new ProspectingSimulation.Config(-10, 10, -2, 3, 0, 96, 64, 24, 1, 4, worldYOrigin);
    }

    private static ProspectingSimulation.Summary baselineSummary(ProspectingSimulation.Config config) {
        return ProspectingSimulation.runAcrossSeeds(
            config,
            FIRST_SEED,
            SEED_COUNT,
            ignored -> ProspectStrategySimulationAdapter.strategy(ProspectStrategyPlanner.StrategyKind.BASELINE_STRAIGHT_TUNNEL)
        );
    }

    private static ProspectingSimulation.Summary sideProbeSummary(ProspectingSimulation.Config config, int spacing) {
        return ProspectingSimulation.runAcrossSeeds(
            config,
            FIRST_SEED,
            SEED_COUNT,
            ignored -> sideProbeStrategy(spacing)
        );
    }

    private static ProspectingSimulation.Strategy<SideProbeState> sideProbeStrategy(int spacing) {
        return new ProspectingSimulation.Strategy<>() {
            @Override
            public SideProbeState initialState() {
                return new SideProbeState(1, 0);
            }

            @Override
            public ProspectingSimulation.StrategyDecision<SideProbeState> nextTarget(
                ProspectingSimulation.Snapshot snapshot,
                SideProbeState state
            ) {
                if (snapshot.ironFound() > 0) {
                    return ProspectingSimulation.StrategyDecision.stop(state);
                }
                Optional<ProspectingSimulation.Pos> reachableIron = snapshot.reachableIronSorted().stream().findFirst();
                if (reachableIron.isPresent()) {
                    return ProspectingSimulation.StrategyDecision.breakBlock(state, reachableIron.get(), "visible_iron");
                }
                SideProbeState cursor = state;
                for (int guard = 0; guard < 64; guard++) {
                    if (cursor.phase() >= phaseCount(cursor.z(), spacing)) {
                        cursor = new SideProbeState(cursor.z() + 1, 0);
                        continue;
                    }
                    Optional<ProspectingSimulation.Pos> target = phaseTarget(cursor.z(), spacing, cursor.phase());
                    SideProbeState next = new SideProbeState(cursor.z(), cursor.phase() + 1);
                    if (target.isPresent()) {
                        ProspectingSimulation.Pos pos = target.get();
                        if (snapshot.reachableBlocks().containsKey(pos)) {
                            return ProspectingSimulation.StrategyDecision.breakBlock(next, pos, phaseReason(cursor.z(), cursor.phase()));
                        }
                        cursor = next;
                        continue;
                    }
                    ProspectingSimulation.Pos move = new ProspectingSimulation.Pos(0, 0, cursor.z());
                    if (snapshot.standableCells().contains(move)) {
                        return ProspectingSimulation.StrategyDecision.move(new SideProbeState(cursor.z() + 1, 0), move);
                    }
                    return ProspectingSimulation.StrategyDecision.stop(cursor);
                }
                return ProspectingSimulation.StrategyDecision.stop(cursor);
            }
        };
    }

    private static int phaseCount(int z, int spacing) {
        return z % spacing == 0 ? 7 : 3;
    }

    private static Optional<ProspectingSimulation.Pos> phaseTarget(int z, int spacing, int phase) {
        if (phase == 0) {
            return Optional.of(new ProspectingSimulation.Pos(0, 1, z));
        }
        if (phase == 1) {
            return Optional.of(new ProspectingSimulation.Pos(0, 0, z));
        }
        if (z % spacing != 0) {
            return Optional.empty();
        }
        return switch (phase) {
            case 2 -> Optional.of(new ProspectingSimulation.Pos(1, 1, z));
            case 3 -> Optional.of(new ProspectingSimulation.Pos(1, 0, z));
            case 4 -> Optional.of(new ProspectingSimulation.Pos(-1, 1, z));
            case 5 -> Optional.of(new ProspectingSimulation.Pos(-1, 0, z));
            default -> Optional.empty();
        };
    }

    private static String phaseReason(int z, int phase) {
        return "side_probe:z=" + z + ":phase=" + phase;
    }

    private static String round(double value) {
        if (Double.isInfinite(value)) {
            return "inf";
        }
        return String.format(java.util.Locale.ROOT, "%.5f", value);
    }

    private record Candidate(
        String name,
        ProspectingSimulation.Config config,
        CandidateRunner runner
    ) {
    }

    private interface CandidateRunner {
        ProspectingSimulation.Summary run(ProspectingSimulation.Config config);
    }

    private record SideProbeState(int z, int phase) {
    }
}
