# Cairn — Deterministic Autonomy V1 to SOTA Track

## Objective

Build MCBot's deterministic Minecraft body into a robust v1 autonomy substrate, then force the first real DeepSeek integration and move into the SOTA-track roadmap.

This is broader than fixing mob avoidance. The target is a general-purpose deterministic agent layer that can survive, navigate, gather, deposit, craft, handle hazards, recover from interruptions, build useful world-state memory, and expose a clean interface that DeepSeek can safely plan against.

The deterministic-v1 end state is not "perfect Minecraft for every possible situation." It is a tested, extensible substrate with:
- strong survival reflexes,
- deterministic combat/PvP primitives suitable for later authorized high-level PvP planning,
- reliable skill execution,
- clean pathfinder/queue ownership,
- progress watchdogs,
- world-query chunk gates,
- basic terrain/water/tree handling,
- repeatable automated tests,
- optional live scenario tests,
- persistent status/eval logs,
- and a world-model foundation that can later feed DeepSeek.

The active project now continues past deterministic-v1 into the first live DeepSeek calls. Before F1, do not spend API tokens. At F1 and F2, DeepSeek calls are allowed only through the explicit opt-in gates, private capture paths, cost controls, and Regime A private-LAN test server flow documented below.

## Project architecture contract

MCBot has three layers today, becoming four when the C1 humanization layer is introduced:

1. Reactive survival layer
   - Hardcoded.
   - No LLM.
   - Highest priority.
   - Prevent death: flee, eat, escape hazards, avoid drowning, avoid lava/void/falls, emergency logout.

2. Deterministic skill executor
   - Runs validated skills.
   - Skills include observe, goto, collect, deposit, craft, equip, consume, flee, logout, recover_drops, build_from_schematic.
   - Skills must be resumable or cleanly preemptible.
   - Reactive preemptions are not advisor failures.

3. DeepSeek advisor
   - Planner only.
   - Emits validated JSON skill calls from the advisor-callable skill subset only.
   - Runtime-only skills such as `recover_drops` are scheduled internally by deterministic systems, not by DeepSeek.
   - Never directly touches pathfinder, survival, raw Mineflayer APIs, or arbitrary code execution.
   - Its first real authority comes only after F1/F2 gates prove response capture, schema validation, activation acceptance, cost logging, and private-server execution.

4. Humanization layer (C1, future)
   - Deterministic execution adapter between skill intent and Mineflayer/client actions.
   - Shapes look, click, movement, and idle behavior into human-plausible timing while preserving vanilla limits.
   - Never grants illegal reach, packet spoofing, impossible rotations, or public-server evasion behavior.

Keep this separation intact. Reactive survival remains highest priority even after DeepSeek and humanization are added.

## Required first read

Before changing code, read:

- README.md
- package.json
- src/config.js
- src/bot.js
- src/control/pathfinder.js
- src/reactive/reactive.js
- src/reactive/flee_goal.js
- src/executor/queue.js
- src/skills/*
- src/state/*
- src/advisor/*
- test/*

Then write/update docs/status.md with:

- current branch and latest commits,
- fixed items,
- active risks,
- parked bugs,
- do-not-touch items,
- test commands,
- live-test availability,
- current best known deterministic score.

## Hard constraints

- Do not edit keys.json, .env, secrets, or API keys.
- Do not call DeepSeek before F1. F1 and F2 may call DeepSeek only through explicit opt-in gates, private capture paths, and cost controls.
- Do not spend API tokens before F1. Every later call must log latency, token/cost data, and validation outcome.
- Do not grant DeepSeek direct execution authority; it remains a planner behind schema validation and activation guards.
- Do not connect to public servers.
- Do not grief, steal, or destructively modify any live world outside explicit private/local test fixtures.
- Do not modify server.properties.
- Do not build public-server cheating, anti-cheat bypasses, packet spoofing, kill-aura, aimbot, impossible rotations, or other behavior intended to evade server rules. PvP work is for private/local/authorized fixtures and should obey normal game mechanics and fair-play input constraints.
- Do not op accounts, create accounts, or change server admin state unless an explicit local-only test config already exists.
- Do not claim live behavior is verified unless an actual live test was run and logs prove it.
- Keep every direct bot.pathfinder.setGoal / setMovements / stop call behind src/control/pathfinder.js unless intentionally internal and documented.
- Keep diffs reviewable. Commit after each milestone.

## Work loop

Repeat this loop until acceptance criteria are met or a stop condition triggers:

1. Run baseline checks.
2. Identify the highest-risk deterministic failure remaining.
3. Add or improve a test/eval that exposes it.
4. Make one focused implementation change.
5. Re-run tests/evals.
6. Record the result in a progress log entry.
7. Commit the checkpoint.
8. Continue to the next bottleneck.

Do not just implement a wishlist. Build an eval loop that keeps finding and shrinking failure modes.

## Baseline commands

Create or standardize these scripts if missing:

- npm run check
  - node --check all JS files.
- npm run test:unit
  - offline unit/mocked tests.
- npm run test:det
  - deterministic substrate regression suite.
- npm run test:grep
  - grep for forbidden direct pathfinder writes outside src/control/pathfinder.js.
- npm run test:live:phase2
  - optional live scenario wrapper, only if local live test config exists.
- npm run test:all
  - check + unit + deterministic + grep, and live tests only when explicitly enabled.

If the current package scripts are different, preserve existing scripts and add these where useful.

## Live test policy

Prefer offline/mocked tests when possible.

If a local Minecraft server is already running and config permits live testing, contributors may run non-destructive live tests. Live tests must be local/private only. If live tests require spawning mobs, changing time, changing difficulty, teleporting, OP, RCON, or server admin actions, do not improvise. Instead:

- create an optional untracked live-test config template;
- document required server setup;
- write the test harness;
- skip the live test if credentials/config are absent.

A missing live server is not a blocker. Build the tests/harness and clearly mark live verification pending.

## Milestone 0 — Audit and guardrails

Deliverables:

- a progress log location for checkpoint records
- npm scripts for check/test/grep
- a grep-based invariant proving all pathfinder writes go through the ownership chokepoint
- a short architecture summary confirming no DeepSeek/advisor behavior changed

Check:
- node --check all JS files
- npm ls
- git status --short

## Milestone 1 — Test harness and deterministic eval framework

Build the testing infrastructure needed for unattended refinement.

Add or improve tests for:

- PathfinderOwner ownership/preempt/release invariants.
- Stale token no-op behavior.
- Reactive outranks skill.
- Skill cannot touch pathfinder while reactive owns it.
- Queue preempt does not become queue failure.
- Quiescence before resume.
- Chunk-ready gate before world-querying skills.
- Collect dig cancellation and stopDigging behavior.
- Skill timeout vs progress watchdog distinction.
- Structured logging shape.

Add an eval summary artifact, for example:

- reports/deterministic-eval.json
- reports/deterministic-eval.md

It should show:
- tests run,
- pass/fail,
- scenario category,
- last changed files,
- remaining risks.

## Milestone 2 — Survival/reflex robustness

Harden the DO-NOT-DIE layer.

Cover at minimum:

1. Hostile flee
   - single hostile,
   - multi-hostile threat set,
   - no target-flip oscillation,
   - distance/liveness logging,
   - sprint state logging,
   - pathfinder not idle while FLEEING.

2. Health/food
   - auto-eat behavior,
   - low-health flee,
   - critical logout,
   - no stale-low-health reconnect loop if preventable.

3. Water/drowning
   - detect submersion / oxygen depletion / sinking,
   - surface or path to land,
   - avoid silent drowning,
   - progress watchdog for water pathing.

4. Fire/lava
   - detect on-fire only through reliable API; no generic health-delta false positives,
   - existing water source escape if reachable,
   - water bucket fallback only outside Nether if implementation is reliable,
   - lava adjacency/flow safety.

5. Fall/void/tree hazards
   - do not treat normal tree canopy traversal as cliff danger,
   - fall hazard should require actual falling/downward velocity or real dangerous drop,
   - keep real cliff/void detection.

6. Stuck detection
   - if position/progress does not change for N seconds during pathing, emit structured stuck event,
   - attempt local recovery if deterministic,
   - otherwise fail cleanly.

Do not make the bot less cautious to pass tests. Survival wins.

## Milestone 3 — Navigation substrate

Improve goto/pathing reliability across normal survival terrain.

Cover:

- flat terrain,
- hills,
- shallow holes,
- leaves/canopy,
- stairs/slabs/fences/gates if supported,
- water edge cases,
- avoiding lava/cactus/magma,
- avoiding known player-made protected regions if world-model flags them,
- reasonable path timeout and progress reporting.

Every goto-like skill should return actionable failure reasons:
- no path,
- timed out,
- stuck,
- unsafe route,
- reactive preempted,
- target disappeared,
- chunk data unavailable.

## Milestone 4 — Skill reliability

Harden each deterministic skill.

observe:
- include compact but useful state.
- include current reactive state, current skill, queue length, nearby hostiles, hazard flags.

goto:
- support fixed coordinate, block target, entity target if currently implemented.
- block target should use exclusion/retry for fungible targets.
- fixed/entity target should resume locked target.

collect:
- prefer reachable/same-cluster targets before global-nearest.
- avoid needless wandering between adjacent logs.
- maintain per-target interruption counters.
- exclude bad targets after threshold.
- detect target disappeared.
- detect no drops due to spawn protection or protected region where possible.
- update inventory delta accurately.
- avoid breaking support under itself when feasible.
- add watchdog for no progress.

deposit:
- lock chest target once selected.
- resume same chest after preempt.
- close/open containers safely.
- fail only on real issues: chest gone, unreachable, inventory mismatch.

craft:
- handle inventory recipes and crafting-table recipes.
- lock crafting table target once selected.
- report missing ingredients clearly.
- do not rescan to a different table after every preempt.

equip:
- deterministic item selection.
- clear failure reasons.

logout:
- reliable safe logout.

build_from_schematic:
- keep DeepSeek out.
- Implement at least a deterministic scaffold if feasible:
  - parse or define interface for schematic/litematica/schem input,
  - material bill of materials,
  - dry-run placement plan,
  - placement order representation,
  - blocked/unsafe placement detection,
  - return actionable missing-material list.
- If full placement is too large, implement BOM + dry-run planner + tests and document the remaining placement steps.

## Milestone 5 — Inventory, materials, and crafting automation

Build deterministic support for larger tasks.

Add utilities for:

- inventory counts,
- chest scanning/deposit/withdraw,
- material requirements,
- recipe lookup,
- crafting dependency expansion,
- tool requirements,
- fuel/smelting planning if feasible,
- "can satisfy goal from current inventory/chests?" checks.

The deterministic layer should be able to answer:
- how many oak_log do I have?
- how many more do I need?
- can I craft the required planks/sticks/tools?
- what is missing?
- where is the nearest known chest with the item?

## Milestone 6 — Deterministic world-model foundation

This is a core part of the project, not optional polish.

Build a deterministic world-model subsystem that ingests block/entity data and emits compact structured facts for future DeepSeek use.

Minimum features:

- persistent spatial memory file under data/world-model/ or similar;
- chunk/region ingest from bot-visible world;
- visited-area tracking;
- home/base/origin markers;
- resource sightings with coords;
- hazard sightings with coords;
- chest/storage sightings with coords;
- player-made / artificial-structure heuristics.

Structure detection heuristics:

- crafted-block density,
- processed block types: planks, bricks, glass, doors, torches, crafting tables, chests, fences, etc.,
- planar runs,
- right angles,
- rectangular/cuboid clusters,
- symmetry/repetition,
- unnatural floating/vertical surfaces,
- biome/context notes.

Outputs:

- machine-readable JSON store;
- compact summary object for advisor;
- human-readable report/log for review;
- "do not touch" flagged regions.

The advisor-facing summary should be compact, not a raw block grid.

Example summary shape:

{
  "interestingRegions": [
    {
      "id": "region_001",
      "bbox": {"min":[x,y,z],"max":[x,y,z]},
      "classification": "likely_player_made",
      "confidence": 0.91,
      "signals": ["crafted_blocks", "rectangular_planes", "door_present"],
      "dominantBlocks": ["oak_planks", "glass_pane"],
      "recommendedPolicy": "avoid_breaking_and_log_for_human_review"
    }
  ]
}

Add offline tests with synthetic block regions:
- natural terrain should not false-positive too aggressively;
- simple plank/glass/door house should flag;
- village-like generated structure can flag as artificial/generated-structure;
- isolated chest/crafting table should flag as player-interesting;
- raw terrain gradients should classify as natural.

## Milestone 7 — Optional human oversight viewer

If easy and low-risk, add or document prismarine-viewer / human-facing 3D view.

Important distinction:
- the viewer is for human oversight;
- DeepSeek should consume structured world-model summaries, not rendered 3D views.

If this becomes large, document and defer.

## Milestone 8 — Scenario tests

Create scenario scripts/harnesses. Offline/mocked where possible, live optional.

Target scenarios:

1. phase2 peaceful: collect 10 logs and deposit.
2. phase2 hostile interruption: collect resumes after one hostile flee.
3. single hostile flee: no critical logout.
4. multi-hostile flee: no target-flip oscillation.
5. water/drowning: bot surfaces or exits water.
6. tree/canopy collection: no fake fall hazard churn.
7. adjacent log efficiency: no unnecessary global wandering.
8. spawn protection/protected-region drop suppression detection.
9. chest deposit resume after preempt.
10. world-model synthetic house detection.
11. world-model natural terrain non-detection.
12. schematic/BOM dry-run, if implemented.

The test suite should make it obvious what still needs live verification.

## Milestone 9 — Autonomy polish pass

After core tests pass, spend remaining time finding issues I did not explicitly list.

Inspect code for:

- unbounded awaits,
- missing abort checks,
- missing progress watchdogs,
- inconsistent result shapes,
- direct pathfinder writes,
- stale config values,
- unstructured logs,
- missing docs,
- skills that cannot resume,
- places a future concurrent advisor would race the executor,
- places a future world-model summary would be stale or misleading.

Add tests before fixes when feasible.

## Milestone 10 — Future DeepSeek/concurrent-advisor readiness

Do not implement the concurrent advisor in this goal unless all deterministic milestones are already clean and there is substantial time left.

Do prepare interfaces for it:

- queue mutation boundary,
- skill-boundary queue swap,
- plan staleness validation hook,
- advisor-facing world-model summary,
- "proposal" vs "active queue" distinction,
- no mid-skill plan injection,
- no safety-critical advisor decisions.

Document the intended future flow:

executor runs current skill;
background advisor reads live snapshot + world-model;
advisor proposes updated queue;
deterministic validator checks if still sane;
executor swaps queue only at a safe skill boundary.

## Account Regimes For Phase Shift

The project now separates test work from production work. This distinction is mandatory because the test server can use the existing offline bot identity while production eventually uses the user's own Microsoft/Mojang account.

Regime A is the current default for all F1-F4 work. It uses the existing offline `MCBot` account on the private LAN test server, with `auth: 'offline'`, live-test gates, and RCON where explicitly enabled. The `MCBot` assumption is correct in this regime and must stay intact in RCON fixtures, live wrappers, and offline tests. F1, F1.5, F2, F3, and F4 all run in Regime A so the substrate and advisor can be validated without risking the user's real account or creating a same-account session conflict.

Regime B is production and starts only after F4. It uses the user's own Microsoft/Mojang account, not a second bot account. Until the later Fabric handoff work exists, the user must be logged out before the bot logs in, and the bot must support clean user take-back through graceful logout. Regime B requires explicit config such as `MCBOT_ACCOUNT_REGIME=production`, online-auth token-cache behavior, and a user-elsewhere kick cooldown so the bot does not fight the user for the same session.

## Phase Shift Gate — F1/F2 Evidence To SOTA Track

This goal should not get stuck polishing the deterministic substrate forever. The transition to SOTA work is now based on two concrete pieces of evidence rather than broad strict-readiness paperwork: F1, one real captured frontier-model response, and F2, one real private-server plan executed through the validated skill boundary.

This gate is tracked by code and reports:

- `src/goal/phase_shift_readiness.js` defines the F1/F2 gate, keeps `DeepSeek off by default` as a required invariant, and reports older strict checks as optional audit evidence.
- `src/goal/current_goal.js` resolves the active phase from readiness evidence and sets the stop-broad-polishing policy once F1 and F2 are proven.
- `src/goal/current_goal.js` keeps the current checkpoint plan focused on `phase_shift_gate_locked`, `f3_five_response_calibration`, `f4_sota_track_entry`, and `private_live_advisor_entry`.
- `resolveCurrentGoalState` exposes both `phaseShiftExecutionPlan` and `currentPhaseShiftCheckpoint`, and generated eval reports show the active checkpoint and next gate.
- `test/offline/phase_shift_readiness.test.js` verifies the F1/F2 gate, DeepSeek default-off behavior, optional strict-readiness reporting, and rendered blockers.
- `test/offline/goal_structure.test.js` verifies that current-goal state does not enter the SOTA track until F1/F2 evidence exists and that queued post-gate work stays ordered.
- `npm run test:det` writes `reports/phase-shift-readiness.json`, `reports/phase-shift-readiness.md`, `reports/deterministic-eval.json`, and `reports/deterministic-eval.md`.

When the readiness report says the phase shift is ready, broad deterministic substrate polishing stops. Remaining deterministic work must directly unblock a benchmark, fix a safety regression, address a failure discovered by DeepSeek calibration, or fill a publication evidence gap.

## Part B — Forcing-Function Milestones

Paperwork no longer substitutes for behavior. These milestones run in order, and F1-F4 all run in Regime A with the offline `MCBot` account on the private LAN test server.

### F1 — First Live Frontier-Model Call

F1 is one real call with the verified DeepSeek frontier model against a recorded snapshot. It is not a live-server control run. It proves that the request shape, response capture, validation, replay, and metrics path works with actual model output instead of guessed response shape.

Acceptance evidence:

- exactly one model request is made through the opt-in advisor path;
- raw output is written under `data/advisor-captures/` or another gitignored private capture path;
- public reports include only safe summaries and never leak raw model output;
- latency, token counts, model id, cost, validation result, and replay result are logged;
- strict replay accepts the captured response;
- the response-capture guard passes.

F1 does not grant DeepSeek runtime authority. A failed or malformed response becomes calibration evidence, not a reason to bypass validators.

### F1.5 — J/K Live Hostile Escalation

F1.5 is deterministic and uses no DeepSeek calls. It live-proves the RCON-assisted hostile escalation fixtures before any frontier model is trusted near combat decisions.

The J fixture, `live_hostile_escalation_fixture`, tests hostile pressure where the safe result is flee rather than engage. It should spawn controlled hostile groups through private-server RCON, observe whether reactive flee keeps liveness, avoids boundary churn, and exits cleanly, and then report live-proven evidence or an exact block reason.

The K fixture, `live_pvm_escalation_decision_fixture`, tests the transition from a manageable PvM engage state to a too-many-hostiles flee state. It should prove that deterministic policy can choose engagement under low risk, switch to flee when the threat set changes, and preserve reactive survival priority.

Acceptance evidence:

- both scenarios run only with private-server live-test gates and RCON/admin gates enabled;
- each scenario reports setup, RCON commands, bot state transitions, health/food, pathfinder state, and final result;
- each scenario becomes live-proven in the generated reports, or the exact missing env/config/server condition is documented.

### F2 — First Live Private-Server Plan

F2 is the first real DeepSeek-guided live plan. It runs `npm start -- "gather 10 oak logs"` against the private LAN test server using the existing offline `MCBot` account in Regime A. This is intentionally not a user-account run. The purpose is to validate the frontier model, planner boundary, schema guard, activation guard, executor, cost ceiling, and survival layer together without risking the user's production account.

Acceptance evidence:

- the planner call is made only with `MCBOT_ALLOW_DEEPSEEK=1`, `DEEPSEEK_API_KEY`, the private-server config, and the advisor cost ceiling in place;
- DeepSeek emits a schema-valid plan;
- the activation guard accepts the plan against a fresh snapshot;
- the executor runs at least one validated skill from the plan;
- the bot completes or fails cleanly with a structured final outcome;
- cost in dollars is logged and the cost ceiling behavior is verified;
- at least one induced hostile flee occurs during or around the run, and the bot survives without letting DeepSeek override reactive survival.

### F3 — Five-Response Calibration

F3 starts only after F1 and F2 pass. At this point the project has real reasoner response shape data, so the broader multi-tier calibration pack can be regenerated without guessing. F3 captures and validates at least five model responses across meaningful categories such as smoke observation, survival pressure, safety rejection, combat escalation, combat preparation, world-model context, and long-horizon mission planning.

Acceptance evidence:

- captured responses remain private and gitignored;
- public reports contain metrics and validation summaries only;
- replay validates all accepted responses;
- validators are adjusted to real response behavior rather than speculative formatting assumptions;
- failed responses become targeted calibration issues instead of new pre-call paperwork.

### F4 — SOTA Track Begins

F4 flips the phase-shift gate into SOTA-track mode. At this point broad deterministic foundation polishing is no longer the normal work. The project moves into C1-C9 in order, with deterministic fixes limited to benchmark blockers, safety regressions, advisor calibration failures, and publication evidence gaps.

Acceptance evidence:

- F1 evidence exists and passes capture/replay/metrics checks;
- F2 evidence exists and proves private-server plan execution through the validated skill boundary;
- `reports/phase-shift-readiness.json` reports the required gates as passed;
- `reports/deterministic-eval.md` names the current post-gate phase and active workstream;
- Progress notes state which capabilities are live-proven, offline-covered, scaffolded, or pending.

## Part C — Long-Term SOTA Additions

The SOTA track is not a loose wishlist. It is an ordered set of workstreams that should make the bot demonstrably stronger, easier to supervise, and more defensible than a simple Mineflayer task runner or generic LLM wrapper.

### C1 — Humanization Layer

C1 adds a deterministic layer between executor intent and Mineflayer/client actions. It turns mechanical commands into human-plausible execution while preserving vanilla constraints. Every look, attack, block placement, dig, and pathing goal should eventually flow through this adapter.

The layer should support aim curves over roughly 100-400ms, bounded jitter, slight overshoot and correction, realistic reaction-time distributions for non-critical actions, click cadence limits, occasional one-block movement variation, small idle behaviors, and a session-level mood scalar such as cautious, exploratory, efficient, or social. Critical survival reflexes may bypass slow human timing, but every exemption must be logged for auditability.

This work is gated behind `MCBOT_HUMANIZE=1`. Deterministic tests remain stable by default, and humanization must never create illegal reach, impossible rotations, packet spoofing, speed changes, or other public-server cheat behavior.

### C2 — Anti-Cheat Invariants Test Suite

C2 proves that humanization and combat output stay inside vanilla physical limits. The suite should live around `test/offline/humanization_invariants.test.js` and fail closed if generated output exceeds allowed bounds.

The invariant set should cover sustained and per-tick rotation limits, attack/interact reach, click intervals, walk/sprint speeds, jump physics, and explicit absence of NoFall, Reach extension, Speed, impossible angles, packet spoofing, kill-aura, and aimbot-like behavior. The point is not public-server evasion. The point is ethical defensibility: the bot should be impressive because it plays well through normal game actions.

### C3 — Detection-Rate Benchmark

C3 creates a benchmark for whether behavior looks human to observers. The harness should record short clips of bot behavior and separately recorded human behavior, strip identifying metadata, present clips for blind classification, and report classification accuracy over time.

The aspirational target is around 55% classification accuracy, barely above chance. That number should become a headline metric for publication because it is clearer than vague claims like "human-like." It also gives C1 a measurable tuning target.

### C4 — Carpet-PvP Heuristic Extraction

C4 mines a locally-acquired Carpet PvP jar for ideas only (the operator supplies the jar from their own Downloads directory; do not commit the binary). If used, decompile into a gitignored `vendor/decompiled/` directory and write findings as prose and pseudocode in `docs/combat-heuristics-extracted.md`.

Permitted extraction includes tactical ideas such as crystal placement heuristics, totem priority, burrow detection, pearl tracking, anchor and bed variants, threat prioritization, anti-trap movement, and positioning concepts. Banned extraction includes copied source, packet-level swaps, sub-tick timing, reach extension, autoclicker behavior, impossible rotation, or anything that violates C2.

If the source appears GPLv3-derived or otherwise restrictive, keep the extraction even more conservative: high-level ideas only, no copied structure, no runtime dependency, and no source snippets in committed files.

### C5 — Oversight And Hand-Off

C5 gives the user a way to watch and eventually hand off control without confusing Regime A and Regime B.

Phase 1 is the near-term viewer. It should add a `prismarine-viewer` first-person web feed, commonly at `localhost:3007`, and document that the viewer renders the 3D world from the bot's perspective only. It does not provide the full Minecraft HUD, inventory UI, or chat overlay. Users should expect to keep logs open beside the viewer. Phase 1 can run in Regime A for dev/demo. It is also the first planned Regime B context, where the bot logs into the user's own account while the user is logged out, and take-back means stopping the bot and logging back in normally.

Phase 2 is the later Fabric client mod bridge. The mod runs inside the user's actual Minecraft client, exposes a localhost bridge, intercepts user input during handoff, and injects bot-generated keyboard/mouse actions through a backend that respects C1 and C2. Before writing Fabric code, the project needs `docs/handoff-architecture.md`, a pluggable backend interface, a user-facing `!handoff <goal>` style command, task-budget/return integration, and instant take-back on any user keyboard input.

### C6 — Reliability Hardening

C6 turns promising behavior into unattended reliability. It should add multi-hour private-server soaks, crash-resume behavior, reconnect resilience, and anti-griefing self-defense fixtures.

Important cases include brief network partitions, ordinary server kicks, process restart recovery, being walled in, lava-lured, bad-potion-fed, or otherwise disrupted by other players on an authorized private server. The user-elsewhere kick in Regime B is different: that should refuse reconnect for a cooldown so the user can reclaim the account.

### C7 — Memory And Social Model

C7 gives the bot durable social and tactical memory. It should maintain a local persistent journal with per-player relationship status, trades, griefing history, and owed/owing items. It should also support self-narration logs where the planner explains why it chose a course of action, separate from strict JSON execution output.

Combat encounters should produce tactical postmortems. Over time, those postmortems can generate reviewed lessons such as `combat_lessons.md`, which can be injected into future prompts only after deterministic sanitization and user review where appropriate.

### C8 — Server-Specific Observation And Behavioral Priors

C8 is intended to become a major differentiator: per-server, per-user behavior learning that is local, reviewable, and not silent.

C8a is observation capture. In Regime B, it records the user's behavior through two paths: out-of-game scraping such as RCON chat logs, scoreboard polls, and server-log tails, and a passive Fabric logger mini-mod that records input, position, inventory deltas, and chat without taking over. The test server can still validate the pipeline with RCON-injected fake-user events. Raw observations live under gitignored `data/observations/<server-id>/` and are never uploaded.

C8b is prior extraction. It distills raw observations into compact human-reviewable facts, such as where the user fishes, which players they avoid, tool preferences, chat style, sleep habits, or common movement habits. Output goes to `data/priors/<server-id>.json`. The user must be able to review, edit, accept, or reject priors before they become consumable.

C8c is prior consumption. Reviewed priors can influence the advisor system prompt, chat-reply style, C1 mood/style parameters, and server-specific behavior. Priors are advisory only. Deterministic survival and safety gates still win, even if a prior says the user normally takes a risky action.

Privacy constraints are strict: local-only storage, no raw logs across the DeepSeek boundary, redaction for sensitive content, user deletion support, and graceful degradation if observation or prior files are absent.

### C9 — Player Awareness, Anomaly Detection, And Chat Reply

C9 makes the bot behave like an attentive server occupant instead of a blind task runner.

C9a adds anomaly detectors for externally imposed state changes. Candidate signals include `forcedMove`, sudden player distance jumps, `windowOpen`, derived head-rotation mismatch, unexpected dimension changes, sudden game-mode changes, large unexplained inventory deltas, unusual death sources, and sustained zero-input/desync windows. Each detector should emit structured logs, pause unsafe work, react in a bounded plausible way, and have an RCON-driven Regime A test fixture before it is considered done.

C9b adds direct chat reply. It should handle private messages and public messages addressed to the bot by building compact reply context, using a separate chat-reply advisor mode, applying deterministic hard refusals, filtering prompt injection before model calls, sanitizing output, and adding plausible typing delay. Hard refusals include requests for credentials, identity/location, admin secrets, unsafe griefing/stealing, hostile-player item drops, user-authorization bypass, and every logout or process-control request. Chat identity never grants runtime authority.

C9c adds unattended-session policy for later handed-off sessions. The bot should keep anomaly detectors active, log high-priority incidents, optionally alert the user through a later side channel, and expose a status summary when the user takes control back.

## SOTA Track Workstream Order

After F4, execute workstreams in this order unless a safety regression or benchmark blocker forces a targeted detour:

1. Humanization layer.
2. Anti-cheat invariants.
3. Detection-rate benchmark.
4. Carpet-PvP heuristic extraction.
5. Oversight and hand-off.
6. Reliability hardening.
7. Memory and social model.
8. Server-specific observation and priors.
9. Player awareness, anomaly detection, and chat reply.

This phase shift does not loosen safety constraints. DeepSeek remains a planner and chat-reply generator only. Deterministic validators own survival, skill execution, queue mutation, public-server refusal, account-regime boundaries, and no-cheat PvP constraints.

## Long-Term Goal — Authorized High-Level PvP

This is an explicit overall project target, but it is not a license to build public-server cheating or anti-cheat bypass behavior. PvP development must stay limited to private/local/authorized tests and must obey normal Minecraft mechanics, plausible timing, and fair-play input constraints.

DeepSeek can eventually reason about tactics, but deterministic systems must own all safety-critical execution:

- reactive survival remains higher priority than PvP aggression;
- player combat must be opt-in and authorized;
- no packet-level spoofing, kill-aura, aimbot, impossible tracking, impossible click/rotation timing, or anti-cheat evasion logic;
- combat actions should use ordinary Mineflayer/game actions with bounded, inspectable timing and structured logs;
- deterministic validators should reject unsafe or impossible advisor PvP plans.

Future PvP capability targets:

- threat assessment for players, mobs, projectiles, lava, fire, fall risk, crystals, and terrain traps;
- deterministic weapon/tool selection for sword, axe, bow/crossbow, shield, lava bucket, water bucket, blocks, food, potions, and golden apples;
- potion and consumable policy for pre-fight buffs and emergency recovery, including strength, regeneration, instant health, speed, fire resistance, food, and golden apples;
- bow/crossbow opening pressure, line-of-sight, cover use, projectile avoidance, transition-to-melee decisions, and safe disengage logic;
- close-combat movement that can use legitimate sprinting, strafing, spacing, cooldown-aware sword/axe attacks, shield timing, and critical-hit opportunities without impossible aim/timing;
- lava/water bucket tactics, including placing lava in a likely opponent path when safe, reacting to enemy lava, placing water at the bot's feet to extinguish fire when safe, and retrieving water when possible;
- block placement for cover, line-of-sight breaking, blast mitigation, and emergency separation;
- crystal PvP modeling for placement legality, explosion self-damage, opponent damage, line-of-sight, vertical offset, one-block-low or cover-block mitigation, escape routes, and immediate self-preservation;
- opponent-model state tracking that remains compact enough for DeepSeek to reason over but deterministic enough for safe execution.

Before DeepSeek controls PvP tactics, deterministic tests should cover:

1. weapon and armor-aware engage/flee gates;
2. potion/food/golden-apple decision thresholds;
3. lava/fire water-bucket response and recovery;
4. bow/crossbow target selection and line-of-sight checks;
5. melee spacing and cooldown-aware attack timing;
6. legitimate critical-hit setup and DPS-aware sword/axe choice;
7. lava placement, lava escape, and water bucket pickup behavior;
8. crystal placement/self-damage simulation;
9. block-cover and vertical-position blast mitigation;
10. player-threat live fixtures on a private/authorized server;
11. explicit no-cheat constraints for rotation, click timing, packet use, and public-server behavior.

## Acceptance criteria

This goal is complete when:

1. npm run check passes.
2. npm run test:unit passes.
3. npm run test:det passes.
4. npm run test:grep confirms no forbidden direct pathfinder writes.
5. docs/status.md is current.
6. A progress log records the iteration loop.
7. The deterministic eval report exists and summarizes pass/fail.
8. Core survival hazards are handled or explicitly documented with reliable deferrals.
9. collect/goto/deposit/craft/equip/logout have structured, actionable failure reasons.
10. World-model foundation exists with synthetic tests and advisor-facing summary.
11. Live test harness exists, even if live verification is pending due to missing local server config.
12. DeepSeek/advisor behavior remains unchanged except interface docs.
13. The final response lists:
    - commits,
    - changed files,
    - tests run,
    - tests skipped and why,
    - remaining risks,
    - next live commands.

## Stop conditions

Stop and ask / report if:

- a change would violate the three-layer architecture;
- a fix requires DeepSeek/API calls;
- a fix requires secrets;
- a fix requires public server access;
- a live test requires admin credentials not already configured;
- a hazard API is unreliable and would require guessy behavior;
- the repo is in a conflicting state;
- a broad rewrite is required and would invalidate previous commits.

## Final deliverable

At the end, produce:

- concise commit list,
- deterministic capability matrix,
- what is verified offline,
- what is verified live,
- what is not verified,
- exact next command I should run,
- exact log patterns that mean success/failure,
- recommended next goal after this one.
