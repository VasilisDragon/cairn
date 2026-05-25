# DeepSeek Model Verification

Date: 2026-05-24

Purpose: verify the default advisor model identifier against DeepSeek's published API docs.

## Decision

Use `deepseek-v4-pro` as the new default frontier advisor model.

Keep `DEEPSEEK_MODEL` as an override in code and examples.

## Official Sources Checked

- `https://api-docs.deepseek.com/`
  - The current "Your First API Call" page lists `deepseek-v4-flash` and `deepseek-v4-pro` as current model identifiers.
  - The same page's current OpenAI-format examples use `model: "deepseek-v4-pro"` with thinking enabled.
- `https://api-docs.deepseek.com/updates/`
  - The 2026-04-24 DeepSeek-V4 changelog says the new model parameter should be `deepseek-v4-pro` or `deepseek-v4-flash`.
  - It says legacy `deepseek-chat` and `deepseek-reasoner` names will be discontinued on 2026-07-24 and currently map to v4-flash modes.
- `https://api-docs.deepseek.com/api/list-models`
  - The list-models documentation example includes `deepseek-v4-flash` and `deepseek-v4-pro`.
- `https://api-docs.deepseek.com/quick_start/pricing`
  - The pricing page lists both DeepSeek-V4-Flash and DeepSeek-V4-Pro, with both supporting JSON output and tool calls.

## Rationale

`deepseek-reasoner` is not selected as the new default because the official docs describe it as a compatibility alias scheduled for deprecation, currently pointing to the thinking mode of `deepseek-v4-flash`.

`deepseek-v4-flash` is not selected as the new default because the goal explicitly asks for the current frontier model, and the official examples and model family split identify `deepseek-v4-pro` as the pro/frontier candidate.

## Follow-Up Actions

- FIRST ACTION 2 updates `CLAUDE.md` with the verified model, thinking behavior, loop-frequency rationale, account model, C-track scope, handoff plan, and advisor cost ceiling behavior.
- FIRST ACTION 3 updates runtime defaults and examples from `deepseek-v4-flash` to `deepseek-v4-pro`.
- No runtime behavior changes are included in this checkpoint.
