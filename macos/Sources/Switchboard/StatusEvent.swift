import Foundation

/// One line of NDJSON emitted by the daemon (see cli/index.js `emitStatus`).
/// Every field past `ev` is optional because each event carries only a subset.
struct StatusEvent: Decodable {
    let ev: String
    // ready / connected / connecting
    var mode: String?          // "account" | "token"
    var machine: String?
    var account: String?
    var machineId: String?
    var dashboardUrl: String?
    var shareUrl: String?
    var token: String?
    var server: String?
    // stats
    var cpu: Double?
    var memUsed: Double?
    var memTotal: Double?
    var cores: Int?
    var rtt: Double?           // may be JSON null → stays nil
    // peer
    var online: Bool?
    // disconnected / fatal
    var code: Int?
    var reason: String?        // "conflict" | "auth" | "replaced"
    var retryInMs: Double?
}

/// High-level connection state the menu reflects, derived from the event stream
/// plus the supervised process's own lifecycle.
enum ConnState: Equatable {
    case stopped                 // daemon not running
    case starting                // process launched, no relay event yet
    case connecting              // dialing the relay
    case online                  // relay handshake done
    case reconnecting(Int)       // dropped; retrying in N ms
    case fatal(FatalReason)      // exited and must not auto-restart

    var isRunningish: Bool {
        switch self {
        case .stopped, .fatal: return false
        default: return true
        }
    }
}

enum FatalReason: String, Equatable {
    case conflict   // 409: another daemon already on this circuit
    case auth       // 401/403: login expired
    case replaced   // 4001: a newer daemon took over
    case crashed    // process died unexpectedly with no fatal event

    var headline: String {
        switch self {
        case .conflict: return "Another daemon is connected"
        case .auth:     return "Sign-in expired"
        case .replaced: return "Replaced by a newer daemon"
        case .crashed:  return "Daemon stopped unexpectedly"
        }
    }

    var hint: String {
        switch self {
        case .conflict: return "Stop the other daemon, then press Start."
        case .auth:     return "Sign in again to reconnect."
        case .replaced: return "This machine is being served elsewhere."
        case .crashed:  return "Press Start to relaunch."
        }
    }
}
