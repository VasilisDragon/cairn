param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('fabric-client', 'test-harness-plugin')]
  [string]$Project,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$GradleArguments
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Join-Path $repositoryRoot $Project
$wrapper = Join-Path $projectRoot 'gradlew.bat'
if (-not (Test-Path -LiteralPath $wrapper -PathType Leaf)) {
  throw "Gradle wrapper not found for $Project."
}
if ($null -eq $GradleArguments -or $GradleArguments.Count -eq 0) {
  throw 'At least one Gradle task or argument is required.'
}

. (Join-Path $PSScriptRoot 'resource-lock.ps1')
Assert-McbotLowImpactJavaEnvironment
Assert-McbotSafeGradleArguments -Arguments $GradleArguments
$processPolicy = Set-McbotLowImpactProcessPolicy -Role "gradle-$Project"
$env:JAVA_TOOL_OPTIONS = Get-McbotCanonicalJavaToolOptions
$resourceLock = $null
$javaProbe = $null
$javaProbeTimedOut = $false
$workload = $null
$exitCode = 1
try {
  $resourceLock = Enter-McbotResourceLock `
    -RepositoryRoot $repositoryRoot `
    -Purpose "gradle-$Project" `
    -EntrypointPath $PSCommandPath `
    -Controls @{
      schedulingPriority = $processPolicy.PriorityClass
      processorAffinity = $processPolicy.ProcessorAffinity
      gradleWorkers = 1
      activeProcessorCount = 2
      ciCompilerCount = 2
      forkJoinParallelism = 1
      serialGc = $true
      serialized = $true
    }
  Write-Host ("mcbot-resource-control: lock={0} inherited={1} priority={2} affinity={3} gradleWorkers=1" -f `
    $resourceLock.LockPath, $resourceLock.Inherited, $processPolicy.PriorityClass, $processPolicy.ProcessorAffinity)
  if (-not [string]::IsNullOrWhiteSpace([string]$env:JAVA_HOME)) {
    $javaExecutable = Join-Path $env:JAVA_HOME 'bin\java.exe'
  } else {
    $javaCommand = Get-Command java.exe -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    $javaExecutable = if ($null -eq $javaCommand) { $null } else { $javaCommand.Source }
  }
  if ([string]::IsNullOrWhiteSpace([string]$javaExecutable) `
      -or -not (Test-Path -LiteralPath $javaExecutable -PathType Leaf)) {
    throw 'The low-impact Gradle launcher requires a discoverable JDK 21 (set JAVA_HOME or PATH).'
  }
  $javacExecutable = Join-Path (Split-Path -Parent $javaExecutable) 'javac.exe'
  if (-not (Test-Path -LiteralPath $javacExecutable -PathType Leaf)) {
    throw 'The selected Java installation is not a JDK with bin\javac.exe.'
  }
  $javaProbeScript = Join-Path $PSScriptRoot 'jdk21-probe.ps1'
  if (-not (Test-Path -LiteralPath $javaProbeScript -PathType Leaf)) {
    throw 'The registered JDK 21 probe script is missing.'
  }
  $javaProbeGate = Join-Path ([IO.Path]::GetTempPath()) ("mcbot-jdk21-probe-{0}-{1}.ready" -f $PID, [guid]::NewGuid())
  try {
    $javaProbe = Start-McbotRegisteredWorkloadProcess `
      -Lease $resourceLock `
      -FilePath ([Diagnostics.Process]::GetCurrentProcess().Path) `
      -ArgumentList @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', $javaProbeScript, '-JavaExecutable', $javaExecutable, '-ReadyPath', $javaProbeGate
      ) `
      -WorkingDirectory $projectRoot `
      -Role "gradle-$Project-java-version-probe" `
      -CaptureOutput
    New-Item -ItemType File -Path $javaProbeGate -ErrorAction Stop | Out-Null
    $javaProbeTimedOut = -not $javaProbe.Process.WaitForExit(10000)
    if (-not $javaProbeTimedOut) {
      $javaProbeExitCode = [int]$javaProbe.Process.ExitCode
    }
  } finally {
    if ($null -ne $javaProbe -and -not $javaProbe.Released) {
      if (Test-McbotProcessIdentity -Identity $javaProbe.Identity) {
        Stop-McbotKillOnCloseJobChildren -Reason "$($javaProbe.Role) bounded probe cleanup"
      }
      Complete-McbotResourceLockWorkloadProcess -Registration $javaProbe
    }
    Remove-Item -LiteralPath $javaProbeGate -Force -ErrorAction SilentlyContinue
  }
  if ($javaProbeTimedOut) {
    throw 'The selected Java executable version probe timed out after 10 seconds.'
  }
  $javaProbeOutputReady = $javaProbe.StandardOutputTask.Wait(1000)
  $javaProbeErrorReady = $javaProbe.StandardErrorTask.Wait(1000)
  if (-not $javaProbeOutputReady -or -not $javaProbeErrorReady) {
    throw 'The selected Java executable version probe output did not close after bounded containment cleanup.'
  }
  $javaVersionOutput = @(
    [string]($javaProbe.StandardOutputTask.GetAwaiter().GetResult())
    [string]($javaProbe.StandardErrorTask.GetAwaiter().GetResult())
  ) -join [Environment]::NewLine
  if ($javaProbeExitCode -ne 0) {
    throw 'The selected Java executable failed its version probe.'
  }
  $javaMajorMatch = [regex]::Match(
    $javaVersionOutput,
    '(?im)(?:openjdk|java)(?:\s+version)?\s+"?(?<major>\d+)'
  )
  if (-not $javaMajorMatch.Success -or [int]$javaMajorMatch.Groups['major'].Value -ne 21) {
    $reportedMajor = if ($javaMajorMatch.Success) { $javaMajorMatch.Groups['major'].Value } else { 'unrecognized' }
    throw "The low-impact Gradle launcher requires JDK 21; selected Java reported major $reportedMajor."
  }
  $validatedJdkRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $javaExecutable)))
  $canonicalGradleArguments = Get-McbotCanonicalGradleArguments `
    -MaxHeap $(if ($Project -eq 'fabric-client') { '2G' } else { '1G' }) `
    -JdkRoot $validatedJdkRoot
  Push-Location -LiteralPath $projectRoot
  try {
    [void](Assert-McbotNoUncontrolledLocalMinecraftServer)
    $workload = Start-McbotRegisteredWorkloadProcess `
      -Lease $resourceLock `
      -FilePath $wrapper `
      -ArgumentList (@($GradleArguments) + @($canonicalGradleArguments)) `
      -WorkingDirectory $projectRoot `
      -Role "gradle-$Project-process"
    $descendantPolicy = Wait-McbotRegisteredWorkloadProcessLowImpact `
      -Registration $workload `
      -RequiredProcessName @('java', 'javaw')
    Write-Host ("mcbot-descendant-policy: role={0} observed={1} names={2} priority={3} processors={4}" -f `
      $descendantPolicy.Role, $descendantPolicy.ObservedProcessCount, `
      ($descendantPolicy.ObservedProcessNames -join '|'), $descendantPolicy.PriorityClass, `
      $descendantPolicy.ProcessorCount)
    $exitCode = [int]$workload.Process.ExitCode
    Complete-McbotResourceLockWorkloadProcess -Registration $workload
  } finally {
    Pop-Location
  }
} finally {
  try {
    try {
      if ($null -ne $workload -and -not $workload.Released) {
        Stop-McbotRegisteredWorkloadProcess -Registration $workload
      }
    } finally {
      if ($null -ne $resourceLock) { Exit-McbotResourceLock -Lease $resourceLock }
    }
  } finally {
    try {
      Restore-McbotLowImpactProcessPolicy -Policy $processPolicy
    } finally {
      Remove-Item Env:\JAVA_TOOL_OPTIONS -ErrorAction SilentlyContinue
    }
  }
}

exit $exitCode
