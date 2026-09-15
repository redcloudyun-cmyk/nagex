(Get-Process -Name DesktopWorker,NagexDesktopController,NagexUiaTestHarnessWpf -ErrorAction SilentlyContinue | Measure-Object).Count
