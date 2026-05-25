import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  buildLiveAdminPlan,
  rconConfigFromEnv,
  runLiveAdminPlan,
  validateLiveAdminEnv,
} from '../../scripts/live-admin-commands.js';

test('live admin plans deterministic private-server fixture commands', () => {
  assert.deepEqual(buildLiveAdminPlan(['fixture-single-zombie', '248', '68', '428']), {
    ok: true,
    action: 'fixture-single-zombie',
    commands: [
      'minecraft:kill @e[type=!player]',
      'summon minecraft:zombie 248 68 428',
    ],
  });

  assert.deepEqual(buildLiveAdminPlan(['summon-spider', '247.25', '63', '413.75']), {
    ok: true,
    action: 'summon-spider',
    commands: ['summon minecraft:spider 247.25 63 413.75'],
  });

  assert.deepEqual(buildLiveAdminPlan(['summon-zombie-fire-resistant', '247.25', '63', '413.75']), {
    ok: true,
    action: 'summon-zombie-fire-resistant',
    commands: [
      'summon minecraft:zombie 247.25 63 413.75',
      'effect give @e[type=minecraft:zombie,x=247.25,y=63,z=413.75,distance=..5,sort=nearest,limit=1] minecraft:fire_resistance 120 1 true',
    ],
  });

  assert.deepEqual(buildLiveAdminPlan(['summon-zombie-wave-fire-resistant', '3', '247.25', '63', '413.75']), {
    ok: true,
    action: 'summon-zombie-wave-fire-resistant',
    commands: [
      'summon minecraft:zombie 247.25 63 413.75',
      'summon minecraft:zombie 247.25 63 413.75',
      'summon minecraft:zombie 247.25 63 413.75',
      'effect give @e[type=minecraft:zombie,x=247.25,y=63,z=413.75,distance=..6] minecraft:fire_resistance 120 1 true',
    ],
  });

  assert.deepEqual(buildLiveAdminPlan(['mcbottest-spawn-zombie-fire-resistant', 'j_1_single-near-1', '247.25', '63', '413.75']), {
    ok: true,
    action: 'mcbottest-spawn-zombie-fire-resistant',
    commands: [
      'mcbottest spawn zombie 247.25 63 413.75 --tag j_1_single-near-1 --effects fire_resistance:120:1 --no-burn',
    ],
  });

  assert.deepEqual(buildLiveAdminPlan(['mcbottest-spawn-zombie-wave-fire-resistant', 'j_2_three-close', '3', '247.25', '63', '413.75']), {
    ok: true,
    action: 'mcbottest-spawn-zombie-wave-fire-resistant',
    commands: [
      'mcbottest spawn zombie 247.25 63 413.75 --tag j_2_three-close-1 --effects fire_resistance:120:1 --no-burn',
      'mcbottest spawn zombie 247.25 63 413.75 --tag j_2_three-close-2 --effects fire_resistance:120:1 --no-burn',
      'mcbottest spawn zombie 247.25 63 413.75 --tag j_2_three-close-3 --effects fire_resistance:120:1 --no-burn',
    ],
  });

  assert.deepEqual(buildLiveAdminPlan(['kill-zombies-near', '205.5', '68', '476.5', '24']), {
    ok: true,
    action: 'kill-zombies-near',
    commands: ['execute positioned 205.5 68 476.5 run minecraft:kill @e[type=minecraft:zombie,distance=..24]'],
  });

  assert.deepEqual(buildLiveAdminPlan(['fixture-single-zombie-fire-resistant', '248', '68', '428']), {
    ok: true,
    action: 'fixture-single-zombie-fire-resistant',
    commands: [
      'minecraft:kill @e[type=!player]',
      'summon minecraft:zombie 248 68 428',
      'effect give @e[type=minecraft:zombie,x=248,y=68,z=428,distance=..5,sort=nearest,limit=1] minecraft:fire_resistance 120 1 true',
    ],
  });

  assert.deepEqual(buildLiveAdminPlan(['give', 'MCBot', 'minecraft:cooked_beef', '8']), {
    ok: true,
    action: 'give',
    commands: ['give MCBot minecraft:cooked_beef 8'],
  });

  assert.deepEqual(buildLiveAdminPlan(['death-recovery-fall', 'MCBot', '120']), {
    ok: true,
    action: 'death-recovery-fall',
    commands: [
      'gamerule keep_inventory false',
      'gamerule fall_damage true',
      'minecraft:damage MCBot 120 minecraft:fall',
    ],
  });

  assert.deepEqual(buildLiveAdminPlan(['query-do-mob-spawning']), {
    ok: true,
    action: 'query-do-mob-spawning',
    commands: ['gamerule spawn_monsters'],
  });

  assert.deepEqual(buildLiveAdminPlan(['set-do-mob-spawning', 'false']), {
    ok: true,
    action: 'set-do-mob-spawning',
    commands: ['gamerule spawn_monsters false'],
  });

  assert.deepEqual(buildLiveAdminPlan(['teleport-player', 'MCBot', '247.5', '68', '428.5']), {
    ok: true,
    action: 'teleport-player',
    commands: ['minecraft:tp MCBot 247.5 68 428.5'],
  });
});

test('live admin rejects malformed actions and unsafe raw commands without gate', async () => {
  assert.match(buildLiveAdminPlan(['missing-action']).reason, /unknown live admin action/);
  assert.equal(buildLiveAdminPlan(['summon-zombie', 'x', '68', '428']).reason, 'position coordinates must be finite numbers');
  assert.equal(buildLiveAdminPlan(['summon-zombie-wave-fire-resistant', '9', '1', '64', '2']).reason, 'count must be a positive integer up to 8');
  assert.equal(buildLiveAdminPlan(['mcbottest-spawn-zombie-fire-resistant', 'not safe', '1', '64', '2']).reason, 'mcbottest-spawn-zombie-fire-resistant requires a safe tag');
  assert.equal(buildLiveAdminPlan(['mcbottest-spawn-zombie-wave-fire-resistant', 'j', '9', '1', '64', '2']).reason, 'count must be a positive integer up to 8');
  assert.equal(buildLiveAdminPlan(['kill-zombies-near', '1', '64']).reason, 'kill-zombies-near requires x y z [radius]');
  assert.equal(buildLiveAdminPlan(['kill-zombies-near', '1', '64', '2', '65']).reason, 'kill-zombies-near radius must be a positive number up to 64');
  assert.equal(buildLiveAdminPlan(['give', 'MCBot', 'minecraft:stone', '0']).reason, 'give count must be a positive integer');
  assert.equal(buildLiveAdminPlan(['death-recovery-fall', 'not-safe!', '100']).reason, 'death-recovery-fall requires a safe player name');
  assert.equal(buildLiveAdminPlan(['death-recovery-fall', 'MCBot', '0']).reason, 'death-recovery-fall amount must be a positive number up to 10000');
  assert.equal(buildLiveAdminPlan(['set-do-mob-spawning', 'maybe']).reason, 'set-do-mob-spawning requires true or false');
  assert.equal(buildLiveAdminPlan(['teleport-player', 'not-safe!', '247.5', '68', '428.5']).reason, 'teleport-player requires a safe player name');
  assert.equal(buildLiveAdminPlan(['teleport-player', 'MCBot', '247.5', '68']).reason, 'position requires x y z');

  const raw = buildLiveAdminPlan(['raw', '/time', 'set', 'day']);
  assert.deepEqual(raw, {
    ok: true,
    action: 'raw',
    commands: ['time set day'],
    raw: true,
  });
  await assert.rejects(
    () => runLiveAdminPlan(raw, {
      MCBOT_LIVE_TESTS: '1',
      MCBOT_LIVE_ADMIN_OK: '1',
      MCBOT_LIVE_ADMIN_DRY_RUN: '1',
    }),
    /without MCBOT_LIVE_ADMIN_RAW_OK=1/,
  );
});

test('live admin environment gates refuse accidental public or unconfigured execution', () => {
  assert.equal(validateLiveAdminEnv({}), 'refusing live admin command without MCBOT_LIVE_TESTS=1');
  assert.equal(validateLiveAdminEnv({ MCBOT_LIVE_TESTS: '1' }), 'refusing live admin command without MCBOT_LIVE_ADMIN_OK=1');
  assert.equal(validateLiveAdminEnv({
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_ADMIN_OK: '1',
    MCBOT_LIVE_ADMIN_MODE: 'desktop-console',
  }), 'unsupported MCBOT_LIVE_ADMIN_MODE="desktop-console"; supported mode is rcon');
  assert.equal(validateLiveAdminEnv({
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_ADMIN_OK: '1',
    MCBOT_LIVE_ADMIN_MODE: 'bot-chat',
  }), 'refusing live admin bot-chat mode; use RCON for server admin commands');
  assert.equal(validateLiveAdminEnv({
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_ADMIN_OK: '1',
    MCBOT_LIVE_ADMIN_MODE: 'bot-chat',
    MCBOT_LIVE_ADMIN_CHAT_OK: '1',
  }), 'refusing live admin bot-chat mode; use RCON for server admin commands');
  assert.equal(validateLiveAdminEnv({
    MCBOT_LIVE_TESTS: '1',
    MCBOT_LIVE_ADMIN_OK: '1',
  }), 'refusing live admin rcon command without MCBOT_RCON_PASSWORD');
});

test('live admin dry-run does not require rcon secrets and reports commands', async () => {
  const result = await runLiveAdminPlan(
    buildLiveAdminPlan(['fixture-single-spider', '1', '64', '2']),
    {
      MCBOT_LIVE_TESTS: '1',
      MCBOT_LIVE_ADMIN_OK: '1',
      MCBOT_LIVE_ADMIN_DRY_RUN: '1',
    },
  );

  assert.deepEqual(result, {
    ok: true,
    dryRun: true,
    action: 'fixture-single-spider',
    commands: [
      'minecraft:kill @e[type=!player]',
      'summon minecraft:spider 1 64 2',
    ],
  });
});

test('live admin uses injected transport for rcon execution', async () => {
  const calls = [];
  const result = await runLiveAdminPlan(
    buildLiveAdminPlan(['summon-zombie', '1', '64', '2']),
    {
      MCBOT_LIVE_TESTS: '1',
      MCBOT_LIVE_ADMIN_OK: '1',
      MCBOT_RCON_PASSWORD: 'secret',
      MCBOT_RCON_HOST: 'localhost',
      MCBOT_RCON_PORT: '25576',
    },
    async (config) => {
      calls.push(config);
      return [{ command: config.commands[0], response: 'Summoned new Zombie', type: 0 }];
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.mode, 'rcon');
  assert.equal(result.commandCount, 1);
  assert.equal(calls[0].host, 'localhost');
  assert.equal(calls[0].port, 25576);
  assert.deepEqual(calls[0].commands, ['summon minecraft:zombie 1 64 2']);
});

test('live admin refuses bot-chat execution even when explicitly requested', async () => {
  await assert.rejects(() => runLiveAdminPlan(
    buildLiveAdminPlan(['clear-non-players']),
    {
      MCBOT_LIVE_TESTS: '1',
      MCBOT_LIVE_ADMIN_OK: '1',
      MCBOT_LIVE_ADMIN_MODE: 'bot-chat',
      MCBOT_LIVE_ADMIN_CHAT_OK: '1',
      MCBOT_LIVE_ADMIN_CHAT_TIMEOUT_MS: '1234',
      MCBOT_LIVE_ADMIN_CHAT_COMMAND_DELAY_MS: '50',
    },
    async (config) => {
      return config.commands.map((command) => ({ command, response: 'sent via injected chat', type: 'bot-chat' }));
    },
  ), /refusing live admin bot-chat mode; use RCON for server admin commands/);
});

test('live admin rcon config uses safe defaults without exposing password in plans', () => {
  assert.deepEqual(rconConfigFromEnv({ MCBOT_RCON_PASSWORD: 'secret' }), {
    host: '127.0.0.1',
    port: 25575,
    password: 'secret',
    timeoutMs: 5000,
  });
});

test('live admin cli refuses execution before rcon import work', () => {
  const env = { ...process.env };
  delete env.MCBOT_LIVE_TESTS;
  delete env.MCBOT_LIVE_ADMIN_OK;
  delete env.MCBOT_RCON_PASSWORD;
  const result = spawnSync(process.execPath, ['scripts/live-admin.js', 'fixture-single-zombie', '248', '68', '428'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /without MCBOT_LIVE_TESTS=1/);
  assert.equal(result.stdout, '');
});
