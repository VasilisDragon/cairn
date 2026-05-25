# Advisor First-Call Replay

- no API call made: yes
- status: validated_model_responses
- require complete responses: yes
- require response metrics: yes
- expected responses: 7
- present responses: 7
- missing responses: 0
- unknown responses: 0
- duplicate responses: 0
- unexpected outcomes: 0
- prompt budget violations: 0
- request fingerprints matched: 7/7
- request fingerprints missing: 0
- request fingerprints mismatched: 0
- response metrics complete: 7/7
- response metrics incomplete: 0
- response sources: data/advisor-f3-responses/responses.template.json:7
- response metrics: count 7, avg latency 12570.4ms, p95 latency 19611ms, total tokens 20603

| Candidate | Response | Fingerprint | Stage | Activation | Expected | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| recorded_live_smoke_observe | present | matched | activation | accepted | stage=activation; activation=accepted; skills=observe | ok |
| recorded_supply_chest_state_observe | present | matched | activation | accepted | stage=activation; activation=accepted; skills=observe | ok |
| recorded_single_hostile_flee | present | matched | activation | accepted | stage=activation; activation=accepted; skills=flee | ok |
| recorded_stacked_hostiles_reject_collect | present | matched | activation | accepted | stage=activation; activation=accepted; allowed=flee+observe | ok |
| recorded_hostile_escalation_flee | present | matched | activation | accepted | stage=activation; activation=accepted; requires=flee; allowed=flee+observe+consume | ok |
| recorded_pvm_strength_prep | present | matched | activation | accepted | stage=activation; activation=accepted; skills=consume | ok |
| recorded_fishing_deposit_fixture | present | matched | activation | accepted | stage=activation; activation=accepted; skills=fish_and_deposit | ok |
