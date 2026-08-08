package com.mcbot.fabricclient;

import net.minecraft.util.math.Box;

/**
 * Conservative auto-pickup classification for a cobblestone drop relative to one exact feet or
 * route-center position.
 *
 * <p>The former two-block spherical test admitted drops beside a player or future route cell even
 * when Minecraft's pickup collision could never intersect them. Current-player admission uses the
 * exact expanded pickup box. A future landing uses the common inner core across the controller's
 * allowed 0.35-block arrival tolerance. A false negative is safe: it enters the existing bounded
 * owned-drop recovery path.
 */
final class MissionStonePickupEnvelope {
    static final double PLAYER_HORIZONTAL_EXPANSION = 1.0D;
    static final double PLAYER_VERTICAL_EXPANSION = 0.5D;
    static final double FUTURE_HORIZONTAL_CORE = 0.95D;
    static final double MIN_VERTICAL_OFFSET = -0.5D;
    static final double MAX_VERTICAL_OFFSET = 2.3D;
    private static final double COORDINATE_EPSILON = 1.0E-9D;

    private MissionStonePickupEnvelope() {
    }

    /**
     * Returns whether {@code drop} is inside the conservative pickup core around
     * {@code exactFeetOrRouteCenter}. Bounds are inclusive and invalid coordinates fail closed.
     */
    static boolean currentPlayerContains(Box playerBox, Box itemBox) {
        return finite(playerBox)
            && finite(itemBox)
            && playerBox.expand(PLAYER_HORIZONTAL_EXPANSION, PLAYER_VERTICAL_EXPANSION,
                PLAYER_HORIZONTAL_EXPANSION).intersects(itemBox);
    }

    static boolean futureLandingContains(
        OwnedDropTracker.Position exactFeetOrRouteCenter,
        OwnedDropTracker.Position drop
    ) {
        if (!finite(exactFeetOrRouteCenter) || !finite(drop)) {
            return false;
        }
        double dx = drop.x() - exactFeetOrRouteCenter.x();
        double dy = drop.y() - exactFeetOrRouteCenter.y();
        double dz = drop.z() - exactFeetOrRouteCenter.z();
        return Math.abs(dx) <= FUTURE_HORIZONTAL_CORE + COORDINATE_EPSILON
            && dy >= MIN_VERTICAL_OFFSET - COORDINATE_EPSILON
            && dy <= MAX_VERTICAL_OFFSET + COORDINATE_EPSILON
            && Math.abs(dz) <= FUTURE_HORIZONTAL_CORE + COORDINATE_EPSILON;
    }

    static boolean futureLandingContains(
        OwnedDropTracker.Position exactFeetOrRouteCenter,
        Box itemBox
    ) {
        if (!finite(exactFeetOrRouteCenter) || !finite(itemBox)) {
            return false;
        }
        Box commonPickupCore = new Box(
            exactFeetOrRouteCenter.x() - FUTURE_HORIZONTAL_CORE,
            exactFeetOrRouteCenter.y() + MIN_VERTICAL_OFFSET,
            exactFeetOrRouteCenter.z() - FUTURE_HORIZONTAL_CORE,
            exactFeetOrRouteCenter.x() + FUTURE_HORIZONTAL_CORE,
            exactFeetOrRouteCenter.y() + MAX_VERTICAL_OFFSET,
            exactFeetOrRouteCenter.z() + FUTURE_HORIZONTAL_CORE
        );
        return commonPickupCore.intersects(itemBox);
    }

    private static boolean finite(OwnedDropTracker.Position position) {
        return position != null
            && Double.isFinite(position.x())
            && Double.isFinite(position.y())
            && Double.isFinite(position.z());
    }

    private static boolean finite(Box box) {
        return box != null
            && Double.isFinite(box.minX)
            && Double.isFinite(box.minY)
            && Double.isFinite(box.minZ)
            && Double.isFinite(box.maxX)
            && Double.isFinite(box.maxY)
            && Double.isFinite(box.maxZ);
    }
}
