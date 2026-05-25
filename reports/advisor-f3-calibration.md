# Advisor F3 Calibration

- no API call made: yes
- status: capture_execution_not_requested
- entrypoint: advisor_first_call_capture
- response dir: data/advisor-f3-responses
- response file: data/advisor-f3-responses/responses.template.json
- execute requested: no
- capture confirmed: no
- overwrite enabled: no
- ready to execute: no
- request count: 7
- runtime request payload omitted: yes
- next action: set MCBOT_ADVISOR_FIRST_CALL_CAPTURE_EXECUTE=1 and MCBOT_ADVISOR_FIRST_CALL_CAPTURE_OK=1 only for an explicitly authorized capture

## First-Call Requests

| Request | Category | Calibration tier | Purpose | Expected | Prompt chars | Est. tokens | Fingerprint |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| recorded_live_smoke_observe | recorded_snapshot | smoke | first gated DeepSeek call should choose observe from a clean chunksReady snapshot | accepted; skills=observe; len=1 | 2205 | 552 | 1c0c946575c6... |
| recorded_supply_chest_state_observe | recorded_snapshot | world_model | first gated DeepSeek call should read compact storage context without inventing chest actions | accepted; skills=observe; len=1 | 2712 | 678 | 34d0339d6070... |
| recorded_single_hostile_flee | recorded_snapshot | survival | first gated DeepSeek call should preserve retreat behavior during active reactive flee | accepted; skills=flee; len=1 | 2885 | 722 | 0f31c0c55fbb... |
| recorded_stacked_hostiles_reject_collect | recorded_snapshot | safety_rejection | first gated DeepSeek call should avoid unsafe normal work under stacked hostiles; unsafe collection would be rejected by activation | accepted | 3014 | 754 | 2251214a3ec8... |
| recorded_hostile_escalation_flee | recorded_snapshot | combat_escalation | first gated DeepSeek call should choose immediate retreat when stacked zombies are in melee range | accepted | 3330 | 833 | 4089ee4faedb... |
| recorded_pvm_strength_prep | recorded_snapshot | combat_prep | recorded private-server PvM posture should preserve potion-prep behavior through the survival-only activation boundary | accepted; skills=consume; len=1 | 2900 | 725 | e1221f2ebe39... |
| recorded_fishing_deposit_fixture | recorded_snapshot | long_horizon_fixture | recorded authorized fishing fixture should choose the bounded fish-and-deposit mission wrapper | accepted; skills=fish_and_deposit; len=1 | 2729 | 683 | 7d3f7ad006ab... |

## Preflight

- status: not_checked_until_execute_requested
- opt-in gate: blocked
- API key: missing
- model: unknown

## Criteria

| Criterion | Status | Severity | Detail |
| --- | --- | --- | --- |
| capture_pack_ready | passed | failure | capture pack status capture_pack_ready; requests=7 |
| response_intake_safe | failed | failure | recorded_live_smoke_observe request fingerprint mismatch; recorded_supply_chest_state_observe request fingerprint mismatch; recorded_single_hostile_flee request fingerprint mismatch; recorded_stacked_hostiles_reject_collect request fingerprint mismatch; recorded_hostile_escalation_flee request fingerprint mismatch; recorded_pvm_strength_prep request fingerprint mismatch; recorded_fishing_deposit_fixture request fingerprint mismatch |
| private_capture_guard | passed | failure | private capture directory is ignored and public reports are raw-response-free |
| response_output_writable | failed | failure | data/advisor-f3-responses/responses.template.json already contains 7 non-empty captured response(s); set MCBOT_ADVISOR_FIRST_CALL_CAPTURE_OVERWRITE=1 to replace it |
| execute_requested | pending | pending | MCBOT_ADVISOR_FIRST_CALL_CAPTURE_EXECUTE=1 required to run first-call capture |
| capture_confirmed | pending | pending | MCBOT_ADVISOR_FIRST_CALL_CAPTURE_OK=1 required to confirm this explicit DeepSeek capture run |
| deepseek_preflight_ready | pending | pending | DeepSeek preflight is checked only when first-call capture execution is requested |

## Capture

- status: not run

## Commands

- dryRunPlan: `npm run advisor:f3`
- executeCapture: `$env:MCBOT_ADVISOR_F3_CAPTURE_EXECUTE='1'; $env:MCBOT_ADVISOR_F3_CAPTURE_OK='1'; $env:MCBOT_ALLOW_DEEPSEEK='1'; npm run advisor:f3`
- executeOverwrite: `$env:MCBOT_ADVISOR_F3_CAPTURE_EXECUTE='1'; $env:MCBOT_ADVISOR_F3_CAPTURE_OK='1'; $env:MCBOT_ADVISOR_F3_CAPTURE_OVERWRITE='1'; $env:MCBOT_ALLOW_DEEPSEEK='1'; npm run advisor:f3`
- strictReplay: `$env:MCBOT_ADVISOR_F3_REQUIRE_RESPONSES='1'; npm run advisor:f3`
- finalGuard: `npm run advisor:f3`

## Failures

- recorded_live_smoke_observe request fingerprint mismatch; recorded_supply_chest_state_observe request fingerprint mismatch; recorded_single_hostile_flee request fingerprint mismatch; recorded_stacked_hostiles_reject_collect request fingerprint mismatch; recorded_hostile_escalation_flee request fingerprint mismatch; recorded_pvm_strength_prep request fingerprint mismatch; recorded_fishing_deposit_fixture request fingerprint mismatch
- data/advisor-f3-responses/responses.template.json already contains 7 non-empty captured response(s); set MCBOT_ADVISOR_FIRST_CALL_CAPTURE_OVERWRITE=1 to replace it
