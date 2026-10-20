using System;
using System.IO;

namespace Switchboard
{
    /// Locates the Node binary and the daemon entry (cli/index.js) to run.
    ///
    /// Resolution order:
    ///   1. Bundled runtime next to the exe — runtime\node.exe + runtime\cli\index.js
    ///      (what scripts/make-app.ps1 produces; the only path that works for an
    ///      installed app). If a validated hot update is staged (see DaemonUpdater),
    ///      its index.js replaces the bundled one — still on the bundled Node and
    ///      bundled node_modules.
    ///   2. Dev override via SWITCHBOARD_NODE + SWITCHBOARD_CLI env vars.
    ///   3. `node` on PATH + the repo's cli\index.js relative to the exe
    ///      (handy when running `dotnet build` output from inside the repo).
    static class NodeRuntime
    {
        public sealed class Resolved
        {
            public string Node;
            public string Cli;
            /// NODE_PATH fallback for hot updates (bundled node_modules), in case
            /// the staged dir's node_modules junction couldn't be created.
            public string NodePathDir;
            public bool IsHotUpdate;
        }

        public static string BundledNode => Path.Combine(Paths.ExeDir, "runtime", "node.exe");
        public static string BundledCliDir => Path.Combine(Paths.ExeDir, "runtime", "cli");

        public static Resolved Resolve()
        {
            // 1. Bundled runtime.
            var node = BundledNode;
            var cli = Path.Combine(BundledCliDir, "index.js");
            if (File.Exists(node) && File.Exists(cli))
            {
                var up = DaemonUpdater.ActiveUpdate();
                if (up != null)
                {
                    return new Resolved
                    {
                        Node = node,
                        Cli = Path.Combine(up.Dir, "index.js"),
                        NodePathDir = Path.Combine(BundledCliDir, "node_modules"),
                        IsHotUpdate = true,
                    };
                }
                return new Resolved { Node = node, Cli = cli };
            }

            // 2. Explicit dev override.
            var n = Environment.GetEnvironmentVariable("SWITCHBOARD_NODE");
            var c = Environment.GetEnvironmentVariable("SWITCHBOARD_CLI");
            if (!string.IsNullOrEmpty(n) && !string.IsNullOrEmpty(c) && File.Exists(n) && File.Exists(c))
                return new Resolved { Node = n, Cli = c };

            // 3. System node + a discoverable cli\index.js.
            var sys = Which("node.exe");
            if (sys == null) return null;
            if (!string.IsNullOrEmpty(c) && File.Exists(c)) return new Resolved { Node = sys, Cli = c };
            // bin\<Config>\net48\Switchboard.exe → windows\ is three up, cli\ is its sibling.
            var repoCli = Path.GetFullPath(Path.Combine(Paths.ExeDir, "..", "..", "..", "..", "cli", "index.js"));
            if (File.Exists(repoCli)) return new Resolved { Node = sys, Cli = repoCli };
            return null;
        }

        static string Which(string exe)
        {
            var dirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator);
            foreach (var d in dirs)
            {
                if (string.IsNullOrWhiteSpace(d)) continue;
                try
                {
                    var p = Path.Combine(d.Trim().Trim('"'), exe);
                    if (File.Exists(p)) return p;
                }
                catch (ArgumentException) { }
            }
            var pf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", exe);
            return File.Exists(pf) ? pf : null;
        }
    }
}
