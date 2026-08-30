// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "my-remote-codex-host",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "my-remote-codex-host", targets: ["MyRemoteCodexHost"]),
    ],
    targets: [
        .executableTarget(
            name: "MyRemoteCodexHost",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("SwiftUI"),
            ]
        ),
        .testTarget(
            name: "MyRemoteCodexHostTests",
            dependencies: ["MyRemoteCodexHost"]
        ),
    ],
    swiftLanguageModes: [.v5]
)
