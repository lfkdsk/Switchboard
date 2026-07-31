import SwiftUI
import AppKit

/// Real entry point: a headless `--selftest` path for CI/manual verification of
/// the supervisor↔daemon wiring, otherwise the normal SwiftUI menu-bar app.
@main
enum EntryPoint {
    static func main() {
        if CommandLine.arguments.contains("--selftest") {
            SelfTest.run()
            return
        }
        if CommandLine.arguments.contains("--update-check") {
            UpdateCheckCLI.run()
            return
        }
        SwitchboardApp.main()
    }
}

/// Headless `--update-check`: one registry check + stage, result on stderr.
/// Exercises the exact code path the menu button uses.
enum UpdateCheckCLI {
    static func run() {
        DispatchQueue.main.async {
            Task { @MainActor in
                let updater = DaemonUpdater()
                await updater.checkAndApply()
                let line = updater.status.line ?? "no status"
                FileHandle.standardError.write(Data("[update-check] \(line)\n".utf8))
                if case .failed = updater.status { exit(1) }
                exit(0)
            }
        }
        RunLoop.main.run(until: Date().addingTimeInterval(120))
        exit(2) // watchdog: never came back from the check
    }
}

struct SwitchboardApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var prefs: Prefs
    @StateObject private var supervisor: DaemonSupervisor
    @StateObject private var updater: DaemonUpdater

    init() {
        let p = Prefs()
        let s = DaemonSupervisor(prefs: p)
        let u = DaemonUpdater()
        u.supervisor = s
        _prefs = StateObject(wrappedValue: p)
        _supervisor = StateObject(wrappedValue: s)
        _updater = StateObject(wrappedValue: u)
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContent(supervisor: supervisor, prefs: prefs, updater: updater)
        } label: {
            Image(systemName: iconName)
                .accessibilityLabel("Switchboard")
                // The label is the only view that exists at launch — the menu
                // content is first created when the user clicks the status item.
                // The delegate handoff must happen here, or silent-launch
                // auto-start would never see a supervisor.
                .onAppear {
                    appDelegate.supervisor = supervisor
                    updater.startAutoChecks()
                }
        }
        .menuBarExtraStyle(.window)
    }

    private var iconName: String {
        switch supervisor.state {
        case .online: return "powerplug.fill"
        case .fatal: return "exclamationmark.triangle.fill"
        case .stopped: return "powerplug"
        case .starting, .connecting, .reconnecting: return "powerplug"
        }
    }
}

/// Makes the process a menu-bar accessory (no Dock icon, no ⌘-Tab entry) even
/// when run as a bare SwiftPM binary, and auto-starts the daemon if a saved
/// login exists. The bundled .app additionally sets LSUIElement in Info.plist.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var supervisor: DaemonSupervisor? {
        didSet { autoStartIfNeeded() }
    }
    private var didAutoStart = false
    private var didFinishLaunching = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        didFinishLaunching = true
        autoStartIfNeeded()
    }

    // Auto-start only when signed in: an anonymous token nobody has seen is
    // useless on a silent launch, so token mode waits for an explicit Start.
    // SwiftUI gives no ordering guarantee between didFinishLaunching and the
    // label's supervisor handoff, so fire from whichever arrives last.
    private func autoStartIfNeeded() {
        guard didFinishLaunching, !didAutoStart, let supervisor else { return }
        didAutoStart = true
        if ConfigReader.read().signedIn {
            supervisor.start()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        supervisor?.stop()
    }
}
