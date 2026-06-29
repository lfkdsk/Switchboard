import Foundation

/// Locates the Node binary and the daemon entry (cli/index.js) to run.
///
/// Resolution order:
///   1. Bundled runtime inside the .app — Resources/runtime/bin/node + runtime/cli/index.js
///      (what scripts/make-app.sh produces; the only path that works for a
///      distributed app, since a GUI process has a minimal PATH).
///   2. Dev override via SWITCHBOARD_NODE + SWITCHBOARD_CLI env vars.
///   3. System `node` on PATH + a sibling ../cli/index.js relative to the binary
///      (handy when running `swift run` from inside the repo).
enum NodeRuntime {
    struct Resolved {
        let node: URL
        let cli: URL
    }

    static func resolve() -> Resolved? {
        let fm = FileManager.default

        // 1. Bundled runtime.
        if let res = Bundle.main.resourceURL {
            let node = res.appendingPathComponent("runtime/bin/node")
            let cli = res.appendingPathComponent("runtime/cli/index.js")
            if fm.isExecutableFile(atPath: node.path), fm.fileExists(atPath: cli.path) {
                return Resolved(node: node, cli: cli)
            }
        }

        // 2. Explicit dev override.
        let env = ProcessInfo.processInfo.environment
        if let n = env["SWITCHBOARD_NODE"], let c = env["SWITCHBOARD_CLI"],
           fm.isExecutableFile(atPath: n), fm.fileExists(atPath: c) {
            return Resolved(node: URL(fileURLWithPath: n), cli: URL(fileURLWithPath: c))
        }

        // 3. System node + a discoverable cli/index.js.
        guard let node = which("node") else { return nil }
        if let c = env["SWITCHBOARD_CLI"], fm.fileExists(atPath: c) {
            return Resolved(node: node, cli: URL(fileURLWithPath: c))
        }
        for candidate in repoCliCandidates() where fm.fileExists(atPath: candidate.path) {
            return Resolved(node: node, cli: candidate)
        }
        return nil
    }

    /// Plausible cli/index.js locations when developing from the repo.
    private static func repoCliCandidates() -> [URL] {
        var urls: [URL] = []
        let exe = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
        // .build/<config>/Switchboard → repo is three levels up, cli is a sibling of macos/
        let buildRoot = exe.deletingLastPathComponent() // <config>
            .deletingLastPathComponent()                // .build
            .deletingLastPathComponent()                // macos
            .deletingLastPathComponent()                // repo root
        urls.append(buildRoot.appendingPathComponent("cli/index.js"))
        urls.append(FileManager.default.currentDirectoryPath.isEmpty
            ? buildRoot.appendingPathComponent("cli/index.js")
            : URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
                .appendingPathComponent("../cli/index.js").standardized)
        return urls
    }

    /// Minimal `which`, since a GUI app can't rely on a login shell's PATH.
    private static func which(_ tool: String) -> URL? {
        let env = ProcessInfo.processInfo.environment
        var dirs = (env["PATH"] ?? "").split(separator: ":").map(String.init)
        // Common Homebrew / nvm-ish spots a GUI launch won't have on PATH.
        dirs += ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
        for dir in dirs {
            let candidate = URL(fileURLWithPath: dir).appendingPathComponent(tool)
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }
}
