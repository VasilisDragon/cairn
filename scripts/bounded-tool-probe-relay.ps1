param(
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][ValidateSet('native', 'node', 'jdk')][string]$Kind,
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][ValidateLength(4, 65536)][string]$ArgumentsBase64,
  [Parameter(Mandatory = $true)][ValidateRange(1024, 8388608)][int]$MaxCaptureBytes
)

$ErrorActionPreference = 'Stop'
$toolPath = [IO.Path]::GetFullPath($Executable)
$gatePath = [IO.Path]::GetFullPath($ReadyPath)
if (-not (Test-Path -LiteralPath $toolPath -PathType Leaf)) {
  throw 'The bounded tool-probe relay received an invalid executable.'
}
$toolName = [IO.Path]::GetFileNameWithoutExtension($toolPath).ToLowerInvariant()
if ($Kind -eq 'node' -and $toolName -ne 'node') {
  throw 'The bounded Node probe relay requires the Node executable.'
}
if ($Kind -eq 'jdk' -and $toolName -notin @('java', 'jar', 'javac')) {
  throw 'The bounded JDK probe relay accepts only java, jar, or javac.'
}

$argumentDocument = $null
try {
  $argumentJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgumentsBase64))
  $argumentDocument = [Text.Json.JsonDocument]::Parse($argumentJson)
  if ($argumentDocument.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Array) {
    throw 'The bounded tool-probe relay arguments must be a JSON array.'
  }
  $toolArguments = @()
  foreach ($element in $argumentDocument.RootElement.EnumerateArray()) {
    if ($element.ValueKind -ne [Text.Json.JsonValueKind]::String) {
      throw 'The bounded tool-probe relay arguments must contain only strings.'
    }
    $value = [string]$element.GetString()
    if ($value.IndexOf([char]0) -ge 0) {
      throw 'The bounded tool-probe relay arguments must not contain NUL characters.'
    }
    $toolArguments += $value
  }
  if ($toolArguments.Count -gt 256) {
    throw 'The bounded tool-probe relay received too many arguments.'
  }
} finally {
  if ($null -ne $argumentDocument) { $argumentDocument.Dispose() }
}

foreach ($name in @(
  'MCBOT_RESOURCE_LOCK_PATH',
  'MCBOT_RESOURCE_LOCK_OWNER_ID',
  'MCBOT_RESOURCE_LOCK_REPOSITORY_ID',
  'MCBOT_RESOURCE_LOCK_OWNER_PID'
)) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) {
    throw "The bounded tool-probe relay is missing required containment state ($name)."
  }
}
if ($Kind -eq 'node' `
    -and ([string]$env:NODE_OPTIONS -cne '--v8-pool-size=1' `
      -or [string]$env:UV_THREADPOOL_SIZE -cne '2')) {
  throw 'The bounded Node probe relay did not inherit canonical V8/libuv caps.'
}
$expectedJavaPolicy = '-XX:+UseSerialGC -XX:ActiveProcessorCount=2 -XX:CICompilerCount=2 -Djava.util.concurrent.ForkJoinPool.common.parallelism=1'
if ($Kind -eq 'jdk' -and [string]$env:JAVA_TOOL_OPTIONS -cne $expectedJavaPolicy) {
  throw 'The bounded JDK probe relay did not inherit the canonical Java policy.'
}

# The parent creates this unpredictable gate only after this relay has been
# registered under the resource-lock owner and its Idle/one-core policy has
# been read back. The native tool cannot race ahead of containment.
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (-not (Test-Path -LiteralPath $gatePath -PathType Leaf)) {
  if ([DateTime]::UtcNow -ge $deadline) {
    throw 'The bounded tool-probe relay timed out waiting for its containment gate.'
  }
  Start-Sleep -Milliseconds 25
}

# The gate proves the parent has completed registration and applied/read back
# the child policy. Validate the relay itself only after that transition.
$currentProcess = [Diagnostics.Process]::GetCurrentProcess()
$currentProcess.Refresh()
$affinity = $currentProcess.ProcessorAffinity.ToInt64()
if ($currentProcess.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::Idle `
    -or $affinity -le 0 -or (($affinity -band ($affinity - 1)) -ne 0)) {
  throw 'The bounded tool-probe relay did not receive Idle/one-core process controls.'
}

# Prefix each relay stream before any tool payload. The registered parent uses
# a text reader, whose BOM detection is only special at byte zero; this ASCII
# frame keeps a leading U+FEFF in valid tool output from being stripped.
$stdoutFramePrefix = 'MCBOT_TOOL_PROBE_STDOUT_V1:'
$stderrFramePrefix = 'MCBOT_TOOL_PROBE_STDERR_V1:'
$frameEncoding = [Text.Encoding]::ASCII
$relayStdout = [Console]::OpenStandardOutput()
$relayStderr = [Console]::OpenStandardError()
$stdoutFrameBytes = $frameEncoding.GetBytes($stdoutFramePrefix)
$stderrFrameBytes = $frameEncoding.GetBytes($stderrFramePrefix)
$relayStdout.Write($stdoutFrameBytes, 0, $stdoutFrameBytes.Length)
$relayStdout.Flush()
$relayStderr.Write($stderrFrameBytes, 0, $stderrFrameBytes.Length)
$relayStderr.Flush()

# Redirect both native streams and drain them concurrently in fixed-size byte
# chunks. The shared limit is enforced before a chunk is retained, so neither
# this relay nor its registered parent can accumulate unbounded probe output.
# Captured bytes are forwarded only after the native process closes both pipes.
$toolStart = [Diagnostics.ProcessStartInfo]::new()
$toolStart.FileName = $toolPath
$toolStart.UseShellExecute = $false
$toolStart.CreateNoWindow = $true
$toolStart.WorkingDirectory = [Environment]::CurrentDirectory
$toolStart.RedirectStandardOutput = $true
$toolStart.RedirectStandardError = $true
foreach ($argument in $toolArguments) {
  [void]$toolStart.ArgumentList.Add([string]$argument)
}
$toolProcess = [Diagnostics.Process]::new()
$toolProcess.StartInfo = $toolStart
if (-not $toolProcess.Start()) {
  throw 'The bounded tool-probe relay could not launch the native tool.'
}

$stdoutCapture = $null
$stderrCapture = $null
$exitCode = 1
try {
  $stdoutCapture = [IO.MemoryStream]::new()
  $stderrCapture = [IO.MemoryStream]::new()
  $stdoutBuffer = [byte[]]::new(8192)
  $stderrBuffer = [byte[]]::new(8192)
  $stdoutStream = $toolProcess.StandardOutput.BaseStream
  $stderrStream = $toolProcess.StandardError.BaseStream
  $stdoutRead = $stdoutStream.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
  $stderrRead = $stderrStream.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
  $stdoutOpen = $true
  $stderrOpen = $true
  $captureExceeded = $false
  while ($stdoutOpen -or $stderrOpen) {
    $madeProgress = $false
    if ($stdoutOpen -and $stdoutRead.IsCompleted) {
      $readCount = [int]$stdoutRead.GetAwaiter().GetResult()
      $madeProgress = $true
      if ($readCount -eq 0) {
        $stdoutOpen = $false
      } elseif (($stdoutCapture.Length + $stderrCapture.Length + $readCount) -gt $MaxCaptureBytes) {
        $captureExceeded = $true
      } else {
        $stdoutCapture.Write($stdoutBuffer, 0, $readCount)
        $stdoutRead = $stdoutStream.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
      }
    }
    if (-not $captureExceeded -and $stderrOpen -and $stderrRead.IsCompleted) {
      $readCount = [int]$stderrRead.GetAwaiter().GetResult()
      $madeProgress = $true
      if ($readCount -eq 0) {
        $stderrOpen = $false
      } elseif (($stdoutCapture.Length + $stderrCapture.Length + $readCount) -gt $MaxCaptureBytes) {
        $captureExceeded = $true
      } else {
        $stderrCapture.Write($stderrBuffer, 0, $readCount)
        $stderrRead = $stderrStream.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
      }
    }
    if ($captureExceeded) {
      try { $toolProcess.Kill($true) } catch { }
      [void]$toolProcess.WaitForExit(2000)
      throw "The bounded tool-probe relay rejected output above $MaxCaptureBytes bytes."
    }
    if (-not $madeProgress) {
      $pendingReads = [Collections.Generic.List[Threading.Tasks.Task]]::new()
      if ($stdoutOpen) { [void]$pendingReads.Add([Threading.Tasks.Task]$stdoutRead) }
      if ($stderrOpen) { [void]$pendingReads.Add([Threading.Tasks.Task]$stderrRead) }
      if ($pendingReads.Count -gt 0) {
        [void][Threading.Tasks.Task]::WaitAny($pendingReads.ToArray(), 25)
      }
    }
  }

  $toolProcess.WaitForExit()
  $exitCode = [int]$toolProcess.ExitCode
  $capturedStdout = $stdoutCapture.ToArray()
  $capturedStderr = $stderrCapture.ToArray()
  # The registered parent captures text. Reject malformed UTF-8 before it can
  # expand through replacement characters and invalidate the outer byte cap.
  $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
  [void]$strictUtf8.GetCharCount($capturedStdout)
  [void]$strictUtf8.GetCharCount($capturedStderr)
  if ($capturedStdout.Length -gt 0) {
    $relayStdout.Write($capturedStdout, 0, $capturedStdout.Length)
    $relayStdout.Flush()
  }
  if ($capturedStderr.Length -gt 0) {
    $relayStderr.Write($capturedStderr, 0, $capturedStderr.Length)
    $relayStderr.Flush()
  }
} finally {
  if (-not $toolProcess.HasExited) {
    try { $toolProcess.Kill($true) } catch { }
    [void]$toolProcess.WaitForExit(2000)
  }
  if ($null -ne $stdoutCapture) { $stdoutCapture.Dispose() }
  if ($null -ne $stderrCapture) { $stderrCapture.Dispose() }
  $toolProcess.Dispose()
}

exit $exitCode
