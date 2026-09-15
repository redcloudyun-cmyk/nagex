# NAgex DC3-B2-R1 — Foreground Preservation Investigation.
#
# Investigates whether Windows UI Automation can mutate a NAgex-owned
# target window while leaving the user's actual foreground/focused
# application completely untouched. Prior real-host acceptance found:
# mouse position is never touched and no SendInput/keybd_event/SendKeys is
# ever used, but the OS foreground window changes to the harness the
# moment the first UIA mutation (ValuePattern.SetValue) runs.
#
# Each of the 5 patterns is tested in total isolation — a fresh UserApp +
# fresh Target pair per pattern per mode — because once foreground is
# stolen by one mutation it stays stolen for everything that runs after
# it in the same pair; testing all 5 patterns sequentially against one
# Target (an earlier version of this script did that) corrupts every
# reading after the first theft and cannot tell which pattern(s) are
# actually responsible. This costs more process launches but is the only
# way to get a scientifically clean per-pattern answer, which the
# directive explicitly requires ("Do not assume all patterns behave the
# same").
#
# This script never uses SendInput. It uses only: UIA pattern calls, the
# UIA HasKeyboardFocus property, and real Win32
# GetForegroundWindow/GetGUIThreadInfo measurements — all read-only
# observation of OS state, never input injection.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -Namespace NagexNative -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);

[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

[StructLayout(LayoutKind.Sequential)]
public struct GUITHREADINFO {
    public int cbSize;
    public uint flags;
    public IntPtr hwndActive;
    public IntPtr hwndFocus;
    public IntPtr hwndCapture;
    public IntPtr hwndMenuOwner;
    public IntPtr hwndMoveSize;
    public IntPtr hwndCaret;
    public RECT rcCaret;
}
'@

function Get-GuiThreadInfoFor([IntPtr]$hwnd) {
    $procId = 0
    $threadId = [NagexNative.Win32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
    $info = New-Object NagexNative.Win32+GUITHREADINFO
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][NagexNative.Win32+GUITHREADINFO])
    [void][NagexNative.Win32]::GetGUIThreadInfo($threadId, [ref]$info)
    return $info
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$harnessExe = Join-Path $scriptDir 'NagexUiaTestHarnessWpf.exe'
$root = [System.Windows.Automation.AutomationElement]::RootElement
$launched = @()

function Start-Harness([string]$tag, [switch]$NoActivate) {
    $argList = if ($NoActivate) { @($tag, '-noactivate') } else { @($tag) }
    $p = Start-Process -FilePath $harnessExe -ArgumentList $argList -PassThru
    $script:launched += $p.Id
    return $p
}

function Wait-HarnessWindow([int]$procId, [int]$timeoutSeconds = 10) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $procId)
        $candidates = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
        foreach ($c in $candidates) {
            if ($c.Current.Name -like 'NAgex UIA Test Harness*') { return $c }
        }
        Start-Sleep -Milliseconds 150
    }
    return $null
}

function Find-ByAutomationId($parent, [string]$autoId) {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $autoId)
    return @($parent.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond))
}

function Close-HarnessGracefully($windowElement) {
    $closeMatches = Find-ByAutomationId $windowElement 'NagexTestCloseButton'
    if ($closeMatches.Count -ne 1) { throw "expected exactly 1 close button, found $($closeMatches.Count)" }
    $closeMatches[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}

function Snapshot([string]$label, [IntPtr]$userAppHwnd, $userAppTextInput) {
    $fg = [NagexNative.Win32]::GetForegroundWindow()
    $gti = Get-GuiThreadInfoFor $userAppHwnd
    $userAppHasFocus = $false
    try { $userAppHasFocus = $userAppTextInput.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty) } catch {}
    [pscustomobject]@{
        Label               = $label
        ForegroundIsUserApp = ($fg -eq $userAppHwnd)
        GuiFocusIsUserApp   = ($gti.hwndFocus -eq $userAppHwnd -or $gti.hwndActive -eq $userAppHwnd)
        UserAppUiaHasFocus  = $userAppHasFocus
    }
}

function Print-Snapshot($snap) {
    Write-Host "  [$($snap.Label)] ForegroundIsUserApp=$($snap.ForegroundIsUserApp) GuiFocusIsUserApp=$($snap.GuiFocusIsUserApp) UserAppUiaHasKeyboardFocus=$($snap.UserAppUiaHasFocus)"
}

# Runs ONE pattern against a freshly-launched, isolated UserApp+Target
# pair. Returns a clean structured result — no diagnostic text leaks into
# the return value (all narration goes through Write-Host, never
# Write-Output, inside this function and everything it calls).
function Test-OnePatternIsolated {
    param(
        [string]$PatternName,
        [bool]$NoActivate,
        [scriptblock]$Act,
        [scriptblock]$Verify,
        [scriptblock]$VerifyMutationGenuine
    )
    Write-Host ""
    Write-Host "--- $PatternName (NoActivate=$NoActivate) ---"

    $userProc = Start-Harness -tag 'UserApp'
    $userWin = Wait-HarnessWindow -procId $userProc.Id
    if (-not $userWin) { throw "UserApp failed to start" }
    $userAppHwnd = [IntPtr]$userWin.Current.NativeWindowHandle
    $userAppTextInput = (Find-ByAutomationId $userWin 'NagexTestTextInput')[0]
    $setupSnap = $null
    # Windows throttles programmatic SetForegroundWindow calls issued in
    # rapid succession (an anti-focus-stealing OS protection, not a bug
    # here) — retry a few times rather than treating one transient denial
    # as a real finding.
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        [void][NagexNative.Win32]::SetForegroundWindow($userAppHwnd)
        Start-Sleep -Milliseconds 300
        $userAppTextInput.SetFocus()
        Start-Sleep -Milliseconds 300
        $setupSnap = Snapshot 'setup' $userAppHwnd $userAppTextInput
        if ($setupSnap.ForegroundIsUserApp) { break }
        Start-Sleep -Milliseconds 400
    }
    if (-not $setupSnap.ForegroundIsUserApp) {
        Close-HarnessGracefully $userWin
        Write-Host "SETUP_FAILED — could not establish UserApp as real foreground after retries, skipping"
        return [pscustomobject]@{ Pattern = $PatternName; NoActivate = $NoActivate; Preserved = $null; MutationGenuine = $null; Note = 'SETUP_FAILED' }
    }

    $targetProc = Start-Harness -tag 'Target' -NoActivate:$NoActivate
    $targetWin = Wait-HarnessWindow -procId $targetProc.Id
    if (-not $targetWin) { throw "Target failed to start" }

    $before = Snapshot 'before' $userAppHwnd $userAppTextInput
    Print-Snapshot $before

    & $Act -TargetWin $targetWin

    $immediatelyAfter = Snapshot 'immediatelyAfter' $userAppHwnd $userAppTextInput
    Print-Snapshot $immediatelyAfter

    & $Verify -TargetWin $targetWin

    $afterVerification = Snapshot 'afterVerification' $userAppHwnd $userAppTextInput
    Print-Snapshot $afterVerification

    $mutationGenuine = & $VerifyMutationGenuine -TargetWin $targetWin

    $preserved = $before.ForegroundIsUserApp -and $immediatelyAfter.ForegroundIsUserApp -and $afterVerification.ForegroundIsUserApp -and
                 $before.GuiFocusIsUserApp -and $immediatelyAfter.GuiFocusIsUserApp -and $afterVerification.GuiFocusIsUserApp
    Write-Host "${PatternName}_FOREGROUND_BEHAVIOR=$(if ($preserved) { 'FOREGROUND_PRESERVED' } else { 'FOREGROUND_STOLEN' }) MutationGenuine=$mutationGenuine"

    Close-HarnessGracefully $targetWin
    Start-Sleep -Milliseconds 400
    Close-HarnessGracefully $userWin
    Start-Sleep -Milliseconds 400

    return [pscustomobject]@{ Pattern = $PatternName; NoActivate = $NoActivate; Preserved = $preserved; MutationGenuine = $mutationGenuine; Note = $null }
}

Write-Output "=== DC3-B2-R1 FOREGROUND PRESERVATION INVESTIGATION (per-pattern isolated) ==="

$patternDefs = @(
    @{
        Name = 'VALUE_PATTERN'
        Act = { param($TargetWin) $tb = (Find-ByAutomationId $TargetWin 'NagexTestTextInput')[0]; $tb.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('NagexForegroundTest') }
        Verify = { param($TargetWin) $null = (Find-ByAutomationId $TargetWin 'NagexTestTextInput')[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value }
        VerifyGenuine = { param($TargetWin) ((Find-ByAutomationId $TargetWin 'NagexTestTextInput')[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value) -eq 'NagexForegroundTest' }
    },
    @{
        Name = 'INVOKE_PATTERN'
        Act = { param($TargetWin) $btn = (Find-ByAutomationId $TargetWin 'NagexTestButton')[0]; $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Start-Sleep -Milliseconds 200 }
        Verify = { param($TargetWin) $null = (Find-ByAutomationId $TargetWin 'NagexTestStatusLabel')[0].Current.Name }
        VerifyGenuine = { param($TargetWin) ((Find-ByAutomationId $TargetWin 'NagexTestStatusLabel')[0].Current.Name) -eq 'ClickCount=1' }
    },
    @{
        Name = 'TOGGLE_PATTERN'
        Act = { param($TargetWin) $chk = (Find-ByAutomationId $TargetWin 'NagexTestCheckbox')[0]; $chk.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle() }
        Verify = { param($TargetWin) $null = (Find-ByAutomationId $TargetWin 'NagexTestCheckbox')[0].GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState }
        VerifyGenuine = { param($TargetWin) ((Find-ByAutomationId $TargetWin 'NagexTestCheckbox')[0].GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState) -eq 'On' }
    },
    @{
        Name = 'SELECT_PATTERN'
        Act = { param($TargetWin) $item = (Find-ByAutomationId $TargetWin 'NagexTestItemB')[0]; $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() }
        Verify = { param($TargetWin) $null = (Find-ByAutomationId $TargetWin 'NagexTestItemB')[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected }
        VerifyGenuine = { param($TargetWin) ((Find-ByAutomationId $TargetWin 'NagexTestItemB')[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) -eq $true }
    },
    @{
        Name = 'SCROLL_PATTERN'
        Act = { param($TargetWin) $scroll = (Find-ByAutomationId $TargetWin 'NagexTestScrollPanel')[0]; $scroll.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern).SetScrollPercent(-1, 50) }
        Verify = { param($TargetWin) $null = (Find-ByAutomationId $TargetWin 'NagexTestScrollPanel')[0].GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern).Current.VerticalScrollPercent }
        VerifyGenuine = { param($TargetWin) ((Find-ByAutomationId $TargetWin 'NagexTestScrollPanel')[0].GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern).Current.VerticalScrollPercent) -eq 50 }
    }
)

$allResults = @()
foreach ($mode in @($false, $true)) {
    foreach ($def in $patternDefs) {
        $result = Test-OnePatternIsolated -PatternName $def.Name -NoActivate $mode -Act $def.Act -Verify $def.Verify -VerifyMutationGenuine $def.VerifyGenuine
        $allResults += $result
    }
}

Write-Host ""
Write-Output "======== SUMMARY (per-pattern, isolated) ========"
foreach ($def in $patternDefs) {
    $normal = $allResults | Where-Object { $_.Pattern -eq $def.Name -and $_.NoActivate -eq $false }
    $noact = $allResults | Where-Object { $_.Pattern -eq $def.Name -and $_.NoActivate -eq $true }
    $classification = if (-not $noact.MutationGenuine) { 'BACKGROUND_UNSUPPORTED' } elseif ($noact.Preserved) { 'BACKGROUND_SAFE' } else { 'BACKGROUND_FOCUS_STEALING' }
    Write-Output "$($def.Name): normal_preserved=$($normal.Preserved) noactivate_preserved=$($noact.Preserved) noactivate_mutation_genuine=$($noact.MutationGenuine) classification=$classification"
}

Write-Output "USER_WINDOW_AFFECTED=NO (every PID touched this run was started by this script itself: $($launched -join ', '); no broad window enumeration was ever performed)"
Write-Output "FORCE_KILL_USED=NO"
Write-Output "SENDINPUT_USED=NO"
Write-Output "=== RUN COMPLETE ==="
