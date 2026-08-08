package com.mcbot.fabricclient;

final class GatherTreeLivenessPolicy {
    static final long BREAK_STANCE_DEADLINE_MS = 45_000L;
    static final long COMMAND_DEADLINE_MS = 180_000L;

    private GatherTreeLivenessPolicy() {
    }

    static BreakStanceEpisode beginBreakStanceEpisode(long startedAtMs) {
        return new BreakStanceEpisode(new Deadline(startedAtMs, BREAK_STANCE_DEADLINE_MS));
    }

    static CommandDeadline fromCommandStart(long startedAtMs) {
        return new CommandDeadline(new Deadline(startedAtMs, COMMAND_DEADLINE_MS));
    }

    static boolean commandChanged(String activeCommandId, String incomingCommandId) {
        if (activeCommandId == null) {
            return false;
        }
        return !activeCommandId.equals(incomingCommandId == null ? "" : incomingCommandId);
    }

    static boolean shouldEnforceCommandDeadline(
        boolean gatherTreeIntent,
        boolean sameWorld,
        String activeCommandId,
        String incomingCommandId,
        CommandDeadline deadline,
        long nowMs
    ) {
        return gatherTreeIntent
            && sameWorld
            && !commandChanged(activeCommandId, incomingCommandId)
            && deadline != null
            && deadline.expiredAt(nowMs);
    }

    static final class BreakStanceEpisode {
        private final Deadline deadline;

        private BreakStanceEpisode(Deadline deadline) {
            this.deadline = deadline;
        }

        long startedAtMs() {
            return deadline.startedAtMs();
        }

        long deadlineAtMs() {
            return deadline.deadlineAtMs();
        }

        long elapsedMs(long nowMs) {
            return deadline.elapsedMs(nowMs);
        }

        long remainingMs(long nowMs) {
            return deadline.remainingMs(nowMs);
        }

        boolean expiredAt(long nowMs) {
            return deadline.expiredAt(nowMs);
        }

        BreakStanceEpisode afterReplan() {
            return this;
        }
    }

    static final class CommandDeadline {
        private final Deadline deadline;

        private CommandDeadline(Deadline deadline) {
            this.deadline = deadline;
        }

        long startedAtMs() {
            return deadline.startedAtMs();
        }

        long deadlineAtMs() {
            return deadline.deadlineAtMs();
        }

        long elapsedMs(long nowMs) {
            return deadline.elapsedMs(nowMs);
        }

        long remainingMs(long nowMs) {
            return deadline.remainingMs(nowMs);
        }

        boolean expiredAt(long nowMs) {
            return deadline.expiredAt(nowMs);
        }
    }

    private record Deadline(long startedAtMs, long deadlineAtMs, long limitMs) {
        private Deadline(long startedAtMs, long limitMs) {
            this(startedAtMs, saturatingAdd(startedAtMs, limitMs), limitMs);
            if (limitMs <= 0L) {
                throw new IllegalArgumentException("limitMs must be positive");
            }
        }

        long elapsedMs(long nowMs) {
            if (nowMs <= startedAtMs) {
                return 0L;
            }
            long elapsed = nowMs - startedAtMs;
            return elapsed < 0L ? Long.MAX_VALUE : elapsed;
        }

        long remainingMs(long nowMs) {
            return Math.max(0L, limitMs - Math.min(limitMs, elapsedMs(nowMs)));
        }

        boolean expiredAt(long nowMs) {
            return elapsedMs(nowMs) >= limitMs;
        }
    }

    private static long saturatingAdd(long value, long increment) {
        return value > Long.MAX_VALUE - increment ? Long.MAX_VALUE : value + increment;
    }
}
