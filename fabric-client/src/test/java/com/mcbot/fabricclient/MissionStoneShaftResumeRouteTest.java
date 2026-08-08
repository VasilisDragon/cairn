package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.lang.reflect.Method;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Pure route-package coverage for returning from later crafting movement to the frozen shaft. */
final class MissionStoneShaftResumeRouteTest {
    @Test
    void craftingDetourRetracesOnlyToTheCommonPrefixThenFinishesTheVerifiedShaft() throws Exception {
        VoxelCell anchor = cell(0, 0);
        VoxelCell sharedOne = cell(1, 0);
        VoxelCell shaftFrontier = cell(2, 0);
        VoxelCell verifiedNext = cell(3, 0);
        VoxelCell detourOne = cell(2, 1);
        VoxelCell craftingSite = cell(3, 1);
        List<VoxelCell> verified = List.of(anchor, sharedOne, shaftFrontier, verifiedNext);
        List<VoxelCell> live = List.of(anchor, sharedOne, shaftFrontier, detourOne, craftingSite);

        assertEquals(
            List.of(craftingSite, detourOne, shaftFrontier, verifiedNext),
            resumeRoute(live, verified, craftingSite)
        );
    }

    @Test
    void loopTruncatedLiveTrailWalksForwardFromItsLastCommonCell() throws Exception {
        VoxelCell anchor = cell(0, 0);
        VoxelCell truncatedFrontier = cell(1, 0);
        VoxelCell shaftTwo = cell(2, 0);
        VoxelCell shaftFrontier = cell(3, 0);
        List<VoxelCell> verified = List.of(anchor, truncatedFrontier, shaftTwo, shaftFrontier);
        List<VoxelCell> live = List.of(anchor, truncatedFrontier);

        assertEquals(
            List.of(truncatedFrontier, shaftTwo, shaftFrontier),
            resumeRoute(live, verified, truncatedFrontier)
        );
    }

    @SuppressWarnings("unchecked")
    private static List<VoxelCell> resumeRoute(
        List<VoxelCell> live,
        List<VoxelCell> verified,
        VoxelCell current
    ) throws Exception {
        Method method = McbotFabricClient.class.getDeclaredMethod(
            "missionStoneShaftResumeRoute", List.class, List.class, VoxelCell.class);
        method.setAccessible(true);
        return (List<VoxelCell>) method.invoke(null, live, verified, current);
    }

    private static VoxelCell cell(int x, int z) {
        return new VoxelCell(x, 64, z);
    }
}
