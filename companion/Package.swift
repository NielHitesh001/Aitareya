// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CtxCompanion",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "CtxCompanion", targets: ["CtxCompanion"])],
    targets: [
        .executableTarget(name: "CtxCompanion", path: "Sources"),
        .testTarget(name: "CtxCompanionTests", dependencies: ["CtxCompanion"], path: "Tests")
    ]
)
