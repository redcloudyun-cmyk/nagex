param([int]$TargetPid)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if ($win) {
    $btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'NagexTestCloseButton')
    $btn = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    if ($btn) {
        $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Write-Output "CLOSED"
    } else {
        Write-Output "CLOSE_BUTTON_NOT_FOUND"
    }
} else {
    Write-Output "WINDOW_NOT_FOUND"
}
