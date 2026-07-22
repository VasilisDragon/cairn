package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.SplittableRandom;

/**
 * Deterministic block-level prospecting simulator for mining-strategy tests.
 *
 * <p>Stone is implicit inside the bounded grid; only air and ore overrides are stored. The
 * simulator now models an actual player-shaped agent: feet + head occupancy, standable support,
 * adjacent movement, and reach-limited block breaking. Strategies can observe exposed blocks but
 * can only break the subset reachable from the current standing cell.
 */
final class ProspectingSimulation {
    private ProspectingSimulation() {
    }

    static final Pos START_FEET = new Pos(0, 0, 0);
    static final double REACH_BLOCKS = 4.5D;

    enum Block {
        AIR,
        STONE,
        IRON_ORE
    }

    enum DecisionKind {
        STOP,
        BREAK,
        MOVE
    }

    record Pos(int x, int y, int z) {
        Pos offset(int dx, int dy, int dz) {
            return new Pos(x + dx, y + dy, z + dz);
        }

        List<Pos> neighbours() {
            return List.of(
                offset(1, 0, 0),
                offset(-1, 0, 0),
                offset(0, 1, 0),
                offset(0, -1, 0),
                offset(0, 0, 1),
                offset(0, 0, -1)
            );
        }
    }

    record Config(
        int minX,
        int maxX,
        int minY,
        int maxY,
        int minZ,
        int maxZ,
        int pickBudget,
        int veinCount,
        int minVeinSize,
        int maxVeinSize,
        int worldYOrigin
    ) {
        Config(
            int minX,
            int maxX,
            int minY,
            int maxY,
            int minZ,
            int maxZ,
            int pickBudget,
            int veinCount,
            int minVeinSize,
            int maxVeinSize
        ) {
            this(minX, maxX, minY, maxY, minZ, maxZ, pickBudget, veinCount, minVeinSize, maxVeinSize, 16);
        }

        Config {
            if (minX > maxX || minY > maxY || minZ > maxZ) {
                throw new IllegalArgumentException("invalid prospecting bounds");
            }
            if (pickBudget < 0 || veinCount < 0 || minVeinSize < 1 || maxVeinSize < minVeinSize) {
                throw new IllegalArgumentException("invalid prospecting config");
            }
        }

        static Config targetDepthDefaults() {
            return new Config(-10, 10, -2, 3, 0, 96, 64, 24, 1, 4, 16);
        }

        int maxActionBudget() {
            int zSpan = Math.max(1, maxZ - minZ + 1);
            return Math.max(64, pickBudget * 16 + zSpan * 8);
        }

        int worldY(Pos pos) {
            return worldYOrigin + pos.y();
        }
    }

    record Target(Pos pos, String reason) {
        Target {
            if (pos == null) {
                throw new IllegalArgumentException("target pos required");
            }
            reason = reason == null ? "" : reason;
        }
    }

    record StrategyDecision<S>(
        S state,
        DecisionKind kind,
        Optional<Target> target,
        Optional<Pos> moveTarget
    ) {
        StrategyDecision {
            kind = kind == null ? DecisionKind.STOP : kind;
            target = target == null ? Optional.empty() : target;
            moveTarget = moveTarget == null ? Optional.empty() : moveTarget;
        }

        static <S> StrategyDecision<S> stop(S state) {
            return new StrategyDecision<>(state, DecisionKind.STOP, Optional.empty(), Optional.empty());
        }

        static <S> StrategyDecision<S> breakBlock(S state, Pos pos, String reason) {
            return new StrategyDecision<>(state, DecisionKind.BREAK, Optional.of(new Target(pos, reason)), Optional.empty());
        }

        static <S> StrategyDecision<S> move(S state, Pos pos) {
            return new StrategyDecision<>(state, DecisionKind.MOVE, Optional.empty(), Optional.of(pos));
        }
    }

    interface Strategy<S> {
        S initialState();

        StrategyDecision<S> nextTarget(Snapshot snapshot, S state);
    }

    interface StrategyFactory<S> {
        Strategy<S> create(long seed);
    }

    record Snapshot(
        int blocksBroken,
        int ironFound,
        int movesMade,
        int budgetRemaining,
        Pos agentFeet,
        Map<Pos, Block> visibleBlocks,
        Map<Pos, Block> reachableBlocks,
        Set<Pos> airBlocks,
        Set<Pos> standableCells
    ) {
        Snapshot {
            visibleBlocks = Map.copyOf(visibleBlocks);
            reachableBlocks = Map.copyOf(reachableBlocks);
            airBlocks = Set.copyOf(airBlocks);
            standableCells = Set.copyOf(standableCells);
        }

        List<Pos> visibleIronSorted() {
            return visibleBlocks.entrySet().stream()
                .filter(entry -> entry.getValue() == Block.IRON_ORE)
                .map(Map.Entry::getKey)
                .sorted(POS_ORDER)
                .toList();
        }

        List<Pos> visibleStoneSorted() {
            return visibleBlocks.entrySet().stream()
                .filter(entry -> entry.getValue() == Block.STONE)
                .map(Map.Entry::getKey)
                .sorted(POS_ORDER)
                .toList();
        }

        List<Pos> reachableIronSorted() {
            return reachableBlocks.entrySet().stream()
                .filter(entry -> entry.getValue() == Block.IRON_ORE)
                .map(Map.Entry::getKey)
                .sorted(POS_ORDER)
                .toList();
        }

        List<Pos> reachableStoneSorted() {
            return reachableBlocks.entrySet().stream()
                .filter(entry -> entry.getValue() == Block.STONE)
                .map(Map.Entry::getKey)
                .sorted(POS_ORDER)
                .toList();
        }
    }

    record Step(DecisionKind kind, Pos target, Block blockBroken, String reason) {
    }

    record Result(
        int blocksBroken,
        int ironFound,
        int movesMade,
        boolean foundWithinBudget,
        boolean exhaustedBudget,
        boolean invalidAction,
        String failureReason,
        Pos finalAgentFeet,
        List<Step> steps
    ) {
        Result {
            failureReason = failureReason == null ? "" : failureReason;
            finalAgentFeet = finalAgentFeet == null ? START_FEET : finalAgentFeet;
            steps = List.copyOf(steps);
        }

        double blocksPerIron() {
            return ironFound == 0 ? Double.POSITIVE_INFINITY : (double) blocksBroken / ironFound;
        }

        double movesPerIron() {
            return ironFound == 0 ? Double.POSITIVE_INFINITY : (double) movesMade / ironFound;
        }
    }

    record Summary(
        int worlds,
        int worldsFound,
        int totalBlocksBroken,
        int totalIronFound,
        int totalMovesMade,
        int invalidWorlds
    ) {
        double foundRate() {
            return worlds == 0 ? 0.0D : (double) worldsFound / worlds;
        }

        double blocksPerIron() {
            return totalIronFound == 0 ? Double.POSITIVE_INFINITY : (double) totalBlocksBroken / totalIronFound;
        }

        double movesPerIron() {
            return totalIronFound == 0 ? Double.POSITIVE_INFINITY : (double) totalMovesMade / totalIronFound;
        }
    }

    record ProspectLeg(int originX, int originZ, int dx, int dz, int cells) {
        ProspectLeg {
            if (Math.abs(dx) + Math.abs(dz) != 1 || cells < 0) {
                throw new IllegalArgumentException("prospect leg must be cardinal and bounded");
            }
        }
    }

    record CoverageResult(int totalExposures, int uniqueExposures, int duplicateExposures, int ironFound) {
    }

    static CoverageResult corridorCoverage(World world, List<ProspectLeg> legs) {
        Set<Pos> unique = new HashSet<>();
        int total = 0;
        int iron = 0;
        for (ProspectLeg leg : legs) {
            int perpX = -leg.dz();
            int perpZ = leg.dx();
            for (int step = 1; step <= leg.cells(); step++) {
                int x = leg.originX() + leg.dx() * step;
                int z = leg.originZ() + leg.dz() * step;
                for (int offset = -2; offset <= 2; offset++) {
                    for (int y = 0; y <= 1; y++) {
                        total++;
                        Pos exposed = new Pos(x + perpX * offset, y, z + perpZ * offset);
                        if (unique.add(exposed) && world.blockAt(exposed) == Block.IRON_ORE) {
                            iron++;
                        }
                    }
                }
            }
        }
        return new CoverageResult(total, unique.size(), total - unique.size(), iron);
    }

    static final Comparator<Pos> POS_ORDER = Comparator
        .comparingInt(Pos::z)
        .thenComparingInt(Pos::y)
        .thenComparingInt(Pos::x);

    static final class World {
        private final Config config;
        private final Map<Pos, Block> overrides = new HashMap<>();

        private World(Config config) {
            this.config = config;
            carveStartCell();
        }

        static World empty(Config config) {
            return new World(config);
        }

        static World seeded(Config config, long seed) {
            World world = new World(config);
            world.seedIronVeins(seed);
            return world;
        }

        Config config() {
            return config;
        }

        int ironBlocks() {
            int count = 0;
            for (Block block : overrides.values()) {
                if (block == Block.IRON_ORE) {
                    count++;
                }
            }
            return count;
        }

        World withIron(Pos pos) {
            requireInside(pos);
            if (blockAt(pos) != Block.AIR) {
                overrides.put(pos, Block.IRON_ORE);
            }
            return this;
        }

        World withAir(Pos pos) {
            requireInside(pos);
            overrides.put(pos, Block.AIR);
            return this;
        }

        Block blockAt(Pos pos) {
            if (!inside(pos)) {
                return Block.AIR;
            }
            return overrides.getOrDefault(pos, Block.STONE);
        }

        boolean inside(Pos pos) {
            return pos.x() >= config.minX()
                && pos.x() <= config.maxX()
                && pos.y() >= config.minY()
                && pos.y() <= config.maxY()
                && pos.z() >= config.minZ()
                && pos.z() <= config.maxZ();
        }

        Snapshot snapshot(int blocksBroken, int ironFound, int movesMade, int budgetRemaining, Pos agentFeet) {
            Set<Pos> air = airBlocks();
            Set<Pos> standable = standableCells(air);
            Map<Pos, Block> visible = new HashMap<>();
            for (Pos open : air) {
                for (Pos candidate : open.neighbours()) {
                    if (!inside(candidate) || visible.containsKey(candidate)) {
                        continue;
                    }
                    Block block = blockAt(candidate);
                    if (block != Block.AIR) {
                        visible.put(candidate, block);
                    }
                }
            }
            Map<Pos, Block> reachable = new HashMap<>();
            for (Map.Entry<Pos, Block> entry : visible.entrySet()) {
                if (withinReach(agentFeet, entry.getKey())) {
                    reachable.put(entry.getKey(), entry.getValue());
                }
            }
            return new Snapshot(
                blocksBroken,
                ironFound,
                movesMade,
                budgetRemaining,
                agentFeet,
                visible,
                reachable,
                air,
                standable
            );
        }

        Block breakBlock(Pos pos) {
            requireInside(pos);
            Block block = blockAt(pos);
            if (block == Block.AIR) {
                throw new IllegalArgumentException("cannot break air at " + pos);
            }
            overrides.put(pos, Block.AIR);
            return block;
        }

        boolean isStandable(Pos feet) {
            return inside(feet)
                && inside(feet.offset(0, 1, 0))
                && inside(feet.offset(0, -1, 0))
                && blockAt(feet) == Block.AIR
                && blockAt(feet.offset(0, 1, 0)) == Block.AIR
                && blockAt(feet.offset(0, -1, 0)) != Block.AIR;
        }

        private void carveStartCell() {
            overrides.put(START_FEET, Block.AIR);
            overrides.put(START_FEET.offset(0, 1, 0), Block.AIR);
        }

        private Set<Pos> airBlocks() {
            Set<Pos> air = new HashSet<>();
            for (Map.Entry<Pos, Block> entry : overrides.entrySet()) {
                if (entry.getValue() == Block.AIR) {
                    air.add(entry.getKey());
                }
            }
            return air;
        }

        private Set<Pos> standableCells(Set<Pos> air) {
            Set<Pos> standable = new HashSet<>();
            for (Pos feet : air) {
                if (isStandable(feet)) {
                    standable.add(feet);
                }
            }
            return standable;
        }

        private void seedIronVeins(long seed) {
            SplittableRandom random = new SplittableRandom(seed);
            for (int veinAttempt = 0; veinAttempt < config.veinCount(); veinAttempt++) {
                Optional<Pos> maybeCursor = randomWeightedStonePos(random);
                if (maybeCursor.isEmpty()) {
                    continue;
                }
                Pos cursor = maybeCursor.get();
                int size = config.minVeinSize() + random.nextInt(config.maxVeinSize() - config.minVeinSize() + 1);
                for (int i = 0; i < size; i++) {
                    if (inside(cursor) && blockAt(cursor) != Block.AIR) {
                        overrides.put(cursor, Block.IRON_ORE);
                    }
                    List<Pos> candidates = cursor.neighbours().stream()
                        .filter(this::inside)
                        .filter(pos -> blockAt(pos) != Block.AIR)
                        .toList();
                    if (candidates.isEmpty()) {
                        break;
                    }
                    cursor = candidates.get(random.nextInt(candidates.size()));
                }
            }
        }

        private Optional<Pos> randomWeightedStonePos(SplittableRandom random) {
            for (int tries = 0; tries < 200; tries++) {
                Pos pos = new Pos(
                    config.minX() + random.nextInt(config.maxX() - config.minX() + 1),
                    config.minY() + random.nextInt(config.maxY() - config.minY() + 1),
                    Math.max(1, config.minZ()) + random.nextInt(config.maxZ() - Math.max(1, config.minZ()) + 1)
                );
                if (blockAt(pos) == Block.STONE) {
                    double density = ironDensityWeight(config.worldY(pos));
                    return density > 0.0D && random.nextDouble() <= density ? Optional.of(pos) : Optional.empty();
                }
            }
            return Optional.empty();
        }

        private void requireInside(Pos pos) {
            if (!inside(pos)) {
                throw new IllegalArgumentException("position outside prospecting world: " + pos);
            }
        }
    }

    static <S> Result run(World world, Strategy<S> strategy) {
        int blocksBroken = 0;
        int ironFound = 0;
        int movesMade = 0;
        int actions = 0;
        Pos agentFeet = START_FEET;
        S state = strategy.initialState();
        List<Step> steps = new ArrayList<>();
        if (!world.isStandable(agentFeet)) {
            return invalidResult(blocksBroken, ironFound, movesMade, agentFeet, steps, "start_not_standable");
        }
        while (blocksBroken < world.config().pickBudget() && actions < world.config().maxActionBudget()) {
            Snapshot snapshot = world.snapshot(
                blocksBroken,
                ironFound,
                movesMade,
                world.config().pickBudget() - blocksBroken,
                agentFeet
            );
            StrategyDecision<S> decision = strategy.nextTarget(snapshot, state);
            state = decision.state();
            if (decision.kind() == DecisionKind.STOP) {
                return new Result(blocksBroken, ironFound, movesMade, ironFound > 0, false, false, "", agentFeet, steps);
            }
            actions++;
            if (decision.kind() == DecisionKind.MOVE) {
                Optional<Pos> moveTarget = decision.moveTarget();
                if (moveTarget.isEmpty()) {
                    return invalidResult(blocksBroken, ironFound, movesMade, agentFeet, steps, "missing_move_target");
                }
                Pos target = moveTarget.get();
                if (!adjacent(agentFeet, target)) {
                    return invalidResult(blocksBroken, ironFound, movesMade, agentFeet, steps, "move_not_adjacent:" + target);
                }
                if (!world.isStandable(target)) {
                    return invalidResult(blocksBroken, ironFound, movesMade, agentFeet, steps, "move_not_standable:" + target);
                }
                agentFeet = target;
                movesMade++;
                steps.add(new Step(DecisionKind.MOVE, target, null, "move"));
                continue;
            }

            Optional<Target> maybeTarget = decision.target();
            if (maybeTarget.isEmpty()) {
                return invalidResult(blocksBroken, ironFound, movesMade, agentFeet, steps, "missing_break_target");
            }
            Target target = maybeTarget.get();
            if (!snapshot.visibleBlocks().containsKey(target.pos())) {
                return invalidResult(blocksBroken, ironFound, movesMade, agentFeet, steps, "break_not_visible:" + target.pos());
            }
            if (!snapshot.reachableBlocks().containsKey(target.pos())) {
                return invalidResult(blocksBroken, ironFound, movesMade, agentFeet, steps, "break_out_of_reach:" + target.pos());
            }
            Block block = world.breakBlock(target.pos());
            blocksBroken++;
            if (block == Block.IRON_ORE) {
                ironFound++;
            }
            steps.add(new Step(DecisionKind.BREAK, target.pos(), block, target.reason()));
        }
        if (blocksBroken >= world.config().pickBudget()) {
            return new Result(blocksBroken, ironFound, movesMade, ironFound > 0, true, false, "", agentFeet, steps);
        }
        return invalidResult(blocksBroken, ironFound, movesMade, agentFeet, steps, "action_budget_exhausted");
    }

    static <S> Summary runAcrossSeeds(Config config, long firstSeed, int seedCount, StrategyFactory<S> factory) {
        int worldsFound = 0;
        int totalBlocksBroken = 0;
        int totalIronFound = 0;
        int totalMovesMade = 0;
        int invalidWorlds = 0;
        for (int i = 0; i < seedCount; i++) {
            long seed = firstSeed + i;
            Result result = run(World.seeded(config, seed), factory.create(seed));
            if (result.foundWithinBudget()) {
                worldsFound++;
            }
            if (result.invalidAction()) {
                invalidWorlds++;
            }
            totalBlocksBroken += result.blocksBroken();
            totalIronFound += result.ironFound();
            totalMovesMade += result.movesMade();
        }
        return new Summary(seedCount, worldsFound, totalBlocksBroken, totalIronFound, totalMovesMade, invalidWorlds);
    }

    static boolean withinReach(Pos agentFeet, Pos target) {
        double dx = target.x() - agentFeet.x();
        double dy = (target.y() + 0.5D) - (agentFeet.y() + 1.6D);
        double dz = target.z() - agentFeet.z();
        return Math.sqrt(dx * dx + dy * dy + dz * dz) <= REACH_BLOCKS;
    }

    static double ironDensityWeight(int worldY) {
        if (worldY < -64 || worldY > 72) {
            return 0.0D;
        }
        double primary = Math.max(0.0D, 1.0D - Math.abs(worldY - 16.0D) / 56.0D);
        double deepslate = Math.max(0.0D, 1.0D - Math.abs(worldY + 16.0D) / 32.0D) * 0.35D;
        double shoulder = Math.max(0.0D, 1.0D - Math.abs(worldY - 48.0D) / 48.0D) * 0.12D;
        return Math.min(0.42D, 0.02D + 0.32D * primary + 0.16D * deepslate + shoulder);
    }

    private static Result invalidResult(
        int blocksBroken,
        int ironFound,
        int movesMade,
        Pos agentFeet,
        List<Step> steps,
        String reason
    ) {
        return new Result(blocksBroken, ironFound, movesMade, ironFound > 0, false, true, reason, agentFeet, steps);
    }

    private static boolean adjacent(Pos a, Pos b) {
        int distance = Math.abs(a.x() - b.x()) + Math.abs(a.y() - b.y()) + Math.abs(a.z() - b.z());
        return distance == 1;
    }
}
