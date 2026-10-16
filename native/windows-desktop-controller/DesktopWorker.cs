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
using System.Text;
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

    // Targeted control messages and process identity. A message goes to ONE window handle that this worker found itself inside the application window it opened - never to the system input queue
    // (no SendInput, no keybd_event, no mouse_event). They exist for the classic Win32 common dialog, whose file-name box and buttons expose no UI Automation patterns.
    internal static class Win32Native
    {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SendMessageTimeout(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam, int flags, int timeoutMs, out IntPtr result);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessageTimeout(IntPtr hWnd, int msg, IntPtr wParam, string lParam, int flags, int timeoutMs, out IntPtr result);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessageTimeout(IntPtr hWnd, int msg, IntPtr wParam, StringBuilder lParam, int flags, int timeoutMs, out IntPtr result);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetParent(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);

        [DllImport("kernel32.dll")]
        public static extern bool CloseHandle(IntPtr handle);

        public const int WM_SETTEXT = 0x000C, WM_GETTEXT = 0x000D, WM_GETTEXTLENGTH = 0x000E, WM_CHAR = 0x0102, BM_CLICK = 0x00F5;
        public const int SMTO_ABORTIFHUNG = 0x0002;
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

        public static string ClassOf(IntPtr h)
        {
            var sb = new StringBuilder(128);
            GetClassName(h, sb, 128);
            return sb.ToString();
        }

        public static string ImageOf(int pid)
        {
            IntPtr p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
            if (p == IntPtr.Zero) return "";
            try
            {
                var sb = new StringBuilder(1024);
                uint size = 1024;
                return QueryFullProcessImageName(p, 0, sb, ref size) ? sb.ToString() : "";
            }
            finally { CloseHandle(p); }
        }

        public static bool Send(IntPtr h, int msg, IntPtr w, IntPtr l)
        {
            IntPtr r;
            return SendMessageTimeout(h, msg, w, l, SMTO_ABORTIFHUNG, 3000, out r) != IntPtr.Zero;
        }

        public static bool SendText(IntPtr h, int msg, IntPtr w, string text)
        {
            IntPtr r;
            return SendMessageTimeout(h, msg, w, text, SMTO_ABORTIFHUNG, 3000, out r) != IntPtr.Zero;
        }

        public static string ReadText(IntPtr h)
        {
            IntPtr len;
            if (SendMessageTimeout(h, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 3000, out len) == IntPtr.Zero) return null;
            int n = len.ToInt32();
            if (n < 0 || n > 4096) return null;
            var sb = new StringBuilder(n + 2);
            IntPtr copied;
            if (SendMessageTimeout(h, WM_GETTEXT, new IntPtr(n + 1), sb, SMTO_ABORTIFHUNG, 3000, out copied) == IntPtr.Zero) return null;
            return sb.ToString();
        }
    }

    // One element of an application window, named by what it IS (kind, class, automation id, accessible name) - not by a path or a coordinate. Exactly one match is required to act.
    internal class SelectorDto
    {
        public string automationId;
        public string name;
        public string[] names; // any of these accessible names (the same control under several display languages)
        public string className;
        public string controlType; // Document | MenuItem | Button | Edit | Window | Text | Pane
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
        public string target; // AutomationId, for OBSERVE/mutation actions ('@window' reads the title of the window this worker opened)
        public string value; // SET_VALUE only
        public string mode; // OPEN_APP only: ISOLATED (default: the hidden desktop) | INTERACTIVE (the user's desktop; the window is found by handle)
        public string expectClass; // OPEN_APP INTERACTIVE only: the window class the application's window must have
        public string expectImage; // OPEN_APP INTERACTIVE only: the file name the owning process image must contain
        public SelectorDto selector; // OBSERVE / mutation: instead of target
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
        private static bool _interactive;
        private static int _appHwnd;
        private static string _expectClass;
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
                    case "SET_VALUE": case "INVOKE": case "TOGGLE": case "SELECT": case "SCROLL": case "EXPAND": return Mutate(req);
                    case "DIALOG_SET_FILENAME": return DialogSetFilename(req);
                    case "DIALOG_PRESS": return DialogPress(req);
                    case "CLOSE_DISCARD": return CloseDiscard(req);
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
            if (req.mode == "INTERACTIVE") return OpenAppInteractive(req);
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

        private static bool WindowAlive()
        {
            return _appHwnd != 0 && Win32Native.IsWindow(new IntPtr(_appHwnd));
        }

        private static bool WaitForWindowGone(int milliseconds)
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
            while (DateTime.UtcNow < deadline)
            {
                if (!WindowAlive()) return true;
                System.Threading.Thread.Sleep(100);
            }
            return !WindowAlive();
        }

        private static string TryCloseAppGracefully()
        {
            if (_interactive)
            {
                if (_appWindow == null || !WindowAlive()) return null;
                try
                {
                    object interactivePattern;
                    if (!_appWindow.TryGetCurrentPattern(WindowPattern.Pattern, out interactivePattern)) return "WINDOW_PATTERN_UNSUPPORTED";
                    ((WindowPattern)interactivePattern).Close();
                }
                catch (Exception ex) { return "CLOSE_EXCEPTION:" + ex.GetType().Name; }
                return WaitForWindowGone(3000) ? null : "CLOSE_DID_NOT_COMPLETE";
            }
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
            if (_interactive && !WindowAlive()) throw new InvalidOperationException("the application window is gone");
            var cond = new PropertyCondition(AutomationElement.AutomationIdProperty, automationId);
            return _appWindow.FindAll(TreeScope.Descendants, cond);
        }

        private static ControlType ParseControlType(string name)
        {
            switch (name)
            {
                case "Document": return ControlType.Document;
                case "MenuItem": return ControlType.MenuItem;
                case "Button": return ControlType.Button;
                case "Edit": return ControlType.Edit;
                case "Window": return ControlType.Window;
                case "Text": return ControlType.Text;
                case "Pane": return ControlType.Pane;
                default: throw new ArgumentException("unsupported control type");
            }
        }

        // Every condition given must hold; at least one is required. Scoped to the application window this worker opened (a dialog of that window is part of it).
        private static AutomationElementCollection FindBySelector(SelectorDto s)
        {
            if (_appWindow == null) throw new InvalidOperationException("no app open for this execution");
            if (_interactive && !WindowAlive()) throw new InvalidOperationException("the application window is gone");
            var conds = new List<Condition>();
            if (!string.IsNullOrEmpty(s.automationId)) conds.Add(new PropertyCondition(AutomationElement.AutomationIdProperty, s.automationId));
            if (!string.IsNullOrEmpty(s.className)) conds.Add(new PropertyCondition(AutomationElement.ClassNameProperty, s.className));
            if (!string.IsNullOrEmpty(s.controlType)) conds.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, ParseControlType(s.controlType)));
            if (s.names != null && s.names.Length > 0)
            {
                var ors = new List<Condition>();
                foreach (string n in s.names) { if (!string.IsNullOrEmpty(n)) ors.Add(new PropertyCondition(AutomationElement.NameProperty, n)); }
                if (ors.Count == 1) conds.Add(ors[0]);
                else if (ors.Count > 1) conds.Add(new OrCondition(ors.ToArray()));
            }
            else if (!string.IsNullOrEmpty(s.name)) conds.Add(new PropertyCondition(AutomationElement.NameProperty, s.name));
            if (conds.Count == 0) throw new ArgumentException("an empty selector");
            Condition all = conds.Count == 1 ? conds[0] : new AndCondition(conds.ToArray());
            return _appWindow.FindAll(TreeScope.Descendants, all);
        }

        private static AutomationElementCollection Resolve(WorkerRequest req)
        {
            if (req.selector != null) return FindBySelector(req.selector);
            return FindCandidates(req.target);
        }

        private static WorkerResponse Observe(WorkerRequest req)
        {
            if (req.selector == null && req.target == "@window")
            {
                if (_appWindow == null) throw new InvalidOperationException("no app open for this execution");
                if (_interactive && !WindowAlive()) return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "APP_WINDOW_GONE" };
                string title = _appWindow.Current.Name ?? "";
                if (title.Length > 160) title = title.Substring(0, 160);
                return new WorkerResponse { requestId = req.requestId, status = "OK", observedAfter = title, matchCount = 1 };
            }
            var candidates = Resolve(req);
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

            var candidates = Resolve(req);
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
                        if (!ReResolveMatches(req, boundRuntimeId))
                            return new WorkerResponse { requestId = req.requestId, status = "TARGET_CHANGED_SINCE_OBSERVATION" };
                        vp.SetValue(req.value);
                        after = ((ValuePattern)Resolve(req)[0].GetCurrentPattern(ValuePattern.Pattern)).Current.Value;
                        verified = after == req.value && after != before;
                        break;
                    }
                case "INVOKE":
                    {
                        before = "invoked=false";
                        if (!ReResolveMatches(req, boundRuntimeId))
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
                        if (!ReResolveMatches(req, boundRuntimeId))
                            return new WorkerResponse { requestId = req.requestId, status = "TARGET_CHANGED_SINCE_OBSERVATION" };
                        tp.Toggle();
                        after = ((TogglePattern)Resolve(req)[0].GetCurrentPattern(TogglePattern.Pattern)).Current.ToggleState.ToString();
                        verified = after != before;
                        break;
                    }
                case "SELECT":
                    {
                        var sp = (SelectionItemPattern)target.GetCurrentPattern(SelectionItemPattern.Pattern);
                        before = sp.Current.IsSelected.ToString();
                        if (!ReResolveMatches(req, boundRuntimeId))
                            return new WorkerResponse { requestId = req.requestId, status = "TARGET_CHANGED_SINCE_OBSERVATION" };
                        sp.Select();
                        after = ((SelectionItemPattern)Resolve(req)[0].GetCurrentPattern(SelectionItemPattern.Pattern)).Current.IsSelected.ToString();
                        verified = before != after;
                        break;
                    }
                case "EXPAND":
                    {
                        var ep = (ExpandCollapsePattern)target.GetCurrentPattern(ExpandCollapsePattern.Pattern);
                        before = ep.Current.ExpandCollapseState.ToString();
                        if (!ReResolveMatches(req, boundRuntimeId))
                            return new WorkerResponse { requestId = req.requestId, status = "TARGET_CHANGED_SINCE_OBSERVATION" };
                        ep.Expand();
                        System.Threading.Thread.Sleep(400);
                        after = ((ExpandCollapsePattern)Resolve(req)[0].GetCurrentPattern(ExpandCollapsePattern.Pattern)).Current.ExpandCollapseState.ToString();
                        verified = after == "Expanded";
                        break;
                    }
                case "SCROLL":
                    {
                        var scp = (ScrollPattern)target.GetCurrentPattern(ScrollPattern.Pattern);
                        before = scp.Current.VerticalScrollPercent.ToString();
                        if (!ReResolveMatches(req, boundRuntimeId))
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
                        after = ((ScrollPattern)Resolve(req)[0].GetCurrentPattern(ScrollPattern.Pattern)).Current.VerticalScrollPercent.ToString();
                        verified = after != before;
                        break;
                    }
                default:
                    return new WorkerResponse { requestId = req.requestId, status = "ERR", errorCode = "UNKNOWN_ACTION" };
            }

            return new WorkerResponse { requestId = req.requestId, status = verified ? "SUCCEEDED_VERIFIED" : "FAILED", observedBefore = before, observedAfter = after, verification = verified };
        }

        // OPEN_APP, INTERACTIVE. Some applications cannot run on a hidden desktop at all (a packaged Windows application is activated by the system on the user's desktop; its launcher process exits at
        // once). The window is then found on the user's desktop - and process id cannot identify it, because a second window of an application that is already open belongs to the SAME process as the
        // user's own window. Identity is therefore: a top-level window that did not exist before the launch, of the expected window class, owned by a process whose image is the expected one.
        // Windows that were already open are only counted, never looked at, and are never touched.
        private static WorkerResponse OpenAppInteractive(WorkerRequest req)
        {
            if (string.IsNullOrEmpty(req.appExePath) || !File.Exists(req.appExePath))
                return new WorkerResponse { requestId = req.requestId, status = "ERR", errorCode = "APP_NOT_FOUND" };
            if (string.IsNullOrEmpty(req.expectClass) || string.IsNullOrEmpty(req.expectImage))
                return new WorkerResponse { requestId = req.requestId, status = "ERR", errorCode = "INTERACTIVE_IDENTITY_REQUIRED" };
            if (_appWindow != null)
                return new WorkerResponse { requestId = req.requestId, status = "ERR", errorCode = "APP_ALREADY_OPEN" };

            var root = AutomationElement.RootElement;
            var windowCond = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window);
            var before = new HashSet<int>();
            int sameClassBefore = 0;
            foreach (AutomationElement w in root.FindAll(TreeScope.Children, windowCond))
            {
                before.Add(w.Current.NativeWindowHandle);
                if (w.Current.ClassName == req.expectClass) sameClassBefore++;
            }

            var psi = new System.Diagnostics.ProcessStartInfo { FileName = req.appExePath, Arguments = req.appArgs ?? "", UseShellExecute = false };
            _appProcess = System.Diagnostics.Process.Start(psi);

            var classCond = new AndCondition(windowCond, new PropertyCondition(AutomationElement.ClassNameProperty, req.expectClass));
            var deadline = DateTime.UtcNow.AddSeconds(12);
            while (DateTime.UtcNow < deadline)
            {
                var fresh = new List<AutomationElement>();
                foreach (AutomationElement w in root.FindAll(TreeScope.Children, classCond))
                {
                    int hwnd = w.Current.NativeWindowHandle;
                    if (before.Contains(hwnd)) continue;
                    string image = Win32Native.ImageOf(w.Current.ProcessId);
                    if (image.IndexOf(req.expectImage, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    fresh.Add(w);
                }
                if (fresh.Count > 1)
                    return new WorkerResponse { requestId = req.requestId, status = "TARGET_AMBIGUOUS", errorCode = "MULTIPLE_NEW_WINDOWS", matchCount = fresh.Count };
                if (fresh.Count == 1)
                {
                    _appWindow = fresh[0];
                    _appHwnd = fresh[0].Current.NativeWindowHandle;
                    _interactive = true;
                    _expectClass = req.expectClass;
                    return new WorkerResponse { requestId = req.requestId, status = "OK", observedAfter = "hwnd=" + _appHwnd + ";preexistingSameClass=" + sameClassBefore, matchCount = 1 };
                }
                System.Threading.Thread.Sleep(150);
            }
            return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "APP_WINDOW_NOT_FOUND_WITHIN_TIMEOUT" };
        }

        // The classic file dialog of the application window: a #32770 child of that window that holds the file-name combo box. Exactly one, or none.
        private static AutomationElement FindFileDialog()
        {
            if (_appWindow == null) throw new InvalidOperationException("no app open for this execution");
            if (_interactive && !WindowAlive()) throw new InvalidOperationException("the application window is gone");
            AutomationElement found = null;
            int count = 0;
            foreach (AutomationElement d in _appWindow.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, "#32770")))
            {
                var host = d.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, "FileNameControlHost"));
                if (host != null) { found = d; count++; }
            }
            return count == 1 ? found : null;
        }

        private static bool HasControlCharacters(string value)
        {
            foreach (char c in value) { if (c < ' ' || c == (char)127) return true; }
            return false;
        }

        // DIALOG_SET_FILENAME: the full path goes into the dialog's file-name box. This dialog ignores a text that is injected in one go, so it is entered character by character, to that one control,
        // and read back. The path must be absolute; whether it is an ALLOWED path was decided by NAgex before the command reached this worker.
        private static WorkerResponse DialogSetFilename(WorkerRequest req)
        {
            if (_cancelRequested) return new WorkerResponse { requestId = req.requestId, status = "CANCELLED" };
            string value = req.value ?? "";
            if (value.Length == 0 || value.Length > 259 || HasControlCharacters(value) || !Path.IsPathRooted(value))
                return new WorkerResponse { requestId = req.requestId, status = "ERR", errorCode = "FILENAME_INVALID" };
            var dlg = FindFileDialog();
            if (dlg == null) return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "FILE_DIALOG_NOT_FOUND", matchCount = 0 };
            var edits = dlg.FindAll(TreeScope.Descendants, new AndCondition(new PropertyCondition(AutomationElement.AutomationIdProperty, "1001"), new PropertyCondition(AutomationElement.ClassNameProperty, "Edit")));
            if (edits.Count != 1) return new WorkerResponse { requestId = req.requestId, status = "TARGET_AMBIGUOUS", errorCode = "FILENAME_CONTROL_NOT_UNIQUE", matchCount = edits.Count };
            IntPtr edit = new IntPtr(edits[0].Current.NativeWindowHandle);
            if (edit == IntPtr.Zero || Win32Native.ClassOf(Win32Native.GetParent(edit)) != "ComboBox")
                return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "FILENAME_CONTROL_UNEXPECTED", matchCount = 1 };
            if (!Win32Native.SendText(edit, Win32Native.WM_SETTEXT, IntPtr.Zero, ""))
                return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "FILENAME_CONTROL_NOT_RESPONDING", matchCount = 1 };
            foreach (char c in value)
            {
                if (!Win32Native.Send(edit, Win32Native.WM_CHAR, new IntPtr((int)c), IntPtr.Zero))
                    return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "FILENAME_TYPING_INTERRUPTED", matchCount = 1 };
            }
            string readBack = Win32Native.ReadText(edit);
            bool same = readBack != null && readBack == value;
            return new WorkerResponse
            {
                requestId = req.requestId,
                status = same ? "SUCCEEDED_VERIFIED" : "FAILED",
                observedBefore = "",
                observedAfter = "length=" + (readBack == null ? -1 : readBack.Length),
                verification = same,
                errorCode = same ? null : "FILENAME_READBACK_MISMATCH",
                matchCount = 1
            };
        }

        // DIALOG_PRESS: SAVE | CANCEL (the dialog's own buttons, ids 1 and 2) or NO (the answer to "replace the file?"). One click on one verified button, then the effect is waited for.
        private static WorkerResponse DialogPress(WorkerRequest req)
        {
            if (_cancelRequested && req.value == "SAVE") return new WorkerResponse { requestId = req.requestId, status = "CANCELLED" };
            string which = req.value ?? "";
            var dlg = FindFileDialog();
            if (dlg == null) return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "FILE_DIALOG_NOT_FOUND", matchCount = 0 };

            AutomationElement confirm = null;
            foreach (AutomationElement c in dlg.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, "#32770"))) confirm = c;

            IntPtr button = IntPtr.Zero;
            if (which == "SAVE" || which == "CANCEL")
            {
                if (confirm != null) return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "CONFIRM_PROMPT_OPEN", matchCount = 1 };
                string id = which == "SAVE" ? "1" : "2";
                var buttons = dlg.FindAll(TreeScope.Descendants, new AndCondition(new PropertyCondition(AutomationElement.AutomationIdProperty, id), new PropertyCondition(AutomationElement.ClassNameProperty, "Button")));
                if (buttons.Count != 1) return new WorkerResponse { requestId = req.requestId, status = "TARGET_AMBIGUOUS", errorCode = "DIALOG_BUTTON_NOT_UNIQUE", matchCount = buttons.Count };
                button = new IntPtr(buttons[0].Current.NativeWindowHandle);
                if (button == IntPtr.Zero || Win32Native.ClassOf(Win32Native.GetParent(button)) != "#32770")
                    return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "DIALOG_BUTTON_UNEXPECTED", matchCount = 1 };
            }
            else if (which == "NO")
            {
                if (confirm == null) return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "CONFIRM_PROMPT_NOT_FOUND", matchCount = 0 };
                var no = confirm.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, "CommandButton_7"));
                if (no.Count != 1) return new WorkerResponse { requestId = req.requestId, status = "TARGET_AMBIGUOUS", errorCode = "CONFIRM_BUTTON_NOT_UNIQUE", matchCount = no.Count };
                button = new IntPtr(no[0].Current.NativeWindowHandle);
                if (button == IntPtr.Zero) return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "CONFIRM_BUTTON_UNEXPECTED", matchCount = 1 };
            }
            else return new WorkerResponse { requestId = req.requestId, status = "ERR", errorCode = "DIALOG_BUTTON_UNKNOWN" };

            if (!Win32Native.Send(button, Win32Native.BM_CLICK, IntPtr.Zero, IntPtr.Zero))
                return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "DIALOG_BUTTON_NOT_RESPONDING", matchCount = 1 };

            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < deadline)
            {
                System.Threading.Thread.Sleep(150);
                if (!WindowAlive()) return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "APP_WINDOW_GONE" };
                var now = FindFileDialog();
                if (which == "NO")
                {
                    bool promptOpen = false;
                    if (now != null) { foreach (AutomationElement c in now.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, "#32770"))) promptOpen = true; }
                    if (!promptOpen) return new WorkerResponse { requestId = req.requestId, status = "SUCCEEDED_VERIFIED", observedAfter = "PROMPT_CLOSED", verification = true, matchCount = 1 };
                    continue;
                }
                if (now == null) return new WorkerResponse { requestId = req.requestId, status = "SUCCEEDED_VERIFIED", observedAfter = "DIALOG_CLOSED", verification = true, matchCount = 1 };
                if (which == "SAVE")
                {
                    foreach (AutomationElement c in now.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, "#32770")))
                        return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "CONFIRM_PROMPT_OPEN", observedAfter = "REPLACE_OR_CONFIRM_PROMPT", matchCount = 1 };
                }
            }
            return new WorkerResponse { requestId = req.requestId, status = "FAILED", errorCode = "DIALOG_DID_NOT_CLOSE", matchCount = 1 };
        }

        // CLOSE_DISCARD: failure clean-up for the window this worker opened and nothing else. The application asks whether to save what was typed; the answer is "do not save" (the text is only what this
        // execution typed). Used only when a step failed before the document was saved.
        private static WorkerResponse CloseDiscard(WorkerRequest req)
        {
            if (!_interactive || _appWindow == null) return new WorkerResponse { requestId = req.requestId, status = "ERR", errorCode = "NOT_INTERACTIVE" };
            if (!WindowAlive()) return new WorkerResponse { requestId = req.requestId, status = "OK" };
            try
            {
                object pattern;
                if (_appWindow.TryGetCurrentPattern(WindowPattern.Pattern, out pattern)) ((WindowPattern)pattern).Close();
            }
            catch (Exception) { }
            if (WaitForWindowGone(2500)) return new WorkerResponse { requestId = req.requestId, status = "OK" };
            var secondary = _appWindow.FindAll(TreeScope.Descendants, new AndCondition(new PropertyCondition(AutomationElement.AutomationIdProperty, "SecondaryButton"), new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)));
            if (secondary.Count != 1) return new WorkerResponse { requestId = req.requestId, status = "CLOSE_UNSAFE", errorCode = "CLOSE_PROMPT_NOT_RECOGNISED", matchCount = secondary.Count };
            ((InvokePattern)secondary[0].GetCurrentPattern(InvokePattern.Pattern)).Invoke();
            return WaitForWindowGone(3000)
                ? new WorkerResponse { requestId = req.requestId, status = "OK" }
                : new WorkerResponse { requestId = req.requestId, status = "CLOSE_UNSAFE", errorCode = "CLOSE_DID_NOT_COMPLETE" };
        }

        // TOCTOU re-check immediately before mutating: re-resolve by the
        // same AutomationId and require both a unique match AND the same
        // RuntimeId as originally bound.
        private static bool ReResolveMatches(WorkerRequest req, int[] boundRuntimeId)
        {
            var recheck = Resolve(req);
            if (recheck.Count != 1) return false;
            int[] currentId = recheck[0].GetRuntimeId();
            if (currentId.Length != boundRuntimeId.Length) return false;
            for (int i = 0; i < currentId.Length; i++) if (currentId[i] != boundRuntimeId[i]) return false;
            return true;
        }
    }
}
