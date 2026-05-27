# Advisor Live Plan

- status: live_plan_failed
- outcome: fail
- goal: make an iron pickaxe
- attempts made: 1
- account: MCBot (offline)
- wood targets: none
- retargets: 0
- final logs: 4/10
- final log counts: oak_log:4
- item goal: iron_pickaxe 1/1 met=true
- advisor model lock: deepseek-v4-pro
- advisor model override: true
- cost usd: 0.051948
- cost ceiling verified: true
- timing: skillRuntime=131169ms, pathfinderSettle=1ms, pickupWait=3801ms
- hostile flee survived: false
- hostile flee events: 0
- tagged hostile spawns: 0
- plugin telemetry: <plugin-telemetry>/advisor_live_plan_f2-20260527073927-8bc335dd.jsonl

## Advisor Calls

| # | Model | Latency ms | Input tokens | Output tokens | USD | Schema |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | deepseek-v4-pro | 47982 | 5562 | 2130 | 0.028164 | accepted |
| 2 | deepseek-v4-pro | 32362 | 5940 | 1488 | 0.023784 | accepted |

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
- failures: skill failure: craft: missing ingredients for "iron_pickaxe": 3 iron_ingot; skill failure: craft: missing ingredients for "iron_pickaxe": 3 iron_ingot

