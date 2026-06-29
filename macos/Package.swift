// swift-tools-version: 5.9
import PackageDescription

// Tools-version 5.9 builds in the Swift 5 language mode, which keeps the menu-bar
// app free of Swift 6 strict-concurrency churn while still compiling cleanly with
// the 6.x toolchain. The product is a bare executable; scripts/make-app.sh wraps
// it into a proper .app bundle (LSUIElement, embedded Node runtime, signing).
let package = Package(
    name: "Switchboard",
    platforms: [.macOS(.v13)], // MenuBarExtra + SMAppService both need macOS 13+
    targets: [
        .executableTarget(
            name: "Switchboard",
            path: "Sources/Switchboard"
        )
    ]
)
