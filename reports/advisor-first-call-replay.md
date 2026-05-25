# Advisor First-Call Replay

- no API call made: yes
- status: validated_model_responses
- require complete responses: no
- require response metrics: no
- expected responses: 1
- present responses: 1
- missing responses: 0
- unknown responses: 0
- duplicate responses: 0
- unexpected outcomes: 0
- prompt budget violations: 0
- request fingerprints matched: 1/1
- request fingerprints missing: 0
- request fingerprints mismatched: 0
- response metrics complete: 1/1
- response metrics incomplete: 0
- response sources: data/advisor-first-call-responses/responses.template.json:1
- response metrics: count 1, avg latency 4755ms, p95 latency 4755ms, total tokens 2377

| Candidate | Response | Fingerprint | Stage | Activation | Expected | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| recorded_live_smoke_observe | present | matched | activation | accepted | stage=activation; activation=accepted; skills=observe | ok |
