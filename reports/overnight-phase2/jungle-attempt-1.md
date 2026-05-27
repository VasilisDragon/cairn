# Advisor Live Plan

- status: iron_tier_verified
- outcome: success
- goal: make an iron pickaxe using nearby jungle_log if wood is needed
- attempts made: 1
- account: MCBot (offline)
- wood targets: none
- retargets: 0
- final logs: 0/10
- final log counts: none
- item goal: iron_pickaxe 1/1 met=true
- advisor model lock: deepseek-v4-pro
- advisor model override: true
- cost usd: 0.07429
- cost ceiling verified: true
- timing: skillRuntime=204874ms, pathfinderSettle=6638ms, pickupWait=7406ms
- hostile flee survived: false
- hostile flee events: 0
- tagged hostile spawns: 0
- plugin telemetry: <plugin-telemetry>/advisor_live_plan_f2-20260527133438-f55b35cc.jsonl

## Advisor Calls

| # | Model | Latency ms | Input tokens | Output tokens | USD | Schema |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | deepseek-v4-pro | 21370 | 5643 | 870 | 0.018246 | accepted |
| 2 | deepseek-v4-pro | 14238 | 6063 | 489 | 0.016038 | pending |
| 3 | deepseek-v4-pro | 8268 | 3216 | 391 | 0.00956 | accepted |
| 4 | deepseek-v4-pro | 20210 | 6229 | 719 | 0.01821 | pending |
| 5 | deepseek-v4-pro | 15732 | 3206 | 728 | 0.012236 | accepted |

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
- executor failed skill count: 4
- failures: skill failure: mine_with_progression: mine_with_progression prep step 1/22 failed (collect): collect refused to dig while airborne: groundWaitTimeout (732ms, onGround=false); skill failure: mine_with_progression: mine_with_progression prep step 1/22 failed (collect): collect refused to dig while airborne: groundWaitTimeout (732ms, onGround=false); skill failure: mine_with_progression: mine_with_progression prep step 2/23 failed (collect): no more oak_log within 64 blocks (have 1/2, excluded 0, above maxTargetY 32); skill failure: mine_with_progression: mine_with_progression prep step 2/23 failed (collect): no more oak_log within 64 blocks (have 1/2, excluded 0, above maxTargetY 32)

