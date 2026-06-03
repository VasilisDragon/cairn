package com.mcbot.fabricclient;

/** Bounded sample of an A* edge rejection for later terrain diagnosis. */
public record GridRejectionSample(
    TraversalIssue issue,
    GridCell from,
    GridCell to,
    Integer fromSurfaceY,
    Integer toSurfaceY
) {
}
