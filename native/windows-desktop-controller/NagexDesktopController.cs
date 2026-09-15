// NAgex DC3-B2 Production — Isolated Windows Desktop Execution Controller.
//
// Spawned by NAgex Main (Node) as a direct child process, one per active
// DesktopExecutionSession, and driven over its own stdin/stdout using
// newline-delimited JSON — a private channel by construction (only the
// parent process that spawned it can write to its stdin), so this
// boundary needs no separate token of its own. It owns everything below
// it: creates a uniquely-named, isolated Win32 desktop object (never
// switched to be visible — SwitchDesktop is never called here), launches
// DesktopWorker.exe onto that desktop, and relays each command to it over
// a local, token-and-nonce-authenticated, ACL-restricted named pipe (that
// hardening lives in DesktopWorker.cs, since the pipe — unlike this
// process's own stdio — is an OS-addressable object other local processes
// could otherwise try to reach).
//
// Lifecycle: create desktop -> create worker (Job-Object-owned) -> relay
// commands -> graceful SHUTDOWN -> close desktop. Never SendInput. Never
// kills by process/executable name — the only termination path here is
// the worker's own Job Object (KILL_ON_JOB_CLOSE), which this controller
// never even has to invoke directly; it is a pure consequence of the
// worker process's own handle to its job closing when the worker exits
// (gracefully or otherwise).
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

namespace NagexDesktopController
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

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateDesktop(string lpszDesktop, IntPtr lpszDevice, IntPtr pDevmode, int dwFlags, uint dwDesiredAccess, IntPtr lpsa);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool CloseDesktop(IntPtr hDesktop);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcess(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        public const uint DESKTOP_CREATEWINDOW = 0x0002, DESKTOP_ENUMERATE = 0x0040, DESKTOP_READOBJECTS = 0x0001, DESKTOP_WRITEOBJECTS = 0x0080;
    }

    internal class NodeCommand
    {
        public string cmd; // INIT | OPEN_APP | OBSERVE | MUTATE | CLOSE_APP | CANCEL | SHUTDOWN
        public string requestId;
        public string appExePath, appArgs;
        public string pattern; // MUTATE only: SET_VALUE|INVOKE|TOGGLE|SELECT|SCROLL
        public string target, value;
    }

    internal class NodeResponse
    {
        public string requestId;
        public string status;
        public string observedBefore, observedAfter;
        public bool verification;
        public string errorCode;
        public int matchCount = -1;
    }

    internal static class Program
    {
        private const string ProtocolVersion = "1.0";
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        private static IntPtr _hDesktop = IntPtr.Zero;
        private static Process _workerProcess;
        private static NamedPipeClientStream _pipe;
        private static StreamReader _pipeReader;
        private static StreamWriter _pipeWriter;
        private static string _workerToken;

        private static void Reply(NodeResponse r) { Console.Out.WriteLine(Json.Serialize(r)); Console.Out.Flush(); }

        private static int Main(string[] args)
        {
            // .NET Framework console apps default Console.In/Out to the
            // system codepage, not UTF-8, unless told otherwise — a real
            // bug found via production acceptance testing: this repo's own
            // path contains non-ASCII (Korean) characters, and Node writes
            // UTF-8 to this process's stdin by default, so without this
            // the appExePath JSON field arrives corrupted.
            Console.InputEncoding = System.Text.Encoding.UTF8;
            Console.OutputEncoding = System.Text.Encoding.UTF8;

            string baseDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            string workerExe = Path.Combine(baseDir, "DesktopWorker.exe");

            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                NodeCommand cmd;
                try { cmd = Json.Deserialize<NodeCommand>(line); }
                catch { Reply(new NodeResponse { status = "ERR", errorCode = "SCHEMA_INVALID" }); continue; }
                if (cmd == null) { continue; }

                try
                {
                    switch (cmd.cmd)
                    {
                        case "INIT":
                            HandleInit(cmd, workerExe);
                            break;
                        case "OPEN_APP":
                            ForwardToWorker(new { protocolVersion = ProtocolVersion, token = _workerToken, nonce = Guid.NewGuid().ToString("N"), requestId = cmd.requestId, action = "OPEN_APP", appExePath = cmd.appExePath, appArgs = cmd.appArgs });
                            break;
                        case "OBSERVE":
                            ForwardToWorker(new { protocolVersion = ProtocolVersion, token = _workerToken, nonce = Guid.NewGuid().ToString("N"), requestId = cmd.requestId, action = "OBSERVE", target = cmd.target });
                            break;
                        case "MUTATE":
                            ForwardToWorker(new { protocolVersion = ProtocolVersion, token = _workerToken, nonce = Guid.NewGuid().ToString("N"), requestId = cmd.requestId, action = cmd.pattern, target = cmd.target, value = cmd.value });
                            break;
                        case "CLOSE_APP":
                            ForwardToWorker(new { protocolVersion = ProtocolVersion, token = _workerToken, nonce = Guid.NewGuid().ToString("N"), requestId = cmd.requestId, action = "CLOSE_APP" });
                            break;
                        case "CANCEL":
                            ForwardToWorker(new { protocolVersion = ProtocolVersion, token = _workerToken, nonce = Guid.NewGuid().ToString("N"), requestId = cmd.requestId, action = "CANCEL" });
                            break;
                        case "SHUTDOWN":
                            HandleShutdown(cmd);
                            return 0;
                        default:
                            Reply(new NodeResponse { requestId = cmd.requestId, status = "ERR", errorCode = "UNKNOWN_COMMAND" });
                            break;
                    }
                }
                catch (Exception ex)
                {
                    Reply(new NodeResponse { requestId = cmd.requestId, status = "ERR", errorCode = "CONTROLLER_EXCEPTION:" + ex.GetType().Name });
                }
            }

            HandleShutdown(new NodeCommand { requestId = null });
            return 0;
        }

        private static void HandleInit(NodeCommand cmd, string workerExe)
        {
            string desktopName = "NagexExecution-" + Guid.NewGuid().ToString("N").Substring(0, 12);
            string pipeName = "NagexExecPipe-" + Guid.NewGuid().ToString("N").Substring(0, 12);
            _workerToken = Guid.NewGuid().ToString("N");

            uint access = NativeMethods.DESKTOP_CREATEWINDOW | NativeMethods.DESKTOP_ENUMERATE | NativeMethods.DESKTOP_READOBJECTS | NativeMethods.DESKTOP_WRITEOBJECTS;
            _hDesktop = NativeMethods.CreateDesktop(desktopName, IntPtr.Zero, IntPtr.Zero, 0, access, IntPtr.Zero);
            if (_hDesktop == IntPtr.Zero)
            {
                Reply(new NodeResponse { requestId = cmd.requestId, status = "ERR", errorCode = "DESKTOP_CREATE_FAILED" });
                return;
            }

            var si = new NativeMethods.STARTUPINFO { cb = Marshal.SizeOf(typeof(NativeMethods.STARTUPINFO)), lpDesktop = desktopName };
            NativeMethods.PROCESS_INFORMATION pi;
            var cmdLine = new StringBuilder("\"" + workerExe + "\" " + pipeName + " " + _workerToken, 1024);
            bool created = NativeMethods.CreateProcess(workerExe, cmdLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, Path.GetDirectoryName(workerExe), ref si, out pi);
            if (!created)
            {
                Reply(new NodeResponse { requestId = cmd.requestId, status = "ERR", errorCode = "WORKER_CREATE_FAILED" });
                NativeMethods.CloseDesktop(_hDesktop);
                _hDesktop = IntPtr.Zero;
                return;
            }
            _workerProcess = Process.GetProcessById(pi.dwProcessId);

            _pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut);
            try { _pipe.Connect(10000); }
            catch (Exception ex)
            {
                Reply(new NodeResponse { requestId = cmd.requestId, status = "ERR", errorCode = "PIPE_CONNECT_FAILED:" + ex.Message });
                return;
            }
            _pipeReader = new StreamReader(_pipe);
            _pipeWriter = new StreamWriter(_pipe) { AutoFlush = true };

            Reply(new NodeResponse { requestId = cmd.requestId, status = "OK" });
        }

        private static void ForwardToWorker(object requestObj)
        {
            if (_pipeWriter == null) { Reply(new NodeResponse { status = "ERR", errorCode = "NOT_INITIALIZED" }); return; }
            string json = Json.Serialize(requestObj);
            _pipeWriter.WriteLine(json);
            string resp = _pipeReader.ReadLine();
            Console.Out.WriteLine(resp ?? Json.Serialize(new NodeResponse { status = "ERR", errorCode = "WORKER_PIPE_CLOSED" }));
            Console.Out.Flush();
        }

        private static void HandleShutdown(NodeCommand cmd)
        {
            try
            {
                if (_pipeWriter != null)
                {
                    _pipeWriter.WriteLine(Json.Serialize(new { protocolVersion = ProtocolVersion, token = _workerToken, nonce = Guid.NewGuid().ToString("N"), requestId = cmd.requestId, action = "SHUTDOWN" }));
                    try { _pipeReader.ReadLine(); } catch { }
                }
                if (_workerProcess != null) _workerProcess.WaitForExit(5000);
            }
            catch { }
            finally
            {
                if (_hDesktop != IntPtr.Zero) { NativeMethods.CloseDesktop(_hDesktop); _hDesktop = IntPtr.Zero; }
                Reply(new NodeResponse { requestId = cmd.requestId, status = "OK" });
            }
        }
    }
}
