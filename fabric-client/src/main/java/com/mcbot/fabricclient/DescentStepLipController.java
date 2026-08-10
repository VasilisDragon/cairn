package com.mcbot.fabricclient;

/**
 * Commits a downward staircase lip crossing without relying on an extra blind forward tick.
 * The caller remains responsible for world geometry validation and authoritative step arrival.
 */
final class DescentStepLipController {
    static final int REQUIRED_STABLE_POLLS = 2;
    static final long LAUNCH_PULSE_MS = 150L;

    enum Phase {
        IDLE,
        STAGING,
        LAUNCHING,
        RELEASED
    }

    enum Action {
        HOLD_SNEAK,
        FORWARD_LAUNCH,
        HOLD_RELEASED
    }

    record Cell(int x, int y, int z) {
    }

    record Key(String commandId, int stepIndex, Cell origin, Cell landing) {
        Key {
            commandId = commandId == null ? "" : commandId;
            if (origin == null || landing == null) {
                throw new IllegalArgumentException("lip cells are required");
            }
        }
    }

    record Observation(
        Key key,
        long nowMs,
        boolean grounded,
        boolean dry,
        boolean bodyClear,
        boolean hazardFree,
        boolean originSupportStable,
        boolean landingSupportStable
    ) {
        Observation {
            if (key == null) {
                throw new IllegalArgumentException("lip key is required");
            }
        }

        boolean safeToLaunch() {
            return grounded
                && dry
                && bodyClear
                && hazardFree
                && originSupportStable
                && landingSupportStable;
        }
    }

    record Decision(
        Phase phase,
        Action action,
        Key key,
        int stablePolls,
        boolean transitioned,
        String reason
    ) {
    }

    private Phase phase = Phase.IDLE;
    private Key key;
    private int stablePolls;
    private long launchStartedAtMs;

    Decision tick(Observation observation) {
        if (observation == null) {
            clear();
            return decision(Action.HOLD_RELEASED, true, "missing_observation");
        }
        if (!observation.key().equals(key)) {
            key = observation.key();
            phase = Phase.STAGING;
            stablePolls = 0;
            launchStartedAtMs = 0L;
        }

        if (phase == Phase.LAUNCHING) {
            if (Math.max(0L, observation.nowMs() - launchStartedAtMs) < LAUNCH_PULSE_MS) {
                return decision(Action.FORWARD_LAUNCH, false, "launching");
            }
            phase = Phase.RELEASED;
            return decision(Action.HOLD_RELEASED, true, "launch_released");
        }
        if (phase == Phase.RELEASED) {
            return decision(Action.HOLD_RELEASED, false, "released");
        }

        if (!observation.safeToLaunch()) {
            stablePolls = 0;
            return decision(Action.HOLD_SNEAK, false, "staging_unsafe");
        }
        stablePolls++;
        if (stablePolls < REQUIRED_STABLE_POLLS) {
            return decision(Action.HOLD_SNEAK, false, "staging");
        }
        phase = Phase.LAUNCHING;
        launchStartedAtMs = observation.nowMs();
        return decision(Action.FORWARD_LAUNCH, true, "launch_started");
    }

    void clear() {
        phase = Phase.IDLE;
        key = null;
        stablePolls = 0;
        launchStartedAtMs = 0L;
    }

    void pauseStaging() {
        if (phase == Phase.STAGING) {
            stablePolls = 0;
        }
    }

    Phase phase() {
        return phase;
    }

    Key key() {
        return key;
    }

    private Decision decision(Action action, boolean transitioned, String reason) {
        return new Decision(phase, action, key, stablePolls, transitioned, reason);
    }
}
