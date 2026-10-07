// Compiled for each invocation. Only this helper touches the binary transport.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public sealed class ContainedLauncher
{
    const int FrameLimit = 1024 * 1024, ChunkLimit = 65536, CleanupMs = 5000;
    const uint KillOnClose = 0x2000, Infinite = 0xffffffff, WaitTimeout = 258;
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    public sealed class Owner { public int pid; public string creationFiletime; }
    public sealed class Config {
        public string executable, cwd, jobName;
        public string[] args;
        public Dictionary<string, string> env;
        public int timeoutMs, maxOutputBytes;
        public Owner owner;
    }
    [StructLayout(LayoutKind.Sequential)] struct Security { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public int cb; public IntPtr reserved, desktop, title;
        public uint x, y, xSize, ySize, xCount, yCount, fill, flags;
        public ushort show, reservedSize; public IntPtr reservedBytes, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking;
        public uint activeLimit; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long userTime, kernelTime, periodUser, periodKernel;
        public uint faults, total, active, terminated;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr key, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr handle, byte[] bytes, uint count, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr handle, byte[] bytes, uint count, out uint written, IntPtr overlapped);

    readonly Stream input = Console.OpenStandardInput(), output = Console.OpenStandardOutput();
    readonly object sendLock = new object(), captureLock = new object();
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = FrameLimit, RecursionLimit = 32 };
    IntPtr job;
    int captured, outBytes, errBytes;
    volatile bool overflow, transportFailed;
    Config config;

    static void Require(bool ok, string code) { if (!ok) throw new InvalidOperationException(code); }
    static void Native(bool ok, string code) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), code); }
    static void Close(ref IntPtr value) { if (value != IntPtr.Zero) { CloseHandle(value); value = IntPtr.Zero; } }
    static int Active(IntPtr handle) {
        Accounting a;
        Native(QueryInformationJobObject(handle, 1, out a, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "job-accounting-failed");
        return checked((int)a.active);
    }
    public static string ProbeJob(string name) {
        IntPtr handle = OpenJobObjectW(4, false, name);
        // An absent kernel object alone is not evidence of zero active processes.
        if (handle == IntPtr.Zero) return "unknown";
        try { return Active(handle) == 0 ? "empty" : "active"; }
        catch { return "unknown"; }
        finally { CloseHandle(handle); }
    }
    static string Quote(string value) {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            slashes = 0; result.Append(c);
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    byte[] ReadExactly(int length) {
        byte[] bytes = new byte[length]; int offset = 0;
        while (offset < length) { int n = input.Read(bytes, offset, length - offset); if (n == 0) throw new EndOfStreamException("transport-eof"); offset += n; }
        return bytes;
    }
    byte[] ReadFrame(out byte kind) {
        uint length = BitConverter.ToUInt32(ReadExactly(4), 0);
        Require(length >= 1 && length <= FrameLimit, "invalid-frame-length");
        kind = ReadExactly(1)[0];
        Require(kind == 1 || length <= ChunkLimit + 1, "oversized-input-frame");
        return ReadExactly((int)length - 1);
    }
    void Send(byte kind, byte[] bytes, int length) {
        Require(length < FrameLimit, "oversized-output-frame");
        lock (sendLock) {
            byte[] header = BitConverter.GetBytes(length + 1);
            output.Write(header, 0, 4); output.WriteByte(kind); output.Write(bytes, 0, length); output.Flush();
        }
    }
    void SendJson(byte kind, object value) { byte[] bytes = Utf8.GetBytes(json.Serialize(value)); Send(kind, bytes, bytes.Length); }
    void Stop() { if (job != IntPtr.Zero) TerminateJobObject(job, 1); }
    Thread PumpOutput(IntPtr handle, byte kind) {
        Thread thread = new Thread(delegate() {
            try {
                byte[] bytes = new byte[ChunkLimit]; uint n;
                while (true) {
                    if (!ReadFile(handle, bytes, (uint)bytes.Length, out n, IntPtr.Zero)) {
                        Require(Marshal.GetLastWin32Error() == 109, "output-read-failed"); break;
                    }
                    if (n == 0) break;
                    // Serialize allocation of the combined cap, but never block the watchdog.
                    lock (captureLock) {
                        int keep = Math.Min((int)n, config.maxOutputBytes - captured);
                        captured += keep;
                        if (kind == 4) outBytes += keep; else errBytes += keep;
                        if (keep < n) { overflow = true; Stop(); }
                        if (keep > 0) Send(kind, bytes, keep);
                    }
                }
            } catch { transportFailed = true; Stop(); }
        });
        thread.IsBackground = true; thread.Start(); return thread;
    }
    Thread PumpInput(IntPtr handle) {
        Thread thread = new Thread(delegate() {
            try {
                int total = 0; bool childClosed = false;
                while (true) {
                    byte kind; byte[] bytes = ReadFrame(out kind);
                    if (kind == 3) { Require(bytes.Length == 0, "invalid-stdin-eof"); break; }
                    Require(kind == 2, "invalid-stdin-frame");
                    total = checked(total + bytes.Length); Require(total <= 16 * 1024 * 1024, "stdin-limit");
                    if (childClosed) continue;
                    uint n;
                    // Synchronous pipe writes apply backpressure all the way to Node.
                    if (!WriteFile(handle, bytes, (uint)bytes.Length, out n, IntPtr.Zero)) {
                        int error = Marshal.GetLastWin32Error();
                        Require(error == 109 || error == 232, "stdin-write-failed"); childClosed = true;
                    } else Require(n == bytes.Length, "stdin-short-write");
                }
            } catch { transportFailed = true; Stop(); }
            finally { CloseHandle(handle); }
        });
        thread.IsBackground = true; thread.Start(); return thread;
    }
    static bool OwnerAlive(IntPtr owner) { return WaitForSingleObject(owner, 0) == WaitTimeout; }
    void Execute(double compileMs) {
        IntPtr owner = IntPtr.Zero, stdinRead = IntPtr.Zero, stdinWrite = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero, stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero, environment = IntPtr.Zero;
        bool attributesReady = false, timedOut = false, ownerLost = false;
        object empty = "unknown"; string failure = null;
        ProcessInfo process = new ProcessInfo(); uint exitCode = 1;
        Thread outPump = null, errPump = null;
        Stopwatch elapsed = Stopwatch.StartNew();
        try {
            byte kind; byte[] frame = ReadFrame(out kind); Require(kind == 1, "config-first-required");
            config = json.Deserialize<Config>(Utf8.GetString(frame));
            Require(config != null && config.owner != null && config.owner.pid > 0, "invalid-owner");
            Require(config.timeoutMs > 0 && config.timeoutMs <= 1800000 && config.maxOutputBytes > 0 && config.maxOutputBytes <= 16 * 1024 * 1024, "invalid-limits");
            Require(Path.IsPathRooted(config.executable) && Path.IsPathRooted(config.cwd) && config.args != null && config.env != null, "invalid-config");
            owner = OpenProcess(0x100000 | 0x1000, false, config.owner.pid);
            Native(owner != IntPtr.Zero, "owner-open-failed");
            long created, exited, kernel, user;
            Native(GetProcessTimes(owner, out created, out exited, out kernel, out user), "owner-identity-failed");
            Require(created.ToString(System.Globalization.CultureInfo.InvariantCulture) == config.owner.creationFiletime && OwnerAlive(owner), "owner-identity-mismatch");
            job = CreateJobObjectW(IntPtr.Zero, config.jobName);
            int jobError = Marshal.GetLastWin32Error();
            Native(job != IntPtr.Zero, "job-create-failed");
            if (jobError == 183) { Close(ref job); throw new InvalidOperationException("job-already-exists"); }
            ExtendedLimit limits = new ExtendedLimit(); limits.basic.flags = KillOnClose;
            Native(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit))), "job-limits-failed");
            Security security = new Security { length = Marshal.SizeOf(typeof(Security)), inherit = 1 };
            Native(CreatePipe(out stdinRead, out stdinWrite, ref security, ChunkLimit), "stdin-pipe-failed");
            Native(CreatePipe(out stdoutRead, out stdoutWrite, ref security, ChunkLimit), "stdout-pipe-failed");
            Native(CreatePipe(out stderrRead, out stderrWrite, ref security, ChunkLimit), "stderr-pipe-failed");
            Native(SetHandleInformation(stdinWrite, 1, 0) && SetHandleInformation(stdoutRead, 1, 0) && SetHandleInformation(stderrRead, 1, 0), "pipe-inheritance-failed");
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            Require(size != IntPtr.Zero, "attribute-size-failed");
            attributes = Marshal.AllocHGlobal(size);
            Native(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "attribute-init-failed"); attributesReady = true;
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
            Marshal.WriteIntPtr(handles, 0, stdinRead); Marshal.WriteIntPtr(handles, IntPtr.Size, stdoutWrite); Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, stderrWrite);
            jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
            Native(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "handle-list-failed");
            Native(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000d), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "job-list-unavailable");
            List<string> keys = new List<string>(config.env.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
            StringBuilder block = new StringBuilder(); string previous = null;
            foreach (string key in keys) {
                string value = config.env[key];
                Require(key.Length > 0 && key.IndexOfAny(new char[] { '=', '\0' }) < 0 && value != null && value.IndexOf('\0') < 0 && !String.Equals(previous, key, StringComparison.OrdinalIgnoreCase), "invalid-environment");
                block.Append(key).Append('=').Append(value).Append('\0'); previous = key;
            }
            block.Append('\0'); if (keys.Count == 0) block.Append('\0');
            environment = Marshal.StringToHGlobalUni(block.ToString());
            StringBuilder command = new StringBuilder(Quote(config.executable));
            foreach (string arg in config.args) { Require(arg != null && arg.IndexOf('\0') < 0, "invalid-argv"); command.Append(' ').Append(Quote(arg)); }
            Require(command.Length < 32767, "command-line-too-long");
            StartupEx startup = new StartupEx(); startup.info.cb = Marshal.SizeOf(typeof(StartupEx));
            startup.info.flags = 0x100; startup.info.stdin = stdinRead; startup.info.stdout = stdoutWrite; startup.info.stderr = stderrWrite; startup.attributes = attributes;
            // Job membership is atomic with creation; the child never runs outside the job.
            Native(CreateProcessW(config.executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 0x400 | 0x8000000, environment, config.cwd, ref startup, out process), "create-process-failed");
            Close(ref process.thread); Close(ref stdinRead); Close(ref stdoutWrite); Close(ref stderrWrite);
            elapsed.Restart();
            outPump = PumpOutput(stdoutRead, 4); errPump = PumpOutput(stderrRead, 5);
            PumpInput(stdinWrite); stdinWrite = IntPtr.Zero; // ownership transfers to the input thread
            while (WaitForSingleObject(process.process, 10) == WaitTimeout) {
                if (!OwnerAlive(owner)) { ownerLost = true; break; }
                if (elapsed.ElapsedMilliseconds >= config.timeoutMs) { timedOut = true; break; }
                if (overflow || transportFailed) break;
            }
        } catch (Exception error) {
            // Deliberately omit environment, argv and child output from diagnostics.
            Win32Exception native = error as Win32Exception;
            failure = native == null ? error.Message : error.Message + ":" + native.NativeErrorCode;
        } finally {
            if (job != IntPtr.Zero) {
                Stop();
                Stopwatch cleanup = Stopwatch.StartNew();
                try {
                    while (Active(job) != 0 && cleanup.ElapsedMilliseconds < CleanupMs) Thread.Sleep(10);
                    empty = Active(job) == 0 ? (object)true : (object)false;
                } catch { empty = "unknown"; }
            }
            if (process.process != IntPtr.Zero) {
                if (WaitForSingleObject(process.process, CleanupMs) != 0 || !GetExitCodeProcess(process.process, out exitCode)) failure = failure ?? "exit-code-unavailable";
            }
            if (!ownerLost) {
                if (outPump != null && !outPump.Join(CleanupMs)) transportFailed = true;
                if (errPump != null && !errPump.Join(CleanupMs)) transportFailed = true;
            }
            Close(ref job); Close(ref owner); Close(ref process.process); Close(ref process.thread);
            Close(ref stdinRead); Close(ref stdinWrite); Close(ref stdoutRead); Close(ref stdoutWrite); Close(ref stderrRead); Close(ref stderrWrite);
            if (attributesReady) DeleteProcThreadAttributeList(attributes);
            foreach (IntPtr allocation in new IntPtr[] { attributes, handles, jobs, environment }) if (allocation != IntPtr.Zero) Marshal.FreeHGlobal(allocation);
        }
        // Node may have disappeared while a pump was blocked. Exit closes every handle.
        if (ownerLost || transportFailed) return;
        SendJson(6, new { containment = "windows-job-v1", containmentEmpty = empty, exitCode = exitCode,
            timedOut = timedOut, outputLimitExceeded = overflow, stdoutBytes = outBytes, stderrBytes = errBytes,
            compileMs = compileMs, executionMs = elapsed.Elapsed.TotalMilliseconds, error = failure });
    }
    public static void Run(double compileMs) { new ContainedLauncher().Execute(compileMs); }
}
