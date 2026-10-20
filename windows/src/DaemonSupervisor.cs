using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Timer = System.Windows.Forms.Timer;

namespace Switchboard
{
    /// Owns the Node daemon child process and the live state the menu renders.
    /// One instance, used only from the UI thread; Process callbacks are marshalled
    /// back onto it through the WinForms SynchronizationContext.
    sealed class DaemonSupervisor
    {
        public event Action Changed;

        // Connection / identity
        public ConnState State { get; private set; } = ConnState.Stopped;
        public string MachineName { get; private set; }
        public string Mode { get; private set; }            // "account" | "token"
        public string Account { get; private set; }
        public string DashboardUrl { get; private set; }
        public string ShareUrl { get; private set; }
        public bool PeerOnline { get; private set; }
        public bool RuntimeMissing { get; private set; }

        // Host stats (null until the first `stats` tick)
        public double? Cpu { get; private set; }
        public double? MemUsed { get; private set; }
        public double? MemTotal { get; private set; }
        public int? Cores { get; private set; }
        public double? Rtt { get; private set; }

        /// How the last stop went: the daemon acknowledged it (`stopping`) and
        /// exited on its own, rather than being killed. --selftest asserts this.
        public bool LastStopWasGraceful { get; private set; }

        public bool IsRunning => process != null;

        // A daemon told to stop gets this long to reap its shells before the
        // whole process tree is killed.
        const int StopGraceMs = 5000;

        readonly Prefs prefs;
        readonly SynchronizationContext ui;

        Process process;
        bool intentionalStop;
        bool forceKilled;
        bool sawStopping;
        FatalReason? pendingFatal;
        Action afterExit;            // queued Restart / Sign in, run once the old daemon is gone

        string statusPath;
        FileStream statusStream;
        Decoder statusDecoder;
        readonly StringBuilder lineBuffer = new StringBuilder();
        readonly Timer statusTimer = new Timer { Interval = 350 };
        readonly Timer restartTimer = new Timer();
        readonly Timer killTimer = new Timer { Interval = StopGraceMs };
        int backoffMs = 1000;

        // Crash rollback for hot-updated cli code: if a launch that ran a staged
        // update dies twice in a row within seconds, drop the update and let the
        // bundled cli take the next restart.
        DateTime lastLaunch;
        bool lastLaunchWasHotUpdate;
        int hotUpdateStrikes;

        readonly object logLock = new object();
        StreamWriter logWriter;

        public DaemonSupervisor(Prefs prefs)
        {
            this.prefs = prefs;
            ui = SynchronizationContext.Current
                ?? throw new InvalidOperationException("DaemonSupervisor needs a UI SynchronizationContext");
            statusTimer.Tick += (s, e) => DrainStatus();
            restartTimer.Tick += (s, e) => { restartTimer.Stop(); Start(); };
            killTimer.Tick += (s, e) => { killTimer.Stop(); KillTree(); };
        }

        // MARK: Lifecycle

        public void Start(bool login = false)
        {
            if (process != null) return;
            CancelRestart();
            var rt = NodeRuntime.Resolve();
            if (rt == null)
            {
                RuntimeMissing = true;
                SetState(ConnState.Fatal(FatalReason.Crashed));
                return;
            }
            RuntimeMissing = false;
            intentionalStop = false;
            forceKilled = false;
            sawStopping = false;
            pendingFatal = null;

            // A fresh status file per launch, so offsets reset cleanly on restart.
            statusPath = Path.Combine(Path.GetTempPath(),
                $"switchboard-status-{Process.GetCurrentProcess().Id}-{DateTime.UtcNow.Ticks}.ndjson");
            try
            {
                File.WriteAllBytes(statusPath, new byte[0]);
                // Node appends with its own open/close per line; share everything.
                statusStream = new FileStream(statusPath, FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete);
            }
            catch (Exception)
            {
                SetState(ConnState.Fatal(FatalReason.Crashed));
                return;
            }
            statusDecoder = new UTF8Encoding(false).GetDecoder();
            lineBuffer.Clear();

            var psi = new ProcessStartInfo
            {
                FileName = rt.Node,
                Arguments = Quote(rt.Cli) + (login ? " login" : ""),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            };
            var env = psi.EnvironmentVariables;
            env["SWITCHBOARD_STATUS_FILE"] = statusPath;
            env["SWITCHBOARD_SERVER"] = prefs.NormalizedServer;
            // There is no signal to send a windowless child on Windows; closing
            // its stdin is how Stop() asks it to shut down (see cli/index.js).
            env["SWITCHBOARD_STOP_ON_STDIN_EOF"] = "1";
            if (!string.IsNullOrWhiteSpace(prefs.Shell)) env["SWITCHBOARD_SHELL"] = prefs.Shell.Trim();
            // Only ever set to decline: absent means the daemon's own default (on).
            if (!prefs.Peer) env["SWITCHBOARD_PEER"] = "0";
            if (rt.NodePathDir != null) env["NODE_PATH"] = rt.NodePathDir;

            lastLaunch = DateTime.UtcNow;
            lastLaunchWasHotUpdate = rt.IsHotUpdate;

            var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
            // Daemon logs (human-readable) go to a log file; status flows via the
            // NDJSON file above.
            p.OutputDataReceived += (s, e) => { if (e.Data != null) WriteLog(e.Data); };
            p.ErrorDataReceived += (s, e) => { if (e.Data != null) WriteLog(e.Data); };
            p.Exited += (s, e) => ui.Post(_ => HandleTermination(p), null);

            OpenLog();
            try
            {
                p.Start();
            }
            catch (Exception ex) when (ex is Win32Exception || ex is InvalidOperationException)
            {
                WriteLog("[app] could not start " + rt.Node + ": " + ex.Message);
                CloseStatus();
                SetState(ConnState.Fatal(FatalReason.Crashed));
                return;
            }
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            process = p;
            WriteLog($"[app] started daemon pid {p.Id}: {rt.Cli}{(login ? " login" : "")}");
            SetState(ConnState.Starting);
            statusTimer.Start();
        }

        public void Stop()
        {
            intentionalStop = true;
            CancelRestart();
            if (process == null)
            {
                SetState(ConnState.Stopped);
                return;
            }
            try { process.StandardInput.Close(); } catch (Exception) { }
            // HandleTermination flips state to Stopped when the process actually dies.
            killTimer.Stop();
            killTimer.Start();
        }

        /// Synchronous stop for app exit: there is no message loop left to wait on.
        public void StopAndWait()
        {
            intentionalStop = true;
            CancelRestart();
            var p = process;
            if (p == null) return;
            try { p.StandardInput.Close(); } catch (Exception) { }
            bool exited;
            try { exited = p.WaitForExit(StopGraceMs); } catch (Exception) { exited = true; }
            if (!exited) KillTree();
        }

        public void Restart()
        {
            if (process == null) { Start(); return; }
            afterExit = () => Start();
            Stop();
        }

        public void SignIn()
        {
            if (process == null) { Start(login: true); return; }
            afterExit = () => Start(login: true);
            Stop();
        }

        /// Runs `node cli logout` once and stops the daemon; `done` fires (on the
        /// UI thread) once the credential is gone.
        public void SignOut(Action done)
        {
            Stop();
            var rt = NodeRuntime.Resolve();
            if (rt == null) { done?.Invoke(); return; }
            var psi = new ProcessStartInfo
            {
                FileName = rt.Node,
                Arguments = Quote(rt.Cli) + " logout",
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            if (rt.NodePathDir != null) psi.EnvironmentVariables["NODE_PATH"] = rt.NodePathDir;
            try
            {
                var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
                p.Exited += (s, e) => ui.Post(_ =>
                {
                    Account = null;
                    Mode = null;
                    p.Dispose();
                    done?.Invoke();
                    Changed?.Invoke();
                }, null);
                p.Start();
            }
            catch (Exception)
            {
                done?.Invoke();
            }
        }

        // MARK: Actions

        public void OpenDashboard()
        {
            var url = DashboardUrl ?? ShareUrl;
            if (url == null) return;
            // Hand only web URLs to the shell: anything else would be a program to run.
            if (!Uri.TryCreate(url, UriKind.Absolute, out var u) ||
                (u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeHttp)) return;
            try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); }
            catch (Exception) { }
        }

        public void CopyShareUrl()
        {
            if (ShareUrl == null) return;
            try { Clipboard.SetText(ShareUrl); } catch (Exception) { }
        }

        // MARK: Termination & restart

        void HandleTermination(Process p)
        {
            if (p != process) return; // a stale exit from a process we already let go
            int code;
            try { code = p.ExitCode; } catch (Exception) { code = -1; }
            process = null;
            killTimer.Stop();
            // Drain any final status lines the daemon wrote on its way out.
            DrainStatus();
            statusTimer.Stop();
            CloseStatus();
            // Not disposed and not waited on: the async log readers finish on their
            // own, and an unbounded WaitForExit() would hang the UI on any
            // grandchild still holding the daemon's stdout.
            WriteLog($"[app] daemon exited with code {code}{(forceKilled ? " (killed)" : "")}");

            LastStopWasGraceful = intentionalStop && sawStopping && !forceKilled;

            if (afterExit != null)
            {
                var next = afterExit;
                afterExit = null;
                SetState(ConnState.Stopped);
                next();
                return;
            }
            if (intentionalStop)
            {
                SetState(ConnState.Stopped);
                return;
            }
            if (pendingFatal is FatalReason fatal)
            {
                SetState(ConnState.Fatal(fatal));
                return;
            }
            // A hot-updated cli that dies almost immediately is presumed broken:
            // two strikes and the staged update is dropped, so the restart below
            // resolves back to the known-good bundled cli.
            if (lastLaunchWasHotUpdate && (DateTime.UtcNow - lastLaunch).TotalSeconds < 20)
            {
                hotUpdateStrikes++;
                if (hotUpdateStrikes >= 2)
                {
                    DaemonUpdater.RevertToBundled(
                        $"daemon exited {hotUpdateStrikes}x within 20s of start (code {code})");
                    hotUpdateStrikes = 0;
                }
            }
            // Unexpected exit with no fatal marker — treat as a crash and retry with
            // backoff. A clean `connected`/`ready` resets the backoff to 1s.
            ScheduleRestart();
        }

        void ScheduleRestart()
        {
            CancelRestart();
            var delayMs = backoffMs;
            SetState(ConnState.Reconnecting(delayMs));
            restartTimer.Interval = Math.Max(1, delayMs);
            restartTimer.Start();
            backoffMs = Math.Min(backoffMs * 2, 15000);
        }

        void CancelRestart() => restartTimer.Stop();

        void KillTree()
        {
            var p = process;
            if (p == null) return;
            forceKilled = true;
            int pid;
            try { pid = p.Id; } catch (Exception) { return; }
            WriteLog($"[app] daemon did not stop within {StopGraceMs / 1000}s; killing process tree {pid}");
            // .NET Framework's Process.Kill() takes only the node process, which
            // would orphan the shells it spawned; taskkill /T takes the tree.
            try
            {
                using (var tk = Process.Start(new ProcessStartInfo("taskkill.exe", $"/PID {pid} /T /F")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                }))
                {
                    tk?.WaitForExit(5000);
                }
            }
            catch (Exception) { }
            try { if (!p.HasExited) p.Kill(); } catch (Exception) { }
        }

        // MARK: Status file polling

        readonly byte[] readBuf = new byte[16 * 1024];
        readonly char[] charBuf = new char[16 * 1024 + 4];

        void DrainStatus()
        {
            if (statusStream == null) return;
            try
            {
                int n;
                while ((n = statusStream.Read(readBuf, 0, readBuf.Length)) > 0)
                {
                    int chars = statusDecoder.GetChars(readBuf, 0, n, charBuf, 0);
                    lineBuffer.Append(charBuf, 0, chars);
                }
            }
            catch (IOException) { return; }

            var changed = false;
            while (true)
            {
                var s = lineBuffer.ToString();
                var nl = s.IndexOf('\n');
                if (nl < 0) break;
                var line = s.Substring(0, nl).TrimEnd('\r');
                lineBuffer.Remove(0, nl + 1);
                var ev = StatusEvent.Parse(line);
                if (ev != null) { Apply(ev); changed = true; }
            }
            if (changed) Changed?.Invoke();
        }

        void CloseStatus()
        {
            try { statusStream?.Dispose(); } catch (Exception) { }
            statusStream = null;
            if (statusPath != null)
            {
                try { File.Delete(statusPath); } catch (Exception) { }
                statusPath = null;
            }
        }

        void Apply(StatusEvent e)
        {
            switch (e.Ev)
            {
                case "connecting":
                    Mode = e.Mode ?? Mode;
                    if (State == ConnState.Starting || State == ConnState.Stopped) State = ConnState.Connecting;
                    break;
                case "connected":
                    backoffMs = 1000;
                    hotUpdateStrikes = 0;
                    Mode = e.Mode ?? Mode;
                    State = ConnState.Online;
                    break;
                case "ready":
                    backoffMs = 1000;
                    hotUpdateStrikes = 0;
                    Mode = e.Mode ?? Mode;
                    MachineName = e.Machine ?? MachineName;
                    Account = e.Account ?? Account;
                    DashboardUrl = e.DashboardUrl ?? DashboardUrl;
                    ShareUrl = e.ShareUrl;
                    State = ConnState.Online;
                    break;
                case "stats":
                    Cpu = e.Cpu; MemUsed = e.MemUsed; MemTotal = e.MemTotal;
                    Cores = e.Cores; Rtt = e.Rtt;
                    if (!State.IsRunningish || State == ConnState.Starting) State = ConnState.Online;
                    break;
                case "peer":
                    PeerOnline = e.Online ?? false;
                    break;
                case "disconnected":
                    PeerOnline = false;
                    State = ConnState.Reconnecting((int)(e.RetryInMs ?? 1000));
                    break;
                case "fatal":
                    var reason = ConnState.ParseReason(e.Reason);
                    pendingFatal = reason;
                    State = ConnState.Fatal(reason);
                    break;
                case "stopping":
                    sawStopping = true;
                    intentionalStop = true;
                    break;
            }
        }

        void SetState(ConnState s)
        {
            State = s;
            Changed?.Invoke();
        }

        // MARK: Logging

        public static string LogPath => Path.Combine(Paths.LogsDir, "daemon.log");

        void OpenLog()
        {
            lock (logLock)
            {
                try
                {
                    Directory.CreateDirectory(Paths.LogsDir);
                    // Keep one generation: plenty to debug with, never unbounded.
                    var info = new FileInfo(LogPath);
                    if (info.Exists && info.Length > 5 * 1024 * 1024)
                    {
                        logWriter?.Dispose();
                        logWriter = null;
                        var old = LogPath + ".1";
                        if (File.Exists(old)) File.Delete(old);
                        File.Move(LogPath, old);
                    }
                    if (logWriter == null)
                    {
                        var fs = new FileStream(LogPath, FileMode.Append, FileAccess.Write,
                            FileShare.ReadWrite | FileShare.Delete);
                        logWriter = new StreamWriter(fs, new UTF8Encoding(false)) { AutoFlush = true };
                    }
                }
                catch (Exception) { logWriter = null; }
            }
        }

        void WriteLog(string line)
        {
            lock (logLock)
            {
                try { logWriter?.WriteLine(line); } catch (Exception) { }
            }
        }

        static string Quote(string arg) => "\"" + arg.Replace("\"", "\\\"") + "\"";
    }
}
