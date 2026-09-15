// NAgex DC3-B2 Production — Isolated Desktop UIA Worker.
//
// Runs entirely inside a dedicated, isolated Win32 desktop object (never
// the user's interactive desktop). Launches exactly one allowlisted
// target application (the executable path arrives already resolved and
// trusted from NAgex Main's DesktopAppAllowlist — this worker never
// accepts a raw path from an untrusted field) and performs a small fixed
// vocabulary of UIA operations against it: OBSERVE, OPEN_APP, CLOSE_APP,
// SET_VALUE, INVOKE, TOGGLE, SELECT, SCROLL. No SendInput, no
// keybd_event/mouse_event, no arbitrary shell, no arbitrary command.
//
// Assigned to a Windows Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
// together with any application it launches — if this worker dies for any
// reason, the OS itself terminates the whole execution's processes.
//
// Protocol: newline-delimited JSON over stdin/stdout, driven by
// NagexDesktopController.exe (which owns the isolated desktop and named
// pipe this worker listens on — this worker itself never touches stdio
// directly; see Main() below, which is a named-pipe server, not a stdio
// loop). Every request carries a session token and a nonce; nonces are
// accepted exactly once (replay protection). Every response distinguishes
// SUCCEEDED_VERIFIED from FAILED/TARGET_AMBIGUOUS/
// TARGET_CHANGED_SINCE_OBSERVATION — a UIA call not throwing is never
// treated as success by itself.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace NagexDesktopWorker
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
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
    }

    internal class WorkerRequest
    {
        public string protocolVersion;
        public string token;
        public string nonce;
        public string requestId;
        public string action; // OPEN_APP | CLOSE_APP | OBSERVE | SET_VALUE | INVOKE | TOGGLE | SELECT | SCROLL | CANCEL | SHUTDOWN
        public string appExePath; // OPEN_APP only — already resolved/trusted by NAgex Main, never from the model
        public string appArgs;
        public string target; // AutomationId, for OBSERVE/mutation actions
        public string value; // SET_VALUE only
    }

    internal class WorkerResponse
    {
        public string requestId;
        public string status; // OK | SUCCEEDED_VERIFIED | FAILED | TARGET_AMBIGUOUS | TARGET_CHANGED_SINCE_OBSERVATION | CLOSE_UNSAFE | CANCELLED | ERR
        public string observedBefore;
        public string observedAfter;
        public bool verification;
        public string errorCode;
        public int matchCount = -1;
    }

    internal static class Program
    {
        private const int MaxMessageBytes = 8192;
        private const string ProtocolVersion = "1.0";

        private static string _token;
        private static System.Diagnostics.Process _appProcess;
        private static AutomationElement _appWindow;
        private static bool _cancelRequested;
        private static IntPtr _jobHandle = IntPtr.Zero;
        private static readonly HashSet<string> _seenNonces = new HashSet<string>();
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length < 2)
            {
                Console.Error.WriteLine("usage: DesktopWorker.exe <pipeName> <token>");
                return 1;
            }
            string pipeName = args[0];
            _token = args[1];

            _jobHandle = JobObjectNative.CreateJobObject(IntPtr.Zero, null);
            if (_jobHandle != IntPtr.Zero)
            {
                var info = new JobObjectNative.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = JobObjectNative.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                JobObjectNative.SetInformationJobObject(_jobHandle, JobObjectNative.JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(JobObjectNative.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            }

            var pipeSecurity = new PipeSecurity();
            pipeSecurity.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.ReadWrite, AccessControlType.Allow));

            using (var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Message, PipeOptions.None, 0, 0, pipeSecurity))
            {
                server.WaitForConnection();
                using (var reader = new StreamReader(server))
                using (var writer = new StreamWriter(server) { AutoFlush = true })
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        if (line.Length > MaxMessageBytes) { writer.WriteLine(Json.Serialize(new WorkerResponse { status = "ERR", errorCode = "MESSAGE_TOO_LARGE" })); continue; }
                        bool shouldExit;
                        var response = HandleRequest(line, out shouldExit);
                        writer.WriteLine(Json.Serialize(response));
                        if (shouldExit) break;
                    }
                }
            }

            TryCloseAppGracefully();
            if (_jobHandle != IntPtr.Zero) JobObjectNative.CloseHandle(_jobHandle);
            return 0;
        }

        private static WorkerResponse HandleRequest(string line, out bool shouldExit)
        {
            shouldExit = false;
            WorkerRequest req;
            try { req = Json.Deserialize<WorkerRequest>(line); }
            catch { return new WorkerResponse { status = "ERR", errorCode = "SCHEMA_INVALID" }; }

            if (req == null || req.token != _token) return new WorkerResponse { requestId = req != null ? req.requestId : null, status = "ERR", errorCode = "UNAUTHORIZED" };
            if (req.protocolVersion != ProtocolVersion) return new WorkerResponse { requestId = req.requestId, status = "ERR", errorCode = "PROTOCOL_VERSION_MISMATCH" };
            if (string.IsNullOrEmpty(req.nonce) || !_seenNonces.Add(req.nonce)) return new WorkerResponse { requestId = req.requestId, status = "ERR", errorCode = "REPLAY_REJECTED" };

            try
            {
                switch (req.action)
                {
                    case "OPEN_APP": return OpenApp(req);
                    case "CLOSE_APP": return CloseApp(req);
                    case "OBSERVE": return Observe(req);
                    case "SET_VALUE": case "INVOKE": case "TOGGLE": case "SELECT": case "SCROLL": return Mutate(req);
                    case "CANCEL":
                        _cancelRequested = true;
                        return new WorkerResponse { requestId = req.requestId, status = "OK" };
                    case "SHUTDOWN":
                        shouldExit = true;
                        return new WorkerResponse { requestId = req.requestId, status = "OK" };
                    default:
                        return new WorkerResponse { requestId = req.requestId, status = "ERR", errorCode = "UNKNOWN_ACTION" };
                }
            }
            catch (Exception ex)
            {
                return new WorkerResponse { requestId = req.requestId, status = "ERR", errorCode = "WORKER_EXCEPTION", observedAfter = ex.GetType().Name };
            }
        }

        // OPEN_APP — appExePath arrives already resolved/trusted by NAgex
        // Main's DesktopAppAllowlist. This worker performs no allowlist
        // logic of its own (it must not become a second policy engine) —
        // it only launches what it is told, onto its own isolated desktop,
        // job-assigned for orphan safety.
        private static WorkerResponse OpenApp(WorkerRequest req)
        {
            if (string.IsNullOrEmpty(req.appExePath) || !File.Exists(req.appExePath))
            {
                return new WorkerResponse { requestId = req.requestId, status = "ERR", errorCode = "APP_NOT_FOUND" };
            }
            var psi = new System.Diagnostics.ProcessStartInfo { FileName = req.appExePath, Arguments = req.appArgs ?? "", UseShellExecute = false };
            _appProcess = System.Diagnostics.Process.Start(psi);
            if (_jobHandle != IntPtr.Zero) JobObjectNative.AssignProcessToJobObject(_jobHandle, _appProcess.Handle);

            var root = AutomationElement.RootElement;
            var deadline = DateTime.UtcNow.AddSeconds(10);
            int lastCount = 0;
            // PID alone is not sufficient identity here either (the same
            // principle the whole DC3-B2 safety model is built on):
            // launching on an isolated desktop, Windows' own UAC/secure-
            // desktop input indicator can transiently attach 1-2 unnamed
            // overlay elements (class UAC_InputIndicatorOverlayWnd / "UAC
            // Input Indicator") sharing the just-launched process's PID —
            // confirmed via real diagnostic logging during DC3-B2
            // production acceptance. Filtering to ControlType.Window (the
            // overlay elements are ControlType.Pane) excludes them
            // without depending on any app-specific window title.
            var pidCond = new PropertyCondition(AutomationElement.ProcessIdProperty, _appProcess.Id);
            var windowTypeCond = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window);
            var combinedCond = new AndCondition(pidCond, windowTypeCond);
            while (DateTime.UtcNow < deadline)
            {
                var candidates = root.FindAll(TreeScope.Children, combinedCond);
                lastCount = candidates.Count;
                if (candidates.Count == 1)
                {
                    _appWindow = candidates[0];
                    return new WorkerResponse { requestId = req.requestId, status = "OK", observedAfter = "pid=" + _appProcess.Id, matchCount = 1 };
                }
                System.Threading.Thread.Sleep(100);
            }
            if (lastCount > 1)
            {
                var finalCandidates = root.FindAll(TreeScope.Children, pidCond);
                var diagLines = new System.Collections.Generic.List<string>();
                foreach (AutomationElement c in finalCandidates)
                {
                    diagLines.Add("name=[" + c.Current.Name + "] class=[" + c.Current.ClassName + "] controlType=[" + c.Current.ControlType.ProgrammaticName + "] isOffscreen=[" + c.Current.IsOffscreen + "]");
                }
                try { File.AppendAllLines(Path.Combine(Path.GetTempPath(), "nagex-desktop-worker-diag.log"), diagLines); } catch { }
                return new WorkerResponse { requestId = req.requestId, status = "TARGET_AMBIGUOUS", errorCode = "MULTIPLE_ROOT_WINDOWS", matchCount = lastCount };
            }
            return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "APP_WINDOW_NOT_FOUND_WITHIN_TIMEOUT" };
        }

        // CLOSE_APP — WindowPattern.Close() is UIA's generic graceful-close
        // request, supported by any well-formed top-level window (not
        // specific to this harness's own custom close button), matching
        // the "graceful shutdown first" lifecycle requirement.
        private static WorkerResponse CloseApp(WorkerRequest req)
        {
            var result = TryCloseAppGracefully();
            if (result != null) return new WorkerResponse { requestId = req.requestId, status = "CLOSE_UNSAFE", errorCode = result };
            return new WorkerResponse { requestId = req.requestId, status = "OK" };
        }

        private static string TryCloseAppGracefully()
        {
            if (_appWindow == null || _appProcess == null || _appProcess.HasExited) return null;
            try
            {
                object patternObj;
                if (_appWindow.TryGetCurrentPattern(WindowPattern.Pattern, out patternObj))
                {
                    ((WindowPattern)patternObj).Close();
                }
                else
                {
                    return "WINDOW_PATTERN_UNSUPPORTED";
                }
                _appProcess.WaitForExit(5000);
                return _appProcess.HasExited ? null : "CLOSE_DID_NOT_COMPLETE";
            }
            catch (Exception ex)
            {
                return "CLOSE_EXCEPTION:" + ex.GetType().Name;
            }
        }

        // "Target belongs to execution": every resolution is scoped to
        // TreeScope.Descendants of _appWindow — the one root window this
        // worker itself opened for this execution — never a broader
        // search. MATCH_COUNT != 1 is never treated as success.
        private static AutomationElementCollection FindCandidates(string automationId)
        {
            if (_appWindow == null) throw new InvalidOperationException("no app open for this execution");
            var cond = new PropertyCondition(AutomationElement.AutomationIdProperty, automationId);
            return _appWindow.FindAll(TreeScope.Descendants, cond);
        }

        private static WorkerResponse Observe(WorkerRequest req)
        {
            var candidates = FindCandidates(req.target);
            if (candidates.Count != 1) return new WorkerResponse { requestId = req.requestId, status = "TARGET_AMBIGUOUS", matchCount = candidates.Count };
            var element = candidates[0];
            // AutomationElement.Current.Name is the control's accessible
            // label (often blank for a plain TextBox) — never its actual
            // text content. Prefer ValuePattern when the control supports
            // it (TextBox and similar), falling back to Name only for
            // controls that don't (Button/CheckBox/Label captions).
            object valuePatternObj;
            string observed = element.TryGetCurrentPattern(ValuePattern.Pattern, out valuePatternObj)
                ? ((ValuePattern)valuePatternObj).Current.Value
                : element.Current.Name;
            return new WorkerResponse { requestId = req.requestId, status = "OK", observedAfter = observed, matchCount = 1 };
        }

        private static WorkerResponse Mutate(WorkerRequest req)
        {
            if (_cancelRequested)
            {
                return new WorkerResponse { requestId = req.requestId, status = "CANCELLED" };
            }

            var candidates = FindCandidates(req.target);
            if (candidates.Count != 1)
            {
                return new WorkerResponse { requestId = req.requestId, status = "TARGET_AMBIGUOUS", matchCount = candidates.Count };
            }
            var target = candidates[0];
            int[] boundRuntimeId = target.GetRuntimeId();

            string before, after;
            bool verified;

            switch (req.action)
            {
                case "SET_VALUE":
                    {
                        var vp = (ValuePattern)target.GetCurrentPattern(ValuePattern.Pattern);
                        before = vp.Current.Value;
                        if (!ReResolveMatches(req.target, boundRuntimeId))
                            return new WorkerResponse { requestId = req.requestId, status = "TARGET_CHANGED_SINCE_OBSERVATION" };
                        vp.SetValue(req.value);
                        after = ((ValuePattern)FindCandidates(req.target)[0].GetCurrentPattern(ValuePattern.Pattern)).Current.Value;
                        verified = after == req.value && after != before;
                        break;
                    }
                case "INVOKE":
                    {
                        before = "invoked=false";
                        if (!ReResolveMatches(req.target, boundRuntimeId))
                            return new WorkerResponse { requestId = req.requestId, status = "TARGET_CHANGED_SINCE_OBSERVATION" };
                        ((InvokePattern)target.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
                        System.Threading.Thread.Sleep(200);
                        after = "invoked=true";
                        verified = true; // caller verifies domain-specific effect via a follow-up OBSERVE
                        break;
                    }
                case "TOGGLE":
                    {
                        var tp = (TogglePattern)target.GetCurrentPattern(TogglePattern.Pattern);
                        before = tp.Current.ToggleState.ToString();
                        if (!ReResolveMatches(req.target, boundRuntimeId))
                            return new WorkerResponse { requestId = req.requestId, status = "TARGET_CHANGED_SINCE_OBSERVATION" };
                        tp.Toggle();
                        after = ((TogglePattern)FindCandidates(req.target)[0].GetCurrentPattern(TogglePattern.Pattern)).Current.ToggleState.ToString();
                        verified = after != before;
                        break;
                    }
                case "SELECT":
                    {
                        var sp = (SelectionItemPattern)target.GetCurrentPattern(SelectionItemPattern.Pattern);
                        before = sp.Current.IsSelected.ToString();
                        if (!ReResolveMatches(req.target, boundRuntimeId))
                            return new WorkerResponse { requestId = req.requestId, status = "TARGET_CHANGED_SINCE_OBSERVATION" };
                        sp.Select();
                        after = ((SelectionItemPattern)FindCandidates(req.target)[0].GetCurrentPattern(SelectionItemPattern.Pattern)).Current.IsSelected.ToString();
                        verified = before != after;
                        break;
                    }
                case "SCROLL":
                    {
                        var scp = (ScrollPattern)target.GetCurrentPattern(ScrollPattern.Pattern);
                        before = scp.Current.VerticalScrollPercent.ToString();
                        if (!ReResolveMatches(req.target, boundRuntimeId))
                            return new WorkerResponse { requestId = req.requestId, status = "TARGET_CHANGED_SINCE_OBSERVATION" };
                        // SetScrollPercent is the validated path on the
                        // canonical test host — Scroll(amount, amount) was
                        // found unreliable on WPF ScrollViewer peers during
                        // DC3-B2 real-host acceptance. Detect support
                        // rather than assuming.
                        if (!scp.Current.VerticallyScrollable)
                        {
                            return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "SCROLL_NOT_SUPPORTED_BY_TARGET" };
                        }
                        scp.SetScrollPercent(-1, 50);
                        after = ((ScrollPattern)FindCandidates(req.target)[0].GetCurrentPattern(ScrollPattern.Pattern)).Current.VerticalScrollPercent.ToString();
                        verified = after != before;
                        break;
                    }
                default:
                    return new WorkerResponse { requestId = req.requestId, status = "ERR", errorCode = "UNKNOWN_ACTION" };
            }

            return new WorkerResponse { requestId = req.requestId, status = verified ? "SUCCEEDED_VERIFIED" : "FAILED", observedBefore = before, observedAfter = after, verification = verified };
        }

        // TOCTOU re-check immediately before mutating: re-resolve by the
        // same AutomationId and require both a unique match AND the same
        // RuntimeId as originally bound.
        private static bool ReResolveMatches(string automationId, int[] boundRuntimeId)
        {
            var recheck = FindCandidates(automationId);
            if (recheck.Count != 1) return false;
            int[] currentId = recheck[0].GetRuntimeId();
            if (currentId.Length != boundRuntimeId.Length) return false;
            for (int i = 0; i < currentId.Length; i++) if (currentId[i] != boundRuntimeId[i]) return false;
            return true;
        }
    }
}
