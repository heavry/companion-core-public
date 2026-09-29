import XCTest
@testable import CompanionKit

final class APIClientTests: XCTestCase {
    private func makeClient(token: String = "test-token") -> APIClient {
        APIClient(config: .init(baseURL: URL(string: "http://127.0.0.1:8765")!, tokenProvider: { token }))
    }

    func testURLBuilding() {
        let client = makeClient()
        XCTAssertEqual(client.url(for: "/health")?.absoluteString, "http://127.0.0.1:8765/health")
        XCTAssertEqual(client.url(for: "health")?.absoluteString, "http://127.0.0.1:8765/health")
        XCTAssertEqual(client.url(for: "/admin/conversations/abc/messages?limit=50")?.absoluteString,
                       "http://127.0.0.1:8765/admin/conversations/abc/messages?limit=50")
    }

    func testConversationDecoding() throws {
        let json = """
        {"data":[
          {"id":"sid-1","source":"kelivo","external_key":"daily-main","category":"daily",
           "display_name":"Kelivo · daily-main","last_activity":"2026-08-25T08:00:00Z",
           "message_count":12,"recent_message":"你好","archived":false},
          {"id":"sid-2","source":"opencode","external_key":"project-companion-core-ab12cd34","category":"agents",
           "display_name":"OpenCode · companion-core","message_count":99}
        ]}
        """
        let wrapper = try JSONDecoder().decode(ConversationListWrapper.self, from: Data(json.utf8))
        XCTAssertEqual(wrapper.data.count, 2)
        XCTAssertEqual(wrapper.data[0].category, "daily")
        XCTAssertTrue(wrapper.data[1].displayName.contains("companion-core"))
    }

    func testMessageBubbleIdentityDecoding() throws {
        let json = #"{"data":[{"id":42,"role":"assistant","content_text":"第二条","bubble_index":1,"bubble_count":2,"bubble_turn_id":"turn-7","generation_route":"core_tools"}]}"#
        let response = try JSONDecoder().decode(ConversationMessagesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.data.first?.bubbleIndex, 1)
        XCTAssertEqual(response.data.first?.bubbleCount, 2)
        XCTAssertEqual(response.data.first?.bubbleTurnId, "turn-7")
        XCTAssertEqual(response.data.first?.generationRoute, "core_tools")
    }

    struct ConversationListWrapper: Decodable { let data: [Conversation] }

    func testBehaviorRoundTrip() throws {
        let original = BehaviorSettings(
            proactiveLevel: "normal", proactiveMessagesEnabled: true,
            quietHours: QuietHours(start: "23:00", end: "08:00"),
            weatherAwareness: true, followUpEnabled: true, proactiveImagesEnabled: false,
            dailyProactiveCap: 3, dailyProactiveImageCap: 1
        )
        let data = try JSONEncoder().encode(original)
        var back = try JSONDecoder().decode(BehaviorSettings.self, from: data)
        back.proactiveImagesEnabled = true
        XCTAssertNotEqual(back.proactiveImagesEnabled, original.proactiveImagesEnabled)
        XCTAssertEqual(back.quietHours.start, "23:00")
    }
}

/// URLProtocol 桩：验证鉴权头、方法与端点路径（无真实网络）
final class URLProtocolStub: URLProtocol {
    static var handler: ((URLRequest) -> (Int, Data))?
    static var contentTypeProvider: ((URLRequest) -> String)?
    static var lastRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var req = request
        if req.httpBody == nil, let stream = req.httpBodyStream {
            stream.open()
            var data = Data();let bufSize = 16384;let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
            while stream.hasBytesAvailable {let read=stream.read(buf,maxLength:bufSize);if read<=0 {break};data.append(buf,count:read)}
            buf.deallocate();stream.close();req.httpBody=data
        }
        Self.lastRequest = req
        let (status, body) = Self.handler?(req) ?? (200, Data("{}".utf8))
        let response = HTTPURLResponse(url: request.url!, statusCode: status,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": Self.contentTypeProvider?(req) ?? "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class APIClientNetworkTests: XCTestCase {
    private func stubbedClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLProtocolStub.self]
        return APIClient(
            config: .init(baseURL: URL(string: "http://127.0.0.1:8765")!, tokenProvider: { "secret-key" }),
            session: URLSession(configuration: config)
        )
    }

    func testAuthHeaderMethodAndPath() async throws {
        URLProtocolStub.handler = { req in
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer secret-key")
            XCTAssertEqual(req.httpMethod, "GET")
            return (200, Data(#"{"ok":true,"version":"0.2.6.1"}"#.utf8))
        }
        let health = try await stubbedClient().health()
        XCTAssertTrue(health.ok)
        XCTAssertEqual(URLProtocolStub.lastRequest?.url?.path, "/health")
    }

    func testSendChatEncodesMessagesBody() async throws {
        var capturedBody: Data?
        URLProtocolStub.handler = { req in
            capturedBody = req.httpBody
            return (200, Data(#"{"choices":[{"message":{"content":"好的，收到。"}}]}"#.utf8))
        }
        let reply = try await stubbedClient().sendChat(message: "在忙吗")
        XCTAssertEqual(reply, "好的，收到。")
        XCTAssertEqual(URLProtocolStub.lastRequest?.value(forHTTPHeaderField: "X-Companion-Source"), "chat")
        XCTAssertEqual(URLProtocolStub.lastRequest?.value(forHTTPHeaderField: "X-Companion-Session"), "chat:default")
        XCTAssertGreaterThanOrEqual(URLProtocolStub.lastRequest?.timeoutInterval ?? 0, 600)
        if let data = capturedBody,
           let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
           let messages = obj["messages"] as? [[String: String]] {
            XCTAssertEqual(obj["model"] as? String, "yuna-chat")
            XCTAssertEqual(messages.first?["content"], "在忙吗")
        } else {
            XCTFail("chat payload malformed")
        }
    }

    func testSendChatEncodesImageAndWebMetadata() async throws {
        var capturedBody: Data?
        URLProtocolStub.handler = { req in
            capturedBody = req.httpBody
            return (200, Data(#"{"choices":[{"message":{"content":"看到了"}}]}"#.utf8))
        }
        let upload = MediaUploadResponse(mediaId: "11111111-1111-4111-8111-111111111111", mime: "image/png",
                                         filename: "tiny.png", width: 1, height: 1, bytes: 70,
                                         url: "/media/11111111-1111-4111-8111-111111111111")
        _ = try await stubbedClient().sendChat(message: "这是什么", attachments: [upload], webEnabled: true)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(capturedBody)) as? [String: Any])
        let metadata = try XCTUnwrap(object["metadata"] as? [String: Bool])
        let messages = try XCTUnwrap(object["messages"] as? [[String: Any]])
        let parts = try XCTUnwrap(messages.first?["content"] as? [[String: Any]])
        let image = try XCTUnwrap(parts.first(where: { $0["type"] as? String == "image_url" }))
        let imageURL = try XCTUnwrap(image["image_url"] as? [String: String])
        XCTAssertEqual(metadata["webEnabled"], true)
        XCTAssertEqual(imageURL["url"], "companion-media://11111111-1111-4111-8111-111111111111")
    }

    @MainActor
    func testStreamChatDeliversIncrementalTextDeltas() async throws {
        URLProtocolStub.contentTypeProvider = { _ in "text/event-stream" }
        defer { URLProtocolStub.contentTypeProvider = nil }
        URLProtocolStub.handler = { req in
            let object = try? JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as? [String: Any]
            XCTAssertEqual(object?["stream"] as? Bool, true)
            let frames = [
                #"data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}"#,
                #"data: {"choices":[{"delta":{"content":"好"},"finish_reason":null}]}"#,
                #"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
                "event: companion.voice_delivery\n" + #"data: {"companion_voice_delivery":{"voice_delivery":"tts","reason":"strong_emotion","emotion":"excited","emotion_intensity":0.91}}"#,
                "data: [DONE]"
            ].joined(separator: "\n\n") + "\n\n"
            return (200, Data(frames.utf8))
        }
        var deltas: [String] = []
        var delivery: VoiceDeliveryDecision?
        let final = try await stubbedClient().streamChat(message: "hello", onVoiceDelivery: { delivery = $0 }) { deltas.append($0) }
        XCTAssertEqual(deltas, ["你", "好"])
        XCTAssertEqual(final, "你好")
        XCTAssertEqual(delivery?.voiceDelivery, "tts")
        XCTAssertEqual(delivery?.reason, "strong_emotion")
        XCTAssertFalse(final.contains("voice_delivery"), "delivery metadata must not enter durable assistant text")
    }

    @MainActor
    func testStreamChatPreservesBubbleIdentityAcrossMultipleChunks() async throws {
        URLProtocolStub.contentTypeProvider = { _ in "text/event-stream" }
        defer { URLProtocolStub.contentTypeProvider = nil }
        URLProtocolStub.handler = { _ in
            let frames = [
                #"data: {"choices":[{"delta":{"content":"刚回"},"finish_reason":null}],"companion_bubble_index":0,"companion_bubble_count":2,"companion_message_id":101}"#,
                #"data: {"choices":[{"delta":{"content":"来呀"},"finish_reason":null}],"companion_bubble_index":0,"companion_bubble_count":2,"companion_message_id":101}"#,
                #"data: {"choices":[{"delta":{"content":"先歇"},"finish_reason":null}],"companion_bubble_index":1,"companion_bubble_count":2,"companion_message_id":102}"#,
                #"data: {"choices":[{"delta":{"content":"会也行"},"finish_reason":"stop"}],"companion_bubble_index":1,"companion_bubble_count":2,"companion_message_id":102}"#,
                "data: [DONE]"
            ].joined(separator: "\n\n") + "\n\n"
            return (200, Data(frames.utf8))
        }
        var texts: [String] = [], metadata: [(Int, Int, Int?)] = []
        _ = try await stubbedClient().streamChat(message: "hello", onDelta: { texts.append($0) }, onBubbleMeta: { metadata.append(($0, $1, $2)) })
        XCTAssertEqual(texts, ["刚回", "来呀", "先歇", "会也行"])
        XCTAssertEqual(metadata.map { $0.0 }, [0, 0, 1, 1])
        XCTAssertEqual(metadata.map { $0.2 }, [101, 101, 102, 102])
    }

    func testUploadImageSendsRawAuthenticatedBytes() async throws {
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!
        let pending = try PendingImageAttachment(filename: "tiny.png", mime: "image/png", data: png)
        URLProtocolStub.handler = { req in
            XCTAssertEqual(req.url?.path, "/media/upload")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer secret-key")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "image/png")
            XCTAssertEqual(req.httpBody, png)
            return (201, Data(#"{"media_id":"11111111-1111-4111-8111-111111111111","mime":"image/png","filename":"tiny.png","width":1,"height":1,"bytes":70,"url":"/media/11111111-1111-4111-8111-111111111111"}"#.utf8))
        }
        let result = try await stubbedClient().uploadImage(pending)
        XCTAssertEqual(result.mediaId, "11111111-1111-4111-8111-111111111111")
        XCTAssertEqual(result.width, 1)
    }

    func testCapabilitiesDecodeUnavailableWebSearch() async throws {
        URLProtocolStub.handler = { _ in
            (200, Data(#"{"vision":{"configured":true,"mode":"openai_compatible_passthrough"},"web_search":{"configured":false,"reason":"未配置联网搜索"}}"#.utf8))
        }
        let value = try await stubbedClient().capabilities()
        XCTAssertTrue(value.vision.configured)
        XCTAssertFalse(value.webSearch.configured)
        XCTAssertEqual(value.webSearch.reason, "未配置联网搜索")
    }

    @MainActor
    func testLocalVoiceStatusDecoding() async throws {
        let status = #"{"id":"voice.tts","provider":"GPT-SoVITS Local","voice":"yuxiao","backend":"PyTorch","device":"CPU","precision":"float32","state":"ready","ready":true,"enabled":true,"mode":"manual","speed":1.0,"endpoint":"127.0.0.1:9880","managed_process":true,"last_error":null,"metrics":{"requests":2,"successes":2,"failures":0,"characters":8,"audio_bytes":1024,"duration_ms":30,"cost_usd":0}}"#
        URLProtocolStub.handler = { req in
            XCTAssertEqual(req.url?.path, "/v1/voice/status")
            return (200, Data(status.utf8))
        }
        let client = stubbedClient(), value = try await client.voiceStatus()
        XCTAssertEqual(value.voice, "yuxiao"); XCTAssertEqual(value.metrics.costUsd, 0)
    }

    func testConversationQueryScopesSourceAndLimit() async throws {
        URLProtocolStub.handler = { req in
            let components = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)
            XCTAssertEqual(components?.queryItems?.first(where: { $0.name == "source" })?.value, "chat")
            XCTAssertEqual(components?.queryItems?.first(where: { $0.name == "limit" })?.value, "25")
            return (200, Data(#"{"data":[]}"#.utf8))
        }
        _ = try await stubbedClient().conversations(source: "chat", limit: 25)
    }

    func testPermissionSnapshotAndDecisionEndpoints() async throws {
        let snapshot = #"{"session_id":"s 1","mode":"ask","grants":[],"pending":[{"request_id":"p1","session_id":"s 1","call_id":"c1","capability_id":"mcp:notion:search","integration_name":"Notion","display_name":"notion-search","scope":"read","risk_level":"low","read_only":true,"reason":"approval","can_allow_session":true,"created_at":"2026-08-28T00:00:00Z","expires_at":"2026-08-28T00:15:00Z","status":"pending"}]}"#
        URLProtocolStub.handler = { req in
            XCTAssertEqual(req.url?.path, "/admin/sessions/s 1/permissions")
            return (200, Data(snapshot.utf8))
        }
        let loaded = try await stubbedClient().sessionPermissions(sessionID: "s 1")
        XCTAssertEqual(loaded.mode, .ask); XCTAssertEqual(loaded.pending.first?.requestId, "p1")
        URLProtocolStub.handler = { req in
            XCTAssertEqual(req.httpMethod, "POST")
            XCTAssertTrue(req.url?.path.hasSuffix("/permissions/decisions/p1") == true)
            return (200, Data("{\"snapshot\":\(snapshot)}".utf8))
        }
        let resolved = try await stubbedClient().resolveSessionPermission(sessionID: "s 1", requestID: "p1", action: "allow_once")
        XCTAssertEqual(resolved.sessionId, "s 1")
    }

    func testWorkspaceSelectionAndClearUseCurrentSessionEndpoint() async throws {
        let selected = #"{"session_id":"s1","mode":"risk_based","grants":[],"pending":[],"workspace":{"path":"/tmp/project","name":"project"}}"#
        URLProtocolStub.handler = { req in
            XCTAssertEqual(req.httpMethod, "PUT"); XCTAssertEqual(req.url?.path, "/admin/sessions/s1/workspace")
            let body = try? JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as? [String: String]
            XCTAssertEqual(body?["path"], "/tmp/project")
            return (200, Data(selected.utf8))
        }
        let client = stubbedClient(), bound = try await client.setSessionWorkspace(sessionID: "s1", path: "/tmp/project")
        XCTAssertEqual(bound.workspace?.path, "/tmp/project")
        URLProtocolStub.handler = { req in
            XCTAssertEqual(req.httpMethod, "DELETE"); XCTAssertEqual(req.url?.path, "/admin/sessions/s1/workspace")
            return (200, Data(#"{"session_id":"s1","mode":"risk_based","grants":[],"pending":[],"workspace":null}"#.utf8))
        }
        let cleared = try await client.clearSessionWorkspace(sessionID: "s1")
        XCTAssertNil(cleared.workspace)
    }

    func testDefaultChatWorkspaceCanBeSelectedBeforeFirstMessage() async throws {
        URLProtocolStub.handler = { req in
            XCTAssertEqual(req.httpMethod, "PUT"); XCTAssertEqual(req.url?.path, "/admin/session-workspace")
            let body = try? JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as? [String: String]
            XCTAssertEqual(body?["source"], "chat"); XCTAssertEqual(body?["external_key"], "chat:default")
            return (200, Data(#"{"session_id":"fresh-chat","mode":"risk_based","grants":[],"pending":[],"workspace":{"path":"/tmp/Companion","name":"Companion"}}"#.utf8))
        }
        let snapshot = try await stubbedClient().setDefaultChatWorkspace(path: "/tmp/Companion")
        XCTAssertEqual(snapshot.sessionId, "fresh-chat"); XCTAssertEqual(snapshot.workspace?.name, "Companion")
    }

    func testLocalRuntimeControlsReadAndPatchCoreOwnedState() async throws {
        let payload = #"{"version":1,"enabled":{"terminal":true,"filesystem":true,"self_maintenance":false,"package_manager":true},"hard_safety_boundary":"active","updated_at":"2026-08-30T00:00:00Z"}"#
        URLProtocolStub.handler = { req in
            XCTAssertEqual(req.httpMethod, "GET")
            XCTAssertEqual(req.url?.path, "/admin/local-runtime-controls")
            return (200, Data(payload.utf8))
        }
        let loaded = try await stubbedClient().localRuntimeControls()
        XCTAssertEqual(loaded.enabled["terminal"], true)
        XCTAssertEqual(loaded.enabled["self_maintenance"], false)
        XCTAssertEqual(loaded.hardSafetyBoundary, "active")
        URLProtocolStub.handler = { req in
            XCTAssertEqual(req.httpMethod, "PATCH")
            XCTAssertEqual(req.url?.path, "/admin/local-runtime-controls")
            let object = try? JSONSerialization.jsonObject(with: req.httpBody ?? Data()) as? [String: Any]
            let enabled = object?["enabled"] as? [String: Bool]
            XCTAssertEqual(enabled?["terminal"], false)
            return (200, Data(payload.utf8))
        }
        _ = try await stubbedClient().updateLocalRuntimeControls(["terminal": false])
    }

    func testHTTPErrorSurfacesStatus() async throws {
        URLProtocolStub.handler = { _ in (401, Data(#"{"error":{"message":"denied"}}"#.utf8)) }
        do {
            _ = try await stubbedClient().getJSON("/admin/conversations")
            XCTFail("expected 401 error")
        } catch let APIError.http(status, _) {
            XCTAssertEqual(status, 401)
        }
    }
}
