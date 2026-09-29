import XCTest
@testable import CompanionKit

/// 本轮三件事的回归测试：Avatar 资源、Chat 布局对齐/宽度、联网搜索状态与来源。
@MainActor
final class ChatLayoutAndWebSearchTests: XCTestCase {
    private func stubbedClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLProtocolStub.self]
        return APIClient(
            config: .init(baseURL: URL(string: "http://127.0.0.1:8770")!, tokenProvider: { "k" }),
            session: URLSession(configuration: config)
        )
    }

    // MARK: Avatar 资源

    func testPersonaAvatarResourceLoadDoesNotCrash() {
        // The private portrait asset is deliberately omitted from this audit mirror.
        let image = PersonaAvatar.image
        XCTAssertNil(image)
    }

    func testPersonaAvatarResolvesStandardInstalledAppLayout() throws {
        let app = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("app")
        let resources = app.appendingPathComponent("Contents/Resources")
        let info = app.appendingPathComponent("Contents/Info.plist")
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        try Data("<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>local.companion.avatar-test</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>".utf8).write(to: info)
        defer { try? FileManager.default.removeItem(at: app) }
        let bundle = try XCTUnwrap(Bundle(url: app))

        let candidate = try XCTUnwrap(PersonaAvatar.resourceCandidates(mainBundle: bundle, moduleBundle: nil).first)
        XCTAssertEqual(candidate.path, resources
            .appendingPathComponent("CompanionMac_CompanionKit.bundle/Assets.xcassets/PersonaAvatar.imageset/PersonaAvatar.png").path)
    }

    func testPersonaAvatarFallsBackOnlyWhenResourceIsUnavailable() throws {
        let emptyBundle = try XCTUnwrap(Bundle(url: FileManager.default.temporaryDirectory))
        XCTAssertNil(PersonaAvatar.image(mainBundle: emptyBundle, moduleBundle: nil))
    }

    // MARK: 对齐模型

    func testAssistantMessageIsLeadingAligned() {
        let alignment = ChatMessageLayout.alignment(forRole: "assistant")
        XCTAssertTrue(alignment.leading)
        XCTAssertFalse(alignment.trailing)
        XCTAssertFalse(alignment.isUser)
    }

    func testUserMessageIsTrailingAligned() {
        let alignment = ChatMessageLayout.alignment(forRole: "user")
        XCTAssertTrue(alignment.trailing)
        XCTAssertFalse(alignment.leading)
        XCTAssertTrue(alignment.isUser)
    }

    // MARK: 气泡宽度

    func testShortMessageDoesNotOccupyFullWidth() {
        // 短消息（"1"）的气泡上限远小于内容区宽度；宽度由内容 hug，上限只约束换行点。
        let userCap = ChatMessageLayout.bubbleMaxWidth(containerWidth: 1000, isUser: true)
        let assistantCap = ChatMessageLayout.bubbleMaxWidth(containerWidth: 1000, isUser: false)
        XCTAssertLessThanOrEqual(userCap, ChatMessageLayout.userBubbleAbsoluteCap)
        XCTAssertLessThanOrEqual(assistantCap, ChatMessageLayout.assistantBubbleAbsoluteCap)
        XCTAssertLessThanOrEqual(userCap, 1000 * ChatMessageLayout.userBubbleWidthRatio + 0.5)
        XCTAssertLessThanOrEqual(assistantCap, 1000 * ChatMessageLayout.assistantBubbleWidthRatio + 0.5)
    }

    func testBubbleMaxWidthIsResponsiveAndCapped() {
        XCTAssertEqual(ChatMessageLayout.bubbleMaxWidth(containerWidth: 400, isUser: true),
                       400 * ChatMessageLayout.userBubbleWidthRatio)
        XCTAssertEqual(ChatMessageLayout.bubbleMaxWidth(containerWidth: 400, isUser: false),
                       400 * ChatMessageLayout.assistantBubbleWidthRatio)
        XCTAssertEqual(ChatMessageLayout.bubbleMaxWidth(containerWidth: 2000, isUser: true),
                       ChatMessageLayout.userBubbleAbsoluteCap)
        XCTAssertEqual(ChatMessageLayout.bubbleMaxWidth(containerWidth: 2000, isUser: false),
                       ChatMessageLayout.assistantBubbleAbsoluteCap)
    }

    // MARK: 消息间距

    func testSpacingTightWithinSpeakerAndLargerOnSwitch() {
        XCTAssertLessThan(ChatMessageLayout.spacing(after: "assistant", before: "assistant"),
                          ChatMessageLayout.spacing(after: "user", before: "assistant"))
        XCTAssertEqual(ChatMessageLayout.spacing(after: nil, before: "user"), 0)
    }

    func testBottomFollowTracksUserScrollButNotGrowingAssistantReply() {
        XCTAssertTrue(ChatMessageLayout.followLatest(previousTop: -500, currentTop: -500,
            contentBottom: 850, viewportHeight: 600, wasFollowing: true),
            "a tool completion or final text can grow content without cancelling follow")
        XCTAssertFalse(ChatMessageLayout.followLatest(previousTop: -500, currentTop: -300,
            contentBottom: 900, viewportHeight: 600, wasFollowing: true),
            "scrolling up through history must not jump to the final reply")
        XCTAssertTrue(ChatMessageLayout.followLatest(previousTop: -300, currentTop: -590,
            contentBottom: 615, viewportHeight: 600, wasFollowing: false))
    }

    // MARK: 图片附件跟随发送者（tool 行过滤 + role 对齐）

    func testDisplayableRowsFilterToolRowsButKeepSenderRoles() {
        let rows = [
            ConversationMessagesResponse.Row(id: 1, role: "user", contentText: "看图", toolCallsJson: nil, toolCallId: nil, createdAt: nil,
                                             attachments: [MediaAttachment(mediaId: "m1", mime: "image/png", path: "/media/m1", width: 1, height: 1, bytes: 10)]),
            ConversationMessagesResponse.Row(id: 2, role: "tool", contentText: "{\"results\":[]}", toolCallsJson: nil, toolCallId: "call_1", createdAt: nil, attachments: nil),
            ConversationMessagesResponse.Row(id: 3, role: "assistant", contentText: "收到", toolCallsJson: nil, toolCallId: nil, createdAt: nil, attachments: nil)
        ]
        let displayable = ChatMessageLayout.displayableRows(rows)
        XCTAssertEqual(displayable.map(\.role), ["user", "assistant"])
        XCTAssertEqual(displayable[0].alignment.isUser, true, "图片消息跟随 user 行右侧")
        XCTAssertEqual(displayable[1].alignment.isUser, false, "assistant 回复固定左侧")
    }

    // MARK: 联网搜索状态（off / unconfigured / configured）

    func testWebToggleOffByDefaultAndPersistsAcrossViewModelInstances() {
        let suiteName = "ChatLayoutWebSearchTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let api = stubbedClient()
        let vm = SessionsViewModel(api: api, preferredSource: "chat", defaults: defaults)
        XCTAssertFalse(vm.webEnabled, "web toggle 默认关闭")

        vm.setWebEnabled(true)
        XCTAssertTrue(vm.webEnabled)
        let reloaded = SessionsViewModel(api: api, preferredSource: "chat", defaults: defaults)
        XCTAssertTrue(reloaded.webEnabled, "per-conversation 偏好跨实例持久化")
    }

    func testCapabilitiesUnconfiguredAndConfiguredStates() async {
        URLProtocolStub.handler = { req in
            if req.url?.path == "/v1/capabilities" {
                if req.url?.query?.contains("configured=1") == true {
                    return (200, Data(#"{"vision":{"configured":true},"web_search":{"configured":true,"provider":"tavily","reason":"联网搜索可用"}}"#.utf8))
                }
                return (200, Data(#"{"vision":{"configured":true},"web_search":{"configured":false,"reason":"未配置联网搜索"}}"#.utf8))
            }
            return (404, Data())
        }
        let unconfigured = SessionsViewModel(api: stubbedClient(), preferredSource: "chat")
        await unconfigured.loadCapabilities()
        XCTAssertFalse(unconfigured.webSearchConfigured)
        XCTAssertNil(unconfigured.webSearchProvider)
        XCTAssertEqual(unconfigured.webSearchReason, "未配置联网搜索")

        URLProtocolStub.handler = { req in
            (200, Data(#"{"vision":{"configured":true},"web_search":{"configured":true,"provider":"tavily","reason":"联网搜索可用"}}"#.utf8))
        }
        let configured = SessionsViewModel(api: stubbedClient(), preferredSource: "chat")
        await configured.loadCapabilities()
        XCTAssertTrue(configured.webSearchConfigured)
        XCTAssertEqual(configured.webSearchProvider, "tavily")
    }

    func testWebSearchConfigEndpointsDoNotEchoKey() async throws {
        URLProtocolStub.handler = { req in
            if req.url?.path == "/admin/search/config" && req.httpMethod == "PUT" {
                let body = String(data: req.httpBody ?? Data(), encoding: .utf8) ?? ""
                XCTAssertTrue(body.contains("your_key_here"), "PUT 请求应携带新 Key")
                return (200, Data(#"{"configured":true,"provider":"tavily","reason":"联网搜索可用"}"#.utf8))
            }
            if req.url?.path == "/admin/search/config" {
                return (200, Data(#"{"configured":true,"provider":"tavily","reason":"联网搜索可用","has_tavily_key":true,"searxng_base_url":""}"#.utf8))
            }
            return (404, Data())
        }
        let api = stubbedClient()
        let status = try await api.updateWebSearch(provider: "tavily", tavilyAPIKey: "your_key_here", searxngBaseURL: nil)
        XCTAssertTrue(status.configured)
        let detail = try await api.webSearchDetail()
        XCTAssertEqual(detail.hasTavilyKey, true, "状态只暴露 has_key，不回传 Key 明文")
    }

    // MARK: 来源展示解码

    func testWebSourceDecodingAndDomainDisplay() throws {
        let json = """
        [{"title":"天气预警","url":"https://weather.example.com/alert?id=1","snippet":"今天有雨","published_at":"2026-08-26","source":"weather.example.com"},
         {"title":"无 source 字段","url":"https://news.example.cn/2026/08/x.html","snippet":null}]
        """
        let sources = try JSONDecoder().decode([WebSource].self, from: Data(json.utf8))
        XCTAssertEqual(sources.count, 2)
        XCTAssertEqual(sources[0].displayDomain, "weather.example.com")
        XCTAssertEqual(sources[1].displayDomain, "news.example.cn", "缺少 source 时从 url 提取域名")
        XCTAssertEqual(sources[0].publishedAt, "2026-08-26")
    }

    func testMessageRowDecodesWebSources() throws {
        let json = #"{"data":[{"id":7,"role":"assistant","content_text":"根据搜索…","attachments":[],"voice_asset":{"voice_asset_id":"voice-7","duration":2.5,"state":"ready","url":"/media/voice-7"},"web_sources":[{"title":"t","url":"https://a.example.com/x","snippet":"s","source":"a.example.com"}]}]}"#
        let response = try JSONDecoder().decode(ConversationMessagesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.data.first?.webSources?.count, 1)
        XCTAssertEqual(response.data.first?.webSources?.first?.url, "https://a.example.com/x")
        XCTAssertEqual(response.data.first?.voiceAsset?.voiceAssetID, "voice-7")
        XCTAssertEqual(response.data.first?.voiceAsset?.duration, 2.5)

        let legacy = try JSONDecoder().decode(ConversationMessagesResponse.self, from: Data(#"{"data":[{"id":8,"role":"assistant","content_text":"旧消息","attachments":[]}]}"#.utf8))
        XCTAssertNil(legacy.data.first?.webSources, "历史消息无来源时解码不失败")
    }
}

private extension ConversationMessagesResponse.Row {
    var alignment: ChatMessageLayout.Alignment { ChatMessageLayout.alignment(forRole: role) }
}
