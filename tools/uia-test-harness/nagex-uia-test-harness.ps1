# NAgex UIA Test Harness — DC3-B2 Preflight, Section 9.
#
# Built directly in response to the real Notepad multi-tab incident: Windows
# 11 Notepad is single-instance/tabbed, so "launch a new instance" did not
# reliably create an isolated process, and a PID-only-targeted mutation
# followed by Stop-Process -Force affected the operator's own pre-existing
# tabs. This harness exists so DC3-B2 mutation-pattern proofs
# (ValuePattern/InvokePattern/TogglePattern/SelectionItemPattern/
# ScrollPattern) never again need to touch a real, possibly-shared,
# possibly-user-owned application.
#
# Properties that make this safe to use for mutation testing, unlike
# Notepad:
#   - Every invocation of `powershell -File this-script` is a genuinely
#     separate OS process (no single-instance reuse behavior to guard
#     against).
#   - The window carries zero user data — every value is synthetic and
#     created fresh by this script.
#   - Every interactive control has a fixed, deterministic AutomationId,
#     so a caller can resolve a target by AutomationId + ProcessId and
#     legitimately expect MATCH_COUNT == 1 without needing the broader
#     target-identity machinery multi-tab/shared apps require.
#   - -InstanceTag lets a caller stamp the window title with a value it
#     chose itself, so it can positively confirm (by title, not just PID)
#     that it is observing the exact process/window it launched, without
#     ever needing to read/enumerate any other window.
#   - Close is graceful only: the Close button and the window's own [X]
#     both go through the normal WinForms close path (Form.Close()),
#     never a force-kill. There is deliberately no "kill" affordance here.
#
# This script performs no file I/O and stores no data outside its own
# process memory; closing it (gracefully or otherwise) leaves nothing
# behind.

param(
    [string]$InstanceTag = 'default'
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "NAgex UIA Test Harness [$InstanceTag]"
$form.Width = 420
$form.Height = 420
$form.StartPosition = 'CenterScreen'

# --- ValuePattern target -----------------------------------------------
$textInput = New-Object System.Windows.Forms.TextBox
$textInput.Name = 'NagexTestTextInput'
$textInput.AccessibleName = 'NagexTestTextInput'
$textInput.Location = New-Object System.Drawing.Point(10, 10)
$textInput.Width = 380
$form.Controls.Add($textInput)

# --- InvokePattern target ------------------------------------------------
$button = New-Object System.Windows.Forms.Button
$button.Name = 'NagexTestButton'
$button.AccessibleName = 'NagexTestButton'
$button.Text = 'NAgex Test Button'
$button.Location = New-Object System.Drawing.Point(10, 45)
$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Name = 'NagexTestStatusLabel'
$statusLabel.AccessibleName = 'NagexTestStatusLabel'
$statusLabel.Text = 'ClickCount=0'
$statusLabel.Location = New-Object System.Drawing.Point(120, 50)
$statusLabel.Width = 200
$script:clickCount = 0
$button.Add_Click({
    $script:clickCount += 1
    $statusLabel.Text = "ClickCount=$script:clickCount"
})
$form.Controls.Add($button)
$form.Controls.Add($statusLabel)

# --- TogglePattern target -------------------------------------------------
$checkbox = New-Object System.Windows.Forms.CheckBox
$checkbox.Name = 'NagexTestCheckbox'
$checkbox.AccessibleName = 'NagexTestCheckbox'
$checkbox.Text = 'NAgex Test Checkbox'
$checkbox.Location = New-Object System.Drawing.Point(10, 80)
$form.Controls.Add($checkbox)

# --- SelectionItemPattern target ------------------------------------------
$listBox = New-Object System.Windows.Forms.ListBox
$listBox.Name = 'NagexTestListBox'
$listBox.AccessibleName = 'NagexTestListBox'
$listBox.Location = New-Object System.Drawing.Point(10, 110)
$listBox.Width = 380
$listBox.Height = 90
[void]$listBox.Items.Add('NagexTestItemA')
[void]$listBox.Items.Add('NagexTestItemB')
[void]$listBox.Items.Add('NagexTestItemC')
$form.Controls.Add($listBox)

# --- ScrollPattern target --------------------------------------------------
$scrollPanel = New-Object System.Windows.Forms.Panel
$scrollPanel.Name = 'NagexTestScrollPanel'
$scrollPanel.AccessibleName = 'NagexTestScrollPanel'
$scrollPanel.Location = New-Object System.Drawing.Point(10, 210)
$scrollPanel.Width = 380
$scrollPanel.Height = 100
$scrollPanel.AutoScroll = $true
for ($i = 0; $i -lt 30; $i++) {
    $scrollItem = New-Object System.Windows.Forms.Label
    $scrollItem.Text = "NagexScrollRow$i"
    $scrollItem.Location = New-Object System.Drawing.Point(5, ($i * 22))
    $scrollItem.Width = 340
    $scrollPanel.Controls.Add($scrollItem)
}
$form.Controls.Add($scrollPanel)

# --- Graceful close only — no force-kill affordance in this harness ------
$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Name = 'NagexTestCloseButton'
$closeButton.AccessibleName = 'NagexTestCloseButton'
$closeButton.Text = 'Close'
$closeButton.Location = New-Object System.Drawing.Point(10, 320)
$closeButton.Add_Click({ $form.Close() })
$form.Controls.Add($closeButton)

[System.Windows.Forms.Application]::Run($form)
