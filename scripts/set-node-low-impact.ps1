param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$TargetPid
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'Node one-core scheduling enforcement requires Windows.'
}

function Get-OneCoreMask {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
  $available = $Process.ProcessorAffinity.ToInt64()
  if (($available -band 2) -ne 0) { return [int64]2 }
  for ($bit = 0; $bit -lt 63; $bit++) {
    $candidate = [int64]1 -shl $bit
    if (($available -band $candidate) -ne 0) { return $candidate }
  }
  throw 'The target process has no usable processor-affinity bit.'
}

$self = [Diagnostics.Process]::GetCurrentProcess()
$selfStartTicks = [int64]$self.StartTime.ToUniversalTime().Ticks
$self.PriorityClass = [Diagnostics.ProcessPriorityClass]::Idle
$self.ProcessorAffinity = [IntPtr](Get-OneCoreMask -Process $self)
if ($self.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::Idle) {
  throw 'The scheduling verifier could not lower its own priority.'
}

$selfCim = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop
if ($null -eq $selfCim -or [int]$selfCim.ParentProcessId -ne $TargetPid) {
  throw 'The scheduling verifier may modify only its exact parent process.'
}

$target = [Diagnostics.Process]::GetProcessById($TargetPid)
$startTicks = [int64]$target.StartTime.ToUniversalTime().Ticks
$targetMustPredateVerifier = $startTicks -lt $selfStartTicks
$targetCim = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetPid" -ErrorAction Stop
if ($null -eq $targetCim `
    -or -not $targetMustPredateVerifier `
    -or [Math]::Abs([int64]$targetCim.CreationDate.ToUniversalTime().Ticks - $startTicks) -gt 10000) {
  throw 'Unable to establish the exact Node parent process identity.'
}

$mask = Get-OneCoreMask -Process $target
$target.PriorityClass = [Diagnostics.ProcessPriorityClass]::Idle
$target.ProcessorAffinity = [IntPtr]$mask
$target.Refresh()
$targetAgain = [Diagnostics.Process]::GetProcessById($TargetPid)
$observedStartTicks = [int64]$targetAgain.StartTime.ToUniversalTime().Ticks
$observedMask = [int64]$targetAgain.ProcessorAffinity.ToInt64()
if ($observedStartTicks -ne $startTicks `
    -or $targetAgain.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::Idle `
    -or $observedMask -ne $mask `
    -or $observedMask -le 0 `
    -or (($observedMask -band ($observedMask - 1)) -ne 0)) {
  throw 'Required Idle/one-core Node scheduling policy did not stick.'
}

$receipt = [ordered]@{
  protocol = 'mcbot.node-low-impact.v1'
  applied = $true
  targetPid = $TargetPid
  processStartIdentity = "windows-start-ticks:$startTicks"
  schedulingPriority = 'Idle'
  processorAffinity = ('0x{0:x}' -f $observedMask)
  verifierPid = $PID
  verifierParentPid = [int]$selfCim.ParentProcessId
}
[Console]::Out.Write(($receipt | ConvertTo-Json -Compress))
