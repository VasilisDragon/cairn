# Fabric furnace, shore, and descent recovery

This catch-up follows the combat, crafting, and descent changes in
[PR #10](https://github.com/VasilisDragon/cairn/pull/10). It brings three
previously reviewed corrections into the public client without importing
private runtime history or changing progression requirements.

## Changes

- **Furnace use:** when opening or safely reopening a furnace requires an
  empty hand, prefer an existing empty hotbar slot. Otherwise prepare one
  using a single authorized player-inventory swap and verify the exact stack
  and inventory after settlement. Protected items, pending ingredient/fuel
  clicks, closed-screen cooking waits, interaction receipts, and original
  smelting deadlines remain enforced. A recreated command cannot renew the
  mutation allowance or turn a prior failure into completion.
- **Shore recovery:** retain and deterministically rank already-admitted safe
  shores when water search reaches its existing 512-cell cap. No larger search
  budget, relaxed hazard checks, or change to dry-origin behavior is added.
- **Descent return:** prefer a validated recorded route. If the actual cell is
  absent from that route but is exactly one cardinal block from its final
  accepted target at the same elevation, a two-cell return may be admitted
  after validating both cells and both transition directions. It consumes
  the existing single rejoin attempt, preserves the command deadline, and
  grants no mining or descent progress. Grounded arrival still requires fresh
  validation before normal work resumes.

Reach, interaction/movement authorities, inventory protections, survival
priority, and retry budgets remain unchanged. Changes remain internal to
executor policies and telemetry; there is no new advisor action, public configuration,
or external command schema.

## Public source manifest

Source commits: furnace `76f115d7`, shore `66bdd6c4`, and descent `f877fa79`.
The exact runtime/test allowlist below is relative to `fabric-client/src/`;
all files use the `com/mcbot/fabricclient/` package.

| Production (`main/java/`) | Portable tests (`test/java/`) |
|---|---|
| `FurnaceHandPreparation.java` | `FurnaceHandPreparationTest.java`, `FurnaceHandPreparationIntegrationTest.java` |
| `McbotFabricClient.java` | Covered by the furnace integration assertions |
| `GatherWoodLocalEgressPlanner.java` | `GatherWoodLocalEgressPlannerTest.java` |
| `DescentRejoinPolicy.java` | `DescentAdjacentReturnTest.java` |
| `DescentExecutor.java` | `DescentRejoinIntegrationTest.java` |

The shared client and descent executor use reviewed hunks, retaining existing
public-only context and prior adaptations. The changes add 73 portable JUnit
cases: 38 furnace, 11 shore, and 24 descent tests. An initial estimate of 77
mistook private baseline-floor headroom for new tests; no test was removed to
correct that estimate.

Other publication changes are this document, README and historical-note
links, and the verified baseline floor. Private fixtures and companion-mod
wiring, harnesses, diagnostic instrumentation, worlds, raw evidence,
authentication material, private work logs, and later unqualified changes are
excluded. Existing authorship, licenses, and functional advisor references
are preserved.

## Local qualification

Run focused furnace/shore/rejoin tests, then the existing authority,
crafting/smelting, combat/survival, descent, surface-return, village, wood, and
mission controls. Run the complete public baseline against a clean committed
candidate, with external output:

```text
npm run test:baseline -- --output-root <external-directory>
```

All work is serialized at Idle priority on one CPU, using one Gradle worker
and Serial GC. The baseline installs dependencies offline into a disposable
worktree and runs Gradle offline. Node guards and offline dependency resolution
are not a claim of OS-level network isolation or a hermetic environment.

| Gate | Required floor |
|---|---:|
| Checked JavaScript files | 285 |
| Root offline files / tests | 119 / 1,355 |
| Fabric brain tests | 449 |
| Fabric JUnit tests | 2,014 |
| Paper tests | 16 |
| Paper jars containing `plugin.yml` | Exactly 1 |

The complete baseline passed at `88dfdbcefcccc3a984ef8e59a60d515bff4daafb`
on 2026-09-10. Actual totals matched every floor above: 285 checked JavaScript
files; 119 root files / 1,355 tests; 9 brain files / 449 tests; 2,014 Fabric
JUnit tests; and 16 Paper tests with exactly one valid plugin jar. Only the
two documented provider-disabled smoke commands skipped. No test failures,
errors, or unexpected skips occurred.

The focused suite passed 111 tests and the broader controls passed 943 tests
at source candidate `f877fa79`, both with no failures or skips. Production and
portable tests were unchanged between that candidate and the baseline commit;
the latter added only the public documentation and baseline-floor update.
These suites overlap the full baseline and are not added to its totals.

The baseline took 1,270,459 ms. Independent verification checked all 300
artifact sizes/hashes and 11 mandatory evidence records, fresh deterministic
evaluation, zero captured provider payloads, matching clean start/finish SHA,
successful disposable-worktree removal, and resource-lock release. The final
baseline summary SHA-256 is
`983e2cbc2e12acbd01db9d2088c65929472cf50d41d055f287d2e0ebaabdf5b9`.
Raw local evidence is not published. Later status wording changes are
documentation-only and do not claim a new execution SHA. Both workflows remain
manual-dispatch-only; no GitHub Actions or Minecraft run was started.

## Supporting evidence and limits

Private controlled fixtures and private offline baselines qualified the three
scoped corrections before this port. The latest completed private five-world
campaign recorded **5/5 wood exits, 2/5 MINE_IRON entries, and 0/5 complete
iron-and-armor finishes**, with zero observed deaths, authority violations,
provider attempts, or cleanup failures. All five fresh Normal-survival worlds
were commandless and provider-free, with no infrastructure replacements.
Gameplay failures remain counted. These are private supporting results, not a
public campaign rerun or a controlled performance comparison across versions.

No campaign world admitted an adjacent return; its positive proof comes from
the disclosed private controlled fixtures. Larger/vertical displacements,
expired commands, and later iron-search blockers remain outside this port.
Existing route-cursor warnings remain visible and disqualifying.

A separate private landing qualification remains incomplete before its
required frozen/fixed mechanism. Its existing logs locate a long client
callback but do not isolate planner, observer, scheduling, or GC cost. This
port contains none of that instrumentation and claims no repair of that timing
issue or client FPS. No additional live run was used for this context-only
public integration.

Phase A remains open: 5/5 wood exits, at least 4/5 iron entries, at least 3/5
full iron-and-armor completions, zero deaths, zero authority violations,
provider-free execution, and clean cleanup are still required.
`northStarEligible=false` remains unchanged; this is not dragon readiness.
