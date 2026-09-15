# Builds the dedicated NAgex UIA test harness (NagexUiaTestHarnessWpf.exe)
# from source. The compiled .exe is a build artifact and is not committed
# to source control — run this once before using the harness or before
# running run-real-host-acceptance.ps1.
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$wpf = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF'
$src = Join-Path $scriptDir 'NagexUiaTestHarnessWpf.cs'
$out = Join-Path $scriptDir 'NagexUiaTestHarnessWpf.exe'

& $csc /nologo /target:winexe /out:"$out" `
  /reference:"$wpf\PresentationFramework.dll" `
  /reference:"$wpf\PresentationCore.dll" `
  /reference:"$wpf\WindowsBase.dll" `
  /reference:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Xaml.dll" `
  /reference:"$wpf\UIAutomationTypes.dll" `
  "$src"

if ($LASTEXITCODE -ne 0) { throw "harness compile failed" }
Write-Output "BUILD_OK: $out"
