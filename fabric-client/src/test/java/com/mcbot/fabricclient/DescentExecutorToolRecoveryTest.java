package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * Offline coverage for the descent field-kit tool-recovery state plumbing ported from the iron path.
 *
 * <p>Exercises the {@code DescentRun} <-> {@link FieldKitRecoveryPlanner.State} round-trip
 * ({@code descentFieldKitState} / {@code applyDescentFieldKitDecision}) and the run's field-kit
 * sub-command-id generators. The {@link FieldKitRecoveryPlanner} transition logic itself is covered by
 * {@link FieldKitRecoveryPlannerTest}; here we only verify the executor wiring writes the planner's
 * state back onto the run and reads it back faithfully.
 *
 * <p>The state accessors never touch {@link ShellServices}, so a {@code null} shell is safe — the
 * driver/dispatch/reactive paths (which do call the shell + Minecraft client) are only exercisable on a
 * live run and are intentionally NOT faked here.
 */
class DescentExecutorToolRecoveryTest {

    private static DescentExecutor.DescentRun newRun(String commandId) {
        return new DescentExecutor.DescentRun(
            commandId,
            new BlockPos(0, 64, 0),
            StaircaseDescentPlanner.south(),
            6,
            0L,
            20.0F
        );
    }

    @Test
    void freshRunStartsWithNoActiveFieldKitRecovery() {
        DescentExecutor executor = new DescentExecutor(null);
        DescentExecutor.DescentRun run = newRun("descend-1");

        FieldKitRecoveryPlanner.State state = executor.descentFieldKitState(run);

        assertFalse(state.active());
        assertFalse(state.retrieveTablePending());
        assertFalse(state.tablePlacedByRecovery());
        assertFalse(state.alcoveKnown());
        assertFalse(state.proactiveLogged());
        assertEquals(0, state.attempts());
    }

    @Test
    void alcoveKnownIsAlwaysFalseForDescent() {
        DescentExecutor executor = new DescentExecutor(null);
        DescentExecutor.DescentRun run = newRun("descend-1");
        // Even if every recovery flag is forced on, descent reports alcoveKnown=false (S2: no alcove).
        run.descentFieldKitRecoveryActive = true;
        run.descentFieldKitRetrieveTablePending = true;
        run.descentFieldKitTablePlacedByRecovery = true;
        run.descentProactiveToolRecoveryLogged = true;
        run.descentToolRecoveryAttempts = 3;

        FieldKitRecoveryPlanner.State state = executor.descentFieldKitState(run);

        assertTrue(state.active());
        assertTrue(state.retrieveTablePending());
        assertTrue(state.tablePlacedByRecovery());
        assertFalse(state.alcoveKnown());
        assertTrue(state.proactiveLogged());
        assertEquals(3, state.attempts());
    }

    @Test
    void activateDecisionLatchesRecoveryOntoRun() {
        DescentExecutor executor = new DescentExecutor(null);
        DescentExecutor.DescentRun run = newRun("descend-1");

        FieldKitRecoveryPlanner.Decision decision =
            executor.applyDescentFieldKitDecision(run, FieldKitRecoveryPlanner.activate(executor.descentFieldKitState(run)));

        assertEquals(FieldKitRecoveryPlanner.Action.CONTINUE, decision.action());
        assertTrue(run.descentFieldKitRecoveryActive);
        // Re-reading the state must reflect the freshly written run fields.
        assertTrue(executor.descentFieldKitState(run).active());
    }

    @Test
    void applyDecisionRoundTripsEveryStateField() {
        DescentExecutor executor = new DescentExecutor(null);
        DescentExecutor.DescentRun run = newRun("descend-1");

        FieldKitRecoveryPlanner.State source = new FieldKitRecoveryPlanner.State(true, true, true, false, true, 2);
        executor.applyDescentFieldKitDecision(
            run, new FieldKitRecoveryPlanner.Decision(source, FieldKitRecoveryPlanner.Action.CONTINUE, false));

        assertTrue(run.descentFieldKitRecoveryActive);
        assertTrue(run.descentFieldKitRetrieveTablePending);
        assertTrue(run.descentFieldKitTablePlacedByRecovery);
        assertTrue(run.descentProactiveToolRecoveryLogged);
        assertEquals(2, run.descentToolRecoveryAttempts);

        FieldKitRecoveryPlanner.State readBack = executor.descentFieldKitState(run);
        assertEquals(source.active(), readBack.active());
        assertEquals(source.retrieveTablePending(), readBack.retrieveTablePending());
        assertEquals(source.tablePlacedByRecovery(), readBack.tablePlacedByRecovery());
        assertEquals(source.proactiveLogged(), readBack.proactiveLogged());
        assertEquals(source.attempts(), readBack.attempts());
    }

    @Test
    void craftCompleteWithoutPlacedTableClearsRecoveryAndIncrementsAttempts() {
        DescentExecutor executor = new DescentExecutor(null);
        DescentExecutor.DescentRun run = newRun("descend-1");
        executor.applyDescentFieldKitDecision(run, FieldKitRecoveryPlanner.activate(executor.descentFieldKitState(run)));

        executor.applyDescentFieldKitDecision(run,
            FieldKitRecoveryPlanner.afterCraftPickaxe(executor.descentFieldKitState(run), "craft_stone_pickaxe_complete:verified"));

        // No table was placed by recovery -> the latch releases and the attempt counter advances.
        assertFalse(run.descentFieldKitRecoveryActive);
        assertFalse(run.descentFieldKitRetrieveTablePending);
        assertEquals(1, run.descentToolRecoveryAttempts);
    }

    @Test
    void craftCompleteAfterRecoveryPlacedTableKeepsRetrievePending() {
        DescentExecutor executor = new DescentExecutor(null);
        DescentExecutor.DescentRun run = newRun("descend-1");
        executor.applyDescentFieldKitDecision(run, FieldKitRecoveryPlanner.activate(executor.descentFieldKitState(run)));
        run.descentFieldKitTablePlacedByRecovery = true;

        executor.applyDescentFieldKitDecision(run,
            FieldKitRecoveryPlanner.afterCraftPickaxe(executor.descentFieldKitState(run), "craft_stone_pickaxe_complete:verified"));

        // A recovery-placed table must be picked back up: stay active with retrieve pending.
        assertTrue(run.descentFieldKitRecoveryActive);
        assertTrue(run.descentFieldKitRetrieveTablePending);
        assertTrue(run.descentFieldKitTablePlacedByRecovery);
        assertEquals(1, run.descentToolRecoveryAttempts);
    }

    @Test
    void retrieveCompleteReleasesEveryRecoveryFlag() {
        DescentExecutor executor = new DescentExecutor(null);
        DescentExecutor.DescentRun run = newRun("descend-1");
        run.descentFieldKitRecoveryActive = true;
        run.descentFieldKitRetrieveTablePending = true;
        run.descentFieldKitTablePlacedByRecovery = true;
        run.descentToolRecoveryAttempts = 1;

        executor.applyDescentFieldKitDecision(run,
            FieldKitRecoveryPlanner.afterRetrieve(executor.descentFieldKitState(run), "retrieve_table_complete:verified"));

        assertFalse(run.descentFieldKitRecoveryActive);
        assertFalse(run.descentFieldKitRetrieveTablePending);
        assertFalse(run.descentFieldKitTablePlacedByRecovery);
        // clearRecovery preserves the attempt count (the run-level budget is not reset on retrieve).
        assertEquals(1, run.descentToolRecoveryAttempts);
    }

    @Test
    void subCommandIdsFollowDescentFieldKitSchemeKeyedOnAttempts() {
        DescentExecutor.DescentRun run = newRun("descend-42");

        assertEquals("descend-42:descent:fieldkit:retrieve_table:0", run.toolRetrieveTableCommandId());
        assertEquals("descend-42:descent:fieldkit:craft_table:0", run.toolCraftTableCommandId());
        assertEquals("descend-42:descent:fieldkit:place_table:0", run.toolPlaceTableCommandId());
        assertEquals("descend-42:descent:fieldkit:craft_stone_pickaxe:0", run.toolCraftPickaxeCommandId());
        assertEquals("descend-42:descent:fieldkit:craft_sticks:0", run.toolCraftSticksCommandId());

        run.descentToolRecoveryAttempts = 2;
        assertEquals("descend-42:descent:fieldkit:retrieve_table:2", run.toolRetrieveTableCommandId());
        assertEquals("descend-42:descent:fieldkit:craft_table:2", run.toolCraftTableCommandId());
        assertEquals("descend-42:descent:fieldkit:place_table:2", run.toolPlaceTableCommandId());
        assertEquals("descend-42:descent:fieldkit:craft_stone_pickaxe:2", run.toolCraftPickaxeCommandId());
        assertEquals("descend-42:descent:fieldkit:craft_sticks:2", run.toolCraftSticksCommandId());
    }

    @Test
    void subCommandIdsAreUniquePerActionForTheSameAttempt() {
        DescentExecutor.DescentRun run = newRun("descend-1");
        // The five ids must be distinct so concurrent sub-command ledgers never collide.
        assertEquals(5, java.util.Set.of(
            run.toolRetrieveTableCommandId(),
            run.toolCraftTableCommandId(),
            run.toolPlaceTableCommandId(),
            run.toolCraftPickaxeCommandId(),
            run.toolCraftSticksCommandId()
        ).size());
    }
}
