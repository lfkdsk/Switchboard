import AppKit
import Combine
import Foundation

enum AvatarRetryPolicy {
    static let delays: [TimeInterval] = [1, 2, 4, 8]

    /// `failureNumber` is one-based: the first failed request waits one second.
    static func delay(afterFailure failureNumber: Int) -> TimeInterval? {
        guard failureNumber > 0, failureNumber <= delays.count else { return nil }
        return delays[failureNumber - 1]
    }
}

enum AvatarRequest {
    static func url(login: String, sizePixels: Int = 64) -> URL? {
        guard !login.isEmpty else { return nil }
        var components = URLComponents()
        components.scheme = "https"
        components.host = "github.com"
        components.path = "/\(login).png"
        components.queryItems = [URLQueryItem(name: "size", value: String(sizePixels))]
        return components.url
    }
}

enum AvatarCache {
    static let fallbackBundleIdentifier = "org.lfkdsk.switchboard"

    static func fileURL(
        cacheRoot: URL,
        bundleIdentifier: String?,
        login: String
    ) -> URL {
        let bundle = bundleIdentifier.flatMap { $0.isEmpty ? nil : $0 }
            ?? fallbackBundleIdentifier
        let safeLogin = login.addingPercentEncoding(
            withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        ) ?? "unknown"
        return cacheRoot
            .appendingPathComponent(bundle, isDirectory: true)
            .appendingPathComponent("avatars", isDirectory: true)
            .appendingPathComponent("\(safeLogin).png", isDirectory: false)
    }
}

/// One app-lifetime avatar loader shared by every avatar view. It displays a
/// memory/disk hit immediately, refreshes from GitHub, and retries transient
/// failures without requiring SwiftUI to reconstruct the view.
@MainActor
final class AvatarLoader: ObservableObject {
    @Published private(set) var image: NSImage?

    private let session: URLSession
    private let cacheRoot: URL
    private let bundleIdentifier: String?
    private var memoryCache: [String: NSImage] = [:]
    private var currentLogin: String?
    private var requestGeneration = 0
    private var failureCount = 0
    private var needsRetry = false
    private var task: URLSessionDataTask?
    private var retryWork: DispatchWorkItem?
    private var accountSubscription: AnyCancellable?

    init(
        session: URLSession = .shared,
        cacheRoot: URL? = nil,
        bundleIdentifier: String? = Bundle.main.bundleIdentifier
    ) {
        self.session = session
        self.cacheRoot = cacheRoot
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Caches", isDirectory: true)
        self.bundleIdentifier = bundleIdentifier
    }

    /// Keep selection and cancellation alive even when MenuBarExtra has not yet
    /// created (or has discarded) its window content.
    func bind(to accountStore: AccountStore) {
        accountSubscription = accountStore.$identity
            .map(\.login)
            .removeDuplicates()
            .sink { [weak self] login in self?.select(login: login) }
    }

    /// Selects the account whose avatar should be shown. A changed login
    /// cancels all work belonging to the previous account.
    func select(login: String?) {
        let next = normalized(login)
        guard next != currentLogin else { return }

        task?.cancel()
        retryWork?.cancel()
        task = nil
        retryWork = nil
        requestGeneration += 1
        failureCount = 0
        needsRetry = false
        currentLogin = next
        image = nil

        guard let next else { return }
        if let cached = memoryCache[next] ?? diskImage(for: next) {
            memoryCache[next] = cached
            image = cached
        }
        fetch(login: next, generation: requestGeneration)
    }

    /// Called when the menu becomes visible. Only an exhausted retry sequence is
    /// restarted; active loads and successful cached results are left alone.
    func retryIfNeeded() {
        guard needsRetry, task == nil, retryWork == nil, let currentLogin else { return }
        failureCount = 0
        needsRetry = false
        fetch(login: currentLogin, generation: requestGeneration)
    }

    private func fetch(login: String, generation: Int) {
        guard let url = AvatarRequest.url(login: login) else {
            registerFailure(login: login, generation: generation)
            return
        }

        let request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 20
        )
        let nextTask = session.dataTask(with: request) { [weak self] data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode
            let validStatus = status.map { (200..<300).contains($0) } ?? false
            let decoded = data.flatMap(NSImage.init(data:))
            DispatchQueue.main.async {
                guard let self,
                      generation == self.requestGeneration,
                      login == self.currentLogin else { return }
                self.task = nil
                guard validStatus, let data, let decoded else {
                    self.registerFailure(login: login, generation: generation)
                    return
                }
                self.failureCount = 0
                self.needsRetry = false
                self.memoryCache[login] = decoded
                self.image = decoded
                self.persist(data: data, login: login)
            }
        }
        task = nextTask
        nextTask.resume()
    }

    private func registerFailure(login: String, generation: Int) {
        guard generation == requestGeneration, login == currentLogin else { return }
        failureCount += 1
        guard let delay = AvatarRetryPolicy.delay(afterFailure: failureCount) else {
            needsRetry = true
            return
        }

        let work = DispatchWorkItem { [weak self] in
            guard let self,
                  generation == self.requestGeneration,
                  login == self.currentLogin else { return }
            self.retryWork = nil
            self.fetch(login: login, generation: generation)
        }
        retryWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func diskImage(for login: String) -> NSImage? {
        let url = AvatarCache.fileURL(
            cacheRoot: cacheRoot,
            bundleIdentifier: bundleIdentifier,
            login: login
        )
        guard let data = try? Data(contentsOf: url) else { return nil }
        return NSImage(data: data)
    }

    private func persist(data: Data, login: String) {
        let url = AvatarCache.fileURL(
            cacheRoot: cacheRoot,
            bundleIdentifier: bundleIdentifier,
            login: login
        )
        DispatchQueue.global(qos: .utility).async {
            do {
                try FileManager.default.createDirectory(
                    at: url.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try data.write(to: url, options: .atomic)
            } catch {
                // A cache failure must never hide an otherwise valid avatar.
            }
        }
    }

    private func normalized(_ login: String?) -> String? {
        guard let value = login?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value.lowercased()
    }
}
