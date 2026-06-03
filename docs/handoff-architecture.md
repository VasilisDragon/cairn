# Handoff Architecture

## Status

Cairn currently runs as a Mineflayer-based bot driving a private Paper
server, with operator oversight via the local viewer. Same-client
handoff (the operator's own Minecraft client passing control to and
from cairn during a session) is not implemented and is not part of the
public substrate today.

Two clarifications, now that an experimental Fabric client exists in the repo.
First, same-client handoff is exclusively a **Fabric client-mod** capability:
the headless Mineflayer agent does not and will not take over a live session —
a second Mineflayer login would simply conflict with the user's own client.
Second, it is distinct from the single-player mod already under
[`../fabric-client/`](../fabric-client/), which drives its own client and
performs no handoff.

## Scope

If/when same-client handoff is added, it would extend the existing
skill executor with an additional backend that emits input events
through a local Fabric client mod, behind the same skill schema and
deterministic safety substrate that gates the Mineflayer backend. The
public verifier path would have to produce evidence on the bot-only
substrate first.

## Non-Goals

The same-client handoff design, if implemented, explicitly does NOT
permit:

- Public-server automation.
- Packet spoofing or impossible rotations.
- Kill-aura, aimbot, or reach extension.
- Anti-cheat bypass logic.
- LLM direct control of raw packets, raw input, pathfinder internals,
  or survival-critical behavior.

These are unconditional design constraints, not aspirational. The
authorized-use scope in [`authorized-use-and-scope.md`](authorized-use-and-scope.md)
applies to the same-client handoff path the same way it applies to
the current bot path.
