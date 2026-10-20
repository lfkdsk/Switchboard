using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Timer = System.Windows.Forms.Timer;

namespace Switchboard
{
    /// Hot-updates the bundled JS daemon (@switch-board/cli) from the npm registry,
    /// without shipping a new installer. Mirrors macos/…/DaemonUpdater.swift.
    ///
    /// The install dir is replaced wholesale on upgrade, so updates are staged
    /// under %LOCALAPPDATA%\Switchboard\cli-updates\<version>\ and the supervisor
    /// runs index.js from there when a staged version is newer than the bundled
    /// one. Only the package's own JS moves: node.exe and the node_modules tree
    /// (node-pty's native addon included) always come from the install dir, via a
    /// node_modules junction in the staged dir (plus NODE_PATH as a fallback). An
    /// update whose `dependencies` differ from the bundled package's is refused —
    /// that change has to ride a full app release.
    ///
    /// Trust model: metadata and tarball both come from registry.npmjs.org over
    /// TLS, and the tarball must match the metadata's sha512 SSRI — the same chain
    /// `npm install` trusts.
    sealed class DaemonUpdater
    {
        public enum StatusKind { Idle, Checking, UpToDate, Updated, Blocked, Failed }

        public StatusKind Status { get; private set; } = StatusKind.Idle;
        string statusArg;

        public string StatusLine
        {
            get
            {
                switch (Status)
                {
                    case StatusKind.Checking: return "Checking npm…";
                    case StatusKind.UpToDate: return $"cli {statusArg} is up to date.";
                    case StatusKind.Updated: return $"Updated to cli {statusArg} — daemon restarted.";
                    case StatusKind.Blocked: return $"cli {statusArg} needs a new app build (deps changed).";
                    case StatusKind.Failed: return $"Update failed: {statusArg}";
                    default: return null;
                }
            }
        }

        public string BundledVersion { get; private set; }
        public string ActiveVersion { get; private set; }   // what Resolve() will actually run
        public bool HotUpdateActive { get; private set; }

        public event Action Changed;
        public DaemonSupervisor Supervisor;

        const string PackageName = "@switch-board/cli";
        const string RegistryHost = "registry.npmjs.org";

        static readonly HttpClient Http;

        static DaemonUpdater()
        {
            // .NET Framework only negotiates what it is told to on older builds.
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            Http = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
            Http.DefaultRequestHeaders.UserAgent.ParseAdd("Switchboard-Windows");
        }

        Timer timer;

        public DaemonUpdater()
        {
            Refresh();
        }

        /// Re-derive the on-disk state (menu calls this on open, supervisor after a
        /// rollback).
        public void Refresh()
        {
            var bundled = BundledManifest();
            BundledVersion = bundled?.Version;
            var up = ActiveUpdate();
            if (up != null)
            {
                ActiveVersion = up.Version;
                HotUpdateActive = true;
            }
            else
            {
                ActiveVersion = bundled?.Version;
                HotUpdateActive = false;
            }
        }

        /// Launch-time + periodic checks. Idempotent.
        public void StartAutoChecks()
        {
            if (timer != null || BundledManifest() == null) return;
            // First check shortly after launch, then every 6 hours.
            timer = new Timer { Interval = 20 * 1000 };
            timer.Tick += async (s, e) =>
            {
                timer.Interval = 6 * 3600 * 1000;
                await CheckAndApply(auto: true);
            };
            timer.Start();
        }

        /// Check the registry and stage the latest version if it qualifies.
        /// `auto` runs stay quiet on network failure (no scary status from a flaky
        /// wifi moment); manual checks surface everything.
        public async Task CheckAndApply(bool auto = false)
        {
            var bundled = BundledManifest();
            if (bundled == null)
            {
                if (!auto) SetStatus(StatusKind.Failed, "no bundled runtime (dev build)");
                return;
            }
            if (Status == StatusKind.Checking) return;
            SetStatus(StatusKind.Checking, null);
            try
            {
                var doc = await FetchRegistryDoc();
                if (!doc.DistTags.TryGetValue("latest", out var latest) ||
                    !doc.Versions.TryGetValue(latest, out var meta))
                    throw new UpdateError("registry doc has no latest version");

                var running = ActiveUpdate()?.Version ?? bundled.Version;
                if (!SemVer.IsNewer(latest, running))
                {
                    SetStatus(StatusKind.UpToDate, running);
                    Refresh();
                    return;
                }
                if (!SameDeps(meta.Dependencies, bundled.Dependencies))
                {
                    Log($"blocked {latest}: dependencies changed, needs a full app release");
                    SetStatus(StatusKind.Blocked, latest);
                    return;
                }
                await Stage(meta);
                Log($"staged {latest} (was {running})");
                Refresh();
                SetStatus(StatusKind.Updated, latest);
                if (Supervisor != null && Supervisor.IsRunning) Supervisor.Restart();
            }
            catch (Exception ex)
            {
                var ue = ex as UpdateError;
                var msg = ue?.Message ?? ex.Message;
                Log("check failed: " + msg);
                if (auto && (ue == null || ue.IsNetwork))
                    SetStatus(StatusKind.Idle, null); // quiet failure; retry on the next tick
                else
                    SetStatus(StatusKind.Failed, msg);
            }
        }

        void SetStatus(StatusKind k, string arg)
        {
            Status = k;
            statusArg = arg;
            Changed?.Invoke();
        }

        // MARK: - On-disk layout (statics, shared with NodeRuntime)

        public sealed class Manifest
        {
            public string Version;
            public Dictionary<string, string> Dependencies;
        }

        public sealed class ActiveUpdateInfo
        {
            public string Version;
            public string Dir;
        }

        public static string BundledCliDir()
        {
            var dir = NodeRuntime.BundledCliDir;
            return File.Exists(Path.Combine(dir, "index.js")) ? dir : null;
        }

        public static Manifest BundledManifest()
        {
            var dir = BundledCliDir();
            return dir == null ? null : ReadManifest(dir);
        }

        static Manifest ReadManifest(string dir)
        {
            try
            {
                var o = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                    File.ReadAllText(Path.Combine(dir, "package.json")));
                return ToManifest(o);
            }
            catch (Exception)
            {
                return null;
            }
        }

        static Manifest ToManifest(Dictionary<string, object> o)
        {
            if (o == null || !(o.TryGetValue("version", out var v) && v is string version)) return null;
            return new Manifest { Version = version, Dependencies = StringMap(o, "dependencies") };
        }

        static Dictionary<string, string> StringMap(Dictionary<string, object> o, string key)
        {
            var map = new Dictionary<string, string>();
            if (o.TryGetValue(key, out var d) && d is Dictionary<string, object> deps)
                foreach (var kv in deps) map[kv.Key] = kv.Value as string ?? "";
            return map;
        }

        static bool SameDeps(Dictionary<string, string> a, Dictionary<string, string> b)
        {
            a = a ?? new Dictionary<string, string>();
            b = b ?? new Dictionary<string, string>();
            return a.Count == b.Count && a.All(kv => b.TryGetValue(kv.Key, out var v) && v == kv.Value);
        }

        static string Marker => Path.Combine(Paths.UpdatesDir, "current");

        /// The staged update the daemon should run, fully validated — or null.
        ///
        /// Invalid or stale state (marker without a dir, version not newer than the
        /// bundle after an app upgrade, deps drifted from the bundle) reverts to the
        /// bundled cli, and a stale marker is pruned so the check starts clean.
        public static ActiveUpdateInfo ActiveUpdate()
        {
            string version;
            try { version = File.ReadAllText(Marker).Trim(); }
            catch (Exception) { return null; }
            if (version.Length == 0) return null;

            var bundled = BundledManifest();
            if (bundled == null) return null;
            var dir = Path.Combine(Paths.UpdatesDir, version);

            var staged = File.Exists(Path.Combine(dir, "index.js")) ? ReadManifest(dir) : null;
            if (!SemVer.IsNewer(version, bundled.Version) || staged == null ||
                staged.Version != version || !SameDeps(staged.Dependencies, bundled.Dependencies))
            {
                // The installer caught up (or the staging is broken) — clean up so
                // the bundled cli wins without re-validating every launch.
                try { File.Delete(Marker); } catch (Exception) { }
                Log($"pruned stale update {version} (bundled {bundled.Version})");
                return null;
            }

            // node-pty & ws resolve from the install dir. A node_modules junction
            // beside index.js is the primary route (immune to a stray
            // %USERPROFILE%\node_modules shadowing NODE_PATH); repair it if the app
            // moved since staging. Junctions, unlike symlinks, need no privilege.
            EnsureJunction(Path.Combine(dir, "node_modules"),
                Path.Combine(BundledCliDir(), "node_modules"));
            return new ActiveUpdateInfo { Version = version, Dir = dir };
        }

        static void EnsureJunction(string link, string target)
        {
            var stamp = link + ".target";
            try
            {
                if (Directory.Exists(link) && File.Exists(stamp) &&
                    string.Equals(File.ReadAllText(stamp).Trim(), target, StringComparison.OrdinalIgnoreCase))
                    return;
                // Non-recursive delete of a junction removes the link, not the target.
                if (Directory.Exists(link)) Directory.Delete(link, false);
                RunHidden("cmd.exe", $"/d /c mklink /J \"{link}\" \"{target}\"", 10000);
                if (Directory.Exists(link)) File.WriteAllText(stamp, target);
            }
            catch (Exception ex)
            {
                Log("could not link node_modules (NODE_PATH fallback applies): " + ex.Message);
            }
        }

        /// Drop the hot update and fall back to the bundled cli (crash rollback).
        public static void RevertToBundled(string reason)
        {
            try { File.Delete(Marker); } catch (Exception) { }
            Log("reverted to bundled cli: " + reason);
        }

        // MARK: - Registry

        sealed class RegistryDoc
        {
            public Dictionary<string, string> DistTags;
            public Dictionary<string, RegistryVersion> Versions;
        }

        sealed class RegistryVersion
        {
            public string Version;
            public Dictionary<string, string> Dependencies;
            public string Tarball;
            public string Integrity;
        }

        sealed class UpdateError : Exception
        {
            public readonly bool IsNetwork;
            public UpdateError(string message, bool isNetwork = false) : base(message) { IsNetwork = isNetwork; }
        }

        static async Task<RegistryDoc> FetchRegistryDoc()
        {
            var url = $"https://{RegistryHost}/{PackageName.Replace("/", "%2F")}";
            var req = new HttpRequestMessage(HttpMethod.Get, url);
            // Abbreviated install doc: dist-tags + per-version dependencies/dist.
            req.Headers.Accept.ParseAdd("application/vnd.npm.install-v1+json");
            HttpResponseMessage resp;
            string body;
            try
            {
                resp = await Http.SendAsync(req);
                body = await resp.Content.ReadAsStringAsync();
            }
            catch (Exception ex)
            {
                throw new UpdateError($"registry unreachable ({ex.Message})", isNetwork: true);
            }
            if (resp.StatusCode != HttpStatusCode.OK)
                throw new UpdateError($"registry HTTP {(int)resp.StatusCode}", isNetwork: true);

            var ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            var o = ser.Deserialize<Dictionary<string, object>>(body);
            var doc = new RegistryDoc
            {
                DistTags = StringMap(o, "dist-tags"),
                Versions = new Dictionary<string, RegistryVersion>(),
            };
            if (o.TryGetValue("versions", out var vs) && vs is Dictionary<string, object> versions)
            {
                foreach (var kv in versions)
                {
                    if (!(kv.Value is Dictionary<string, object> v)) continue;
                    var m = ToManifest(v);
                    if (m == null || !(v.TryGetValue("dist", out var d) && d is Dictionary<string, object> dist))
                        continue;
                    doc.Versions[kv.Key] = new RegistryVersion
                    {
                        Version = m.Version,
                        Dependencies = m.Dependencies,
                        Tarball = dist.TryGetValue("tarball", out var t) ? t as string : null,
                        Integrity = dist.TryGetValue("integrity", out var i) ? i as string : null,
                    };
                }
            }
            return doc;
        }

        /// Download, verify, extract and mark `meta.Version` as current.
        static async Task Stage(RegistryVersion meta)
        {
            if (!Uri.TryCreate(meta.Tarball ?? "", UriKind.Absolute, out var tarUrl) ||
                tarUrl.Scheme != Uri.UriSchemeHttps || tarUrl.Host != RegistryHost)
                throw new UpdateError($"tarball URL not on {RegistryHost}: {meta.Tarball}");

            byte[] data;
            try
            {
                var resp = await Http.GetAsync(tarUrl);
                if (resp.StatusCode != HttpStatusCode.OK)
                    throw new UpdateError($"tarball HTTP {(int)resp.StatusCode}", isNetwork: true);
                data = await resp.Content.ReadAsByteArrayAsync();
            }
            catch (UpdateError) { throw; }
            catch (Exception ex)
            {
                throw new UpdateError($"tarball download failed ({ex.Message})", isNetwork: true);
            }
            VerifyIntegrity(data, meta.Integrity);

            await Task.Run(() =>
            {
                var updates = Paths.UpdatesDir;
                Directory.CreateDirectory(updates);

                var work = Path.Combine(updates, ".staging-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(work);
                try
                {
                    var tarball = Path.Combine(work, "pkg.tgz");
                    File.WriteAllBytes(tarball, data);
                    // bsdtar ships with Windows 10 1803+ and reads .tgz directly.
                    var tar = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "tar.exe");
                    var code = RunHidden(tar, $"-x -z -f \"{tarball}\" -C \"{work}\"", 60000);
                    if (code != 0) throw new UpdateError($"tar exited {code}");

                    var extracted = Path.Combine(work, "package");
                    if (!File.Exists(Path.Combine(extracted, "index.js")))
                        throw new UpdateError("tarball has no package/index.js");

                    var dest = Path.Combine(updates, meta.Version);
                    if (Directory.Exists(dest)) DeleteTree(dest);
                    Directory.Move(extracted, dest);

                    // Marker last, atomically (write-temp + rename): a crash mid-stage
                    // leaves the previous version live.
                    var tmp = Marker + ".tmp";
                    File.WriteAllText(tmp, meta.Version, new UTF8Encoding(false));
                    if (File.Exists(Marker)) File.Replace(tmp, Marker, null);
                    else File.Move(tmp, Marker);

                    // Keep only the live version around.
                    foreach (var d in Directory.GetDirectories(updates))
                        if (!string.Equals(Path.GetFileName(d), meta.Version, StringComparison.OrdinalIgnoreCase))
                            DeleteTree(d);
                }
                finally
                {
                    DeleteTree(work);
                }
            });
        }

        /// Recursive delete that never follows the node_modules junction into the
        /// install dir: reparse points are unlinked, not descended into.
        static void DeleteTree(string dir)
        {
            try
            {
                var info = new DirectoryInfo(dir);
                if (!info.Exists) return;
                if ((info.Attributes & FileAttributes.ReparsePoint) != 0) { info.Delete(false); return; }
                foreach (var f in info.GetFiles())
                {
                    f.Attributes = FileAttributes.Normal;
                    f.Delete();
                }
                foreach (var d in info.GetDirectories()) DeleteTree(d.FullName);
                info.Delete(false);
            }
            catch (Exception) { }
        }

        static void VerifyIntegrity(byte[] data, string ssri)
        {
            if (ssri == null) throw new UpdateError("registry metadata lacks integrity");
            // SSRI can be a space-separated list; we require the sha512 entry.
            var entry = ssri.Split(' ').FirstOrDefault(s => s.StartsWith("sha512-", StringComparison.Ordinal));
            if (entry == null) throw new UpdateError("no sha512 integrity entry");
            var expected = entry.Substring("sha512-".Length);
            string actual;
            using (var sha = SHA512.Create()) actual = Convert.ToBase64String(sha.ComputeHash(data));
            if (actual != expected) throw new UpdateError("tarball integrity mismatch");
        }

        static int RunHidden(string exe, string args, int timeoutMs)
        {
            using (var p = Process.Start(new ProcessStartInfo(exe, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            }))
            {
                if (p == null) return -1;
                if (!p.WaitForExit(timeoutMs))
                {
                    try { p.Kill(); } catch (Exception) { }
                    return -1;
                }
                return p.ExitCode;
            }
        }

        // MARK: - Logging

        public static void Log(string s) => Paths.AppendLog("updater.log", s);
    }

    /// Just enough semver for npm versions: numeric x.y.z compare, and a release
    /// outranks its own prereleases (1.2.0 > 1.2.0-rc1).
    static class SemVer
    {
        public static bool IsNewer(string a, string than) => Compare(a, than) > 0;

        public static int Compare(string a, string b)
        {
            var (aCore, aPre) = Split(a);
            var (bCore, bPre) = Split(b);
            for (var i = 0; i < 3; i++)
            {
                var x = aCore.Length > i ? aCore[i] : 0;
                var y = bCore.Length > i ? bCore[i] : 0;
                if (x != y) return x < y ? -1 : 1;
            }
            if (aPre == null && bPre == null) return 0;
            if (aPre == null) return 1;    // release > prerelease
            if (bPre == null) return -1;
            return Math.Sign(string.CompareOrdinal(aPre, bPre));
        }

        static (int[], string) Split(string v)
        {
            var trimmed = v.StartsWith("v", StringComparison.Ordinal) ? v.Substring(1) : v;
            var parts = trimmed.Split(new[] { '-' }, 2);
            var core = parts[0].Split('.').Select(p => int.TryParse(p, out var n) ? n : 0).ToArray();
            return (core, parts.Length > 1 ? parts[1] : null);
        }
    }
}
