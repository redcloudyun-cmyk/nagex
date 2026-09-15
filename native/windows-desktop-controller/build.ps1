# Builds the DC3-B2 production isolated-desktop execution binaries:
#   - DesktopWorker.exe            (runs inside the isolated desktop)
#   - NagexDesktopController.exe   (spawned by Node per execution session)
# Both are gitignored build artifacts — run this before starting the
# NAgex server on Windows with DC3-B2 desktop execution enabled.
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$wpf = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF'
$fx = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'

& $csc /nologo /target:exe /out:"$scriptDir\DesktopWorker.exe" `
  /reference:"$wpf\UIAutomationClient.dll" `
  /reference:"$wpf\UIAutomationTypes.dll" `
  /reference:"$fx\System.Core.dll" `
  /reference:"$fx\System.Web.Extensions.dll" `
  "$scriptDir\DesktopWorker.cs"
if ($LASTEXITCODE -ne 0) { throw "DesktopWorker compile failed" }

& $csc /nologo /target:exe /out:"$scriptDir\NagexDesktopController.exe" `
  /reference:"$fx\System.Core.dll" `
  /reference:"$fx\System.Web.Extensions.dll" `
  "$scriptDir\NagexDesktopController.cs"
if ($LASTEXITCODE -ne 0) { throw "NagexDesktopController compile failed" }

Write-Output "BUILD_OK"
