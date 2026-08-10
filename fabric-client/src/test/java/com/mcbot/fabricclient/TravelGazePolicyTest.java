package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class TravelGazePolicyTest {
    private static final double EPSILON = 0.000_001D;

    @Test
    void levelWaypointUsesRawSteeringYawAndStablePitch() {
        LookDemand demand = demand(
            new VoxelCell(2, 64, 3),
            new VoxelCell(3, 64, 3),
            false,
            -42.0D
        );

        assertEquals(LookDemand.Owner.NORMAL, demand.owner());
        assertEquals(LookDemand.Profile.TRAVEL, demand.profile());
        assertEquals(LookDemand.RetargetPolicy.CONTINUOUS, demand.retargetPolicy());
        assertEquals(-90.0D, demand.desiredYaw(), EPSILON);
        assertEquals(TravelGazePolicy.STABLE_TRAVEL_PITCH_DEG, demand.desiredPitch(), EPSILON);
    }

    @Test
    void stepUpKeepsStableTravelPitchInsteadOfFeetLevelPitch() {
        LookDemand demand = demand(
            new VoxelCell(2, 64, 3),
            new VoxelCell(2, 65, 4),
            false,
            -61.0D
        );

        assertEquals(0.0D, demand.desiredYaw(), EPSILON);
        assertEquals(8.0D, demand.desiredPitch(), EPSILON);
    }

    @Test
    void committedLowerWaypointPreservesExactPitch() {
        LookDemand demand = demand(
            new VoxelCell(2, 64, 3),
            new VoxelCell(2, 62, 4),
            true,
            47.25D
        );

        assertEquals(0.0D, demand.desiredYaw(), EPSILON);
        assertEquals(47.25D, demand.desiredPitch(), EPSILON);
    }

    @Test
    void sameHorizontalPositionPreservesCurrentYaw() {
        LookDemand demand = TravelGazePolicy.demand(
            "command-7",
            12L,
            4,
            "drop:84",
            "owned_drop_nav3d",
            2.5D,
            3.5D,
            137.0D,
            new VoxelCell(2, 64, 3),
            new VoxelCell(2, 64, 3),
            false,
            -70.0D
        );

        assertEquals(137.0D, demand.desiredYaw(), EPSILON);
        assertEquals(8.0D, demand.desiredPitch(), EPSILON);
    }

    @Test
    void identityIncludesCommandRouteWaypointAndTarget() {
        LookDemand demand = demand(
            new VoxelCell(2, 64, 3),
            new VoxelCell(3, 64, 3),
            false,
            0.0D
        );

        assertEquals(
            "travel:command-7:route=12:waypoint=4:target=drop:84",
            demand.targetIdentity()
        );
        assertEquals("command-7", demand.commandId());
        assertEquals("owned_drop_nav3d", demand.reason());
    }

    @Test
    void lowerWaypointRequiresExplicitCommittedDescent() {
        assertThrows(
            IllegalArgumentException.class,
            () -> demand(
                new VoxelCell(2, 64, 3),
                new VoxelCell(2, 63, 4),
                false,
                35.0D
            )
        );
    }

    @Test
    void committedDescentCannotTargetLevelOrHigherWaypoint() {
        assertThrows(
            IllegalArgumentException.class,
            () -> demand(
                new VoxelCell(2, 64, 3),
                new VoxelCell(2, 64, 4),
                true,
                35.0D
            )
        );
    }

    @Test
    void invalidRouteMetadataAndNonFiniteInputsFailClosed() {
        assertThrows(
            IllegalArgumentException.class,
            () -> TravelGazePolicy.demand(
                "command-7",
                -1L,
                4,
                "drop:84",
                "owned_drop_nav3d",
                2.5D,
                3.5D,
                0.0D,
                new VoxelCell(2, 64, 3),
                new VoxelCell(3, 64, 3),
                false,
                0.0D
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> TravelGazePolicy.demand(
                "command-7",
                12L,
                -1,
                "drop:84",
                "owned_drop_nav3d",
                2.5D,
                3.5D,
                0.0D,
                new VoxelCell(2, 64, 3),
                new VoxelCell(3, 64, 3),
                false,
                0.0D
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> TravelGazePolicy.demand(
                "command-7",
                12L,
                4,
                "drop:84",
                "owned_drop_nav3d",
                Double.NaN,
                3.5D,
                0.0D,
                new VoxelCell(2, 64, 3),
                new VoxelCell(3, 64, 3),
                false,
                0.0D
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> TravelGazePolicy.demand(
                "command-7",
                12L,
                4,
                " ",
                "owned_drop_nav3d",
                2.5D,
                3.5D,
                0.0D,
                new VoxelCell(2, 64, 3),
                new VoxelCell(3, 64, 3),
                false,
                0.0D
            )
        );
    }

    private static LookDemand demand(
        VoxelCell playerFeet,
        VoxelCell waypoint,
        boolean committedDescent,
        double exactPitch
    ) {
        return TravelGazePolicy.demand(
            "command-7",
            12L,
            4,
            "drop:84",
            "owned_drop_nav3d",
            2.5D,
            3.5D,
            0.0D,
            playerFeet,
            waypoint,
            committedDescent,
            exactPitch
        );
    }
}
