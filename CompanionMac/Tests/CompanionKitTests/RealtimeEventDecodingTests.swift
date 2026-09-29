import XCTest
@testable import CompanionKit

final class RealtimeEventDecodingTests: XCTestCase {
    func testDecodeMessageCreatedEvent() throws {
        let json = """
        {"type":"message.created","eventId":"evt_abc","at":"2026-08-25T08:00:00.000Z","sessionId":"s1",
         "data":{"messageId":42,"role":"assistant","source":"proactive","preview":"你上次说明天要测新版…"}}
        """
        let event = try XCTUnwrap(RealtimeClient.decode(text: json))
        XCTAssertEqual(event.type, "message.created")
        XCTAssertEqual(event.sessionId, "s1")
        XCTAssertEqual(event.data?["messageId"]?.intValue, 42)
        XCTAssertTrue(event.data?["preview"]?.stringValue?.contains("测新版") ?? false)
    }

    func testControlFramesAreNotBusinessEvents() {
        XCTAssertNil(RealtimeClient.decode(text: #"{"type":"hello"}"#))
        XCTAssertNil(RealtimeClient.decode(text: #"{"type":"pong"}"#))
    }

    func testToolCompletedWithTruncatedPreview() throws {
        let longPreview = String(repeating: "x", count: 400) + "…[70000 chars]"
        let json = """
        {"type":"tool.completed","eventId":"e2","sessionId":"s2",
         "data":{"callId":"call_1","name":"bash","source":"client","output_preview":"\(longPreview)","output_chars":70000}}
        """
        let event = try XCTUnwrap(RealtimeClient.decode(text: json))
        let preview = event.data?["output_preview"]?.stringValue ?? ""
        XCTAssertLessThanOrEqual(preview.count, 420, "preview must stay bounded")
        XCTAssertTrue(preview.contains("70000"), "original size is reported instead of raw output")
    }

    func testSensitiveKeysAreAbsentFromEventPayload() throws {
        // Core 侧 sanitize 已剥除；客户端解码层再验证不崩溃且无该键
        let json = #"{"type":"provider.status_changed","data":{"apiKey":"sk-secret","provider":"primary","healthy":true}}"#
        let event = try XCTUnwrap(RealtimeClient.decode(text: json))
        if case .dictionary(let dict)? = event.data {
            XCTAssertNil(dict["apiKey"], "apiKey never decoded into client payload")
            XCTAssertNotNil(dict["provider"])
        } else {
            XCTFail("expected dictionary payload")
        }
    }
}
