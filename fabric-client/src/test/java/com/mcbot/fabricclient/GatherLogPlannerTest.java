package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.OptionalInt;
import java.util.Set;
import org.junit.jupiter.api.Test;

class GatherLogPlannerTest {
    @Test
    void selectsReachableAdjacentCellForTargetLog() {
        KinematicSim perception = new KinematicSim(
            0.0D,
            0.0D,
            0.0D,
            0.2D,
            Set.of(new GridCell(1, 0)),
            -2,
            3,
            -2,
            2
        );

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseAdjacent(perception, new GridCell(0, 0), 1, 0);

        assertEquals("reachable_adjacent_cell", plan.reason());
        assertEquals(new GridCell(0, 0), plan.cell());
        assertFalse(plan.route().isEmpty());
    }

    @Test
    void reportsNoAdjacentPathWhenAllNeighborsAreBlocked() {
        KinematicSim perception = new KinematicSim(
            0.0D,
            0.0D,
            0.0D,
            0.2D,
            Set.of(new GridCell(2, 0), new GridCell(0, 0), new GridCell(1, 1), new GridCell(1, -1)),
            0,
            2,
            -1,
            1
        );

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseAdjacent(perception, new GridCell(0, 1), 1, 0);

        assertEquals("no_reachable_adjacent_cell", plan.reason());
        assertEquals(null, plan.cell());
    }

    @Test
    void skipsExcludedAdjacentCellsForOcclusionReposition() {
        KinematicSim perception = new KinematicSim(
            0.0D,
            0.0D,
            0.0D,
            0.2D,
            Set.of(new GridCell(1, 0)),
            -2,
            3,
            -2,
            2
        );

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseAdjacent(
            perception,
            new GridCell(0, 0),
            1,
            0,
            Set.of(new GridCell(0, 0))
        );

        assertEquals("reachable_adjacent_cell", plan.reason());
        assertEquals(new GridCell(1, 1), plan.cell());
    }

    @Test
    void fallsBackToNearestUnblockedAdjacentCellWhenRouteCannotBeProved() {
        GridPerception perception = new GridPerception() {
            @Override
            public boolean isBlocked(int x, int z) {
                return !inBounds(x, z) || (x == 2 && z == 0);
            }

            @Override
            public OptionalInt surfaceY(int x, int z) {
                return isBlocked(x, z) ? OptionalInt.empty() : OptionalInt.of(24);
            }

            @Override
            public TraversalIssue traversalIssue(GridCell from, GridCell to) {
                return from.equals(to) ? TraversalIssue.NONE : TraversalIssue.FROM_BLOCKED;
            }

            @Override
            public int minX() {
                return -2;
            }

            @Override
            public int maxX() {
                return 4;
            }

            @Override
            public int minZ() {
                return -2;
            }

            @Override
            public int maxZ() {
                return 2;
            }
        };

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseAdjacent(perception, new GridCell(0, 0), 2, 0);

        assertEquals("unrouted_unblocked_adjacent_cell", plan.reason());
        assertEquals(new GridCell(1, 0), plan.cell());
        assertEquals(List.of(new GridCell(1, 0)), plan.route());
    }

    @Test
    void usesLocalUnroutedFallbackForBreakCells() {
        GridPerception perception = new GridPerception() {
            @Override
            public boolean isBlocked(int x, int z) {
                return !inBounds(x, z) || x == 5 && z == 0;
            }

            @Override
            public OptionalInt surfaceY(int x, int z) {
                return isBlocked(x, z) ? OptionalInt.empty() : OptionalInt.of(64);
            }

            @Override
            public TraversalIssue traversalIssue(GridCell from, GridCell to) {
                return from.equals(to) ? TraversalIssue.NONE : TraversalIssue.FROM_BLOCKED;
            }

            @Override
            public int minX() {
                return 0;
            }

            @Override
            public int maxX() {
                return 6;
            }

            @Override
            public int minZ() {
                return -2;
            }

            @Override
            public int maxZ() {
                return 2;
            }
        };

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
            perception,
            new GridCell(0, 0),
            5,
            64,
            0,
            Set.of()
        );

        assertEquals("unrouted_unblocked_in_reach_cell", plan.reason());
        assertEquals(new GridCell(1, 0), plan.cell());
        assertEquals(List.of(new GridCell(1, 0)), plan.route());
    }

    @Test
    void rejectsUnroutedBreakCellWithLargeSurfaceDelta() {
        GridPerception perception = new GridPerception() {
            @Override
            public boolean isBlocked(int x, int z) {
                return !inBounds(x, z) || x == 5 && z == 0;
            }

            @Override
            public OptionalInt surfaceY(int x, int z) {
                if (isBlocked(x, z)) {
                    return OptionalInt.empty();
                }
                return OptionalInt.of(x == 0 && z == 0 ? 62 : 65);
            }

            @Override
            public int minX() {
                return 0;
            }

            @Override
            public int maxX() {
                return 6;
            }

            @Override
            public int minZ() {
                return -2;
            }

            @Override
            public int maxZ() {
                return 2;
            }
        };

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
            perception,
            new GridCell(0, 0),
            5,
            65,
            0,
            Set.of()
        );

        assertEquals("no_reachable_break_cell", plan.reason());
        assertEquals(null, plan.cell());
        assertEquals(List.of(), plan.route());
    }

    @Test
    void rejectsBreakCellRouteWithLargeDrop() {
        GridPerception perception = new GridPerception() {
            @Override
            public boolean isBlocked(int x, int z) {
                return !inBounds(x, z) || x == 5 && z == 0;
            }

            @Override
            public OptionalInt surfaceY(int x, int z) {
                if (isBlocked(x, z)) {
                    return OptionalInt.empty();
                }
                return OptionalInt.of(x == 0 && z == 0 ? 65 : 62);
            }

            @Override
            public int minX() {
                return 0;
            }

            @Override
            public int maxX() {
                return 6;
            }

            @Override
            public int minZ() {
                return -2;
            }

            @Override
            public int maxZ() {
                return 2;
            }
        };

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
            perception,
            new GridCell(0, 0),
            5,
            64,
            0,
            Set.of()
        );

        assertEquals("no_reachable_break_cell", plan.reason());
        assertEquals(null, plan.cell());
        assertEquals(List.of(), plan.route());
    }

    @Test
    void rejectsDistantUnroutedBreakCellWhenRouteCannotBeProved() {
        GridPerception perception = new GridPerception() {
            @Override
            public boolean isBlocked(int x, int z) {
                return !inBounds(x, z) || x == 8 && z == 0;
            }

            @Override
            public OptionalInt surfaceY(int x, int z) {
                return isBlocked(x, z) ? OptionalInt.empty() : OptionalInt.of(64);
            }

            @Override
            public TraversalIssue traversalIssue(GridCell from, GridCell to) {
                return from.equals(to) ? TraversalIssue.NONE : TraversalIssue.FROM_BLOCKED;
            }

            @Override
            public int minX() {
                return 0;
            }

            @Override
            public int maxX() {
                return 9;
            }

            @Override
            public int minZ() {
                return -2;
            }

            @Override
            public int maxZ() {
                return 2;
            }
        };

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
            perception,
            new GridCell(0, 0),
            8,
            64,
            0,
            Set.of()
        );

        assertEquals("no_reachable_break_cell", plan.reason());
        assertEquals(null, plan.cell());
        assertEquals(List.of(), plan.route());
    }

    @Test
    void selectsInReachBreakCellWhenAdjacentCellsAreBlocked() {
        Set<GridCell> blocked = Set.of(
            new GridCell(4, 0),
            new GridCell(2, 0),
            new GridCell(3, 1),
            new GridCell(3, -1),
            new GridCell(3, 0)
        );
        GridPerception perception = flatPerception(blocked, -1, 5, -2, 2, 64);

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
            perception,
            new GridCell(0, 0),
            3,
            64,
            0,
            Set.of()
        );

        assertEquals("reachable_in_reach_cell", plan.reason());
        assertEquals(new GridCell(0, 0), plan.cell());
        assertEquals(List.of(new GridCell(0, 0)), plan.route());
    }

    @Test
    void rejectsNonAdjacentBreakCellsOutsideHandReach() {
        Set<GridCell> blocked = Set.of(
            new GridCell(4, 0),
            new GridCell(2, 0),
            new GridCell(3, 1),
            new GridCell(3, -1),
            new GridCell(3, 0)
        );
        GridPerception perception = flatPerception(blocked, -1, 5, -2, 2, 64);

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
            perception,
            new GridCell(0, 0),
            3,
            72,
            0,
            Set.of()
        );

        assertEquals("no_reachable_break_cell", plan.reason());
        assertEquals(null, plan.cell());
        assertEquals(List.of(), plan.route());
    }

    @Test
    void avoidsStandingOnNeighboringLogAsBreakCell() {
        Set<GridCell> blocked = Set.of(new GridCell(3, 0));
        Map<GridCell, Integer> surfaces = Map.of(
            new GridCell(2, 0), 65,
            new GridCell(4, 0), 65,
            new GridCell(3, 1), 65,
            new GridCell(3, -1), 64
        );
        GridPerception perception = surfacePerception(blocked, surfaces, 0, 4, -1, 1, 64);

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
            perception,
            new GridCell(0, -1),
            3,
            64,
            0,
            Set.of()
        );

        assertEquals("reachable_adjacent_cell", plan.reason());
        assertEquals(new GridCell(3, -1), plan.cell());
    }

    @Test
    void doesNotUseTargetColumnAsBreakCell() {
        Set<GridCell> blocked = new HashSet<>();
        for (int x = -4; x <= 4; x++) {
            for (int z = -4; z <= 4; z++) {
                GridCell cell = new GridCell(x, z);
                if (!cell.equals(new GridCell(0, 0)) && !cell.equals(new GridCell(4, 4))) {
                    blocked.add(cell);
                }
            }
        }
        GridPerception perception = flatPerception(blocked, -4, 4, -4, 4, 64);

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
            perception,
            new GridCell(4, 4),
            0,
            64,
            0,
            Set.of()
        );

        assertEquals("no_reachable_break_cell", plan.reason());
        assertEquals(null, plan.cell());
    }

    @Test
    void canForceFallenTreeBreakCellOntoSideCorridor() {
        Set<GridCell> excludedTreeRow = new HashSet<>();
        for (int x = -13; x <= 0; x++) {
            excludedTreeRow.add(new GridCell(x, 12));
        }
        GridPerception perception = flatPerception(Set.of(), -14, 1, 10, 14, 24);

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
            perception,
            new GridCell(-3, 12),
            -10,
            24,
            12,
            excludedTreeRow
        );

        assertEquals("reachable_adjacent_cell", plan.reason());
        assertEquals(-10, plan.cell().x());
        assertFalse(plan.cell().z() == 12);
    }

    @Test
    void sideCorridorCanBreakFromControllerReachDistance() {
        Set<GridCell> excludedTreeRow = new HashSet<>();
        for (int x = -5; x <= 0; x++) {
            excludedTreeRow.add(new GridCell(x, 12));
        }
        Set<GridCell> blocked = new HashSet<>();
        for (int x = -5; x <= 0; x++) {
            for (int z = 10; z <= 13; z++) {
                GridCell cell = new GridCell(x, z);
                if (!cell.equals(new GridCell(-1, 10)) && !cell.equals(new GridCell(0, 11))) {
                    blocked.add(cell);
                }
            }
        }
        GridPerception perception = flatPerception(blocked, -5, 0, 10, 13, 24);

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
            perception,
            new GridCell(0, 11),
            -4,
            24,
            12,
            excludedTreeRow
        );

        assertEquals("reachable_in_reach_cell", plan.reason());
        assertEquals(new GridCell(0, 11), plan.cell());
    }

    @Test
    void excludedFallenTreeRowDoesNotUseUnroutedRowFallback() {
        Set<GridCell> excludedTreeRow = new HashSet<>();
        for (int x = -6; x <= 0; x++) {
            excludedTreeRow.add(new GridCell(x, 12));
        }
        Set<GridCell> blocked = new HashSet<>();
        for (int x = -6; x <= 0; x++) {
            for (int z = 11; z <= 13; z++) {
                if (z != 12) {
                    blocked.add(new GridCell(x, z));
                }
            }
        }
        GridPerception perception = flatPerception(
            blocked,
            -6,
            0,
            11,
            13,
            24
        );

        GatherLogPlanner.AdjacentPlan plan = GatherLogPlanner.chooseBreakCell(
            perception,
            new GridCell(0, 12),
            -4,
            24,
            12,
            excludedTreeRow
        );

        assertEquals("no_reachable_unexcluded_break_cell", plan.reason());
        assertEquals(null, plan.cell());
        assertEquals(List.of(), plan.route());
    }

    private static GridPerception flatPerception(Set<GridCell> blocked, int minX, int maxX, int minZ, int maxZ, int feetY) {
        return new GridPerception() {
            @Override
            public boolean isBlocked(int x, int z) {
                return !inBounds(x, z) || blocked.contains(new GridCell(x, z));
            }

            @Override
            public OptionalInt surfaceY(int x, int z) {
                return isBlocked(x, z) ? OptionalInt.empty() : OptionalInt.of(feetY);
            }

            @Override
            public TraversalIssue traversalIssue(GridCell from, GridCell to) {
                return isBlocked(from.x(), from.z())
                    ? TraversalIssue.FROM_BLOCKED
                    : (isBlocked(to.x(), to.z()) ? TraversalIssue.TO_BLOCKED : TraversalIssue.NONE);
            }

            @Override
            public int minX() {
                return minX;
            }

            @Override
            public int maxX() {
                return maxX;
            }

            @Override
            public int minZ() {
                return minZ;
            }

            @Override
            public int maxZ() {
                return maxZ;
            }
        };
    }

    private static GridPerception surfacePerception(
        Set<GridCell> blocked,
        Map<GridCell, Integer> surfaces,
        int minX,
        int maxX,
        int minZ,
        int maxZ,
        int defaultFeetY
    ) {
        return new GridPerception() {
            @Override
            public boolean isBlocked(int x, int z) {
                return !inBounds(x, z) || blocked.contains(new GridCell(x, z));
            }

            @Override
            public OptionalInt surfaceY(int x, int z) {
                if (isBlocked(x, z)) {
                    return OptionalInt.empty();
                }
                return OptionalInt.of(surfaces.getOrDefault(new GridCell(x, z), defaultFeetY));
            }

            @Override
            public TraversalIssue traversalIssue(GridCell from, GridCell to) {
                return isBlocked(from.x(), from.z())
                    ? TraversalIssue.FROM_BLOCKED
                    : (isBlocked(to.x(), to.z()) ? TraversalIssue.TO_BLOCKED : TraversalIssue.NONE);
            }

            @Override
            public int minX() {
                return minX;
            }

            @Override
            public int maxX() {
                return maxX;
            }

            @Override
            public int minZ() {
                return minZ;
            }

            @Override
            public int maxZ() {
                return maxZ;
            }
        };
    }
}
