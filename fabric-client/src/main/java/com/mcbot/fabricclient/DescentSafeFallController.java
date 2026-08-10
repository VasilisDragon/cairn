package com.mcbot.fabricclient;

/** Pure committed launch/airborne/landing state for one frozen descent safe-fall package. */
final class DescentSafeFallController {
    static final long ALIGN_TIMEOUT_MS = 2_000L;
    static final long LAUNCH_LANDING_TIMEOUT_MS = 3_000L;
    static final int REQUIRED_LANDING_POLLS = 2;
    static final double DEPARTURE_PROGRESS = 0.05D;
    // Safe-fall is an MQ pass-through action. A bounded analog nudge avoids carrying full walking
    // velocity through a deep fall while retaining the same forward-only launch authority.
    static final float LAUNCH_FORWARD_SCALE = 0.25F;
    static final double ORIGIN_SUPPORT_CLEARANCE_MARGIN = 0.01D;
    static final double MIN_PLAYER_HALF_WIDTH = 0.1D;
    static final double MAX_PLAYER_HALF_WIDTH = 1.0D;

    enum Phase {
        SELECTED,
        CLEARING,
        ALIGNING,
        LAUNCHING,
        AIRBORNE,
        LAND_SETTLE,
        LANDED,
        REJECTED
    }

    enum Action {
        HOLD,
        CLEAR_BLOCKER,
        ALIGN,
        HOLD_FORWARD,
        HOLD_AIRBORNE,
        LANDED,
        REJECTED
    }

    enum ClearanceStatus {
        NONE,
        RUNNING,
        VERIFIED,
        FAILED
    }

    record StartRequest(
        String commandId,
        Object worldIdentity,
        DescentSafeFallLaunchPlanner.Plan plan,
        double startX,
        double startZ,
        double playerHalfWidth,
        float health,
        long nowMs
    ) {
    }

    record Observation(
        long nowMs,
        Object worldIdentity,
        VoxelCell feet,
        double x,
        double z,
        boolean grounded,
        boolean dry,
        boolean bodyClear,
        boolean hazardFree,
        boolean supportStable,
        boolean aligned,
        float health,
        ClearanceStatus clearanceStatus,
        VoxelCell clearanceCell,
        boolean packageValid,
        double landingHorizontalDistance,
        double arrivalEpsilon
    ) {
        Observation {
            clearanceStatus = clearanceStatus == null ? ClearanceStatus.NONE : clearanceStatus;
        }
    }

    record Decision(
        Phase phase,
        Action action,
        DescentSafeFallLaunchPlanner.Plan plan,
        VoxelCell clearanceCell,
        String reason,
        boolean transitioned,
        boolean departed,
        boolean columnCaptured,
        boolean expectedDamageLatched,
        int stableLandingPolls,
        long remainingMs
    ) {
        Decision {
            reason = reason == null ? "" : reason;
        }
    }

    private String commandId;
    private Object worldIdentity;
    private DescentSafeFallLaunchPlanner.Plan plan;
    private Phase phase;
    private double startX;
    private double startZ;
    private double playerHalfWidth;
    private float healthAtSelection;
    private long phaseStartedAtMs;
    private long launchStartedAtMs;
    private int clearanceIndex;
    private boolean departed;
    private boolean airborneObserved;
    private boolean columnCaptured;
    private int stableLandingPolls;
    private String terminalReason = "";
    private String pendingPostDepartureReason = "";

    Decision start(StartRequest request) {
        clear();
        if (request == null
            || request.commandId() == null
            || request.commandId().isBlank()
            || request.worldIdentity() == null
            || request.plan() == null
            || !Double.isFinite(request.startX())
            || !Double.isFinite(request.startZ())
            || !Double.isFinite(request.playerHalfWidth())
            || request.playerHalfWidth() < MIN_PLAYER_HALF_WIDTH
            || request.playerHalfWidth() > MAX_PLAYER_HALF_WIDTH
            || !Float.isFinite(request.health())) {
            phase = Phase.REJECTED;
            terminalReason = "invalid_start";
            return decision(Action.REJECTED, terminalReason, true, request == null ? 0L : request.nowMs());
        }
        commandId = request.commandId();
        worldIdentity = request.worldIdentity();
        plan = request.plan();
        startX = request.startX();
        startZ = request.startZ();
        playerHalfWidth = request.playerHalfWidth();
        healthAtSelection = request.health();
        phaseStartedAtMs = request.nowMs();
        phase = Phase.SELECTED;
        return decision(Action.HOLD, "selected", true, request.nowMs());
    }

    Decision tick(Observation observation) {
        long nowMs = observation == null ? 0L : observation.nowMs();
        if (!active()) {
            return rejectedDecision("inactive", nowMs, false);
        }
        if (phase == Phase.LANDED) {
            return decision(Action.LANDED, terminalReason, false, nowMs);
        }
        if (phase == Phase.REJECTED) {
            return decision(Action.REJECTED, terminalReason, false, nowMs);
        }
        if (observation == null
            || observation.worldIdentity() != worldIdentity
            || observation.feet() == null
            || !Double.isFinite(observation.x())
            || !Double.isFinite(observation.z())
            || !Float.isFinite(observation.health())
            || !Double.isFinite(observation.landingHorizontalDistance())
            || !Double.isFinite(observation.arrivalEpsilon())
            || observation.arrivalEpsilon() < 0.0D) {
            return reject("lifecycle_changed", nowMs);
        }
        if (!departed
            && phase != Phase.LAUNCHING
            && observation.health() + 0.001F < healthAtSelection) {
            return reject("prelaunch_health_loss", nowMs);
        }

        return switch (phase) {
            case SELECTED -> beginSelected(observation);
            case CLEARING -> tickClearing(observation);
            case ALIGNING -> tickAligning(observation);
            case LAUNCHING -> tickLaunching(observation);
            case AIRBORNE -> tickAirborne(observation);
            case LAND_SETTLE -> tickLandSettle(observation);
            case LANDED -> decision(Action.LANDED, terminalReason, false, nowMs);
            case REJECTED -> decision(Action.REJECTED, terminalReason, false, nowMs);
        };
    }

    private Decision beginSelected(Observation observation) {
        if (!observation.packageValid()) {
            return reject("geometry_invalidated", observation.nowMs());
        }
        if (!atOrigin(observation) || !validOrigin(observation)) {
            return reject("origin_invalidated", observation.nowMs());
        }
        phaseStartedAtMs = observation.nowMs();
        if (!plan.clearanceCells().isEmpty()) {
            phase = Phase.CLEARING;
            return decision(Action.CLEAR_BLOCKER, "clearance_started", true, observation.nowMs());
        }
        phase = Phase.ALIGNING;
        return decision(Action.ALIGN, "aligning", true, observation.nowMs());
    }

    private Decision tickClearing(Observation observation) {
        if (!atOrigin(observation) || !validOrigin(observation)) {
            return reject("origin_invalidated_during_clearance", observation.nowMs());
        }
        VoxelCell activeClearance = activeClearanceCell();
        if (activeClearance == null) {
            phase = Phase.ALIGNING;
            phaseStartedAtMs = observation.nowMs();
            return decision(Action.ALIGN, "clearance_complete", true, observation.nowMs());
        }
        if (observation.clearanceStatus() == ClearanceStatus.FAILED) {
            return reject("clearance_failed", observation.nowMs());
        }
        if (observation.clearanceStatus() == ClearanceStatus.VERIFIED) {
            if (!activeClearance.equals(observation.clearanceCell())) {
                return reject("clearance_cell_mismatch", observation.nowMs());
            }
            if (!observation.packageValid()) {
                return reject("geometry_invalidated_after_clearance", observation.nowMs());
            }
            clearanceIndex++;
            if (activeClearanceCell() != null) {
                return decision(Action.CLEAR_BLOCKER, "clearance_advanced", true, observation.nowMs());
            }
            phase = Phase.ALIGNING;
            phaseStartedAtMs = observation.nowMs();
            return decision(Action.ALIGN, "clearance_complete", true, observation.nowMs());
        }
        return decision(Action.CLEAR_BLOCKER, "clearing", false, observation.nowMs());
    }

    private Decision tickAligning(Observation observation) {
        if (!observation.packageValid()) {
            return reject("geometry_invalidated_before_launch", observation.nowMs());
        }
        if (!atOrigin(observation) || !validOrigin(observation)) {
            return reject("origin_invalidated_before_launch", observation.nowMs());
        }
        if (observation.nowMs() - phaseStartedAtMs >= ALIGN_TIMEOUT_MS) {
            return reject("alignment_timeout", observation.nowMs());
        }
        if (observation.aligned()) {
            phase = Phase.LAUNCHING;
            phaseStartedAtMs = observation.nowMs();
            launchStartedAtMs = observation.nowMs();
            return decision(Action.HOLD_FORWARD, "launch_started", true, observation.nowMs());
        }
        return decision(Action.ALIGN, "aligning", false, observation.nowMs());
    }

    private Decision tickLaunching(Observation observation) {
        boolean departureObserved = departureObserved(observation);
        if (!departureObserved && !observation.packageValid()) {
            return reject("geometry_invalidated_before_departure", observation.nowMs());
        }
        // The launch/landing window is non-resetting. A late first observation may not
        // manufacture an on-time departure or grounded step-down merely because success was
        // sampled before the timeout branch.
        if (launchLandingTimedOut(observation)) {
            return reject("launch_timeout", observation.nowMs());
        }
        if (!departureObserved
            && observation.health() + 0.001F < healthAtSelection) {
            return reject("prelaunch_health_loss", observation.nowMs());
        }
        if (departureObserved) {
            departed = true;
            phase = Phase.AIRBORNE;
            phaseStartedAtMs = observation.nowMs();
            airborneObserved = !observation.grounded()
                || observation.feet().y() < plan.origin().y();
            columnCaptured = shouldCaptureLandingColumn(observation);
            latchPostDepartureFailure(observation);
            if (validLanding(observation)) {
                return beginLandSettle(observation, "grounded_step_down");
            }
            if (observation.grounded()
                && !atOrigin(observation)
                && !groundedLaunchTransit(observation)) {
                return reject(
                    plan.landing().equals(observation.feet())
                        ? "landing_invalid"
                        : "off_target_landing",
                    observation.nowMs()
                );
            }
            return decision(
                columnCaptured ? Action.HOLD_AIRBORNE : Action.HOLD_FORWARD,
                observation.grounded() ? "departed_grounded" : "departed_airborne",
                true,
                observation.nowMs()
            );
        }
        return decision(Action.HOLD_FORWARD, "launch_hold", false, observation.nowMs());
    }

    private Decision tickAirborne(Observation observation) {
        latchPostDepartureFailure(observation);
        // Landing must first be observed inside the original window. LAND_SETTLE remains
        // governed by that same non-resetting deadline.
        if (launchLandingTimedOut(observation)) {
            return reject("landing_timeout", observation.nowMs());
        }
        airborneObserved = airborneObserved
            || !observation.grounded()
            || observation.feet().y() < plan.origin().y();
        columnCaptured = columnCaptured
            || shouldCaptureLandingColumn(observation);
        if (validLanding(observation)) {
            return beginLandSettle(observation, "landing_observed");
        }
        if (observation.grounded()
            && !atOrigin(observation)
            && !groundedLaunchTransit(observation)) {
            return reject(
                plan.landing().equals(observation.feet())
                    ? "landing_invalid"
                    : "off_target_landing",
                observation.nowMs()
            );
        }
        return decision(
            columnCaptured ? Action.HOLD_AIRBORNE : Action.HOLD_FORWARD,
            columnCaptured ? "column_captured" : "airborne_forward",
            false,
            observation.nowMs()
        );
    }

    private Decision tickLandSettle(Observation observation) {
        latchPostDepartureFailure(observation);
        if (launchLandingTimedOut(observation)) {
            return reject("landing_timeout", observation.nowMs());
        }
        if (!validLanding(observation)) {
            stableLandingPolls = 0;
            if (!observation.grounded() && inLandingColumn(observation.feet())) {
                phase = Phase.AIRBORNE;
                return decision(Action.HOLD_AIRBORNE, "landing_poll_reset", true, observation.nowMs());
            }
            return reject(
                inLandingColumn(observation.feet()) ? "landing_invalid" : "off_target_landing",
                observation.nowMs()
            );
        }
        stableLandingPolls++;
        if (stableLandingPolls >= REQUIRED_LANDING_POLLS) {
            if (!pendingPostDepartureReason.isBlank()) {
                return rejectAfterSafeLanding(
                    pendingPostDepartureReason, observation.nowMs());
            }
            phase = Phase.LANDED;
            terminalReason = "landed";
            return decision(Action.LANDED, terminalReason, true, observation.nowMs());
        }
        return decision(Action.HOLD_AIRBORNE, "landing_settle", false, observation.nowMs());
    }

    private void latchPostDepartureFailure(Observation observation) {
        if (!departed || !pendingPostDepartureReason.isBlank()) {
            return;
        }
        if (observation.health() + 0.001F < healthAtSelection) {
            pendingPostDepartureReason = "postdeparture_health_loss";
        } else if (!observation.packageValid()) {
            pendingPostDepartureReason = "geometry_invalidated_after_departure";
        }
    }

    private Decision beginLandSettle(Observation observation, String reason) {
        phase = Phase.LAND_SETTLE;
        stableLandingPolls = 1;
        columnCaptured = true;
        return decision(Action.HOLD_AIRBORNE, reason, true, observation.nowMs());
    }

    private boolean launchLandingTimedOut(Observation observation) {
        return launchStartedAtMs <= 0L
            || observation.nowMs() - launchStartedAtMs >= LAUNCH_LANDING_TIMEOUT_MS;
    }

    private boolean departureObserved(Observation observation) {
        if (!observation.grounded() || !plan.origin().equals(observation.feet())) {
            return true;
        }
        return projectedLaunchProgress(observation) >= DEPARTURE_PROGRESS;
    }

    private double projectedLaunchProgress(Observation observation) {
        int deltaX = plan.launchFeet().x() - plan.origin().x();
        int deltaY = plan.launchFeet().y() - plan.origin().y();
        int deltaZ = plan.launchFeet().z() - plan.origin().z();
        if (deltaY != 0 || Math.abs(deltaX) + Math.abs(deltaZ) != 1) {
            return 0.0D;
        }
        int directionX = Integer.signum(deltaX);
        int directionZ = Integer.signum(deltaZ);
        return (observation.x() - startX) * directionX
            + (observation.z() - startZ) * directionZ;
    }

    private boolean shouldCaptureLandingColumn(Observation observation) {
        if (!inLandingColumn(observation.feet())) {
            return false;
        }
        return airborneObserved
            || observation.feet().y() < plan.origin().y()
            || clearsOriginSupport(plan, observation.x(), observation.z(), playerHalfWidth);
    }

    /** True only after the player's trailing edge has completely cleared the origin support. */
    static boolean clearsOriginSupport(
        DescentSafeFallLaunchPlanner.Plan plan,
        double x,
        double z,
        double halfWidth
    ) {
        if (plan == null
            || !Double.isFinite(x)
            || !Double.isFinite(z)
            || !Double.isFinite(halfWidth)
            || halfWidth < MIN_PLAYER_HALF_WIDTH
            || halfWidth > MAX_PLAYER_HALF_WIDTH) {
            return false;
        }
        int deltaX = plan.launchFeet().x() - plan.origin().x();
        int deltaY = plan.launchFeet().y() - plan.origin().y();
        int deltaZ = plan.launchFeet().z() - plan.origin().z();
        if (deltaY != 0 || Math.abs(deltaX) + Math.abs(deltaZ) != 1) {
            return false;
        }
        int directionX = Integer.signum(deltaX);
        int directionZ = Integer.signum(deltaZ);
        if (directionX != 0 && directionZ == 0) {
            return directionX > 0
                ? x - halfWidth >= plan.origin().x() + 1.0D + ORIGIN_SUPPORT_CLEARANCE_MARGIN
                : x + halfWidth <= plan.origin().x() - ORIGIN_SUPPORT_CLEARANCE_MARGIN;
        }
        if (directionZ != 0 && directionX == 0) {
            return directionZ > 0
                ? z - halfWidth >= plan.origin().z() + 1.0D + ORIGIN_SUPPORT_CLEARANCE_MARGIN
                : z + halfWidth <= plan.origin().z() - ORIGIN_SUPPORT_CLEARANCE_MARGIN;
        }
        return false;
    }

    private boolean validOrigin(Observation observation) {
        return observation.grounded()
            && observation.dry()
            && observation.bodyClear()
            && observation.hazardFree()
            && observation.supportStable();
    }

    private boolean validLanding(Observation observation) {
        return plan.landing().equals(observation.feet())
            && observation.landingHorizontalDistance() <= observation.arrivalEpsilon()
            && observation.grounded()
            && observation.dry()
            && observation.bodyClear()
            && observation.hazardFree()
            && observation.supportStable();
    }

    private boolean atOrigin(Observation observation) {
        return plan.origin().equals(observation.feet());
    }

    private boolean groundedLaunchTransit(Observation observation) {
        return !airborneObserved
            && observation.grounded()
            && plan.launchFeet().equals(observation.feet())
            && observation.feet().y() == plan.origin().y()
            && observation.dry()
            && observation.bodyClear()
            && observation.hazardFree();
    }

    private boolean inLandingColumn(VoxelCell feet) {
        return feet != null
            && feet.x() == plan.dropColumn().x()
            && feet.z() == plan.dropColumn().z();
    }

    private VoxelCell activeClearanceCell() {
        return plan == null || clearanceIndex < 0 || clearanceIndex >= plan.clearanceCells().size()
            ? null
            : plan.clearanceCells().get(clearanceIndex);
    }

    private Decision reject(String reason, long nowMs) {
        phase = Phase.REJECTED;
        terminalReason = reason == null ? "rejected" : reason;
        pendingPostDepartureReason = "";
        stableLandingPolls = 0;
        return decision(Action.REJECTED, terminalReason, true, nowMs);
    }

    private Decision rejectAfterSafeLanding(String reason, long nowMs) {
        phase = Phase.REJECTED;
        terminalReason = reason == null ? "rejected_after_landing" : reason;
        pendingPostDepartureReason = "";
        return decision(Action.REJECTED, terminalReason, true, nowMs);
    }

    private Decision rejectedDecision(String reason, long nowMs, boolean transitioned) {
        return new Decision(
            Phase.REJECTED,
            Action.REJECTED,
            null,
            null,
            reason,
            transitioned,
            false,
            false,
            false,
            0,
            0L
        );
    }

    private Decision decision(Action action, String reason, boolean transitioned, long nowMs) {
        long remaining = launchStartedAtMs <= 0L
            ? 0L
            : Math.max(0L, LAUNCH_LANDING_TIMEOUT_MS - Math.max(0L, nowMs - launchStartedAtMs));
        return new Decision(
            phase,
            action,
            plan,
            activeClearanceCell(),
            reason,
            transitioned,
            departed,
            columnCaptured,
            departed,
            stableLandingPolls,
            remaining
        );
    }

    void clear() {
        commandId = null;
        worldIdentity = null;
        plan = null;
        phase = null;
        startX = 0.0D;
        startZ = 0.0D;
        playerHalfWidth = 0.0D;
        healthAtSelection = 0.0F;
        phaseStartedAtMs = 0L;
        launchStartedAtMs = 0L;
        clearanceIndex = 0;
        departed = false;
        airborneObserved = false;
        columnCaptured = false;
        stableLandingPolls = 0;
        terminalReason = "";
        pendingPostDepartureReason = "";
    }

    Phase phase() {
        return phase;
    }

    boolean active() {
        return plan != null && phase != null;
    }

    boolean departed() {
        return departed;
    }

    /**
     * True once physical launch output has been committed and until the caller has published the
     * grounded terminal result. Post-departure health and geometry failures are published only
     * after a stable landing and remain committed until integration consumes that result.
     */
    boolean committedMovementActive() {
        if (phase == null) {
            return false;
        }
        return phase == Phase.LAUNCHING
            || phase == Phase.AIRBORNE
            || phase == Phase.LAND_SETTLE
            || (departed && (phase == Phase.LANDED || phase == Phase.REJECTED));
    }

    long launchStartedAtMs() {
        return launchStartedAtMs;
    }

    int clearanceIndex() {
        return clearanceIndex;
    }
}
