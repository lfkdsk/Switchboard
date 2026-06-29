import Foundation

/// Headless verification of the supervisor↔daemon wiring, no GUI involved.
/// Launches the daemon via the supervisor, prints every connection-state change
/// for a few seconds, then exits non-zero if it never came online.
///
/// Run with:  swift run Switchboard --selftest
/// (needs SWITCHBOARD_NODE / SWITCHBOARD_CLI or a `node` on PATH + ../cli)
///
/// Note: the supervisor polls its status file via a Foundation `Timer`, which
/// needs a live run loop — so this harness drives `RunLoop.main.run`, not
/// `dispatchMain()`. The cross-actor reads below are all on the main thread (the
/// timer/dispatch callbacks fire there); the resulting Swift-5 isolation warnings
/// are harness-only and don't touch the app target.
enum SelfTest {
    static func run() {
        let duration = ProcessInfo.processInfo.environment["SELFTEST_SECONDS"]
            .flatMap(Double.init) ?? 8
        var sawOnline = false
        var lastTitle = ""

        DispatchQueue.main.async {
            let prefs = Prefs()
            if let server = ProcessInfo.processInfo.environment["SWITCHBOARD_SERVER"] {
                prefs.server = server
            }
            let sup = DaemonSupervisor(prefs: prefs)
            log("starting daemon (server=\(prefs.normalizedServer))")
            sup.start()

            let poll = Timer(timeInterval: 0.2, repeats: true) { _ in
                let title = sup.state.title
                guard title != lastTitle else { return }
                lastTitle = title
                var extra = ""
                if sup.state == .online {
                    sawOnline = true
                    let dash = sup.dashboardURL
                    let share = sup.shareURL
                    extra = " machine=\(sup.machineName ?? "?") mode=\(sup.mode ?? "?")"
                    if let url = dash ?? share { extra += " url=\(url)" }
                }
                log("state → \(title)\(extra)")
            }
            RunLoop.main.add(poll, forMode: .common)

            DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
                poll.invalidate()
                sup.stop()
                log(sawOnline ? "PASS — reached online" : "FAIL — never online")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { exit(sawOnline ? 0 : 1) }
            }
        }

        RunLoop.main.run(until: Date().addingTimeInterval(duration + 3))
        exit(sawOnline ? 0 : 1)
    }
}

private func log(_ s: String) {
    FileHandle.standardError.write(Data("[selftest] \(s)\n".utf8))
}
