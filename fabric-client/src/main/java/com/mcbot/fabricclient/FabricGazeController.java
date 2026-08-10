package com.mcbot.fabricclient;

final class FabricGazeController {
    static final double MIN_DT_SECONDS = 0.010D;
    static final double MAX_DT_SECONDS = 0.100D;
    static final double RESUME_DT_SECONDS = 0.050D;
    static final long LONG_GAP_MS = 250L;
    static final long PRECISION_COMMITMENT_MS = 500L;
    static final double SETTLE_ANGLE_DEGREES = 0.7D;
    static final double SETTLE_SPEED_DEGREES_PER_SECOND = 8.0D;
    private static final double EPSILON = 1.0E-9D;
    private static final double PROFILE_LIMIT_EPSILON = 1.0E-6D;

    record State(
        boolean initialized,
        long lastTickMs,
        double yawVelocity,
        double pitchVelocity,
        LookDemand effectiveDemand,
        long commitmentUntilMs,
        int settlePolls,
        boolean settled,
        LookDemand.Profile speedEnvelopeProfile
    ) {
        static State initial() {
            return new State(false, 0L, 0.0D, 0.0D, null, 0L, 0, false, null);
        }
    }

    record Output(
        double yaw,
        double pitch,
        boolean write,
        boolean targetChanged,
        boolean targetSuppressed,
        boolean settled,
        boolean settledNow,
        boolean criticalImmediate,
        boolean longGapReset,
        double angularSpeed,
        double angularAcceleration,
        double remainingAngle,
        int outputReversals,
        int uncommandedReversals,
        LookDemand.Profile speedEnvelopeProfile,
        boolean profileTransition,
        double requestedProfileSpeedExcess,
        boolean profileAccountingViolation
    ) {
    }

    record Transition(State state, Output output) {
    }

    private record DemandSelection(
        LookDemand demand,
        long commitmentUntilMs,
        boolean targetChanged,
        boolean scopeChanged,
        boolean suppressed
    ) {
    }

    private record Velocity(double yaw, double pitch) {
        double magnitude() {
            return Math.hypot(yaw, pitch);
        }
    }

    private record SpeedEnvelopeAccounting(
        LookDemand.Profile profile,
        boolean transition,
        double requestedProfileSpeedExcess,
        boolean violation
    ) {
    }

    private FabricGazeController() {
    }

    static State initialState() {
        return State.initial();
    }

    static Transition step(
        State previous,
        double currentYaw,
        double currentPitch,
        LookDemand rawDemand,
        long nowMs
    ) {
        State prior = previous == null ? State.initial() : previous;
        if (!Double.isFinite(currentYaw) || !Double.isFinite(currentPitch)) {
            throw new IllegalArgumentException("current look angles must be finite");
        }
        if (rawDemand == null) {
            throw new IllegalArgumentException("look demand must not be null");
        }

        double safeCurrentYaw = LookController.normalizeYaw(currentYaw);
        double safeCurrentPitch = clamp(currentPitch, -90.0D, 90.0D);
        DemandSelection selection = selectDemand(prior, rawDemand, nowMs);
        LookDemand demand = selection.demand();

        boolean longGapReset = prior.initialized()
            && (nowMs - prior.lastTickMs() > LONG_GAP_MS || nowMs < prior.lastTickMs());
        double dt = elapsedSeconds(prior, nowMs, longGapReset);
        Velocity oldVelocity = longGapReset
            ? new Velocity(0.0D, 0.0D)
            : new Velocity(prior.yawVelocity(), prior.pitchVelocity());

        double yawError = LookController.shortestYawDelta(safeCurrentYaw, demand.desiredYaw());
        double pitchError = demand.desiredPitch() - safeCurrentPitch;
        double remaining = Math.hypot(yawError, pitchError);
        boolean sameEffectiveTarget = prior.effectiveDemand() != null
            && prior.effectiveDemand().targetIdentity().equals(demand.targetIdentity())
            && prior.effectiveDemand().sameCommitmentScope(demand);

        if (demand.profile() == LookDemand.Profile.CRITICAL) {
            boolean changed = remaining > EPSILON
                || !prior.settled()
                || selection.targetChanged()
                || selection.scopeChanged();
            State next = new State(
                true,
                nowMs,
                0.0D,
                0.0D,
                demand,
                0L,
                2,
                true,
                LookDemand.Profile.CRITICAL
            );
            Output output = new Output(
                demand.desiredYaw(),
                demand.desiredPitch(),
                changed,
                selection.targetChanged(),
                selection.suppressed(),
                true,
                changed,
                changed,
                longGapReset,
                0.0D,
                0.0D,
                0.0D,
                0,
                0,
                LookDemand.Profile.CRITICAL,
                false,
                0.0D,
                false
            );
            return new Transition(next, output);
        }

        boolean demandMovedOutsideDeadband = remaining > SETTLE_ANGLE_DEGREES;
        if (prior.settled() && sameEffectiveTarget && !selection.scopeChanged() && !demandMovedOutsideDeadband) {
            State next = new State(
                true,
                nowMs,
                0.0D,
                0.0D,
                demand,
                selection.commitmentUntilMs(),
                2,
                true,
                demand.profile()
            );
            Output output = new Output(
                safeCurrentYaw,
                safeCurrentPitch,
                false,
                selection.targetChanged(),
                selection.suppressed(),
                true,
                false,
                false,
                longGapReset,
                0.0D,
                0.0D,
                remaining,
                0,
                0,
                demand.profile(),
                false,
                0.0D,
                false
            );
            return new Transition(next, output);
        }

        Velocity desiredVelocity = desiredVelocity(demand.profile(), yawError, pitchError, remaining);
        Velocity nextVelocity = approachVelocity(
            oldVelocity,
            desiredVelocity,
            demand.profile().maxAccelerationDegPerSecondSquared() * dt
        );

        double yawStep = nextVelocity.yaw() * dt;
        double pitchStep = nextVelocity.pitch() * dt;
        boolean yawReached = crossesTarget(yawStep, yawError);
        boolean pitchReached = crossesTarget(pitchStep, pitchError);
        if (yawReached) {
            yawStep = yawError;
        }
        if (pitchReached) {
            pitchStep = pitchError;
        }

        double nextYaw = LookController.normalizeYaw(safeCurrentYaw + yawStep);
        double nextPitch = clamp(safeCurrentPitch + pitchStep, -90.0D, 90.0D);
        double finalYawError = LookController.shortestYawDelta(nextYaw, demand.desiredYaw());
        double finalPitchError = demand.desiredPitch() - nextPitch;
        double finalRemaining = Math.hypot(finalYawError, finalPitchError);
        double finalSpeed = nextVelocity.magnitude();

        boolean withinSettle = finalRemaining <= SETTLE_ANGLE_DEGREES
            && finalSpeed < SETTLE_SPEED_DEGREES_PER_SECOND
            && oldVelocity.magnitude()
                <= demand.profile().maxAccelerationDegPerSecondSquared() * dt + EPSILON;
        int priorSettlePolls = selection.targetChanged()
            || selection.scopeChanged()
            || (prior.settled() && demandMovedOutsideDeadband)
            ? 0
            : prior.settlePolls();
        int settlePolls = withinSettle ? Math.min(2, priorSettlePolls + 1) : 0;
        boolean settled = settlePolls >= 2;
        boolean settledNow = settled && !prior.settled();
        if (settled) {
            nextYaw = demand.desiredYaw();
            nextPitch = demand.desiredPitch();
            finalRemaining = 0.0D;
            nextVelocity = new Velocity(0.0D, 0.0D);
            finalSpeed = 0.0D;
        }
        SpeedEnvelopeAccounting speedAccounting = accountSpeedEnvelope(
            prior,
            demand.profile(),
            finalSpeed,
            longGapReset
        );

        double acceleration = Math.hypot(
            nextVelocity.yaw() - oldVelocity.yaw(),
            nextVelocity.pitch() - oldVelocity.pitch()
        ) / dt;
        int reversals = reversalCount(oldVelocity, nextVelocity);
        int uncommandedReversals = uncommandedReversalCount(
            oldVelocity,
            nextVelocity,
            yawError,
            pitchError,
            selection.targetChanged() || selection.scopeChanged()
        );
        boolean write = settledNow
            || Math.abs(yawStep) > EPSILON
            || Math.abs(pitchStep) > EPSILON;
        State next = new State(
            true,
            nowMs,
            nextVelocity.yaw(),
            nextVelocity.pitch(),
            demand,
            selection.commitmentUntilMs(),
            settlePolls,
            settled,
            speedAccounting.profile()
        );
        Output output = new Output(
            nextYaw,
            nextPitch,
            write,
            selection.targetChanged(),
            selection.suppressed(),
            settled,
            settledNow,
            false,
            longGapReset,
            finalSpeed,
            acceleration,
            finalRemaining,
            reversals,
            uncommandedReversals,
            speedAccounting.profile(),
            speedAccounting.transition(),
            speedAccounting.requestedProfileSpeedExcess(),
            speedAccounting.violation()
        );
        return new Transition(next, output);
    }

    private static SpeedEnvelopeAccounting accountSpeedEnvelope(
        State prior,
        LookDemand.Profile requestedProfile,
        double speed,
        boolean longGapReset
    ) {
        if (requestedProfile == LookDemand.Profile.CRITICAL
            || longGapReset
            || speed <= requestedProfile.maxSpeedDegPerSecond() + PROFILE_LIMIT_EPSILON) {
            return new SpeedEnvelopeAccounting(requestedProfile, false, 0.0D, false);
        }

        LookDemand.Profile inheritedProfile = prior.speedEnvelopeProfile() != null
            ? prior.speedEnvelopeProfile()
            : prior.effectiveDemand() == null
                ? null
                : prior.effectiveDemand().profile();
        double requestedProfileSpeedExcess =
            speed - requestedProfile.maxSpeedDegPerSecond();
        if (inheritedProfile != null
            && inheritedProfile != LookDemand.Profile.CRITICAL
            && inheritedProfile.maxSpeedDegPerSecond()
                > requestedProfile.maxSpeedDegPerSecond()
            && speed <= inheritedProfile.maxSpeedDegPerSecond() + PROFILE_LIMIT_EPSILON) {
            return new SpeedEnvelopeAccounting(
                inheritedProfile,
                true,
                requestedProfileSpeedExcess,
                false
            );
        }
        return new SpeedEnvelopeAccounting(
            requestedProfile,
            false,
            requestedProfileSpeedExcess,
            true
        );
    }

    private static DemandSelection selectDemand(State prior, LookDemand raw, long nowMs) {
        LookDemand previous = prior.effectiveDemand();
        boolean scopeChanged = previous == null || !previous.sameCommitmentScope(raw);
        boolean identityChanged = previous == null
            || !previous.targetIdentity().equals(raw.targetIdentity());
        boolean committed = raw.profile() == LookDemand.Profile.PRECISION
            && raw.retargetPolicy() == LookDemand.RetargetPolicy.COMMITTED;
        boolean previousCommitted = previous != null
            && previous.profile() == LookDemand.Profile.PRECISION
            && previous.retargetPolicy() == LookDemand.RetargetPolicy.COMMITTED;

        if (!committed) {
            return new DemandSelection(raw, 0L, identityChanged, scopeChanged, false);
        }
        if (previous == null || scopeChanged || !previousCommitted) {
            return new DemandSelection(raw, nowMs + PRECISION_COMMITMENT_MS, identityChanged, true, false);
        }

        boolean sameTarget = previous.targetIdentity().equals(raw.targetIdentity());
        if (sameTarget) {
            return new DemandSelection(
                raw,
                prior.commitmentUntilMs(),
                false,
                false,
                false
            );
        }
        if (nowMs < prior.commitmentUntilMs()) {
            return new DemandSelection(
                previous,
                prior.commitmentUntilMs(),
                false,
                false,
                true
            );
        }
        return new DemandSelection(raw, nowMs + PRECISION_COMMITMENT_MS, true, false, false);
    }

    private static double elapsedSeconds(State prior, long nowMs, boolean longGapReset) {
        if (!prior.initialized() || longGapReset) {
            return RESUME_DT_SECONDS;
        }
        return clamp((nowMs - prior.lastTickMs()) / 1_000.0D, MIN_DT_SECONDS, MAX_DT_SECONDS);
    }

    private static Velocity desiredVelocity(
        LookDemand.Profile profile,
        double yawError,
        double pitchError,
        double remaining
    ) {
        if (remaining <= EPSILON) {
            return new Velocity(0.0D, 0.0D);
        }
        double speedLimit = brakingSpeedLimit(profile, remaining);
        double scale = speedLimit / remaining;
        return new Velocity(yawError * scale, pitchError * scale);
    }

    static double brakingSpeedLimit(LookDemand.Profile profile, double remainingAngle) {
        double remaining = Math.max(0.0D, remainingAngle);
        return Math.min(
            profile.maxSpeedDegPerSecond(),
            Math.sqrt(2.0D * profile.maxAccelerationDegPerSecondSquared() * remaining)
        );
    }

    private static Velocity approachVelocity(Velocity current, Velocity desired, double maximumDelta) {
        double yawDelta = desired.yaw() - current.yaw();
        double pitchDelta = desired.pitch() - current.pitch();
        double magnitude = Math.hypot(yawDelta, pitchDelta);
        if (magnitude <= maximumDelta || magnitude <= EPSILON) {
            return desired;
        }
        double scale = maximumDelta / magnitude;
        return new Velocity(
            current.yaw() + yawDelta * scale,
            current.pitch() + pitchDelta * scale
        );
    }

    private static boolean crossesTarget(double step, double error) {
        return Math.abs(error) <= EPSILON
            || (Math.signum(step) == Math.signum(error) && Math.abs(step) >= Math.abs(error));
    }

    private static int reversalCount(Velocity before, Velocity after) {
        int count = 0;
        if (reversed(before.yaw(), after.yaw())) {
            count++;
        }
        if (reversed(before.pitch(), after.pitch())) {
            count++;
        }
        return count;
    }

    private static int uncommandedReversalCount(
        Velocity before,
        Velocity after,
        double yawError,
        double pitchError,
        boolean targetChanged
    ) {
        int count = 0;
        if (isUncommandedReversal(before.yaw(), after.yaw(), yawError, targetChanged)) {
            count++;
        }
        if (isUncommandedReversal(before.pitch(), after.pitch(), pitchError, targetChanged)) {
            count++;
        }
        return count;
    }

    static boolean isUncommandedReversal(
        double priorVelocity,
        double nextVelocity,
        double angularError,
        boolean targetChanged
    ) {
        return reversed(priorVelocity, nextVelocity)
            && !targetChanged
            && Math.abs(angularError) > EPSILON
            && Math.signum(angularError) == Math.signum(priorVelocity);
    }

    private static boolean reversed(double before, double after) {
        return Math.abs(before) > EPSILON
            && Math.abs(after) > EPSILON
            && Math.signum(before) != Math.signum(after);
    }

    private static double clamp(double value, double min, double max) {
        return Math.max(min, Math.min(max, value));
    }
}
