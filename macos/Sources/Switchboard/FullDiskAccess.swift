import AppKit
import Combine
import Darwin
import Foundation

enum FullDiskAccessProbe {
    static func candidateURLs(homeDirectory: URL) -> [URL] {
        [
            homeDirectory.appendingPathComponent(
                "Library/Application Support/com.apple.TCC/TCC.db",
                isDirectory: false
            ),
            homeDirectory.appendingPathComponent(
                "Library/Safari/Bookmarks.plist",
                isDirectory: false
            ),
        ]
    }

    /// Pure decision seam used by tests; probing stops as soon as one protected
    /// file can be opened read-only.
    static func isGranted(
        candidateURLs: [URL],
        canOpen: (URL) -> Bool
    ) -> Bool {
        candidateURLs.contains(where: canOpen)
    }

    static func check(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) -> Bool {
        isGranted(candidateURLs: candidateURLs(homeDirectory: homeDirectory)) { url in
            let descriptor = Darwin.open(url.path, O_RDONLY | O_CLOEXEC)
            guard descriptor >= 0 else { return false }
            Darwin.close(descriptor)
            return true
        }
    }
}

enum FullDiskAccessSettings {
    static let urls: [URL] = [
        URL(string: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles")!,
        URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!,
    ]

    /// Tries the current System Settings route first, then the legacy Security &
    /// Privacy route. Returning the accepted URL makes fallback order testable.
    static func firstOpened(
        urls: [URL] = FullDiskAccessSettings.urls,
        using open: (URL) -> Bool
    ) -> URL? {
        for url in urls where open(url) { return url }
        return nil
    }

    @discardableResult
    static func open() -> Bool {
        firstOpened { NSWorkspace.shared.open($0) } != nil
    }
}

/// Refreshes on menu presentation and when Switchboard becomes active again
/// after the user changes privacy settings.
@MainActor
final class FullDiskAccessStore: ObservableObject {
    @Published private(set) var isGranted = false

    private let probe: () -> Bool
    private var activeSubscription: AnyCancellable?

    init(probe: @escaping () -> Bool = { FullDiskAccessProbe.check() }) {
        self.probe = probe
        refresh()
        activeSubscription = NotificationCenter.default
            .publisher(for: NSApplication.didBecomeActiveNotification)
            .sink { [weak self] _ in self?.refresh() }
    }

    func refresh() {
        isGranted = probe()
    }

    func openSettings() {
        FullDiskAccessSettings.open()
    }
}
