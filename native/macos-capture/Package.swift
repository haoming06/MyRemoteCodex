// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "remote-codex-capture",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "remote-codex-capture", targets: ["RemoteCodexCapture"]),
    ],
    targets: [
        .executableTarget(
            name: "RemoteCodexCapture",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("VideoToolbox"),
            ]
        ),
        .testTarget(
            name: "RemoteCodexCaptureTests",
            dependencies: ["RemoteCodexCapture"]
        ),
    ],
    swiftLanguageModes: [.v5]
)
