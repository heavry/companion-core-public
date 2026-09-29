import XCTest
@testable import CompanionKit

final class ComputerUseCapabilityTests: XCTestCase {
    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        return APIClient(config: .init(baseURL: URL(string: "http://127.0.0.1:8770")!, tokenProvider: { "test" }), session: URLSession(configuration: configuration))
    }

    func testProductStatesAndToolActivityLabels() {
        XCTAssertEqual(ComputerUsePresentation.statusTitle(installed: false, enabled: false, health: "not_installed", permissionsReady: false), "Not installed")
        XCTAssertEqual(ComputerUsePresentation.statusTitle(installed: true, enabled: true, health: "installed", permissionsReady: false), "Needs macOS permission")
        XCTAssertEqual(ComputerUsePresentation.statusTitle(installed: true, enabled: true, health: "installed", permissionsReady: true), "Ready")
        XCTAssertEqual(ComputerUsePresentation.statusTitle(installed: true, enabled: false, health: "disabled", permissionsReady: true), "Disabled")
        XCTAssertEqual(ComputerUsePresentation.statusTitle(installed: false, enabled: false, health: "error", permissionsReady: false), "Error")
        XCTAssertEqual(ComputerUsePresentation.installProgress["health_check"], "正在测试")
        XCTAssertEqual(ComputerUsePresentation.toolLabels["computer_keyboard_type"], "输入文字")
    }

    func testComputerUseStatusDecodesProvenanceAndPermissionSession() async throws {
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.path, "/admin/capabilities/computer.use")
            return (200, Data(Self.statusJSON.utf8))
        }
        let value = try await client().computerUseStatus()
        XCTAssertTrue(value.status.installed)
        XCTAssertEqual(value.status.version, "0.22.2")
        XCTAssertEqual(value.status.upstreamCommit, "d114f35fec05ecd37bf529e5587be86852205b64")
        XCTAssertEqual(value.status.permissions, ["screen.read", "mouse.control"])
        XCTAssertEqual(value.permissionSession.mode, .riskBased)
    }

    func testInstallUsesExistingApprovalAndSessionGrantShape() async throws {
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/admin/capabilities/computer.use/install")
            return (202, Data(Self.installApprovalJSON.utf8))
        }
        let value = try await client().installComputerUse()
        XCTAssertEqual(value.request?.integrationName, "Capability Installer")
        XCTAssertEqual(value.request?.displayName, "安装 Computer Use")
        XCTAssertEqual(value.request?.canAllowSession, true)
        XCTAssertEqual(value.permissionSession?.pending.count, 1)
    }

    func testManagedActionsUseBoundedProductEndpoints() async throws {
        var calls: [(String?, String?)] = []
        URLProtocolStub.handler = { request in
            calls.append((request.httpMethod, request.url?.path))
            if request.httpMethod == "DELETE" { return (202, Data(#"{"ok":true,"status":"awaiting_approval","request":null,"permissionSession":null}"#.utf8)) }
            return (200, Data(#"{"ok":true,"status":{"id":"computer.use","name":"Computer Use","known":true,"installed":true,"enabled":true,"configured":true,"health":"installed","lastError":null,"lastTest":null,"installTime":null,"installPath":null,"adapterVersion":"1","version":"0.22.2","source":"known_github_descriptor","sourceUrl":"https://github.com/trycua/cua","upstreamCommit":"d114f35fec05ecd37bf529e5587be86852205b64","license":"MIT","permissions":[],"macOSPermissions":[]}}"#.utf8))
        }
        let api = client()
        _ = try await api.testComputerUse()
        _ = try await api.setComputerUseEnabled(true)
        _ = try await api.uninstallComputerUse()
        XCTAssertEqual(calls.map { $0.0 }, ["POST", "PATCH", "DELETE"])
        XCTAssertEqual(calls.map { $0.1 }, ["/admin/capabilities/computer.use/test", "/admin/capabilities/computer.use", "/admin/capabilities/computer.use"])
    }

    private static let statusJSON = #"{"status":{"id":"computer.use","name":"Computer Use","known":true,"installed":true,"enabled":true,"configured":true,"health":"installed","lastError":null,"lastTest":"2026-08-28T12:00:00Z","installTime":"2026-08-28T11:00:00Z","installPath":"/owned/capabilities/computer.use","adapterVersion":"1","version":"0.22.2","source":"known_github_descriptor","sourceUrl":"https://github.com/trycua/cua","upstreamCommit":"d114f35fec05ecd37bf529e5587be86852205b64","license":"MIT","permissions":["screen.read","mouse.control"],"macOSPermissions":["accessibility","screen_recording"]},"permissionSession":{"session_id":"capability-installer-ui","mode":"risk_based","grants":[],"pending":[]}}"#
    private static let installApprovalJSON = #"{"ok":true,"status":"awaiting_approval","request":{"request_id":"p1","session_id":"capability-installer-ui","call_id":"c1","capability_id":"capability.install:computer.use","source_type":"native","source_id":"companion-installer","integration_name":"Capability Installer","display_name":"安装 Computer Use","scope":"write","risk_level":"medium","read_only":false,"reason":"persistent install","can_allow_session":true,"created_at":"2026-08-28T12:00:00Z","expires_at":"2026-08-28T12:15:00Z","status":"pending"},"permissionSession":{"session_id":"capability-installer-ui","mode":"risk_based","grants":[],"pending":[{"request_id":"p1","session_id":"capability-installer-ui","call_id":"c1","capability_id":"capability.install:computer.use","source_type":"native","source_id":"companion-installer","integration_name":"Capability Installer","display_name":"安装 Computer Use","scope":"write","risk_level":"medium","read_only":false,"reason":"persistent install","can_allow_session":true,"created_at":"2026-08-28T12:00:00Z","expires_at":"2026-08-28T12:15:00Z","status":"pending"}]}}"#
}
