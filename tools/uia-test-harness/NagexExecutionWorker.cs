// NAgex DC3-B2-R2/R3 — Isolated Windows Desktop Execution Worker.
//
// Runs entirely inside a dedicated, isolated Win32 desktop object (never
// the user's interactive desktop). Its job is narrow and bounded: launch
// the dedicated NAgex UIA test harness (never a user-owned application)
// onto its own desktop, perform a small fixed vocabulary of UIA
// observe/mutate/verify operations against it, and report results back to
// the main-process stand-in (NagexDesktopIsolationProof.exe) over a
// local, token-authenticated, replay-protected, size-bounded named pipe.
//
// Why a worker process is needed at all (not just cross-desktop UIA calls
// from the main process): UI Automation's AutomationElement.RootElement
// enumerates windows on the CALLING THREAD's current desktop only. A
// process created with STARTUPINFO.lpDesktop set to an isolated desktop
// has its primary thread already on that desktop, so its own UIA calls
// naturally reach only that desktop's windows.
//
// R3 hardening added: the launched harness is assigned to a Windows Job
// Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE — if this worker process
// dies for any reason (crash, terminated), its job handle closes as part
// of normal process teardown, and Windows itself terminates every process
// in the job automatically. This replaces R2's manual "reap the orphan by
// tracked PID" cleanup with the canonical OS mechanism for exactly this
// case: deterministic ownership, no orphan window ever needs discovering.
//
// Protocol (fixed, closed vocabulary — never arbitrary shell/commands):
//   TOKEN|NONCE|LAUNCH_HARNESS|
//   TOKEN|NONCE|OBSERVE|<automationId>
//   TOKEN|NONCE|MUTATE|<pattern>|<automationId>|<value-or-empty>
//   TOKEN|NONCE|CANCEL|
//   TOKEN|NONCE|CLOSE_HARNESS|
//   TOKEN|NONCE|SHUTDOWN|
// Every nonce may be used exactly once (replay protection); every line is
// size-bounded. Responses: OK|<data...> or ERR|<message>, plus
// unsolicited STATUS|<phase>|<detail> lines (STARTED, ACTION, VERIFYING,
// SUCCEEDED, FAILED, CANCELLED).
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Windows.Automation;

namespace NagexExecutionWorker
{
    internal static class JobObjectNative
    {
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr hJob, int jobObjectInfoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, int cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        public const int JobObjectExtendedLimitInformation = 9;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
    }

    internal static class Program
    {
        private const int MaxLineLength = 4096; // bounded message size

        private static string _harnessExePath;
        private static string _token;
        private static System.Diagnostics.Process _harnessProcess;
        private static AutomationElement _harnessWindow;
        private static bool _cancelRequested;
        private static IntPtr _jobHandle = IntPtr.Zero;
        private static readonly HashSet<string> _seenNonces = new HashSet<string>();

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
            _harnessExePath = Path.Combine(Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location), "NagexUiaTestHarnessWpf.exe");

            // R3 — Job Object for deterministic child-process ownership.
            // KILL_ON_JOB_CLOSE means: if this worker process's handle to
            // the job closes for ANY reason (including this process
            // crashing), Windows itself terminates every process still in
            // the job. No orphan can outlive its owning worker.
            _jobHandle = JobObjectNative.CreateJobObject(IntPtr.Zero, null);
            if (_jobHandle != IntPtr.Zero)
            {
                var info = new JobObjectNative.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = JobObjectNative.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                JobObjectNative.SetInformationJobObject(_jobHandle, JobObjectNative.JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(JobObjectNative.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            }

            // R3 — pipe ACL restricted to the current identity only (no
            // Everyone/Network access), a production-shaped hardening step
            // even though this proof still runs as a single local user.
            var pipeSecurity = new PipeSecurity();
            var currentIdentity = WindowsIdentity.GetCurrent().User;
            pipeSecurity.AddAccessRule(new PipeAccessRule(currentIdentity, PipeAccessRights.ReadWrite, AccessControlType.Allow));

            using (var server = NamedPipeServerStreamAcl.Create(pipeName, pipeSecurity))
            {
                server.WaitForConnection();
                using (var reader = new StreamReader(server))
                using (var writer = new StreamWriter(server) { AutoFlush = true })
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        if (line.Length > MaxLineLength)
                        {
                            writer.WriteLine("ERR|message-too-large");
                            continue;
                        }
                        bool shouldExit;
                        string response = HandleRequest(line, writer, out shouldExit);
                        writer.WriteLine(response);
                        if (shouldExit) break;
                    }
                }
            }

            if (_jobHandle != IntPtr.Zero) JobObjectNative.CloseHandle(_jobHandle);
            return 0;
        }

        private static string HandleRequest(string line, StreamWriter writer, out bool shouldExit)
        {
            shouldExit = false;
            string[] parts = line.Split('|');
            if (parts.Length < 3 || parts[0] != _token)
            {
                return "ERR|unauthorized";
            }
            string nonce = parts[1];
            if (!_seenNonces.Add(nonce))
            {
                return "ERR|replay-rejected";
            }
            string action = parts[2];
            try
            {
                switch (action)
                {
                    case "LAUNCH_HARNESS":
                        return LaunchHarness();
                    case "OBSERVE":
                        return Observe(parts.Length > 3 ? parts[3] : "");
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

            if (_jobHandle != IntPtr.Zero)
            {
                JobObjectNative.AssignProcessToJobObject(_jobHandle, _harnessProcess.Handle);
            }

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
            string pattern = parts[3];
            string automationId = parts[4];
            string value = parts.Length > 5 ? parts[5] : null;

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
                        verified = after != before;
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
                        verified = before != after;
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

    // NamedPipeServerStream's ACL-aware constructor differs across .NET
    // Framework versions' overload sets; this indirection keeps Main()
    // readable and isolates the ACL wiring in one place.
    internal static class NamedPipeServerStreamAcl
    {
        public static NamedPipeServerStream Create(string pipeName, PipeSecurity security)
        {
            return new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Message, PipeOptions.None, 0, 0, security);
        }
    }
}
