using System;
using System.Threading;
using System.Windows.Forms;

namespace Switchboard
{
    /// Real entry point: headless `--selftest` / `--update-check` paths for CI and
    /// manual verification, otherwise the tray app.
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            // The supervisor marshals Process callbacks through this; install it
            // before anything is constructed, headless paths included.
            SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());

            if (Array.IndexOf(args, "--selftest") >= 0) return SelfTest.Run();
            if (Array.IndexOf(args, "--update-check") >= 0) return UpdateCheckCli.Run();

            // One tray icon per user session. The installer names this mutex too
            // (AppMutex), so it can ask for the app to be closed before upgrading.
            using (var mutex = new Mutex(true, "SwitchboardTrayApp", out var first))
            {
                if (!first) return 0;
                Application.Run(new TrayApp());
                GC.KeepAlive(mutex);
            }
            return 0;
        }
    }

    /// Headless `--update-check`: one registry check + stage, result on stderr.
    /// Exercises the exact code path the menu item uses.
    static class UpdateCheckCli
    {
        public static int Run()
        {
            var code = 2; // watchdog: never came back from the check
            var updater = new DaemonUpdater();
            var watchdog = new System.Windows.Forms.Timer { Interval = 120 * 1000 };
            watchdog.Tick += (s, e) => Application.ExitThread();
            watchdog.Start();
            SynchronizationContext.Current.Post(async _ =>
            {
                await updater.CheckAndApply();
                SelfTest.Log("[update-check] " + (updater.StatusLine ?? "no status"));
                code = updater.Status == DaemonUpdater.StatusKind.Failed ? 1 : 0;
                Application.ExitThread();
            }, null);
            Application.Run();
            return code;
        }
    }
}
