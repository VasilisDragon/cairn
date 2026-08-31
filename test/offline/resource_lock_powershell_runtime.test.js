import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RESOURCE_LOCK_ENV,
  applyLowImpactNodeScheduling,
  resolveResourceLockLocation,
} from '../../scripts/resource-lock.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

const DAEMON_SURROGATE = String.raw`param(
  [Parameter(Mandatory = $true)][string]$PolicyReceiptPath
)
$ErrorActionPreference = 'Stop'
$self = [Diagnostics.Process]::GetCurrentProcess()
try { $self.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal } catch { }
$self.Refresh()
$record = [ordered]@{
  pid = [int]$self.Id
  priorityClass = [string]$self.PriorityClass
  processorAffinity = ('0x{0:x}' -f $self.ProcessorAffinity.ToInt64())
}
[IO.File]::WriteAllText($PolicyReceiptPath, ($record | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
[Threading.Thread]::Sleep(20000)
`;

const DESCENDANT_HELPER = String.raw`param(
  [Parameter(Mandatory = $true)][string]$GatePath,
  [Parameter(Mandatory = $true)][string]$ReceiptPath,
  [Parameter(Mandatory = $true)][string]$DaemonScript,
  [Parameter(Mandatory = $true)][string]$PolicyReceiptPath
)
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while (-not (Test-Path -LiteralPath $GatePath -PathType Leaf)) {
  if ([DateTime]::UtcNow -ge $deadline) { throw 'test descendant gate timed out' }
  Start-Sleep -Milliseconds 20
}
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.UseShellExecute = $false
$startInfo.FileName = [Diagnostics.Process]::GetCurrentProcess().Path
[void]$startInfo.ArgumentList.Add('-NoLogo')
[void]$startInfo.ArgumentList.Add('-NoProfile')
[void]$startInfo.ArgumentList.Add('-NonInteractive')
[void]$startInfo.ArgumentList.Add('-ExecutionPolicy')
[void]$startInfo.ArgumentList.Add('Bypass')
[void]$startInfo.ArgumentList.Add('-File')
[void]$startInfo.ArgumentList.Add($DaemonScript)
[void]$startInfo.ArgumentList.Add('-PolicyReceiptPath')
[void]$startInfo.ArgumentList.Add($PolicyReceiptPath)
$child = [Diagnostics.Process]::new()
$child.StartInfo = $startInfo
if (-not $child.Start()) { throw 'unable to start test descendant' }
$record = [ordered]@{
  pid = [int]$child.Id
  startTimeUtcTicks = [int64]$child.StartTime.ToUniversalTime().Ticks
}
[IO.File]::WriteAllText($ReceiptPath, ($record | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
`;

const RUNTIME_DRIVER = String.raw`param(
  [Parameter(Mandatory = $true)][string]$RepositoryRoot,
  [Parameter(Mandatory = $true)][string]$ResourceLockScript,
  [Parameter(Mandatory = $true)][string]$DescendantScript,
  [Parameter(Mandatory = $true)][string]$DaemonScript,
  [Parameter(Mandatory = $true)][string]$GatePath,
  [Parameter(Mandatory = $true)][string]$ReceiptPath,
  [Parameter(Mandatory = $true)][string]$PolicyReceiptPath
)
$ErrorActionPreference = 'Stop'
foreach ($name in @(
  'MCBOT_RESOURCE_LOCK_PATH',
  'MCBOT_RESOURCE_LOCK_OWNER_ID',
  'MCBOT_RESOURCE_LOCK_REPOSITORY_ID',
  'MCBOT_RESOURCE_LOCK_OWNER_PID',
  'MCBOT_RESOURCE_LOCK_ROOT'
)) {
  [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
. $ResourceLockScript

$currentPolicy = $null
$sentinelProcess = $null
$sentinelIdentity = $null
$lease = $null
$targetRegistration = $null
$drainRegistration = $null
$result = [ordered]@{}
$overall = [Diagnostics.Stopwatch]::StartNew()
try {
  $currentPolicy = Set-McbotLowImpactProcessPolicy -Role 'resource-lock-runtime-test-driver'

  # Start this test-owned sentinel before assigning the driver to its production
  # Job Object. It must remain outside that Job and survive every scoped drain.
  $sentinelStartInfo = [Diagnostics.ProcessStartInfo]::new()
  $sentinelStartInfo.UseShellExecute = $false
  $sentinelStartInfo.WorkingDirectory = [IO.Path]::GetTempPath()
  $sentinelStartInfo.FileName = [Diagnostics.Process]::GetCurrentProcess().Path
  foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Threading.Thread]::Sleep(20000)')) {
    [void]$sentinelStartInfo.ArgumentList.Add($argument)
  }
  $sentinelProcess = [Diagnostics.Process]::new()
  $sentinelProcess.StartInfo = $sentinelStartInfo
  if (-not $sentinelProcess.Start()) { throw 'unable to start test-owned sentinel' }
  $sentinelIdentity = New-McbotProcessIdentity -Process $sentinelProcess -Role 'test-owned-unrelated-sentinel'
  if ($null -eq $sentinelIdentity) { throw 'unable to identify test-owned sentinel' }
  $sentinelPolicy = Set-McbotLowImpactChildProcessPolicy -Process $sentinelProcess -Role 'test-owned-unrelated-sentinel'

  $lease = Enter-McbotResourceLock -RepositoryRoot $RepositoryRoot -Purpose 'resource-lock-runtime-test' -EntrypointPath $PSCommandPath -Controls @{
    schedulingPriority = $currentPolicy.PriorityClass
    processorAffinity = $currentPolicy.ProcessorAffinity
    dummyProcessesOnly = $true
  }
  $result.driverIdle = $currentPolicy.PriorityClass -eq 'Idle'
  $driverAffinity = [Convert]::ToInt64(($currentPolicy.ProcessorAffinity -replace '^0x', ''), 16)
  $result.driverOneCore = $driverAffinity -gt 0 -and ($driverAffinity -band ($driverAffinity - 1)) -eq 0
  $result.sentinelIdle = $sentinelPolicy.PriorityClass -eq 'Idle'
  $sentinelAffinity = [Convert]::ToInt64(($sentinelPolicy.ProcessorAffinity -replace '^0x', ''), 16)
  $result.sentinelOneCore = $sentinelAffinity -gt 0 -and ($sentinelAffinity -band ($sentinelAffinity - 1)) -eq 0
  $result.sentinelOutsideJob = [int]$sentinelIdentity.Pid -notin @(Get-McbotKillOnCloseJobProcessIds)

  $sleepArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Threading.Thread]::Sleep(20000)')
  $targetRegistration = Start-McbotRegisteredWorkloadProcess -Lease $lease -FilePath ([Diagnostics.Process]::GetCurrentProcess().Path) -ArgumentList $sleepArguments -WorkingDirectory ([IO.Path]::GetTempPath()) -Role 'runtime-test-exact-target'
  $result.targetRegisteredInJob = [int]$targetRegistration.Identity.Pid -in @(Get-McbotKillOnCloseJobProcessIds)
  $targetAffinity = [Convert]::ToInt64(($targetRegistration.ProcessPolicy.ProcessorAffinity -replace '^0x', ''), 16)
  $result.targetIdleOneCore = $targetRegistration.ProcessPolicy.PriorityClass -eq 'Idle' -and $targetAffinity -gt 0 -and ($targetAffinity -band ($targetAffinity - 1)) -eq 0

  $wrongTargetIdentity = [pscustomobject]@{
    Pid = [int]$targetRegistration.Identity.Pid
    StartTimeUtcTicks = [int64]$targetRegistration.Identity.StartTimeUtcTicks + 1
  }
  $result.wrapperMismatchRefused = -not [bool](Stop-McbotProcessIdentityTree -Identity $wrongTargetIdentity)
  $result.targetSurvivedMismatch = Test-McbotProcessIdentity -Identity $targetRegistration.Identity

  $nativeMismatchError = 0
  $result.nativeMismatchRefused = -not [Mcbot.ResourceControl.NativeProcess]::TerminateExact(
    [int]$sentinelIdentity.Pid,
    [int64]$sentinelIdentity.StartTimeUtcTicks + 1,
    [ref]$nativeMismatchError
  )
  $result.nativeMismatchError = [int]$nativeMismatchError
  $result.sentinelSurvivedNativeMismatch = Test-McbotProcessIdentity -Identity $sentinelIdentity

  $equalTickParent = [pscustomobject]@{
    Pid = [int]$targetRegistration.Identity.Pid
    StartTimeUtcTicks = [int64]$sentinelIdentity.StartTimeUtcTicks
  }
  $result.equalTickDescendantRefused = -not [bool](Test-McbotStrictDescendantIdentity -ParentIdentity $equalTickParent -ChildIdentity $sentinelIdentity)
  if (-not $result.equalTickDescendantRefused) {
    [void](Stop-McbotProcessIdentityTree -Identity $sentinelIdentity)
  }
  $result.sentinelSurvivedEqualTickRefusal = Test-McbotProcessIdentity -Identity $sentinelIdentity

  $result.exactIdentityStopped = [bool](Stop-McbotProcessIdentityTree -Identity $targetRegistration.Identity)
  [void]$targetRegistration.Process.WaitForExit(2000)
  $result.exactTargetGone = -not (Test-McbotProcessIdentity -Identity $targetRegistration.Identity)
  $result.sentinelSurvivedExactStop = Test-McbotProcessIdentity -Identity $sentinelIdentity
  Complete-McbotResourceLockWorkloadProcess -Registration $targetRegistration

  $drainRegistration = Start-McbotRegisteredWorkloadProcess -Lease $lease -FilePath ([Diagnostics.Process]::GetCurrentProcess().Path) -ArgumentList @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', $DescendantScript, '-GatePath', $GatePath, '-ReceiptPath', $ReceiptPath,
    '-DaemonScript', $DaemonScript, '-PolicyReceiptPath', $PolicyReceiptPath
  ) -WorkingDirectory ([IO.Path]::GetTempPath()) -Role 'runtime-test-descendant-root'
  [IO.File]::WriteAllText($GatePath, '', [Text.UTF8Encoding]::new($false))
  $descendantWaitReceipt = Wait-McbotRegisteredWorkloadProcessLowImpact -Registration $drainRegistration -RequiredProcessName @('pwsh')
  $result.descendantWaitObserved = [int]$descendantWaitReceipt.ObservedProcessCount -ge 1
  if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) { throw 'test descendant receipt was not written' }
  $policyDeadline = [DateTime]::UtcNow.AddSeconds(3)
  while (-not (Test-Path -LiteralPath $PolicyReceiptPath -PathType Leaf)) {
    if ([DateTime]::UtcNow -ge $policyDeadline) { throw 'test daemon-surrogate policy receipt was not written' }
    Start-Sleep -Milliseconds 20
  }
  $descendantRecord = Get-Content -Raw -LiteralPath $ReceiptPath | ConvertFrom-Json
  $daemonPolicyRecord = Get-Content -Raw -LiteralPath $PolicyReceiptPath | ConvertFrom-Json
  $descendantIdentity = [pscustomobject]@{
    Pid = [int]$descendantRecord.pid
    StartTimeUtcTicks = [int64]$descendantRecord.startTimeUtcTicks
    Role = 'runtime-test-descendant'
  }
  $descendantProcess = Get-McbotValidatedProcess -Identity $descendantIdentity
  if ($null -eq $descendantProcess) { throw 'test descendant identity was not active' }
  $descendantAffinity = $descendantProcess.ProcessorAffinity.ToInt64()
  $policySnapshot = @(Assert-McbotKillOnCloseJobChildrenLowImpact)
  $result.descendantRegisteredInJob = [int]$descendantIdentity.Pid -in @(Get-McbotKillOnCloseJobProcessIds)
  $result.descendantIdleOneCore = $descendantProcess.PriorityClass -eq [Diagnostics.ProcessPriorityClass]::Idle -and $descendantAffinity -gt 0 -and ($descendantAffinity -band ($descendantAffinity - 1)) -eq 0
  $result.descendantPolicyReadBack = @($policySnapshot | Where-Object { [int]$_.Pid -eq [int]$descendantIdentity.Pid -and [bool]$_.PolicyValid }).Count -eq 1
  $reportedDaemonAffinity = [Convert]::ToInt64(([string]$daemonPolicyRecord.processorAffinity -replace '^0x', ''), 16)
  $result.daemonSurrogateOverrideDenied = [int]$daemonPolicyRecord.pid -eq [int]$descendantIdentity.Pid -and [string]$daemonPolicyRecord.priorityClass -eq 'Idle' -and $reportedDaemonAffinity -gt 0 -and ($reportedDaemonAffinity -band ($reportedDaemonAffinity - 1)) -eq 0
  $descendantProcess.Dispose()

  $drainTimer = [Diagnostics.Stopwatch]::StartNew()
  Stop-McbotKillOnCloseJobChildren -Reason 'runtime-test-bounded-drain'
  $drainTimer.Stop()
  $result.drainMilliseconds = [int64]$drainTimer.ElapsedMilliseconds
  $result.descendantGone = -not (Test-McbotProcessIdentity -Identity $descendantIdentity)
  $result.sentinelSurvivedJobDrain = Test-McbotProcessIdentity -Identity $sentinelIdentity
  Complete-McbotResourceLockWorkloadProcess -Registration $drainRegistration
  $result.childReceiptsRemoved = @(Get-ChildItem -LiteralPath $lease.LockPath -Filter 'workload-child-*.json' -ErrorAction SilentlyContinue).Count -eq 0
  $result.jobChildrenAfterDrain = @(Get-McbotKillOnCloseJobProcessIds | Where-Object { [int]$_ -ne $PID }).Count

  $lockPath = [string]$lease.LockPath
  $releaseTimer = [Diagnostics.Stopwatch]::StartNew()
  Exit-McbotResourceLock -Lease $lease
  $releaseTimer.Stop()
  $result.releaseMilliseconds = [int64]$releaseTimer.ElapsedMilliseconds
  $result.lockReleased = -not (Test-Path -LiteralPath $lockPath)
  $result.sentinelSurvivedRelease = Test-McbotProcessIdentity -Identity $sentinelIdentity
} finally {
  if ($null -ne $drainRegistration -and -not $drainRegistration.Released) {
    try { Stop-McbotRegisteredWorkloadProcess -Registration $drainRegistration } catch { }
  }
  if ($null -ne $targetRegistration -and -not $targetRegistration.Released) {
    try { Stop-McbotRegisteredWorkloadProcess -Registration $targetRegistration } catch { }
  }
  if ($null -ne $lease -and -not $lease.Released) {
    try { Exit-McbotResourceLock -Lease $lease } catch { }
  }
  if ($null -ne $sentinelIdentity -and (Test-McbotProcessIdentity -Identity $sentinelIdentity)) {
    [void](Stop-McbotProcessIdentityTree -Identity $sentinelIdentity)
    if ($null -ne $sentinelProcess) { [void]$sentinelProcess.WaitForExit(2000) }
  }
  $result.sentinelCleaned = $null -eq $sentinelIdentity -or -not (Test-McbotProcessIdentity -Identity $sentinelIdentity)
  if ($null -ne $currentPolicy) { Restore-McbotLowImpactProcessPolicy -Policy $currentPolicy }
  Remove-Item -LiteralPath $GatePath,$ReceiptPath,$PolicyReceiptPath -Force -ErrorAction SilentlyContinue
}
$overall.Stop()
$result.overallMilliseconds = [int64]$overall.ElapsedMilliseconds
[Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 4))
`;

test('production Node scheduling applies and reads back Idle one-core policy', {
  skip: process.platform !== 'win32',
  timeout: 15_000,
}, () => {
  const receipt = applyLowImpactNodeScheduling();
  assert.equal(receipt.schedulingPriority, 'Idle');
  assert.match(receipt.processorAffinity, /^0x[0-9a-f]+$/);
  const affinity = BigInt(receipt.processorAffinity);
  assert.ok(affinity > 0n);
  assert.equal(affinity & (affinity - 1n), 0n);
  assert.match(receipt.processStartIdentity, /^windows-start-ticks:\d+$/);
  assert.ok(Number.isInteger(receipt.verifierPid) && receipt.verifierPid > 0);
});

test('production PowerShell lock helpers terminate only exact test-owned identities and drain their Job', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-resource-ps-runtime-'));
  const repository = path.join(temp, 'repository');
  const driverPath = path.join(temp, 'runtime-driver.ps1');
  const descendantPath = path.join(temp, 'spawn-descendant.ps1');
  const daemonPath = path.join(temp, 'daemon-surrogate.ps1');
  const gatePath = path.join(temp, 'descendant.ready');
  const receiptPath = path.join(temp, 'descendant.json');
  const policyReceiptPath = path.join(temp, 'daemon-policy.json');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  fs.writeFileSync(driverPath, RUNTIME_DRIVER, 'utf8');
  fs.writeFileSync(descendantPath, DESCENDANT_HELPER, 'utf8');
  fs.writeFileSync(daemonPath, DAEMON_SURROGATE, 'utf8');
  const location = resolveResourceLockLocation(repository);
  const env = { ...process.env, MCBOT_NODE_EXECUTABLE: process.execPath };
  delete env.MCBOT_RESOURCE_LOCK_ROOT;
  for (const name of Object.values(RESOURCE_LOCK_ENV)) delete env[name];

  try {
    const execution = spawnSync('pwsh', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', driverPath,
      '-RepositoryRoot', repository,
      '-ResourceLockScript', path.join(ROOT, 'scripts', 'resource-lock.ps1'),
      '-DescendantScript', descendantPath,
      '-DaemonScript', daemonPath,
      '-GatePath', gatePath,
      '-ReceiptPath', receiptPath,
      '-PolicyReceiptPath', policyReceiptPath,
    ], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 25_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(execution.error, undefined, execution.error?.message);
    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    const result = JSON.parse(execution.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.driverIdle, true);
    assert.equal(result.driverOneCore, true);
    assert.equal(result.sentinelIdle, true);
    assert.equal(result.sentinelOneCore, true);
    assert.equal(result.sentinelOutsideJob, true);
    assert.equal(result.targetRegisteredInJob, true);
    assert.equal(result.targetIdleOneCore, true);
    assert.equal(result.wrapperMismatchRefused, true);
    assert.equal(result.targetSurvivedMismatch, true);
    assert.equal(result.nativeMismatchRefused, true);
    assert.equal(result.nativeMismatchError, 1168);
    assert.equal(result.sentinelSurvivedNativeMismatch, true);
    assert.equal(result.equalTickDescendantRefused, true);
    assert.equal(result.sentinelSurvivedEqualTickRefusal, true);
    assert.equal(result.exactIdentityStopped, true);
    assert.equal(result.exactTargetGone, true);
    assert.equal(result.sentinelSurvivedExactStop, true);
    assert.equal(result.descendantRegisteredInJob, true);
    assert.equal(result.descendantWaitObserved, true);
    assert.equal(result.descendantIdleOneCore, true);
    assert.equal(result.descendantPolicyReadBack, true);
    assert.equal(result.daemonSurrogateOverrideDenied, true);
    assert.equal(result.descendantGone, true);
    assert.equal(result.sentinelSurvivedJobDrain, true);
    assert.equal(result.childReceiptsRemoved, true);
    assert.equal(result.jobChildrenAfterDrain, 0);
    assert.equal(result.lockReleased, true);
    assert.equal(result.sentinelSurvivedRelease, true);
    assert.equal(result.sentinelCleaned, true);
    assert.ok(result.drainMilliseconds < 5_000, `drain took ${result.drainMilliseconds}ms`);
    assert.ok(result.releaseMilliseconds < 5_000, `release took ${result.releaseMilliseconds}ms`);
    assert.ok(result.overallMilliseconds < 15_000, `runtime probe took ${result.overallMilliseconds}ms`);
  } finally {
    fs.rmSync(location.lockPath, { recursive: true, force: true });
    fs.rmSync(location.eventsPath, { force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
