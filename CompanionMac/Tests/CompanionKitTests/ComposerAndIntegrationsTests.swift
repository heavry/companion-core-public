import XCTest
@testable import CompanionKit

/// v0.2.6.2：Composer Return-to-send 分流逻辑 + Integrations ViewModel。
@MainActor
final class ComposerAndIntegrationsTests: XCTestCase {
    private func stubbedClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLProtocolStub.self]
        return APIClient(
            config: .init(baseURL: URL(string: "http://127.0.0.1:8770")!, tokenProvider: { "k" }),
            session: URLSession(configuration: config)
        )
    }

    // MARK: Composer Return 分流（IME-safe 核心逻辑）

    func testReturnSendsWhenTextPresent() {
        XCTAssertEqual(ComposerKeyDecision.resolve(shift: false, hasMarkedText: false, canSend: true), .send)
    }

    func testShiftReturnInsertsNewlineNeverSends() {
        XCTAssertEqual(ComposerKeyDecision.resolve(shift: true, hasMarkedText: false, canSend: true), .newline)
        XCTAssertEqual(ComposerKeyDecision.resolve(shift: true, hasMarkedText: false, canSend: false), .newline)
    }

    func testEmptyOrWhitespaceCannotSend() {
        // 空/空白输入时 canSend=false → Return 不发送
        XCTAssertEqual(ComposerKeyDecision.resolve(shift: false, hasMarkedText: false, canSend: false), .ignore)
    }

    func testIMEMarkedTextNeverSends() {
        // 中文输入法 composing 中：即使 canSend=true，Return 只确认候选词
        XCTAssertEqual(ComposerKeyDecision.resolve(shift: false, hasMarkedText: true, canSend: true), .ignore)
        XCTAssertEqual(ComposerKeyDecision.resolve(shift: false, hasMarkedText: true, canSend: false), .ignore)
    }

    func testAttachmentOnlyCanSendViaReturn() {
        // 仅图片无文字：发送按钮允许时 Return 行为完全一致
        XCTAssertEqual(ComposerKeyDecision.resolve(shift: false, hasMarkedText: false, canSend: true), .send)
    }

    // MARK: Integrations ViewModel 解析（secret 永不出现）

    func testParseIntegrationsPayload() throws {
        let json = """
        {"data":[
          {"id":"mock_ab12","name":"Mock MCP","type":"stdio","enabled":true,"availableToAgent":true,
           "availableToChat":false,"command":"/usr/bin/node","args":["server.js"],"envKeys":["MOCK_TOKEN"],
           "url":null,"hasAuth":false,"status":"connected","lastError":null,"toolsCount":5},
          {"id":"http_1","name":"Remote","type":"http","enabled":false,"availableToAgent":false,
           "availableToChat":true,"command":null,"args":[],"envKeys":[],
           "url":"https://mcp.example.test/mcp","hasAuth":false,"authType":"oauth","oauthStatus":"authorization_required",
           "status":"authorization_required","lastError":null,"toolsCount":0}
        ]}
        """
        let items = try IntegrationsViewModel.parseIntegrations(Data(json.utf8))
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0].id, "mock_ab12")
        XCTAssertEqual(items[0].status, "connected")
        XCTAssertEqual(items[0].toolsCount, 5)
        XCTAssertEqual(items[1].status, "authorization_required")
        XCTAssertEqual(items[1].authType, "oauth")
        XCTAssertEqual(items[1].oauthStatus, "authorization_required")
        XCTAssertFalse(items[1].hasAuth)
    }

    func testParseToolsPayloadWithRiskAndDeny() throws {
        let json = """
        {"data":[
          {"id":"mcp:x:echo","wireName":"mcp_x_echo","displayName":"echo","description":"echo back",
           "inputSchema":{"type":"object","properties":{"text":{"type":"string"}}},"riskLevel":"low",
           "sideEffect":"idempotent","denied":false},
          {"id":"mcp:x:wipe","wireName":"mcp_x_wipe","displayName":"wipe","description":"delete all",
           "inputSchema":{"type":"object"},"riskLevel":"high","sideEffect":"non_idempotent","denied":true}
        ]}
        """
        let tools = try IntegrationsViewModel.parseTools(Data(json.utf8))
        XCTAssertEqual(tools.count, 2)
        XCTAssertEqual(tools[0].riskLevel, "low")
        XCTAssertFalse(tools[0].denied)
        XCTAssertEqual(tools[1].riskLevel, "high")
        XCTAssertTrue(tools[1].denied)
        XCTAssertTrue(tools[0].inputSchemaJSON.contains("text"), "schema preserved for developer view")
    }

    func testCapabilitiesEndpointDecodesMcpAwareWebSearch() async {
        URLProtocolStub.handler = { req in
            if req.url?.path == "/v1/capabilities" {
                return (200, Data(#"{"vision":{"configured":true},"web_search":{"configured":true,"provider":"tavily","reason":"联网搜索可用"}}"#.utf8))
            }
            return (404, Data())
        }
        let vm = SessionsViewModel(api: stubbedClient(), preferredSource: "chat")
        await vm.loadCapabilities()
        XCTAssertTrue(vm.webSearchConfigured, "web search 语义不受 MCP Registry 影响")
        XCTAssertEqual(vm.webSearchProvider, "tavily")
    }
}
