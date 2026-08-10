package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.util.math.Box;
import org.junit.jupiter.api.Test;

final class MissionStonePickupEnvelopeTest {
    private static final OwnedDropTracker.Position CENTER = position(100.5D, 64.0D, -20.5D);

    @Test
    void exactCenterAndInclusiveEnvelopeBoundariesAreAccepted() {
        assertTrue(MissionStonePickupEnvelope.futureLandingContains(CENTER, CENTER));
        assertTrue(MissionStonePickupEnvelope.futureLandingContains(CENTER, offset(0.95D, -0.5D, 0.95D)));
        assertTrue(MissionStonePickupEnvelope.futureLandingContains(CENTER, offset(-0.95D, 2.3D, -0.95D)));
        assertTrue(MissionStonePickupEnvelope.futureLandingContains(CENTER, offset(0.95D, 2.3D, -0.95D)));
        assertTrue(MissionStonePickupEnvelope.futureLandingContains(CENTER, offset(-0.95D, -0.5D, 0.95D)));
    }

    @Test
    void anyHorizontalAxisOutsideTheCoreIsRejected() {
        double outside = MissionStonePickupEnvelope.FUTURE_HORIZONTAL_CORE + 0.000_001D;

        assertFalse(MissionStonePickupEnvelope.futureLandingContains(CENTER, offset(outside, 0.0D, 0.0D)));
        assertFalse(MissionStonePickupEnvelope.futureLandingContains(CENTER, offset(-outside, 0.0D, 0.0D)));
        assertFalse(MissionStonePickupEnvelope.futureLandingContains(CENTER, offset(0.0D, 0.0D, outside)));
        assertFalse(MissionStonePickupEnvelope.futureLandingContains(CENTER, offset(0.0D, 0.0D, -outside)));
    }

    @Test
    void anyVerticalOffsetOutsideTheAsymmetricCoreIsRejected() {
        assertFalse(MissionStonePickupEnvelope.futureLandingContains(
            CENTER,
            offset(0.0D, MissionStonePickupEnvelope.MIN_VERTICAL_OFFSET - 0.000_001D, 0.0D)
        ));
        assertFalse(MissionStonePickupEnvelope.futureLandingContains(
            CENTER,
            offset(0.0D, MissionStonePickupEnvelope.MAX_VERTICAL_OFFSET + 0.000_001D, 0.0D)
        ));
    }

    @Test
    void legacyTwoBlockSphereFalsePositivesAreRejected() {
        assertFalse(MissionStonePickupEnvelope.futureLandingContains(CENTER, offset(1.5D, 0.0D, 0.0D)));
        assertFalse(MissionStonePickupEnvelope.futureLandingContains(CENTER, offset(0.0D, 0.0D, -1.5D)));
    }

    @Test
    void nullAndNonFiniteCoordinatesFailClosed() {
        assertFalse(MissionStonePickupEnvelope.futureLandingContains(null, CENTER));
        assertFalse(MissionStonePickupEnvelope.futureLandingContains(CENTER, (OwnedDropTracker.Position) null));
        assertFalse(MissionStonePickupEnvelope.futureLandingContains(
            position(Double.NaN, 64.0D, 0.0D), CENTER));
        assertFalse(MissionStonePickupEnvelope.futureLandingContains(
            CENTER, position(Double.POSITIVE_INFINITY, 64.0D, 0.0D)));
        assertFalse(MissionStonePickupEnvelope.futureLandingContains(
            CENTER, position(0.0D, Double.NEGATIVE_INFINITY, 0.0D)));
    }

    @Test
    void currentPlayerUsesMinecraftExpandedPickupBoxRatherThanASphere() {
        Box player = new Box(-0.3D, 64.0D, -0.3D, 0.3D, 65.8D, 0.3D);

        assertTrue(MissionStonePickupEnvelope.currentPlayerContains(
            player, itemBox(1.2D, 64.0D, 0.0D)));
        assertFalse(MissionStonePickupEnvelope.currentPlayerContains(
            player, itemBox(1.6D, 64.0D, 0.0D)));
        assertFalse(MissionStonePickupEnvelope.currentPlayerContains(
            player, itemBox(0.0D, 66.6D, 0.0D)));
    }

    @Test
    void futureLandingItemBoxMustIntersectTheGuaranteedCommonCore() {
        assertTrue(MissionStonePickupEnvelope.futureLandingContains(
            CENTER, itemBox(CENTER.x() + 1.0D, CENTER.y(), CENTER.z())));
        assertFalse(MissionStonePickupEnvelope.futureLandingContains(
            CENTER, itemBox(CENTER.x() + 1.2D, CENTER.y(), CENTER.z())));
    }

    private static OwnedDropTracker.Position offset(double dx, double dy, double dz) {
        return position(CENTER.x() + dx, CENTER.y() + dy, CENTER.z() + dz);
    }

    private static OwnedDropTracker.Position position(double x, double y, double z) {
        return new OwnedDropTracker.Position(x, y, z);
    }

    private static Box itemBox(double x, double y, double z) {
        return new Box(x - 0.125D, y, z - 0.125D, x + 0.125D, y + 0.25D, z + 0.125D);
    }
}
