package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class ConstructiveNav3DHardeningBatchTest {
    @Test
    void constructiveAStarMatchesIndependentOracleAcrossDeterministicRounds() {
        ConstructiveNav3DHardeningBatch.RoundResult round1 = ConstructiveNav3DHardeningBatch.runRound(8303_001L, 500);
        ConstructiveNav3DHardeningBatch.RoundResult round2 = ConstructiveNav3DHardeningBatch.runRound(8303_002L, 500);
        System.out.println("CONSTRUCTIVE_NAV_3D_HARDENING_ROUND_1 " + round1.summary());
        System.out.println("CONSTRUCTIVE_NAV_3D_HARDENING_ROUND_2 " + round2.summary());

        for (ConstructiveNav3DHardeningBatch.RoundResult round : List.of(round1, round2)) {
            assertTrue(round.solvable() > 250, round.summary());
            assertEquals(round.solvable(), round.solved(), round.summary());
            assertEquals(0, round.invalid(), round.summary());
            assertEquals(0, round.spurious(), round.summary());
            assertEquals(0, round.maxOptimalGap(), round.summary());
        }
    }
}
