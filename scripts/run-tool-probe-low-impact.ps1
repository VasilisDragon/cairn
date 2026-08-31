param(
  [Parameter(Mandatory = $true)][string]$RepositoryRoot,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [Parameter(Mandatory = $true)][ValidateSet('native', 'node', 'jdk')][string]$Kind,
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][ValidateLength(4, 65536)][string]$ArgumentsBase64,
  [ValidateRange(100, 60000)][int]$TimeoutMilliseconds = 10000,
  [ValidateRange(1024, 8388608)][int]$MaxCaptureBytes = 8388608
)

$ErrorActionPreference = 'Stop'

$resolvedRoot = [IO.Path]::GetFullPath($RepositoryRoot)
if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
  throw 'The registered tool probe repository root is invalid.'
}
$resolvedWorkingDirectory = [IO.Path]::GetFullPath($WorkingDirectory)
if (-not (Test-Path -LiteralPath $resolvedWorkingDirectory -PathType Container)) {
  throw 'The registered tool probe working directory is invalid.'
}

$argumentDocument = $null
try {
  $argumentJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64))
  $argumentDocument = [Text.Json.JsonDocument]::Parse($argumentJson)
  if ($argumentDocument.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Array) {
    throw 'The registered tool probe arguments must be a JSON array.'
  }
  $toolArguments = @()
  foreach ($element in $argumentDocument.RootElement.EnumerateArray()) {
    if ($element.ValueKind -ne [Text.Json.JsonValueKind]::String) {
      throw 'The registered tool probe arguments must contain only strings.'
    }
    $value = [string]$element.GetString()
    if ($value.IndexOf([char]0) -ge 0) {
      throw 'The registered tool probe arguments must not contain NUL characters.'
    }
    $toolArguments += $value
  }
  if ($toolArguments.Count -gt 256) {
    throw 'The registered tool probe received too many arguments.'
  }
} finally {
  if ($null -ne $argumentDocument) { $argumentDocument.Dispose() }
}

if ([IO.Path]::IsPathRooted($Executable)) {
  $toolPath = [IO.Path]::GetFullPath($Executable)
} else {
  if ($Executable -notmatch '^[A-Za-z0-9_.+-]+$') {
    throw 'The registered tool probe executable name is invalid.'
  }
  $toolCommand = Get-Command $Executable -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $toolCommand) { throw 'The registered tool probe executable is unavailable.' }
  $toolPath = [IO.Path]::GetFullPath($toolCommand.Source)
}
if (-not (Test-Path -LiteralPath $toolPath -PathType Leaf)) {
  throw 'The registered tool probe executable is not a regular file.'
}

$toolName = [IO.Path]::GetFileNameWithoutExtension($toolPath).ToLowerInvariant()
if ($Kind -eq 'node' -and $toolName -ne 'node') {
  throw 'The capped Node tool probe requires the Node executable.'
}
if ($Kind -eq 'jdk' -and $toolName -notin @('java', 'jar', 'javac')) {
  throw 'The capped JDK tool probe accepts only java, jar, or javac.'
}

. (Join-Path $PSScriptRoot 'resource-lock.ps1')
Assert-McbotLowImpactJavaEnvironment
$processPolicy = Set-McbotLowImpactProcessPolicy -Role "baseline-$Kind-tool-probe-wrapper"
$canonicalJavaOptions = '-XX:+UseSerialGC -XX:ActiveProcessorCount=2 -XX:CICompilerCount=2 -Djava.util.concurrent.ForkJoinPool.common.parallelism=1'
if ($Kind -eq 'node') {
  if ([string]$env:NODE_OPTIONS -cne '--v8-pool-size=1' -or [string]$env:UV_THREADPOOL_SIZE -cne '2') {
    throw 'The registered Node tool probe requires canonical V8 and libuv caps.'
  }
} elseif (-not [string]::IsNullOrWhiteSpace([string]$env:NODE_OPTIONS)) {
  throw 'Non-Node registered tool probes refuse NODE_OPTIONS.'
}
if ($Kind -eq 'jdk') { $env:JAVA_TOOL_OPTIONS = $canonicalJavaOptions }

$resourceLock = $null
$registration = $null
$readyPath = Join-Path ([IO.Path]::GetTempPath()) ("mcbot-bounded-tool-probe-{0}-{1}.ready" -f $PID, [guid]::NewGuid())
$relayPath = Join-Path $PSScriptRoot 'bounded-tool-probe-relay.ps1'
if (-not (Test-Path -LiteralPath $relayPath -PathType Leaf)) {
  throw 'The bounded registered tool-probe relay is missing.'
}
$exitCode = 1
try {
  $resourceLock = Enter-McbotResourceLock `
    -RepositoryRoot $resolvedRoot `
    -Purpose "baseline-$Kind-tool-probe" `
    -EntrypointPath $PSCommandPath `
    -WaitMilliseconds 0 `
    -Controls @{
      schedulingPriority = $processPolicy.PriorityClass
      processorAffinity = $processPolicy.ProcessorAffinity
      activeProcessorCount = $(if ($Kind -eq 'jdk') { 2 } else { $null })
      ciCompilerCount = $(if ($Kind -eq 'jdk') { 2 } else { $null })
      forkJoinParallelism = $(if ($Kind -eq 'jdk') { 1 } else { $null })
      nodeThreadPoolSize = $(if ($Kind -eq 'node') { 2 } else { $null })
      serialGc = ($Kind -eq 'jdk')
      serialized = $true
      v8PoolSize = $(if ($Kind -eq 'node') { 1 } else { $null })
    }
  $registration = Start-McbotRegisteredWorkloadProcess `
    -Lease $resourceLock `
    -FilePath ([Diagnostics.Process]::GetCurrentProcess().Path) `
    -ArgumentList @(
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', $relayPath,
      '-ReadyPath', $readyPath,
      '-Kind', $Kind,
      '-Executable', $toolPath,
      '-ArgumentsBase64', $ArgumentsBase64,
      '-MaxCaptureBytes', [string]$MaxCaptureBytes
    ) `
    -WorkingDirectory $resolvedWorkingDirectory `
    -Role "baseline-$Kind-tool-probe-relay" `
    -CaptureOutput
  # Capture is safe here because the gated relay itself enforces one shared
  # byte limit while draining the native stdout/stderr pipes. The wrapper's
  # concurrent ReadToEndAsync tasks therefore have a strict upstream bound.
  New-Item -ItemType File -Path $readyPath -ErrorAction Stop | Out-Null
  if (-not $registration.Process.WaitForExit($TimeoutMilliseconds)) {
    throw "The registered $Kind tool probe timed out after $TimeoutMilliseconds milliseconds."
  }
  $exitCode = [int]$registration.Process.ExitCode
  Complete-McbotResourceLockWorkloadProcess -Registration $registration
  $stdoutReady = $registration.StandardOutputTask.Wait(2000)
  $stderrReady = $registration.StandardErrorTask.Wait(2000)
  if (-not $stdoutReady -or -not $stderrReady) {
    throw 'The registered tool probe output pipes did not close after relay exit.'
  }
  $capturedStdout = [string]$registration.StandardOutputTask.GetAwaiter().GetResult()
  $capturedStderr = [string]$registration.StandardErrorTask.GetAwaiter().GetResult()
  $stdoutFramePrefix = 'MCBOT_TOOL_PROBE_STDOUT_V1:'
  $stderrFramePrefix = 'MCBOT_TOOL_PROBE_STDERR_V1:'
  if (-not $capturedStdout.StartsWith($stdoutFramePrefix, [StringComparison]::Ordinal) `
      -or -not $capturedStderr.StartsWith($stderrFramePrefix, [StringComparison]::Ordinal)) {
    throw 'The registered tool probe relay returned invalid framed output.'
  }
  $capturedStdout = $capturedStdout.Substring($stdoutFramePrefix.Length)
  $capturedStderr = $capturedStderr.Substring($stderrFramePrefix.Length)
  $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
  $capturedStdoutBytes = $strictUtf8.GetBytes($capturedStdout)
  $capturedStderrBytes = $strictUtf8.GetBytes($capturedStderr)
  $forwardedBytes = $capturedStdoutBytes.Length + $capturedStderrBytes.Length
  if ($forwardedBytes -gt $MaxCaptureBytes) {
    throw 'The registered tool probe relay exceeded its shared forwarding limit.'
  }
  $wrapperStdout = [Console]::OpenStandardOutput()
  $wrapperStderr = [Console]::OpenStandardError()
  if ($capturedStdoutBytes.Length -gt 0) {
    $wrapperStdout.Write($capturedStdoutBytes, 0, $capturedStdoutBytes.Length)
    $wrapperStdout.Flush()
  }
  if ($capturedStderrBytes.Length -gt 0) {
    $wrapperStderr.Write($capturedStderrBytes, 0, $capturedStderrBytes.Length)
    $wrapperStderr.Flush()
  }
} finally {
  try {
    if ($null -ne $registration -and -not $registration.Released) {
      Stop-McbotRegisteredWorkloadProcess -Registration $registration
    }
  } finally {
    try {
      if ($null -ne $resourceLock) { Exit-McbotResourceLock -Lease $resourceLock }
    } finally {
      try {
        Restore-McbotLowImpactProcessPolicy -Policy $processPolicy
      } finally {
        try {
          if ($Kind -eq 'jdk') { Remove-Item Env:\JAVA_TOOL_OPTIONS -ErrorAction SilentlyContinue }
        } finally {
          Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
        }
      }
    }
  }
}

exit $exitCode
