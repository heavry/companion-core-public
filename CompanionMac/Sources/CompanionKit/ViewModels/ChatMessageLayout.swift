import Foundation

/// 聊天消息行布局的纯逻辑（无 UI 依赖，便于测试）。
/// Assistant 固定左侧 + 头像；User 固定右侧；气泡宽度按内容自然增长、
/// 上限为聊天内容区宽度的约 62%（短消息只包住文字）。
public enum ChatMessageLayout {
    public static let userBubbleWidthRatio: CGFloat = 0.60
    public static let userBubbleAbsoluteCap: CGFloat = 540
    public static let assistantBubbleWidthRatio: CGFloat = 0.65
    public static let assistantBubbleAbsoluteCap: CGFloat = 600
    public static let sameSpeakerSpacing: CGFloat = 5
    public static let speakerSwitchSpacing: CGFloat = 16

    public struct Alignment {
        public let isUser: Bool
        public var leading: Bool { !isUser }
        public var trailing: Bool { isUser }
    }

    public static func alignment(forRole role: String) -> Alignment {
        Alignment(isUser: role == "user")
    }

    /// 气泡最大宽度：随窗口响应式，短消息不会被撑满（宽度本身由内容 hug，上限只约束换行点）。
    public static func bubbleMaxWidth(containerWidth: CGFloat, isUser: Bool) -> CGFloat {
        min(containerWidth * (isUser ? userBubbleWidthRatio : assistantBubbleWidthRatio),
            isUser ? userBubbleAbsoluteCap : assistantBubbleAbsoluteCap)
    }

    /// 同一说话者连续消息间距小，角色切换间距大。
    public static func spacing(after previousRole: String?, before currentRole: String) -> CGFloat {
        guard let previousRole else { return 0 }
        return previousRole == currentRole ? sameSpeakerSpacing : speakerSwitchSpacing
    }

    /// Content growth moves the bottom marker without a user scroll. Preserve
    /// the prior follow decision until the content's top actually moves.
    public static func followLatest(previousTop: CGFloat?, currentTop: CGFloat,
                                    contentBottom: CGFloat, viewportHeight: CGFloat,
                                    wasFollowing: Bool) -> Bool {
        guard let previousTop, abs(currentTop - previousTop) > 1 else { return wasFollowing }
        return contentBottom <= viewportHeight + 160
    }

    /// 展示层过滤：tool 结果行不作为聊天气泡渲染（搜索结果以 Sources 呈现）。
    public static func displayableRows(_ rows: [ConversationMessagesResponse.Row]) -> [ConversationMessagesResponse.Row] {
        rows.filter { $0.role == "user" || $0.role == "assistant" }
    }
}

/// Composer Return 键分流（纯逻辑，可单测；UI 层据此执行发送/换行/忽略）。
/// IME 安全：marked text（中文/日文输入法组合中）期间 Return 永远不触发发送。
public enum ComposerKeyDecision: Equatable {
    case send
    case newline
    case ignore

    public static func resolve(shift: Bool, hasMarkedText: Bool, canSend: Bool) -> ComposerKeyDecision {
        if shift { return .newline }
        if hasMarkedText { return .ignore } // IME composition 确认
        return canSend ? .send : .ignore
    }
}
