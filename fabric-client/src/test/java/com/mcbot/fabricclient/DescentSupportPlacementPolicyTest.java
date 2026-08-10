package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import org.junit.jupiter.api.Test;

class DescentSupportPlacementPolicyTest {
    @Test
    void waterSealKeepsOriginalSpecAfterLastFillerIsConsumed() {
        BlockPlaceController.PlaceSpec original = spec("cobblestone");

        assertEquals(
            original,
            DescentExecutor.selectDescentSupportPlaceSpec(true, original, null)
        );
    }

    @Test
    void waterSealIgnoresAReplacementFillerUntilVerificationCompletes() {
        BlockPlaceController.PlaceSpec original = spec("cobblestone");
        BlockPlaceController.PlaceSpec replacement = spec("dirt");

        assertEquals(
            original,
            DescentExecutor.selectDescentSupportPlaceSpec(
                true,
                original,
                replacement
            )
        );
    }

    @Test
    void ordinarySupportPlacementUsesCurrentlyAvailableSpec() {
        BlockPlaceController.PlaceSpec available = spec("dirt");

        assertEquals(
            available,
            DescentExecutor.selectDescentSupportPlaceSpec(
                false,
                spec("cobblestone"),
                available
            )
        );
        assertNull(
            DescentExecutor.selectDescentSupportPlaceSpec(false, null, null)
        );
    }

    @Test
    void waterSealConstraintOwnsOneExactHorizontalPlacement() {
        BlockPos hitBlock = new BlockPos(4, 10, 6);
        BlockPos waterCell = hitBlock.south();
        BlockPlaceController.FaceConstraint constraint =
            DescentExecutor.waterSealFaceConstraint(
                true,
                hitBlock,
                waterCell
            );

        assertEquals(hitBlock, constraint.expectedHitBlock());
        assertEquals(Direction.SOUTH, constraint.expectedHitSide());
        assertEquals(waterCell, constraint.expectedPlacePos());
        assertEquals(true, constraint.matches(hitBlock, Direction.SOUTH, waterCell));
        assertEquals(false, constraint.matches(hitBlock, Direction.NORTH, waterCell));
        assertNull(DescentExecutor.waterSealFaceConstraint(false, hitBlock, waterCell));
        assertNull(DescentExecutor.waterSealFaceConstraint(true, hitBlock, hitBlock.up()));
    }

    @Test
    void faceConstraintRejectsDownwardAndNonAdjacentPlacements() {
        BlockPos hitBlock = new BlockPos(4, 10, 6);

        assertThrows(
            IllegalArgumentException.class,
            () -> new BlockPlaceController.FaceConstraint(
                hitBlock,
                Direction.DOWN,
                hitBlock.down()
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> new BlockPlaceController.FaceConstraint(
                hitBlock,
                Direction.NORTH,
                hitBlock.north(2)
            )
        );
    }

    private static BlockPlaceController.PlaceSpec spec(String itemId) {
        return new BlockPlaceController.PlaceSpec(
            "place_support",
            itemId,
            null,
            false,
            true
        );
    }
}
