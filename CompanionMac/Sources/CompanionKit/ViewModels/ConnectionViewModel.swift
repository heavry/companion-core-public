import Foundation
import Combine

/// 连接与实时事件聚合视图模型。
@MainActor
public final class ConnectionViewModel: ObservableObject {
    @Published public private(set) var status: RealtimeClient.Status = .idle
    @Published public private(set) var lastEvent: RealtimeEvent?
    @Published public private(set) var proactiveEvents: [RealtimeEvent] = []
    @Published public private(set) var activityEvents: [RealtimeEvent] = []
    @Published public private(set) var activeAgentSessionIDs: Set<String> = []
    @Published public private(set) var guidanceRevision = 0
    @Published public private(set) var permissionRevision = 0
    @Published public private(set) var conversationRevision = 0
    @Published public private(set) var voiceReadyRevision = 0
    @Published public private(set) var lastVoiceReady: VoiceReadyPayload?
    @Published public var selectedConversationId: String? {
        didSet { NotificationService.shared.setCurrentlyViewing(conversationId: selectedConversationId) }
    }

    private var realtime: RealtimeClient?
    public private(set) var apiRef: APIClient?
    private weak var catchUpRef: ProactiveCatchUpService?

    /// 装配依赖（幂等）；随后调用 connectIfNeeded() 开始实时订阅
    public func configure(api: APIClient, catchUp: ProactiveCatchUpService) {
        apiRef = api
        self.catchUpRef = catchUp
    }

    /// 兼容别名：装配并启动
    public func attach(api: APIClient, catchUp: ProactiveCatchUpService) {
        configure(api: api, catchUp: catchUp)
        connectIfNeeded()
    }

    public func connectIfNeeded() {
        guard let api = apiRef else { return } // 未装配前不启动订阅
        if realtime == nil {
            let base = api.config.baseURL
            realtime = RealtimeClient(baseURL: base, tokenProvider: api.config.tokenProvider)
            realtime?.onEvent = { [weak self] e in Task { await self?.handle(e) } }
            realtime?.onStatusChange = { [weak self] s in Task { await self?.setStatus(s) } }
        }
        realtime?.connect()
    }

    func setStatus(_ s: RealtimeClient.Status) {
        status = s
        switch s {
        case .connected: Breadcrumb.emit("ws.state.connected")
        case .closed: Breadcrumb.emit("ws.state.disconnected")
        case .connecting: Breadcrumb.emit("ws.state.reconnecting")
        case .idle: break
        }
    }

    public init() {}

    public func isAgentRunning(sessionID: String?) -> Bool {
        guard let sessionID else { return false }
        return activeAgentSessionIDs.contains(sessionID)
    }

    /// The chat SSE terminal frame is authoritative local evidence that this
    /// client is no longer streaming the turn. Core still independently gates
    /// guidance POSTs, so this is UI convergence rather than a safety decision.
    public func markAgentStreamCompleted(sessionID: String?) {
        guard let sessionID else { return }
        activeAgentSessionIDs.remove(sessionID)
    }

    /// 配置并连接（baseURL 形如 http://127.0.0.1:8765）
    public func configure(baseURL: URL, tokenProvider: @escaping @Sendable () -> String) {
        let client = RealtimeClient(baseURL: baseURL, tokenProvider: tokenProvider)
        client.onStatusChange = { [weak self] s in self?.status = s }
        client.onEvent = { [weak self] event in self?.handle(event) }
        realtime = client
        client.connect()
    }

    func handle(_ event: RealtimeEvent) {
        lastEvent = event
        switch event.type {
        case "proactive.created", "attention.created":
            proactiveEvents.insert(event, at: 0)
            if proactiveEvents.count > 100 { proactiveEvents.removeLast(proactiveEvents.count - 100) }
            let preview = PresenceSettingsStore().settings.notificationPreview
            NotificationService.shared.post(
                .init(
                    title: (event.data?["title"]?.stringValue) ?? "林小糖",
                    body: (event.data?["preview"]?.stringValue) ?? event.previewText ?? "有一条需要你关注的事。",
                    messageKey: event.eventId ?? UUID().uuidString,
                    conversationId: event.sessionId ?? selectedConversationId,
                    destination: (event.data?["type"]?.stringValue) == "approval_needed" ? "chat" : "today",
                    attentionId: event.data?["id"]?.stringValue,
                    preview: preview,
                    playSound: true
                )
            )
        case "message.created":
            if event.data?["role"]?.stringValue != "user" { conversationRevision += 1 }
            Task { await catchUpRef?.refresh() }
        case "voice.ready":
            if let payload = Self.decodeVoiceReady(event) {
                lastVoiceReady = payload
                voiceReadyRevision += 1
            }
        case "image.created":
            conversationRevision += 1
            Task { await catchUpRef?.refresh() }
        case "agent.started":
            if let id = event.sessionId { activeAgentSessionIDs.insert(id) }
            activityEvents.insert(event, at: 0)
            if activityEvents.count > 300 { activityEvents.removeLast(activityEvents.count - 300) }
        case "agent.completed", "turn.completed":
            if let id = event.sessionId { activeAgentSessionIDs.remove(id) }
            activityEvents.insert(event, at: 0)
            if activityEvents.count > 300 { activityEvents.removeLast(activityEvents.count - 300) }
        case "guidance.queued", "guidance.cancelled", "guidance.consumed":
            guidanceRevision += 1
        case "permission.requested", "permission.resolved", "permission.mode_changed", "workspace.changed",
             "permission.grant_revoked", "permission.grants_revoked":
            permissionRevision += 1
            activityEvents.insert(event, at: 0)
            if activityEvents.count > 300 { activityEvents.removeLast(activityEvents.count - 300) }
        case "tool.started", "tool.completed", "tool.failed",
             "module.started", "module.completed", "module.failed":
            activityEvents.insert(event, at: 0)
            if activityEvents.count > 300 { activityEvents.removeLast(activityEvents.count - 300) }
        default:
            break
        }
    }

    private static func decodeVoiceReady(_ event: RealtimeEvent) -> VoiceReadyPayload? {
        guard let data = event.data else { return nil }
        let messageID = (data["message_id"]?.intValue)
            ?? (data["companion_voice_ready"]?["message_id"]?.intValue)
        guard let messageID else { return nil }
        let assetJSON = data["voice_asset"] ?? data["companion_voice_ready"]?["voice_asset"]
        let assetID = assetJSON?["voice_asset_id"]?.stringValue
        let asset = assetID.map {
            VoiceAsset(
                voiceAssetID: $0,
                duration: assetJSON?["duration"]?.doubleValue ?? 0,
                state: assetJSON?["state"]?.stringValue ?? "ready",
                url: assetJSON?["url"]?.stringValue
            )
        }
        let should = (data["should_autoplay"]?.boolValue)
            ?? (data["companion_voice_ready"]?["should_autoplay"]?.boolValue)
            ?? false
        return VoiceReadyPayload(
            messageID: messageID,
            sessionID: event.sessionId ?? data["session_id"]?.stringValue,
            attemptKey: data["attempt_key"]?.stringValue ?? data["companion_voice_ready"]?["attempt_key"]?.stringValue,
            voiceAsset: asset,
            voiceStyle: data["voice_style"]?.stringValue ?? data["companion_voice_ready"]?["voice_style"]?.stringValue,
            shouldAutoplay: should
        )
    }
}
