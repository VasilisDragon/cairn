# C4 Carpet-PvP Heuristic Extraction

Status: scaffolded, prose-only, no runtime dependency.

This checkpoint inspected the user-supplied `carpet-pvp-1.21-1.2.0+v250515.jar` as a local reference artifact. The jar was extracted only into the gitignored `vendor/decompiled/` workspace so class names, manifests, scripts, and public signatures could be reviewed without adding the jar, copied source, or generated class output to this repository.

No Java source decompiler was available during this pass. The review used the jar manifest, bundled license, file/class inventory, Scarpet script names and topics, and limited `javap -public` signatures. That is enough for a safe first extraction of ideas, but not enough to claim detailed implementation parity.

## Source And License Notes

- The jar manifest identifies the mod as `Carpet PVP`, described as `Carpet with some PVP tweaks`.
- The bundled license and manifest identify the license as MIT.
- The extracted workspace is intentionally ignored by git through `.gitignore`.
- This project does not import, load, vendor, or depend on the jar at runtime.

## What The Jar Appears To Provide

- Carpet/Scarpet server tooling rather than a ready-made general PvP agent.
- Fake-player/player-command infrastructure through an action-pack style control surface.
- Scarpet scripts for AI visibility, camera paths, chunk display, distance/drawing overlays, event inspection, and lightweight stats.
- Event/mixin surfaces around player actions, fake players, path navigation, explosions, TNT, and end crystals.
- Debug/visualization ideas that are useful for private-server fixtures and analysis.

## Safe Ideas To Recreate Independently

- Build combat and PvP fixtures around ordinary player-action primitives: move, sprint, sneak, look, attack, use item, select slot, drop, stop movement, and stop all.
- Treat combat evaluation as observable telemetry first: position, velocity, target distance, line of sight, health, armor, effects, equipment, nearby hazards, explosion events, and path state.
- Add private-server fake-player or dummy-style fixtures before real PvP claims. The fixtures should make target motion, spacing, aggression, armor, potion state, and hazard placement explicit.
- Add overlay/report concepts for later publication evidence: threat rings, path decisions, target locks, projectile/explosion timing windows, and flee/engage state transitions.
- For crystal PvP, start with an original scoring model that compares expected self damage, expected opponent damage, armor/effect mitigation, escape routes, block cover, line of sight, and post-explosion recovery options.
- For general PvM/PvP, keep the deterministic layer focused on bounded validators and action execution while DeepSeek receives compact summaries for planning, re-evaluation, and postmortems.

## Explicit Non-Goals

- No source code was copied from the jar.
- No class or method structure from the jar should be recreated as a dependency shape.
- No packet-level swap or packet spoof path is allowed.
- No sub-tick timing, reach extension, kill-aura, aimbot, autoclicker, impossible rotation, or anti-cheat bypass behavior is allowed.
- No public-server behavior is allowed.

## Project Implications

The jar is most useful as evidence that private-server instrumentation, fake-player fixtures, and explosion/crystal event observation are practical directions. It is not enough by itself to solve high-level PvP. The next useful implementation work is an original benchmark ladder:

- PvM fixture ladder: isolated zombie, stacked zombies, ranged hostile, creeper-safe ranged/melee, mixed hostile group, retreat-and-resume.
- PvP fixture ladder: stationary dummy, moving dummy, armored dummy, potion-prep duel, bow/melee swap, lava/water hazard response, block-cover response.
- Crystal fixture ladder: blast-radius measurement, self-damage cap, target-damage threshold, cover placement, detonation escape, opponent-crystal avoidance.

Each fixture should remain private-server-only and should produce public-safe reports with no raw server logs, secrets, or copied third-party implementation details.
