package com.mcbot.fabricclient;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Persisted cockpit panel layout: per-panel position / scale / collapsed / enabled, edited in-game via
 * {@code CockpitScreen} and read by the HUD renderer. Mutable (the editor drags/resizes in place); saved
 * to {@code config/mcbot_cockpit.json}. All IO is FAIL-SAFE — a missing/corrupt file falls back to
 * defaults and save errors are swallowed; the cockpit must never break the game.
 */
final class CockpitLayout {
    static final String STATUS = "status";
    static final String DEEPSEEK = "deepseek";

    static final float MIN_SCALE = 0.5f;
    static final float MAX_SCALE = 2.5f;

    /** Mutable per-panel layout state (the editor writes x/y/scale/collapsed/enabled directly). */
    static final class PanelConfig {
        int x;
        int y;
        float scale = 1.0f;
        boolean collapsed = false;
        boolean enabled = true;

        PanelConfig() {
        }

        PanelConfig(int x, int y) {
            this.x = x;
            this.y = y;
        }

        float clampedScale() {
            float s = scale > 0.05f ? scale : 1.0f;
            return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
        }
    }

    // Insertion-ordered so the editor renders panels in a stable order.
    Map<String, PanelConfig> panels = new LinkedHashMap<>();

    static CockpitLayout defaults() {
        CockpitLayout layout = new CockpitLayout();
        layout.panels.put(STATUS, new PanelConfig(4, 4));
        layout.panels.put(DEEPSEEK, new PanelConfig(4, 78));
        return layout;
    }

    PanelConfig get(String id) {
        PanelConfig config = panels.get(id);
        if (config == null) {
            config = new PanelConfig(4, 4);
            panels.put(id, config);
        }
        return config;
    }

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    /** Load the layout, falling back to defaults on any error; backfills any panels missing from the file. */
    static CockpitLayout load(Path file) {
        try {
            if (file != null && Files.exists(file)) {
                CockpitLayout loaded = GSON.fromJson(Files.readString(file), CockpitLayout.class);
                if (loaded != null && loaded.panels != null && !loaded.panels.isEmpty()) {
                    for (Map.Entry<String, PanelConfig> def : defaults().panels.entrySet()) {
                        loaded.panels.putIfAbsent(def.getKey(), def.getValue());
                    }
                    return loaded;
                }
            }
        } catch (Throwable ignored) {
            // fall through to defaults
        }
        return defaults();
    }

    /** Persist the layout; swallow any error (a failed save must never break the game). */
    void save(Path file) {
        try {
            if (file != null) {
                if (file.getParent() != null) {
                    Files.createDirectories(file.getParent());
                }
                Files.writeString(file, GSON.toJson(this));
            }
        } catch (Throwable ignored) {
            // best-effort persistence
        }
    }
}
