$script:McbotResourceLockCli = Join-Path $PSScriptRoot 'resource-lock-cli.js'
$script:McbotLocalMinecraftServerPolicyCli = Join-Path $PSScriptRoot 'local-minecraft-server-policy-cli.js'
if ($null -eq (Get-Variable -Name McbotResourceLockRegistry -Scope Script -ErrorAction SilentlyContinue)) {
  $script:McbotResourceLockRegistry = @{}
}
if ($null -eq (Get-Variable -Name McbotResourceLockExitEvent -Scope Script -ErrorAction SilentlyContinue)) {
  $script:McbotResourceLockExitEvent = $null
}
if ($null -eq (Get-Variable -Name McbotKillOnCloseJobHandle -Scope Script -ErrorAction SilentlyContinue)) {
  $script:McbotKillOnCloseJobHandle = [IntPtr]::Zero
}

function Assert-McbotDedicatedPowerShellFileHost {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$EntrypointPath)
  $current = [Diagnostics.Process]::GetCurrentProcess()
  $executableName = [IO.Path]::GetFileName([string]$current.Path)
  if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7 `
      -or $executableName -notin @('pwsh', 'pwsh.exe') `
      -or $null -eq ([Diagnostics.ProcessStartInfo].GetProperty('ArgumentList'))) {
    throw 'MCBot resource-controlled PowerShell entrypoints require PowerShell 7 (pwsh).'
  }
  $commandLineArguments = @([Environment]::GetCommandLineArgs())
  $fileIndex = -1
  $hostSwitchesWithoutValues = @('-noprofile', '-nologo', '-noninteractive', '-mta', '-sta')
  $hostSwitchesWithValues = @(
    '-executionpolicy', '-inputformat', '-outputformat', '-settingsfile',
    '-workingdirectory', '-configurationname'
  )
  $executionModeSelectors = @(
    '-', '-command', '-commandwithargs', '-encodedcommand', '-encodedarguments',
    '-c', '-e', '-ec'
  )
  $index = 1
  while ($index -lt $commandLineArguments.Count) {
    $argument = [string]$commandLineArguments[$index]
    $normalizedArgument = $argument.ToLowerInvariant()
    if ($argument -imatch '^-noe(?:x(?:i(?:t)?)?)?$') {
      throw 'MCBot resource-controlled entrypoints refuse -NoExit because the host must terminate when the entrypoint completes.'
    }
    if ($argument -ieq '-File') {
      $fileIndex = $index
      break
    }
    if ($executionModeSelectors -contains $normalizedArgument) {
      throw "MCBot resource-controlled entrypoints refuse PowerShell execution mode $argument before -File."
    }
    if ($hostSwitchesWithoutValues -contains $normalizedArgument) {
      $index++
      continue
    }
    if ($hostSwitchesWithValues -contains $normalizedArgument) {
      if ($index + 1 -ge $commandLineArguments.Count) {
        throw "PowerShell host switch $argument is missing its value before -File."
      }
      $index += 2
      continue
    }
    throw "Unsupported PowerShell host argument before the required -File entrypoint: $argument"
  }
  if ($fileIndex -lt 0 -or $fileIndex + 1 -ge $commandLineArguments.Count) {
    throw 'Run this MCBot entrypoint in a dedicated process: pwsh -NoProfile -ExecutionPolicy Bypass -File <entrypoint.ps1> ...'
  }
  $entrypoint = [string]$commandLineArguments[$fileIndex + 1]
  if ([string]::IsNullOrWhiteSpace($entrypoint) -or $entrypoint -eq '-' `
      -or [IO.Path]::GetExtension($entrypoint) -ine '.ps1') {
    throw 'The dedicated MCBot PowerShell host must use -File with a .ps1 entrypoint.'
  }
  $launchedEntrypoint = [IO.Path]::GetFullPath($entrypoint)
  $expectedEntrypoint = [IO.Path]::GetFullPath($EntrypointPath)
  if (-not [string]::Equals($launchedEntrypoint, $expectedEntrypoint, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The dedicated -File entrypoint does not match this MCBot launcher ($expectedEntrypoint)."
  }
  return [pscustomobject]@{
    Applied = $true
    Executable = $executableName
    LaunchMode = 'dedicated-pwsh-file'
    Entrypoint = $expectedEntrypoint
  }
}

function Enable-McbotKillOnCloseProcessTree {
  [CmdletBinding()]
  param([string]$Role = 'mcbot-wrapper')
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'The required MCBot kill-on-close process-tree policy is only available on Windows.'
  }
  $current = [Diagnostics.Process]::GetCurrentProcess()
  $currentAffinity = [int64]$current.ProcessorAffinity.ToInt64()
  if ($current.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::Idle `
      -or $currentAffinity -le 0 `
      -or ($currentAffinity -band ($currentAffinity - 1)) -ne 0) {
    throw "The $Role wrapper must be verified Idle/one-core before Job containment is enabled."
  }
  if ($script:McbotKillOnCloseJobHandle -ne [IntPtr]::Zero) {
    return [pscustomobject]@{
      Applied = $true
      Role = $Role
      Limit = 'KILL_ON_JOB_CLOSE|PRIORITY_CLASS|AFFINITY'
      PriorityClass = 'Idle'
      ProcessorAffinity = ('0x{0:x}' -f $currentAffinity)
    }
  }
  if ($null -eq ('Mcbot.ResourceControl.NativeJob' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Mcbot.ResourceControl {
  [StructLayout(LayoutKind.Sequential)] public struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] public struct BasicLimitInformation {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct ExtendedLimitInformation {
    public BasicLimitInformation BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] public struct NativeFileTime {
    public uint LowDateTime;
    public uint HighDateTime;
    public long Value { get { return ((long)HighDateTime << 32) | LowDateTime; } }
  }
  public static class NativeJob {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);
  }
  public static class NativeProcess {
    const uint PROCESS_TERMINATE = 0x0001;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint SYNCHRONIZE = 0x00100000;
    const uint WAIT_OBJECT_0 = 0x00000000;
    const uint WAIT_TIMEOUT = 0x00000102;
    const uint WAIT_FAILED = 0xffffffff;
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out NativeFileTime creation, out NativeFileTime exit, out NativeFileTime kernel, out NativeFileTime user);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    public static bool TerminateExact(int processId, long expectedStartTimeUtcTicks, out int error) {
      return TerminateExactWithWait(processId, expectedStartTimeUtcTicks, 2000, out error);
    }

    public static bool TerminateExactWithWait(int processId, long expectedStartTimeUtcTicks, uint waitMilliseconds, out int error) {
      error = 0;
      IntPtr process = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, processId);
      if (process == IntPtr.Zero) {
        error = Marshal.GetLastWin32Error();
        return false;
      }
      try {
        NativeFileTime creation, exit, kernel, user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
          error = Marshal.GetLastWin32Error();
          return false;
        }
        long actualStartTimeUtcTicks;
        try { actualStartTimeUtcTicks = DateTime.FromFileTimeUtc(creation.Value).Ticks; }
        catch { error = 13; return false; }
        if (actualStartTimeUtcTicks != expectedStartTimeUtcTicks) {
          error = 1168;
          return false;
        }
        if (!TerminateProcess(process, 1)) {
          error = Marshal.GetLastWin32Error();
          return false;
        }
        uint wait = WaitForSingleObject(process, waitMilliseconds);
        if (wait == WAIT_OBJECT_0) return true;
        if (wait == WAIT_TIMEOUT) { error = 1460; return false; }
        error = wait == WAIT_FAILED ? Marshal.GetLastWin32Error() : 31;
        return false;
      } finally {
        CloseHandle(process);
      }
    }
  }
}
'@
  }
  $job = [Mcbot.ResourceControl.NativeJob]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) {
    throw "Unable to create the required kill-on-close job for $Role (Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
  }
  $buffer = [IntPtr]::Zero
  try {
    $basic = [Mcbot.ResourceControl.BasicLimitInformation]::new()
    # Enforce, rather than merely inherit, Idle priority and the wrapper's
    # verified one-core affinity for every present and future Job descendant.
    # This prevents Gradle or a JVM launcher from widening either policy.
    $basic.LimitFlags = [uint32]0x00002030
    $basic.Affinity = [UIntPtr]$currentAffinity
    $basic.PriorityClass = [uint32]0x00000040
    $limits = [Mcbot.ResourceControl.ExtendedLimitInformation]::new()
    $limits.BasicLimitInformation = $basic
    $size = [Runtime.InteropServices.Marshal]::SizeOf([type][Mcbot.ResourceControl.ExtendedLimitInformation])
    $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
    [Runtime.InteropServices.Marshal]::StructureToPtr($limits, $buffer, $false)
    if (-not [Mcbot.ResourceControl.NativeJob]::SetInformationJobObject($job, 9, $buffer, [uint32]$size)) {
      throw "Unable to configure the required kill-on-close job for $Role (Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
    }
    $returned = [uint32]0
    if (-not [Mcbot.ResourceControl.NativeJob]::QueryInformationJobObject(
        $job,
        9,
        $buffer,
        [uint32]$size,
        [ref]$returned
      ) -or $returned -lt $size) {
      throw "Unable to read back the required Job limits for $Role (Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
    }
    $observedLimits = [Runtime.InteropServices.Marshal]::PtrToStructure(
      $buffer,
      [type][Mcbot.ResourceControl.ExtendedLimitInformation]
    )
    $observedBasic = $observedLimits.BasicLimitInformation
    if (([uint32]$observedBasic.LimitFlags -band [uint32]0x00002030) -ne [uint32]0x00002030 `
        -or [uint32]$observedBasic.PriorityClass -ne [uint32]0x00000040 `
        -or [uint64]$observedBasic.Affinity.ToUInt64() -ne [uint64]$currentAffinity) {
      throw "Required kill-on-close/Idle/one-core Job limits did not stick for $Role."
    }
    if (-not [Mcbot.ResourceControl.NativeJob]::AssignProcessToJobObject($job, $current.Handle)) {
      throw "Unable to assign $Role to the required kill-on-close job (Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
    }
    # Once this process is a member, retain the only job handle even if the
    # subsequent verification fails; closing it here would terminate the caller.
    $script:McbotKillOnCloseJobHandle = $job
    $job = [IntPtr]::Zero
    $inJob = $false
    if (-not [Mcbot.ResourceControl.NativeJob]::IsProcessInJob(
        $current.Handle,
        $script:McbotKillOnCloseJobHandle,
        [ref]$inJob
      ) -or -not $inJob) {
      throw "The required kill-on-close job did not stick for $Role."
    }
    return [pscustomobject]@{
      Applied = $true
      Role = $Role
      Limit = 'KILL_ON_JOB_CLOSE|PRIORITY_CLASS|AFFINITY'
      PriorityClass = 'Idle'
      ProcessorAffinity = ('0x{0:x}' -f $currentAffinity)
    }
  } finally {
    if ($buffer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
    if ($job -ne [IntPtr]::Zero) { [void][Mcbot.ResourceControl.NativeJob]::CloseHandle($job) }
  }
}

function Get-McbotKillOnCloseJobProcessIds {
  [CmdletBinding()]
  param()
  if ($script:McbotKillOnCloseJobHandle -eq [IntPtr]::Zero) {
    throw 'The required MCBot kill-on-close job is not active.'
  }
  $capacity = 65536
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($capacity)
  try {
    $returned = [uint32]0
    if (-not [Mcbot.ResourceControl.NativeJob]::QueryInformationJobObject(
        $script:McbotKillOnCloseJobHandle,
        3,
        $buffer,
        [uint32]$capacity,
        [ref]$returned
      )) {
      throw "Unable to enumerate the MCBot kill-on-close job (Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
    }
    $assigned = [Runtime.InteropServices.Marshal]::ReadInt32($buffer, 0)
    $listed = [Runtime.InteropServices.Marshal]::ReadInt32($buffer, 4)
    if ($assigned -lt 0 -or $listed -lt 0 -or $assigned -ne $listed `
        -or (8 + ($listed * [IntPtr]::Size)) -gt $capacity) {
      throw 'The MCBot kill-on-close job process list was incomplete.'
    }
    $result = @()
    for ($index = 0; $index -lt $listed; $index++) {
      $raw = [Runtime.InteropServices.Marshal]::ReadIntPtr($buffer, 8 + ($index * [IntPtr]::Size)).ToInt64()
      if ($raw -le 0 -or $raw -gt [int]::MaxValue) {
        throw 'The MCBot kill-on-close job returned an invalid process ID.'
      }
      $result += [int]$raw
    }
    return @($result | Select-Object -Unique)
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  }
}

function Stop-McbotKillOnCloseJobChildren {
  [CmdletBinding()]
  param([string]$Reason = 'resource-lock cleanup')
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $lastDiagnostics = @{}
  $terminationSignaled = @{}
  do {
    $childPids = @(Get-McbotKillOnCloseJobProcessIds | Where-Object { [int]$_ -ne $PID })
    if ($childPids.Count -eq 0) { return }
    $identities = @()
    foreach ($childPid in $childPids) {
      $process = Get-Process -Id $childPid -ErrorAction SilentlyContinue
      if ($null -eq $process) {
        if (-not $lastDiagnostics.ContainsKey([string]$childPid)) {
          $lastDiagnostics[[string]$childPid] = [pscustomobject]@{
            Pid = [int]$childPid
            StartTimeUtcTicks = $null
            ProcessName = 'unavailable'
            Role = "job-child:$Reason"
            JobMember = $null
            Outcome = 'job_pid_not_openable'
            NativeError = $null
          }
        }
        continue
      }
      try {
        # The job query returns bare PIDs. Re-open that exact process and prove
        # its handle is still in our job before retaining an identity that may
        # later be used to stop it; this closes the PID-reuse window without
        # ever targeting an unrelated process.
        $inJob = $false
        if (-not [Mcbot.ResourceControl.NativeJob]::IsProcessInJob(
            $process.Handle,
            $script:McbotKillOnCloseJobHandle,
            [ref]$inJob
          )) {
          throw "Unable to revalidate kill-on-close job child pid $childPid (Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
        }
        if (-not $inJob) {
          if (-not $lastDiagnostics.ContainsKey([string]$childPid)) {
            $lastDiagnostics[[string]$childPid] = [pscustomobject]@{
              Pid = [int]$childPid
              StartTimeUtcTicks = $null
              ProcessName = 'unavailable'
              Role = "job-child:$Reason"
              JobMember = $false
              Outcome = 'job_membership_changed'
              NativeError = $null
            }
          }
          continue
        }
        $identity = New-McbotProcessIdentity -Process $process -Role "job-child:$Reason"
        if ($null -eq $identity) {
          if (-not $lastDiagnostics.ContainsKey([string]$childPid)) {
            $lastDiagnostics[[string]$childPid] = [pscustomobject]@{
              Pid = [int]$childPid
              StartTimeUtcTicks = $null
              ProcessName = 'unavailable'
              Role = "job-child:$Reason"
              JobMember = $true
              Outcome = 'identity_unverifiable'
              NativeError = $null
            }
          }
          continue
        }
        $identities += $identity
      } finally {
        $process.Dispose()
      }
    }
    [array]::Reverse($identities)
    $remainingBudget = [Math]::Max(0, 5000 - [int]$timer.ElapsedMilliseconds)
    $perIdentityWait = [Math]::Min(250, [Math]::Max(0, [int][Math]::Floor($remainingBudget / [Math]::Max(1, $identities.Count))))
    foreach ($identity in $identities) {
      $stopDiagnostic = $null
      [void](Stop-McbotProcessIdentityTree -Identity $identity -WaitMilliseconds $perIdentityWait -Diagnostic ([ref]$stopDiagnostic))
      $stopDiagnostic | Add-Member -NotePropertyName JobMember -NotePropertyValue $true
      if ($stopDiagnostic.Outcome -eq 'terminated_and_signaled') {
        $terminationSignaled[[string]$identity.Pid] = $true
      }
      $lastDiagnostics[[string]$identity.Pid] = $stopDiagnostic
    }
    $remainingAfterStop = @(Get-McbotKillOnCloseJobProcessIds | Where-Object { [int]$_ -ne $PID })
    if ($remainingAfterStop.Count -eq 0) { return }
    if ($timer.ElapsedMilliseconds -ge 5000) { break }
    Start-Sleep -Milliseconds ([Math]::Min(50, [Math]::Max(1, 5000 - [int]$timer.ElapsedMilliseconds)))
  } while ($true)
  $remaining = @(Get-McbotKillOnCloseJobProcessIds | Where-Object { [int]$_ -ne $PID })
  if ($remaining.Count -ne 0) {
    $details = @($remaining | ForEach-Object {
      $diagnostic = $lastDiagnostics[[string]$_]
      if ($null -eq $diagnostic) { return "pid=$_,outcome=not_observed" }
      $safeName = ([string]$diagnostic.ProcessName -replace '[^A-Za-z0-9._-]', '?')
      $safeRole = ([string]$diagnostic.Role -replace '[^A-Za-z0-9:._-]', '?')
      $start = if ($null -eq $diagnostic.StartTimeUtcTicks) { 'unknown' } else { [string]$diagnostic.StartTimeUtcTicks }
      $native = if ($null -eq $diagnostic.NativeError) { 'none' } else { [string]$diagnostic.NativeError }
      $membership = if ($null -eq $diagnostic.JobMember) { 'unknown' } else { [string][bool]$diagnostic.JobMember }
      $everSignaled = [bool]$terminationSignaled.ContainsKey([string]$_)
      return "pid=$($diagnostic.Pid),startTicks=$start,name=$safeName,role=$safeRole,jobMember=$membership,terminationSignaled=$everSignaled,outcome=$($diagnostic.Outcome),nativeError=$native"
    })
    throw "Unable to stop every MCBot job child before release ($($details -join '; '))."
  }
}

function Assert-McbotKillOnCloseJobHasNoChildren {
  [CmdletBinding()]
  param()
  $remaining = @(Get-McbotKillOnCloseJobProcessIds | Where-Object { [int]$_ -ne $PID })
  if ($remaining.Count -ne 0) {
    throw "Refusing resource-lock release while kill-on-close job children remain ($($remaining -join ','))."
  }
}

function Wait-McbotKillOnCloseJobHasNoChildren {
  [CmdletBinding()]
  param([ValidateRange(0, 30000)][int]$TimeoutMilliseconds = 5000)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    $remaining = @(Get-McbotKillOnCloseJobProcessIds | Where-Object { [int]$_ -ne $PID })
    if ($remaining.Count -eq 0) { return $true }
    if ([DateTime]::UtcNow -ge $deadline) { return $false }
    Start-Sleep -Milliseconds 100
  } while ($true)
}

function Resolve-McbotNodeExecutable {
  if (-not [string]::IsNullOrWhiteSpace([string]$env:MCBOT_NODE_EXECUTABLE)) {
    $candidate = [System.IO.Path]::GetFullPath([string]$env:MCBOT_NODE_EXECUTABLE)
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      throw 'MCBOT_NODE_EXECUTABLE does not identify a Node executable.'
    }
    return $candidate
  }
  $command = Get-Command node.exe,node -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $command) {
    throw 'The MCBot resource lock requires Node.js 22 or newer on PATH (or MCBOT_NODE_EXECUTABLE).'
  }
  return $command.Source
}

function Invoke-McbotTrustedNodeScript {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$NodeExecutable,
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [string[]]$Arguments = @()
  )
  # Baseline child processes intentionally receive a bootstrap through
  # NODE_OPTIONS. These tiny trusted coordination CLIs must not bootstrap
  # themselves before they can register their calling PowerShell wrapper.
  $priorNodeOptions = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process')
  try {
    [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $null, 'Process')
    $output = @(& $NodeExecutable $ScriptPath @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    return [pscustomobject]@{ Output = $output; ExitCode = $exitCode }
  } finally {
    [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $priorNodeOptions, 'Process')
  }
}

function Assert-McbotNoUncontrolledLocalMinecraftServer {
  [CmdletBinding()]
  param()
  $node = Resolve-McbotNodeExecutable
  $execution = Invoke-McbotTrustedNodeScript `
    -NodeExecutable $node `
    -ScriptPath $script:McbotLocalMinecraftServerPolicyCli
  $output = @($execution.Output)
  $exitCode = [int]$execution.ExitCode
  $text = ($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
  if ($exitCode -ne 0) {
    throw "MCBot local-server admission failed: $text"
  }
  try {
    $record = $text | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw 'MCBot local-server admission returned malformed JSON.'
  }
  if (-not [bool]$record.applied -or [string]$record.policy -ne 'phase1_no_local_server') {
    throw 'MCBot local-server admission did not apply the required Phase-1 policy.'
  }
  return $record
}

function Invoke-McbotResourceLockCli {
  param(
    [Parameter(Mandatory = $true)][string]$NodeExecutable,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  $execution = Invoke-McbotTrustedNodeScript `
    -NodeExecutable $NodeExecutable `
    -ScriptPath $script:McbotResourceLockCli `
    -Arguments $Arguments
  $output = @($execution.Output)
  $exitCode = [int]$execution.ExitCode
  $text = ($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
  if ($exitCode -ne 0) {
    $message = $text
    try {
      $record = $text | ConvertFrom-Json -ErrorAction Stop
      if (-not [string]::IsNullOrWhiteSpace([string]$record.message)) { $message = [string]$record.message }
    } catch { }
    throw "MCBot resource lock failed (exit $exitCode): $message"
  }
  try {
    return $text | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw 'MCBot resource lock returned malformed JSON.'
  }
}

function Register-McbotResourceLockExitCleanup {
  if ($null -ne $script:McbotResourceLockExitEvent) { return }
  $messageData = [pscustomobject]@{
    Registry = $script:McbotResourceLockRegistry
    CliPath = $script:McbotResourceLockCli
  }
  $script:McbotResourceLockExitEvent = Register-EngineEvent `
    -SourceIdentifier PowerShell.Exiting `
    -SupportEvent `
    -MessageData $messageData `
    -Action {
      # Do not release from PowerShell.Exiting: the kill-on-close job handle is
      # closed only after this event, and its children must remain represented by
      # the owner/child records until the OS has completed process teardown.
      # Normal try/finally paths call Exit-McbotResourceLock explicitly; abnormal
      # exits are reclaimed through the finite PID+start stale-owner protocol.
    }
}

function Enter-McbotResourceLock {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$Purpose,
    [Parameter(Mandatory = $true)][string]$EntrypointPath,
    [hashtable]$Controls = @{},
    [ValidateRange(0, 86400000)][int]$WaitMilliseconds = 0
  )
  $resolvedRoot = [System.IO.Path]::GetFullPath($RepositoryRoot)
  $hostPolicy = Assert-McbotDedicatedPowerShellFileHost -EntrypointPath $EntrypointPath
  $localServerPolicy = Assert-McbotNoUncontrolledLocalMinecraftServer
  $jobPolicy = Enable-McbotKillOnCloseProcessTree -Role $Purpose
  $effectiveControls = @{}
  foreach ($key in $Controls.Keys) { $effectiveControls[$key] = $Controls[$key] }
  $effectiveControls.killOnCloseJob = [bool]$jobPolicy.Applied
  $effectiveControls.powerShellHost = [string]$hostPolicy.LaunchMode
  $effectiveControls.localMinecraftServerPolicy = [string]$localServerPolicy.policy
  $node = Resolve-McbotNodeExecutable
  $detailsJson = $effectiveControls | ConvertTo-Json -Compress -Depth 4
  $detailsBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($detailsJson))
  $arguments = @(
    'acquire', '--repo-root', $resolvedRoot,
    '--owner-pid', [string]$PID,
    '--owner-executable', [System.IO.Path]::GetFileName((Get-Process -Id $PID).Path),
    '--purpose', $Purpose,
    '--wait-ms', [string]$WaitMilliseconds,
    '--details', $detailsBase64
  )
  $record = Invoke-McbotResourceLockCli -NodeExecutable $node -Arguments $arguments
  $priorEnvironment = @{}
  $appliedEnvironmentNames = @()
  $lease = $null
  try {
    foreach ($property in $record.environment.PSObject.Properties) {
      $priorEnvironment[$property.Name] = [Environment]::GetEnvironmentVariable($property.Name, 'Process')
      $appliedEnvironmentNames += [string]$property.Name
      [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
    }
    $lease = [pscustomobject]@{
      LeaseId = [guid]::NewGuid().ToString('n')
      RepositoryRoot = $resolvedRoot
      NodeExecutable = $node
      LockPath = [string]$record.lockPath
      EventsPath = [string]$record.eventsPath
      RepositoryId = [string]$record.repositoryId
      OwnerId = [string]$record.metadata.owner.id
      OwnerPid = [int]$record.metadata.owner.pid
      OwnerStartIdentity = [string]$record.metadata.owner.processStartIdentity
      Purpose = [string]$record.metadata.owner.purpose
      Controls = $record.metadata.controls
      KillOnCloseJob = $jobPolicy
      Inherited = [bool]$record.inherited
      ChildPid = if ($null -ne $record.childRegistration) { [int]$record.childRegistration.pid } else { 0 }
      ChildStartIdentity = if ($null -ne $record.childRegistration) { [string]$record.childRegistration.processStartIdentity } else { $null }
      Released = $false
      PriorEnvironment = $priorEnvironment
      AppliedEnvironment = $record.environment
    }
    $script:McbotResourceLockRegistry[$lease.LeaseId] = $lease
    Register-McbotResourceLockExitCleanup
    return $lease
  } catch {
    $setupError = $_
    if ($null -ne $lease) {
      [void]$script:McbotResourceLockRegistry.Remove($lease.LeaseId)
    }
    foreach ($name in $appliedEnvironmentNames) {
      $expected = [string]$record.environment.PSObject.Properties[$name].Value
      $current = [Environment]::GetEnvironmentVariable($name, 'Process')
      if ($current -ne $expected) { continue }
      [Environment]::SetEnvironmentVariable($name, $priorEnvironment[$name], 'Process')
    }
    $releaseError = $null
    if ([bool]$record.inherited -and $null -ne $record.childRegistration) {
      try {
        [void](Invoke-McbotResourceLockCli -NodeExecutable $node -Arguments @(
          'deregister-child', '--repo-root', $resolvedRoot,
          '--owner-id', [string]$record.metadata.owner.id,
          '--owner-pid', [string]$record.metadata.owner.pid,
          '--owner-start-identity', [string]$record.metadata.owner.processStartIdentity,
          '--child-pid', [string]$record.childRegistration.pid,
          '--child-start-identity', [string]$record.childRegistration.processStartIdentity
        ))
      } catch {
        $releaseError = $_
      }
    } elseif (-not [bool]$record.inherited) {
      try {
        [void](Invoke-McbotResourceLockCli -NodeExecutable $node -Arguments @(
          'release', '--repo-root', $resolvedRoot,
          '--owner-id', [string]$record.metadata.owner.id,
          '--owner-pid', [string]$record.metadata.owner.pid,
          '--owner-start-identity', [string]$record.metadata.owner.processStartIdentity
        ))
      } catch {
        $releaseError = $_
      }
    }
    if ($null -ne $releaseError) {
      throw "MCBot resource lock setup failed ($($setupError.Exception.Message)); rollback also failed ($($releaseError.Exception.Message))."
    }
    throw $setupError
  }
}

function Exit-McbotResourceLock {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Lease)
  if ($null -eq $Lease -or $Lease.Released) { return }
  # Gradle's single-use daemon can outlive its client briefly even with
  # --no-daemon. Give owned Job members a short grace period, then terminate
  # only identities revalidated as members of this wrapper's kill-on-close
  # Job. Registered direct workloads still retain their lock records and make
  # the subsequent owner release fail closed if a caller skipped deregistration.
  if (-not (Wait-McbotKillOnCloseJobHasNoChildren -TimeoutMilliseconds 5000)) {
    Stop-McbotKillOnCloseJobChildren -Reason 'resource-lock finalization'
  }
  Assert-McbotKillOnCloseJobHasNoChildren
  if ($Lease.Inherited) {
    [void](Invoke-McbotResourceLockCli -NodeExecutable $Lease.NodeExecutable -Arguments @(
      'deregister-child', '--repo-root', $Lease.RepositoryRoot,
      '--owner-id', $Lease.OwnerId,
      '--owner-pid', [string]$Lease.OwnerPid,
      '--owner-start-identity', $Lease.OwnerStartIdentity,
      '--child-pid', [string]$Lease.ChildPid,
      '--child-start-identity', $Lease.ChildStartIdentity
    ))
  } else {
    [void](Invoke-McbotResourceLockCli -NodeExecutable $Lease.NodeExecutable -Arguments @(
      'release', '--repo-root', $Lease.RepositoryRoot,
      '--owner-id', $Lease.OwnerId,
      '--owner-pid', [string]$Lease.OwnerPid,
      '--owner-start-identity', $Lease.OwnerStartIdentity
    ))
  }
  foreach ($property in $Lease.AppliedEnvironment.PSObject.Properties) {
    $current = [Environment]::GetEnvironmentVariable($property.Name, 'Process')
    if ($current -ne [string]$property.Value) { continue }
    [Environment]::SetEnvironmentVariable($property.Name, $Lease.PriorEnvironment[$property.Name], 'Process')
  }
  $Lease.Released = $true
  [void]$script:McbotResourceLockRegistry.Remove($Lease.LeaseId)
}

function Register-McbotResourceLockWorkloadProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Lease,
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$Role
  )
  $identity = New-McbotProcessIdentity -Process $Process -Role $Role
  if ($null -eq $identity) {
    throw "Unable to establish a stable PID/start identity for $Role."
  }
  try {
    $record = Invoke-McbotResourceLockCli -NodeExecutable $Lease.NodeExecutable -Arguments @(
      'register-child', '--repo-root', $Lease.RepositoryRoot,
      '--owner-id', $Lease.OwnerId,
      '--owner-pid', [string]$Lease.OwnerPid,
      '--owner-start-identity', $Lease.OwnerStartIdentity,
      '--child-pid', [string]$identity.Pid,
      '--role', $Role
    )
  } catch {
    try { Stop-McbotKillOnCloseJobChildren -Reason "$Role registration failure" } catch { }
    throw
  }
  if ([int]$record.child.pid -ne [int]$identity.Pid `
      -or [string]$record.child.processStartIdentity -ne "windows-start-ticks:$($identity.StartTimeUtcTicks)") {
    try { Stop-McbotKillOnCloseJobChildren -Reason "$Role receipt mismatch" } catch { }
    throw "The resource-lock child identity receipt did not match $Role."
  }
  return [pscustomobject]@{
    Lease = $Lease
    Process = $Process
    Identity = $identity
    ChildStartIdentity = [string]$record.child.processStartIdentity
    Role = $Role
    Released = $false
  }
}

function Start-McbotRegisteredWorkloadProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Lease,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$Role,
    [switch]$CaptureOutput
  )
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.UseShellExecute = $false
  $startInfo.WorkingDirectory = [IO.Path]::GetFullPath($WorkingDirectory)
  $extension = [IO.Path]::GetExtension($FilePath)
  if ($extension -in @('.bat', '.cmd')) {
    $commandProcessor = if ([string]::IsNullOrWhiteSpace($env:ComSpec)) {
      Join-Path $env:SystemRoot 'System32\cmd.exe'
    } else { [IO.Path]::GetFullPath($env:ComSpec) }
    $resolvedBatch = [IO.Path]::GetFullPath($FilePath)
    if ($resolvedBatch -match '[%\r\n"&|<>^!()]') {
      throw 'The Gradle wrapper path contains characters that cannot be forwarded safely through cmd.exe.'
    }
    foreach ($argument in $ArgumentList) {
      $text = [string]$argument
      if ($text -match '[\x00-\x1f"%&|<>^!()]') {
        throw "A batch workload argument contains an unsupported cmd.exe metacharacter."
      }
    }
    $startInfo.FileName = $commandProcessor
    [void]$startInfo.ArgumentList.Add('/d')
    [void]$startInfo.ArgumentList.Add('/s')
    [void]$startInfo.ArgumentList.Add('/c')
    [void]$startInfo.ArgumentList.Add('call')
    [void]$startInfo.ArgumentList.Add($resolvedBatch)
    foreach ($argument in $ArgumentList) { [void]$startInfo.ArgumentList.Add([string]$argument) }
  } else {
    $startInfo.FileName = [IO.Path]::GetFullPath($FilePath)
    foreach ($argument in $ArgumentList) { [void]$startInfo.ArgumentList.Add([string]$argument) }
  }
  $stdoutTask = $null
  $stderrTask = $null
  if ($CaptureOutput) {
    $startInfo.RedirectStandardOutput = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw "Unable to start registered workload $Role." }
  if ($CaptureOutput) {
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
  }
  $registration = $null
  try {
    $registration = Register-McbotResourceLockWorkloadProcess `
      -Lease $Lease `
      -Process $process `
      -Role $Role
    $registration | Add-Member `
      -NotePropertyName ProcessPolicy `
      -NotePropertyValue (Set-McbotLowImpactChildProcessPolicy -Process $process -Role $Role)
    $registration | Add-Member -NotePropertyName StandardOutputTask -NotePropertyValue $stdoutTask
    $registration | Add-Member -NotePropertyName StandardErrorTask -NotePropertyValue $stderrTask
    return $registration
  } catch {
    if ($null -ne $registration) {
      try { Stop-McbotRegisteredWorkloadProcess -Registration $registration } catch { }
    } else {
      try { Stop-McbotKillOnCloseJobChildren -Reason "$Role launch failure" } catch { }
    }
    throw
  }
}

function Complete-McbotResourceLockWorkloadProcess {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Registration)
  if ($Registration.Released) { return }
  if (Test-McbotProcessIdentity -Identity $Registration.Identity) {
    throw "Refusing to deregister active $($Registration.Role) pid $($Registration.Identity.Pid)."
  }
  if (-not (Wait-McbotKillOnCloseJobHasNoChildren -TimeoutMilliseconds 5000)) {
    Stop-McbotKillOnCloseJobChildren -Reason "$($Registration.Role) completion"
  }
  Assert-McbotKillOnCloseJobHasNoChildren
  [void](Invoke-McbotResourceLockCli -NodeExecutable $Registration.Lease.NodeExecutable -Arguments @(
    'deregister-child', '--repo-root', $Registration.Lease.RepositoryRoot,
    '--owner-id', $Registration.Lease.OwnerId,
    '--owner-pid', [string]$Registration.Lease.OwnerPid,
    '--owner-start-identity', $Registration.Lease.OwnerStartIdentity,
    '--child-pid', [string]$Registration.Identity.Pid,
    '--child-start-identity', $Registration.ChildStartIdentity
  ))
  $Registration.Released = $true
}

function Stop-McbotRegisteredWorkloadProcess {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Registration)
  Stop-McbotKillOnCloseJobChildren -Reason $Registration.Role
  if (-not (Test-McbotProcessIdentity -Identity $Registration.Identity)) {
    Complete-McbotResourceLockWorkloadProcess -Registration $Registration
  }
}

function Get-McbotOneCoreAffinityMask {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
  $availableMask = $Process.ProcessorAffinity.ToInt64()
  if (($availableMask -band 2) -ne 0) {
    # Keep CPU 0 available for foreground/UI work whenever CPU 1 is available.
    return [IntPtr]2
  }
  for ($bit = 0; $bit -lt 63; $bit++) {
    $candidate = [int64]1 -shl $bit
    if (($availableMask -band $candidate) -ne 0) { return [IntPtr]$candidate }
  }
  throw "Process $($Process.Id) has no usable processor-affinity bit."
}

function Set-McbotLowImpactProcessPolicy {
  [CmdletBinding()]
  param(
    [System.Diagnostics.Process]$Process = (Get-Process -Id $PID),
    [string]$Role = 'mcbot-heavy-workload'
  )
  if ($null -eq $Process -or $Process.HasExited) {
    throw "Cannot apply the low-impact policy to exited $Role process."
  }
  $originalPriority = $Process.PriorityClass
  $originalAffinity = $Process.ProcessorAffinity
  $targetAffinity = Get-McbotOneCoreAffinityMask -Process $Process
  try {
    $Process.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::Idle
    $Process.ProcessorAffinity = $targetAffinity
    $Process.Refresh()
  } catch {
    $failureMessage = [string]$_.Exception.Message
    try {
      $Process.ProcessorAffinity = $originalAffinity
      $Process.PriorityClass = $originalPriority
    } catch { }
    throw "Failed to apply required Idle/one-core policy to $Role process $($Process.Id): $failureMessage"
  }
  if ($Process.PriorityClass -ne [System.Diagnostics.ProcessPriorityClass]::Idle `
      -or $Process.ProcessorAffinity -ne $targetAffinity) {
    try {
      $Process.ProcessorAffinity = $originalAffinity
      $Process.PriorityClass = $originalPriority
    } catch { }
    throw "Required Idle/one-core policy did not stick for $Role process $($Process.Id)."
  }
  return [pscustomobject]@{
    Role = $Role
    Pid = [int]$Process.Id
    PriorityClass = [string]$Process.PriorityClass
    ProcessorAffinity = ('0x{0:x}' -f $Process.ProcessorAffinity.ToInt64())
    OriginalPriorityClass = [string]$originalPriority
    OriginalProcessorAffinity = $originalAffinity
    AppliedAt = Get-Date -Format o
  }
}

function Restore-McbotLowImpactProcessPolicy {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Policy,
    [System.Diagnostics.Process]$Process = (Get-Process -Id $PID)
  )
  if ($null -eq $Process -or $Process.HasExited -or [int]$Process.Id -ne [int]$Policy.Pid) { return }
  try {
    $Process.ProcessorAffinity = $Policy.OriginalProcessorAffinity
    $Process.PriorityClass = [System.Diagnostics.ProcessPriorityClass]$Policy.OriginalPriorityClass
  } catch {
    Write-Warning "Unable to restore process policy for pid $($Policy.Pid): $($_.Exception.Message)"
  }
}

function Set-McbotLowImpactChildProcessPolicy {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$Role
  )
  return Set-McbotLowImpactProcessPolicy -Process $Process -Role $Role
}

function Get-McbotKillOnCloseJobProcessPolicySnapshot {
  [CmdletBinding()]
  param()
  $observations = @()
  $expectedAffinity = [int64]([Diagnostics.Process]::GetCurrentProcess().ProcessorAffinity.ToInt64())
  foreach ($childPid in @(Get-McbotKillOnCloseJobProcessIds | Where-Object { [int]$_ -ne $PID })) {
    $process = Get-Process -Id $childPid -ErrorAction SilentlyContinue
    if ($null -eq $process) { continue }
    $identity = $null
    try {
      $inJob = $false
      if (-not [Mcbot.ResourceControl.NativeJob]::IsProcessInJob(
          $process.Handle,
          $script:McbotKillOnCloseJobHandle,
          [ref]$inJob
        )) {
        throw "Unable to verify low-impact Job membership for pid $childPid (Win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
      }
      if (-not $inJob) { continue }
      $identity = New-McbotProcessIdentity -Process $process -Role 'low-impact-job-policy-observation'
      if ($null -eq $identity) { continue }
      $priority = [string]$process.PriorityClass
      $affinity = [int64]$process.ProcessorAffinity.ToInt64()
      $observations += [pscustomobject]@{
        Pid = [int]$identity.Pid
        StartTimeUtcTicks = [int64]$identity.StartTimeUtcTicks
        ProcessName = [string]$identity.ProcessName
        PriorityClass = $priority
        ProcessorAffinity = ('0x{0:x}' -f $affinity)
        PolicyValid = $priority -eq 'Idle' `
          -and $affinity -eq $expectedAffinity `
          -and $affinity -gt 0 `
          -and ($affinity -band ($affinity - 1)) -eq 0
      }
    } catch {
      # Exiting descendants are expected during a poll. Any failure against a
      # process that is still active remains fail-closed.
      try { if ($process.HasExited) { continue } } catch { continue }
      throw
    } finally {
      $process.Dispose()
    }
  }
  return @($observations)
}

function Assert-McbotKillOnCloseJobChildrenLowImpact {
  [CmdletBinding()]
  param()
  $snapshot = @(Get-McbotKillOnCloseJobProcessPolicySnapshot)
  $violations = @($snapshot | Where-Object { -not [bool]$_.PolicyValid })
  if ($violations.Count -ne 0) {
    $details = @($violations | ForEach-Object {
      $safeName = ([string]$_.ProcessName -replace '[^A-Za-z0-9._-]', '?')
      "pid=$($_.Pid),startTicks=$($_.StartTimeUtcTicks),name=$safeName,priority=$($_.PriorityClass),affinity=$($_.ProcessorAffinity)"
    })
    throw "A contained workload descendant escaped required Idle/one-core scheduling ($($details -join '; '))."
  }
  return @($snapshot)
}

function Wait-McbotRegisteredWorkloadProcessLowImpact {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Registration,
    [string[]]$RequiredProcessName = @(),
    [ValidateRange(10, 1000)][int]$PollMilliseconds = 250
  )
  if ($Registration.Released) { throw "Cannot wait on released $($Registration.Role) registration." }
  $observed = @{}
  do {
    foreach ($entry in @(Assert-McbotKillOnCloseJobChildrenLowImpact)) {
      $key = '{0}:{1}' -f ([int]$entry.Pid), ([int64]$entry.StartTimeUtcTicks)
      $observed[$key] = $entry
    }
    $exited = $Registration.Process.WaitForExit($PollMilliseconds)
  } while (-not $exited)
  foreach ($entry in @(Assert-McbotKillOnCloseJobChildrenLowImpact)) {
    $key = '{0}:{1}' -f ([int]$entry.Pid), ([int64]$entry.StartTimeUtcTicks)
    $observed[$key] = $entry
  }
  $required = @($RequiredProcessName | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } | Where-Object { $_ })
  $observedNames = @($observed.Values | ForEach-Object { ([string]$_.ProcessName).ToLowerInvariant() })
  if ($required.Count -ne 0 -and @($observedNames | Where-Object { $_ -in $required }).Count -eq 0) {
    throw "No required low-impact descendant process was observed for $($Registration.Role) (required=$($required -join '|'))."
  }
  $receipt = [pscustomobject]@{
    Applied = $true
    Role = [string]$Registration.Role
    ObservedProcessCount = [int]$observed.Count
    ObservedProcessNames = @($observedNames | Sort-Object -Unique)
    RequiredProcessNames = $required
    PriorityClass = 'Idle'
    ProcessorCount = 1
  }
  $Registration | Add-Member -Force -NotePropertyName DescendantPolicyReceipt -NotePropertyValue $receipt
  return $receipt
}

function Assert-McbotLowImpactJavaEnvironment {
  [CmdletBinding()]
  param(
    [AllowNull()][string]$JavaToolOptions = ([string]$env:JAVA_TOOL_OPTIONS),
    [AllowNull()][string]$JavaOptions = ([string]$env:JAVA_OPTS),
    [AllowNull()][string]$GradleOptions = ([string]$env:GRADLE_OPTS)
  )
  if (-not [string]::IsNullOrWhiteSpace([string]$env:_JAVA_OPTIONS) `
      -or -not [string]::IsNullOrWhiteSpace([string]$env:JDK_JAVA_OPTIONS) `
      -or -not [string]::IsNullOrWhiteSpace($JavaToolOptions) `
      -or -not [string]::IsNullOrWhiteSpace($JavaOptions) `
      -or -not [string]::IsNullOrWhiteSpace($GradleOptions)) {
    throw 'JAVA_TOOL_OPTIONS, _JAVA_OPTIONS, JDK_JAVA_OPTIONS, JAVA_OPTS, and GRADLE_OPTS must be unset before the canonical low-impact JVM policy is applied.'
  }
}

function Get-McbotCanonicalJavaToolOptions {
  return @(
    '-XX:+UseSerialGC',
    '-XX:ActiveProcessorCount=2',
    '-XX:CICompilerCount=2',
    '-Djava.util.concurrent.ForkJoinPool.common.parallelism=1'
  ) -join ' '
}

function Assert-McbotSafeGradleArguments {
  [CmdletBinding()]
  param([AllowEmptyCollection()][string[]]$Arguments = @())
  foreach ($argument in $Arguments) {
    $text = [string]$argument
    if ($text -match '(?i)^(?:--(?:no-)?daemon|--(?:no-)?parallel|--max-workers(?:=|$)|--priority(?:=|$)|--system-prop(?:=|$)|-D(?:=|$)|-D\s+org\.gradle\.|-Dorg\.gradle\.(?:jvmargs|workers\.max|parallel|daemon|priority|java\.home)(?:=|$))') {
      throw "Gradle argument conflicts with the canonical low-impact policy: $text"
    }
  }
}

function Get-McbotCanonicalGradleArguments {
  [CmdletBinding()]
  param(
    [ValidateSet('1G', '2G')][string]$MaxHeap = '1G',
    [Parameter(Mandatory = $true)][string]$JdkRoot
  )
  $resolvedJdkRoot = [IO.Path]::GetFullPath($JdkRoot)
  if (-not (Test-Path -LiteralPath (Join-Path $resolvedJdkRoot 'bin\java.exe') -PathType Leaf) `
      -or -not (Test-Path -LiteralPath (Join-Path $resolvedJdkRoot 'bin\javac.exe') -PathType Leaf)) {
    throw 'Canonical Gradle arguments require the validated JDK root containing bin\java.exe and bin\javac.exe.'
  }
  $jvmArguments = "-Xmx$MaxHeap $(Get-McbotCanonicalJavaToolOptions)"
  return @(
    '--no-daemon',
    '--no-parallel',
    '--max-workers=1',
    "-Dorg.gradle.jvmargs=$jvmArguments",
    '-Dorg.gradle.workers.max=1',
    '-Dorg.gradle.parallel=false',
    '-Dorg.gradle.daemon=false',
    "-Dorg.gradle.java.home=$resolvedJdkRoot"
  )
}

function New-McbotProcessIdentity {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$Role,
    [AllowNull()]$ExpectedStartTimeUtc = $null
  )
  try {
    if ($Process.HasExited) { return $null }
    $actualStart = $Process.StartTime.ToUniversalTime()
    if ($null -ne $ExpectedStartTimeUtc) {
      $expectedStart = ([datetime]$ExpectedStartTimeUtc).ToUniversalTime()
    # CIM CreationDate may lose a few 100 ns ticks while referring to the same
    # Windows creation time. Bind it within 1 ms, then retain the exact Process
    # StartTime ticks below as the identity used by every later revalidation.
    if ([Math]::Abs([int64]$actualStart.Ticks - [int64]$expectedStart.Ticks) -gt 10000) { return $null }
    }
    return [pscustomobject]@{
      Pid = [int]$Process.Id
      StartTimeUtcTicks = [int64]$actualStart.Ticks
      StartedAt = $actualStart.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
      ProcessName = [string]$Process.ProcessName
      Role = $Role
    }
  } catch {
    return $null
  }
}

function New-McbotCimProcessIdentity {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$CimProcess,
    [string]$Role = 'signature-fallback'
  )
  if ($null -eq $CimProcess.CreationDate) { return $null }
  $processId = [int]$CimProcess.ProcessId
  if ($processId -le 0) { return $null }
  $currentCim = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $currentCim -or $null -eq $currentCim.CreationDate) { return $null }
  try {
    $originalCreationTicks = ([datetime]$CimProcess.CreationDate).ToUniversalTime().Ticks
    $currentCreationTicks = ([datetime]$currentCim.CreationDate).ToUniversalTime().Ticks
  } catch {
    return $null
  }
  if ([int64]$currentCreationTicks -ne [int64]$originalCreationTicks `
      -or -not [string]::Equals([string]$currentCim.Name, [string]$CimProcess.Name, [StringComparison]::OrdinalIgnoreCase) `
      -or -not [string]::Equals([string]$currentCim.CommandLine, [string]$CimProcess.CommandLine, [StringComparison]::Ordinal) `
      -or [int]$currentCim.ParentProcessId -ne [int]$CimProcess.ParentProcessId) {
    return $null
  }
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }
  return New-McbotProcessIdentity `
    -Process $process `
    -Role $Role `
    -ExpectedStartTimeUtc $currentCim.CreationDate
}

function Get-McbotValidatedProcess {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Identity)
  if ($null -eq $Identity -or [int]$Identity.Pid -le 0 -or [int64]$Identity.StartTimeUtcTicks -le 0) {
    return $null
  }
  $process = Get-Process -Id ([int]$Identity.Pid) -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }
  try {
    if ($process.HasExited `
        -or [int64]$process.StartTime.ToUniversalTime().Ticks -ne [int64]$Identity.StartTimeUtcTicks) {
      return $null
    }
    return $process
  } catch {
    return $null
  }
}

function Test-McbotProcessIdentity {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Identity)
  return $null -ne (Get-McbotValidatedProcess -Identity $Identity)
}

function Test-McbotStrictDescendantIdentity {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$ParentIdentity,
    [Parameter(Mandatory = $true)]$ChildIdentity
  )
  if ($null -eq $ParentIdentity -or $null -eq $ChildIdentity) { return $false }
  return [int64]$ChildIdentity.StartTimeUtcTicks -gt [int64]$ParentIdentity.StartTimeUtcTicks
}

function Stop-McbotProcessIdentityTree {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Identity,
    [ValidateRange(0, 2000)][int]$WaitMilliseconds = 2000,
    [ref]$Diagnostic
  )
  $validated = Get-McbotValidatedProcess -Identity $Identity
  if ($null -eq $validated) {
    if ($PSBoundParameters.ContainsKey('Diagnostic')) {
      $Diagnostic.Value = [pscustomobject]@{
        Pid = [int]$Identity.Pid
        StartTimeUtcTicks = [int64]$Identity.StartTimeUtcTicks
        ProcessName = 'unavailable'
        Role = [string]$Identity.Role
        Outcome = 'exact_identity_not_active'
        NativeError = $null
      }
    }
    return $false
  }
  $processName = [string]$validated.ProcessName
  $validated.Dispose()
  # Open one native handle, verify its creation time, and terminate through that
  # same retained handle. A process that exits and lends its PID to another app
  # between validation and termination can therefore never become the target.
  $nativeError = 0
  $stopped = [Mcbot.ResourceControl.NativeProcess]::TerminateExactWithWait(
    [int]$Identity.Pid,
    [int64]$Identity.StartTimeUtcTicks,
    [uint32]$WaitMilliseconds,
    [ref]$nativeError
  )
  $outcome = if ($stopped) { 'terminated_and_signaled' } else { 'native_termination_refused_or_incomplete' }
  if ($PSBoundParameters.ContainsKey('Diagnostic')) {
    $Diagnostic.Value = [pscustomobject]@{
      Pid = [int]$Identity.Pid
      StartTimeUtcTicks = [int64]$Identity.StartTimeUtcTicks
      ProcessName = $processName
      Role = [string]$Identity.Role
      Outcome = $outcome
      NativeError = [int]$nativeError
    }
  }
  return $stopped
}

function Get-McbotProcessTreeIdentities {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$RootIdentity,
    [int[]]$ExcludedPid = @()
  )
  if ($null -eq (Get-McbotValidatedProcess -Identity $RootIdentity)) { return @() }
  $snapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $queue = [System.Collections.Generic.Queue[object]]::new()
  $queue.Enqueue($RootIdentity)
  $result = @()
  $seen = @{}
  while ($queue.Count -gt 0) {
    $parent = $queue.Dequeue()
    $key = '{0}:{1}' -f ([int]$parent.Pid), ([int64]$parent.StartTimeUtcTicks)
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    if ([int]$parent.Pid -in $ExcludedPid) { continue }
    # Revalidate after the CIM snapshot and again for every dequeued descendant;
    # a PID reused during enumeration must terminate that entire subtree.
    if ($null -eq (Get-McbotValidatedProcess -Identity $parent)) { continue }
    $result += $parent
    foreach ($candidate in @($snapshot | Where-Object { [int]$_.ParentProcessId -eq [int]$parent.Pid })) {
      if ([int]$candidate.ProcessId -in $ExcludedPid) { continue }
      $child = New-McbotCimProcessIdentity -CimProcess $candidate -Role "descendant-of-$($RootIdentity.Role)"
      # Parentage must be temporally strict. Equal creation ticks are
      # ambiguous at Windows clock resolution and may represent a stale PPID
      # after PID reuse, so they are never admitted to a destructive tree.
      if ($null -eq $child -or -not (Test-McbotStrictDescendantIdentity -ParentIdentity $parent -ChildIdentity $child)) { continue }
      $queue.Enqueue($child)
    }
  }
  return @(Select-McbotUniqueProcessIdentity -Identity $result)
}

function Test-McbotCommandLineContainsPath {
  [CmdletBinding()]
  param(
    [AllowNull()][string]$CommandLine,
    [Parameter(Mandatory = $true)][string]$RepositoryRoot
  )
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  $needle = [System.IO.Path]::GetFullPath($RepositoryRoot).TrimEnd([char[]]@('\', '/'))
  if ([string]::IsNullOrWhiteSpace($needle)) { return $false }
  $searchFrom = 0
  while ($searchFrom -lt $CommandLine.Length) {
    $index = $CommandLine.IndexOf($needle, $searchFrom, [StringComparison]::OrdinalIgnoreCase)
    if ($index -lt 0) { return $false }
    $afterIndex = $index + $needle.Length
    $beforeOk = $index -eq 0 `
      -or [char]::IsWhiteSpace($CommandLine[$index - 1]) `
      -or ([string]$CommandLine[$index - 1]) -in @('"', "'", '=', ';')
    $afterOk = $afterIndex -eq $CommandLine.Length `
      -or [char]::IsWhiteSpace($CommandLine[$afterIndex]) `
      -or ([string]$CommandLine[$afterIndex]) -in @('\', '/', '"', "'", ';')
    if ($beforeOk -and $afterOk) { return $true }
    $searchFrom = $index + 1
  }
  return $false
}

function Select-McbotUniqueProcessIdentity {
  [CmdletBinding()]
  param([object[]]$Identity)
  $seen = @{}
  foreach ($entry in @($Identity)) {
    if ($null -eq $entry) { continue }
    $key = '{0}:{1}' -f ([int]$entry.Pid), ([int64]$entry.StartTimeUtcTicks)
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $entry
  }
}
