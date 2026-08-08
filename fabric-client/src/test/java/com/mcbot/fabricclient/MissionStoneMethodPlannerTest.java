package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

final class MissionStoneMethodPlannerTest {
    @Test
    void commandFaceBudgetBoundsLaterPlansAndLeavesStaircaseAvailable() {
        MissionStoneMethodPlanner.FaceCandidate face = face("face", line(11), 0, 0);
        MissionStoneMethodPlanner.Request threeRemaining = new MissionStoneMethodPlanner.Request(
            0,
            11,
            0,
            false,
            true,
            null,
            face,
            null,
            timing(),
            3
        );

        MissionStoneMethodPlanner.Plan boundedFace =
            MissionStoneMethodPlanner.plan(threeRemaining).plan();
        assertNotNull(boundedFace);
        assertEquals(MissionStoneMethodPlanner.Method.REACHABLE_FACE, boundedFace.method());
        assertEquals(3, boundedFace.plannedBreaks());
        assertEquals(3, boundedFace.plannedFaceBlocks().size());

        MissionStoneMethodPlanner.Request exhausted = new MissionStoneMethodPlanner.Request(
            0,
            11,
            0,
            false,
            true,
            null,
            face,
            staircase("stairs", false, false, false, false),
            timing(),
            0
        );
        MissionStoneMethodPlanner.Decision continuation =
            MissionStoneMethodPlanner.plan(exhausted);

        assertNotNull(continuation.plan());
        assertEquals(MissionStoneMethodPlanner.Method.STAIRCASE, continuation.plan().method());
        assertEquals(
            "face_command_cap_exhausted",
            evaluation(continuation, MissionStoneMethodPlanner.Method.REACHABLE_FACE).reason()
        );
    }

    @Test
    void exhaustedFaceBudgetCannotOverrideAuthoritativeInventoryCompletion() {
        MissionStoneMethodPlanner.Request satisfied = new MissionStoneMethodPlanner.Request(
            11,
            11,
            0,
            false,
            true,
            null,
            face("face", line(11), 0, 0),
            staircase("stairs", false, false, false, false),
            timing(),
            0
        );

        MissionStoneMethodPlanner.Decision decision = MissionStoneMethodPlanner.plan(satisfied);
        assertNull(decision.plan());
        assertEquals("inventory_requirement_satisfied", decision.reason());
    }

    @Test
    void boundedCandidateSelectionIsOrderIndependentAndUsesGlobalCostRanking() {
        MissionStoneMethodPlanner.Request westBlocked = request(
            0,
            8,
            null,
            staircaseWithMaterial("staircase:west", MissionStoneMethodPlanner.BreakMaterial.UNKNOWN),
            null
        );
        MissionStoneMethodPlanner.Request eastSafe = request(
            0,
            8,
            null,
            staircase("staircase:east", false, false, false, false),
            null
        );
        MissionStoneMethodPlanner.Request nearbyFace = request(
            0,
            8,
            face("face", line(2), 0, 0),
            null,
            null
        );

        MissionStoneMethodPlanner.Decision forward = MissionStoneMethodPlanner.planCandidates(
            List.of(westBlocked, eastSafe, nearbyFace));
        MissionStoneMethodPlanner.Decision reversed = MissionStoneMethodPlanner.planCandidates(
            List.of(nearbyFace, eastSafe, westBlocked));

        assertNotNull(forward.plan());
        assertEquals("staircase:east", forward.plan().identity());
        assertEquals(forward.plan(), reversed.plan());
        assertEquals(9, forward.evaluations().size());
        assertTrue(forward.evaluations().stream().anyMatch(evaluation ->
            "staircase:west".equals(evaluation.identity())
                && "unknown_clearance_forbidden".equals(evaluation.reason())));
    }

    @Test
    void boundedCandidateSelectionDoesNotInventAPlanFromRejectedPackages() {
        MissionStoneMethodPlanner.Request blockedNorth = request(
            0,
            8,
            null,
            staircaseWithMaterial("staircase:north", MissionStoneMethodPlanner.BreakMaterial.UNKNOWN),
            null
        );
        MissionStoneMethodPlanner.Request blockedSouth = request(
            0,
            8,
            null,
            staircaseWithMaterial("staircase:south", MissionStoneMethodPlanner.BreakMaterial.FLUID),
            null
        );

        MissionStoneMethodPlanner.Decision decision = MissionStoneMethodPlanner.planCandidates(
            List.of(blockedNorth, blockedSouth));

        assertNull(decision.plan());
        assertEquals("no_safe_method", decision.reason());
        assertEquals(6, decision.evaluations().size());
    }

    @Test
    void missionStoneHeadingOrderCoversEveryCardinalOnceAndPricesTheCurrentView() {
        List<StaircaseDescentPlanner.Direction2d> headings =
            McbotFabricClient.missionStoneCandidateHeadings(StaircaseDescentPlanner.west());

        assertEquals(List.of("west", "north", "south", "east"), headings.stream()
            .map(StaircaseDescentPlanner.Direction2d::name)
            .toList());
        assertEquals(4, headings.stream().distinct().count());
        assertEquals(0L, McbotFabricClient.missionStoneHeadingTurnCostMs(
            90.0F, StaircaseDescentPlanner.west()));
        assertEquals(375L, McbotFabricClient.missionStoneHeadingTurnCostMs(
            0.0F, StaircaseDescentPlanner.east()));
        assertEquals(750L, McbotFabricClient.missionStoneHeadingTurnCostMs(
            0.0F, StaircaseDescentPlanner.north()));
    }

    @Test
    void authoritativeInventoryIsTheOnlyCompletionSignal() {
        MissionStoneMethodPlanner.Request unsatisfied = request(
            7,
            8,
            face("face", line(8), 0, 0),
            staircase("stairs", false, false, false, false),
            null
        );
        MissionStoneMethodPlanner.Decision planned = MissionStoneMethodPlanner.plan(unsatisfied);

        assertFalse(MissionStoneMethodPlanner.inventoryRequirementSatisfied(unsatisfied));
        assertNotNull(planned.plan(), "a predicted eight-block harvest must remain a plan, not completion");
        assertEquals(1, planned.plan().authoritativeDeficit());
        assertEquals(1, planned.plan().predictedCobblestone());
        assertEquals(1, planned.plan().plannedBreaks());

        MissionStoneMethodPlanner.Request satisfied = request(8, 8, null, null, null);
        assertTrue(MissionStoneMethodPlanner.inventoryRequirementSatisfied(satisfied));
        assertNull(MissionStoneMethodPlanner.plan(satisfied).plan());
        assertEquals("inventory_requirement_satisfied", MissionStoneMethodPlanner.plan(satisfied).reason());
    }

    @Test
    void verifiedPendingProductionShrinksTheNextExactPrefixWithoutCompletingInventory() {
        MissionStoneMethodPlanner.Request request = new MissionStoneMethodPlanner.Request(
            0,
            8,
            2,
            false,
            false,
            null,
            face("six_remaining", line(8), 0, 0),
            null,
            timing()
        );

        MissionStoneMethodPlanner.Decision decision = MissionStoneMethodPlanner.plan(request);

        assertFalse(MissionStoneMethodPlanner.inventoryRequirementSatisfied(request));
        assertNotNull(decision.plan());
        assertEquals(8, decision.plan().authoritativeDeficit());
        assertEquals(6, decision.plan().predictedCobblestone());
        assertEquals(6, decision.plan().plannedBreaks());

        MissionStoneMethodPlanner.Request covered = new MissionStoneMethodPlanner.Request(
            6,
            8,
            2,
            false,
            false,
            null,
            face("unused", line(8), 0, 0),
            null,
            timing()
        );
        assertFalse(MissionStoneMethodPlanner.inventoryRequirementSatisfied(covered));
        assertNull(MissionStoneMethodPlanner.plan(covered).plan());
        assertEquals("verified_production_covers_deficit", MissionStoneMethodPlanner.plan(covered).reason());
    }

    @Test
    void aReachableFaceWinsForOneImmediateBlock() {
        MissionStoneMethodPlanner.Decision decision = MissionStoneMethodPlanner.plan(request(
            7,
            8,
            face("near_face", line(8), 0, 0),
            staircase("shaft", false, false, false, false),
            null
        ));

        assertEquals(MissionStoneMethodPlanner.Method.REACHABLE_FACE, decision.plan().method());
        assertEquals(1, decision.plan().plannedBreaks());
    }

    @Test
    void staircaseNormallyWinsBulkStoneAndCreditsFutureDescent() {
        MissionStoneMethodPlanner.FaceCandidate face = new MissionStoneMethodPlanner.FaceCandidate(
            "wide_face",
            true,
            safe(),
            line(8),
            true,
            true,
            true,
            true,
            1,
            8,
            4,
            0L
        );
        MissionStoneMethodPlanner.StaircaseCandidate stairs = staircase(
            "progressive_shaft", false, false, false, false);

        MissionStoneMethodPlanner.Decision decision = MissionStoneMethodPlanner.plan(request(
            0, 8, face, stairs, null));

        assertEquals(MissionStoneMethodPlanner.Method.STAIRCASE, decision.plan().method());
        assertEquals(8, decision.plan().predictedCobblestone());
        assertEquals(8, decision.plan().plannedBreaks());
        assertEquals(3, decision.plan().plannedStaircaseSteps().size());
        assertEquals(2, decision.plan().completedStaircaseSteps());
        assertEquals(2, decision.plan().futureDescentBlocks());
        assertTrue(decision.plan().cost().futureDescentCreditMs() > 0L);
    }

    @Test
    void rejectedUnusedStaircaseSuffixDoesNotSuppressASmallExecutablePrefix() {
        MissionStoneMethodPlanner.Plan plan = MissionStoneMethodPlanner.plan(request(
            4,
            8,
            null,
            staircase("small_prefix", false, false, false, false),
            null
        )).plan();

        assertEquals(MissionStoneMethodPlanner.Method.STAIRCASE, plan.method());
        assertEquals(1, plan.completedStaircaseSteps());
        assertEquals(2, plan.plannedStaircaseSteps().size());
        assertEquals(
            plan.plannedStaircaseSteps().subList(0, 1),
            McbotFabricClient.executableMissionStoneMovementSteps(plan)
        );

        MissionStoneRejectedTransitionMemory memory = new MissionStoneRejectedTransitionMemory();
        memory.observeContext(
            "world-a",
            "minecraft:overworld",
            MissionStoneRejectedTransitionMemory.PRE_ACTIVATION_SESSION
        );
        StaircaseDescentPlanner.Step unused = plan.plannedStaircaseSteps().get(1);
        memory.recordPhysicalRejection(
            new VoxelCell(
                unused.currentFeet().getX(),
                unused.currentFeet().getY(),
                unused.currentFeet().getZ()
            ),
            new VoxelCell(
                unused.nextFeet().getX(),
                unused.nextFeet().getY(),
                unused.nextFeet().getZ()
            )
        );

        assertTrue(memory.contains(
            new VoxelCell(
                unused.currentFeet().getX(),
                unused.currentFeet().getY(),
                unused.currentFeet().getZ()
            ),
            new VoxelCell(
                unused.nextFeet().getX(),
                unused.nextFeet().getY(),
                unused.nextFeet().getZ()
            )
        ));
        assertTrue(
            McbotFabricClient.executableMissionStoneMovementSteps(plan).stream().noneMatch(step ->
                memory.contains(
                    new VoxelCell(
                        step.currentFeet().getX(),
                        step.currentFeet().getY(),
                        step.currentFeet().getZ()
                    ),
                    new VoxelCell(
                        step.nextFeet().getX(),
                        step.nextFeet().getY(),
                        step.nextFeet().getZ()
                    )
                )
            ),
            "the rejected speculative suffix is not an executable edge for this exact deficit"
        );
    }

    @Test
    void facePrefixIsDeterministicAndCandidateOrderIndependent() {
        List<BlockPos> forward = line(4);
        List<BlockPos> shuffled = List.of(forward.get(3), forward.get(1), forward.get(0), forward.get(2));

        MissionStoneMethodPlanner.Plan first = MissionStoneMethodPlanner.plan(request(
            6, 8, face("same", forward, 0, 4), null, null)).plan();
        MissionStoneMethodPlanner.Plan second = MissionStoneMethodPlanner.plan(request(
            6, 8, face("same", shuffled, 0, 4), null, null)).plan();

        assertEquals(first.plannedFaceBlocks(), second.plannedFaceBlocks());
        assertEquals(List.of(new BlockPos(0, 64, 0), new BlockPos(1, 64, 0)), first.plannedFaceBlocks());
        assertEquals(first.cost(), second.cost());
    }

    @Test
    void faceUsesOnlyBlocksWithExactReachLineOfSightAndStoneValidation() {
        List<BlockPos> blocks = line(3);
        List<MissionStoneMethodPlanner.FaceBlock> checks = List.of(
            new MissionStoneMethodPlanner.FaceBlock(blocks.get(0)),
            new MissionStoneMethodPlanner.FaceBlock(blocks.get(1)),
            new MissionStoneMethodPlanner.FaceBlock(
                blocks.get(2), MissionStoneMethodPlanner.BreakMaterial.ORE, true, true)
        );
        MissionStoneMethodPlanner.FaceCandidate exactPrefix = new MissionStoneMethodPlanner.FaceCandidate(
            "exact_prefix", true, safe(), blocks, true, true, true, true, 0, 3, 0, 0, checks, true);

        MissionStoneMethodPlanner.Plan plan = MissionStoneMethodPlanner.plan(
            request(7, 8, exactPrefix, null, null)).plan();

        assertEquals(List.of(blocks.getFirst()), plan.plannedFaceBlocks());
        assertEquals(1, plan.plannedBreaks());

        List<MissionStoneMethodPlanner.FaceBlock> unreachable = blocks.stream()
            .map(block -> new MissionStoneMethodPlanner.FaceBlock(
                block, MissionStoneMethodPlanner.BreakMaterial.STONE, false, true))
            .toList();
        MissionStoneMethodPlanner.FaceCandidate rejected = new MissionStoneMethodPlanner.FaceCandidate(
            "unreachable", true, safe(), blocks, true, true, true, true, 0, 0, 0, 0, unreachable, true);
        assertEquals("unreachable_face", faceReason(rejected));
    }

    @Test
    void stalePerBlockFaceValidationFailsClosed() {
        List<BlockPos> blocks = line(2);
        MissionStoneMethodPlanner.FaceCandidate stale = new MissionStoneMethodPlanner.FaceCandidate(
            "stale",
            true,
            safe(),
            blocks,
            true,
            true,
            true,
            true,
            0,
            0,
            0,
            0,
            List.of(new MissionStoneMethodPlanner.FaceBlock(blocks.getFirst())),
            true
        );

        assertEquals("stale_face_validation", faceReason(stale));
    }

    @Test
    void aValidatedExistingSafeDropCanBeatBothMiningApproaches() {
        MissionStoneMethodPlanner.SafeDropCandidate drop = new MissionStoneMethodPlanner.SafeDropCandidate(
            "existing_drop",
            true,
            safe(),
            safe(),
            2,
            true,
            true,
            3,
            0,
            0,
            0,
            2,
            0L
        );
        MissionStoneMethodPlanner.FaceCandidate face = face("face", line(3), 4, 3);
        MissionStoneMethodPlanner.StaircaseCandidate stairs = staircase(
            "stairs", false, false, false, false);

        MissionStoneMethodPlanner.Decision decision = MissionStoneMethodPlanner.plan(request(
            0, 3, face, stairs, drop));

        assertEquals(MissionStoneMethodPlanner.Method.SAFE_DROP, decision.plan().method());
        assertEquals(3, decision.plan().predictedCobblestone());
    }

    @Test
    void safeDropFreezesOnlyTheExactProductionDeficitHarvestPrefix() {
        List<BlockPos> blocks = List.of(
            new BlockPos(4, 62, 0),
            new BlockPos(4, 63, 0),
            new BlockPos(5, 62, 0)
        );
        MissionStoneMethodPlanner.SafeDropCandidate drop = safeDrop(
            "exact_drop", blocks, gravityClearChecks(blocks));

        MissionStoneMethodPlanner.Plan one = MissionStoneMethodPlanner.plan(request(
            7, 8, null, null, drop)).plan();

        assertEquals(MissionStoneMethodPlanner.Method.SAFE_DROP, one.method());
        assertEquals(1, one.predictedCobblestone());
        assertEquals(1, one.plannedBreaks());
        assertEquals(List.of(blocks.getFirst()), one.plannedFaceBlocks());
        assertTrue(one.plannedStaircaseBreaks().isEmpty());
        assertTrue(one.plannedStaircaseSteps().isEmpty());
        assertEquals(0, one.completedStaircaseSteps());

        MissionStoneMethodPlanner.Request twoRemaining = new MissionStoneMethodPlanner.Request(
            0,
            8,
            6,
            false,
            false,
            drop,
            null,
            null,
            timing()
        );
        MissionStoneMethodPlanner.Plan two = MissionStoneMethodPlanner.plan(twoRemaining).plan();
        assertEquals(2, two.predictedCobblestone());
        assertEquals(blocks.subList(0, 2), two.plannedFaceBlocks());
    }

    @Test
    void safeDropRejectsMismatchedDuplicateAndGravityBlockedHarvestPackages() {
        BlockPos first = new BlockPos(4, 62, 0);
        BlockPos second = new BlockPos(4, 63, 0);
        MissionStoneMethodPlanner.SafeDropCandidate mismatched = new MissionStoneMethodPlanner.SafeDropCandidate(
            "mismatched",
            true,
            safe(),
            safe(),
            2,
            true,
            true,
            2,
            0,
            0,
            0,
            2,
            0,
            List.of(new MissionStoneMethodPlanner.FaceBlock(first))
        );
        MissionStoneMethodPlanner.SafeDropCandidate duplicate = new MissionStoneMethodPlanner.SafeDropCandidate(
            "duplicate",
            true,
            safe(),
            safe(),
            2,
            true,
            true,
            2,
            0,
            0,
            0,
            2,
            0,
            List.of(
                new MissionStoneMethodPlanner.FaceBlock(first),
                new MissionStoneMethodPlanner.FaceBlock(first)
            )
        );
        MissionStoneMethodPlanner.SafeDropCandidate gravityBlocked = safeDrop(
            "gravity",
            List.of(first, second),
            List.of(
                new MissionStoneMethodPlanner.FaceBlock(
                    first, MissionStoneMethodPlanner.BreakMaterial.STONE, true, true, true),
                new MissionStoneMethodPlanner.FaceBlock(
                    second, MissionStoneMethodPlanner.BreakMaterial.STONE, true, true, false)
            )
        );
        MissionStoneMethodPlanner.SafeDropCandidate nonStone = safeDrop(
            "non_stone",
            List.of(first),
            List.of(new MissionStoneMethodPlanner.FaceBlock(
                first, MissionStoneMethodPlanner.BreakMaterial.ORE, true, true, true))
        );

        for (MissionStoneMethodPlanner.SafeDropCandidate candidate :
            List.of(mismatched, duplicate, gravityBlocked, nonStone)) {
            MissionStoneMethodPlanner.Decision decision = MissionStoneMethodPlanner.plan(
                request(0, 2, null, null, candidate));
            assertNull(decision.plan(), candidate.identity());
            assertEquals(
                "invalid_harvest_batch",
                evaluation(decision, MissionStoneMethodPlanner.Method.SAFE_DROP).reason(),
                candidate.identity()
            );
        }
    }

    @Test
    void deterministicTiesPreferSafeDropThenFaceThenStaircase() {
        MissionStoneMethodPlanner.Timing zero = new MissionStoneMethodPlanner.Timing(
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        MissionStoneMethodPlanner.SafeDropCandidate drop = new MissionStoneMethodPlanner.SafeDropCandidate(
            "drop", true, safe(), safe(), 1, true, true, 1, 0, 0, 0, 0, 0);
        MissionStoneMethodPlanner.StaircaseCandidate noCreditStaircase = new MissionStoneMethodPlanner.StaircaseCandidate(
            "stairs",
            true,
            safe(),
            steps(1),
            stoneBreakCells(steps(1)),
            true,
            true,
            false,
            false,
            false,
            false,
            0,
            0,
            0,
            0,
            0
        );
        MissionStoneMethodPlanner.Request request = new MissionStoneMethodPlanner.Request(
            0,
            1,
            false,
            false,
            drop,
            face("face", line(1), 0, 0),
            noCreditStaircase,
            zero
        );

        assertEquals(MissionStoneMethodPlanner.Method.SAFE_DROP, MissionStoneMethodPlanner.plan(request).plan().method());
    }

    @Test
    void faceBoundsTheScanAndEachSelectedComponentWithoutDependingOnScannerSeed() {
        List<BlockPos> oneComponent = line(9);
        List<BlockPos> tooMany = line(MissionStoneMethodPlanner.FACE_SCAN_BLOCK_LIMIT + 1);
        List<BlockPos> duplicate = List.of(new BlockPos(0, 64, 0), new BlockPos(0, 64, 0));

        assertEquals("face_block_limit", faceReason(face("too_many", tooMany, 0, 0)));
        assertEquals("invalid_face_blocks", faceReason(face("duplicate", duplicate, 0, 0)));

        MissionStoneMethodPlanner.Plan bounded = MissionStoneMethodPlanner.plan(
            request(0, 8, face("nine", oneComponent, 0, 0), null, null)).plan();
        assertEquals(MissionStoneMethodPlanner.FACE_BLOCK_LIMIT, bounded.plannedFaceBlocks().size());
    }

    @Test
    void allBoundedFaceComponentsAreComparedAndLargerUsefulComponentBeatsNearestSingleton() {
        List<BlockPos> blocks = List.of(
            new BlockPos(0, 64, 0),
            new BlockPos(10, 64, 0),
            new BlockPos(11, 64, 0),
            new BlockPos(12, 64, 0)
        );
        MissionStoneMethodPlanner.FaceCandidate candidate = sampledFace(
            "components", blocks, true, gravityClearChecks(blocks));

        MissionStoneMethodPlanner.Plan plan = MissionStoneMethodPlanner.plan(
            request(0, 3, candidate, null, null)).plan();

        assertEquals(3, plan.predictedCobblestone());
        assertEquals(
            List.of(
                new BlockPos(10, 64, 0),
                new BlockPos(11, 64, 0),
                new BlockPos(12, 64, 0)
            ),
            plan.plannedFaceBlocks()
        );
        assertTrue(plan.identity().endsWith("component:10,64,0"));

        List<BlockPos> reversed = List.of(blocks.get(3), blocks.get(0), blocks.get(2), blocks.get(1));
        MissionStoneMethodPlanner.Plan reordered = MissionStoneMethodPlanner.plan(request(
            0,
            3,
            sampledFace("components", reversed, true, gravityClearChecks(reversed)),
            null,
            null
        )).plan();
        assertEquals(plan.plannedFaceBlocks(), reordered.plannedFaceBlocks());
        assertEquals(plan.cost(), reordered.cost());
    }

    @Test
    void faceRequiresFullCubeStableStanceSupportBeyondLegacyStableFlag() {
        List<BlockPos> blocks = line(1);
        MissionStoneMethodPlanner.FaceCandidate partialSupport = sampledFace(
            "partial_support", blocks, false, gravityClearChecks(blocks));

        assertEquals("unsafe_stance", faceReason(partialSupport));

        MissionStoneMethodPlanner.FaceCandidate oldPerBlockSampler =
            new MissionStoneMethodPlanner.FaceCandidate(
                "unupgraded_sampler",
                true,
                safe(),
                blocks,
                true,
                true,
                true,
                true,
                0,
                0,
                0,
                0,
                gravityClearChecks(blocks)
            );
        assertEquals(
            "unsafe_stance",
            faceReason(oldPerBlockSampler),
            "the old per-block sampler overload must fail closed until it proves full-cube support"
        );
    }

    @Test
    void fallingSandOrGravelAboveEveryReachableTargetRejectsFaceMethod() {
        List<BlockPos> blocks = line(2);
        List<MissionStoneMethodPlanner.FaceBlock> blocked = blocks.stream()
            .map(block -> new MissionStoneMethodPlanner.FaceBlock(
                block,
                MissionStoneMethodPlanner.BreakMaterial.STONE,
                true,
                true,
                false
            ))
            .toList();
        MissionStoneMethodPlanner.FaceCandidate candidate = sampledFace(
            "gravity", blocks, true, blocked);

        assertEquals("face_gravity_unstable", faceReason(candidate));
    }

    @Test
    void hardSafetyVetoesEveryMethodBeforeTiming() {
        MissionStoneMethodPlanner.Safety wet = new MissionStoneMethodPlanner.Safety(
            true, false, true, true, true, true, true);
        MissionStoneMethodPlanner.FaceCandidate face = new MissionStoneMethodPlanner.FaceCandidate(
            "wet_face", true, wet, line(1), true, true, true, true, 0, 0, 0, 0);
        MissionStoneMethodPlanner.SafeDropCandidate drop = new MissionStoneMethodPlanner.SafeDropCandidate(
            "wet_drop", true, safe(), wet, 1, true, true, 1, 0, 0, 0, 0, 0);
        MissionStoneMethodPlanner.StaircaseCandidate stairs = new MissionStoneMethodPlanner.StaircaseCandidate(
            "wet_stairs",
            true,
            wet,
            steps(1),
            stoneBreakCells(steps(1)),
            true,
            true,
            false,
            false,
            false,
            false,
            6,
            6,
            0,
            6,
            0
        );
        MissionStoneMethodPlanner.Decision decision = MissionStoneMethodPlanner.plan(new MissionStoneMethodPlanner.Request(
            0, 1, false, false, drop, face, stairs, timing()));

        assertNull(decision.plan());
        assertEquals("no_safe_method", decision.reason());
        assertEquals("unsafe_stance_or_landing", evaluation(decision, MissionStoneMethodPlanner.Method.SAFE_DROP).reason());
        assertEquals("unsafe_stance", evaluation(decision, MissionStoneMethodPlanner.Method.REACHABLE_FACE).reason());
        assertEquals("unsafe_origin_or_step_envelope", evaluation(decision, MissionStoneMethodPlanner.Method.STAIRCASE).reason());
    }

    @Test
    void surfaceDirtIsPricedAsClearanceButNeverCountedAsCobblestone() {
        List<StaircaseDescentPlanner.Step> route = steps(1);
        List<MissionStoneMethodPlanner.BreakCell> cells = stoneBreakCells(route);
        cells.set(0, new MissionStoneMethodPlanner.BreakCell(
            cells.get(0).position(), MissionStoneMethodPlanner.BreakMaterial.SAFE_NON_ORE));
        cells.set(1, new MissionStoneMethodPlanner.BreakCell(
            cells.get(1).position(), MissionStoneMethodPlanner.BreakMaterial.SAFE_NON_ORE));
        MissionStoneMethodPlanner.StaircaseCandidate surface = new MissionStoneMethodPlanner.StaircaseCandidate(
            "surface_dirt_over_stone",
            true,
            safe(),
            route,
            cells,
            true,
            true,
            false,
            false,
            false,
            false,
            6,
            6,
            0,
            6,
            0
        );

        MissionStoneMethodPlanner.Plan plan = MissionStoneMethodPlanner.plan(
            request(0, 8, null, surface, null)).plan();

        assertEquals(MissionStoneMethodPlanner.Method.STAIRCASE, plan.method());
        assertEquals(8, plan.predictedCobblestone());
        assertEquals(10, plan.plannedBreaks(), "two dirt blocks are work, not cobblestone yield");
        assertEquals(10_000L, plan.cost().breakMs());
    }

    @Test
    void oreFluidGravityHazardAndUnknownClearanceFailClosed() {
        List<StaircaseDescentPlanner.Step> route = steps(1);
        for (MissionStoneMethodPlanner.BreakMaterial material : List.of(
            MissionStoneMethodPlanner.BreakMaterial.ORE,
            MissionStoneMethodPlanner.BreakMaterial.FLUID,
            MissionStoneMethodPlanner.BreakMaterial.GRAVITY_UNSTABLE,
            MissionStoneMethodPlanner.BreakMaterial.HAZARD,
            MissionStoneMethodPlanner.BreakMaterial.UNKNOWN
        )) {
            List<MissionStoneMethodPlanner.BreakCell> cells = stoneBreakCells(route);
            cells.set(0, new MissionStoneMethodPlanner.BreakCell(cells.get(0).position(), material));
            MissionStoneMethodPlanner.StaircaseCandidate unsafe = new MissionStoneMethodPlanner.StaircaseCandidate(
                material.name(),
                true,
                safe(),
                route,
                cells,
                true,
                true,
                false,
                false,
                false,
                false,
                6,
                6,
                0,
                6,
                0
            );
            MissionStoneMethodPlanner.Decision decision = MissionStoneMethodPlanner.plan(
                request(0, 8, null, unsafe, null));

            assertNull(decision.plan(), material.name());
            assertTrue(
                evaluation(decision, MissionStoneMethodPlanner.Method.STAIRCASE).reason().endsWith("clearance_forbidden"),
                material.name()
            );
        }
    }

    @Test
    void staircaseValidatesOnlyTheExactYieldPrefix() {
        List<StaircaseDescentPlanner.Step> route = steps(1);
        List<MissionStoneMethodPlanner.BreakCell> cells = stoneBreakCells(route);
        cells.set(1, new MissionStoneMethodPlanner.BreakCell(
            cells.get(1).position(), MissionStoneMethodPlanner.BreakMaterial.ORE));
        MissionStoneMethodPlanner.StaircaseCandidate candidate = new MissionStoneMethodPlanner.StaircaseCandidate(
            "one_stone_then_ore",
            true,
            safe(),
            route,
            cells,
            true,
            true,
            false,
            false,
            false,
            false,
            6,
            6,
            0,
            6,
            0
        );

        MissionStoneMethodPlanner.Plan one = MissionStoneMethodPlanner.plan(
            request(7, 8, null, candidate, null)).plan();
        assertNotNull(one);
        assertEquals(1, one.plannedStaircaseBreaks().size());
        assertEquals(0, one.completedStaircaseSteps());

        MissionStoneMethodPlanner.Decision two = MissionStoneMethodPlanner.plan(
            request(6, 8, null, candidate, null));
        assertNull(two.plan());
        assertEquals(
            "ore_clearance_forbidden",
            evaluation(two, MissionStoneMethodPlanner.Method.STAIRCASE).reason()
        );
    }

    @Test
    void granularStepSafetyIgnoresUnusedSuffixButRejectsTouchedSupport() {
        List<StaircaseDescentPlanner.Step> route = steps(1);
        List<MissionStoneMethodPlanner.StepEnvelope> envelopes = new ArrayList<>();
        for (int index = 0; index < route.size(); index++) {
            envelopes.add(new MissionStoneMethodPlanner.StepEnvelope(
                route.get(index).index(),
                index == 0 ? safe() : new MissionStoneMethodPlanner.Safety(
                    true, true, true, false, true, true, true),
                index == 0,
                false,
                false,
                false,
                false
            ));
        }
        MissionStoneMethodPlanner.StaircaseCandidate candidate = new MissionStoneMethodPlanner.StaircaseCandidate(
            "granular",
            true,
            safe(),
            route,
            stoneBreakCells(route),
            false,
            false,
            false,
            false,
            false,
            false,
            6,
            6,
            0,
            6,
            0,
            envelopes
        );

        assertNotNull(MissionStoneMethodPlanner.plan(request(7, 8, null, candidate, null)).plan());
        MissionStoneMethodPlanner.Decision touchesUnsafeSuffix = MissionStoneMethodPlanner.plan(
            request(4, 8, null, candidate, null));
        assertNull(touchesUnsafeSuffix.plan());
        assertEquals(
            "unsafe_origin_or_step_envelope",
            evaluation(touchesUnsafeSuffix, MissionStoneMethodPlanner.Method.STAIRCASE).reason()
        );
    }

    @Test
    void bootstrapStaircaseRejectsEveryRecoveryCapability() {
        for (MissionStoneMethodPlanner.StaircaseCandidate candidate : List.of(
            staircase("bridge", true, false, false, false),
            staircase("tunnel", false, true, false, false),
            staircase("fall", false, false, true, false),
            staircase("constructive", false, false, false, true)
        )) {
            MissionStoneMethodPlanner.Decision decision = MissionStoneMethodPlanner.plan(request(
                0, 8, null, candidate, null));
            assertNull(decision.plan(), candidate.identity());
            assertEquals(
                "bootstrap_recovery_forbidden",
                evaluation(decision, MissionStoneMethodPlanner.Method.STAIRCASE).reason(),
                candidate.identity()
            );
        }
    }

    @Test
    void manifestReadyCanUseAnExistingBoundedStaircaseRecoveryCapability() {
        MissionStoneMethodPlanner.StaircaseCandidate candidate = staircase(
            "post_manifest_safe_fall", false, false, true, false);
        MissionStoneMethodPlanner.Request request = new MissionStoneMethodPlanner.Request(
            0, 8, true, false, null, null, candidate, timing());

        assertEquals(MissionStoneMethodPlanner.Method.STAIRCASE, MissionStoneMethodPlanner.plan(request).plan().method());
    }

    @Test
    void staircaseRequiresSixConnectedSameHeadingStepsAndNeverOwnSupport() {
        List<StaircaseDescentPlanner.Step> five = steps(1).subList(0, 5);
        List<StaircaseDescentPlanner.Step> turned = new ArrayList<>(steps(1));
        StaircaseDescentPlanner.Step third = turned.get(2);
        turned.set(3, StaircaseDescentPlanner.stepFrom(third.nextFeet(), StaircaseDescentPlanner.east(), 4));
        for (int index = 4; index < 6; index++) {
            turned.set(index, StaircaseDescentPlanner.stepFrom(turned.get(index - 1).nextFeet(), StaircaseDescentPlanner.east(), index + 1));
        }
        List<StaircaseDescentPlanner.Step> selfSupport = new ArrayList<>(steps(1));
        StaircaseDescentPlanner.Step first = selfSupport.getFirst();
        selfSupport.set(0, new StaircaseDescentPlanner.Step(
            first.index(),
            first.currentFeet(),
            first.nextFeet(),
            first.currentFeet().down(),
            first.upperClear(),
            first.lowerClear(),
            first.support()
        ));

        assertEquals("staircase_step_count", staircaseReason(five));
        assertEquals("staircase_heading_changed", staircaseReason(turned));
        assertEquals("staircase_targets_self_support", staircaseReason(selfSupport));
    }

    @Test
    void resumedShaftMayUseAnyPositiveConsecutiveStepIndex() {
        MissionStoneMethodPlanner.StaircaseCandidate resumed = new MissionStoneMethodPlanner.StaircaseCandidate(
            "resumed",
            true,
            safe(),
            steps(13),
            stoneBreakCells(steps(13)),
            true,
            true,
            false,
            false,
            false,
            false,
            6,
            6,
            0,
            6,
            0
        );

        assertEquals(
            MissionStoneMethodPlanner.Method.STAIRCASE,
            MissionStoneMethodPlanner.plan(request(0, 8, null, resumed, null)).plan().method()
        );
    }

    @Test
    void costMathSaturatesInsteadOfOverflowing() {
        MissionStoneMethodPlanner.Timing huge = new MissionStoneMethodPlanner.Timing(
            Long.MAX_VALUE,
            Long.MAX_VALUE,
            Long.MAX_VALUE,
            Long.MAX_VALUE,
            Long.MAX_VALUE,
            Long.MAX_VALUE,
            Long.MAX_VALUE,
            Long.MAX_VALUE,
            Long.MAX_VALUE,
            Long.MAX_VALUE
        );
        MissionStoneMethodPlanner.Request request = new MissionStoneMethodPlanner.Request(
            0, 8, false, true, null, face("huge", line(8), 8, 8), null, huge);

        assertEquals(Long.MAX_VALUE, MissionStoneMethodPlanner.plan(request).plan().cost().totalMs());
    }

    private String faceReason(MissionStoneMethodPlanner.FaceCandidate face) {
        MissionStoneMethodPlanner.Decision decision = MissionStoneMethodPlanner.plan(request(0, 8, face, null, null));
        return evaluation(decision, MissionStoneMethodPlanner.Method.REACHABLE_FACE).reason();
    }

    private String staircaseReason(List<StaircaseDescentPlanner.Step> steps) {
        MissionStoneMethodPlanner.StaircaseCandidate candidate = new MissionStoneMethodPlanner.StaircaseCandidate(
            "invalid",
            true,
            safe(),
            steps,
            stoneBreakCells(steps),
            true,
            true,
            false,
            false,
            false,
            false,
            6,
            6,
            0,
            6,
            0
        );
        MissionStoneMethodPlanner.Decision decision = MissionStoneMethodPlanner.plan(request(0, 8, null, candidate, null));
        return evaluation(decision, MissionStoneMethodPlanner.Method.STAIRCASE).reason();
    }

    private MissionStoneMethodPlanner.Evaluation evaluation(
        MissionStoneMethodPlanner.Decision decision,
        MissionStoneMethodPlanner.Method method
    ) {
        return decision.evaluations().stream().filter(candidate -> candidate.method() == method).findFirst().orElseThrow();
    }

    private MissionStoneMethodPlanner.Request request(
        int owned,
        int target,
        MissionStoneMethodPlanner.FaceCandidate face,
        MissionStoneMethodPlanner.StaircaseCandidate stairs,
        MissionStoneMethodPlanner.SafeDropCandidate drop
    ) {
        return new MissionStoneMethodPlanner.Request(owned, target, false, false, drop, face, stairs, timing());
    }

    private MissionStoneMethodPlanner.Timing timing() {
        return new MissionStoneMethodPlanner.Timing(
            100,
            100,
            1_000,
            100,
            1_000,
            500,
            3_000,
            200,
            200,
            200
        );
    }

    private MissionStoneMethodPlanner.Safety safe() {
        return new MissionStoneMethodPlanner.Safety(true, true, true, true, true, true, true);
    }

    private MissionStoneMethodPlanner.FaceCandidate face(
        String identity,
        List<BlockPos> blocks,
        int movement,
        int gaze
    ) {
        return new MissionStoneMethodPlanner.FaceCandidate(
            identity, true, safe(), blocks, true, true, true, true, movement, gaze, 0, 0);
    }

    private MissionStoneMethodPlanner.FaceCandidate sampledFace(
        String identity,
        List<BlockPos> blocks,
        boolean fullCubeStableSupport,
        List<MissionStoneMethodPlanner.FaceBlock> checks
    ) {
        return new MissionStoneMethodPlanner.FaceCandidate(
            identity,
            true,
            safe(),
            blocks,
            false,
            true,
            true,
            true,
            0,
            blocks.size(),
            blocks.isEmpty() ? 0 : 1,
            0,
            checks,
            fullCubeStableSupport
        );
    }

    private MissionStoneMethodPlanner.SafeDropCandidate safeDrop(
        String identity,
        List<BlockPos> blocks,
        List<MissionStoneMethodPlanner.FaceBlock> checks
    ) {
        return new MissionStoneMethodPlanner.SafeDropCandidate(
            identity,
            true,
            safe(),
            safe(),
            2,
            true,
            true,
            blocks.size(),
            0,
            blocks.size(),
            blocks.isEmpty() ? 0 : 1,
            2,
            0,
            checks
        );
    }

    private List<MissionStoneMethodPlanner.FaceBlock> gravityClearChecks(List<BlockPos> blocks) {
        return blocks.stream()
            .map(block -> new MissionStoneMethodPlanner.FaceBlock(
                block,
                MissionStoneMethodPlanner.BreakMaterial.STONE,
                true,
                true,
                true
            ))
            .toList();
    }

    private MissionStoneMethodPlanner.StaircaseCandidate staircase(
        String identity,
        boolean bridge,
        boolean tunnel,
        boolean safeFall,
        boolean constructive
    ) {
        List<StaircaseDescentPlanner.Step> route = steps(1);
        return new MissionStoneMethodPlanner.StaircaseCandidate(
            identity,
            true,
            safe(),
            route,
            stoneBreakCells(route),
            true,
            true,
            bridge,
            tunnel,
            safeFall,
            constructive,
            6,
            6,
            0,
            6,
            0
        );
    }

    private MissionStoneMethodPlanner.StaircaseCandidate staircaseWithMaterial(
        String identity,
        MissionStoneMethodPlanner.BreakMaterial material
    ) {
        List<StaircaseDescentPlanner.Step> route = steps(1);
        List<MissionStoneMethodPlanner.BreakCell> cells = new ArrayList<>();
        for (StaircaseDescentPlanner.Step step : route) {
            addBreakCell(cells, step.sightClear(), material);
            addBreakCell(cells, step.upperClear(), material);
            addBreakCell(cells, step.lowerClear(), material);
        }
        return new MissionStoneMethodPlanner.StaircaseCandidate(
            identity,
            true,
            safe(),
            route,
            cells,
            true,
            true,
            false,
            false,
            false,
            false,
            6,
            6,
            0,
            6,
            0
        );
    }

    private List<StaircaseDescentPlanner.Step> steps(int firstIndex) {
        List<StaircaseDescentPlanner.Step> result = new ArrayList<>();
        BlockPos current = new BlockPos(0, 70, 0);
        for (int offset = 0; offset < MissionStoneMethodPlanner.STAIRCASE_STEP_COUNT; offset++) {
            StaircaseDescentPlanner.Step step = StaircaseDescentPlanner.stepFrom(
                current, StaircaseDescentPlanner.south(), firstIndex + offset);
            result.add(step);
            current = step.nextFeet();
        }
        return result;
    }

    private List<MissionStoneMethodPlanner.BreakCell> stoneBreakCells(
        List<StaircaseDescentPlanner.Step> steps
    ) {
        List<MissionStoneMethodPlanner.BreakCell> result = new ArrayList<>();
        for (StaircaseDescentPlanner.Step step : steps) {
            addBreakCell(result, step.sightClear(), MissionStoneMethodPlanner.BreakMaterial.STONE);
            addBreakCell(result, step.upperClear(), MissionStoneMethodPlanner.BreakMaterial.STONE);
            addBreakCell(result, step.lowerClear(), MissionStoneMethodPlanner.BreakMaterial.STONE);
        }
        return result;
    }

    private void addBreakCell(
        List<MissionStoneMethodPlanner.BreakCell> cells,
        BlockPos position,
        MissionStoneMethodPlanner.BreakMaterial material
    ) {
        if (cells.stream().noneMatch(existing -> existing.position().equals(position))) {
            cells.add(new MissionStoneMethodPlanner.BreakCell(position, material));
        }
    }

    private List<BlockPos> line(int count) {
        List<BlockPos> blocks = new ArrayList<>();
        for (int index = 0; index < count; index++) {
            blocks.add(new BlockPos(index, 64, 0));
        }
        return blocks;
    }
}
