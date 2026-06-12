package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class Nav3DHardeningBatchTest {
    @Test
    void aStarMatchesIndependentBfsGroundTruthAcrossDeterministicRounds() {
        Nav3DHardeningBatch.RoundResult round1 = Nav3DHardeningBatch.runRound(8103_001L, 500);
        Nav3DHardeningBatch.RoundResult round2 = Nav3DHardeningBatch.runRound(8103_002L, 500);
        System.out.println("NAV_3D_HARDENING_ROUND_1 " + round1.summary());
        System.out.println("NAV_3D_HARDENING_ROUND_2 " + round2.summary());

        for (Nav3DHardeningBatch.RoundResult round : List.of(round1, round2)) {
            // Enough independently-reachable scenarios for the round to mean something.
            assertTrue(round.solvable() > 300, round.summary());
            // The falsifiable invariant: A* must route EVERY BFS-reachable scenario with a legal path.
            // (Was structurally impossible to fail before, when solvable := A*'s own routeFound.)
            assertEquals(round.solvable(), round.solved(), round.summary());
            // A* must never emit an illegal route, nor a route to a BFS-unreachable goal.
            assertEquals(0, round.invalid(), round.summary());
            assertEquals(0, round.spurious(), round.summary());
        }
    }
}
