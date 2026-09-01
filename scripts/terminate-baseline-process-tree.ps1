param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][int64]$StartTimeUtcTicks,
  [Parameter(Mandatory = $true)][int]$ParentProcessId,
  [ValidateRange(100, 30000)][int]$WaitMilliseconds = 5000
)

$ErrorActionPreference = 'Stop'

if ($ProcessId -le 0 -or $StartTimeUtcTicks -le 0 -or $ParentProcessId -le 0) {
  exit 20
}

$target = $null
try {
  $target = [Diagnostics.Process]::GetProcessById($ProcessId)
  # Force creation of the native process handle before validating identity.
  # StartTime and Kill below therefore operate on the same kernel object, not
  # on separate PID lookups that could straddle PID reuse.
  $targetHandle = $target.Handle
  $actualStartTicks = [int64]$target.StartTime.ToUniversalTime().Ticks
} catch [ArgumentException] {
  exit 10
} catch {
  exit 21
}

if ($targetHandle -eq [IntPtr]::Zero -or $actualStartTicks -ne $StartTimeUtcTicks) {
  exit 11
}

try {
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
  if ($null -eq $cim -or [int]$cim.ParentProcessId -ne $ParentProcessId) {
    exit 12
  }
  $cimTicks = [int64]$cim.CreationDate.ToUniversalTime().Ticks
  if ([Math]::Abs($cimTicks - $actualStartTicks) -gt 10000) {
    exit 11
  }
  if ($target.HasExited -or [int64]$target.StartTime.ToUniversalTime().Ticks -ne $StartTimeUtcTicks) {
    exit 10
  }
  $target.Kill($true)
  if (-not $target.WaitForExit($WaitMilliseconds)) {
    exit 22
  }
  exit 0
} catch [InvalidOperationException] {
  # The exact handle becoming exited after validation is safe; never reopen its
  # PID, since it may already identify an unrelated replacement process.
  try {
    if ($target.HasExited) { exit 10 }
  } catch { }
  exit 23
} catch {
  exit 24
} finally {
  if ($null -ne $target) { $target.Dispose() }
}
