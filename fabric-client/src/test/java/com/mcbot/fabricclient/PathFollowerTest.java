package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class PathFollowerTest {
    private static final double EPSILON = 0.25D;
    private static final double TURN = 30.0D;
    private static final double SPEED = 0.2D;

    @Test
    void advancesPastReachedStartingWaypointAndMovesTowardNext() {
        List<GridCell> path = List.of(new GridCell(0, 0), new GridCell(1, 0));

        PathFollower.Command command =
            PathFollower.follow(path, 0, 0.5D, 0.5D, -90.0D, EPSILON, TURN);

        assertEquals(1, command.waypointIndex());
        assertFalse(command.finished());
        assertEquals("navigate_forward", command.intent().action());
        assertTrue(command.input().pressingForward());
        assertEquals(-90.0D, command.look().yaw(), 0.000_001D);
    }

    @Test
    void facingAwayTurnsFirstWithoutForwardInput() {
        List<GridCell> path = List.of(new GridCell(0, 0), new GridCell(1, 0));

        PathFollower.Command command =
            PathFollower.follow(path, 0, 0.5D, 0.5D, 90.0D, EPSILON, TURN);

        assertEquals(1, command.waypointIndex());
        assertEquals("turn_toward", command.intent().action());
        assertFalse(command.input().pressingForward());
        assertEquals(60.0D, command.look().yaw(), 0.000_001D);
    }

    @Test
    void finishesAtGoalAndReleasesInput() {
        List<GridCell> path = List.of(new GridCell(0, 0), new GridCell(1, 0));

        PathFollower.Command command =
            PathFollower.follow(path, 1, 1.5D, 0.5D, -90.0D, EPSILON, TURN);

        assertTrue(command.finished());
        assertEquals(2, command.waypointIndex());
        assertEquals("stop", command.intent().action());
        assertEquals("path_complete", command.intent().reason());
        assertEquals(InputState.stop(), command.input());
    }

    @Test
    void advancesWhenParkedOnWaypointBoundaryWithFloatingError() {
        List<GridCell> path = List.of(new GridCell(27, 185), new GridCell(27, 184), new GridCell(28, 184));

        PathFollower.Progress progress = PathFollower.Progress.initial();
        PathFollower.Command command = null;
        int index = 1;
        for (int tick = 0; tick < 10; tick++) {
            command = PathFollower.follow(
                path,
                index,
                progress,
                27.502298241409385D,
                185.30000001192093D,
                179.8354D,
                0.8D,
                TURN
            );
            index = command.waypointIndex();
            progress = command.progress();
        }

        assertEquals(2, command == null ? -1 : command.waypointIndex());
        assertFalse(command.finished());
    }

    @Test
    void doesNotAdvanceBoundaryBeforeStallThreshold() {
        List<GridCell> path = List.of(new GridCell(27, 185), new GridCell(27, 184), new GridCell(28, 184));

        PathFollower.Command command =
            PathFollower.follow(path, 1, PathFollower.Progress.initial(), 27.502298241409385D, 185.30000001192093D, 179.8354D, 0.8D, TURN);
        assertEquals(1, command.waypointIndex());
        assertFalse(command.finished());
    }

    @Test
    void doesNotFinishFinalWaypointFromBoundaryTolerance() {
        List<GridCell> path = List.of(new GridCell(-270, 32), new GridCell(-271, 32));

        PathFollower.Progress progress = PathFollower.Progress.initial();
        PathFollower.Command command = null;
        int index = 1;
        for (int tick = 0; tick < 12; tick++) {
            command = PathFollower.follow(path, index, progress, -269.69999998807907D, 32.59530672864443D, 63.046745D, 0.8D, TURN);
            index = command.waypointIndex();
            progress = command.progress();
        }

        assertEquals(1, command == null ? -1 : command.waypointIndex());
        assertFalse(command.finished());
    }

    @Test
    void advancesAfterPassingWaypointWithoutWideningNormalCornerAcceptance() {
        List<GridCell> path = List.of(new GridCell(0, 0), new GridCell(1, 0), new GridCell(2, 0));

        PathFollower.Command passed =
            PathFollower.follow(path, 1, 1.82D, 0.5D, -90.0D, EPSILON, TURN);
        assertEquals(2, passed.waypointIndex());

        PathFollower.Command offCorridor =
            PathFollower.follow(path, 1, 1.5D, 1.3005D, 0.0D, 0.8D, TURN);
        assertEquals(1, offCorridor.waypointIndex());
    }

    @Test
    void followsRoutedWaypointsAroundWallInSim() {
        Set<GridCell> blocked = new HashSet<>();
        for (int z = 0; z <= 3; z++) {
            blocked.add(new GridCell(2, z));
        }
        KinematicSim sim = new KinematicSim(0.5D, 0.5D, 0.0D, SPEED, blocked, 0, 4, 0, 4);
        List<GridCell> path = GridAStar.route(sim, new GridCell(0, 0), new GridCell(4, 0));

        int index = 0;
        PathFollower.Command command = null;
        for (int tick = 0; tick < 500; tick++) {
            command = PathFollower.follow(path, index, sim.x(), sim.z(), sim.yaw(), EPSILON, TURN);
            index = command.waypointIndex();
            if (command.finished()) {
                break;
            }
            sim.step(command.input(), command.look());
            assertFalse(blocked.contains(new GridCell(KinematicSim.cell(sim.x()), KinematicSim.cell(sim.z()))));
        }

        assertTrue(command != null && command.finished(), "should finish path; index=" + index);
        assertEquals(4.5D, sim.x(), 0.35D);
        assertEquals(0.5D, sim.z(), 0.35D);
    }
}
