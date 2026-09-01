package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.Bootstrap;
import net.minecraft.SharedConstants;
import net.minecraft.block.Blocks;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

class FabricInteractionHeldItemRequirementTest {
    @BeforeAll
    static void bootstrapMinecraftRegistries() {
        SharedConstants.createGameVersion();
        Bootstrap.initialize();
    }

    @Test
    void genericBlockUseRequiresAnActuallyEmptyMainHand() {
        FabricInteractionAuthority.HeldItemRequirement requirement =
            FabricInteractionAuthority.HeldItemRequirement.emptyMainHand();

        assertTrue(requirement.matches(Hand.MAIN_HAND, ItemStack.EMPTY));
        assertFalse(requirement.matches(Hand.OFF_HAND, ItemStack.EMPTY));
        assertFalse(requirement.matches(Hand.MAIN_HAND, new ItemStack(Blocks.COBBLESTONE)));
        assertFalse(requirement.matches(Hand.MAIN_HAND, new ItemStack(Items.WATER_BUCKET)));
        assertFalse(requirement.matches(Hand.MAIN_HAND, new ItemStack(Items.FLINT_AND_STEEL)));
        assertFalse(requirement.matches(Hand.MAIN_HAND, new ItemStack(Items.IRON_PICKAXE)));
        assertFalse(requirement.matches(Hand.MAIN_HAND, null));
    }

    @Test
    void placementRequiresTheExactModeledBlockItemInTheMainHand() {
        FabricInteractionAuthority.HeldItemRequirement cobblestone =
            FabricInteractionAuthority.HeldItemRequirement.exactBlockItem(Blocks.COBBLESTONE);

        assertTrue(cobblestone.matches(
            Hand.MAIN_HAND,
            new ItemStack(Blocks.COBBLESTONE)
        ));
        assertFalse(cobblestone.matches(
            Hand.MAIN_HAND,
            new ItemStack(Blocks.DIRT)
        ));
        assertFalse(cobblestone.matches(
            Hand.MAIN_HAND,
            new ItemStack(Blocks.OAK_DOOR)
        ));
        assertFalse(cobblestone.matches(
            Hand.MAIN_HAND,
            new ItemStack(Blocks.WHITE_BED)
        ));
        assertFalse(cobblestone.matches(
            Hand.OFF_HAND,
            new ItemStack(Blocks.COBBLESTONE)
        ));
    }

    @Test
    void bedPlacementBindsTheExactBedColorAndRejectsGenericPlacementSemantics() {
        FabricInteractionAuthority.HeldItemRequirement redBed =
            FabricInteractionAuthority.HeldItemRequirement.exactBlockItem(Blocks.RED_BED);

        assertTrue(redBed.matches(Hand.MAIN_HAND, new ItemStack(Blocks.RED_BED)));
        assertFalse(redBed.matches(Hand.MAIN_HAND, new ItemStack(Blocks.WHITE_BED)));
        assertThrows(IllegalArgumentException.class, () ->
            FabricInteractionAuthority.Payload.blockPlacement(
                hit(new BlockPos(0, 64, 0)),
                Hand.MAIN_HAND,
                FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
                Blocks.RED_BED,
                java.util.List.of(new BlockPos(0, 65, 0))
            )
        );
    }

    @Test
    void blockUseFactoriesCarryMandatoryRequirementsAndRejectOffhandAtMatchTime() {
        FabricInteractionAuthority.Payload use = FabricInteractionAuthority.Payload.blockUse(
            hit(new BlockPos(1, 64, 1)),
            Hand.OFF_HAND,
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor()
        );
        FabricInteractionAuthority.Payload placement =
            FabricInteractionAuthority.Payload.blockPlacement(
                hit(new BlockPos(2, 64, 2)),
                Hand.MAIN_HAND,
                FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
                Blocks.COBBLESTONE,
                java.util.List.of(new BlockPos(2, 65, 2))
            );

        assertFalse(use.heldItemRequirement().matches(use.hand(), ItemStack.EMPTY));
        assertTrue(placement.heldItemRequirement().matches(
            placement.hand(),
            new ItemStack(Blocks.COBBLESTONE)
        ));
    }

    private static BlockHitResult hit(BlockPos position) {
        return new BlockHitResult(
            Vec3d.ofCenter(position),
            Direction.UP,
            position,
            false
        );
    }
}
