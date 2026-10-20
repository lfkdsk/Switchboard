using System;
using System.IO;

namespace Switchboard
{
    /// Where the app keeps its own state. Per-user and outside the install dir,
    /// so an upgrade (which replaces the install dir) leaves it alone:
    ///   %LOCALAPPDATA%\Switchboard\Logs         daemon.log, updater.log
    ///   %LOCALAPPDATA%\Switchboard\cli-updates  hot-updated cli versions
    static class Paths
    {
        public static string AppDataDir =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Switchboard");

        public static string LogsDir => Path.Combine(AppDataDir, "Logs");

        public static string UpdatesDir => Path.Combine(AppDataDir, "cli-updates");

        /// The directory Switchboard.exe lives in (the install dir for a real install).
        public static string ExeDir => AppDomain.CurrentDomain.BaseDirectory;

        public static string ExePath =>
            System.Reflection.Assembly.GetEntryAssembly()?.Location ?? Path.Combine(ExeDir, "Switchboard.exe");

        /// ~/.switchboard — shared with the CLI.
        public static string ConfigFile =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".switchboard", "config.json");

        /// Appends one timestamped line to a log under LogsDir. Never throws.
        public static void AppendLog(string name, string line)
        {
            try
            {
                Directory.CreateDirectory(LogsDir);
                File.AppendAllText(Path.Combine(LogsDir, name),
                    "[" + DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ") + "] " + line + Environment.NewLine);
            }
            catch (Exception) { }
        }
    }
}
