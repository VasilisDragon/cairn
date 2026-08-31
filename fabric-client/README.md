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
- **Motion authority** — a single writer for movement, look, and interaction, with smoothed route following and replay-pinned baselines.
- **Descent & recovery** — mine-through descent, controlled safe-fall, fluid-breach sealing, a mining-workspace lifecycle, and canonical surface return.
- **Spatial memory** — trajectory-retrace returns, a mined-region atlas, and per-world memory that survives across commands.
- **Opportunity layer** — bounded village and iron-golem detours that resume the interrupted objective.
- **Inventory management, look control, staircase descent.**

## Pinned stack

- Minecraft `1.21.1`, Yarn `1.21.1+build.3`
- Fabric Loader `0.19.2`, Fabric API `0.116.12+1.21.1`, Fabric Loom `1.13.4`
- Gradle wrapper `8.14.3`, Java `21`

Set `JAVA_HOME` to a JDK 21 installation before invoking the wrapper. The
repository deliberately does not track a machine-specific `org.gradle.java.home`.

## Run

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\run-brain.ps1                 # deterministic stub
pwsh -NoProfile -ExecutionPolicy Bypass -File .\run-brain-deepseek.ps1        # DeepSeek-backed brain
pwsh -NoProfile -ExecutionPolicy Bypass -File .\run-client.ps1 -InstanceId fabric-dev -BrainUrl http://127.0.0.1:8765/intent -AutoSingleplayer
.\send-command.ps1 -InstanceId fabric-dev -Blocks 2
```

Resource-controlled launchers intentionally refuse in-process invocation such as
`.\run-client.ps1`. Each must be the `-File` entrypoint of a dedicated `pwsh`
process so its kill-on-close containment cannot outlive the MCBot workload or
capture unrelated programs launched later from a reusable terminal.

After a dev world exists under `run\saves`, launch directly into it:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\run-client.ps1 -InstanceId fabric-dev -QuickPlayWorld mcbot-dev
```

### Do-not-touch regions

The live client can protect exact blocks or inclusive cuboids with
`-DoNotTouchRegion` (or `MCBOT_FABRIC_DO_NOT_TOUCH_REGIONS`). Each entry is
scoped to the opaque `world-v1-...` identity in the
`world_action.identity` startup log and an exact dimension. A point uses
`<world-id>|<dimension>@<x>,<y>,<z>`; a cuboid appends
`..<x>,<y>,<z>`. For example:

```powershell
$worldId = 'world-v1-<64 lowercase hex characters from the client snapshot>'
pwsh -NoProfile -ExecutionPolicy Bypass -File .\run-client.ps1 -QuickPlayWorld mcbot-dev -DoNotTouchRegion @(
  "$worldId|minecraft:overworld@248,68,428",
  "$worldId|minecraft:overworld@290,16,354..292,19,356"
)
```

The policy is parsed once at startup and held as an immutable snapshot; no
file I/O occurs on the render tick. The final interaction authority checks the
current world/dimension and actual target immediately before every block break
or block use. Placement checks both the clicked reference block and the
destination. Malformed/unreadable policy state, missing live geometry, or a
stale world binding denies the action. An absent/empty policy is an explicitly
loaded policy with zero protected regions.

Development-fixture server commands use an intentionally stricter rule because
their command text is not parsed into a trustworthy affected-block footprint.
They are allowed only while this policy is readable, bound to the current live
world/dimension, and explicitly empty. Configuring even one protected point or
cuboid disables **all** fixture commands, including `/setblock`, `/fill`,
`/clone`, and `/place`. A malformed/unreadable policy or stale/missing binding
also denies the whole batch. The client checks this before enqueueing and again
on the integrated-server thread before each command executes.

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
