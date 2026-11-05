// swift-tools-version: 5.9
import PackageDescription

// Tools-version 5.9 builds in the Swift 5 language mode, which keeps the menu-bar
// app free of Swift 6 strict-concurrency churn while still compiling cleanly with
// the 6.x toolchain. The product is a bare executable; scripts/make-app.sh wraps
// it into a proper .app bundle (LSUIElement, embedded Node runtime, signing).
var packageTargets: [Target] = [
    // Keep the safety policy free of AppKit so its fail-closed behavior can be
    // exercised by Linux CI as well as the macOS application build.
    .target(
        name: "UpdatePolicy",
        path: "Sources/UpdatePolicy"
    ),
    .testTarget(
        name: "UpdatePolicyTests",
        dependencies: ["UpdatePolicy"],
        path: "Tests/UpdatePolicyTests"
    ),
]
var packageDependencies: [Package.Dependency] = []

#if os(macOS)
packageDependencies.append(
    .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.1")
)
packageTargets += [
    .executableTarget(
        name: "Switchboard",
        dependencies: [
            "UpdatePolicy",
            .product(name: "Sparkle", package: "Sparkle"),
        ],
        path: "Sources/Switchboard"
    ),
    .testTarget(
        name: "SwitchboardTests",
        dependencies: ["Switchboard"],
        path: "Tests/SwitchboardTests"
    ),
]
#endif

let package = Package(
    name: "Switchboard",
    platforms: [.macOS(.v13)], // MenuBarExtra + SMAppService both need macOS 13+
    dependencies: packageDependencies,
    targets: packageTargets
)
