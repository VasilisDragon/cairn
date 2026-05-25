# Observation And Priors Placeholder

Status: placeholder for C8. Do not build prior consumption before observation capture exists.

## Scope

The C8 workstream will let MCBot learn local, reviewable, server-specific behavior priors from the user's own play patterns. The system must be local-only and user-reviewable. Raw observations must not be uploaded or sent directly to DeepSeek.

## C8a Observation Capture

Initial observation capture can use two paths:

- Out-of-game scraping: RCON chat logs, scoreboard polls, and server-log tails. This captures public/server-visible events only and can be tested in Regime A with RCON-injected events.
- Passive Fabric logger: a later read-only client mod that records the user's input, position, inventory deltas, and chat without taking over control.

Raw records should live under gitignored `data/observations/<server-id>/` as structured JSONL.

## C8b Prior Extraction

Extraction should distill observations into compact, editable facts such as:

- common fishing or mining locations;
- avoided or trusted players;
- common session lengths;
- preferred tools, routes, and base habits;
- chat style and common abbreviations;
- recurring safety behaviors.

Output should live under `data/priors/<server-id>.json`.

## C8c Prior Consumption

Reviewed priors may inform:

- advisor server-context blocks;
- chat-reply style templates;
- C1 humanization mood/style defaults;
- task preferences and route choices.

Priors are advisory only. Reactive survival, deterministic safety gates, no-cheat constraints, and user instructions always override priors.

## Privacy And Safety Requirements

- Local-only storage.
- No raw observations sent to DeepSeek.
- Redaction before any summarization.
- User can delete observations and priors at any time.
- Priors require explicit user review before consumption.
- The bot must function in degraded mode when no priors exist.

## Acceptance For Replacing This Placeholder

- Observation schema.
- Redaction plan.
- Prior JSON schema.
- Review/edit CLI design.
- Regime A test fixture plan.
- DeepSeek prompt-boundary rules for distilled priors only.
