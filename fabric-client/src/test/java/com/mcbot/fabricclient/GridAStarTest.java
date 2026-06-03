package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class GridAStarTest {
    @Test
    void findsShortestOpenPath() {
        List<GridCell> path = GridAStar.route(
            perception(Set.of(), 0, 5, 0, 5),
            new GridCell(0, 0),
            new GridCell(3, 0)
        );

        assertEquals(List.of(new GridCell(0, 0), new GridCell(1, 0), new GridCell(2, 0), new GridCell(3, 0)), path);
    }

    @Test
    void routesAroundWallThroughGap() {
        Set<GridCell> blocked = new HashSet<>();
        for (int z = 0; z <= 3; z++) {
            blocked.add(new GridCell(2, z));
        }

        List<GridCell> path = GridAStar.route(
            perception(blocked, 0, 4, 0, 4),
            new GridCell(0, 0),
            new GridCell(4, 0)
        );

        assertFalse(path.isEmpty());
        assertEquals(new GridCell(0, 0), path.getFirst());
        assertEquals(new GridCell(4, 0), path.getLast());
        assertTrue(path.contains(new GridCell(2, 4)), "path should use the wall gap at z=4");
        assertTrue(path.stream().noneMatch(blocked::contains), "path must not enter blocked cells");
    }

    @Test
    void returnsEmptyForUnreachableGoal() {
        Set<GridCell> blocked = Set.of(
            new GridCell(1, 0),
            new GridCell(0, 1),
            new GridCell(1, 2),
            new GridCell(2, 1)
        );

        List<GridCell> path = GridAStar.route(
            perception(blocked, 0, 2, 0, 2),
            new GridCell(0, 0),
            new GridCell(1, 1)
        );

        assertTrue(path.isEmpty());
    }

    @Test
    void startEqualsGoalIsTrivial() {
        List<GridCell> path = GridAStar.route(
            perception(Set.of(), -1, 1, -1, 1),
            new GridCell(0, 0),
            new GridCell(0, 0)
        );

        assertEquals(List.of(new GridCell(0, 0)), path);
    }

    private static GridPerception perception(Set<GridCell> blocked, int minX, int maxX, int minZ, int maxZ) {
        return new KinematicSim(0.0D, 0.0D, 0.0D, 0.2D, blocked, minX, maxX, minZ, maxZ);
    }
}
