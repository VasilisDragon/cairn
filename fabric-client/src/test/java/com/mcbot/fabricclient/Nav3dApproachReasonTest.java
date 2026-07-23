package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class Nav3dApproachReasonTest {
    @Test
    void allowsTheStage1ApproachReasons() {
        assertTrue(McbotFabricClient.nav3dApproachReasonAllowed("navigating_to_point"));
        assertTrue(McbotFabricClient.nav3dApproachReasonAllowed("gather_tree_search"));
        assertTrue(McbotFabricClient.nav3dApproachReasonAllowed("gather_tree_nav_adjacent"));
        assertTrue(McbotFabricClient.nav3dApproachReasonAllowed("gather_log_nav_adjacent"));
        assertTrue(McbotFabricClient.nav3dApproachReasonAllowed("exploration:wood:leg_1"));
        assertTrue(McbotFabricClient.nav3dApproachReasonAllowed("mission:MINE_STONE_RELOCATE"));
        assertTrue(McbotFabricClient.nav3dApproachReasonAllowed("mine_nearby_stone_collect_item"));
        assertFalse(McbotFabricClient.nav3dApproachReasonAllowed("mine_nearby_iron_collect_item"));
        assertFalse(McbotFabricClient.nav3dApproachReasonAllowed("hunt_sheep_collect_item"));
    }

    @Test
    void rejectCompletionCoversBrainLevelNavigationsOnly() {
        assertTrue(McbotFabricClient.navigationRejectCompletesCommand("navigating_to_point"));
        assertTrue(McbotFabricClient.navigationRejectCompletesCommand("exploration:wood:leg_2"));
        assertTrue(McbotFabricClient.navigationRejectCompletesCommand("mission:MINE_STONE_RELOCATE"));
        assertFalse(McbotFabricClient.navigationRejectCompletesCommand(null));
        assertFalse(McbotFabricClient.navigationRejectCompletesCommand(""));
        assertFalse(McbotFabricClient.navigationRejectCompletesCommand("gather_tree_search"));
        assertFalse(McbotFabricClient.navigationRejectCompletesCommand("gather_tree_nav_adjacent"));
        assertFalse(McbotFabricClient.navigationRejectCompletesCommand("gather_log_nav_adjacent"));
        assertFalse(McbotFabricClient.navigationRejectCompletesCommand("mine_nearby_stone_collect_item"));
        assertFalse(McbotFabricClient.navigationRejectCompletesCommand("mission:GATHER_WOOD"));
    }

    @Test
    void rejectsReasonsOutsideTheAllowlist() {
        assertFalse(McbotFabricClient.nav3dApproachReasonAllowed(null));
        assertFalse(McbotFabricClient.nav3dApproachReasonAllowed(""));
        assertFalse(McbotFabricClient.nav3dApproachReasonAllowed("return_staircase"));
        assertFalse(McbotFabricClient.nav3dApproachReasonAllowed("mine_nearby_stone_face"));
        assertFalse(McbotFabricClient.nav3dApproachReasonAllowed("mission:GATHER_WOOD"));
        assertFalse(McbotFabricClient.nav3dApproachReasonAllowed("descent_safe_fall_hold"));
        assertFalse(McbotFabricClient.nav3dApproachReasonAllowed("exploration"));
    }
}
