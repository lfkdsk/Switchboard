import Foundation
import AppKit

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

    init(prefs: Prefs) {
        self.prefs = prefs
    }

    var isRunning: Bool { process != nil }

    // MARK: Lifecycle

    func start(login: Bool = false) {
        guard process == nil else { return }
        guard let rt = NodeRuntime.resolve() else {
            runtimeMissing = true
            state = .fatal(.crashed)
            return
        }
        runtimeMissing = false
        intentionalStop = false
        pendingFatal = nil

        // A fresh status file per launch, so offsets reset cleanly on restart.
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("switchboard-status-\(ProcessInfo.processInfo.processIdentifier)-\(Int(Date().timeIntervalSince1970 * 1000)).ndjson")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        statusURL = url
        statusHandle = try? FileHandle(forReadingFrom: url)
        lineBuffer = ""

        let p = Process()
        p.executableURL = rt.node
        p.arguments = login ? [rt.cli.path, "login"] : [rt.cli.path]

        var env = ProcessInfo.processInfo.environment
        env["SWITCHBOARD_STATUS_FILE"] = url.path
        env["SWITCHBOARD_SERVER"] = prefs.normalizedServer
        if !prefs.shell.trimmingCharacters(in: .whitespaces).isEmpty {
            env["SWITCHBOARD_SHELL"] = prefs.shell
        }
        p.environment = env

        // Daemon logs (human-readable) go to a rolling file; status flows via the
        // NDJSON file above, so we never have to drain a pipe.
        if let logHandle = Self.openLogHandle() {
            p.standardOutput = logHandle
            p.standardError = logHandle
        }

        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.handleTermination(code: proc.terminationStatus) }
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
        p.environment = ProcessInfo.processInfo.environment
        try? p.run()
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
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
        // Drain any final status lines the daemon wrote on its way out.
        drainStatus()
        stopStatusPolling()

        if intentionalStop {
            state = .stopped
            return
        }
        if let fatal = pendingFatal {
            state = .fatal(fatal)
            return
        }
        // Unexpected exit with no fatal marker — treat as a crash and retry with
        // backoff. A clean `connected`/`ready` resets the backoff to 1s.
        scheduleRestart()
    }

    private func scheduleRestart() {
        cancelRestart()
        let delayMs = backoffMs
        state = .reconnecting(delayMs)
        let work = DispatchWorkItem { [weak self] in self?.start() }
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
            Task { @MainActor in self?.drainStatus() }
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
            mode = e.mode ?? mode
            state = .online
        case "ready":
            backoffMs = 1000
            mode = e.mode ?? mode
            machineName = e.machine ?? machineName
            account = e.account ?? account
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
