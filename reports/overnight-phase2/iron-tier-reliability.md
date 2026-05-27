# Phase 2 Iron Tier Reliability Summary

Date: 2026-05-27

## Result

Phase 2 is complete for the required close-out evidence set:

- F2 forest starter fixture: 3/3 consecutive successes
  (`forest-starter-attempt-19`, `20`, `21`)
- Jungle fixture: 1/1 success (`jungle-attempt-1`)
- Hilly fixture: 1/2 attempts, with attempt 2 successful after the
  attempt-1 coordinate/setup issue was fixed

Across those five successful close-out runs, every run ended with:

- `status: iron_tier_verified`
- `itemGoal.item: iron_pickaxe`
- `itemGoal.met: true`
- `assertions.noBotDeath: true`
- `assertions.pluginTelemetryClosed: true`

## Evidence Matrix

| Terrain | Report | Result | Advisor calls | Cost USD | Skill runtime | Failed skills | Notes |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Forest starter | `forest-starter-attempt-19` | success | 4 | 0.071278 | 214014ms | 4 | Recovered from stale `jungle_log` selection, one JSON truncation, and one shaft open-air hazard. |
| Forest starter | `forest-starter-attempt-20` | success | 1 | 0.020162 | 165101ms | 0 | Cleanest Phase 2 proof run. |
| Forest starter | `forest-starter-attempt-21` | success | 2 | 0.039106 | 190162ms | 2 | Recovered from stale `jungle_log` selection. |
| Jungle | `jungle-attempt-1` | success | 5 | 0.074290 | 204874ms | 4 | Recovered from airborne collect refusal and later oak fallback. |
| Hilly | `hilly-attempt-1` | fail | 10 | 0.171594 | 1009ms | 14 | Bad fixture coordinate: server locate Y placed the bot below the real surface/no reachable logs. |
| Hilly | `hilly-attempt-2` | success | 5 | 0.074196 | 164277ms | 4 | Real surface Y was probed first; recovered from straight-down refusal and one JSON truncation. |

Successful close-out average:

- Advisor calls: 3.4 per run
- Cost: $0.055806 per run
- Skill runtime: 187686ms per run
- Pickup wait: 6410ms per run

## Recovery Patterns That Worked

- The deterministic `mine_with_progression` composer can now carry the
  wood-to-iron-pickaxe chain to completion from empty inventory.
- Repair prompts recovered from JSON truncation in forest and hilly runs.
- The planner can re-enter `mine_with_progression` after recoverable
  substrate failures without losing the item goal.
- The hilly fixture required real surface probing. The follow-up verifier
  change preloads teleport chunks before floor/air setup, preventing the
  far-coordinate setup command miss that caused hilly attempt 1.

## Recurring Failure Modes

- Stale or inappropriate `woodBlock` selection still appears. Forest runs
  sometimes tried `jungle_log`; the jungle run later fell back to oak despite
  the explicit jungle fixture goal.
- Advisor repair can still hit truncated/empty JSON under stress, though the
  repair loop now recovers.
- `mine_until` / final ore collection can hit straight-down refusal when the
  visible target sits below the bot. This is correctly safer than digging
  straight down, but it costs replans.
- Dig-time fallback logs still classify `iron_ore` as
  `incorrect_for_wooden_tool` even when the held tool is stone or iron tier.
  The run can succeed, but the telemetry label/math needs later investigation.
- Pickup waits and local nudges are still visible in ore collection. They are
  not blocking iron-tier completion, but they are measurable overhead.

## Interpretation

The phase goal was not "perfect iron-tier execution"; it was reliability
across multiple terrain classes. The evidence now supports that `iron_pickaxe`
from empty inventory is live-proven in controlled forest, jungle, and hilly
fixtures. The remaining gaps are quality and generality issues that should
feed Phase 3/4 work rather than block Phase 2 closure.

