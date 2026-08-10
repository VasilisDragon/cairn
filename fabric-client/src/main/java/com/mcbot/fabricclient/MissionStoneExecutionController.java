package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;

/**
 * Executes one frozen, mission-owned stone acquisition package.
 *
 * <p>This controller is deliberately narrower than {@code DescentExecutor}. It can break only the
 * exact prefix admitted by {@link MissionStoneMethodPlanner}, and it can move only over the frozen
 * one-block staircase transitions. It owns no search, reroute, excavation, construction, safe-fall,
 * or recovery authority.</p>
 */
final class MissionStoneExecutionController {
    static final int MAX_FACE_BLOCKS = MissionStoneMethodPlanner.FACE_BLOCK_LIMIT;
    static final int MAX_STAIR_STEPS = MissionStoneMethodPlanner.STAIRCASE_STEP_COUNT;
    static final long STEP_LANDING_TIMEOUT_MS = 3_000L;
    static final double LANDING_HORIZONTAL_EPSILON = 0.35D;
    static final double DEPARTURE_PROGRESS_EPSILON = 0.05D;
    static final double PLAYER_HALF_WIDTH = 0.30D;
    static final double ORIGIN_SUPPORT_CLEARANCE_MARGIN = 0.01D;

    enum Action {
        IDLE,
        HOLD,
        BREAK_BLOCK,
        MOVE,
        PLAN_EXHAUSTED,
        COMPLETE,
        REJECTED
    }

    enum RuntimeMaterial {
        AIR,
        STONE,
        SAFE_NON_ORE,
        ORE,
        FLUID,
        GRAVITY_UNSTABLE,
        HAZARD,
        UNKNOWN_SOLID
    }

    enum MovementPhase {
        NONE,
        SELECTED,
        ALIGNING,
        LAUNCHING,
        AIRBORNE,
        LAND_SETTLE
    }

    record ExecutionKey(String commandId, String worldIdentity, String dimensionIdentity) {
        ExecutionKey {
            commandId = requireText(commandId, "commandId");
            worldIdentity = requireText(worldIdentity, "worldIdentity");
            dimensionIdentity = requireText(dimensionIdentity, "dimensionIdentity");
        }
    }

    /** Runtime classification sampled by the caller; no world scan occurs inside the controller. */
    record RuntimeBlock(
        RuntimeMaterial material,
        boolean interactionReachable,
        boolean lineOfSightClear,
        Direction interactionFace
    ) {
        RuntimeBlock {
            material = material == null ? RuntimeMaterial.UNKNOWN_SOLID : material;
        }

        static RuntimeBlock air() {
            return new RuntimeBlock(RuntimeMaterial.AIR, false, false, null);
        }

        static RuntimeBlock breakable(RuntimeMaterial material, Direction face) {
            return new RuntimeBlock(material, true, true, face);
        }
    }

    record StanceState(
        boolean dry,
        boolean bodyClear,
        boolean stableSupport,
        boolean hazardFree,
        boolean adjacentLavaFree
    ) {
        static StanceState safe() {
            return new StanceState(true, true, true, true, true);
        }

        boolean hardSafe() {
            return dry && bodyClear && stableSupport && hazardFree && adjacentLavaFree;
        }
    }

    interface GeometryProbe {
        RuntimeBlock block(BlockPos position);

        StanceState stance(VoxelCell feet);
    }

    record Observation(
        ExecutionKey key,
        VoxelCell feet,
        double x,
        double y,
        double z,
        boolean grounded,
        boolean aligned,
        int authoritativeCobblestone
    ) {
        Observation {
            authoritativeCobblestone = Math.max(0, authoritativeCobblestone);
        }

        static Observation centered(
            ExecutionKey key,
            VoxelCell feet,
            boolean grounded,
            boolean aligned,
            int authoritativeCobblestone
        ) {
            return new Observation(
                key,
                feet,
                feet == null ? 0.0D : feet.x() + 0.5D,
                feet == null ? 0.0D : feet.y(),
                feet == null ? 0.0D : feet.z() + 0.5D,
                grounded,
                aligned,
                authoritativeCobblestone
            );
        }
    }

    /** Adapter-friendly subset of {@link BlockBreakController.Result}. */
    record BreakFeedback(
        BlockPos requestedTarget,
        BlockBreakController.Status status,
        String reason
    ) {
        BreakFeedback {
            if (requestedTarget == null || status == null) {
                throw new IllegalArgumentException("break feedback requires target and status");
            }
            requestedTarget = requestedTarget.toImmutable();
            reason = reason == null || reason.isBlank() ? "unspecified" : reason;
        }
    }

    /**
     * Immutable selected package. Exactly one candidate must correspond to the chosen planner method.
     */
    record FrozenPlan(
        MissionStoneMethodPlanner.Plan selection,
        VoxelCell origin,
        MissionStoneMethodPlanner.FaceCandidate face,
        MissionStoneMethodPlanner.StaircaseCandidate staircase
    ) {
        FrozenPlan {
            selection = Objects.requireNonNull(selection, "selection");
            origin = Objects.requireNonNull(origin, "origin");
            if (selection.method() == MissionStoneMethodPlanner.Method.REACHABLE_FACE
                || selection.method() == MissionStoneMethodPlanner.Method.SAFE_DROP) {
                if (staircase != null) {
                    throw new IllegalArgumentException("face selection cannot carry a staircase candidate");
                }
            } else if (selection.method() == MissionStoneMethodPlanner.Method.STAIRCASE) {
                if (face != null) {
                    throw new IllegalArgumentException("staircase selection cannot carry a face candidate");
                }
            } else {
                throw new IllegalArgumentException("unsupported mission stone method");
            }
        }

        static FrozenPlan face(
            MissionStoneMethodPlanner.Plan selection,
            VoxelCell origin
        ) {
            if (selection == null
                || selection.method() != MissionStoneMethodPlanner.Method.REACHABLE_FACE) {
                throw new IllegalArgumentException("face harvest requires REACHABLE_FACE selection");
            }
            return new FrozenPlan(selection, origin, null, null);
        }

        /** Compatibility overload for callers retaining the sampled candidate for telemetry. */
        static FrozenPlan face(
            MissionStoneMethodPlanner.Plan selection,
            VoxelCell origin,
            MissionStoneMethodPlanner.FaceCandidate face
        ) {
            return new FrozenPlan(selection, origin, face, null);
        }

        /** Post-landing SAFE_DROP harvest; the committed fall itself remains owned by
         * DescentSafeFallController. */
        static FrozenPlan safeDropHarvest(
            MissionStoneMethodPlanner.Plan selection,
            VoxelCell landing
        ) {
            if (selection == null
                || selection.method() != MissionStoneMethodPlanner.Method.SAFE_DROP) {
                throw new IllegalArgumentException("safe-drop harvest requires SAFE_DROP selection");
            }
            return new FrozenPlan(selection, landing, null, null);
        }

        static FrozenPlan staircase(
            MissionStoneMethodPlanner.Plan selection
        ) {
            VoxelCell origin = selection == null || selection.plannedStaircaseSteps().isEmpty()
                ? null
                : voxel(selection.plannedStaircaseSteps().getFirst().currentFeet());
            return new FrozenPlan(selection, origin, null, null);
        }

        /** Compatibility overload for callers retaining the sampled candidate for telemetry. */
        static FrozenPlan staircase(
            MissionStoneMethodPlanner.Plan selection,
            MissionStoneMethodPlanner.StaircaseCandidate staircase
        ) {
            VoxelCell origin = selection == null || selection.plannedStaircaseSteps().isEmpty()
                ? null
                : voxel(selection.plannedStaircaseSteps().getFirst().currentFeet());
            return new FrozenPlan(selection, origin, null, staircase);
        }
    }

    record StartResult(boolean started, String reason, String gestureIdentity) {
    }

    record Decision(
        Action action,
        MissionStoneMethodPlanner.Method method,
        BlockPos breakTarget,
        BlockBreakController.ValidatedNextBlockHint nextBlockHint,
        String breakerCommandId,
        String gestureIdentity,
        VoxelCell waypoint,
        boolean forward,
        boolean jump,
        boolean sneak,
        boolean descentExempt,
        String reason,
        int plannedBreakCursor,
        int plannedBreakCount,
        int staircaseStepIndex,
        int verifiedBreaks,
        int verifiedStoneProduced,
        boolean stoneProducedThisTick,
        boolean stepLandedThisTick,
        MovementPhase movementPhase,
        int authoritativeCobblestone,
        int completionCobblestone,
        long elapsedMs,
        long remainingDeadlineMs
    ) {
    }

    private ExecutionKey key;
    private FrozenPlan plan;
    private int completionCobblestone;
    private long startedAtMs;
    private long deadlineAtMs;
    private String breakerCommandId = "";
    private String gestureIdentity = "";
    private List<FrozenBreak> breaks = List.of();
    private int breakCursor;
    private BlockPos activeBreakTarget;
    private int verifiedBreaks;
    private int verifiedStoneProduced;
    private int staircaseStepCursor;
    private MovementPhase movementPhase = MovementPhase.NONE;
    private VoxelCell movementOrigin;
    private VoxelCell movementLanding;
    private long movementSelectedAtMs;
    private boolean movementDepartureObserved;
    private boolean movementLandingColumnCaptured;
    private final DescentStepArrivalValidator arrivalValidator = new DescentStepArrivalValidator();

    StartResult begin(
        ExecutionKey nextKey,
        FrozenPlan nextPlan,
        int authoritativeCobblestone,
        int nextCompletionCobblestone,
        long nowMs,
        long fixedDeadlineAtMs
    ) {
        clear();
        if (nextKey == null || nextPlan == null) {
            return new StartResult(false, "missing_plan_or_key", "");
        }
        if (nextCompletionCobblestone <= 0
            || authoritativeCobblestone >= nextCompletionCobblestone) {
            return new StartResult(false, "inventory_requirement_satisfied", "");
        }
        if (fixedDeadlineAtMs <= nowMs) {
            return new StartResult(false, "deadline_expired", "");
        }
        String validation = validateFrozenPlan(nextPlan);
        if (!validation.isBlank()) {
            return new StartResult(false, validation, "");
        }

        key = nextKey;
        plan = nextPlan;
        completionCobblestone = nextCompletionCobblestone;
        startedAtMs = nowMs;
        deadlineAtMs = fixedDeadlineAtMs;
        breakerCommandId = nextKey.commandId()
            + ":mission-stone:"
            + stableIdentity(nextPlan.selection().identity());
        gestureIdentity = "break-gesture:" + breakerCommandId;
        breaks = freezeBreakPrefix(nextPlan);
        breakCursor = 0;
        staircaseStepCursor = 0;
        return new StartResult(true, "started", gestureIdentity);
    }

    Decision tick(
        Observation observation,
        GeometryProbe geometry,
        BreakFeedback breakFeedback,
        long nowMs
    ) {
        if (!active()) {
            return idleDecision();
        }
        if (observation == null || observation.key() == null || !key.equals(observation.key())) {
            return reject("lifecycle_changed", observation, nowMs);
        }
        if (observation.feet() == null || geometry == null) {
            return reject("missing_runtime_observation", observation, nowMs);
        }
        // Reconcile a terminal verified break first so production telemetry is not lost on the
        // same tick that its pickup satisfies inventory. A simultaneous failed/stale feedback is
        // still subordinate to the absolute inventory postcondition below.
        BreakAdvance advance = applyBreakFeedback(breakFeedback, geometry);
        // Once a staircase launch is committed, landing safety owns the controller until the
        // transition either reaches its frozen landing or rejects. SELECTED/ALIGNING remain safely
        // cancellable at the frozen origin. Inventory may become satisfied (or the outer command
        // deadline may expire) while the player is launching or airborne;
        // clearing movement state on that tick would strand the player without the committed input
        // and arrival validation. The landed HOLD decision clears the commitment, so the terminal
        // result wins on the following tick without resetting either deadline.
        boolean committedMovement = committedMovementActive();
        // Absolute inventory is the only terminal authority and wins over a simultaneous breaker
        // failure or command deadline whenever no physical transition is committed.
        if (!committedMovement
            && observation.authoritativeCobblestone() >= completionCobblestone) {
            return terminal(
                Action.COMPLETE,
                "inventory_requirement_satisfied",
                observation,
                nowMs,
                advance.stoneProduced(),
                false
            );
        }
        if (!advance.accepted()) {
            return reject(advance.reason(), observation, nowMs);
        }
        if (!committedMovement && nowMs >= deadlineAtMs) {
            return reject("command_deadline", observation, nowMs);
        }

        if (plan.selection().method() == MissionStoneMethodPlanner.Method.REACHABLE_FACE
            || plan.selection().method() == MissionStoneMethodPlanner.Method.SAFE_DROP) {
            return tickFace(observation, geometry, nowMs, advance.stoneProduced());
        }
        return tickStaircase(observation, geometry, nowMs, advance.stoneProduced());
    }

    boolean active() {
        return plan != null;
    }

    ExecutionKey activeKey() {
        return key;
    }

    String gestureIdentity() {
        return gestureIdentity;
    }

    int breakCursor() {
        return breakCursor;
    }

    int staircaseStepCursor() {
        return staircaseStepCursor;
    }

    /**
     * True only after launch has been committed. SELECTED and ALIGNING remain cancellable while
     * the player is stopped at the verified origin.
     */
    boolean committedMovementActive() {
        return movementPhase == MovementPhase.LAUNCHING
            || movementPhase == MovementPhase.AIRBORNE
            || movementPhase == MovementPhase.LAND_SETTLE;
    }

    /** Package-private diagnostic accessor used by integration guards and focused tests. */
    MovementPhase committedMovementPhase() {
        return movementPhase;
    }

    /** Package-private diagnostic accessor for the pure committed-landing motor. */
    boolean landingColumnCaptured() {
        return movementLandingColumnCaptured;
    }

    void reset() {
        clear();
    }

    private Decision tickFace(
        Observation observation,
        GeometryProbe geometry,
        long nowMs,
        boolean stoneProduced
    ) {
        if (!observation.grounded()
            || !plan.origin().equals(observation.feet())
            || !safeStance(geometry, plan.origin())) {
            return reject("face_stance_invalid", observation, nowMs);
        }
        if (breakCursor >= breaks.size()) {
            return terminal(
                Action.PLAN_EXHAUSTED,
                "face_sequence_exhausted",
                observation,
                nowMs,
                stoneProduced,
                false
            );
        }
        return breakDecision(observation, geometry, nowMs, stoneProduced);
    }

    private Decision tickStaircase(
        Observation observation,
        GeometryProbe geometry,
        long nowMs,
        boolean stoneProduced
    ) {
        if (movementPhase != MovementPhase.NONE) {
            return tickCommittedLanding(observation, geometry, nowMs, stoneProduced);
        }

        List<StaircaseDescentPlanner.Step> steps = plan.selection().plannedStaircaseSteps();
        if (staircaseStepCursor >= steps.size()) {
            return terminal(
                Action.PLAN_EXHAUSTED,
                "staircase_sequence_exhausted",
                observation,
                nowMs,
                stoneProduced,
                false
            );
        }
        StaircaseDescentPlanner.Step step = steps.get(staircaseStepCursor);
        VoxelCell expectedOrigin = voxel(step.currentFeet());
        if (!observation.grounded()
            || !expectedOrigin.equals(observation.feet())
            || !safeStance(geometry, expectedOrigin)) {
            return reject("staircase_origin_invalid", observation, nowMs);
        }

        FrozenBreak next = nextBreak();
        if (next != null && next.stepIndex() == staircaseStepCursor) {
            return breakDecision(observation, geometry, nowMs, stoneProduced);
        }

        // The planner may touch one final partial step solely to obtain the exact remaining stone.
        // Its clearance is intentionally incomplete, so never manufacture descent progress from it.
        if (staircaseStepCursor >= plan.selection().completedStaircaseSteps()) {
            return terminal(
                Action.PLAN_EXHAUSTED,
                "exact_break_prefix_exhausted",
                observation,
                nowMs,
                stoneProduced,
                false
            );
        }

        // A plan may deliberately end after the exact stone-producing prefix in the middle of a
        // step. Do not clear extra blocks merely to obtain predicted future depth progress.
        String envelopeReason = clearedStepEnvelopeReason(step, geometry);
        if (!envelopeReason.isBlank()) {
            if (breakCursor >= breaks.size()) {
                return terminal(
                    Action.PLAN_EXHAUSTED,
                    "exact_break_prefix_exhausted",
                    observation,
                    nowMs,
                    stoneProduced,
                    false
                );
            }
            return reject(envelopeReason, observation, nowMs);
        }
        VoxelCell landing = voxel(step.nextFeet());
        if (!safeStance(geometry, landing)) {
            return reject("staircase_landing_invalid", observation, nowMs);
        }
        movementPhase = MovementPhase.SELECTED;
        movementOrigin = expectedOrigin;
        movementLanding = landing;
        movementSelectedAtMs = nowMs;
        movementDepartureObserved = false;
        movementLandingColumnCaptured = false;
        arrivalValidator.reset();
        return decision(
            Action.MOVE,
            null,
            null,
            landing,
            false,
            false,
            false,
            false,
            "staircase_movement:descent_selected",
            observation,
            nowMs,
            stoneProduced,
            false
        );
    }

    private Decision tickCommittedLanding(
        Observation observation,
        GeometryProbe geometry,
        long nowMs,
        boolean stoneProduced
    ) {
        if (movementOrigin == null || movementLanding == null) {
            return reject("staircase_movement:state_invalid", observation, nowMs);
        }
        if (nowMs - movementSelectedAtMs >= STEP_LANDING_TIMEOUT_MS) {
            return reject("staircase_movement:descent_timeout", observation, nowMs);
        }
        if (!safeStance(geometry, movementLanding)) {
            return reject("staircase_movement:landing_invalid", observation, nowMs);
        }

        StanceState observedStance = safeStanceState(geometry, observation.feet());
        double horizontalDistance = horizontalDistance(observation, movementLanding);
        boolean atLandingCell = movementLanding.equals(observation.feet());
        boolean atLandingY = observation.feet().y() == movementLanding.y();
        // A player can cross the landing X/Z while still standing at the origin height. That is a
        // valid launch transient, not an arrival observation. Exact canonical Y is required before
        // the arrival validator may suppress or credit a landing; a grounded exact step-down remains
        // accepted even when no airborne sample was observed.
        if (atLandingCell
            || movementDepartureObserved
                && atLandingY
                && horizontalDistance <= LANDING_HORIZONTAL_EPSILON) {
            boolean landingColumnCapturedNow = !movementLandingColumnCaptured;
            movementLandingColumnCaptured = true;
            DescentStepArrivalValidator.Decision arrival = arrivalValidator.tick(
                movementKey(),
                new DescentStepArrivalValidator.Observation(
                    movementLanding,
                    observation.feet(),
                    horizontalDistance,
                    LANDING_HORIZONTAL_EPSILON,
                    observation.grounded(),
                    observedStance.dry(),
                    observedStance.bodyClear(),
                    observedStance.hazardFree() && observedStance.adjacentLavaFree(),
                    observedStance.stableSupport()
                )
            );
            if (arrival.status() == DescentStepArrivalValidator.Status.REACHED) {
                staircaseStepCursor++;
                clearMovement();
                return decision(
                    Action.HOLD,
                    null,
                    null,
                    observation.feet(),
                    false,
                    false,
                    false,
                    false,
                    "staircase_step_landed",
                    observation,
                    nowMs,
                    stoneProduced,
                    true
                );
            }
            if (arrival.status() == DescentStepArrivalValidator.Status.SUPPRESSED
                && observation.grounded()) {
                return reject(
                    "staircase_movement:" + arrival.reason(), observation, nowMs);
            }
            movementDepartureObserved = movementDepartureObserved || departed(observation);
            movementPhase = MovementPhase.LAND_SETTLE;
            return movementDecision(
                observation,
                nowMs,
                stoneProduced,
                false,
                false,
                landingColumnCapturedNow
                    ? "descent_landing_column_captured"
                    : "descent_landing_settling"
            );
        }

        if (movementPhase == MovementPhase.SELECTED) {
            if (!safeAtMovementOrigin(observation, geometry)) {
                return reject("staircase_movement:origin_invalid", observation, nowMs);
            }
            movementPhase = MovementPhase.ALIGNING;
            return movementDecision(
                observation, nowMs, stoneProduced, false, false, "descent_aligning");
        }
        if (movementPhase == MovementPhase.ALIGNING) {
            if (!safeAtMovementOrigin(observation, geometry)) {
                return reject("staircase_movement:origin_invalid", observation, nowMs);
            }
            if (!observation.aligned()) {
                return movementDecision(
                    observation, nowMs, stoneProduced, false, false, "descent_aligning");
            }
            movementPhase = MovementPhase.LAUNCHING;
            return movementDecision(
                observation, nowMs, stoneProduced, true, true, "descent_launching");
        }

        boolean departedNow = departed(observation);
        if (departedNow) {
            movementDepartureObserved = true;
        }
        movementLandingColumnCaptured = movementLandingColumnCaptured
            || movementDepartureObserved && shouldCaptureLandingColumn(observation);
        if (movementLandingColumnCaptured) {
            if (!inLandingColumn(observation.feet())) {
                return observation.grounded()
                    ? reject("staircase_movement:descent_missed", observation, nowMs)
                    : reject("staircase_movement:transition_deviation", observation, nowMs);
            }
            if (observation.feet().y() < movementLanding.y()
                || observation.feet().y() > movementOrigin.y() + 1) {
                return observation.grounded()
                    ? reject("staircase_movement:descent_missed", observation, nowMs)
                    : reject("staircase_movement:transition_deviation", observation, nowMs);
            }
            movementPhase = observation.grounded()
                ? MovementPhase.LAUNCHING
                : MovementPhase.AIRBORNE;
            return movementDecision(
                observation,
                nowMs,
                stoneProduced,
                false,
                false,
                "descent_landing_column_captured"
            );
        }
        if (movementOrigin.equals(observation.feet())) {
            return movementDecision(
                observation, nowMs, stoneProduced, true, true, "descent_launching");
        }
        if (!observation.grounded() && onFrozenTransitionColumn(observation.feet())) {
            movementPhase = MovementPhase.AIRBORNE;
            return movementDecision(
                observation, nowMs, stoneProduced, true, true, "descent_airborne");
        }
        if (elevatedLandingColumn(observation.feet())) {
            movementPhase = MovementPhase.LAUNCHING;
            return movementDecision(
                observation, nowMs, stoneProduced, true, true, "descent_departed");
        }
        if (observation.grounded() && movementDepartureObserved) {
            return reject("staircase_movement:descent_missed", observation, nowMs);
        }
        return reject("staircase_movement:transition_deviation", observation, nowMs);
    }

    private Decision movementDecision(
        Observation observation,
        long nowMs,
        boolean stoneProduced,
        boolean forward,
        boolean descentExempt,
        String reason
    ) {
        return decision(
            Action.MOVE,
            null,
            null,
            movementLanding,
            forward,
            false,
            false,
            descentExempt,
            "staircase_movement:" + reason,
            observation,
            nowMs,
            stoneProduced,
            false
        );
    }

    private Decision breakDecision(
        Observation observation,
        GeometryProbe geometry,
        long nowMs,
        boolean stoneProduced
    ) {
        FrozenBreak target = nextBreak();
        if (target == null) {
            return reject("missing_break_target", observation, nowMs);
        }
        RuntimeBlock runtime = safeRuntimeBlock(geometry, target.position());
        boolean continuingAirConfirmation = target.position().equals(activeBreakTarget)
            && runtime.material() == RuntimeMaterial.AIR;
        if (!continuingAirConfirmation && !matches(target.material(), runtime.material())) {
            return reject("break_geometry_changed:" + runtime.material().name().toLowerCase(), observation, nowMs);
        }
        if (!continuingAirConfirmation
            && (!runtime.interactionReachable()
                || !runtime.lineOfSightClear()
                || runtime.interactionFace() == null)) {
            return reject("break_interaction_invalid", observation, nowMs);
        }
        activeBreakTarget = target.position();
        BlockBreakController.ValidatedNextBlockHint hint = validatedNextHint(geometry, target);
        return decision(
            Action.BREAK_BLOCK,
            target.position(),
            hint,
            null,
            false,
            false,
            false,
            false,
            continuingAirConfirmation ? "break_air_confirming" : "breaking_frozen_target",
            observation,
            nowMs,
            stoneProduced,
            false
        );
    }

    private BreakAdvance applyBreakFeedback(BreakFeedback feedback, GeometryProbe geometry) {
        if (feedback == null) {
            return BreakAdvance.NO_CHANGE;
        }
        if (activeBreakTarget == null || !activeBreakTarget.equals(feedback.requestedTarget())) {
            return new BreakAdvance(false, false, "stale_break_feedback");
        }
        if (feedback.status() == BlockBreakController.Status.RUNNING) {
            return BreakAdvance.NO_CHANGE;
        }
        if (feedback.status() == BlockBreakController.Status.REPOSITION) {
            return new BreakAdvance(false, false, "break_reposition_forbidden:" + feedback.reason());
        }
        if (feedback.status() == BlockBreakController.Status.FAILED) {
            return new BreakAdvance(false, false, "break_failed:" + feedback.reason());
        }
        RuntimeBlock after = safeRuntimeBlock(geometry, activeBreakTarget);
        if (after.material() != RuntimeMaterial.AIR) {
            return new BreakAdvance(false, false, "broken_block_not_air");
        }
        FrozenBreak cleared = nextBreak();
        if (cleared == null || !cleared.position().equals(activeBreakTarget)) {
            return new BreakAdvance(false, false, "break_cursor_mismatch");
        }
        boolean producedStone = cleared.material() == MissionStoneMethodPlanner.BreakMaterial.STONE;
        verifiedBreaks++;
        if (producedStone) {
            verifiedStoneProduced++;
        }
        breakCursor++;
        activeBreakTarget = null;
        return new BreakAdvance(true, producedStone, "verified");
    }

    private BlockBreakController.ValidatedNextBlockHint validatedNextHint(
        GeometryProbe geometry,
        FrozenBreak current
    ) {
        int nextIndex = breakCursor + 1;
        if (nextIndex >= breaks.size()) {
            return null;
        }
        FrozenBreak next = breaks.get(nextIndex);
        if (plan.selection().method() == MissionStoneMethodPlanner.Method.STAIRCASE
            && next.stepIndex() != current.stepIndex()) {
            return null;
        }
        RuntimeBlock state = safeRuntimeBlock(geometry, next.position());
        if (!matches(next.material(), state.material())
            || !state.interactionReachable()
            || !state.lineOfSightClear()
            || state.interactionFace() == null) {
            return null;
        }
        return new BlockBreakController.ValidatedNextBlockHint(
            next.position(),
            state.interactionFace(),
            blockIdentity(next.position())
        );
    }

    private String clearedStepEnvelopeReason(
        StaircaseDescentPlanner.Step step,
        GeometryProbe geometry
    ) {
        Set<BlockPos> unique = new HashSet<>();
        for (BlockPos cell : List.of(step.sightClear(), step.upperClear(), step.lowerClear())) {
            if (!unique.add(cell)) {
                continue;
            }
            if (safeRuntimeBlock(geometry, cell).material() != RuntimeMaterial.AIR) {
                return "staircase_envelope_not_clear";
            }
        }
        return "";
    }

    private Decision reject(String reason, Observation observation, long nowMs) {
        return terminal(Action.REJECTED, reason, observation, nowMs, false, false);
    }

    private Decision terminal(
        Action action,
        String reason,
        Observation observation,
        long nowMs,
        boolean stoneProduced,
        boolean stepLanded
    ) {
        Decision result = decision(
            action,
            null,
            null,
            null,
            false,
            false,
            false,
            false,
            reason,
            observation,
            nowMs,
            stoneProduced,
            stepLanded
        );
        clear();
        return result;
    }

    private Decision decision(
        Action action,
        BlockPos breakTarget,
        BlockBreakController.ValidatedNextBlockHint hint,
        VoxelCell waypoint,
        boolean forward,
        boolean jump,
        boolean sneak,
        boolean descentExempt,
        String reason,
        Observation observation,
        long nowMs,
        boolean stoneProduced,
        boolean stepLanded
    ) {
        int inventory = observation == null ? 0 : observation.authoritativeCobblestone();
        return new Decision(
            action,
            plan == null ? null : plan.selection().method(),
            breakTarget,
            hint,
            breakerCommandId,
            gestureIdentity,
            waypoint,
            forward,
            jump,
            sneak,
            descentExempt,
            reason,
            breakCursor,
            breaks.size(),
            staircaseStepCursor,
            verifiedBreaks,
            verifiedStoneProduced,
            stoneProduced,
            stepLanded,
            movementPhase,
            inventory,
            completionCobblestone,
            Math.max(0L, nowMs - startedAtMs),
            Math.max(0L, deadlineAtMs - nowMs)
        );
    }

    private Decision idleDecision() {
        return new Decision(
            Action.IDLE,
            null,
            null,
            null,
            "",
            "",
            null,
            false,
            false,
            false,
            false,
            "inactive",
            0,
            0,
            0,
            0,
            0,
            false,
            false,
            MovementPhase.NONE,
            0,
            0,
            0L,
            0L
        );
    }

    private static String validateFrozenPlan(FrozenPlan frozen) {
        MissionStoneMethodPlanner.Plan selection = frozen.selection();
        if (selection.plannedBreaks() < 1) {
            return "empty_break_prefix";
        }
        if (selection.method() == MissionStoneMethodPlanner.Method.REACHABLE_FACE
            || selection.method() == MissionStoneMethodPlanner.Method.SAFE_DROP) {
            List<BlockPos> blocks = selection.plannedFaceBlocks();
            if (blocks.isEmpty()
                || blocks.size() > MAX_FACE_BLOCKS
                || selection.plannedBreaks() != blocks.size()
                || new HashSet<>(blocks).size() != blocks.size()) {
                return "invalid_face_sequence";
            }
            return "";
        }
        List<StaircaseDescentPlanner.Step> steps = selection.plannedStaircaseSteps();
        List<MissionStoneMethodPlanner.BreakCell> cells = selection.plannedStaircaseBreaks();
        if (steps.isEmpty()
            || steps.size() > MAX_STAIR_STEPS
            || cells.isEmpty()
            || selection.plannedBreaks() != cells.size()
            || selection.completedStaircaseSteps() > steps.size()) {
            return "invalid_staircase_sequence";
        }
        int dx = 0;
        int dz = 0;
        Set<BlockPos> allowed = new HashSet<>();
        for (int index = 0; index < steps.size(); index++) {
            StaircaseDescentPlanner.Step step = steps.get(index);
            if (step == null || StaircaseDescentPlanner.targetsSelfSupport(step)) {
                return "unsafe_staircase_step";
            }
            int stepDx = step.nextFeet().getX() - step.currentFeet().getX();
            int stepDz = step.nextFeet().getZ() - step.currentFeet().getZ();
            if (Math.abs(stepDx) + Math.abs(stepDz) != 1
                || step.nextFeet().getY() != step.currentFeet().getY() - 1) {
                return "noncanonical_staircase_step";
            }
            if (index == 0) {
                dx = stepDx;
                dz = stepDz;
            } else if (stepDx != dx
                || stepDz != dz
                || !steps.get(index - 1).nextFeet().equals(step.currentFeet())) {
                return "staircase_heading_changed";
            }
            allowed.add(step.sightClear());
            allowed.add(step.upperClear());
            allowed.add(step.lowerClear());
        }
        Set<BlockPos> unique = new HashSet<>();
        for (MissionStoneMethodPlanner.BreakCell cell : cells) {
            if (cell == null
                || cell.position() == null
                || !unique.add(cell.position())
                || !allowed.contains(cell.position())
                || (cell.material() != MissionStoneMethodPlanner.BreakMaterial.STONE
                    && cell.material() != MissionStoneMethodPlanner.BreakMaterial.SAFE_NON_ORE)) {
                return "invalid_staircase_break_cell";
            }
        }
        return "";
    }

    private static List<FrozenBreak> freezeBreakPrefix(FrozenPlan frozen) {
        int count = frozen.selection().plannedBreaks();
        List<FrozenBreak> result = new ArrayList<>(count);
        if (frozen.selection().method() == MissionStoneMethodPlanner.Method.REACHABLE_FACE
            || frozen.selection().method() == MissionStoneMethodPlanner.Method.SAFE_DROP) {
            for (int index = 0; index < count; index++) {
                result.add(new FrozenBreak(
                    frozen.selection().plannedFaceBlocks().get(index).toImmutable(),
                    MissionStoneMethodPlanner.BreakMaterial.STONE,
                    -1
                ));
            }
            return List.copyOf(result);
        }
        Map<BlockPos, Integer> owner = stepIndexByBreakCell(frozen.selection().plannedStaircaseSteps());
        for (int index = 0; index < count; index++) {
            MissionStoneMethodPlanner.BreakCell cell = frozen.selection().plannedStaircaseBreaks().get(index);
            result.add(new FrozenBreak(
                cell.position().toImmutable(),
                cell.material(),
                owner.getOrDefault(cell.position(), -1)
            ));
        }
        return List.copyOf(result);
    }

    private FrozenBreak nextBreak() {
        return breakCursor >= 0 && breakCursor < breaks.size() ? breaks.get(breakCursor) : null;
    }

    private static Map<BlockPos, Integer> stepIndexByBreakCell(
        List<StaircaseDescentPlanner.Step> steps
    ) {
        Map<BlockPos, Integer> owner = new HashMap<>();
        for (int index = 0; index < steps.size(); index++) {
            StaircaseDescentPlanner.Step step = steps.get(index);
            owner.putIfAbsent(step.sightClear(), index);
            owner.putIfAbsent(step.upperClear(), index);
            owner.putIfAbsent(step.lowerClear(), index);
        }
        return owner;
    }

    private static boolean matches(
        MissionStoneMethodPlanner.BreakMaterial expected,
        RuntimeMaterial actual
    ) {
        return (expected == MissionStoneMethodPlanner.BreakMaterial.STONE
                && actual == RuntimeMaterial.STONE)
            || (expected == MissionStoneMethodPlanner.BreakMaterial.SAFE_NON_ORE
                && actual == RuntimeMaterial.SAFE_NON_ORE);
    }

    private static RuntimeBlock safeRuntimeBlock(GeometryProbe geometry, BlockPos position) {
        RuntimeBlock result = geometry == null || position == null ? null : geometry.block(position);
        return result == null
            ? new RuntimeBlock(RuntimeMaterial.UNKNOWN_SOLID, false, false, null)
            : result;
    }

    private static StanceState safeStanceState(GeometryProbe geometry, VoxelCell feet) {
        StanceState result = geometry == null || feet == null ? null : geometry.stance(feet);
        return result == null
            ? new StanceState(false, false, false, false, false)
            : result;
    }

    private static boolean safeStance(GeometryProbe geometry, VoxelCell feet) {
        return safeStanceState(geometry, feet).hardSafe();
    }

    private boolean safeAtMovementOrigin(Observation observation, GeometryProbe geometry) {
        return observation != null
            && observation.grounded()
            && movementOrigin != null
            && movementOrigin.equals(observation.feet())
            && safeStance(geometry, movementOrigin);
    }

    private boolean departed(Observation observation) {
        if (observation == null || observation.feet() == null || movementOrigin == null) {
            return false;
        }
        if (!observation.grounded() || !movementOrigin.equals(observation.feet())) {
            return true;
        }
        double dx = observation.x() - (movementOrigin.x() + 0.5D);
        double dz = observation.z() - (movementOrigin.z() + 0.5D);
        return Math.hypot(dx, dz) >= DEPARTURE_PROGRESS_EPSILON;
    }

    private boolean onFrozenTransitionColumn(VoxelCell feet) {
        if (feet == null || movementOrigin == null || movementLanding == null) {
            return false;
        }
        boolean originColumn = feet.x() == movementOrigin.x() && feet.z() == movementOrigin.z();
        boolean landingColumn = feet.x() == movementLanding.x() && feet.z() == movementLanding.z();
        return (originColumn || landingColumn)
            && feet.y() >= movementLanding.y()
            && feet.y() <= movementOrigin.y() + 1;
    }

    private boolean elevatedLandingColumn(VoxelCell feet) {
        return feet != null
            && movementOrigin != null
            && movementLanding != null
            && feet.x() == movementLanding.x()
            && feet.z() == movementLanding.z()
            && feet.y() == movementOrigin.y();
    }

    private boolean shouldCaptureLandingColumn(Observation observation) {
        if (observation == null || !inLandingColumn(observation.feet())) {
            return false;
        }
        return !observation.grounded()
            || observation.feet().y() < movementOrigin.y()
            || clearsOriginSupport(
                movementOrigin,
                movementLanding,
                observation.x(),
                observation.z()
            );
    }

    private boolean inLandingColumn(VoxelCell feet) {
        return feet != null
            && movementLanding != null
            && feet.x() == movementLanding.x()
            && feet.z() == movementLanding.z();
    }

    /** True only after the player's trailing edge has completely cleared the origin support. */
    static boolean clearsOriginSupport(
        VoxelCell origin,
        VoxelCell landing,
        double x,
        double z
    ) {
        if (origin == null
            || landing == null
            || !Double.isFinite(x)
            || !Double.isFinite(z)) {
            return false;
        }
        int deltaX = landing.x() - origin.x();
        int deltaZ = landing.z() - origin.z();
        if (landing.y() != origin.y() - 1
            || Math.abs(deltaX) + Math.abs(deltaZ) != 1) {
            return false;
        }
        if (deltaX > 0) {
            return x - PLAYER_HALF_WIDTH
                >= origin.x() + 1.0D + ORIGIN_SUPPORT_CLEARANCE_MARGIN;
        }
        if (deltaX < 0) {
            return x + PLAYER_HALF_WIDTH
                <= origin.x() - ORIGIN_SUPPORT_CLEARANCE_MARGIN;
        }
        if (deltaZ > 0) {
            return z - PLAYER_HALF_WIDTH
                >= origin.z() + 1.0D + ORIGIN_SUPPORT_CLEARANCE_MARGIN;
        }
        return z + PLAYER_HALF_WIDTH
            <= origin.z() - ORIGIN_SUPPORT_CLEARANCE_MARGIN;
    }

    private static double horizontalDistance(Observation observation, VoxelCell target) {
        if (observation == null || target == null) {
            return Double.POSITIVE_INFINITY;
        }
        return Math.hypot(
            observation.x() - (target.x() + 0.5D),
            observation.z() - (target.z() + 0.5D)
        );
    }

    private String movementKey() {
        return key.commandId()
            + ":mission-stone-step:"
            + staircaseStepCursor
            + ":"
            + movementOrigin
            + "->"
            + movementLanding;
    }

    private void clearMovement() {
        movementPhase = MovementPhase.NONE;
        movementOrigin = null;
        movementLanding = null;
        movementSelectedAtMs = 0L;
        movementDepartureObserved = false;
        movementLandingColumnCaptured = false;
        arrivalValidator.reset();
    }

    private void clear() {
        clearMovement();
        key = null;
        plan = null;
        completionCobblestone = 0;
        startedAtMs = 0L;
        deadlineAtMs = 0L;
        breakerCommandId = "";
        gestureIdentity = "";
        breaks = List.of();
        breakCursor = 0;
        activeBreakTarget = null;
        verifiedBreaks = 0;
        verifiedStoneProduced = 0;
        staircaseStepCursor = 0;
    }

    private static String stableIdentity(String identity) {
        return identity == null || identity.isBlank()
            ? "plan"
            : identity.replaceAll("[^A-Za-z0-9_.-]", "_");
    }

    private static String blockIdentity(BlockPos position) {
        return "mission-stone:"
            + position.getX() + "," + position.getY() + "," + position.getZ();
    }

    private static VoxelCell voxel(BlockPos position) {
        return position == null
            ? null
            : new VoxelCell(position.getX(), position.getY(), position.getZ());
    }

    private static String requireText(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
        return value;
    }

    private record FrozenBreak(
        BlockPos position,
        MissionStoneMethodPlanner.BreakMaterial material,
        int stepIndex
    ) {
    }

    private record BreakAdvance(boolean accepted, boolean stoneProduced, String reason) {
        private static final BreakAdvance NO_CHANGE = new BreakAdvance(true, false, "unchanged");
    }
}
