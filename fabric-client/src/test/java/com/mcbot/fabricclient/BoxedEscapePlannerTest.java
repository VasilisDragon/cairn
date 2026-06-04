package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class BoxedEscapePlannerTest {
    @Test
    void followsRouteWhenEscapeGoalAndRouteExist() {
        assertEquals(BoxedEscapePlanner.Action.FOLLOW_ROUTE, BoxedEscapePlanner.decide(true, true, 0L, 12_000L));
    }

    @Test
    void waitsBeforeLogoutGraceWhenNoEscapeGoalExists() {
        assertEquals(BoxedEscapePlanner.Action.WAIT, BoxedEscapePlanner.decide(false, false, 2_000L, 12_000L));
    }

    @Test
    void logsOutWhenNoEscapeGoalPersistsPastGrace() {
        assertEquals(BoxedEscapePlanner.Action.LOGOUT, BoxedEscapePlanner.decide(false, false, 12_000L, 12_000L));
    }

    @Test
    void waitsBeforeLogoutGraceWhenGoalHasNoUsableRoute() {
        assertEquals(BoxedEscapePlanner.Action.WAIT, BoxedEscapePlanner.decide(true, false, 2_000L, 12_000L));
    }

    @Test
    void logsOutWhenGoalHasNoUsableRoutePastGrace() {
        assertEquals(BoxedEscapePlanner.Action.LOGOUT, BoxedEscapePlanner.decide(true, false, 12_000L, 12_000L));
    }
}
