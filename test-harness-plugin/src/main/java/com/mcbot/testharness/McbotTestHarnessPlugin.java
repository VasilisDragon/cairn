package com.mcbot.testharness;

import java.io.File;
import java.io.IOException;
import org.bukkit.plugin.java.JavaPlugin;

public final class McbotTestHarnessPlugin extends JavaPlugin {
    private ScenarioManager scenarioManager;
    private HarnessAccess access;

    @Override
    public void onEnable() {
        saveDefaultConfig();

        File harnessConfigDirectory = new File(getDataFolder().getParentFile(), "mcbottest");
        File telemetryDirectory = new File(getServer().getWorldContainer(), "mcbottest");
        access = HarnessAccess.fromConfig(this, harnessConfigDirectory);
        scenarioManager = new ScenarioManager(this, telemetryDirectory);

        SafetyCheck startupSafety = access.checkServerSafety();
        if (!startupSafety.isAllowed()) {
            getLogger().severe("MCBot test harness refused to load: " + startupSafety.reason());
            getServer().getPluginManager().disablePlugin(this);
            return;
        }

        McbotTestCommand command = new McbotTestCommand(this, access, scenarioManager);
        if (getCommand("mcbottest") == null) {
            getLogger().severe("Missing /mcbottest command registration in plugin.yml");
            getServer().getPluginManager().disablePlugin(this);
            return;
        }
        getCommand("mcbottest").setExecutor(command);
        getCommand("mcbottest").setTabCompleter(command);
        getServer().getPluginManager().registerEvents(new ScenarioEventListener(scenarioManager), this);

        getLogger().info("MCBot test harness lifecycle commands loaded.");
    }

    @Override
    public void onDisable() {
        if (scenarioManager != null) {
            try {
                scenarioManager.closeAll("plugin_disable");
            } catch (IOException err) {
                getLogger().warning("Failed to close scenario telemetry cleanly: " + err.getMessage());
            }
        }
        getLogger().info("MCBot test harness disabled.");
    }
}
