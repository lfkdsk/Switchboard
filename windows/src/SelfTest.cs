using System;
using System.Windows.Forms;

namespace Switchboard
{
    /// Headless verification of the supervisor↔daemon wiring, no tray involved.
    /// Launches the daemon via the supervisor, prints every connection-state change
    /// for a few seconds, stops it, and exits non-zero unless it reached the
    /// expected state AND the stop was graceful (the daemon acknowledged it and
    /// exited by itself — the stdin-EOF path, which only Windows uses).
    ///
    ///   Switchboard.exe --selftest
    ///
    /// Env:
    ///   SELFTEST_SECONDS=8         how long to watch before stopping
    ///   SELFTEST_EXPECT=online     or `connecting`: any dialing/retrying state
    ///                              counts, for runs against an unreachable relay
    ///   SWITCHBOARD_SERVER=<url>   relay override
    ///
    /// Output goes to stderr and to %LOCALAPPDATA%\Switchboard\Logs\selftest.log,
    /// since a GUI-subsystem exe has no console unless its stderr is redirected.
    static class SelfTest
    {
        public static int Run()
        {
            var duration = double.TryParse(Environment.GetEnvironmentVariable("SELFTEST_SECONDS"), out var d) ? d : 8;
            var expectOnline = !string.Equals(Environment.GetEnvironmentVariable("SELFTEST_EXPECT"),
                "connecting", StringComparison.OrdinalIgnoreCase);

            var prefs = new Prefs();
            var server = Environment.GetEnvironmentVariable("SWITCHBOARD_SERVER");
            if (!string.IsNullOrEmpty(server)) prefs.Server = server;
            var sup = new DaemonSupervisor(prefs);

            var reached = false;
            var stopping = false;
            var lastTitle = "";
            var code = 2;

            sup.Changed += () =>
            {
                var st = sup.State;
                if (st.Title == lastTitle) return;
                lastTitle = st.Title;
                var extra = "";
                if (st.Kind == ConnKind.Online)
                {
                    extra = $" machine={sup.MachineName ?? "?"} mode={sup.Mode ?? "?"}";
                    var url = sup.DashboardUrl ?? sup.ShareUrl;
                    if (url != null) extra += " url=" + Redact(url);
                }
                Log($"state → {st.Title}{extra}");

                if (!stopping)
                {
                    if (expectOnline ? st.Kind == ConnKind.Online
                                     : st.Kind == ConnKind.Connecting || st.Kind == ConnKind.Reconnecting ||
                                       st.Kind == ConnKind.Online)
                        reached = true;
                    if (st.Kind == ConnKind.Fatal) Finish(false, "daemon hit a fatal state");
                }
                else if (st.Kind == ConnKind.Stopped)
                {
                    if (!sup.LastStopWasGraceful) Finish(false, "daemon had to be killed — stop was not graceful");
                    else Finish(reached, reached ? "reached " + (expectOnline ? "online" : "the relay dial loop")
                                                 : "never reached " + (expectOnline ? "online" : "the relay dial loop"));
                }
            };

            void Finish(bool pass, string why)
            {
                if (code != 2) return;
                code = pass ? 0 : 1;
                Log((pass ? "PASS — " : "FAIL — ") + why);
                Application.ExitThread();
            }

            var stopTimer = new Timer { Interval = (int)(duration * 1000) };
            stopTimer.Tick += (s, e) =>
            {
                stopTimer.Stop();
                stopping = true;
                Log("stopping daemon");
                if (sup.IsRunning) sup.Stop();
                else Finish(false, "daemon was not running at stop time");
            };
            var watchdog = new Timer { Interval = (int)(duration * 1000) + 15000 };
            watchdog.Tick += (s, e) => Finish(false, "watchdog: daemon never finished stopping");

            Log($"starting daemon (server={prefs.NormalizedServer}, expect={(expectOnline ? "online" : "connecting")})");
            sup.Start();
            stopTimer.Start();
            watchdog.Start();
            Application.Run();
            return code == 2 ? 1 : code;
        }

        // A token-mode share URL carries the shell credential; keep it out of CI logs.
        static string Redact(string url)
        {
            var i = url.IndexOf("token=", StringComparison.Ordinal);
            return i < 0 ? url : url.Substring(0, i + 6) + "…";
        }

        public static void Log(string s)
        {
            try { Console.Error.WriteLine("[selftest] " + s); } catch (Exception) { }
            Paths.AppendLog("selftest.log", s);
        }
    }
}
