package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

final class MissionStoneFaceHarvestBudgetTest {
    @Test
    void verifiedFaceProductionConsumesOneCommandScopedAllowance() {
        MissionStoneFaceHarvestBudget budget = new MissionStoneFaceHarvestBudget();

        for (int index = 0; index < MissionStoneMethodPlanner.FACE_BLOCK_LIMIT; index++) {
            assertEquals(
                MissionStoneFaceHarvestBudget.RecordResult.RECORDED,
                budget.recordVerifiedProduction(MissionStoneMethodPlanner.Method.REACHABLE_FACE)
            );
        }

        assertEquals(MissionStoneMethodPlanner.FACE_BLOCK_LIMIT, budget.harvestedBlocks());
        assertEquals(0, budget.remainingBlocks());
        assertEquals(
            MissionStoneFaceHarvestBudget.RecordResult.EXHAUSTED,
            budget.recordVerifiedProduction(MissionStoneMethodPlanner.Method.REACHABLE_FACE)
        );
        assertEquals(MissionStoneMethodPlanner.FACE_BLOCK_LIMIT, budget.harvestedBlocks());
    }

    @Test
    void otherMethodsDoNotConsumeOrResetTheFaceAllowance() {
        MissionStoneFaceHarvestBudget budget = new MissionStoneFaceHarvestBudget();
        assertEquals(
            MissionStoneFaceHarvestBudget.RecordResult.RECORDED,
            budget.recordVerifiedProduction(MissionStoneMethodPlanner.Method.REACHABLE_FACE)
        );
        assertEquals(
            MissionStoneFaceHarvestBudget.RecordResult.IGNORED_NON_FACE,
            budget.recordVerifiedProduction(MissionStoneMethodPlanner.Method.STAIRCASE)
        );
        assertEquals(
            MissionStoneFaceHarvestBudget.RecordResult.IGNORED_NON_FACE,
            budget.recordVerifiedProduction(MissionStoneMethodPlanner.Method.SAFE_DROP)
        );
        assertEquals(1, budget.harvestedBlocks());
        assertEquals(MissionStoneMethodPlanner.FACE_BLOCK_LIMIT - 1, budget.remainingBlocks());
    }
}
