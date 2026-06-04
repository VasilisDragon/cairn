# MCBot Fabric Client

An experimental Fabric **client** mod that lets an external "brain" process drive a
real Minecraft client to play autonomously — navigate, gather, craft, smelt, mine,
fight, and survive — in **single-player**. It is the client-embodied counterpart to
the parent [cairn](..) agent: the same planning discipline, running inside the real
game client rather than a headless protocol bot.

> **Status:** early and active — research-grade, not a finished product. The bot
> currently progresses **autonomously from an empty inventory to an iron pickaxe** —
> gather wood, craft tools, descend to ore depth, mine and smelt iron, and craft iron
> gear — driven by an external planner and validated in a live client. The
> capabilities below are implemented and unit-tested.

## Design

```
   Node brain  ──(local HTTP, 127.0.0.1)──▶  Fabric mod  ──▶  Minecraft client
    (planning)        intent / snapshot        (this dir)       (vanilla play)
```

The mod runs **inside the client** and never opens its own server connection or
speaks the Minecraft protocol. It acts only through the client's own
`interactionManager` (break / place / use / inventory) and the player's input state —
the vanilla client performs the actual world interaction, exactly as a human's inputs
would. A consequence worth stating plainly: the bot inherits vanilla reach, attack
cooldowns, and turn-rate limits **by construction**, and cannot exceed what a fair
human client can do.

A separate Node process — the **brain** — receives a compact world snapshot each tick
and returns the current *intent* over a local socket. Every intent carries an expiry;
a stale or missing one decays to a safe stop, so the bot never keeps acting on
outdated guidance. The brain can be the bundled deterministic **stub** (no API key
required) or an LLM-backed planner that picks an objective and runs a closed
plan → execute → observe → re-plan loop.

## Capabilities

Implemented and unit-tested (JUnit + Node):

- **Navigation** — grid A* pathfinding, kinematics-aware path following, walkability classification.
- **Gathering** — log and tree harvesting with reachable-target selection.
- **Crafting & smelting** — 2×2 and 3×3 recipes, furnace control, charcoal.
- **Descent** — real-terrain staircase to ore depth, bridging open-air cave gaps with placed support.
- **Iron progression** — end-to-end mine → smelt → craft of an iron pickaxe at depth.
- **Block interaction** — breaking and placing with reach/occlusion handling and tool selection.
- **Survival** — auto-eat and a fast-loop reflex that preempts normal control under threat.
- **Fair-play combat** (hostile **mobs** only) — engage a single weak threat, handle multiple/ranged mobs with strafe-kiting, flee when cornered, equip armor, and disengage when boxed in; turn-rate-limited aim (no aimbot).
- **Mission loop** — an external planner selects the next objective and runs a closed plan → execute → observe → re-plan cycle.
- **Inventory management and look control.**

Out of scope, deliberately: multiplayer, PvP, and any anti-cheat bypass, packet
manipulation, kill-aura/aimbot, or impossible-rotation behavior. This is a fair-play,
single-player automation experiment.

## Build & run

Requires JDK 21.

```bash
./gradlew build        # compile and run the JUnit suite
./gradlew runClient    # launch a development client
```

Run a brain in a separate process and point the mod at it:

```bash
node brain/fabric-brain-stub.js     # deterministic, no API key needed
```

The mod reads its endpoint from `MCBOT_FABRIC_BRAIN_URL`
(default `http://127.0.0.1:8765/intent`).

## A note on the entrypoint

`McbotFabricClient` is, for now, a large class that owns the tick loop and wires the
components together. It is being progressively decomposed into the surrounding
planners and controllers — the capabilities above are the cleanly-separated,
individually-tested pieces.

## License & use

Licensed AGPL-3.0-only, consistent with the parent project. Intended for private or
explicitly authorized single-player use; see
[authorized use and scope](../docs/authorized-use-and-scope.md).
