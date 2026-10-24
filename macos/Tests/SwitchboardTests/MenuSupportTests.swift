import Foundation
import XCTest
@testable import Switchboard

final class MenuSupportTests: XCTestCase {
    func testAccountIdentityPrefersLiveDaemonAndFallsBackToConfig() {
        let config = AccountConfig(
            signedIn: true,
            login: "disk-user",
            machineId: nil,
            server: nil
        )

        XCTAssertEqual(
            AccountIdentityResolver.resolve(
                daemonAccount: "daemon-user",
                daemonRunning: true,
                config: config
            ),
            AccountIdentity(signedIn: true, login: "daemon-user")
        )
        XCTAssertEqual(
            AccountIdentityResolver.resolve(
                daemonAccount: "stale-daemon-user",
                daemonRunning: false,
                config: config
            ),
            AccountIdentity(signedIn: true, login: "disk-user")
        )
        XCTAssertEqual(
            AccountIdentityResolver.resolve(
                daemonAccount: nil,
                daemonRunning: true,
                config: config
            ),
            AccountIdentity(signedIn: true, login: "disk-user")
        )
    }

    func testFullDiskAccessProbeRequiresOneReadableCandidate() {
        let first = URL(fileURLWithPath: "/protected/one")
        let second = URL(fileURLWithPath: "/protected/two")
        var visited: [URL] = []

        XCTAssertTrue(FullDiskAccessProbe.isGranted(candidateURLs: [first, second]) { url in
            visited.append(url)
            return url == second
        })
        XCTAssertEqual(visited, [first, second])
        XCTAssertFalse(FullDiskAccessProbe.isGranted(candidateURLs: [first, second]) { _ in false })
    }

    func testFullDiskAccessSettingsFallsBackToLegacyURL() {
        XCTAssertEqual(
            FullDiskAccessSettings.urls.map(\.absoluteString),
            [
                "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
                "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
            ]
        )
        let modern = URL(string: "test-settings:modern")!
        let legacy = URL(string: "test-settings:legacy")!
        var attempted: [URL] = []

        let opened = FullDiskAccessSettings.firstOpened(urls: [modern, legacy]) { url in
            attempted.append(url)
            return url == legacy
        }

        XCTAssertEqual(opened, legacy)
        XCTAssertEqual(attempted, [modern, legacy])
    }

    func testAvatarRetryBackoffAndExhaustion() {
        XCTAssertEqual((1...4).compactMap(AvatarRetryPolicy.delay(afterFailure:)), [1, 2, 4, 8])
        XCTAssertNil(AvatarRetryPolicy.delay(afterFailure: 0))
        XCTAssertNil(AvatarRetryPolicy.delay(afterFailure: 5))
    }

    func testAvatarCachePathUsesBundleAndFallbackIdentifiers() {
        let root = URL(fileURLWithPath: "/tmp/avatar-cache", isDirectory: true)

        XCTAssertEqual(
            AvatarCache.fileURL(cacheRoot: root, bundleIdentifier: "com.example.Switchboard", login: "octocat").path,
            "/tmp/avatar-cache/com.example.Switchboard/avatars/octocat.png"
        )
        XCTAssertEqual(
            AvatarCache.fileURL(cacheRoot: root, bundleIdentifier: nil, login: "hubot").path,
            "/tmp/avatar-cache/org.lfkdsk.switchboard/avatars/hubot.png"
        )
    }
}
