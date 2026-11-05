import Foundation
import AppKit
import Darwin
import UpdatePolicy

/// Owns the Node daemon child process and the live state the menu renders.
/// One instance, on the main actor; the only observable the UI binds to.
@MainActor
final class DaemonSupervisor: ObservableObject {
    // Connection / identity
    @Published private(set) var state: ConnState = .stopped
    @Published private(set) var machineName: String?
    @Published private(set) var mode: String?            // "account" | "token"
    @Published private(set) var account: String?
    @Published private(set) var dashboardURL: String?
    @Published private(set) var shareURL: String?
    @Published private(set) var peerOnline: Bool = false
    @Published private(set) var runtimeMissing: Bool = false

    // Host stats (nil until the first `stats` tick)
    @Published private(set) var cpu: Double?
    @Published private(set) var memUsed: Double?
    @Published private(set) var memTotal: Double?
    @Published private(set) var cores: Int?
    @Published private(set) var rtt: Double?

    private let prefs: Prefs

    private var process: Process?
    private var intentionalStop = false
    private var pendingFatal: FatalReason?
    private var statusHandle: FileHandle?
    private var statusURL: URL?
    private var lineBuffer = ""
    private var statusTimer: Timer?
    private var restartWork: DispatchWorkItem?
    private var backoffMs = 1000
    private var reconnectToken: String?

    // Sparkle may only terminate this app after an atomic, fail-closed idle
    // check. The completion is held until the supervised daemon has exited.
    private let updateActivityProbe = UpdateActivityProbe()
    private var updateStopCompletion: ((UpdateInstallDecision) -> Void)?
    private var updateStopTimeout: DispatchWorkItem?

    // Crash rollback for hot-updated cli code: if a launch that ran a staged
    // update dies twice in a row within seconds, drop the update and let the
    // bundled cli take the next restart.
    private var lastLaunchDate: Date?
    private var lastLaunchWasHotUpdate = false
    private var hotUpdateStrikes = 0

    init(prefs: Prefs) {
        self.prefs = prefs
    }

    var isRunning: Bool { process != nil }

    // MARK: Lifecycle

    func start(login: Bool = false, oneOffToken: String? = nil) {
        guard process == nil, updateStopCompletion == nil else { return }
        guard let rt = NodeRuntime.resolve() else {
            runtimeMissing = true
            state = .fatal(.crashed)
            return
        }
        runtimeMissing = false
        intentionalStop = false
        pendingFatal = nil
        reconnectToken = oneOffToken
        account = nil

        // A fresh status file per launch, so offsets reset cleanly on restart.
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("switchboard-status-\(ProcessInfo.processInfo.processIdentifier)-\(Int(Date().timeIntervalSince1970 * 1000)).ndjson")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        statusURL = url
        statusHandle = try? FileHandle(forReadingFrom: url)
        lineBuffer = ""

        let p = Process()
        p.executableURL = rt.node
        if login {
            p.arguments = [rt.cli.path, "login"]
        } else if let oneOffToken {
            p.arguments = [rt.cli.path, "--token", oneOffToken]
        } else {
            p.arguments = [rt.cli.path]
        }

        var env = ProcessInfo.processInfo.environment
        env["SWITCHBOARD_STATUS_FILE"] = url.path
        env["SWITCHBOARD_SERVER"] = prefs.normalizedServer
        if !prefs.shell.trimmingCharacters(in: .whitespaces).isEmpty {
            env["SWITCHBOARD_SHELL"] = prefs.shell
        }
        // Only ever set to decline: absent means the daemon's own default (on).
        if !prefs.peer {
            env["SWITCHBOARD_PEER"] = "0"
        }
        if let np = rt.nodePathDir {
            env["NODE_PATH"] = np.path
        }
        p.environment = env

        lastLaunchDate = Date()
        lastLaunchWasHotUpdate = rt.isHotUpdate

        // Daemon logs (human-readable) go to a rolling file; status flows via the
        // NDJSON file above, so we never have to drain a pipe.
        if let logHandle = Self.openLogHandle() {
            p.standardOutput = logHandle
            p.standardError = logHandle
        }

        p.terminationHandler = { proc in
            let status = proc.terminationStatus
            DispatchQueue.main.async { [weak self] in self?.handleTermination(code: status) }
        }

        do {
            try p.run()
        } catch {
            statusHandle = nil
            state = .fatal(.crashed)
            return
        }
        process = p
        state = .starting
        startStatusPolling()
    }

    func stop() {
        intentionalStop = true
        cancelRestart()
        stopStatusPolling()
        if let p = process, p.isRunning {
            p.interrupt() // SIGINT → daemon cleans up sessions and exits
        }
        // handleTermination flips state to .stopped when the process actually dies.
        if process == nil { state = .stopped }
    }

    func restart() {
        let wasLogin = false
        stop()
        // Give SIGINT a beat to land before relaunching.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.start(login: wasLogin)
        }
    }

    /// Atomically transitions an idle daemon to stopped for a silent app update.
    ///
    /// A read-only preflight avoids pausing active work. If it looks idle, stop
    /// the daemon, repeat the same probe while it cannot accept a new request,
    /// and only then terminate it. Any missing or malformed signal postpones.
    func prepareForAutomaticAppUpdate(
        completion: @escaping (UpdateInstallDecision) -> Void
    ) {
        guard updateStopCompletion == nil else {
            completion(.unavailable("Another app-update activity check is already in progress."))
            return
        }

        guard let daemon = process else {
            completion(UpdateInstallPolicy.evaluate(updateActivityProbe.snapshot(daemonPID: nil)))
            return
        }
        guard daemon.isRunning else {
            completion(.unavailable("The daemon is still finishing its shutdown."))
            return
        }

        let pid = daemon.processIdentifier
        let preflight = UpdateInstallPolicy.evaluate(updateActivityProbe.snapshot(daemonPID: pid))
        guard preflight.canInstallAutomatically else {
            completion(preflight)
            return
        }

        guard Darwin.kill(pid, SIGSTOP) == 0 else {
            completion(.unavailable("The daemon could not be paused for the final activity check."))
            return
        }

        guard process === daemon, daemon.isRunning else {
            _ = Darwin.kill(pid, SIGCONT)
            completion(.unavailable("The daemon changed during the final activity check."))
            return
        }

        let frozenDecision = UpdateInstallPolicy.evaluate(updateActivityProbe.snapshot(daemonPID: pid))
        guard frozenDecision.canInstallAutomatically else {
            _ = Darwin.kill(pid, SIGCONT)
            completion(frozenDecision)
            return
        }

        // SIGKILL is intentional here: the process is frozen and proven to have
        // no child task, shell-holder socket, or running JobStore record. Keeping
        // it frozen until death closes the check→stop race completely.
        intentionalStop = true
        cancelRestart()
        stopStatusPolling()
        updateStopCompletion = completion
        guard Darwin.kill(pid, SIGKILL) == 0 else {
            updateStopCompletion = nil
            intentionalStop = false
            _ = Darwin.kill(pid, SIGCONT)
            startStatusPolling()
            completion(.unavailable("The idle daemon could not be stopped for the app update."))
            return
        }
        armUpdateStopWatchdog(for: daemon, forceOnTimeout: false)
    }

    /// Explicit menu action. The confirmation is owned by AppUpdater; unlike the
    /// automatic path this may stop work because the user chose to restart now.
    func prepareForUserRequestedAppUpdate(
        completion: @escaping (UpdateInstallDecision) -> Void
    ) {
        guard updateStopCompletion == nil else {
            completion(.unavailable("Another app-update stop is already in progress."))
            return
        }
        guard let daemon = process else {
            completion(.ready)
            return
        }

        intentionalStop = true
        cancelRestart()
        stopStatusPolling()
        updateStopCompletion = completion
        if daemon.isRunning {
            daemon.interrupt()
            armUpdateStopWatchdog(for: daemon, forceOnTimeout: true)
        } else {
            armUpdateStopWatchdog(for: daemon, forceOnTimeout: true)
        }
    }

    private func armUpdateStopWatchdog(for daemon: Process, forceOnTimeout: Bool) {
        updateStopTimeout?.cancel()
        let pid = daemon.processIdentifier
        let work = DispatchWorkItem { [weak self, weak daemon] in
            guard let self, let daemon, self.process === daemon,
                  self.updateStopCompletion != nil else { return }
            if forceOnTimeout, daemon.isRunning {
                _ = Darwin.kill(pid, SIGKILL)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self, weak daemon] in
                guard let self, let daemon, self.process === daemon,
                      let completion = self.updateStopCompletion else { return }
                self.updateStopCompletion = nil
                self.updateStopTimeout = nil
                completion(.unavailable("The daemon did not stop in time for the app update."))
            }
        }
        updateStopTimeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
    }

    func signIn() {
        stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.start(login: true)
        }
    }

    /// Runs `node cli logout` once, then stops the daemon and refreshes identity.
    func signOut() {
        stop()
        guard let rt = NodeRuntime.resolve() else { return }
        let p = Process()
        p.executableURL = rt.node
        p.arguments = [rt.cli.path, "logout"]
        var env = ProcessInfo.processInfo.environment
        if let np = rt.nodePathDir { env["NODE_PATH"] = np.path }
        p.environment = env
        try? p.run()
        p.terminationHandler = { _ in
            DispatchQueue.main.async { [weak self] in
                self?.account = nil
                self?.mode = nil
            }
        }
    }

    // MARK: Actions

    func openDashboard() {
        guard let s = dashboardURL ?? shareURL, let url = URL(string: s) else { return }
        NSWorkspace.shared.open(url)
    }

    func copyShareURL() {
        guard let s = shareURL else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }

    // MARK: Termination & restart

    private func handleTermination(code: Int32) {
        process = nil
        let appUpdateCompletion = updateStopCompletion
        updateStopCompletion = nil
        updateStopTimeout?.cancel()
        updateStopTimeout = nil
        // Drain any final status lines the daemon wrote on its way out.
        drainStatus()
        stopStatusPolling()

        if let appUpdateCompletion {
            state = .stopped
            appUpdateCompletion(.ready)
            return
        }

        if intentionalStop {
            state = .stopped
            return
        }
        if let fatal = pendingFatal {
            state = .fatal(fatal)
            return
        }
        // A hot-updated cli that dies almost immediately is presumed broken:
        // two strikes and the staged update is dropped, so the restart below
        // resolves back to the known-good bundled cli.
        if lastLaunchWasHotUpdate,
           let started = lastLaunchDate, Date().timeIntervalSince(started) < 20 {
            hotUpdateStrikes += 1
            if hotUpdateStrikes >= 2 {
                DaemonUpdater.revertToBundled(
                    reason: "daemon exited \(hotUpdateStrikes)× within 20s of start (code \(code))")
                hotUpdateStrikes = 0
            }
        }
        // Unexpected exit with no fatal marker — treat as a crash and retry with
        // backoff. A clean `connected`/`ready` resets the backoff to 1s.
        scheduleRestart()
    }

    private func scheduleRestart() {
        cancelRestart()
        let delayMs = backoffMs
        let token = reconnectToken
        state = .reconnecting(delayMs)
        let work = DispatchWorkItem { [weak self] in self?.start(oneOffToken: token) }
        restartWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(delayMs), execute: work)
        backoffMs = min(backoffMs * 2, 15000)
    }

    private func cancelRestart() {
        restartWork?.cancel()
        restartWork = nil
    }

    // MARK: Status file polling

    private func startStatusPolling() {
        stopStatusPolling()
        let t = Timer(timeInterval: 0.35, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in self.drainStatus() }
        }
        RunLoop.main.add(t, forMode: .common)
        statusTimer = t
    }

    private func stopStatusPolling() {
        statusTimer?.invalidate()
        statusTimer = nil
    }

    private func drainStatus() {
        guard let h = statusHandle else { return }
        let data = h.availableData
        guard !data.isEmpty, let chunk = String(data: data, encoding: .utf8) else { return }
        lineBuffer += chunk
        while let nl = lineBuffer.firstIndex(of: "\n") {
            let line = String(lineBuffer[..<nl])
            lineBuffer = String(lineBuffer[lineBuffer.index(after: nl)...])
            if let d = line.data(using: .utf8),
               let ev = try? JSONDecoder().decode(StatusEvent.self, from: d) {
                apply(ev)
            }
        }
    }

    private func apply(_ e: StatusEvent) {
        switch e.ev {
        case "connecting":
            mode = e.mode ?? mode
            if state == .starting || state == .stopped { state = .connecting }
        case "connected":
            backoffMs = 1000
            hotUpdateStrikes = 0
            mode = e.mode ?? mode
            state = .online
        case "ready":
            backoffMs = 1000
            hotUpdateStrikes = 0
            mode = e.mode ?? mode
            machineName = e.machine ?? machineName
            account = e.account
            dashboardURL = e.dashboardUrl ?? dashboardURL
            shareURL = e.shareUrl
            state = .online
        case "stats":
            cpu = e.cpu; memUsed = e.memUsed; memTotal = e.memTotal
            cores = e.cores; rtt = e.rtt
            if !state.isRunningish || state == .starting { state = .online }
        case "peer":
            peerOnline = e.online ?? false
        case "disconnected":
            peerOnline = false
            state = .reconnecting(Int(e.retryInMs ?? 1000))
        case "fatal":
            let reason = FatalReason(rawValue: e.reason ?? "") ?? .crashed
            pendingFatal = reason
            state = .fatal(reason)
        case "stopping":
            intentionalStop = true
        default:
            break
        }
    }

    // MARK: Logging

    private static func openLogHandle() -> FileHandle? {
        let fm = FileManager.default
        let dir = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Switchboard")
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("daemon.log")
        if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
        let h = try? FileHandle(forWritingTo: url)
        _ = try? h?.seekToEnd()
        return h
    }
}
