package com.mcbot.fabricclient;

final class BoxedEscapePlanner {
    private BoxedEscapePlanner() {
    }

    enum Action {
        FOLLOW_ROUTE,
        WAIT,
        LOGOUT
    }

    static Action decide(boolean escapeGoalAvailable, boolean routeAvailable, long fleeElapsedMs, long logoutGraceMs) {
        if (escapeGoalAvailable && routeAvailable) {
            return Action.FOLLOW_ROUTE;
        }
        return fleeElapsedMs >= logoutGraceMs ? Action.LOGOUT : Action.WAIT;
    }
}
