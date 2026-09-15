# Used by run-dc3b2-production-acceptance.js. Kept as a dedicated .ps1
# file, not an inline -Command string, to avoid Windows argument-quoting
# fragility discovered when passing nested-quoted Add-Type snippets
# through child_process's Windows argv escaping.
Add-Type -Namespace NagexAcceptance -Name Win32 -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'
[NagexAcceptance.Win32]::GetForegroundWindow().ToInt64()
