import SwiftUI

/// Presentation helpers for the connection state.
extension ConnState {
    var title: String {
        switch self {
        case .stopped: return "Stopped"
        case .starting: return "Starting…"
        case .connecting: return "Connecting…"
        case .online: return "Online"
        case .reconnecting: return "Reconnecting…"
        case .fatal(let r): return r.headline
        }
    }

    var dotColor: Color {
        switch self {
        case .online: return .green
        case .connecting, .starting, .reconnecting: return .yellow
        case .fatal: return .red
        case .stopped: return .secondary
        }
    }
}

struct MenuContent: View {
    @ObservedObject var supervisor: DaemonSupervisor
    @ObservedObject var prefs: Prefs

    @State private var config = ConfigReader.read()
    @State private var showSettings = false
    @State private var loginItemFailed = false

    private let appVersion = "0.1.0"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header

            if case .fatal(let reason) = supervisor.state {
                fatalBanner(reason)
            } else if supervisor.state == .online {
                statsRow
            }

            Divider()

            actionsSection

            Divider()

            controlSection

            Divider()

            accountSection

            settingsDisclosure

            Divider()

            footer
        }
        .padding(12)
        .frame(width: 290)
        .onAppear {
            config = ConfigReader.read()
            prefs.refreshLoginItem()
        }
    }

    // MARK: Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 7) {
                Circle().fill(supervisor.state.dotColor).frame(width: 9, height: 9)
                Text(supervisor.state.title).font(.system(size: 13, weight: .semibold))
                Spacer()
                if supervisor.peerOnline {
                    Label("viewer", systemImage: "eye.fill")
                        .labelStyle(.iconOnly)
                        .foregroundStyle(.secondary)
                        .help("A browser is viewing this machine")
                }
            }
            HStack(spacing: 6) {
                Text(supervisor.machineName ?? Host.current().localizedName ?? "this machine")
                    .foregroundStyle(.secondary)
                if let m = supervisor.mode {
                    Text("· \(m)").foregroundStyle(.secondary)
                }
            }
            .font(.system(size: 11))
        }
    }

    private var statsRow: some View {
        HStack(spacing: 14) {
            metric("RTT", supervisor.rtt.map { "\(Int($0)) ms" } ?? "—")
            metric("CPU", supervisor.cpu.map { "\(Int($0 * 100))%" } ?? "—")
            metric("Mem", memText)
        }
        .font(.system(size: 11))
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).foregroundStyle(.secondary).font(.system(size: 9))
            Text(value).font(.system(size: 12, weight: .medium)).monospacedDigit()
        }
    }

    private func fatalBanner(_ reason: FatalReason) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(reason.headline).font(.system(size: 12, weight: .medium))
            Text(reason.hint).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
    }

    private var actionsSection: some View {
        VStack(spacing: 2) {
            menuButton("Open dashboard", systemImage: "macwindow") {
                supervisor.openDashboard()
            }
            .disabled((supervisor.dashboardURL ?? supervisor.shareURL) == nil)

            if supervisor.mode == "token", supervisor.shareURL != nil {
                menuButton("Copy share URL", systemImage: "link") {
                    supervisor.copyShareURL()
                }
            }
        }
    }

    private var controlSection: some View {
        VStack(spacing: 2) {
            if supervisor.isRunning {
                menuButton("Stop", systemImage: "stop.fill") { supervisor.stop() }
                menuButton("Restart", systemImage: "arrow.clockwise") { supervisor.restart() }
            } else {
                menuButton(startTitle, systemImage: "play.fill") { supervisor.start() }
            }
        }
    }

    private var accountSection: some View {
        VStack(spacing: 2) {
            if config.signedIn {
                HStack {
                    Label(config.login ?? "signed in", systemImage: "person.crop.circle.fill")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.vertical, 2)
                menuButton("Sign out", systemImage: "rectangle.portrait.and.arrow.right") {
                    supervisor.signOut()
                    config = ConfigReader.read()
                }
            } else {
                menuButton("Sign in…", systemImage: "person.crop.circle.badge.plus") {
                    supervisor.signIn()
                    // Config is written once the browser handshake completes.
                }
            }
        }
    }

    private var settingsDisclosure: some View {
        DisclosureGroup(isExpanded: $showSettings) {
            VStack(alignment: .leading, spacing: 8) {
                labeledField("Relay", text: $prefs.server, placeholder: Prefs.defaultServer)
                labeledField("Shell", text: $prefs.shell, placeholder: "$SHELL (default)")
                Toggle("Launch at login", isOn: Binding(
                    get: { prefs.launchAtLogin },
                    set: { loginItemFailed = !prefs.setLaunchAtLogin($0) }
                ))
                .font(.system(size: 11))
                if loginItemFailed {
                    Text("Couldn't change login item — only works from the bundled app.")
                        .font(.system(size: 9)).foregroundStyle(.secondary)
                }
                Text("Relay/Shell changes apply on the next Start.")
                    .font(.system(size: 9)).foregroundStyle(.secondary)
            }
            .padding(.top, 4)
        } label: {
            Label("Settings", systemImage: "gearshape").font(.system(size: 11))
        }
        .font(.system(size: 11))
    }

    private var footer: some View {
        HStack {
            Text("Switchboard \(appVersion)").font(.system(size: 10)).foregroundStyle(.secondary)
            Spacer()
            Button("Quit") {
                supervisor.stop()
                NSApplication.shared.terminate(nil)
            }
            .font(.system(size: 11))
        }
    }

    // MARK: Bits

    private var startTitle: String {
        config.signedIn ? "Start" : "Start (one-off token)"
    }

    private var memText: String {
        guard let used = supervisor.memUsed, let total = supervisor.memTotal, total > 0 else { return "—" }
        return String(format: "%.1f/%.0f GB", used / 1e9, total / 1e9)
    }

    private func labeledField(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11))
        }
    }

    private func menuButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 12))
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
