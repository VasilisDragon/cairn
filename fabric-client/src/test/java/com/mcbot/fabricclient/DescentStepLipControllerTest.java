package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class DescentStepLipControllerTest {
    private static final DescentStepLipController.Key KEY = new DescentStepLipController.Key(
        "mission-1",
        2,
        new DescentStepLipController.Cell(0, 18, 0),
        new DescentStepLipController.Cell(0, 17, 1)
    );

    @Test
    void stagesWhileSneakingThenEmitsOneBoundedLaunchPulse() {
        DescentStepLipController controller = new DescentStepLipController();

        DescentStepLipController.Decision first = controller.tick(observation(KEY, 100L, true));
        assertEquals(DescentStepLipController.Phase.STAGING, first.phase());
        assertEquals(DescentStepLipController.Action.HOLD_SNEAK, first.action());
        assertEquals(1, first.stablePolls());

        DescentStepLipController.Decision launched = controller.tick(observation(KEY, 150L, true));
        assertEquals(DescentStepLipController.Phase.LAUNCHING, launched.phase());
        assertEquals(DescentStepLipController.Action.FORWARD_LAUNCH, launched.action());
        assertEquals("launch_started", launched.reason());

        assertEquals(
            DescentStepLipController.Action.FORWARD_LAUNCH,
            controller.tick(observation(KEY, 299L, false)).action()
        );
        DescentStepLipController.Decision released = controller.tick(observation(KEY, 300L, false));
        assertEquals(DescentStepLipController.Phase.RELEASED, released.phase());
        assertEquals(DescentStepLipController.Action.HOLD_RELEASED, released.action());
        assertEquals(
            DescentStepLipController.Action.HOLD_RELEASED,
            controller.tick(observation(KEY, 500L, true)).action()
        );
    }

    @Test
    void lateUnsafeObservationResetsStagingAndNeverLaunches() {
        DescentStepLipController controller = new DescentStepLipController();
        controller.tick(observation(KEY, 100L, true));

        DescentStepLipController.Decision unsafe = controller.tick(observation(KEY, 150L, false));
        assertEquals(DescentStepLipController.Phase.STAGING, unsafe.phase());
        assertEquals(DescentStepLipController.Action.HOLD_SNEAK, unsafe.action());
        assertEquals(0, unsafe.stablePolls());

        assertEquals(
            DescentStepLipController.Action.HOLD_SNEAK,
            controller.tick(observation(KEY, 200L, true)).action()
        );
        assertEquals(
            DescentStepLipController.Action.FORWARD_LAUNCH,
            controller.tick(observation(KEY, 250L, true)).action()
        );
    }

    @Test
    void stepOrCommandChangeCreatesANewStagingEpisode() {
        DescentStepLipController controller = new DescentStepLipController();
        controller.tick(observation(KEY, 100L, true));
        controller.tick(observation(KEY, 150L, true));

        DescentStepLipController.Key next = new DescentStepLipController.Key(
            "mission-1",
            3,
            KEY.landing(),
            new DescentStepLipController.Cell(0, 16, 2)
        );
        DescentStepLipController.Decision reset = controller.tick(observation(next, 200L, true));
        assertEquals(DescentStepLipController.Phase.STAGING, reset.phase());
        assertEquals(DescentStepLipController.Action.HOLD_SNEAK, reset.action());
        assertEquals(1, reset.stablePolls());

        controller.clear();
        assertEquals(DescentStepLipController.Phase.IDLE, controller.phase());
    }

    @Test
    void leavingTheLipResetsPollsWithoutRearmingAConsumedLaunch() {
        DescentStepLipController controller = new DescentStepLipController();
        controller.tick(observation(KEY, 100L, true));
        controller.pauseStaging();
        assertEquals(0, controller.tick(observation(KEY, 150L, false)).stablePolls());
        assertEquals(
            DescentStepLipController.Action.HOLD_SNEAK,
            controller.tick(observation(KEY, 200L, true)).action()
        );
        controller.tick(observation(KEY, 250L, true));
        controller.pauseStaging();
        assertEquals(
            DescentStepLipController.Action.FORWARD_LAUNCH,
            controller.tick(observation(KEY, 300L, true)).action()
        );
    }

    private static DescentStepLipController.Observation observation(
        DescentStepLipController.Key key,
        long nowMs,
        boolean safe
    ) {
        return new DescentStepLipController.Observation(
            key,
            nowMs,
            safe,
            safe,
            safe,
            safe,
            safe,
            safe
        );
    }
}
