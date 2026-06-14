package com.mcbot.fabricclient;

import java.nio.file.Path;
import java.util.List;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.text.Text;

/**
 * In-game cockpit layout editor (opened by the "Open Cockpit Editor" hotkey). Drag a panel to move it,
 * corner-drag (green handle) to resize/scale its content, click {@code _}/{@code +} to collapse, {@code x}
 * to remove, and re-add removed panels from the bottom tray. Edits a {@link CockpitLayout} in place — the
 * HUD reads the same object, so changes are live — and saves to disk on close.
 *
 * <p>Each panel is drawn as an UNSCALED chrome title bar (name + collapse/remove buttons) above a SCALED
 * preview of the panel's content. Keeping the chrome unscaled is deliberate: the title/buttons stay
 * legible and clickable at any scale, and the title never smears into the scaled content the way a single
 * overlaid header did. It only mutates the layout; it never touches the bot. {@code shouldPause()} is
 * false so the bot keeps running while you lay panels out against live behaviour.
 */
final class CockpitScreen extends Screen {
    private final CockpitLayout layout;
    private final Path savePath;

    /** An editable panel: id + display name + representative sample lines (so the edit box ≈ real size). */
    private record PanelDef(String id, String name, List<String> sample) {
    }

    private static final List<PanelDef> PANELS = List.of(
        new PanelDef(CockpitLayout.STATUS, "Status", List.of(
            "MCBot RUNNING [control]", "objective: MINE_IRON", "action: mine_nearby_iron",
            "brain: ok rtt=42ms ttl=300ms", "cmd: …-13", "hp 20.0  y=11")),
        new PanelDef(CockpitLayout.DEEPSEEK, "DeepSeek", List.of(
            "DeepSeek", "src: llm", "why: needs 3 iron ingots"))
    );

    private enum DragMode { NONE, MOVE, RESIZE }

    private DragMode dragMode = DragMode.NONE;
    private String dragPanel = null;
    private int moveOffsetX;
    private int moveOffsetY;
    private float resizeStartScale = 1.0f;
    private double resizeStartY;

    CockpitScreen(CockpitLayout layout, Path savePath) {
        super(Text.literal("MCBot Cockpit Editor"));
        this.layout = layout;
        this.savePath = savePath;
    }

    @Override
    public boolean shouldPause() {
        return false;
    }

    private int lineHeight() {
        return textRenderer.fontHeight + 2;
    }

    /** Unscaled height of the editor-only chrome title bar (holds the name + collapse/remove buttons). */
    private int chromeHeight() {
        return textRenderer.fontHeight + 3;
    }

    private List<String> visibleLines(PanelDef def, CockpitLayout.PanelConfig cfg) {
        return cfg.collapsed ? def.sample().subList(0, 1) : def.sample();
    }

    private int contentWidth(PanelDef def, CockpitLayout.PanelConfig cfg) {
        int w = 0;
        for (String line : visibleLines(def, cfg)) {
            w = Math.max(w, textRenderer.getWidth(line));
        }
        return w + 6;
    }

    private int contentHeight(PanelDef def, CockpitLayout.PanelConfig cfg) {
        return visibleLines(def, cfg).size() * lineHeight() + 2;
    }

    /** Screen-space box {x, y, w, h}: unscaled chrome title bar above the SCALED content preview. */
    private int[] panelBox(PanelDef def, CockpitLayout.PanelConfig cfg) {
        float s = cfg.clampedScale();
        int titleMinW = textRenderer.getWidth(def.name()) + 26; // room for name + [_][x]
        int w = Math.max((int) (contentWidth(def, cfg) * s), titleMinW);
        int h = chromeHeight() + (int) (contentHeight(def, cfg) * s);
        return new int[]{cfg.x, cfg.y, w, h};
    }

    @Override
    public void render(DrawContext context, int mouseX, int mouseY, float delta) {
        super.render(context, mouseX, mouseY, delta);

        int ch = chromeHeight();
        for (PanelDef def : PANELS) {
            CockpitLayout.PanelConfig cfg = layout.get(def.id());
            if (!cfg.enabled) {
                continue;
            }
            int[] b = panelBox(def, cfg);
            int x = b[0];
            int y = b[1];
            int w = b[2];
            int h = b[3];
            boolean hover = in(mouseX, mouseY, x - 2, y - 2, w + 4, h + 4);
            context.fill(x - 2, y - 2, x + w + 2, y + h + 2, hover ? 0xD0202840 : 0xB0000000); // body
            context.fill(x - 2, y - 2, x + w + 2, y + ch, 0xFF2E5C96);                          // title bar

            // Content preview (SCALED), below the unscaled chrome.
            float s = cfg.clampedScale();
            context.getMatrices().push();
            context.getMatrices().translate(x, y + ch, 0.0);
            if (s != 1.0f) {
                context.getMatrices().scale(s, s, 1.0f);
            }
            List<String> lines = visibleLines(def, cfg);
            int cy = 0;
            for (int i = 0; i < lines.size(); i++) {
                context.drawText(textRenderer, lines.get(i), 0, cy, i == 0 ? 0xFF80C0FF : 0xFFFFFFFF, true);
                cy += lineHeight();
            }
            context.getMatrices().pop();

            // Chrome text + buttons (UNSCALED, so they stay legible + clickable at any panel scale).
            context.drawText(textRenderer, def.name(), x, y, 0xFFFFFFFF, true);
            context.drawText(textRenderer, "x", x + w - 8, y, 0xFFFF6060, true);
            context.drawText(textRenderer, cfg.collapsed ? "+" : "_", x + w - 18, y, 0xFFFFFF80, true);
            context.fill(x + w - 6, y + h - 6, x + w, y + h, 0xFF60FF60); // resize handle
        }

        // Removed-panel tray + help, anchored at the bottom so they never overlap top-left panels.
        int trayY = height - 28;
        context.drawText(textRenderer, "Removed:", 8, trayY - 12, 0xFFAAAAAA, true);
        int tx = 8;
        for (PanelDef def : PANELS) {
            if (layout.get(def.id()).enabled) {
                continue;
            }
            String label = "[+ " + def.name() + "]";
            int w = textRenderer.getWidth(label) + 6;
            boolean hover = in(mouseX, mouseY, tx, trayY - 2, w, lineHeight() + 2);
            context.fill(tx, trayY - 2, tx + w, trayY + lineHeight(), hover ? 0xC0306030 : 0xA0203020);
            context.drawText(textRenderer, label, tx + 3, trayY, 0xFF80FF80, true);
            tx += w + 8;
        }
        context.drawText(textRenderer,
            "drag = move  ·  green corner = resize  ·  _/+ = collapse  ·  x = remove  ·  Esc = save & close",
            8, height - 11, 0xFFFFFF55, true);
    }

    @Override
    public boolean mouseClicked(double mouseX, double mouseY, int button) {
        if (button == 0) {
            int ch = chromeHeight();
            for (int i = PANELS.size() - 1; i >= 0; i--) { // top-most first
                PanelDef def = PANELS.get(i);
                CockpitLayout.PanelConfig cfg = layout.get(def.id());
                if (!cfg.enabled) {
                    continue;
                }
                int[] b = panelBox(def, cfg);
                int x = b[0];
                int y = b[1];
                int w = b[2];
                int h = b[3];
                if (in(mouseX, mouseY, x + w - 10, y - 2, 14, ch + 2)) {
                    cfg.enabled = false;
                    return true;
                }
                if (in(mouseX, mouseY, x + w - 20, y - 2, 12, ch + 2)) {
                    cfg.collapsed = !cfg.collapsed;
                    return true;
                }
                if (in(mouseX, mouseY, x + w - 7, y + h - 7, 11, 11)) {
                    dragMode = DragMode.RESIZE;
                    dragPanel = def.id();
                    resizeStartScale = cfg.clampedScale();
                    resizeStartY = mouseY;
                    return true;
                }
                if (in(mouseX, mouseY, x - 2, y - 2, w + 4, h + 4)) {
                    dragMode = DragMode.MOVE;
                    dragPanel = def.id();
                    moveOffsetX = (int) (mouseX - cfg.x);
                    moveOffsetY = (int) (mouseY - cfg.y);
                    return true;
                }
            }
            int trayY = height - 28;
            int tx = 8;
            for (PanelDef def : PANELS) {
                CockpitLayout.PanelConfig cfg = layout.get(def.id());
                if (cfg.enabled) {
                    continue;
                }
                int w = textRenderer.getWidth("[+ " + def.name() + "]") + 6;
                if (in(mouseX, mouseY, tx, trayY - 2, w, lineHeight() + 2)) {
                    cfg.enabled = true;
                    return true;
                }
                tx += w + 8;
            }
        }
        return super.mouseClicked(mouseX, mouseY, button);
    }

    @Override
    public boolean mouseDragged(double mouseX, double mouseY, int button, double deltaX, double deltaY) {
        if (dragPanel != null) {
            CockpitLayout.PanelConfig cfg = layout.get(dragPanel);
            if (dragMode == DragMode.MOVE) {
                cfg.x = Math.max(0, (int) (mouseX - moveOffsetX));
                cfg.y = Math.max(0, (int) (mouseY - moveOffsetY));
                return true;
            }
            if (dragMode == DragMode.RESIZE) {
                float s = resizeStartScale + (float) ((mouseY - resizeStartY) * 0.01D);
                cfg.scale = Math.max(CockpitLayout.MIN_SCALE, Math.min(CockpitLayout.MAX_SCALE, s));
                return true;
            }
        }
        return super.mouseDragged(mouseX, mouseY, button, deltaX, deltaY);
    }

    @Override
    public boolean mouseReleased(double mouseX, double mouseY, int button) {
        dragMode = DragMode.NONE;
        dragPanel = null;
        return super.mouseReleased(mouseX, mouseY, button);
    }

    @Override
    public void close() {
        layout.save(savePath);
        super.close();
    }

    private static boolean in(double mx, double my, double x, double y, double w, double h) {
        return mx >= x && mx <= x + w && my >= y && my <= y + h;
    }
}
