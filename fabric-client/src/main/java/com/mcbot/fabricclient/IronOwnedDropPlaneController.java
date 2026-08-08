package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

/**
 * Pure, bounded traversal state for collecting an attributed raw-iron drop without leaving the
 * prospecting plane.
 *
 * <p>Ownership and settlement remain the responsibility of {@link OwnedDropTracker}. This class
 * begins only from a settled tracker, asks {@link CollectTarget3DPlanner} for a route through a
 * same-Y perception view, and keeps the complete outbound route so pickup can be followed by an
 * exact reverse traversal to the frozen lane-resume cell.
 */
final class IronOwnedDropPlaneController {
    static final int MIN_PROSPECT_FEET_Y = 13;
    static final int MAX_PROSPECT_FEET_Y = 16;
    static final int MAX_ROUTE_CELLS = 16;
    static final int MAX_ROUTE_COMPUTATIONS = OwnedDropTracker.MAX_ROUTE_ATTEMPTS;
    static final int MAX_FORWARD_RESYNC_CELLS = 8;
    static final long STALL_TIMEOUT_MS = 4_000L;
    static final long COLLECTION_TIMEOUT_MS = 8_000L;
    static final double PICKUP_CONTACT_MAX_SHIFT = 0.25D;
    static final double PICKUP_CONTACT_EPSILON = 0.10D;
    // Conservative pure counterpart to playerBox.expand(1.0, 0.5, 1.0) intersecting the
    // quarter-block item box. The shared planner's symmetric +/-1.5 Y envelope admits items well
    // below a fixed plane that the actual expanded player box can never touch.
    static final double PICKUP_ENVELOPE_MIN_VERTICAL_OFFSET = -0.70D;
    static final double PICKUP_ENVELOPE_MAX_VERTICAL_OFFSET = 2.25D;
    // playerBox.expand(1.0, 0.5, 1.0) is axis-aligned. A player half-width of 0.3
    // plus the item's 0.125 half-width gives a theoretical 1.425-block center
    // overlap on each horizontal axis; keep a small conservative margin.
    static final double PICKUP_ENVELOPE_MAX_HORIZONTAL_AXIS_OFFSET = 1.40D;
    static final long MIN_RETURN_TIMEOUT_MS = 20_000L;
    static final double RETURN_TIMEOUT_PER_CELL_MS = 2_500.0D;
    static final double PRECISE_PROGRESS_BLOCKS = 0.05D;
    static final double REPLAN_ITEM_MOVEMENT = OwnedDropTraversal.REPLAN_ITEM_MOVEMENT;

    enum Phase {
        IDLE,
        OUTBOUND,
        PICKUP,
        RETURNING,
        RESUME
    }

    enum Outcome {
        IDLE,
        HOLD,
        DRIVE,
        PICKUP_REACHED,
        RETURN_STARTED,
        RESUME_REACHED,
        COMPLETED,
        REJECTED
    }

    record PlayerObservation(
        VoxelCell feet,
        double x,
        double y,
        double z,
        boolean onGround,
        boolean aligned
    ) {
        static PlayerObservation centered(VoxelCell feet, boolean onGround, boolean aligned) {
            return new PlayerObservation(
                feet,
                feet == null ? 0.0D : feet.x() + 0.5D,
                feet == null ? 0.0D : feet.y(),
                feet == null ? 0.0D : feet.z() + 0.5D,
                onGround,
                aligned
            );
        }
    }

    record DropObservation(
        UUID entityId,
        OwnedDropTracker.Position position,
        boolean live,
        boolean pickupEnvelopeReached
    ) {
        DropObservation(UUID entityId, OwnedDropTracker.Position position, boolean live) {
            this(entityId, position, live, false);
        }
    }

    record StartResult(
        boolean started,
        VoxelCell pickupCell,
        List<VoxelCell> route,
        int routeComputations,
        String reason
    ) {
        StartResult {
            route = route == null ? List.of() : List.copyOf(route);
            reason = normalizedReason(reason);
        }
    }

    /**
     * Pure pre-break proof that the expected raw-iron drop can be reached without leaving the
     * frozen prospect plane.  Unlike {@link #begin}, this does not consume a route attempt or
     * mutate controller state; callers use it only to decide whether an ore cell is safe to break.
     */
    record RouteAdmission(
        boolean admitted,
        VoxelCell pickupCell,
        List<VoxelCell> route,
        String reason
    ) {
        RouteAdmission {
            route = route == null ? List.of() : List.copyOf(route);
            reason = normalizedReason(reason);
        }
    }

    record Step(
        Outcome outcome,
        Phase phase,
        VoxelCell waypoint,
        boolean forward,
        boolean stopped,
        String reason,
        int waypointIndex,
        int remainingCells,
        int maximumWaypointIndex,
        boolean waypointAdvanced,
        boolean forwardResynchronized,
        boolean replanned,
        int routeComputations,
        long lastProgressAgeMs,
        long elapsedMs
    ) {
        Step {
            reason = normalizedReason(reason);
        }
    }

    private Phase phase = Phase.IDLE;
    private int planeY;
    private UUID entityId;
    private OwnedDropTracker.Position plannedDropPosition;
    private VoxelCell resumeCell;
    private VoxelCell pickupCell;
    private double pickupContactX;
    private double pickupContactZ;
    private boolean pickupContactSelected;
    private List<VoxelCell> outboundRoute = List.of();
    private List<VoxelCell> activeRoute = List.of();
    private int waypointIndex = -1;
    private int maximumWaypointIndex = -1;
    private VoxelCell stableFeet;
    private int routeComputations;
    private long startedAtMs;
    private long collectionDeadlineAtMs;
    private long returnDeadlineAtMs;
    private long lastProgressAtMs;
    private double bestPreciseDistance = Double.POSITIVE_INFINITY;
    private boolean inventoryConfirmed;
    private long inventoryConfirmedAtMs;
    private OwnedDropTracker routeAttemptTracker;
    private int identityReacquisitions;

    StartResult begin(
        VoxelPerception perception,
        VoxelCell feet,
        int nextPlaneY,
        VoxelCell nextResumeCell,
        OwnedDropTracker tracker,
        long nowMs
    ) {
        clear();
        if (tracker == null || !tracker.settled()) {
            return new StartResult(false, null, List.of(), 0, "drop_not_settled");
        }
        routeAttemptTracker = tracker;
        routeComputations = tracker.routeAttempts();
        return beginPrepared(
            perception,
            feet,
            nextPlaneY,
            nextResumeCell,
            tracker.entityId(),
            tracker.settledPosition(),
            nowMs
        );
    }

    StartResult begin(
        VoxelPerception perception,
        VoxelCell feet,
        int nextPlaneY,
        VoxelCell nextResumeCell,
        UUID nextEntityId,
        OwnedDropTracker.Position settledPosition,
        long nowMs
    ) {
        clear();
        return beginPrepared(
            perception,
            feet,
            nextPlaneY,
            nextResumeCell,
            nextEntityId,
            settledPosition,
            nowMs
        );
    }

    private StartResult beginPrepared(
        VoxelPerception perception,
        VoxelCell feet,
        int nextPlaneY,
        VoxelCell nextResumeCell,
        UUID nextEntityId,
        OwnedDropTracker.Position settledPosition,
        long nowMs
    ) {
        if (!validPlane(nextPlaneY)) {
            return failedStart("plane_out_of_bounds");
        }
        if (perception == null
            || feet == null
            || nextResumeCell == null
            || nextEntityId == null
            || settledPosition == null) {
            return failedStart("invalid_request");
        }
        if (!feet.equals(nextResumeCell) || feet.y() != nextPlaneY) {
            return failedStart("resume_cell_mismatch");
        }
        if (!planeStandable(perception, feet, nextPlaneY)) {
            return failedStart("start_unstandable");
        }

        if (!recordRouteComputation()) {
            return failedStart("route_attempt_limit");
        }
        RouteAdmission admission = assessRoute(
            perception,
            feet,
            nextPlaneY,
            settledPosition
        );
        if (!admission.admitted()) {
            return failedStart(admission.reason());
        }

        planeY = nextPlaneY;
        entityId = nextEntityId;
        plannedDropPosition = settledPosition;
        resumeCell = nextResumeCell;
        pickupCell = admission.pickupCell();
        pickupContactX = contactCoordinate(settledPosition.x(), pickupCell.x());
        pickupContactZ = contactCoordinate(settledPosition.z(), pickupCell.z());
        outboundRoute = admission.route();
        activeRoute = outboundRoute;
        waypointIndex = 1;
        maximumWaypointIndex = 0;
        stableFeet = feet;
        startedAtMs = nowMs;
        collectionDeadlineAtMs = saturatedAdd(nowMs, COLLECTION_TIMEOUT_MS);
        lastProgressAtMs = nowMs;
        phase = Phase.OUTBOUND;
        return new StartResult(true, pickupCell, outboundRoute, routeComputations, admission.reason());
    }

    static RouteAdmission assessRoute(
        VoxelPerception perception,
        VoxelCell feet,
        int planeY,
        OwnedDropTracker.Position expectedDropPosition
    ) {
        if (!validPlane(planeY)) {
            return new RouteAdmission(false, null, List.of(), "plane_out_of_bounds");
        }
        if (perception == null || feet == null || expectedDropPosition == null) {
            return new RouteAdmission(false, null, List.of(), "invalid_request");
        }
        if (feet.y() != planeY || !planeStandable(perception, feet, planeY)) {
            return new RouteAdmission(false, null, List.of(), "start_unstandable");
        }
        PlannedRoute planned = plan(perception, feet, planeY, expectedDropPosition);
        return planned.accepted()
            ? new RouteAdmission(true, planned.pickupCell(), planned.route(), planned.reason())
            : new RouteAdmission(false, null, List.of(), planned.reason());
    }

    Step tick(
        PlayerObservation player,
        DropObservation drop,
        VoxelPerception perception,
        boolean inventoryGain,
        long nowMs
    ) {
        if (phase == Phase.IDLE || player == null || player.feet() == null) {
            return idleStep();
        }
        if (inventoryGain && !inventoryConfirmed) {
            inventoryConfirmed = true;
            inventoryConfirmedAtMs = nowMs;
        }
        if (phase == Phase.RESUME) {
            return complete(player, perception, nowMs);
        }
        if (phase == Phase.RETURNING) {
            if (nowMs >= returnDeadlineAtMs) {
                return reject("return_timeout", nowMs);
            }
            return driveRoute(player, null, perception, nowMs, true);
        }

        if (nowMs >= collectionDeadlineAtMs && !inventoryConfirmed) {
            return reject("collection_timeout", nowMs);
        }
        if (inventoryConfirmed) {
            Step returnStep = beginReturn(player, perception, nowMs);
            if (returnStep != null) {
                return returnStep;
            }
            if (player.onGround()) {
                return reject("return_start_off_plane", nowMs);
            }
            if (nowMs - inventoryConfirmedAtMs >= STALL_TIMEOUT_MS) {
                return reject("return_start_stalled", nowMs);
            }
            return hold("inventory_confirmed_wait_grounded", nowMs, false);
        }
        if (drop == null || !drop.live() || drop.position() == null) {
            return reject("drop_disappeared_without_inventory", nowMs);
        }
        if (drop.entityId() == null || !drop.entityId().equals(entityId)) {
            return reject("unexpected_entity_id", nowMs);
        }
        if (movedBeyondReplanThreshold(drop.position())) {
            return replan(player, drop, perception, nowMs);
        }
        refreshPickupContact(drop.position());
        if (phase == Phase.PICKUP) {
            return hold("awaiting_inventory_confirmation", nowMs, false);
        }
        return driveRoute(player, drop, perception, nowMs, false);
    }

    boolean active() {
        return phase != Phase.IDLE;
    }

    Phase phase() {
        return phase;
    }

    int planeY() {
        return planeY;
    }

    UUID entityId() {
        return entityId;
    }

    VoxelCell resumeCell() {
        return resumeCell;
    }

    VoxelCell pickupCell() {
        return pickupCell;
    }

    boolean pickupContactApproachPending() {
        return active()
            && phase == Phase.OUTBOUND
            && pickupContactSelected
            && waypointIndex >= activeRoute.size();
    }

    double pickupContactX() {
        return pickupContactX;
    }

    double pickupContactZ() {
        return pickupContactZ;
    }

    List<VoxelCell> outboundRoute() {
        return outboundRoute;
    }

    List<VoxelCell> activeRoute() {
        return activeRoute;
    }

    int routeComputations() {
        return routeComputations;
    }

    int identityReacquisitions() {
        return identityReacquisitions;
    }

    /**
     * Admits the one identity replacement already proven by {@link OwnedDropTracker}.
     *
     * <p>The caller passes the tracker's authoritative reacquisition count from the same update.
     * Ordinary observations cannot silently replace the UUID through {@link #tick}.
     */
    boolean admitReacquiredEntity(
        UUID expectedPreviousId,
        UUID replacementId,
        OwnedDropTracker.Position replacementPosition,
        int authoritativeReacquisitions
    ) {
        if (!active()
            || expectedPreviousId == null
            || replacementId == null
            || replacementPosition == null
            || replacementId.equals(expectedPreviousId)
            || !expectedPreviousId.equals(entityId)
            || identityReacquisitions >= OwnedDropTracker.MAX_REACQUISITIONS
            || authoritativeReacquisitions != identityReacquisitions + 1
            || authoritativeReacquisitions > OwnedDropTracker.MAX_REACQUISITIONS
            || plannedDropPosition == null
            || replacementPosition.horizontalDistanceTo(plannedDropPosition)
                > OwnedDropTracker.REACQUISITION_DISTANCE
            || Math.abs(replacementPosition.y() - plannedDropPosition.y())
                > OwnedDropTracker.REACQUISITION_DISTANCE) {
            return false;
        }
        entityId = replacementId;
        identityReacquisitions = authoritativeReacquisitions;
        return true;
    }

    int waypointIndex() {
        return waypointIndex;
    }

    int remainingCells() {
        return Math.max(0, activeRoute.size() - Math.max(0, waypointIndex));
    }

    VoxelCell stableFeet() {
        return stableFeet;
    }

    long lastProgressAgeMs(long nowMs) {
        return active() ? Math.max(0L, nowMs - lastProgressAtMs) : 0L;
    }

    void clear() {
        phase = Phase.IDLE;
        planeY = 0;
        entityId = null;
        plannedDropPosition = null;
        resumeCell = null;
        pickupCell = null;
        pickupContactX = 0.0D;
        pickupContactZ = 0.0D;
        pickupContactSelected = false;
        outboundRoute = List.of();
        activeRoute = List.of();
        waypointIndex = -1;
        maximumWaypointIndex = -1;
        stableFeet = null;
        routeComputations = 0;
        startedAtMs = 0L;
        collectionDeadlineAtMs = 0L;
        returnDeadlineAtMs = 0L;
        lastProgressAtMs = 0L;
        bestPreciseDistance = Double.POSITIVE_INFINITY;
        inventoryConfirmed = false;
        inventoryConfirmedAtMs = 0L;
        routeAttemptTracker = null;
        identityReacquisitions = 0;
    }

    private Step driveRoute(
        PlayerObservation player,
        DropObservation drop,
        VoxelPerception perception,
        long nowMs,
        boolean returning
    ) {
        if (!validPlayerOnPlane(player, perception)) {
            return reject(player.onGround() ? "route_deviation" : "route_unexpected_airborne", nowMs);
        }
        Synchronization synchronization = synchronizeForward(player, nowMs);
        if (waypointIndex >= activeRoute.size()) {
            return returning
                ? reachResume(nowMs, synchronization)
                : approachPickupContact(player, drop, perception, nowMs, synchronization);
        }

        VoxelCell waypoint = activeRoute.get(waypointIndex);
        if (!planeStandable(perception, waypoint, planeY)) {
            return reject("route_invalidated", nowMs);
        }
        int currentIndex = activeRoute.indexOf(player.feet());
        if (currentIndex < 0 || currentIndex >= waypointIndex) {
            return reject("route_deviation", nowMs);
        }
        if (currentIndex == waypointIndex - 1) {
            stableFeet = player.feet();
            observePreciseProgress(player, waypoint, nowMs);
        }
        if (nowMs - lastProgressAtMs >= STALL_TIMEOUT_MS) {
            return reject(returning ? "return_stalled" : "outbound_stalled", nowMs);
        }
        return step(
            Outcome.DRIVE,
            waypoint,
            player.aligned(),
            !player.aligned(),
            player.aligned() ? "driving" : "aligning",
            nowMs,
            synchronization,
            false
        );
    }

    private Step replan(
        PlayerObservation player,
        DropObservation drop,
        VoxelPerception perception,
        long nowMs
    ) {
        if (routeComputations >= MAX_ROUTE_COMPUTATIONS) {
            return reject("replan_limit", nowMs);
        }
        if (!validPlayerOnPlane(player, perception)) {
            return reject("replan_start_invalid", nowMs);
        }
        int currentIndex = outboundRoute.indexOf(player.feet());
        if (currentIndex < 0) {
            return reject("replan_route_deviation", nowMs);
        }
        if (currentIndex < maximumWaypointIndex) {
            return reject("replan_route_regression", nowMs);
        }

        if (!recordRouteComputation()) {
            return reject("replan_limit", nowMs);
        }
        PlannedRoute suffix = plan(perception, player.feet(), planeY, drop.position());
        if (!suffix.accepted()) {
            return reject("replan_" + suffix.reason(), nowMs);
        }
        List<VoxelCell> combined = splice(outboundRoute, currentIndex, suffix.route());
        if (combined.isEmpty()) {
            return reject("replan_route_intersection", nowMs);
        }
        if (combined.size() > MAX_ROUTE_CELLS) {
            return reject("replan_route_cell_limit", nowMs);
        }

        outboundRoute = combined;
        activeRoute = outboundRoute;
        pickupCell = suffix.pickupCell();
        pickupContactX = contactCoordinate(drop.position().x(), pickupCell.x());
        pickupContactZ = contactCoordinate(drop.position().z(), pickupCell.z());
        pickupContactSelected = false;
        plannedDropPosition = drop.position();
        waypointIndex = currentIndex + 1;
        maximumWaypointIndex = Math.max(maximumWaypointIndex, currentIndex);
        stableFeet = player.feet();
        lastProgressAtMs = nowMs;
        bestPreciseDistance = Double.POSITIVE_INFINITY;
        phase = Phase.OUTBOUND;
        return step(
            Outcome.HOLD,
            activeWaypoint(),
            false,
            true,
            "drop_replanned",
            nowMs,
            Synchronization.NONE,
            true
        );
    }

    private Step beginReturn(
        PlayerObservation player,
        VoxelPerception perception,
        long nowMs
    ) {
        if (!validPlayerOnPlane(player, perception)) {
            return null;
        }
        int currentIndex = outboundRoute.indexOf(player.feet());
        if (currentIndex < 0) {
            return reject("pickup_off_route", nowMs);
        }
        List<VoxelCell> consumedPrefix = new ArrayList<>(outboundRoute.subList(0, currentIndex + 1));
        Collections.reverse(consumedPrefix);
        activeRoute = List.copyOf(consumedPrefix);
        waypointIndex = 1;
        maximumWaypointIndex = 0;
        stableFeet = player.feet();
        lastProgressAtMs = nowMs;
        bestPreciseDistance = Double.POSITIVE_INFINITY;
        returnDeadlineAtMs = saturatedAdd(
            nowMs,
            Math.max(MIN_RETURN_TIMEOUT_MS, Math.round(activeRoute.size() * RETURN_TIMEOUT_PER_CELL_MS))
        );
        phase = Phase.RETURNING;
        pickupContactSelected = false;
        return step(
            Outcome.RETURN_STARTED,
            activeWaypoint(),
            false,
            true,
            "inventory_confirmed_return_selected",
            nowMs,
            Synchronization.NONE,
            false
        );
    }

    private Step approachPickupContact(
        PlayerObservation player,
        DropObservation drop,
        VoxelPerception perception,
        long nowMs,
        Synchronization synchronization
    ) {
        if (!validPlayerOnPlane(player, perception) || !pickupCell.equals(player.feet())) {
            return reject(player.onGround()
                ? "pickup_contact_route_deviation"
                : "pickup_contact_unexpected_airborne", nowMs);
        }
        double distance = Math.hypot(pickupContactX - player.x(), pickupContactZ - player.z());
        if (drop != null && drop.pickupEnvelopeReached()) {
            phase = Phase.PICKUP;
            stableFeet = pickupCell;
            return step(
                Outcome.PICKUP_REACHED,
                pickupCell,
                false,
                true,
                "pickup_envelope_reached",
                nowMs,
                synchronization,
                false
            );
        }
        if (!pickupContactSelected) {
            pickupContactSelected = true;
            bestPreciseDistance = distance;
            stableFeet = player.feet();
            return hold("pickup_contact_selected", nowMs, false);
        }
        if (distance <= bestPreciseDistance - PRECISE_PROGRESS_BLOCKS) {
            bestPreciseDistance = distance;
            lastProgressAtMs = nowMs;
        }
        if (nowMs - lastProgressAtMs >= STALL_TIMEOUT_MS) {
            return reject("pickup_contact_stalled", nowMs);
        }
        if (distance <= PICKUP_CONTACT_EPSILON) {
            return hold("pickup_contact_wait_envelope", nowMs, false);
        }
        return step(
            Outcome.DRIVE,
            pickupCell,
            player.aligned(),
            !player.aligned(),
            player.aligned() ? "pickup_contact_approach" : "pickup_contact_aligning",
            nowMs,
            synchronization,
            false
        );
    }

    private Step reachResume(long nowMs, Synchronization synchronization) {
        phase = Phase.RESUME;
        stableFeet = resumeCell;
        return step(
            Outcome.RESUME_REACHED,
            resumeCell,
            false,
            true,
            "resume_reached",
            nowMs,
            synchronization,
            false
        );
    }

    private Step complete(
        PlayerObservation player,
        VoxelPerception perception,
        long nowMs
    ) {
        if (!player.onGround()
            || player.feet().y() != planeY
            || !player.feet().equals(resumeCell)) {
            return reject("resume_displaced", nowMs);
        }
        if (!planeStandable(perception, resumeCell, planeY)) {
            return reject("resume_invalidated", nowMs);
        }
        Step result = step(
            Outcome.COMPLETED,
            resumeCell,
            false,
            true,
            "plane_restored",
            nowMs,
            Synchronization.NONE,
            false
        );
        clear();
        return result;
    }

    private StartResult failedStart(String reason) {
        int computations = routeComputations;
        clear();
        return new StartResult(false, null, List.of(), computations, reason);
    }

    private Step hold(String reason, long nowMs, boolean replanned) {
        return step(
            Outcome.HOLD,
            activeWaypoint(),
            false,
            true,
            reason,
            nowMs,
            Synchronization.NONE,
            replanned
        );
    }

    private Step reject(String reason, long nowMs) {
        Step result = step(
            Outcome.REJECTED,
            activeWaypoint(),
            false,
            true,
            reason,
            nowMs,
            Synchronization.NONE,
            false
        );
        clear();
        return result;
    }

    private Step step(
        Outcome outcome,
        VoxelCell waypoint,
        boolean forward,
        boolean stopped,
        String reason,
        long nowMs,
        Synchronization synchronization,
        boolean replanned
    ) {
        return new Step(
            outcome,
            phase,
            waypoint,
            forward,
            stopped,
            reason,
            waypointIndex,
            remainingCells(),
            maximumWaypointIndex,
            synchronization.advanced(),
            synchronization.forwardResynchronized(),
            replanned,
            routeComputations,
            Math.max(0L, nowMs - lastProgressAtMs),
            Math.max(0L, nowMs - startedAtMs)
        );
    }

    private Step idleStep() {
        return new Step(
            Outcome.IDLE,
            Phase.IDLE,
            null,
            false,
            true,
            "idle",
            -1,
            0,
            -1,
            false,
            false,
            false,
            0,
            0L,
            0L
        );
    }

    private Synchronization synchronizeForward(PlayerObservation player, long nowMs) {
        if (!player.onGround() || waypointIndex < 0 || waypointIndex >= activeRoute.size()) {
            return Synchronization.NONE;
        }
        int end = Math.min(activeRoute.size() - 1, waypointIndex + MAX_FORWARD_RESYNC_CELLS);
        for (int index = end; index >= waypointIndex; index--) {
            if (!activeRoute.get(index).equals(player.feet())) {
                continue;
            }
            boolean resynchronized = index > waypointIndex;
            waypointIndex = index + 1;
            maximumWaypointIndex = Math.max(maximumWaypointIndex, index);
            stableFeet = player.feet();
            lastProgressAtMs = nowMs;
            bestPreciseDistance = Double.POSITIVE_INFINITY;
            return new Synchronization(true, resynchronized);
        }
        return Synchronization.NONE;
    }

    private void observePreciseProgress(
        PlayerObservation player,
        VoxelCell waypoint,
        long nowMs
    ) {
        double dx = (waypoint.x() + 0.5D) - player.x();
        double dz = (waypoint.z() + 0.5D) - player.z();
        double distance = Math.hypot(dx, dz);
        if (Double.isInfinite(bestPreciseDistance)) {
            bestPreciseDistance = distance;
            return;
        }
        if (distance <= bestPreciseDistance - PRECISE_PROGRESS_BLOCKS) {
            bestPreciseDistance = distance;
            lastProgressAtMs = nowMs;
        }
    }

    private boolean validPlayerOnPlane(PlayerObservation player, VoxelPerception perception) {
        return player != null
            && player.feet() != null
            && player.onGround()
            && player.feet().y() == planeY
            && planeStandable(perception, player.feet(), planeY);
    }

    private boolean recordRouteComputation() {
        if (routeComputations >= MAX_ROUTE_COMPUTATIONS) {
            return false;
        }
        if (routeAttemptTracker != null) {
            if (!routeAttemptTracker.recordRouteAttempt()) {
                routeComputations = routeAttemptTracker.routeAttempts();
                return false;
            }
            routeComputations = routeAttemptTracker.routeAttempts();
            return true;
        }
        routeComputations++;
        return true;
    }

    private boolean movedBeyondReplanThreshold(OwnedDropTracker.Position current) {
        return plannedDropPosition != null
            && current != null
            && plannedDropPosition.squaredDistanceTo(current)
                > REPLAN_ITEM_MOVEMENT * REPLAN_ITEM_MOVEMENT;
    }

    private VoxelCell activeWaypoint() {
        return waypointIndex >= 0 && waypointIndex < activeRoute.size()
            ? activeRoute.get(waypointIndex)
            : null;
    }

    private static PlannedRoute plan(
        VoxelPerception perception,
        VoxelCell start,
        int planeY,
        OwnedDropTracker.Position drop
    ) {
        PlanePerception plane = new PlanePerception(perception, planeY, start);
        CollectTarget3DPlanner.TargetPlan target = CollectTarget3DPlanner.chooseTarget(
            plane,
            start,
            drop.x(),
            drop.y(),
            drop.z()
        );
        if (target.cell() == null || target.route().isEmpty()) {
            // The shared collector intentionally uses a symmetric +/-1.5 Y
            // approximation. Iron recovery has an exact-plane contract and a
            // closer model of the real expanded player pickup box, whose upper
            // reach includes drops resting two blocks above the feet plane.
            PlannedRoute alternative = boundedAlternative(plane, start, planeY, drop);
            return alternative.accepted()
                ? alternative
                : PlannedRoute.rejected(target.reason());
        }
        boolean targetPickupFeasible = pickupEnvelopeFeasible(target.cell(), drop);
        if (target.route().size() > MAX_ROUTE_CELLS || !targetPickupFeasible) {
            PlannedRoute alternative = boundedAlternative(plane, start, planeY, drop);
            return alternative.accepted()
                ? alternative
                : PlannedRoute.rejected(target.route().size() > MAX_ROUTE_CELLS
                    ? "route_cell_limit"
                    : "no_reachable_pickup_cell");
        }
        if (!validPlaneRoute(target.route(), start, planeY)) {
            return PlannedRoute.rejected("route_not_same_plane");
        }
        return new PlannedRoute(target.cell(), target.route(), "route_selected");
    }

    /**
     * The shared planner ranks pickup proximity before route length. If that preferred stance is
     * over the iron controller's 16-cell cap, inspect the same bounded pickup envelope for the
     * best cap-compliant stance instead of rejecting a reachable alternative.
     */
    private static PlannedRoute boundedAlternative(
        PlanePerception perception,
        VoxelCell start,
        int planeY,
        OwnedDropTracker.Position drop
    ) {
        List<BoundedPickupCandidate> candidates = new ArrayList<>();
        for (int x = perception.minX(); x <= perception.maxX(); x++) {
            for (int z = perception.minZ(); z <= perception.maxZ(); z++) {
                VoxelCell cell = new VoxelCell(x, planeY, z);
                if (!pickupEnvelopeFeasible(cell, drop)
                    || !perception.isStandable(x, planeY, z)) {
                    continue;
                }
                Nav3DRouteDiagnostic diagnostic = VoxelAStar.diagnose(perception, start, cell);
                if (!diagnostic.routeFound()
                    || diagnostic.route().size() > MAX_ROUTE_CELLS
                    || !validPlaneRoute(diagnostic.route(), start, planeY)) {
                    continue;
                }
                candidates.add(new BoundedPickupCandidate(
                    cell,
                    diagnostic.route(),
                    pickupDistanceSquared(cell, drop)
                ));
            }
        }
        if (candidates.isEmpty()) {
            return PlannedRoute.rejected("route_cell_limit");
        }
        candidates.sort(Comparator
            .comparingDouble(BoundedPickupCandidate::pickupDistanceSquared)
            .thenComparingInt(candidate -> candidate.route().size())
            .thenComparingInt(candidate -> candidate.cell().y())
            .thenComparingInt(candidate -> candidate.cell().z())
            .thenComparingInt(candidate -> candidate.cell().x()));
        BoundedPickupCandidate best = candidates.getFirst();
        return new PlannedRoute(best.cell(), best.route(), "bounded_pickup_alternative");
    }

    private static double pickupDistanceSquared(
        VoxelCell cell,
        OwnedDropTracker.Position drop
    ) {
        double dx = (cell.x() + 0.5D) - drop.x();
        double dy = cell.y() - drop.y();
        double dz = (cell.z() + 0.5D) - drop.z();
        return dx * dx + dy * dy + dz * dz;
    }

    private static double contactCoordinate(double dropCoordinate, int cellCoordinate) {
        double center = cellCoordinate + 0.5D;
        double shift = Math.max(
            -PICKUP_CONTACT_MAX_SHIFT,
            Math.min(PICKUP_CONTACT_MAX_SHIFT, dropCoordinate - center)
        );
        return center + shift;
    }

    private void refreshPickupContact(OwnedDropTracker.Position currentPosition) {
        if (pickupCell == null
            || currentPosition == null
            || !pickupEnvelopeFeasible(pickupCell, currentPosition)) {
            return;
        }
        pickupContactX = contactCoordinate(currentPosition.x(), pickupCell.x());
        pickupContactZ = contactCoordinate(currentPosition.z(), pickupCell.z());
    }

    static boolean pickupEnvelopeFeasible(
        VoxelCell cell,
        OwnedDropTracker.Position drop
    ) {
        if (cell == null
            || drop == null
            || !Double.isFinite(drop.x())
            || !Double.isFinite(drop.y())
            || !Double.isFinite(drop.z())) {
            return false;
        }
        double horizontalX = Math.abs((cell.x() + 0.5D) - drop.x());
        double horizontalZ = Math.abs((cell.z() + 0.5D) - drop.z());
        double verticalOffset = drop.y() - cell.y();
        return horizontalX <= PICKUP_ENVELOPE_MAX_HORIZONTAL_AXIS_OFFSET
            && horizontalZ <= PICKUP_ENVELOPE_MAX_HORIZONTAL_AXIS_OFFSET
            && verticalOffset >= PICKUP_ENVELOPE_MIN_VERTICAL_OFFSET
            && verticalOffset <= PICKUP_ENVELOPE_MAX_VERTICAL_OFFSET;
    }

    private static boolean validPlaneRoute(List<VoxelCell> route, VoxelCell start, int planeY) {
        if (route == null
            || route.isEmpty()
            || route.size() > MAX_ROUTE_CELLS
            || start == null
            || !start.equals(route.get(0))) {
            return false;
        }
        for (int index = 0; index < route.size(); index++) {
            VoxelCell cell = route.get(index);
            if (cell == null || cell.y() != planeY) {
                return false;
            }
            if (index > 0 && !samePlaneAdjacent(route.get(index - 1), cell)) {
                return false;
            }
        }
        return true;
    }

    private static List<VoxelCell> splice(
        List<VoxelCell> existing,
        int currentIndex,
        List<VoxelCell> suffix
    ) {
        if (existing == null
            || suffix == null
            || suffix.isEmpty()
            || currentIndex < 0
            || currentIndex >= existing.size()
            || !existing.get(currentIndex).equals(suffix.get(0))) {
            return List.of();
        }
        List<VoxelCell> combined = new ArrayList<>(existing.subList(0, currentIndex + 1));
        for (int index = 1; index < suffix.size(); index++) {
            VoxelCell cell = suffix.get(index);
            if (combined.contains(cell)) {
                return List.of();
            }
            combined.add(cell);
        }
        return List.copyOf(combined);
    }

    private static boolean samePlaneAdjacent(VoxelCell first, VoxelCell second) {
        return first != null
            && second != null
            && first.y() == second.y()
            && Math.abs(first.x() - second.x()) + Math.abs(first.z() - second.z()) == 1;
    }

    private static boolean planeStandable(VoxelPerception perception, VoxelCell cell, int planeY) {
        return perception != null
            && cell != null
            && cell.y() == planeY
            && perception.isStandable(cell.x(), cell.y(), cell.z())
            && !hasAdjacentHazard(perception, cell);
    }

    /** VoxelPerception exposes hazard kind only as a bit; conservatively treat adjacent hazards as lava. */
    private static boolean hasAdjacentHazard(VoxelPerception perception, VoxelCell cell) {
        int[][] directions = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        for (int[] direction : directions) {
            int x = cell.x() + direction[0];
            int z = cell.z() + direction[1];
            for (int y = cell.y() - 1; y <= cell.y() + 1; y++) {
                if (perception.inBounds(x, y, z) && perception.isHazard(x, y, z)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean validPlane(int planeY) {
        return planeY >= MIN_PROSPECT_FEET_Y && planeY <= MAX_PROSPECT_FEET_Y;
    }

    private static long saturatedAdd(long first, long second) {
        if (second > 0L && first > Long.MAX_VALUE - second) {
            return Long.MAX_VALUE;
        }
        return first + second;
    }

    private static String normalizedReason(String reason) {
        return reason == null || reason.isBlank() ? "unknown" : reason;
    }

    private record PlannedRoute(VoxelCell pickupCell, List<VoxelCell> route, String reason) {
        PlannedRoute {
            route = route == null ? List.of() : List.copyOf(route);
            reason = normalizedReason(reason);
        }

        static PlannedRoute rejected(String reason) {
            return new PlannedRoute(null, List.of(), reason);
        }

        boolean accepted() {
            return pickupCell != null && !route.isEmpty();
        }
    }

    private record BoundedPickupCandidate(
        VoxelCell cell,
        List<VoxelCell> route,
        double pickupDistanceSquared
    ) {
        BoundedPickupCandidate {
            route = List.copyOf(route);
        }
    }

    private record Synchronization(boolean advanced, boolean forwardResynchronized) {
        private static final Synchronization NONE = new Synchronization(false, false);
    }

    /** Restricts standable feet cells and planner bounds to the frozen prospect plane. */
    private static final class PlanePerception implements VoxelPerception {
        private final VoxelPerception delegate;
        private final int planeY;
        private final int minX;
        private final int maxX;
        private final int minZ;
        private final int maxZ;

        private PlanePerception(VoxelPerception delegate, int planeY, VoxelCell start) {
            this.delegate = delegate;
            this.planeY = planeY;
            int reach = MAX_ROUTE_CELLS - 1;
            minX = Math.max(delegate.minX(), start.x() - reach);
            maxX = Math.min(delegate.maxX(), start.x() + reach);
            minZ = Math.max(delegate.minZ(), start.z() - reach);
            maxZ = Math.min(delegate.maxZ(), start.z() + reach);
        }

        @Override
        public int minX() {
            return minX;
        }

        @Override
        public int maxX() {
            return maxX;
        }

        @Override
        public int minY() {
            return delegate.minY();
        }

        @Override
        public int maxY() {
            return delegate.maxY();
        }

        @Override
        public int minZ() {
            return minZ;
        }

        @Override
        public int maxZ() {
            return maxZ;
        }

        @Override
        public boolean isSolid(int x, int y, int z) {
            return delegate.isSolid(x, y, z);
        }

        @Override
        public boolean isHazard(int x, int y, int z) {
            return delegate.isHazard(x, y, z);
        }

        @Override
        public boolean isStandable(int x, int y, int z) {
            return y == planeY
                && x >= minX && x <= maxX
                && z >= minZ && z <= maxZ
                && planeStandable(delegate, new VoxelCell(x, y, z), planeY);
        }
    }
}
