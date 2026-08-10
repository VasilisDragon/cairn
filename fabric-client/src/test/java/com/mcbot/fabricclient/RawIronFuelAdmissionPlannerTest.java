package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.api.Test;

final class RawIronFuelAdmissionPlannerTest {
    @Test
    void rejectsFourAndSevenPlanksForAThreeItemBatch() {
        assertEquals(RawIronFuelAdmissionPlanner.Outcome.UNAVAILABLE, planWithPlanks(3, 4).outcome());
        assertEquals(RawIronFuelAdmissionPlanner.Outcome.UNAVAILABLE, planWithPlanks(3, 7).outcome());
    }

    @Test
    void insertsExactlyTwoOfEightPlanks() {
        RawIronFuelAdmissionPlanner.Plan plan = planWithPlanks(3, 8);

        assertEquals(RawIronFuelAdmissionPlanner.Outcome.INSERT_SOURCE, plan.outcome());
        assertEquals(RawIronFuelAdmissionPlanner.SourceClass.PLANK, plan.sourceClass());
        assertEquals(2, plan.insertCount());
        assertEquals(2, plan.requiredFuelCount());
    }

    @Test
    void sevenPlanksCanFuelAOneItemBatch() {
        RawIronFuelAdmissionPlanner.Plan plan = planWithPlanks(1, 7);

        assertEquals(RawIronFuelAdmissionPlanner.Outcome.INSERT_SOURCE, plan.outcome());
        assertEquals(1, plan.insertCount());
    }

    @Test
    void reusesSufficientLoadedFuelWithoutApplyingInventoryReserve() {
        RawIronFuelAdmissionPlanner.Plan plan = RawIronFuelAdmissionPlanner.plan(new RawIronFuelAdmissionPlanner.Request(
            3,
            "oak_planks",
            2,
            RawIronFuelAdmissionPlanner.SourceClass.PLANK,
            List.of(),
            0,
            6
        ));

        assertEquals(RawIronFuelAdmissionPlanner.Outcome.REUSE_LOADED, plan.outcome());
        assertEquals(0, plan.insertCount());
    }

    @Test
    void reusesOneLoadedCoalForAThreeItemBatch() {
        RawIronFuelAdmissionPlanner.Plan plan = RawIronFuelAdmissionPlanner.plan(new RawIronFuelAdmissionPlanner.Request(
            3,
            "coal",
            1,
            RawIronFuelAdmissionPlanner.SourceClass.EFFICIENT,
            List.of(),
            0,
            6
        ));

        assertEquals(RawIronFuelAdmissionPlanner.Outcome.REUSE_LOADED, plan.outcome());
        assertEquals(RawIronFuelAdmissionPlanner.SourceClass.EFFICIENT, plan.sourceClass());
        assertEquals(1, plan.requiredFuelCount());
    }

    @Test
    void reusesTwoLoadedLogsForAThreeItemBatch() {
        RawIronFuelAdmissionPlanner.Plan plan = RawIronFuelAdmissionPlanner.plan(new RawIronFuelAdmissionPlanner.Request(
            3,
            "oak_log",
            2,
            RawIronFuelAdmissionPlanner.SourceClass.LOG,
            List.of(),
            0,
            6
        ));

        assertEquals(RawIronFuelAdmissionPlanner.Outcome.REUSE_LOADED, plan.outcome());
        assertEquals(RawIronFuelAdmissionPlanner.SourceClass.LOG, plan.sourceClass());
        assertEquals(2, plan.requiredFuelCount());
    }

    @Test
    void topsUpShortLoadedFuelWithTheSameItemOnly() {
        RawIronFuelAdmissionPlanner.Plan plan = RawIronFuelAdmissionPlanner.plan(new RawIronFuelAdmissionPlanner.Request(
            3,
            "birch_planks",
            1,
            RawIronFuelAdmissionPlanner.SourceClass.PLANK,
            List.of(
                stack(4, "oak_planks", 12, RawIronFuelAdmissionPlanner.SourceClass.PLANK),
                stack(7, "birch_planks", 7, RawIronFuelAdmissionPlanner.SourceClass.PLANK)
            ),
            19,
            6
        ));

        assertEquals(RawIronFuelAdmissionPlanner.Outcome.TOP_UP_SAME_ITEM, plan.outcome());
        assertEquals("birch_planks", plan.sourceItemId());
        assertEquals(7, plan.sourceSlot());
        assertEquals(1, plan.insertCount());
    }

    @Test
    void shortLoadedFuelWithoutCompatibleTopUpBlocksTheSlot() {
        RawIronFuelAdmissionPlanner.Plan plan = RawIronFuelAdmissionPlanner.plan(new RawIronFuelAdmissionPlanner.Request(
            3,
            "birch_planks",
            1,
            RawIronFuelAdmissionPlanner.SourceClass.PLANK,
            List.of(stack(4, "oak_planks", 12, RawIronFuelAdmissionPlanner.SourceClass.PLANK)),
            12,
            6
        ));

        assertEquals(RawIronFuelAdmissionPlanner.Outcome.BLOCKED_SLOT, plan.outcome());
        assertEquals("compatible_top_up_missing", plan.reason());
    }

    @Test
    void efficientFuelWinsBeforeLogsAndPlanks() {
        RawIronFuelAdmissionPlanner.Plan plan = RawIronFuelAdmissionPlanner.plan(new RawIronFuelAdmissionPlanner.Request(
            3,
            "",
            0,
            RawIronFuelAdmissionPlanner.SourceClass.INVALID,
            List.of(
                stack(3, "oak_planks", 8, RawIronFuelAdmissionPlanner.SourceClass.PLANK),
                stack(4, "oak_log", 2, RawIronFuelAdmissionPlanner.SourceClass.LOG),
                stack(5, "charcoal", 1, RawIronFuelAdmissionPlanner.SourceClass.EFFICIENT)
            ),
            8,
            6
        ));

        assertEquals(RawIronFuelAdmissionPlanner.SourceClass.EFFICIENT, plan.sourceClass());
        assertEquals("charcoal", plan.sourceItemId());
        assertEquals(1, plan.insertCount());
    }

    @Test
    void splitSameIdStacksAreAdmittedButMixedIdsAreNotCombined() {
        RawIronFuelAdmissionPlanner.Request split = new RawIronFuelAdmissionPlanner.Request(
            3,
            "",
            0,
            RawIronFuelAdmissionPlanner.SourceClass.INVALID,
            List.of(
                stack(3, "oak_planks", 1, RawIronFuelAdmissionPlanner.SourceClass.PLANK),
                stack(9, "oak_planks", 1, RawIronFuelAdmissionPlanner.SourceClass.PLANK)
            ),
            8,
            6
        );
        RawIronFuelAdmissionPlanner.Request mixed = new RawIronFuelAdmissionPlanner.Request(
            3,
            "",
            0,
            RawIronFuelAdmissionPlanner.SourceClass.INVALID,
            List.of(
                stack(3, "oak_planks", 1, RawIronFuelAdmissionPlanner.SourceClass.PLANK),
                stack(9, "birch_planks", 1, RawIronFuelAdmissionPlanner.SourceClass.PLANK)
            ),
            8,
            6
        );

        assertEquals(RawIronFuelAdmissionPlanner.Outcome.INSERT_SOURCE, RawIronFuelAdmissionPlanner.plan(split).outcome());
        assertEquals(RawIronFuelAdmissionPlanner.Outcome.UNAVAILABLE, RawIronFuelAdmissionPlanner.plan(mixed).outcome());
    }

    @Test
    void junkLoadedFuelSlotFailsClosed() {
        RawIronFuelAdmissionPlanner.Plan plan = RawIronFuelAdmissionPlanner.plan(new RawIronFuelAdmissionPlanner.Request(
            3,
            "cobblestone",
            1,
            RawIronFuelAdmissionPlanner.SourceClass.INVALID,
            List.of(stack(3, "coal", 1, RawIronFuelAdmissionPlanner.SourceClass.EFFICIENT)),
            0,
            6
        ));

        assertEquals(RawIronFuelAdmissionPlanner.Outcome.BLOCKED_SLOT, plan.outcome());
    }

    @Test
    void loadedInputVerificationSurvivesImmediateVanillaFuelConsumption() {
        RawIronFuelAdmissionPlanner.Plan plan = RawIronFuelAdmissionPlanner.plan(new RawIronFuelAdmissionPlanner.Request(
            3,
            "birch_planks",
            1,
            RawIronFuelAdmissionPlanner.SourceClass.PLANK,
            List.of(stack(7, "birch_planks", 7, RawIronFuelAdmissionPlanner.SourceClass.PLANK)),
            7,
            6
        ));

        assertEquals(RawIronFuelAdmissionPlanner.Outcome.TOP_UP_SAME_ITEM, plan.outcome());
        assertEquals(
            true,
            RawIronFuelAdmissionPlanner.insertionVerified(plan, "birch_planks", "birch_planks", 1, 1, true)
        );
        assertEquals(
            false,
            RawIronFuelAdmissionPlanner.insertionVerified(plan, "birch_planks", "birch_planks", 1, 0, true)
        );
    }

    @Test
    void emptyInputRequiresObservedFuelInsteadOfClickAccountingAlone() {
        RawIronFuelAdmissionPlanner.Plan plan = planWithPlanks(3, 8);

        assertEquals(
            false,
            RawIronFuelAdmissionPlanner.insertionVerified(plan, "oak_planks", "oak_planks", 1, 2, false)
        );
        assertEquals(
            true,
            RawIronFuelAdmissionPlanner.insertionVerified(plan, "oak_planks", "oak_planks", 2, 2, false)
        );
    }

    @Test
    void missingFuelSourceBeforeVerificationCompletesNeutrally() {
        assertEquals(
            RawIronFuelAdmissionPlanner.RuntimeSourceDecision.NEUTRAL_UNAVAILABLE,
            RawIronFuelAdmissionPlanner.decideFuelSource(false, false)
        );
        assertEquals(
            RawIronFuelAdmissionPlanner.RuntimeSourceDecision.READY,
            RawIronFuelAdmissionPlanner.decideFuelSource(false, true)
        );
    }

    @Test
    void missingInputAfterFuelVerificationRemainsANormalFailure() {
        assertEquals(
            RawIronFuelAdmissionPlanner.RuntimeSourceDecision.NORMAL_FAILURE,
            RawIronFuelAdmissionPlanner.decideInputSource(true, false)
        );
        assertEquals(
            RawIronFuelAdmissionPlanner.RuntimeSourceDecision.READY,
            RawIronFuelAdmissionPlanner.decideInputSource(true, true)
        );
    }

    private RawIronFuelAdmissionPlanner.Plan planWithPlanks(int batch, int planks) {
        return RawIronFuelAdmissionPlanner.plan(new RawIronFuelAdmissionPlanner.Request(
            batch,
            "",
            0,
            RawIronFuelAdmissionPlanner.SourceClass.INVALID,
            List.of(stack(3, "oak_planks", planks, RawIronFuelAdmissionPlanner.SourceClass.PLANK)),
            planks,
            6
        ));
    }

    private RawIronFuelAdmissionPlanner.InventoryFuelStack stack(
        int slot,
        String itemId,
        int count,
        RawIronFuelAdmissionPlanner.SourceClass sourceClass
    ) {
        return new RawIronFuelAdmissionPlanner.InventoryFuelStack(slot, itemId, count, sourceClass);
    }
}
