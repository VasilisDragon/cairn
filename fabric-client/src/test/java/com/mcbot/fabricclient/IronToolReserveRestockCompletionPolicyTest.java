package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

final class IronToolReserveRestockCompletionPolicyTest {
    @Test
    void stopWrappedResidentCraftCompletesTheFrozenRestock() {
        assertEquals(
            IronToolReserveRestockCompletionPolicy.Outcome.SUCCEEDED,
            classify(
                "stop",
                "craft_stone_pickaxe_complete:craft_stone_pickaxe_typed_delta_verified",
                "craft_stone_pickaxe_complete:craft_stone_pickaxe_typed_delta_verified",
                "mission-135",
                false,
                "mission-135",
                "mission-135",
                "craft_stone_pickaxe",
                "mission:MINE_IRON"
            )
        );
    }

    @Test
    void directCraftCompletionRemainsSupported() {
        assertEquals(
            IronToolReserveRestockCompletionPolicy.Outcome.SUCCEEDED,
            classify(
                "craft_stone_pickaxe",
                "mission:MINE_IRON",
                "craft_stone_pickaxe_complete:craft_stone_pickaxe_typed_delta_verified",
                "mission-135",
                false,
                "",
                "",
                "",
                ""
            )
        );
    }

    @Test
    void localFallbackReceiptIsNeutralAndDoesNotClaimACraft() {
        assertEquals(
            IronToolReserveRestockCompletionPolicy.Outcome.LOCAL_FALLBACK_HANDOFF,
            classify(
                "stop",
                "craft_stone_pickaxe_complete:mining_workspace_local_fallback_required",
                "craft_stone_pickaxe_complete:mining_workspace_local_fallback_required",
                "mission-135",
                true,
                "",
                "",
                "",
                ""
            )
        );
    }

    @Test
    void failedCraftIsClassifiedWithoutBecomingSuccess() {
        assertEquals(
            IronToolReserveRestockCompletionPolicy.Outcome.FAILED,
            classify(
                "stop",
                "craft_stone_pickaxe_failed:missing_cobblestone",
                "craft_stone_pickaxe_failed:missing_cobblestone",
                "mission-135",
                false,
                "mission-135",
                "",
                "",
                ""
            )
        );
    }

    @Test
    void unrelatedOrMismatchedCompletionsAreIgnored() {
        assertEquals(
            IronToolReserveRestockCompletionPolicy.Outcome.NONE,
            classify(
                "stop",
                "craft_stone_pickaxe_complete:craft_stone_pickaxe_typed_delta_verified",
                "craft_stone_pickaxe_complete:craft_stone_pickaxe_typed_delta_verified",
                "mission-136",
                false,
                "mission-135",
                "mission-135",
                "craft_stone_pickaxe",
                "mission:MINE_IRON"
            )
        );
        assertEquals(
            IronToolReserveRestockCompletionPolicy.Outcome.NONE,
            classify(
                "stop",
                "craft_stone_pickaxe_complete:craft_stone_pickaxe_typed_delta_verified",
                "craft_stone_pickaxe_complete:craft_stone_pickaxe_typed_delta_verified",
                "mission-135",
                false,
                "",
                "mission-135",
                "craft_stone_pickaxe",
                "mission:MAKE_ARMOR"
            )
        );
    }

    private static IronToolReserveRestockCompletionPolicy.Outcome classify(
        String action,
        String reason,
        String completion,
        String commandId,
        boolean pending,
        String restockCommandId,
        String residentCommandId,
        String residentAction,
        String residentReason
    ) {
        return IronToolReserveRestockCompletionPolicy.classify(
            new IronToolReserveRestockCompletionPolicy.Observation(
                action,
                reason,
                completion,
                commandId,
                pending,
                restockCommandId,
                residentCommandId,
                residentAction,
                residentReason
            )
        );
    }
}
