package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.api.Test;

final class DescentExecutorIronToolReserveTest {
    @Test
    void exactRecoveryRequiresRemainingDescentPlusTheConservativeNextLane() {
        MissionIronToolReservePolicy.Assessment result = assessRecovery(
            8,
            1,
            64,
            List.of(iron(0, 70), stone(1, 68)),
            0,
            3,
            384
        );

        assertEquals(74, result.requiredDurability());
        assertEquals(74, result.spendableDurability());
        assertEquals(MissionIronToolReservePolicy.Status.READY, result.status());
        assertEquals(0, result.selectedHotbarSlot());
        assertEquals(
            MissionIronToolReservePolicy.SelectionReason.CURRENT_TOOL_STABLE,
            result.selectionReason()
        );
    }

    @Test
    void recoverySwitchesToStoneAtTheReservedFloor() {
        MissionIronToolReservePolicy.Assessment result = assessRecovery(
            8,
            1,
            64,
            List.of(iron(0, 64), stone(1, 74)),
            0,
            3,
            384
        );

        assertEquals(MissionIronToolReservePolicy.Status.READY, result.status());
        assertEquals(List.of(0), result.reservedIronSlots());
        assertEquals(1, result.selectedHotbarSlot());
        assertEquals(MissionIronToolReservePolicy.SelectionReason.STONE, result.selectionReason());
    }

    @Test
    void recoveryRestocksBeforeTheCombinedHorizonIsUnderfunded() {
        MissionIronToolReservePolicy.Assessment result = assessRecovery(
            8,
            1,
            64,
            List.of(iron(0, 70), stone(1, 67)),
            1,
            3,
            384
        );

        assertEquals(74, result.requiredDurability());
        assertEquals(73, result.spendableDurability());
        assertEquals(MissionIronToolReservePolicy.Status.RESTOCK_REQUIRED, result.status());
        assertEquals(-1, result.selectedHotbarSlot());
    }

    @Test
    void remainingEpochWorkClampsOnlyProspectingAndPreservesRecoveryAllowance() {
        MissionIronToolReservePolicy.Assessment result = assessRecovery(
            8,
            1,
            64,
            List.of(stone(1, 100)),
            1,
            10,
            40
        );

        assertEquals(95, result.requiredDurability());
        assertEquals(MissionIronToolReservePolicy.Status.READY, result.status());
    }

    @Test
    void shortRemainingEpochStillKeepsRawVeinAndRecoveryAllowances() {
        MissionIronToolReservePolicy.Assessment result = assessRecovery(
            8,
            1,
            64,
            List.of(stone(35, 50)),
            35,
            2,
            4
        );

        assertEquals(45, result.requiredDurability());
        assertEquals(35, result.selectedHotbarSlot());
        assertEquals(MissionIronToolReservePolicy.Status.READY, result.status());
    }

    @Test
    void recoveryUsesTheAuthoritativeCurrentRecipeMilestoneRatherThanTheTotalMissionRemainder() {
        MissionIronToolReservePolicy.Assessment prePick = assessRecovery(
            27, 1, 64, inventory(0, 0, 0, armor(false, false, false, false)),
            List.of(stone(1, 100)), 1, 2, 384
        );
        MissionIronToolReservePolicy.Assessment helmet = assessRecovery(
            24, 1, 64, inventory(0, 0, 1, armor(false, false, false, false)),
            List.of(stone(1, 100)), 1, 2, 384
        );
        MissionIronToolReservePolicy.Assessment chestplate = assessRecovery(
            19, 1, 64, inventory(0, 0, 1, armor(true, false, false, false)),
            List.of(stone(1, 100)), 1, 2, 384
        );
        MissionIronToolReservePolicy.Assessment partialPick = assessRecovery(
            25, 1, 64, inventory(2, 0, 0, armor(false, false, false, false)),
            List.of(stone(1, 100)), 1, 2, 384
        );
        MissionIronToolReservePolicy.Assessment clamped = assessRecovery(
            2, 1, 64, inventory(0, 0, 0, armor(false, false, false, false)),
            List.of(stone(1, 100)), 1, 2, 384
        );

        assertEquals(71, prePick.requiredDurability(), "30 recovery + 30 lane + 3 pick + 8 vein");
        assertEquals(73, helmet.requiredDurability(), "the helmet recipe needs five current iron");
        assertEquals(76, chestplate.requiredDurability(), "the next missing chestplate needs eight");
        assertEquals(69, partialPick.requiredDurability(), "owned raw reduces the current pick milestone");
        assertEquals(70, clamped.requiredDurability(), "the frozen mission remainder caps the milestone");
    }

    @Test
    void diamondSparePickaxeUsesThePickRecipeMilestone() {
        MissionIronToolReservePolicy.Assessment result = assessRecovery(
            3, 2, 64, inventory(0, 0, 1, armor(false, false, false, false)),
            List.of(iron(0, 200), stone(1, 100)), 1, 2, 384
        );

        assertEquals(71, result.requiredDurability());
    }

    @Test
    void exactRecoveryReserveFeedbackUsesNeutralCanonicalCompletionReasons() {
        assertEquals(
            "descent_complete:tool_reserve_required",
            DescentExecutor.missionIronRecoveryReserveCompletionReason(false)
        );
        assertEquals(
            "descent_complete:tool_reserve_unavailable",
            DescentExecutor.missionIronRecoveryReserveCompletionReason(true)
        );
    }

    @Test
    void malformedMissionRecoveryFieldsFailClosed() {
        MissionIronToolReservePolicy.Assessment result = assessRecovery(
            null,
            null,
            null,
            List.of(stone(1, 131)),
            1,
            3,
            384
        );

        assertEquals(MissionIronToolReservePolicy.Status.INVALID_MISSION_INPUT, result.status());
        assertEquals("invalid_remaining_mission_iron", result.reason());
    }

    @Test
    void primaryAndNonMissionDescentsRemainLegacyPassThrough() {
        MissionIronToolReservePolicy.Assessment primary = DescentExecutor.assessMissionIronRecoveryReserve(
            "mission-run-1",
            "mission:DESCEND",
            null,
            null,
            null,
            null,
            null,
            -1,
            20,
            384
        );
        MissionIronToolReservePolicy.Assessment stub = DescentExecutor.assessMissionIronRecoveryReserve(
            "stub-run-1",
            "mission:MINE_IRON_RECOVERY",
            null,
            null,
            null,
            null,
            null,
            -1,
            3,
            384
        );

        assertEquals(MissionIronToolReservePolicy.Status.LEGACY, primary.status());
        assertEquals(MissionIronToolReservePolicy.Status.LEGACY, stub.status());
    }

    private MissionIronToolReservePolicy.Assessment assessRecovery(
        Integer remainingIron,
        Integer reservedCount,
        Integer floor,
        List<MissionIronToolReservePolicy.ToolCandidate> tools,
        int selectedSlot,
        int remainingDepth,
        int remainingEpochWork
    ) {
        return assessRecovery(
            remainingIron,
            reservedCount,
            floor,
            inventory(0, 0, 0, armor(false, false, false, false)),
            tools,
            selectedSlot,
            remainingDepth,
            remainingEpochWork
        );
    }

    private MissionIronToolReservePolicy.Assessment assessRecovery(
        Integer remainingIron,
        Integer reservedCount,
        Integer floor,
        DescentExecutor.MissionIronRecoveryInventory inventory,
        List<MissionIronToolReservePolicy.ToolCandidate> tools,
        int selectedSlot,
        int remainingDepth,
        int remainingEpochWork
    ) {
        return DescentExecutor.assessMissionIronRecoveryReserve(
            "mission-run-1",
            "mission:MINE_IRON_RECOVERY",
            remainingIron,
            reservedCount,
            floor,
            inventory,
            tools,
            selectedSlot,
            remainingDepth,
            remainingEpochWork
        );
    }

    private DescentExecutor.MissionIronRecoveryInventory inventory(
        int rawIron,
        int ironIngots,
        int ironPickaxes,
        IronMiningTargetDeltaPlanner.ArmorState armor
    ) {
        return new DescentExecutor.MissionIronRecoveryInventory(rawIron, ironIngots, ironPickaxes, armor);
    }

    private IronMiningTargetDeltaPlanner.ArmorState armor(
        boolean helmet,
        boolean chestplate,
        boolean leggings,
        boolean boots
    ) {
        return new IronMiningTargetDeltaPlanner.ArmorState(
            helmet,
            chestplate,
            leggings,
            boots,
            0,
            0,
            0,
            0
        );
    }

    private MissionIronToolReservePolicy.ToolCandidate iron(int slot, int remaining) {
        return new MissionIronToolReservePolicy.ToolCandidate(
            slot,
            MissionIronToolReservePolicy.ToolKind.IRON,
            remaining
        );
    }

    private MissionIronToolReservePolicy.ToolCandidate stone(int slot, int remaining) {
        return new MissionIronToolReservePolicy.ToolCandidate(
            slot,
            MissionIronToolReservePolicy.ToolKind.STONE,
            remaining
        );
    }
}
