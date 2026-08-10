package com.mcbot.fabricclient;

import java.util.EnumMap;
import java.util.Map;
import net.minecraft.client.network.ClientPlayerEntity;
import org.slf4j.Logger;

final class FabricGazeAuthority {
    private static final double NORMAL_MAX_DEG_PER_TICK = 9.0D;
    private static final double COMBAT_MAX_DEG_PER_TICK = 12.0D;
    private static final double HUNT_MAX_DEG_PER_TICK = 9.0D;
    private static final double LEGACY_DEADBAND_DEG = 0.7D;
    private static final double LEGACY_SWAP_ANGLE_DEG = 10.0D;
    private static final long LEGACY_SWAP_MIN_INTERVAL_MS = 500L;
    private static final long SUMMARY_INTERVAL_MS = 5_000L;
    private static final int COMPUTATION_SAMPLE_CAP = 256;

    record LegacyState(
        boolean hasAcceptedNormal,
        String acceptedCommandId,
        double acceptedYaw,
        double acceptedPitch,
        long lastSwapAtMs
    ) {
        static LegacyState initial() {
            return new LegacyState(false, "", 0.0D, 0.0D, 0L);
        }
    }

    record LegacyOutput(
        LegacyState state,
        double yaw,
        double pitch,
        double acceptedYaw,
        double acceptedPitch,
        boolean write,
        boolean targetSuppressed
    ) {
    }

    record Applied(
        double yaw,
        double pitch,
        boolean write,
        LegacyOutput legacy,
        FabricGazeController.Output smooth
    ) {
    }

    private final String instanceId;
    private final Logger logger;
    private final FabricMotionMode mode;
    private final long[] computationNanos = new long[COMPUTATION_SAMPLE_CAP];

    private LegacyState legacyState = LegacyState.initial();
    private FabricGazeController.State smoothState = FabricGazeController.initialState();
    private FabricGazeController.Output lastSmoothOutput;
    private LegacyOutput lastLegacyOutput;
    private boolean shadowPoseInitialized;
    private double shadowYaw;
    private double shadowPitch;
    private LookDemand lastDemand;
    private LookDemand lastLegacyDemand;
    private long activeStartedAtMs;
    private long targetStartedAtMs;
    private long lastSummaryAtMs;
    private int computationIndex;
    private int computationCount;
    private int fixedTargetSuppressions;
    private int appliedReversals;
    private int shadowReversals;
    private int criticalImmediateCount;
    private int forwardResynchronizations;
    private int cursorRegressions;
    private int profileTransitionCount;
    private int profileTransitionTicks;
    private int profileAccountingViolationCount;
    private boolean profileTransitionActive;
    private LookDemand.Profile activeTransitionRequestedProfile;
    private LookDemand.Profile activeTransitionSpeedEnvelope;
    private String activeProfileAccountingViolationSignature = "";
    private double peakSpeed;
    private double peakAcceleration;
    private double profileTransitionPeakSpeed;
    private double profileTransitionPeakExcess;
    private final Map<LookDemand.Profile, Double> peakSpeedByProfile =
        new EnumMap<>(LookDemand.Profile.class);
    private final Map<LookDemand.Profile, Double> peakAccelerationByProfile =
        new EnumMap<>(LookDemand.Profile.class);
    private double stationaryTargetJitter;
    private double travelPitchMin = Double.POSITIVE_INFINITY;
    private double travelPitchMax = Double.NEGATIVE_INFINITY;
    private double stableTravelPitchMin = Double.POSITIVE_INFINITY;
    private double stableTravelPitchMax = Double.NEGATIVE_INFINITY;
    private long settleTimeMs = -1L;
    private long lastAppliedAtMs;
    private double lastAppliedYaw;
    private double lastAppliedPitch;
    private double lastAppliedYawVelocity;
    private double lastAppliedPitchVelocity;
    private String lastLegacyLookTarget = "";
    private long lastLegacyLookLogMs;

    FabricGazeAuthority(String instanceId, Logger logger, FabricMotionMode mode) {
        this.instanceId = instanceId == null ? "" : instanceId;
        this.logger = logger;
        this.mode = mode == null ? FabricMotionMode.LEGACY : mode;
    }

    FabricMotionMode mode() {
        return mode;
    }

    double locomotionObservationYaw(ClientPlayerEntity player) {
        if (mode == FabricMotionMode.SHADOW && shadowPoseInitialized) {
            return shadowYaw;
        }
        return player == null ? 0.0D : player.getYaw();
    }

    Applied commit(ClientPlayerEntity player, LookDemand demand, long nowMs) {
        return commit(player, demand, null, nowMs);
    }

    Applied commit(
        ClientPlayerEntity player,
        LookDemand demand,
        LookDemand legacyDemand,
        long nowMs
    ) {
        if (player == null) {
            return null;
        }
        if (demand == null) {
            finishActive(nowMs, player.getYaw(), player.getPitch());
            legacyState = LegacyState.initial();
            smoothState = FabricGazeController.initialState();
            lastSmoothOutput = null;
            lastLegacyOutput = null;
            shadowPoseInitialized = false;
            lastLegacyDemand = null;
            lastLegacyLookTarget = "";
            lastLegacyLookLogMs = 0L;
            return new Applied(player.getYaw(), player.getPitch(), false, null, null);
        }
        if (lastDemand != null && !lastDemand.commandId().equals(demand.commandId())) {
            finishActive(nowMs, player.getYaw(), player.getPitch());
        }

        long startedNs = System.nanoTime();
        double currentYaw = player.getYaw();
        double currentPitch = player.getPitch();
        if (lastDemand != null
            && lastDemand.owner() != demand.owner()
            && demand.owner() == LookDemand.Owner.NORMAL) {
            legacyState = LegacyState.initial();
        }
        LookDemand effectiveLegacyDemand = legacyDemand == null ? demand : legacyDemand;
        LegacyOutput legacy = legacyStep(
            legacyState,
            currentYaw,
            currentPitch,
            effectiveLegacyDemand,
            nowMs
        );
        legacyState = legacy.state();
        lastLegacyOutput = legacy;

        double smoothCurrentYaw = currentYaw;
        double smoothCurrentPitch = currentPitch;
        if (mode == FabricMotionMode.SHADOW && shadowPoseInitialized) {
            smoothCurrentYaw = shadowYaw;
            smoothCurrentPitch = shadowPitch;
        }
        FabricGazeController.Transition smoothTransition = mode == FabricMotionMode.LEGACY
            ? null
            : FabricGazeController.step(smoothState, smoothCurrentYaw, smoothCurrentPitch, demand, nowMs);
        if (smoothTransition != null) {
            smoothState = smoothTransition.state();
            lastSmoothOutput = smoothTransition.output();
            if (mode == FabricMotionMode.SHADOW) {
                shadowYaw = smoothTransition.output().yaw();
                shadowPitch = smoothTransition.output().pitch();
                shadowPoseInitialized = true;
            }
        }
        recordComputation(System.nanoTime() - startedNs);

        boolean targetChanged = lastDemand == null
            || !lastDemand.targetIdentity().equals(demand.targetIdentity())
            || !lastDemand.sameCommitmentScope(demand);
        double targetDelta = lastDemand == null
            ? 0.0D
            : Math.hypot(
                LookController.shortestYawDelta(lastDemand.desiredYaw(), demand.desiredYaw()),
                demand.desiredPitch() - lastDemand.desiredPitch()
            );
        boolean criticalImmediate = demand.profile() == LookDemand.Profile.CRITICAL
            && (targetChanged
                || Math.abs(LookController.shortestYawDelta(currentYaw, demand.desiredYaw())) > 0.0001D
                || Math.abs(currentPitch - demand.desiredPitch()) > 0.0001D);
        observeTransitions(
            demand,
            smoothTransition,
            targetChanged,
            targetDelta,
            criticalImmediate,
            nowMs
        );

        Applied selected = selectApplied(
            mode,
            legacy,
            smoothTransition == null ? null : smoothTransition.output()
        );
        double appliedYaw = selected.yaw();
        double appliedPitch = selected.pitch();
        boolean write = selected.write();
        if (write) {
            player.setYaw((float) appliedYaw);
            player.setPitch((float) appliedPitch);
        }
        emitLegacyLookIfNeeded(effectiveLegacyDemand, legacy, nowMs);

        observeAppliedMotion(
            demand,
            appliedYaw,
            appliedPitch,
            write,
            targetChanged,
            smoothTransition == null ? null : smoothTransition.output(),
            nowMs
        );
        lastDemand = demand;
        lastLegacyDemand = effectiveLegacyDemand;
        emitSummaryIfDue(demand, legacy, smoothTransition, appliedYaw, appliedPitch, targetDelta, nowMs, false);
        return new Applied(
            appliedYaw,
            appliedPitch,
            write,
            legacy,
            smoothTransition == null ? null : smoothTransition.output()
        );
    }

    static Applied selectApplied(
        FabricMotionMode mode,
        LegacyOutput legacy,
        FabricGazeController.Output smooth
    ) {
        if (mode == FabricMotionMode.SMOOTH && smooth != null) {
            return new Applied(smooth.yaw(), smooth.pitch(), smooth.write(), legacy, smooth);
        }
        return new Applied(legacy.yaw(), legacy.pitch(), legacy.write(), legacy, smooth);
    }

    void recordCursorMetrics(boolean regression, int forwardResynchronizationDelta) {
        if (regression) {
            cursorRegressions++;
        }
        forwardResynchronizations += Math.max(0, forwardResynchronizationDelta);
    }

    void reset() {
        legacyState = LegacyState.initial();
        smoothState = FabricGazeController.initialState();
        lastSmoothOutput = null;
        lastLegacyOutput = null;
        shadowPoseInitialized = false;
        lastDemand = null;
        lastLegacyDemand = null;
        lastLegacyLookTarget = "";
        lastLegacyLookLogMs = 0L;
        resetMetrics();
    }

    private void emitLegacyLookIfNeeded(LookDemand demand, LegacyOutput legacy, long nowMs) {
        if (mode == FabricMotionMode.SMOOTH
            || demand.owner() != LookDemand.Owner.NORMAL
            || !legacy.write()) {
            return;
        }
        String targetKey = demand.commandId()
            + ":"
            + legacy.acceptedYaw()
            + ":"
            + legacy.acceptedPitch();
        if (targetKey.equals(lastLegacyLookTarget) && nowMs - lastLegacyLookLogMs < 1_000L) {
            return;
        }
        logger.info(
            "look.apply instanceId={} commandId={} targetYaw={} targetPitch={} yaw={} pitch={}",
            instanceId,
            demand.commandId(),
            legacy.acceptedYaw(),
            legacy.acceptedPitch(),
            legacy.yaw(),
            legacy.pitch()
        );
        lastLegacyLookTarget = targetKey;
        lastLegacyLookLogMs = nowMs;
    }

    private void observeTransitions(
        LookDemand demand,
        FabricGazeController.Transition smooth,
        boolean targetChanged,
        double targetDelta,
        boolean criticalImmediate,
        long nowMs
    ) {
        if (lastDemand == null) {
            activeStartedAtMs = nowMs;
            lastSummaryAtMs = nowMs;
            targetStartedAtMs = nowMs;
            lastAppliedAtMs = 0L;
        }
        if (lastDemand == null || lastDemand.owner() != demand.owner()) {
            logger.info(
                "motion.gaze.owner_changed instanceId={} mode={} owner={} profile={} command={} reason={} targetIdentity={}",
                instanceId,
                mode.wireName(),
                demand.owner(),
                demand.profile(),
                demand.commandId(),
                demand.reason(),
                demand.targetIdentity()
            );
        }
        if (targetChanged) {
            targetStartedAtMs = nowMs;
            settleTimeMs = -1L;
            logger.info(
                "motion.gaze.target_changed instanceId={} mode={} owner={} profile={} command={} reason={} targetIdentity={} targetDelta={} desiredYaw={} desiredPitch={}",
                instanceId,
                mode.wireName(),
                demand.owner(),
                demand.profile(),
                demand.commandId(),
                demand.reason(),
                demand.targetIdentity(),
                rounded(targetDelta),
                rounded(demand.desiredYaw()),
                rounded(demand.desiredPitch())
            );
        }
        if (criticalImmediate) {
            criticalImmediateCount++;
            logger.info(
                "motion.gaze.critical_immediate instanceId={} mode={} owner={} profile={} command={} reason={} targetIdentity={} desiredYaw={} desiredPitch={}",
                instanceId,
                mode.wireName(),
                demand.owner(),
                demand.profile(),
                demand.commandId(),
                demand.reason(),
                demand.targetIdentity(),
                rounded(demand.desiredYaw()),
                rounded(demand.desiredPitch())
            );
        }
        if (smooth == null) {
            return;
        }
        FabricGazeController.Output output = smooth.output();
        if (output.targetSuppressed()) {
            fixedTargetSuppressions++;
        }
        if (mode == FabricMotionMode.SHADOW) {
            shadowReversals += output.outputReversals();
        }
        if (output.settledNow()) {
            settleTimeMs = Math.max(0L, nowMs - targetStartedAtMs);
            logger.info(
                "motion.gaze.settled instanceId={} mode={} owner={} profile={} command={} reason={} targetIdentity={} settleMs={}",
                instanceId,
                mode.wireName(),
                demand.owner(),
                demand.profile(),
                demand.commandId(),
                demand.reason(),
                demand.targetIdentity(),
                settleTimeMs
            );
        }
        if (output.uncommandedReversals() > 0) {
            logger.warn(
                "motion.gaze.anomaly instanceId={} mode={} owner={} profile={} command={} reason={} targetIdentity={} anomaly=uncommanded_reversal reversals={}",
                instanceId,
                mode.wireName(),
                demand.owner(),
                demand.profile(),
                demand.commandId(),
                demand.reason(),
                demand.targetIdentity(),
                output.uncommandedReversals()
            );
        }
        if (output.profileTransition()) {
            boolean changedTransition = !profileTransitionActive
                || activeTransitionRequestedProfile != demand.profile()
                || activeTransitionSpeedEnvelope != output.speedEnvelopeProfile();
            if (changedTransition) {
                profileTransitionCount++;
            }
            profileTransitionActive = true;
            activeTransitionRequestedProfile = demand.profile();
            activeTransitionSpeedEnvelope = output.speedEnvelopeProfile();
            profileTransitionTicks++;
            profileTransitionPeakSpeed = Math.max(
                profileTransitionPeakSpeed,
                output.angularSpeed()
            );
            profileTransitionPeakExcess = Math.max(
                profileTransitionPeakExcess,
                output.requestedProfileSpeedExcess()
            );
        } else {
            profileTransitionActive = false;
            activeTransitionRequestedProfile = null;
            activeTransitionSpeedEnvelope = null;
        }
        if (output.profileAccountingViolation()) {
            String violationSignature =
                demand.profile() + ":" + output.speedEnvelopeProfile();
            if (!violationSignature.equals(activeProfileAccountingViolationSignature)) {
                profileAccountingViolationCount++;
                logger.warn(
                    "motion.gaze.anomaly instanceId={} mode={} owner={} profile={} command={} reason={} targetIdentity={} anomaly=profile_accounting_violation speedEnvelope={} speed={} requestedCap={}",
                    instanceId,
                    mode.wireName(),
                    demand.owner(),
                    demand.profile(),
                    demand.commandId(),
                    demand.reason(),
                    demand.targetIdentity(),
                    output.speedEnvelopeProfile(),
                    rounded(output.angularSpeed()),
                    rounded(demand.profile().maxSpeedDegPerSecond())
                );
            }
            activeProfileAccountingViolationSignature = violationSignature;
        } else {
            activeProfileAccountingViolationSignature = "";
        }
    }

    private void observeAppliedMotion(
        LookDemand demand,
        double yaw,
        double pitch,
        boolean write,
        boolean targetChanged,
        FabricGazeController.Output smooth,
        long nowMs
    ) {
        if (demand.profile() == LookDemand.Profile.TRAVEL) {
            travelPitchMin = Math.min(travelPitchMin, demand.desiredPitch());
            travelPitchMax = Math.max(travelPitchMax, demand.desiredPitch());
            if (Math.abs(
                demand.desiredPitch() - TravelGazePolicy.STABLE_TRAVEL_PITCH_DEG
            ) < 0.0001D) {
                stableTravelPitchMin = Math.min(stableTravelPitchMin, demand.desiredPitch());
                stableTravelPitchMax = Math.max(stableTravelPitchMax, demand.desiredPitch());
            }
        }
        if (smooth != null) {
            peakSpeed = Math.max(peakSpeed, smooth.angularSpeed());
            peakAcceleration = Math.max(peakAcceleration, smooth.angularAcceleration());
            recordProfilePeak(
                peakSpeedByProfile,
                speedAccountingProfile(demand, smooth),
                smooth.angularSpeed()
            );
            recordProfilePeak(
                peakAccelerationByProfile,
                accelerationAccountingProfile(demand),
                smooth.angularAcceleration()
            );
            if (mode == FabricMotionMode.SMOOTH) {
                appliedReversals += smooth.outputReversals();
            }
        }
        double yawVelocity = 0.0D;
        double pitchVelocity = 0.0D;
        if (lastAppliedAtMs != 0L && mode != FabricMotionMode.SMOOTH) {
            double dt = Math.max(0.010D, Math.min(0.100D, (nowMs - lastAppliedAtMs) / 1_000.0D));
            yawVelocity = LookController.shortestYawDelta(lastAppliedYaw, yaw) / dt;
            pitchVelocity = (pitch - lastAppliedPitch) / dt;
            double speed = Math.hypot(yawVelocity, pitchVelocity);
            double acceleration = Math.hypot(
                yawVelocity - lastAppliedYawVelocity,
                pitchVelocity - lastAppliedPitchVelocity
            ) / dt;
            if (mode == FabricMotionMode.LEGACY) {
                peakSpeed = Math.max(peakSpeed, speed);
                peakAcceleration = Math.max(peakAcceleration, acceleration);
                recordProfilePeak(peakSpeedByProfile, demand.profile(), speed);
                recordProfilePeak(peakAccelerationByProfile, demand.profile(), acceleration);
            }
            if (reversed(lastAppliedYawVelocity, yawVelocity)) {
                appliedReversals++;
            }
            if (reversed(lastAppliedPitchVelocity, pitchVelocity)) {
                appliedReversals++;
            }
        }
        boolean stationaryTarget = !targetChanged
            && lastDemand != null
            && Math.abs(
                LookController.shortestYawDelta(lastDemand.desiredYaw(), demand.desiredYaw())
            ) < 0.01D
            && Math.abs(lastDemand.desiredPitch() - demand.desiredPitch()) < 0.01D;
        boolean stationarySettled = mode == FabricMotionMode.SMOOTH
            ? smooth != null && smooth.settled()
            : !write;
        if (stationaryTarget && stationarySettled) {
            stationaryTargetJitter = Math.max(
                stationaryTargetJitter,
                Math.hypot(
                    LookController.shortestYawDelta(yaw, demand.desiredYaw()),
                    pitch - demand.desiredPitch()
                )
            );
        }
        lastAppliedAtMs = nowMs;
        lastAppliedYaw = yaw;
        lastAppliedPitch = pitch;
        lastAppliedYawVelocity = yawVelocity;
        lastAppliedPitchVelocity = pitchVelocity;
    }

    private void emitSummaryIfDue(
        LookDemand demand,
        LegacyOutput legacy,
        FabricGazeController.Transition smooth,
        double appliedYaw,
        double appliedPitch,
        double targetDelta,
        long nowMs,
        boolean terminal
    ) {
        if (!terminal && nowMs - lastSummaryAtMs < SUMMARY_INTERVAL_MS) {
            return;
        }
        FabricGazeController.Output shadow = smooth == null ? lastSmoothOutput : smooth.output();
        LookDemand.Profile speedEnvelopeProfile = shadow == null
            || shadow.speedEnvelopeProfile() == null
            ? demand.profile()
            : shadow.speedEnvelopeProfile();
        logger.info(
            "motion.gaze.summary instanceId={} mode={} owner={} profile={} speedEnvelope={} command={} reason={} targetIdentity={} desiredYaw={} desiredPitch={} legacyYaw={} legacyPitch={} shadowYaw={} shadowPitch={} appliedYaw={} appliedPitch={} targetDelta={} elapsedMs={} peakSpeed={} peakAcceleration={} profileTransitionCount={} profileTransitionTicks={} profileTransitionPeakSpeed={} profileTransitionPeakExcess={} profileAccountingViolations={} travelPeakSpeed={} travelPeakAcceleration={} precisionPeakSpeed={} precisionPeakAcceleration={} trackingPeakSpeed={} trackingPeakAcceleration={} settleMs={} outputReversals={} appliedReversals={} shadowReversals={} fixedTargetSuppressions={} stationaryTargetJitter={} travelPitchMin={} travelPitchMax={} stableTravelPitchMin={} stableTravelPitchMax={} cursorRegressions={} forwardResynchronizations={} criticalImmediate={} computationP95Ms={} directWriterViolations=0",
            instanceId,
            mode.wireName(),
            demand.owner(),
            demand.profile(),
            speedEnvelopeProfile,
            demand.commandId(),
            demand.reason(),
            demand.targetIdentity(),
            rounded(demand.desiredYaw()),
            rounded(demand.desiredPitch()),
            rounded(legacy.yaw()),
            rounded(legacy.pitch()),
            rounded(shadow == null ? legacy.yaw() : shadow.yaw()),
            rounded(shadow == null ? legacy.pitch() : shadow.pitch()),
            rounded(appliedYaw),
            rounded(appliedPitch),
            rounded(targetDelta),
            Math.max(0L, nowMs - activeStartedAtMs),
            rounded(peakSpeed),
            rounded(peakAcceleration),
            profileTransitionCount,
            profileTransitionTicks,
            rounded(profileTransitionPeakSpeed),
            rounded(profileTransitionPeakExcess),
            profileAccountingViolationCount,
            rounded(profilePeak(peakSpeedByProfile, LookDemand.Profile.TRAVEL)),
            rounded(profilePeak(peakAccelerationByProfile, LookDemand.Profile.TRAVEL)),
            rounded(profilePeak(peakSpeedByProfile, LookDemand.Profile.PRECISION)),
            rounded(profilePeak(peakAccelerationByProfile, LookDemand.Profile.PRECISION)),
            rounded(profilePeak(peakSpeedByProfile, LookDemand.Profile.TRACKING)),
            rounded(profilePeak(peakAccelerationByProfile, LookDemand.Profile.TRACKING)),
            settleTimeMs,
            appliedReversals + shadowReversals,
            appliedReversals,
            shadowReversals,
            fixedTargetSuppressions,
            rounded(stationaryTargetJitter),
            Double.isFinite(travelPitchMin) ? rounded(travelPitchMin) : "none",
            Double.isFinite(travelPitchMax) ? rounded(travelPitchMax) : "none",
            Double.isFinite(stableTravelPitchMin) ? rounded(stableTravelPitchMin) : "none",
            Double.isFinite(stableTravelPitchMax) ? rounded(stableTravelPitchMax) : "none",
            cursorRegressions,
            forwardResynchronizations,
            criticalImmediateCount,
            rounded(computationP95Ms())
        );
        lastSummaryAtMs = nowMs;
    }

    private void finishActive(long nowMs, double currentYaw, double currentPitch) {
        if (lastDemand == null) {
            return;
        }
        LegacyOutput legacy = lastLegacyOutput == null
            ? legacyStep(
                legacyState,
                currentYaw,
                currentPitch,
                lastLegacyDemand == null ? lastDemand : lastLegacyDemand,
                nowMs
            )
            : lastLegacyOutput;
        emitSummaryIfDue(
            lastDemand,
            legacy,
            null,
            currentYaw,
            currentPitch,
            0.0D,
            nowMs,
            true
        );
        lastDemand = null;
        lastLegacyDemand = null;
        lastLegacyOutput = null;
        resetMetrics();
    }

    private void resetMetrics() {
        activeStartedAtMs = 0L;
        targetStartedAtMs = 0L;
        lastSummaryAtMs = 0L;
        computationIndex = 0;
        computationCount = 0;
        fixedTargetSuppressions = 0;
        appliedReversals = 0;
        shadowReversals = 0;
        criticalImmediateCount = 0;
        forwardResynchronizations = 0;
        cursorRegressions = 0;
        profileTransitionCount = 0;
        profileTransitionTicks = 0;
        profileAccountingViolationCount = 0;
        profileTransitionActive = false;
        activeTransitionRequestedProfile = null;
        activeTransitionSpeedEnvelope = null;
        activeProfileAccountingViolationSignature = "";
        peakSpeed = 0.0D;
        peakAcceleration = 0.0D;
        profileTransitionPeakSpeed = 0.0D;
        profileTransitionPeakExcess = 0.0D;
        peakSpeedByProfile.clear();
        peakAccelerationByProfile.clear();
        stationaryTargetJitter = 0.0D;
        travelPitchMin = Double.POSITIVE_INFINITY;
        travelPitchMax = Double.NEGATIVE_INFINITY;
        stableTravelPitchMin = Double.POSITIVE_INFINITY;
        stableTravelPitchMax = Double.NEGATIVE_INFINITY;
        settleTimeMs = -1L;
        lastAppliedAtMs = 0L;
        lastAppliedYawVelocity = 0.0D;
        lastAppliedPitchVelocity = 0.0D;
    }

    private void recordComputation(long nanos) {
        computationNanos[computationIndex] = Math.max(0L, nanos);
        computationIndex = (computationIndex + 1) % computationNanos.length;
        computationCount = Math.min(computationNanos.length, computationCount + 1);
    }

    private static void recordProfilePeak(
        Map<LookDemand.Profile, Double> peaks,
        LookDemand.Profile profile,
        double value
    ) {
        peaks.merge(profile, Math.max(0.0D, value), Math::max);
    }

    static LookDemand.Profile speedAccountingProfile(
        LookDemand demand,
        FabricGazeController.Output output
    ) {
        return output == null || output.speedEnvelopeProfile() == null
            ? demand.profile()
            : output.speedEnvelopeProfile();
    }

    static LookDemand.Profile accelerationAccountingProfile(LookDemand demand) {
        return demand.profile();
    }

    private static double profilePeak(
        Map<LookDemand.Profile, Double> peaks,
        LookDemand.Profile profile
    ) {
        return peaks.getOrDefault(profile, 0.0D);
    }

    private double computationP95Ms() {
        if (computationCount == 0) {
            return 0.0D;
        }
        long[] ordered = new long[computationCount];
        System.arraycopy(computationNanos, 0, ordered, 0, computationCount);
        java.util.Arrays.sort(ordered);
        int index = Math.min(ordered.length - 1, (int) Math.ceil(ordered.length * 0.95D) - 1);
        return ordered[index] / 1_000_000.0D;
    }

    static LegacyOutput legacyStep(
        LegacyState previous,
        double currentYaw,
        double currentPitch,
        LookDemand demand,
        long nowMs
    ) {
        LegacyState state = previous == null ? LegacyState.initial() : previous;
        if (demand.owner() == LookDemand.Owner.SURVIVAL
            || demand.profile() == LookDemand.Profile.CRITICAL
            || (demand.owner() == LookDemand.Owner.COMBAT && demand.reason().contains("escape_route_exact"))) {
            return new LegacyOutput(
                state,
                demand.desiredYaw(),
                demand.desiredPitch(),
                demand.desiredYaw(),
                demand.desiredPitch(),
                true,
                false
            );
        }
        if (demand.owner() == LookDemand.Owner.COMBAT || demand.owner() == LookDemand.Owner.HUNT) {
            double maxStep = demand.owner() == LookDemand.Owner.COMBAT
                ? COMBAT_MAX_DEG_PER_TICK
                : HUNT_MAX_DEG_PER_TICK;
            LookController.Look next = LookController.nextLook(
                currentYaw,
                currentPitch,
                demand.desiredYaw(),
                demand.desiredPitch(),
                maxStep
            );
            boolean write = Math.abs(LookController.shortestYawDelta(currentYaw, next.yaw())) > 0.0D
                || Math.abs(next.pitch() - currentPitch) > 0.0D;
            return new LegacyOutput(
                state,
                next.yaw(),
                next.pitch(),
                demand.desiredYaw(),
                demand.desiredPitch(),
                write,
                false
            );
        }

        double targetYaw = demand.desiredYaw();
        double targetPitch = demand.desiredPitch();
        boolean suppressed = false;
        boolean dampEligible = demand.reason().contains("face")
            || demand.reason().contains("aim")
            || demand.reason().contains("place");
        if (dampEligible
            && state.hasAcceptedNormal()
            && demand.commandId().equals(state.acceptedCommandId())) {
            double yawDelta = Math.abs(LookController.shortestYawDelta(state.acceptedYaw(), targetYaw));
            double pitchDelta = Math.abs(targetPitch - state.acceptedPitch());
            if (yawDelta > LEGACY_SWAP_ANGLE_DEG || pitchDelta > LEGACY_SWAP_ANGLE_DEG) {
                if (nowMs - state.lastSwapAtMs() < LEGACY_SWAP_MIN_INTERVAL_MS) {
                    targetYaw = state.acceptedYaw();
                    targetPitch = state.acceptedPitch();
                    suppressed = true;
                } else {
                    state = new LegacyState(true, demand.commandId(), targetYaw, targetPitch, nowMs);
                }
            } else {
                state = new LegacyState(
                    true,
                    demand.commandId(),
                    targetYaw,
                    targetPitch,
                    state.lastSwapAtMs()
                );
            }
        } else {
            state = new LegacyState(true, demand.commandId(), targetYaw, targetPitch, nowMs);
        }

        double yawError = Math.abs(LookController.shortestYawDelta(currentYaw, targetYaw));
        double pitchError = Math.abs(targetPitch - currentPitch);
        if (yawError < LEGACY_DEADBAND_DEG && pitchError < LEGACY_DEADBAND_DEG) {
            return new LegacyOutput(
                state,
                currentYaw,
                currentPitch,
                targetYaw,
                targetPitch,
                false,
                suppressed
            );
        }
        LookController.Look next = LookController.nextLook(
            currentYaw,
            currentPitch,
            targetYaw,
            targetPitch,
            NORMAL_MAX_DEG_PER_TICK
        );
        return new LegacyOutput(
            state,
            next.yaw(),
            next.pitch(),
            targetYaw,
            targetPitch,
            true,
            suppressed
        );
    }

    private static boolean reversed(double before, double after) {
        return Math.abs(before) > 0.01D
            && Math.abs(after) > 0.01D
            && Math.signum(before) != Math.signum(after);
    }

    private static double rounded(double value) {
        return Math.round(value * 1_000.0D) / 1_000.0D;
    }
}
