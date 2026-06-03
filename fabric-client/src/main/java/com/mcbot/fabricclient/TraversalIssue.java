package com.mcbot.fabricclient;

/** Pure reason codes for why one grid edge cannot be traversed. */
public enum TraversalIssue {
    NONE,
    INVALID_REQUEST,
    OUT_OF_BOUNDS,
    FROM_BLOCKED,
    TO_BLOCKED,
    RISE_TOO_HIGH,
    DROP_TOO_FAR
}
