using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace Switchboard
{
    /// One line of NDJSON emitted by the daemon (see cli/index.js `emitStatus`).
    /// Every field past `ev` is optional because each event carries only a subset.
    sealed class StatusEvent
    {
        public string Ev;
        // ready / connected / connecting
        public string Mode;          // "account" | "token"
        public string Machine;
        public string Account;
        public string DashboardUrl;
        public string ShareUrl;
        // stats
        public double? Cpu;
        public double? MemUsed;
        public double? MemTotal;
        public int? Cores;
        public double? Rtt;          // may be JSON null → stays null
        // peer
        public bool? Online;
        // disconnected / fatal / stopping
        public int? Code;
        public string Reason;        // "conflict" | "auth" | "replaced"
        public double? RetryInMs;
        public string Signal;

        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        public static StatusEvent Parse(string line)
        {
            Dictionary<string, object> o;
            try { o = Json.Deserialize<Dictionary<string, object>>(line); }
            catch (Exception) { return null; }
            if (o == null || !(o.TryGetValue("ev", out var ev) && ev is string evs)) return null;
            return new StatusEvent
            {
                Ev = evs,
                Mode = Str(o, "mode"),
                Machine = Str(o, "machine"),
                Account = Str(o, "account"),
                DashboardUrl = Str(o, "dashboardUrl"),
                ShareUrl = Str(o, "shareUrl"),
                Cpu = Num(o, "cpu"),
                MemUsed = Num(o, "memUsed"),
                MemTotal = Num(o, "memTotal"),
                Cores = (int?)Num(o, "cores"),
                Rtt = Num(o, "rtt"),
                Online = o.TryGetValue("online", out var on) && on is bool b ? b : (bool?)null,
                Code = (int?)Num(o, "code"),
                Reason = Str(o, "reason"),
                RetryInMs = Num(o, "retryInMs"),
                Signal = Str(o, "signal"),
            };
        }

        static string Str(Dictionary<string, object> o, string k) =>
            o.TryGetValue(k, out var v) ? v as string : null;

        static double? Num(Dictionary<string, object> o, string k)
        {
            if (!o.TryGetValue(k, out var v) || v == null) return null;
            switch (v)
            {
                case int i: return i;
                case long l: return l;
                case decimal m: return (double)m;
                case double d: return d;
                default: return null;
            }
        }
    }

    enum ConnKind { Stopped, Starting, Connecting, Online, Reconnecting, Fatal }

    enum FatalReason { Conflict, Auth, Replaced, Crashed }

    /// High-level connection state the menu reflects, derived from the event stream
    /// plus the supervised process's own lifecycle.
    readonly struct ConnState : IEquatable<ConnState>
    {
        public readonly ConnKind Kind;
        public readonly int RetryInMs;        // Reconnecting
        public readonly FatalReason Reason;   // Fatal

        ConnState(ConnKind kind, int retry = 0, FatalReason reason = FatalReason.Crashed)
        {
            Kind = kind; RetryInMs = retry; Reason = reason;
        }

        public static readonly ConnState Stopped = new ConnState(ConnKind.Stopped);
        public static readonly ConnState Starting = new ConnState(ConnKind.Starting);
        public static readonly ConnState Connecting = new ConnState(ConnKind.Connecting);
        public static readonly ConnState Online = new ConnState(ConnKind.Online);
        public static ConnState Reconnecting(int ms) => new ConnState(ConnKind.Reconnecting, ms);
        public static ConnState Fatal(FatalReason r) => new ConnState(ConnKind.Fatal, 0, r);

        public bool IsRunningish => Kind != ConnKind.Stopped && Kind != ConnKind.Fatal;

        public string Title
        {
            get
            {
                switch (Kind)
                {
                    case ConnKind.Stopped: return "Stopped";
                    case ConnKind.Starting: return "Starting…";
                    case ConnKind.Connecting: return "Connecting…";
                    case ConnKind.Online: return "Online";
                    case ConnKind.Reconnecting: return "Reconnecting…";
                    default: return Headline(Reason);
                }
            }
        }

        public static FatalReason ParseReason(string s)
        {
            switch (s)
            {
                case "conflict": return FatalReason.Conflict;
                case "auth": return FatalReason.Auth;
                case "replaced": return FatalReason.Replaced;
                default: return FatalReason.Crashed;
            }
        }

        public static string Headline(FatalReason r)
        {
            switch (r)
            {
                case FatalReason.Conflict: return "Another daemon is connected";
                case FatalReason.Auth: return "Sign-in expired";
                case FatalReason.Replaced: return "Replaced by a newer daemon";
                default: return "Daemon stopped unexpectedly";
            }
        }

        public static string Hint(FatalReason r)
        {
            switch (r)
            {
                case FatalReason.Conflict: return "Stop the other daemon, then press Start.";
                case FatalReason.Auth: return "Sign in again to reconnect.";
                case FatalReason.Replaced: return "This machine is being served elsewhere.";
                default: return "Press Start to relaunch.";
            }
        }

        public bool Equals(ConnState o) => Kind == o.Kind && RetryInMs == o.RetryInMs && Reason == o.Reason;
        public override bool Equals(object obj) => obj is ConnState o && Equals(o);
        public override int GetHashCode() => ((int)Kind * 397) ^ RetryInMs ^ ((int)Reason << 20);
        public static bool operator ==(ConnState a, ConnState b) => a.Equals(b);
        public static bool operator !=(ConnState a, ConnState b) => !a.Equals(b);
    }
}
