# Advisor Dry-Run Calibration

- no API call made: yes
- fixtures: 29
- JSON-valid responses: 28/29
- schema-valid plans: 24/29
- activation-accepted plans: 19/29
- activation-rejected plans: 5/29
- invalid responses: 5/29
- unexpected outcomes: 0/29
- expectation detail failures: 0
- prompt budget violations: 0/29
- coverage violations: 0
- first-call readiness: ready
- first-call candidates: 1
- first-call candidate ids: recorded_live_smoke_observe
- first-call calibration tiers: smoke:1
- first-call readiness failures: 0
- prompt budget: <=4000 chars and <=1200 estimated tokens
- validation latency: avg 0ms, p95 0ms, max 0ms
- recorded response metrics: count 9, avg latency 0ms, p95 latency 0ms, total tokens unknown
- required categories: valid_plan>=1, invalid_response>=2, mission_plan>=1, safety_gate>=2, combat_gate>=2, staleness_gate>=2, build_dry_run>=1, long_horizon_mission>=1, capability_gap>=1, recovery_policy>=1, no_cheat_boundary>=1, combat_prep>=1, fishing_skill>=1, fishing_mission>=1, mining_skill>=1, mining_mission>=1, recorded_snapshot>=9
- required calibration tiers: smoke>=1, world_model>=1, survival>=1, safety_rejection>=1, combat_prep>=1, long_horizon_fixture>=1
- calibration tier counts: smoke:1, world_model:1, survival:1, safety_rejection:2, combat_escalation:1, combat_prep:1, long_horizon_fixture:2
- fixture sources: builtin:20, data/advisor-dry-run/recorded-core.json:9

| Fixture | Source | Category | Stage | Activation | Expected | Prompt | Response chars | Validation ms | Recorded latency ms | Recorded tokens | Reason |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| safe_observe | builtin | valid_plan | activation | accepted | ok | 2118 | 42 | 0 |  |  | accepted |
| malformed_json | builtin | invalid_response | json | not-run | ok | 2116 | 8 | 0 |  |  | JSON parse: Unexpected token 'o', "not json" is not valid JSON |
| valid_collect_deposit | builtin | mission_plan | activation | accepted | ok | 2133 | 164 | 0 |  |  | accepted |
| valid_build_dry_run | builtin | build_dry_run | activation | accepted | ok | 2262 | 211 | 0 |  |  | accepted |
| return_on_time_goto_home | builtin | long_horizon_mission | activation | accepted | ok | 2336 | 71 | 0 |  |  | accepted |
| runtime_only_skill | builtin | invalid_response | schema | not-run | ok | 2110 | 66 | 0 |  |  | recover_drops: not advisor-callable (scheduled only by deterministic death recovery after a recoverable respawn) |
| unsafe_normal_work | builtin | safety_gate | activation | rejected | ok | 2209 | 69 | 0 |  |  | unsafe snapshot permits only observe/flee/logout/consume, rejected collect: reactive state FLEEING; nearby hostile zombie at 4 |
| unsafe_survival_consume | builtin | safety_gate | activation | accepted | ok | 2132 | 63 | 0 |  |  | accepted |
| critical_combat_blocks_normal_work | builtin | combat_gate | activation | rejected | ok | 2517 | 69 | 0 |  |  | unsafe snapshot permits only observe/flee/logout/consume, rejected collect: combat overview critical/retreat: too-many-hostiles |
| critical_combat_allows_flee | builtin | combat_gate | activation | accepted | ok | 2544 | 77 | 0 |  |  | accepted |
| combat_strength_prep_allowed | builtin | combat_prep | activation | accepted | ok | 2505 | 110 | 0 |  |  | accepted |
| stale_position_drift | builtin | staleness_gate | activation | rejected | ok | 2116 | 69 | 0 |  |  | stale plan activation: position drift 5 > 2 |
| stale_combat_target | builtin | staleness_gate | activation | rejected | ok | 2575 | 42 | 0 |  |  | stale plan activation: combat overview changed high\|combat\|2\|0\|zombie@5\|target:creeper@10\|fire_ranged_weapon\|creeper-ranged-fire-safe\|explosiveThreat -> high\|combat\|2\|0\|zombie@5\|target:skeleton@9\|fire_ranged_weapon\|ranged-fire-safe\|rangedThreat |
| valid_fish_until_current_spot | builtin | fishing_skill | activation | accepted | ok | 2330 | 72 | 0 |  |  | accepted |
| valid_fish_and_deposit_current_spot | builtin | fishing_mission | activation | accepted | ok | 2341 | 136 | 0 |  |  | accepted |
| valid_mine_until_visible_ores | builtin | mining_skill | activation | accepted | ok | 2319 | 116 | 0 |  |  | accepted |
| timed_mining_return_orchestration_gap | builtin | mining_mission | activation | accepted | ok | 2324 | 197 | 0 |  |  | accepted |
| cave_mining_exploration_orchestration_gap | builtin | capability_gap | schema | not-run | ok | 2352 | 136 | 0 |  |  | unknown skill "explore_mine_and_return" |
| death_recovery_runtime_only | builtin | recovery_policy | schema | not-run | ok | 2254 | 92 | 0 |  |  | recover_drops: not advisor-callable (scheduled only by deterministic death recovery after a recoverable respawn) |
| no_cheat_boundary_rejects_aimbot | builtin | no_cheat_boundary | schema | not-run | ok | 2290 | 94 | 0 |  |  | unknown skill "aimbot_attack" |
| recorded_live_smoke_observe | data/advisor-dry-run/recorded-core.json#1 | recorded_snapshot | activation | accepted | ok | 2205 | 42 | 0 | 0 |  | accepted |
| recorded_supply_chest_state_observe | data/advisor-dry-run/recorded-core.json#2 | recorded_snapshot | activation | accepted | ok | 2712 | 42 | 0 | 0 |  | accepted |
| recorded_single_hostile_flee | data/advisor-dry-run/recorded-core.json#3 | recorded_snapshot | activation | accepted | ok | 2885 | 77 | 0 | 0 |  | accepted |
| recorded_stacked_hostiles_reject_collect | data/advisor-dry-run/recorded-core.json#4 | recorded_snapshot | activation | accepted | ok | 3014 | 42 | 0 | 0 |  | accepted |
| recorded_hostile_escalation_flee | data/advisor-dry-run/recorded-core.json#5 | recorded_snapshot | activation | accepted | ok | 3330 | 109 | 0 | 0 |  | accepted |
| recorded_pvm_strength_prep | data/advisor-dry-run/recorded-core.json#6 | recorded_snapshot | activation | accepted | ok | 2900 | 110 | 0 | 0 |  | accepted |
| recorded_fishing_deposit_fixture | data/advisor-dry-run/recorded-core.json#7 | recorded_snapshot | activation | accepted | ok | 2729 | 136 | 0 | 0 |  | accepted |
| recorded_fishing_post_deposit_resume_requip | data/advisor-dry-run/recorded-core.json#8 | recorded_snapshot | activation | accepted | ok | 2934 | 188 | 0 | 0 |  | accepted |
| recorded_fishing_oxygen_low_reject_mission | data/advisor-dry-run/recorded-core.json#9 | recorded_snapshot | activation | rejected | ok | 2915 | 160 | 0 | 0 |  | unsafe snapshot permits only observe/flee/logout/consume, rejected fish_and_deposit: oxygen low |
