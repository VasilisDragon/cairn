package com.mcbot.testharness;

import java.io.IOException;
import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.bukkit.Location;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockState;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Entity;
import org.bukkit.entity.EntityType;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Player;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.potion.PotionEffect;
import org.bukkit.potion.PotionEffectType;

final class McbotTestCommand implements CommandExecutor, TabCompleter {
    private static final List<String> SUBCOMMANDS = List.of("start", "end", "spawn", "snapshot", "assert", "reset");

    private final McbotTestHarnessPlugin plugin;
    private final HarnessAccess access;
    private final ScenarioManager scenarioManager;

    McbotTestCommand(McbotTestHarnessPlugin plugin, HarnessAccess access, ScenarioManager scenarioManager) {
        this.plugin = plugin;
        this.access = access;
        this.scenarioManager = scenarioManager;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        SafetyCheck allowed = access.checkCommandAllowed(sender);
        if (!allowed.isAllowed()) {
            plugin.getLogger().warning("Refused /mcbottest from " + sender.getName() + ": " + allowed.reason());
            sender.sendMessage("MCBOTTEST refused: " + allowed.reason());
            return true;
        }

        if (args.length == 0) {
            sender.sendMessage("Usage: /mcbottest <start|end> ...");
            return true;
        }

        String subcommand = args[0].toLowerCase();
        try {
            return switch (subcommand) {
                case "start" -> start(sender, args);
                case "end" -> end(sender, args);
                case "spawn" -> spawn(sender, args);
                case "snapshot" -> snapshot(sender, args);
                case "assert" -> assertScenario(sender, args);
                case "reset" -> reset(sender, args);
                default -> {
                    sender.sendMessage("Unknown /mcbottest subcommand: " + subcommand);
                    yield true;
                }
            };
        } catch (IllegalArgumentException err) {
            sender.sendMessage("MCBOTTEST failed: " + err.getMessage());
            return true;
        } catch (IOException err) {
            plugin.getLogger().warning("MCBot test harness IO failure: " + err.getMessage());
            sender.sendMessage("MCBOTTEST IO failure: " + err.getMessage());
            return true;
        }
    }

    private boolean start(CommandSender sender, String[] args) throws IOException {
        if (args.length != 2) {
            sender.sendMessage("Usage: /mcbottest start <scenario_id>");
            return true;
        }
        ScenarioSession session = scenarioManager.start(args[1], sender.getName());
        sender.sendMessage("MCBOTTEST started token=" + session.token() + " telemetry=" + session.telemetryPath());
        return true;
    }

    private boolean end(CommandSender sender, String[] args) throws IOException {
        if (args.length != 2) {
            sender.sendMessage("Usage: /mcbottest end <token>");
            return true;
        }
        ScenarioSession session = scenarioManager.end(args[1], sender.getName());
        sender.sendMessage("MCBOTTEST ended token=" + session.token() + " telemetry=" + session.telemetryPath());
        return true;
    }

    private boolean spawn(CommandSender sender, String[] args) throws IOException {
        if (args.length < 6) {
            sender.sendMessage("Usage: /mcbottest spawn <mob_type> <x> <y> <z> --tag <id> [--effects effect:seconds:level] [--no-burn]");
            return true;
        }

        ScenarioSession session = scenarioManager.singleActiveSession();
        EntityType entityType = parseEntityType(args[1]);
        double x = parseDouble(args[2], "x");
        double y = parseDouble(args[3], "y");
        double z = parseDouble(args[4], "z");
        String tag = null;
        List<PotionEffect> effects = new ArrayList<>();
        boolean noBurn = false;

        for (int index = 5; index < args.length; index += 1) {
            String arg = args[index];
            if ("--tag".equals(arg)) {
                if (index + 1 >= args.length) {
                    throw new IllegalArgumentException("--tag requires an id");
                }
                tag = args[++index];
            } else if ("--effects".equals(arg)) {
                if (index + 1 >= args.length) {
                    throw new IllegalArgumentException("--effects requires effect:seconds:level");
                }
                effects.add(parsePotionEffect(args[++index]));
            } else if ("--no-burn".equals(arg)) {
                noBurn = true;
            } else {
                throw new IllegalArgumentException("unknown spawn option: " + arg);
            }
        }

        if (tag == null || tag.isBlank()) {
            throw new IllegalArgumentException("spawn requires --tag <id>");
        }

        World world = plugin.getServer().getWorlds().get(0);
        Location location = new Location(world, x, y, z);
        Entity entity = world.spawnEntity(location, entityType);
        entity.setPersistent(true);
        if (entity instanceof LivingEntity living) {
            living.setRemoveWhenFarAway(false);
            for (PotionEffect effect : effects) {
                living.addPotionEffect(effect);
            }
            if (noBurn) {
                living.setFireTicks(0);
            }
        }

        scenarioManager.registerTaggedEntity(session, entity, tag, noBurn);
        sender.sendMessage("MCBOTTEST spawned uuid=" + entity.getUniqueId() + " tag=" + tag);
        return true;
    }

    private boolean snapshot(CommandSender sender, String[] args) throws IOException {
        if (args.length != 2 && args.length != 6) {
            sender.sendMessage("Usage: /mcbottest snapshot <token> [chest <x> <y> <z>]");
            return true;
        }
        ScenarioSession session = scenarioManager.session(args[1]);
        Player bot = Bukkit.getPlayerExact("MCBot");
        if (bot == null) {
            throw new IllegalArgumentException("MCBot is not online for snapshot");
        }

        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("player", bot.getName());
        fields.put("position", ScenarioManager.positionMap(bot.getLocation()));
        fields.put("inventory", inventoryMap(bot.getInventory()));
        fields.put("offhand", itemMap(bot.getInventory().getItemInOffHand()));
        fields.put("armor", armorMap(bot));

        if (args.length == 6) {
            if (!"chest".equalsIgnoreCase(args[2])) {
                throw new IllegalArgumentException("snapshot target must be chest");
            }
            Location chestLocation = blockLocation(parseDouble(args[3], "x"), parseDouble(args[4], "y"), parseDouble(args[5], "z"));
            Inventory chestInventory = inventoryAt(chestLocation);
            Map<String, Integer> contents = inventoryCounts(chestInventory);
            scenarioManager.captureChestBaseline(session, chestLocation, contents);
            fields.put("chest", Map.of(
                "position", ScenarioManager.positionMap(chestLocation),
                "contents", contents
            ));
        }

        session.writeEvent("snapshot", fields);
        sender.sendMessage("MCBOTTEST snapshot token=" + session.token());
        return true;
    }

    private boolean assertScenario(CommandSender sender, String[] args) throws IOException {
        if (args.length < 2) {
            sender.sendMessage("Usage: /mcbottest assert <chest_delta|bot_returned_by> ...");
            return true;
        }
        return switch (args[1].toLowerCase()) {
            case "chest_delta" -> assertChestDelta(sender, args);
            case "bot_returned_by" -> assertBotReturnedBy(sender, args);
            default -> {
                sender.sendMessage("Unknown assertion: " + args[1]);
                yield true;
            }
        };
    }

    private boolean assertChestDelta(CommandSender sender, String[] args) throws IOException {
        if (args.length != 7) {
            sender.sendMessage("Usage: /mcbottest assert chest_delta <x> <y> <z> <item> <expected_delta>");
            return true;
        }
        ScenarioSession session = scenarioManager.singleActiveSession();
        Location chestLocation = blockLocation(parseDouble(args[2], "x"), parseDouble(args[3], "y"), parseDouble(args[4], "z"));
        Material item = parseMaterial(args[5]);
        int expectedDelta = parseInt(args[6], "expected_delta");
        int current = countItem(inventoryAt(chestLocation), item);
        Integer baseline = scenarioManager.chestBaseline(session, chestLocation, item);
        boolean hasBaseline = baseline != null;
        int delta = hasBaseline ? current - baseline : 0;
        boolean ok = hasBaseline && delta == expectedDelta;
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("assertion", "chest_delta");
        fields.put("ok", ok);
        fields.put("position", ScenarioManager.positionMap(chestLocation));
        fields.put("item", item.key().asString());
        fields.put("baseline", baseline == null ? "missing" : baseline);
        fields.put("current", current);
        fields.put("delta", delta);
        fields.put("expectedDelta", expectedDelta);
        session.writeEvent("assertion", fields);
        sender.sendMessage((ok ? "MCBOTTEST assertion PASS" : "MCBOTTEST assertion FAIL")
            + " chest_delta item=" + item.key().asString()
            + " expected=" + expectedDelta
            + " actual=" + (hasBaseline ? delta : "baseline_missing"));
        return true;
    }

    private boolean assertBotReturnedBy(CommandSender sender, String[] args) throws IOException {
        if (args.length != 5 && args.length != 6) {
            sender.sendMessage("Usage: /mcbottest assert bot_returned_by <x> <z> <deadline_ms> [radius]");
            return true;
        }
        ScenarioSession session = scenarioManager.singleActiveSession();
        double x = parseDouble(args[2], "x");
        double z = parseDouble(args[3], "z");
        long deadlineMs = parseLong(args[4], "deadline_ms");
        double radius = args.length == 6 ? parseDouble(args[5], "radius") : 2.0;
        Player bot = Bukkit.getPlayerExact("MCBot");
        if (bot == null) {
            throw new IllegalArgumentException("MCBot is not online for bot_returned_by");
        }
        Location location = bot.getLocation();
        double dx = location.getX() - x;
        double dz = location.getZ() - z;
        double distance = Math.sqrt(dx * dx + dz * dz);
        long now = System.currentTimeMillis();
        boolean ok = now <= deadlineMs && distance <= radius;
        session.writeEvent("assertion", Map.of(
            "assertion", "bot_returned_by",
            "ok", ok,
            "targetX", x,
            "targetZ", z,
            "radius", radius,
            "deadlineMs", deadlineMs,
            "nowMs", now,
            "distance", distance,
            "position", ScenarioManager.positionMap(location)
        ));
        sender.sendMessage((ok ? "MCBOTTEST assertion PASS" : "MCBOTTEST assertion FAIL")
            + " bot_returned_by distance=" + distance + " deadlineOk=" + (now <= deadlineMs));
        return true;
    }

    private boolean reset(CommandSender sender, String[] args) throws IOException {
        if (args.length != 2) {
            sender.sendMessage("Usage: /mcbottest reset <arena_id>");
            return true;
        }
        String arenaId = args[1];
        if (!arenaId.matches("[A-Za-z0-9_.-]{1,64}")) {
            throw new IllegalArgumentException("arena_id must match [A-Za-z0-9_.-]{1,64}");
        }
        File arenaFile = new File(plugin.getDataFolder().getParentFile(), "mcbottest/arenas/" + arenaId + ".blocks.tsv");
        if (!arenaFile.isFile()) {
            throw new IllegalArgumentException("arena file not found: " + arenaFile.getAbsolutePath());
        }

        int changed = 0;
        for (String rawLine : Files.readAllLines(arenaFile.toPath())) {
            String line = rawLine.trim();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            String[] parts = line.split("\\s+");
            if (parts.length != 5) {
                throw new IllegalArgumentException("invalid arena line: " + line);
            }
            World world = Bukkit.getWorld(parts[0]);
            if (world == null) {
                throw new IllegalArgumentException("unknown arena world: " + parts[0]);
            }
            int x = parseInt(parts[1], "x");
            int y = parseInt(parts[2], "y");
            int z = parseInt(parts[3], "z");
            Material material = parseMaterial(parts[4]);
            world.getBlockAt(x, y, z).setType(material, false);
            changed += 1;
        }
        scenarioManager.writeToActiveSessions("arena_reset", Map.of("arenaId", arenaId, "changedBlocks", changed));
        sender.sendMessage("MCBOTTEST reset arena=" + arenaId + " changedBlocks=" + changed);
        return true;
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        if (args.length == 1) {
            String prefix = args[0].toLowerCase();
            List<String> matches = new ArrayList<>();
            for (String subcommand : SUBCOMMANDS) {
                if (subcommand.startsWith(prefix)) {
                    matches.add(subcommand);
                }
            }
            return matches;
        }
        if (args.length == 2 && "end".equalsIgnoreCase(args[0])) {
            return scenarioManager.activeTokens().stream()
                .filter(token -> token.startsWith(args[1]))
                .toList();
        }
        return Collections.emptyList();
    }

    private static EntityType parseEntityType(String value) {
        try {
            EntityType type = EntityType.valueOf(value.trim().toUpperCase().replace('-', '_'));
            if (!type.isSpawnable()) {
                throw new IllegalArgumentException("entity is not spawnable: " + value);
            }
            return type;
        } catch (IllegalArgumentException err) {
            throw new IllegalArgumentException("unknown spawnable entity type: " + value);
        }
    }

    private static PotionEffect parsePotionEffect(String value) {
        String[] parts = value.split(":");
        if (parts.length != 3) {
            throw new IllegalArgumentException("effect must be effect:seconds:level");
        }
        PotionEffectType type = PotionEffectType.getByName(parts[0].trim().toUpperCase().replace('-', '_'));
        if (type == null) {
            throw new IllegalArgumentException("unknown potion effect: " + parts[0]);
        }
        int seconds = parseInt(parts[1], "effect seconds");
        int level = parseInt(parts[2], "effect level");
        return new PotionEffect(type, Math.max(1, seconds) * 20, Math.max(0, level - 1), false, false, true);
    }

    private static double parseDouble(String value, String field) {
        try {
            return Double.parseDouble(value);
        } catch (NumberFormatException err) {
            throw new IllegalArgumentException(field + " must be a number");
        }
    }

    private static int parseInt(String value, String field) {
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException err) {
            throw new IllegalArgumentException(field + " must be an integer");
        }
    }

    private static long parseLong(String value, String field) {
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException err) {
            throw new IllegalArgumentException(field + " must be an integer");
        }
    }

    private static Material parseMaterial(String value) {
        Material material = Material.matchMaterial(value);
        if (material == null) {
            material = Material.matchMaterial("minecraft:" + value);
        }
        if (material == null) {
            throw new IllegalArgumentException("unknown material: " + value);
        }
        return material;
    }

    private static Location blockLocation(double x, double y, double z) {
        World world = Bukkit.getWorlds().get(0);
        return new Location(world, Math.floor(x), Math.floor(y), Math.floor(z));
    }

    private static Inventory inventoryAt(Location location) {
        Block block = location.getBlock();
        BlockState state = block.getState();
        if (!(state instanceof InventoryHolder holder)) {
            throw new IllegalArgumentException("block at position is not an inventory holder: " + block.getType().key().asString());
        }
        return holder.getInventory();
    }

    private static int countItem(Inventory inventory, Material material) {
        int count = 0;
        for (ItemStack stack : inventory.getContents()) {
            if (stack != null && stack.getType() == material) {
                count += stack.getAmount();
            }
        }
        return count;
    }

    private static Map<String, Integer> inventoryCounts(Inventory inventory) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (ItemStack stack : inventory.getContents()) {
            if (stack == null || stack.getType().isAir()) {
                continue;
            }
            counts.merge(stack.getType().key().asString(), stack.getAmount(), Integer::sum);
        }
        return counts;
    }

    private static Map<String, Object> inventoryMap(Inventory inventory) {
        Map<String, Object> slots = new LinkedHashMap<>();
        ItemStack[] contents = inventory.getContents();
        for (int index = 0; index < contents.length; index += 1) {
            ItemStack stack = contents[index];
            if (stack != null && !stack.getType().isAir()) {
                slots.put(String.valueOf(index), itemMap(stack));
            }
        }
        return slots;
    }

    private static Map<String, Object> armorMap(Player player) {
        Map<String, Object> armor = new LinkedHashMap<>();
        ItemStack[] contents = player.getInventory().getArmorContents();
        String[] names = {"boots", "leggings", "chestplate", "helmet"};
        for (int index = 0; index < contents.length && index < names.length; index += 1) {
            armor.put(names[index], itemMap(contents[index]));
        }
        return armor;
    }

    private static Map<String, Object> itemMap(ItemStack stack) {
        if (stack == null || stack.getType().isAir()) {
            return Map.of("item", "minecraft:air", "count", 0);
        }
        return Map.of("item", stack.getType().key().asString(), "count", stack.getAmount());
    }
}
