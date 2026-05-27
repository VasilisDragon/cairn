# Advisor Live Plan

- status: iron_tier_verified
- outcome: success
- goal: make an iron pickaxe
- attempts made: 1
- account: MCBot (offline)
- wood targets: none
- retargets: 0
- final logs: 0/10
- final log counts: none
- item goal: iron_pickaxe 1/1 met=true
- advisor model lock: deepseek-v4-pro
- advisor model override: true
- cost usd: 0.039106
- cost ceiling verified: true
- timing: skillRuntime=190162ms, pathfinderSettle=0ms, pickupWait=4764ms
- hostile flee survived: false
- hostile flee events: 0
- tagged hostile spawns: 0
- plugin telemetry: <plugin-telemetry>/advisor_live_plan_f2-20260527131750-38db06a4.jsonl

## Advisor Calls

| # | Model | Latency ms | Input tokens | Output tokens | USD | Schema |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | deepseek-v4-pro | 30940 | 5593 | 1385 | 0.022266 | accepted |
| 2 | deepseek-v4-pro | 15766 | 5912 | 627 | 0.01684 | accepted |

## Hostile Flee

- induced at: none
- transition at: none
- progress at induction: unknown/unknown
- progress at transition: unknown/unknown
- returned normal: false

## Validation

- planner call made: true
- schema valid: true
- activation accepted: true
- executor failed skill count: 2
- failures: skill failure: mine_with_progression: mine_with_progression prep step 1/22 failed (collect): no more jungle_log within 64 blocks (have 0/2, excluded 0, above maxTargetY 32); skill failure: mine_with_progression: mine_with_progression prep step 1/22 failed (collect): no more jungle_log within 64 blocks (have 0/2, excluded 0, above maxTargetY 32)

