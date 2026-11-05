import AppKit
import Foundation
import Sparkle
import UpdatePolicy

/// Sparkle 2 integration for the application bundle (separate from the npm cli
/// hot updater). Scheduled reminders stay gentle in this LSUIElement app: menu
/// state and the status-item icon change, while only a user check opens Sparkle UI.
@MainActor
final class AppUpdater: NSObject, ObservableObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
    enum Status: Equatable {
        case disabled
        case idle
        case checking
        case available(String)
        case downloading(String)
        case downloaded(String)
        case waitingForIdle(String, String)
        case installing(String)
        case upToDate
        case failed(String)

        var line: String {
            switch self {
            case .disabled:
                return "App updates are disabled in this development build."
            case .idle:
                return "App updates check automatically in the background."
            case .checking:
                return "Checking for an app update…"
            case .available(let version):
                return "Switchboard \(version) is available."
            case .downloading(let version):
                return "Downloading Switchboard \(version)…"
            case .downloaded(let version):
                return "Switchboard \(version) is downloaded."
            case .waitingForIdle(_, let reason):
                return reason
            case .installing(let version):
                return "Installing Switchboard \(version)…"
            case .upToDate:
                return "Switchboard.app is up to date."
            case .failed(let message):
                return "App update failed: \(message)"
            }
        }

        var hasUpdate: Bool {
            switch self {
            case .available, .downloading, .downloaded, .waitingForIdle, .installing:
                return true
            default:
                return false
            }
        }
    }

    @Published private(set) var status: Status = .disabled

    weak var supervisor: DaemonSupervisor?
    private var controller: SPUStandardUpdaterController?
    private var pendingInstallHandler: (() -> Void)?
    private var pendingVersion: String?
    private var retryTimer: Timer?
    private var installAttemptInFlight = false
    private var preparedForInstall = false
    private var restartDaemonIfInstallAborts = false

    override init() {
        super.init()
        guard Self.hasReleaseConfiguration else { return }
        controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: self,
            userDriverDelegate: self
        )
        status = .idle
    }

    var canCheckForUpdates: Bool {
        guard let controller else { return false }
        return controller.updater.canCheckForUpdates || status.hasUpdate
    }

    var canRestartAndInstall: Bool { pendingInstallHandler != nil }

    func checkForUpdates() {
        guard let controller else { return }
        status = .checking
        NSApp.activate(ignoringOtherApps: true)
        controller.checkForUpdates(nil)
    }

    /// Explicit override for a downloaded update that automatic policy deferred.
    /// The alert makes the detached-job consequence clear before stopping daemon.
    func confirmRestartAndInstall() {
        guard pendingInstallHandler != nil, let version = pendingVersion else { return }

        let alert = NSAlert()
        alert.messageText = "Restart and install Switchboard \(version)?"
        alert.informativeText = "Open shell sessions normally reconnect after the app restarts. Any running detached job may be stopped. Choose Wait to let Switchboard update automatically when all work is idle."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Restart and Update")
        alert.addButton(withTitle: "Wait")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        retryTimer?.invalidate()
        retryTimer = nil
        status = .installing(version)
        guard let supervisor else {
            status = .failed("daemon supervisor is unavailable")
            return
        }
        let daemonWasRunning = supervisor.isRunning
        supervisor.prepareForUserRequestedAppUpdate { [weak self] decision in
            guard let self else { return }
            if decision.canInstallAutomatically {
                self.restartDaemonIfInstallAborts = daemonWasRunning
                self.invokeInstallHandler()
            } else {
                self.status = .waitingForIdle(version, decision.explanation)
                self.startRetryTimer()
            }
        }
    }

    private static var hasReleaseConfiguration: Bool {
        let info = Bundle.main.infoDictionary ?? [:]
        let feed = (info["SUFeedURL"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = (info["SUPublicEDKey"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return !(feed ?? "").isEmpty && !(key ?? "").isEmpty
    }

    private func holdInstallation(version: String, handler: @escaping () -> Void) {
        preparedForInstall = false
        restartDaemonIfInstallAborts = false
        pendingVersion = version
        pendingInstallHandler = handler
        status = .waitingForIdle(version, "App update downloaded; waiting for Switchboard to become idle.")
        startRetryTimer()
        // The delegate must return before Sparkle's immediate handler is invoked.
        DispatchQueue.main.async { [weak self] in self?.attemptAutomaticInstallation() }
    }

    private func startRetryTimer() {
        guard retryTimer == nil, pendingInstallHandler != nil else { return }
        let timer = Timer(timeInterval: 60, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in self.attemptAutomaticInstallation() }
        }
        RunLoop.main.add(timer, forMode: .common)
        retryTimer = timer
    }

    private func attemptAutomaticInstallation() {
        guard !installAttemptInFlight,
              pendingInstallHandler != nil,
              let version = pendingVersion,
              let supervisor
        else { return }

        installAttemptInFlight = true
        let daemonWasRunning = supervisor.isRunning
        supervisor.prepareForAutomaticAppUpdate { [weak self] decision in
            guard let self else { return }
            self.installAttemptInFlight = false
            if decision.canInstallAutomatically {
                self.status = .installing(version)
                self.restartDaemonIfInstallAborts = daemonWasRunning
                self.invokeInstallHandler()
            } else {
                self.status = .waitingForIdle(version, decision.explanation)
            }
        }
    }

    private func invokeInstallHandler() {
        guard let handler = pendingInstallHandler else { return }
        pendingInstallHandler = nil
        retryTimer?.invalidate()
        retryTimer = nil
        preparedForInstall = true
        handler()
    }

    // MARK: SPUUpdaterDelegate

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        status = .available(item.displayVersionString)
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: Error) {
        status = .upToDate
    }

    func updater(_ updater: SPUUpdater, willDownloadUpdate item: SUAppcastItem, with request: NSMutableURLRequest) {
        status = .downloading(item.displayVersionString)
    }

    func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) {
        status = .downloaded(item.displayVersionString)
    }

    func updater(_ updater: SPUUpdater, failedToDownloadUpdate item: SUAppcastItem, error: Error) {
        status = .failed(error.localizedDescription)
    }

    func updater(
        _ updater: SPUUpdater,
        willInstallUpdateOnQuit item: SUAppcastItem,
        immediateInstallationBlock immediateInstallHandler: @escaping () -> Void
    ) -> Bool {
        holdInstallation(version: item.displayVersionString, handler: immediateInstallHandler)
        return true
    }

    func updater(
        _ updater: SPUUpdater,
        shouldPostponeRelaunchForUpdate item: SUAppcastItem,
        untilInvokingBlock installHandler: @escaping () -> Void
    ) -> Bool {
        // Our automatic/manual preparation already stopped the daemon atomically.
        if preparedForInstall { return false }
        holdInstallation(version: item.displayVersionString, handler: installHandler)
        return true
    }

    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        let shouldRestartDaemon = preparedForInstall && restartDaemonIfInstallAborts
        preparedForInstall = false
        restartDaemonIfInstallAborts = false
        if shouldRestartDaemon { supervisor?.start() }
        guard pendingInstallHandler == nil, status != .upToDate else { return }
        status = .failed(error.localizedDescription)
    }

    // MARK: SPUStandardUserDriverDelegate (gentle LSUIElement reminders)

    var supportsGentleScheduledUpdateReminders: Bool { true }

    func standardUserDriverShouldHandleShowingScheduledUpdate(
        _ update: SUAppcastItem,
        andInImmediateFocus immediateFocus: Bool
    ) -> Bool {
        false
    }

    func standardUserDriverWillHandleShowingUpdate(
        _ handleShowingUpdate: Bool,
        forUpdate update: SUAppcastItem,
        state: SPUUserUpdateState
    ) {
        if !handleShowingUpdate {
            status = .available(update.displayVersionString)
        }
    }

    func standardUserDriverDidReceiveUserAttentionForUpdate(_ update: SUAppcastItem) {
        // Keep a scheduled reminder visible until the user actually opens or
        // acts on it; a background session may finish without user attention.
        if pendingInstallHandler == nil {
            status = .idle
        }
    }
}
