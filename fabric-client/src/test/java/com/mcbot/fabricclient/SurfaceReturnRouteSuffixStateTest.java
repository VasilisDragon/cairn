package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class SurfaceReturnRouteSuffixStateTest {
    @Test
    void rejectedSignatureSuppressesAnyLaterRouteContainingTheSameEdge() {
        SurfaceReturnRouteSuffixState state = new SurfaceReturnRouteSuffixState();
        List<VoxelCell> route = line(0, 4);

        assertEquals(
            SurfaceReturnRouteSuffixState.Admission.AVAILABLE,
            state.admission(7L, 11L, route)
        );
        SurfaceReturnRouteSuffixState.Signature signature = state.signature(route, 2);
        assertTrue(state.reject(signature));
        assertTrue(state.reject(signature));
        assertTrue(state.contains(signature));
        assertEquals(1, state.retainedSignatureCount());
        assertEquals(
            SurfaceReturnRouteSuffixState.Admission.KNOWN_BROKEN,
            state.admission(7L, 11L, route)
        );
        assertEquals(
            SurfaceReturnRouteSuffixState.Admission.KNOWN_BROKEN,
            state.admission(
                7L,
                11L,
                List.of(
                    new VoxelCell(0, 16, -1),
                    route.get(1),
                    route.get(2),
                    route.get(3)
                )
            )
        );
    }

    @Test
    void sessionOrTrailRevisionChangesClearRejectedSignatures() {
        SurfaceReturnRouteSuffixState state = new SurfaceReturnRouteSuffixState();
        List<VoxelCell> route = line(0, 3);
        state.admission(1L, 2L, route);
        SurfaceReturnRouteSuffixState.Signature first = state.signature(route, 1);
        assertTrue(state.reject(first));

        assertEquals(
            SurfaceReturnRouteSuffixState.Admission.AVAILABLE,
            state.admission(1L, 3L, route)
        );
        assertEquals(0, state.retainedSignatureCount());
        assertFalse(state.reject(first));

        SurfaceReturnRouteSuffixState.Signature second = state.signature(route, 1);
        assertTrue(state.reject(second));
        assertEquals(
            SurfaceReturnRouteSuffixState.Admission.AVAILABLE,
            state.admission(2L, 3L, route)
        );
        assertEquals(0, state.retainedSignatureCount());
        assertEquals(2L, state.sessionRevision());
        assertEquals(3L, state.trailRevision());
    }

    @Test
    void signatureCapacityFailsClosedWithoutGrowingPastBound() {
        SurfaceReturnRouteSuffixState state = new SurfaceReturnRouteSuffixState();
        List<VoxelCell> route = line(
            0,
            SurfaceReturnRouteSuffixState.MAX_REJECTED_SIGNATURES + 1
        );
        state.admission(1L, 1L, route);
        for (
            int index = 1;
            index <= SurfaceReturnRouteSuffixState.MAX_REJECTED_SIGNATURES;
            index++
        ) {
            assertTrue(state.reject(state.signature(route, index)));
        }
        assertFalse(state.reject(state.signature(
            new VoxelCell(1, 16, 0),
            new VoxelCell(2, 16, 0)
        )));
        assertTrue(state.saturated());
        assertEquals(
            SurfaceReturnRouteSuffixState.MAX_REJECTED_SIGNATURES,
            state.retainedSignatureCount()
        );
        assertEquals(
            SurfaceReturnRouteSuffixState.Admission.SATURATED,
            state.admission(1L, 1L, route)
        );
    }

    @Test
    void invalidRoutesAndStaleSignaturesCannotPoisonTheCache() {
        SurfaceReturnRouteSuffixState state = new SurfaceReturnRouteSuffixState();
        assertEquals(
            SurfaceReturnRouteSuffixState.Admission.INVALID,
            state.admission(1L, 1L, List.of(new VoxelCell(0, 16, 0)))
        );
        assertEquals(null, state.signature(List.of(new VoxelCell(0, 16, 0)), 1));
        assertEquals(null, state.signature(null, new VoxelCell(0, 16, 0)));

        List<VoxelCell> route = line(0, 2);
        state.admission(1L, 1L, route);
        SurfaceReturnRouteSuffixState.Signature stale = state.signature(route, 1);
        state.admission(1L, 2L, route);
        assertFalse(state.reject(stale));
        assertEquals(0, state.retainedSignatureCount());
    }

    private static List<VoxelCell> line(int start, int endInclusive) {
        List<VoxelCell> cells = new ArrayList<>();
        for (int z = start; z <= endInclusive; z++) {
            cells.add(new VoxelCell(0, 16, z));
        }
        return List.copyOf(cells);
    }
}
