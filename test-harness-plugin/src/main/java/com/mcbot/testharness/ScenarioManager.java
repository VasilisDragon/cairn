package com.mcbot.testharness;

import java.io.File;
import java.io.IOException;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

final class ScenarioManager {
    private static final String SCENARIO_ID_PATTERN = "[A-Za-z0-9_.-]{1,64}";
    private static final String TOKEN_PATTERN = "[A-Za-z0-9_.-]{1,96}";

    private final JavaPlugin plugin;
    private final File telemetryDirectory;
    private final ConcurrentMap<String, ScenarioSession> activeSessions = new ConcurrentHashMap<>();
    private final ConcurrentMap<UUID, TaggedEntity> taggedEntities = new ConcurrentHashMap<>();
    private final Set<UUID> noBurnEntities = ConcurrentHashMap.newKeySet();
    private final ConcurrentMap<String, Location> lastMoveByToken = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, Integer> chestBaselines = new ConcurrentHashMap<>();

    ScenarioManager(JavaPlugin plugin, File telemetryDirectory) {
        this.plugin = plugin;
        this.telemetryDirectory = telemetryDirectory;
    }

    ScenarioSession start(String scenarioId, String senderName) throws IOException {
        String normalizedScenarioId = validate(scenarioId, SCENARIO_ID_PATTERN, "scenario_id");
        telemetryDirectory.mkdirs();
        if (!telemetryDirectory.isDirectory()) {
            throw new IOException("telemetry directory unavailable: " + telemetryDirectory.getAbsolutePath());
        }
        String token = uniqueToken(normalizedScenarioId);
        File telemetryFile = new File(telemetryDirectory, token + ".jsonl");
        ScenarioSession session = ScenarioSession.open(token, normalizedScenarioId, telemetryFile);
        ScenarioSession existing = activeSessions.putIfAbsent(token, session);
        if (existing != null) {
            session.close("duplicate_token");
            throw new IOException("scenario token collision: " + token);
        }
        session.writeEvent("scenario_start", Map.of(
            "scenarioId", normalizedScenarioId,
            "sender", safeSender(senderName),
            "serverOnlineMode", plugin.getServer().getOnlineMode(),
            "onlinePlayerCount", plugin.getServer().getOnlinePlayers().size()
        ));
        plugin.getLogger().info("Started MCBot test scenario " + normalizedScenarioId + " token=" + token);
        return session;
    }

    ScenarioSession end(String token, String senderName) throws IOException {
        String normalizedToken = validate(token, TOKEN_PATTERN, "token");
        ScenarioSession session = activeSessions.remove(normalizedToken);
        if (session == null) {
            throw new IllegalArgumentException("unknown scenario token: " + normalizedToken);
        }
        session.writeEvent("scenario_end", Map.of("sender", safeSender(senderName)));
        removeTaggedEntitiesForToken(normalizedToken, "scenario_end");
        session.close("end_command");
        plugin.getLogger().info("Ended MCBot test scenario token=" + normalizedToken);
        return session;
    }

    ScenarioSession singleActiveSession() {
        List<ScenarioSession> sessions = List.copyOf(activeSessions.values());
        if (sessions.isEmpty()) {
            throw new IllegalArgumentException("no active scenario; run /mcbottest start <scenario_id> first");
        }
        if (sessions.size() > 1) {
            throw new IllegalArgumentException("multiple active scenarios; command requires exactly one active scenario");
        }
        return sessions.get(0);
    }

    ScenarioSession session(String token) {
        ScenarioSession session = activeSessions.get(token);
        if (session == null) {
            throw new IllegalArgumentException("unknown scenario token: " + token);
        }
        return session;
    }

    void registerTaggedEntity(ScenarioSession session, Entity entity, String tag, boolean noBurn) throws IOException {
        TaggedEntity tagged = new TaggedEntity(session.token(), entity.getUniqueId(), tag, entity.getType().key().asString());
        taggedEntities.put(entity.getUniqueId(), tagged);
        if (noBurn) {
            noBurnEntities.add(entity.getUniqueId());
        }
        session.writeEvent("tagged_hostile_spawn", Map.of(
            "uuid", entity.getUniqueId().toString(),
            "tag", tag,
            "entityType", entity.getType().key().asString(),
            "position", positionMap(entity.getLocation()),
            "noBurn", noBurn
        ));
    }

    boolean isNoBurnEntity(UUID uuid) {
        return noBurnEntities.contains(uuid);
    }

    TaggedEntity taggedEntity(UUID uuid) {
        return taggedEntities.get(uuid);
    }

    void writeForTaggedEntity(UUID uuid, String event, Map<String, Object> fields) throws IOException {
        TaggedEntity tagged = taggedEntities.get(uuid);
        if (tagged == null) {
            return;
        }
        ScenarioSession session = activeSessions.get(tagged.token());
        if (session == null) {
            return;
        }
        Map<String, Object> payload = new LinkedHashMap<>(fields);
        payload.put("uuid", uuid.toString());
        payload.put("tag", tagged.tag());
        payload.put("entityType", tagged.entityType());
        session.writeEvent(event, payload);
    }

    void writeToActiveSessions(String event, Map<String, Object> fields) throws IOException {
        for (ScenarioSession session : activeSessions.values()) {
            session.writeEvent(event, fields);
        }
    }

    void captureChestBaseline(ScenarioSession session, Location location, Map<String, Integer> contents) {
        for (Map.Entry<String, Integer> entry : contents.entrySet()) {
            chestBaselines.put(chestKey(session, location, entry.getKey()), entry.getValue());
        }
    }

    Integer chestBaseline(ScenarioSession session, Location location, org.bukkit.Material material) {
        return chestBaselines.get(chestKey(session, location, material.key().asString()));
    }

    void recordBotMove(Player player, Location to) throws IOException {
        if (!isBot(player)) {
            return;
        }
        for (ScenarioSession session : activeSessions.values()) {
            Location last = lastMoveByToken.get(session.token());
            if (last != null && last.getWorld() == to.getWorld() && last.distanceSquared(to) < 4.0) {
                continue;
            }
            lastMoveByToken.put(session.token(), to.clone());
            session.writeEvent("bot_move", Map.of(
                "player", player.getName(),
                "position", positionMap(to),
                "nearestTaggedHostileDistance", nearestTaggedHostileDistance(to)
            ));
        }
    }

    boolean hasActiveSessions() {
        return !activeSessions.isEmpty();
    }

    static Map<String, Object> positionMap(Location location) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("world", location.getWorld() == null ? "unknown" : location.getWorld().getName());
        out.put("x", location.getX());
        out.put("y", location.getY());
        out.put("z", location.getZ());
        return out;
    }

    static boolean isBot(Player player) {
        return player != null && "MCBot".equalsIgnoreCase(player.getName());
    }

    void closeAll(String reason) throws IOException {
        List<IOException> failures = new ArrayList<>();
        for (ScenarioSession session : activeSessions.values()) {
            activeSessions.remove(session.token());
            try {
                removeTaggedEntitiesForToken(session.token(), reason);
                session.writeEvent("scenario_end", Map.of("reason", reason));
                session.close(reason);
            } catch (IOException err) {
                failures.add(err);
            }
        }
        if (!failures.isEmpty()) {
            throw failures.get(0);
        }
    }

    List<String> activeTokens() {
        return activeSessions.keySet().stream().sorted().toList();
    }

    private void removeTaggedEntitiesForToken(String token, String reason) throws IOException {
        List<UUID> toRemove = taggedEntities.values().stream()
            .filter(tagged -> tagged.token().equals(token))
            .map(TaggedEntity::uuid)
            .toList();
        for (UUID uuid : toRemove) {
            TaggedEntity tagged = taggedEntities.remove(uuid);
            noBurnEntities.remove(uuid);
            Entity entity = Bukkit.getEntity(uuid);
            ScenarioSession session = activeSessions.get(token);
            if (session != null && tagged != null) {
                session.writeEvent("tagged_hostile_despawn", Map.of(
                    "uuid", uuid.toString(),
                    "tag", tagged.tag(),
                    "entityType", tagged.entityType(),
                    "reason", reason,
                    "position", entity == null ? Map.of() : positionMap(entity.getLocation())
                ));
            }
            if (entity != null && !entity.isDead()) {
                entity.remove();
            }
        }
    }

    private String chestKey(ScenarioSession session, Location location, String itemId) {
        String world = location.getWorld() == null ? "unknown" : location.getWorld().getName();
        return session.token() + "|" + world + "|" + location.getBlockX() + "|" + location.getBlockY() + "|" + location.getBlockZ() + "|" + itemId;
    }

    private double nearestTaggedHostileDistance(Location location) {
        double best = Double.NaN;
        for (UUID uuid : taggedEntities.keySet()) {
            Entity entity = Bukkit.getEntity(uuid);
            if (entity == null || entity.isDead() || entity.getWorld() != location.getWorld()) {
                continue;
            }
            double distance = entity.getLocation().distance(location);
            if (Double.isNaN(best) || distance < best) {
                best = distance;
            }
        }
        return best;
    }

    private String uniqueToken(String scenarioId) {
        String timestamp = DateTimeFormatter.ofPattern("yyyyMMddHHmmss", Locale.ROOT)
            .withZone(java.time.ZoneOffset.UTC)
            .format(Instant.now());
        String random = UUID.randomUUID().toString().substring(0, 8);
        return scenarioId + "-" + timestamp + "-" + random;
    }

    private static String validate(String value, String pattern, String fieldName) {
        String normalized = String.valueOf(value == null ? "" : value).trim();
        if (!normalized.matches(pattern)) {
            throw new IllegalArgumentException(fieldName + " must match " + pattern);
        }
        return normalized;
    }

    private static String safeSender(String senderName) {
        return String.valueOf(senderName == null ? "unknown" : senderName);
    }
}
