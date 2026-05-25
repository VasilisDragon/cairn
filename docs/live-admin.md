# Live Admin Fixture Helper

This project now has an explicit private-server admin helper for live test setup.

The helper is for the user's local/private dev server only. It is gated separately from normal live tests and does not call DeepSeek.

## Why RCON

The current server was started from `D:\Minecraft\Server\start.bat` in a desktop console. Another process cannot safely attach to that existing console's stdin in a reliable way. Automating through RCON is the controlled path: commands are sent over the Minecraft server's normal remote console protocol, with explicit env gates and no secrets committed.

If RCON is not enabled for the current server process, the helper will fail with an exact reason or connection error. Enable RCON outside this repo when you want the helper to execute real commands; keep the password in environment variables only.

Admin commands must not be sent through the MCBot player session. `MCBOT_LIVE_ADMIN_MODE=bot-chat` is intentionally refused; use RCON-backed `npm run live:admin` or type commands manually into the server console/RCON client.

## Gates

Required for any live admin command:

- `MCBOT_LIVE_TESTS=1`
- `MCBOT_LIVE_ADMIN_OK=1`

Required for actual RCON execution:

- `MCBOT_RCON_PASSWORD=<server rcon password>`

Optional:

- `MCBOT_RCON_HOST=127.0.0.1`
- `MCBOT_RCON_PORT=25575`
- `MCBOT_RCON_TIMEOUT_MS=5000`
- `MCBOT_LIVE_ADMIN_DRY_RUN=1`
- `MCBOT_LIVE_ADMIN_RAW_OK=1`, only for `raw`

## Commands

Dry-run a clean single-zombie fixture:

```powershell
$env:MCBOT_LIVE_TESTS='1'
$env:MCBOT_LIVE_ADMIN_OK='1'
$env:MCBOT_LIVE_ADMIN_DRY_RUN='1'
npm run live:admin -- fixture-single-zombie 248 68 428
```

Run it for real through RCON:

```powershell
$env:MCBOT_LIVE_TESTS='1'
$env:MCBOT_LIVE_ADMIN_OK='1'
$env:MCBOT_RCON_PASSWORD='<set locally>'
npm run live:admin -- fixture-single-zombie 248 68 428
```

Useful actions:

- `clear-non-players`
- `summon-zombie x y z`
- `summon-zombie-fire-resistant x y z`
- `summon-zombie-wave-fire-resistant count x y z`
- `summon-spider x y z`
- `fixture-single-zombie x y z`
- `fixture-single-zombie-fire-resistant x y z`
- `fixture-single-spider x y z`
- `death-recovery-fall player [amount]`
- `give player item count`
- `raw command...`, only with `MCBOT_LIVE_ADMIN_RAW_OK=1`

The single-hostile fixture actions run:

```text
minecraft:kill @e[type=!player]
summon minecraft:zombie x y z
```

or the spider equivalent.

The fire-resistant zombie variants add a second command after summon:

```text
effect give @e[type=minecraft:zombie,x=x,y=y,z=z,distance=..5,sort=nearest,limit=1] minecraft:fire_resistance 120 1 true
```

Use those for daylight PvM fixtures so the test zombie does not burn before the bot can engage.

The wave variant is for the gated hostile-escalation fixture only. It summons up to eight zombies on the requested block and applies fire resistance to zombies within six blocks:

```text
summon minecraft:zombie x y z
...
effect give @e[type=minecraft:zombie,x=x,y=y,z=z,distance=..6] minecraft:fire_resistance 120 1 true
```

The death-recovery fall action runs:

```text
gamerule keep_inventory false
gamerule fall_damage true
minecraft:damage player amount minecraft:fall
```

Use it only after H has armed a proof item. It intentionally avoids player, lava, fire, and void death causes so the normal one-attempt drop recovery policy can be validated.

## Live Wrapper Setup

For E hostile flee validation, the live wrapper should clear entities before importing Mineflayer, then let the scenario summon exactly one hostile after the bot proves it is safely staged:

```powershell
$env:MCBOT_LIVE_TESTS='1'
$env:MCBOT_LIVE_SCENARIO='live_single_hostile_flee_fixture'
$env:MCBOT_LIVE_HOSTILE_FIXTURE_OK='1'
$env:MCBOT_LIVE_ADMIN_SETUP='1'
$env:MCBOT_LIVE_ADMIN_OK='1'
$env:MCBOT_RCON_PASSWORD='<set locally>'
$env:MCBOT_LIVE_HOSTILE_WAIT_MS='60000'
$env:MCBOT_LIVE_HOSTILE_POST_STAGING_ADMIN='1'
$env:MCBOT_LIVE_HOSTILE_POST_STAGING_ADMIN_ACTION='summon-zombie'
$env:MCBOT_LIVE_HOSTILE_POST_STAGING_SPAWN_MODE='near-bot'
npm run test:live
```

To verify the planned setup without connecting the bot:

```powershell
$env:MCBOT_LIVE_TESTS='1'
$env:MCBOT_LIVE_SCENARIO='live_single_hostile_flee_fixture'
$env:MCBOT_LIVE_HOSTILE_FIXTURE_OK='1'
$env:MCBOT_LIVE_ADMIN_SETUP='1'
$env:MCBOT_LIVE_ADMIN_SETUP_ONLY='1'
$env:MCBOT_LIVE_ADMIN_DRY_RUN='1'
$env:MCBOT_LIVE_ADMIN_OK='1'
npm run test:live
```

Override the hostile setup:

- `MCBOT_LIVE_HOSTILE_ADMIN_ACTION=clear-non-players|fixture-single-zombie|fixture-single-spider`
- `MCBOT_LIVE_HOSTILE_POST_STAGING_ADMIN=1`
- `MCBOT_LIVE_HOSTILE_POST_STAGING_ADMIN_ACTION=summon-zombie|summon-spider`
- `MCBOT_LIVE_HOSTILE_POST_STAGING_SPAWN_MODE=near-bot|fixed`
- `MCBOT_LIVE_HOSTILE_POST_STAGING_SPAWN_DX`
- `MCBOT_LIVE_HOSTILE_POST_STAGING_SPAWN_DY`
- `MCBOT_LIVE_HOSTILE_POST_STAGING_SPAWN_DZ`
- `MCBOT_LIVE_HOSTILE_SPAWN_X`
- `MCBOT_LIVE_HOSTILE_SPAWN_Y`
- `MCBOT_LIVE_HOSTILE_SPAWN_Z`
- `MCBOT_LIVE_PVM_ENGAGE_ADMIN_ACTION=clear-non-players|fixture-single-zombie|fixture-single-zombie-fire-resistant|fixture-single-spider`
- `MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_ADMIN=1`
- `MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_ADMIN_ACTION=summon-zombie|summon-zombie-fire-resistant|summon-spider`
- `MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_SPAWN_MODE=near-bot|fixed`
- `MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_SPAWN_DX`
- `MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_SPAWN_DY`
- `MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_SPAWN_DZ`
- `MCBOT_LIVE_PVM_ENGAGE_SPAWN_X`
- `MCBOT_LIVE_PVM_ENGAGE_SPAWN_Y`
- `MCBOT_LIVE_PVM_ENGAGE_SPAWN_Z`

For I PvM engage validation, the safer wrapper pattern is clear-before-import, gear and stage the bot, then post-gear summon a fire-resistant zombie near the bot:

```powershell
$env:MCBOT_LIVE_TESTS='1'
$env:MCBOT_LIVE_SCENARIO='live_single_hostile_engage_fixture'
$env:MCBOT_LIVE_PVM_ENGAGE_FIXTURE_OK='1'
$env:MCBOT_LIVE_ADMIN_SETUP='1'
$env:MCBOT_LIVE_ADMIN_OK='1'
$env:MCBOT_RCON_PASSWORD='<set locally>'
$env:MCBOT_LIVE_PVM_ENGAGE_WAIT_MS='60000'
$env:MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_ADMIN='1'
$env:MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_ADMIN_ACTION='summon-zombie-fire-resistant'
$env:MCBOT_LIVE_PVM_ENGAGE_POST_GEAR_SPAWN_MODE='near-bot'
npm run test:live
```

For J hostile escalation validation, the wrapper and scenario both require private-server admin opt-in. The scenario clears non-player entities, stages safely, then spawns one, three, and four fire-resistant zombie waves near the current bot position:

```powershell
$env:MCBOT_LIVE_TESTS='1'
$env:MCBOT_LIVE_SCENARIO='live_hostile_escalation_fixture'
$env:MCBOT_LIVE_HOSTILE_ESCALATION_FIXTURE_OK='1'
$env:MCBOT_LIVE_ADMIN_OK='1'
$env:MCBOT_RCON_PASSWORD='<set locally>'
npm run test:live
```

For H death/drop recovery validation, clear the area before import, then let the scenario trigger one fall-damage death only after it has withdrawn the proof item and logged `live_death_recovery_fixture.armed`:

```powershell
$env:MCBOT_LIVE_TESTS='1'
$env:MCBOT_LIVE_SCENARIO='live_death_recovery_fixture'
$env:MCBOT_LIVE_DEATH_RECOVERY_FIXTURE_OK='1'
$env:MCBOT_LIVE_DEATH_RECOVERY_ADMIN='1'
$env:MCBOT_LIVE_ADMIN_OK='1'
$env:MCBOT_RCON_PASSWORD='<set locally>'
npm run test:live
```
