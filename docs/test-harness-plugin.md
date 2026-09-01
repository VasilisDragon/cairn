# Private Test Harness Plugin

## v0 Operator Guide

Status:
- Server type: Paper, detected from `<server-dir>\paper.jar` and existing Paper/Bukkit config.
- Plugin project: `test-harness-plugin\`.
- Built jar: `test-harness-plugin\build\libs\mcbot-test-harness-0.1.0.jar`.
- Deployed jar: `<server-dir>\plugins\MCBotTestHarness.jar`.
- Telemetry files: `<server-dir>\mcbottest\<scenario_token>.jsonl`.
- Scope: private dev/test server only. Do not install this plugin on a public or production server.

Build:
- Use JDK 21.
- From `test-harness-plugin\`, prepare dependencies if needed, then run the
  qualification build without network access:
  - `.\gradlew.bat clean test build --offline --no-daemon`
- Copy the built jar to `<server-dir>\plugins\MCBotTestHarness.jar`, then restart the Paper server.

Allowlist and safety:
- Command senders allowed by v0:
  - server console;
  - RCON;
  - players only when the server has `online-mode=true`, the player has the
    explicit `mcbottest.use` permission, and the player's authenticated UUID
    appears in `<server-dir>\plugins\MCBotTestHarness\config.yml`.
- Default config:
  - `allowed-uuids: []` (deny every player until explicitly configured).
- Player names and operator status never grant access. Any malformed UUID
  invalidates the complete list and denies every player.
- Safety refusal flag:
  - `<server-dir>\plugins\mcbottest\production-refuse`
  - If this file exists, `/mcbottest` refuses to run.
- Console and authenticated RCON access remain available on the private server
  regardless of player count; the production-refuse flag still overrides them.

v0 command surface:
- `/mcbottest start <scenario_id>`
  - Starts one telemetry session and returns `token=<scenario_token>` and `telemetry=<absolute_jsonl_path>`.
- `/mcbottest end <token>`
  - Ends the session, writes `scenario_end`, despawns tagged hostile entities for that token, and closes the JSONL file.
- `/mcbottest spawn <mob_type> <x> <y> <z> --tag <id> [--effects effect:seconds:level] [--no-burn]`
  - Spawns one tagged entity for the single active scenario.
  - Use `--no-burn` for daylight zombie/skeleton tests.
  - Effects are one-based levels; for example `fire_resistance:120:1`.
- `/mcbottest snapshot <token>`
  - Records MCBot position, inventory, offhand, and armor.
- `/mcbottest snapshot <token> chest <x> <y> <z>`
  - Also records chest contents and stores a baseline for later `chest_delta`.
- `/mcbottest assert chest_delta <x> <y> <z> <item> <expected_delta>`
  - Requires a prior chest snapshot in the same active scenario.
- `/mcbottest assert bot_returned_by <x> <z> <deadline_ms> [radius]`
  - Verifies MCBot is within the radius before the deadline.
- `/mcbottest reset <arena_id>`
  - Restores block states from `<server-dir>\plugins\mcbottest\arenas\<arena_id>.blocks.tsv`.
  - File rows are `world x y z material`; blank lines and `#` comments are ignored.

Bot-side wrapper:
- Use `scripts/run-live-scenario.js` for plugin-backed live evidence.
- Required gates:
  - `MCBOT_LIVE_TESTS=1`
  - `MCBOT_LIVE_ADMIN_OK=1`
  - `MCBOT_RCON_PASSWORD=<password from server.properties>`
- Usually also set:
  - `MCBOT_RCON_PORT=25575`
- Raw admin cleanup/setup is separate and must be explicit:
  - `MCBOT_LIVE_ADMIN_RAW_OK=1`
- Example:
  - `node scripts/run-live-scenario.js --scenario live_hostile_escalation_fixture --report reports/plugin-live-j.json --timeout-ms 260000`
- Wrapper behavior:
  - starts `/mcbottest start <scenario_id>` over RCON;
  - passes `MCBOT_PLUGIN_BACKED=1`, `MCBOT_PLUGIN_SCENARIO_TOKEN`, `MCBOT_PLUGIN_SCENARIO_ID`, and `MCBOT_PLUGIN_TELEMETRY_PATH` to the child fixture;
  - ends the plugin session in cleanup;
  - reads the plugin JSONL telemetry;
  - writes the local report JSON.

Scenario IDs:
- `live_server_smoke`: connect/chunks/snapshot/quit smoke.
- `live_supply_chest_inspect`: inspect authorized chest without withdrawal.
- `live_supply_chest_equip`: withdraw controlled equipment and log inventory/equipment deltas.
- `live_phase2_collect_deposit_fixture`: collect and deposit oak logs.
- `live_single_hostile_flee_fixture`: one-hostile flee baseline.
- `live_supply_chest_fishing_fixture`: withdraw rod, catch three items, deposit catches and rod. Plugin-backed live-proven.
- `live_mining_soak_fixture`: short mining fixture for coal/iron/diamond proof. Plugin-backed live-proven.
- `live_death_recovery_fixture`: one death, one recovery attempt, deposit recovered proof items. Plugin-backed live-proven.
- `live_single_hostile_engage_fixture`: deterministic one-hostile engage baseline.
- `live_hostile_escalation_fixture`: RCON/plugin-spawned hostile escalation. Plugin-backed live-proven.
- `live_pvm_escalation_decision_fixture`: staged flee-vs-engage decision escalation. Plugin-backed live-proven.

Telemetry format:
- Files are JSONL: one JSON object per line.
- Every event includes:
  - `event`
  - `token`
  - `scenarioId`
  - `timeIso`
  - `timeMs`
- Implemented v0 event names:
  - `scenario_start`
  - `scenario_end`
  - `tagged_hostile_spawn`
  - `tagged_hostile_death`
  - `tagged_hostile_despawn`
  - `bot_move`
  - `bot_damage`
  - `bot_death`
  - `bot_respawn`
  - `item_pickup`
  - `item_drop`
  - `block_break`
  - `block_place`
  - `snapshot`
  - `assertion`
  - `arena_reset`
- Positions use:
  - `{ "world": "<world>", "x": <number>, "y": <number>, "z": <number> }`
- Item IDs use namespaced Bukkit keys such as `minecraft:cooked_beef`.
- `bot_move` is throttled to roughly two-block movement deltas per active scenario.

Troubleshooting:
- `Unknown command` or no `/mcbottest`: the jar is not loaded; copy the jar to `<server-dir>\plugins\MCBotTestHarness.jar` and restart the Paper server.
- `MCBOTTEST refused: production-refuse flag exists`: remove the flag only on the private dev/test server.
- `player commands require online-mode=true`: use console/authenticated RCON,
  or enable authenticated online mode before granting any player access.
- `sender lacks mcbottest.use` or `sender UUID is not allowlisted`: grant the
  permission explicitly and add the exact authenticated UUID to
  `plugins\MCBotTestHarness\config.yml`; operator status and names do not count.
- Wrapper cannot parse `token` or `telemetry`: check the RCON response from `/mcbottest start`; it must contain `MCBOTTEST started token=... telemetry=...`.
- Empty telemetry file: verify the session was started before the fixture and that `/mcbottest end <token>` ran during cleanup.
- `chest_delta` reports `baseline_missing`: run `/mcbottest snapshot <token> chest <x> <y> <z>` before the chest mutation.
- Hostiles burn during daytime: spawn through `/mcbottest spawn ... --no-burn` or add `--effects fire_resistance:120:1`.
- Fixture blocked by natural mobs or stale entities: use gated private-server RCON setup/cleanup in the scenario, then restore the original gamerules.
- Arena reset fails: verify the arena file exists under `plugins\mcbottest\arenas\` and each non-comment line has exactly five fields.

Out of scope for v0:
- HTTP endpoint.
- Dashboard.
- Aggregate metrics service.
- Runtime bot-to-plugin telemetry channel.
- Client handoff/viewer work.
- Public-server or production use.

## Step 18 - Server Type Detection

Date: 2026-05-24

Scope:
- Inspected `<server-dir>\` only.
- No server software was changed.
- No plugin project was created.
- No live bot behavior was run.

Detected server type: **Paper**

Evidence:
- `<server-dir>\paper.jar` exists and is the only top-level server jar.
- `<server-dir>\start.bat` is titled `Minecraft Paper Server - 1.21.11`, sets `SERVER_JAR=%~dp0paper.jar`, and runs that jar with Java 21.
- `paper.jar` manifest contains `Main-Class: io.papermc.paperclip.Main`.
- Paper/Bukkit-family config and plugin layout exists:
  - `<server-dir>\config\paper-global.yml`
  - `<server-dir>\config\paper-world-defaults.yml`
  - `<server-dir>\spigot.yml`
  - `<server-dir>\bukkit.yml`
  - `<server-dir>\plugins\`
- Existing Bukkit/Paper plugins are present, including EssentialsX, LuckPerms, ProtocolLib, PlaceholderAPI, Chunky, spark, and BetterPortals.
- Fabric indicators are absent:
  - no `<server-dir>\mods\`
  - no `<server-dir>\fabric.mod.json`
  - no `<server-dir>\fabric-server-launch.jar`
- Vanilla-only indicators are absent:
  - no top-level `server.jar`
  - Paperclip manifest confirms `paper.jar` is not a vanilla server jar.

Relevant server properties observed:
- `online-mode=false`
- `enable-rcon=true`
- `server-port=25565`
- `rcon.port=25575`
- `difficulty=normal`
- `gamemode=survival`

Decision for step 19:
- Recommended implementation path: **Paper plugin** using Java 21 and the Paper API for the current 1.21.x server.
- Do not switch the user's server software.
- Do not start step 19 until the operator confirms this tech choice.

Scope guard:
- Step 19 may create `test-harness-plugin\` only after operator confirmation.
- v0 must stay limited to the command and telemetry scope agreed for the test harness.
- No HTTP endpoint, dashboard, aggregate metrics system, runtime bot telemetry channel, or bulk fixture migration belongs in v0.

## Step 19 - Plugin Project Skeleton

Date: 2026-05-24

Operator confirmation:
- The operator confirmed the Paper plugin path after step 18 detected the server as Paper.

Implemented:
- Created `test-harness-plugin\` as a standalone Gradle Java project.
- Added Gradle wrapper files so the project does not require a globally installed Gradle.
- Configured Java 21 toolchain.
- Configured the Paper Maven repository and Paper API dependency for the detected server line:
  - `io.papermc.paper:paper-api:1.21.11-R0.1-SNAPSHOT`
- Added a minimal Paper plugin descriptor:
  - `test-harness-plugin\src\main\resources\paper-plugin.yml`
- Added a minimal main class:
  - `test-harness-plugin\src\main\java\com\mcbot\testharness\McbotTestHarnessPlugin.java`
- Added `copyPluginJar`, which writes the built jar to `test-harness-plugin\dist\`.
- Added local ignore rules for `.gradle\`, `build\`, `dist\`, and logs.

Validation:
- Build command:
  - `.\gradlew.bat build --no-daemon`
- Java used:
  - `<server-dir>\runtime\jdk-21.0.11+10`
- Result:
  - PASS.
  - Built `test-harness-plugin\dist\mcbot-test-harness-0.1.0.jar`.
  - `dist\`, `build\`, and `.gradle\` are ignored and not committed.

Not implemented in step 19:
- No `/mcbottest` commands.
- No telemetry writer.
- No scenario runner.
- No server deployment or live load test.
- No fixture migration.

Next:
- PART B2 step 20 starts v0 command implementation in separate logical checkpoints.

## Step 20a - Lifecycle Commands

Date: 2026-05-24

Implemented:
- Added `/mcbottest start <scenario_id>`.
- Added `/mcbottest end <token>`.
- Added active scenario token tracking.
- Added telemetry JSONL foundation at `<server_root>\mcbottest\<token>.jsonl`.
- Added `scenario_start` and `scenario_end` telemetry events.
- Added server-side command access checks:
  - console is allowed;
  - operators are allowed;
  - configured usernames in `plugins\MCBotTestHarness\config.yml` are allowed.
- Added default allowlist containing `MCBot`.
- Added server-side safety checks:
  - refuses if `plugins\mcbottest\production-refuse` exists;
  - refuses when `online-mode=true` and more than one player is connected.

Validation:
- Build command:
  - `.\gradlew.bat build --no-daemon`
- Result:
  - PASS.

Not implemented in this checkpoint:
- No `/mcbottest spawn`.
- No `/mcbottest snapshot`.
- No `/mcbottest reset`.
- No `/mcbottest assert`.
- No bot-side scenario runner.
- No live server deployment or fixture migration.

## Step 20b - Tagged Spawn and Core Event Telemetry

Date: 2026-05-24

Implemented:
- Added `/mcbottest spawn <mob_type> <x> <y> <z> --tag <id> [--effects effect:seconds:level] [--no-burn]`.
- Spawn command requires exactly one active scenario and writes a `tagged_hostile_spawn` telemetry event.
- Added tagged entity tracking by UUID and tag.
- Added `--no-burn` protection for tagged entities through `EntityCombustEvent`.
- Added effect application for spawned living entities.
- Added core telemetry listeners while scenarios are active:
  - `bot_move`
  - `bot_damage`
  - `item_drop`
  - `item_pickup`
  - `block_break`
  - `block_place`
  - `tagged_hostile_death`
  - `tagged_hostile_despawn` on scenario end/plugin shutdown cleanup

Validation:
- `.\gradlew.bat build --no-daemon`: PASS.

Not implemented in this checkpoint:
- No `/mcbottest snapshot`.
- No `/mcbottest reset`.
- No `/mcbottest assert`.
- No bot-side scenario runner.
- No live server deployment or fixture migration.

## Step 20c - Snapshot, Reset, and Assertions

Date: 2026-05-24

Implemented:
- Added `/mcbottest snapshot <token>`.
- Added `/mcbottest snapshot <token> chest <x> <y> <z>` to record a chest baseline for later delta assertions.
- Added `/mcbottest assert chest_delta <x> <y> <z> <item> <expected_delta>`.
- Added `/mcbottest assert bot_returned_by <x> <z> <deadline_ms> [radius]`.
- Added `/mcbottest reset <arena_id>` for v0 file-backed arena resets.

Arena reset format:
- File path: `plugins\mcbottest\arenas\<arena_id>.blocks.tsv`.
- One block per non-comment line:
  - `<world> <x> <y> <z> <material>`

Validation:
- `.\gradlew.bat build --no-daemon`: PASS.

Notes:
- `chest_delta` requires a prior chest snapshot baseline in the same active scenario.
- Reset is intentionally limited to declared block-list arena files in v0.

Not implemented in this checkpoint:
- No bot-side scenario runner.
- No live server deployment.
- No fixture migration.

## Step 21 - Plugin-Backed Live Scenario Runner

Date: 2026-05-24

Implemented:
- Added `scripts/run-live-scenario.js`.
- Added npm script:
  - `npm run live:scenario`
- Runner behavior:
  - validates existing live/RCON gates;
  - starts `/mcbottest start <scenario_id>` over RCON;
  - parses the scenario token and telemetry path;
  - launches the existing `scripts/live-suite.js` selected scenario;
  - always attempts `/mcbottest end <token>` in cleanup;
  - reads plugin JSONL telemetry;
  - emits `reports/plugin-live-scenario.json`.
- Added focused offline tests for argument parsing, env gating, start-response parsing, JSONL parsing, telemetry summary, and hostile-scenario validation.

Validation:
- `node --check scripts\run-live-scenario.js`: PASS.
- `node --test test\offline\run_live_scenario.test.js`: PASS; 3/3 tests.

Not implemented in this checkpoint:
- No plugin deployment.
- No live server behavior.
- No fixture migration.

## Step 21a - Live Load Validation

Date: 2026-05-24

Implemented:
- Converted the plugin descriptor from `paper-plugin.yml` to Bukkit-compatible `plugin.yml`.
- Updated Gradle resource expansion to process `plugin.yml`.
- Allowed `RemoteConsoleCommandSender` in addition to the local console sender so RCON can execute `/mcbottest`.

Reason:
- Paper rejected the original Paper-plugin startup path because Paper plugins do not support YAML command declarations with `JavaPlugin#getCommand`.
- The harness only needs the Bukkit-compatible command executor surface for v0, and Paper loads Bukkit plugins normally.

Live validation:
- Copied the rebuilt jar to `<server-dir>\plugins\MCBotTestHarness.jar`.
- Restarted the private dev server using RCON `save-all`, RCON `stop`, a Paper JVM exit wait, then `<server-dir>\start.bat`.
- `plugins`: PASS, `MCBotTestHarness` listed green under Bukkit plugins.
- `/mcbottest start harness_load_smoke`: PASS.
- `/mcbottest spawn zombie 248 68 428 --tag load_smoke_zombie --effects fire_resistance:120:1 --no-burn`: PASS.
- `/mcbottest end harness_load_smoke-20260524201514-2b42002f`: PASS.
- Telemetry file contained:
  - `scenario_start`
  - `tagged_hostile_spawn`
  - `scenario_end`

Validation:
- `.\gradlew.bat build --no-daemon`: PASS.

Not implemented in this checkpoint:
- No fixture migration.
- No long-horizon soak.
- No C-track live evidence.

## Step 22a - Fixture J Migration

Date: 2026-05-24

Implemented:
- Migrated `live_hostile_escalation_fixture` to plugin-backed hostile waves when launched through `scripts/run-live-scenario.js`.
- Child fixtures now receive:
  - `MCBOT_PLUGIN_BACKED=1`
  - `MCBOT_PLUGIN_SCENARIO_TOKEN`
  - `MCBOT_PLUGIN_SCENARIO_ID`
  - `MCBOT_PLUGIN_TELEMETRY_PATH`
- Added safe RCON plan actions that call `/mcbottest spawn` without using the raw-admin path.
- J wave tags:
  - `j_1_single-near-1`
  - `j_2_three-close-1..3`
  - `j_3_four-stack-1..4`
- Fixed telemetry JSON serialization for unavailable nearest-tagged-hostile distances.
- Fixed RCON start-response parsing for Windows paths with CRLF line endings.

Live validation:
- Command:
  - `node scripts/run-live-scenario.js --scenario live_hostile_escalation_fixture --timeout-ms 240000 --report reports/plugin-live-j.json`
- Result:
  - PASS.
  - Token: `live_hostile_escalation_fixture-20260524202153-b0d51c6f`.
  - Telemetry: `<server-dir>\mcbottest\live_hostile_escalation_fixture-20260524202153-b0d51c6f.jsonl`.
- Telemetry counts:
  - `scenario_start: 1`
  - `tagged_hostile_spawn: 8`
  - `bot_move: 62`
  - `tagged_hostile_death: 8`
  - `scenario_end: 1`
- Scenario behavior:
  - Bot saw `FLEEING`.
  - Bot did not enter `ENGAGING`.
  - Bot returned to `NORMAL`.
  - Final health was `20`.
  - Final food was `11`.
  - `waterEscapeEntries` was `0`.
  - `finalEscapeObserved` was `true`.
  - Cleanup restored ambient mob spawning.

Validation:
- `node --check scripts\run-live-scenario.js`: PASS.
- `node --check scripts\live-admin-commands.js`: PASS.
- `node --check test\live_hostile_escalation_fixture.js`: PASS.
- `node --test test\offline\live_admin_commands.test.js test\offline\run_live_scenario.test.js`: PASS; 12/12 tests.
- `.\gradlew.bat build --no-daemon`: PASS.

Not implemented in this checkpoint:
- No K migration.
- No mining soak migration.
- No death-recovery migration.
- No fishing migration.

## Step 22b - Fixture K Migration

Date: 2026-05-24

Implemented:
- Migrated `live_pvm_escalation_decision_fixture` to plugin-backed hostile waves when launched through `scripts/run-live-scenario.js`.
- K wave tags:
  - `k_1_single-engage-1`
  - `k_2_three-overwhelm-1..3`

Live validation:
- First attempt failed safely before hostile spawn because the authorized chest fixture was missing `netherite_chestplate`; cleanup restored ambient mob spawning.
- Restocked controlled fixture inputs in known chest slots through namespaced vanilla RCON.
- Passing command:
  - `node scripts/run-live-scenario.js --scenario live_pvm_escalation_decision_fixture --timeout-ms 300000 --report reports/plugin-live-k.json`
- Result:
  - PASS.
  - Token: `live_pvm_escalation_decision_fixture-20260524202734-5a5ca1b1`.
  - Telemetry: `<server-dir>\mcbottest\live_pvm_escalation_decision_fixture-20260524202734-5a5ca1b1.jsonl`.
- Telemetry counts:
  - `scenario_start: 1`
  - `tagged_hostile_spawn: 4`
  - `bot_move: 47`
  - `bot_damage: 1`
  - `tagged_hostile_death: 4`
  - `scenario_end: 1`
- Scenario behavior:
  - Bot withdrew and equipped missing netherite chestplate and boots.
  - Bot held a netherite sword.
  - Bot saw `ENGAGING` before escalation.
  - Bot saw `FLEEING` and `too-many-hostiles` after escalation.
  - Bot returned to `NORMAL`.
  - Final health was `20`.
  - Final food was `20`.
  - `waterEscapeEntries` was `0`.
  - `finalEscapeObserved` was `true`.
  - Cleanup restored ambient mob spawning.

Validation:
- `node --check test\live_pvm_escalation_decision_fixture.js`: PASS.
- `node --check scripts\live-scenarios.js`: PASS.
- `node --test test\offline\live_scenarios.test.js test\offline\live_pvm_escalation_plan.test.js`: PASS; 28/28 tests.

Not implemented in this checkpoint:
- No mining soak migration.
- No death-recovery migration.
- No fishing migration.

## Step 22c - Mining Soak Migration and Dig Timing Fix

Date: 2026-05-24

Implemented:
- Migrated `live_mining_soak_fixture` evidence to plugin-backed telemetry validation.
- Added server-side mining validation in `scripts/run-live-scenario.js`; mining now requires bot movement and at least one plugin `block_break` event.
- Added a Mineflayer dig-time fallback for modern ore materials where local registry data reports `netherite_pickaxe` mining `diamond_ore`/`iron_ore` as `4550ms`.
- Added reachable-block fast dig timing logs and a local dropped-item nudge after fast dig when pickup does not arrive immediately.
- Removed the dropped-item `objectType` probe that caused live deprecation stack traces.
- Added a short ground-settle gate before fast-digging so airborne jumps do not start a 5x-penalty dig.

Live validation:
- Passing command:
  - `node scripts/run-live-scenario.js --scenario live_mining_soak_fixture --report reports/plugin-live-mining.json --timeout-ms 160000`
- The command was run with `MCBOT_LIVE_TESTS=1`, `MCBOT_LIVE_ADMIN_OK=1`, `MCBOT_LIVE_MINING_FIXTURE_OK=1`, `MCBOT_LIVE_MINING_DURATION_MS=70000`, and `MCBOT_LIVE_MINING_RETURN_RESERVE_MS=22000`.
- Before the run, RCON temporarily set `gamerule spawn_monsters false`, cleared non-player entities, and restaged controlled `diamond_ore` blocks. Cleanup restored `gamerule spawn_monsters true`.
- Result:
  - PASS.
  - Token: `live_mining_soak_fixture-20260524210432-0ea30c14`.
  - Telemetry: `<server-dir>\.\mcbottest\live_mining_soak_fixture-20260524210432-0ea30c14.jsonl`.
- Telemetry counts:
  - `scenario_start: 1`
  - `bot_move: 37`
  - `block_break: 15`
  - `item_pickup: 15`
  - `scenario_end: 1`
- Timing evidence:
  - `dig-time.fallback`: `diamond_ore` with `netherite_pickaxe`, `originalMs:4550`, `fallbackMs:500`.
  - Fast-dig starts: `8`.
  - Fast-dig expected range: `500ms..500ms`.
  - Fast-dig actual range: `500ms..517ms`, average `507ms`.
  - `collect.fast-dig.pickup`: `5` local nudge recoveries.
  - `collect.no-drop`: `0`.
  - Object-type warning lines: `0`.
- Scenario behavior:
  - Bot mined `diamond_ore`, returned to the authorized supply chest, deposited `diamond`, and finished before deadline.
  - Plugin telemetry showed every server-side block break had a matching item pickup.

Validation:
- `node --check src\control\dig_time.js src\bot.js src\skills\_pathing.js src\skills\collect.js scripts\run-live-scenario.js test\offline\collect_abort.test.js test\offline\skill_runtime_failure.test.js`: PASS.
- `node --test test\offline\dig_time_fallback.test.js test\offline\collect_abort.test.js test\offline\collect_target_selection.test.js test\offline\run_live_scenario.test.js test\offline\skill_runtime_failure.test.js test\offline\humanization_action_boundary.test.js`: PASS; 102/102 tests.

Not implemented in this checkpoint:
- No death-recovery migration.
- No fishing migration.

## Step 22d - Death Recovery Migration

Date: 2026-05-24

Implemented:
- Migrated `live_death_recovery_fixture` evidence to plugin-backed telemetry validation.
- Added server-side bot death and respawn telemetry:
  - `bot_death`
  - `bot_respawn`
- Updated `scripts/run-live-scenario.js` so the death recovery fixture requires plugin evidence for death, respawn, and item pickup.
- Tightened `recover_drops` item sweeping after the first live H run showed a false pass: `cooked_beef` was not recovered and visible drops remained near the death location.
- Expanded the visible drop sweep radius and target count, shortened per-item settle/wait windows, and made the sweep update its inventory baseline after each successful pickup.
- Changed `recover_drops` to fail as partial recovery when any visible nearby dropped item remains after a positive recovery delta.
- Added an optional private-server proof item path for H:
  - `MCBOT_LIVE_DEATH_RECOVERY_ADMIN_EXTRA_ITEM`
  - `MCBOT_LIVE_DEATH_RECOVERY_ADMIN_EXTRA_COUNT`

Live validation:
- Passing command:
  - `node scripts/run-live-scenario.js --scenario live_death_recovery_fixture --report reports/plugin-live-death.json --timeout-ms 260000`
- The command was run with `MCBOT_LIVE_TESTS=1`, `MCBOT_LIVE_ADMIN_OK=1`, `MCBOT_LIVE_ADMIN_RAW_OK=1`, `MCBOT_LIVE_DEATH_RECOVERY_FIXTURE_OK=1`, `MCBOT_LIVE_DEATH_RECOVERY_ADMIN=1`, `MCBOT_LIVE_DEATH_RECOVERY_ADMIN_DAMAGE=100`, `MCBOT_LIVE_DEATH_RECOVERY_ADMIN_EXTRA_ITEM=cooked_beef`, `MCBOT_LIVE_DEATH_RECOVERY_ADMIN_EXTRA_COUNT=4`, and RCON credentials loaded from `<server-dir>\server.properties`.
- Before the run, RCON temporarily set `gamerule spawn_monsters false`, set `gamerule keepInventory false`, and cleared nearby non-player entities. Cleanup restored the original gamerules.
- Result:
  - PASS.
  - Token: `live_death_recovery_fixture-20260524213051-86776df4`.
  - Telemetry: `<server-dir>\.\mcbottest\live_death_recovery_fixture-20260524213051-86776df4.jsonl`.
- Telemetry counts:
  - `scenario_start: 1`
  - `bot_damage: 1`
  - `bot_death: 1`
  - `bot_respawn: 1`
  - `bot_move: 91`
  - `item_pickup: 13`
  - `scenario_end: 1`
- Scenario behavior:
  - Bot withdrew `dirt:1` from the authorized supply chest.
  - RCON gave `cooked_beef:4` as a second proof item.
  - RCON killed the bot with controlled fall damage near the fixture.
  - Bot respawned, queued exactly one recovery attempt, returned to the death position, and recovered all visible drops.
  - `recover_drops` reported `recoveredItems` containing `cooked_beef:4`, `dirt:1`, netherite tools, logs, rotten flesh, stick, and wheat seeds.
  - `nearbyItems: []` and `itemSweep.remainingItems: 0`.
  - Bot returned to the authorized chest and deposited the proof `dirt:1`.

Validation:
- `node --check src\skills\recover_drops.js test\offline\recover_drops.test.js test\live_death_recovery_fixture.js scripts\live-scenarios.js scripts\run-live-scenario.js test\offline\run_live_scenario.test.js`: PASS.
- `node --test test\offline\recover_drops.test.js test\offline\run_live_scenario.test.js test\offline\skill_schema.test.js`: PASS; 46/46 tests.
- `.\gradlew.bat build --no-daemon`: PASS.

Not implemented in this checkpoint:
- No fishing migration.
- No large death-recovery subsystem beyond the existing one-attempt policy.

## Step 22d Follow-Up - Death Recovery Pickup Sweep Calibration

Date: 2026-05-24

Implemented:
- Calibrated the `recover_drops` pickup sweep after live observation showed the passed H run could still look like it was leaving steak and pausing between dropped items.
- Added a direct local visible-item sweep before the pathfinder-per-item fallback.
- Added local stale-target skipping when one visible item is not getting closer.
- Added a no-wait path fallback when the target item entity is already gone and inventory has advanced.
- Updated `live_death_recovery_fixture` cleanup for RCON-given proof items:
  - pre-deposit stale proof items already in inventory before arming the death;
  - deposit recovered proof items after the recovery pass.

Live validation:
- Passing command:
  - `node scripts/run-live-scenario.js --scenario live_death_recovery_fixture --report reports/plugin-live-death-local-sweep.json --timeout-ms 260000`
- The command was run with `MCBOT_LIVE_TESTS=1`, `MCBOT_LIVE_ADMIN_OK=1`, `MCBOT_LIVE_ADMIN_RAW_OK=1`, `MCBOT_LIVE_DEATH_RECOVERY_FIXTURE_OK=1`, `MCBOT_LIVE_DEATH_RECOVERY_ADMIN=1`, `MCBOT_LIVE_DEATH_RECOVERY_ADMIN_DAMAGE=100`, `MCBOT_LIVE_DEATH_RECOVERY_ADMIN_EXTRA_ITEM=cooked_beef`, `MCBOT_LIVE_DEATH_RECOVERY_ADMIN_EXTRA_COUNT=4`, and RCON credentials loaded from `<server-dir>\server.properties`.
- Setup used RCON to query and temporarily set `spawn_monsters=false`, clear non-player entities, and restore the original `spawn_monsters` value afterward.
- Result:
  - PASS.
  - Token: `live_death_recovery_fixture-20260524220125-858cf594`.
  - Telemetry: `<server-dir>\.\mcbottest\live_death_recovery_fixture-20260524220125-858cf594.jsonl`.
- Telemetry counts:
  - `scenario_start: 1`
  - `bot_damage: 1`
  - `bot_death: 1`
  - `bot_respawn: 1`
  - `bot_move: 86`
  - `item_pickup: 13`
  - `scenario_end: 1`
- Pickup counts included:
  - `minecraft:cooked_beef: 4`
  - `minecraft:dirt: 1`
- Scenario behavior:
  - Pre-clean deposited stale `cooked_beef:8` from previous runs.
  - Current proof `cooked_beef:4` was recovered after the induced death.
  - `recover_drops` ended with `nearbyItems: []` and `itemSweep.remainingItems: 0`.
  - Cleanup deposited `dirt:1` and `cooked_beef:4`.
  - Final inventory had no `cooked_beef`.

Validation:
- `node --check src\skills\recover_drops.js test\offline\recover_drops.test.js test\live_death_recovery_fixture.js`: PASS.
- `node --test test\offline\recover_drops.test.js test\offline\run_live_scenario.test.js test\offline\skill_schema.test.js`: PASS; 48/48 tests.

Not implemented in this checkpoint:
- No repeated recovery attempts.
- No plugin v1+ telemetry channels.
- No broad item-gathering subsystem outside the existing one-attempt recovery policy.

## Step 22e - Fishing Fixture Migration

Date: 2026-05-24

Implemented:
- Migrated `live_supply_chest_fishing_fixture` evidence to plugin-backed telemetry validation.
- Added item pickup summaries to `scripts/run-live-scenario.js`.
- Added fishing-specific plugin validation requiring:
  - at least one server-side `bot_move` event;
  - at least three server-side `item_pickup` events.
- Fixed a live-observed fishing safety false positive where stale low oxygen caused the fixture to abort even though block reads showed the bot was standing in dry air.
- Applied the same stale-oxygen dry-air fix to the reusable `fish_until` skill.

Live validation:
- First plugin-backed F attempt failed safely before fishing because the authorized chest no longer contained `fishing_rod`.
- Fixture repair used RCON against the private dev server:
  - `minecraft:item replace block 248 68 428 container.21 with minecraft:fishing_rod 1`
- Second plugin-backed F attempt withdrew and equipped the rod but failed safely on stale oxygen while dry:
  - `oxygenLevel: 12`
  - `inWater: false`
  - `submerged: false`
  - `feet/head/eyes: air`
- Passing command:
  - `node scripts/run-live-scenario.js --scenario live_supply_chest_fishing_fixture --report reports/plugin-live-fishing.json --timeout-ms 280000`
- The command was run with `MCBOT_LIVE_TESTS=1`, `MCBOT_LIVE_ADMIN_OK=1`, `MCBOT_LIVE_ADMIN_RAW_OK=1`, `MCBOT_LIVE_FISHING_RUN_TIMEOUT_MS=260000`, `MCBOT_LIVE_FISHING_DURATION_MS=210000`, `MCBOT_LIVE_FISHING_RETURN_RESERVE_MS=60000`, `MCBOT_LIVE_FISHING_DEPOSIT_INTERVAL_MS=75000`, and RCON credentials loaded from `<server-dir>\server.properties`.
- Before the passing run, RCON temporarily set `gamerule spawn_monsters false` and cleared non-player entities near the chest/water fixture. Cleanup restored the original spawn-monsters gamerule.
- Result:
  - PASS.
  - Token: `live_supply_chest_fishing_fixture-20260524214648-b2a6088e`.
  - Telemetry: `<server-dir>\.\mcbottest\live_supply_chest_fishing_fixture-20260524214648-b2a6088e.jsonl`.
- Telemetry counts:
  - `scenario_start: 1`
  - `bot_move: 24`
  - `item_pickup: 3`
  - `scenario_end: 1`
- Plugin pickup summary:
  - `minecraft:pufferfish: 1`
  - `minecraft:cod: 1`
  - `minecraft:salmon: 1`
- Scenario behavior:
  - Bot withdrew and equipped exactly one `fishing_rod`.
  - Bot reached the authorized fishing water fixture and selected stand `{x:246,y:63,z:414}` for water `{x:246,y:62,z:410}`.
  - Bot caught three items: `pufferfish:1`, `cod:1`, `salmon:1`.
  - Controlled water-entry pickup recovered caught items that landed in water and returned to dry stand afterward.
  - Bot returned to the authorized chest, deposited `pufferfish:1`, `cod:1`, `salmon:1`, and `fishing_rod:1`.
  - Final inventory contained no fishing output or rod.

Validation:
- `node --check src\skills\fish_until.js test\offline\fish_until_skill.test.js test\live_supply_chest_fishing_fixture.js scripts\run-live-scenario.js test\offline\run_live_scenario.test.js`: PASS.
- `node --test test\offline\fish_until_skill.test.js test\offline\run_live_scenario.test.js`: PASS; 16/16 tests.
- `npm run test:all`: PASS.

Not implemented in this checkpoint:
- No long-horizon fishing soak beyond the existing three-catch fixture.
- No new plugin v1+ telemetry surface.

## Step 24a - Fishing Duration Soak and Shore-First Pickup

Date: 2026-05-24

Implemented:
- Added duration-only fishing mode for bounded long-horizon soak runs.
- Added shore-first fishing pickup behavior:
  - prefer water with a nearby dry stand;
  - wait for caught item flight before pathing;
  - attempt dry pickup/reposition before water-entry fallback.
- Added wrapper validation over structured child logs so fishing soak evidence must include:
  - `mission.result`;
  - `live_supply_chest_fishing_fixture.done`;
  - catches greater than or equal to `MCBOT_LIVE_FISHING_MIN_CATCHES`;
  - final task budget not overdue;
  - duration-only end reason from a return plan or return reserve.
- Added an authorized chest range fast path to avoid pathfinder churn when the bot is already close enough to open the fixture chest.

Live validation:
- Passing command:
  - `node scripts/run-live-scenario.js --scenario live_supply_chest_fishing_fixture --report reports/plugin-live-fishing-duration-soak.json --timeout-ms 300000 --env MCBOT_LIVE_FISHING_DURATION_ONLY=1 --env MCBOT_LIVE_FISHING_DURATION_MS=180000 --env MCBOT_LIVE_FISHING_RETURN_RESERVE_MS=45000 --env MCBOT_LIVE_FISHING_DEPOSIT_INTERVAL_MS=70000 --env MCBOT_LIVE_FISHING_MIN_CATCHES=3 --env MCBOT_LIVE_FISHING_RUN_TIMEOUT_MS=260000 --env MCBOT_LIVE_FISHING_MAX_ITERATIONS=1000`
- Result:
  - PASS.
  - Token: `live_supply_chest_fishing_fixture-20260524223057-f3356ede`.
  - Telemetry: `<server-dir>\.\mcbottest\live_supply_chest_fishing_fixture-20260524223057-f3356ede.jsonl`.
- Plugin telemetry counts:
  - `scenario_start: 1`
  - `bot_move: 35`
  - `item_pickup: 6`
  - `scenario_end: 1`
- Scenario behavior:
  - Bot selected water `{x:244,y:62,z:412}` and dry stand `{x:244,y:63,z:414}`.
  - Bot caught six outputs: salmon, tropical fish, bow, pufferfish, and leather boots.
  - Bot deposited caught outputs and returned the fishing rod to the authorized supply chest.
  - Bot returned because the mission reserve was reached, with final `overdue:false`.
  - The passing run required no controlled water-entry pickup.

Validation:
- `node --check test\live_helpers.js test\live_supply_chest_fishing_fixture.js scripts\run-live-scenario.js test\offline\live_scenarios.test.js test\offline\run_live_scenario.test.js`: PASS.
- `node --test test\offline\live_scenarios.test.js test\offline\run_live_scenario.test.js`: PASS; 34/34 tests.

Not implemented in this checkpoint:
- No multi-hour fishing proof.
- No new plugin v1+ telemetry surface.
- No broader item-collection subsystem outside the fishing fixture.

## Step 24b - Strict Mining Soak

Date: 2026-05-24

Implemented:
- Added strict mining soak mode for plugin-backed long-horizon evidence:
  - `MCBOT_LIVE_MINING_REQUIRE_RETURN_RESERVE=1`
  - `MCBOT_LIVE_MINING_MIN_WORK_MS`
- Updated wrapper validation so strict mining evidence must end from `return-reserve-reached` and satisfy the configured minimum elapsed work window.
- Preserved the existing non-strict mining fixture behavior for short fixture validation.

Live validation:
- Setup:
  - Disabled natural mob spawning.
  - Cleared non-player entities.
  - Staged controlled `diamond_ore` blocks near the existing mining fixture at `x=244 y=69 z=439..473`.
- Passing command:
  - `node scripts/run-live-scenario.js --scenario live_mining_soak_fixture --report reports/plugin-live-mining-strict-soak.json --timeout-ms 220000 --env MCBOT_LIVE_MINING_DURATION_MS=90000 --env MCBOT_LIVE_MINING_RETURN_RESERVE_MS=30000 --env MCBOT_LIVE_MINING_DEPOSIT_INTERVAL_MS=30000 --env MCBOT_LIVE_MINING_REQUIRE_RETURN_RESERVE=1 --env MCBOT_LIVE_MINING_MIN_WORK_MS=50000 --env MCBOT_LIVE_MINING_RUN_TIMEOUT_MS=180000`
- Cleanup:
  - Restored natural mob spawning.
- Result:
  - PASS.
  - Token: `live_mining_soak_fixture-20260524224315-142f91d2`.
  - Telemetry: `<server-dir>\.\mcbottest\live_mining_soak_fixture-20260524224315-142f91d2.jsonl`.
- Plugin telemetry counts:
  - `scenario_start: 1`
  - `bot_move: 49`
  - `block_break: 14`
  - `item_pickup: 14`
  - `bot_damage: 1`
  - `scenario_end: 1`
- Scenario behavior:
  - Bot mined and picked up 14 target drops.
  - Bot made an interval deposit, resumed mining, then returned because the return reserve was reached.
  - Child evidence recorded `durationMs: 67411`, `minWorkMs: 50000`, `requireReturnReserve: true`, `loopResult.reason: return-reserve-reached`, and `overdue:false`.
  - Deposited target deltas were `diamond:13` and `raw_iron:1`.

Validation:
- `node --check test\live_mining_soak_fixture.js scripts\live-scenarios.js scripts\run-live-scenario.js test\offline\live_scenarios.test.js test\offline\run_live_scenario.test.js`: PASS.
- `node --test test\offline\live_scenarios.test.js test\offline\run_live_scenario.test.js`: PASS; 34/34 tests.

Not implemented in this checkpoint:
- No multi-hour cave-mining proof.
- No plugin v1+ telemetry surface.

## Step 24c - Five-Minute Fishing Soak

Date: 2026-05-24

Live validation:
- Setup:
  - Disabled natural mob spawning.
  - Cleared non-player entities.
- Passing command:
  - `node scripts/run-live-scenario.js --scenario live_supply_chest_fishing_fixture --report reports/plugin-live-fishing-five-minute-soak.json --timeout-ms 430000 --env MCBOT_LIVE_FISHING_DURATION_ONLY=1 --env MCBOT_LIVE_FISHING_DURATION_MS=300000 --env MCBOT_LIVE_FISHING_RETURN_RESERVE_MS=60000 --env MCBOT_LIVE_FISHING_DEPOSIT_INTERVAL_MS=90000 --env MCBOT_LIVE_FISHING_MIN_CATCHES=8 --env MCBOT_LIVE_FISHING_RUN_TIMEOUT_MS=390000 --env MCBOT_LIVE_FISHING_MAX_ITERATIONS=1000`
- Cleanup:
  - Restored natural mob spawning.
- Result:
  - PASS.
  - Token: `live_supply_chest_fishing_fixture-20260524224840-0caa5891`.
  - Telemetry: `<server-dir>\.\mcbottest\live_supply_chest_fishing_fixture-20260524224840-0caa5891.jsonl`.
- Plugin telemetry counts:
  - `scenario_start: 1`
  - `bot_move: 52`
  - `item_pickup: 12`
  - `scenario_end: 1`
- Scenario behavior:
  - Bot used the shore-first pickup path from the Step 24a checkpoint.
  - Bot caught 12 outputs against an 8-catch minimum.
  - Bot made two interval deposits, resumed fishing each time, then returned because the reserve was reached.
  - Child evidence recorded `durationMs: 260513`, `durationTarget: 300000`, `loopResult.reason: return-reserve-reached`, `overdue:false`, `standRecoveries:0`, and `castRetries:0`.
  - Caught totals were `cod:7`, `pufferfish:2`, `tropical_fish:1`, `salmon:1`, and `bone:1`.

Validation:
- `npm run test:all`: PASS before this docs-only live-evidence checkpoint.

Not implemented in this checkpoint:
- No multi-hour unattended fishing proof.
- No plugin v1+ telemetry surface.

## Step 24f - Benchmark Ladder Consumption of Plugin Soaks

Date: 2026-05-24

Implemented:
- Wired plugin-backed fishing and mining soak reports into `scripts/benchmark-ladder.js`.
- Added `src/benchmarks/ladder.js` validation so `long_horizon_return_by_deadline` becomes `live-proven` only when both:
  - a plugin-backed fishing duration soak is valid; and
  - the strict plugin-backed mining soak is valid.
- Added fail-closed tests for weak plugin evidence.
- Updated the broad capability-matrix long-horizon entry to point to plugin-backed bounded soak evidence without claiming multi-hour endurance.

Local generated evidence check:
- Command:
  - `node scripts/benchmark-ladder.js --source-report-dir reports --report-dir <temp-dir>`
- Result:
  - `long_horizon_return_by_deadline.status: live-proven`
  - `evidenceArtifact: reports/plugin-live-fishing-dry-five-minute-soak.json + reports/plugin-live-mining-strict-soak.json`
  - Fishing summary included `catches=13/8`, `elapsedMs=259232`, `pickups=13`, and `waterFallback=false`.
  - Mining summary included `elapsedMs=67411`, `minWorkMs=50000`, `mined=diamond:13,raw_iron:1`, `deposited=diamond:13,raw_iron:1`, `blockBreaks=14`, and `pickups=14`.

Validation:
- `node --check src\benchmarks\ladder.js scripts\benchmark-ladder.js test\offline\benchmark_ladder.test.js`: PASS.
- `node --test test\offline\benchmark_ladder.test.js`: PASS; 7/7 tests.
- `git diff --check`: PASS for the changed code/test files.

Not implemented in this checkpoint:
- No multi-hour unattended mission proof.
- No plugin v1+ telemetry surface.

## Step 24g - Fishing Dry-Catch Runway and Conditional Motion

Date: 2026-05-24

Implemented:
- Tightened the fishing fixture after live observation showed fixed post-catch movement was too predictable.
- Added catch-runway scoring so stand selection prefers positions that can keep caught items on dry land.
- Added shore-biased cast targets.
- Replaced unconditional post-catch step-back with a logged `fish.landing-plan`:
  - comfortable dry runways hold position;
  - moderate/weak runways can still use bounded reel pull or post-reel nudge;
  - dry-land drops are collected directly instead of resetting to the stand first.
- Added `MCBOT_LIVE_FISHING_DRY_INTERCEPT_REACH`, `MCBOT_LIVE_FISHING_LANDING_MOTION_MODE`, `MCBOT_LIVE_FISHING_LANDING_SCORE_COMFORT`, and `MCBOT_LIVE_FISHING_LANDING_SCORE_MINIMUM`.
- Added `rod.missing-before-cast` diagnostics after a live rerun exposed a worn fixture rod.

Live validation:
- Setup:
  - RCON credentials were loaded from `<server-dir>\server.properties`; the password was not logged.
  - Disabled natural mob spawning.
  - Cleared non-player entities.
- Issue encountered:
  - First auto-mode rerun failed after one catch because the authorized chest rod was already worn and disappeared before cast 2.
  - Restored a fresh fixture rod with:
    - `node scripts\live-admin.js raw minecraft:item replace block 248 68 428 container.21 with minecraft:fishing_rod 1`
- Passing command:
  - `node scripts\run-live-scenario.js --scenario live_supply_chest_fishing_fixture --report reports/plugin-live-fishing-dry-runway-auto.json --timeout-ms 300000 --env MCBOT_LIVE_FISHING_CATCHES=5 --env MCBOT_LIVE_FISHING_WATER_PICKUP_FALLBACK=0 --env MCBOT_LIVE_FISHING_DRY_INTERCEPT_REACH=4.5 --env MCBOT_LIVE_FISHING_LANDING_MOTION_MODE=auto --env MCBOT_LIVE_FISHING_REEL_INLAND_PULL_MS=450 --env MCBOT_LIVE_FISHING_DRY_LANDING_NUDGE_MS=650 --env MCBOT_LIVE_FISHING_MAX_DRY_PICKUP_ATTEMPTS=3 --env MCBOT_LIVE_FISHING_RUN_TIMEOUT_MS=280000`
- Cleanup:
  - Restored natural mob spawning.
- Result:
  - PASS.
  - Token: `live_supply_chest_fishing_fixture-20260524233639-527504d0`.
  - Telemetry: `<server-dir>\.\mcbottest\live_supply_chest_fishing_fixture-20260524233639-527504d0.jsonl`.
- Plugin telemetry counts:
  - `bot_move: 41`
  - `item_pickup: 5`
- Scenario behavior:
  - `allowWaterPickup:false`
  - `waterPickupFallback:false`
  - `fish.landing-plan: 5`
  - `fish.reel-inland-pull: 2`
  - `fish.dry-landing-nudge: 0`
  - at least one comfortable dry-runway plan held position with `catchLandingScore:17`, `reelInlandPull:false`, and `postReelNudge:false`
  - `fish.pickup-navigate: 3`
  - `fish.pickup-water-entry: 0`
  - `fish.pickup-water-target: 0`
  - caught and deposited `salmon:2` and `cod:3`
  - `standRecoveries:0`
  - `castRetries:0`

Validation:
- `node --check test\live_supply_chest_fishing_fixture.js src\skills\fishing_pickup_policy.js scripts\live-scenarios.js test\offline\fishing_pickup_policy.test.js test\offline\live_scenarios.test.js`: PASS.
- `node --test test\offline\fishing_pickup_policy.test.js test\offline\live_scenarios.test.js`: PASS; 31/31 tests.

Not implemented in this checkpoint:
- No public-server anti-cheat evasion or Watchdog tuning.
- No multi-hour unattended fishing proof.
- No plugin v1+ telemetry surface.

## Step 24d - Dry-Safe Fishing Pickup Follow-Up

Date: 2026-05-24

Implemented:
- Tightened fishing pickup after live observation showed caught items could still drift in water and the bot could spend too much time trying to chase them.
- Changed the default fishing pickup policy to stay dry:
  - `MCBOT_LIVE_FISHING_WATER_PICKUP_FALLBACK` now defaults to `0`.
  - Water entry requires explicit opt-in.
  - Stand selection now scores dry landing room and prefers inland dry stands instead of only the closest shore block.
  - After reeling, the fixture performs a short dry-landing nudge and then retries bounded shore-side pickup positions.
- Added policy tests for dry pickup decisions and stand ordering.

Live validation:
- RCON credentials were loaded from `<server-dir>\server.properties`; the password was not logged.
- Passing command:
  - `node scripts/run-live-scenario.js --scenario live_supply_chest_fishing_fixture --report reports/plugin-live-fishing-dry-pickup.json --timeout-ms 240000 --env MCBOT_LIVE_FISHING_CATCHES=3 --env MCBOT_LIVE_FISHING_WATER_PICKUP_FALLBACK=0 --env MCBOT_LIVE_FISHING_DRY_LANDING_NUDGE_MS=650 --env MCBOT_LIVE_FISHING_MAX_DRY_PICKUP_ATTEMPTS=3 --env MCBOT_LIVE_FISHING_RUN_TIMEOUT_MS=220000`
- Result:
  - PASS.
  - Token: `live_supply_chest_fishing_fixture-20260524230341-1ca221cc`.
  - Telemetry: `<server-dir>\.\mcbottest\live_supply_chest_fishing_fixture-20260524230341-1ca221cc.jsonl`.
- Plugin telemetry counts:
  - `scenario_start: 1`
  - `bot_move: 17`
  - `item_pickup: 3`
  - `scenario_end: 1`
- Scenario behavior:
  - The run used `allowWaterPickup:false` and `waterPickupFallback:false`.
  - The fixture logged three `fish.dry-landing-nudge` events and three `fish.pickup-wait` events.
  - The bot caught and deposited `salmon:3`, returned the fishing rod, and completed with `standRecoveries:0` and `castRetries:0`.

Validation:
- `node --check test\live_supply_chest_fishing_fixture.js`: PASS.
- `node --check src\skills\fishing_pickup_policy.js`: PASS.
- `node --test test\offline\fishing_pickup_policy.test.js test\offline\live_scenarios.test.js`: PASS; 28/28 tests.
- `node scripts\check-js.js`: PASS.
- `npm run test:all`: PASS; live phase2 wrapper skipped because `MCBOT_LIVE_TESTS` was unset for that default subcommand.

Not implemented in this checkpoint:
- No five-minute rerun under the new no-water-default pickup policy.
- No multi-hour unattended fishing proof.
- No plugin v1+ telemetry surface.

## Step 24e - Dry-Safe Five-Minute Fishing Soak

Date: 2026-05-24

Live validation:
- Setup:
  - RCON credentials were loaded from `<server-dir>\server.properties`; the password was not logged.
  - Disabled natural mob spawning.
  - Cleared non-player entities.
- Passing command:
  - `node scripts/run-live-scenario.js --scenario live_supply_chest_fishing_fixture --report reports/plugin-live-fishing-dry-five-minute-soak.json --timeout-ms 430000 --env MCBOT_LIVE_FISHING_DURATION_ONLY=1 --env MCBOT_LIVE_FISHING_DURATION_MS=300000 --env MCBOT_LIVE_FISHING_RETURN_RESERVE_MS=60000 --env MCBOT_LIVE_FISHING_DEPOSIT_INTERVAL_MS=90000 --env MCBOT_LIVE_FISHING_MIN_CATCHES=8 --env MCBOT_LIVE_FISHING_RUN_TIMEOUT_MS=390000 --env MCBOT_LIVE_FISHING_MAX_ITERATIONS=1000 --env MCBOT_LIVE_FISHING_WATER_PICKUP_FALLBACK=0 --env MCBOT_LIVE_FISHING_DRY_LANDING_NUDGE_MS=650 --env MCBOT_LIVE_FISHING_MAX_DRY_PICKUP_ATTEMPTS=3`
- Cleanup:
  - Restored natural mob spawning.
- Result:
  - PASS.
  - Token: `live_supply_chest_fishing_fixture-20260524230945-12106ce9`.
  - Telemetry: `<server-dir>\.\mcbottest\live_supply_chest_fishing_fixture-20260524230945-12106ce9.jsonl`.
- Plugin telemetry counts:
  - `scenario_start: 1`
  - `bot_move: 47`
  - `item_pickup: 13`
  - `scenario_end: 1`
- Plugin pickup summary:
  - `minecraft:cod: 3`
  - `minecraft:salmon: 7`
  - `minecraft:pufferfish: 3`
- Scenario behavior:
  - The run used `allowWaterPickup:false` and `waterPickupFallback:false`.
  - The fixture logged 13 `fish.dry-landing-nudge` events and 13 `fish.pickup-wait` events.
  - The bot caught 13 outputs against an 8-catch minimum.
  - The bot made interval deposits, resumed fishing each time, returned because the reserve was reached, deposited the final catches and fishing rod, and finished with `standRecoveries:0` and `castRetries:0`.
  - Child evidence recorded `durationMs:259232`, `durationTarget:300000`, `deadlineRemainingMs:40768`, `loopResult.reason:return-reserve-reached`, and `overdue:false`.

Validation:
- The code under test already passed `npm run test:all` in checkpoint `6f1ea86`.

Not implemented in this checkpoint:
- No multi-hour unattended fishing proof.
- No plugin v1+ telemetry surface.
