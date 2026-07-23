package com.mcbot.fabricclient;

/**
 * Pure survivability rules for the descent's controlled safe-fall (drop {@code <= MAX_SAFE_DROP} to a
 * validated floor instead of refusing "no safe way down"). Shared by live block sampling
 * ({@code DescentExecutor.canSafeFallFromStall}) and offline tests.
 *
 * <p>The world-coupled caller samples each cell of a candidate drop into the booleans below and asks
 * {@link #isPhysicallySafeLanding} whether that single landing is physically committable (clear drop
 * column, solid floor, air feet + head, no hazard, not a boxed pit). On top of that it applies ONE of
 * two depth/damage gates: {@link #isSurvivableLanding} for a zero-fall-damage shallow drop
 * ({@code fallBlocks <= MAX_SAFE_DROP = 3}), or {@link #isHealthSurvivableFall} for a deeper
 * HEALTH-AWARE fall that accepts survivable {@link #fallDamage} when no zero-damage landing exists.
 *
 * <p>The shallow path guarantees zero fall damage structurally. The health-aware path instead commits a
 * damage-taking drop only when it leaves a health margin after landing, and the descent's health
 * preflight is told to tolerate exactly that expected fall damage (see {@code DescentExecutor}), so the
 * deliberate drop is not mistaken for a mob hit.
 */
public final class SafeFallPlanner {

    private SafeFallPlanner() {
    }

    /** Vanilla zero-fall-damage threshold: a drop of this many blocks or fewer deals no damage. */
    public static final int VANILLA_SAFE_FALL_BLOCKS = 3;

    /**
     * Whether a single candidate landing {@code fallBlocks} below the bot's current feet is a
     * committable safe-fall target.
     *
     * @param fallBlocks    true vertical distance (blocks) from the bot's current feet to the landing
     *                      feet cell; must be {@code 1 <= fallBlocks <= maxSafeFall}.
     * @param maxSafeFall   the zero-fall-damage cap ({@code WalkabilityClassifier.MAX_SAFE_DROP}).
     * @param columnClear   every intermediate cell from the rejected next-feet cell down to (and
     *                      including) the landing feet cell is air / non-collidable AND non-hazard
     *                      (no solid/partial block and no mid-column lava/fire/cactus to clip through).
     * @param floorSolid    the cell directly below the landing feet is a solid, non-hazard floor
     *                      (a stable descent support).
     * @param feetAir       the landing feet cell is air / non-collidable.
     * @param headAir       the cell above the landing feet (head room) is air / non-collidable.
     * @param landingHazard a hazard occupies the landing feet or head cell.
     * @param adjacentLava  lava is directly adjacent (any of 6 faces) to the landing feet cell.
     * @param boxedPit      the landing is a fully boxed pit: for ALL 4 horizontal directions BOTH the
     *                      feet-level and head-level neighbour are solid, so the bot could not step or
     *                      climb out (a no-worse-trap; reject).
     */
    public static boolean isSurvivableLanding(
        int fallBlocks,
        int maxSafeFall,
        boolean columnClear,
        boolean floorSolid,
        boolean feetAir,
        boolean headAir,
        boolean landingHazard,
        boolean adjacentLava,
        boolean boxedPit
    ) {
        if (fallBlocks < 1 || fallBlocks > maxSafeFall) {
            return false;
        }
        return isPhysicallySafeLanding(
            columnClear, floorSolid, feetAir, headAir, landingHazard, adjacentLava, boxedPit);
    }

    /**
     * The fall-distance-independent physical conditions for a committable landing: clear drop column,
     * solid non-hazard floor, air feet + head, no landing hazard / adjacent lava, and not a fully boxed
     * pit. Shared by {@link #isSurvivableLanding} (the zero-damage shallow drop) and the health-aware
     * deep fall, which layers its own depth + survivable-damage gate ({@link #isHealthSurvivableFall})
     * on top of these same physical checks.
     */
    public static boolean isPhysicallySafeLanding(
        boolean columnClear,
        boolean floorSolid,
        boolean feetAir,
        boolean headAir,
        boolean landingHazard,
        boolean adjacentLava,
        boolean boxedPit
    ) {
        if (!columnClear) {
            return false;
        }
        if (!floorSolid || !feetAir || !headAir) {
            return false;
        }
        if (landingHazard || adjacentLava) {
            return false;
        }
        return !boxedPit;
    }

    /**
     * Vanilla fall damage (health points, 1 = half a heart) for a drop of {@code fallBlocks}: the first
     * {@link #VANILLA_SAFE_FALL_BLOCKS} blocks are free, each block beyond deals one. Never negative.
     */
    public static int fallDamage(int fallBlocks) {
        return Math.max(0, fallBlocks - VANILLA_SAFE_FALL_BLOCKS);
    }

    /**
     * Whether a drop of {@code fallBlocks} is a committable HEALTH-AWARE fall: within the deep-fall cap
     * {@code maxHealthFall}, and its {@link #fallDamage} leaves at least {@code healthMargin} health after
     * landing ({@code fallDamage <= currentHealth - healthMargin}). Independent of the physical checks in
     * {@link #isPhysicallySafeLanding}, which the caller still requires. Zero-damage drops
     * ({@code fallBlocks <= VANILLA_SAFE_FALL_BLOCKS}) pass whenever {@code currentHealth >= healthMargin}.
     */
    public static boolean isHealthSurvivableFall(
        int fallBlocks,
        int maxHealthFall,
        float currentHealth,
        float healthMargin
    ) {
        if (fallBlocks < 1 || fallBlocks > maxHealthFall) {
            return false;
        }
        return fallDamage(fallBlocks) <= currentHealth - healthMargin;
    }

    /** The progress action for an in-progress controlled safe-fall (see {@link #safeFallInProgressDecision}). */
    public enum SafeFallProgress { REANCHOR, TIMEOUT_FAIL, NUDGE_OFF_LEDGE, HOLD_AIM }

    /**
     * The action for an in-progress controlled safe-fall, in strict priority: a confirmed landing
     * re-anchors the descent; otherwise a launch that overran its time budget fails out; otherwise the
     * bot nudges forward off the ledge once it is facing the drop column ({@code facingColumn}), and
     * until then merely holds the aim, so it never walks the wrong way while the head is still slewing.
     */
    public static SafeFallProgress safeFallInProgressDecision(boolean landed, boolean timedOut, boolean facingColumn) {
        if (landed) {
            return SafeFallProgress.REANCHOR;
        }
        if (timedOut) {
            return SafeFallProgress.TIMEOUT_FAIL;
        }
        return facingColumn ? SafeFallProgress.NUDGE_OFF_LEDGE : SafeFallProgress.HOLD_AIM;
    }

    /**
     * Whether a landing is a fully boxed pit given the four horizontal neighbour pairs (feet-level and
     * head-level solidity per cardinal direction). Boxed iff every direction is walled at BOTH levels.
     *
     * <p>{@code feetLevelSolid} / {@code headLevelSolid} are indexed in the same cardinal order; the
     * arrays must be length 4. A {@code null}/short array is treated as not-boxed (caller passed no
     * neighbour data, so we do not invent a trap).
     */
    public static boolean isBoxedPit(boolean[] feetLevelSolid, boolean[] headLevelSolid) {
        if (feetLevelSolid == null || headLevelSolid == null
            || feetLevelSolid.length != 4 || headLevelSolid.length != 4) {
            return false;
        }
        for (int dir = 0; dir < 4; dir++) {
            if (!feetLevelSolid[dir] || !headLevelSolid[dir]) {
                // At least one direction has an open step or climb-out at some level -> not boxed.
                return false;
            }
        }
        return true;
    }
}
