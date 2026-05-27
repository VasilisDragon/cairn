# Cairn

A reliability-first AI Minecraft agent. An LLM plans strategy; deterministic
code handles survival, validates every plan, and executes the actions. The
LLM has no direct survival authority — reactive survival runs outside the
model path and preempts unsafe execution before advisor plans reach the
world. Plans are also bounded against unknown skills, stale snapshots, and
vanilla-limit violations before activation.

Built on Mineflayer for the Java Edition Minecraft protocol. Tested on
private 1.21.x Paper servers. Status: **iron-tier autonomous progression
live-proven** across forest, jungle, and hilly terrain (5 successful
close-out runs, ~$0.06 advisor cost, ~187s skill runtime; matrix at
[reports/overnight-phase2/iron-tier-reliability.md](reports/overnight-phase2/iron-tier-reliability.md)).
Higher-tier and combat substrate continue under private fixtures
pending substrate maturity. See [Status](#status) for the full maturity
breakdown.

## What's different about it

Most LLM-driven Minecraft agents (Voyager, Mindcraft, JARVIS-1) let the
language model author or call arbitrary code at runtime. The model is in
the survival loop, the action loop, and the planning loop simultaneously.
Reliability suffers — bots hallucinate skills, get stuck in unproductive
loops, and die from slow or wrong model output.

Cairn takes the opposite architectural bet:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Advisor (LLM)        — DeepSeek frontier model, planner only        │
│  ↓ emits validated JSON skill calls from a FROZEN vocabulary         │
├─────────────────────────────────────────────────────────────────────┤
│  Plan activation guard — re-validates every plan against a fresh     │
│                          world snapshot before the executor sees it  │
├─────────────────────────────────────────────────────────────────────┤
│  Skill executor       — runs one validated skill at a time, queue    │
│                          with preempt/resume, structured returns     │
├─────────────────────────────────────────────────────────────────────┤
│  Reactive loop        — DO NOT DIE. Hardcoded FSM, no LLM, every     │
│                          tick. Hard interrupt priority over all      │
│                          above layers. Auto-eat, flee, hazard abort, │
│                          emergency logout.                            │
├─────────────────────────────────────────────────────────────────────┤
│  Mineflayer + plugins — pathfinder, collectblock, auto-eat, pvp,     │
│                          tool, armor-manager, statemachine           │
└─────────────────────────────────────────────────────────────────────┘
```

Three properties fall out of this architecture that don't exist in other
LLM-Minecraft projects:

1. **The LLM has no direct survival authority.** Reactive survival runs
   outside the model path on every physics tick with hard interrupt
   priority. If the LLM hangs, mis-plans, or issues an unsafe sequence,
   reactive overrides it before the plan reaches the world.
2. **The LLM cannot hallucinate skills.** Output is validated against a
   frozen vocabulary defined in `src/skills/schema.js`. Unknown skills
   or malformed parameters are rejected before activation.
3. **Stale plans cannot execute.** Every plan is re-validated against a
   fresh world snapshot at the executor boundary. A plan that became
   unsafe in the 200ms between proposal and execution is rejected.

The model is `deepseek-v4-pro` by default (configurable via
`DEEPSEEK_MODEL`), called as a chain-of-thought planner. Per-session API
cost is capped via `MCBOT_ADVISOR_COST_USD_MAX` with structured fallback
at 50%/90%/100% of the ceiling.

## Architecture

Four loops, four trust levels:

| Loop | Frequency | Trust | Responsibility |
|---|---|---|---|
| Reactive | every tick | hardcoded | DO NOT DIE — auto-eat, flee, hazard abort, emergency logout |
| Executor | per-action | deterministic | run one skill at a time from validated queue |
| Advisor (LLM) | on demand / skill failure | validated output only | emit ordered JSON skill calls from frozen vocabulary |

The reactive loop has **hard interrupt priority** over everything else.
A reactive event aborts the active skill, preempts pathfinding, and is
the only path that can issue an emergency logout. The LLM is never in
this loop and never makes survival decisions.

The frozen skill vocabulary (full schema in `src/skills/schema.js`):

| Skill | Purpose |
|---|---|
| `observe` | Refresh and return a world-state snapshot. |
| `goto` | Pathfind to a coordinate, entity, or named block. |
| `collect` | Mine N of a target block (handles tool selection and pickup). |
| `deposit` | Deposit items into a target chest. |
| `craft` | Craft an item by recipe name and count. |
| `equip` | Equip an item into a slot. |
| `consume` | Eat food or drink a potion. |
| `flee` | Move away from a position or entity for a duration / distance. |
| `recover_drops` | Recover items from a death location. |
| `logout` | Disconnect cleanly. |
| `build_from_schematic` | Place blocks from a `.schem` file at an anchor. |
| `mining_with_progression` | Mining mission with tool progression and return planning. |
| `fish_and_deposit` | Timed fishing mission with deposit + return-by-deadline. |

Each skill returns `{ ok: boolean, reason: string, state: snapshot }`.
The advisor sees only this contract — never raw Mineflayer APIs.

## Status

Honest current state, by maturity tier:

**Live-proven on private 1.21.x Paper server (working today):**
- **Iron-tier autonomous progression**: from-empty inventory to
  `iron_pickaxe` via the `mine_with_progression` composer. 5 successful
  close-out runs across forest, jungle, and hilly fixtures (3/3 forest,
  1/1 jungle, 1/2 hilly after a fixture-coordinate retry); ~$0.06
  advisor spend per run; reproducible via
  `scripts/iron-tier-verify-live.js` behind `MCBOT_LIVE_TESTS=1`.
  Matrix: [reports/overnight-phase2/iron-tier-reliability.md](reports/overnight-phase2/iron-tier-reliability.md)
- F1: real DeepSeek frontier-model call captured, validated, replayed
- F2: live `gather 10 oak logs` end-to-end with cost ceiling enforced
  and induced hostile flee survived
- J: hostile escalation fixture (1-3-4 fire-resistant zombie waves)
- K: PvM escalation decision (engage → flee transition on threat-set
  change)
- Mining soak fixture, supply-chest fishing, death recovery
- Calibration ladder: stale plan rejection, unsafe plan rejection,
  recovery handling, activation rejection cases
- Test harness Paper plugin v0 for repeatable scenario telemetry

**Offline-covered (passes ~100 tests, not yet live-proven):**
- Multi-hour mission reliability
- Plan activation guard, queue boundary, schema validation
- Account regime A (test) and B (production) selectors
- `!logout` chat command + SIGINT graceful shutdown
- World model snapshot pipeline
- Mission controllers (mining, fishing, deposit, return-by-deadline)

**Scaffolded / in progress:**
- C4 combat heuristic extraction
- C5 Phase 1 prismarine-viewer integration
- Optional behavior-shaping refinements (see [Optional behavior shaping](#optional-behavior-shaping) below)

**Planned, not started:**
- C5 Phase 2 Fabric client mod (same-account same-session takeover)
- C6 multi-hour live soak proofs
- C7 memory & social model
- C8 per-server observation + behavioral priors
- C9 anomaly detection + chat reply

See [`docs/goal.det-autonomy-v1.md`](docs/goal.det-autonomy-v1.md) for the
long-form architecture contract and acceptance criteria.

## Setup

Requires:
- Node.js 22+
- A private Minecraft server you own or are explicitly authorized to
  automate on (LAN offline-auth works for development; online-auth
  Microsoft accounts require explicit opt-in)
- A DeepSeek API key (or any OpenAI-compatible endpoint)

Install:

```bash
git clone https://github.com/VasilisDragon/cairn.git
cd cairn
npm install
```

Configure:

```bash
cp config.example.json config.json
cp keys.example.json keys.json
# Edit keys.json with your DEEPSEEK_API_KEY
# Edit config.json for your server (host, port, version)
```

Run an offline phase test (no DeepSeek calls):

```bash
npm run phase0   # connect + 3 snapshots
npm run phase1   # reactive FSM running
npm run phase2   # scripted collect 10 oak logs + deposit
```

Run the offline test suite (~100 tests):

```bash
npm test
```

Run a live DeepSeek-driven plan (requires explicit opt-in via env):

```bash
MCBOT_ALLOW_DEEPSEEK=1 MCBOT_LIVE_TESTS=1 npm start -- "gather 10 oak logs"
```

The cost ceiling defaults to **$2.00/session**. Override with
`MCBOT_ADVISOR_COST_USD_MAX`.

## Project layout

```
src/
├── reactive/           Hardcoded survival FSM (no LLM)
├── executor/           Skill queue with preempt/resume
├── behavior_shaping/   Optional, gated, off-by-default action timing wrapper
├── advisor/            DeepSeek planner integration
├── skills/             Frozen skill vocabulary + schema
├── control/            Pathfinder ownership chokepoint, dig-time fallback
├── state/              World model + snapshot pipeline
├── runtime/            Process lifecycle, logout controls
├── goal/               Phase-shift gate, capability matrix
├── benchmarks/         Mission reliability + ladder
├── account_regime.js   Test/production account selector
└── bot.js              Mineflayer + plugin construction

test/
├── offline/            ~100 unit & integration tests (no live server)
├── live_*              Live fixtures gated behind MCBOT_LIVE_TESTS=1
└── phase[0-3]_*.js     Phased manual test scripts

docs/
├── goal.det-autonomy-v1.md   Long-form architecture contract and acceptance criteria
├── test-harness-plugin.md    Paper plugin setup and protocol
├── oversight-handoff.md      Viewer and handoff plans
├── awareness-and-chat.md     Anomaly detection + chat reply design
├── observation-and-priors.md Per-user behavioral priors design
├── handoff-architecture.md   Same-account handoff design (Fabric mod)
├── combat-heuristics-extracted.md   Combat tactic notes
├── authorized-use-and-scope.md   Authorized-use scope and risk notes
├── deepseek-model-verification.md   Model identifier verification
└── live-admin.md             Private RCON live-admin workflow

test-harness-plugin/    Local Paper plugin for repeatable private-server telemetry
scripts/                CLI entry points for each major subsystem
reports/                Generated artifacts from test runs (regenerated)
```

## Configuration

See [`config.example.json`](config.example.json) for the full surface.
Key sections:

- `account.regime` — `test` (LAN, offline `MCBot` account) or
  `production` (user's own Microsoft account, post-F4 only)
- `minecraft` — host, port, version, username, auth
- `reactive` — survival thresholds, flee/engage tuning, hazard sensitivity
- `executor` — task budgets, preempt/resume timing
- `advisor` — cost ceiling, prompt limits, retry behavior

Secrets (`DEEPSEEK_API_KEY`, etc.) go in `keys.json` (gitignored) or
environment variables.

## Safety and scope

The reactive layer remains hardcoded and outside LLM influence by
design. The frozen skill vocabulary is the only path through which the
LLM affects the world. Deterministic validators enforce vanilla physics
limits (rotation rate, action cadence, reach distance, jump kinematics)
so the executor cannot emit impossible action records — these protect
the bot's own state machine from logic bugs, not as a detection-evasion
mechanism.

This project is for **authorized private/LAN use only**. The default
`account.regime: 'test'` config prevents accidental production logins.

## Optional behavior shaping

The `src/behavior_shaping/` module is an opt-in deterministic wrapper
around action timing — aim curve interpolation, click-cadence floors,
reach validation, optional idle micro-behaviors when the executor is
genuinely idle. It exists for the operator to experiment with
plausibility on **servers they own** during personal testing.

It is **disabled by default**, and the install path in `src/bot.js`
gates it with two refusals:

- Requires `account.regime === 'private'`. The shipped default is
  `'test'`, so a fresh clone never loads it.
- Refuses to install on `auth: 'microsoft'` sessions outright. Behavior
  shaping never runs against a Mojang-authenticated account, regardless
  of regime.

If either gate fails, the install logs the reason and falls through to
the unwrapped action path. There is no override flag. Running this
module against a server you do not own or have explicit authorization
to automate on is outside the supported scope of this project.

## Testing

```bash
npm run check          # JS syntax / module check across all source files
npm run test:unit      # Offline test suite
npm run test:grep      # Pathfinder ownership chokepoint enforcement
npm run test:det       # Deterministic evaluation + capability matrix
npm run test:all       # Above, plus gated live phase2 fixture
```

Live fixtures (A–K scenarios) are gated behind `MCBOT_LIVE_TESTS=1` and
require RCON credentials. See [`docs/test-harness-plugin.md`](docs/test-harness-plugin.md)
for the plugin-backed scenario runner.

## Technology

- **Runtime:** Node.js 22+, ES modules
- **Bot:** [mineflayer](https://github.com/PrismarineJS/mineflayer)
  ^4.37
- **Movement:** mineflayer-pathfinder, with a defensive ownership
  chokepoint at `src/control/pathfinder.js`
- **Survival plugins:** mineflayer-auto-eat, mineflayer-pvp,
  mineflayer-tool, mineflayer-armor-manager, mineflayer-statemachine
- **Tasks:** mineflayer-collectblock
- **LLM:** DeepSeek via OpenAI-compatible client (`openai` npm package);
  default model `deepseek-v4-pro`
- **Game data:** minecraft-data (with local dig-time corrections at
  `src/control/dig_time.js` for known registry errors on modern ores)
- **Server-side test harness:** Paper plugin (Java 21, Paper API for
  MC 1.21.x), source under `test-harness-plugin/`

## License

All rights reserved. This project is in active development and not yet
licensed for public redistribution.

## Acknowledgments

- The [PrismarineJS](https://github.com/PrismarineJS) ecosystem — Mineflayer
  and the plugin family this project builds on
- The Minecraft Wiki contributors for the [Breaking page](https://minecraft.wiki/w/Breaking)
  formulas referenced in `src/control/dig_time.js`
- Prior LLM-Minecraft work — [Voyager](https://github.com/MineDojo/Voyager),
  [Mindcraft](https://github.com/kolbytn/mindcraft), and the published
  research that established the patterns this project deliberately
  diverges from
- [AltoClef](https://github.com/MiranCZ/altoclef) — the first bot to
  autonomously beat Minecraft (2021), proving deterministic task
  decomposition can carry an agent end-to-end, which informed the
  decision to keep the LLM strictly as a planner rather than a code
  generator
