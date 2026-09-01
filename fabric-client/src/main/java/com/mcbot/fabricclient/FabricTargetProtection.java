package com.mcbot.fabricclient;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;
import net.minecraft.client.MinecraftClient;
import net.minecraft.util.math.BlockPos;

/**
 * Immutable, operator-configured do-not-touch regions plus the live world binding used to query
 * them.
 *
 * <p>The configuration is parsed once, away from the client tick. Every physical block sink still
 * queries this service immediately before dispatch, so controllers cannot carry a stale or forged
 * protection Boolean. A malformed/unreadable policy or a missing/stale world binding evaluates to
 * {@link ProtectionState#UNKNOWN}; the world-action authority must deny that state.
 */
final class FabricTargetProtection {
    static final String CONFIG_PROPERTY = "mcbot.doNotTouchRegions";
    static final String CONFIG_ENV = "MCBOT_FABRIC_DO_NOT_TOUCH_REGIONS";
    static final int MAX_CONFIG_CHARS = 65_536;
    static final int MAX_CONFIGURED_REGIONS = 1_024;
    // A conservative queued-bed footprint has ten cells; each can live-expand to one paired cell.
    static final int MAX_AFFECTED_POSITIONS = 20;

    private static final Pattern WORLD_ID_PATTERN =
        Pattern.compile("world-v1-[0-9a-f]{64}");
    private static final Pattern DIMENSION_PATTERN =
        Pattern.compile("[a-z0-9_.-]+:[a-z0-9_/.-]+");

    enum ProtectionState {
        PROTECTED,
        UNPROTECTED,
        UNKNOWN
    }

    private record Coordinates(int x, int y, int z) {
    }

    private record ProtectedRegion(
        String worldIdentity,
        String dimension,
        int minX,
        int minY,
        int minZ,
        int maxX,
        int maxY,
        int maxZ
    ) {
        boolean contains(BlockPos position) {
            return position.getX() >= minX && position.getX() <= maxX
                && position.getY() >= minY && position.getY() <= maxY
                && position.getZ() >= minZ && position.getZ() <= maxZ;
        }
    }

    private final List<ProtectedRegion> regions;
    private final boolean configurationReadable;
    private final String configurationStatus;
    private Object observedWorld;
    private String observedWorldIdentity = "";
    private String observedDimension = "";

    private FabricTargetProtection(
        List<ProtectedRegion> regions,
        boolean configurationReadable,
        String configurationStatus
    ) {
        this.regions = List.copyOf(regions == null ? List.of() : regions);
        this.configurationReadable = configurationReadable;
        this.configurationStatus = normalizedStatus(configurationStatus);
    }

    static FabricTargetProtection fromSystemConfiguration() {
        try {
            String configured = System.getProperty(CONFIG_PROPERTY);
            String source = "system_property";
            if (configured == null || configured.isBlank()) {
                configured = System.getenv(CONFIG_ENV);
                source = "environment";
            }
            return parseConfiguredRegions(configured, source);
        } catch (SecurityException unavailable) {
            return unreadable("configuration_access_denied");
        }
    }

    static FabricTargetProtection fromConfiguredRegions(String configured) {
        return parseConfiguredRegions(configured, "test_or_code");
    }

    private static FabricTargetProtection parseConfiguredRegions(
        String configured,
        String source
    ) {
        String raw = configured == null ? "" : configured;
        if (raw.length() > MAX_CONFIG_CHARS) {
            return unreadable("configuration_too_large");
        }
        String stable = raw.trim();
        if (stable.isEmpty()) {
            return new FabricTargetProtection(List.of(), true, "ready_empty:" + source);
        }

        String[] entries = stable.split(";", -1);
        if (entries.length > MAX_CONFIGURED_REGIONS) {
            return unreadable("too_many_regions");
        }
        Set<ProtectedRegion> parsed = new LinkedHashSet<>();
        for (String entry : entries) {
            ProtectedRegion region = parseRegion(entry);
            if (region == null) {
                return unreadable("invalid_region_syntax");
            }
            parsed.add(region);
        }
        return new FabricTargetProtection(
            new ArrayList<>(parsed),
            true,
            "ready:" + source
        );
    }

    private static ProtectedRegion parseRegion(String configured) {
        if (configured == null) {
            return null;
        }
        String stable = configured.trim();
        int worldSeparator = stable.indexOf('|');
        int positionSeparator = stable.indexOf('@', worldSeparator + 1);
        if (worldSeparator <= 0
            || positionSeparator <= worldSeparator + 1
            || stable.indexOf('|', worldSeparator + 1) >= 0
            || stable.indexOf('@', positionSeparator + 1) >= 0) {
            return null;
        }

        String worldIdentity = stable.substring(0, worldSeparator).trim();
        String dimension = stable.substring(worldSeparator + 1, positionSeparator).trim();
        if (!validWorldIdentity(worldIdentity) || !validDimension(dimension)) {
            return null;
        }

        String coordinates = stable.substring(positionSeparator + 1).trim();
        int rangeSeparator = coordinates.indexOf("..");
        if (rangeSeparator >= 0
            && coordinates.indexOf("..", rangeSeparator + 2) >= 0) {
            return null;
        }
        Coordinates first;
        Coordinates second;
        try {
            if (rangeSeparator < 0) {
                first = parseCoordinates(coordinates);
                second = first;
            } else {
                first = parseCoordinates(coordinates.substring(0, rangeSeparator));
                second = parseCoordinates(coordinates.substring(rangeSeparator + 2));
            }
        } catch (IllegalArgumentException invalid) {
            return null;
        }
        if (first == null || second == null) {
            return null;
        }

        return new ProtectedRegion(
            worldIdentity,
            dimension,
            Math.min(first.x(), second.x()),
            Math.min(first.y(), second.y()),
            Math.min(first.z(), second.z()),
            Math.max(first.x(), second.x()),
            Math.max(first.y(), second.y()),
            Math.max(first.z(), second.z())
        );
    }

    private static Coordinates parseCoordinates(String configured) {
        String[] parts = configured == null
            ? new String[0]
            : configured.trim().split(",", -1);
        if (parts.length != 3) {
            return null;
        }
        return new Coordinates(
            Integer.parseInt(parts[0].trim()),
            Integer.parseInt(parts[1].trim()),
            Integer.parseInt(parts[2].trim())
        );
    }

    synchronized void observeWorld(
        MinecraftClient client,
        FabricWorldActionAuthorization.WorldObservation observation
    ) {
        if (client == null || client.world == null || observation == null) {
            clearWorldContext();
            return;
        }
        try {
            observeWorldContext(
                client.world,
                observation.worldIdentity(),
                client.world.getRegistryKey().getValue().toString()
            );
        } catch (RuntimeException unavailable) {
            clearWorldContext();
        }
    }

    synchronized void observeWorldContext(
        Object world,
        String worldIdentity,
        String dimension
    ) {
        String stableWorldIdentity = normalized(worldIdentity);
        String stableDimension = normalized(dimension);
        if (world == null
            || !validWorldIdentity(stableWorldIdentity)
            || !validDimension(stableDimension)) {
            clearWorldContext();
            return;
        }
        observedWorld = world;
        observedWorldIdentity = stableWorldIdentity;
        observedDimension = stableDimension;
    }

    synchronized void clearWorldContext() {
        observedWorld = null;
        observedWorldIdentity = "";
        observedDimension = "";
    }

    synchronized ProtectionState evaluate(
        MinecraftClient client,
        List<BlockPos> affectedPositions
    ) {
        if (client == null || client.world == null) {
            return ProtectionState.UNKNOWN;
        }
        try {
            return evaluateContext(
                client.world,
                client.world.getRegistryKey().getValue().toString(),
                affectedPositions
            );
        } catch (RuntimeException unavailable) {
            return ProtectionState.UNKNOWN;
        }
    }

    /**
     * Fixture commands are intentionally all-or-nothing. Their command text is not interpreted as
     * block geometry, so the only safe coexistence rule is a readable, explicitly empty policy
     * bound to the current client world and dimension. Any configured region disables every
     * fixture command, including commands whose apparent coordinates are outside that region.
     */
    synchronized boolean fixtureCommandsAllowed(MinecraftClient client) {
        if (client == null) {
            return false;
        }
        try {
            var currentWorld = client.world;
            if (currentWorld == null) {
                return false;
            }
            String currentDimension = currentWorld.getRegistryKey().getValue().toString();
            return fixtureCommandsAllowedContext(
                currentWorld,
                currentDimension
            ) && client.world == currentWorld;
        } catch (RuntimeException unavailable) {
            return false;
        }
    }

    /**
     * Phase-1 fail-closed gate for block actions whose complete vanilla effect graph (attachments,
     * fluids, gravity, redstone, explosions, and entities) is not modeled. Such an action is
     * permitted only when the current observed world binding is exact and the readable policy has
     * no configured do-not-touch region anywhere. A later region configuration must therefore
     * deny at the physical sink even when the declared target is outside every region.
     */
    synchronized boolean unboundedBlockEffectsAllowed(MinecraftClient client) {
        if (client == null) {
            return false;
        }
        try {
            var currentWorld = client.world;
            if (currentWorld == null) {
                return false;
            }
            return unboundedBlockEffectsAllowedContext(
                currentWorld,
                currentWorld.getRegistryKey().getValue().toString()
            ) && client.world == currentWorld;
        } catch (RuntimeException unavailable) {
            return false;
        }
    }

    synchronized boolean unboundedBlockEffectsAllowedForObservedWorld() {
        return configurationReadable
            && regions.isEmpty()
            && observedWorld != null
            && validWorldIdentity(observedWorldIdentity)
            && validDimension(observedDimension);
    }

    synchronized boolean unboundedBlockEffectsAllowedContext(Object world, String dimension) {
        return unboundedBlockEffectsAllowedForObservedWorld()
            && world == observedWorld
            && Objects.equals(normalized(dimension), observedDimension);
    }

    synchronized boolean fixtureCommandsAllowedForObservedWorld() {
        return configurationReadable
            && regions.isEmpty()
            && observedWorld != null
            && validWorldIdentity(observedWorldIdentity)
            && validDimension(observedDimension);
    }

    synchronized boolean fixtureCommandsAllowedContext(Object world, String dimension) {
        return fixtureCommandsAllowedForObservedWorld()
            && world == observedWorld
            && Objects.equals(normalized(dimension), observedDimension);
    }

    synchronized ProtectionState evaluateContext(
        Object world,
        String dimension,
        List<BlockPos> affectedPositions
    ) {
        if (!configurationReadable
            || world == null
            || world != observedWorld
            || !validWorldIdentity(observedWorldIdentity)
            || !Objects.equals(normalized(dimension), observedDimension)
            || affectedPositions == null
            || affectedPositions.isEmpty()
            || affectedPositions.size() > MAX_AFFECTED_POSITIONS) {
            return ProtectionState.UNKNOWN;
        }

        for (BlockPos position : affectedPositions) {
            if (position == null) {
                return ProtectionState.UNKNOWN;
            }
            for (ProtectedRegion region : regions) {
                if (region.worldIdentity().equals(observedWorldIdentity)
                    && region.dimension().equals(observedDimension)
                    && region.contains(position)) {
                    return ProtectionState.PROTECTED;
                }
            }
        }
        return ProtectionState.UNPROTECTED;
    }

    boolean configurationReadable() {
        return configurationReadable;
    }

    int configuredRegionCount() {
        return regions.size();
    }

    String configurationStatus() {
        return configurationStatus;
    }

    private static FabricTargetProtection unreadable(String status) {
        return new FabricTargetProtection(List.of(), false, status);
    }

    private static boolean validWorldIdentity(String value) {
        return value != null && WORLD_ID_PATTERN.matcher(value).matches();
    }

    private static boolean validDimension(String value) {
        return value != null
            && value.length() <= 256
            && DIMENSION_PATTERN.matcher(value).matches();
    }

    private static String normalized(String value) {
        return value == null ? "" : value.trim();
    }

    private static String normalizedStatus(String value) {
        String stable = normalized(value);
        return stable.isEmpty() ? "unknown" : stable;
    }
}
