package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class LookDemandTest {
    @Test
    void normalizesYawAndClampsPitch() {
        LookDemand demand = demand(540.0D, 140.0D);

        assertEquals(-180.0D, demand.desiredYaw());
        assertEquals(90.0D, demand.desiredPitch());
    }

    @Test
    void rejectsNonFiniteAnglesAndBlankIdentity() {
        assertThrows(IllegalArgumentException.class, () -> demand(Double.NaN, 0.0D));
        assertThrows(IllegalArgumentException.class, () -> new LookDemand(
            LookDemand.Owner.NORMAL,
            " ",
            LookDemand.Profile.TRAVEL,
            0.0D,
            0.0D,
            LookDemand.RetargetPolicy.CONTINUOUS,
            "command",
            "travel"
        ));
    }

    @Test
    void criticalDemandMustUseImmediateRetargeting() {
        assertThrows(IllegalArgumentException.class, () -> new LookDemand(
            LookDemand.Owner.SURVIVAL,
            "escape",
            LookDemand.Profile.CRITICAL,
            0.0D,
            -75.0D,
            LookDemand.RetargetPolicy.COMMITTED,
            "command",
            "swim_up"
        ));
    }

    @Test
    void commitmentScopeUsesCommandAndReason() {
        LookDemand initial = precision("command", "aim_block", "block:a", 0.0D);

        assertEquals(true, initial.sameCommitmentScope(precision("command", "aim_block", "block:b", 90.0D)));
        assertEquals(false, initial.sameCommitmentScope(precision("command", "break_block", "block:a", 0.0D)));
        assertEquals(false, initial.sameCommitmentScope(precision("next", "aim_block", "block:a", 0.0D)));
        assertEquals(false, initial.sameCommitmentScope(new LookDemand(
            LookDemand.Owner.HUNT,
            "block:a",
            LookDemand.Profile.PRECISION,
            0.0D,
            0.0D,
            LookDemand.RetargetPolicy.COMMITTED,
            "command",
            "aim_block"
        )));
    }

    @Test
    void derivesNormalProfilesWithoutChangingIntentAngles() {
        LookDemand travel = LookDemand.fromNormalDecision(
            intent("nav3d_test_nav3d", -90.0D, 65.0D),
            new InputState(true, false, false, false, false, false, 1.0F, 0.0F)
        );
        assertEquals(LookDemand.Owner.NORMAL, travel.owner());
        assertEquals(LookDemand.Profile.TRAVEL, travel.profile());
        assertEquals(LookDemand.RetargetPolicy.CONTINUOUS, travel.retargetPolicy());
        assertEquals(-90.0D, travel.desiredYaw());
        assertEquals(65.0D, travel.desiredPitch());

        LookDemand tracking = LookDemand.fromNormalDecision(
            intent("gather_tree_collect_close", 20.0D, 10.0D),
            new InputState(true, false, false, false, false, false, 1.0F, 0.0F)
        );
        assertEquals(LookDemand.Profile.TRACKING, tracking.profile());
        assertEquals(LookDemand.RetargetPolicy.CONTINUOUS, tracking.retargetPolicy());

        LookDemand precision = LookDemand.fromNormalDecision(
            intent("gather_tree_breaking", 40.0D, 50.0D),
            InputState.stop()
        );
        assertEquals(LookDemand.Profile.PRECISION, precision.profile());
        assertEquals(LookDemand.RetargetPolicy.COMMITTED, precision.retargetPolicy());
    }

    @Test
    void preservesCurrentAxisWhenAnIntentSuppliesOnlyOneAngle() {
        BrainLink.Intent yawOnly = new BrainLink.Intent(
            "aim_block",
            false,
            false,
            false,
            false,
            false,
            false,
            40.0D,
            null,
            1.0D,
            64.0D,
            2.0D,
            java.util.List.of(),
            java.util.List.of(),
            null,
            java.util.List.of(),
            10_000L,
            "aim_block",
            "command"
        );

        LookDemand demand = LookDemand.fromNormalDecision(
            yawOnly,
            InputState.stop(),
            -15.0D,
            -32.0D
        );

        assertEquals(40.0D, demand.desiredYaw());
        assertEquals(-32.0D, demand.desiredPitch());
    }

    @Test
    void precisionIdentityChangesWithTheCodeOwnedBlockTarget() {
        LookDemand first = LookDemand.fromNormalDecision(
            intent("gather_tree_breaking", 40.0D, 50.0D, 1.0D, 64.0D, 2.0D),
            InputState.stop()
        );
        LookDemand second = LookDemand.fromNormalDecision(
            intent("gather_tree_breaking", 41.0D, 49.0D, 3.0D, 65.0D, 4.0D),
            InputState.stop()
        );

        assertEquals("fixed:command:gather_tree_breaking:1.0:64.0:2.0", first.targetIdentity());
        assertEquals("fixed:command:gather_tree_breaking:3.0:65.0:4.0", second.targetIdentity());
        assertEquals(false, first.targetIdentity().equals(second.targetIdentity()));
        assertEquals(true, first.sameCommitmentScope(second));
    }

    private static LookDemand demand(double yaw, double pitch) {
        return new LookDemand(
            LookDemand.Owner.NORMAL,
            "route:1:2",
            LookDemand.Profile.TRAVEL,
            yaw,
            pitch,
            LookDemand.RetargetPolicy.CONTINUOUS,
            "command",
            "travel"
        );
    }

    private static LookDemand precision(String command, String reason, String target, double yaw) {
        return new LookDemand(
            LookDemand.Owner.NORMAL,
            target,
            LookDemand.Profile.PRECISION,
            yaw,
            0.0D,
            LookDemand.RetargetPolicy.COMMITTED,
            command,
            reason
        );
    }

    private static BrainLink.Intent intent(String reason, double yaw, double pitch) {
        return intent(reason, yaw, pitch, 1.0D, 64.0D, 2.0D);
    }

    private static BrainLink.Intent intent(
        String reason,
        double yaw,
        double pitch,
        double targetX,
        double targetY,
        double targetZ
    ) {
        return new BrainLink.Intent(
            reason,
            false,
            false,
            false,
            false,
            false,
            false,
            yaw,
            pitch,
            targetX,
            targetY,
            targetZ,
            java.util.List.of(),
            java.util.List.of(),
            null,
            java.util.List.of(),
            10_000L,
            reason,
            "command"
        );
    }
}
