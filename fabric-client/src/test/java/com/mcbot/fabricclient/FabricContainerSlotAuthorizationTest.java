package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class FabricContainerSlotAuthorizationTest {
    @Test
    void staleOrSubstitutedOpenIdentitiesFailClosed() {
        Object world = new Object();
        Object player = new Object();
        Object handler = new Object();

        assertTrue(FabricInteractionAuthority.accessRequestMatches("open-1", "open-1"));
        assertFalse(FabricInteractionAuthority.accessRequestMatches("open-1", "open-2"));
        assertFalse(FabricInteractionAuthority.accessRequestMatches("open-1", ""));

        assertTrue(FabricInteractionAuthority.worldAndPlayerIdentityMatches(
            world, world, player, player));
        assertFalse(FabricInteractionAuthority.worldAndPlayerIdentityMatches(
            world, new Object(), player, player));
        assertFalse(FabricInteractionAuthority.worldAndPlayerIdentityMatches(
            world, world, player, new Object()));

        assertTrue(FabricInteractionAuthority.boundContainerIdentityMatches(
            handler, handler, 7, 7));
        assertFalse(FabricInteractionAuthority.boundContainerIdentityMatches(
            handler, new Object(), 7, 7));
        assertFalse(FabricInteractionAuthority.boundContainerIdentityMatches(
            handler, handler, 7, 8));
        assertFalse(FabricInteractionAuthority.boundContainerIdentityMatches(
            null, handler, -1, 7));

        Object playerHandler = new Object();
        Object openedHandler = new Object();
        assertTrue(FabricInteractionAuthority.isNewExternalContainerHandler(
            playerHandler, 0, playerHandler, openedHandler, 7));
        assertFalse(FabricInteractionAuthority.isNewExternalContainerHandler(
            playerHandler, 0, playerHandler, playerHandler, 0));
        assertFalse(FabricInteractionAuthority.isNewExternalContainerHandler(
            new Object(), 0, playerHandler, openedHandler, 7));
        assertFalse(FabricInteractionAuthority.isNewExternalContainerHandler(
            playerHandler, 0, playerHandler, openedHandler, 0));
    }

    @Test
    void changedContainerFootprintFailsClosedRegardlessOfOrdering() {
        BlockPos left = new BlockPos(10, 64, 10);
        BlockPos right = new BlockPos(11, 64, 10);

        assertTrue(FabricInteractionAuthority.sameBlockFootprint(
            List.of(left, right), List.of(right, left)));
        assertFalse(FabricInteractionAuthority.sameBlockFootprint(
            List.of(left, right), List.of(left)));
        assertFalse(FabricInteractionAuthority.sameBlockFootprint(
            List.of(left, right), List.of(left, new BlockPos(9, 64, 10))));
    }
}
