using System;
using Microsoft.Win32;

namespace Switchboard
{
    /// User-facing preferences, persisted under HKCU\Software\Switchboard, plus
    /// the launch-at-login toggle (HKCU\…\Run — the same value the installer's
    /// "start when I sign in" task writes, so the two always agree).
    sealed class Prefs
    {
        const string KeyPath = @"Software\Switchboard";
        const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunValue = "Switchboard";

        public const string DefaultServer = "https://shell.lfkdsk.org";

        public string Server;
        /// Empty means "let the daemon pick" (powershell.exe on Windows).
        public string Shell;
        /// May the account's *other* machines run commands here (`switchboard exec`)?
        /// On by default, like the CLI. A GUI app doesn't run under your shell's
        /// environment, so SWITCHBOARD_PEER isn't something a user could set here —
        /// this toggle is the only way to say no.
        public bool Peer;

        public Prefs()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(KeyPath))
            {
                Server = k?.GetValue("Server") as string ?? DefaultServer;
                Shell = k?.GetValue("Shell") as string ?? "";
                Peer = !(k?.GetValue("Peer") is int p) || p != 0;
            }
        }

        public void Save()
        {
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(KeyPath))
                {
                    k.SetValue("Server", Server ?? "");
                    k.SetValue("Shell", Shell ?? "");
                    k.SetValue("Peer", Peer ? 1 : 0, RegistryValueKind.DWord);
                }
            }
            catch (Exception) { }
        }

        public string NormalizedServer
        {
            get
            {
                var s = (Server ?? "").Trim();
                return s.Length == 0 ? DefaultServer : s;
            }
        }

        // MARK: Launch at login

        public static string RunCommand => "\"" + Paths.ExePath + "\" --autostart";

        public static bool LaunchAtLogin
        {
            get
            {
                using (var k = Registry.CurrentUser.OpenSubKey(RunKeyPath))
                    return k?.GetValue(RunValue) is string s && s.Length > 0;
            }
        }

        /// Returns false if the toggle couldn't be applied.
        public static bool SetLaunchAtLogin(bool on)
        {
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(RunKeyPath))
                {
                    if (on) k.SetValue(RunValue, RunCommand);
                    else if (k.GetValue(RunValue) != null) k.DeleteValue(RunValue, false);
                }
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }
    }
}
