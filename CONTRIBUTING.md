# Contributing

Architecture and conventions for contributors to Cairn.

For project overview, status, and setup, see the [README](README.md).

## Architecture contract

Three loops, three frequencies, three trust levels. A fourth humanization
layer is planned but does not give the LLM direct control. The LLM is a
**planner only** — it emits structured skill calls from a frozen
vocabulary. It never writes or runs code, never drives the bot directly,
never touches the reactive loop. This contract is the entire point of
the project; do not violate it for convenience.

### 1. Reactive loop — every physics tick, no LLM, hardcoded

The "DO NOT DIE" layer. A finite state machine with hard interrupt
priority over everything else.

Responsibilities:
- Auto-eat when hunger drops.
- Flee / retreat or engage when a hostile is in range (configurable).
- Abort movement near void / lava / fall hazards.
- Emergency disconnect (logout) on critical health when no safe option
  exists.

The LLM is never in this loop. It is too slow and too unreliable to be
trusted with survival. Death-avoidance is a coded guarantee.

### 2. Skill executor loop — per-action, deterministic

Executes exactly one skill at a time from a sequential queue.

Every skill returns:

```js
{ ok: boolean, reason: string, state: <world-state snapshot> }
```

Skills are thin wrappers over the Mineflayer plugin ecosystem. The
reactive loop can interrupt and pause the active skill.

### 3. Advisor loop — DeepSeek, on skill-failure or mission checkpoint

Consumes a compact world-state snapshot, compares current state against
the goal, decomposes the goal into an ordered queue of skill calls, and
re-plans whenever a skill reports `ok: false` or a real mission
condition forces a replan.

- Default frontier model is `deepseek-v4-pro`. Verified against DeepSeek
  API docs on 2026-05-24 in `docs/deepseek-model-verification.md`.
- DeepSeek reasoning/thinking output is allowed. The strict JSON
  contract applies to the final planner-consumed answer, not to
  provider-side reasoning tokens.
- Calls are deliberately fewer, smarter, and slower than the earlier
  v4-flash loop. Do not design around cheap high-frequency polling.
- Planner-consumed output is **strict JSON only** (an ordered list of
  skill calls), no prose.
- Every plan is validated against the skill schema; malformed output is
  rejected with a repair request.
- Keep the context tight.

### 4. Humanization layer — planned, deterministic, gated

When `MCBOT_HUMANIZE=1`, executor intent passes through a deterministic
humanization layer before Mineflayer actions: bounded aim curves,
vanilla-limited rotation and reach, plausible click cadence, reaction
delay distributions, movement entropy, idle behavior, and occasional
corrected mistakes. Critical survival reflexes are exempt from delay
but logged for audit. This layer must satisfy anti-cheat invariants and
is not a public-server bypass feature.

## Frozen skill vocabulary

These names and their parameter schemas are a contract DeepSeek plans
against. Adding or changing a skill means updating **both** the schema
and the advisor system prompt.

| Skill | Purpose |
|---|---|
| `observe` | Refresh and return a world-state snapshot. |
| `goto` | Pathfind to a coordinate, entity, or named block. |
| `collect` | Mine N of a target block (handles tool selection and pickup via mineflayer-collectblock). |
| `deposit` | Deposit items into a target chest. |
| `craft` | Craft an item by recipe name and count, using a crafting table if needed. |
| `equip` | Equip an item into a slot (hand, head, chest, legs, feet, off-hand). |
| `flee` | Move away from a position or entity for a duration / distance. |
| `logout` | Disconnect cleanly. |
| `build_from_schematic` | Place blocks from a schematic at an anchor. **Stub in early phases.** |

Every skill returns `{ ok, reason, state }`. The full parameter schema
lives in `src/skills/schema.js` and is the source of truth for both
validation and the advisor system prompt.

## World-state snapshot

A compact structured JSON object regenerated each tick the advisor needs
it. This is what gets fed to DeepSeek.

Fields:
- `position` — `{ x, y, z, dimension }`
- `health`, `food`, `saturation`
- `inventory` — summarized: array of `{ name, count }`, grouped
- `nearbyHostiles` — array of `{ name, distance }` (capped)
- `timeOfDay` — `day | night | dusk | dawn`
- `currentSubtask` — string or null
- `remainingQueue` — array of skill calls

## Account regimes

`account.regime` selects between two operational modes.

**Regime A — test / private-LAN** (default for all development):
- Uses an offline account with `auth: "offline"`.
- No Microsoft credentials, no risk of session conflict with a real
  account.

**Regime B — production / online-auth**:
- Uses a Microsoft/Mojang-authenticated account.
- Operator must log out of their normal client before starting the bot
  until the Fabric handoff bridge ships.
- Online auth relies on Mineflayer/Microsoft token caching and never
  stores plaintext credentials.
- If the same account logs in elsewhere and kicks the bot, the kick
  reason is detected and reconnect is refused for a configurable
  cooldown, default 60s. This handler is Regime-B-only and does not run
  for `auth: "offline"`.
- Clean take-back: `!logout` from a recognized authority channel and
  SIGINT graceful disconnect.

## Pathfinder ownership

There is exactly one shared `bot.pathfinder` per bot. All writes to it
go through `bot.pathfinderOwner` (`src/control/pathfinder.js`). Direct
calls to `bot.pathfinder.setGoal` / `setMovements` / `stop` anywhere
outside that file are bugs.

Contract:
- Reactive always outranks skills. `acquire('reactive')` always succeeds
  and preempts any skill holder by aborting its `AbortController` and
  calling `bot.pathfinder.stop()` (mineflayer-collectblock catches the
  resulting `PathStopped` cleanly; direct-setGoal skills observe their
  signal aborting).
- `acquire('skill')` returns `null` if reactive holds the token; the
  skill returns `{ preempted: true, ... }` and the executor resumes it
  after the quiescence debounce (`config.reactive.resumeDebounceMs`).
- Skills carry `ctx.callState` across preempt/resume cycles. Fungible-
  target skills (`collect`, `goto{block}`) maintain a per-target
  interruption counter and exclude targets after
  `config.reactive.maxInterruptionsPerTarget` preempts; locked-target
  skills (`goto{xyz}`, `goto{entity}`, `deposit`, `craft`, `flee`)
  resume the same target indefinitely and escalate to the advisor only
  on real failure.

The token logic is intentionally minimal today (reactive-vs-skill
priority only). Richer arbitration (skill-vs-skill, fairness, lanes) is
a drop-in change to `src/control/pathfinder.js`, not a hunt across call
sites.

## Safety posture

- The advisor never executes arbitrary code and never touches the
  reactive loop.
- The only thing crossing the LLM boundary is **validated, schema-
  conforming skill calls in** and a **world-state snapshot out**.
- All LLM output is validated before any skill runs. Malformed output
  is rejected and re-prompted; partial or unknown skills never execute.
- The reactive loop has hard interrupt priority. It pauses the executor
  and the advisor when triggered.

## Known limitations

- **Fire hazard is not handled.** Mineflayer 4.37 exposes
  `entity.crouching` and `entity.elytraFlying` from the shared_flags
  byte but not the on-fire bit. Health-delta detection has too many
  false positives, so the fire branch is a follow-up.
- **`build_from_schematic` functional correctness** is out of scope; the
  skill is a stub in the published vocabulary.

## Logging conventions

- All logs go through `src/logger.js` (pino-style JSON to stdout when
  not a TTY; pretty when TTY).
- Required event fields: `t` (ISO time), `lvl`, `loop` (reactive |
  executor | advisor | bot | startup), `evt`, plus event-specific
  fields.
- Every state transition, every skill `invoke` / `result`, every
  advisor `plan` / `validate` / `replan` is logged. No silent paths.
- Heavy structured logging is intentional, not debt — it is how the
  bot's behavior is observed.

## Decision log

- **MC version:** 1.21.11. Empirically verified that
  minecraft-data 3.110.2 has 1.21.11 with all blocks, items, foods, and
  recipes used by Cairn, and that mineflayer 4.37.1 plus all six
  plugins load cleanly on `version: "1.21.11"`.
- **Base choice:** fresh build on raw Mineflayer plus the listed
  plugins. `mindcraft-ce` was deliberately not used as a base — its
  "LLM writes and executes commands" loop conflicts with the
  advisor-only, frozen-vocabulary, no-code-execution contract; bending
  it would be more work than greenfield.
- **Advisor model:** `deepseek-v4-pro` — official-doc verified frontier
  default. Reasoning/thinking output may exist; final planner content
  must be strict JSON.
- **Loop frequency:** fewer, smarter, slower advisor calls. Prefer
  cached validated plans unless a real failure or mission condition
  forces a replan, especially as the cost ceiling approaches.

## Conventions

- State the expected behavior of a code path in one sentence before
  debugging a symptom in it. If that sentence cannot be written, that
  is the first thing to figure out.
- When troubleshooting interactively, send one diagnostic at a time and
  observe the response before pre-writing fix branches for outcomes
  that have not happened yet.
- Commit in logical chunks with messages that describe the change.
