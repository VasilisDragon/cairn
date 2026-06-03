# Human Oversight Viewer and Client Handoff

This document records the current v1 position for watching the bot and eventually handing control between a human player and automation.

## Current State

The bot is currently a Mineflayer-controlled Minecraft account. In Regime A it uses the existing offline `MCBot` account on the private LAN test server. In Regime B, after F4, it will use the user's own Microsoft/Mojang account, but only when the user is logged out until the later Fabric handoff bridge exists.

The bot is not controlling the user's already-open vanilla Minecraft client today.

An experimental single-player Fabric client mod now lives under [`../fabric-client/`](../fabric-client/). It drives its *own* single-player client and is **not** the same-session handoff bridge described below — that handoff path is a separate, unbuilt, Fabric-mod-only capability (the Mineflayer backend cannot take over a live session, as noted under [Selected Handoff Path](#selected-handoff-path)).

Supported today:

- Headless bot login through Mineflayer.
- Structured logs and snapshots.
- Live scenario logs for private/local validation.
- Compact world-model summaries for future advisor planning.

Not implemented today:

- A first-person rendered viewer.
- A persistent web viewer that survives bot reconnects.
- Direct takeover of an already-connected vanilla client session.
- Human-to-bot or bot-to-human control handoff inside the same vanilla client.
- Same-account production login with user-elsewhere kick cooldown.

## Viewer Direction

The selected near-term path is the read-only bot viewer. This is the "B-now" path: build local visual oversight around the bot session first, before attempting same-client takeover.

1. Start a local viewer process only when explicitly enabled, for example `MCBOT_VIEWER=1`.
2. Bind to localhost by default.
3. Render the bot's current world view with `prismarine-viewer` or a purpose-built web UI backed by snapshots/world-model data.
4. Keep the viewer process alive when the bot disconnects; the display can show a disconnected/black state until a new bot session attaches.
5. Never feed rendered pixels to DeepSeek as the primary planning input. DeepSeek should consume compact structured snapshots and world-model summaries.

`prismarine-viewer` is a 3D world renderer, not a full Minecraft client UI. The first viewer should document this limitation plainly: it can show the bot's first-person world perspective, but it should not be treated as a HUD, inventory screen, hotbar UI, chat overlay, or exact copy of the vanilla client. Operators should expect to keep structured logs or a later overlay beside the viewer for health, food, inventory, equipment, chat, current skill, and reactive state.

This is an oversight tool, not an autonomy layer.

## Selected Handoff Path

Directly taking over an existing vanilla client session is not a Mineflayer feature. Minecraft servers treat the client connection as one session. A second Mineflayer login on the same Microsoft account would conflict with the user's connected client.

The selected architecture is:

1. Regime A viewer and demo path: the offline `MCBot` account connects to the private LAN server; the user watches through the local viewer and logs.
2. Regime B Phase 1 viewer: after F4 and explicit production config, the bot logs into the user's own account while the user is logged out; the user watches through the local viewer and takes back control by stopping the bot and logging in normally.
3. Regime B Phase 2 same-client handoff: later, a Fabric client mod runs inside the user's already-open client, intercepts user input during handoff, and injects bot-generated legitimate keyboard/mouse actions through a pluggable backend.

The previous proxy idea is intentionally dropped. Do not build a local proxy handoff path unless the project is explicitly replanned. The Fabric bridge is the "D-later" path because it matches the user's desired same-session handoff more directly and keeps control inside the user's local client.

## Fabric Handoff Requirements

Before writing Fabric code, create and review `docs/handoff-architecture.md`. That architecture should define:

- a pluggable output backend interface, with Mineflayer as the current backend and Fabric input as the later backend;
- C1 humanization as mandatory for the Fabric backend, because it will emit literal keyboard/mouse input;
- C2 invariant enforcement for reach, rotation, click timing, movement, and jump physics;
- a user command such as `!handoff <goal>. return to <base> by <duration>`;
- integration with existing task budget and return-planning machinery;
- instant take-back when the user presses any keyboard or mouse input;
- graceful bot logout for the Mineflayer account flow;
- clear separation between Regime A offline `MCBot` testing and Regime B user's-account production use.

Non-goals:

- Public-server automation.
- Packet spoofing, impossible rotations, kill-aura, aimbot, or anti-cheat bypass behavior.
- Letting DeepSeek directly drive raw packets or raw Mineflayer APIs.

## Recommended Build Order

1. Add a read-only local viewer for the bot account.
2. Add a tiny viewer supervisor so the web page remains open across bot disconnect/reconnect and clearly indicates disconnected state.
3. Add snapshot overlays: position, health, food, dimension, current skill, reactive state, nearby hostiles, and task budget.
4. Add Regime B Phase 1 docs for user's-own-account login: user logs out first, starts the bot, watches through the viewer, stops the bot, then logs back in.
5. Only after F4, viewer evidence, and user review of `docs/handoff-architecture.md`, prototype the Fabric client-mod bridge.

## Acceptance Notes

Viewer work should remain optional and gated. The deterministic substrate must remain correct without it.

DeepSeek should receive the structured state interfaces already being prepared:

- `buildSnapshot(bot, runtimeContext)`
- compact world-model summary
- current task budget
- executor/reactive state
- validated skill contract and activation guard context

Rendered video is for the human operator.
