package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class LocomotionDemandTest {
    @Test
    void passthroughFactoryPreservesRawInputAndLegacySprint() {
        InputState raw = new InputState(true, false, false, false, true, false, 0.42F, 0.0F);

        LocomotionDemand demand = LocomotionDemand.passthrough(
            LookDemand.Owner.HUNT,
            raw,
            true,
            "hunt-1",
            "hunt_sheep"
        );

        assertEquals(LocomotionDemand.Policy.PASSTHROUGH, demand.policy());
        assertEquals(raw, demand.rawInput());
        assertEquals(true, demand.legacySprintRequested());
        assertEquals(LocomotionDemand.JumpPolicy.CONTINUOUS, demand.jumpPolicy());
        assertNull(demand.stepIdentity());
    }

    @Test
    void routeDemandNormalizesYawAndRequiresRouteIdentity() {
        LocomotionDemand demand = routeDemand(540.0D, LocomotionDemand.JumpPolicy.NONE, null);

        assertEquals(-180.0D, demand.desiredYaw(), 0.000_001D);
        assertEquals(7L, demand.routeGeneration());
        assertEquals(3, demand.waypointIndex());

        assertThrows(
            IllegalArgumentException.class,
            () -> new LocomotionDemand(
                LookDemand.Owner.NORMAL,
                LocomotionDemand.Policy.ROUTE_TRAVEL,
                forward(false),
                false,
                "cmd",
                -1L,
                3,
                "segment",
                0.0D,
                false,
                false,
                true,
                LocomotionDemand.JumpPolicy.NONE,
                null,
                "travel"
            )
        );
    }

    @Test
    void pulsePoliciesRequireAnIdentityAndOtherPoliciesRejectOne() {
        LocomotionDemand.StepIdentity identity = stepIdentity();

        assertThrows(
            IllegalArgumentException.class,
            () -> routeDemand(0.0D, LocomotionDemand.JumpPolicy.STEP_PULSE, null)
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> routeDemand(0.0D, LocomotionDemand.JumpPolicy.NONE, identity)
        );
        assertEquals(
            identity,
            routeDemand(0.0D, LocomotionDemand.JumpPolicy.UNSTICK_PULSE, identity)
                .stepIdentity()
        );
    }

    @Test
    void pulseIdentityMustMatchItsOuterRouteIdentity() {
        LocomotionDemand.StepIdentity mismatched = new LocomotionDemand.StepIdentity(
            "other",
            7L,
            3,
            new VoxelCell(2, 64, 3),
            new VoxelCell(3, 65, 3)
        );

        assertThrows(
            IllegalArgumentException.class,
            () -> routeDemand(0.0D, LocomotionDemand.JumpPolicy.STEP_PULSE, mismatched)
        );
    }

    private static LocomotionDemand routeDemand(
        double yaw,
        LocomotionDemand.JumpPolicy jumpPolicy,
        LocomotionDemand.StepIdentity identity
    ) {
        return new LocomotionDemand(
            LookDemand.Owner.NORMAL,
            LocomotionDemand.Policy.ROUTE_TRAVEL,
            forward(jumpPolicy != LocomotionDemand.JumpPolicy.NONE),
            false,
            "cmd",
            7L,
            3,
            "route:7:3",
            yaw,
            true,
            false,
            true,
            jumpPolicy,
            identity,
            "navigation_travel"
        );
    }

    private static LocomotionDemand.StepIdentity stepIdentity() {
        return new LocomotionDemand.StepIdentity(
            "cmd",
            7L,
            3,
            new VoxelCell(2, 64, 3),
            new VoxelCell(3, 65, 3)
        );
    }

    private static InputState forward(boolean jump) {
        return new InputState(true, false, false, false, jump, false, 0.42F, 0.0F);
    }
}
