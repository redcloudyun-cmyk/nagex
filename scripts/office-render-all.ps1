# Renders every .docx / .pptx in a directory with the real Office application (scripts/office-render.ps1), one output folder per file: <Dir>\render\<file name without extension>\.
# Windows + Microsoft Office only; local certification, never part of a gate. Each file gets a time limit: a render that does not finish is reported, and left alone (it is not killed).
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [int]$TimeoutSeconds = 150
)
$ErrorActionPreference = 'Stop'
$Dir = (Resolve-Path -LiteralPath $Dir).Path
$script = Join-Path $PSScriptRoot 'office-render.ps1'
foreach ($file in Get-ChildItem -LiteralPath $Dir -File | Where-Object { $_.Extension -in '.docx', '.pptx' } | Sort-Object Name) {
  $out = Join-Path $Dir ("render\" + [IO.Path]::GetFileNameWithoutExtension($file.Name))
  $job = Start-Job -ScriptBlock { param($s, $f, $o) powershell -NoProfile -ExecutionPolicy Bypass -File $s -Path $f -OutDir $o } -ArgumentList $script, $file.FullName, $out
  if (Wait-Job $job -Timeout $TimeoutSeconds) { "{0}: {1}" -f $file.Name, ((Receive-Job $job) -join ' ') } else { "{0}: TIMEOUT after {1} s (the render is still running and was left alone)" -f $file.Name, $TimeoutSeconds }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
}
