package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Pure admission and tool-selection policy for mission-owned iron acquisition.
 *
 * <p>The policy deliberately knows nothing about player or world state. Callers freeze a bounded
 * horizon and provide authoritative remaining durability for each eligible inventory pickaxe. This
 * keeps reserve accounting testable and prevents an executor from starting a block that would
 * consume the protected part of a required iron pickaxe.</p>
 */
final class MissionIronToolReservePolicy {
    static final int MAX_PROJECTED_LANE_BREAKS = 30;
    static final int MAX_CURRENT_COMMAND_RAW_TARGET = 8;
    static final int MAX_EXISTING_VEIN_EXTRA_ALLOWANCE = 8;
    static final int MAX_FROZEN_LANE_REQUIREMENT = 46;
    static final int MAX_REMAINING_MISSION_IRON_COUNT = 64;
    static final int MAX_RESERVED_IRON_PICKAXE_COUNT = 2;
    static final int MAX_RESERVED_IRON_PICKAXE_DURABILITY_FLOOR = 250;

    private MissionIronToolReservePolicy() {
    }

    enum ToolKind {
        STONE,
        IRON
    }

    enum Status {
        LEGACY,
        READY,
        RESTOCK_REQUIRED,
        INVALID_MISSION_INPUT
    }

    enum SelectionReason {
        LEGACY,
        CURRENT_TOOL_STABLE,
        SURPLUS_IRON,
        RESERVED_IRON_ABOVE_FLOOR,
        STONE,
        NONE
    }

    record ToolCandidate(int hotbarSlot, ToolKind kind, int remainingDurability) {
    }

    record FrozenLaneHorizon(
        int remainingProjectedLaneBreaks,
        int remainingCurrentCommandRawTarget,
        int remainingExistingVeinExtraAllowance
    ) {
        int requiredDurability() {
            if (!valid()) {
                return MAX_FROZEN_LANE_REQUIREMENT;
            }
            return remainingProjectedLaneBreaks
                + remainingCurrentCommandRawTarget
                + remainingExistingVeinExtraAllowance;
        }

        boolean valid() {
            return remainingProjectedLaneBreaks >= 0
                && remainingProjectedLaneBreaks <= MAX_PROJECTED_LANE_BREAKS
                && remainingCurrentCommandRawTarget >= 0
                && remainingCurrentCommandRawTarget <= MAX_CURRENT_COMMAND_RAW_TARGET
                && remainingExistingVeinExtraAllowance >= 0
                && remainingExistingVeinExtraAllowance <= MAX_EXISTING_VEIN_EXTRA_ALLOWANCE;
        }
    }

    record Request(
        boolean missionOwned,
        Integer remainingMissionIronCount,
        Integer reservedIronPickaxeCount,
        Integer reservedIronPickaxeDurabilityFloor,
        FrozenLaneHorizon horizon,
        List<ToolCandidate> tools,
        int currentHotbarSlot
    ) {
        Request {
            tools = tools == null ? null : List.copyOf(tools);
        }
    }

    record Assessment(
        Status status,
        int requiredDurability,
        int spendableDurability,
        int reservedIronPickaxeCount,
        int reservedIronPickaxeDurabilityFloor,
        List<Integer> reservedIronSlots,
        int selectedHotbarSlot,
        ToolKind selectedToolKind,
        SelectionReason selectionReason,
        String reason
    ) {
        Assessment {
            status = status == null ? Status.INVALID_MISSION_INPUT : status;
            requiredDurability = Math.max(0, requiredDurability);
            spendableDurability = Math.max(0, spendableDurability);
            reservedIronPickaxeCount = Math.max(0, reservedIronPickaxeCount);
            reservedIronPickaxeDurabilityFloor = Math.max(0, reservedIronPickaxeDurabilityFloor);
            reservedIronSlots = reservedIronSlots == null ? List.of() : List.copyOf(reservedIronSlots);
            selectionReason = selectionReason == null ? SelectionReason.NONE : selectionReason;
            reason = reason == null ? "" : reason;
        }

        boolean admitted() {
            return status == Status.READY;
        }

        boolean reserveAppliesTo(int hotbarSlot) {
            return reservedIronSlots.contains(hotbarSlot);
        }
    }

    static boolean applies(String commandId, String reason) {
        if (commandId == null || !commandId.startsWith("mission-")) {
            return false;
        }
        return "mission:MINE_IRON".equals(reason) || "mission:MINE_IRON_RECOVERY".equals(reason);
    }

    static Assessment assess(Request request) {
        return assess(request, null);
    }

    static Assessment assessRecovery(Request request, int remainingRecoveryDepth, int remainingEpochWork) {
        if (remainingRecoveryDepth < 0 || remainingEpochWork < 0) {
            return invalid("invalid_recovery_horizon");
        }
        FrozenLaneHorizon horizon = request == null ? null : request.horizon();
        int laneRequirement = horizon == null
            ? MAX_FROZEN_LANE_REQUIREMENT
            : Math.min(horizon.remainingProjectedLaneBreaks(), remainingEpochWork)
                + horizon.remainingCurrentCommandRawTarget()
                + horizon.remainingExistingVeinExtraAllowance();
        long recoveryAllowance = (long) remainingRecoveryDepth * 3L + 24L;
        // Recovery work is already authorized by the descent budget and must remain fully
        // funded. Only the prospective lane portion is clamped by the remaining iron epoch;
        // clamping the combined value could admit fewer tools than the recovery itself needs.
        int required = (int) Math.min(
            Integer.MAX_VALUE,
            recoveryAllowance + laneRequirement
        );
        return assess(request, required);
    }

    private static Assessment assess(Request request, Integer requiredOverride) {
        if (request == null) {
            return invalid("missing_request");
        }
        if (!request.missionOwned()) {
            return legacy();
        }
        String invalidReason = validateMissionRequest(request);
        if (invalidReason != null) {
            return invalid(invalidReason);
        }

        List<ToolCandidate> tools = new ArrayList<>(request.tools());
        int reserveCount = request.reservedIronPickaxeCount();
        int floor = request.reservedIronPickaxeDurabilityFloor();
        Set<Integer> reservedSlots = selectReservedIronSlots(tools, reserveCount);
        int required = requiredOverride == null
            ? request.horizon().requiredDurability()
            : Math.max(0, requiredOverride);
        int spendable = spendableDurability(tools, reservedSlots, floor);

        if (spendable < required) {
            return new Assessment(
                Status.RESTOCK_REQUIRED,
                required,
                spendable,
                reserveCount,
                floor,
                sortedSlots(reservedSlots),
                -1,
                null,
                SelectionReason.NONE,
                "insufficient_spendable_durability"
            );
        }

        ToolSelection selection = selectTool(tools, reservedSlots, floor, request.currentHotbarSlot());
        if (required > 0 && selection == null) {
            return new Assessment(
                Status.RESTOCK_REQUIRED,
                required,
                spendable,
                reserveCount,
                floor,
                sortedSlots(reservedSlots),
                -1,
                null,
                SelectionReason.NONE,
                "no_legal_tool"
            );
        }
        return new Assessment(
            Status.READY,
            required,
            spendable,
            reserveCount,
            floor,
            sortedSlots(reservedSlots),
            selection == null ? -1 : selection.tool().hotbarSlot(),
            selection == null ? null : selection.tool().kind(),
            selection == null ? SelectionReason.NONE : selection.reason(),
            required == 0 ? "no_durability_required" : "durability_ready"
        );
    }

    /**
     * Checks the actual block cost against the same frozen assessment used for admission.
     * A caller must re-assess after authoritative durability changes.
     */
    static boolean canStartBlock(Request request, Assessment assessment, int hotbarSlot, int durabilityCost) {
        if (request == null || assessment == null || durabilityCost <= 0) {
            return false;
        }
        if (!request.missionOwned()) {
            return assessment.status() == Status.LEGACY;
        }
        if (!assessment.admitted()) {
            return false;
        }
        ToolCandidate tool = findTool(request.tools(), hotbarSlot);
        if (tool == null || tool.remainingDurability() < durabilityCost) {
            return false;
        }
        return !assessment.reserveAppliesTo(hotbarSlot)
            || tool.remainingDurability() - durabilityCost >= assessment.reservedIronPickaxeDurabilityFloor();
    }

    private static String validateMissionRequest(Request request) {
        if (request.remainingMissionIronCount() == null
            || request.remainingMissionIronCount() < 0
            || request.remainingMissionIronCount() > MAX_REMAINING_MISSION_IRON_COUNT) {
            return "invalid_remaining_mission_iron";
        }
        if (request.reservedIronPickaxeCount() == null
            || request.reservedIronPickaxeCount() < 1
            || request.reservedIronPickaxeCount() > MAX_RESERVED_IRON_PICKAXE_COUNT) {
            return "invalid_reserved_pickaxe_count";
        }
        if (request.reservedIronPickaxeDurabilityFloor() == null
            || request.reservedIronPickaxeDurabilityFloor() < 1
            || request.reservedIronPickaxeDurabilityFloor() > MAX_RESERVED_IRON_PICKAXE_DURABILITY_FLOOR) {
            return "invalid_reserved_pickaxe_floor";
        }
        if (request.horizon() == null || !request.horizon().valid()) {
            return "invalid_frozen_lane_horizon";
        }
        if (request.tools() == null) {
            return "missing_tool_inventory";
        }
        Set<Integer> slots = new HashSet<>();
        for (ToolCandidate tool : request.tools()) {
            if (tool == null
                || tool.hotbarSlot() < 0
                || tool.hotbarSlot() > 35
                || tool.kind() == null
                || tool.remainingDurability() < 0
                || !slots.add(tool.hotbarSlot())) {
                return "invalid_tool_inventory";
            }
        }
        return null;
    }

    private static Set<Integer> selectReservedIronSlots(List<ToolCandidate> tools, int requiredCount) {
        List<ToolCandidate> iron = tools.stream()
            .filter(tool -> tool.kind() == ToolKind.IRON && tool.remainingDurability() > 0)
            .sorted(Comparator.comparingInt(ToolCandidate::remainingDurability).reversed()
                .thenComparingInt(ToolCandidate::hotbarSlot))
            .toList();
        Set<Integer> reserved = new HashSet<>();
        for (int index = 0; index < Math.min(requiredCount, iron.size()); index++) {
            reserved.add(iron.get(index).hotbarSlot());
        }
        return reserved;
    }

    private static int spendableDurability(
        List<ToolCandidate> tools,
        Set<Integer> reservedSlots,
        int floor
    ) {
        long total = 0L;
        for (ToolCandidate tool : tools) {
            if (tool.kind() == ToolKind.STONE || !reservedSlots.contains(tool.hotbarSlot())) {
                total += tool.remainingDurability();
            } else {
                total += Math.max(0, tool.remainingDurability() - floor);
            }
        }
        return (int) Math.min(Integer.MAX_VALUE, total);
    }

    private static ToolSelection selectTool(
        List<ToolCandidate> tools,
        Set<Integer> reservedSlots,
        int floor,
        int currentHotbarSlot
    ) {
        ToolCandidate current = findTool(tools, currentHotbarSlot);
        if (isLegalForOneBlock(current, reservedSlots, floor)) {
            return new ToolSelection(current, SelectionReason.CURRENT_TOOL_STABLE);
        }

        ToolCandidate surplusIron = tools.stream()
            .filter(tool -> tool.kind() == ToolKind.IRON)
            .filter(tool -> !reservedSlots.contains(tool.hotbarSlot()))
            .filter(tool -> tool.remainingDurability() > 0)
            .sorted(Comparator.comparingInt(ToolCandidate::remainingDurability)
                .thenComparingInt(ToolCandidate::hotbarSlot))
            .findFirst()
            .orElse(null);
        if (surplusIron != null) {
            return new ToolSelection(surplusIron, SelectionReason.SURPLUS_IRON);
        }

        ToolCandidate reservedIron = tools.stream()
            .filter(tool -> tool.kind() == ToolKind.IRON)
            .filter(tool -> reservedSlots.contains(tool.hotbarSlot()))
            .filter(tool -> tool.remainingDurability() > floor)
            .sorted(Comparator.comparingInt(ToolCandidate::remainingDurability).reversed()
                .thenComparingInt(ToolCandidate::hotbarSlot))
            .findFirst()
            .orElse(null);
        if (reservedIron != null) {
            return new ToolSelection(reservedIron, SelectionReason.RESERVED_IRON_ABOVE_FLOOR);
        }

        ToolCandidate stone = tools.stream()
            .filter(tool -> tool.kind() == ToolKind.STONE && tool.remainingDurability() > 0)
            .sorted(Comparator.comparingInt(ToolCandidate::remainingDurability).reversed()
                .thenComparingInt(ToolCandidate::hotbarSlot))
            .findFirst()
            .orElse(null);
        return stone == null ? null : new ToolSelection(stone, SelectionReason.STONE);
    }

    private static boolean isLegalForOneBlock(
        ToolCandidate tool,
        Set<Integer> reservedSlots,
        int floor
    ) {
        if (tool == null || tool.remainingDurability() <= 0) {
            return false;
        }
        return !reservedSlots.contains(tool.hotbarSlot()) || tool.remainingDurability() - 1 >= floor;
    }

    private static ToolCandidate findTool(List<ToolCandidate> tools, int hotbarSlot) {
        if (tools == null) {
            return null;
        }
        for (ToolCandidate tool : tools) {
            if (tool != null && tool.hotbarSlot() == hotbarSlot) {
                return tool;
            }
        }
        return null;
    }

    private static List<Integer> sortedSlots(Set<Integer> slots) {
        return slots.stream().sorted().toList();
    }

    private static Assessment legacy() {
        return new Assessment(
            Status.LEGACY,
            0,
            0,
            0,
            0,
            List.of(),
            -1,
            null,
            SelectionReason.LEGACY,
            "non_mission_legacy"
        );
    }

    private static Assessment invalid(String reason) {
        return new Assessment(
            Status.INVALID_MISSION_INPUT,
            MAX_FROZEN_LANE_REQUIREMENT,
            0,
            0,
            0,
            List.of(),
            -1,
            null,
            SelectionReason.NONE,
            reason
        );
    }

    private record ToolSelection(ToolCandidate tool, SelectionReason reason) {
    }
}
