package com.mcbot.testharness;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Item;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityCombustEvent;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityDeathEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerRespawnEvent;

final class ScenarioEventListener implements Listener {
    private final ScenarioManager scenarioManager;

    ScenarioEventListener(ScenarioManager scenarioManager) {
        this.scenarioManager = scenarioManager;
    }

    @EventHandler
    public void onEntityCombust(EntityCombustEvent event) {
        if (scenarioManager.isNoBurnEntity(event.getEntity().getUniqueId())) {
            event.setCancelled(true);
        }
    }

    @EventHandler
    public void onPlayerMove(PlayerMoveEvent event) {
        try {
            scenarioManager.recordBotMove(event.getPlayer(), event.getTo());
        } catch (IOException err) {
            event.getPlayer().getServer().getLogger().warning("MCBot test harness move telemetry failed: " + err.getMessage());
        }
    }

    @EventHandler
    public void onEntityDamage(EntityDamageEvent event) {
        if (!(event.getEntity() instanceof Player player) || !ScenarioManager.isBot(player)) {
            return;
        }
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("player", player.getName());
        fields.put("damageCause", event.getCause().name());
        fields.put("damage", event.getFinalDamage());
        fields.put("position", ScenarioManager.positionMap(player.getLocation()));
        addDamageSourceFields(fields, event);
        writeAll("bot_damage", fields);
    }

    @EventHandler
    public void onPlayerDeath(PlayerDeathEvent event) {
        Player player = event.getEntity();
        if (!ScenarioManager.isBot(player)) {
            return;
        }
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("player", player.getName());
        fields.put("deathMessage", event.getDeathMessage());
        fields.put("position", ScenarioManager.positionMap(player.getLocation()));
        EntityDamageEvent damage = player.getLastDamageCause();
        if (damage != null) {
            fields.put("damageCause", damage.getCause().name());
            fields.put("damage", damage.getFinalDamage());
            addDamageSourceFields(fields, damage);
        }
        writeAll("bot_death", fields);
    }

    @EventHandler
    public void onPlayerRespawn(PlayerRespawnEvent event) {
        if (!ScenarioManager.isBot(event.getPlayer())) {
            return;
        }
        writeAll("bot_respawn", Map.of(
            "player", event.getPlayer().getName(),
            "position", ScenarioManager.positionMap(event.getRespawnLocation())
        ));
    }

    @EventHandler
    public void onEntityDeath(EntityDeathEvent event) {
        Entity entity = event.getEntity();
        TaggedEntity tagged = scenarioManager.taggedEntity(entity.getUniqueId());
        if (tagged == null) {
            return;
        }
        writeTagged(entity, "tagged_hostile_death", Map.of(
            "position", ScenarioManager.positionMap(entity.getLocation())
        ));
    }

    @EventHandler
    public void onPickup(EntityPickupItemEvent event) {
        if (!(event.getEntity() instanceof Player player) || !ScenarioManager.isBot(player)) {
            return;
        }
        Item item = event.getItem();
        writeAll("item_pickup", Map.of(
            "player", player.getName(),
            "itemEntityUuid", item.getUniqueId().toString(),
            "item", item.getItemStack().getType().key().asString(),
            "count", item.getItemStack().getAmount(),
            "position", ScenarioManager.positionMap(item.getLocation())
        ));
    }

    @EventHandler
    public void onDrop(PlayerDropItemEvent event) {
        if (!ScenarioManager.isBot(event.getPlayer())) {
            return;
        }
        Item item = event.getItemDrop();
        writeAll("item_drop", Map.of(
            "player", event.getPlayer().getName(),
            "itemEntityUuid", item.getUniqueId().toString(),
            "item", item.getItemStack().getType().key().asString(),
            "count", item.getItemStack().getAmount(),
            "position", ScenarioManager.positionMap(item.getLocation())
        ));
    }

    @EventHandler
    public void onBlockBreak(BlockBreakEvent event) {
        if (!ScenarioManager.isBot(event.getPlayer())) {
            return;
        }
        writeAll("block_break", Map.of(
            "player", event.getPlayer().getName(),
            "block", event.getBlock().getType().key().asString(),
            "position", ScenarioManager.positionMap(event.getBlock().getLocation())
        ));
    }

    @EventHandler
    public void onBlockPlace(BlockPlaceEvent event) {
        if (!ScenarioManager.isBot(event.getPlayer())) {
            return;
        }
        writeAll("block_place", Map.of(
            "player", event.getPlayer().getName(),
            "block", event.getBlockPlaced().getType().key().asString(),
            "position", ScenarioManager.positionMap(event.getBlockPlaced().getLocation())
        ));
    }

    private void writeTagged(Entity entity, String event, Map<String, Object> fields) {
        try {
            scenarioManager.writeForTaggedEntity(entity.getUniqueId(), event, fields);
        } catch (IOException err) {
            entity.getServer().getLogger().warning("MCBot test harness telemetry failed: " + err.getMessage());
        }
    }

    private void writeAll(String event, Map<String, Object> fields) {
        if (!scenarioManager.hasActiveSessions()) {
            return;
        }
        try {
            scenarioManager.writeToActiveSessions(event, fields);
        } catch (IOException err) {
            org.bukkit.Bukkit.getLogger().warning("MCBot test harness telemetry failed: " + err.getMessage());
        }
    }

    private void addDamageSourceFields(Map<String, Object> fields, EntityDamageEvent event) {
        if (event instanceof EntityDamageByEntityEvent byEntity) {
            Entity damager = byEntity.getDamager();
            fields.put("sourceUuid", damager.getUniqueId().toString());
            fields.put("sourceType", damager.getType().key().asString());
            TaggedEntity tagged = scenarioManager.taggedEntity(damager.getUniqueId());
            if (tagged != null) {
                fields.put("sourceTag", tagged.tag());
            }
        }
    }
}
