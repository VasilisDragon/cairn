package com.mcbot.testharness;

import java.io.File;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.command.RemoteConsoleCommandSender;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

final class HarnessAccess {
    private final JavaPlugin plugin;
    private final File productionRefuseFlag;
    private final HarnessAuthorizationPolicy.UuidAllowlist allowedUuids;

    HarnessAccess(
        JavaPlugin plugin,
        File productionRefuseFlag,
        HarnessAuthorizationPolicy.UuidAllowlist allowedUuids
    ) {
        this.plugin = plugin;
        this.productionRefuseFlag = productionRefuseFlag;
        this.allowedUuids = allowedUuids;
    }

    static HarnessAccess fromConfig(JavaPlugin plugin, File harnessConfigDirectory) {
        if (!plugin.getConfig().getStringList("allowed-users").isEmpty()) {
            plugin.getLogger().warning("Ignoring deprecated allowed-users; player authorization requires allowed-uuids.");
        }
        HarnessAuthorizationPolicy.UuidAllowlist allowlist = HarnessAuthorizationPolicy.parseAllowedUuids(
            plugin.getConfig().getList("allowed-uuids")
        );
        if (!allowlist.valid()) {
            plugin.getLogger().severe("Invalid allowed-uuids configuration; all player commands will be denied.");
        } else if (allowlist.uuids().isEmpty()) {
            plugin.getLogger().warning("allowed-uuids is empty; all player commands will be denied.");
        }
        return new HarnessAccess(plugin, new File(harnessConfigDirectory, "production-refuse"), allowlist);
    }

    SafetyCheck checkServerSafety() {
        if (productionRefuseFlag.exists()) {
            return SafetyCheck.refused("production-refuse flag exists at " + productionRefuseFlag.getAbsolutePath());
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
            return HarnessAuthorizationPolicy.authorizePlayer(
                plugin.getServer().getOnlineMode(),
                player.hasPermission(HarnessAuthorizationPolicy.PLAYER_PERMISSION),
                player.getUniqueId(),
                allowedUuids
            );
        }
        return SafetyCheck.refused("unsupported command sender: " + sender.getClass().getSimpleName());
    }
}
