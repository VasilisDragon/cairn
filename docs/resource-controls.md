# MCBot Resource Controls

MCBot heavy tests and live clients share one exclusive, machine-local lock for all Git worktrees
that use the same common object database. This prevents a baseline run, a root offline run, and a
live Fabric harness from overlapping. A second launcher fails closed and reports the active
owner's purpose, PID, and process start time.

Lock ownership is established by an atomic directory creation, then `owner.json` is atomically
renamed into that directory. Contenders treat the short initialization window as
non-reclaimable. The owner record contains a random owner ID, PID, process-start identity,
repository identity, acquisition time, purpose, and the applied resource controls. An owner is
reclaimed only when its PID is absent or its exact process-start identity no longer matches;
unreadable, malformed, foreign-machine, and unverifiable locks are never removed automatically.
Release also verifies the complete owner identity before renaming and deleting the lock directory.

Lock state is always under the repository's resolved common Git directory in production. Every
linked worktree therefore resolves the same location, and ambient environment cannot redirect it,
so independent top-level launches cannot evade serialization by choosing different directories.
Unit tests receive isolated roots only through the module's
identity-bound test-environment factory, which is not exposed by the CLI or live launchers. The
adjacent JSONL file records bounded acquire, contention, stale-reclaim, and release events without
command lines or credentials.

`fabric-client/run-client.ps1` is the canonical Minecraft launcher. It requires Idle process
priority, confines the launcher and its children to one logical processor, uses one Gradle worker,
and defaults Minecraft to a 30 FPS, four-chunk render profile. `-FullQuality`,
`MCBOT_FULL_QUALITY_CLIENT=1`, or the compatibility setting `MCBOT_LOW_SPEC_CLIENT=0` opts out of
the reduced render settings only. The exclusive lock and JVM limits remain mandatory:

- 1 GiB maximum heap for the Minecraft `JavaExec` process;
- Serial GC;
- two JVM-visible processors and two compiler threads;
- ForkJoin common parallelism of one.

The live harness and brain wrappers acquire or inherit the same lease, apply the same scheduling
policy, and release it in `finally`/process-exit cleanup. Resource-controlled PowerShell scripts
must be launched as the exact `-File` entrypoint of a dedicated PowerShell 7 process; in-process
invocation and `-NoExit` are refused before Job Object assignment. This keeps a reusable terminal
and programs launched from it outside MCBot's kill-on-close containment. PowerShell children inherit four
`MCBOT_RESOURCE_LOCK_*` values; these are ownership capabilities for local child processes, not
credentials, and must be propagated unchanged by sanitized child environments.

PowerShell launchers enforce `KILL_ON_JOB_CLOSE`, Idle priority, and one-core affinity as Job
Object limits, with immediate configuration readback. Those limits apply to every later Gradle
and Java descendant. Gradle's `org.gradle.priority=low` option is deliberately prohibited because
on Windows it launches the single-use daemon as BelowNormal instead of inheriting Idle. Canonical
Gradle waits continuously validate contained descendants and record the observed Java process.

Canonical Node live entrypoints load `config/low-impact-node.env` through Node's launch-time
`--env-file` option before startup, cap the V8 worker pool to one, and then import the lock
bootstrap. The bootstrap refuses a missing or non-1/2 `UV_THREADPOOL_SIZE`; it never sets that
variable in-process, because doing so after Node initialization cannot prove the libuv pool size.
Before acquiring the lock, the shared Node helper applies Idle priority and a one-core affinity to
the exact parent Node process through a bounded verifier and records the read-back affinity and
process-start identity. Child processes inherit that operating-system policy.

The public `check` and `test:det` commands use the same launch-time profile. Deterministic
evaluation also validates the cap itself, acquires or joins the repository-wide lease, and adds
the bootstrap, V8 cap, libuv cap, and exact lease quartet to every Node child and grandchild. A
raw or ambiguously capped deterministic launch fails before running a producer or changing a
report.

Harness cleanup snapshots both PID and process start time, waits a bounded period for natural
exit, and then revalidates the creation time and terminates through the same retained native
process handle. It never uses PID-based window-close messages. Fallback discovery is limited to MCBot command signatures;
unrelated Java programs (including RuneLite) are neither counted as MCBot clients nor cleanup
targets.

For a direct Gradle invocation, use `scripts/run-gradle-low-impact.ps1`, for example:

```powershell
pwsh -NoProfile -File scripts/run-gradle-low-impact.ps1 fabric-client test --offline
```

The wrapper uses the same exclusive lease, Idle/one-core scheduling, and one-worker Gradle limit.

## Phase-1 local Paper boundary

The existing `D:\Minecraft\Server\start.bat` is not a low-impact launcher: it requests a 10 GiB
G1 heap and twelve parallel GC threads and detaches the server from MCBot process containment.
Phase 1 therefore fails closed whenever an exact, stable listener is present on the local
Minecraft/RCON ports (25565 or 25575). The baseline, direct offline runner, Gradle/client/brain
PowerShell wrappers, Fabric live harnesses, plugin-backed live runner, and RCON transport all
enforce this admission check. On Windows, the check records PID plus process-start identity and
compares two listener snapshots. It never stops or reprioritizes the listener process.

The legacy `scripts/server-bring-up.ps1` entrypoint is disabled. Local Paper-backed live and RCON
testing must remain off during this stabilization phase. Remote-server live work may still use the
explicit live gates because it consumes no local server CPU or heap, but Phase 1 requires the
configured endpoint to be a validated non-local IP literal. Hostnames are rejected so a DNS alias
or rebinding cannot cross the local-server boundary between admission and connection. A later
phase may replace this boundary with one composite supervisor that owns and attests both the
low-impact server and its live harness under a single admission policy.

Offline launchers also prove that the default Minecraft and RCON ports have no local listeners
before acquiring the resource lock. Windows validates listener PID/start identities with
`Get-NetTCPConnection`; Linux double-samples `/proc/net/tcp` and `/proc/net/tcp6` and fails closed
if either table is unavailable, malformed, or changes during inspection.
