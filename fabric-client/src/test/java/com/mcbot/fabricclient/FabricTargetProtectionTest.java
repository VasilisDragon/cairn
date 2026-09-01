package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Collections;
import java.util.List;
import java.util.stream.IntStream;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class FabricTargetProtectionTest {
    private static final String WORLD_A = "world-v1-" + "a".repeat(64);
    private static final String WORLD_B = "world-v1-" + "b".repeat(64);

    @Test
    void exactPointsAndInclusiveRegionsAreScopedToWorldAndDimension() {
        FabricTargetProtection protection = FabricTargetProtection.fromConfiguredRegions(
            WORLD_A + "|minecraft:overworld@1,64,3;"
                + WORLD_A + "|minecraft:overworld@10,70,12..8,68,10;"
                + WORLD_A + "|minecraft:the_nether@1,64,3;"
                + WORLD_B + "|minecraft:overworld@1,64,3"
        );
        Object liveWorld = new Object();
        protection.observeWorldContext(liveWorld, WORLD_A, "minecraft:overworld");

        assertTrue(protection.configurationReadable());
        assertEquals(4, protection.configuredRegionCount());
        assertEquals(
            FabricTargetProtection.ProtectionState.PROTECTED,
            protection.evaluateContext(
                liveWorld,
                "minecraft:overworld",
                List.of(new BlockPos(1, 64, 3))
            )
        );
        assertEquals(
            FabricTargetProtection.ProtectionState.PROTECTED,
            protection.evaluateContext(
                liveWorld,
                "minecraft:overworld",
                List.of(new BlockPos(9, 69, 11))
            )
        );
        assertEquals(
            FabricTargetProtection.ProtectionState.UNPROTECTED,
            protection.evaluateContext(
                liveWorld,
                "minecraft:overworld",
                List.of(new BlockPos(30, 80, 30))
            )
        );
        assertEquals(
            FabricTargetProtection.ProtectionState.UNKNOWN,
            protection.evaluateContext(
                liveWorld,
                "minecraft:the_nether",
                List.of(new BlockPos(1, 64, 3))
            )
        );
    }

    @Test
    void everyAffectedPositionIsCheckedSoPlacementReferenceAndDestinationAreProtected() {
        FabricTargetProtection protection = FabricTargetProtection.fromConfiguredRegions(
            WORLD_A + "|minecraft:overworld@5,65,5"
        );
        Object liveWorld = new Object();
        protection.observeWorldContext(liveWorld, WORLD_A, "minecraft:overworld");

        assertEquals(
            FabricTargetProtection.ProtectionState.PROTECTED,
            protection.evaluateContext(
                liveWorld,
                "minecraft:overworld",
                List.of(new BlockPos(4, 65, 5), new BlockPos(5, 65, 5))
            )
        );
        assertEquals(
            FabricTargetProtection.ProtectionState.PROTECTED,
            protection.evaluateContext(
                liveWorld,
                "minecraft:overworld",
                List.of(new BlockPos(5, 65, 5), new BlockPos(6, 65, 5))
            )
        );
    }

    @Test
    void staleOrMissingWorldContextAndMalformedPolicyFailClosed() {
        Object firstWorld = new Object();
        Object secondWorld = new Object();
        List<BlockPos> target = List.of(new BlockPos(1, 64, 3));
        FabricTargetProtection protection = FabricTargetProtection.fromConfiguredRegions(
            WORLD_A + "|minecraft:overworld@1,64,3"
        );

        assertEquals(
            FabricTargetProtection.ProtectionState.UNKNOWN,
            protection.evaluateContext(firstWorld, "minecraft:overworld", target)
        );
        protection.observeWorldContext(firstWorld, WORLD_A, "minecraft:overworld");
        assertEquals(
            FabricTargetProtection.ProtectionState.UNKNOWN,
            protection.evaluateContext(secondWorld, "minecraft:overworld", target)
        );
        protection.clearWorldContext();
        assertEquals(
            FabricTargetProtection.ProtectionState.UNKNOWN,
            protection.evaluateContext(firstWorld, "minecraft:overworld", target)
        );

        for (String malformed : List.of(
            WORLD_A + "|minecraft:overworld@1,2",
            WORLD_A + "|minecraft:overworld@1,2,3;",
            "not-an-opaque-id|minecraft:overworld@1,2,3",
            WORLD_A + "|not a dimension@1,2,3",
            WORLD_A + "|minecraft:overworld@2147483648,2,3",
            WORLD_A + "|minecraft:overworld@1,2,3..4,5,6..7,8,9"
        )) {
            FabricTargetProtection invalid =
                FabricTargetProtection.fromConfiguredRegions(malformed);
            invalid.observeWorldContext(firstWorld, WORLD_A, "minecraft:overworld");
            assertFalse(invalid.configurationReadable());
            assertEquals(
                FabricTargetProtection.ProtectionState.UNKNOWN,
                invalid.evaluateContext(firstWorld, "minecraft:overworld", target)
            );
        }

        FabricTargetProtection oversized = FabricTargetProtection.fromConfiguredRegions(
            "x".repeat(FabricTargetProtection.MAX_CONFIG_CHARS + 1)
        );
        assertFalse(oversized.configurationReadable());
        oversized.observeWorldContext(firstWorld, WORLD_A, "minecraft:overworld");
        assertEquals(
            FabricTargetProtection.ProtectionState.UNKNOWN,
            oversized.evaluateContext(firstWorld, "minecraft:overworld", target)
        );
    }

    @Test
    void explicitlyEmptyPolicyIsReadableButStillRequiresValidLiveGeometry() {
        FabricTargetProtection protection =
            FabricTargetProtection.fromConfiguredRegions("");
        Object liveWorld = new Object();
        protection.observeWorldContext(liveWorld, WORLD_A, "minecraft:overworld");

        assertTrue(protection.configurationReadable());
        assertEquals(0, protection.configuredRegionCount());
        assertEquals(
            FabricTargetProtection.ProtectionState.UNPROTECTED,
            protection.evaluateContext(
                liveWorld,
                "minecraft:overworld",
                List.of(new BlockPos(1, 2, 3))
            )
        );
        assertEquals(
            FabricTargetProtection.ProtectionState.UNKNOWN,
            protection.evaluateContext(liveWorld, "minecraft:overworld", List.of())
        );
        assertEquals(
            FabricTargetProtection.ProtectionState.UNKNOWN,
            protection.evaluateContext(
                liveWorld,
                "minecraft:overworld",
                Collections.singletonList(null)
            )
        );
    }

    @Test
    void conservativePlacementBoundAdmitsTwentyCellsAndRejectsTwentyOne() {
        FabricTargetProtection protection =
            FabricTargetProtection.fromConfiguredRegions("");
        Object liveWorld = new Object();
        protection.observeWorldContext(liveWorld, WORLD_A, "minecraft:overworld");
        List<BlockPos> twenty = IntStream.range(0, 20)
            .mapToObj(index -> new BlockPos(index, 64, 0))
            .toList();
        List<BlockPos> twentyOne = IntStream.range(0, 21)
            .mapToObj(index -> new BlockPos(index, 64, 0))
            .toList();

        assertEquals(20, FabricTargetProtection.MAX_AFFECTED_POSITIONS);
        assertEquals(
            FabricTargetProtection.ProtectionState.UNPROTECTED,
            protection.evaluateContext(liveWorld, "minecraft:overworld", twenty)
        );
        assertEquals(
            FabricTargetProtection.ProtectionState.UNKNOWN,
            protection.evaluateContext(liveWorld, "minecraft:overworld", twentyOne)
        );
    }

    @Test
    void fixtureCommandsRequireReadableExplicitlyEmptyCurrentWorldPolicy() {
        Object liveWorld = new Object();
        Object staleWorld = new Object();
        FabricTargetProtection empty = FabricTargetProtection.fromConfiguredRegions("");

        assertFalse(empty.fixtureCommandsAllowedForObservedWorld());
        assertFalse(empty.fixtureCommandsAllowedContext(
            liveWorld,
            "minecraft:overworld"
        ));
        empty.observeWorldContext(liveWorld, WORLD_A, "minecraft:overworld");
        assertTrue(empty.fixtureCommandsAllowedForObservedWorld());
        assertTrue(empty.fixtureCommandsAllowedContext(
            liveWorld,
            "minecraft:overworld"
        ));
        assertFalse(empty.fixtureCommandsAllowedContext(
            staleWorld,
            "minecraft:overworld"
        ));
        assertFalse(empty.fixtureCommandsAllowedContext(
            liveWorld,
            "minecraft:the_nether"
        ));
        empty.clearWorldContext();
        assertFalse(empty.fixtureCommandsAllowedForObservedWorld());

        FabricTargetProtection anyRegion = FabricTargetProtection.fromConfiguredRegions(
            WORLD_B + "|minecraft:the_end@100,50,100"
        );
        anyRegion.observeWorldContext(liveWorld, WORLD_A, "minecraft:overworld");
        assertFalse(anyRegion.fixtureCommandsAllowedForObservedWorld());
        assertFalse(anyRegion.fixtureCommandsAllowedContext(
            liveWorld,
            "minecraft:overworld"
        ));

        FabricTargetProtection malformed = FabricTargetProtection.fromConfiguredRegions(
            "not-a-region"
        );
        malformed.observeWorldContext(liveWorld, WORLD_A, "minecraft:overworld");
        assertFalse(malformed.fixtureCommandsAllowedForObservedWorld());
        assertFalse(malformed.fixtureCommandsAllowedContext(
            liveWorld,
            "minecraft:overworld"
        ));
    }

    @Test
    void unboundedBlockEffectsRequireReadableEmptyPolicyBoundToTheExactWorld() {
        Object liveWorld = new Object();
        Object staleWorld = new Object();
        FabricTargetProtection empty = FabricTargetProtection.fromConfiguredRegions("");

        assertFalse(empty.unboundedBlockEffectsAllowedForObservedWorld());
        empty.observeWorldContext(liveWorld, WORLD_A, "minecraft:overworld");
        assertTrue(empty.unboundedBlockEffectsAllowedForObservedWorld());
        assertTrue(empty.unboundedBlockEffectsAllowedContext(
            liveWorld,
            "minecraft:overworld"
        ));
        assertFalse(empty.unboundedBlockEffectsAllowedContext(
            staleWorld,
            "minecraft:overworld"
        ));

        FabricTargetProtection distantRegion = FabricTargetProtection.fromConfiguredRegions(
            WORLD_A + "|minecraft:overworld@100000,64,100000"
        );
        distantRegion.observeWorldContext(liveWorld, WORLD_A, "minecraft:overworld");
        assertFalse(distantRegion.unboundedBlockEffectsAllowedForObservedWorld());
        assertFalse(distantRegion.unboundedBlockEffectsAllowedContext(
            liveWorld,
            "minecraft:overworld"
        ));

        FabricTargetProtection malformed =
            FabricTargetProtection.fromConfiguredRegions("not-a-region");
        malformed.observeWorldContext(liveWorld, WORLD_A, "minecraft:overworld");
        assertFalse(malformed.unboundedBlockEffectsAllowedForObservedWorld());
    }

    @Test
    void changingWorldIdentityRebindsWithoutLeakingOldWorldProtection() {
        FabricTargetProtection protection = FabricTargetProtection.fromConfiguredRegions(
            WORLD_A + "|minecraft:overworld@1,64,3"
        );
        Object worldA = new Object();
        Object worldB = new Object();
        List<BlockPos> target = List.of(new BlockPos(1, 64, 3));
        protection.observeWorldContext(worldA, WORLD_A, "minecraft:overworld");
        assertEquals(
            FabricTargetProtection.ProtectionState.PROTECTED,
            protection.evaluateContext(worldA, "minecraft:overworld", target)
        );

        protection.observeWorldContext(worldB, WORLD_B, "minecraft:overworld");
        assertEquals(
            FabricTargetProtection.ProtectionState.UNKNOWN,
            protection.evaluateContext(worldA, "minecraft:overworld", target)
        );
        assertEquals(
            FabricTargetProtection.ProtectionState.UNPROTECTED,
            protection.evaluateContext(worldB, "minecraft:overworld", target)
        );
    }
}
