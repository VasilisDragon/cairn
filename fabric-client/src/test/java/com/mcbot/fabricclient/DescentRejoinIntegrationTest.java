package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.*;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class DescentRejoinIntegrationTest {
    private static BrainLink.Intent intent(String action, String command) {
        return new BrainLink.Intent(action, false, false, false, false, false, false,
            null, null, null, null, List.of(), List.of(), null, List.of(), 45000, "mission:DESCEND", command);
    }
    private static DescentExecutor.DescentRun install(DescentExecutor executor) throws Exception {
        var run = new DescentExecutor.DescentRun("held", new BlockPos(0, 64, 0), StaircaseDescentPlanner.north(), 6, 1000, 20);
        run.depthReached = 4;
        run.stepIndex = 5;
        run.reroutes = 2;
        run.rejoinCommandDeadlineMs = 45000;
        Field active = DescentExecutor.class.getDeclaredField("activeRun");
        active.setAccessible(true);
        active.set(executor, run);
        return run;
    }
    @Test void reflexObserverPreservesIdentityProgressDeadlinesAndRecoveryBudgets() throws Exception {
        var executor = new DescentExecutor(null);
        var run = install(executor);
        for (int i = 0; i < 20; i++) executor.preemptForReflex(intent("descend_staircase", "held"), i % 2 == 0 ? "combat" : "survival");
        assertTrue(run.rejoinPreempted);
        assertEquals("held", run.commandId);
        assertEquals(4, run.depthReached);
        assertEquals(5, run.stepIndex);
        assertEquals(2, run.reroutes);
        assertEquals(1000, run.startedAtMs);
        assertEquals(45000, run.rejoinCommandDeadlineMs);
        assertFalse(run.rejoinTraversal.active());
        assertTrue(run.rejoinRoute.isEmpty());
    }
    @Test void unrelatedOrMissingCommandProvenanceDoesNotArmRejoin() throws Exception {
        var executor = new DescentExecutor(null);
        var run = install(executor);
        executor.preemptForReflex(null, "combat");
        executor.preemptForReflex(intent("descend_staircase", "other"), "combat");
        executor.preemptForReflex(intent("mine_nearby_stone", "held"), "combat");
        assertFalse(run.rejoinPreempted);
    }
    @Test void interruptionOfActiveTraversalDoesNotRestartItsDeadlineOrCursor() throws Exception {
        var executor = new DescentExecutor(null);
        var run = install(executor);
        run.rejoinRoute = List.of(new VoxelCell(0, 64, 0), new VoxelCell(1, 63, 0));
        assertTrue(run.rejoinTraversal.begin(MiningWorkspaceTraversalController.Mode.RESUME, run.rejoinRoute, run.rejoinRoute.getFirst(), 1500));
        run.rejoinDeadlineMs = 21500;
        run.rejoinStartedAtMs = 1500;
        int cursor = run.rejoinTraversal.waypointIndex();
        executor.preemptForReflex(intent("descend_staircase", "held"), "combat");
        assertEquals(21500, run.rejoinDeadlineMs);
        assertEquals(1500, run.rejoinStartedAtMs);
        assertEquals(cursor, run.rejoinTraversal.waypointIndex());
    }
    @Test void rejoinUsesExistingTraversalWithoutConstructiveWorkOrInputWrites() throws Exception {
        String source = Files.readString(Path.of("src/main/java/com/mcbot/fabricclient/DescentExecutor.java"));
        String block = source.substring(source.indexOf("private ControlDecision resolveDescentRejoin("), source.indexOf("private static VoxelCell rejoinCell("));
        for (String forbidden : List.of("setPressed(", "setVelocity(", "setBlockState(", "clickSlot(", "breakDescentBlock(", "placeBlock(", "depthReached =", "reroutes =")) assertFalse(block.contains(forbidden), forbidden);
        assertTrue(block.contains("rejoinTraversal.tick("));
        assertTrue(block.contains("player.getBoundingBox()"));
        assertTrue(block.contains("new DescentRejoinPolicy.Footprint("));
        assertTrue(block.contains("nowMs >= run.rejoinCommandDeadlineMs"));
        assertTrue(block.contains("nowMs >= run.rejoinDeadlineMs"));
        assertTrue(block.contains("DescentRejoinPolicy.sameTrail("));
        assertTrue(block.contains("DescentRejoinPolicy.validRoute("));
        assertTrue(block.contains("run.stage = DescentControlPlanner.Stage.BREAK_SIGHT"));
    }
    @Test void shellReflexesNotifyBeforeControlReturnsAndRouteViewIsReadOnly() throws Exception {
        String source = Files.readString(Path.of("src/main/java/com/mcbot/fabricclient/McbotFabricClient.java"));
        assertTrue(source.contains("descentExecutor.preemptForReflex(effective, \"combat\")"));
        assertTrue(source.contains("descentExecutor.preemptForReflex(effective, \"survival\")"));
        String trail = source.substring(source.indexOf("public DescentRejoinPolicy.Trail descentRejoinTrail()"), source.indexOf("static boolean canonicalTrailContainsSupport("));
        assertFalse(trail.contains("restoreVerifiedPrefix"));
        assertFalse(trail.contains("appendObserved"));
        assertTrue(trail.contains("List.copyOf(surfaceReturnTrailStore.trail())"));
    }
}
