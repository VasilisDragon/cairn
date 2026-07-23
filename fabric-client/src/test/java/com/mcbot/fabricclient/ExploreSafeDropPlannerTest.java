package com.mcbot.fabricclient;

import java.util.List;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ExploreSafeDropPlannerTest {

    private static ExploreSafeDropPlanner.Candidate safe(int dx, int dz, int fallBlocks, double remaining) {
        return new ExploreSafeDropPlanner.Candidate(
            dx, dz, fallBlocks, remaining, true, true, true, true, true, false, false, false);
    }

    @Test
    void acceptsZeroDamageProgressiveDropsAndPrefersTheShallowest() {
        ExploreSafeDropPlanner.Candidate chosen = ExploreSafeDropPlanner.chooseCandidate(List.of(
            safe(1, 0, 3, 4.0D),
            safe(0, 1, 2, 9.0D),
            safe(-1, 0, 1, 16.0D)
        ));

        assertEquals(1, chosen.fallBlocks());
        assertEquals(-1, chosen.dx());
    }

    @Test
    void rejectsExcessiveDepthAndEveryUnsafeLandingClass() {
        List<ExploreSafeDropPlanner.Candidate> rejected = List.of(
            safe(1, 0, 4, 1.0D),
            new ExploreSafeDropPlanner.Candidate(1, 0, 3, 1, false, true, true, true, true, false, false, false),
            new ExploreSafeDropPlanner.Candidate(1, 0, 3, 1, true, false, true, true, true, false, false, false),
            new ExploreSafeDropPlanner.Candidate(1, 0, 3, 1, true, true, false, true, true, false, false, false),
            new ExploreSafeDropPlanner.Candidate(1, 0, 3, 1, true, true, true, false, true, false, false, false),
            new ExploreSafeDropPlanner.Candidate(1, 0, 3, 1, true, true, true, true, false, false, false, false),
            new ExploreSafeDropPlanner.Candidate(1, 0, 3, 1, true, true, true, true, true, true, false, false),
            new ExploreSafeDropPlanner.Candidate(1, 0, 3, 1, true, true, true, true, true, false, true, false),
            new ExploreSafeDropPlanner.Candidate(1, 0, 3, 1, true, true, true, true, true, false, false, true)
        );

        for (ExploreSafeDropPlanner.Candidate candidate : rejected) {
            assertNull(ExploreSafeDropPlanner.chooseCandidate(List.of(candidate)));
        }
    }

    @Test
    void reasonAndEdgeGuardAuthorityAreNarrow() {
        assertTrue(ExploreSafeDropPlanner.reasonAllowed("exploration:wood:leg_1:hop_1"));
        assertFalse(ExploreSafeDropPlanner.reasonAllowed("gather_tree_search"));
        assertFalse(ExploreSafeDropPlanner.reasonAllowed(null));
        assertTrue(ExploreSafeDropPlanner.edgeGuardActionAllowed("nav3d_approach_safe_drop"));
        assertTrue(ExploreSafeDropPlanner.edgeGuardActionAllowed("nav3d_approach_safe_drop_hold"));
        assertFalse(ExploreSafeDropPlanner.edgeGuardActionAllowed("nav3d_approach_tunnel"));
        assertEquals(
            ExploreSafeDropPlanner.attemptKey("command-1", "exploration:wood:leg_1:hop_1"),
            ExploreSafeDropPlanner.attemptKey("command-1", "exploration:wood:leg_1:hop_1"));
        assertFalse(ExploreSafeDropPlanner.attemptKey("command-1", "exploration:wood:leg_1:hop_1")
            .equals(ExploreSafeDropPlanner.attemptKey("command-2", "exploration:wood:leg_1:hop_1")));
    }

    @Test
    void controllerProgressRotatesNudgesHoldsLandsAndFailsClosed() {
        assertEquals(ExploreSafeDropPlanner.Progress.ROTATE,
            ExploreSafeDropPlanner.progressDecision(false, true, false, false, false));
        assertEquals(ExploreSafeDropPlanner.Progress.NUDGE,
            ExploreSafeDropPlanner.progressDecision(false, true, false, false, true));
        assertEquals(ExploreSafeDropPlanner.Progress.HOLD,
            ExploreSafeDropPlanner.progressDecision(true, false, false, false, true));
        assertEquals(ExploreSafeDropPlanner.Progress.LANDED,
            ExploreSafeDropPlanner.progressDecision(true, true, true, false, true));
        assertEquals(ExploreSafeDropPlanner.Progress.REJECTED,
            ExploreSafeDropPlanner.progressDecision(true, true, false, false, true));
        assertEquals(ExploreSafeDropPlanner.Progress.TIMEOUT,
            ExploreSafeDropPlanner.progressDecision(false, true, false, true, true));
    }
}
