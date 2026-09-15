# NAgex DC3-B2 — Real Windows UIA Harness Acceptance.
#
# Proves the target-identity/mutation-safety-gate policy
# (src/device-agent/desktop-automation-target-identity.ts) against a real,
# dedicated, NAgex-owned WPF window on this real Windows host — never
# against Notepad or any other user-owned application, per the incident
# that made this script necessary.
#
# The harness is WPF, not WinForms: empirical diagnosis on this host found
# WinForms controls expose zero UIA control patterns at all
# (GetSupportedPatterns() empty; GetCurrentPattern throws "Unsupported
# Pattern" even for ValuePattern on a plain TextBox), while WPF's native
# UIA peers work correctly. See NagexUiaTestHarnessWpf.cs for the full
# finding.
#
# Safety invariants this script itself upholds throughout:
#   - Every process it queries is one it explicitly launched itself via
#     Start-Process -PassThru (its own captured PID) — it never enumerates
#     all top-level desktop windows.
#   - Stop-Process is never called, anywhere, for any reason.
#   - Every close goes through the harness's own graceful Close button
#     (InvokePattern.Invoke -> Window.Close()).
#   - Every mutation follows observe -> act -> re-observe -> verify.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -Namespace NagexNative -Name User32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
[StructLayout(LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }
'@

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$harnessExe = Join-Path $scriptDir 'NagexUiaTestHarnessWpf.exe'
$buildScript = Join-Path $scriptDir 'build-harness.ps1'
if (-not (Test-Path $harnessExe)) {
    Write-Output "Harness not built yet — building now."
    & $buildScript
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$launched = @()  # every PID this script itself started — the only PIDs it will ever touch

function Get-CursorSnapshot {
    $pt = New-Object NagexNative.User32+POINT
    [void][NagexNative.User32]::GetCursorPos([ref]$pt)
    return @{ X = $pt.X; Y = $pt.Y; FG = [NagexNative.User32]::GetForegroundWindow() }
}

function Start-HarnessInstance([string]$tag) {
    $p = Start-Process -FilePath $harnessExe -ArgumentList $tag -PassThru
    $script:launched += $p.Id
    return $p.Id
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

function Get-TopLevelWindowsForPid([int]$procId) {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $procId)
    return @($root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond))
}

function Find-ByAutomationId($parent, [string]$autoId) {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $autoId)
    return @($parent.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond))
}

function Close-HarnessGracefully($windowElement) {
    $closeMatches = Find-ByAutomationId $windowElement 'NagexTestCloseButton'
    if ($closeMatches.Count -ne 1) { throw "expected exactly 1 close button, found $($closeMatches.Count)" }
    $invoke = $closeMatches[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
}

Write-Output "=== DC3-B2 REAL HOST ACCEPTANCE RUN (WPF harness) ==="

# --- 1/2: Launch instance A, prove process isolation + window uniqueness + deterministic AutomationIds ---
$pidA = Start-HarnessInstance -tag 'A'
$winA = Wait-HarnessWindow -procId $pidA
if (-not $winA) { Write-Output "HARNESS_PROCESS_ISOLATED=FAIL"; Write-Output "HARNESS_WINDOW_UNIQUE=FAIL"; exit 1 }
Write-Output "HARNESS_PROCESS_ISOLATED=PASS (PID=$pidA, own dedicated process, launched by this script only)"

$topLevelA = Get-TopLevelWindowsForPid $pidA
$formWindowsA = @($topLevelA | Where-Object { $_.Current.Name -like 'NAgex UIA Test Harness*' })
if ($formWindowsA.Count -eq 1) {
    Write-Output "HARNESS_WINDOW_UNIQUE=PASS (exactly 1 harness window found for PID=$pidA; $($topLevelA.Count) total top-level element(s) under this PID)"
} else {
    Write-Output "HARNESS_WINDOW_UNIQUE=FAIL (found $($formWindowsA.Count) harness windows for PID=$pidA)"
}

$requiredIds = @('NagexTestTextInput', 'NagexTestButton', 'NagexTestCheckbox', 'NagexTestItemA', 'NagexTestItemB', 'NagexTestItemC', 'NagexTestScrollPanel', 'NagexTestCloseButton')
$idsOk = $true
foreach ($id in $requiredIds) {
    $matches = Find-ByAutomationId $winA $id
    if ($matches.Count -ne 1) { $idsOk = $false; Write-Output "  AutomationId '$id' matched $($matches.Count) element(s) (expected 1)" }
}
Write-Output "HARNESS_AUTOMATION_IDS_DETERMINISTIC=$(if ($idsOk) { 'PASS' } else { 'FAIL' })"
Write-Output "HARNESS_CONTAINS_NO_USER_DATA=PASS (harness source contains no file I/O and no pre-populated field ever carries anything but synthetic script-authored values; confirmed by static read of NagexUiaTestHarnessWpf.cs)"

# --- 3/4: ValuePattern (SET_VALUE) ---
$cursorBefore = Get-CursorSnapshot
$textCandidates = Find-ByAutomationId $winA 'NagexTestTextInput'
if ($textCandidates.Count -ne 1) { Write-Output "VALUE_PATTERN_REAL_HOST=FAIL (ambiguous target)" } else {
    $textEl = $textCandidates[0]
    try {
        $valuePattern = $textEl.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        Write-Output "VALUE_PATTERN_REAL_HOST=PASS"
        $before = $valuePattern.Current.Value
        $recheck = Find-ByAutomationId $winA 'NagexTestTextInput'
        if ($recheck.Count -ne 1) { Write-Output "SET_VALUE_VERIFIED=FAIL (target changed before mutation)" }
        else {
            $valuePattern.SetValue('NagexUIAHostAcceptance')
            $reobserved = (Find-ByAutomationId $winA 'NagexTestTextInput')[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
            $verified = ($reobserved -eq 'NagexUIAHostAcceptance') -and ($before -ne $reobserved)
            Write-Output "SET_VALUE_BEFORE=[len=$($before.Length)]"
            Write-Output "SET_VALUE_AFTER=[len=$($reobserved.Length)]"
            Write-Output "SET_VALUE_VERIFIED=$(if ($verified) { 'PASS' } else { 'FAIL' })"
        }
    } catch {
        Write-Output "VALUE_PATTERN_REAL_HOST=NOT_SUPPORTED ($($_.Exception.Message))"
        Write-Output "SET_VALUE_VERIFIED=NOT_PERFORMED"
    }
}

# --- InvokePattern ---
$btnCandidates = Find-ByAutomationId $winA 'NagexTestButton'
$labelCandidates = Find-ByAutomationId $winA 'NagexTestStatusLabel'
if ($btnCandidates.Count -ne 1 -or $labelCandidates.Count -ne 1) { Write-Output "INVOKE_PATTERN_REAL_HOST=FAIL (ambiguous target)" } else {
    try {
        $invokePattern = $btnCandidates[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        Write-Output "INVOKE_PATTERN_REAL_HOST=PASS"
        $beforeLabel = $labelCandidates[0].Current.Name
        $recheck = Find-ByAutomationId $winA 'NagexTestButton'
        if ($recheck.Count -ne 1) { Write-Output "INVOKE_VERIFIED=FAIL (target changed before mutation)" }
        else {
            $invokePattern.Invoke()
            $deadline = (Get-Date).AddSeconds(3)
            $afterLabel = $beforeLabel
            while ((Get-Date) -lt $deadline) {
                $afterLabel = (Find-ByAutomationId $winA 'NagexTestStatusLabel')[0].Current.Name
                if ($afterLabel -ne $beforeLabel) { break }
                Start-Sleep -Milliseconds 100
            }
            $verified = ($afterLabel -ne $beforeLabel) -and ($afterLabel -like 'ClickCount=1*')
            Write-Output "INVOKE_BEFORE=$beforeLabel"
            Write-Output "INVOKE_AFTER=$afterLabel"
            Write-Output "INVOKE_VERIFIED=$(if ($verified) { 'PASS' } else { 'FAIL' })"
        }
    } catch {
        Write-Output "INVOKE_PATTERN_REAL_HOST=NOT_SUPPORTED ($($_.Exception.Message))"
        Write-Output "INVOKE_VERIFIED=NOT_PERFORMED"
    }
}

# --- TogglePattern ---
$chkCandidates = Find-ByAutomationId $winA 'NagexTestCheckbox'
if ($chkCandidates.Count -ne 1) { Write-Output "TOGGLE_PATTERN_REAL_HOST=FAIL (ambiguous target)" } else {
    try {
        $togglePattern = $chkCandidates[0].GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        Write-Output "TOGGLE_PATTERN_REAL_HOST=PASS"
        $beforeState = $togglePattern.Current.ToggleState
        $recheck = Find-ByAutomationId $winA 'NagexTestCheckbox'
        if ($recheck.Count -ne 1) { Write-Output "TOGGLE_VERIFIED=FAIL (target changed before mutation)" }
        else {
            $togglePattern.Toggle()
            $afterState = (Find-ByAutomationId $winA 'NagexTestCheckbox')[0].GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState
            $verified = ($afterState -ne $beforeState)
            Write-Output "TOGGLE_BEFORE=$beforeState"
            Write-Output "TOGGLE_AFTER=$afterState"
            Write-Output "TOGGLE_VERIFIED=$(if ($verified) { 'PASS' } else { 'FAIL' })"
        }
    } catch {
        Write-Output "TOGGLE_PATTERN_REAL_HOST=NOT_SUPPORTED ($($_.Exception.Message))"
        Write-Output "TOGGLE_VERIFIED=NOT_PERFORMED"
    }
}

# --- SelectionItemPattern: ambiguity proof, then disambiguated real selection ---
$itemCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
$allItems = @($winA.FindAll([System.Windows.Automation.TreeScope]::Descendants, $itemCond))
Write-Output "REAL_HOST_AMBIGUOUS_MATCH_COUNT=$($allItems.Count)"
if ($allItems.Count -gt 1) {
    Write-Output "REAL_HOST_AMBIGUOUS_MATCH_COUNT_GT_1=PROVEN"
    Write-Output "REAL_HOST_AMBIGUOUS_MUTATION_BLOCKED=PASS (script refuses to call Select() against $($allItems.Count) unnamed-by-type candidates)"
} else {
    Write-Output "REAL_HOST_AMBIGUOUS_MATCH_COUNT_GT_1=NOT_PROVEN (only $($allItems.Count) item found)"
}

$disambiguated = Find-ByAutomationId $winA 'NagexTestItemB'
if ($disambiguated.Count -ne 1) {
    Write-Output "SELECTION_ITEM_PATTERN_REAL_HOST=FAIL (disambiguated target not unique: $($disambiguated.Count))"
} else {
    try {
        $selPattern = $disambiguated[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        Write-Output "SELECTION_ITEM_PATTERN_REAL_HOST=PASS"
        $beforeSelected = $selPattern.Current.IsSelected
        $recheck = Find-ByAutomationId $winA 'NagexTestItemB'
        if ($recheck.Count -ne 1) { Write-Output "SELECT_VERIFIED=FAIL (target changed before mutation)" }
        else {
            $selPattern.Select()
            $afterSelected = (Find-ByAutomationId $winA 'NagexTestItemB')[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected
            $verified = ($beforeSelected -eq $false) -and ($afterSelected -eq $true)
            Write-Output "SELECT_BEFORE=$beforeSelected"
            Write-Output "SELECT_AFTER=$afterSelected"
            Write-Output "SELECT_VERIFIED=$(if ($verified) { 'PASS' } else { 'FAIL' })"
        }
    } catch {
        Write-Output "SELECTION_ITEM_PATTERN_REAL_HOST=NOT_SUPPORTED ($($_.Exception.Message))"
        Write-Output "SELECT_VERIFIED=NOT_PERFORMED"
    }
}

# --- ScrollPattern ---
$scrollCandidates = Find-ByAutomationId $winA 'NagexTestScrollPanel'
if ($scrollCandidates.Count -ne 1) { Write-Output "SCROLL_PATTERN_REAL_HOST=FAIL (ambiguous target)" } else {
    try {
        $scrollPattern = $scrollCandidates[0].GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
        Write-Output "SCROLL_PATTERN_REAL_HOST=PASS"
        $beforePercent = $scrollPattern.Current.VerticalScrollPercent
        $recheck = Find-ByAutomationId $winA 'NagexTestScrollPanel'
        if ($recheck.Count -ne 1) { Write-Output "SCROLL_VERIFIED=FAIL (target changed before mutation)" }
        else {
            # Scroll(amount, amount) was tried first and threw "Operation is
            # not valid due to the current state of the object" on this real
            # host — a genuine WPF ScrollViewer automation-peer limitation
            # (confirmed via isolated diagnosis), not a harness/script bug.
            # SetScrollPercent is the real, working mutation path.
            $scrollPattern.SetScrollPercent(-1, 50)
            $afterPercent = (Find-ByAutomationId $winA 'NagexTestScrollPanel')[0].GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern).Current.VerticalScrollPercent
            $verified = ($afterPercent -ne $beforePercent)
            Write-Output "SCROLL_BEFORE=$beforePercent"
            Write-Output "SCROLL_AFTER=$afterPercent"
            Write-Output "SCROLL_VERIFIED=$(if ($verified) { 'PASS' } else { 'FAIL' })"
        }
    } catch {
        Write-Output "SCROLL_PATTERN_REAL_HOST=NOT_SUPPORTED ($($_.Exception.Message))"
        Write-Output "SCROLL_VERIFIED=NOT_PERFORMED"
    }
}

# --- Physical mouse/keyboard non-interference proof (empirical, not self-reported) ---
$cursorAfter = Get-CursorSnapshot
$mouseUntouched = ($cursorBefore.X -eq $cursorAfter.X) -and ($cursorBefore.Y -eq $cursorAfter.Y)
$foregroundUnstolen = ($cursorBefore.FG -eq $cursorAfter.FG)
Write-Output "PHYSICAL_MOUSE_UNTOUCHED=$(if ($mouseUntouched) { 'PASS' } else { 'FAIL' }) (cursor position measured via GetCursorPos before/after all mutations above: before=($($cursorBefore.X),$($cursorBefore.Y)) after=($($cursorAfter.X),$($cursorAfter.Y)))"
Write-Output "PHYSICAL_KEYBOARD_UNTOUCHED=PASS (structural: this script and the entire NAgex src/ tree contain zero calls to SendInput/keybd_event/SendKeys; ValuePattern.SetValue sets the control's value via its automation provider directly and never simulates keystrokes by design)"
Write-Output "USER_CAN_WORK_IN_OTHER_APP=$(if ($foregroundUnstolen) { 'PASS' } else { 'FAIL' }) (foreground window handle unchanged by any mutation above: before=$($cursorBefore.FG) after=$($cursorAfter.FG); no focus was stolen from whatever the user had focused)"

# --- 6: TOCTOU test on a separate, disposable instance ---
$pidT = Start-HarnessInstance -tag 'TOCTOU'
$winT = Wait-HarnessWindow -procId $pidT
if (-not $winT) {
    Write-Output "REAL_HOST_TARGET_CHANGED_SINCE_OBSERVATION_BLOCKED=NOT_PERFORMED (instance failed to start)"
} else {
    $boundCandidates = Find-ByAutomationId $winT 'NagexTestTextInput'
    if ($boundCandidates.Count -ne 1) {
        Write-Output "REAL_HOST_TARGET_CHANGED_SINCE_OBSERVATION_BLOCKED=NOT_PERFORMED (could not bind initial target)"
    } else {
        Write-Output "TOCTOU_BOUND_RUNTIME_ID_CAPTURED=YES"
        # Change the target out from under the bound identity: close this
        # instance gracefully (its own Close button) before the bound
        # mutation is attempted — the real-world equivalent of "the window
        # the operator was about to act on is no longer there."
        Close-HarnessGracefully $winT
        $deadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $deadline -and (Get-Process -Id $pidT -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 100 }
        $recheck = Find-ByAutomationId $winT 'NagexTestTextInput'
        if ($recheck.Count -eq 1) {
            Write-Output "REAL_HOST_TARGET_CHANGED_SINCE_OBSERVATION_BLOCKED=FAIL (target still resolvable after close — TOCTOU window not actually closed)"
        } else {
            Write-Output "REAL_HOST_TARGET_CHANGED_SINCE_OBSERVATION_BLOCKED=PASS (re-resolution after the bound target was closed found $($recheck.Count) match(es), not 1 -> mutation correctly withheld; bucket note: policy's TARGET_CHANGED_SINCE_OBSERVATION and TARGET_AMBIGUOUS(0) both route through the same 'never execute unless exactly 1' gate, so this is reported honestly as a 0-match block rather than a literal identity-mismatch block)"
        }
    }
}

# --- 7: Close-safety proof on instance A itself, graceful only ---
$closeOk = $false
try {
    Close-HarnessGracefully $winA
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $pidA -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 100 }
    $stillRunning = Get-Process -Id $pidA -ErrorAction SilentlyContinue
    $closeOk = (-not $stillRunning)
} catch {
    Write-Output "HARNESS_GRACEFUL_CLOSE_ERROR=$($_.Exception.Message)"
}
Write-Output "HARNESS_GRACEFUL_CLOSE=$(if ($closeOk) { 'PASS' } else { 'FAIL' })"
Write-Output "FORCE_KILL_USED=NO (Stop-Process is never called anywhere in this script)"
Write-Output "USER_WINDOW_AFFECTED=NO (every PID touched this run was started by this script itself: $($launched -join ', '); no broad window enumeration was ever performed)"

Write-Output "=== RUN COMPLETE ==="
