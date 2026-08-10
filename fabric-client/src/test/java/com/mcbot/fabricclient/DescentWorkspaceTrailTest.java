package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class DescentWorkspaceTrailTest {
    @Test
    void descentRerouteCannotClearSupportBelowAnAlreadyReachedStance() {
        BlockPos priorReached = new BlockPos(300, 18, 358);
        BlockPos currentFeet = new BlockPos(300, 17, 359);
        List<BlockPos> reachedFeet = List.of(priorReached, currentFeet);

        StaircaseDescentPlanner.Step destructiveNorth = StaircaseDescentPlanner.stepFrom(
            currentFeet,
            StaircaseDescentPlanner.north(),
            20
        );
        assertEquals(priorReached.down(), destructiveNorth.upperClear());
        assertTrue(DescentExecutor.targetsReachedStanceSupport(
            reachedFeet,
            destructiveNorth.upperClear()
        ));
        assertTrue(DescentExecutor.stepTargetsReachedStanceSupport(
            reachedFeet,
            destructiveNorth
        ));

        StaircaseDescentPlanner.Step safeEast = StaircaseDescentPlanner.stepFrom(
            currentFeet,
            StaircaseDescentPlanner.east(),
            20
        );
        assertFalse(DescentExecutor.stepTargetsReachedStanceSupport(reachedFeet, safeEast));
        assertFalse(DescentExecutor.targetsReachedStanceSupport(List.of(), safeEast.upperClear()));
        assertFalse(DescentExecutor.targetsReachedStanceSupport(reachedFeet, null));
    }

    @Test
    void laterCommandCannotPlanThroughCanonicalSupportLease() {
        BlockPos leasedFeet = new BlockPos(-50, 53, -47);
        BlockPos recoveryFeet = new BlockPos(-51, 52, -47);
        BlockPos leasedSupport = leasedFeet.down();
        StaircaseDescentPlanner.Step destructiveEast = StaircaseDescentPlanner.stepFrom(
            recoveryFeet,
            StaircaseDescentPlanner.east(),
            1
        );

        assertEquals(leasedSupport, destructiveEast.upperClear());
        assertEquals(
            leasedSupport,
            DescentExecutor.firstCanonicalSupportConflict(
                destructiveEast,
                leasedSupport::equals
            )
        );
        assertEquals(
            null,
            DescentExecutor.firstCanonicalSupportConflict(
                StaircaseDescentPlanner.stepFrom(
                    recoveryFeet,
                    StaircaseDescentPlanner.north(),
                    1
                ),
                leasedSupport::equals
            )
        );
        assertTrue(McbotFabricClient.canonicalTrailContainsSupport(
            List.of(new VoxelCell(-50, 53, -47)),
            leasedSupport
        ));
        assertFalse(McbotFabricClient.canonicalTrailContainsSupport(
            List.of(new VoxelCell(-50, 53, -47)),
            leasedSupport.east()
        ));
    }

    @Test
    void supportPlacementAndWaterSealsCannotOccupyCanonicalFeetOrHeadCells() {
        BlockPos feet = new BlockPos(14, 22, -8);
        BlockPos head = feet.up();
        Set<BlockPos> leasedOccupancy = Set.of(feet, head);

        assertTrue(DescentExecutor.placementOccupiesCanonicalTrail(
            feet,
            leasedOccupancy::contains
        ), "normal filler may not occupy a canonical feet cell");
        assertTrue(DescentExecutor.placementOccupiesCanonicalTrail(
            head,
            leasedOccupancy::contains
        ), "a water-seal target may not occupy canonical headroom");
        assertFalse(DescentExecutor.placementOccupiesCanonicalTrail(
            feet.east(),
            leasedOccupancy::contains
        ));
        assertFalse(DescentExecutor.placementOccupiesCanonicalTrail(null, leasedOccupancy::contains));
    }

    @Test
    void pendingPlacementDemandMustMatchIntendedCellAndAvoidCanonicalTrail() {
        BlockPos intended = new BlockPos(4, 20, 4);
        BlockPos drifted = new BlockPos(5, 20, 4);
        Set<BlockPos> leased = Set.of(drifted);

        assertEquals(
            "canonical_trail_occupancy",
            DescentExecutor.placementDemandViolationReason(
                true, intended, drifted, leased::contains));
        assertEquals(
            "predicted_cell_mismatch",
            DescentExecutor.placementDemandViolationReason(
                true, intended, drifted, ignored -> false));
        assertEquals(
            "",
            DescentExecutor.placementDemandViolationReason(
                true, intended, intended, leased::contains));
        assertEquals(
            "",
            DescentExecutor.placementDemandViolationReason(
                false, intended, drifted, leased::contains));
    }

    @Test
    void workspaceCarveRejectsRequestedAndRedirectedCanonicalTrailCells() {
        BlockPos requested = new BlockPos(20, 15, 20);
        BlockPos leasedFeet = new BlockPos(19, 15, 20);
        BlockPos leasedSupport = leasedFeet.down();
        Set<BlockPos> supports = Set.of(leasedSupport);
        Set<BlockPos> occupancy = Set.of(leasedFeet, leasedFeet.up());

        assertEquals(
            leasedSupport,
            MiningWorkspaceController.firstCanonicalCarveConflict(
                leasedSupport,
                null,
                null,
                supports::contains,
                occupancy::contains
            )
        );
        assertEquals(
            leasedFeet,
            MiningWorkspaceController.firstCanonicalCarveConflict(
                requested,
                leasedFeet,
                null,
                supports::contains,
                occupancy::contains
            )
        );
        assertEquals(
            leasedSupport,
            MiningWorkspaceController.firstCanonicalCarveConflict(
                requested,
                leasedFeet,
                leasedSupport,
                supports::contains,
                occupancy::contains
            ),
            "the physical acted block is authoritative over the raycast hit"
        );
        assertEquals(
            null,
            MiningWorkspaceController.firstCanonicalCarveConflict(
                requested,
                requested,
                requested,
                supports::contains,
                occupancy::contains
            )
        );
    }

    @Test
    void ironCleanupCannotMineThroughARecordedTrailOccluder() {
        BlockPos ore = new BlockPos(31, 16, 30);
        BlockPos leasedFeet = new BlockPos(30, 16, 30);
        BlockPos leasedSupport = leasedFeet.down();
        Set<BlockPos> supports = Set.of(leasedSupport);
        Set<BlockPos> occupancy = Set.of(leasedFeet, leasedFeet.up());

        assertEquals(
            leasedSupport,
            DescentExecutor.firstCanonicalBreakInteractionConflict(
                leasedSupport,
                leasedSupport,
                supports::contains,
                occupancy::contains
            )
        );
        assertEquals(
            leasedFeet,
            DescentExecutor.firstCanonicalBreakInteractionConflict(
                leasedFeet,
                null,
                supports::contains,
                occupancy::contains
            )
        );
        assertEquals(
            null,
            DescentExecutor.firstCanonicalBreakInteractionConflict(
                ore,
                ore,
                supports::contains,
                occupancy::contains
            )
        );
    }

    @Test
    void verifiedCarveApproachExtendsTheMutableDescentTrailBeforeSitePlanning() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world =
            new SurfaceReturnTrailGapPlannerTest.TestWorld(-2, 5, 60, 68, -2, 2);
        world.floor(-2, 5, -2, 2, 63);
        List<BlockPos> descent = new ArrayList<>(List.of(new BlockPos(0, 64, 0)));

        assertTrue(MiningWorkspaceController.appendVerifiedTraversal(
            descent,
            world,
            new VoxelCell(1, 64, 0),
            true
        ));
        assertTrue(MiningWorkspaceController.appendVerifiedTraversal(
            descent,
            world,
            new VoxelCell(2, 64, 0),
            true
        ));
        assertEquals(
            List.of(
                new BlockPos(0, 64, 0),
                new BlockPos(1, 64, 0),
                new BlockPos(2, 64, 0)
            ),
            descent
        );

        // A post-carve plan may legitimately be a one-cell already-at-stance route. The physical
        // carve approach remains authoritative and must not disappear during the readiness merge.
        assertEquals(
            descent,
            DescentExecutor.mergeVerifiedWorkspaceRoute(
                descent,
                List.of(new VoxelCell(2, 64, 0))
            )
        );
    }

    @Test
    void workspaceTraversalObservationTruncatesLoopsAndIgnoresUnsafeTransients() {
        SurfaceReturnTrailGapPlannerTest.TestWorld world =
            new SurfaceReturnTrailGapPlannerTest.TestWorld(-2, 5, 60, 68, -2, 2);
        world.floor(-2, 5, -2, 2, 63);
        List<BlockPos> descent = new ArrayList<>(List.of(
            new BlockPos(0, 64, 0),
            new BlockPos(1, 64, 0),
            new BlockPos(2, 64, 0)
        ));

        assertTrue(MiningWorkspaceController.appendVerifiedTraversal(
            descent,
            world,
            new VoxelCell(1, 64, 0),
            true
        ));
        assertEquals(
            List.of(new BlockPos(0, 64, 0), new BlockPos(1, 64, 0)),
            descent
        );

        assertFalse(MiningWorkspaceController.appendVerifiedTraversal(
            descent,
            world,
            new VoxelCell(2, 64, 0),
            false
        ));
        world.water(2, 64, 0);
        assertFalse(MiningWorkspaceController.appendVerifiedTraversal(
            descent,
            world,
            new VoxelCell(2, 64, 0),
            true
        ));
        assertEquals(
            List.of(new BlockPos(0, 64, 0), new BlockPos(1, 64, 0)),
            descent
        );
    }

    @Test
    void verifiedWorkspaceRouteExtendsTerminalDescentTrail() {
        List<BlockPos> descent = List.of(
            new BlockPos(0, 66, 0),
            new BlockPos(1, 65, 0),
            new BlockPos(2, 64, 0)
        );
        List<VoxelCell> workspace = List.of(
            new VoxelCell(2, 64, 0),
            new VoxelCell(2, 64, 1),
            new VoxelCell(3, 64, 1)
        );

        assertEquals(
            List.of(
                new BlockPos(0, 66, 0),
                new BlockPos(1, 65, 0),
                new BlockPos(2, 64, 0),
                new BlockPos(2, 64, 1),
                new BlockPos(3, 64, 1)
            ),
            DescentExecutor.mergeVerifiedWorkspaceRoute(descent, workspace)
        );
    }

    @Test
    void workspaceRevisitTruncatesTheCanonicalLoopBeforeAppendingSuffix() {
        List<BlockPos> descent = List.of(
            new BlockPos(0, 66, 0),
            new BlockPos(1, 65, 0),
            new BlockPos(2, 64, 0),
            new BlockPos(3, 64, 0)
        );
        List<VoxelCell> workspace = List.of(
            new VoxelCell(3, 64, 0),
            new VoxelCell(2, 64, 0),
            new VoxelCell(2, 64, 1)
        );

        assertEquals(
            List.of(
                new BlockPos(0, 66, 0),
                new BlockPos(1, 65, 0),
                new BlockPos(2, 64, 0),
                new BlockPos(2, 64, 1)
            ),
            DescentExecutor.mergeVerifiedWorkspaceRoute(descent, workspace)
        );
    }

    @Test
    void disconnectedOrWrongStartWorkspaceRouteCannotInventTrailCells() {
        List<BlockPos> descent = new ArrayList<>(List.of(
            new BlockPos(0, 66, 0),
            new BlockPos(1, 65, 0)
        ));
        List<VoxelCell> wrongStart = List.of(
            new VoxelCell(3, 65, 0),
            new VoxelCell(4, 65, 0)
        );
        List<VoxelCell> nonReversible = List.of(
            new VoxelCell(1, 65, 0),
            new VoxelCell(2, 62, 0)
        );

        assertEquals(descent, DescentExecutor.mergeVerifiedWorkspaceRoute(descent, wrongStart));
        assertEquals(descent, DescentExecutor.mergeVerifiedWorkspaceRoute(descent, nonReversible));
        assertEquals(
            List.of(),
            DescentExecutor.mergeVerifiedWorkspaceRoute(List.of(), wrongStart)
        );
    }
}
