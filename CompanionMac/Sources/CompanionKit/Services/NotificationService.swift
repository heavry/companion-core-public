import Foundation

#if canImport(UserNotifications)
import UserNotifications
import AppKit

/// macOS 系统通知：仅用于 proactive.created 等主动消息；
/// 内容为已脱敏的预览文本（Core 侧保证不含密钥/工具输出/内部 prompt）。
public final class NotificationService {
    public static let shared = NotificationService()
    private var authorized = false
    private var seenMessageIds: Set<String> = []
    private var currentlyViewingConversationId: String?

    private init() {
        let defaults = UserDefaults.standard
        seenMessageIds = Set(defaults.stringArray(forKey: "notification.seenMessageIds") ?? [])
    }

    /// 当前正在查看的会话：该会话的事件只更新 UI，不弹系统通知
    public func setCurrentlyViewing(conversationId: String?) {
        currentlyViewingConversationId = conversationId
    }

    /// 同一 messageId 只通知一次（跨重启持久化）
    public func shouldNotify(messageKey: String, conversationId: String?) -> Bool {
        if seenMessageIds.contains(messageKey) { return false }
        if let viewing = currentlyViewingConversationId, viewing == conversationId { return false }
        seenMessageIds.insert(messageKey)
        if seenMessageIds.count > 200 {
            let trimmed = Array(seenMessageIds.suffix(100))
            seenMessageIds = Set(trimmed)
            UserDefaults.standard.set(trimmed, forKey: "notification.seenMessageIds")
        } else {
            UserDefaults.standard.set(Array(seenMessageIds), forKey: "notification.seenMessageIds")
        }
        return true
    }

    public var seenCount: Int { seenMessageIds.count }
    public func isViewing(_ conversationId: String?) -> Bool {
        guard let c = conversationId else { return false }
        return currentlyViewingConversationId == c
    }

    public func requestAuthorizationIfNeeded() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            DispatchQueue.main.async { self.authorized = granted }
        }
    }

    public enum PermissionStatus: String { case notRequested, denied, authorized }

    public struct Payload: Equatable {
        public var title: String
        public var body: String
        public var messageKey: String
        public var conversationId: String?
        public var destination: String
        public var attentionId: String?
        public var preview: NotificationPreviewMode
        public var playSound: Bool
        public init(title: String, body: String, messageKey: String, conversationId: String? = nil, destination: String = "chat", attentionId: String? = nil, preview: NotificationPreviewMode = .summary, playSound: Bool = true) {
            self.title = title; self.body = body; self.messageKey = messageKey
            self.conversationId = conversationId; self.destination = destination
            self.attentionId = attentionId; self.preview = preview; self.playSound = playSound
        }
    }

    public static func privacyCopy(title: String, body: String, preview: NotificationPreviewMode) -> (String, String) {
        switch preview {
        case .privatePreview: return ("林小糖", "有一条新消息。")
        case .summary: return (String(title.prefix(60)), String(body.prefix(80)))
        case .full: return (String(title.prefix(60)), String(body.prefix(180)))
        }
    }

    public var permissionStatus: PermissionStatus { authorized ? .authorized : .notRequested }

    public func registerSafeCategories() {
        let open = UNNotificationAction(identifier: "OPEN", title: "打开", options: [.foreground])
        let snooze = UNNotificationAction(identifier: "SNOOZE", title: "稍后提醒", options: [])
        let dismiss = UNNotificationAction(identifier: "DISMISS", title: "忽略", options: [.destructive])
        let category = UNNotificationCategory(identifier: "COMPANION_ATTENTION", actions: [open, snooze, dismiss], intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    /// Safe actions only: open / snooze / dismiss. Never approve or run tools.
    public static func isUnsafeNotificationAction(_ identifier: String) -> Bool {
        ["ALLOW", "APPROVE", "RUN", "CLICK", "SHELL"].contains(identifier.uppercased())
    }

    /// appActive=false 且前台不显示时由系统决定；这里显式跳过前台场景。
    public func postProactive(title: String, body: String, messageKey: String, conversationId: String?) {
        post(Payload(title: title, body: body, messageKey: messageKey, conversationId: conversationId, destination: "chat"))
    }

    public func post(_ payload: Payload, appActive: Bool? = nil) {
        #if canImport(AppKit)
        let active = appActive ?? NSApp?.isActive ?? false
        if active { return }
        #else
        if appActive == true { return }
        #endif
        guard shouldNotify(messageKey: payload.messageKey, conversationId: payload.conversationId) else { return }
        guard authorized else { return }
        let copy = Self.privacyCopy(title: payload.title, body: payload.body, preview: payload.preview)
        let content = UNMutableNotificationContent()
        content.title = copy.0
        content.body = copy.1
        content.sound = payload.playSound ? .default : nil
        content.categoryIdentifier = "COMPANION_ATTENTION"
        content.userInfo = [
            "conversationId": payload.conversationId ?? "",
            "destination": payload.destination,
            "attentionId": payload.attentionId ?? "",
            "messageKey": payload.messageKey
        ]
        let request = UNNotificationRequest(identifier: payload.messageKey, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
#else
public final class NotificationService {
    public static let shared = NotificationService()
    public func requestAuthorizationIfNeeded() {}
    public func postProactive(title: String, body: String, conversationId: String?) {}
}
#endif
