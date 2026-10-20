using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;

namespace Switchboard
{
    /// Reads ~/.switchboard/config.json — the same file the CLI writes on login —
    /// so the menu can show who's signed in without re-running the daemon.
    sealed class AccountConfig
    {
        public bool SignedIn;
        public string Login;
        public string MachineId;
        public string Server;

        public static readonly AccountConfig Empty = new AccountConfig();
    }

    static class ConfigReader
    {
        public static AccountConfig Read()
        {
            try
            {
                var o = new JavaScriptSerializer()
                    .Deserialize<Dictionary<string, object>>(File.ReadAllText(Paths.ConfigFile));
                if (o == null) return AccountConfig.Empty;
                string S(string k) => o.TryGetValue(k, out var v) ? v as string : null;
                return new AccountConfig
                {
                    SignedIn = !string.IsNullOrEmpty(S("agentToken")),
                    Login = S("login"),
                    MachineId = S("machineId"),
                    Server = S("server"),
                };
            }
            catch (Exception)
            {
                return AccountConfig.Empty;
            }
        }
    }
}
