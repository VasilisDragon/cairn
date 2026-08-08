package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class IronExposureLanePlannerTest {
    private static final StaircaseDescentPlanner.Direction2d SOUTH =
        new StaircaseDescentPlanner.Direction2d(0, 1, "south");

    @Test
    void selectsExactTwelveCellStraightContinuationFirst() {
        TestPerception perception = TestPerception.openOrigin(new VoxelCell(0, 14, 0));
        perception.failOnLateralRead = true;
        IronExposureLanePlanner.Result result = IronExposureLanePlanner.plan(request(perception));

        assertTrue(result.selected());
        IronExposureLanePlanner.Plan plan = result.plan();
        assertTrue(plan.straightContinuation());
        assertEquals(SOUTH, plan.heading());
        assertTrue(plan.connector().isEmpty());
        assertEquals(12, plan.lane().size());
        assertEquals(new VoxelCell(0, 14, 12), plan.lane().getLast());
        assertEquals(24, plan.projectedBreaks());
        assertEquals(74, plan.freshShellCells());
        assertTrue(plan.freshShellPerBreak() >= 2.5D);
        assertEquals(1, result.consideredCandidates());
    }

    @Test
    void lateLaneIronBodyCellPreservesStraightContinuationAndFrozenHeading() {
        VoxelCell origin = new VoxelCell(0, 14, 0);
        VoxelCell lateLaneFeet = new VoxelCell(0, 14, 11);
        VoxelCell lateIron = new VoxelCell(0, 15, 11);
        TestPerception perception = TestPerception.openOrigin(origin);
        perception.ironOre.add(lateIron);
        perception.failOnLateralRead = true;

        IronExposureLanePlanner.Result result = IronExposureLanePlanner.plan(request(perception));

        assertTrue(result.selected());
        IronExposureLanePlanner.Plan plan = result.plan();
        assertTrue(plan.straightContinuation());
        assertEquals(SOUTH, plan.heading());
        assertTrue(plan.connector().isEmpty());
        assertEquals(lateLaneFeet, plan.lane().get(10));
        assertTrue(perception.prospectableReads.contains(lateIron),
            "the late ore must be admitted as the frozen lane's prospectable head block");
        assertEquals(24, plan.projectedBreaks());
        assertTrue(plan.completeRoute().stream().allMatch(cell -> cell.x() == origin.x()));
    }

    @Test
    void visibleIronAndConnectedVeinsAlwaysPreemptLanePlanning() {
        TestPerception perception = TestPerception.openOrigin(new VoxelCell(0, 14, 0));
        IronExposureLanePlanner.Request visible = new IronExposureLanePlanner.Request(
            new VoxelCell(0, 14, 0), SOUTH, perception, Set.of(), Set.of(), Set.of(), true, false, false);
        IronExposureLanePlanner.Request vein = new IronExposureLanePlanner.Request(
            new VoxelCell(0, 14, 0), SOUTH, perception, Set.of(), Set.of(), Set.of(), false, true, false);

        assertEquals(IronExposureLanePlanner.Action.DEFER_VISIBLE_IRON,
            IronExposureLanePlanner.plan(visible).action());
        assertEquals(IronExposureLanePlanner.Action.DEFER_CONNECTED_VEIN,
            IronExposureLanePlanner.plan(vein).action());
    }

    @Test
    void admitsOnlyTheProductiveFeetBandAndASafeOrigin() {
        TestPerception y12 = TestPerception.openOrigin(new VoxelCell(0, 12, 0));
        IronExposureLanePlanner.Result outside = IronExposureLanePlanner.plan(new IronExposureLanePlanner.Request(
            new VoxelCell(0, 12, 0), SOUTH, y12, Set.of(), Set.of(), Set.of()));
        assertEquals("outside_productive_band", outside.reason());

        TestPerception unsafe = TestPerception.openOrigin(new VoxelCell(0, 14, 0));
        unsafe.unstableFeet.add(new VoxelCell(0, 14, 0));
        IronExposureLanePlanner.Result rejected = IronExposureLanePlanner.plan(request(unsafe));
        assertEquals("origin_unsafe", rejected.reason());
    }

    @Test
    void completedStraightLaneSelectsDeterministicSpacingThreeUTurn() {
        TestPerception perception = TestPerception.openOrigin(new VoxelCell(0, 14, 0));
        IronProspectAtlas.LaneSignature straight = new IronProspectAtlas.LaneSignature(14, 0, 0, 0, 1, 12);
        IronExposureLanePlanner.Request request = new IronExposureLanePlanner.Request(
            new VoxelCell(0, 14, 0), SOUTH, perception, Set.of(), Set.of(straight), Set.of());

        IronExposureLanePlanner.Plan plan = IronExposureLanePlanner.plan(request).plan();
        assertFalse(plan.straightContinuation());
        assertEquals(3, plan.connector().size());
        assertEquals(new VoxelCell(-3, 14, 0), plan.laneOrigin());
        assertEquals("north", plan.heading().name());
        assertEquals(new VoxelCell(-3, 14, -12), plan.lane().getLast());
    }

    @Test
    void shiftedStraightLaneCannotReuseCompletedStancesExceptCurrentSource() {
        VoxelCell source = new VoxelCell(0, 14, 1);
        TestPerception perception = TestPerception.openOrigin(source);
        IronProspectAtlas.LaneSignature completed =
            new IronProspectAtlas.LaneSignature(14, 0, 0, 0, 1, 12);
        IronExposureLanePlanner.Request request = new IronExposureLanePlanner.Request(
            source, SOUTH, perception, Set.of(), Set.of(completed), Set.of());

        IronExposureLanePlanner.Plan selected = IronExposureLanePlanner.plan(request).plan();
        assertFalse(selected.straightContinuation());
        Set<VoxelCell> prior = new HashSet<>(completed.stanceFootprint());
        prior.remove(source);
        assertTrue(selected.completeRoute().stream().noneMatch(prior::contains));
    }

    @Test
    void canonicalConnectorCannotBeReusedInReverse() {
        VoxelCell source = new VoxelCell(3, 14, 0);
        TestPerception perception = TestPerception.openOrigin(source);
        Set<IronProspectAtlas.LaneSignature> completedLanes = Set.of(
            new IronProspectAtlas.LaneSignature(14, 3, 0, 0, 1, 12),
            new IronProspectAtlas.LaneSignature(14, 6, 0, 0, -1, 12)
        );
        IronProspectAtlas.ConnectorSignature usedForward =
            new IronProspectAtlas.ConnectorSignature(14, 0, 0, 3, 0);
        IronExposureLanePlanner.Request request = new IronExposureLanePlanner.Request(
            source, SOUTH, perception, Set.of(), completedLanes, Set.of(usedForward));

        IronExposureLanePlanner.Result result = IronExposureLanePlanner.plan(request);
        assertEquals(IronExposureLanePlanner.Action.REJECT, result.action());
        assertEquals("plane_exhausted", result.reason());
    }

    @Test
    void exactPriorExposureRejectsStraightAndSelectsFreshLateralLane() {
        TestPerception perception = TestPerception.openOrigin(new VoxelCell(0, 14, 0));
        Set<IronProspectAtlas.InspectedCell> straightShell =
            IronProspectAtlas.exposureShellForLane(new VoxelCell(0, 14, 0), SOUTH, 12);
        IronExposureLanePlanner.Request request = new IronExposureLanePlanner.Request(
            new VoxelCell(0, 14, 0), SOUTH, perception, straightShell, Set.of(), Set.of());

        IronExposureLanePlanner.Plan selected = IronExposureLanePlanner.plan(request).plan();
        assertFalse(selected.straightContinuation());
        assertTrue(selected.freshShellCells() >= IronExposureLanePlanner.MIN_FRESH_SHELL_CELLS);
    }

    @Test
    void exposureRatioBoundaryIsExact() {
        TestPerception perception = TestPerception.openOrigin(new VoxelCell(0, 14, 0));
        List<IronProspectAtlas.InspectedCell> shell = new ArrayList<>(
            IronProspectAtlas.exposureShellForLane(new VoxelCell(0, 14, 0), SOUTH, 12));
        Set<IronProspectAtlas.LaneSignature> lateralLanes = Set.of(
            new IronProspectAtlas.LaneSignature(14, -3, 0, 0, -1, 12),
            new IronProspectAtlas.LaneSignature(14, 3, 0, 0, -1, 12)
        );

        Set<IronProspectAtlas.InspectedCell> fourteenOverlap = new HashSet<>(shell.subList(0, 14));
        IronExposureLanePlanner.Result exact = IronExposureLanePlanner.plan(new IronExposureLanePlanner.Request(
            new VoxelCell(0, 14, 0), SOUTH, perception, fourteenOverlap, lateralLanes, Set.of()));
        assertTrue(exact.selected());
        assertEquals(60, exact.plan().freshShellCells());
        assertEquals(2.5D, exact.plan().freshShellPerBreak(), 0.000_001D);

        Set<IronProspectAtlas.InspectedCell> fifteenOverlap = new HashSet<>(shell.subList(0, 15));
        IronExposureLanePlanner.Result below = IronExposureLanePlanner.plan(new IronExposureLanePlanner.Request(
            new VoxelCell(0, 14, 0), SOUTH, perception, fifteenOverlap, lateralLanes, Set.of()));
        assertEquals(IronExposureLanePlanner.Action.REJECT, below.action());
        assertEquals("plane_exhausted", below.reason());
    }

    @Test
    void liquidsHazardsLavaUnstableSupportAndExcludedCellsFailClosed() {
        for (UnsafeKind kind : UnsafeKind.values()) {
            TestPerception perception = TestPerception.openOrigin(new VoxelCell(0, 14, 0));
            // Block the first cell in all three bounded candidate transitions.
            for (VoxelCell feet : List.of(
                new VoxelCell(0, 14, 1),
                new VoxelCell(-1, 14, 0),
                new VoxelCell(1, 14, 0)
            )) {
                kind.apply(perception, feet);
            }
            IronExposureLanePlanner.Result result = IronExposureLanePlanner.plan(request(perception));
            assertEquals(IronExposureLanePlanner.Action.REJECT, result.action(), kind.name());
            assertEquals("plane_exhausted", result.reason(), kind.name());
            assertNull(result.plan(), kind.name());
        }
    }

    @Test
    void atlasSaturationAndCompletedSignaturesFailClosed() {
        TestPerception perception = TestPerception.openOrigin(new VoxelCell(0, 14, 0));
        IronExposureLanePlanner.Request saturated = new IronExposureLanePlanner.Request(
            new VoxelCell(0, 14, 0), SOUTH, perception, Set.of(), Set.of(), Set.of(), false, false, true);
        assertEquals("atlas_saturated", IronExposureLanePlanner.plan(saturated).reason());

        Set<IronProspectAtlas.LaneSignature> allLanes = Set.of(
            new IronProspectAtlas.LaneSignature(14, 0, 0, 0, 1, 12),
            new IronProspectAtlas.LaneSignature(14, -3, 0, 0, -1, 12),
            new IronProspectAtlas.LaneSignature(14, 3, 0, 0, -1, 12)
        );
        IronExposureLanePlanner.Request exhausted = new IronExposureLanePlanner.Request(
            new VoxelCell(0, 14, 0), SOUTH, perception, Set.of(), allLanes, Set.of());
        assertEquals("plane_exhausted", IronExposureLanePlanner.plan(exhausted).reason());
    }

    private static IronExposureLanePlanner.Request request(TestPerception perception) {
        return new IronExposureLanePlanner.Request(
            new VoxelCell(0, 14, 0), SOUTH, perception, Set.of(), Set.of(), Set.of());
    }

    private enum UnsafeKind {
        LIQUID {
            @Override void apply(TestPerception perception, VoxelCell feet) {
                perception.liquids.add(feet);
            }
        },
        HAZARD {
            @Override void apply(TestPerception perception, VoxelCell feet) {
                perception.hazards.add(feet);
            }
        },
        ADJACENT_LAVA {
            @Override void apply(TestPerception perception, VoxelCell feet) {
                perception.lavaAdjacentFeet.add(feet);
            }
        },
        UNSTABLE_SUPPORT {
            @Override void apply(TestPerception perception, VoxelCell feet) {
                perception.unstableFeet.add(feet);
            }
        },
        EXCLUDED {
            @Override void apply(TestPerception perception, VoxelCell feet) {
                perception.excluded.add(feet);
            }
        },
        BLOCKED_BODY {
            @Override void apply(TestPerception perception, VoxelCell feet) {
                perception.blocked.add(feet);
            }
        };

        abstract void apply(TestPerception perception, VoxelCell feet);
    }

    private static final class TestPerception implements IronExposureLanePlanner.Perception {
        private final Set<VoxelCell> clear = new HashSet<>();
        private final Set<VoxelCell> blocked = new HashSet<>();
        private final Set<VoxelCell> unstableFeet = new HashSet<>();
        private final Set<VoxelCell> liquids = new HashSet<>();
        private final Set<VoxelCell> hazards = new HashSet<>();
        private final Set<VoxelCell> lavaAdjacentFeet = new HashSet<>();
        private final Set<VoxelCell> excluded = new HashSet<>();
        private final Set<VoxelCell> ironOre = new HashSet<>();
        private final Set<VoxelCell> prospectableReads = new HashSet<>();
        private boolean failOnLateralRead = false;

        static TestPerception openOrigin(VoxelCell origin) {
            TestPerception perception = new TestPerception();
            perception.clear.add(origin);
            perception.clear.add(new VoxelCell(origin.x(), origin.y() + 1, origin.z()));
            return perception;
        }

        @Override
        public boolean isClear(VoxelCell block) {
            guard(block);
            return clear.contains(block);
        }

        @Override
        public boolean isProspectable(VoxelCell block) {
            guard(block);
            prospectableReads.add(block);
            if (ironOre.contains(block)) {
                return true;
            }
            return !clear.contains(block)
                && !blocked.contains(block)
                && !liquids.contains(block)
                && !hazards.contains(block)
                && !excluded.contains(block);
        }

        @Override
        public boolean isStableSupport(VoxelCell feet) {
            guard(feet);
            return !unstableFeet.contains(feet);
        }

        @Override
        public boolean isLiquid(VoxelCell block) {
            guard(block);
            return liquids.contains(block);
        }

        @Override
        public boolean isHazard(VoxelCell block) {
            guard(block);
            return hazards.contains(block);
        }

        @Override
        public boolean isAdjacentLava(VoxelCell feet) {
            guard(feet);
            return lavaAdjacentFeet.contains(feet);
        }

        @Override
        public boolean isExcluded(VoxelCell block) {
            guard(block);
            return excluded.contains(block);
        }

        private void guard(VoxelCell cell) {
            if (failOnLateralRead && cell.x() != 0) {
                throw new AssertionError("productive straight lane evaluated lateral geometry: " + cell);
            }
        }
    }
}
