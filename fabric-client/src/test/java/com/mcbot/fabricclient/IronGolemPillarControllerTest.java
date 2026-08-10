package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class IronGolemPillarControllerTest {
    private static final String COMMAND = "village:golem:30";
    private static final String UUID = "00000000-0000-0000-0000-000000000030";
    private static final VoxelCell BASE = new VoxelCell(613, 149, 600);
    private static final List<VoxelCell> PLACEMENTS = List.of(
        BASE,
        new VoxelCell(613, 150, 600),
        new VoxelCell(613, 151, 600)
    );
    private static final VoxelCell ATTACK = new VoxelCell(613, 152, 600);

    @Test
    void performsExactlyThreeAppliedVerifiedCyclesAndNeverAFourth() {
        IronGolemPillarController controller = controller(0L);
        long now = 0L;

        for (int cycle = 0; cycle < 3; cycle++) {
            VoxelCell origin = new VoxelCell(BASE.x(), BASE.y() + cycle, BASE.z());
            VoxelCell landing = new VoxelCell(BASE.x(), BASE.y() + cycle + 1, BASE.z());

            IronGolemPillarController.Step jump = controller.tick(
                COMMAND,
                observation(origin, origin.y(), true, true, true, false,
                    IronGolemPillarController.PlacementFeedback.NONE),
                now += 10L
            );
            assertEquals(IronGolemPillarController.Phase.JUMPING, jump.phase());
            assertTrue(jump.jump());
            assertFalse(jump.requestPlacement());

            IronGolemPillarController.Step place = controller.tick(
                COMMAND,
                observation(origin, origin.y() + 0.5D, false, true, true, false,
                    IronGolemPillarController.PlacementFeedback.NONE),
                now += 25L
            );
            assertEquals(IronGolemPillarController.Phase.AIRBORNE, place.phase());
            assertFalse(place.jump());
            assertTrue(place.requestPlacement());
            assertEquals(PLACEMENTS.get(cycle), place.placementCell());

            IronGolemPillarController.Step acknowledged = controller.tick(
                COMMAND,
                observation(origin, origin.y() + 0.7D, false, true, true, false,
                    IronGolemPillarController.PlacementFeedback.APPLIED),
                now += 10L
            );
            assertFalse(acknowledged.requestPlacement());

            IronGolemPillarController.Step firstPoll = controller.tick(
                COMMAND,
                observation(landing, landing.y(), true, true, false, true,
                    IronGolemPillarController.PlacementFeedback.NONE),
                now += 40L
            );
            assertEquals("pillar_landing_settling", firstPoll.reason());
            assertEquals(1, firstPoll.settlementPolls());

            IronGolemPillarController.Step settled = controller.tick(
                COMMAND,
                observation(landing, landing.y(), true, true, false, true,
                    IronGolemPillarController.PlacementFeedback.NONE),
                now += 50L
            );
            assertEquals(cycle + 1, settled.completedPlacements());
            if (cycle < 2) {
                assertEquals(IronGolemPillarController.Outcome.ACTIVE, settled.outcome());
                assertEquals("pillar_cycle_completed", settled.reason());
            } else {
                assertEquals(IronGolemPillarController.Outcome.COMPLETE, settled.outcome());
                assertEquals("pillar_complete", settled.reason());
            }
        }

        IronGolemPillarController.Step terminal = controller.tick(
            COMMAND,
            observation(ATTACK, ATTACK.y(), true, true, false, true,
                IronGolemPillarController.PlacementFeedback.NONE),
            now + 100L
        );
        assertEquals(IronGolemPillarController.Outcome.COMPLETE, terminal.outcome());
        assertFalse(terminal.jump());
        assertFalse(terminal.requestPlacement());
        assertEquals(3, terminal.completedPlacements());
        assertEquals(3, terminal.appliedPlacementReceipts());
    }

    @Test
    void jumpPulseNeverExceedsOneHundredFiftyMillisecondsOrRepeats() {
        IronGolemPillarController controller = controller(1_000L);
        assertTrue(controller.tick(
            COMMAND,
            observation(BASE, BASE.y(), true, true, true, false,
                IronGolemPillarController.PlacementFeedback.NONE),
            1_010L
        ).jump());
        assertTrue(controller.tick(
            COMMAND,
            observation(BASE, BASE.y(), true, true, true, false,
                IronGolemPillarController.PlacementFeedback.NONE),
            1_159L
        ).jump());

        IronGolemPillarController.Step timedOut = controller.tick(
            COMMAND,
            observation(BASE, BASE.y(), true, true, true, false,
                IronGolemPillarController.PlacementFeedback.NONE),
            1_160L
        );
        assertEquals(IronGolemPillarController.Outcome.REJECTED, timedOut.outcome());
        assertEquals("pillar_takeoff_timeout", timedOut.reason());
        assertFalse(timedOut.jump());
    }

    @Test
    void deferredPlacementRepeatsDemandButOnlyAppliedReceiptIsCounted() {
        IronGolemPillarController controller = controller(0L);
        controller.tick(COMMAND, ready(BASE, true), 10L);
        IronGolemPillarController.Step first = controller.tick(
            COMMAND,
            observation(BASE, BASE.y() + 0.5D, false, true, true, false,
                IronGolemPillarController.PlacementFeedback.DEFERRED),
            20L
        );
        IronGolemPillarController.Step second = controller.tick(
            COMMAND,
            observation(BASE, BASE.y() + 0.6D, false, true, true, false,
                IronGolemPillarController.PlacementFeedback.DEFERRED),
            30L
        );
        IronGolemPillarController.Step applied = controller.tick(
            COMMAND,
            observation(BASE, BASE.y() + 0.7D, false, true, true, false,
                IronGolemPillarController.PlacementFeedback.APPLIED),
            40L
        );

        assertTrue(first.requestPlacement());
        assertTrue(second.requestPlacement());
        assertFalse(applied.requestPlacement());
        assertEquals(1, applied.appliedPlacementReceipts());
    }

    @Test
    void requiresTwoConsecutiveSafeVerifiedSettlementPolls() {
        IronGolemPillarController controller = controller(0L);
        controller.tick(COMMAND, ready(BASE, true), 10L);
        controller.tick(COMMAND, airborne(BASE,
            IronGolemPillarController.PlacementFeedback.APPLIED), 20L);

        VoxelCell landing = new VoxelCell(BASE.x(), BASE.y() + 1, BASE.z());
        IronGolemPillarController.Step first = controller.tick(
            COMMAND,
            observation(landing, landing.y(), true, true, false, true,
                IronGolemPillarController.PlacementFeedback.NONE),
            30L
        );
        assertEquals(1, first.settlementPolls());

        IronGolemPillarController.Step unsafe = controller.tick(
            COMMAND,
            new IronGolemPillarController.Observation(
                landing, landing.y(), true, true, true, false, true,
                UUID, true, false, true,
                IronGolemPillarController.PlacementFeedback.NONE
            ),
            40L
        );
        assertEquals(IronGolemPillarController.Outcome.REJECTED, unsafe.outcome());
        assertEquals("pillar_settlement_invalid", unsafe.reason());
        assertEquals(0, unsafe.completedPlacements());
    }

    @Test
    void externallyAppearingBlockCannotSatisfyAPlacementCycle() {
        IronGolemPillarController controller = controller(0L);
        controller.tick(COMMAND, ready(BASE, true), 10L);
        controller.tick(
            COMMAND,
            airborne(BASE, IronGolemPillarController.PlacementFeedback.NONE),
            20L
        );

        VoxelCell landing = new VoxelCell(BASE.x(), BASE.y() + 1, BASE.z());
        IronGolemPillarController.Step rejected = controller.tick(
            COMMAND,
            observation(
                landing,
                landing.y(),
                true,
                true,
                false,
                true,
                IronGolemPillarController.PlacementFeedback.NONE
            ),
            30L
        );

        assertEquals(IronGolemPillarController.Outcome.REJECTED, rejected.outcome());
        assertEquals("pillar_landing_unverified", rejected.reason());
        assertEquals(0, rejected.appliedPlacementReceipts());
        assertEquals(0, rejected.completedPlacements());
    }

    @Test
    void rejectsIdentityGeometryPlacementAndLandingFailures() {
        IronGolemPillarController wrongIdentity = controller(0L);
        IronGolemPillarController.Step identity = wrongIdentity.tick(
            COMMAND,
            new IronGolemPillarController.Observation(
                BASE, BASE.y(), true, true, true, true, true,
                "different", true, true, false,
                IronGolemPillarController.PlacementFeedback.NONE
            ),
            10L
        );
        assertEquals("target_identity_changed", identity.reason());

        IronGolemPillarController blocked = controller(0L);
        assertEquals("pillar_origin_invalid", blocked.tick(
            COMMAND,
            new IronGolemPillarController.Observation(
                BASE, BASE.y(), true, true, true, true, true,
                UUID, true, false, false,
                IronGolemPillarController.PlacementFeedback.NONE
            ),
            10L
        ).reason());

        IronGolemPillarController placementRejected = controller(0L);
        placementRejected.tick(COMMAND, ready(BASE, true), 10L);
        assertEquals("placement_rejected", placementRejected.tick(
            COMMAND,
            airborne(BASE, IronGolemPillarController.PlacementFeedback.REJECTED),
            20L
        ).reason());

        IronGolemPillarController missed = controller(0L);
        missed.tick(COMMAND, ready(BASE, true), 10L);
        missed.tick(COMMAND, airborne(BASE,
            IronGolemPillarController.PlacementFeedback.APPLIED), 20L);
        assertEquals("pillar_landing_missed", missed.tick(
            COMMAND,
            observation(new VoxelCell(614, 150, 600), 150.0D, true, true, false, true,
                IronGolemPillarController.PlacementFeedback.NONE),
            30L
        ).reason());
    }

    @Test
    void validatesFrozenPackageAndCleansLifecycleState() {
        IronGolemPillarController invalid = new IronGolemPillarController();
        assertFalse(invalid.begin(
            COMMAND,
            UUID,
            BASE,
            List.of(BASE, new VoxelCell(613, 151, 600), new VoxelCell(613, 152, 600)),
            ATTACK,
            BASE,
            0L
        ));
        assertEquals(IronGolemPillarController.Phase.IDLE, invalid.phase());

        IronGolemPillarController controller = controller(0L);
        assertEquals("command_changed", controller.tick("other", ready(BASE, true), 10L).reason());
        assertFalse(controller.active());
        controller.clear();
        assertEquals(IronGolemPillarController.Outcome.IDLE,
            controller.tick(COMMAND, ready(BASE, true), 20L).outcome());
    }

    private static IronGolemPillarController controller(long nowMs) {
        IronGolemPillarController controller = new IronGolemPillarController();
        assertTrue(controller.begin(COMMAND, UUID, BASE, PLACEMENTS, ATTACK, BASE, nowMs));
        return controller;
    }

    private static IronGolemPillarController.Observation ready(VoxelCell feet, boolean aligned) {
        return observation(
            feet,
            feet.y(),
            true,
            aligned,
            true,
            false,
            IronGolemPillarController.PlacementFeedback.NONE
        );
    }

    private static IronGolemPillarController.Observation airborne(
        VoxelCell feet,
        IronGolemPillarController.PlacementFeedback feedback
    ) {
        return observation(feet, feet.y() + 0.5D, false, true, true, false, feedback);
    }

    private static IronGolemPillarController.Observation observation(
        VoxelCell feet,
        double preciseY,
        boolean onGround,
        boolean aligned,
        boolean placementCellOpen,
        boolean placementVerified,
        IronGolemPillarController.PlacementFeedback feedback
    ) {
        return new IronGolemPillarController.Observation(
            feet,
            preciseY,
            onGround,
            true,
            true,
            true,
            aligned,
            UUID,
            true,
            placementCellOpen,
            placementVerified,
            feedback
        );
    }
}
