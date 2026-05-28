# Handoff Architecture

## Status

Cairn currently runs as a Mineflayer-based bot driving a private Paper
server, with operator oversight via the local viewer. Same-client
handoff (the operator's own Minecraft client passing control to and
from cairn during a session) is not implemented and is not part of the
public substrate today.

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
