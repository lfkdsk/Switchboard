using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Switchboard
{
    /// The notification-area icon and its menu — the Windows counterpart of the
    /// macOS MenuBarExtra. No main window: the app lives only in the tray.
    sealed class TrayApp : ApplicationContext
    {
        readonly Prefs prefs;
        readonly DaemonSupervisor supervisor;
        readonly DaemonUpdater updater;
        readonly NotifyIcon tray;
        readonly ContextMenuStrip menu;
        readonly Icon baseIcon;

        AccountConfig config = ConfigReader.Read();
        ConnKind? iconKind;
        Image avatar;
        string avatarLogin;
        SettingsForm settings;

        static readonly string AppVersion =
            Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()
                ?.InformationalVersion ?? "dev";

        public TrayApp()
        {
            prefs = new Prefs();
            supervisor = new DaemonSupervisor(prefs);
            updater = new DaemonUpdater { Supervisor = supervisor };

            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("Switchboard.ico"))
                baseIcon = new Icon(s, SystemInformation.SmallIconSize);

            menu = new ContextMenuStrip { ShowImageMargin = true };
            menu.Opening += (s, e) =>
            {
                config = ConfigReader.Read();
                updater.Refresh();
                LoadAvatar();
                Rebuild();
                e.Cancel = false;
            };

            tray = new NotifyIcon { ContextMenuStrip = menu, Visible = true };
            // Left click opens the same menu (NotifyIcon only does it for right).
            tray.MouseUp += (s, e) =>
            {
                if (e.Button != MouseButtons.Left) return;
                typeof(NotifyIcon).GetMethod("ShowContextMenu", BindingFlags.Instance | BindingFlags.NonPublic)
                    ?.Invoke(tray, null);
            };

            supervisor.Changed += OnSupervisorChanged;
            updater.Changed += () => { if (menu.Visible) Rebuild(); };

            UpdateIcon();
            updater.StartAutoChecks();

            // Auto-start only when signed in: an anonymous token nobody has seen is
            // useless on a silent launch, so token mode waits for an explicit Start.
            // Opened by hand with nothing to start: say where the app went.
            if (config.SignedIn) supervisor.Start();
            else if (!IsAutostart())
                tray.ShowBalloonTip(5000, "Switchboard",
                    "Switchboard is in the notification area. Click the icon to sign in or start.",
                    ToolTipIcon.None);
        }

        static bool IsAutostart() => Array.IndexOf(Environment.GetCommandLineArgs(), "--autostart") >= 0;

        void OnSupervisorChanged()
        {
            var was = iconKind;
            UpdateIcon();
            // Surface the states that need the user: the menu is out of sight.
            if (was != ConnKind.Fatal && supervisor.State.Kind == ConnKind.Fatal)
                tray.ShowBalloonTip(8000, ConnState.Headline(supervisor.State.Reason),
                    supervisor.RuntimeMissing
                        ? "The bundled Node runtime is missing — reinstall Switchboard."
                        : ConnState.Hint(supervisor.State.Reason),
                    ToolTipIcon.Warning);
            if (menu.Visible) Rebuild();
        }

        // MARK: Tray icon

        void UpdateIcon()
        {
            var kind = supervisor.State.Kind;
            var tip = "Switchboard — " + supervisor.State.Title;
            tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
            if (iconKind == kind) return;
            iconKind = kind;
            var old = tray.Icon;
            tray.Icon = BadgedIcon(DotColor(supervisor.State));
            if (old != null && old != baseIcon) DestroyIconHandle(old);
        }

        /// The app icon with a status dot in the corner (none when stopped).
        Icon BadgedIcon(Color? dot)
        {
            if (dot == null) return baseIcon;
            var size = SystemInformation.SmallIconSize;
            using (var bmp = new Bitmap(size.Width, size.Height))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.DrawIcon(baseIcon, new Rectangle(Point.Empty, size));
                    var d = Math.Max(6, size.Width * 7 / 16);
                    var r = new Rectangle(size.Width - d, size.Height - d, d - 1, d - 1);
                    using (var b = new SolidBrush(dot.Value)) g.FillEllipse(b, r);
                    using (var pen = new Pen(Color.FromArgb(220, 11, 14, 20), Math.Max(1f, d / 6f)))
                        g.DrawEllipse(pen, r);
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }

        static Color? DotColor(ConnState s)
        {
            switch (s.Kind)
            {
                case ConnKind.Online: return Color.FromArgb(52, 199, 89);
                case ConnKind.Fatal: return Color.FromArgb(255, 69, 58);
                case ConnKind.Stopped: return null;
                default: return Color.FromArgb(255, 204, 0);
            }
        }

        static Image DotImage(ConnState s)
        {
            var bmp = new Bitmap(16, 16);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (var b = new SolidBrush(DotColor(s) ?? Color.Gray)) g.FillEllipse(b, 3, 3, 10, 10);
            }
            return bmp;
        }

        [DllImport("user32.dll")]
        static extern bool DestroyIcon(IntPtr handle);

        static void DestroyIconHandle(Icon icon)
        {
            var h = icon.Handle;
            icon.Dispose();
            DestroyIcon(h);
        }

        // MARK: Menu

        void Rebuild()
        {
            menu.SuspendLayout();
            foreach (ToolStripItem old in menu.Items) old.Image?.Dispose();
            menu.Items.Clear();
            var items = menu.Items;
            var st = supervisor.State;

            // Header: status, machine, viewer.
            var head = Info(st.Title + (supervisor.PeerOnline ? "   · viewer connected" : ""), DotImage(st));
            head.Font = new Font(menu.Font, FontStyle.Bold);
            items.Add(head);
            var machine = supervisor.MachineName ?? Environment.MachineName;
            items.Add(Info(machine + (supervisor.Mode != null ? " · " + supervisor.Mode : "")));

            if (st.Kind == ConnKind.Fatal)
            {
                items.Add(Info(supervisor.RuntimeMissing
                    ? "Bundled Node runtime missing — reinstall."
                    : ConnState.Hint(st.Reason)));
            }
            else if (st.Kind == ConnKind.Online)
            {
                var rtt = supervisor.Rtt.HasValue ? $"{(int)supervisor.Rtt.Value} ms" : "—";
                var cpu = supervisor.Cpu.HasValue ? $"{(int)(supervisor.Cpu.Value * 100)}%" : "—";
                items.Add(Info($"RTT {rtt}   CPU {cpu}   Mem {MemText()}"));
            }

            items.Add(new ToolStripSeparator());

            var dash = Item("Open dashboard", supervisor.OpenDashboard);
            dash.Enabled = (supervisor.DashboardUrl ?? supervisor.ShareUrl) != null;
            items.Add(dash);
            if (supervisor.Mode == "token" && supervisor.ShareUrl != null)
                items.Add(Item("Copy share URL", supervisor.CopyShareUrl));

            items.Add(new ToolStripSeparator());

            if (supervisor.IsRunning)
            {
                items.Add(Item("Stop", supervisor.Stop));
                items.Add(Item("Restart", supervisor.Restart));
            }
            else
            {
                items.Add(Item(config.SignedIn ? "Start" : "Start (one-off token)", () => supervisor.Start()));
            }

            items.Add(new ToolStripSeparator());

            if (config.SignedIn)
            {
                var who = Info("Signed in as " + (config.Login ?? "?"));
                if (avatar != null && avatarLogin == config.Login) who.Image = new Bitmap(avatar);
                items.Add(who);
                items.Add(Item("Sign out", () => supervisor.SignOut(() => config = ConfigReader.Read())));
            }
            else
            {
                // Config is written once the browser handshake completes.
                items.Add(Item("Sign in…", supervisor.SignIn));
            }

            items.Add(new ToolStripSeparator());

            items.Add(Item("Settings…", ShowSettings));
            var check = Item("Check for cli updates", async () => await updater.CheckAndApply());
            check.Enabled = updater.Status != DaemonUpdater.StatusKind.Checking && updater.BundledVersion != null;
            items.Add(check);
            if (updater.StatusLine != null) items.Add(Info("   " + updater.StatusLine));
            items.Add(Item("Open logs folder", OpenLogs));

            items.Add(new ToolStripSeparator());

            var cli = updater.ActiveVersion != null
                ? $" · cli {updater.ActiveVersion}{(updater.HotUpdateActive ? "↑" : "")}"
                : "";
            var ver = Info($"Switchboard {AppVersion}{cli}");
            ver.ToolTipText = updater.HotUpdateActive
                ? $"cli hot-updated from npm (bundled: {updater.BundledVersion ?? "?"})"
                : "cli bundled with the app";
            items.Add(ver);
            items.Add(Item("Quit", Quit));
            menu.ResumeLayout();
        }

        static ToolStripMenuItem Item(string text, Action onClick)
        {
            var it = new ToolStripMenuItem(text);
            it.Click += (s, e) => onClick();
            return it;
        }

        static ToolStripMenuItem Info(string text, Image image = null) =>
            new ToolStripMenuItem(text, image) { Enabled = false };

        string MemText()
        {
            if (!(supervisor.MemUsed is double used) || !(supervisor.MemTotal is double total) || total <= 0)
                return "—";
            return $"{used / 1e9:0.0}/{total / 1e9:0} GB";
        }

        // MARK: Avatar

        static readonly HttpClient AvatarHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };

        /// The signed-in user's GitHub avatar (github.com/<login>.png), circular.
        async void LoadAvatar()
        {
            var login = config.SignedIn ? config.Login : null;
            if (string.IsNullOrEmpty(login) || login == avatarLogin) return;
            avatarLogin = login;
            try
            {
                var bytes = await AvatarHttp.GetByteArrayAsync(
                    $"https://github.com/{Uri.EscapeDataString(login)}.png?size=64");
                using (var ms = new MemoryStream(bytes))
                using (var src = Image.FromStream(ms))
                {
                    var bmp = new Bitmap(16, 16);
                    using (var g = Graphics.FromImage(bmp))
                    using (var path = new GraphicsPath())
                    {
                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        path.AddEllipse(0, 0, 16, 16);
                        g.SetClip(path);
                        g.DrawImage(src, 0, 0, 16, 16);
                    }
                    avatar?.Dispose();
                    avatar = bmp;
                }
                if (menu.Visible) Rebuild();
            }
            catch (Exception)
            {
                avatarLogin = null; // offline: try again next time the menu opens
            }
        }

        // MARK: Actions

        void ShowSettings()
        {
            if (settings != null && !settings.IsDisposed)
            {
                settings.Activate();
                return;
            }
            settings = new SettingsForm(prefs, baseIcon);
            settings.FormClosed += (s, e) => settings = null;
            settings.Show();
            settings.Activate();
        }

        static void OpenLogs()
        {
            try
            {
                Directory.CreateDirectory(Paths.LogsDir);
                Process.Start(new ProcessStartInfo("explorer.exe", "\"" + Paths.LogsDir + "\"") { UseShellExecute = true });
            }
            catch (Exception) { }
        }

        void Quit()
        {
            supervisor.StopAndWait();
            tray.Visible = false;
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                tray.Visible = false;
                tray.Dispose();
                menu.Dispose();
                avatar?.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
