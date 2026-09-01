package com.mcbot.testharness;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import org.bukkit.Server;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.command.RemoteConsoleCommandSender;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class HarnessAccessTest {
    private static final UUID ALLOWED = UUID.fromString("01234567-89ab-cdef-0123-456789abcdef");

    @TempDir
    Path temporaryDirectory;

    @Test
    void consoleAndAuthenticatedRconRemainAllowedUntilProductionRefuseIsPresent() throws Exception {
        File refuseFlag = temporaryDirectory.resolve("production-refuse").toFile();
        JavaPlugin plugin = pluginWithServer(true);
        HarnessAccess access = access(plugin, refuseFlag, List.of());
        ConsoleCommandSender console = mock(ConsoleCommandSender.class);
        RemoteConsoleCommandSender rcon = mock(RemoteConsoleCommandSender.class);

        assertTrue(access.checkCommandAllowed(console).isAllowed());
        assertTrue(access.checkCommandAllowed(rcon).isAllowed());

        Files.createFile(refuseFlag.toPath());
        assertFalse(access.checkCommandAllowed(console).isAllowed());
        assertFalse(access.checkCommandAllowed(rcon).isAllowed());
    }

    @Test
    void playerRequiresOnlineModePermissionAndExactUuid() {
        File refuseFlag = temporaryDirectory.resolve("production-refuse").toFile();
        JavaPlugin plugin = pluginWithServer(true);
        HarnessAccess access = access(plugin, refuseFlag, List.of(ALLOWED.toString()));
        Player player = mock(Player.class);
        when(player.getUniqueId()).thenReturn(ALLOWED);
        when(player.hasPermission(HarnessAuthorizationPolicy.PLAYER_PERMISSION)).thenReturn(true);

        assertTrue(access.checkCommandAllowed(player).isAllowed());
    }

    @Test
    void operatorAndNameCannotBypassMissingPermissionOrUuid() {
        File refuseFlag = temporaryDirectory.resolve("production-refuse").toFile();
        JavaPlugin plugin = pluginWithServer(true);
        HarnessAccess access = access(plugin, refuseFlag, List.of(ALLOWED.toString()));
        Player player = mock(Player.class);
        when(player.getName()).thenReturn("MCBot");
        when(player.isOp()).thenReturn(true);
        when(player.getUniqueId()).thenReturn(ALLOWED);
        when(player.hasPermission(HarnessAuthorizationPolicy.PLAYER_PERMISSION)).thenReturn(false);

        assertFalse(access.checkCommandAllowed(player).isAllowed());

        when(player.hasPermission(HarnessAuthorizationPolicy.PLAYER_PERMISSION)).thenReturn(true);
        when(player.getUniqueId()).thenReturn(UUID.fromString("fedcba98-7654-3210-fedc-ba9876543210"));
        assertFalse(access.checkCommandAllowed(player).isAllowed());
    }

    @Test
    void offlineModeAndInvalidOrEmptyListsDenyPlayers() {
        File refuseFlag = temporaryDirectory.resolve("production-refuse").toFile();
        Player player = mock(Player.class);
        when(player.getUniqueId()).thenReturn(ALLOWED);
        when(player.hasPermission(HarnessAuthorizationPolicy.PLAYER_PERMISSION)).thenReturn(true);

        assertFalse(access(pluginWithServer(false), refuseFlag, List.of(ALLOWED.toString()))
            .checkCommandAllowed(player).isAllowed());
        assertFalse(access(pluginWithServer(true), refuseFlag, List.of())
            .checkCommandAllowed(player).isAllowed());
        assertFalse(access(pluginWithServer(true), refuseFlag, List.of(ALLOWED.toString(), "invalid"))
            .checkCommandAllowed(player).isAllowed());
    }

    private static HarnessAccess access(JavaPlugin plugin, File refuseFlag, List<String> configuredUuids) {
        return new HarnessAccess(
            plugin,
            refuseFlag,
            HarnessAuthorizationPolicy.parseAllowedUuids(configuredUuids)
        );
    }

    private static JavaPlugin pluginWithServer(boolean onlineMode) {
        JavaPlugin plugin = mock(JavaPlugin.class);
        Server server = mock(Server.class);
        when(plugin.getServer()).thenReturn(server);
        when(server.getOnlineMode()).thenReturn(onlineMode);
        return plugin;
    }
}
