package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;

/** Deterministic randomized obstacle hardening runner for offline navigation. */
public final class NavHardeningBatch {
    public static final double ARRIVE_EPSILON = 0.25D;
    public static final double MAX_TURN_DEG_PER_TICK = 30.0D;
    public static final double SPEED_PER_TICK = 0.2D;

    private NavHardeningBatch() {
    }

    public record Scenario(
        String kind,
        int width,
        int height,
        Set<GridCell> blocked,
        Map<GridCell, Integer> surfaceHeights,
        GridCell start,
        GridCell goal,
        double startYaw
    ) {
        public Scenario {
            blocked = Set.copyOf(blocked);
            surfaceHeights = Map.copyOf(surfaceHeights == null ? Map.of() : surfaceHeights);
        }

        public Scenario(
            String kind,
            int width,
            int height,
            Set<GridCell> blocked,
            GridCell start,
            GridCell goal,
            double startYaw
        ) {
            this(kind, width, height, blocked, Map.of(), start, goal, startYaw);
        }
    }

    public record ScenarioResult(
        Scenario scenario,
        boolean solvable,
        boolean arrived,
        int ticks,
        double finalDistance,
        int pathLength,
        String failure
    ) {
    }

    public record RoundResult(long seed, int requested, int solvable, int arrived, List<ScenarioResult> failures) {
        public RoundResult {
            failures = List.copyOf(failures);
        }

        public double successRate() {
            return solvable == 0 ? 1.0D : (double) arrived / (double) solvable;
        }

        public String summary() {
            return "seed=" + seed
                + " requested=" + requested
                + " solvable=" + solvable
                + " arrived=" + arrived
                + " successRate=" + String.format(java.util.Locale.ROOT, "%.3f", successRate())
                + " failures=" + failures.size();
        }
    }

    public static RoundResult runRound(long seed, int scenarioCount) {
        Random random = new Random(seed);
        int solvable = 0;
        int arrived = 0;
        List<ScenarioResult> failures = new ArrayList<>();

        for (int i = 0; i < scenarioCount; i++) {
            Scenario scenario = generateScenario(random, i);
            ScenarioResult result = runScenario(scenario);
            if (!result.solvable()) {
                continue;
            }
            solvable++;
            if (result.arrived()) {
                arrived++;
            } else {
                failures.add(result);
            }
        }

        return new RoundResult(seed, scenarioCount, solvable, arrived, failures);
    }

    public static ScenarioResult runScenario(Scenario scenario) {
        KinematicSim perception = new KinematicSim(
            PathFollower.center(scenario.start().x()),
            PathFollower.center(scenario.start().z()),
            scenario.startYaw(),
            SPEED_PER_TICK,
            scenario.blocked(),
            scenario.surfaceHeights(),
            0,
            scenario.width() - 1,
            0,
            scenario.height() - 1
        );
        GridRouteDiagnostic diagnostic = GridAStar.diagnose(perception, scenario.start(), scenario.goal());
        if (!diagnostic.routeFound()) {
            return new ScenarioResult(
                scenario,
                false,
                false,
                0,
                Double.NaN,
                0,
                diagnostic.failureReason().isBlank() ? "unsolvable" : diagnostic.failureReason()
            );
        }

        PerceptionBackedPathFollowerSim.Result result = PerceptionBackedPathFollowerSim.followRoute(
            perception,
            diagnostic.route(),
            PathFollower.center(scenario.start().x()),
            PathFollower.center(scenario.start().z()),
            scenario.startYaw(),
            ARRIVE_EPSILON,
            MAX_TURN_DEG_PER_TICK,
            new PerceptionBackedPathFollowerSim.Config(
                SPEED_PER_TICK,
                PerceptionBackedPathFollowerSim.DEFAULT_PLAYER_RADIUS,
                Math.max(300, diagnostic.routeLength() * 80),
                false
            )
        );
        return new ScenarioResult(
            scenario,
            true,
            result.arrived(),
            result.ticks(),
            result.finalDistance(),
            diagnostic.routeLength(),
            result.arrived() ? "" : result.reason()
        );
    }

    public static List<ScenarioResult> runFailureShapeBaselines() {
        return List.of(
            runScenario(unstandableTargetShape()),
            runScenario(shallowScanDugPitShape()),
            runScenario(stepUpCorridorShape())
        );
    }

    static Scenario generateScenario(Random random, int index) {
        int width = 8 + random.nextInt(11);
        int height = 8 + random.nextInt(11);
        Set<GridCell> blocked = new HashSet<>();
        String kind = switch (index % 4) {
            case 0 -> {
                addWallsWithGaps(random, blocked, width, height);
                yield "walls";
            }
            case 1 -> {
                addSimpleMaze(random, blocked, width, height);
                yield "maze";
            }
            case 2 -> {
                addDeadEnds(random, blocked, width, height);
                yield "dead_ends";
            }
            default -> {
                addRandomScatter(random, blocked, width, height, 0.14D);
                yield "scatter";
            }
        };

        GridCell start = randomOpenCell(random, width, height, blocked, null);
        GridCell goal = randomOpenCell(random, width, height, blocked, start);
        double startYaw = LookController.normalizeYaw(random.nextDouble(-180.0D, 180.0D));
        return new Scenario(kind, width, height, blocked, start, goal, startYaw);
    }

    static Scenario unstandableTargetShape() {
        return new Scenario(
            "unstandable_target",
            5,
            5,
            Set.of(new GridCell(4, 2)),
            new GridCell(0, 2),
            new GridCell(4, 2),
            0.0D
        );
    }

    static Scenario shallowScanDugPitShape() {
        Set<GridCell> blocked = new HashSet<>();
        for (int z = 0; z <= 2; z++) {
            blocked.add(new GridCell(2, z));
        }
        return new Scenario(
            "shallow_scan_dug_pit",
            5,
            3,
            blocked,
            new GridCell(0, 1),
            new GridCell(4, 1),
            0.0D
        );
    }

    static Scenario stepUpCorridorShape() {
        Map<GridCell, Integer> heights = new HashMap<>();
        heights.put(new GridCell(0, 0), 64);
        heights.put(new GridCell(1, 0), 65);
        heights.put(new GridCell(2, 0), 65);
        heights.put(new GridCell(3, 0), 65);
        return new Scenario(
            "step_up_corridor",
            4,
            1,
            Set.of(),
            heights,
            new GridCell(0, 0),
            new GridCell(3, 0),
            -90.0D
        );
    }

    private static void addWallsWithGaps(Random random, Set<GridCell> blocked, int width, int height) {
        int wallCount = 1 + random.nextInt(3);
        for (int i = 0; i < wallCount; i++) {
            boolean vertical = random.nextBoolean();
            if (vertical) {
                int x = 1 + random.nextInt(Math.max(1, width - 2));
                int gap = random.nextInt(height);
                for (int z = 0; z < height; z++) {
                    if (z != gap) {
                        blocked.add(new GridCell(x, z));
                    }
                }
            } else {
                int z = 1 + random.nextInt(Math.max(1, height - 2));
                int gap = random.nextInt(width);
                for (int x = 0; x < width; x++) {
                    if (x != gap) {
                        blocked.add(new GridCell(x, z));
                    }
                }
            }
        }
    }

    private static void addSimpleMaze(Random random, Set<GridCell> blocked, int width, int height) {
        for (int x = 2; x < width - 1; x += 2) {
            int gap = random.nextInt(height);
            for (int z = 0; z < height; z++) {
                if (z != gap) {
                    blocked.add(new GridCell(x, z));
                }
            }
        }
        addRandomScatter(random, blocked, width, height, 0.04D);
    }

    private static void addDeadEnds(Random random, Set<GridCell> blocked, int width, int height) {
        int chambers = 2 + random.nextInt(4);
        for (int i = 0; i < chambers; i++) {
            int left = random.nextInt(Math.max(1, width - 3));
            int top = random.nextInt(Math.max(1, height - 3));
            int right = Math.min(width - 1, left + 2 + random.nextInt(3));
            int bottom = Math.min(height - 1, top + 2 + random.nextInt(3));
            int doorwaySide = random.nextInt(4);
            int door = switch (doorwaySide) {
                case 0, 1 -> left + random.nextInt(Math.max(1, right - left + 1));
                default -> top + random.nextInt(Math.max(1, bottom - top + 1));
            };
            for (int x = left; x <= right; x++) {
                maybeAddWall(blocked, new GridCell(x, top), doorwaySide == 0 && x == door);
                maybeAddWall(blocked, new GridCell(x, bottom), doorwaySide == 1 && x == door);
            }
            for (int z = top; z <= bottom; z++) {
                maybeAddWall(blocked, new GridCell(left, z), doorwaySide == 2 && z == door);
                maybeAddWall(blocked, new GridCell(right, z), doorwaySide == 3 && z == door);
            }
        }
        addRandomScatter(random, blocked, width, height, 0.05D);
    }

    private static void maybeAddWall(Set<GridCell> blocked, GridCell cell, boolean isDoorway) {
        if (!isDoorway) {
            blocked.add(cell);
        }
    }

    private static void addRandomScatter(Random random, Set<GridCell> blocked, int width, int height, double density) {
        for (int x = 0; x < width; x++) {
            for (int z = 0; z < height; z++) {
                if (random.nextDouble() < density) {
                    blocked.add(new GridCell(x, z));
                }
            }
        }
    }

    private static GridCell randomOpenCell(Random random, int width, int height, Set<GridCell> blocked, GridCell notEqual) {
        for (int attempt = 0; attempt < 10_000; attempt++) {
            GridCell cell = new GridCell(random.nextInt(width), random.nextInt(height));
            if (!blocked.contains(cell) && !cell.equals(notEqual)) {
                return cell;
            }
        }
        throw new IllegalStateException("could not find open cell");
    }

}
