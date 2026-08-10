package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

final class IronToolReserveRestockIdentityPolicyTest {
    private final Object world = new Object();
    private final VoxelCell frontier = new VoxelCell(8, 14, 12);

    @Test
    void exactResumeIdentityCompletes() {
        IronToolReserveRestockIdentityPolicy.Identity frozen = identity(world, "overworld", 4, 2, "p14", "EAST", 41, frontier);
        assertNull(IronToolReserveRestockIdentityPolicy.validate(frozen, frozen, true));
    }

    @Test
    void craftCompletionDoesNotRequireFrontierUntilResume() {
        IronToolReserveRestockIdentityPolicy.Identity frozen = identity(world, "overworld", 4, 2, "p14", "EAST", 41, frontier);
        IronToolReserveRestockIdentityPolicy.Identity atWorkspace = identity(world, "overworld", 4, 2, "p14", "EAST", 41, new VoxelCell(0, 16, 0));
        assertNull(IronToolReserveRestockIdentityPolicy.validate(frozen, atWorkspace, false));
        assertEquals("frontier_not_restored",
            IronToolReserveRestockIdentityPolicy.validate(frozen, atWorkspace, true));
    }

    @Test
    void lifecycleAndBudgetChangesRejectBeforeCompletion() {
        IronToolReserveRestockIdentityPolicy.Identity frozen = identity(world, "overworld", 4, 2, "p14", "EAST", 41, frontier);
        assertEquals("world_changed", validate(frozen, identity(new Object(), "overworld", 4, 2, "p14", "EAST", 41, frontier)));
        assertEquals("dimension_changed", validate(frozen, identity(world, "the_nether", 4, 2, "p14", "EAST", 41, frontier)));
        assertEquals("workspace_session_changed", validate(frozen, identity(world, "overworld", 5, 2, "p14", "EAST", 41, frontier)));
        assertEquals("epoch_changed", validate(frozen, identity(world, "overworld", 4, 3, "p14", "EAST", 41, frontier)));
        assertEquals("plane_changed", validate(frozen, identity(world, "overworld", 4, 2, "p15", "EAST", 41, frontier)));
        assertEquals("heading_changed", validate(frozen, identity(world, "overworld", 4, 2, "p14", "NORTH", 41, frontier)));
        assertEquals("block_budget_changed", validate(frozen, identity(world, "overworld", 4, 2, "p14", "EAST", 42, frontier)));
    }

    private String validate(
        IronToolReserveRestockIdentityPolicy.Identity frozen,
        IronToolReserveRestockIdentityPolicy.Identity live
    ) {
        return IronToolReserveRestockIdentityPolicy.validate(frozen, live, true);
    }

    private IronToolReserveRestockIdentityPolicy.Identity identity(
        Object worldIdentity,
        String dimension,
        long session,
        int epoch,
        String plane,
        String heading,
        int blocks,
        VoxelCell cell
    ) {
        return new IronToolReserveRestockIdentityPolicy.Identity(
            worldIdentity, dimension, session, epoch, plane, heading, blocks, cell
        );
    }
}
