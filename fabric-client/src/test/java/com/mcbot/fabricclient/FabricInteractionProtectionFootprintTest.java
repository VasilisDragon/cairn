package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import net.minecraft.Bootstrap;
import net.minecraft.SharedConstants;
import net.minecraft.block.BedBlock;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.ChestBlock;
import net.minecraft.block.enums.BedPart;
import net.minecraft.block.enums.ChestType;
import net.minecraft.block.enums.DoubleBlockHalf;
import net.minecraft.state.property.Properties;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

class FabricInteractionProtectionFootprintTest {
    @BeforeAll
    static void bootstrapMinecraftRegistries() {
        SharedConstants.createGameVersion();
        Bootstrap.initialize();
    }

    @Test
    void existingBedUseResolvesBothCurrentMatchingHalves() {
        BlockPos foot = new BlockPos(4, 70, 9);
        BlockPos head = foot.north();
        BlockState footState = Blocks.RED_BED.getDefaultState()
            .with(BedBlock.FACING, Direction.NORTH)
            .with(BedBlock.PART, BedPart.FOOT);
        BlockState headState = Blocks.RED_BED.getDefaultState()
            .with(BedBlock.FACING, Direction.NORTH)
            .with(BedBlock.PART, BedPart.HEAD);
        Map<BlockPos, BlockState> world = Map.of(foot, footState, head, headState);

        assertEquals(
            List.of(foot, head),
            FabricInteractionAuthority.resolveUseFootprint(
                foot,
                FabricInteractionAuthority.BlockTargetSemantics.BED_USE_LIVE,
                world::get
            )
        );
        assertEquals(
            List.of(head, foot),
            FabricInteractionAuthority.resolveUseFootprint(
                head,
                FabricInteractionAuthority.BlockTargetSemantics.BED_USE_LIVE,
                world::get
            )
        );
    }

    @Test
    void existingBedUseFailsClosedForMissingOrMalformedCounterpart() {
        BlockPos foot = new BlockPos(4, 70, 9);
        BlockPos head = foot.north();
        BlockState footState = Blocks.RED_BED.getDefaultState()
            .with(BedBlock.FACING, Direction.NORTH)
            .with(BedBlock.PART, BedPart.FOOT);
        BlockState wrongHead = Blocks.BLUE_BED.getDefaultState()
            .with(BedBlock.FACING, Direction.NORTH)
            .with(BedBlock.PART, BedPart.HEAD);

        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolveUseFootprint(
                foot,
                FabricInteractionAuthority.BlockTargetSemantics.BED_USE_LIVE,
                Map.of(foot, footState)::get
            )
        );
        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolveUseFootprint(
                foot,
                FabricInteractionAuthority.BlockTargetSemantics.BED_USE_LIVE,
                Map.of(foot, footState, head, wrongHead)::get
            )
        );
        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolveUseFootprint(
                foot,
                FabricInteractionAuthority.BlockTargetSemantics.BED_USE_LIVE,
                ignored -> { throw new IllegalStateException("unreadable"); }
            )
        );
    }

    @Test
    void breakingBedResolvesBothHalvesAndFailsClosedForMalformedPair() {
        BlockPos foot = new BlockPos(4, 70, 9);
        BlockPos head = foot.north();
        BlockState footState = Blocks.RED_BED.getDefaultState()
            .with(BedBlock.FACING, Direction.NORTH)
            .with(BedBlock.PART, BedPart.FOOT);
        BlockState headState = Blocks.RED_BED.getDefaultState()
            .with(BedBlock.FACING, Direction.NORTH)
            .with(BedBlock.PART, BedPart.HEAD);
        BlockState wrongHead = Blocks.BLUE_BED.getDefaultState()
            .with(BedBlock.FACING, Direction.NORTH)
            .with(BedBlock.PART, BedPart.HEAD);
        Map<BlockPos, BlockState> world = Map.of(foot, footState, head, headState);

        assertEquals(
            List.of(foot, head),
            FabricInteractionAuthority.resolveBreakFootprint(foot, world::get)
        );
        assertEquals(
            List.of(head, foot),
            FabricInteractionAuthority.resolveBreakFootprint(head, world::get)
        );
        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolveBreakFootprint(
                foot,
                Map.of(foot, footState)::get
            )
        );
        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolveBreakFootprint(
                foot,
                Map.of(foot, footState, head, wrongHead)::get
            )
        );
        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolveBreakFootprint(
                foot,
                ignored -> { throw new IllegalStateException("unreadable"); }
            )
        );
    }

    @Test
    void placementExpandsDisplacedPairsAndFailsClosedForMalformedLiveState() {
        BlockPos support = new BlockPos(29, 63, 30);
        BlockPos lower = new BlockPos(30, 64, 30);
        BlockPos upper = lower.up();
        BlockState lowerState = Blocks.TALL_GRASS.getDefaultState()
            .with(Properties.DOUBLE_BLOCK_HALF, DoubleBlockHalf.LOWER);
        BlockState upperState = Blocks.TALL_GRASS.getDefaultState()
            .with(Properties.DOUBLE_BLOCK_HALF, DoubleBlockHalf.UPPER);
        Map<BlockPos, BlockState> doublePlantWorld = Map.of(
            support,
            Blocks.STONE.getDefaultState(),
            lower,
            lowerState,
            upper,
            upperState
        );

        List<BlockPos> expanded = FabricInteractionAuthority.resolvePlacementFootprint(
            List.of(support, lower),
            doublePlantWorld::get
        );
        assertEquals(List.of(support, lower, upper), expanded);
        String worldIdentity = "world-v1-" + "a".repeat(64);
        FabricTargetProtection protection = FabricTargetProtection.fromConfiguredRegions(
            worldIdentity + "|minecraft:overworld@" + upper.getX() + "," + upper.getY()
                + "," + upper.getZ()
        );
        protection.observeWorldContext(doublePlantWorld, worldIdentity, "minecraft:overworld");
        assertEquals(
            FabricTargetProtection.ProtectionState.PROTECTED,
            protection.evaluateContext(doublePlantWorld, "minecraft:overworld", expanded)
        );
        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolvePlacementFootprint(
                List.of(support, lower),
                Map.of(support, Blocks.STONE.getDefaultState(), lower, lowerState)::get
            )
        );

        BlockPos bedFoot = new BlockPos(40, 64, 40);
        BlockPos bedHead = bedFoot.north();
        BlockState bedFootState = Blocks.RED_BED.getDefaultState()
            .with(BedBlock.FACING, Direction.NORTH)
            .with(BedBlock.PART, BedPart.FOOT);
        BlockState bedHeadState = Blocks.RED_BED.getDefaultState()
            .with(BedBlock.FACING, Direction.NORTH)
            .with(BedBlock.PART, BedPart.HEAD);
        assertEquals(
            List.of(bedFoot, bedHead),
            FabricInteractionAuthority.resolvePlacementFootprint(
                List.of(bedFoot),
                Map.of(bedFoot, bedFootState, bedHead, bedHeadState)::get
            )
        );
        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolvePlacementFootprint(
                List.of(lower),
                ignored -> { throw new IllegalStateException("unreadable"); }
            )
        );
    }

    @Test
    void placementOnDoubleChestExpandsPartnerAndFailsClosedForMalformedPair() {
        BlockPos left = new BlockPos(50, 64, 50);
        BlockPos right = left.east();
        BlockState leftState = Blocks.CHEST.getDefaultState()
            .with(ChestBlock.FACING, Direction.NORTH)
            .with(ChestBlock.CHEST_TYPE, ChestType.LEFT);
        BlockState rightState = Blocks.CHEST.getDefaultState()
            .with(ChestBlock.FACING, Direction.NORTH)
            .with(ChestBlock.CHEST_TYPE, ChestType.RIGHT);
        Map<BlockPos, BlockState> world = Map.of(left, leftState, right, rightState);

        List<BlockPos> expanded = FabricInteractionAuthority.resolvePlacementFootprint(
            List.of(left),
            world::get
        );
        assertEquals(List.of(left, right), expanded);

        String worldIdentity = "world-v1-" + "b".repeat(64);
        FabricTargetProtection protection = FabricTargetProtection.fromConfiguredRegions(
            worldIdentity + "|minecraft:overworld@" + right.getX() + "," + right.getY()
                + "," + right.getZ()
        );
        protection.observeWorldContext(world, worldIdentity, "minecraft:overworld");
        assertEquals(
            FabricTargetProtection.ProtectionState.PROTECTED,
            protection.evaluateContext(world, "minecraft:overworld", expanded)
        );
        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolvePlacementFootprint(
                List.of(left),
                Map.of(left, leftState)::get
            )
        );
    }

    @Test
    void doubleChestUseResolvesAndValidatesItsFacingPartner() {
        for (Block chest : List.of(Blocks.CHEST, Blocks.TRAPPED_CHEST)) {
            BlockPos left = new BlockPos(20, 64, 20);
            BlockPos right = left.east();
            BlockState leftState = chest.getDefaultState()
                .with(ChestBlock.FACING, Direction.NORTH)
                .with(ChestBlock.CHEST_TYPE, ChestType.LEFT);
            BlockState rightState = chest.getDefaultState()
                .with(ChestBlock.FACING, Direction.NORTH)
                .with(ChestBlock.CHEST_TYPE, ChestType.RIGHT);
            Map<BlockPos, BlockState> world = Map.of(left, leftState, right, rightState);

            assertEquals(
                List.of(left, right),
                FabricInteractionAuthority.resolveUseFootprint(
                    left,
                    FabricInteractionAuthority.BlockTargetSemantics.USE_LIVE,
                    world::get
                )
            );
            assertEquals(
                List.of(right, left),
                FabricInteractionAuthority.resolveUseFootprint(
                    right,
                    FabricInteractionAuthority.BlockTargetSemantics.USE_LIVE,
                    world::get
                )
            );
        }
    }

    @Test
    void breakingDoubleChestIncludesAndProtectsThePartnerCell() {
        for (Block chest : List.of(Blocks.CHEST, Blocks.TRAPPED_CHEST)) {
            BlockPos left = new BlockPos(70, 64, 70);
            BlockPos right = left.east();
            BlockState leftState = chest.getDefaultState()
                .with(ChestBlock.FACING, Direction.NORTH)
                .with(ChestBlock.CHEST_TYPE, ChestType.LEFT);
            BlockState rightState = chest.getDefaultState()
                .with(ChestBlock.FACING, Direction.NORTH)
                .with(ChestBlock.CHEST_TYPE, ChestType.RIGHT);
            Map<BlockPos, BlockState> world = Map.of(left, leftState, right, rightState);

            assertEquals(
                List.of(left, right),
                FabricInteractionAuthority.resolveBreakFootprint(left, world::get)
            );
            assertEquals(
                List.of(right, left),
                FabricInteractionAuthority.resolveBreakFootprint(right, world::get)
            );

            String worldIdentity = "world-v1-" + "c".repeat(64);
            FabricTargetProtection protection = FabricTargetProtection.fromConfiguredRegions(
                worldIdentity + "|minecraft:overworld@" + right.getX() + ","
                    + right.getY() + "," + right.getZ()
            );
            protection.observeWorldContext(world, worldIdentity, "minecraft:overworld");
            FabricTargetProtection.ProtectionState protectionState =
                protection.evaluateContext(
                    world,
                    "minecraft:overworld",
                    FabricInteractionAuthority.resolveBreakFootprint(left, world::get)
                );
            assertEquals(FabricTargetProtection.ProtectionState.PROTECTED, protectionState);

            FabricWorldActionAuthorization.Decision decision =
                new FabricWorldActionAuthorization().authorize(
                    FabricWorldActionAuthorization.BlockAuthorization.naturalResource(),
                    protectionState
                );
            assertFalse(decision.allowed());
            assertTrue(decision.reason().contains("do_not_touch"));
        }
    }

    @Test
    void chestBreakKeepsSinglesOneCellAndRejectsMalformedPairs() {
        BlockPos left = new BlockPos(80, 64, 80);
        BlockPos right = left.east();
        BlockState single = Blocks.CHEST.getDefaultState()
            .with(ChestBlock.FACING, Direction.NORTH)
            .with(ChestBlock.CHEST_TYPE, ChestType.SINGLE);
        BlockState leftState = Blocks.CHEST.getDefaultState()
            .with(ChestBlock.FACING, Direction.NORTH)
            .with(ChestBlock.CHEST_TYPE, ChestType.LEFT);
        BlockState wrongFacing = Blocks.CHEST.getDefaultState()
            .with(ChestBlock.FACING, Direction.SOUTH)
            .with(ChestBlock.CHEST_TYPE, ChestType.RIGHT);
        BlockState wrongBlock = Blocks.TRAPPED_CHEST.getDefaultState()
            .with(ChestBlock.FACING, Direction.NORTH)
            .with(ChestBlock.CHEST_TYPE, ChestType.RIGHT);

        assertEquals(
            List.of(left),
            FabricInteractionAuthority.resolveBreakFootprint(
                left,
                Map.of(left, single)::get
            )
        );
        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolveBreakFootprint(
                left,
                Map.of(left, leftState)::get
            )
        );
        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolveBreakFootprint(
                left,
                Map.of(left, leftState, right, wrongFacing)::get
            )
        );
        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolveBreakFootprint(
                left,
                Map.of(left, leftState, right, wrongBlock)::get
            )
        );
    }

    @Test
    void chestUseFailsClosedForMismatchedPairButOrdinaryUseRemainsOneCell() {
        BlockPos left = new BlockPos(20, 64, 20);
        BlockPos right = left.east();
        BlockState leftState = Blocks.CHEST.getDefaultState()
            .with(ChestBlock.FACING, Direction.NORTH)
            .with(ChestBlock.CHEST_TYPE, ChestType.LEFT);
        BlockState wrongRight = Blocks.CHEST.getDefaultState()
            .with(ChestBlock.FACING, Direction.SOUTH)
            .with(ChestBlock.CHEST_TYPE, ChestType.RIGHT);

        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolveUseFootprint(
                left,
                FabricInteractionAuthority.BlockTargetSemantics.USE_LIVE,
                Map.of(left, leftState, right, wrongRight)::get
            )
        );
        assertEquals(
            List.of(left),
            FabricInteractionAuthority.resolveUseFootprint(
                left,
                FabricInteractionAuthority.BlockTargetSemantics.USE_LIVE,
                Map.of(left, Blocks.CRAFTING_TABLE.getDefaultState())::get
            )
        );
    }

    @Test
    void doubleBlockUseResolvesBothHalvesAndFailsClosedForMalformedPair() {
        BlockPos lower = new BlockPos(60, 64, 60);
        BlockPos upper = lower.up();
        BlockState lowerState = Blocks.OAK_DOOR.getDefaultState()
            .with(Properties.DOUBLE_BLOCK_HALF, DoubleBlockHalf.LOWER);
        BlockState upperState = Blocks.OAK_DOOR.getDefaultState()
            .with(Properties.DOUBLE_BLOCK_HALF, DoubleBlockHalf.UPPER);
        Map<BlockPos, BlockState> world = Map.of(lower, lowerState, upper, upperState);

        assertEquals(
            List.of(lower, upper),
            FabricInteractionAuthority.resolveUseFootprint(
                lower,
                FabricInteractionAuthority.BlockTargetSemantics.USE_LIVE,
                world::get
            )
        );
        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolveUseFootprint(
                lower,
                FabricInteractionAuthority.BlockTargetSemantics.USE_LIVE,
                Map.of(lower, lowerState)::get
            )
        );
    }

    @Test
    void breakingAnyDryDoubleBlockHalfStateResolvesBothMatchingHalves() {
        for (Block plantOrDoor : List.of(
            Blocks.TALL_GRASS,
            Blocks.LARGE_FERN,
            Blocks.SUNFLOWER,
            Blocks.LILAC,
            Blocks.ROSE_BUSH,
            Blocks.PEONY,
            Blocks.PITCHER_PLANT,
            Blocks.OAK_DOOR
        )) {
            BlockPos lower = new BlockPos(30, 64, 30);
            BlockPos upper = lower.up();
            BlockState lowerState = plantOrDoor.getDefaultState()
                .with(Properties.DOUBLE_BLOCK_HALF, DoubleBlockHalf.LOWER);
            BlockState upperState = plantOrDoor.getDefaultState()
                .with(Properties.DOUBLE_BLOCK_HALF, DoubleBlockHalf.UPPER);
            Map<BlockPos, BlockState> world = Map.of(lower, lowerState, upper, upperState);

            assertEquals(
                List.of(lower, upper),
                FabricInteractionAuthority.resolveBreakFootprint(lower, world::get),
                "lower half of " + plantOrDoor
            );
            assertEquals(
                List.of(upper, lower),
                FabricInteractionAuthority.resolveBreakFootprint(upper, world::get),
                "upper half of " + plantOrDoor
            );
        }
    }

    @Test
    void fluidReleasingBreakTargetsFailClosed() {
        BlockPos target = new BlockPos(31, 64, 30);
        for (BlockState state : List.of(
            Blocks.ICE.getDefaultState(),
            Blocks.FROSTED_ICE.getDefaultState(),
            Blocks.WATER.getDefaultState(),
            Blocks.TALL_SEAGRASS.getDefaultState()
                .with(Properties.DOUBLE_BLOCK_HALF, DoubleBlockHalf.LOWER),
            Blocks.TALL_SEAGRASS.getDefaultState()
                .with(Properties.DOUBLE_BLOCK_HALF, DoubleBlockHalf.UPPER),
            Blocks.OAK_STAIRS.getDefaultState().with(Properties.WATERLOGGED, true)
        )) {
            assertEquals(
                List.of(),
                FabricInteractionAuthority.resolveBreakFootprint(
                    target,
                    Map.of(target, state)::get
                ),
                "fluid-bearing break state " + state
            );
        }
    }

    @Test
    void breakingDoubleHeightPlantFailsClosedForMissingOrWrongHalf() {
        BlockPos lower = new BlockPos(30, 64, 30);
        BlockPos upper = lower.up();
        BlockState lowerState = Blocks.TALL_GRASS.getDefaultState()
            .with(Properties.DOUBLE_BLOCK_HALF, DoubleBlockHalf.LOWER);
        BlockState wrongUpper = Blocks.LARGE_FERN.getDefaultState()
            .with(Properties.DOUBLE_BLOCK_HALF, DoubleBlockHalf.UPPER);

        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolveBreakFootprint(
                lower,
                Map.of(lower, lowerState)::get
            )
        );
        assertEquals(
            List.of(),
            FabricInteractionAuthority.resolveBreakFootprint(
                lower,
                Map.of(lower, lowerState, upper, wrongUpper)::get
            )
        );
    }
}
