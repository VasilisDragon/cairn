package com.mcbot.fabricclient;

import java.util.Collection;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Code-owned readiness registry for scanner discoveries.
 *
 * <p>A discovery proves that a resource exists and the accessibility proof establishes geometry.
 * Neither fact proves that the client has an executor which can consume that opportunity. This
 * registry is the narrow bridge between those independent facts. It names only action ids already
 * implemented by the deterministic client and mirrors their current tool admission rules; it never
 * creates an intent, route, target, inventory item, or action authority.
 */
final class OpportunityExecutorCapabilityRegistry {
    static final String READINESS_SOURCE = "code_owned_registry_v1";

    private enum ToolRequirement {
        NONE,
        WOODEN_OR_BETTER,
        STONE_OR_BETTER
    }

    private record Definition(
        String capabilityId,
        String executorId,
        ToolRequirement toolRequirement
    ) {
    }

    record RuntimeState(
        boolean woodenOrBetterPickaxe,
        boolean stoneOrBetterPickaxe,
        double health,
        int foodLevel,
        int stoneSwordRemainingDurability,
        int totalFiller,
        int reservedFiller,
        int nearbyHostileCount,
        int liveIronGolemCount
    ) {
        RuntimeState {
            health = Double.isFinite(health) ? Math.max(0.0D, health) : 0.0D;
            foodLevel = Math.max(0, foodLevel);
            stoneSwordRemainingDurability = Math.max(0, stoneSwordRemainingDurability);
            totalFiller = Math.max(0, totalFiller);
            reservedFiller = Math.max(0, reservedFiller);
            nearbyHostileCount = Math.max(0, nearbyHostileCount);
            liveIronGolemCount = Math.max(0, liveIronGolemCount);
        }

        RuntimeState(boolean woodenOrBetterPickaxe, boolean stoneOrBetterPickaxe) {
            this(
                woodenOrBetterPickaxe,
                stoneOrBetterPickaxe,
                0.0D,
                0,
                0,
                0,
                0,
                0,
                0
            );
        }

        static RuntimeState none() {
            return new RuntimeState(false, false);
        }

        static RuntimeState fromCanonicalItemIds(Collection<String> itemIds) {
            boolean woodenOrBetter = false;
            boolean stoneOrBetter = false;
            if (itemIds != null) {
                for (String rawItemId : itemIds) {
                    String itemId = itemPath(rawItemId);
                    if (isStoneOrBetterPickaxe(itemId)) {
                        stoneOrBetter = true;
                        woodenOrBetter = true;
                    } else if ("wooden_pickaxe".equals(itemId)) {
                        woodenOrBetter = true;
                    }
                }
            }
            return new RuntimeState(woodenOrBetter, stoneOrBetter);
        }

        int usableFiller() {
            return Math.max(0, totalFiller - reservedFiller);
        }
    }

    /** Target-specific geometry proof supplied by the code-owned defense planner. */
    record TargetReadiness(boolean ready, String reason) {
        TargetReadiness {
            reason = normalized(reason);
            if (reason.isBlank()) {
                reason = ready ? "defense_ready" : "defense_unavailable";
            }
        }

        static TargetReadiness unavailable() {
            return new TargetReadiness(false, "defense_unavailable");
        }
    }

    record Readiness(
        String capabilityId,
        String executorId,
        boolean ready,
        String reason,
        String source
    ) {
        Readiness {
            capabilityId = normalized(capabilityId);
            executorId = normalized(executorId);
            reason = normalized(reason);
            source = normalized(source);
        }

        List<String> wireSignals() {
            java.util.ArrayList<String> signals = new java.util.ArrayList<>();
            signals.add("readiness_source:" + source);
            if (!capabilityId.isBlank()) {
                signals.add("capability:" + capabilityId);
            }
            if (!executorId.isBlank()) {
                signals.add("executor:" + executorId);
            }
            signals.add(ready ? "capability_ready" : "capability_unready");
            signals.add(ready ? "executor_ready" : "executor_unready");
            if ("village_golem_iron".equals(capabilityId)) {
                signals.add(ready ? "defense_ready" : "defense_unready");
            }
            signals.add("readiness:" + reason);
            return List.copyOf(signals);
        }
    }

    private static final Map<OpportunityScanner.DiscoveryType, Definition> DEFINITIONS =
        definitions();

    private OpportunityExecutorCapabilityRegistry() {
    }

    /**
     * Return a conservative readiness verdict for a revalidated live discovery.
     *
     * @param exactExecutorTarget true only when at least one live discovery member is a block type
     *     the named executor already accepts (e.g. exact vanilla stone, not generic base
     *     stone)
     */
    static Readiness evaluate(
        OpportunityScanner.DiscoveryType type,
        RuntimeState runtime,
        boolean exactExecutorTarget
    ) {
        return evaluate(type, runtime, exactExecutorTarget, TargetReadiness.unavailable());
    }

    static Readiness evaluate(
        OpportunityScanner.DiscoveryType type,
        RuntimeState runtime,
        boolean exactExecutorTarget,
        TargetReadiness targetReadiness
    ) {
        RuntimeState state = runtime == null ? RuntimeState.none() : runtime;
        Definition definition = type == null ? null : DEFINITIONS.get(type);
        if (definition == null) {
            String reason = type == OpportunityScanner.DiscoveryType.PASSIVE_FOOD
                ? "no_general_passive_food_executor"
                : "phase_executor_unavailable";
            return new Readiness("", "", false, reason, READINESS_SOURCE);
        }
        if (!exactExecutorTarget) {
            return new Readiness(
                definition.capabilityId(),
                definition.executorId(),
                false,
                "unsupported_live_target",
                READINESS_SOURCE
            );
        }
        if (type == OpportunityScanner.DiscoveryType.IRON_GOLEM) {
            TargetReadiness proof = targetReadiness == null
                ? TargetReadiness.unavailable() : targetReadiness;
            return new Readiness(
                definition.capabilityId(),
                definition.executorId(),
                proof.ready(),
                proof.ready() ? "code_owned_executor_ready" : proof.reason(),
                READINESS_SOURCE
            );
        }
        boolean toolReady = switch (definition.toolRequirement()) {
            case NONE -> true;
            case WOODEN_OR_BETTER -> state.woodenOrBetterPickaxe();
            case STONE_OR_BETTER -> state.stoneOrBetterPickaxe();
        };
        return new Readiness(
            definition.capabilityId(),
            definition.executorId(),
            toolReady,
            toolReady ? "code_owned_executor_ready" : "required_tool_unavailable",
            READINESS_SOURCE
        );
    }

    static boolean isRegistered(OpportunityScanner.DiscoveryType type) {
        return type != null && DEFINITIONS.containsKey(type);
    }

    private static Map<OpportunityScanner.DiscoveryType, Definition> definitions() {
        EnumMap<OpportunityScanner.DiscoveryType, Definition> definitions =
            new EnumMap<>(OpportunityScanner.DiscoveryType.class);
        definitions.put(
            OpportunityScanner.DiscoveryType.VILLAGE_MARKER_CLUSTER,
            new Definition("village_transaction", "village_revalidate", ToolRequirement.NONE)
        );
        definitions.put(
            OpportunityScanner.DiscoveryType.CONTAINER,
            new Definition("village_container", "village_inspect_container", ToolRequirement.NONE)
        );
        definitions.put(
            OpportunityScanner.DiscoveryType.HAY,
            new Definition("village_hay", "village_harvest_hay", ToolRequirement.NONE)
        );
        definitions.put(
            OpportunityScanner.DiscoveryType.BED,
            new Definition("village_bed", "village_collect_bed", ToolRequirement.NONE)
        );
        definitions.put(
            OpportunityScanner.DiscoveryType.IRON_GOLEM,
            new Definition(
                "village_golem_iron",
                "village_defeat_iron_golem",
                ToolRequirement.NONE
            )
        );
        definitions.put(
            OpportunityScanner.DiscoveryType.EXPOSED_STONE,
            new Definition(
                "local_exposed_stone",
                "mine_nearby_stone",
                ToolRequirement.WOODEN_OR_BETTER
            )
        );
        definitions.put(
            OpportunityScanner.DiscoveryType.EXPOSED_IRON,
            new Definition(
                "local_exposed_iron",
                "mine_nearby_iron",
                ToolRequirement.STONE_OR_BETTER
            )
        );
        definitions.put(
            OpportunityScanner.DiscoveryType.EXPOSED_COAL,
            new Definition(
                "local_exposed_coal",
                "mine_nearby_coal",
                ToolRequirement.STONE_OR_BETTER
            )
        );
        return Map.copyOf(definitions);
    }

    private static boolean isStoneOrBetterPickaxe(String itemId) {
        return "stone_pickaxe".equals(itemId)
            || "iron_pickaxe".equals(itemId)
            || "diamond_pickaxe".equals(itemId)
            || "netherite_pickaxe".equals(itemId);
    }

    private static String itemPath(String value) {
        String normalized = normalized(value);
        int separator = normalized.indexOf(':');
        return separator < 0 ? normalized : normalized.substring(separator + 1);
    }

    private static String normalized(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }
}
