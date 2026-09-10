# Fabric mission continuity

This document records the earlier combat/crafting/descent port in PR #10.
For the subsequent furnace, shore, and adjacent-return changes and current
qualification, see [Fabric recovery](fabric-phase-a-recovery.md).

This port brings three bounded corrections into the Fabric client after
[PR #9](https://github.com/VasilisDragon/cairn/pull/9). They address combat
occupancy, full-hotbar crafting preparation, and descent resumption. They do
not add progression milestones or establish dragon readiness.

## Changes

- **Combat:** screened melee threats more than eight blocks away may be
  deferred only while fresh eye/torso raycasts and survival observations allow
  it. Deferral is reconsidered every tick. Encounters retain their budgets
  across target and command changes: eight seconds without meaningful progress
  or 30 seconds active engagement enters bounded recovery. Recovery lasts at
  most 12 seconds before safe release or `combat_preemption_exhausted`.
- **Crafting:** before opening a table for a shared 3×3 recipe, an existing
  empty hotbar slot is preferred. Otherwise one eligible stack may be swapped
  into empty player storage through the existing inventory authority. The
  exact stack and inventory are verified after settlement. One mutation is
  permitted per command, within its existing total crafting timeout. Protected
  items remain protected; no dropping, consolidation, or furnace preparation
  is added.
- **Descent:** combat/survival preemption is observed without resetting the
  command. Rejoin uses the recorded trail and current world, stance, hazard,
  and deadline checks. Final-landing braking is retained. Exhaustion and
  critical-health shutdown capture terminal evidence before disconnect;
  capture failure cannot prevent the safety disconnect.

All movement and interactions remain behind the existing authorities. No
advisor action, public configuration, or external command schema changes.

## Public source manifest

The source changes are split into three commits: combat (`b8f50ed0`), crafting
(`aeddfac9`), and descent/terminal capture (`8bfd3033`). Only the following
11 production and 10 portable test files are included. Paths below are relative
to `fabric-client/src/`; each uses the `com/mcbot/fabricclient/` package.

| Production file (`main/java/`) | Change |
|---|---|
| `CombatController.java` | Admission, encounter bounds, terminal capture |
| `CombatEncounterTracker.java` | Encounter progress and recovery budgets |
| `CombatThreatAdmission.java` | Pure threat deferral policy |
| `TargetPriorityPlanner.java` | Actionable target selection |
| `CraftHandPreparation.java` | Command-owned preparation transaction |
| `HotbarItemProtection.java` | Shared existing protection predicate |
| `VillageOpportunityExecutor.java` | Reuse the protection predicate |
| `DescentExecutor.java` | Preemption and recorded-trail rejoin |
| `DescentRejoinPolicy.java` | Pure bounded rejoin policy |
| `ShellServices.java` | Read-only trail interface |
| `McbotFabricClient.java` | Shared-client integration hooks |

Portable tests (`test/java/`):

```text
CombatEncounterTrackerTest.java
CombatMissionHandoffTest.java
CombatThreatAdmissionTest.java
CraftHandPreparationIntegrationTest.java
CraftHandPreparationTest.java
DescentRejoinIntegrationTest.java
DescentRejoinPolicyTest.java
IronGolemOpportunityExecutorIntegrationSourceTest.java
LiveEvidenceShutdownSourceTest.java
VillageOpportunityExecutorIntegrationSourceTest.java
```

Seven new test files add 115 tests; the other three update source assertions.
The shutdown-order assertion uses Cairn's existing `clearSurfaceReturnState()`
boundary. No unrelated lifecycle cleanup was introduced to satisfy the test.
Shared-client and descent changes were applied by reviewed hunks, preserving
older public/private differences instead of replacing those files wholesale.

The remaining publication changes are this document, README status wording,
public baseline floors, and manual-only triggers in the two existing workflows.
Private history, fixtures and companion-mod wiring, live harnesses, diagnostic
scripts, world files, raw evidence, authentication data, and private work logs
are excluded. Existing authorship, licenses, and functional advisor references
are preserved.

## Local qualification contract

Run the focused combat, crafting, shutdown, and rejoin tests first, then the
existing authority, survival, furnace, descent, surface-return, village, and
mission controls. Run all work serially at Idle priority on one CPU, with one
Gradle worker and Serial GC; do not overlap Minecraft with these tests.

The complete public gate is:

```text
npm run test:baseline -- --output-root <external-directory>
```

The runner checks a clean committed candidate in a disposable worktree and
keeps its summaries, hashes, and artifacts outside the repository. It uses
offline dependency installation and Gradle offline mode. Local network guards
are not a claim of OS-level network isolation.

| Gate | Required floor |
|---|---:|
| JavaScript files checked | 285 |
| Root offline files / tests | 119 / 1,355 |
| Fabric brain tests | 449 |
| Fabric JUnit tests | 1,941 |
| Paper tests | 16 |
| Paper plugin jars containing `plugin.yml` | Exactly 1 |

Only the two existing provider-gated brain smoke skips are expected. All other
failures, errors, count decreases, or unexpected skips block qualification.
Actual results and the tested commit are recorded in the pull request. Both
GitHub workflows are manual-dispatch-only in this change; local qualification
does not depend on starting an Actions run.

## Supporting evidence and limits

At the time of this port, the latest private five-world campaign recorded
4/5 wood exits, 1/5 iron
entries, and 0/5 Phase-A completions, with zero observed deaths, zero authority
violations, no infrastructure replacements, and clean cleanup. The worlds
were fresh Normal survival, commandless, and provider-free. These aggregate
results label private support; they are not a public live-campaign rerun.

Private controlled fixtures support the scoped corrections. The campaign did
not establish a positive rejoin; one descent rejection followed an already
expired command, not a new traversal timeout. The earlier tree-route authority
warning remains disqualifying when observed and was not changed by this port.
Original campaign counts are not rewritten.

Phase A still requires 5/5 wood exits, at least 4/5 iron entries, at least 3/5
full completions, zero deaths, zero authority violations, and clean cleanup.
It remained open. Furnace empty-hand preparation was separate work in this
port; it is covered by the subsequent recovery port linked above. No new live
campaign is claimed for this context-only
public integration. `northStarEligible=false` remains unchanged until
authoritative record auditing and the full North-Star requirements are met.
