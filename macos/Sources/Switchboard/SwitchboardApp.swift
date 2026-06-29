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
        SwitchboardApp.main()
    }
}

struct SwitchboardApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var prefs: Prefs
    @StateObject private var supervisor: DaemonSupervisor

    init() {
        let p = Prefs()
        _prefs = StateObject(wrappedValue: p)
        _supervisor = StateObject(wrappedValue: DaemonSupervisor(prefs: p))
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContent(supervisor: supervisor, prefs: prefs)
                .onAppear { appDelegate.supervisor = supervisor }
        } label: {
            Image(systemName: iconName)
                .accessibilityLabel("Switchboard")
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
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var supervisor: DaemonSupervisor?
    private var didAutoStart = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        // Auto-start only when signed in: an anonymous token nobody has seen is
        // useless on a silent launch, so token mode waits for an explicit Start.
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.didAutoStart else { return }
            self.didAutoStart = true
            if ConfigReader.read().signedIn {
                self.supervisor?.start()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        supervisor?.stop()
    }
}
