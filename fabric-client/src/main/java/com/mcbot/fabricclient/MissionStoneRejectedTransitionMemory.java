package com.mcbot.fabricclient;

import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.util.math.BlockPos;

/**
 * Remembers physically rejected mission-stone transitions for one canonical shaft scope.
 *
 * <p>The memory is intentionally independent of command and trail revisions. A directed
 * transition that proved unreplayable remains suppressed while ordinary command replacement or
 * trail recording changes around it. Before the first verified shaft landing, provisional
 * one-cell surface-trail sessions share a world/dimension scope so command cleanup cannot revive a
 * rejected edge. Once the shaft activates, its actual surface-trail session is the isolation
 * boundary.</p>
 */
final class MissionStoneRejectedTransitionMemory {
    static final int MAX_REJECTED_TRANSITIONS = 64;
    /**
     * Stable world/dimension scope used before a mission-stone landing has activated a canonical
     * shaft session. Starting and then discarding a provisional one-cell surface trail must not
     * make a physically rejected edge eligible again on the next command.
     */
    static final long PRE_ACTIVATION_SESSION = -1L;

    enum RecordResult {
        RECORDED,
        ALREADY_RECORDED,
        INVALID
    }

    record Context(
        String worldIdentity,
        String dimensionIdentity,
        long surfaceTrailSessionRevision
    ) {
        Context {
            worldIdentity = normalize(worldIdentity);
            dimensionIdentity = normalize(dimensionIdentity);
        }

        boolean valid() {
            return !worldIdentity.isBlank()
                && !dimensionIdentity.isBlank()
                && surfaceTrailSessionRevision >= PRE_ACTIVATION_SESSION;
        }
    }

    record Signature(
        String worldIdentity,
        String dimensionIdentity,
        long surfaceTrailSessionRevision,
        VoxelCell origin,
        VoxelCell landing
    ) {
        Signature(Context context, VoxelCell origin, VoxelCell landing) {
            this(
                context.worldIdentity(),
                context.dimensionIdentity(),
                context.surfaceTrailSessionRevision(),
                origin,
                landing
            );
        }
    }

    private final Set<Signature> rejected = new LinkedHashSet<>();
    private Context context = new Context("", "", -1L);

    /**
     * Observes the lifecycle boundary that owns subsequent transition rejections.
     *
     * @return {@code true} when the boundary changed and retained transitions were cleared
     */
    boolean observeContext(
        String worldIdentity,
        String dimensionIdentity,
        long surfaceTrailSessionRevision
    ) {
        Context next = new Context(
            worldIdentity,
            dimensionIdentity,
            surfaceTrailSessionRevision
        );
        if (context.equals(next)) {
            return false;
        }
        context = next;
        rejected.clear();
        return true;
    }

    /**
     * Records one directed transition after the caller has proved a physical transition failure.
     * Duplicate observations are idempotent and do not refresh FIFO age.
     */
    RecordResult recordPhysicalRejection(VoxelCell origin, VoxelCell landing) {
        Signature signature = signature(origin, landing);
        if (signature == null) {
            return RecordResult.INVALID;
        }
        if (rejected.contains(signature)) {
            return RecordResult.ALREADY_RECORDED;
        }
        if (rejected.size() == MAX_REJECTED_TRANSITIONS) {
            Iterator<Signature> oldest = rejected.iterator();
            oldest.next();
            oldest.remove();
        }
        rejected.add(signature);
        return RecordResult.RECORDED;
    }

    boolean contains(VoxelCell origin, VoxelCell landing) {
        Signature signature = signature(origin, landing);
        return signature != null && rejected.contains(signature);
    }

    boolean suppressesSafeDrop(VoxelCell origin, VoxelCell landing) {
        return contains(origin, landing);
    }

    StaircaseDescentPlanner.Step firstRejectedExecutableStep(
        List<StaircaseDescentPlanner.Step> executableSteps
    ) {
        if (executableSteps == null) {
            return null;
        }
        for (StaircaseDescentPlanner.Step step : executableSteps) {
            if (step != null && contains(
                voxel(step.currentFeet()),
                voxel(step.nextFeet())
            )) {
                return step;
            }
        }
        return null;
    }

    int retainedTransitionCount() {
        return rejected.size();
    }

    Context context() {
        return context;
    }

    private Signature signature(VoxelCell origin, VoxelCell landing) {
        if (
            !context.valid()
                || origin == null
                || landing == null
                || origin.equals(landing)
        ) {
            return null;
        }
        return new Signature(context, origin, landing);
    }

    private static VoxelCell voxel(BlockPos cell) {
        return cell == null
            ? null
            : new VoxelCell(cell.getX(), cell.getY(), cell.getZ());
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim();
    }
}
