package com.mcbot.testharness;

import java.io.File;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.command.RemoteConsoleCommandSender;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

final class HarnessAccess {
    private final JavaPlugin plugin;
    private final File productionRefuseFlag;
    private final Set<String> allowedUsers;

    private HarnessAccess(JavaPlugin plugin, File productionRefuseFlag, Set<String> allowedUsers) {
        this.plugin = plugin;
        this.productionRefuseFlag = productionRefuseFlag;
        this.allowedUsers = allowedUsers;
    }

    static HarnessAccess fromConfig(JavaPlugin plugin, File harnessConfigDirectory) {
        Set<String> allowed = new HashSet<>();
        for (String value : plugin.getConfig().getStringList("allowed-users")) {
            String normalized = normalizeName(value);
            if (!normalized.isEmpty()) {
                allowed.add(normalized);
            }
        }
        if (allowed.isEmpty()) {
            allowed.add("mcbot");
        }
        return new HarnessAccess(plugin, new File(harnessConfigDirectory, "production-refuse"), allowed);
    }

    SafetyCheck checkServerSafety() {
        if (productionRefuseFlag.exists()) {
            return SafetyCheck.refused("production-refuse flag exists at " + productionRefuseFlag.getAbsolutePath());
        }
        if (plugin.getServer().getOnlineMode() && plugin.getServer().getOnlinePlayers().size() > 1) {
            return SafetyCheck.refused("online-mode=true with multiple players connected");
        }
        return SafetyCheck.ok();
    }

    SafetyCheck checkCommandAllowed(CommandSender sender) {
        SafetyCheck serverSafety = checkServerSafety();
        if (!serverSafety.isAllowed()) {
            return serverSafety;
        }
        if (sender instanceof ConsoleCommandSender || sender instanceof RemoteConsoleCommandSender) {
            return SafetyCheck.ok();
        }
        if (sender instanceof Player player) {
            String name = normalizeName(player.getName());
            if (player.isOp() || allowedUsers.contains(name)) {
                return SafetyCheck.ok();
            }
            return SafetyCheck.refused("sender is not op or allowlisted: " + player.getName());
        }
        return SafetyCheck.refused("unsupported command sender: " + sender.getClass().getSimpleName());
    }

    private static String normalizeName(String value) {
        return String.valueOf(value == null ? "" : value).trim().toLowerCase(Locale.ROOT);
    }
}
