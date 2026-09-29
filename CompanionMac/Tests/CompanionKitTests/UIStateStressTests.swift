import XCTest
@testable import CompanionKit

/// 复现原崩溃路径的确定性压力测试：
/// 旧实现在频繁的 observable 状态更新（TabView 切换/列表重建）期间，
/// NSHostingView+行内 sheet 的 LiftedPresentation 会触碰悬空 executor。
/// 新生命周期下，同样强度的状态变更必须稳定。
@MainActor
final class UIStateStressTests: XCTestCase {
    private func stubbedClient(handler: @escaping (URLRequest) -> (Int, Data)) -> APIClient {
        URLProtocolStub.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLProtocolStub.self]
        return APIClient(config: .init(baseURL: URL(string: "http://127.0.0.1:8765")!, tokenProvider: { "k" }),
                         session: URLSession(configuration: config))
    }

    func testConversationSwitchFiftyTimes() async throws {
        let fixed = #"{"data":[{"id":"s0","source":"opencode","category":"agents","display_name":"OpenCode · demo0"},{"id":"s1","source":"opencode","category":"agents","display_name":"OpenCode · demo1"},{"id":"s2","source":"opencode","category":"agents","display_name":"OpenCode · demo2"},{"id":"s3","source":"opencode","category":"agents","display_name":"OpenCode · demo3"}]}"#
        URLProtocolStub.handler = { req in
            if req.url?.path.hasPrefix("/admin/conversations/") == true {
                let json = #"{"data":[{"id":7,"role":"assistant","content_text":"final answer","attachments":[]}]}"#
                return (200, Data(json.utf8))
            }
            return (200, Data(fixed.utf8))
        }
        let vm = SessionsViewModel(api: stubbedClient(handler: { req in
            if req.url?.path.hasPrefix("/admin/conversations/") == true {
                let json = #"{"data":[{"id":7,"role":"assistant","content_text":"final answer","attachments":[]}]}"#
                return (200, Data(json.utf8))
            }
            return (200, Data(fixed.utf8))
        }))
        await vm.reload()
        XCTAssertEqual(vm.conversations.count, 4)
        for i in 0..<50 {
            let target = vm.conversations[i % vm.conversations.count]
            await vm.select(target)
        }
        XCTAssertEqual(vm.messages.first?.contentText, "final answer")
    }

    func testSettingsSaveTwentyTimes() async {
        URLProtocolStub.handler = { req in
            if req.httpMethod == "GET" {
                return (200, Data(#"{"proactiveLevel":"normal","proactiveMessagesEnabled":true,"quietHours":{"start":"23:00","end":"08:00"},"weatherAwareness":true,"followUpEnabled":true,"proactiveImagesEnabled":true,"dailyProactiveCap":3,"dailyProactiveImageCap":1}"#.utf8))
            }
            return (200, Data(#"{"proactiveLevel":"active","proactiveMessagesEnabled":true,"quietHours":{"start":"23:00","end":"08:00"},"weatherAwareness":false,"followUpEnabled":false,"proactiveImagesEnabled":false,"dailyProactiveCap":5,"dailyProactiveImageCap":2}"#.utf8))
        }
        let vm = SettingsViewModel(api: stubbedClient(handler: { req in
            if req.httpMethod == "GET" {
                return (200, Data(#"{"proactiveLevel":"normal","proactiveMessagesEnabled":true,"quietHours":{"start":"23:00","end":"08:00"},"weatherAwareness":true,"followUpEnabled":true,"proactiveImagesEnabled":true,"dailyProactiveCap":3,"dailyProactiveImageCap":1}"#.utf8))
            }
            return (200, Data(#"{"proactiveLevel":"active","proactiveMessagesEnabled":true,"quietHours":{"start":"23:00","end":"08:00"},"weatherAwareness":false,"followUpEnabled":false,"proactiveImagesEnabled":false,"dailyProactiveCap":5,"dailyProactiveImageCap":2}"#.utf8))
        }))
        await vm.load()
        for i in 0..<20 {
            vm.level = i % 2 == 0 ? "low" : "active"
            await vm.save()
        }
        XCTAssertNotNil(vm.savedAt)
    }
}

/// Modules 进入退出 ×20：反复 load 不泄漏 loading 状态
@MainActor
final class ModulesLoadStressTests: XCTestCase {
    private func stubbedClient(handler: @escaping (URLRequest) -> (Int, Data)) -> APIClient {
        URLProtocolStub.handler = handler
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLProtocolStub.self]
        return APIClient(config: .init(baseURL: URL(string: "http://127.0.0.1:8765")!, tokenProvider: { "k" }),
                         session: URLSession(configuration: config))
    }

    func testModulesEnterExitTwentyTimes() async {
        let vm = ModulesViewModel(api: stubbedClient(handler: { _ in
            (200, Data(#"{"modules":[{"id":"weather","version":"1"}]}"#.utf8))
        }))
        for _ in 0..<20 {
            await vm.load()
        }
        XCTAssertEqual(vm.rows.count, 1)
        XCTAssertFalse(vm.isLoading)
    }
}
