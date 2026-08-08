package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

class Nav3DGazeCursorTest {
    @Test
    void nav3dPointIdentityIgnoresLiveTargetHeight() {
        String lower = McbotFabricClient.nav3dTravelTargetIdentity(
            "nav3d_approach",
            new Vec3d(12.5D, 63.0D, -4.5D)
        );
        String upper = McbotFabricClient.nav3dTravelTargetIdentity(
            "nav3d_approach",
            new Vec3d(12.5D, 71.0D, -4.5D)
        );

        assertEquals(lower, upper);
        assertEquals("point:nav3d_approach:12:-5", lower);
    }

    @Test
    void startsAtTheFirstForwardCellAndAdvancesSequentially() {
        List<VoxelCell> route = line(5);
        Nav3DGazeCursor cursor = new Nav3DGazeCursor();

        Nav3DGazeCursor.Selection initial = cursor.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            route,
            route.get(0)
        );
        assertTrue(initial.reset());
        assertEquals(route.get(1), initial.waypoint());
        assertEquals(1, initial.waypointIndex());
        assertEquals(3, initial.remainingCells());
        assertEquals(1, initial.maximumWaypointIndex());

        Nav3DGazeCursor.Selection advanced = cursor.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            route,
            route.get(1)
        );
        assertTrue(advanced.advanced());
        assertFalse(advanced.forwardResynchronized());
        assertEquals(route.get(2), advanced.waypoint());
        assertEquals(2, advanced.waypointIndex());
        assertEquals(2, advanced.maximumWaypointIndex());
        assertEquals(0, advanced.forwardResynchronizations());
    }

    @Test
    void forwardResynchronizationAcceptsEightCellsButNotNine() {
        List<VoxelCell> route = line(12);
        Nav3DGazeCursor accepted = new Nav3DGazeCursor();
        accepted.select(Nav3DGazeCursor.Scope.SMOOTH, identity(), route, route.get(0));

        Nav3DGazeCursor.Selection resynchronized = accepted.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            route,
            route.get(9)
        );
        assertTrue(resynchronized.advanced());
        assertTrue(resynchronized.forwardResynchronized());
        assertEquals(route.get(10), resynchronized.waypoint());
        assertEquals(10, resynchronized.waypointIndex());
        assertEquals(1, resynchronized.forwardResynchronizations());

        Nav3DGazeCursor rejected = new Nav3DGazeCursor();
        rejected.select(Nav3DGazeCursor.Scope.SMOOTH, identity(), route, route.get(0));
        Nav3DGazeCursor.Selection tooFar = rejected.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            route,
            route.get(10)
        );
        assertFalse(tooFar.advanced());
        assertFalse(tooFar.forwardResynchronized());
        assertEquals(route.get(1), tooFar.waypoint());
        assertEquals(1, tooFar.waypointIndex());
        assertEquals(0, tooFar.forwardResynchronizations());
    }

    @Test
    void earlierRouteObservationsNeverRegressTheCursor() {
        List<VoxelCell> route = line(9);
        Nav3DGazeCursor cursor = new Nav3DGazeCursor();
        cursor.select(Nav3DGazeCursor.Scope.SMOOTH, identity(), route, route.get(0));
        Nav3DGazeCursor.Selection forward = cursor.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            route,
            route.get(4)
        );
        assertEquals(5, forward.waypointIndex());
        assertEquals(1, forward.forwardResynchronizations());

        Nav3DGazeCursor.Selection earlier = cursor.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            route,
            route.get(2)
        );
        assertFalse(earlier.advanced());
        assertFalse(earlier.forwardResynchronized());
        assertEquals(route.get(5), earlier.waypoint());
        assertEquals(5, earlier.waypointIndex());
        assertEquals(5, earlier.maximumWaypointIndex());
        assertEquals(1, earlier.forwardResynchronizations());

        Nav3DGazeCursor.Selection sequential = cursor.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            route,
            route.get(5)
        );
        assertTrue(sequential.advanced());
        assertFalse(sequential.forwardResynchronized());
        assertEquals(6, sequential.waypointIndex());
        assertEquals(1, sequential.forwardResynchronizations());
    }

    @Test
    void shadowAndSmoothCursorsAdvanceIndependently() {
        List<VoxelCell> route = line(5);
        Nav3DGazeCursor cursor = new Nav3DGazeCursor();
        cursor.select(Nav3DGazeCursor.Scope.SHADOW, identity(), route, route.get(0));
        cursor.select(Nav3DGazeCursor.Scope.SMOOTH, identity(), route, route.get(0));

        Nav3DGazeCursor.Selection shadow = cursor.select(
            Nav3DGazeCursor.Scope.SHADOW,
            identity(),
            route,
            route.get(1)
        );
        Nav3DGazeCursor.Selection smooth = cursor.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            route,
            route.get(0)
        );

        assertEquals(2, shadow.waypointIndex());
        assertEquals(1, smooth.waypointIndex());
        assertFalse(smooth.reset());
        assertFalse(smooth.advanced());
    }

    @Test
    void commandRouteTargetWorldAndDimensionChangesResetState() {
        List<VoxelCell> route = line(6);
        List<Nav3DGazeCursor.Identity> changedIdentities = List.of(
            new Nav3DGazeCursor.Identity("cmd-2", 7L, "drop:1", "world-a", "overworld"),
            new Nav3DGazeCursor.Identity("cmd-1", 8L, "drop:1", "world-a", "overworld"),
            new Nav3DGazeCursor.Identity("cmd-1", 7L, "drop:2", "world-a", "overworld"),
            new Nav3DGazeCursor.Identity("cmd-1", 7L, "drop:1", "world-b", "overworld"),
            new Nav3DGazeCursor.Identity("cmd-1", 7L, "drop:1", "world-a", "the_nether")
        );

        for (Nav3DGazeCursor.Identity changed : changedIdentities) {
            Nav3DGazeCursor cursor = advancedCursor(route);
            Nav3DGazeCursor.Selection reset = cursor.select(
                Nav3DGazeCursor.Scope.SMOOTH,
                changed,
                route,
                route.get(4)
            );
            assertTrue(reset.reset(), changed.toString());
            assertFalse(reset.advanced(), changed.toString());
            assertEquals(1, reset.waypointIndex(), changed.toString());
            assertEquals(0, reset.forwardResynchronizations(), changed.toString());
        }
    }

    @Test
    void replacingTheRouteInstanceResetsEvenWhenItsCellsMatch() {
        List<VoxelCell> route = line(6);
        Nav3DGazeCursor cursor = advancedCursor(route);
        List<VoxelCell> replacement = new ArrayList<>(route);

        Nav3DGazeCursor.Selection reset = cursor.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            replacement,
            route.get(4)
        );

        assertTrue(reset.reset());
        assertEquals(1, reset.waypointIndex());
        assertEquals(0, reset.forwardResynchronizations());
    }

    @Test
    void explicitScopeAndGlobalResetClearLifecycleState() {
        List<VoxelCell> route = line(4);
        Nav3DGazeCursor cursor = new Nav3DGazeCursor();
        cursor.select(Nav3DGazeCursor.Scope.SHADOW, identity(), route, route.get(0));
        cursor.select(Nav3DGazeCursor.Scope.SMOOTH, identity(), route, route.get(0));
        cursor.select(Nav3DGazeCursor.Scope.SHADOW, identity(), route, route.get(1));
        cursor.select(Nav3DGazeCursor.Scope.SMOOTH, identity(), route, route.get(1));

        cursor.reset(Nav3DGazeCursor.Scope.SHADOW);
        Nav3DGazeCursor.Selection shadowReset = cursor.select(
            Nav3DGazeCursor.Scope.SHADOW,
            identity(),
            route,
            route.get(2)
        );
        Nav3DGazeCursor.Selection smoothPreserved = cursor.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            route,
            route.get(2)
        );
        assertTrue(shadowReset.reset());
        assertEquals(1, shadowReset.waypointIndex());
        assertFalse(smoothPreserved.reset());
        assertEquals(3, smoothPreserved.waypointIndex());

        cursor.resetAll();
        Nav3DGazeCursor.Selection smoothReset = cursor.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            route,
            route.get(3)
        );
        assertTrue(smoothReset.reset());
        assertEquals(1, smoothReset.waypointIndex());
    }

    @Test
    void invalidInputClearsOnlyTheRequestedScope() {
        List<VoxelCell> route = line(4);
        Nav3DGazeCursor cursor = new Nav3DGazeCursor();
        cursor.select(Nav3DGazeCursor.Scope.SHADOW, identity(), route, route.get(0));
        cursor.select(Nav3DGazeCursor.Scope.SMOOTH, identity(), route, route.get(0));

        Nav3DGazeCursor.Selection inactive = cursor.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            List.of(),
            route.get(0)
        );
        assertFalse(inactive.active());
        assertNull(inactive.waypoint());
        assertEquals(-1, inactive.waypointIndex());

        Nav3DGazeCursor.Selection smoothReset = cursor.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            route,
            route.get(0)
        );
        Nav3DGazeCursor.Selection shadowPreserved = cursor.select(
            Nav3DGazeCursor.Scope.SHADOW,
            identity(),
            route,
            route.get(1)
        );
        assertTrue(smoothReset.reset());
        assertFalse(shadowPreserved.reset());
        assertEquals(2, shadowPreserved.waypointIndex());
    }

    @Test
    void aSingleCellRouteRemainsItsOnlyWaypoint() {
        List<VoxelCell> route = List.of(new VoxelCell(4, 70, -2));
        Nav3DGazeCursor cursor = new Nav3DGazeCursor();

        Nav3DGazeCursor.Selection selected = cursor.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            route,
            route.get(0)
        );
        assertTrue(selected.active());
        assertEquals(route.get(0), selected.waypoint());
        assertEquals(0, selected.waypointIndex());
        assertEquals(0, selected.remainingCells());

        Nav3DGazeCursor.Selection observed = cursor.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            route,
            route.get(0)
        );
        assertFalse(observed.advanced());
        assertEquals(0, observed.waypointIndex());
    }

    private static Nav3DGazeCursor advancedCursor(List<VoxelCell> route) {
        Nav3DGazeCursor cursor = new Nav3DGazeCursor();
        cursor.select(Nav3DGazeCursor.Scope.SMOOTH, identity(), route, route.get(0));
        Nav3DGazeCursor.Selection advanced = cursor.select(
            Nav3DGazeCursor.Scope.SMOOTH,
            identity(),
            route,
            route.get(3)
        );
        assertEquals(4, advanced.waypointIndex());
        return cursor;
    }

    private static Nav3DGazeCursor.Identity identity() {
        return new Nav3DGazeCursor.Identity(
            "cmd-1",
            7L,
            "drop:1",
            "world-a",
            "overworld"
        );
    }

    private static List<VoxelCell> line(int length) {
        List<VoxelCell> route = new ArrayList<>();
        for (int index = 0; index < length; index++) {
            route.add(new VoxelCell(index, 64, 0));
        }
        return List.copyOf(route);
    }
}
