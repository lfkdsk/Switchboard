import Foundation
import XCTest
@testable import UpdatePolicy

final class UpdateInstallPolicyTests: XCTestCase {
    func testReadyRequiresEverySignalToBeZero() {
        let snapshot = UpdateActivitySnapshot(
            daemonDescendants: .count(0),
            shellHolderSockets: .count(0),
            runningDetachedJobs: .count(0)
        )

        XCTAssertEqual(UpdateInstallPolicy.evaluate(snapshot), .ready)
        XCTAssertTrue(UpdateInstallPolicy.evaluate(snapshot).canInstallAutomatically)
    }

    func testAnyKnownActivityPostponesInstallation() {
        let cases = [
            UpdateActivitySnapshot(
                daemonDescendants: .count(1), shellHolderSockets: .count(0), runningDetachedJobs: .count(0)
            ),
            UpdateActivitySnapshot(
                daemonDescendants: .count(0), shellHolderSockets: .count(2), runningDetachedJobs: .count(0)
            ),
            UpdateActivitySnapshot(
                daemonDescendants: .count(0), shellHolderSockets: .count(0), runningDetachedJobs: .count(1)
            ),
        ]

        for snapshot in cases {
            guard case .busy = UpdateInstallPolicy.evaluate(snapshot) else {
                return XCTFail("expected busy for \(snapshot)")
            }
        }
    }

    func testUnavailableSignalFailsClosed() {
        let snapshot = UpdateActivitySnapshot(
            daemonDescendants: .count(0),
            shellHolderSockets: .unavailable("permission denied"),
            runningDetachedJobs: .count(0)
        )

        guard case .unavailable(let explanation) = UpdateInstallPolicy.evaluate(snapshot) else {
            return XCTFail("unavailable activity must not be treated as idle")
        }
        XCTAssertTrue(explanation.contains("could not be verified"))
        XCTAssertFalse(UpdateInstallPolicy.evaluate(snapshot).canInstallAutomatically)
    }

    func testProcessTreeCountsTransitiveDescendantsOnly() throws {
        let table = """
          10   1
          11  10
          12  11
          13  10
          90   1
        """

        XCTAssertEqual(try UpdateActivityProbe.descendantCount(rootPID: 10, psOutput: table), 3)
        XCTAssertEqual(try UpdateActivityProbe.descendantCount(rootPID: 90, psOutput: table), 0)
        XCTAssertThrowsError(try UpdateActivityProbe.descendantCount(rootPID: 99, psOutput: table))
        XCTAssertThrowsError(try UpdateActivityProbe.descendantCount(rootPID: 10, psOutput: "10 nope\n"))
    }

    func testFilesystemProbeSeesHolderSocketAndRunningJob() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("switchboard-update-policy-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let socket = root.appendingPathComponent("sessions/scope/session/sock")
        try FileManager.default.createDirectory(
            at: socket.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try Data().write(to: socket)

        let job = root.appendingPathComponent("jobs/scope/job.json")
        try FileManager.default.createDirectory(
            at: job.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try Data(#"{"status":"running"}"#.utf8).write(to: job)

        let snapshot = UpdateActivityProbe(switchboardRoot: root).snapshot(daemonPID: nil)
        XCTAssertEqual(snapshot.shellHolderSockets, .count(1))
        XCTAssertEqual(snapshot.runningDetachedJobs, .count(1))
        guard case .busy = UpdateInstallPolicy.evaluate(snapshot) else {
            return XCTFail("holder and running job must block installation")
        }
    }

    func testUnreadableJobRecordFailsClosedAndMissingRootIsIdle() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("switchboard-update-policy-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        XCTAssertEqual(
            UpdateInstallPolicy.evaluate(UpdateActivityProbe(switchboardRoot: root).snapshot(daemonPID: nil)),
            .ready
        )

        let job = root.appendingPathComponent("jobs/scope/broken.json")
        try FileManager.default.createDirectory(
            at: job.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try Data("not json".utf8).write(to: job)

        let snapshot = UpdateActivityProbe(switchboardRoot: root).snapshot(daemonPID: nil)
        guard case .unavailable = UpdateInstallPolicy.evaluate(snapshot) else {
            return XCTFail("corrupt job metadata must fail closed")
        }
    }

    func testActivityRootWithWrongTypeFailsClosed() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("switchboard-update-policy-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data().write(to: root.appendingPathComponent("sessions"))

        let snapshot = UpdateActivityProbe(switchboardRoot: root).snapshot(daemonPID: nil)
        guard case .unavailable = UpdateInstallPolicy.evaluate(snapshot) else {
            return XCTFail("an uninspectable activity root must fail closed")
        }
    }
}
