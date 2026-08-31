package com.mcbot.testharness;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import org.bukkit.Server;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.command.RemoteConsoleCommandSender;
import org.bukkit.entity.Player;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class McbotTestCommandTabCompletionTest {
    private static final UUID ALLOWED = UUID.fromString("01234567-89ab-cdef-0123-456789abcdef");
    private static final UUID OTHER = UUID.fromString("fedcba98-7654-3210-fedc-ba9876543210");
    private static final String ACTIVE_TOKEN = "active-secret-token";

    @TempDir
    Path temporaryDirectory;

    @Test
    void unsupportedSenderSeesNoSubcommandsOrActiveTokens() {
        Fixture fixture = fixture(true, List.of(ALLOWED.toString()));
        CommandSender sender = mock(CommandSender.class);

        assertEquals(List.of(), fixture.command().onTabComplete(sender, null, "mcbottest", new String[]{""}));
        assertEquals(List.of(), activeTokenCompletions(fixture, sender));
        verify(fixture.scenarioManager(), never()).activeTokens();
    }

    @Test
    void offlinePlayerSeesNoActiveTokens() {
        Fixture fixture = fixture(false, List.of(ALLOWED.toString()));
        Player player = player(ALLOWED, true);

        assertEquals(List.of(), activeTokenCompletions(fixture, player));
        verify(fixture.scenarioManager(), never()).activeTokens();
    }

    @Test
    void nonallowlistedPlayerSeesNoActiveTokens() {
        Fixture fixture = fixture(true, List.of(ALLOWED.toString()));
        Player player = player(OTHER, true);

        assertEquals(List.of(), activeTokenCompletions(fixture, player));
        verify(fixture.scenarioManager(), never()).activeTokens();
    }

    @Test
    void permissionlessPlayerSeesNoActiveTokens() {
        Fixture fixture = fixture(true, List.of(ALLOWED.toString()));
        Player player = player(ALLOWED, false);

        assertEquals(List.of(), activeTokenCompletions(fixture, player));
        verify(fixture.scenarioManager(), never()).activeTokens();
    }

    @Test
    void productionRefuseDeniesCompletionsWithoutReadingTokens() throws Exception {
        Fixture fixture = fixture(true, List.of(ALLOWED.toString()));
        Player player = player(ALLOWED, true);
        Files.createFile(temporaryDirectory.resolve("production-refuse"));

        assertEquals(List.of(), activeTokenCompletions(fixture, player));
        verify(fixture.scenarioManager(), never()).activeTokens();
    }

    @Test
    void authorizedPlayerRetainsSubcommandAndActiveTokenCompletions() {
        Fixture fixture = fixture(true, List.of(ALLOWED.toString()));
        Player player = player(ALLOWED, true);

        assertEquals(
            List.of("start", "spawn", "snapshot"),
            fixture.command().onTabComplete(player, null, "mcbottest", new String[]{"s"})
        );
        assertEquals(List.of(ACTIVE_TOKEN), activeTokenCompletions(fixture, player));
        verify(fixture.scenarioManager()).activeTokens();
    }

    @Test
    void consoleAndRconRetainActiveTokenCompletions() {
        Fixture fixture = fixture(true, List.of());
        ConsoleCommandSender console = mock(ConsoleCommandSender.class);
        RemoteConsoleCommandSender rcon = mock(RemoteConsoleCommandSender.class);

        assertEquals(List.of(ACTIVE_TOKEN), activeTokenCompletions(fixture, console));
        assertEquals(List.of(ACTIVE_TOKEN), activeTokenCompletions(fixture, rcon));
        verify(fixture.scenarioManager(), org.mockito.Mockito.times(2)).activeTokens();
    }

    private Fixture fixture(boolean onlineMode, List<String> allowedUuids) {
        McbotTestHarnessPlugin plugin = mock(McbotTestHarnessPlugin.class);
        Server server = mock(Server.class);
        when(plugin.getServer()).thenReturn(server);
        when(server.getOnlineMode()).thenReturn(onlineMode);

        HarnessAccess access = new HarnessAccess(
            plugin,
            temporaryDirectory.resolve("production-refuse").toFile(),
            HarnessAuthorizationPolicy.parseAllowedUuids(allowedUuids)
        );
        ScenarioManager scenarioManager = mock(ScenarioManager.class);
        when(scenarioManager.activeTokens()).thenReturn(List.of(ACTIVE_TOKEN, "other-token"));
        return new Fixture(new McbotTestCommand(plugin, access, scenarioManager), scenarioManager);
    }

    private static Player player(UUID uuid, boolean hasPermission) {
        Player player = mock(Player.class);
        when(player.getUniqueId()).thenReturn(uuid);
        when(player.hasPermission(HarnessAuthorizationPolicy.PLAYER_PERMISSION)).thenReturn(hasPermission);
        return player;
    }

    private static List<String> activeTokenCompletions(Fixture fixture, CommandSender sender) {
        return fixture.command().onTabComplete(sender, null, "mcbottest", new String[]{"end", "active-"});
    }

    private record Fixture(McbotTestCommand command, ScenarioManager scenarioManager) {
    }
}
