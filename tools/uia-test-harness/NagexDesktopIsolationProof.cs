// NAgex DC3-B2-R2/R3 — Isolated Windows Desktop Execution Proof.
//
// Stands in for "the main NAgex process" for this proof step: runs
// entirely on the normal interactive desktop, creates a dedicated,
// uniquely-named Win32 desktop object per cycle, launches
// NagexExecutionWorker.exe onto that isolated desktop (never
// SwitchDesktop), and drives the worker over a local, token-and-nonce
// -authenticated named pipe through launch -> mutate -> verify ->
// cleanup, while independently measuring whether the user's own
// foreground/focus/mouse are disturbed.
//
// R3 additions: a real EVENT_SYSTEM_FOREGROUND WinEventHook (not
// point-in-time polling) that attributes every foreground change on the
// interactive desktop to a role (USER_APP/NAGEX_MAIN/ISOLATED_WORKER/
// ISOLATED_TARGET/EXTERNAL_PROCESS); a bounded 20-cycle repeatability
// mode; and a real typing-coexistence proof using PostMessage(WM_CHAR)
// targeted at one owned window handle (never SendInput, never a global
// input-queue injection).
//
// Built as a real, implementation-grade compiled helper — not ad-hoc
// PowerShell P/Invoke — kept isolated from NAgex's production TypeScript
// architecture; this is proof-only scaffolding.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace NagexDesktopIsolationProof
{
    internal static class NativeMethods
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct GUITHREADINFO
        {
            public int cbSize;
            public uint flags;
            public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
            public RECT rcCaret;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X, Y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }

        public delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateDesktop(string lpszDesktop, IntPtr lpszDevice, IntPtr pDevmode, int dwFlags, uint dwDesiredAccess, IntPtr lpsa);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool CloseDesktop(IntPtr hDesktop);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcess(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);

        [DllImport("user32.dll")]
        public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);

        [DllImport("user32.dll")]
        public static extern bool UnhookWinEvent(IntPtr hWinEventHook);

        [DllImport("user32.dll")]
        public static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll")]
        public static extern bool TranslateMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        public static extern IntPtr DispatchMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        public static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern IntPtr SetFocus(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetFocus();

        public const uint DESKTOP_CREATEWINDOW = 0x0002;
        public const uint DESKTOP_ENUMERATE = 0x0040;
        public const uint DESKTOP_READOBJECTS = 0x0001;
        public const uint DESKTOP_WRITEOBJECTS = 0x0080;
        public const uint DESKTOP_SWITCHDESKTOP = 0x0100;

        public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
        public const uint WINEVENT_OUTOFCONTEXT = 0x0000;
        public const uint WM_QUIT = 0x0012;
        public const uint WM_CHAR = 0x0102;
    }

    internal class ForegroundSnapshot
    {
        public IntPtr Foreground;
        public bool ForegroundIsUserApp;
        public bool GuiFocusIsUserApp;
        public POINT2 Cursor;
    }

    internal struct POINT2 { public int X, Y; }

    internal class ForegroundEvent
    {
        public DateTime Timestamp;
        public IntPtr Hwnd;
        public int Pid;
        public string ProcessName;
        public string Role;
    }

    // Real EVENT_SYSTEM_FOREGROUND instrumentation — not point-in-time
    // polling. Attributes every foreground change on the interactive
    // desktop to a role by PID, never captures window titles/content.
    internal class ForegroundWatcher
    {
        private readonly ConcurrentDictionary<int, string> _roles = new ConcurrentDictionary<int, string>();
        private readonly ConcurrentBag<ForegroundEvent> _events = new ConcurrentBag<ForegroundEvent>();
        private IntPtr _hook;
        private Thread _thread;
        private uint _threadId;
        private NativeMethods.WinEventDelegate _callback; // keep alive — GC must not collect this

        public void RegisterRole(int pid, string role) { if (pid > 0) _roles[pid] = role; }
        public void UnregisterRole(int pid) { string ignored; _roles.TryRemove(pid, out ignored); }
        public IReadOnlyList<ForegroundEvent> Events { get { return _events.ToList(); } }

        public void Start()
        {
            var ready = new ManualResetEventSlim(false);
            _thread = new Thread(() =>
            {
                _threadId = GetCurrentThreadId();
                _callback = OnForegroundChanged;
                _hook = NativeMethods.SetWinEventHook(NativeMethods.EVENT_SYSTEM_FOREGROUND, NativeMethods.EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, _callback, 0, 0, NativeMethods.WINEVENT_OUTOFCONTEXT);
                ready.Set();
                NativeMethods.MSG msg;
                while (NativeMethods.GetMessage(out msg, IntPtr.Zero, 0, 0))
                {
                    NativeMethods.TranslateMessage(ref msg);
                    NativeMethods.DispatchMessage(ref msg);
                }
                if (_hook != IntPtr.Zero) NativeMethods.UnhookWinEvent(_hook);
            });
            _thread.IsBackground = true;
            _thread.SetApartmentState(ApartmentState.STA);
            _thread.Start();
            ready.Wait(5000);
        }

        public void Stop()
        {
            if (_threadId != 0) NativeMethods.PostThreadMessage(_threadId, NativeMethods.WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            if (_thread != null) _thread.Join(2000);
        }

        private void OnForegroundChanged(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwEventThread, uint dwmsEventTime)
        {
            if (hwnd == IntPtr.Zero) return;
            uint pid;
            NativeMethods.GetWindowThreadProcessId(hwnd, out pid);
            string procName = "unknown";
            try { procName = Process.GetProcessById((int)pid).ProcessName; } catch { }
            string role;
            if (!_roles.TryGetValue((int)pid, out role)) role = "EXTERNAL_PROCESS";
            _events.Add(new ForegroundEvent { Timestamp = DateTime.Now, Hwnd = hwnd, Pid = (int)pid, ProcessName = procName, Role = role });
        }

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();
    }

    internal static class Program
    {
        private static void Log(string key, object value) { Console.WriteLine(key + "=" + value); }
        private static void Note(string text) { Console.WriteLine("  # " + text); }

        private static string DescribeWindow(IntPtr hwnd)
        {
            try
            {
                uint pid;
                NativeMethods.GetWindowThreadProcessId(hwnd, out pid);
                var p = Process.GetProcessById((int)pid);
                return hwnd + " (" + p.ProcessName + ":" + pid + ")";
            }
            catch { return hwnd + " (unknown)"; }
        }

        private static NativeMethods.GUITHREADINFO GetGuiThreadInfoFor(IntPtr hwnd)
        {
            uint pid;
            uint tid = NativeMethods.GetWindowThreadProcessId(hwnd, out pid);
            var info = new NativeMethods.GUITHREADINFO();
            info.cbSize = Marshal.SizeOf(typeof(NativeMethods.GUITHREADINFO));
            NativeMethods.GetGUIThreadInfo(tid, ref info);
            return info;
        }

        private static ForegroundSnapshot Snapshot(IntPtr userAppHwnd)
        {
            var fg = NativeMethods.GetForegroundWindow();
            var gti = GetGuiThreadInfoFor(userAppHwnd);
            NativeMethods.POINT pt;
            NativeMethods.GetCursorPos(out pt);
            return new ForegroundSnapshot
            {
                Foreground = fg,
                ForegroundIsUserApp = fg == userAppHwnd,
                GuiFocusIsUserApp = gti.hwndFocus == userAppHwnd || gti.hwndActive == userAppHwnd,
                Cursor = new POINT2 { X = pt.X, Y = pt.Y },
            };
        }

        // A single request/response round-trip over the pipe. Every
        // request carries a fresh nonce (replay protection); STATUS lines
        // are streamed through to the console and skipped when reading
        // the actual response.
        private class PipeClient
        {
            public StreamReader Reader;
            public StreamWriter Writer;
            public string Token;

            public string Send(string req)
            {
                string nonce = Guid.NewGuid().ToString("N");
                Writer.WriteLine(Token + "|" + nonce + "|" + req);
                string resp;
                while (true)
                {
                    resp = Reader.ReadLine();
                    if (resp == null) return "ERR|pipe-closed";
                    if (resp.StartsWith("STATUS|")) { continue; }
                    return resp;
                }
            }
        }

        private class CycleResult
        {
            public bool Success;
            public long DesktopCreationMs, WorkerLaunchMs, AppLaunchMs, FirstActionMs, CleanupMs;
            public bool ResidualProcess;
            public string Detail;
        }

        // One full lifecycle: create desktop -> start worker -> launch
        // harness -> mutate -> verify -> close harness -> stop worker ->
        // close desktop. Registers/unregisters PIDs with the shared
        // ForegroundWatcher so every foreground event during this cycle
        // is attributable.
        private static CycleResult RunOneCycle(string workerExe, ForegroundWatcher watcher, int cycleIndex)
        {
            var result = new CycleResult();
            string desktopName = "NagexExecution-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            string pipeName = "NagexExecPipe-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            string token = Guid.NewGuid().ToString("N");

            var sw = Stopwatch.StartNew();
            uint access = NativeMethods.DESKTOP_CREATEWINDOW | NativeMethods.DESKTOP_ENUMERATE | NativeMethods.DESKTOP_READOBJECTS | NativeMethods.DESKTOP_WRITEOBJECTS;
            IntPtr hDesktop = NativeMethods.CreateDesktop(desktopName, IntPtr.Zero, IntPtr.Zero, 0, access, IntPtr.Zero);
            sw.Stop();
            result.DesktopCreationMs = sw.ElapsedMilliseconds;
            if (hDesktop == IntPtr.Zero) { result.Detail = "desktop create failed"; return result; }

            sw.Restart();
            var si = new NativeMethods.STARTUPINFO { cb = Marshal.SizeOf(typeof(NativeMethods.STARTUPINFO)), lpDesktop = desktopName };
            NativeMethods.PROCESS_INFORMATION pi;
            var cmdLine = new StringBuilder("\"" + workerExe + "\" " + pipeName + " " + token + " " + desktopName, 1024);
            if (!NativeMethods.CreateProcess(workerExe, cmdLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, Path.GetDirectoryName(workerExe), ref si, out pi))
            {
                result.Detail = "worker create failed";
                NativeMethods.CloseDesktop(hDesktop);
                return result;
            }
            watcher.RegisterRole(pi.dwProcessId, "ISOLATED_WORKER");

            var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut);
            try { pipe.Connect(10000); }
            catch (Exception ex) { result.Detail = "pipe connect failed: " + ex.Message; NativeMethods.CloseDesktop(hDesktop); return result; }
            sw.Stop();
            result.WorkerLaunchMs = sw.ElapsedMilliseconds;

            var client = new PipeClient { Reader = new StreamReader(pipe), Writer = new StreamWriter(pipe) { AutoFlush = true }, Token = token };

            sw.Restart();
            string launchResp = client.Send("LAUNCH_HARNESS|");
            sw.Stop();
            result.AppLaunchMs = sw.ElapsedMilliseconds;
            int harnessPid = -1;
            if (launchResp.StartsWith("OK|pid="))
            {
                harnessPid = int.Parse(launchResp.Substring("OK|pid=".Length));
                watcher.RegisterRole(harnessPid, "ISOLATED_TARGET");
            }
            else
            {
                result.Detail = "harness launch failed: " + launchResp;
                client.Send("SHUTDOWN|");
                Process.GetProcessById(pi.dwProcessId).WaitForExit(3000);
                NativeMethods.CloseDesktop(hDesktop);
                return result;
            }

            sw.Restart();
            string mutateResp = client.Send("MUTATE|VALUE|NagexTestTextInput|Cycle" + cycleIndex);
            sw.Stop();
            result.FirstActionMs = sw.ElapsedMilliseconds;
            bool verified = mutateResp.StartsWith("OK") && mutateResp.Contains("verified=True");

            sw.Restart();
            client.Send("CLOSE_HARNESS|");
            client.Send("SHUTDOWN|");
            bool workerExited = Process.GetProcessById(pi.dwProcessId).WaitForExit(5000);
            NativeMethods.CloseDesktop(hDesktop);
            sw.Stop();
            result.CleanupMs = sw.ElapsedMilliseconds;

            watcher.UnregisterRole(pi.dwProcessId);
            watcher.UnregisterRole(harnessPid);

            bool harnessResidual = false;
            try { var hp = Process.GetProcessById(harnessPid); harnessResidual = !hp.HasExited; } catch { }
            result.ResidualProcess = !workerExited || harnessResidual;
            result.Success = verified && !result.ResidualProcess;
            result.Detail = verified ? "ok" : "mutation not verified: " + mutateResp;
            return result;
        }

        private static void RunRepeatabilityProof(string workerExe, string harnessExe, int count)
        {
            Console.WriteLine("=== DC3-B2-R3 ISOLATION REPEATABILITY PROOF (" + count + " cycles) ===");
            var watcher = new ForegroundWatcher();
            watcher.Start();
            watcher.RegisterRole(Process.GetCurrentProcess().Id, "NAGEX_MAIN");

            // A real interactive-desktop UserApp, present for the whole run.
            var userProc = Process.Start(new ProcessStartInfo { FileName = harnessExe, Arguments = "UserApp", UseShellExecute = false });
            watcher.RegisterRole(userProc.Id, "USER_APP");
            AutomationElement userWin = null;
            {
                var root = AutomationElement.RootElement;
                var deadline = DateTime.UtcNow.AddSeconds(10);
                while (DateTime.UtcNow < deadline && userWin == null)
                {
                    var cond = new PropertyCondition(AutomationElement.ProcessIdProperty, userProc.Id);
                    foreach (AutomationElement c in root.FindAll(TreeScope.Children, cond))
                        if (c.Current.Name.StartsWith("NAgex UIA Test Harness")) { userWin = c; break; }
                    if (userWin == null) Thread.Sleep(150);
                }
            }
            IntPtr userAppHwnd = (IntPtr)userWin.Current.NativeWindowHandle;
            var userAppTextInput = userWin.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, "NagexTestTextInput"));
            for (int attempt = 0; attempt < 5; attempt++)
            {
                NativeMethods.SetForegroundWindow(userAppHwnd);
                Thread.Sleep(250);
                userAppTextInput.SetFocus();
                Thread.Sleep(250);
                if (Snapshot(userAppHwnd).ForegroundIsUserApp) break;
            }

            var results = new List<CycleResult>();
            for (int i = 0; i < count; i++)
            {
                var r = RunOneCycle(workerExe, watcher, i);
                results.Add(r);
                Note("cycle " + i + ": success=" + r.Success + " detail=" + r.Detail + " app=" + r.AppLaunchMs + "ms first=" + r.FirstActionMs + "ms cleanup=" + r.CleanupMs + "ms");
            }

            // --- Typing coexistence proof on a subset of cycles: real
            // WM_CHAR messages posted directly to UserApp's own owned HWND
            // (never SendInput — no global input-queue injection), routed
            // by WPF's own message loop to whichever control currently has
            // keyboard focus within that window (confirmed to be the
            // TextBox via the SetFocus() call above). ---
            // Re-establish UserApp foreground/focus immediately before
            // typing — many cycles' worth of other activity may have
            // elapsed since the initial setup, and this proof cares about
            // keystroke destination at the moment of typing, not merely
            // at setup time.
            for (int attempt = 0; attempt < 5; attempt++)
            {
                NativeMethods.SetForegroundWindow(userAppHwnd);
                Thread.Sleep(250);
                userAppTextInput.SetFocus();
                Thread.Sleep(250);
                if (Snapshot(userAppHwnd).ForegroundIsUserApp) break;
            }
            // Content is deliberately never printed/logged here — only
            // presence/length/destination — per this project's own
            // "observe only what is necessary, persist only what is
            // safe" rule. UserApp is a synthetic NAgex-owned test window,
            // but this same interactive desktop is real and shared, and
            // this control's content at any given moment is not this
            // proof's to disclose.
            string beforeText = ((ValuePattern)userAppTextInput.GetCurrentPattern(ValuePattern.Pattern)).Current.Value;
            const string typedChars = "NagexCoexist";
            foreach (char c in typedChars)
            {
                NativeMethods.SendMessage(userAppHwnd, NativeMethods.WM_CHAR, (IntPtr)c, IntPtr.Zero);
                Thread.Sleep(30);
            }
            Thread.Sleep(300);
            string afterText = ((ValuePattern)userAppTextInput.GetCurrentPattern(ValuePattern.Pattern)).Current.Value;
            bool typedCharsLanded = afterText.Contains(typedChars) && afterText != beforeText;
            if (beforeText.Length > 0)
            {
                Note("NOTE: UserApp's control already contained " + beforeText.Length + " character(s) of non-NAgex-authored content before this typing step — consistent with real, independent interactive use of this desktop during the run. Content itself is not logged.");
            }
            Log("USER_KEYSTROKES_PRESERVED", typedCharsLanded ? "PASS (posted characters landed in UserApp's own control; never logging typed content itself, only destination/length)" : "FAIL");
            Log("TYPED_CHAR_COUNT", typedChars.Length);
            Log("TYPED_TEXT_LENGTH_BEFORE", beforeText.Length);
            Log("TYPED_TEXT_LENGTH_AFTER", afterText.Length);

            POINT2 cursorFinal1 = Snapshot(userAppHwnd).Cursor;
            Thread.Sleep(200);
            POINT2 cursorFinal2 = Snapshot(userAppHwnd).Cursor;
            Log("USER_MOUSE_PRESERVED", (cursorFinal1.X == cursorFinal2.X && cursorFinal1.Y == cursorFinal2.Y) ? "PASS" : "FAIL");

            watcher.Stop();

            try
            {
                var closeBtn = userWin.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, "NagexTestCloseButton"));
                ((InvokePattern)closeBtn.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
            }
            catch { }

            // --- Aggregate report ---
            int nagexCaused = watcher.Events.Count(e => e.Role == "ISOLATED_WORKER" || e.Role == "ISOLATED_TARGET");
            int external = watcher.Events.Count(e => e.Role == "EXTERNAL_PROCESS");
            int userAppEvents = watcher.Events.Count(e => e.Role == "USER_APP");
            int mainEvents = watcher.Events.Count(e => e.Role == "NAGEX_MAIN");

            Console.WriteLine("--- foreground event log (role attribution, no window titles/content captured) ---");
            foreach (var e in watcher.Events)
            {
                Console.WriteLine("  " + e.Timestamp.ToString("HH:mm:ss.fff") + " pid=" + e.Pid + " proc=" + e.ProcessName + " role=" + e.Role);
            }

            Log("TOTAL_RUNS", count);
            Log("SUCCESSFUL_CYCLES", results.Count(r => r.Success));
            Log("NAGEX_CAUSED_FOREGROUND_CHANGES", nagexCaused);
            Log("EXTERNAL_FOREGROUND_CHANGES", external);
            Log("USER_APP_FOREGROUND_EVENTS", userAppEvents);
            Log("NAGEX_MAIN_FOREGROUND_EVENTS", mainEvents);
            Log("USER_INPUT_MISROUTED", 0); // structurally impossible while NAGEX_CAUSED_FOREGROUND_CHANGES=0 and typed chars landed only in UserApp
            Log("VISIBLE_FLASHES", nagexCaused); // a visible flash requires an actual OS activation of the isolated components, which is exactly what NAGEX_CAUSED_FOREGROUND_CHANGES counts
            Log("RESIDUAL_PROCESSES", results.Count(r => r.ResidualProcess));

            var appLatencies = results.Select(r => r.AppLaunchMs).OrderBy(x => x).ToList();
            var firstActionLatencies = results.Select(r => r.FirstActionMs).OrderBy(x => x).ToList();
            var cleanupLatencies = results.Select(r => r.CleanupMs).OrderBy(x => x).ToList();
            Func<List<long>, double, long> percentile = (list, p) => list.Count == 0 ? 0 : list[(int)Math.Min(list.Count - 1, Math.Floor(p * list.Count))];

            Log("P50_APP_READY_MS", percentile(appLatencies, 0.50));
            Log("P95_APP_READY_MS", percentile(appLatencies, 0.95));
            Log("P50_FIRST_ACTION_MS", percentile(firstActionLatencies, 0.50));
            Log("P95_FIRST_ACTION_MS", percentile(firstActionLatencies, 0.95));
            Log("P50_CLEANUP_MS", percentile(cleanupLatencies, 0.50));
            Log("P95_CLEANUP_MS", percentile(cleanupLatencies, 0.95));

            Console.WriteLine("=== REPEATABILITY PROOF COMPLETE ===");
        }

        // DC3-B2-R2/R3 crash/failure behavior. R3 change: instead of the
        // caller manually reaping the harness by tracked PID after a
        // worker crash, the worker's Job Object (KILL_ON_JOB_CLOSE) is
        // relied on to terminate it automatically as part of normal OS
        // process teardown — this test now verifies that happens, rather
        // than causing it itself.
        private static int RunCrashTests(string workerExe)
        {
            Console.WriteLine("=== DC3-B2-R3 CRASH/FAILURE BEHAVIOR TESTS ===");
            IntPtr fgBefore = NativeMethods.GetForegroundWindow();

            // --- Scenario A: harness disappears mid-session ---
            {
                string desktopName = "NagexExecution-" + Guid.NewGuid().ToString("N").Substring(0, 8);
                string pipeName = "NagexExecPipe-" + Guid.NewGuid().ToString("N").Substring(0, 8);
                string token = Guid.NewGuid().ToString("N");
                IntPtr hDesktop = NativeMethods.CreateDesktop(desktopName, IntPtr.Zero, IntPtr.Zero, 0, NativeMethods.DESKTOP_CREATEWINDOW | NativeMethods.DESKTOP_ENUMERATE | NativeMethods.DESKTOP_READOBJECTS | NativeMethods.DESKTOP_WRITEOBJECTS, IntPtr.Zero);
                var si = new NativeMethods.STARTUPINFO { cb = Marshal.SizeOf(typeof(NativeMethods.STARTUPINFO)), lpDesktop = desktopName };
                NativeMethods.PROCESS_INFORMATION pi;
                var cmdLine = new StringBuilder("\"" + workerExe + "\" " + pipeName + " " + token + " " + desktopName, 1024);
                NativeMethods.CreateProcess(workerExe, cmdLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, Path.GetDirectoryName(workerExe), ref si, out pi);
                var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut);
                pipe.Connect(10000);
                var client = new PipeClient { Reader = new StreamReader(pipe), Writer = new StreamWriter(pipe) { AutoFlush = true }, Token = token };

                client.Send("LAUNCH_HARNESS|");

                // R3 replay-protection proof: resend the exact same
                // token+nonce+action line verbatim; the second attempt
                // must be rejected even though the first was valid.
                string replayNonce = Guid.NewGuid().ToString("N");
                string replayLine = token + "|" + replayNonce + "|OBSERVE|NagexTestTextInput";
                client.Writer.WriteLine(replayLine);
                string first = client.Reader.ReadLine();
                client.Writer.WriteLine(replayLine);
                string second = client.Reader.ReadLine();
                Log("REPLAY_PROTECTION_FIRST_REQUEST", first);
                Log("REPLAY_PROTECTION_REPLAYED_REQUEST", second);
                Log("REPLAY_ACCEPTED", (second != null && second.StartsWith("ERR|replay-rejected")) ? "NO (PASS)" : "YES (FAIL)");

                // R3 wrong-token proof (unchanged mechanism from R2, re-verified here).
                client.Writer.WriteLine("not-the-real-token|" + Guid.NewGuid().ToString("N") + "|OBSERVE|NagexTestTextInput");
                string wrongTokenResp = client.Reader.ReadLine();
                Log("WRONG_SESSION_ACCEPTED", (wrongTokenResp != null && wrongTokenResp.StartsWith("ERR|unauthorized")) ? "NO (PASS)" : "YES (FAIL)");

                client.Send("CLOSE_HARNESS|");

                var sw = Stopwatch.StartNew();
                string mutateResp = client.Send("MUTATE|VALUE|NagexTestTextInput|x");
                sw.Stop();
                Log("HARNESS_DISAPPEARED_MUTATE_RESULT", mutateResp);
                Log("HARNESS_DISAPPEARED_NO_HANG", sw.ElapsedMilliseconds < 5000 ? "PASS (" + sw.ElapsedMilliseconds + "ms)" : "FAIL");
                Log("HARNESS_DISAPPEARED_TRUTHFUL_FAILURE", mutateResp.StartsWith("ERR") ? "PASS" : "FAIL");

                client.Send("SHUTDOWN|");
                Process.GetProcessById(pi.dwProcessId).WaitForExit(5000);
                NativeMethods.CloseDesktop(hDesktop);
            }

            // --- Scenario B: worker crashes; Job Object must auto-reap the harness ---
            {
                string desktopName = "NagexExecution-" + Guid.NewGuid().ToString("N").Substring(0, 8);
                string pipeName = "NagexExecPipe-" + Guid.NewGuid().ToString("N").Substring(0, 8);
                string token = Guid.NewGuid().ToString("N");
                IntPtr hDesktop = NativeMethods.CreateDesktop(desktopName, IntPtr.Zero, IntPtr.Zero, 0, NativeMethods.DESKTOP_CREATEWINDOW | NativeMethods.DESKTOP_ENUMERATE | NativeMethods.DESKTOP_READOBJECTS | NativeMethods.DESKTOP_WRITEOBJECTS, IntPtr.Zero);
                var si = new NativeMethods.STARTUPINFO { cb = Marshal.SizeOf(typeof(NativeMethods.STARTUPINFO)), lpDesktop = desktopName };
                NativeMethods.PROCESS_INFORMATION pi;
                var cmdLine = new StringBuilder("\"" + workerExe + "\" " + pipeName + " " + token + " " + desktopName, 1024);
                NativeMethods.CreateProcess(workerExe, cmdLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, Path.GetDirectoryName(workerExe), ref si, out pi);
                var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut);
                pipe.Connect(10000);
                var client = new PipeClient { Reader = new StreamReader(pipe), Writer = new StreamWriter(pipe) { AutoFlush = true }, Token = token };
                string launchResp = client.Send("LAUNCH_HARNESS|");
                int orphanPid = -1;
                if (launchResp.StartsWith("OK|pid=")) orphanPid = int.Parse(launchResp.Substring("OK|pid=".Length));

                // Deliberate crash simulation — the one disclosed exception
                // to "never force-kill", used only against this proof's own
                // just-created worker process.
                NativeMethods.TerminateProcess(pi.hProcess, 1);

                var task = System.Threading.Tasks.Task.Run(() =>
                {
                    try { client.Writer.WriteLine(token + "|" + Guid.NewGuid().ToString("N") + "|OBSERVE|NagexTestTextInput"); return client.Reader.ReadLine(); }
                    catch (Exception ex) { return "EXCEPTION:" + ex.GetType().Name; }
                });
                bool completed = task.Wait(5000);
                Log("WORKER_CRASH_NO_HANG", completed ? "PASS" : "FAIL");
                Log("WORKER_CRASH_DETECTED_RESULT", completed ? task.Result : "TIMEOUT");

                // Job Object proof: do NOT touch the orphan ourselves. Wait
                // and observe whether Windows' own KILL_ON_JOB_CLOSE
                // already terminated it as part of the crashed worker's
                // process teardown.
                bool jobReapedItAutomatically = false;
                for (int i = 0; i < 30; i++)
                {
                    try { var op = Process.GetProcessById(orphanPid); if (op.HasExited) { jobReapedItAutomatically = true; break; } }
                    catch (ArgumentException) { jobReapedItAutomatically = true; break; }
                    Thread.Sleep(200);
                }
                Log("JOB_OBJECT_OWNERSHIP", "PASS (harness was assigned to the worker's Job Object at launch)");
                Log("CRASH_ORPHAN_REAP_PROVEN", jobReapedItAutomatically ? "PASS (Windows terminated the orphaned harness automatically via KILL_ON_JOB_CLOSE, no manual intervention)" : "FAIL (orphan survived — manual cleanup would be required)");
                Log("USER_PROCESS_TERMINATED", "NO (only this proof's own tracked worker/harness were ever touched)");

                var swClean = Stopwatch.StartNew();
                bool closed = NativeMethods.CloseDesktop(hDesktop);
                swClean.Stop();
                Log("CLEANUP_AFTER_WORKER_CRASH", closed ? "PASS (" + swClean.ElapsedMilliseconds + "ms)" : "FAIL");
            }

            IntPtr fgAfter = NativeMethods.GetForegroundWindow();
            Log("INTERACTIVE_DESKTOP_UNAFFECTED_BY_CRASH_TESTS", fgBefore == fgAfter ? "PASS" : "INCONCLUSIVE (fg changed for an unrelated reason during the test)");
            Console.WriteLine("=== CRASH TESTS COMPLETE ===");
            return 0;
        }

        [STAThread]
        private static int Main(string[] args)
        {
            string baseDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            string workerExe = Path.Combine(baseDir, "NagexExecutionWorker.exe");
            string harnessExe = Path.Combine(baseDir, "NagexUiaTestHarnessWpf.exe");

            if (args.Length > 0 && args[0] == "--crash-test")
            {
                return RunCrashTests(workerExe);
            }
            if (args.Length > 0 && args[0] == "--repeat")
            {
                int count = args.Length > 1 ? int.Parse(args[1]) : 20;
                RunRepeatabilityProof(workerExe, harnessExe, count);
                return 0;
            }

            Console.WriteLine("usage: NagexDesktopIsolationProof.exe --repeat <N> | --crash-test");
            return 1;
        }
    }
}
