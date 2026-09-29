import Foundation
import AppKit

/// 面向用户的友好文本：剥离内部标签前缀（如 [weather]/[module:x]）。
public func friendlyText(_ raw: String?) -> String {
    guard var text = raw, !text.isEmpty else { return "" }
    while text.hasPrefix("["), let close = text.firstIndex(of: "]") {
        text = String(text[text.index(after: close)...]).trimmingCharacters(in: .whitespaces)
    }
    return text
}

// MARK: - 共享默认地址
@inline(__always) public func AppModelServerBase() -> URL {
    if let raw = UserDefaults.standard.string(forKey: "serverBaseURL"), let url = URL(string: raw) { return url }
    return URL(string: "http://127.0.0.1:8765")!
}

// MARK: - JSONValue（宽松事件负载解码）

public enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case dictionary([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let v = try? container.decode(Bool.self) { self = .bool(v); return }
        if let v = try? container.decode(Double.self) { self = .number(v); return }
        if let v = try? container.decode(String.self) { self = .string(v); return }
        if (try? container.decodeNil()) == true { self = .null; return }
        if let v = try? container.decode([JSONValue].self) { self = .array(v); return }
        if let v = try? container.decode([String: JSONValue].self) { self = .dictionary(v); return }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "unsupported JSON")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        case .array(let v): try c.encode(v)
        case .dictionary(let v): try c.encode(v)
        }
    }

    public var stringValue: String? { if case .string(let v) = self { return v }; return nil }
    public var boolValue: Bool? { if case .bool(let v) = self { return v }; return nil }
    public var intValue: Int? { if case .number(let v) = self { return Int(v) }; return nil }
    public var doubleValue: Double? { if case .number(let v) = self { return v }; return nil }
    public subscript(key: String) -> JSONValue? {
        if case .dictionary(let d) = self { return d[key] }
        return nil
    }

    public var dictionaryValue: [String: JSONValue]? {
        if case .dictionary(let d) = self { return d }
        return nil
    }

    /// 客户端防御：递归剥离敏感键（纵深防御，Core 已在服务端过滤）
    public func strippingSensitiveKeys() -> JSONValue {
        switch self {
        case .dictionary(let d):
            var out: [String: JSONValue] = [:]
            for (k, v) in d {
                let key = k.lowercased().replacingOccurrences(of: "_", with: "").replacingOccurrences(of: "-", with: "")
                if key.contains("apikey") || key.contains("authorization") || key.contains("cookie")
                    || key.contains("password") || key.contains("credential")
                    || key.contains("token") || key.contains("secret") { continue }
                out[k] = v.strippingSensitiveKeys()
            }
            return .dictionary(out)
        case .array(let a): return .array(a.map { $0.strippingSensitiveKeys() })
        default: return self
        }
    }
}

// MARK: - 领域模型

public struct Conversation: Identifiable, Equatable, Codable, Hashable {
    public let id: String
    public let source: String
    public let externalKey: String?
    public let category: String       // daily | agents | proactive | system
    public let displayName: String
    public let lastActivity: String?
    public let messageCount: Int?
    public let recentMessage: String?
    public let archived: Bool?

    public init(id: String, source: String, externalKey: String?, category: String,
                displayName: String, lastActivity: String?, messageCount: Int?,
                recentMessage: String?, archived: Bool?) {
        self.id = id; self.source = source; self.externalKey = externalKey
        self.category = category; self.displayName = displayName
        self.lastActivity = lastActivity; self.messageCount = messageCount
        self.recentMessage = recentMessage; self.archived = archived
    }

    enum CodingKeys: String, CodingKey {
        case id, source, category
        case displayName = "display_name"
        case externalKey = "external_key"
        case lastActivity = "last_activity"
        case messageCount = "message_count"
        case recentMessage = "recent_message"
        case archived
    }
}

public struct ConversationMessagesResponse: Equatable, Codable {
    public struct Row: Identifiable, Equatable, Codable {
        public init(id: Int, role: String, contentText: String?, toolCallsJson: String?,
                    toolCallId: String?, createdAt: String?, attachments: [MediaAttachment]?,
                    webSources: [WebSource]? = nil, toolActivities: [ToolActivityMetadata]? = nil,
                    voiceAsset: VoiceAsset? = nil, voicePlan: RemoteVoicePlan? = nil, bubbleIndex: Int? = nil,
                    bubbleCount: Int? = nil, bubbleTurnId: String? = nil,
                    generationRoute: String? = nil) {
            self.id = id; self.role = role; self.contentText = contentText
            self.toolCallsJson = toolCallsJson; self.toolCallId = toolCallId
            self.createdAt = createdAt; self.attachments = attachments
            self.webSources = webSources
            self.toolActivities = toolActivities
            self.voiceAsset = voiceAsset
            self.voicePlan = voicePlan
            self.bubbleIndex = bubbleIndex
            self.bubbleCount = bubbleCount
            self.bubbleTurnId = bubbleTurnId
            self.generationRoute = generationRoute
        }
        public let id: Int
        public let role: String
        public let contentText: String?
        public let toolCallsJson: String?
        public let toolCallId: String?
        public let createdAt: String?
        public let attachments: [MediaAttachment]?
        public let webSources: [WebSource]?
        public let toolActivities: [ToolActivityMetadata]?
        public let voiceAsset: VoiceAsset?
        public let voicePlan: RemoteVoicePlan?
        public let bubbleIndex: Int?
        public let bubbleCount: Int?
        public let bubbleTurnId: String?
        public let generationRoute: String?

        enum CodingKeys: String, CodingKey {
            case id, role
            case contentText = "content_text"
            case toolCallsJson = "tool_calls_json"
            case toolCallId = "tool_call_id"
            case createdAt = "created_at"
            case attachments
            case webSources = "web_sources"
            case toolActivities = "tool_activities"
            case voiceAsset = "voice_asset"
            case voicePlan = "voice_plan"
            case bubbleIndex = "bubble_index"
            case bubbleCount = "bubble_count"
            case bubbleTurnId = "bubble_turn_id"
            case generationRoute = "generation_route"
        }
    }
    public let data: [Row]
}

/// Immutable Core decision consumed by the remote-mode Mac client. The text is
/// already-finalized bubble text; local synthesis must never change it or create
/// another assistant message.
public struct RemoteVoicePlan: Equatable, Codable, Sendable {
    public let schemaVersion: Int
    public let generationID: String
    public let bubbleTurnID: String
    public let bubbleIndex: Int
    public let bubbleCount: Int
    public let text: String
    public let voiceRequested: Bool
    public let voiceProfile: String
    public let voiceStyle: String?
    public let emotion: String?

    enum CodingKeys: String, CodingKey {
        case text, emotion
        case schemaVersion = "schema_version"
        case generationID = "generation_id"
        case bubbleTurnID = "bubble_turn_id"
        case bubbleIndex = "bubble_index"
        case bubbleCount = "bubble_count"
        case voiceRequested = "voice_requested"
        case voiceProfile = "voice_profile"
        case voiceStyle = "voice_style"
    }
}

public struct VoiceAsset: Equatable, Codable, Sendable {
    public init(voiceAssetID: String, duration: Double, state: String, createdAt: String? = nil,
                expiredAt: String? = nil, url: String? = nil) {
        self.voiceAssetID = voiceAssetID; self.duration = duration; self.state = state
        self.createdAt = createdAt; self.expiredAt = expiredAt; self.url = url
    }
    public let voiceAssetID: String
    public let duration: Double
    public let state: String
    public let createdAt: String?
    public let expiredAt: String?
    public let url: String?
    enum CodingKeys: String, CodingKey {
        case voiceAssetID = "voice_asset_id"
        case duration, state, url
        case createdAt = "created_at"
        case expiredAt = "expired_at"
    }
}

/// Core 为聊天展示生成的最小安全工具元数据。原始 arguments / output 不进入此模型。
public struct ToolActivityMetadata: Equatable, Codable {
    public init(callId: String, status: String, sourceType: String? = nil, sourceId: String? = nil,
                integrationName: String? = nil, displayName: String? = nil,
                detail: String? = nil, resultCount: Int? = nil, failureCategory: String? = nil,
                failureCode: String? = nil, failureSummary: String? = nil, failureReason: String? = nil) {
        self.callId = callId; self.status = status; self.sourceType = sourceType; self.sourceId = sourceId
        self.integrationName = integrationName; self.displayName = displayName
        self.detail = detail; self.resultCount = resultCount
        self.failureCategory = failureCategory; self.failureCode = failureCode
        self.failureSummary = failureSummary; self.failureReason = failureReason
    }
    public let callId: String
    public let status: String
    public let sourceType: String?
    public let sourceId: String?
    public let integrationName: String?
    public let displayName: String?
    public let detail: String?
    public let resultCount: Int?
    public let failureCategory: String?
    public let failureCode: String?
    public let failureSummary: String?
    public let failureReason: String?

    enum CodingKeys: String, CodingKey {
        case status, detail
        case callId = "call_id"
        case sourceType = "source_type"
        case sourceId = "source_id"
        case integrationName = "integration_name"
        case displayName = "display_name"
        case resultCount = "result_count"
        case failureCategory = "failure_category"
        case failureCode = "failure_code"
        case failureSummary = "failure_summary"
        case failureReason = "failure_reason"
    }
}

public enum SessionPermissionMode: String, CaseIterable, Codable, Identifiable {
    case ask
    case riskBased = "risk_based"
    case sessionGrant = "session_grant"
    case fullAutonomy = "full_autonomy"
    public var id: String { rawValue }
    public var title: String { switch self { case .ask: "请求批准"; case .riskBased: "帮我批准"; case .sessionGrant: "本会话扩展授权"; case .fullAutonomy: "完全自主" } }
    public var summary: String { switch self {
        case .ask: "外部工具调用前先询问。"
        case .riskBased: "安全只读操作自动执行；有副作用时询问。"
        case .sessionGrant: "仅对当前会话中明确批准的能力减少重复确认。"
        case .fullAutonomy: "在当前授权范围内连续执行任务，不再逐步确认；系统与凭证等硬边界仍然保留。"
    } }
    public var symbol: String { switch self { case .ask: "shield"; case .riskBased: "checkmark.shield"; case .sessionGrant: "shield.fill"; case .fullAutonomy: "bolt.shield.fill" } }
}

public struct SessionPermissionGrant: Identifiable, Equatable, Codable {
    public let id: String
    public let sessionId: String
    public let capabilityId: String
    public let scope: String
    public let sourceType: String?
    public let sourceId: String?
    public let integrationName: String?
    public let displayName: String?
    public let createdAt: String
    public let expiresAt: String
    public let source: String
    enum CodingKeys: String, CodingKey {
        case id, scope, source
        case sessionId = "session_id"; case capabilityId = "capability_id"
        case sourceType = "source_type"; case sourceId = "source_id"
        case integrationName = "integration_name"; case displayName = "display_name"
        case createdAt = "created_at"; case expiresAt = "expires_at"
    }
}

public struct SessionPermissionRequest: Identifiable, Equatable, Codable {
    public var id: String { requestId }
    public let requestId: String
    public let sessionId: String
    public let callId: String
    public let capabilityId: String
    public let sourceType: String?
    public let sourceId: String?
    public let integrationName: String
    public let displayName: String
    public let scope: String
    public let riskLevel: String
    public let readOnly: Bool
    public let reason: String
    public let canAllowSession: Bool
    public var actionPreview: String? = nil
    public let createdAt: String
    public let expiresAt: String
    public let status: String
    enum CodingKeys: String, CodingKey {
        case scope, reason, status
        case actionPreview = "action_preview"
        case requestId = "request_id"; case sessionId = "session_id"; case callId = "call_id"
        case capabilityId = "capability_id"; case sourceType = "source_type"; case sourceId = "source_id"
        case integrationName = "integration_name"; case displayName = "display_name"
        case riskLevel = "risk_level"; case readOnly = "read_only"; case canAllowSession = "can_allow_session"
        case createdAt = "created_at"; case expiresAt = "expires_at"
    }
}

public struct SessionPermissionSnapshot: Equatable, Codable {
    public let sessionId: String
    public let mode: SessionPermissionMode
    public let grants: [SessionPermissionGrant]
    public let pending: [SessionPermissionRequest]
    public let workspace: SessionWorkspace?
    enum CodingKeys: String, CodingKey { case mode, grants, pending, workspace; case sessionId = "session_id" }
}

public struct SessionWorkspace: Equatable, Codable {
    public let path: String
    public let name: String
}

/// 联网搜索来源（assistant 消息附带的轻量引用信息）。
public struct WebSource: Equatable, Codable, Identifiable {
    public let title: String
    public let url: String
    public let snippet: String?
    public let publishedAt: String?
    public let source: String?

    public init(title: String, url: String, snippet: String? = nil, publishedAt: String? = nil, source: String? = nil) {
        self.title = title; self.url = url; self.snippet = snippet
        self.publishedAt = publishedAt; self.source = source
    }
    public var id: String { url }
    public var displayDomain: String {
        if let source, !source.isEmpty { return source }
        var host = url
        for prefix in ["https://", "http://"] where host.hasPrefix(prefix) { host.removeFirst(prefix.count) }
        if let slash = host.firstIndex(of: "/") { host = String(host[..<slash]) }
        return host
    }

    enum CodingKeys: String, CodingKey {
        case title, url, snippet, source
        case publishedAt = "published_at"
    }
}

public struct MediaAttachment: Equatable, Codable, Identifiable {
    public init(mediaId: String?, mime: String?, path: String?, width: Int?, height: Int?, bytes: Int?) {
        self.mediaId = mediaId; self.mime = mime; self.path = path
        self.width = width; self.height = height; self.bytes = bytes
    }
    public var id: String { mediaId ?? path ?? UUID().uuidString }
    public let mediaId: String?
    public let mime: String?
    public let path: String?
    public let width: Int?
    public let height: Int?
    public let bytes: Int?
}

public struct MediaUploadResponse: Equatable, Codable {
    public let mediaId: String
    public let mime: String
    public let filename: String
    public let width: Int
    public let height: Int
    public let bytes: Int
    public let url: String

    public init(mediaId: String, mime: String, filename: String, width: Int, height: Int, bytes: Int, url: String) {
        self.mediaId = mediaId; self.mime = mime; self.filename = filename
        self.width = width; self.height = height; self.bytes = bytes; self.url = url
    }

    enum CodingKeys: String, CodingKey {
        case mime, filename, width, height, bytes, url
        case mediaId = "media_id"
    }
}

public enum ImageAttachmentError: Error, Equatable {
    case unsupportedType
    case tooLarge
    case invalidImage
}

public struct PendingImageAttachment: Identifiable, Equatable {
    public static let maxBytes = 10 * 1024 * 1024
    public let id: UUID
    public let filename: String
    public let mime: String
    public let data: Data

    public init(id: UUID = UUID(), filename: String, mime: String, data: Data) throws {
        guard data.count <= Self.maxBytes else { throw ImageAttachmentError.tooLarge }
        guard ["image/png", "image/jpeg", "image/webp"].contains(mime) else { throw ImageAttachmentError.unsupportedType }
        guard NSImage(data: data) != nil else { throw ImageAttachmentError.invalidImage }
        self.id = id; self.filename = filename; self.mime = mime; self.data = data
    }

    public static func load(from url: URL) throws -> PendingImageAttachment {
        let ext = url.pathExtension.lowercased()
        let mime: String
        switch ext {
        case "png": mime = "image/png"
        case "jpg", "jpeg": mime = "image/jpeg"
        case "webp": mime = "image/webp"
        default: throw ImageAttachmentError.unsupportedType
        }
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        if let size = values.fileSize, size > maxBytes { throw ImageAttachmentError.tooLarge }
        return try PendingImageAttachment(filename: url.lastPathComponent, mime: mime, data: Data(contentsOf: url))
    }
}

public struct ComposerImageAttachment: Identifiable, Equatable {
    public var id: UUID { pending.id }
    public let pending: PendingImageAttachment
    public var uploaded: MediaUploadResponse?
}

public struct CoreCapabilities: Equatable, Codable {
    public struct Capability: Equatable, Codable {
        public let configured: Bool
        public let mode: String?
        public let reason: String?
        public let provider: String?
    }
    public let vision: Capability
    public let webSearch: Capability
    public let voice: VoiceStatus?

    enum CodingKeys: String, CodingKey {
        case vision
        case webSearch = "web_search"
        case voice
    }
}

public struct VoiceStatus: Equatable, Codable {
    public struct Metrics: Equatable, Codable {
        public let requests: Int
        public let successes: Int
        public let failures: Int
        public let characters: Int
        public let audioBytes: Int
        public let durationMs: Int
        public let costUsd: Double
        enum CodingKeys: String, CodingKey { case requests, successes, failures, characters; case audioBytes = "audio_bytes"; case durationMs = "duration_ms"; case costUsd = "cost_usd" }
    }
    public let id: String
    public let provider: String
    public let voice: String
    public let backend: String
    public let device: String
    public let precision: String
    public let state: String
    public let ready: Bool
    public let enabled: Bool
    public let mode: String
    public let speed: Double
    public let endpoint: String
    public let managedProcess: Bool
    public let lastError: String?
    public let metrics: Metrics
    enum CodingKeys: String, CodingKey { case id, provider, voice, backend, device, precision, state, ready, enabled, mode, speed, endpoint, metrics; case managedProcess = "managed_process"; case lastError = "last_error" }
}

public struct VoiceCallRuntimeStatus: Equatable, Codable {
    public struct SpeechStatus: Equatable, Codable {
        public let state: String
        public let ready: Bool
        public let configured: Bool
    }
    public let stt: SpeechStatus
    public let tts: VoiceStatus
}

public struct VoiceCallTranscription: Equatable, Codable {
    public struct Prosody: Equatable, Codable {
        public let pitchMeanHz: Double?
        public let pitchRangeHz: Double?
        public let energyRmsMean: Double
        public let pauseRatio: Double
        enum CodingKeys: String, CodingKey { case pitchMeanHz = "pitch_mean_hz"; case pitchRangeHz = "pitch_range_hz"; case energyRmsMean = "energy_rms_mean"; case pauseRatio = "pause_ratio" }
    }
    public struct SpeechContext: Equatable, Codable {
        public let rawTranscript: String
        public let normalizedTranscript: String
        public let uncertain: Bool
        enum CodingKeys: String, CodingKey { case rawTranscript = "raw_transcript"; case normalizedTranscript = "normalized_transcript"; case uncertain }
    }
    public let transcript: String
    public let language: String?
    public let emotion: String?
    public let audioEvents: [String]
    public let prosody: Prosody
    public let audioDurationSeconds: Double
    public let inferenceMs: Double
    public let realtimeFactor: Double
    public let speechContext: SpeechContext
    enum CodingKeys: String, CodingKey {
        case transcript, language, emotion, prosody
        case audioEvents = "audio_events"; case audioDurationSeconds = "audio_duration_seconds"
        case inferenceMs = "inference_ms"; case realtimeFactor = "realtime_factor"; case speechContext = "speech_context"
    }
}

public struct VoiceSynthesisResponse: Equatable, Codable {
    public let id: String
    public let text: String
    public let durationMs: Int
    public let audioURL: String
    enum CodingKeys: String, CodingKey { case id, text; case durationMs = "duration_ms"; case audioURL = "audio_url" }
}

public struct WakeWordStatus: Equatable, Codable {
    public struct Metrics: Equatable, Codable {
        public let listeningSeconds: Double
        public let wakeDetections: Int
        public let oneShotTurns: Int
        public let timeouts: Int
        public let cancels: Int
        public let falseWakeDismiss: Int
        public let callStarts: Int
        public let costUsd: Double
        public let inputTokens: Int
        public let outputTokens: Int
        enum CodingKeys: String, CodingKey {
            case timeouts, cancels
            case listeningSeconds = "listening_seconds"
            case wakeDetections = "wake_detections"
            case oneShotTurns = "one_shot_turns"
            case falseWakeDismiss = "false_wake_dismiss"
            case callStarts = "call_starts"
            case costUsd = "cost_usd"
            case inputTokens = "input_tokens"
            case outputTokens = "output_tokens"
        }
    }
    public let state: String
    public let enabled: Bool
    public let sensitivity: String
    public let experimental: Bool
    public let productQualified: Bool
    public let configured: Bool
    public let ready: Bool
    public let feedbackSound: Bool
    public let suspendWhileLocked: Bool
    public let lastError: String?
    public let metrics: Metrics?
    enum CodingKeys: String, CodingKey {
        case state, enabled, sensitivity, experimental, configured, ready, metrics
        case productQualified = "product_qualified"
        case feedbackSound = "feedback_sound"
        case suspendWhileLocked = "suspend_while_locked"
        case lastError = "last_error"
    }
}

public struct WakeWordIngestResponse: Equatable, Codable {
    public struct Detection: Equatable, Codable {
        public let keyword: String
        public let score: Double?
    }
    public let accepted: Bool
    public let detections: [Detection]
    public let gated: Bool?
    public let state: String?
}

public struct WakeWordResolveResponse: Equatable, Codable {
    public let command: String
    public let raw: String
    public let stripped: String
    public let persistUserText: String?
    enum CodingKeys: String, CodingKey {
        case command, raw, stripped
        case persistUserText = "persist_user_text"
    }
}

/// Ephemeral Core decision carried beside the stream. It is never part of the
/// assistant message content and therefore cannot enter conversation memory.
public struct VoiceDeliveryDecision: Equatable, Codable {
    public let voiceDelivery: String
    public let reason: String
    public let emotion: String
    public let emotionIntensity: Double
    public let voiceAsset: VoiceAsset?
    enum CodingKeys: String, CodingKey {
        case voiceDelivery = "voice_delivery"
        case reason, emotion
        case emotionIntensity = "emotion_intensity"
        case voiceAsset = "voice_asset"
    }
}

/// Core voice-ready signal. Asset ready ≠ should autoplay.
public struct VoiceReadyPayload: Equatable, Codable {
    public let messageID: Int
    public let sessionID: String?
    public let attemptKey: String?
    public let voiceAsset: VoiceAsset?
    public let voiceStyle: String?
    public let shouldAutoplay: Bool

    enum CodingKeys: String, CodingKey {
        case messageID = "message_id"
        case sessionID = "session_id"
        case attemptKey = "attempt_key"
        case voiceAsset = "voice_asset"
        case voiceStyle = "voice_style"
        case shouldAutoplay = "should_autoplay"
    }

    public init(messageID: Int, sessionID: String? = nil, attemptKey: String? = nil,
                voiceAsset: VoiceAsset?, voiceStyle: String? = nil, shouldAutoplay: Bool) {
        self.messageID = messageID
        self.sessionID = sessionID
        self.attemptKey = attemptKey
        self.voiceAsset = voiceAsset
        self.voiceStyle = voiceStyle
        self.shouldAutoplay = shouldAutoplay
    }
}

public struct ModelsResponse: Equatable, Codable {
    public struct Model: Equatable, Codable {
        public let id: String
    }
    public let data: [Model]
}

public struct ScreenContextResponse: Equatable, Codable {
    public let ephemeral: Bool
    public let persist: Bool
    public let memory: Bool
    public let screenshot: Bool
    public let summary: String
    public let frontmost: String?
    public let unavailable: Bool?
}

public struct HealthResponse: Equatable, Codable {
    public let ok: Bool
    public let version: String
}

// MARK: - Realtime 事件

public struct RealtimeEvent: Equatable {
    public init(type: String, eventId: String?, at: String?, sessionId: String?, data: JSONValue?) {
        self.type = type; self.eventId = eventId; self.at = at
        self.sessionId = sessionId; self.data = data
    }
    public let type: String
    public let eventId: String?
    public let at: String?
    public let sessionId: String?
    public let data: JSONValue?

    public var previewText: String? { data?.stringValue }
}

struct RealtimeWireEvent: Decodable {
    let type: String
    let eventId: String?
    let at: String?
    let sessionId: String?
    let data: JSONValue?
}

extension RealtimeEvent: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type, at, data
        case eventId = "eventId"
        case sessionId = "sessionId"
    }
    public init(from decoder: Decoder) throws {
        // 兼容 snake/camel：Core 使用 eventId / sessionId（camel），此处同时容忍 event_id/session_id
        if let c = try? decoder.container(keyedBy: CodingKeys.self) {
            type = try c.decode(String.self, forKey: .type)
            eventId = try c.decodeIfPresent(String.self, forKey: .eventId)
                ?? (try? decoder.container(keyedBy: SnakeKeys.self)).flatMap { try $0.decodeIfPresent(String.self, forKey: .eventId) }
            at = try c.decodeIfPresent(String.self, forKey: .at)
            sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
                ?? (try? decoder.container(keyedBy: SnakeKeys.self)).flatMap { try $0.decodeIfPresent(String.self, forKey: .sessionId) }
            data = try c.decodeIfPresent(JSONValue.self, forKey: .data)
        } else {
            throw DecodingError.dataCorrupted(DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "bad event"))
        }
    }
    private enum SnakeKeys: String, CodingKey { case eventId = "event_id", sessionId = "session_id" }
}

// MARK: - Behavior / State

public struct QuietHours: Equatable, Codable {
    public var start: String
    public var end: String
    public init(start: String, end: String) { self.start = start; self.end = end }
}

public struct BehaviorSettings: Equatable, Codable {
    public var proactiveLevel: String          // low | normal | active
    public var proactiveMessagesEnabled: Bool
    public var quietHours: QuietHours
    public var weatherAwareness: Bool
    public var followUpEnabled: Bool
    public var proactiveImagesEnabled: Bool
    public var dailyProactiveCap: Int
    public var dailyProactiveImageCap: Int

    public init(proactiveLevel: String,
                proactiveMessagesEnabled: Bool,
                quietHours: QuietHours,
                weatherAwareness: Bool,
                followUpEnabled: Bool,
                proactiveImagesEnabled: Bool,
                dailyProactiveCap: Int,
                dailyProactiveImageCap: Int) {
        self.proactiveLevel = proactiveLevel
        self.proactiveMessagesEnabled = proactiveMessagesEnabled
        self.quietHours = quietHours
        self.weatherAwareness = weatherAwareness
        self.followUpEnabled = followUpEnabled
        self.proactiveImagesEnabled = proactiveImagesEnabled
        self.dailyProactiveCap = dailyProactiveCap
        self.dailyProactiveImageCap = dailyProactiveImageCap
    }

    enum CodingKeys: String, CodingKey {
        case proactiveLevel = "proactiveLevel"
        case proactiveMessagesEnabled = "proactiveMessagesEnabled"
        case quietHours = "quietHours"
        case weatherAwareness = "weatherAwareness"
        case followUpEnabled = "followUpEnabled"
        case proactiveImagesEnabled = "proactiveImagesEnabled"
        case dailyProactiveCap = "dailyProactiveCap"
        case dailyProactiveImageCap = "dailyProactiveImageCap"
    }
}

public struct CompanionStateSummary: Equatable, Codable {
    public let lastUserInteractionAt: String?
    public let lastProactiveAt: String?
    public let consecutiveUnansweredProactive: Int
    public let pendingFollowups: Int
    public let quietHoursNow: Bool

    enum CodingKeys: String, CodingKey {
        case lastUserInteractionAt = "lastUserInteractionAt"
        case lastProactiveAt = "lastProactiveAt"
        case consecutiveUnansweredProactive = "consecutiveUnansweredProactive"
        case pendingFollowups = "pendingFollowups"
        case quietHoursNow = "quiet_hours_now"
    }
}

// MARK: - Suzu Fusion product surfaces

public struct SchedulerPlan: Equatable, Codable, Identifiable {
    public struct Schedule: Equatable, Codable {
        public let type: String
        public let at: String?
        public let expression: String?
        public let timeZone: String
        public init(type: String, at: String? = nil, expression: String? = nil, timeZone: String) {
            self.type = type; self.at = at; self.expression = expression; self.timeZone = timeZone
        }
    }
    public struct Target: Equatable, Codable {
        public let type: String
        public let operation: String?
        public let content: String
        public let importance: Double?
        public init(type: String, operation: String? = nil, content: String, importance: Double? = nil) {
            self.type = type; self.operation = operation; self.content = content; self.importance = importance
        }
    }
    public let id: String
    public let title: String
    public let schedule: Schedule
    public let target: Target
    public let enabled: Bool
    public let nextRunAt: String?
    public let lastRunAt: String?
    public let createdAt: String
    public let updatedAt: String
}

public struct SchedulerExecution: Equatable, Codable, Identifiable {
    public struct Transition: Equatable, Codable {
        public let status: String
        public let at: String
    }
    public let id: String
    public let planId: String
    public let planTitle: String
    public let scheduledFor: String
    public let status: String
    public let createdAt: String
    public let startedAt: String?
    public let finishedAt: String?
    public let error: String?
    public let transitions: [Transition]
}

public struct SchedulerSnapshot: Equatable, Codable {
    public let generatedAt: String
    public let plans: [SchedulerPlan]
    public let history: [SchedulerExecution]
}

public struct SchedulerPlanDraft: Equatable, Codable {
    public let title: String
    public let schedule: SchedulerPlan.Schedule
    public let target: SchedulerPlan.Target
    public let enabled: Bool
    public init(title: String, schedule: SchedulerPlan.Schedule, target: SchedulerPlan.Target, enabled: Bool = true) {
        self.title = title; self.schedule = schedule; self.target = target; self.enabled = enabled
    }
}

public struct CapabilityProductSnapshot: Equatable, Codable {
    public struct Item: Equatable, Codable, Identifiable {
        public let id: String
        public let name: String
        public let wireName: String
        public let description: String
        public let category: String
        public let enabled: Bool
        public let configured: Bool
        public let scope: [String]
        public let provider: String
        public let permission: [String]
        public let riskLevel: String
        public let health: String
        public let lastStatus: String?
        public let requiresApproval: Bool
        public let installable: Bool?
        public let installed: Bool?
        public let status: String?
        public let sourceUrl: String?
        public let version: String?
        public let upstreamCommit: String?
        public let license: String?
        public let installTime: String?
        public let installPath: String?
        public let adapterVersion: String?
        public let lastTest: String?
        public let macOSPermissions: [String]?
    }
    public let generatedAt: String
    public let source: String
    public let data: [Item]
}

public struct LocalRuntimeControlsSnapshot: Equatable, Codable {
    public let version: Int
    public let enabled: [String: Bool]
    public let hardSafetyBoundary: String
    public let updatedAt: String?
    enum CodingKeys: String, CodingKey {
        case version, enabled
        case hardSafetyBoundary = "hard_safety_boundary"
        case updatedAt = "updated_at"
    }
}

public struct ComputerUseManagedStatus: Equatable, Codable {
    public let id: String
    public let name: String?
    public let known: Bool
    public let installed: Bool
    public let enabled: Bool
    public let configured: Bool?
    public let health: String
    public let lastError: String?
    public let lastTest: String?
    public let installTime: String?
    public let installPath: String?
    public let adapterVersion: String?
    public let version: String?
    public let source: String?
    public let sourceUrl: String?
    public let upstreamCommit: String?
    public let license: String?
    public let permissions: [String]?
    public let macOSPermissions: [String]?
    enum CodingKeys: String, CodingKey {
        case id, name, known, installed, enabled, configured, health, version, source, license, permissions
        case lastError, lastTest, installTime, installPath, adapterVersion, sourceUrl, upstreamCommit, macOSPermissions
    }
}

public struct ComputerUseStatusResponse: Equatable, Codable {
    public let status: ComputerUseManagedStatus
    public let permissionSession: SessionPermissionSnapshot
}

public struct CapabilityOperationResponse: Equatable, Codable {
    public let ok: Bool
    public let status: String?
    public let request: SessionPermissionRequest?
    public let permissionSession: SessionPermissionSnapshot?
}

public struct UsageLedgerSnapshot: Equatable, Codable {
    public struct Metric: Equatable, Codable {
        public let requests: Int
        public let inputTokens: Int?
        public let cachedInputTokens: Int?
        public let reasoningTokens: Int?
        public let outputTokens: Int?
        public let costUsd: Double?
        public let unknownUsage: Int
        public let unpriced: Int
    }
    public struct Breakdown: Equatable, Codable, Identifiable {
        public var id: String { key }
        public let key: String
        public let requests: Int
        public let inputTokens: Int?
        public let cachedInputTokens: Int?
        public let reasoningTokens: Int?
        public let outputTokens: Int?
        public let costUsd: Double?
        public let unknownUsage: Int
        public let unpriced: Int
    }
    public struct Invocation: Equatable, Codable, Identifiable {
        public let id: String
        public let timestamp: String
        public let provider: String
        public let model: String
        public let publicModel: String
        public let feature: String
        public let source: String
        public let session: String?
        public let requestCount: Int
        public let inputTokens: Int?
        public let cachedInputTokens: Int?
        public let reasoningTokens: Int?
        public let outputTokens: Int?
        public let usageSource: String
        public let costUsd: Double?
        public let costStatus: String
        public let priceRevisionId: String?
    }
    public struct PriceRevision: Equatable, Codable, Identifiable {
        public let id: String
        public let provider: String
        public let model: String
        public let inputPerMillion: Double
        public let cachedInputPerMillion: Double?
        public let outputPerMillion: Double
        public let reasoningPerMillion: Double?
        public let effectiveFrom: String
        public let createdAt: String
    }
    public let generatedAt: String
    public let ledgerFormat: String
    public let summaryFormat: String
    public let today: Metric
    public let month: Metric
    public let providers: [Breakdown]
    public let models: [Breakdown]
    public let features: [Breakdown]
    public let recent: [Invocation]
    public let prices: [PriceRevision]
}

public struct UsagePriceDraft: Encodable {
    public let provider: String
    public let model: String
    public let inputPerMillion: Double
    public let cachedInputPerMillion: Double?
    public let outputPerMillion: Double
    public let reasoningPerMillion: Double?
    public let effectiveFrom: String
    public init(provider: String, model: String, inputPerMillion: Double, cachedInputPerMillion: Double?, outputPerMillion: Double, reasoningPerMillion: Double?, effectiveFrom: String) {
        self.provider = provider; self.model = model; self.inputPerMillion = inputPerMillion; self.cachedInputPerMillion = cachedInputPerMillion; self.outputPerMillion = outputPerMillion; self.reasoningPerMillion = reasoningPerMillion; self.effectiveFrom = effectiveFrom
    }
}

public struct GuidanceQueueSnapshot: Equatable, Codable {
    public struct Item: Equatable, Codable, Identifiable {
        public let id: String
        public let sessionId: String
        public let content: String
        public let status: String
        public let sequence: Int
        public let createdAt: String
        public let consumedAt: String?
        public let cancelledAt: String?
    }
    public let generatedAt: String
    public let sessionId: String
    public let clearRule: String
    public let data: [Item]
}

public struct MemoryBrainResponse: Equatable, Codable {
    public struct Evidence: Equatable, Codable, Identifiable {
        public var id: String { "\(source):\(recordedAt ?? "")" }
        public let source: String
        public let mode: String
        public let recordedAt: String?
    }
    public struct Node: Equatable, Codable, Identifiable {
        public struct Layout: Equatable, Codable {
            public let angle: Double
            public let radius: Double
            public let depth: Double
        }
        public let id: String
        public let title: String
        public let content: String
        public let preview: String
        public let kind: String
        public let stateFamily: String
        public let representationLayer: String
        public let temporalState: String
        public let evidenceMode: String
        public let source: String
        public let status: String
        public let importance: Double
        public let pinned: Bool
        public let createdAt: String?
        public let updatedAt: String?
        public let visualTier: String
        public let visualFamily: String
        public let layout: Layout
        public let evidence: [Evidence]
        public let relatedMemoryIds: [String]
    }
    public struct Edge: Equatable, Codable, Identifiable {
        public let id: String
        public let source: String
        public let target: String
        public let relation: String?
        public let weight: Double?
    }
    public struct Disclosure: Equatable, Codable {
        public let inferredEdges: Bool
        public let note: String
    }
    public struct Search: Equatable, Codable {
        public let query: String
        public let resultIds: [String]
    }
    public let engine: String
    public let nodes: [Node]
    public let edges: [Edge]
    public let search: Search
    public let disclosure: Disclosure
}

public struct MemoryRecallPreview: Equatable, Codable {
    public struct Row: Equatable, Codable, Identifiable {
        public let id: String
        public let content: String
        public let type: String
        public let source: String
        public let finalScore: Double
        public let inContext: Bool
        public let reasons: [String]
        enum CodingKeys: String, CodingKey {
            case id, content, type, source, reasons
            case finalScore = "final_score"
            case inContext = "in_context"
        }
    }
    public let query: String
    public let data: [Row]
}

public struct ManualMemoryMatch: Equatable, Codable, Identifiable {
    public let id: String
    public let content: String
    public let type: String
    public let status: String
    public let source: String
    public let updatedAt: String?
    enum CodingKeys: String, CodingKey { case id, content, type, status, source; case updatedAt = "updated_at" }
}

public struct ManualMemoryAssessment: Equatable, Codable {
    public let disposition: String
    public let reason: String?
    public let duplicate: ManualMemoryMatch?
    public let possibleConflicts: [ManualMemoryMatch]
}

public struct ManualMemoryDraft: Equatable, Codable {
    public var content: String
    public var type: String
    public var temporalState: String
    public var importance: Double
    public init(content: String = "", type: String = "fact", temporalState: String = "current", importance: Double = 0.8) {
        self.content = content; self.type = type; self.temporalState = temporalState; self.importance = importance
    }
    enum CodingKeys: String, CodingKey { case content, type, importance; case temporalState = "temporal_state" }
}

public struct ManualMemoryMutation: Equatable, Codable {
    public struct StoredMemory: Equatable, Codable, Identifiable {
        public let id: String
        public let content: String
        public let type: String
        public let status: String
        public let source: String
        public let temporalState: String
        public let evidenceMode: String
        enum CodingKeys: String, CodingKey { case id, content, type, status, source; case temporalState = "temporal_state"; case evidenceMode = "evidence_mode" }
    }
    public let ok: Bool
    public let created: Bool
    public let outcome: String
    public let memory: StoredMemory?
}

public struct ProductEvent: Equatable, Codable, Identifiable {
    public let id: String
    public let source: String
    public let content: String
    public let importance: Double
    public let createdAt: String
}

public struct TodaySnapshot: Equatable, Codable {
    public struct Plans: Equatable, Codable {
        public let available: Bool
        public let upcoming: [SchedulerPlan]
    }
    public struct Proactive: Equatable, Codable {
        public let allowed: Bool
        public let reasons: [String]
        public let level: String
        public let messagesToday: Int
        public let dailyCap: Int
        public let pendingFollowups: Int
        public let lastProactiveAt: String?
        public let quietHoursNow: Bool
    }
    public struct Usage: Equatable, Codable {
        public let requests: Int
        public let inputTokens: Int?
        public let outputTokens: Int?
        public let cachedTokens: Int?
        public let totalTokens: Int?
        public let unknownTokenRequests: Int
    }
    public struct AgentActivity: Equatable, Codable, Identifiable {
        public let id: String
        public let source: String
        public let updatedAt: String
        public let messageCount: Int
    }
    public struct Attention: Equatable, Codable {
        public struct Item: Equatable, Codable, Identifiable {
            public let id: String
            public let type: String
            public let title: String
            public let summary: String
            public let status: String
            public let destination: String?
            public let createdAt: String
            enum CodingKeys: String, CodingKey {
                case id, type, title, summary, status, destination
                case createdAt = "created_at"
            }
        }
        public let unread: Int
        public let items: [Item]
    }
    public struct Diary: Equatable, Codable {
        public struct Entry: Equatable, Codable, Identifiable {
            public var id: String { dateLocal }
            public let dateLocal: String
            public let body: String
            public let summary: String?
            public let reflection: String?
            public let messageToUser: String?
            public let createdAt: String?
            public let userMessageCount: Int?
            public let assistantMessageCount: Int?
        }
        public struct Recent: Equatable, Codable, Identifiable {
            public var id: String { dateLocal }
            public let dateLocal: String
            public let summary: String
            public let createdAt: String?
            public let userMessageCount: Int?
        }
        public let available: Bool
        public let selectedDate: String
        public let entry: Entry?
        public let recent: [Recent]
        public let previousDate: String?
        public let nextDate: String?
    }
    public let generatedAt: String
    public let events: [ProductEvent]
    public let plans: Plans
    public let proactive: Proactive
    public let usage: Usage
    public let recentAgentActivity: [AgentActivity]
    public let attention: Attention?
    public let diary: Diary?
}

public struct RelationshipSnapshot: Equatable, Codable {
    public struct Persona: Equatable, Codable {
        public struct SpeakingStyle: Equatable, Codable {
            public let tone: String
            public let verbosity: String
            public let emojiFrequency: String
            public let rules: [String]
        }
        public let id: String
        public let name: String
        public let coreIdentity: String
        public let personality: [String]
        public let speakingStyle: SpeakingStyle
        public let memoryEnabled: Bool
    }
    public struct MemoryOverview: Equatable, Codable {
        public struct Recent: Equatable, Codable, Identifiable {
            public let id: String
            public let content: String
            public let type: String
            public let status: String
            public let source: String
            public let updatedAt: String
        }
        public let total: Int
        public let active: Int
        public let staging: Int
        public let historical: Int
        public let types: [String: Int]
        public let recent: [Recent]
    }
    public struct Journal: Equatable, Codable {
        public let available: Bool
        public let entries: [JSONValue]
    }
    public let generatedAt: String
    public let persona: Persona?
    public let memoryOverview: MemoryOverview
    public let contextSummary: String?
    public let contextUpdatedAt: String?
    public let importantEvents: [ProductEvent]
    public let journal: Journal
}

public struct TTSProviderCatalog: Equatable, Codable {
    public struct Provider: Equatable, Codable, Identifiable {
        public var id: String { self.providerId }
        public let providerId: String
        public let name: String
        public let available: Bool
        /// true when engine process is currently up (GPT). nil for worker-style providers.
        public let loaded: Bool?
        public let state: String?
        public let detail: String?
        public let supportsStyle: Bool?
        enum CodingKeys: String, CodingKey {
            case providerId = "id"
            case name, available, loaded, state, detail, supportsStyle
        }
    }
    public let selected: String
    public let providers: [Provider]
}

extension String {
    /// UTC ISO8601 → Companion authoritative Beijing time（仅 presentation；存储仍为 UTC）
    public static func localTime(from iso8601: String) -> String {
        CompanionTime.shortTime(fromISO8601: iso8601)
    }
}
