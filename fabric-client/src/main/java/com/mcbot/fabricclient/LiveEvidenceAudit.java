package com.mcbot.fabricclient;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Locale;

/** Pure encoding helpers for the local V2 evidence trace. */
final class LiveEvidenceAudit {
    private LiveEvidenceAudit() {
    }

    static String normalizeCommand(String command) {
        String normalized = command == null ? "" : command.trim();
        return normalized.startsWith("/") ? normalized.substring(1) : normalized;
    }

    static String commandSha256(String command) {
        return sha256(normalizeCommand(command));
    }

    static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest((value == null ? "" : value).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    static String commandCategory(String command) {
        String normalized = normalizeCommand(command);
        if (normalized.isBlank()) {
            return "empty";
        }
        String verb = normalized.split("\\s+", 2)[0].toLowerCase(Locale.ROOT);
        return switch (verb) {
            case "difficulty", "gamemode", "gamerule" -> "rules_and_mode";
            case "tp", "teleport", "spreadplayers", "spawnpoint", "setworldspawn" ->
                "position_and_spawn";
            case "give", "clear", "item", "effect", "experience", "xp", "enchant" ->
                "player_and_inventory";
            case "setblock", "fill", "clone", "place" -> "blocks";
            case "summon", "kill", "damage", "ride" -> "entities";
            case "time", "weather" -> "time_and_weather";
            default -> "other_server_command";
        };
    }

    static String payloadBase64(String json) {
        return Base64.getEncoder().encodeToString(
            (json == null ? "null" : json).getBytes(StandardCharsets.UTF_8)
        );
    }
}
