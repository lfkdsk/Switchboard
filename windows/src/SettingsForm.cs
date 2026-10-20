using System;
using System.Drawing;
using System.Windows.Forms;

namespace Switchboard
{
    /// Relay / shell / launch-at-login / peer settings. Changes to the first two
    /// and peer apply on the next Start, like the macOS app.
    sealed class SettingsForm : Form
    {
        readonly Prefs prefs;
        readonly TextBox server = new TextBox();
        readonly TextBox shell = new TextBox();
        readonly CheckBox launchAtLogin = new CheckBox { Text = "Start Switchboard when I sign in", AutoSize = true };
        readonly CheckBox peer = new CheckBox { Text = "Let my other machines run commands here", AutoSize = true };
        readonly Label loginError = new Label { AutoSize = true, ForeColor = Color.Firebrick, Visible = false };

        public SettingsForm(Prefs prefs, Icon icon)
        {
            this.prefs = prefs;
            Text = "Switchboard Settings";
            Icon = icon;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = true;
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Padding = new Padding(12);

            var layout = new TableLayoutPanel
            {
                ColumnCount = 1,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Dock = DockStyle.Fill,
            };

            server.Width = shell.Width = 360;
            server.Text = prefs.Server;
            shell.Text = prefs.Shell;
            SetCue(server, Prefs.DefaultServer);
            SetCue(shell, "powershell.exe (default)");
            launchAtLogin.Checked = Prefs.LaunchAtLogin;
            peer.Checked = prefs.Peer;

            layout.Controls.Add(Caption("Relay"));
            layout.Controls.Add(server);
            layout.Controls.Add(Caption("Shell"));
            layout.Controls.Add(shell);
            layout.Controls.Add(Spacer());
            layout.Controls.Add(launchAtLogin);
            layout.Controls.Add(loginError);
            layout.Controls.Add(peer);
            layout.Controls.Add(Note("`switchboard exec` / `shell` from the machines on your account."));
            layout.Controls.Add(Note("Relay, shell and peer changes apply on the next Start."));
            layout.Controls.Add(Spacer());

            var buttons = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.RightToLeft,
                AutoSize = true,
                Dock = DockStyle.Fill,
            };
            var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true };
            var save = new Button { Text = "Save", AutoSize = true };
            save.Click += (s, e) => Save();
            buttons.Controls.Add(cancel);
            buttons.Controls.Add(save);
            layout.Controls.Add(buttons);

            Controls.Add(layout);
            AcceptButton = save;
            CancelButton = cancel;
        }

        void Save()
        {
            prefs.Server = server.Text.Trim();
            prefs.Shell = shell.Text.Trim();
            prefs.Peer = peer.Checked;
            prefs.Save();
            if (launchAtLogin.Checked != Prefs.LaunchAtLogin && !Prefs.SetLaunchAtLogin(launchAtLogin.Checked))
            {
                loginError.Text = "Couldn't change the sign-in startup entry.";
                loginError.Visible = true;
                return;
            }
            Close();
        }

        static Label Caption(string text) =>
            new Label { Text = text, AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(3, 6, 3, 0) };

        static Label Note(string text) =>
            new Label { Text = text, AutoSize = true, ForeColor = SystemColors.GrayText, Margin = new Padding(20, 0, 3, 2) };

        static Control Spacer() => new Panel { Height = 6, Width = 1 };

        const int EM_SETCUEBANNER = 0x1501;

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, string lParam);

        /// Placeholder text (the native cue banner; .NET Framework has no property for it).
        static void SetCue(TextBox box, string cue) =>
            box.HandleCreated += (s, e) => SendMessage(box.Handle, EM_SETCUEBANNER, (IntPtr)1, cue);
    }
}
