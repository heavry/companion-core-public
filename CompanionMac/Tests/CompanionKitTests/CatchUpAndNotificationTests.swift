import XCTest
@testable import CompanionKit

@MainActor
final class CatchUpAndNotificationTests: XCTestCase {
    private func stubbedClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLProtocolStub.self]
        return APIClient(
            config: .init(baseURL: URL(string: "http://127.0.0.1:8765")!, tokenProvider: { "k" }),
            session: URLSession(configuration: config)
        )
    }

    func testCatchUpFetchesOnlyNewerProactiveMessages() async throws {
        let old = "2026-08-25T08:00:00.000Z"
        let newer = "2026-08-25T10:00:00.000Z"
        URLProtocolStub.handler = { req in
            if req.url?.path == "/admin/conversations" {
                return (200, Data(#"{"data":[{"id":"pro","source":"proactive","category":"proactive","display_name":"主动消息"}]}"#.utf8))
            }
            if req.url?.path == "/admin/conversations/pro/messages" {
                let json = """
                {"data":[
                 {"id":1,"role":"assistant","content_text":"旧消息","created_at":"\(old)","attachments":[]},
                 {"id":2,"role":"user","content_text":"用户回复","created_at":"\(newer)","attachments":[]},
                 {"id":3,"role":"assistant","content_text":"新主动消息","created_at":"\(newer)","attachments":[]}
                ]}
                """
                return (200, Data(json.utf8))
            }
            return (404, Data())
        }
        let defaults = UserDefaults(suiteName: "catchup-test-\(UUID().uuidString)")!
        let service = ProactiveCatchUpService(api: stubbedClient(), defaults: defaults)
        // 从未读过 → 全部 assistant 消息视为未读
        await service.refresh()
        XCTAssertEqual(service.unread.count, 2)
        // 推进已读水位到 old 之后 → 只有 newer 的 assistant 留下
        service.lastReadAt = String.dateFromISO8601(old)
        await service.refresh()
        XCTAssertEqual(service.unread.count, 1)
        XCTAssertEqual(service.unread.first?.contentText, "新主动消息")
        // markAllRead 清零
        service.markAllRead()
        XCTAssertTrue(service.unread.isEmpty)
        XCTAssertNotNil(service.lastReadAt)
    }

    func testNotificationDeduplicatesSameMessageKey() {
        let service = NotificationService.shared
        let key = "evt-" + UUID().uuidString
        XCTAssertTrue(service.shouldNotify(messageKey: key, conversationId: "s1"))
        XCTAssertFalse(service.shouldNotify(messageKey: key, conversationId: "s1"), "same message never notifies twice")
    }

    func testViewingConversationSuppressesNotification() {
        let service = NotificationService.shared
        let convId = "viewing-" + UUID().uuidString
        service.setCurrentlyViewing(conversationId: convId)
        let key = "evt-viewing-" + UUID().uuidString
        XCTAssertFalse(service.shouldNotify(messageKey: key, conversationId: convId), "viewing the conversation suppresses system notification")
        service.setCurrentlyViewing(conversationId: nil)
        XCTAssertTrue(service.shouldNotify(messageKey: key, conversationId: convId), "after leaving conversation it may notify again")
    }
}
