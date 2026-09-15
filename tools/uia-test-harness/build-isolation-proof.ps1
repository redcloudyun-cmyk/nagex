# Builds the DC3-B2-R2 isolated-desktop execution proof binaries:
#   - NagexExecutionWorker.exe  (runs inside the isolated desktop)
#   - NagexDesktopIsolationProof.exe (main-process stand-in, drives the proof)
# Both are gitignored build artifacts — run this before
# run-isolated-desktop-execution-proof.ps1. Also (re)builds the WPF
# harness these depend on.
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$wpf = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF'
$fx = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'

& $scriptDir\build-harness.ps1

& $csc /nologo /target:exe /out:"$scriptDir\NagexExecutionWorker.exe" `
  /reference:"$wpf\UIAutomationClient.dll" `
  /reference:"$wpf\UIAutomationTypes.dll" `
  /reference:"$fx\System.Core.dll" `
  "$scriptDir\NagexExecutionWorker.cs"
if ($LASTEXITCODE -ne 0) { throw "worker compile failed" }

& $csc /nologo /target:exe /out:"$scriptDir\NagexDesktopIsolationProof.exe" `
  /reference:"$wpf\UIAutomationClient.dll" `
  /reference:"$wpf\UIAutomationTypes.dll" `
  /reference:"$fx\System.Core.dll" `
  "$scriptDir\NagexDesktopIsolationProof.cs"
if ($LASTEXITCODE -ne 0) { throw "launcher compile failed" }

Write-Output "BUILD_OK"
