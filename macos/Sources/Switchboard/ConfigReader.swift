import Foundation

/// Reads ~/.switchboard/config.json — the same file the CLI writes on login —
/// so the menu can show who's signed in without re-running the daemon.
struct AccountConfig {
    var signedIn: Bool
    var login: String?
    var machineId: String?
    var server: String?

    static let empty = AccountConfig(signedIn: false, login: nil, machineId: nil, server: nil)
}

enum ConfigReader {
    static var configURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".switchboard/config.json")
    }

    static func read() -> AccountConfig {
        guard let data = try? Data(contentsOf: configURL),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return .empty }
        let agent = obj["agentToken"] as? String
        return AccountConfig(
            signedIn: !(agent ?? "").isEmpty,
            login: obj["login"] as? String,
            machineId: obj["machineId"] as? String,
            server: obj["server"] as? String
        )
    }
}
