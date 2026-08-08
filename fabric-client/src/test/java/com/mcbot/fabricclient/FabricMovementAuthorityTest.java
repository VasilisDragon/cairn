package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class FabricMovementAuthorityTest {
    @Test
    void legacySprintRequiresEligibleFullForwardInput() {
        InputState fullForward = new InputState(
            true, false, false, false, false, false, 1.0F, 0.0F);
        InputState fractionalForward = new InputState(
            true, false, false, false, false, false, 0.75F, 0.0F);
        InputState sneaking = new InputState(
            true, false, false, false, false, true, 1.0F, 0.0F);

        assertTrue(FabricMovementAuthority.legacySprintRequested(fullForward, true));
        assertFalse(FabricMovementAuthority.legacySprintRequested(fullForward, false));
        assertFalse(FabricMovementAuthority.legacySprintRequested(fractionalForward, true));
        assertFalse(FabricMovementAuthority.legacySprintRequested(sneaking, true));
        assertFalse(FabricMovementAuthority.legacySprintRequested(InputState.stop(), true));
        assertFalse(FabricMovementAuthority.legacySprintRequested(null, true));
    }

    @Test
    void legacyAndShadowApplyTheLegacyInputWhileSmoothAppliesTheCandidate() {
        InputState legacy = new InputState(
            true, false, false, false, false, false, 0.35F, 0.0F);
        InputState smoothInput = new InputState(
            true, false, false, false, false, false, 1.0F, 0.0F);
        FabricLocomotionController.Output smooth =
            new FabricLocomotionController.Output(
                smoothInput,
                true,
                false,
                false,
                true,
                true,
                false,
                false,
                false,
                false,
                5.0D
            );

        FabricMovementAuthority.Selected legacySelected =
            FabricMovementAuthority.selectApplied(
                FabricMotionMode.LEGACY, legacy, false, smooth);
        FabricMovementAuthority.Selected shadowSelected =
            FabricMovementAuthority.selectApplied(
                FabricMotionMode.SHADOW, legacy, false, smooth);
        FabricMovementAuthority.Selected smoothSelected =
            FabricMovementAuthority.selectApplied(
                FabricMotionMode.SMOOTH, legacy, false, smooth);

        assertEquals(legacy, legacySelected.input());
        assertFalse(legacySelected.sprintRequested());
        assertEquals(legacy, shadowSelected.input());
        assertFalse(shadowSelected.sprintRequested());
        assertEquals(smoothInput, smoothSelected.input());
        assertTrue(smoothSelected.sprintRequested());
        assertSame(smooth, legacySelected.smooth());
        assertSame(smooth, shadowSelected.smooth());
        assertSame(smooth, smoothSelected.smooth());
    }

    @Test
    void controlDecisionConstructorsRemainSourceCompatibleAndDemandIsOptional() {
        BrainLink.Intent intent = BrainLink.Intent.stop("compatibility");
        InputState input = InputState.stop();
        LookDemand look = new LookDemand(
            LookDemand.Owner.NORMAL,
            "fixed:compatibility",
            LookDemand.Profile.PRECISION,
            0.0D,
            0.0D,
            LookDemand.RetargetPolicy.COMMITTED,
            "compatibility",
            "compatibility"
        );
        LocomotionDemand locomotion = LocomotionDemand.passthrough(
            LookDemand.Owner.NORMAL,
            input,
            false,
            "compatibility",
            "compatibility"
        );

        assertNull(new ControlDecision(intent, input).locomotionDemand());
        assertNull(new ControlDecision(intent, input, look).locomotionDemand());
        assertNull(new ControlDecision(intent, input, look, look).locomotionDemand());
        assertSame(
            locomotion,
            new ControlDecision(intent, input, look, look, locomotion).locomotionDemand()
        );
    }

    @Test
    void smoothPreviewUsesTheDigitalGateWithoutAdvancingControllerState() {
        InputState raw = new InputState(
            true, false, false, false, false, false, 1.0F, 0.0F);
        FabricLocomotionController.State initial =
            FabricLocomotionController.initialState();
        FabricLocomotionController.Observation start =
            observation(0L, 0.0D);

        InputState misaligned = FabricMovementAuthority.previewAppliedInput(
            FabricMotionMode.SMOOTH,
            initial,
            raw,
            routeDemand(180.0D, 1, "straight:1"),
            start
        );
        InputState aligned = FabricMovementAuthority.previewAppliedInput(
            FabricMotionMode.SMOOTH,
            initial,
            raw,
            routeDemand(0.0D, 1, "straight:1"),
            start
        );

        assertFalse(misaligned.pressingForward());
        assertTrue(aligned.pressingForward());
        assertEquals(FabricLocomotionController.initialState(), initial);

        FabricLocomotionController.Transition engaged =
            FabricLocomotionController.step(
                initial,
                routeDemand(0.0D, 1, "straight:1"),
                start
            );
        FabricLocomotionController.Observation turning =
            observation(50L, 0.0D);
        LocomotionDemand heldTurn = routeDemand(20.0D, 1, "straight:1");
        InputState preview = FabricMovementAuthority.previewAppliedInput(
            FabricMotionMode.SMOOTH,
            engaged.state(),
            raw,
            heldTurn,
            turning
        );
        FabricLocomotionController.Transition committed =
            FabricLocomotionController.step(engaged.state(), heldTurn, turning);

        assertTrue(preview.pressingForward());
        assertEquals(committed.output().input(), preview);
        assertEquals(1, engaged.state().waypointIndex());
        assertTrue(engaged.state().forwardEngaged());
    }

    @Test
    void legacyAndShadowPreviewRemainByteEquivalentToRawInput() {
        InputState raw = new InputState(
            true, false, false, false, false, false, 0.35F, 0.0F);
        LocomotionDemand demand = routeDemand(180.0D, 1, "straight:1");
        FabricLocomotionController.Observation observation =
            observation(0L, 0.0D);

        assertEquals(
            raw,
            FabricMovementAuthority.previewAppliedInput(
                FabricMotionMode.LEGACY,
                FabricLocomotionController.initialState(),
                raw,
                demand,
                observation
            )
        );
        assertEquals(
            raw,
            FabricMovementAuthority.previewAppliedInput(
                FabricMotionMode.SHADOW,
                FabricLocomotionController.initialState(),
                raw,
                demand,
                observation
            )
        );
    }

    private static LocomotionDemand routeDemand(
        double desiredYaw,
        int waypointIndex,
        String segment
    ) {
        return new LocomotionDemand(
            LookDemand.Owner.NORMAL,
            LocomotionDemand.Policy.ROUTE_TRAVEL,
            new InputState(true, false, false, false, false, false, 1.0F, 0.0F),
            true,
            "preview",
            1L,
            waypointIndex,
            segment,
            desiredYaw,
            true,
            false,
            true,
            LocomotionDemand.JumpPolicy.NONE,
            null,
            "navigate_to_point"
        );
    }

    private static FabricLocomotionController.Observation observation(
        long nowMs,
        double yaw
    ) {
        return new FabricLocomotionController.Observation(
            nowMs,
            yaw,
            true,
            false,
            new VoxelCell(0, 0, 0),
            false
        );
    }
}
