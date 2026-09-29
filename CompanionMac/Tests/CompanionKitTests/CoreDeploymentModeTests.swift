import XCTest
@testable import CompanionKit

final class CoreDeploymentModeTests: XCTestCase {
    func testEnvironmentWinsAndDefaultsLocal() {
        XCTAssertEqual(CoreDeploymentMode.resolve(environment: nil, stored: nil), .local)
        XCTAssertEqual(CoreDeploymentMode.resolve(environment: "remote", stored: "local"), .remote)
    }

    func testLocalRequiresCandidateLoopback() {
        XCTAssertNil(CoreDeploymentMode.local.validate(baseURL: URL(string: "http://127.0.0.1:8770")!))
        XCTAssertNotNil(CoreDeploymentMode.local.validate(baseURL: URL(string: "http://127.0.0.1:8765")!))
        XCTAssertNotNil(CoreDeploymentMode.local.validate(baseURL: URL(string: "https://companion.example")!))
    }

    func testRemoteRequiresNonLoopbackHTTPS() {
        XCTAssertNil(CoreDeploymentMode.remote.validate(baseURL: URL(string: "https://companion.example")!))
        XCTAssertNotNil(CoreDeploymentMode.remote.validate(baseURL: URL(string: "http://companion.example")!))
        XCTAssertNotNil(CoreDeploymentMode.remote.validate(baseURL: URL(string: "https://127.0.0.1:8770")!))
    }

    @MainActor
    func testRemoteManagerRefusesLocalLaunch() async {
        let manager = CoreProcessManager(mode: .remote)
        let didStart = await manager.ensureRunning(waitSeconds: 0)
        XCTAssertFalse(didStart)
        XCTAssertFalse(manager.ownedByApp)
    }
}
