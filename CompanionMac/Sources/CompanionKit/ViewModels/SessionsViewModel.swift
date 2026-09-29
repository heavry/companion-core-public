import Foundation
import Combine

/// 会话列表 + 当前会话消息视图模型（Unified Conversation Center 的 Mac 端）。
@MainActor
public final class SessionsViewModel: ObservableObject {
    public enum GuidanceEnqueueResult: Equatable { case queued, noActiveTurn, failed }
    public struct FailedSend: Equatable {
        public let text: String
        public let messageID: Int
        public let attachments: [MediaUploadResponse]
        public let webEnabled: Bool
    }

    @Published public private(set) var conversations: [Conversation] = []
    @Published public private(set) var filterCategory: String? = nil   // nil=全部
    @Published public private(set) var messages: [ConversationMessagesResponse.Row] = []
    @Published public private(set) var currentConversationID: String?
    @Published public private(set) var isLoading = false
    @Published public private(set) var isSending = false
    @Published public private(set) var failedSend: FailedSend?
    @Published public private(set) var webEnabled: Bool
    @Published public private(set) var webSearchConfigured = false
    @Published public private(set) var webSearchProvider: String?
    @Published public private(set) var webSearchReason = "未配置联网搜索"
    @Published public private(set) var guidanceItems: [GuidanceQueueSnapshot.Item] = []
    @Published public private(set) var permissionSnapshot: SessionPermissionSnapshot?
    @Published public private(set) var lastVoiceDelivery: VoiceDeliveryDecision?
    @Published public var errorText: String?

    private let api: APIClient
    private let preferredSource: String?
    private let defaults: UserDefaults
    private let webPreferenceKey: String
    private var nextOptimisticID = -1
    private var permissionEpoch = 0
    private var sendCompletionWaiters: [CheckedContinuation<Void, Never>] = []
    private var reloadEpoch = 0
    private var reloadInFlight: Task<Void, Never>? = nil
    private var reloadQueued = false
    /// Optimistic assistant IDs created during the current stream, for reload merge.
    private var streamingOptimisticAssistantIDs: [Int] = []
    /// Exact optimistic bubble -> durable DB row identity learned from SSE metadata.
    private var streamingDurableMessageIDs: [Int: Int] = [:]

    private func bubbleTrace(_ fields: [String: Any]) {
        guard ProcessInfo.processInfo.environment["COMPANION_BUBBLE_TRACE_DEBUG"] == "1",
              let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else { return }
        print("[mac] \(line)")
    }

    public init(api: APIClient, preferredSource: String? = nil, defaults: UserDefaults = .standard) {
        self.api = api
        self.preferredSource = preferredSource
        self.defaults = defaults
        self.webPreferenceKey = "Companion.webEnabled.\(api.config.baseURL.absoluteString).\(preferredSource ?? "all")"
        self.webEnabled = defaults.bool(forKey: self.webPreferenceKey)
    }

    public func setFilter(_ category: String?) {
        filterCategory = category
        Task { await reload() }
    }

    public func loadCapabilities() async {
        do {
            let value = try await api.capabilities()
            webSearchConfigured = value.webSearch.configured
            webSearchProvider = value.webSearch.provider
            webSearchReason = value.webSearch.reason ?? (value.webSearch.configured ? "联网搜索可用" : "未配置联网搜索")
        } catch {
            webSearchConfigured = false
            webSearchProvider = nil
            webSearchReason = "未配置联网搜索"
        }
    }

    public func setWebEnabled(_ enabled: Bool) {
        webEnabled = enabled
        defaults.set(enabled, forKey: webPreferenceKey)
    }

    /// Coalesced, epoch-guarded reload. Concurrent message.created events for
    /// multi-bubble proactive turns must not let an older response overwrite
    /// a newer one (that dropped the 2nd bubble from the UI).
    public func reload() async {
        if let existing = reloadInFlight {
            reloadQueued = true
            await existing.value
            return
        }
        let task = Task { @MainActor in
            self.isLoading = true
            repeat {
                self.reloadQueued = false
                await self.performReloadPass()
            } while self.reloadQueued
            self.isLoading = false
            self.reloadInFlight = nil
        }
        reloadInFlight = task
        await task.value
    }

    private func performReloadPass() async {
        reloadEpoch += 1
        let epoch = reloadEpoch
        do {
            let all = try await self.api.conversations(source: self.preferredSource)
            if epoch != self.reloadEpoch { return }
            self.conversations = self.filterCategory.map { c in all.filter { $0.category == c } } ?? all
            let selectedId = self.selectedConversationID()
                ?? self.conversations.first(where: { $0.source == self.preferredSource && $0.externalKey == "chat:default" })?.id
                ?? (self.preferredSource == nil ? nil : self.conversations.first?.id)
            if let selectedId {
                self.storedSelection = selectedId
                self.currentConversationID = selectedId
                let resp = try await self.api.conversationMessages(id: selectedId)
                if epoch != self.reloadEpoch { return }
                let incoming = resp.data
                self.mergeIncomingMessages(incoming, reloadEpoch: epoch)
                await self.reloadGuidance()
                await self.reloadPermissions()
            } else if self.preferredSource != nil {
                self.currentConversationID = nil
                self.messages = []
                self.permissionSnapshot = nil
            }
            self.errorText = nil
        } catch {
            if epoch == self.reloadEpoch { self.errorText = String(describing: error) }
        }
    }

    public func select(_ conversation: Conversation) async {
        do {
            let resp = try await api.conversationMessages(id: conversation.id)
            currentConversationID = conversation.id
            messages = resp.data
            await reloadGuidance()
            await reloadPermissions()
        } catch {
            errorText = String(describing: error)
        }
    }

    public var queuedGuidance: [GuidanceQueueSnapshot.Item] { guidanceItems.filter { $0.status == "queued" } }

    public func reloadGuidance() async {
        guard let id = currentConversationID else { guidanceItems = []; return }
        do { guidanceItems = try await api.guidanceQueue(sessionID: id).data }
        catch { /* Queue display is additive; chat history remains usable if it is unavailable. */ }
    }

    public func reloadPermissions() async {
        guard let id = currentConversationID else { permissionSnapshot = nil; return }
        let epoch = permissionEpoch
        do {
            let value = try await api.sessionPermissions(sessionID: id)
            guard epoch == permissionEpoch, id == currentConversationID else { return }
            permissionSnapshot = value
        }
        catch { /* Permission UX is additive; sending and history remain usable. */ }
    }

    public func setPermissionMode(_ mode: SessionPermissionMode) async {
        guard let id = currentConversationID else { return }
        permissionEpoch += 1
        do { let value = try await api.setSessionPermissionMode(sessionID: id, mode: mode); permissionEpoch += 1; permissionSnapshot = value }
        catch { errorText = userFacingMessage(error) }
    }

    public func setWorkspace(path: String) async {
        permissionEpoch += 1
        do {
            let value = if let id = currentConversationID { try await api.setSessionWorkspace(sessionID: id, path: path) }
                        else { try await api.setDefaultChatWorkspace(path: path) }
            permissionEpoch += 1; currentConversationID = value.sessionId; permissionSnapshot = value
        }
        catch { errorText = userFacingMessage(error); await reloadPermissions() }
    }

    public func clearWorkspace() async {
        guard let id = currentConversationID else { return }
        permissionEpoch += 1
        do { let value = try await api.clearSessionWorkspace(sessionID: id); permissionEpoch += 1; permissionSnapshot = value }
        catch { errorText = userFacingMessage(error); await reloadPermissions() }
    }

    public func resolvePermission(_ request: SessionPermissionRequest, action: String) async {
        guard let id = currentConversationID else { return }
        permissionEpoch += 1
        do { let value = try await api.resolveSessionPermission(sessionID: id, requestID: request.requestId, action: action); permissionEpoch += 1; permissionSnapshot = value }
        catch { errorText = userFacingMessage(error); await reloadPermissions() }
    }

    public func revokePermissionGrant(_ grant: SessionPermissionGrant) async {
        guard let id = currentConversationID else { return }
        permissionEpoch += 1
        do { let value = try await api.revokeSessionPermissionGrant(sessionID: id, grantID: grant.id); permissionEpoch += 1; permissionSnapshot = value }
        catch { errorText = userFacingMessage(error); await reloadPermissions() }
    }

    public func revokeAllPermissionGrants() async {
        guard let id = currentConversationID else { return }
        permissionEpoch += 1
        do { let value = try await api.revokeAllSessionPermissionGrants(sessionID: id); permissionEpoch += 1; permissionSnapshot = value }
        catch { errorText = userFacingMessage(error); await reloadPermissions() }
    }

    @discardableResult
    public func enqueueGuidance(_ text: String) async -> Bool {
        await enqueueGuidanceResult(text) == .queued
    }

    public func enqueueGuidanceResult(_ text: String) async -> GuidanceEnqueueResult {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let id = currentConversationID, !clean.isEmpty else { return .failed }
        do { _ = try await api.enqueueGuidance(sessionID: id, content: clean); await reloadGuidance(); return .queued }
        catch {
            if isNoActiveTurn(error) { await reloadGuidance(); return .noActiveTurn }
            errorText = userFacingMessage(error); return .failed
        }
    }

    /// Used only when Core rejects a stale guidance route. Waiting on the actual
    /// in-flight send completion keeps the original text and avoids timer races
    /// with the previous turn's terminal history reload.
    public func sendAfterCurrentTurnCompletes(_ text: String) async -> Bool {
        if isSending {
            await withCheckedContinuation { continuation in
                if isSending { sendCompletionWaiters.append(continuation) }
                else { continuation.resume() }
            }
        }
        return await sendDaily(text)
    }

    public func cancelGuidance(_ item: GuidanceQueueSnapshot.Item) async {
        guard let id = currentConversationID else { return }
        do { try await api.cancelGuidance(sessionID: id, queueID: item.id); await reloadGuidance() }
        catch { errorText = userFacingMessage(error); await reloadGuidance() }
    }

    @discardableResult
    public func sendDaily(_ text: String, model: String = "yuna-chat",
                          attachments: [MediaUploadResponse] = [], webEnabled requestedWebEnabled: Bool? = nil,
                          speechContext: VoiceCallTranscription? = nil,
                          screenContext: ScreenContextResponse? = nil,
                          onDelta: (@MainActor (String) -> Void)? = nil) async -> Bool {
        let cleanText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!cleanText.isEmpty || !attachments.isEmpty), !isSending else { return false }
        let requestWebEnabled = requestedWebEnabled ?? webEnabled
        let optimisticID = nextOptimisticID
        nextOptimisticID -= 1
        let assistantID = nextOptimisticID
        nextOptimisticID -= 1
        let optimistic = ConversationMessagesResponse.Row(
            id: optimisticID, role: "user", contentText: cleanText,
            toolCallsJson: nil, toolCallId: nil,
            createdAt: ISO8601DateFormatter().string(from: Date()),
            attachments: attachments.map {
                MediaAttachment(mediaId: $0.mediaId, mime: $0.mime, path: $0.url,
                                width: $0.width, height: $0.height, bytes: $0.bytes)
            }
        )
        messages.append(optimistic)
        let firstAssistant = ConversationMessagesResponse.Row(
            id: assistantID, role: "assistant", contentText: "", toolCallsJson: nil,
            toolCallId: nil, createdAt: ISO8601DateFormatter().string(from: Date()), attachments: nil
        )
        messages.append(firstAssistant)
        streamingOptimisticAssistantIDs = [assistantID]
        streamingDurableMessageIDs = [:]
        var streamAssistantID = assistantID
        var streamBubbleIndex = 0
        isSending = true
        failedSend = nil
        errorText = nil
        lastVoiceDelivery = nil
        let requestID = UUID().uuidString.lowercased()
        defer {
            finishSending()
            streamingOptimisticAssistantIDs = []
            streamingDurableMessageIDs = [:]
        }
        do {
            var attempt = 0
            while true {
                attempt += 1
                var receivedDurableDelta = false
                do {
                    _ = try await api.streamChat(message: cleanText, model: model,
                                         attachments: attachments, webEnabled: requestWebEnabled,
                                         speechContext: speechContext,
                                         screenContext: screenContext,
                                         requestID: requestID,
                                         onVoiceDelivery: { [weak self] decision in self?.lastVoiceDelivery = decision },
                                         onDelta: { [weak self] delta in
                receivedDurableDelta = true
                self?.appendStreamingDelta(delta, messageID: streamAssistantID)
                onDelta?(delta)
            },
                                         onBubbleMeta: { [weak self] bubbleIndex, bubbleCount, durableMessageID in
                guard let self else { return }
                // New bubble boundary → close previous optimistic bubble, open a new one.
                if bubbleIndex > streamBubbleIndex {
                    let newID = self.nextOptimisticID
                    self.nextOptimisticID -= 1
                    self.messages.append(ConversationMessagesResponse.Row(
                        id: newID, role: "assistant", contentText: "", toolCallsJson: nil,
                        toolCallId: nil, createdAt: ISO8601DateFormatter().string(from: Date()), attachments: nil
                    ))
                    self.streamingOptimisticAssistantIDs.append(newID)
                    streamAssistantID = newID
                    streamBubbleIndex = bubbleIndex
                }
                if let durableMessageID {
                    self.streamingDurableMessageIDs[streamAssistantID] = durableMessageID
                }
                self.bubbleTrace([
                    "optimistic_bubble": streamAssistantID,
                    "durable_message_id": durableMessageID.map { $0 as Any } ?? NSNull(),
                    "bubble_index": bubbleIndex,
                    "bubble_count": bubbleCount
                ])
            })
                    break
                } catch {
                    // Core emits visible text only after the corresponding durable
                    // bubble exists. If any text arrived, DB catch-up is safer than
                    // replaying generation. Before the first durable delta, retry the
                    // same idempotent request within a short bounded window.
                    if receivedDurableDelta {
                        await reload()
                        return true
                    }
                    guard attempt < 3, isRetryableSendError(error) else { throw error }
                    let delay: UInt64 = attempt == 1 ? 400_000_000 : 1_000_000_000
                    try? await Task.sleep(nanoseconds: delay)
                }
            }
            await reload()
            return true
        } catch {
            let message = userFacingMessage(error)
            failedSend = FailedSend(text: cleanText, messageID: optimisticID,
                                    attachments: attachments, webEnabled: requestWebEnabled)
            await reload()
            errorText = message
            let uploadedIDs = Set(attachments.map(\.mediaId))
            if !messages.contains(where: {
                $0.role == "user" && $0.contentText == cleanText
                    && uploadedIDs.isSubset(of: Set(($0.attachments ?? []).compactMap(\.mediaId)))
            }) {
                messages.append(optimistic)
            }
            return false
        }
    }

    private func appendStreamingDelta(_ delta: String, messageID: Int) {
        guard let index = messages.firstIndex(where: { $0.id == messageID }) else { return }
        let row = messages[index]
        messages[index] = ConversationMessagesResponse.Row(
            id: row.id, role: row.role, contentText: (row.contentText ?? "") + delta,
            toolCallsJson: row.toolCallsJson, toolCallId: row.toolCallId,
            createdAt: row.createdAt, attachments: row.attachments,
            webSources: row.webSources, toolActivities: row.toolActivities,
            voiceAsset: row.voiceAsset, voicePlan: row.voicePlan, bubbleIndex: row.bubbleIndex,
            bubbleCount: row.bubbleCount, bubbleTurnId: row.bubbleTurnId,
            generationRoute: row.generationRoute
        )
    }

    /// Merge durable history without flicker/duplicates:
    /// - keep optimistic rows not yet in DB
    /// - drop optimistic assistants that this stream already flushed to DB
    /// - drop empty optimistic assistant shells once any durable assistant exists
    private func mergeIncomingMessages(_ incoming: [ConversationMessagesResponse.Row], reloadEpoch: Int) {
        let incomingIds = Set(incoming.map(\.id))
        let streamedIDs = Set(streamingOptimisticAssistantIDs)
        let replacedOptimisticIDs = Set(streamingDurableMessageIDs.compactMap { optimisticID, durableID in
            incomingIds.contains(durableID) ? optimisticID : nil
        })
        var extras = self.messages.filter { !incomingIds.contains($0.id) }
        // Replace only the optimistic bubble whose exact durable row is present.
        // A snapshot containing bubble 0 must not erase bubble 1's in-flight shell.
        extras = extras.filter { !replacedOptimisticIDs.contains($0.id) }
        // Empty optimistic assistant placeholders should not survive a durable reply.
        extras = extras.filter { extra in
            guard extra.id < 0, extra.role == "assistant", (extra.contentText ?? "").isEmpty else { return true }
            if streamedIDs.contains(extra.id),
               streamingDurableMessageIDs[extra.id] != nil,
               !replacedOptimisticIDs.contains(extra.id) { return true }
            return !incoming.contains(where: { $0.role == "assistant" })
        }
        // If durable copy already has this optimistic text, keep only the durable row.
        extras = extras.filter { extra in
            guard extra.id < 0 else { return true }
            if streamedIDs.contains(extra.id), streamingDurableMessageIDs[extra.id] != nil { return true }
            let text = extra.contentText ?? ""
            guard !text.isEmpty else { return true }
            return !incoming.contains { $0.role == extra.role && ($0.contentText ?? "") == text }
        }
        self.messages = extras.isEmpty ? incoming : (incoming + extras).sorted { $0.id < $1.id }
        for optimisticID in replacedOptimisticIDs {
            streamingDurableMessageIDs.removeValue(forKey: optimisticID)
        }
        streamingOptimisticAssistantIDs.removeAll { replacedOptimisticIDs.contains($0) }
        bubbleTrace([
            "reload_epoch": reloadEpoch,
            "merge_result": self.messages.count,
            "incoming_durable_count": incoming.count,
            "replaced_optimistic_count": replacedOptimisticIDs.count,
            "remaining_optimistic_count": streamingOptimisticAssistantIDs.count
        ])
    }

    @discardableResult
    public func retryFailedSend(model: String = "yuna-chat") async -> Bool {
        guard let failedSend else { return false }
        messages.removeAll { $0.id == failedSend.messageID }
        return await sendDaily(failedSend.text, model: model,
                               attachments: failedSend.attachments, webEnabled: failedSend.webEnabled)
    }

    private func userFacingMessage(_ error: Error) -> String {
        if case APIError.http(let status, let body) = error {
            if let data = body.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let payload = json["error"] as? [String: Any],
               let message = payload["message"] as? String, !message.isEmpty {
                return message
            }
            let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, trimmed != "stream request failed", trimmed != "no response" {
                return trimmed.count > 180 ? String(trimmed.prefix(180)) + "…" : trimmed
            }
            switch status {
            case 429: return "发送失败：上游并发/限流，请稍后重试。"
            case 502, 503, 504: return "发送失败：上游暂时不可用（可能是冷启动后账号池尚未就绪），请稍后重试。"
            case 401, 403: return "发送失败：鉴权失败，请检查 Companion Core / 上游配置。"
            default: break
            }
        }
        if let url = error as? URLError {
            return "发送失败（\(url.code.rawValue)）：网络或 Companion Core 连接异常。"
        }
        return "发送失败，请检查 Companion Core 连接后重试。"
    }

    private func isRetryableSendError(_ error: Error) -> Bool {
        if let url = error as? URLError {
            return [.timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost,
                    .dnsLookupFailed, .notConnectedToInternet, .resourceUnavailable].contains(url.code)
        }
        if case APIError.http(let status, _) = error {
            return [408, 425, 429, 500, 502, 503, 504].contains(status)
        }
        return false
    }

    private func isNoActiveTurn(_ error: Error) -> Bool {
        guard case APIError.http(409, let body) = error,
              let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let payload = json["error"] as? [String: Any]
        else { return false }
        return payload["code"] as? String == "no_active_turn"
    }

    private func finishSending() {
        isSending = false
        let waiters = sendCompletionWaiters
        sendCompletionWaiters.removeAll(keepingCapacity: true)
        waiters.forEach { $0.resume() }
    }

    private var storedSelection: String?
    public func setSelectedConversation(_ id: String?) { storedSelection = id }
    private func selectedConversationID() -> String? { storedSelection }
}
