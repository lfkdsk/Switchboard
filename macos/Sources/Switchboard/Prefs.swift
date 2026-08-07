import Foundation
import ServiceManagement

/// User-facing preferences, persisted in UserDefaults, plus the login-item toggle.
@MainActor
final class Prefs: ObservableObject {
    private let defaults = UserDefaults.standard
    private enum Key {
        static let server = "server"
        static let shell = "shell"
        static let peer = "peer"
    }

    static let defaultServer = "https://shell.lfkdsk.org"

    @Published var server: String {
        didSet { defaults.set(server, forKey: Key.server) }
    }
    /// Empty means "let the daemon pick $SHELL".
    @Published var shell: String {
        didSet { defaults.set(shell, forKey: Key.shell) }
    }
    /// May the account's *other* machines run commands here (`switchboard exec`)?
    /// On by default, like the CLI. A GUI app inherits launchd's environment
    /// rather than your shell's, so SWITCHBOARD_PEER isn't something a user could
    /// set here — this toggle is the only way to say no.
    @Published var peer: Bool {
        didSet { defaults.set(peer, forKey: Key.peer) }
    }

    @Published var launchAtLogin: Bool = false

    init() {
        server = defaults.string(forKey: Key.server) ?? Prefs.defaultServer
        shell = defaults.string(forKey: Key.shell) ?? ""
        peer = defaults.object(forKey: Key.peer) as? Bool ?? true
        refreshLoginItem()
    }

    var normalizedServer: String {
        let s = server.trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? Prefs.defaultServer : s
    }

    // MARK: Launch at login (macOS 13+ SMAppService)

    func refreshLoginItem() {
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }

    /// Returns false if the toggle couldn't be applied — e.g. running as a bare
    /// `swift run` binary rather than a registered .app bundle.
    @discardableResult
    func setLaunchAtLogin(_ on: Bool) -> Bool {
        do {
            if on {
                if SMAppService.mainApp.status != .enabled {
                    try SMAppService.mainApp.register()
                }
            } else {
                if SMAppService.mainApp.status == .enabled {
                    try SMAppService.mainApp.unregister()
                }
            }
            refreshLoginItem()
            return true
        } catch {
            refreshLoginItem()
            return false
        }
    }
}
