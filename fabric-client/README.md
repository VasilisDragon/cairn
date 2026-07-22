# MCBot Fabric Client

A Fabric **client** mod that lets an external Node "brain" drive a real
single-player Minecraft client to play autonomously — navigate, gather, craft,
smelt, and survive — through the vanilla input and interaction APIs. It is the
client-embodied counterpart to the headless mineflayer agent: the same planning
discipline, running inside the real game client.

It began as a bounded walking-forward spike
(`brain -> intent -> client input -> safe stop`) and has grown into the
capability set below.

## Design

```
   Node brain  ──(local HTTP, 127.0.0.1)──▶  Fabric mod  ──▶  Minecraft client
    (planning)        intent / snapshot        (this dir)       (vanilla play)
```

The mod runs inside the client and never opens its own server connection or
speaks the Minecraft protocol. It acts only through the client's
`interactionManager` (break / place / use / inventory) and the player's input
state, so it inherits vanilla reach, attack cooldowns, and turn-rate limits by
construction. Each intent carries an expiry; a stale or missing intent decays to
a safe stop. The mod releases inputs and refuses brain intent when not in
integrated singleplayer.

## Capabilities (implemented, JUnit-tested)

- **Navigation** — grid A* pathfinding, kinematics-aware following, walkability classification.
- **Gathering** — log/tree harvesting with reachable-target selection.
- **Crafting & smelting** — 2×2 and 3×3 recipes, furnace control, charcoal.
- **Block interaction** — break / place with reach/occlusion handling and tool selection.
- **Survival reflex** — auto-eat plus a fast-loop guard that preempts normal control.
- **Combat reflex** — fair-play mob combat: engage a single weak hostile, flee creepers/groups, turn-rate-limited aim.
- **Inventory management, look control, staircase descent.**

## Pinned stack

- Minecraft `1.21.1`, Yarn `1.21.1+build.3`
- Fabric Loader `0.19.2`, Fabric API `0.116.12+1.21.1`, Fabric Loom `1.13.4`
- Gradle wrapper `8.14.3`, Java `21`

Gradle is currently pointed at a local JDK via `org.gradle.java.home` in
`gradle.properties` — adjust that path for your machine, or set `JAVA_HOME`.

## Run

```powershell
.\run-brain.ps1                 # start the Node brain (deterministic stub)
.\run-brain-deepseek.ps1        # start the DeepSeek-backed brain instead
.\run-client.ps1 -InstanceId fabric-dev -BrainUrl http://127.0.0.1:8765/intent -AutoSingleplayer
.\send-command.ps1 -InstanceId fabric-dev -Blocks 2
```

After a dev world exists under `run\saves`, launch directly into it:

```powershell
.\run-client.ps1 -InstanceId fabric-dev -QuickPlayWorld mcbot-dev
```

Build / run the JUnit suite directly:

```powershell
.\gradlew build
.\gradlew test
```

The brain endpoint defaults to `http://127.0.0.1:8765/intent`
(`MCBOT_FABRIC_BRAIN_URL` overrides it).

## Entrypoint

`McbotFabricClient` owns the tick loop and wires the components together; it is
a large class being progressively decomposed into the surrounding planners and
controllers (the capabilities above are the separated, individually-tested
pieces).
