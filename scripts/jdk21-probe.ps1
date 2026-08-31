param(
  [Parameter(Mandatory = $true)]
  [string]$JavaExecutable,

  [Parameter(Mandatory = $true)]
  [string]$ReadyPath
)

$ErrorActionPreference = 'Stop'
$javaPath = [IO.Path]::GetFullPath($JavaExecutable)
$gatePath = [IO.Path]::GetFullPath($ReadyPath)
if (-not (Test-Path -LiteralPath $javaPath -PathType Leaf)) {
  throw 'The registered JDK probe received an invalid Java executable.'
}
$requiredLockEnvironment = @(
  'MCBOT_RESOURCE_LOCK_PATH',
  'MCBOT_RESOURCE_LOCK_OWNER_ID',
  'MCBOT_RESOURCE_LOCK_REPOSITORY_ID',
  'MCBOT_RESOURCE_LOCK_OWNER_PID'
)
foreach ($name in $requiredLockEnvironment) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) {
    throw "The registered JDK probe is missing required containment state ($name)."
  }
}
$expectedJavaPolicy = '-XX:+UseSerialGC -XX:ActiveProcessorCount=2 -XX:CICompilerCount=2 -Djava.util.concurrent.ForkJoinPool.common.parallelism=1'
if ([string]$env:JAVA_TOOL_OPTIONS -cne $expectedJavaPolicy) {
  throw 'The registered JDK probe requires the canonical low-impact Java policy.'
}
$currentProcess = [Diagnostics.Process]::GetCurrentProcess()
$affinity = $currentProcess.ProcessorAffinity.ToInt64()
if ($currentProcess.PriorityClass -ne [Diagnostics.ProcessPriorityClass]::Idle `
    -or $affinity -le 0 -or (($affinity -band ($affinity - 1)) -ne 0)) {
  throw 'The registered JDK probe did not inherit Idle/one-core process controls.'
}

# The parent creates this unpredictable gate only after this PowerShell process
# is registered under the repository resource-lock owner and inherited the
# wrapper's kill-on-close Job. Java therefore cannot race ahead of containment.
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (-not (Test-Path -LiteralPath $gatePath -PathType Leaf)) {
  if ([DateTime]::UtcNow -ge $deadline) {
    throw 'The registered JDK probe timed out waiting for its containment gate.'
  }
  Start-Sleep -Milliseconds 25
}

$priorNativePreference = $null
$hasNativePreference = Test-Path Variable:\PSNativeCommandUseErrorActionPreference
if ($hasNativePreference) {
  $priorNativePreference = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
}
try {
  & $javaPath -version 2>&1 | ForEach-Object { [Console]::Out.WriteLine([string]$_) }
  $probeExitCode = if ($null -eq $LASTEXITCODE) { 1 } else { [int]$LASTEXITCODE }
} finally {
  if ($hasNativePreference) {
    $PSNativeCommandUseErrorActionPreference = $priorNativePreference
  }
}
exit $probeExitCode
