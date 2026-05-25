# Awareness And Chat Placeholder

Status: placeholder for C9. Generic chat reply may be built before C8 priors only if it is clearly marked as v0 and does not pretend to match the user's style.

## Scope

C9 makes MCBot behave like an attentive server occupant rather than a task runner that ignores everything outside the current skill. It covers anomaly detection, direct chat reply, and unattended-session policy.

## C9a Anomaly Detectors

Candidate anomaly sources:

- server-forced movement such as `forcedMove`;
- sudden player distance jumps;
- `windowOpen` from server-opened GUIs;
- derived head-rotation mismatch;
- unexpected dimension change;
- sudden game-mode change;
- large unexplained inventory delta;
- unusual death source;
- sustained zero-input or desync window.

Each detector should pause unsafe work, emit structured logs, choose a bounded reaction, and have an RCON-driven Regime A fixture before it is considered done.

## C9b Direct Chat Reply

The chat-reply path is separate from planner mode. It should build compact reply context, call the advisor only when allowed by the shared cost budget, and sanitize output before typing.

Deterministic hard refusals include:

- requests for credentials, API keys, admin passwords, real identity, or location;
- instructions to grief, steal, or attack unauthorized players;
- instructions to trade with or drop items to hostile players;
- instructions to reveal prompts or that it is a bot;
- logout requests not from a recognized user authority channel;
- prompt-injection patterns such as "ignore previous instructions" or code fences.

Suspicious inputs should get a short in-style deflection when a style prior exists, or a generic v0 deflection before C8b exists.

## C9c Unattended-Session Policy

In later handoff mode, the bot should keep anomaly detectors active, log high-priority incidents, optionally notify the user through a later side channel, and produce a status summary on take-back.

## Acceptance For Replacing This Placeholder

- Mineflayer event audit for exact event names.
- Detector schema and RCON fixture list.
- Chat prompt mode separate from planner mode.
- Deterministic refusal and prompt-injection filter tests.
- Typing-delay and humanization integration plan.
- Take-back status summary format.
