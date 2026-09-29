import Foundation

/// 未读主动消息补偿（delivery catch-up）：
/// Mac App 离线期间 Core 已把 proactive 消息写入 Conversation；
/// 启动/重连时按 lastReadAt 拉取并标记未读 —— 只读既有消息，绝不重新生成。
@MainActor
public final class ProactiveCatchUpService: ObservableObject {
    @Published public private(set) var unread: [ConversationMessagesResponse.Row] = []

    private let api: APIClient
    private let defaults: UserDefaults

    public init(api: APIClient, defaults: UserDefaults = .standard) {
        self.api = api
        self.defaults = defaults
    }

    var lastReadAt: Date? {
        get {
            defaults.object(forKey: "proactive.lastReadAt") as? Date
        }
        set { defaults.set(newValue, forKey: "proactive.lastReadAt") }
    }

    /// Pull unread assistant messages from the live chat:default turn
    /// (proactive bubbles now land there) and any legacy proactive session.
    public func refresh() async {
        guard let conversations = try? await api.conversations() else { return }
        var candidates: [ConversationMessagesResponse.Row] = []
        let since = lastReadAt
        func collect(_ rows: [ConversationMessagesResponse.Row]) {
            let fresh = rows.filter { row in
                guard row.role == "assistant" else { return false }
                if since == nil { return true }
                guard let at = row.createdAt.flatMap(String.dateFromISO8601) else { return true }
                return at > since!
            }
            candidates.append(contentsOf: fresh)
        }
        // Primary: chat:default (source=chat) — proactive multi-bubbles live here.
        if let daily = conversations.first(where: { $0.source == "chat" && $0.externalKey == "chat:default" })
            ?? conversations.first(where: { $0.category == "daily" }) {
            if let resp = try? await api.conversationMessages(id: daily.id, limit: 200) { collect(resp.data) }
        }
        // Legacy: standalone proactive session
        if let proactive = conversations.first(where: { $0.category == "proactive" }) {
            if let resp = try? await api.conversationMessages(id: proactive.id, limit: 200) { collect(resp.data) }
        }
        unread = candidates.sorted { ($0.createdAt ?? "") < ($1.createdAt ?? "") }
    }

    /// 用户查看主动消息会话 → 清零未读并推进已读水位
    public func markAllRead(now: Date = Date()) {
        lastReadAt = now
        unread = []
    }
}

extension Optional where Wrapped == String {
    fileprivate var isNilMeansNeverRead: Bool { self == nil }
}
