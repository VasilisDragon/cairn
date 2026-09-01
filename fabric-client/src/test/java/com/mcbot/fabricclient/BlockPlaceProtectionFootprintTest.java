package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import net.minecraft.Bootstrap;
import net.minecraft.SharedConstants;
import net.minecraft.block.Blocks;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

class BlockPlaceProtectionFootprintTest {
    @BeforeAll
    static void bootstrapMinecraftRegistries() {
        SharedConstants.createGameVersion();
        Bootstrap.initialize();
    }

    @Test
    void bedPlacementCarriesOnlyStableOriginAndExpandsCardinallyAtSink() {
        BlockPos support = new BlockPos(10, 64, 10);
        BlockPos foot = support.up();
        FabricInteractionAuthority.Payload payload =
            FabricInteractionAuthority.Payload.bedPlacement(
                hit(support),
                Hand.MAIN_HAND,
                FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
                Blocks.WHITE_BED,
                foot
            );

        assertEquals(
            List.of(support, foot),
            payload.affectedBlockPositions()
        );
        assertEquals(
            FabricInteractionAuthority.BlockTargetSemantics.BED_PLACEMENT,
            payload.blockTargetSemantics()
        );
        assertEquals(
            List.of(
                support,
                foot,
                foot.north(),
                foot.south(),
                foot.east(),
                foot.west()
            ),
            FabricInteractionAuthority.conservativeBedPlacementFootprint(support, foot)
        );
    }

    @Test
    void bedPlacementFailsClosedWithoutSupportOrFootGeometry() {
        BlockPos support = new BlockPos(10, 64, 10);
        FabricInteractionAuthority.Payload missingFoot =
            FabricInteractionAuthority.Payload.bedPlacement(
                hit(support),
                Hand.MAIN_HAND,
                FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
                Blocks.WHITE_BED,
                null
            );

        assertEquals(List.of(), missingFoot.affectedBlockPositions());
        assertEquals(
            List.of(),
            FabricInteractionAuthority.conservativeBedPlacementFootprint(support, null)
        );
        assertEquals(
            List.of(),
            FabricInteractionAuthority.conservativeBedPlacementFootprint(null, support)
        );
    }

    @Test
    void queuedPlacementAuthorizesBothLiveReplaceabilityDestinations() {
        BlockPos clicked = new BlockPos(20, 64, 20);
        BlockHitResult clickedHit = hit(clicked, Direction.UP);
        FabricInteractionAuthority.Payload payload =
            FabricInteractionAuthority.Payload.blockPlacement(
                clickedHit,
                Hand.MAIN_HAND,
                FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
                Blocks.COBBLESTONE,
                List.of(clicked)
            );

        assertEquals(
            List.of(clicked, clicked.up()),
            FabricInteractionAuthority.conservativeLivePlacementFootprint(
                payload.blockHit(),
                payload.affectedBlockPositions()
            )
        );
    }

    @Test
    void queuedBedPlacementExpandsTheRedirectedLiveFootAndEveryHeadDirection() {
        BlockPos clicked = new BlockPos(30, 64, 30);
        BlockPos redirectedFoot = clicked.up();

        assertEquals(
            List.of(
                clicked,
                clicked.north(),
                clicked.south(),
                clicked.east(),
                clicked.west(),
                redirectedFoot,
                redirectedFoot.north(),
                redirectedFoot.south(),
                redirectedFoot.east(),
                redirectedFoot.west()
            ),
            FabricInteractionAuthority.conservativeLiveBedPlacementFootprint(
                hit(clicked, Direction.UP),
                clicked
            )
        );
    }

    @Test
    void queuedBedPlacementAcceptsOnlyTheTwoVanillaFootCandidates() {
        BlockPos support = new BlockPos(35, 64, 35);
        BlockHitResult topHit = hit(support, Direction.UP);
        List<BlockPos> normal =
            FabricInteractionAuthority.conservativeLiveBedPlacementFootprint(
                topHit,
                support.up()
            );

        assertEquals(10, normal.size());
        String worldIdentity = "world-v1-" + "d".repeat(64);
        Object liveWorld = new Object();
        List<BlockPos> liveResolved = FabricInteractionAuthority.resolvePlacementFootprint(
            normal,
            ignored -> Blocks.AIR.getDefaultState()
        );
        FabricTargetProtection emptyProtection =
            FabricTargetProtection.fromConfiguredRegions("");
        emptyProtection.observeWorldContext(
            liveWorld,
            worldIdentity,
            "minecraft:overworld"
        );
        FabricTargetProtection.ProtectionState emptyState =
            emptyProtection.evaluateContext(
                liveWorld,
                "minecraft:overworld",
                liveResolved
            );
        FabricWorldActionAuthorization authorization =
            new FabricWorldActionAuthorization();
        authorization.observe(new FabricWorldActionAuthorization.WorldObservation(
            "fixture-session-bed-placement",
            worldIdentity,
            worldIdentity,
            "",
            true,
            false,
            true,
            1
        ));

        assertEquals(10, liveResolved.size());
        assertEquals(FabricTargetProtection.ProtectionState.UNPROTECTED, emptyState);
        assertTrue(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            emptyState
        ).allowed());
        for (BlockPos candidate : normal) {
            FabricTargetProtection protection = FabricTargetProtection.fromConfiguredRegions(
                worldIdentity + "|minecraft:overworld@" + candidate.getX() + ","
                    + candidate.getY() + "," + candidate.getZ()
            );
            protection.observeWorldContext(liveWorld, worldIdentity, "minecraft:overworld");
            assertEquals(
                FabricTargetProtection.ProtectionState.PROTECTED,
                protection.evaluateContext(liveWorld, "minecraft:overworld", normal)
            );
        }
        assertEquals(
            List.of(),
            FabricInteractionAuthority.conservativeLiveBedPlacementFootprint(
                topHit,
                support.east()
            )
        );
    }

    private static BlockHitResult hit(BlockPos position) {
        return hit(position, Direction.UP);
    }

    private static BlockHitResult hit(BlockPos position, Direction side) {
        return new BlockHitResult(
            Vec3d.ofCenter(position),
            side,
            position,
            false
        );
    }
}
