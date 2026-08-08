package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class MiningWorkspaceRouteSuffixStateTest {
    @Test
    void rejectedSignatureSuppressesTheWholeLaterRoute() {
        MiningWorkspaceRouteSuffixState state = new MiningWorkspaceRouteSuffixState();
        List<VoxelCell> route = line(0, 4);

        assertEquals(
            MiningWorkspaceRouteSuffixState.Admission.AVAILABLE,
            state.admission(
                7L,
                11L,
                "workspace",
                MiningWorkspaceTraversalController.Mode.RETURN,
                route
            )
        );
        MiningWorkspaceRouteSuffixState.Signature signature = state.signature(
            MiningWorkspaceTraversalController.Mode.RETURN,
            route,
            2
        );
        assertTrue(state.reject(signature));
        assertEquals(
            MiningWorkspaceRouteSuffixState.Admission.KNOWN_BROKEN,
            state.admission(
                7L,
                11L,
                "workspace",
                MiningWorkspaceTraversalController.Mode.RETURN,
                route
            )
        );
        assertEquals(
            MiningWorkspaceRouteSuffixState.Admission.AVAILABLE,
            state.admission(
                7L,
                11L,
                "workspace",
                MiningWorkspaceTraversalController.Mode.RESUME,
                route
            )
        );
    }

    @Test
    void trailWorkspaceAndSessionChangesClearRejectedSignatures() {
        MiningWorkspaceRouteSuffixState state = new MiningWorkspaceRouteSuffixState();
        List<VoxelCell> route = line(0, 3);
        state.admission(1L, 2L, "one", MiningWorkspaceTraversalController.Mode.RETURN, route);
        assertTrue(state.reject(state.signature(
            MiningWorkspaceTraversalController.Mode.RETURN,
            route,
            1
        )));

        assertEquals(
            MiningWorkspaceRouteSuffixState.Admission.AVAILABLE,
            state.admission(1L, 3L, "one", MiningWorkspaceTraversalController.Mode.RETURN, route)
        );
        assertEquals(0, state.retainedSignatureCount());

        assertTrue(state.reject(state.signature(
            MiningWorkspaceTraversalController.Mode.RETURN,
            route,
            1
        )));
        assertEquals(
            MiningWorkspaceRouteSuffixState.Admission.AVAILABLE,
            state.admission(1L, 3L, "two", MiningWorkspaceTraversalController.Mode.RETURN, route)
        );
        assertEquals(
            MiningWorkspaceRouteSuffixState.Admission.AVAILABLE,
            state.admission(2L, 3L, "two", MiningWorkspaceTraversalController.Mode.RETURN, route)
        );
    }

    @Test
    void signatureCapacityFailsClosedWithoutGrowingPastBound() {
        MiningWorkspaceRouteSuffixState state = new MiningWorkspaceRouteSuffixState();
        List<VoxelCell> route = line(0, MiningWorkspaceRouteSuffixState.MAX_REJECTED_SIGNATURES + 2);
        state.admission(1L, 1L, "workspace", MiningWorkspaceTraversalController.Mode.RETURN, route);
        for (int index = 1; index <= MiningWorkspaceRouteSuffixState.MAX_REJECTED_SIGNATURES; index++) {
            assertTrue(state.reject(state.signature(
                MiningWorkspaceTraversalController.Mode.RETURN,
                route,
                index
            )));
        }
        assertFalse(state.reject(state.signature(
            MiningWorkspaceTraversalController.Mode.RETURN,
            route,
            MiningWorkspaceRouteSuffixState.MAX_REJECTED_SIGNATURES + 1
        )));
        assertTrue(state.saturated());
        assertEquals(
            MiningWorkspaceRouteSuffixState.MAX_REJECTED_SIGNATURES,
            state.retainedSignatureCount()
        );
        assertEquals(
            MiningWorkspaceRouteSuffixState.Admission.SATURATED,
            state.admission(1L, 1L, "workspace", MiningWorkspaceTraversalController.Mode.RETURN, route)
        );
    }

    @Test
    void invalidRoutesDoNotCreateSignatures() {
        MiningWorkspaceRouteSuffixState state = new MiningWorkspaceRouteSuffixState();
        assertEquals(
            MiningWorkspaceRouteSuffixState.Admission.INVALID,
            state.admission(1L, 1L, "", MiningWorkspaceTraversalController.Mode.NONE, List.of())
        );
        assertEquals(null, state.signature(
            MiningWorkspaceTraversalController.Mode.RETURN,
            List.of(new VoxelCell(0, 16, 0)),
            1
        ));
    }

    private static List<VoxelCell> line(int start, int endInclusive) {
        List<VoxelCell> cells = new ArrayList<>();
        for (int z = start; z <= endInclusive; z++) {
            cells.add(new VoxelCell(0, 16, z));
        }
        return List.copyOf(cells);
    }
}
