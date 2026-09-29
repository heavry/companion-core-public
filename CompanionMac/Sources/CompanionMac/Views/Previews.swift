import SwiftUI
import CompanionKit

// MARK: - Mock 数据（仅 Preview 使用；不触碰真实 Core / 数据库）

private enum Mock {
    static let conversations: [Conversation] = [
        Conversation(id: "c-daily", source: "kelivo", externalKey: "daily-main", category: "daily",
                     displayName: "Kelivo · daily-main", lastActivity: "2026-08-25T09:00:00Z",
                     messageCount: 42, recentMessage: "晚上可能有雨，记得带伞", archived: false),
        Conversation(id: "c-agent", source: "opencode", externalKey: "project-companion-core-ab12cd34",
                     category: "agents", displayName: "OpenCode · companion-core",
                     lastActivity: "2026-08-25T08:30:00Z", messageCount: 128,
                     recentMessage: "npm test 通过", archived: false)
    ]
    static var userRow: ConversationMessagesResponse.Row {
        ConversationMessagesResponse.Row(id: 1, role: "user", contentText: "明天要测试新版吗？",
                                         toolCallsJson: nil, toolCallId: nil,
                                         createdAt: "2026-08-25T09:01:00Z", attachments: [])
    }
    static var assistantRow: ConversationMessagesResponse.Row {
        ConversationMessagesResponse.Row(id: 2, role: "assistant",
                                         contentText: "是的！**测试计划**已经准备好：\n- 跑 `swift test`\n- 检查回归",
                                         toolCallsJson: nil, toolCallId: nil,
                                         createdAt: "2026-08-25T09:02:00Z", attachments: [])
    }
}

// MARK: - 预览容器（注入 mock 状态）

#Preview("Chat") {
    VStack(spacing: DS.Space.l) {
        MessageBubble(row: Mock.userRow, imageCache: .constant([:]))
        MessageBubble(row: Mock.assistantRow, imageCache: .constant([:]))
    }
    .padding(DS.Space.xl)
    .background(DS.ColorToken.surfaceSecondary)
}

#Preview("Timeline") {
    TimelineActivityView(
        events: [RealtimeEvent(type: "image.created", eventId: "e2", at: "2026-08-25T10:00:00Z",
                               sessionId: "s", data: .dictionary(["preview": .string("[thumbnail]")]))],
        proactive: [RealtimeEvent(type: "proactive.created", eventId: "e1", at: "2026-08-25T09:30:00Z",
                                  sessionId: "s", data: .dictionary(["preview": .string("外面下雨了，记得带伞～")]))]
    )
    .frame(width: 560, height: 480)
}

#Preview("Agent") {
    AgentTabView(api: APIClient(config: .init(baseURL: URL(string: "http://127.0.0.1:8765")!, tokenProvider: { "" })), developerMode: .constant(false), refreshTrigger: 0)
        .frame(width: 900, height: 560)
}

#Preview("Memory") {
    MemoryCenterView(api: APIClient(config: .init(baseURL: URL(string: "http://127.0.0.1:8765")!, tokenProvider: { "" })))
        .frame(width: 900, height: 560)
}

#Preview("Modules") {
    ModulesView(api: APIClient(config: .init(baseURL: URL(string: "http://127.0.0.1:8765")!, tokenProvider: { "" })))
        .frame(width: 860, height: 520)
}
