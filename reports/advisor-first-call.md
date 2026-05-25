# Advisor First Call

- no API call made: yes
- status: capture_execution_not_requested
- entrypoint: advisor_first_call_capture
- response dir: data/advisor-first-call-responses
- response file: data/advisor-first-call-responses/responses.template.json
- execute requested: no
- capture confirmed: no
- overwrite enabled: no
- ready to execute: no
- request count: 1
- runtime request payload omitted: yes
- next action: set MCBOT_ADVISOR_FIRST_CALL_CAPTURE_EXECUTE=1 and MCBOT_ADVISOR_FIRST_CALL_CAPTURE_OK=1 only for an explicitly authorized capture

## First-Call Requests

| Request | Category | Calibration tier | Purpose | Expected | Prompt chars | Est. tokens | Fingerprint |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| recorded_live_smoke_observe | recorded_snapshot | smoke | first gated DeepSeek call should choose observe from a clean chunksReady snapshot | accepted; skills=observe; len=1 | 2205 | 552 | fce174875a67... |

## Preflight

- status: not_checked_until_execute_requested
- opt-in gate: blocked
- API key: missing
- model: unknown

## Criteria

| Criterion | Status | Severity | Detail |
| --- | --- | --- | --- |
| capture_pack_ready | passed | failure | capture pack status capture_pack_ready; requests=1 |
| response_intake_safe | passed | failure | response intake status ready_for_strict_replay; present=1; empty=0; non-output-present=0 |
| private_capture_guard | passed | failure | private capture directory is ignored and public reports are raw-response-free |
| response_output_writable | failed | failure | data/advisor-first-call-responses/responses.template.json already contains 1 non-empty captured response(s); set MCBOT_ADVISOR_FIRST_CALL_CAPTURE_OVERWRITE=1 to replace it |
| execute_requested | pending | pending | MCBOT_ADVISOR_FIRST_CALL_CAPTURE_EXECUTE=1 required to run first-call capture |
| capture_confirmed | pending | pending | MCBOT_ADVISOR_FIRST_CALL_CAPTURE_OK=1 required to confirm this explicit DeepSeek capture run |
| deepseek_preflight_ready | pending | pending | DeepSeek preflight is checked only when first-call capture execution is requested |

## Capture

- status: not run

## Commands

- dryRunPlan: `npm run advisor:first-call`
- executeCapture: `$env:MCBOT_ADVISOR_FIRST_CALL_CAPTURE_EXECUTE='1'; $env:MCBOT_ADVISOR_FIRST_CALL_CAPTURE_OK='1'; $env:MCBOT_ALLOW_DEEPSEEK='1'; npm run advisor:first-call`
- replay: `npm run advisor:replay`
- strictReplay: `$env:MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSES='1'; npm run advisor:replay`
- strictMetricsReplay: `$env:MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSES='1'; $env:MCBOT_ADVISOR_FIRST_CALL_REQUIRE_RESPONSE_METRICS='1'; npm run advisor:replay`
- finalGuard: `npm run advisor:response-capture-guard`

## Failures

- data/advisor-first-call-responses/responses.template.json already contains 1 non-empty captured response(s); set MCBOT_ADVISOR_FIRST_CALL_CAPTURE_OVERWRITE=1 to replace it
