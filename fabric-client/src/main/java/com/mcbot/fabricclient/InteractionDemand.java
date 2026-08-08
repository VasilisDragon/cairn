package com.mcbot.fabricclient;

import java.util.Objects;

/**
 * Immutable code-owned request for the final, post-gaze interaction commit.
 *
 * <p>The demand carries stable identities only. Minecraft object references belong to the
 * authority payload, so cadence and acknowledgement remain deterministic and unit-testable.
 */
record InteractionDemand(
    String requestId,
    LookDemand.Owner owner,
    Action action,
    Policy policy,
    String commandId,
    String stageIdentity,
    String gestureIdentity,
    String targetIdentity,
    String toolIdentity,
    String faceIdentity,
    String reason
) {
    enum Action {
        NONE,
        BLOCK_BREAK_HOLD,
        BREAK_BLOCK,
        CANCEL_BREAK,
        ATTACK_ENTITY,
        USE_BLOCK,
        HOLD_ITEM,
        RELEASE
    }

    enum Policy {
        IDLE,
        CONTINUOUS,
        PULSE,
        HOLD,
        IMMEDIATE
    }

    InteractionDemand {
        requestId = requireText(requestId, "requestId");
        owner = Objects.requireNonNull(owner, "owner");
        action = Objects.requireNonNull(action, "action");
        policy = Objects.requireNonNull(policy, "policy");
        commandId = requireText(commandId, "commandId");
        stageIdentity = requireText(stageIdentity, "stageIdentity");
        gestureIdentity = normalized(gestureIdentity);
        targetIdentity = normalized(targetIdentity);
        toolIdentity = normalized(toolIdentity);
        faceIdentity = normalized(faceIdentity);
        reason = requireText(reason, "reason");

        switch (action) {
            case NONE -> requirePolicy(policy, Policy.IDLE, action);
            case BLOCK_BREAK_HOLD, BREAK_BLOCK -> {
                requirePolicy(policy, Policy.CONTINUOUS, action);
                requireIdentity(gestureIdentity, "gestureIdentity", action);
                requireIdentity(targetIdentity, "targetIdentity", action);
                requireIdentity(toolIdentity, "toolIdentity", action);
                requireIdentity(faceIdentity, "faceIdentity", action);
            }
            case CANCEL_BREAK -> {
                requirePolicy(policy, Policy.IMMEDIATE, action);
                requireIdentity(gestureIdentity, "gestureIdentity", action);
            }
            case ATTACK_ENTITY -> {
                requirePolicy(policy, Policy.PULSE, action);
                requireIdentity(targetIdentity, "targetIdentity", action);
            }
            case USE_BLOCK -> {
                requirePolicy(policy, Policy.PULSE, action);
                requireIdentity(targetIdentity, "targetIdentity", action);
                requireIdentity(faceIdentity, "faceIdentity", action);
            }
            case HOLD_ITEM -> {
                requirePolicy(policy, Policy.HOLD, action);
                requireIdentity(gestureIdentity, "gestureIdentity", action);
                requireIdentity(toolIdentity, "toolIdentity", action);
            }
            case RELEASE -> requirePolicy(policy, Policy.IMMEDIATE, action);
        }
    }

    static InteractionDemand idle(
        LookDemand.Owner owner,
        String commandId,
        String stageIdentity,
        String reason
    ) {
        String command = stableCommand(commandId);
        String stage = stableStage(stageIdentity);
        return new InteractionDemand(
            "idle:" + command + ":" + stage,
            owner,
            Action.NONE,
            Policy.IDLE,
            command,
            stage,
            "",
            "",
            "",
            "",
            stableReason(reason)
        );
    }

    static InteractionDemand blockBreakHold(
        String requestId,
        LookDemand.Owner owner,
        String commandId,
        String stageIdentity,
        String gestureIdentity,
        String targetIdentity,
        String toolIdentity,
        String faceIdentity,
        String reason
    ) {
        return blockDemand(
            requestId,
            owner,
            Action.BLOCK_BREAK_HOLD,
            commandId,
            stageIdentity,
            gestureIdentity,
            targetIdentity,
            toolIdentity,
            faceIdentity,
            reason
        );
    }

    static InteractionDemand breakBlock(
        String requestId,
        LookDemand.Owner owner,
        String commandId,
        String stageIdentity,
        String gestureIdentity,
        String targetIdentity,
        String toolIdentity,
        String faceIdentity,
        String reason
    ) {
        return blockDemand(
            requestId,
            owner,
            Action.BREAK_BLOCK,
            commandId,
            stageIdentity,
            gestureIdentity,
            targetIdentity,
            toolIdentity,
            faceIdentity,
            reason
        );
    }

    static InteractionDemand cancelBreak(
        String requestId,
        LookDemand.Owner owner,
        String commandId,
        String stageIdentity,
        String gestureIdentity,
        String reason
    ) {
        return new InteractionDemand(
            requestId,
            owner,
            Action.CANCEL_BREAK,
            Policy.IMMEDIATE,
            stableCommand(commandId),
            stableStage(stageIdentity),
            gestureIdentity,
            "",
            "",
            "",
            stableReason(reason)
        );
    }

    static InteractionDemand attackEntity(
        String requestId,
        LookDemand.Owner owner,
        String commandId,
        String stageIdentity,
        String targetIdentity,
        String reason
    ) {
        return pulseDemand(
            requestId,
            owner,
            Action.ATTACK_ENTITY,
            commandId,
            stageIdentity,
            targetIdentity,
            "",
            reason
        );
    }

    static InteractionDemand useBlock(
        String requestId,
        LookDemand.Owner owner,
        String commandId,
        String stageIdentity,
        String targetIdentity,
        String faceIdentity,
        String reason
    ) {
        return pulseDemand(
            requestId,
            owner,
            Action.USE_BLOCK,
            commandId,
            stageIdentity,
            targetIdentity,
            faceIdentity,
            reason
        );
    }

    static InteractionDemand holdItem(
        String requestId,
        LookDemand.Owner owner,
        String commandId,
        String stageIdentity,
        String gestureIdentity,
        String toolIdentity,
        String reason
    ) {
        return new InteractionDemand(
            requestId,
            owner,
            Action.HOLD_ITEM,
            Policy.HOLD,
            stableCommand(commandId),
            stableStage(stageIdentity),
            gestureIdentity,
            "",
            toolIdentity,
            "",
            stableReason(reason)
        );
    }

    static InteractionDemand release(
        String requestId,
        LookDemand.Owner owner,
        String commandId,
        String stageIdentity,
        String reason
    ) {
        return new InteractionDemand(
            requestId,
            owner,
            Action.RELEASE,
            Policy.IMMEDIATE,
            stableCommand(commandId),
            stableStage(stageIdentity),
            "",
            "",
            "",
            "",
            stableReason(reason)
        );
    }

    boolean isBreakOwnership() {
        return action == Action.BREAK_BLOCK || action == Action.BLOCK_BREAK_HOLD;
    }

    boolean sameLogicalGesture(InteractionDemand other) {
        return other != null
            && owner == other.owner
            && commandId.equals(other.commandId)
            && gestureIdentity.equals(other.gestureIdentity)
            && toolIdentity.equals(other.toolIdentity)
            && !gestureIdentity.isEmpty();
    }

    private static InteractionDemand blockDemand(
        String requestId,
        LookDemand.Owner owner,
        Action action,
        String commandId,
        String stageIdentity,
        String gestureIdentity,
        String targetIdentity,
        String toolIdentity,
        String faceIdentity,
        String reason
    ) {
        return new InteractionDemand(
            requestId,
            owner,
            action,
            Policy.CONTINUOUS,
            stableCommand(commandId),
            stableStage(stageIdentity),
            gestureIdentity,
            targetIdentity,
            toolIdentity,
            faceIdentity,
            stableReason(reason)
        );
    }

    private static InteractionDemand pulseDemand(
        String requestId,
        LookDemand.Owner owner,
        Action action,
        String commandId,
        String stageIdentity,
        String targetIdentity,
        String faceIdentity,
        String reason
    ) {
        return new InteractionDemand(
            requestId,
            owner,
            action,
            Policy.PULSE,
            stableCommand(commandId),
            stableStage(stageIdentity),
            "",
            targetIdentity,
            "",
            faceIdentity,
            stableReason(reason)
        );
    }

    private static void requirePolicy(Policy actual, Policy expected, Action action) {
        if (actual != expected) {
            throw new IllegalArgumentException(action + " requires policy " + expected);
        }
    }

    private static void requireIdentity(String value, String field, Action action) {
        if (value.isEmpty()) {
            throw new IllegalArgumentException(action + " requires " + field);
        }
    }

    private static String normalized(String value) {
        return value == null ? "" : value.trim();
    }

    private static String stableCommand(String value) {
        return value == null || value.isBlank() ? "uncommanded" : value;
    }

    private static String stableStage(String value) {
        return value == null || value.isBlank() ? "unstaged" : value;
    }

    private static String stableReason(String value) {
        return value == null || value.isBlank() ? "unspecified" : value;
    }

    private static String requireText(String value, String field) {
        Objects.requireNonNull(value, field);
        if (value.isBlank()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return value;
    }
}
