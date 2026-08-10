package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.util.math.BlockPos;

/**
 * Pure method selection for mission-owned cobblestone acquisition.
 *
 * <p>The live client is responsible for sampling the world and constructing the three bounded candidate
 * packages. This class deliberately has no world access: it validates the frozen package, prices only
 * hard-safe choices, and returns the lowest predicted total mission time. Predicted cobblestone is used
 * for ranking only; {@link #inventoryRequirementSatisfied(Request)} reads the authoritative inventory
 * count exclusively.
 */
final class MissionStoneMethodPlanner {
    static final int FACE_BLOCK_LIMIT = 8;
    static final int FACE_SCAN_BLOCK_LIMIT = 64;
    static final int FACE_COMPONENT_EVALUATION_LIMIT = 8;
    static final int STAIRCASE_STEP_COUNT = 6;
    static final int DROP_BATCH_LIMIT = 8;

    private MissionStoneMethodPlanner() {
    }

    enum Method {
        SAFE_DROP,
        REACHABLE_FACE,
        STAIRCASE
    }

    /** Caller-classified material for a block that the frozen staircase would actually break. */
    enum BreakMaterial {
        STONE,
        SAFE_NON_ORE,
        ORE,
        FLUID,
        GRAVITY_UNSTABLE,
        HAZARD,
        UNKNOWN
    }

    record BreakCell(BlockPos position, BreakMaterial material) {
        BreakCell {
            material = material == null ? BreakMaterial.UNKNOWN : material;
        }
    }

    /** One face block with the exact interaction checks used by the eventual frozen prefix. */
    record FaceBlock(
        BlockPos position,
        BreakMaterial material,
        boolean interactionReachValid,
        boolean lineOfSightValid,
        boolean gravityClearAbove
    ) {
        FaceBlock {
            material = material == null ? BreakMaterial.UNKNOWN : material;
        }

        FaceBlock(BlockPos position) {
            this(position, BreakMaterial.STONE, true, true, true);
        }

        /** Compatibility adapter. Runtime sampling must use the five-argument form and prove clearance. */
        FaceBlock(
            BlockPos position,
            BreakMaterial material,
            boolean interactionReachValid,
            boolean lineOfSightValid
        ) {
            this(position, material, interactionReachValid, lineOfSightValid, false);
        }

        boolean harvestable() {
            return position != null
                && material == BreakMaterial.STONE
                && interactionReachValid
                && lineOfSightValid
                && gravityClearAbove;
        }
    }

    /** Common physical preconditions for every candidate stance or landing. */
    record Safety(
        boolean grounded,
        boolean dry,
        boolean bodyClear,
        boolean stableSupport,
        boolean hazardFree,
        boolean adjacentLavaFree,
        boolean ownSupportPreserved
    ) {
        boolean hardSafe() {
            return grounded
                && dry
                && bodyClear
                && stableSupport
                && hazardFree
                && adjacentLavaFree
                && ownSupportPreserved;
        }
    }

    /**
     * A validated shallow drop that reaches a bounded stone harvest. The drop itself must remain within
     * vanilla's zero-damage range and must have a clear column and a non-boxed landing.
     */
    record SafeDropCandidate(
        String identity,
        boolean available,
        Safety originSafety,
        Safety landingSafety,
        int fallDepth,
        boolean columnClear,
        boolean landingNonBoxed,
        int harvestableCobblestone,
        int movementCells,
        int gazeTransitions,
        int explicitCollectionStops,
        int futureDescentBlocks,
        long fixedSetupMs,
        List<FaceBlock> harvestBlocks
    ) {
        SafeDropCandidate {
            identity = normalizedIdentity(identity, "safe_drop");
            harvestBlocks = harvestBlocks == null ? List.of() : List.copyOf(harvestBlocks);
        }

        /** Compatibility adapter for the original scalar-yield pure corpus. Runtime callers must
         * provide exact post-landing face blocks through the canonical constructor. */
        SafeDropCandidate(
            String identity,
            boolean available,
            Safety originSafety,
            Safety landingSafety,
            int fallDepth,
            boolean columnClear,
            boolean landingNonBoxed,
            int harvestableCobblestone,
            int movementCells,
            int gazeTransitions,
            int explicitCollectionStops,
            int futureDescentBlocks,
            long fixedSetupMs
        ) {
            this(
                identity,
                available,
                originSafety,
                landingSafety,
                fallDepth,
                columnClear,
                landingNonBoxed,
                harvestableCobblestone,
                movementCells,
                gazeTransitions,
                explicitCollectionStops,
                futureDescentBlocks,
                fixedSetupMs,
                compatibilitySafeDropBlocks(harvestableCobblestone)
            );
        }
    }

    /**
     * A bounded set of directly reachable stone-face observations. The planner, rather than scanner
     * iteration order, forms and compares up to eight deterministic connected components; any selected
     * component contributes at most eight exact blocks.
     */
    record FaceCandidate(
        String identity,
        boolean available,
        Safety stanceSafety,
        List<BlockPos> blocks,
        boolean contiguous,
        boolean immediatelyReachable,
        boolean interactionReachValid,
        boolean lineOfSightValid,
        int movementCells,
        int gazeTransitions,
        int explicitCollectionStops,
        long fixedSetupMs,
        List<FaceBlock> blockChecks,
        boolean stanceSupportFullCubeStable
    ) {
        FaceCandidate {
            identity = normalizedIdentity(identity, "reachable_face");
            blocks = blocks == null ? List.of() : List.copyOf(blocks);
            blockChecks = blockChecks == null ? List.of() : List.copyOf(blockChecks);
        }

        /** Compatibility adapter for the aggregate checks used by the pre-integration fixture corpus. */
        FaceCandidate(
            String identity,
            boolean available,
            Safety stanceSafety,
            List<BlockPos> blocks,
            boolean contiguous,
            boolean immediatelyReachable,
            boolean interactionReachValid,
            boolean lineOfSightValid,
            int movementCells,
            int gazeTransitions,
            int explicitCollectionStops,
            long fixedSetupMs
        ) {
            this(
                identity,
                available,
                stanceSafety,
                blocks,
                contiguous,
                immediatelyReachable,
                interactionReachValid,
                lineOfSightValid,
                movementCells,
                gazeTransitions,
                explicitCollectionStops,
                fixedSetupMs,
                faceBlocks(blocks, interactionReachValid, lineOfSightValid),
                stanceSafety != null && stanceSafety.stableSupport()
            );
        }

        /**
         * Compatibility adapter for the first per-block API. It deliberately fails the new full-support
         * admission until the live sampler supplies that proof through the canonical constructor.
         */
        FaceCandidate(
            String identity,
            boolean available,
            Safety stanceSafety,
            List<BlockPos> blocks,
            boolean contiguous,
            boolean immediatelyReachable,
            boolean interactionReachValid,
            boolean lineOfSightValid,
            int movementCells,
            int gazeTransitions,
            int explicitCollectionStops,
            long fixedSetupMs,
            List<FaceBlock> blockChecks
        ) {
            this(
                identity,
                available,
                stanceSafety,
                blocks,
                contiguous,
                immediatelyReachable,
                interactionReachValid,
                lineOfSightValid,
                movementCells,
                gazeTransitions,
                explicitCollectionStops,
                fixedSetupMs,
                blockChecks,
                false
            );
        }
    }

    /** Post-clearance landing contract for one exact staircase step. */
    record StepEnvelope(
        int stepIndex,
        Safety landingSafety,
        boolean bootstrapSupportDryAndStable,
        boolean requiresBridge,
        boolean requiresTunnel,
        boolean requiresSafeFall,
        boolean requiresConstructiveRecovery
    ) {
        boolean needsRecovery() {
            return requiresBridge || requiresTunnel || requiresSafeFall || requiresConstructiveRecovery;
        }
    }

    /**
     * The existing six-step descending staircase, frozen as exact planner steps. Recovery flags describe
     * capabilities that would be needed to execute the sampled package. Before the full manifest exists,
     * all four flags must remain false and every bootstrap support must already be dry and stable.
     */
    record StaircaseCandidate(
        String identity,
        boolean available,
        Safety originSafety,
        List<StaircaseDescentPlanner.Step> steps,
        List<BreakCell> breakCells,
        boolean allStepEnvelopesSafe,
        boolean bootstrapSupportsDryAndStable,
        boolean requiresBridge,
        boolean requiresTunnel,
        boolean requiresSafeFall,
        boolean requiresConstructiveRecovery,
        int movementCells,
        int gazeTransitions,
        int explicitCollectionStops,
        int futureDescentBlocks,
        long fixedSetupMs,
        List<StepEnvelope> stepEnvelopes
    ) {
        StaircaseCandidate {
            identity = normalizedIdentity(identity, "staircase");
            steps = steps == null ? List.of() : List.copyOf(steps);
            breakCells = breakCells == null ? List.of() : List.copyOf(breakCells);
            stepEnvelopes = stepEnvelopes == null ? List.of() : List.copyOf(stepEnvelopes);
        }

        /** Compatibility adapter for the original whole-package safety flags. */
        StaircaseCandidate(
            String identity,
            boolean available,
            Safety originSafety,
            List<StaircaseDescentPlanner.Step> steps,
            List<BreakCell> breakCells,
            boolean allStepEnvelopesSafe,
            boolean bootstrapSupportsDryAndStable,
            boolean requiresBridge,
            boolean requiresTunnel,
            boolean requiresSafeFall,
            boolean requiresConstructiveRecovery,
            int movementCells,
            int gazeTransitions,
            int explicitCollectionStops,
            int futureDescentBlocks,
            long fixedSetupMs
        ) {
            this(
                identity,
                available,
                originSafety,
                steps,
                breakCells,
                allStepEnvelopesSafe,
                bootstrapSupportsDryAndStable,
                requiresBridge,
                requiresTunnel,
                requiresSafeFall,
                requiresConstructiveRecovery,
                movementCells,
                gazeTransitions,
                explicitCollectionStops,
                futureDescentBlocks,
                fixedSetupMs,
                MissionStoneMethodPlanner.stepEnvelopes(
                    steps,
                    allStepEnvelopesSafe,
                    bootstrapSupportsDryAndStable,
                    requiresBridge,
                    requiresTunnel,
                    requiresSafeFall,
                    requiresConstructiveRecovery
                )
            );
        }
    }

    /** Millisecond costs are explicit inputs so live break speed and tool choice remain authoritative. */
    record Timing(
        long movementCellMs,
        long gazeTransitionMs,
        long stoneBreakMs,
        long pickupPerDropMs,
        long collectionStopMs,
        long craftingTransitionMs,
        long fallbackCobblestoneMs,
        long futureDescentBlockCreditMs,
        long safeDropCommitMs,
        long staircaseStepCommitMs
    ) {
        Timing {
            movementCellMs = nonNegative(movementCellMs);
            gazeTransitionMs = nonNegative(gazeTransitionMs);
            stoneBreakMs = nonNegative(stoneBreakMs);
            pickupPerDropMs = nonNegative(pickupPerDropMs);
            collectionStopMs = nonNegative(collectionStopMs);
            craftingTransitionMs = nonNegative(craftingTransitionMs);
            fallbackCobblestoneMs = nonNegative(fallbackCobblestoneMs);
            futureDescentBlockCreditMs = nonNegative(futureDescentBlockCreditMs);
            safeDropCommitMs = nonNegative(safeDropCommitMs);
            staircaseStepCommitMs = nonNegative(staircaseStepCommitMs);
        }
    }

    record Request(
        int authoritativeCobblestone,
        int completionCobblestone,
        int verifiedPendingCobblestone,
        boolean fullManifestReady,
        boolean craftingTransitionExpected,
        SafeDropCandidate safeDrop,
        FaceCandidate face,
        StaircaseCandidate staircase,
        Timing timing,
        int reachableFaceBlockBudget
    ) {
        Request {
            authoritativeCobblestone = Math.max(0, authoritativeCobblestone);
            completionCobblestone = Math.max(0, completionCobblestone);
            verifiedPendingCobblestone = Math.max(0, Math.min(
                DROP_BATCH_LIMIT, verifiedPendingCobblestone));
            reachableFaceBlockBudget = Math.max(0, Math.min(
                FACE_BLOCK_LIMIT, reachableFaceBlockBudget));
        }

        /** Compatibility constructor for callers using the full per-plan face allowance. */
        Request(
            int authoritativeCobblestone,
            int completionCobblestone,
            int verifiedPendingCobblestone,
            boolean fullManifestReady,
            boolean craftingTransitionExpected,
            SafeDropCandidate safeDrop,
            FaceCandidate face,
            StaircaseCandidate staircase,
            Timing timing
        ) {
            this(
                authoritativeCobblestone,
                completionCobblestone,
                verifiedPendingCobblestone,
                fullManifestReady,
                craftingTransitionExpected,
                safeDrop,
                face,
                staircase,
                timing,
                FACE_BLOCK_LIMIT
            );
        }

        /** Compatibility constructor for callers that have no verified production in flight. */
        Request(
            int authoritativeCobblestone,
            int completionCobblestone,
            boolean fullManifestReady,
            boolean craftingTransitionExpected,
            SafeDropCandidate safeDrop,
            FaceCandidate face,
            StaircaseCandidate staircase,
            Timing timing
        ) {
            this(
                authoritativeCobblestone,
                completionCobblestone,
                0,
                fullManifestReady,
                craftingTransitionExpected,
                safeDrop,
                face,
                staircase,
                timing,
                FACE_BLOCK_LIMIT
            );
        }
    }

    record Cost(
        long setupMs,
        long travelMs,
        long gazeMs,
        long breakMs,
        long pickupMs,
        long collectionMs,
        long craftingMs,
        long fallbackMs,
        long futureDescentCreditMs,
        long totalMs
    ) {
    }

    /** A normalized, executable method package. Candidate geometry remains frozen by the caller. */
    record Plan(
        Method method,
        String identity,
        int authoritativeDeficit,
        int predictedCobblestone,
        int plannedBreaks,
        int movementCells,
        int futureDescentBlocks,
        Cost cost,
        List<BlockPos> plannedFaceBlocks,
        List<BreakCell> plannedStaircaseBreaks,
        List<StaircaseDescentPlanner.Step> plannedStaircaseSteps,
        int completedStaircaseSteps
    ) {
        Plan {
            plannedFaceBlocks = plannedFaceBlocks == null ? List.of() : List.copyOf(plannedFaceBlocks);
            plannedStaircaseBreaks = plannedStaircaseBreaks == null
                ? List.of()
                : List.copyOf(plannedStaircaseBreaks);
            plannedStaircaseSteps = plannedStaircaseSteps == null
                ? List.of()
                : List.copyOf(plannedStaircaseSteps);
            completedStaircaseSteps = Math.max(0, completedStaircaseSteps);
        }
    }

    /** Includes rejected candidates so integration telemetry can preserve the exact classified reason. */
    record Evaluation(Method method, String identity, Plan plan, String reason) {
        boolean accepted() {
            return plan != null;
        }
    }

    record Decision(Plan plan, List<Evaluation> evaluations, String reason) {
        Decision {
            evaluations = evaluations == null ? List.of() : List.copyOf(evaluations);
            reason = reason == null ? "" : reason;
        }
    }

    static Decision plan(Request request) {
        if (request == null || request.timing() == null || request.completionCobblestone() <= 0) {
            return new Decision(null, List.of(), "invalid_request");
        }
        if (inventoryRequirementSatisfied(request)) {
            return new Decision(null, List.of(), "inventory_requirement_satisfied");
        }

        int inventoryDeficit = request.completionCobblestone() - request.authoritativeCobblestone();
        int pending = Math.min(inventoryDeficit, request.verifiedPendingCobblestone());
        int productionDeficit = Math.min(
            inventoryDeficit - pending,
            DROP_BATCH_LIMIT - pending
        );
        if (productionDeficit <= 0) {
            return new Decision(null, List.of(), "verified_production_covers_deficit");
        }
        List<Evaluation> evaluations = List.of(
            evaluateSafeDrop(request.safeDrop(), request, inventoryDeficit, productionDeficit),
            evaluateFace(request.face(), request, inventoryDeficit, productionDeficit),
            evaluateStaircase(request.staircase(), request, inventoryDeficit, productionDeficit)
        );
        Plan chosen = evaluations.stream()
            .filter(Evaluation::accepted)
            .map(Evaluation::plan)
            .min(planComparator())
            .orElse(null);
        return chosen == null
            ? new Decision(null, evaluations, "no_safe_method")
            : new Decision(chosen, evaluations, "selected");
    }

    /**
     * Selects one globally fastest package from a bounded set of independently sampled method
     * requests. This is used when the live client has more than one cardinal staircase envelope:
     * every envelope keeps the ordinary per-request safety validation, while the final choice uses
     * the exact same cost and deterministic tie-break rules as {@link #plan(Request)}.
     *
     * <p>The caller owns the bound. This helper performs no world work and does not turn a rejected
     * package into authority; it merely combines already classified decisions.
     */
    static Decision planCandidates(List<Request> requests) {
        if (requests == null || requests.isEmpty()) {
            return new Decision(null, List.of(), "invalid_request");
        }
        List<Decision> decisions = requests.stream()
            .filter(java.util.Objects::nonNull)
            .map(MissionStoneMethodPlanner::plan)
            .toList();
        if (decisions.isEmpty()) {
            return new Decision(null, List.of(), "invalid_request");
        }
        return selectCandidates(decisions);
    }

    /** Combines already-evaluated bounded packages without weakening any rejection. */
    static Decision selectCandidates(List<Decision> decisions) {
        if (decisions == null || decisions.isEmpty()) {
            return new Decision(null, List.of(), "invalid_request");
        }
        List<Decision> valid = decisions.stream()
            .filter(java.util.Objects::nonNull)
            .toList();
        if (valid.isEmpty()) {
            return new Decision(null, List.of(), "invalid_request");
        }
        List<Evaluation> evaluations = valid.stream()
            .flatMap(decision -> decision.evaluations().stream())
            .toList();
        Plan chosen = valid.stream()
            .map(Decision::plan)
            .filter(java.util.Objects::nonNull)
            .min(planComparator())
            .orElse(null);
        if (chosen != null) {
            return new Decision(chosen, evaluations, "selected");
        }
        if (valid.stream().allMatch(decision ->
            "inventory_requirement_satisfied".equals(decision.reason()))) {
            return new Decision(null, evaluations, "inventory_requirement_satisfied");
        }
        if (valid.stream().allMatch(decision ->
            "verified_production_covers_deficit".equals(decision.reason()))) {
            return new Decision(null, evaluations, "verified_production_covers_deficit");
        }
        return new Decision(null, evaluations, "no_safe_method");
    }

    /** Inventory is the sole completion authority. Candidate yield and attributed drops are ignored. */
    static boolean inventoryRequirementSatisfied(Request request) {
        return request != null
            && request.completionCobblestone() > 0
            && request.authoritativeCobblestone() >= request.completionCobblestone();
    }

    private static Evaluation evaluateSafeDrop(
        SafeDropCandidate candidate,
        Request request,
        int inventoryDeficit,
        int productionDeficit
    ) {
        String identity = candidate == null ? "safe_drop" : candidate.identity();
        if (candidate == null || !candidate.available()) {
            return rejected(Method.SAFE_DROP, identity, "unavailable");
        }
        if (!hardSafe(candidate.originSafety()) || !hardSafe(candidate.landingSafety())) {
            return rejected(Method.SAFE_DROP, identity, "unsafe_stance_or_landing");
        }
        if (candidate.fallDepth() < 1 || candidate.fallDepth() > SafeFallPlanner.VANILLA_SAFE_FALL_BLOCKS) {
            return rejected(Method.SAFE_DROP, identity, "unsafe_fall_depth");
        }
        if (!candidate.columnClear() || !candidate.landingNonBoxed()) {
            return rejected(Method.SAFE_DROP, identity, "unsafe_drop_geometry");
        }
        if (candidate.harvestableCobblestone() <= 0
            || candidate.harvestableCobblestone() > DROP_BATCH_LIMIT
            || candidate.harvestBlocks().size() != candidate.harvestableCobblestone()
            || candidate.harvestBlocks().stream().anyMatch(block -> block == null || !block.harvestable())
            || candidate.harvestBlocks().stream().map(FaceBlock::position).distinct().count()
                != candidate.harvestBlocks().size()) {
            return rejected(Method.SAFE_DROP, identity, "invalid_harvest_batch");
        }
        int planned = Math.min(productionDeficit, candidate.harvestableCobblestone());
        List<BlockPos> plannedBlocks = candidate.harvestBlocks().subList(0, planned).stream()
            .map(FaceBlock::position)
            .toList();
        return accepted(
            Method.SAFE_DROP,
            candidate.identity(),
            inventoryDeficit,
            productionDeficit,
            candidate.harvestableCobblestone(),
            planned,
            candidate.movementCells(),
            candidate.gazeTransitions(),
            candidate.explicitCollectionStops(),
            candidate.futureDescentBlocks(),
            saturatedAdd(nonNegative(candidate.fixedSetupMs()), request.timing().safeDropCommitMs()),
            request,
            plannedBlocks,
            List.of(),
            List.of(),
            0
        );
    }

    private static Evaluation evaluateFace(
        FaceCandidate candidate,
        Request request,
        int inventoryDeficit,
        int productionDeficit
    ) {
        String identity = candidate == null ? "reachable_face" : candidate.identity();
        if (request.reachableFaceBlockBudget() <= 0) {
            return rejected(Method.REACHABLE_FACE, identity, "face_command_cap_exhausted");
        }
        if (candidate == null || !candidate.available()) {
            return rejected(Method.REACHABLE_FACE, identity, "unavailable");
        }
        if (!hardSafe(candidate.stanceSafety()) || !candidate.stanceSupportFullCubeStable()) {
            return rejected(Method.REACHABLE_FACE, identity, "unsafe_stance");
        }
        if (!candidate.immediatelyReachable()) {
            return rejected(Method.REACHABLE_FACE, identity, "unreachable_face");
        }
        if (candidate.blocks().isEmpty() || candidate.blocks().size() > FACE_SCAN_BLOCK_LIMIT) {
            return rejected(Method.REACHABLE_FACE, identity, "face_block_limit");
        }
        if (candidate.blocks().stream().anyMatch(block -> block == null)
            || candidate.blocks().stream().distinct().count() != candidate.blocks().size()) {
            return rejected(Method.REACHABLE_FACE, identity, "invalid_face_blocks");
        }
        if (candidate.blockChecks().size() != candidate.blocks().size()
            || candidate.blockChecks().stream().anyMatch(block -> block == null || block.position() == null)
            || candidate.blockChecks().stream().map(FaceBlock::position).distinct().count()
                != candidate.blockChecks().size()
            || !new HashSet<>(candidate.blocks()).equals(
                candidate.blockChecks().stream().map(FaceBlock::position).collect(java.util.stream.Collectors.toSet()))) {
            return rejected(Method.REACHABLE_FACE, identity, "stale_face_validation");
        }
        List<FaceBlock> harvestable = candidate.blockChecks().stream().filter(FaceBlock::harvestable).toList();
        if (harvestable.isEmpty()) {
            boolean hasStone = candidate.blockChecks().stream()
                .anyMatch(block -> block.material() == BreakMaterial.STONE);
            boolean gravityBlocked = candidate.blockChecks().stream()
                .anyMatch(block -> block.material() == BreakMaterial.STONE
                    && block.interactionReachValid()
                    && block.lineOfSightValid()
                    && !block.gravityClearAbove());
            return rejected(
                Method.REACHABLE_FACE,
                identity,
                gravityBlocked
                    ? "face_gravity_unstable"
                    : hasStone ? "unreachable_face" : "face_material_forbidden"
            );
        }
        List<List<FaceBlock>> components = connectedFaceComponents(harvestable);
        Plan chosen = components.stream()
            .limit(FACE_COMPONENT_EVALUATION_LIMIT)
            .map(component -> evaluateFaceComponent(
                candidate, component, request, inventoryDeficit, productionDeficit))
            .min(planComparator())
            .orElse(null);
        return chosen == null
            ? rejected(Method.REACHABLE_FACE, identity, "face_disconnected")
            : new Evaluation(Method.REACHABLE_FACE, chosen.identity(), chosen, "accepted");
    }

    private static Plan evaluateFaceComponent(
        FaceCandidate candidate,
        List<FaceBlock> fullComponent,
        Request request,
        int inventoryDeficit,
        int productionDeficit
    ) {
        List<FaceBlock> component = fullComponent.subList(
            0, Math.min(request.reachableFaceBlockBudget(), fullComponent.size()));
        int predicted = Math.min(productionDeficit, component.size());
        List<BlockPos> plannedBlocks = component.subList(0, predicted).stream()
            .map(FaceBlock::position)
            .toList();
        Evaluation evaluated = accepted(
            Method.REACHABLE_FACE,
            faceComponentIdentity(candidate.identity(), component.getFirst().position()),
            inventoryDeficit,
            productionDeficit,
            component.size(),
            predicted,
            candidate.movementCells(),
            Math.min(candidate.gazeTransitions(), predicted),
            Math.min(candidate.explicitCollectionStops(), predicted),
            0,
            candidate.fixedSetupMs(),
            request,
            plannedBlocks,
            List.of(),
            List.of(),
            0
        );
        return evaluated.plan();
    }

    private static Evaluation evaluateStaircase(
        StaircaseCandidate candidate,
        Request request,
        int inventoryDeficit,
        int productionDeficit
    ) {
        String identity = candidate == null ? "staircase" : candidate.identity();
        if (candidate == null || !candidate.available()) {
            return rejected(Method.STAIRCASE, identity, "unavailable");
        }
        if (!hardSafe(candidate.originSafety())) {
            return rejected(Method.STAIRCASE, identity, "unsafe_origin_or_step_envelope");
        }
        String routeReason = staircaseRouteReason(candidate.steps());
        if (!routeReason.isBlank()) {
            return rejected(Method.STAIRCASE, identity, routeReason);
        }
        StaircasePrefix prefix = staircasePrefix(candidate, productionDeficit, request.fullManifestReady());
        if (!prefix.reason().isBlank()) {
            return rejected(Method.STAIRCASE, identity, prefix.reason());
        }
        int completedSteps = prefix.completedSteps();
        int futureDescentBlocks = Math.min(Math.max(0, candidate.futureDescentBlocks()), completedSteps);
        int movementCells = Math.min(Math.max(0, candidate.movementCells()), completedSteps);
        int gazeTransitions = Math.min(Math.max(0, candidate.gazeTransitions()), prefix.breakCells().size());
        int collectionStops = Math.min(
            Math.max(0, candidate.explicitCollectionStops()), prefix.predictedCobblestone());
        long stepCommitMs = saturatedMultiply(request.timing().staircaseStepCommitMs(), completedSteps);
        return accepted(
            Method.STAIRCASE,
            candidate.identity(),
            inventoryDeficit,
            productionDeficit,
            prefix.predictedCobblestone(),
            prefix.breakCells().size(),
            movementCells,
            gazeTransitions,
            collectionStops,
            futureDescentBlocks,
            saturatedAdd(nonNegative(candidate.fixedSetupMs()), stepCommitMs),
            request,
            List.of(),
            prefix.breakCells(),
            prefix.steps(),
            completedSteps
        );
    }

    private static Evaluation accepted(
        Method method,
        String identity,
        int inventoryDeficit,
        int productionDeficit,
        int harvestable,
        int availableBreaks,
        int movementCells,
        int gazeTransitions,
        int collectionStops,
        int futureDescentBlocks,
        long setupMs,
        Request request,
        List<BlockPos> plannedFaceBlocks,
        List<BreakCell> plannedStaircaseBreaks,
        List<StaircaseDescentPlanner.Step> plannedStaircaseSteps,
        int completedStaircaseSteps
    ) {
        int predicted = Math.max(1, Math.min(Math.min(productionDeficit, harvestable), DROP_BATCH_LIMIT));
        int plannedBreaks = Math.max(predicted, Math.max(0, availableBreaks));
        Cost cost = cost(
            request.timing(),
            predicted,
            plannedBreaks,
            movementCells,
            gazeTransitions,
            collectionStops,
            futureDescentBlocks,
            setupMs,
            request.craftingTransitionExpected(),
            productionDeficit
        );
        Plan plan = new Plan(
            method,
            identity,
            inventoryDeficit,
            predicted,
            plannedBreaks,
            Math.max(0, movementCells),
            Math.max(0, futureDescentBlocks),
            cost,
            plannedFaceBlocks,
            plannedStaircaseBreaks,
            plannedStaircaseSteps,
            completedStaircaseSteps
        );
        return new Evaluation(method, identity, plan, "accepted");
    }

    private static Cost cost(
        Timing timing,
        int predicted,
        int breaks,
        int movementCells,
        int gazeTransitions,
        int collectionStops,
        int futureDescentBlocks,
        long setupMs,
        boolean craftingTransitionExpected,
        int deficit
    ) {
        long normalizedSetup = nonNegative(setupMs);
        long travel = saturatedMultiply(Math.max(0, movementCells), timing.movementCellMs());
        long gaze = saturatedMultiply(Math.max(0, gazeTransitions), timing.gazeTransitionMs());
        long breaking = saturatedMultiply(Math.max(0, breaks), timing.stoneBreakMs());
        long pickup = saturatedMultiply(Math.max(0, predicted), timing.pickupPerDropMs());
        long collection = saturatedMultiply(Math.max(0, collectionStops), timing.collectionStopMs());
        long crafting = craftingTransitionExpected ? timing.craftingTransitionMs() : 0L;
        long fallback = saturatedMultiply(Math.max(0, deficit - predicted), timing.fallbackCobblestoneMs());
        long futureCredit = saturatedMultiply(
            Math.max(0, futureDescentBlocks), timing.futureDescentBlockCreditMs());
        long gross = saturatedSum(normalizedSetup, travel, gaze, breaking, pickup, collection, crafting, fallback);
        long total = Math.max(0L, gross - Math.min(gross, futureCredit));
        return new Cost(
            normalizedSetup,
            travel,
            gaze,
            breaking,
            pickup,
            collection,
            crafting,
            fallback,
            futureCredit,
            total
        );
    }

    private static Comparator<Plan> planComparator() {
        return Comparator.comparingLong((Plan plan) -> plan.cost().totalMs())
            .thenComparing(Comparator.comparingInt(Plan::predictedCobblestone).reversed())
            .thenComparing(Comparator.comparingInt(Plan::futureDescentBlocks).reversed())
            .thenComparingInt(plan -> methodOrder(plan.method()))
            .thenComparing(Plan::identity);
    }

    private static int methodOrder(Method method) {
        return switch (method) {
            case SAFE_DROP -> 0;
            case REACHABLE_FACE -> 1;
            case STAIRCASE -> 2;
        };
    }

    private static List<List<FaceBlock>> connectedFaceComponents(List<FaceBlock> blocks) {
        List<FaceBlock> remaining = new ArrayList<>(blocks);
        remaining.sort(Comparator.comparing(FaceBlock::position, MissionStoneMethodPlanner::comparePosition));
        List<List<FaceBlock>> components = new ArrayList<>();
        while (!remaining.isEmpty()) {
            FaceBlock seed = remaining.removeFirst();
            List<FaceBlock> component = new ArrayList<>();
            List<FaceBlock> frontier = new ArrayList<>();
            frontier.add(seed);
            for (int index = 0; index < frontier.size(); index++) {
                FaceBlock current = frontier.get(index);
                component.add(current);
                List<FaceBlock> neighbors = remaining.stream()
                    .filter(candidate -> manhattan(current.position(), candidate.position()) == 1)
                    .sorted(Comparator.comparing(FaceBlock::position, MissionStoneMethodPlanner::comparePosition))
                    .toList();
                frontier.addAll(neighbors);
                remaining.removeAll(neighbors);
            }
            components.add(List.copyOf(component));
        }
        components.sort((left, right) -> {
            int boundedYield = Integer.compare(
                Math.min(FACE_BLOCK_LIMIT, right.size()),
                Math.min(FACE_BLOCK_LIMIT, left.size())
            );
            if (boundedYield != 0) {
                return boundedYield;
            }
            for (int index = 0; index < Math.min(left.size(), right.size()); index++) {
                int coordinate = comparePosition(left.get(index).position(), right.get(index).position());
                if (coordinate != 0) {
                    return coordinate;
                }
            }
            return Integer.compare(left.size(), right.size());
        });
        return List.copyOf(components);
    }

    private static String staircaseRouteReason(List<StaircaseDescentPlanner.Step> steps) {
        if (steps == null || steps.size() != STAIRCASE_STEP_COUNT) {
            return "staircase_step_count";
        }
        int firstStepIndex = steps.getFirst() == null ? -1 : steps.getFirst().index();
        int directionX = 0;
        int directionZ = 0;
        for (int index = 0; index < steps.size(); index++) {
            StaircaseDescentPlanner.Step step = steps.get(index);
            if (step == null || firstStepIndex < 1 || step.index() != firstStepIndex + index) {
                return "staircase_index";
            }
            if (StaircaseDescentPlanner.targetsSelfSupport(step)) {
                return "staircase_targets_self_support";
            }
            if (index > 0 && !steps.get(index - 1).nextFeet().equals(step.currentFeet())) {
                return "staircase_disconnected";
            }
            BlockPos expected = step.currentFeet().add(
                Integer.signum(step.nextFeet().getX() - step.currentFeet().getX()),
                -1,
                Integer.signum(step.nextFeet().getZ() - step.currentFeet().getZ())
            );
            if (!expected.equals(step.nextFeet()) || manhattanHorizontal(step.currentFeet(), step.nextFeet()) != 1) {
                return "staircase_noncanonical_step";
            }
            int stepDirectionX = step.nextFeet().getX() - step.currentFeet().getX();
            int stepDirectionZ = step.nextFeet().getZ() - step.currentFeet().getZ();
            if (index == 0) {
                directionX = stepDirectionX;
                directionZ = stepDirectionZ;
            } else if (directionX != stepDirectionX || directionZ != stepDirectionZ) {
                return "staircase_heading_changed";
            }
        }
        return "";
    }

    private static StaircasePrefix staircasePrefix(
        StaircaseCandidate candidate,
        int desiredStone,
        boolean fullManifestReady
    ) {
        if (candidate.breakCells().isEmpty()) {
            return StaircasePrefix.rejected("no_break_cells");
        }
        if (candidate.stepEnvelopes().isEmpty()) {
            return StaircasePrefix.rejected("missing_step_envelope");
        }

        List<CanonicalBreak> canonical = new ArrayList<>();
        Set<BlockPos> currentSupports = new HashSet<>();
        for (int stepOffset = 0; stepOffset < candidate.steps().size(); stepOffset++) {
            StaircaseDescentPlanner.Step step = candidate.steps().get(stepOffset);
            appendCanonical(canonical, step.sightClear(), stepOffset);
            appendCanonical(canonical, step.upperClear(), stepOffset);
            appendCanonical(canonical, step.lowerClear(), stepOffset);
            currentSupports.add(step.currentFeet().down());
        }

        List<BreakCell> prefix = new ArrayList<>();
        Set<BlockPos> seen = new HashSet<>();
        int lastCanonicalIndex = -1;
        int predicted = 0;
        int touchedStepCount = 0;
        for (BreakCell cell : candidate.breakCells()) {
            if (predicted >= desiredStone) {
                break;
            }
            if (cell == null || cell.position() == null || !seen.add(cell.position())) {
                return StaircasePrefix.rejected("invalid_or_duplicate_break_cell");
            }
            if (currentSupports.contains(cell.position())) {
                return StaircasePrefix.rejected("staircase_targets_self_support");
            }
            int canonicalIndex = canonicalIndex(canonical, cell.position());
            if (canonicalIndex < 0 || canonicalIndex <= lastCanonicalIndex) {
                return StaircasePrefix.rejected("break_cell_outside_sequence");
            }
            CanonicalBreak exact = canonical.get(canonicalIndex);
            String envelopeReason = validateStepEnvelopes(
                candidate,
                touchedStepCount,
                exact.stepOffset() + 1,
                fullManifestReady
            );
            if (!envelopeReason.isBlank()) {
                return StaircasePrefix.rejected(envelopeReason);
            }
            String materialReason = breakMaterialReason(cell.material());
            if (!materialReason.isBlank()) {
                return StaircasePrefix.rejected(materialReason);
            }
            prefix.add(cell);
            lastCanonicalIndex = canonicalIndex;
            touchedStepCount = Math.max(touchedStepCount, exact.stepOffset() + 1);
            if (cell.material() == BreakMaterial.STONE) {
                predicted++;
            }
        }
        if (predicted <= 0) {
            return StaircasePrefix.rejected("no_stone_breaks");
        }

        int completedSteps = completedStaircaseSteps(
            candidate.breakCells(), canonical, lastCanonicalIndex, touchedStepCount);
        return new StaircasePrefix(
            List.copyOf(prefix),
            List.copyOf(candidate.steps().subList(0, touchedStepCount)),
            predicted,
            completedSteps,
            ""
        );
    }

    private static String validateStepEnvelopes(
        StaircaseCandidate candidate,
        int fromStepOffset,
        int toStepCount,
        boolean fullManifestReady
    ) {
        for (int offset = fromStepOffset; offset < toStepCount; offset++) {
            if (offset >= candidate.stepEnvelopes().size()) {
                return "missing_step_envelope";
            }
            StepEnvelope envelope = candidate.stepEnvelopes().get(offset);
            StaircaseDescentPlanner.Step step = candidate.steps().get(offset);
            if (envelope == null || envelope.stepIndex() != step.index()) {
                return "stale_step_envelope";
            }
            if (!hardSafe(envelope.landingSafety())) {
                return "unsafe_origin_or_step_envelope";
            }
            if (!fullManifestReady
                && (!envelope.bootstrapSupportDryAndStable() || envelope.needsRecovery())) {
                return "bootstrap_recovery_forbidden";
            }
        }
        return "";
    }

    private static int completedStaircaseSteps(
        List<BreakCell> allBreakCells,
        List<CanonicalBreak> canonical,
        int lastIncludedCanonicalIndex,
        int touchedStepCount
    ) {
        int completed = 0;
        for (int stepOffset = 0; stepOffset < touchedStepCount; stepOffset++) {
            boolean hasUnclearedBlock = false;
            for (BreakCell cell : allBreakCells) {
                if (cell == null || cell.position() == null) {
                    continue;
                }
                int index = canonicalIndex(canonical, cell.position());
                if (index > lastIncludedCanonicalIndex
                    && index >= 0
                    && canonical.get(index).stepOffset() == stepOffset) {
                    hasUnclearedBlock = true;
                    break;
                }
            }
            if (hasUnclearedBlock) {
                break;
            }
            completed++;
        }
        return completed;
    }

    private static String breakMaterialReason(BreakMaterial material) {
        return switch (material == null ? BreakMaterial.UNKNOWN : material) {
            case STONE, SAFE_NON_ORE -> "";
            case ORE -> "ore_clearance_forbidden";
            case FLUID -> "fluid_clearance_forbidden";
            case GRAVITY_UNSTABLE -> "gravity_clearance_forbidden";
            case HAZARD -> "hazard_clearance_forbidden";
            case UNKNOWN -> "unknown_clearance_forbidden";
        };
    }

    private static void appendCanonical(List<CanonicalBreak> cells, BlockPos position, int stepOffset) {
        if (canonicalIndex(cells, position) < 0) {
            cells.add(new CanonicalBreak(position, stepOffset));
        }
    }

    private static int canonicalIndex(List<CanonicalBreak> cells, BlockPos position) {
        for (int index = 0; index < cells.size(); index++) {
            if (cells.get(index).position().equals(position)) {
                return index;
            }
        }
        return -1;
    }

    private static List<FaceBlock> compatibilitySafeDropBlocks(int count) {
        if (count <= 0) {
            return List.of();
        }
        List<FaceBlock> result = new ArrayList<>();
        for (int index = 0; index < Math.min(DROP_BATCH_LIMIT, count); index++) {
            result.add(new FaceBlock(new BlockPos(index, 0, 0)));
        }
        return List.copyOf(result);
    }

    private static List<FaceBlock> faceBlocks(
        List<BlockPos> blocks,
        boolean interactionReachValid,
        boolean lineOfSightValid
    ) {
        if (blocks == null || blocks.isEmpty()) {
            return List.of();
        }
        return blocks.stream()
            .map(block -> new FaceBlock(
                block,
                BreakMaterial.STONE,
                interactionReachValid,
                lineOfSightValid,
                true
            ))
            .toList();
    }

    private static String faceComponentIdentity(String identity, BlockPos root) {
        return normalizedIdentity(identity, "reachable_face")
            + ":component:"
            + root.getX() + "," + root.getY() + "," + root.getZ();
    }

    private static List<StepEnvelope> stepEnvelopes(
        List<StaircaseDescentPlanner.Step> steps,
        boolean allStepEnvelopesSafe,
        boolean bootstrapSupportsDryAndStable,
        boolean requiresBridge,
        boolean requiresTunnel,
        boolean requiresSafeFall,
        boolean requiresConstructiveRecovery
    ) {
        if (steps == null || steps.isEmpty()) {
            return List.of();
        }
        Safety safety = new Safety(
            allStepEnvelopesSafe,
            allStepEnvelopesSafe,
            allStepEnvelopesSafe,
            allStepEnvelopesSafe,
            allStepEnvelopesSafe,
            allStepEnvelopesSafe,
            allStepEnvelopesSafe
        );
        return steps.stream()
            .map(step -> new StepEnvelope(
                step == null ? -1 : step.index(),
                safety,
                bootstrapSupportsDryAndStable,
                requiresBridge,
                requiresTunnel,
                requiresSafeFall,
                requiresConstructiveRecovery
            ))
            .toList();
    }

    private static int comparePosition(BlockPos left, BlockPos right) {
        int y = Integer.compare(left.getY(), right.getY());
        if (y != 0) {
            return y;
        }
        int z = Integer.compare(left.getZ(), right.getZ());
        return z != 0 ? z : Integer.compare(left.getX(), right.getX());
    }

    private static Evaluation rejected(Method method, String identity, String reason) {
        return new Evaluation(method, identity, null, reason);
    }

    private static boolean hardSafe(Safety safety) {
        return safety != null && safety.hardSafe();
    }

    private static int manhattan(BlockPos left, BlockPos right) {
        return Math.abs(left.getX() - right.getX())
            + Math.abs(left.getY() - right.getY())
            + Math.abs(left.getZ() - right.getZ());
    }

    private static int manhattanHorizontal(BlockPos left, BlockPos right) {
        return Math.abs(left.getX() - right.getX()) + Math.abs(left.getZ() - right.getZ());
    }

    private static String normalizedIdentity(String identity, String fallback) {
        if (identity == null || identity.isBlank()) {
            return fallback;
        }
        return identity.trim();
    }

    private static long nonNegative(long value) {
        return Math.max(0L, value);
    }

    private static long saturatedMultiply(long left, long right) {
        if (left <= 0L || right <= 0L) {
            return 0L;
        }
        if (left > Long.MAX_VALUE / right) {
            return Long.MAX_VALUE;
        }
        return left * right;
    }

    private static long saturatedAdd(long left, long right) {
        if (left > Long.MAX_VALUE - right) {
            return Long.MAX_VALUE;
        }
        return left + right;
    }

    private static long saturatedSum(long... values) {
        long sum = 0L;
        for (long value : values) {
            sum = saturatedAdd(sum, nonNegative(value));
        }
        return sum;
    }

    private record CanonicalBreak(BlockPos position, int stepOffset) {
    }

    private record StaircasePrefix(
        List<BreakCell> breakCells,
        List<StaircaseDescentPlanner.Step> steps,
        int predictedCobblestone,
        int completedSteps,
        String reason
    ) {
        private static StaircasePrefix rejected(String reason) {
            return new StaircasePrefix(List.of(), List.of(), 0, 0, reason);
        }
    }
}
