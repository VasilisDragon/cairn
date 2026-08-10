package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;

final class MiningWorkspaceTransaction {
    enum Workstation {
        NONE,
        TABLE,
        FURNACE
    }

    private String workspaceId = "";
    private String originalCommandId = "";
    private String originalAction = "";
    private String objectiveReason = "";
    private String travelCommandId = "";
    private VoxelCell frontier;
    private List<VoxelCell> returnRoute = List.of();
    private List<VoxelCell> resumeRoute = List.of();
    private List<VoxelCell> canonicalTrail = List.of();
    private int breadcrumbCount;
    private long workspaceSessionRevision;
    private long workspaceTrailRevision;
    private long startedAtMs;
    private boolean returned;
    private boolean resumed;
    private boolean returnRouteSuffixRepairAttempted;
    private boolean resumeRouteSuffixRepairAttempted;
    private boolean replacementSuppression;
    private String lastReusedCommandId = "";
    private String residentCommandId = "";
    private String residentAction = "";
    private String residentReason = "";
    private final MiningWorkspaceTraversalController traversal = new MiningWorkspaceTraversalController();

    boolean start(
        String nextWorkspaceId,
        String commandId,
        String action,
        String reason,
        VoxelCell nextFrontier,
        List<VoxelCell> nextReturnRoute,
        List<VoxelCell> nextResumeRoute,
        int nextBreadcrumbCount,
        boolean suppressReplacement,
        long nowMs
    ) {
        return start(
            nextWorkspaceId,
            commandId,
            action,
            reason,
            nextFrontier,
            nextReturnRoute,
            nextResumeRoute,
            nextBreadcrumbCount,
            -1L,
            -1L,
            suppressReplacement,
            nowMs
        );
    }

    boolean start(
        String nextWorkspaceId,
        String commandId,
        String action,
        String reason,
        VoxelCell nextFrontier,
        List<VoxelCell> nextReturnRoute,
        List<VoxelCell> nextResumeRoute,
        int nextBreadcrumbCount,
        long nextSessionRevision,
        long nextTrailRevision,
        boolean suppressReplacement,
        long nowMs
    ) {
        if (active()
            || nextWorkspaceId == null
            || nextWorkspaceId.isBlank()
            || commandId == null
            || commandId.isBlank()
            || nextFrontier == null
            || nextReturnRoute == null
            || nextReturnRoute.isEmpty()
            || nextResumeRoute == null
            || nextResumeRoute.isEmpty()
            || !nextReturnRoute.equals(reversed(nextResumeRoute))) {
            return false;
        }
        workspaceId = nextWorkspaceId;
        originalCommandId = commandId;
        originalAction = action == null ? "" : action;
        objectiveReason = reason == null ? "" : reason;
        travelCommandId = commandId;
        frontier = nextFrontier;
        returnRoute = List.copyOf(nextReturnRoute);
        resumeRoute = List.copyOf(nextResumeRoute);
        canonicalTrail = List.copyOf(nextResumeRoute);
        breadcrumbCount = Math.max(0, nextBreadcrumbCount);
        workspaceSessionRevision = nextSessionRevision;
        workspaceTrailRevision = nextTrailRevision;
        startedAtMs = nowMs;
        returned = false;
        resumed = false;
        returnRouteSuffixRepairAttempted = false;
        resumeRouteSuffixRepairAttempted = false;
        replacementSuppression = suppressReplacement;
        lastReusedCommandId = "";
        residentCommandId = "";
        residentAction = "";
        residentReason = "";
        boolean begun = traversal.begin(
            MiningWorkspaceTraversalController.Mode.RETURN,
            returnRoute,
            nextFrontier,
            nowMs
        );
        if (!begun) {
            clear();
        }
        return begun;
    }

    boolean beginResume(String commandId, VoxelCell feet, long nowMs) {
        if (!active()
            || !returned
            || resumed
            || traversal.active()
            || commandId == null
            || commandId.isBlank()
            || feet == null) {
            return false;
        }
        boolean begun = traversal.begin(
            MiningWorkspaceTraversalController.Mode.RESUME,
            resumeRoute,
            feet,
            nowMs
        );
        if (begun) {
            travelCommandId = commandId;
        }
        return begun;
    }

    void markReturned() {
        returned = true;
    }

    void markResumed() {
        resumed = true;
    }

    boolean markReused(String commandId) {
        String key = commandId == null ? "" : commandId;
        if (key.isBlank() || key.equals(lastReusedCommandId)) {
            return false;
        }
        lastReusedCommandId = key;
        return true;
    }

    void observeResidentCommand(String commandId, String action, String reason) {
        if (commandId == null || commandId.isBlank() || workstationFor(action) == Workstation.NONE) {
            return;
        }
        residentCommandId = commandId;
        residentAction = action;
        residentReason = reason == null ? "" : reason;
    }

    Workstation residentWorkstation(String commandId) {
        return commandId != null && commandId.equals(residentCommandId)
            ? workstationFor(residentAction)
            : Workstation.NONE;
    }

    String residentAction(String commandId) {
        return commandId != null && commandId.equals(residentCommandId) ? residentAction : "";
    }

    String residentReason(String commandId) {
        return commandId != null && commandId.equals(residentCommandId) ? residentReason : "";
    }

    boolean active() {
        return !workspaceId.isBlank();
    }

    boolean atWorkspace() {
        return active() && returned && !resumed && !traversal.active();
    }

    boolean travelActive() {
        return traversal.active();
    }

    boolean replacementSuppression() {
        return replacementSuppression;
    }

    String workspaceId() {
        return workspaceId;
    }

    String originalCommandId() {
        return originalCommandId;
    }

    String originalAction() {
        return originalAction;
    }

    String objectiveReason() {
        return objectiveReason;
    }

    boolean travelCommandMatches(String commandId) {
        return commandId != null && commandId.equals(travelCommandId);
    }

    VoxelCell frontier() {
        return frontier;
    }

    int routeLength() {
        return traversal.active()
            ? traversal.route().size()
            : (returned ? resumeRoute.size() : returnRoute.size());
    }

    int breadcrumbCount() {
        return breadcrumbCount;
    }

    List<VoxelCell> canonicalTrail() {
        return canonicalTrail;
    }

    List<VoxelCell> returnRoute() {
        return returnRoute;
    }

    List<VoxelCell> resumeRoute() {
        return resumeRoute;
    }

    long workspaceSessionRevision() {
        return workspaceSessionRevision;
    }

    long workspaceTrailRevision() {
        return workspaceTrailRevision;
    }

    boolean claimRouteSuffixRepair(MiningWorkspaceTraversalController.Mode repairMode) {
        if (!active()
            || !traversal.active()
            || traversal.mode() != repairMode
            || traversal.descentPhase() != MiningWorkspaceTraversalController.DescentPhase.NONE) {
            return false;
        }
        if (repairMode == MiningWorkspaceTraversalController.Mode.RETURN) {
            if (returnRouteSuffixRepairAttempted) {
                return false;
            }
            returnRouteSuffixRepairAttempted = true;
            return true;
        }
        if (repairMode == MiningWorkspaceTraversalController.Mode.RESUME) {
            if (resumeRouteSuffixRepairAttempted) {
                return false;
            }
            resumeRouteSuffixRepairAttempted = true;
            return true;
        }
        return false;
    }

    boolean routeSuffixRepairAttempted(MiningWorkspaceTraversalController.Mode repairMode) {
        return switch (repairMode) {
            case RETURN -> returnRouteSuffixRepairAttempted;
            case RESUME -> resumeRouteSuffixRepairAttempted;
            default -> false;
        };
    }

    boolean canApplyCanonicalRepair(
        MiningWorkspaceTraversalController.Mode repairMode,
        MiningWorkspaceTraversalController.RouteSnapshot expectedTraversal,
        long expectedSessionRevision,
        long expectedTrailRevision,
        List<VoxelCell> expectedCanonicalTrail,
        List<VoxelCell> repairedCanonicalTrail,
        long repairedTrailRevision
    ) {
        if (!active()
            || repairMode == null
            || repairMode == MiningWorkspaceTraversalController.Mode.NONE
            || traversal.mode() != repairMode
            || !routeSuffixRepairAttempted(repairMode)
            || workspaceSessionRevision != expectedSessionRevision
            || workspaceTrailRevision != expectedTrailRevision
            || expectedCanonicalTrail == null
            || !canonicalTrail.equals(expectedCanonicalTrail)
            || repairedCanonicalTrail == null
            || repairedCanonicalTrail.size() < 2
            || repairedCanonicalTrail.size() > MiningWorkspaceStore.MAX_BREADCRUMBS
            || repairedTrailRevision <= workspaceTrailRevision
            || !MiningWorkspaceTraversal.reversibleRoute(repairedCanonicalTrail)
            || !canonicalTrail.get(0).equals(repairedCanonicalTrail.get(0))
            || !canonicalTrail.get(canonicalTrail.size() - 1)
                .equals(repairedCanonicalTrail.get(repairedCanonicalTrail.size() - 1))
            || new HashSet<>(repairedCanonicalTrail).size() != repairedCanonicalTrail.size()) {
            return false;
        }
        List<VoxelCell> repairedActiveRoute = repairMode == MiningWorkspaceTraversalController.Mode.RETURN
            ? reversed(repairedCanonicalTrail)
            : List.copyOf(repairedCanonicalTrail);
        return traversal.canReplaceRoute(expectedTraversal, repairedActiveRoute);
    }

    boolean applyCanonicalRepair(
        MiningWorkspaceTraversalController.Mode repairMode,
        MiningWorkspaceTraversalController.RouteSnapshot expectedTraversal,
        long expectedSessionRevision,
        long expectedTrailRevision,
        List<VoxelCell> expectedCanonicalTrail,
        List<VoxelCell> repairedCanonicalTrail,
        long repairedTrailRevision
    ) {
        if (!canApplyCanonicalRepair(
            repairMode,
            expectedTraversal,
            expectedSessionRevision,
            expectedTrailRevision,
            expectedCanonicalTrail,
            repairedCanonicalTrail,
            repairedTrailRevision
        )) {
            return false;
        }
        applyPrevalidatedCanonicalRepair(
            repairMode,
            repairedCanonicalTrail,
            repairedTrailRevision
        );
        return true;
    }

    void applyPrevalidatedCanonicalRepair(
        MiningWorkspaceTraversalController.Mode repairMode,
        List<VoxelCell> repairedCanonicalTrail,
        long repairedTrailRevision
    ) {
        List<VoxelCell> repairedResume = List.copyOf(repairedCanonicalTrail);
        List<VoxelCell> repairedReturn = reversed(repairedResume);
        List<VoxelCell> repairedActiveRoute =
            repairMode == MiningWorkspaceTraversalController.Mode.RETURN
                ? repairedReturn
                : repairedResume;
        traversal.replacePrevalidatedRoute(repairedActiveRoute);
        canonicalTrail = repairedResume;
        resumeRoute = repairedResume;
        returnRoute = repairedReturn;
        breadcrumbCount = repairedResume.size();
        workspaceTrailRevision = repairedTrailRevision;
    }

    long elapsedMs(long nowMs) {
        return Math.max(0L, nowMs - startedAtMs);
    }

    MiningWorkspaceTraversalController traversal() {
        return traversal;
    }

    void clear() {
        workspaceId = "";
        originalCommandId = "";
        originalAction = "";
        objectiveReason = "";
        travelCommandId = "";
        frontier = null;
        returnRoute = List.of();
        resumeRoute = List.of();
        canonicalTrail = List.of();
        breadcrumbCount = 0;
        workspaceSessionRevision = 0L;
        workspaceTrailRevision = 0L;
        startedAtMs = 0L;
        returned = false;
        resumed = false;
        returnRouteSuffixRepairAttempted = false;
        resumeRouteSuffixRepairAttempted = false;
        replacementSuppression = false;
        lastReusedCommandId = "";
        residentCommandId = "";
        residentAction = "";
        residentReason = "";
        traversal.clear();
    }

    static boolean eligibleAction(String action, String reason) {
        if ("craft_stone_pickaxe".equals(action)) {
            return stoneToolRestockObjective(reason);
        }
        return miningObjective(reason) && workstationFor(action) != Workstation.NONE;
    }

    static boolean replacementAction(String action, String reason) {
        if (!miningObjective(reason) && !stoneToolRestockObjective(reason)) {
            return false;
        }
        return "craft_table".equals(action)
            || "place_table".equals(action)
            || "craft_furnace".equals(action)
            || "place_furnace".equals(action);
    }

    static boolean resumeAction(String action, String reason) {
        return "mine_nearby_iron".equals(action)
            || "mine_nearby_coal".equals(action)
            || ("descend_staircase".equals(action) && "mission:MINE_IRON_RECOVERY".equals(reason));
    }

    static boolean residentAction(String action, String reason) {
        return eligibleAction(action, reason)
            || "stop".equals(action)
            || "equip_armor".equals(action)
            || "eat".equals(action)
            || Craft2x2RecipePlanner.isCraftAction(action);
    }

    static boolean closesWithoutResume(String action, String reason) {
        return "return_staircase".equals(action)
            || ("stop".equals(action) && reason != null
                && (reason.startsWith("mission:done") || reason.startsWith("mission:aborted")));
    }

    static Workstation workstationFor(String action) {
        if ("smelt_raw_iron".equals(action)) {
            return Workstation.FURNACE;
        }
        if ("craft_iron_pickaxe".equals(action)
            || "craft_stone_pickaxe".equals(action)
            || "craft_iron_helmet".equals(action)
            || "craft_iron_chestplate".equals(action)
            || "craft_iron_leggings".equals(action)
            || "craft_iron_boots".equals(action)) {
            return Workstation.TABLE;
        }
        return Workstation.NONE;
    }

    private static boolean miningObjective(String reason) {
        return "mission:SMELT_IRON".equals(reason)
            || "mission:MAKE_FURNACE".equals(reason)
            || "mission:MAKE_IRON_TOOLS".equals(reason)
            || "mission:MAKE_ARMOR".equals(reason);
    }

    private static boolean stoneToolRestockObjective(String reason) {
        return "mission:MINE_IRON".equals(reason)
            || "mission:MAKE_STONE_TOOLS".equals(reason);
    }

    private static List<VoxelCell> reversed(List<VoxelCell> route) {
        List<VoxelCell> reversed = new ArrayList<>(route);
        java.util.Collections.reverse(reversed);
        return List.copyOf(reversed);
    }
}
