package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

final class IronToolReserveRestockResumePolicyTest {
    @Test
    void ordinaryWorkspaceRoundtripDoesNotRequireARestockReceipt() {
        assertEquals(
            IronToolReserveRestockResumePolicy.Outcome.ORDINARY_TRANSACTION,
            classify(null, "mission-smelt-133", "smelt_raw_iron", "mission:SMELT_IRON")
        );
        assertEquals(
            IronToolReserveRestockResumePolicy.Outcome.ORDINARY_TRANSACTION,
            classify("", "mission-smelt-133", "smelt_raw_iron", "mission:SMELT_IRON")
        );
    }

    @Test
    void matchingRestockTransactionMustFinalizeAfterFrontierResume() {
        assertEquals(
            IronToolReserveRestockResumePolicy.Outcome.COMPLETE_RESTOCK,
            classify(
                "mission-stone-pick-42",
                "mission-stone-pick-42",
                "craft_stone_pickaxe",
                "mission:MINE_IRON"
            )
        );
    }

    @Test
    void staleRestockContextFailsClosedInsteadOfCompletingAnotherTransaction() {
        assertEquals(
            IronToolReserveRestockResumePolicy.Outcome.REJECT_STALE_CONTEXT,
            classify(
                "mission-stone-pick-42",
                "mission-smelt-133",
                "smelt_raw_iron",
                "mission:SMELT_IRON"
            )
        );
        assertEquals(
            IronToolReserveRestockResumePolicy.Outcome.REJECT_STALE_CONTEXT,
            classify(
                "mission-stone-pick-42",
                null,
                "craft_stone_pickaxe",
                "mission:MINE_IRON"
            )
        );
    }

    @Test
    void matchingCommandCannotTurnAnOrdinaryTransactionIntoARestock() {
        assertEquals(
            IronToolReserveRestockResumePolicy.Outcome.REJECT_STALE_CONTEXT,
            classify(
                "mission-stone-pick-42",
                "mission-stone-pick-42",
                "smelt_raw_iron",
                "mission:SMELT_IRON"
            )
        );
        assertEquals(
            IronToolReserveRestockResumePolicy.Outcome.REJECT_STALE_CONTEXT,
            classify(
                "mission-stone-pick-42",
                "mission-stone-pick-42",
                "craft_stone_pickaxe",
                "mission:MAKE_STONE_TOOLS"
            )
        );
    }

    private static IronToolReserveRestockResumePolicy.Outcome classify(
        String restockCommandId,
        String transactionCommandId,
        String transactionAction,
        String transactionReason
    ) {
        return IronToolReserveRestockResumePolicy.classify(
            restockCommandId,
            transactionCommandId,
            transactionAction,
            transactionReason
        );
    }
}
