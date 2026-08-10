package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

final class MissionIronToolReservePolicyTest {
    @Test
    void appliesOnlyToExactMissionIronCommands() {
        assertTrue(MissionIronToolReservePolicy.applies("mission-run-1", "mission:MINE_IRON"));
        assertTrue(MissionIronToolReservePolicy.applies("mission-run-2", "mission:MINE_IRON_RECOVERY"));
        assertFalse(MissionIronToolReservePolicy.applies("stub-run-1", "mission:MINE_IRON"));
        assertFalse(MissionIronToolReservePolicy.applies("mission-run-1", "mine_nearby_iron"));
        assertFalse(MissionIronToolReservePolicy.applies("mission-run-1", "mission:MINE_COAL"));
    }

    @Test
    void frozenLaneRequirementIsExactAndBoundedAtFortySix() {
        MissionIronToolReservePolicy.FrozenLaneHorizon horizon = horizon(30, 8, 8);

        assertTrue(horizon.valid());
        assertEquals(46, horizon.requiredDurability());
        assertEquals(1, horizon(1, 0, 0).requiredDurability());
        assertFalse(horizon(31, 0, 0).valid());
        assertFalse(horizon(0, 9, 0).valid());
        assertFalse(horizon(0, 0, 9).valid());
        assertFalse(horizon(-1, 0, 0).valid());
    }

    @Test
    void recoveryRequirementIncludesAllowanceAndNextLaneWithoutExtendingEpochWork() {
        MissionIronToolReservePolicy.Request request = request(
            List.of(stone(0, 80)),
            0,
            1,
            horizon(30, 8, 8)
        );

        MissionIronToolReservePolicy.Assessment complete =
            MissionIronToolReservePolicy.assessRecovery(request, 3, 384);
        MissionIronToolReservePolicy.Assessment epochClamped =
            MissionIronToolReservePolicy.assessRecovery(request, 2, 4);

        assertEquals(79, complete.requiredDurability());
        assertEquals(MissionIronToolReservePolicy.Status.READY, complete.status());
        assertEquals(50, epochClamped.requiredDurability());
        assertEquals(MissionIronToolReservePolicy.Status.READY, epochClamped.status());
    }

    @Test
    void healthiestRequiredIronPickIsReservedAndOnlyItsExcessIsSpendable() {
        MissionIronToolReservePolicy.Assessment result = assess(
            46,
            List.of(iron(0, 70), iron(1, 30), stone(2, 10)),
            -1,
            1,
            horizon(30, 8, 8)
        );

        assertEquals(List.of(0), result.reservedIronSlots());
        assertEquals(46, result.spendableDurability());
        assertEquals(MissionIronToolReservePolicy.Status.READY, result.status());
        assertEquals(1, result.selectedHotbarSlot());
        assertEquals(MissionIronToolReservePolicy.SelectionReason.SURPLUS_IRON, result.selectionReason());
    }

    @Test
    void twoRequiredPicksReserveTheTwoHealthiestDeterministically() {
        MissionIronToolReservePolicy.Assessment result = assess(
            8,
            List.of(iron(4, 80), iron(1, 80), iron(2, 70), stone(3, 2)),
            -1,
            2,
            horizon(8, 0, 0)
        );

        assertEquals(List.of(1, 4), result.reservedIronSlots());
        assertEquals(104, result.spendableDurability());
        assertEquals(2, result.selectedHotbarSlot());
        assertEquals(MissionIronToolReservePolicy.SelectionReason.SURPLUS_IRON, result.selectionReason());
    }

    @Test
    void currentLegalToolRemainsStableBeforePrioritySwitching() {
        MissionIronToolReservePolicy.Assessment currentStone = assess(
            2,
            List.of(iron(0, 70), iron(1, 20), stone(2, 10)),
            2,
            1,
            horizon(2, 0, 0)
        );
        MissionIronToolReservePolicy.Assessment currentReservedIron = assess(
            2,
            List.of(iron(0, 70), iron(1, 20), stone(2, 10)),
            0,
            1,
            horizon(2, 0, 0)
        );

        assertEquals(2, currentStone.selectedHotbarSlot());
        assertEquals(MissionIronToolReservePolicy.SelectionReason.CURRENT_TOOL_STABLE, currentStone.selectionReason());
        assertEquals(0, currentReservedIron.selectedHotbarSlot());
        assertEquals(
            MissionIronToolReservePolicy.SelectionReason.CURRENT_TOOL_STABLE,
            currentReservedIron.selectionReason()
        );
    }

    @Test
    void reservedIronIsUsedDownToExactlyTheFloorThenStoneTakesOver() {
        MissionIronToolReservePolicy.Request at65 = request(
            List.of(iron(0, 65), stone(1, 10)),
            0,
            1,
            horizon(2, 0, 0)
        );
        MissionIronToolReservePolicy.Assessment selectedIron = MissionIronToolReservePolicy.assess(at65);
        assertEquals(0, selectedIron.selectedHotbarSlot());
        assertTrue(MissionIronToolReservePolicy.canStartBlock(at65, selectedIron, 0, 1));

        MissionIronToolReservePolicy.Request at64 = request(
            List.of(iron(0, 64), stone(1, 10)),
            0,
            1,
            horizon(2, 0, 0)
        );
        MissionIronToolReservePolicy.Assessment selectedStone = MissionIronToolReservePolicy.assess(at64);
        assertEquals(1, selectedStone.selectedHotbarSlot());
        assertEquals(MissionIronToolReservePolicy.SelectionReason.STONE, selectedStone.selectionReason());
        assertFalse(MissionIronToolReservePolicy.canStartBlock(at64, selectedStone, 0, 1));
        assertTrue(MissionIronToolReservePolicy.canStartBlock(at64, selectedStone, 1, 1));

        MissionIronToolReservePolicy.Request at63 = request(
            List.of(iron(0, 63), stone(1, 10)),
            0,
            1,
            horizon(2, 0, 0)
        );
        MissionIronToolReservePolicy.Assessment belowFloor = MissionIronToolReservePolicy.assess(at63);
        assertEquals(1, belowFloor.selectedHotbarSlot());
        assertFalse(MissionIronToolReservePolicy.canStartBlock(at63, belowFloor, 0, 1));
    }

    @Test
    void mainInventoryToolsParticipateInHealthiestReservationAndSelection() {
        MissionIronToolReservePolicy.Assessment result = assess(
            20,
            List.of(iron(2, 65), iron(35, 100), stone(9, 20)),
            -1,
            1,
            horizon(20, 0, 0)
        );

        assertEquals(List.of(35), result.reservedIronSlots());
        assertEquals(2, result.selectedHotbarSlot());
        assertEquals(MissionIronToolReservePolicy.SelectionReason.SURPLUS_IRON, result.selectionReason());
    }

    @Test
    void aBlockCannotCrossTheReserveEvenWithAMultiDurabilityCost() {
        MissionIronToolReservePolicy.Request request = request(
            List.of(iron(0, 65), stone(1, 10)),
            0,
            1,
            horizon(1, 0, 0)
        );
        MissionIronToolReservePolicy.Assessment result = MissionIronToolReservePolicy.assess(request);

        assertTrue(MissionIronToolReservePolicy.canStartBlock(request, result, 0, 1));
        assertFalse(MissionIronToolReservePolicy.canStartBlock(request, result, 0, 2));
    }

    @Test
    void insufficientAggregateDurabilityRequiresRestockAndAdmitsNoBreak() {
        MissionIronToolReservePolicy.Request request = request(
            List.of(iron(0, 64), stone(1, 5)),
            1,
            1,
            horizon(6, 0, 0)
        );
        MissionIronToolReservePolicy.Assessment result = MissionIronToolReservePolicy.assess(request);

        assertEquals(MissionIronToolReservePolicy.Status.RESTOCK_REQUIRED, result.status());
        assertEquals(5, result.spendableDurability());
        assertEquals(-1, result.selectedHotbarSlot());
        assertFalse(MissionIronToolReservePolicy.canStartBlock(request, result, 1, 1));
    }

    @Test
    void conservativeNextLaneBoundaryRequiresFortyOneDurability() {
        MissionIronToolReservePolicy.Request request = request(
            List.of(stone(1, 40)),
            1,
            1,
            horizon(30, 3, 8)
        );

        MissionIronToolReservePolicy.Assessment result = MissionIronToolReservePolicy.assess(request);

        assertEquals(41, result.requiredDurability());
        assertEquals(40, result.spendableDurability());
        assertEquals(MissionIronToolReservePolicy.Status.RESTOCK_REQUIRED, result.status());
        assertEquals(-1, result.selectedHotbarSlot());
    }

    @Test
    void aNotYetCraftedGoalPickDoesNotConsumeAvailableStoneBudget() {
        MissionIronToolReservePolicy.Assessment result = assess(
            10,
            List.of(stone(1, 10)),
            1,
            1,
            horizon(10, 0, 0)
        );

        assertEquals(List.of(), result.reservedIronSlots());
        assertEquals(MissionIronToolReservePolicy.Status.READY, result.status());
        assertEquals(10, result.spendableDurability());
        assertEquals(1, result.selectedHotbarSlot());
    }

    @Test
    void absentOrMalformedMissionContractFailsConservatively() {
        MissionIronToolReservePolicy.Request absent = new MissionIronToolReservePolicy.Request(
            true,
            null,
            null,
            null,
            horizon(1, 0, 0),
            List.of(stone(0, 10)),
            0
        );
        MissionIronToolReservePolicy.Request malformed = new MissionIronToolReservePolicy.Request(
            true,
            65,
            3,
            251,
            horizon(31, 9, 9),
            List.of(stone(0, 10)),
            0
        );

        assertEquals(
            MissionIronToolReservePolicy.Status.INVALID_MISSION_INPUT,
            MissionIronToolReservePolicy.assess(absent).status()
        );
        assertEquals(
            MissionIronToolReservePolicy.Status.INVALID_MISSION_INPUT,
            MissionIronToolReservePolicy.assess(malformed).status()
        );
        assertFalse(MissionIronToolReservePolicy.canStartBlock(
            absent,
            MissionIronToolReservePolicy.assess(absent),
            0,
            1
        ));
    }

    @Test
    void nonMissionCommandsRemainLegacyEvenWithoutReserveFields() {
        MissionIronToolReservePolicy.Request request = new MissionIronToolReservePolicy.Request(
            false,
            null,
            null,
            null,
            null,
            null,
            -1
        );
        MissionIronToolReservePolicy.Assessment result = MissionIronToolReservePolicy.assess(request);

        assertEquals(MissionIronToolReservePolicy.Status.LEGACY, result.status());
        assertEquals(MissionIronToolReservePolicy.SelectionReason.LEGACY, result.selectionReason());
        assertTrue(MissionIronToolReservePolicy.canStartBlock(request, result, 8, 1));
    }

    @Test
    void duplicateOrOutOfInventoryToolEntriesFailConservatively() {
        MissionIronToolReservePolicy.Request duplicate = request(
            List.of(iron(0, 70), stone(0, 10)),
            0,
            1,
            horizon(1, 0, 0)
        );
        MissionIronToolReservePolicy.Request outsideHotbar = request(
            List.of(stone(36, 10)),
            0,
            1,
            horizon(1, 0, 0)
        );

        assertEquals(
            MissionIronToolReservePolicy.Status.INVALID_MISSION_INPUT,
            MissionIronToolReservePolicy.assess(duplicate).status()
        );
        assertEquals(
            MissionIronToolReservePolicy.Status.INVALID_MISSION_INPUT,
            MissionIronToolReservePolicy.assess(outsideHotbar).status()
        );
    }

    private MissionIronToolReservePolicy.Assessment assess(
        int remainingMissionIron,
        List<MissionIronToolReservePolicy.ToolCandidate> tools,
        int currentSlot,
        int reservedCount,
        MissionIronToolReservePolicy.FrozenLaneHorizon horizon
    ) {
        return MissionIronToolReservePolicy.assess(new MissionIronToolReservePolicy.Request(
            true,
            remainingMissionIron,
            reservedCount,
            64,
            horizon,
            tools,
            currentSlot
        ));
    }

    private MissionIronToolReservePolicy.Request request(
        List<MissionIronToolReservePolicy.ToolCandidate> tools,
        int currentSlot,
        int reservedCount,
        MissionIronToolReservePolicy.FrozenLaneHorizon horizon
    ) {
        return new MissionIronToolReservePolicy.Request(
            true,
            8,
            reservedCount,
            64,
            horizon,
            tools,
            currentSlot
        );
    }

    private MissionIronToolReservePolicy.FrozenLaneHorizon horizon(int lane, int raw, int vein) {
        return new MissionIronToolReservePolicy.FrozenLaneHorizon(lane, raw, vein);
    }

    private MissionIronToolReservePolicy.ToolCandidate iron(int slot, int durability) {
        return new MissionIronToolReservePolicy.ToolCandidate(
            slot,
            MissionIronToolReservePolicy.ToolKind.IRON,
            durability
        );
    }

    private MissionIronToolReservePolicy.ToolCandidate stone(int slot, int durability) {
        return new MissionIronToolReservePolicy.ToolCandidate(
            slot,
            MissionIronToolReservePolicy.ToolKind.STONE,
            durability
        );
    }
}
