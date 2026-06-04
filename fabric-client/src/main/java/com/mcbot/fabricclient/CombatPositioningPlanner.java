package com.mcbot.fabricclient;

final class CombatPositioningPlanner {
    private CombatPositioningPlanner() {
    }

    enum Hint {
        NONE,
        STRAFE_LEFT,
        STRAFE_RIGHT,
        BACK_UP
    }

    record SurroundingThreats(int front, int left, int right, int behind) {
    }

    static Hint decide(SurroundingThreats threats) {
        if (threats == null) {
            return Hint.NONE;
        }
        if (threats.left() > threats.right()) {
            return Hint.STRAFE_RIGHT;
        }
        if (threats.right() > threats.left()) {
            return Hint.STRAFE_LEFT;
        }
        if (threats.front() > 0 && threats.behind() == 0) {
            return Hint.BACK_UP;
        }
        return Hint.NONE;
    }
}
