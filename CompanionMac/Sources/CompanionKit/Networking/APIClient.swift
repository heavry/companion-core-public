import Foundation

public enum APIError: Error, Equatable {
    case invalidURL
    case http(Int, String)
    case decoding(String)
}

public protocol APIClientProtocol {
    func getJSON(_ path: String) async throws -> Data
    func send(_ method: String, _ path: String, body: Data?) async throws -> Data
}

/// Companion Core 本地 REST 客户端。
/// 鉴权：Bearer token 由 TokenProviding 提供（生产实现读 macOS Keychain）。
public final class APIClient: APIClientProtocol {
    public struct Configuration {
        public var baseURL: URL
        public var tokenProvider: @Sendable () -> String
        /// Optional extra headers. Default empty — used by existing gateway/credential WIP only.
        public var additionalHeaderProvider: @Sendable () -> [String: String]
        public init(baseURL: URL, tokenProvider: @escaping @Sendable () -> String,
                    additionalHeaderProvider: @escaping @Sendable () -> [String: String] = { [:] }) {
            self.baseURL = baseURL
            self.tokenProvider = tokenProvider
            self.additionalHeaderProvider = additionalHeaderProvider
        }
    }

    public let config: Configuration
    private let session: URLSession
    private let decoder: JSONDecoder

    public init(config: Configuration, session: URLSession = .shared) {
        self.config = config
        self.session = session
        let d = JSONDecoder()
        self.decoder = d
    }

    public func url(for path: String) -> URL? {
        let suffix = path.hasPrefix("/") ? path : "/" + path
        // 手工拼接以保留 query 字符串原样（避免 URLComponents 对 ? 的路径化）
        var base = config.baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: base + suffix)
    }

    private func request(_ method: String, _ path: String, body: Data?) throws -> URLRequest {
        guard let url = url(for: path) else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(config.tokenProvider())", forHTTPHeaderField: "Authorization")
        for (name, value) in config.additionalHeaderProvider() where !value.isEmpty {
            req.setValue(value, forHTTPHeaderField: name)
        }
        if let body { req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.httpBody = body }
        return req
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.http(-1, "no response") }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(http.statusCode, String(data: data.prefix(1000), encoding: .utf8) ?? "")
        }
        return data
    }

    public func send(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
        try await perform(request(method, path, body: body))
    }

    public func getJSON(_ path: String) async throws -> Data { try await send("GET", path) }

    // MARK: - 高层端点

    public func health() async throws -> HealthResponse {
        try decode(HealthResponse.self, from: try await getJSON("/health"))
    }
    public func models() async throws -> ModelsResponse {
        try decode(ModelsResponse.self, from: try await getJSON("/v1/models"))
    }
    public func capabilities() async throws -> CoreCapabilities {
        try decode(CoreCapabilities.self, from: try await getJSON("/v1/capabilities"))
    }
    public func voiceStatus() async throws -> VoiceStatus {
        try decode(VoiceStatus.self, from: try await getJSON("/v1/voice/status"))
    }
    public func updateVoiceSettings(enabled: Bool, mode: String, speed: Double) async throws -> VoiceStatus {
        let body = try JSONSerialization.data(withJSONObject: ["enabled": enabled, "mode": mode, "speed": speed])
        return try decode(VoiceStatus.self, from: try await send("PATCH", "/v1/voice/settings", body: body))
    }
    public func voiceCallPrewarm() async throws -> VoiceCallRuntimeStatus {
        try decode(VoiceCallRuntimeStatus.self, from: try await send("POST", "/v1/voice-call/prewarm", body: Data("{}".utf8)))
    }
    public func transcribeVoiceCall(wav: Data, sessionID: String) async throws -> VoiceCallTranscription {
        let body = try JSONSerialization.data(withJSONObject: ["audio_base64": wav.base64EncodedString(), "session_id": sessionID])
        return try decode(VoiceCallTranscription.self, from: try await send("POST", "/v1/voice-call/transcribe", body: body))
    }
    public struct ChatVoiceMessageResponse: Decodable {
        public let ok: Bool
        public let messageId: Int?
        public let sessionId: String?
        public let transcript: String?
        public let durationMs: Double?
        public let voiceAsset: VoiceAsset?
        enum CodingKeys: String, CodingKey {
            case ok, transcript
            case messageId = "message_id"
            case sessionId = "session_id"
            case durationMs = "duration_ms"
            case voiceAsset = "voice_asset"
        }
    }
    public func sendChatVoiceMessage(wav: Data, durationMs: Int, sessionID: String? = nil) async throws -> ChatVoiceMessageResponse {
        var payload: [String: Any] = ["audio_base64": wav.base64EncodedString(), "duration_ms": durationMs]
        if let sessionID { payload["session_id"] = sessionID }
        let body = try JSONSerialization.data(withJSONObject: payload)
        var req = try request("POST", "/v1/chat/voice-message", body: body)
        req.timeoutInterval = 20
        return try decode(ChatVoiceMessageResponse.self, from: try await perform(req))
    }
    /// Real seen: only call when chat:default is visible and window is active.
    public func reportChatSeen(messageIds: [Int], sessionID: String?, windowActive: Bool, chatVisible: Bool) async {
        let payload: [String: Any] = [
            "message_ids": messageIds,
            "session_id": sessionID as Any,
            "window_active": windowActive,
            "chat_visible": chatVisible
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
        _ = try? await send("POST", "/admin/natural-cognition/seen", body: body)
    }
    public func reportAttention(windowActive: Bool, chatVisible: Bool) async {
        let body = try? JSONSerialization.data(withJSONObject: ["window_active": windowActive, "chat_visible": chatVisible])
        _ = try? await send("POST", "/admin/natural-cognition/attention", body: body)
    }
    public func synthesizeVoiceCall(text: String, sessionID: String) async throws -> VoiceSynthesisResponse {
        let body = try JSONSerialization.data(withJSONObject: ["text": text, "voice": "yuxiao", "session_id": sessionID])
        return try decode(VoiceSynthesisResponse.self, from: try await send("POST", "/v1/voice/synthesize", body: body))
    }
    public func voiceAudio(id: String) async throws -> Data {
        try await perform(request("GET", "/v1/voice/audio/\(id)", body: nil))
    }
    public func recordVoiceCallTurn(_ metrics: VoiceTurnMetrics) async throws {
        let body = try JSONSerialization.data(withJSONObject: metrics.diagnosticsPayload())
        _ = try await send("POST", "/v1/voice-call/turn-metrics", body: body)
    }
    public func endVoiceCall(duration: Double = 0, utterances: Int = 0, bargeIns: Int = 0, cancellations: Int = 0,
                             muteDuration: Double = 0, deviceChanges: Int = 0, speechSeconds: Double = 0,
                             falseStarts: Int = 0, selfTriggersPrevented: Int = 0, callSessionId: String = "") async throws {
        let body = try JSONSerialization.data(withJSONObject: [
            "duration_seconds": duration, "utterances": utterances, "barge_ins": bargeIns, "cancellations": cancellations,
            "mute_duration_seconds": muteDuration, "device_changes": deviceChanges, "speech_seconds": speechSeconds,
            "vad_false_starts": falseStarts, "self_triggers_prevented": selfTriggersPrevented, "call_session_id": callSessionId
        ])
        _ = try await send("POST", "/v1/voice-call/end", body: body)
    }
    public func cancelVoiceSynthesis() async throws { _ = try await send("POST", "/v1/voice/cancel", body: Data("{}".utf8)) }
    public func wakeWordStatus() async throws -> WakeWordStatus {
        try decode(WakeWordStatus.self, from: try await getJSON("/v1/wake-word/status"))
    }
    public func updateWakeWordSettings(enabled: Bool, sensitivity: String, feedbackSound: Bool, suspendWhileLocked: Bool) async throws -> WakeWordStatus {
        let body = try JSONSerialization.data(withJSONObject: [
            "enabled": enabled, "sensitivity": sensitivity, "feedbackSound": feedbackSound, "suspendWhileLocked": suspendWhileLocked
        ])
        return try decode(WakeWordStatus.self, from: try await send("PATCH", "/v1/wake-word/settings", body: body))
    }
    public func updateWakeWordContext(locked: Bool, sleeping: Bool, voiceCallActive: Bool, assistantAudioPlaying: Bool, holdoffMs: Int = 0) async throws {
        let body = try JSONSerialization.data(withJSONObject: [
            "locked": locked, "sleeping": sleeping, "voiceCallActive": voiceCallActive,
            "assistantAudioPlaying": assistantAudioPlaying, "holdoffMs": holdoffMs
        ])
        _ = try await send("POST", "/v1/wake-word/context", body: body)
    }
    public func ingestWakeWord(pcm16: Data, sampleRate: Double) async throws -> WakeWordIngestResponse {
        let body = try JSONSerialization.data(withJSONObject: [
            "pcm16_base64": pcm16.base64EncodedString(), "sample_rate": sampleRate
        ])
        return try decode(WakeWordIngestResponse.self, from: try await send("POST", "/v1/wake-word/ingest", body: body))
    }
    public func resolveWakeWord(transcript: String) async throws -> WakeWordResolveResponse {
        let body = try JSONSerialization.data(withJSONObject: ["transcript": transcript])
        return try decode(WakeWordResolveResponse.self, from: try await send("POST", "/v1/wake-word/resolve", body: body))
    }
    public func recordWakeWordEvent(kind: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["kind": kind])
        _ = try await send("POST", "/v1/wake-word/event", body: body)
    }
    public func conversations(search: String = "", source: String? = nil,
                              category: String? = nil, limit: Int = 500) async throws -> [Conversation] {
        struct Wrapper: Decodable { let data: [Conversation] }
        var c = URLComponents()
        c.path = "/admin/conversations"
        var items = [URLQueryItem(name: "limit", value: String(max(1, min(500, limit))))]
        if !search.isEmpty { items.append(URLQueryItem(name: "search", value: search)) }
        if let source, !source.isEmpty { items.append(URLQueryItem(name: "source", value: source)) }
        if let category, !category.isEmpty { items.append(URLQueryItem(name: "category", value: category)) }
        c.queryItems = items
        let path = c.percentEncodedPath + (c.percentEncodedQuery.map { "?" + $0 } ?? "")
        return try decode(Wrapper.self, from: try await getJSON(path)).data
    }
    public func conversationMessages(id: String, limit: Int = 300) async throws -> ConversationMessagesResponse {
        try decode(ConversationMessagesResponse.self, from: try await getJSON("/admin/conversations/\(id)/messages?limit=\(limit)"))
    }
    public func behavior() async throws -> BehaviorSettings {
        try decode(BehaviorSettings.self, from: try await getJSON("/admin/companion/behavior"))
    }
    public func updateBehavior(_ settings: BehaviorSettings) async throws -> BehaviorSettings {
        let encoder = JSONEncoder()
        let body = try encoder.encode(settings)
        return try decode(BehaviorSettings.self, from: try await send("PATCH", "/admin/companion/behavior", body: body))
    }
    public func companionState() async throws -> CompanionStateSummary {
        try await decode(CompanionStateSummary.self, from: try await getJSON("/admin/companion/state"))
    }
    public func todaySnapshot(date: String? = nil) async throws -> TodaySnapshot {
        var path = "/admin/product/today"
        if let date, !date.isEmpty {
            path += "?date=\(date)"
        }
        return try decode(TodaySnapshot.self, from: try await getJSON(path))
    }
    public func relationshipSnapshot() async throws -> RelationshipSnapshot {
        try decode(RelationshipSnapshot.self, from: try await getJSON("/admin/product/relationship"))
    }
    public func ttsProviders() async throws -> TTSProviderCatalog {
        try decode(TTSProviderCatalog.self, from: try await getJSON("/admin/tts-providers"))
    }
    public func selectTTSProvider(id: String) async throws -> TTSProviderCatalog {
        let body = try JSONSerialization.data(withJSONObject: ["id": id])
        return try decode(TTSProviderCatalog.self, from: try await send("POST", "/admin/tts-providers/select", body: body))
    }
    public func memoryBrain(search: String = "") async throws -> MemoryBrainResponse {
        let encoded = search.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        return try decode(MemoryBrainResponse.self, from: try await getJSON("/admin/memory/brain?limit=500&search=\(encoded)"))
    }
    public func memoryRecallPreview(query: String, limit: Int = 8) async throws -> MemoryRecallPreview {
        let body = try JSONSerialization.data(withJSONObject: ["query": query, "limit": max(1, min(20, limit))])
        return try decode(MemoryRecallPreview.self, from: try await send("POST", "/admin/memories/retrieval-debug", body: body))
    }
    public func schedulerSnapshot() async throws -> SchedulerSnapshot {
        try decode(SchedulerSnapshot.self, from: try await getJSON("/admin/scheduler"))
    }
    public func createPlan(_ draft: SchedulerPlanDraft) async throws -> SchedulerPlan {
        struct Wrapper: Decodable { let plan: SchedulerPlan }
        return try decode(Wrapper.self, from: try await send("POST", "/admin/scheduler", body: JSONEncoder().encode(draft))).plan
    }
    public func updatePlan(id: String, draft: SchedulerPlanDraft) async throws -> SchedulerPlan {
        struct Wrapper: Decodable { let plan: SchedulerPlan }
        return try decode(Wrapper.self, from: try await send("PATCH", "/admin/scheduler/\(id)", body: JSONEncoder().encode(draft))).plan
    }
    public func setPlanEnabled(id: String, enabled: Bool) async throws -> SchedulerPlan {
        struct Payload: Encodable { let enabled: Bool }
        struct Wrapper: Decodable { let plan: SchedulerPlan }
        return try decode(Wrapper.self, from: try await send("PATCH", "/admin/scheduler/\(id)", body: JSONEncoder().encode(Payload(enabled: enabled)))).plan
    }
    public func deletePlan(id: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["confirm": true])
        _ = try await send("DELETE", "/admin/scheduler/\(id)", body: body)
    }
    public func capabilityProductSnapshot() async throws -> CapabilityProductSnapshot {
        try decode(CapabilityProductSnapshot.self, from: try await getJSON("/admin/product/capabilities"))
    }
    public func localRuntimeControls() async throws -> LocalRuntimeControlsSnapshot {
        try decode(LocalRuntimeControlsSnapshot.self, from: try await getJSON("/admin/local-runtime-controls"))
    }
    public func updateLocalRuntimeControls(_ enabled: [String: Bool]) async throws -> LocalRuntimeControlsSnapshot {
        struct Payload: Encodable { let enabled: [String: Bool] }
        return try decode(LocalRuntimeControlsSnapshot.self, from: try await send("PATCH", "/admin/local-runtime-controls", body: JSONEncoder().encode(Payload(enabled: enabled))))
    }
    public func computerUseStatus() async throws -> ComputerUseStatusResponse {
        try decode(ComputerUseStatusResponse.self, from: try await getJSON("/admin/capabilities/computer.use"))
    }
    public func installComputerUse() async throws -> CapabilityOperationResponse {
        try decode(CapabilityOperationResponse.self, from: try await send("POST", "/admin/capabilities/computer.use/install", body: Data("{}".utf8)))
    }
    public func testComputerUse() async throws -> ComputerUseManagedStatus {
        struct Wrapper: Decodable { let status: ComputerUseManagedStatus }
        return try decode(Wrapper.self, from: try await send("POST", "/admin/capabilities/computer.use/test")).status
    }
    public func setComputerUseEnabled(_ enabled: Bool) async throws -> ComputerUseManagedStatus {
        struct Payload: Encodable { let enabled: Bool }
        struct Wrapper: Decodable { let status: ComputerUseManagedStatus }
        return try decode(Wrapper.self, from: try await send("PATCH", "/admin/capabilities/computer.use", body: JSONEncoder().encode(Payload(enabled: enabled)))).status
    }
    public func uninstallComputerUse() async throws -> CapabilityOperationResponse {
        try decode(CapabilityOperationResponse.self, from: try await send("DELETE", "/admin/capabilities/computer.use", body: Data("{}".utf8)))
    }
    public func usageLedgerSnapshot() async throws -> UsageLedgerSnapshot {
        try decode(UsageLedgerSnapshot.self, from: try await getJSON("/admin/product/usage"))
    }
    public func addUsagePrice(_ draft: UsagePriceDraft) async throws {
        _ = try await send("POST", "/admin/usage/prices", body: JSONEncoder().encode(draft))
    }
    public func guidanceQueue(sessionID: String) async throws -> GuidanceQueueSnapshot {
        let id = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
        return try decode(GuidanceQueueSnapshot.self, from: try await getJSON("/admin/sessions/\(id)/guidance"))
    }
    public func enqueueGuidance(sessionID: String, content: String) async throws -> GuidanceQueueSnapshot.Item {
        struct Payload: Encodable { let content: String }
        struct Wrapper: Decodable { let item: GuidanceQueueSnapshot.Item }
        let id = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
        return try decode(Wrapper.self, from: try await send("POST", "/admin/sessions/\(id)/guidance", body: JSONEncoder().encode(Payload(content: content)))).item
    }
    public func cancelGuidance(sessionID: String, queueID: String) async throws {
        let session = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
        let queue = queueID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? queueID
        _ = try await send("DELETE", "/admin/sessions/\(session)/guidance/\(queue)")
    }
    public func sessionPermissions(sessionID: String) async throws -> SessionPermissionSnapshot {
        let id = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
        return try decode(SessionPermissionSnapshot.self, from: try await getJSON("/admin/sessions/\(id)/permissions"))
    }
    public func setSessionPermissionMode(sessionID: String, mode: SessionPermissionMode) async throws -> SessionPermissionSnapshot {
        struct Payload: Encodable { let mode: String }
        let id = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
        return try decode(SessionPermissionSnapshot.self, from: try await send("PATCH", "/admin/sessions/\(id)/permissions", body: JSONEncoder().encode(Payload(mode: mode.rawValue))))
    }
    public func setSessionWorkspace(sessionID: String, path: String) async throws -> SessionPermissionSnapshot {
        struct Payload: Encodable { let path: String }
        let id = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
        return try decode(SessionPermissionSnapshot.self, from: try await send("PUT", "/admin/sessions/\(id)/workspace", body: JSONEncoder().encode(Payload(path: path))))
    }
    public func setDefaultChatWorkspace(path: String) async throws -> SessionPermissionSnapshot {
        struct Payload: Encodable { let source: String; let external_key: String; let path: String }
        let body = try JSONEncoder().encode(Payload(source: "chat", external_key: "chat:default", path: path))
        return try decode(SessionPermissionSnapshot.self, from: try await send("PUT", "/admin/session-workspace", body: body))
    }
    public func clearSessionWorkspace(sessionID: String) async throws -> SessionPermissionSnapshot {
        let id = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
        return try decode(SessionPermissionSnapshot.self, from: try await send("DELETE", "/admin/sessions/\(id)/workspace"))
    }
    public func resolveSessionPermission(sessionID: String, requestID: String, action: String) async throws -> SessionPermissionSnapshot {
        struct Payload: Encodable { let action: String }
        struct Wrapper: Decodable { let snapshot: SessionPermissionSnapshot }
        let session = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
        let request = requestID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? requestID
        return try decode(Wrapper.self, from: try await send("POST", "/admin/sessions/\(session)/permissions/decisions/\(request)", body: JSONEncoder().encode(Payload(action: action)))).snapshot
    }
    public func revokeSessionPermissionGrant(sessionID: String, grantID: String) async throws -> SessionPermissionSnapshot {
        struct Wrapper: Decodable { let snapshot: SessionPermissionSnapshot }
        let session = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
        let grant = grantID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? grantID
        return try decode(Wrapper.self, from: try await send("DELETE", "/admin/sessions/\(session)/permissions/grants/\(grant)" )).snapshot
    }
    public func revokeAllSessionPermissionGrants(sessionID: String) async throws -> SessionPermissionSnapshot {
        struct Wrapper: Decodable { let snapshot: SessionPermissionSnapshot }
        let session = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionID
        return try decode(Wrapper.self, from: try await send("POST", "/admin/sessions/\(session)/permissions/revoke-all" )).snapshot
    }

    // MARK: 联网搜索配置（Key 只写 Keychain / Core 安全配置文件，绝不在响应中回传）

    public struct WebSearchStatus: Equatable, Codable {
        public let configured: Bool
        public let provider: String?
        public let reason: String?
        public var hasTavilyKey: Bool?
        public var searxngBaseURL: String?

        enum CodingKeys: String, CodingKey {
            case configured, provider, reason
            case hasTavilyKey = "has_tavily_key"
            case searxngBaseURL = "searxng_base_url"
        }
    }

    public func webSearchStatus() async throws -> WebSearchStatus {
        try decode(WebSearchStatus.self, from: try await getJSON("/admin/search/status"))
    }

    public func webSearchDetail() async throws -> WebSearchStatus {
        try decode(WebSearchStatus.self, from: try await getJSON("/admin/search/config"))
    }

    /// 更新搜索 Provider 配置。`tavilyAPIKey` 传 nil 表示保留已存 Key，传空串表示清除。
    public func updateWebSearch(provider: String, tavilyAPIKey: String?, searxngBaseURL: String?) async throws -> WebSearchStatus {
        var payload: [String: Any] = ["provider": provider]
        if let tavilyAPIKey { payload["tavily_api_key"] = tavilyAPIKey }
        if let searxngBaseURL { payload["searxng_base_url"] = searxngBaseURL }
        let body = try JSONSerialization.data(withJSONObject: payload)
        return try decode(WebSearchStatus.self, from: try await send("PUT", "/admin/search/config", body: body))
    }

    /// 发送 daily 聊天消息（非流式；Mac v1 保持简单可靠）
    public func sendChat(message: String, model: String = "yuna-chat",
                         attachments: [MediaUploadResponse] = [], webEnabled: Bool = false) async throws -> String {
        struct Choice: Decodable { struct Message: Decodable { let content: String? }; let message: Message }
        struct Completion: Decodable { let choices: [Choice] }
        let content: Any
        if attachments.isEmpty {
            content = message
        } else {
            var parts: [[String: Any]] = []
            if !message.isEmpty { parts.append(["type": "text", "text": message]) }
            parts += attachments.map { ["type": "image_url", "image_url": ["url": "companion-media://\($0.mediaId)"]] }
            content = parts
        }
        let payload: [String: Any] = [
            "model": model,
            "messages": [["role": "user", "content": content]],
            "metadata": ["webEnabled": webEnabled]
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        var req = try request("POST", "/v1/chat/completions", body: data)
        // Daily chat can include several local MCP tool rounds before Core returns
        // the final answer. URLSession's default 60-second request timeout can
        // otherwise cancel a healthy browser run between tool completion and the
        // final model response.
        req.timeoutInterval = 660
        req.setValue("chat", forHTTPHeaderField: "X-Companion-Source")
        req.setValue("chat:default", forHTTPHeaderField: "X-Companion-Session")
        let completion = try decode(Completion.self, from: try await perform(req))
        return completion.choices.first?.message.content ?? ""
    }

    /// 真正逐 delta 的聊天流。Core 负责最终消息持久化；这里仅更新临时 UI。
    public func captureScreenContext() async throws -> ScreenContextResponse {
        try decode(ScreenContextResponse.self, from: try await send("POST", "/v1/presence/screen-context", body: Data(#"{"explicit":true}"#.utf8)))
    }
    public func snoozeAttention(id: String, `in` interval: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["in": interval])
        _ = try await send("POST", "/admin/attention/\(id)/snooze", body: body)
    }
    public func streamChat(message: String, model: String = "yuna-chat",
                           attachments: [MediaUploadResponse] = [], webEnabled: Bool = false,
                           speechContext: VoiceCallTranscription? = nil,
                           screenContext: ScreenContextResponse? = nil,
                           requestID: String? = nil,
                           onVoiceDelivery: (@MainActor (VoiceDeliveryDecision) -> Void)? = nil,
                           onVoiceReady: (@MainActor (VoiceReadyPayload?) -> Void)? = nil,
                           onDelta: @escaping @MainActor (String) -> Void,
                           onBubbleMeta: (@MainActor (_ bubbleIndex: Int, _ bubbleCount: Int, _ messageId: Int?) -> Void)? = nil) async throws -> String {
        let content: Any
        if attachments.isEmpty { content = message }
        else {
            var parts: [[String: Any]] = []
            if !message.isEmpty { parts.append(["type": "text", "text": message]) }
            parts += attachments.map { ["type": "image_url", "image_url": ["url": "companion-media://\($0.mediaId)"]] }
            content = parts
        }
        var metadata: [String: Any] = ["webEnabled": webEnabled]
        if let speechContext, let encoded = try? JSONEncoder().encode(speechContext), let value = try? JSONSerialization.jsonObject(with: encoded) { metadata["speechContext"] = value }
        if let screenContext, let encoded = try? JSONEncoder().encode(screenContext), let value = try? JSONSerialization.jsonObject(with: encoded) { metadata["screenContext"] = value }
        let payload: [String: Any] = [
            "model": model, "stream": true,
            "messages": [["role": "user", "content": content]],
            "metadata": metadata
        ]
        var req = try request("POST", "/v1/chat/completions", body: JSONSerialization.data(withJSONObject: payload))
        req.timeoutInterval = 660
        req.setValue("chat", forHTTPHeaderField: "X-Companion-Source")
        req.setValue("chat:default", forHTTPHeaderField: "X-Companion-Session")
        if let requestID, !requestID.isEmpty { req.setValue(requestID, forHTTPHeaderField: "X-Companion-Request-ID") }
        let (bytes, response) = try await session.bytes(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.http(-1, "no response") }
        if !(200..<300).contains(http.statusCode) {
            // Preserve upstream/Core error body so UI can show the real failure
            // (pool not ready / rate limit / upstream 5xx) instead of a connection guess.
            var errorBody = ""
            do {
                for try await line in bytes.lines {
                    if errorBody.count >= 2000 { break }
                    errorBody += line + "\n"
                }
            } catch {}
            let body = errorBody.trimmingCharacters(in: .whitespacesAndNewlines)
            throw APIError.http(http.statusCode, body.isEmpty ? "stream request failed" : body)
        }
        var accumulated = "", plainLines: [String] = [], sawSSE = false
        func consumeFrame(_ payload: String) async throws {
            guard payload != "[DONE]", let data = payload.data(using: .utf8),
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            if let error = json["error"] as? [String: Any] { throw APIError.http(502, error["message"] as? String ?? "stream interrupted") }
            if let delivery = json["companion_voice_delivery"],
               JSONSerialization.isValidJSONObject(delivery),
               let encoded = try? JSONSerialization.data(withJSONObject: delivery),
               let value = try? decoder.decode(VoiceDeliveryDecision.self, from: encoded) {
                await onVoiceDelivery?(value)
                return
            }
            if let ready = json["companion_voice_ready"] as? [String: Any] {
                await onVoiceReady?(Self.decodeVoiceReady(ready))
                return
            }
            // companion.bubbles summary event — not a content frame
            if json["companion_bubbles"] != nil { return }
            guard let choices = json["choices"] as? [[String: Any]], let delta = choices.first?["delta"] as? [String: Any], let text = delta["content"] as? String, !text.isEmpty else { return }
            if let bubbleIndex = json["companion_bubble_index"] as? Int {
                let bubbleCount = (json["companion_bubble_count"] as? Int) ?? (bubbleIndex + 1)
                let messageId = (json["companion_message_id"] as? Int)
                await onBubbleMeta?(bubbleIndex, bubbleCount, messageId)
            }
            accumulated += text
            await onDelta(text)
        }
        for try await line in bytes.lines {
            if line.hasPrefix("data:") { sawSSE = true; try await consumeFrame(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)) }
            else if !sawSSE && !line.hasPrefix("event:") { plainLines.append(line) }
        }
        if !sawSSE {
            struct Choice: Decodable { struct Message: Decodable { let content: String? }; let message: Message }
            struct Completion: Decodable { let choices: [Choice] }
            let final = try decode(Completion.self, from: Data(plainLines.joined(separator: "\n").utf8)).choices.first?.message.content ?? ""
            if !final.isEmpty { await onDelta(final) }
            return final
        }
        return accumulated
    }

    public func uploadImage(_ attachment: PendingImageAttachment) async throws -> MediaUploadResponse {
        var req = try request("POST", "/media/upload", body: nil)
        req.setValue(attachment.mime, forHTTPHeaderField: "Content-Type")
        req.setValue(attachment.filename.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "image", forHTTPHeaderField: "X-Companion-Filename")
        req.httpBody = attachment.data
        return try decode(MediaUploadResponse.self, from: try await perform(req))
    }

    /// 媒体下载（图片附件），返回原始字节与 MIME。
    public func mediaData(id: String) async throws -> (Data, String) {
        var req = try request("GET", "/media/\(id)", body: nil)
        req.timeoutInterval = 15
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.http(-1, "no response") }
        guard (200..<300).contains(http.statusCode) else { throw APIError.http(http.statusCode, "") }
        return (data, http.value(forHTTPHeaderField: "Content-Type") ?? "image/png")
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try decoder.decode(T.self, from: data) }
        catch { throw APIError.decoding(String(describing: error)) }
    }

    private static func decodeVoiceReady(_ json: [String: Any]) -> VoiceReadyPayload? {
        let messageID = (json["message_id"] as? Int) ?? (json["message_id"] as? Double).map(Int.init)
        guard let messageID else { return nil }
        let assetJSON = json["voice_asset"] as? [String: Any]
        let asset = (assetJSON?["voice_asset_id"] as? String).map {
            VoiceAsset(
                voiceAssetID: $0,
                duration: (assetJSON?["duration"] as? Double) ?? 0,
                state: (assetJSON?["state"] as? String) ?? "ready",
                url: assetJSON?["url"] as? String
            )
        }
        return VoiceReadyPayload(
            messageID: messageID,
            sessionID: json["session_id"] as? String,
            attemptKey: json["attempt_key"] as? String,
            voiceAsset: asset,
            voiceStyle: json["voice_style"] as? String,
            shouldAutoplay: (json["should_autoplay"] as? Bool) ?? false
        )
    }
}
