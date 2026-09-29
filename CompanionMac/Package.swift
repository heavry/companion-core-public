// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "CompanionMac",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "CompanionMac", targets: ["CompanionMac"]),
        .library(name: "CompanionKit", targets: ["CompanionKit"])
    ],
    targets: [
        .target(
            name: "CompanionKit",
            resources: [.process("Assets.xcassets")]
        ),
        .executableTarget(name: "CompanionMac", dependencies: ["CompanionKit"]),
        .testTarget(name: "CompanionKitTests", dependencies: ["CompanionKit"])
    ]
)
