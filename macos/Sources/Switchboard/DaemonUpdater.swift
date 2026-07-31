import Foundation
import CryptoKit

/// Hot-updates the bundled JS daemon (@switch-board/cli) from the npm registry,
/// without shipping a new .app.
///
/// The signed bundle is immutable, so updates are staged under
/// ~/Library/Application Support/Switchboard/cli-updates/<version>/ and the
/// supervisor runs index.js from there when a staged version is newer than the
/// bundled one. Only the package's own JS moves: the Node binary and the
/// node_modules tree (node-pty's native addon included) always come from the
/// signed bundle, via a node_modules symlink into the staged dir (plus NODE_PATH
/// as a fallback). An update whose `dependencies` differ from the bundled
/// package's is refused — that change has to ride a full app release.
///
/// Trust model: metadata and tarball both come from registry.npmjs.org over
/// TLS, and the tarball must match the metadata's sha512 SSRI — the same chain
/// `npm install` trusts.
@MainActor
final class DaemonUpdater: ObservableObject {
    enum Status: Equatable {
        case idle
        case checking
        case upToDate(String)        // latest == what we already run
        case updated(String)         // hot update staged; daemon restarting
        case blocked(String)         // newer version exists but its deps changed
        case failed(String)

        var line: String? {
            switch self {
            case .idle: return nil
            case .checking: return "Checking npm…"
            case .upToDate(let v): return "cli \(v) is up to date."
            case .updated(let v): return "Updated to cli \(v) — daemon restarted."
            case .blocked(let v): return "cli \(v) needs a new app build (deps changed)."
            case .failed(let msg): return "Update failed: \(msg)"
            }
        }
    }

    @Published private(set) var status: Status = .idle
    @Published private(set) var bundledVersion: String?
    @Published private(set) var activeVersion: String?   // what resolve() will actually run
    @Published private(set) var hotUpdateActive = false

    weak var supervisor: DaemonSupervisor?
    private var timer: Timer?
    private var checkTask: Task<Void, Never>?

    nonisolated static let packageName = "@switch-board/cli"
    nonisolated static let registryHost = "registry.npmjs.org"

    init() {
        refresh()
    }

    /// Re-derive the on-disk state (menu calls this on open, supervisor after a
    /// rollback).
    func refresh() {
        let bundled = Self.bundledManifest()
        bundledVersion = bundled?.version
        if let up = Self.activeUpdate() {
            activeVersion = up.version
            hotUpdateActive = true
        } else {
            activeVersion = bundled?.version
            hotUpdateActive = false
        }
    }

    /// Launch-time + periodic checks. Idempotent.
    func startAutoChecks() {
        guard timer == nil, Self.bundledManifest() != nil else { return }
        // First check shortly after launch, then every 6 hours.
        checkTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 20 * 1_000_000_000)
            guard !Task.isCancelled else { return }
            await self?.checkAndApply(auto: true)
        }
        let t = Timer(timeInterval: 6 * 3600, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.checkAndApply(auto: true) }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    /// Check the registry and stage the latest version if it qualifies.
    /// `auto` runs stay quiet on network failure (no scary status from a flaky
    /// wifi moment); manual checks surface everything.
    func checkAndApply(auto: Bool = false) async {
        guard let bundled = Self.bundledManifest() else {
            if !auto { status = .failed("no bundled runtime (dev build)") }
            return
        }
        if case .checking = status { return }
        status = .checking
        do {
            let doc = try await Self.fetchRegistryDoc()
            guard let latest = doc.distTags["latest"], let meta = doc.versions[latest] else {
                throw UpdateError("registry doc has no latest version")
            }
            let running = Self.activeUpdate()?.version ?? bundled.version
            guard SemVer.isNewer(latest, than: running) else {
                status = .upToDate(running)
                refresh()
                return
            }
            guard (meta.dependencies ?? [:]) == (bundled.dependencies ?? [:]) else {
                Self.log("blocked \(latest): dependencies changed, needs a full app release")
                status = .blocked(latest)
                return
            }
            try await Self.stage(meta)
            Self.log("staged \(latest) (was \(running))")
            status = .updated(latest)
            refresh()
            if let sup = supervisor, sup.isRunning { sup.restart() }
        } catch {
            let msg = (error as? UpdateError)?.message ?? error.localizedDescription
            Self.log("check failed: \(msg)")
            if auto, (error as? UpdateError)?.isNetwork ?? true {
                status = .idle          // quiet failure; retry on the next tick
            } else {
                status = .failed(msg)
            }
        }
    }

    // MARK: - On-disk layout (statics, shared with NodeRuntime)

    struct PackageManifest: Decodable {
        let version: String
        let dependencies: [String: String]?
    }

    nonisolated static func updatesDir() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Switchboard/cli-updates")
    }

    nonisolated static func bundledCliDir() -> URL? {
        guard let res = Bundle.main.resourceURL else { return nil }
        let dir = res.appendingPathComponent("runtime/cli")
        return FileManager.default.fileExists(atPath: dir.appendingPathComponent("index.js").path) ? dir : nil
    }

    nonisolated static func bundledManifest() -> PackageManifest? {
        guard let dir = bundledCliDir() else { return nil }
        return manifest(at: dir)
    }

    nonisolated static func manifest(at dir: URL) -> PackageManifest? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("package.json")) else { return nil }
        return try? JSONDecoder().decode(PackageManifest.self, from: data)
    }

    /// The staged update the daemon should run, fully validated — or nil.
    ///
    /// Invalid or stale state (marker without a dir, version not newer than the
    /// bundle after a DMG upgrade, deps drifted from the bundle) reverts to the
    /// bundled cli, and a stale marker is pruned so the check starts clean.
    nonisolated static func activeUpdate() -> (version: String, dir: URL)? {
        let fm = FileManager.default
        let marker = updatesDir().appendingPathComponent("current")
        guard let raw = try? String(contentsOf: marker, encoding: .utf8) else { return nil }
        let version = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !version.isEmpty else { return nil }

        guard let bundled = bundledManifest() else { return nil }
        let dir = updatesDir().appendingPathComponent(version)

        guard SemVer.isNewer(version, than: bundled.version),
              fm.fileExists(atPath: dir.appendingPathComponent("index.js").path),
              let staged = manifest(at: dir),
              staged.version == version,
              (staged.dependencies ?? [:]) == (bundled.dependencies ?? [:])
        else {
            // The DMG train caught up (or the staging is broken) — clean up so
            // the bundled cli wins without re-validating every launch.
            try? fm.removeItem(at: marker)
            log("pruned stale update \(version) (bundled \(bundled.version))")
            return nil
        }

        // node-pty & ws resolve from the signed bundle. A node_modules symlink
        // beside index.js is the primary route (immune to a stray ~/node_modules
        // shadowing NODE_PATH); repair it if the app moved since staging.
        let link = dir.appendingPathComponent("node_modules")
        if let bundledCli = bundledCliDir() {
            let target = bundledCli.appendingPathComponent("node_modules")
            let existing = try? fm.destinationOfSymbolicLink(atPath: link.path)
            if existing != target.path {
                try? fm.removeItem(at: link)
                try? fm.createSymbolicLink(at: link, withDestinationURL: target)
            }
        }
        return (version, dir)
    }

    /// Drop the hot update and fall back to the bundled cli (crash rollback).
    nonisolated static func revertToBundled(reason: String) {
        let marker = updatesDir().appendingPathComponent("current")
        try? FileManager.default.removeItem(at: marker)
        log("reverted to bundled cli: \(reason)")
    }

    // MARK: - Registry

    struct RegistryDoc: Decodable {
        struct Version: Decodable {
            struct Dist: Decodable {
                let tarball: String
                let integrity: String?
            }
            let version: String
            let dependencies: [String: String]?
            let dist: Dist
        }
        let distTags: [String: String]
        let versions: [String: Version]
        enum CodingKeys: String, CodingKey {
            case distTags = "dist-tags"
            case versions
        }
    }

    struct UpdateError: Error {
        let message: String
        var isNetwork = false
        init(_ message: String, isNetwork: Bool = false) {
            self.message = message
            self.isNetwork = isNetwork
        }
    }

    nonisolated static func fetchRegistryDoc() async throws -> RegistryDoc {
        let escaped = packageName.replacingOccurrences(of: "/", with: "%2F")
        guard let url = URL(string: "https://\(registryHost)/\(escaped)") else {
            throw UpdateError("bad registry URL")
        }
        var req = URLRequest(url: url, timeoutInterval: 30)
        // Abbreviated install doc: dist-tags + per-version dependencies/dist.
        req.setValue("application/vnd.npm.install-v1+json", forHTTPHeaderField: "Accept")
        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw UpdateError("registry unreachable (\(error.localizedDescription))", isNetwork: true)
        }
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw UpdateError("registry HTTP \((resp as? HTTPURLResponse)?.statusCode ?? -1)", isNetwork: true)
        }
        return try JSONDecoder().decode(RegistryDoc.self, from: data)
    }

    /// Download, verify, extract and mark `meta.version` as current.
    nonisolated static func stage(_ meta: RegistryDoc.Version) async throws {
        guard let tarURL = URL(string: meta.dist.tarball),
              tarURL.scheme == "https", tarURL.host == registryHost else {
            throw UpdateError("tarball URL not on \(registryHost): \(meta.dist.tarball)")
        }
        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await URLSession.shared.data(for: URLRequest(url: tarURL, timeoutInterval: 60))
        } catch {
            throw UpdateError("tarball download failed (\(error.localizedDescription))", isNetwork: true)
        }
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw UpdateError("tarball HTTP \((resp as? HTTPURLResponse)?.statusCode ?? -1)", isNetwork: true)
        }
        try verifyIntegrity(data, ssri: meta.dist.integrity)

        let fm = FileManager.default
        let updates = updatesDir()
        try fm.createDirectory(at: updates, withIntermediateDirectories: true)

        let work = updates.appendingPathComponent(".staging-\(UUID().uuidString)")
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: work) }

        let tarball = work.appendingPathComponent("pkg.tgz")
        try data.write(to: tarball)
        try await runTar(tarball: tarball, into: work)

        let extracted = work.appendingPathComponent("package")
        guard fm.fileExists(atPath: extracted.appendingPathComponent("index.js").path) else {
            throw UpdateError("tarball has no package/index.js")
        }

        let dest = updates.appendingPathComponent(meta.version)
        try? fm.removeItem(at: dest)
        try fm.moveItem(at: extracted, to: dest)

        // Marker last, atomically (write-temp + rename): a crash mid-stage
        // leaves the previous version live.
        try meta.version.write(to: updates.appendingPathComponent("current"),
                               atomically: true, encoding: .utf8)

        // Keep only the live version around.
        if let entries = try? fm.contentsOfDirectory(at: updates, includingPropertiesForKeys: nil) {
            for e in entries where e.hasDirectoryPath && e.lastPathComponent != meta.version {
                try? fm.removeItem(at: e)
            }
        }
    }

    nonisolated private static func verifyIntegrity(_ data: Data, ssri: String?) throws {
        guard let ssri else { throw UpdateError("registry metadata lacks integrity") }
        // SSRI can be a space-separated list; we require the sha512 entry.
        guard let entry = ssri.split(separator: " ").first(where: { $0.hasPrefix("sha512-") }) else {
            throw UpdateError("no sha512 integrity entry")
        }
        let expected = String(entry.dropFirst("sha512-".count))
        let digest = SHA512.hash(data: data)
        let actual = Data(digest).base64EncodedString()
        guard actual == expected else {
            throw UpdateError("tarball integrity mismatch")
        }
    }

    nonisolated private static func runTar(tarball: URL, into dir: URL) async throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        p.arguments = ["-x", "-z", "-f", tarball.path, "-C", dir.path]
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            p.terminationHandler = { proc in
                proc.terminationStatus == 0
                    ? cont.resume()
                    : cont.resume(throwing: UpdateError("tar exited \(proc.terminationStatus)"))
            }
            do { try p.run() } catch { cont.resume(throwing: error) }
        }
    }

    // MARK: - Logging

    nonisolated static func log(_ s: String) {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Switchboard")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("updater.log")
        let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(s)\n"
        if let h = try? FileHandle(forWritingTo: url) {
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: Data(line.utf8))
            try? h.close()
        } else {
            try? line.write(to: url, atomically: true, encoding: .utf8)
        }
    }
}

/// Just enough semver for npm versions: numeric x.y.z compare, and a release
/// outranks its own prereleases (1.2.0 > 1.2.0-rc1).
enum SemVer {
    static func isNewer(_ a: String, than b: String) -> Bool {
        compare(a, b) == .orderedDescending
    }

    static func compare(_ a: String, _ b: String) -> ComparisonResult {
        let (aCore, aPre) = split(a)
        let (bCore, bPre) = split(b)
        for i in 0..<3 {
            let x = aCore.count > i ? aCore[i] : 0
            let y = bCore.count > i ? bCore[i] : 0
            if x != y { return x < y ? .orderedAscending : .orderedDescending }
        }
        switch (aPre, bPre) {
        case (nil, nil): return .orderedSame
        case (nil, _): return .orderedDescending   // release > prerelease
        case (_, nil): return .orderedAscending
        case (let p?, let q?): return p == q ? .orderedSame
            : (p < q ? .orderedAscending : .orderedDescending)
        }
    }

    private static func split(_ v: String) -> ([Int], String?) {
        let trimmed = v.hasPrefix("v") ? String(v.dropFirst()) : v
        let parts = trimmed.split(separator: "-", maxSplits: 1)
        let core = parts[0].split(separator: ".").map { Int($0) ?? 0 }
        return (core, parts.count > 1 ? String(parts[1]) : nil)
    }
}
