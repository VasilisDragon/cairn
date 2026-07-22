package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import net.minecraft.util.math.BlockPos;
import org.junit.jupiter.api.Test;

class StaircaseDescentPlannerTest {
    @Test
    void computesOneBlockDownCardinalSteps() {
        BlockPos start = new BlockPos(10, 70, 20);
        StaircaseDescentPlanner.Step first = StaircaseDescentPlanner.step(start, StaircaseDescentPlanner.east(), 1);
        StaircaseDescentPlanner.Step third = StaircaseDescentPlanner.step(start, StaircaseDescentPlanner.east(), 3);

        assertEquals(new BlockPos(10, 70, 20), first.currentFeet());
        assertEquals(new BlockPos(11, 69, 20), first.nextFeet());
        assertEquals(new BlockPos(11, 71, 20), first.sightClear());
        assertEquals(new BlockPos(11, 70, 20), first.upperClear());
        assertEquals(new BlockPos(11, 69, 20), first.lowerClear());
        assertEquals(new BlockPos(11, 68, 20), first.support());

        assertEquals(new BlockPos(12, 68, 20), third.currentFeet());
        assertEquals(new BlockPos(13, 67, 20), third.nextFeet());
    }

    @Test
    void computesOneStepFromCurrentFeetForReroutes() {
        BlockPos current = new BlockPos(10, 67, 20);
        StaircaseDescentPlanner.Step turn = StaircaseDescentPlanner.stepFrom(current, StaircaseDescentPlanner.south(), 4);

        assertEquals(new BlockPos(10, 67, 20), turn.currentFeet());
        assertEquals(new BlockPos(10, 66, 21), turn.nextFeet());
        assertEquals(new BlockPos(10, 65, 21), turn.support());
        assertEquals(4, turn.index());
    }

    @Test
    void levelStepAdvancesOneCellAtSameHeight() {
        BlockPos current = new BlockPos(10, 60, -4);
        StaircaseDescentPlanner.Step step = StaircaseDescentPlanner.levelStepFrom(current, StaircaseDescentPlanner.east(), 3);

        assertEquals(new BlockPos(10, 60, -4), step.currentFeet());
        assertEquals(new BlockPos(11, 60, -4), step.nextFeet());
        assertEquals(new BlockPos(11, 61, -4), step.sightClear());
        assertEquals(new BlockPos(11, 61, -4), step.upperClear());
        assertEquals(new BlockPos(11, 60, -4), step.lowerClear());
        assertEquals(new BlockPos(11, 59, -4), step.support());
        assertEquals(3, step.index());
        assertFalse(StaircaseDescentPlanner.targetsSelfSupport(step));
    }

    @Test
    void plannedTargetsNeverIncludeCurrentSupport() {
        BlockPos start = new BlockPos(-5, 101, 7);
        for (int index = 1; index <= 12; index++) {
            StaircaseDescentPlanner.Step step = StaircaseDescentPlanner.step(start, StaircaseDescentPlanner.north(), index);
            assertFalse(StaircaseDescentPlanner.targetsSelfSupport(step), "step " + index + " must not dig current support");
        }
    }

    @Test
    void boundsRequestedDepth() {
        assertEquals(1, StaircaseDescentPlanner.boundedDepth(-3, 12));
        assertEquals(4, StaircaseDescentPlanner.boundedDepth(4, 12));
        assertEquals(12, StaircaseDescentPlanner.boundedDepth(20, 12));
    }

    @Test
    void deepDescentUsesDeepCapOnlyForNegativeTargetY() {
        assertEquals(6, McbotFabricClient.resolveDescentDepthForTargetY(null, 70));
        assertEquals(20, McbotFabricClient.resolveDescentDepthForTargetY(11.0D, 70));
        assertEquals(128, McbotFabricClient.resolveDescentDepthForTargetY(-59.0D, 70));
    }

    @Test
    void resolvesDominantCardinalDelta() {
        assertEquals(StaircaseDescentPlanner.east(), StaircaseDescentPlanner.cardinalFromDelta(5, 1, StaircaseDescentPlanner.north()));
        assertEquals(StaircaseDescentPlanner.north(), StaircaseDescentPlanner.cardinalFromDelta(1, -5, StaircaseDescentPlanner.south()));
        assertEquals(StaircaseDescentPlanner.west(), StaircaseDescentPlanner.cardinalFromDelta(0, 0, StaircaseDescentPlanner.west()));
    }

    @Test
    void choosesBoundedRerouteWithoutRepeatingCurrentDirection() {
        assertEquals(
            StaircaseDescentPlanner.south(),
            StaircaseDescentPlanner.chooseReroute(
                StaircaseDescentPlanner.east(),
                direction -> direction.equals(StaircaseDescentPlanner.south())
            )
        );
        assertEquals(
            StaircaseDescentPlanner.north(),
            StaircaseDescentPlanner.chooseReroute(
                StaircaseDescentPlanner.east(),
                direction -> direction.equals(StaircaseDescentPlanner.north())
            )
        );
        assertNull(StaircaseDescentPlanner.chooseReroute(StaircaseDescentPlanner.east(), direction -> false));
    }

    @Test
    void rerouteCandidateOrderingPrefersSideTurnsBeforeReverse() {
        assertEquals(
            List.of(StaircaseDescentPlanner.east(), StaircaseDescentPlanner.west(), StaircaseDescentPlanner.south()),
            StaircaseDescentPlanner.rerouteCandidates(StaircaseDescentPlanner.north())
        );
        assertEquals(
            List.of(StaircaseDescentPlanner.west(), StaircaseDescentPlanner.east(), StaircaseDescentPlanner.north()),
            StaircaseDescentPlanner.rerouteCandidates(StaircaseDescentPlanner.south())
        );
        assertEquals(
            List.of(StaircaseDescentPlanner.south(), StaircaseDescentPlanner.north(), StaircaseDescentPlanner.west()),
            StaircaseDescentPlanner.rerouteCandidates(StaircaseDescentPlanner.east())
        );
        assertEquals(
            List.of(StaircaseDescentPlanner.north(), StaircaseDescentPlanner.south(), StaircaseDescentPlanner.east()),
            StaircaseDescentPlanner.rerouteCandidates(StaircaseDescentPlanner.west())
        );
    }

    @Test
    void nullCurrentRerouteHasStableExplorationOrdering() {
        assertEquals(
            List.of(
                StaircaseDescentPlanner.south(),
                StaircaseDescentPlanner.east(),
                StaircaseDescentPlanner.west(),
                StaircaseDescentPlanner.north()
            ),
            StaircaseDescentPlanner.rerouteCandidates(null)
        );
    }
}
