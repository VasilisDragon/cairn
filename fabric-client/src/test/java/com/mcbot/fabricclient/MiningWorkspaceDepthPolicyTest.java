package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class MiningWorkspaceDepthPolicyTest {
    @Test
    void admitsPrimaryAndRecoveryMissionDescentsTargetingIronDepthOrLower() {
        assertTrue(MiningWorkspaceDepthPolicy.applies("mission-run-1", "mission:DESCEND", 16.0D));
        assertTrue(MiningWorkspaceDepthPolicy.applies("mission-run-1", "mission:DESCEND", 12.0D));
        assertTrue(MiningWorkspaceDepthPolicy.applies(
            "mission-run-2",
            "mission:DESCEND_RECOVERY",
            16.0D
        ));
        assertFalse(MiningWorkspaceDepthPolicy.applies("stub-run-1", "mission:DESCEND", 16.0D));
        assertFalse(MiningWorkspaceDepthPolicy.applies("mission-run-1", "mission:MINE_IRON_RECOVERY", 14.0D));
        assertFalse(MiningWorkspaceDepthPolicy.applies(
            "mission-run-1",
            "mission:DESCEND_RECOVERY",
            17.0D
        ));
        assertFalse(MiningWorkspaceDepthPolicy.applies("mission-run-1", "mission:DESCEND", 17.0D));
        assertFalse(MiningWorkspaceDepthPolicy.applies("mission-run-1", "mission:DESCEND", null));
        assertFalse(MiningWorkspaceDepthPolicy.applies("mission-run-1", "mission:DESCEND", Double.NaN));
    }

    @Test
    void recognizesExactAndOneToThreeBlockTerminalOvershoot() {
        assertTrue(MiningWorkspaceDepthPolicy.terminalLandingReached(16, 16.0D));
        assertTrue(MiningWorkspaceDepthPolicy.terminalLandingReached(15, 16.0D));
        assertTrue(MiningWorkspaceDepthPolicy.terminalLandingReached(14, 16.0D));
        assertTrue(MiningWorkspaceDepthPolicy.terminalLandingReached(13, 16.0D));
        assertFalse(MiningWorkspaceDepthPolicy.terminalLandingReached(17, 16.0D));
        assertFalse(MiningWorkspaceDepthPolicy.terminalLandingReached(12, 16.0D));
    }

    @Test
    void workspaceStanceAllowsOneStepUpButRejectsUpperSegments() {
        assertTrue(MiningWorkspaceDepthPolicy.workspaceStanceAllowed(new VoxelCell(0, 17, 0), 16.0D));
        assertTrue(MiningWorkspaceDepthPolicy.workspaceStanceAllowed(new VoxelCell(0, 13, 0), 16.0D));
        assertFalse(MiningWorkspaceDepthPolicy.workspaceStanceAllowed(new VoxelCell(0, 18, 0), 16.0D));
        assertFalse(MiningWorkspaceDepthPolicy.workspaceStanceAllowed(new VoxelCell(0, 39, 0), 16.0D));
        assertFalse(MiningWorkspaceDepthPolicy.workspaceStanceAllowed(null, 16.0D));
    }

    @Test
    void terminalMissionSafeFallCannotLandBelowWorkspaceBand() {
        for (int landingY = 13; landingY <= 30; landingY++) {
            assertTrue(MiningWorkspaceDepthPolicy.safeFallLandingAllowed(
                "mission-run-1",
                "mission:DESCEND",
                16.0D,
                landingY
            ));
        }
        assertFalse(MiningWorkspaceDepthPolicy.safeFallLandingAllowed(
            "mission-run-1",
            "mission:DESCEND_RECOVERY",
            16.0D,
            12
        ));
    }

    @Test
    void ineligibleSafeFallsKeepTheirExistingRange() {
        assertTrue(MiningWorkspaceDepthPolicy.safeFallLandingAllowed(
            "stub-run-1",
            "mission:DESCEND",
            16.0D,
            4
        ));
        assertTrue(MiningWorkspaceDepthPolicy.safeFallLandingAllowed(
            "mission-run-1",
            "mission:MINE_IRON_RECOVERY",
            14.0D,
            4
        ));
        assertTrue(MiningWorkspaceDepthPolicy.safeFallLandingAllowed(
            "mission-run-1",
            "mission:DESCEND",
            40.0D,
            4
        ));
    }

    @Test
    void terminalAdmissionStaysLatchedWhileRoutingToAnAllowedUpperStance() {
        boolean admitted = MiningWorkspaceDepthPolicy.latchTerminalLanding(false, 15, 16.0D);
        assertTrue(admitted);
        assertTrue(MiningWorkspaceDepthPolicy.latchTerminalLanding(admitted, 17, 16.0D));
        assertFalse(MiningWorkspaceDepthPolicy.latchTerminalLanding(false, 17, 16.0D));
    }

    @Test
    void immediatelyAdmitsSafeMissionDescentStancesInsideTheTerminalBand() {
        for (int feetY = 13; feetY <= 16; feetY++) {
            assertTrue(MiningWorkspaceDepthPolicy.immediateAdmissionAllowed(
                "mission-run-1",
                "mission:DESCEND",
                16.0D,
                feetY,
                true,
                true,
                true,
                true
            ));
            assertTrue(MiningWorkspaceDepthPolicy.immediateAdmissionAllowed(
                "mission-run-2",
                "mission:DESCEND_RECOVERY",
                16.0D,
                feetY,
                true,
                true,
                true,
                true
            ));
        }
    }

    @Test
    void immediateAdmissionRejectsPositionsOutsideTheTerminalBand() {
        assertFalse(MiningWorkspaceDepthPolicy.immediateAdmissionAllowed(
            "mission-run-1", "mission:DESCEND", 16.0D, 17, true, true, true, true
        ));
        assertFalse(MiningWorkspaceDepthPolicy.immediateAdmissionAllowed(
            "mission-run-1", "mission:DESCEND", 16.0D, 12, true, true, true, true
        ));
    }

    @Test
    void immediateAdmissionRejectsIneligibleCommandsAndTargets() {
        assertFalse(MiningWorkspaceDepthPolicy.immediateAdmissionAllowed(
            "stub-run-1", "mission:DESCEND", 16.0D, 16, true, true, true, true
        ));
        assertFalse(MiningWorkspaceDepthPolicy.immediateAdmissionAllowed(
            "mission-run-1", "mission:MINE_IRON_RECOVERY", 16.0D, 16, true, true, true, true
        ));
        assertFalse(MiningWorkspaceDepthPolicy.immediateAdmissionAllowed(
            "mission-run-1", "mission:DESCEND", 17.0D, 17, true, true, true, true
        ));
        assertFalse(MiningWorkspaceDepthPolicy.immediateAdmissionAllowed(
            "mission-run-1", "mission:DESCEND", null, 16, true, true, true, true
        ));
    }

    @Test
    void immediateAdmissionRequiresAGroundedDryClearStableStance() {
        assertFalse(MiningWorkspaceDepthPolicy.immediateAdmissionAllowed(
            "mission-run-1", "mission:DESCEND", 16.0D, 16, false, true, true, true
        ));
        assertFalse(MiningWorkspaceDepthPolicy.immediateAdmissionAllowed(
            "mission-run-1", "mission:DESCEND", 16.0D, 16, true, false, true, true
        ));
        assertFalse(MiningWorkspaceDepthPolicy.immediateAdmissionAllowed(
            "mission-run-1", "mission:DESCEND", 16.0D, 16, true, true, false, true
        ));
        assertFalse(MiningWorkspaceDepthPolicy.immediateAdmissionAllowed(
            "mission-run-1", "mission:DESCEND", 16.0D, 16, true, true, true, false
        ));
    }

    @Test
    void fractionalTargetsUseTheirFlooredDepthBand() {
        assertTrue(MiningWorkspaceDepthPolicy.terminalLandingReached(15, 15.9D));
        assertFalse(MiningWorkspaceDepthPolicy.terminalLandingReached(16, 15.9D));
        assertTrue(MiningWorkspaceDepthPolicy.workspaceStanceAllowed(new VoxelCell(0, 16, 0), 15.9D));
    }

    @Test
    void threeSegmentDescentCommitsOnlyAtTheTerminalLanding() {
        List<Integer> workspaceLandings = List.of(56, 36, 16).stream()
            .filter(feetY -> MiningWorkspaceDepthPolicy.terminalLandingReached(feetY, 16.0D))
            .toList();

        assertTrue(MiningWorkspaceDepthPolicy.applies("mission-run-1", "mission:DESCEND", 16.0D));
        assertEquals(List.of(16), workspaceLandings);
    }

    @Test
    void recoverySegmentsRemainWorkspaceFreeUntilTheirTerminalLanding() {
        List<Integer> workspaceLandings = List.of(36, 16).stream()
            .filter(feetY -> MiningWorkspaceDepthPolicy.terminalLandingReached(feetY, 16.0D))
            .toList();

        assertTrue(MiningWorkspaceDepthPolicy.applies(
            "mission-run-2",
            "mission:DESCEND_RECOVERY",
            16.0D
        ));
        assertEquals(List.of(16), workspaceLandings);
        assertFalse(MiningWorkspaceDepthPolicy.applies(
            "mission-run-2",
            "mission:MINE_IRON_RECOVERY",
            16.0D
        ));
    }
}
