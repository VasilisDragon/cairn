package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import org.junit.jupiter.api.Test;

class BlockInteractionDemandTest {
    @Test
    void validatedNextBlockHintIsImmutableAndExplicit() {
        BlockPos mutable = new BlockPos.Mutable(4, 20, -3);
        BlockBreakController.ValidatedNextBlockHint hint =
            new BlockBreakController.ValidatedNextBlockHint(
                mutable,
                Direction.NORTH,
                "sequence:block:4,20,-3"
            );
        ((BlockPos.Mutable) mutable).set(9, 9, 9);

        assertEquals(new BlockPos(4, 20, -3), hint.target());
        assertEquals(Direction.NORTH, hint.face());
        assertEquals("sequence:block:4,20,-3", hint.targetIdentity());
        assertThrows(
            IllegalArgumentException.class,
            () -> new BlockBreakController.ValidatedNextBlockHint(
                BlockPos.ORIGIN,
                Direction.UP,
                ""
            )
        );
    }

    @Test
    void placementReceiptMustMatchAndBePhysicallyApplied() {
        InteractionAppliedReceipt applied = receipt(
            "place:command:table:1:0,64,0:0,63,0:up",
            InteractionDemand.Action.USE_BLOCK,
            InteractionAppliedReceipt.Disposition.APPLIED,
            true
        );
        InteractionAppliedReceipt deferred = receipt(
            applied.requestId(),
            InteractionDemand.Action.USE_BLOCK,
            InteractionAppliedReceipt.Disposition.DEFERRED,
            false
        );
        InteractionAppliedReceipt wrongAction = receipt(
            applied.requestId(),
            InteractionDemand.Action.ATTACK_ENTITY,
            InteractionAppliedReceipt.Disposition.APPLIED,
            true
        );

        assertTrue(BlockPlaceController.matchesAppliedReceipt(applied.requestId(), applied));
        assertFalse(BlockPlaceController.matchesAppliedReceipt("another-request", applied));
        assertFalse(BlockPlaceController.matchesAppliedReceipt(applied.requestId(), deferred));
        assertFalse(BlockPlaceController.matchesAppliedReceipt(applied.requestId(), wrongAction));
        assertFalse(BlockPlaceController.matchesAppliedReceipt(applied.requestId(), null));
    }

    @Test
    void lowLevelControllersContainNoPhysicalInteractionWriter() throws IOException {
        Path root = Path.of("src", "main", "java", "com", "mcbot", "fabricclient");
        String breaker = Files.readString(root.resolve("BlockBreakController.java"));
        String placer = Files.readString(root.resolve("BlockPlaceController.java"));

        assertFalse(breaker.contains("updateBlockBreakingProgress("));
        assertFalse(breaker.contains("cancelBlockBreaking("));
        assertFalse(breaker.contains("attackKey.setPressed("));
        assertFalse(placer.contains("interactionManager.interactBlock("));
        assertFalse(placer.contains("swingHand("));
        assertTrue(breaker.contains("InteractionDemand.breakBlock("));
        assertTrue(breaker.contains("InteractionDemand.blockBreakHold("));
        assertTrue(placer.contains("InteractionDemand.useBlock("));
        assertTrue(placer.contains("receipt.applied()"));
    }

    @Test
    void tunnelActiveBreakTargetIsLimitedToImmediateForwardColumn() {
        assertTrue(McbotFabricClient.isImmediateTunnelColumn(new BlockPos(4, 70, 8), 4, 7, 0, 1));
        assertTrue(McbotFabricClient.isImmediateTunnelColumn(new BlockPos(3, 69, 7), 4, 7, -1, 0));
        assertFalse(McbotFabricClient.isImmediateTunnelColumn(new BlockPos(4, 70, 9), 4, 7, 0, 1));
        assertFalse(McbotFabricClient.isImmediateTunnelColumn(new BlockPos(5, 70, 8), 4, 7, 0, 1));
        assertFalse(McbotFabricClient.isImmediateTunnelColumn(null, 4, 7, 0, 1));
    }

    @Test
    void tunnelTravelConvertsPhysicalBreakToLogicalHoldWithoutChangingIdentity() {
        InteractionDemand breaking = InteractionDemand.breakBlock(
            "break:cmd:0,64,3:north",
            LookDemand.Owner.NORMAL,
            "cmd",
            "block_break",
            "break-gesture:cmd",
            "0,64,3",
            "minecraft:iron_pickaxe",
            "north",
            "raycast_breaking_block"
        );

        InteractionDemand hold = McbotFabricClient.nav3dTunnelHoldFrom(breaking);

        assertEquals(InteractionDemand.Action.BLOCK_BREAK_HOLD, hold.action());
        assertEquals(breaking.owner(), hold.owner());
        assertEquals(breaking.commandId(), hold.commandId());
        assertEquals(breaking.stageIdentity(), hold.stageIdentity());
        assertEquals(breaking.gestureIdentity(), hold.gestureIdentity());
        assertEquals(breaking.targetIdentity(), hold.targetIdentity());
        assertEquals(breaking.toolIdentity(), hold.toolIdentity());
        assertEquals(breaking.faceIdentity(), hold.faceIdentity());
        assertSame(hold, McbotFabricClient.nav3dTunnelHoldFrom(hold));
        assertNull(McbotFabricClient.nav3dTunnelHoldFrom(
            InteractionDemand.idle(LookDemand.Owner.NORMAL, "cmd", "idle", "idle")
        ));
    }

    @Test
    void tunnelLogicalHoldRetargetsWithoutStartingANewGesture() {
        InteractionDemand first = InteractionDemand.blockBreakHold(
            "hold:cmd:0,64,3",
            LookDemand.Owner.NORMAL,
            "cmd",
            "block_break",
            "break-gesture:cmd",
            "0,64,3",
            "minecraft:stone_pickaxe",
            "north",
            "air_confirmed"
        );

        InteractionDemand next = McbotFabricClient.nav3dTunnelHoldForTarget(
            first,
            new BlockPos(0, 65, 4)
        );

        assertEquals(InteractionDemand.Action.BLOCK_BREAK_HOLD, next.action());
        assertEquals(first.commandId(), next.commandId());
        assertEquals(first.gestureIdentity(), next.gestureIdentity());
        assertEquals(first.toolIdentity(), next.toolIdentity());
        assertEquals("0, 65, 4", next.targetIdentity());
        assertNull(McbotFabricClient.nav3dTunnelHoldForTarget(null, BlockPos.ORIGIN));
        assertNull(McbotFabricClient.nav3dTunnelHoldForTarget(first, null));
    }

    @Test
    void tunnelSourceWalksToOutOfReachFrontierAndCarriesLogicalHold() throws IOException {
        String source = Files.readString(
            Path.of("src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java")
        );

        assertTrue(source.contains("toDig = immediateSolid;"));
        assertTrue(source.contains("\"target_out_of_reach\".equals(dig.reason())"));
        assertTrue(source.contains("reasonPrefix + \"_tunnel_preaim_approach\""));
        assertTrue(source.contains("nav3dTunnelInteractionHold(nextDig, commandId)"));
        assertTrue(source.contains("finishPendingNav3dTunnelBreak("));
        assertTrue(source.contains("block_air_confirmed_before_route"));
    }

    @Test
    void verifiedPlacementIsRecordedBeforeTheTerminalInteractionCommit() throws IOException {
        String source = Files.readString(
            Path.of("src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java")
        );
        int consume = source.indexOf(
            "String verifiedPlacementRequestId = blockPlaceController.consumeVerifiedRequestId();"
        );
        int record = source.indexOf(
            "interactionAuthority.recordUseVerification(\n                verifiedPlacementRequestId",
            consume
        );
        int commit = source.indexOf(
            "InteractionAppliedReceipt interactionReceipt = interactionAuthority.commit(",
            record
        );

        assertTrue(consume >= 0);
        assertTrue(record > consume);
        assertTrue(commit > record);
    }

    private static InteractionAppliedReceipt receipt(
        String requestId,
        InteractionDemand.Action action,
        InteractionAppliedReceipt.Disposition disposition,
        boolean applied
    ) {
        return new InteractionAppliedReceipt(
            requestId,
            action,
            disposition,
            applied,
            null,
            1_000L,
            applied ? "applied" : "deferred",
            FabricMotionMode.LEGACY,
            null,
            null,
            false,
            false,
            false
        );
    }
}
