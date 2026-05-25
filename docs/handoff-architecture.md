# Handoff Architecture Placeholder

Status: placeholder. This file must be filled in and reviewed before any Fabric client-mod handoff code is written.

## Scope

This document will define the later Regime B same-client handoff architecture. The near-term path remains the Mineflayer bot plus local viewer. Same-client handoff is post-F4 work and must not be built before the viewer path produces evidence.

## Required Design Decisions

- Output backend interface: keep Mineflayer as the current backend and add a future Fabric input backend behind the same skill/humanization boundary.
- Account model: Regime A keeps using offline `MCBot`; Regime B uses the user's own Microsoft/Mojang account only with explicit production config.
- Humanization: C1 is mandatory for Fabric because the backend emits literal keyboard/mouse input.
- Invariants: C2 must cap reach, rotation, click timing, movement, and jump behavior.
- Handoff command: define the user-facing command shape, for example `!handoff <goal>. return to <base> by <duration>`.
- Take-back: any user keyboard or mouse input must cancel the active skill and return control immediately.
- Task integration: handoff goals must use existing task-budget and return-planning machinery.
- Failure behavior: disconnect, timeout, death, or unsafe state must stop cleanly and leave a clear status summary.

## Non-Goals

- No public-server automation.
- No proxy handoff path unless the project is explicitly replanned.
- No packet spoofing, impossible rotations, kill-aura, aimbot, reach extension, or anti-cheat bypass logic.
- No DeepSeek direct control of raw packets, raw input, pathfinder internals, or survival-critical behavior.

## Acceptance For Replacing This Placeholder

- Architecture diagram or textual data flow from planner to skill executor to humanization to backend.
- Backend interface contract with Mineflayer and Fabric responsibilities separated.
- Regime A/B operational flow.
- User take-back and graceful logout flow.
- Safety invariants and test plan.
- Open questions listed for user review before implementation.
