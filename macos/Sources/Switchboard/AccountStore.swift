import Combine
import Darwin
import Foundation

struct AccountIdentity: Equatable {
    let signedIn: Bool
    let login: String?

}

/// Chooses the daemon's confirmed identity while it is alive, but never lets a
/// stale value retained by the supervisor override the on-disk state after the
/// daemon stops. The config also fills the short gap before the `ready` event.
enum AccountIdentityResolver {
    static func resolve(
        daemonAccount: String?,
        daemonRunning: Bool,
        config: AccountConfig
    ) -> AccountIdentity {
        if daemonRunning, let login = normalized(daemonAccount) {
            return AccountIdentity(signedIn: true, login: login)
        }
        return AccountIdentity(
            signedIn: config.signedIn,
            login: normalized(config.login)
        )
    }

    private static func normalized(_ login: String?) -> String? {
        guard let value = login?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }
}

/// App-lifetime account state. It combines live daemon status with the CLI's
/// config and watches both the containing directory (safe across atomic file
/// replacement) and the current file (compatible with older in-place writers).
@MainActor
final class AccountStore: ObservableObject {
    @Published private(set) var identity: AccountIdentity

    var signedIn: Bool { identity.signedIn }
    var login: String? { identity.login }

    private weak var supervisor: DaemonSupervisor?
    private let readConfig: () -> AccountConfig
    private var subscriptions = Set<AnyCancellable>()
    private var configWatcher: ConfigDirectoryWatcher?

    init(
        supervisor: DaemonSupervisor,
        readConfig: @escaping () -> AccountConfig = ConfigReader.read
    ) {
        self.supervisor = supervisor
        self.readConfig = readConfig
        let config = readConfig()
        identity = AccountIdentityResolver.resolve(
            daemonAccount: supervisor.account,
            daemonRunning: supervisor.state.isRunningish,
            config: config
        )

        Publishers.CombineLatest(supervisor.$account, supervisor.$state)
            .sink { [weak self] account, state in
                self?.reload(daemonAccount: account, state: state)
            }
            .store(in: &subscriptions)

        let watcher = ConfigDirectoryWatcher(configURL: ConfigReader.configURL) { [weak self] in
            self?.refresh()
        }
        configWatcher = watcher
        watcher.start()
    }

    func refresh() {
        guard let supervisor else { return }
        reload(daemonAccount: supervisor.account, state: supervisor.state)
    }

    private func reload(daemonAccount: String?, state: ConnState) {
        let next = AccountIdentityResolver.resolve(
            daemonAccount: daemonAccount,
            daemonRunning: state.isRunningish,
            config: readConfig()
        )
        if next != identity { identity = next }
    }
}

/// Watches ~/.switchboard when it exists and the home directory while waiting
/// for it to be created. No directory is created merely to observe config.
private final class ConfigDirectoryWatcher {
    private let configURL: URL
    private let configDirectory: URL
    private let fallbackDirectory: URL
    private let eventHandler: () -> Void
    private var directorySource: DispatchSourceFileSystemObject?
    private var fileSource: DispatchSourceFileSystemObject?
    private var watchedDirectory: URL?

    init(configURL: URL, eventHandler: @escaping () -> Void) {
        self.configURL = configURL
        configDirectory = configURL.deletingLastPathComponent()
        fallbackDirectory = configDirectory.deletingLastPathComponent()
        self.eventHandler = eventHandler
    }

    func start() {
        installSources(for: preferredDirectory())
    }

    private func preferredDirectory() -> URL {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: configDirectory.path, isDirectory: &isDirectory),
           isDirectory.boolValue {
            return configDirectory
        }
        return fallbackDirectory
    }

    private func installSources(for directory: URL) {
        directorySource?.cancel()
        fileSource?.cancel()
        directorySource = nil
        fileSource = nil
        watchedDirectory = nil

        let descriptor = open(directory.path, O_EVTONLY)
        guard descriptor >= 0 else { return }

        let nextDirectorySource = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .rename, .delete, .revoke],
            queue: .main
        )
        nextDirectorySource.setEventHandler { [weak self] in self?.directoryChanged() }
        nextDirectorySource.setCancelHandler { close(descriptor) }
        directorySource = nextDirectorySource
        watchedDirectory = directory
        nextDirectorySource.resume()
        if directory == configDirectory { installFileSource() }
    }

    private func installFileSource() {
        fileSource?.cancel()
        fileSource = nil

        let descriptor = open(configURL.path, O_EVTONLY)
        guard descriptor >= 0 else { return }
        let nextFileSource = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .extend, .attrib, .rename, .delete, .revoke],
            queue: .main
        )
        nextFileSource.setEventHandler { [weak self] in self?.fileChanged() }
        nextFileSource.setCancelHandler { close(descriptor) }
        fileSource = nextFileSource
        nextFileSource.resume()
    }

    private func directoryChanged() {
        eventHandler()
        let preferred = preferredDirectory()
        let flags = directorySource?.data ?? []
        if preferred != watchedDirectory
            || flags.contains(.rename)
            || flags.contains(.delete)
            || flags.contains(.revoke) {
            scheduleReinstall()
        } else if preferred == configDirectory {
            // A directory event may be an atomic config replacement. Attach to
            // the new inode so in-place writes remain observable afterward.
            installFileSource()
        }
    }

    private func fileChanged() {
        eventHandler()
        let flags = fileSource?.data ?? []
        if flags.contains(.rename) || flags.contains(.delete) || flags.contains(.revoke) {
            fileSource?.cancel()
            fileSource = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                guard let self, self.preferredDirectory() == self.configDirectory else { return }
                self.installFileSource()
            }
        }
    }

    private func scheduleReinstall() {
        directorySource?.cancel()
        fileSource?.cancel()
        directorySource = nil
        fileSource = nil
        watchedDirectory = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self else { return }
            self.installSources(for: self.preferredDirectory())
        }
    }

    deinit {
        directorySource?.cancel()
        fileSource?.cancel()
    }
}
