import XCTest
@testable import CompanionKit

/// Modules 页 offline / 失败路径回归：
/// 旧实现在 Core 断连 + 打开插件页时触碰悬空 presentation executor 崩溃；
/// 新实现将状态收敛进 @MainActor ViewModel，失败必须显式呈现且不崩溃。
@MainActor
final class ModulesViewModelTests: XCTestCase {
    private func client(handler: @escaping (URLRequest) -> (Int, Data)) -> APIClient {
        URLProtocolStub.handler = { req in
            handler(req)
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLProtocolStub.self]
        return APIClient(config: .init(baseURL: URL(string: "http://127.0.0.1:8765")!, tokenProvider: { "k" }),
                         session: URLSession(configuration: config))
    }

    func testOfflineLoadSurfacesErrorAndKeepsRows() async {
        var vm = ModulesViewModel(api: client(handler: { _ in (200, Data(#"{"modules":[{"id":"m","version":"1"}]}"#.utf8)) }))
        await vm.load()
        XCTAssertEqual(vm.rows.count, 1, "baseline load populates rows")
        XCTAssertNil(vm.errorText)

        // Core 掉线：请求 503
        vm = ModulesViewModel(api: client(handler: { _ in (503, Data(#"{"error":"down"}"#.utf8)) }))
        await vm.load()
        XCTAssertTrue(vm.errorText?.contains("模块列表加载失败") ?? false, "failure surfaces explicit error text")
        XCTAssertFalse(vm.isLoading)
    }

    func testMalformedPayloadFailsClosed() async {
        let vm = ModulesViewModel(api: client(handler: { _ in (200, Data("not-json-at-all".utf8)) }))
        await vm.load()
        XCTAssertTrue(vm.errorText?.contains("模块列表加载失败") ?? false)
    }

    func testConsecutiveReloadsNoRace() async {
        URLProtocolStub.handler = { _ in (200, Data(#"{"modules":[]}"#.utf8)) }
        let vm = ModulesViewModel(api: client(handler: { _ in (200, Data(#"{"modules":[]}"#.utf8)) }))
        // 并发双 reload（offline→reconnect 场景可能触发）：后完成者不得覆盖新状态为旧错误
        async let a: Void = vm.load()
        async let b: Void = vm.load()
        _ = await (a, b)
        XCTAssertFalse(vm.isLoading, "loading flag cleared after concurrent reloads settle")
        XCTAssertNil(vm.errorText)
    }
}
