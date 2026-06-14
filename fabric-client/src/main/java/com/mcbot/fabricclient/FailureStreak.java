package com.mcbot.fabricclient;

// R0 (escalation reflex): a reusable "same key N times in a row" counter. A control site records
// the key of the local decision it just repeated -- a rejected support cell, a re-aimed skipped
// jump waypoint, a route-less search origin. When the SAME key repeats at least `escalateAt` times
// with no intervening change, escalated() returns true so the site can hand off to its existing
// reroute/abandon path instead of spinning until the slow stall/watchdog fires. Generalizes the
// proven edge-veto streak idiom (10-tick reroute / 60-tick abandon) for reuse across the
// descent / navigation / gather control sites identified in the livelock census.
final class FailureStreak {
    private String key = null;
    private int count = 0;

    // Record one occurrence. A null key means "no failure this tick" and resets the streak, so a
    // site may call record(failing ? failKey : null) unconditionally each tick. Returns the streak
    // length (0 for null, 1 when the key just changed or first appears).
    int record(String currentKey) {
        if (currentKey == null) {
            reset();
            return 0;
        }
        if (currentKey.equals(key)) {
            count++;
        } else {
            key = currentKey;
            count = 1;
        }
        return count;
    }

    // True once the most-recently-recorded key has repeated at least `escalateAt` times in a row.
    boolean escalated(int escalateAt) {
        return key != null && count >= escalateAt;
    }

    int count() {
        return count;
    }

    String key() {
        return key;
    }

    void reset() {
        key = null;
        count = 0;
    }
}
