import Foundation

/// One independently collected signal used by the app-update installation gate.
/// An unavailable signal is deliberately not equivalent to zero activity.
public enum ActivityObservation: Equatable, Sendable {
    case count(Int)
    case unavailable(String)
}

public struct UpdateActivitySnapshot: Equatable, Sendable {
    public let daemonDescendants: ActivityObservation
    public let shellHolderSockets: ActivityObservation
    public let runningDetachedJobs: ActivityObservation

    public init(
        daemonDescendants: ActivityObservation,
        shellHolderSockets: ActivityObservation,
        runningDetachedJobs: ActivityObservation
    ) {
        self.daemonDescendants = daemonDescendants
        self.shellHolderSockets = shellHolderSockets
        self.runningDetachedJobs = runningDetachedJobs
    }
}

public enum UpdateInstallDecision: Equatable, Sendable {
    case ready
    case busy(String)
    case unavailable(String)

    public var canInstallAutomatically: Bool { self == .ready }

    public var explanation: String {
        switch self {
        case .ready:
            return "Switchboard is idle."
        case .busy(let reason), .unavailable(let reason):
            return reason
        }
    }
}

/// Pure, fail-closed policy. Collection lives below so this part can be tested
/// with adversarial combinations without touching real processes or user data.
public enum UpdateInstallPolicy {
    public static func evaluate(_ snapshot: UpdateActivitySnapshot) -> UpdateInstallDecision {
        let named: [(singular: String, plural: String, observation: ActivityObservation)] = [
            ("daemon child process", "daemon child processes", snapshot.daemonDescendants),
            ("live shell session", "live shell sessions", snapshot.shellHolderSockets),
            ("running detached job", "running detached jobs", snapshot.runningDetachedJobs),
        ]

        var busy: [String] = []
        var unavailable: [String] = []
        for signal in named {
            switch signal.observation {
            case .count(let count) where count > 0:
                busy.append("\(count) \(count == 1 ? signal.singular : signal.plural)")
            case .count(let count) where count < 0:
                unavailable.append("\(signal.singular) count was invalid")
            case .count:
                break
            case .unavailable(let reason):
                unavailable.append("\(signal.singular): \(reason)")
            }
        }

        if !busy.isEmpty {
            return .busy("Waiting for Switchboard to become idle (\(busy.joined(separator: ", "))).")
        }
        if !unavailable.isEmpty {
            return .unavailable(
                "Waiting because activity could not be verified (\(unavailable.joined(separator: "; ")))."
            )
        }
        return .ready
    }
}

/// Read-only collector for facts already maintained by the daemon:
/// descendants of the supervised process, PTY holder sockets, and JobStore JSON.
public struct UpdateActivityProbe: Sendable {
    private let switchboardRoot: URL
    private let fileManager: FileManager

    public init(
        switchboardRoot: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".switchboard", isDirectory: true),
        fileManager: FileManager = .default
    ) {
        self.switchboardRoot = switchboardRoot
        self.fileManager = fileManager
    }

    public func snapshot(daemonPID: Int32?) -> UpdateActivitySnapshot {
        UpdateActivitySnapshot(
            daemonDescendants: daemonPID.map(processDescendants) ?? .count(0),
            shellHolderSockets: countShellHolderSockets(),
            runningDetachedJobs: countRunningJobs()
        )
    }

    private func processDescendants(of rootPID: Int32) -> ActivityObservation {
        guard rootPID > 0 else { return .unavailable("invalid daemon pid") }

        let process = Process()
        let candidates = ["/bin/ps", "/usr/bin/ps"]
        guard let executable = candidates.first(where: { fileManager.isExecutableFile(atPath: $0) }) else {
            return .unavailable("ps is unavailable")
        }
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = ["-axo", "pid=,ppid="]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                return .unavailable("ps exited \(process.terminationStatus)")
            }
            guard let text = String(data: data, encoding: .utf8) else {
                return .unavailable("ps output was not UTF-8")
            }
            return .count(try Self.descendantCount(rootPID: rootPID, psOutput: text))
        } catch {
            return .unavailable(error.localizedDescription)
        }
    }

    static func descendantCount(rootPID: Int32, psOutput: String) throws -> Int {
        var parents: [Int32: Int32] = [:]
        for (index, line) in psOutput.split(separator: "\n", omittingEmptySubsequences: true).enumerated() {
            let columns = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
            guard columns.count == 2,
                  let pid = Int32(columns[0]),
                  let parent = Int32(columns[1])
            else {
                throw ProbeError.malformedProcessRow(index + 1)
            }
            parents[pid] = parent
        }
        guard parents[rootPID] != nil else { throw ProbeError.daemonMissing }

        var children: [Int32: [Int32]] = [:]
        for (pid, parent) in parents {
            children[parent, default: []].append(pid)
        }
        var seen: Set<Int32> = [rootPID]
        var queue = children[rootPID] ?? []
        var count = 0
        while let pid = queue.popLast() {
            guard seen.insert(pid).inserted else { continue }
            count += 1
            queue.append(contentsOf: children[pid] ?? [])
        }
        return count
    }

    private func countShellHolderSockets() -> ActivityObservation {
        let root = switchboardRoot.appendingPathComponent("sessions", isDirectory: true)
        return enumerate(root: root) { url in url.lastPathComponent == "sock" }
    }

    private func countRunningJobs() -> ActivityObservation {
        let root = switchboardRoot.appendingPathComponent("jobs", isDirectory: true)
        var failure: String?
        let files = enumerateURLs(root: root, failure: &failure) { $0.pathExtension == "json" }
        if let failure { return .unavailable(failure) }

        var running = 0
        for file in files {
            do {
                let record = try JSONDecoder().decode(JobStatus.self, from: Data(contentsOf: file))
                if record.status == "running" { running += 1 }
            } catch {
                return .unavailable("could not read \(file.lastPathComponent)")
            }
        }
        return .count(running)
    }

    private func enumerate(root: URL, matching predicate: (URL) -> Bool) -> ActivityObservation {
        var failure: String?
        let matches = enumerateURLs(root: root, failure: &failure, matching: predicate)
        return failure.map(ActivityObservation.unavailable) ?? .count(matches.count)
    }

    private func enumerateURLs(
        root: URL,
        failure: inout String?,
        matching predicate: (URL) -> Bool
    ) -> [URL] {
        do {
            let attributes = try fileManager.attributesOfItem(atPath: root.path)
            guard attributes[.type] as? FileAttributeType == .typeDirectory else {
                failure = "\(root.lastPathComponent) is not a directory"
                return []
            }
        } catch let error as NSError
            where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError {
            // A fresh install legitimately has no activity directories yet.
            return []
        } catch {
            // fileExists(atPath:) conflates a missing path with permission and
            // I/O failures; treating all of those as zero would fail open.
            failure = "could not inspect \(root.lastPathComponent)"
            return []
        }

        guard fileManager.isReadableFile(atPath: root.path) else {
            failure = "could not read \(root.lastPathComponent)"
            return []
        }

        var enumerationFailure: String?
        guard let enumerator = fileManager.enumerator(
            at: root,
            includingPropertiesForKeys: nil,
            options: [],
            errorHandler: { url, _ in
                enumerationFailure = "could not enumerate \(url.lastPathComponent)"
                return false
            }
        ) else {
            failure = "could not enumerate \(root.lastPathComponent)"
            return []
        }

        var matches: [URL] = []
        for case let url as URL in enumerator where predicate(url) {
            matches.append(url)
        }
        failure = enumerationFailure
        return matches
    }

    private struct JobStatus: Decodable {
        let status: String
    }

    enum ProbeError: LocalizedError, Equatable {
        case malformedProcessRow(Int)
        case daemonMissing

        var errorDescription: String? {
            switch self {
            case .malformedProcessRow(let line): return "malformed ps output at line \(line)"
            case .daemonMissing: return "daemon disappeared during activity check"
            }
        }
    }
}
