// NAgex DC3-B2-R2 — Isolated Windows Desktop Execution Worker.
//
// Runs entirely inside a dedicated, isolated Win32 desktop object (never
// the user's interactive desktop). Its job is narrow and bounded: launch
// the dedicated NAgex UIA test harness (never a user-owned application)
// onto its own desktop, perform a small fixed vocabulary of UIA
// observe/mutate/verify operations against it, and report results back to
// the main-process stand-in (NagexDesktopIsolationProof.exe) over a
// local, token-authenticated named pipe.
//
// Why a worker process is needed at all (not just cross-desktop UIA calls
// from the main process): UI Automation's AutomationElement.RootElement
// enumerates windows on the CALLING THREAD's current desktop only. A
// thread's "current desktop" is fixed at process/thread creation (or via
// SetThreadDesktop); a process created with STARTUPINFO.lpDesktop set to
// an isolated desktop has its primary thread already on that desktop, so
// its own UIA calls naturally reach only that desktop's windows — which
// is exactly the isolation property being proven, not routed around.
//
// Protocol: newline-delimited, pipe-delimited plain text (not shell, not
// arbitrary commands) — a small closed action vocabulary. Every request
// must carry the shared token established at worker startup.
//   TOKEN|LAUNCH_HARNESS|
//   TOKEN|OBSERVE|<automationId>
//   TOKEN|MUTATE|<pattern>|<automationId>|<value-or-empty>
//   TOKEN|CANCEL|
//   TOKEN|CLOSE_HARNESS|
//   TOKEN|SHUTDOWN|
// Responses: OK|<data...> or ERR|<message>, plus unsolicited
// STATUS|<phase>|<detail> lines for Activity-stream proof (STARTED,
// ACTION, VERIFYING, SUCCEEDED, FAILED, CANCELLED).
using System;
using System.IO;
using System.IO.Pipes;
using System.Windows.Automation;

namespace NagexExecutionWorker
{
    internal static class Program
    {
        private static string _desktopName;
        private static string _harnessExePath;
        private static string _token;
        private static System.Diagnostics.Process _harnessProcess;
        private static AutomationElement _harnessWindow;
        private static bool _cancelRequested;

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length < 3)
            {
                Console.Error.WriteLine("usage: NagexExecutionWorker.exe <pipeName> <token> <desktopName>");
                return 1;
            }
            string pipeName = args[0];
            _token = args[1];
            _desktopName = args[2];
            _harnessExePath = Path.Combine(Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location), "NagexUiaTestHarnessWpf.exe");

            using (var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Message, PipeOptions.None))
            {
                server.WaitForConnection();
                using (var reader = new StreamReader(server))
                using (var writer = new StreamWriter(server) { AutoFlush = true })
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        bool shouldExit;
                        string response = HandleRequest(line, writer, out shouldExit);
                        writer.WriteLine(response);
                        if (shouldExit) break;
                    }
                }
            }

            // Best-effort graceful cleanup if the harness is still open
            // (e.g. caller disconnected without sending CLOSE_HARNESS —
            // the crash-scenario path). Never a force-kill of anything
            // outside this worker's own owned child.
            TryCloseHarnessGracefully();
            return 0;
        }

        private static string HandleRequest(string line, StreamWriter writer, out bool shouldExit)
        {
            shouldExit = false;
            string[] parts = line.Split('|');
            if (parts.Length < 2 || parts[0] != _token)
            {
                return "ERR|unauthorized";
            }
            string action = parts[1];
            try
            {
                switch (action)
                {
                    case "LAUNCH_HARNESS":
                        return LaunchHarness();
                    case "OBSERVE":
                        return Observe(parts.Length > 2 ? parts[2] : "");
                    case "MUTATE":
                        return Mutate(writer, parts);
                    case "CANCEL":
                        _cancelRequested = true;
                        writer.WriteLine("STATUS|CANCELLED|cancel flag set, no further mutation will execute");
                        return "OK|cancel-armed";
                    case "CLOSE_HARNESS":
                        return CloseHarness();
                    case "SHUTDOWN":
                        shouldExit = true;
                        return "OK|shutting-down";
                    default:
                        return "ERR|unknown-action";
                }
            }
            catch (Exception ex)
            {
                return "ERR|" + ex.GetType().Name + ":" + ex.Message.Replace("\r", " ").Replace("\n", " ");
            }
        }

        private static string LaunchHarness()
        {
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = _harnessExePath,
                Arguments = "WorkerLaunched",
                UseShellExecute = false,
            };
            _harnessProcess = System.Diagnostics.Process.Start(psi);

            var root = AutomationElement.RootElement;
            var deadline = DateTime.UtcNow.AddSeconds(10);
            while (DateTime.UtcNow < deadline)
            {
                var cond = new PropertyCondition(AutomationElement.ProcessIdProperty, _harnessProcess.Id);
                foreach (AutomationElement candidate in root.FindAll(TreeScope.Children, cond))
                {
                    if (candidate.Current.Name.StartsWith("NAgex UIA Test Harness"))
                    {
                        _harnessWindow = candidate;
                        return "OK|pid=" + _harnessProcess.Id;
                    }
                }
                System.Threading.Thread.Sleep(100);
            }
            return "ERR|harness-window-not-found-within-timeout";
        }

        private static AutomationElement FindOne(string automationId)
        {
            if (_harnessWindow == null) throw new InvalidOperationException("harness not launched");
            var cond = new PropertyCondition(AutomationElement.AutomationIdProperty, automationId);
            var matches = _harnessWindow.FindAll(TreeScope.Descendants, cond);
            if (matches.Count != 1) throw new InvalidOperationException("TARGET_AMBIGUOUS:" + matches.Count);
            return matches[0];
        }

        private static string Observe(string automationId)
        {
            var el = FindOne(automationId);
            return "OK|name=" + el.Current.Name;
        }

        private static string Mutate(StreamWriter writer, string[] parts)
        {
            if (_cancelRequested)
            {
                writer.WriteLine("STATUS|CANCELLED|skipped, cancel was requested");
                return "OK|cancelled-skip";
            }
            string pattern = parts[2];
            string automationId = parts[3];
            string value = parts.Length > 4 ? parts[4] : null;

            writer.WriteLine("STATUS|STARTED|" + pattern);
            var target = FindOne(automationId);
            writer.WriteLine("STATUS|ACTION|" + pattern);

            string before, after;
            bool verified;

            switch (pattern)
            {
                case "VALUE":
                    {
                        var vp = (ValuePattern)target.GetCurrentPattern(ValuePattern.Pattern);
                        before = vp.Current.Value;
                        // TOCTOU re-resolve immediately before mutating.
                        var recheck = FindOne(automationId);
                        vp = (ValuePattern)recheck.GetCurrentPattern(ValuePattern.Pattern);
                        vp.SetValue(value);
                        writer.WriteLine("STATUS|VERIFYING|" + pattern);
                        after = ((ValuePattern)FindOne(automationId).GetCurrentPattern(ValuePattern.Pattern)).Current.Value;
                        verified = after == value && after != before;
                        break;
                    }
                case "INVOKE":
                    {
                        var labelBefore = FindOne("NagexTestStatusLabel").Current.Name;
                        before = labelBefore;
                        var recheck = FindOne(automationId);
                        ((InvokePattern)recheck.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
                        System.Threading.Thread.Sleep(200);
                        writer.WriteLine("STATUS|VERIFYING|" + pattern);
                        after = FindOne("NagexTestStatusLabel").Current.Name;
                        verified = after != before && after == "ClickCount=1";
                        break;
                    }
                case "TOGGLE":
                    {
                        var tp = (TogglePattern)target.GetCurrentPattern(TogglePattern.Pattern);
                        before = tp.Current.ToggleState.ToString();
                        var recheck = FindOne(automationId);
                        ((TogglePattern)recheck.GetCurrentPattern(TogglePattern.Pattern)).Toggle();
                        writer.WriteLine("STATUS|VERIFYING|" + pattern);
                        after = ((TogglePattern)FindOne(automationId).GetCurrentPattern(TogglePattern.Pattern)).Current.ToggleState.ToString();
                        verified = after != before;
                        break;
                    }
                case "SELECT":
                    {
                        var sp = (SelectionItemPattern)target.GetCurrentPattern(SelectionItemPattern.Pattern);
                        before = sp.Current.IsSelected.ToString();
                        var recheck = FindOne(automationId);
                        ((SelectionItemPattern)recheck.GetCurrentPattern(SelectionItemPattern.Pattern)).Select();
                        writer.WriteLine("STATUS|VERIFYING|" + pattern);
                        after = ((SelectionItemPattern)FindOne(automationId).GetCurrentPattern(SelectionItemPattern.Pattern)).Current.IsSelected.ToString();
                        verified = before == "False" && after == "True";
                        break;
                    }
                case "SCROLL":
                    {
                        var scp = (ScrollPattern)target.GetCurrentPattern(ScrollPattern.Pattern);
                        before = scp.Current.VerticalScrollPercent.ToString();
                        var recheck = FindOne(automationId);
                        ((ScrollPattern)recheck.GetCurrentPattern(ScrollPattern.Pattern)).SetScrollPercent(-1, 50);
                        writer.WriteLine("STATUS|VERIFYING|" + pattern);
                        after = ((ScrollPattern)FindOne(automationId).GetCurrentPattern(ScrollPattern.Pattern)).Current.VerticalScrollPercent.ToString();
                        verified = after != before;
                        break;
                    }
                default:
                    writer.WriteLine("STATUS|FAILED|unknown-pattern");
                    return "ERR|unknown-pattern";
            }

            writer.WriteLine("STATUS|" + (verified ? "SUCCEEDED" : "FAILED") + "|" + pattern);
            return "OK|before=" + before + ";after=" + after + ";verified=" + verified;
        }

        private static string CloseHarness()
        {
            string result = TryCloseHarnessGracefully();
            return result ?? "OK|closed";
        }

        // Returns null on success (or nothing to close), or an ERR string.
        // Never uses Process.Kill/TerminateProcess — only the harness's
        // own graceful InvokePattern close path.
        private static string TryCloseHarnessGracefully()
        {
            if (_harnessWindow == null || _harnessProcess == null || _harnessProcess.HasExited) return null;
            try
            {
                var closeBtn = FindOne("NagexTestCloseButton");
                ((InvokePattern)closeBtn.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
                _harnessProcess.WaitForExit(5000);
                return null;
            }
            catch (Exception ex)
            {
                return "ERR|close-failed:" + ex.Message;
            }
        }
    }
}
