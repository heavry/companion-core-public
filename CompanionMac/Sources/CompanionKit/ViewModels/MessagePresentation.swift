import Foundation

public enum ToolActivityStatus: String, Equatable {
    case running
    case success
    case failed

    fileprivate var rank: Int {
        switch self { case .running: 0; case .success: 1; case .failed: 2 }
    }
}

public struct ToolActivityPresentation: Identifiable, Equatable {
    public let id: String
    public var status: ToolActivityStatus
    public let integrationName: String
    public let displayName: String
    public var detail: String?
    public var resultCount: Int?
    public var failureCategory: String?
    public var failureSummary: String?
    public var failureReason: String?

    public var headline: String {
        switch status {
        case .running:
            switch integrationName {
            case "联网搜索": return "正在搜索网络"
            case "Notion": return "正在查询 Notion"
            case "Weather": return "正在查询天气"
            case "Home Assistant": return "正在读取 Home Assistant"
            default: return "正在使用 \(integrationName)"
            }
        case .success: return integrationName
        case .failed: return integrationName
        }
    }

    public var actionText: String {
        if status == .failed { return failureSummary ?? Self.failureText(failureCategory) }
        if integrationName == "联网搜索", status == .success, let resultCount { return "\(resultCount) 个来源" }
        return Self.action(displayName: displayName, status: status)
    }

    public var compactText: String {
        if displayName == "读取图片" || displayName == "read_image" {
            return status == .running ? "正在查看图片" : status == .success ? "已查看图片" : actionText
        }
        return actionText
    }

    private static func failureText(_ category: String?) -> String {
        switch category {
        case "permission_required": return "需要批准"
        case "capability_disabled": return "此能力已关闭"
        case "not_configured": return "尚未配置"
        case "scope_denied": return "当前范围不允许此操作"
        case "approval_denied": return "操作被拒绝"
        case "provider_error": return "服务调用失败"
        default: return "操作失败"
        }
    }

    private static func action(displayName: String, status: ToolActivityStatus) -> String {
        let name = displayName.lowercased()
        let pair: (String, String)
        if name == "读取图片" || name == "read_image" { pair = ("读取图片", "图片已读取") }
        else if name == "读取文件" || name == "read_file" { pair = ("读取文件", "文件已读取") }
        else if name == "修改代码" || name == "apply_patch" { pair = ("修改代码", "代码已修改") }
        else if name == "执行测试或命令" || name == "run_command" { pair = ("正在执行", "命令已启动") }
        else if name == "读取执行结果" || name == "read_command_output" { pair = ("检查结果", "已检查结果") }
        else if name == "查看目录" || name == "搜索项目" { pair = ("查看项目", "已查看项目") }
        else if name.contains("browser_navigate") { pair = ("打开网页", "已打开网页") }
        else if name.contains("browser_snapshot") { pair = ("读取页面", "已读取页面") }
        else if name.contains("browser_click") { pair = ("点击页面", "已点击页面") }
        else if name.contains("browser_fill_form") || name.contains("browser_type") { pair = ("填写表单", "已填写表单") }
        else if name.contains("browser_take_screenshot") || name.contains("browser_screenshot") { pair = ("截图", "已截图") }
        else if name.contains("browser_find") { pair = ("查找页面内容", "已查找页面内容") }
        else if name == "web_search" || name.contains("web_search") { pair = ("联网搜索", "已完成搜索") }
        else if name.contains("notion-search") { pair = ("搜索 Notion", "已搜索 Notion") }
        else if name.contains("notion-list-private-pages") { pair = ("读取 Notion 页面", "已读取 Notion 页面") }
        else if name.contains("notion-fetch") || name.contains("notion") { pair = ("读取 Notion 内容", "已读取 Notion 内容") }
        else if name.contains("weather") { pair = ("查询天气", "已查询天气") }
        else if name.contains("get_state") { pair = ("读取设备状态", "已读取设备状态") }
        else if name.contains("turn_on") { pair = ("打开设备", "已打开设备") }
        else if name.contains("turn_off") { pair = ("关闭设备", "已关闭设备") }
        else { pair = ("执行操作", "操作完成") }
        return status == .running ? pair.0 : pair.1
    }
}

public struct ToolActivityGroupPresentation: Identifiable, Equatable {
    public var id: String { "tool-group:\(activities.first?.id ?? "empty")" }
    public var activities: [ToolActivityPresentation]
}

/// A tool run and its natural-language bubbles occupy one assistant row.
/// The first call ID stays stable while completion and streamed text arrive.
public struct AssistantTurnPresentation: Identifiable, Equatable {
    public init(activities: [ToolActivityPresentation], messages: [ConversationMessagesResponse.Row]) {
        self.activities = activities
        self.messages = messages
    }
    public var id: String { "assistant-turn:\(activities.first?.id ?? "empty")" }
    public var activities: [ToolActivityPresentation]
    public var messages: [ConversationMessagesResponse.Row]
}

public struct PermissionApprovalPresentation: Identifiable, Equatable {
    public var id: String { request.requestId }
    public let request: SessionPermissionRequest
}

/// Voice-first presentation for a single assistant message that has TTS of its own text.
/// text-only: ordinary bubble. voiceFirst: voice card + collapsible transcript (no duplicate text bubble).
/// textFallback: TTS unusable → ordinary text bubble so the reply can never disappear.
public enum VoiceMessageDisplayMode: Equatable {
    case textOnly
    case voiceFirst
    case textFallback
}

public enum VoiceMessagePresentation {
    public static func displayMode(
        role: String,
        text: String?,
        voiceAsset: VoiceAsset?,
        voicePlan: RemoteVoicePlan? = nil
    ) -> VoiceMessageDisplayMode {
        let trimmed = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        // User rows keep the existing text + optional attachment layout.
        if role != "assistant" { return .textOnly }
        let state = (voiceAsset?.state ?? "").lowercased()
        if state == "failed" || state == "expired" {
            return .textFallback
        }
        if let asset = voiceAsset, !asset.voiceAssetID.isEmpty, state != "failed", state != "expired" {
            return trimmed.isEmpty ? .textFallback : .voiceFirst
        }
        // Pending TTS (voice_plan only): stay voice-first so presentation does not
        // flip from text → voice after synthesis. Failed synthesis falls back below.
        if voicePlan != nil {
            return trimmed.isEmpty ? .textFallback : .voiceFirst
        }
        return .textOnly
    }

    /// True when playback reports unusable audio — UI should reveal ordinary text.
    public static func shouldFallbackToText(mode: VoiceMessageDisplayMode, playbackFailed: Bool) -> Bool {
        mode == .textFallback || (mode == .voiceFirst && playbackFailed)
    }
}

public enum MessagePresentation: Identifiable, Equatable {
    case bubble(ConversationMessagesResponse.Row)
    case attachment(ConversationMessagesResponse.Row)
    case toolActivityGroup(ToolActivityGroupPresentation)
    case assistantTurn(AssistantTurnPresentation)
    case approval(PermissionApprovalPresentation)

    public var id: String {
        switch self {
        case .bubble(let row): return "message:\(row.id)"
        case .attachment(let row): return "attachment:\(row.id)"
        case .toolActivityGroup(let group): return group.id
        case .assistantTurn(let turn): return turn.id
        case .approval(let approval): return "permission:\(approval.id)"
        }
    }

    public var role: String {
        switch self {
        case .bubble(let row), .attachment(let row): return row.role
        case .toolActivityGroup, .assistantTurn: return "assistant"
        case .approval: return "assistant"
        }
    }

    public var isNormalBubble: Bool { if case .bubble = self { return true }; return false }
    public var activityGroup: ToolActivityGroupPresentation? { if case .toolActivityGroup(let group) = self { return group }; return nil }
}

/// 聊天唯一 presentation classification：历史 DB 行与实时 lifecycle 事件都在这里合并。
public enum MessagePresentationBuilder {
    /// Chat rendering groups activity and all final bubbles inside one assistant turn.
    /// The flat builder remains available for history and activity-only consumers.
    public static func buildAssistantTurns(rows: [ConversationMessagesResponse.Row], realtimeEvents: [RealtimeEvent] = [], sessionId: String? = nil, pendingPermissions: [SessionPermissionRequest] = []) -> [MessagePresentation] {
        let flat = build(rows: rows, realtimeEvents: realtimeEvents, sessionId: sessionId, pendingPermissions: pendingPermissions)
        var turns: [MessagePresentation] = []
        for item in flat {
            switch item {
            case .toolActivityGroup(let group):
                if case .assistantTurn(var turn)? = turns.last, turn.messages.isEmpty {
                    for activity in group.activities where !turn.activities.contains(where: { $0.id == activity.id }) {
                        turn.activities.append(activity)
                    }
                    turns[turns.count - 1] = .assistantTurn(turn)
                } else {
                    turns.append(.assistantTurn(.init(activities: group.activities, messages: [])))
                }
            case .bubble(let row), .attachment(let row):
                guard row.role == "assistant" else { turns.append(item); continue }
                if case .assistantTurn(var turn)? = turns.last,
                   turn.messages.compactMap(\.bubbleTurnId).first.map({ row.bubbleTurnId == nil || row.bubbleTurnId == $0 }) ?? true {
                    turn.messages.append(row)
                    turns[turns.count - 1] = .assistantTurn(turn)
                } else {
                    turns.append(item)
                }
            default:
                turns.append(item)
            }
        }
        return turns
    }

    public static func build(rows: [ConversationMessagesResponse.Row], realtimeEvents: [RealtimeEvent] = [], sessionId: String? = nil, pendingPermissions: [SessionPermissionRequest] = []) -> [MessagePresentation] {
        var items: [MessagePresentation] = []
        var callMetadata: [String: ToolActivityMetadata] = [:]

        func appendOrUpdate(_ metadata: ToolActivityMetadata, turnId: String? = nil, eventAt: String? = nil) {
            guard !metadata.callId.isEmpty else { return }
            let activity = presentation(from: metadata)
            for itemIndex in items.indices {
                guard case .toolActivityGroup(var group) = items[itemIndex],
                      let activityIndex = group.activities.firstIndex(where: { $0.id == metadata.callId }) else { continue }
                var existing = group.activities[activityIndex]
                if activity.status.rank >= existing.status.rank { existing.status = activity.status }
                if let detail = activity.detail { existing.detail = detail }
                if let count = activity.resultCount { existing.resultCount = count }
                if let value = activity.failureCategory { existing.failureCategory = value }
                if let value = activity.failureSummary { existing.failureSummary = value }
                if let value = activity.failureReason { existing.failureReason = value }
                group.activities[activityIndex] = existing
                items[itemIndex] = .toolActivityGroup(group)
                return
            }
            let explicitTarget: Int? = turnId.flatMap { id in
                if let index = items.firstIndex(where: {
                    if case .bubble(let row) = $0 { return row.role == "assistant" && row.bubbleTurnId == id }
                    return false
                }) { return index }
                guard let userID = Int(id.split(separator: ":").last ?? "") else { return nil }
                return items.firstIndex(where: {
                    if case .bubble(let row) = $0 { return row.role == "user" && row.id == userID }
                    return false
                }).map { $0 + 1 }
            }
            let inferredUser = latestUserIndex(for: eventAt, in: items)
            let optimisticTarget: Int? = inferredUser.flatMap { index in
                if case .bubble(let row) = items[index], row.id < 0 { return index + 1 }
                return nil
            }
            let target: Int? = explicitTarget ?? (turnId == nil ? inferredUser.map { $0 + 1 } : optimisticTarget)
            if (turnId != nil || eventAt != nil) && target == nil { return }
            if let target, target < items.count, case .toolActivityGroup(var group) = items[target] {
                group.activities.append(activity)
                items[target] = .toolActivityGroup(group)
            } else if let target {
                items.insert(.toolActivityGroup(.init(activities: [activity])), at: target)
            } else if case .toolActivityGroup(var group)? = items.last {
                group.activities.append(activity)
                items[items.count - 1] = .toolActivityGroup(group)
            } else {
                items.append(.toolActivityGroup(.init(activities: [activity])))
            }
        }

        for row in rows {
            let text = (row.contentText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let hasAttachments = !(row.attachments ?? []).isEmpty
            let metadata = row.toolActivities ?? fallbackMetadata(for: row, knownCalls: callMetadata)
            for value in metadata {
                callMetadata[value.callId] = mergedMetadata(old: callMetadata[value.callId], new: value)
                appendOrUpdate(value)
            }

            if row.role == "assistant", let count = row.webSources?.count, count > 0 {
                updateLatestSearchCount(count, items: &items)
            }
            guard row.role == "user" || row.role == "assistant" else { continue }
            if !text.isEmpty { items.append(.bubble(row)) }
            else if hasAttachments { items.append(.attachment(row)) }
            // 空文本且无附件/工具元数据：presentation 层统一忽略。
        }

        let live = realtimeEvents.enumerated().filter { _, event in
            guard ["tool.started", "tool.completed", "tool.failed", "module.started", "module.completed", "module.failed"].contains(event.type) else { return false }
            return sessionId == nil || event.sessionId == sessionId
        }.sorted { lhs, rhs in
            let left = lhs.element.at ?? String(format: "%012d", lhs.offset)
            let right = rhs.element.at ?? String(format: "%012d", rhs.offset)
            return left < right
        }
        for (_, event) in live {
            if let metadata = metadata(from: event) {
                appendOrUpdate(metadata, turnId: event.data?["turnId"]?.stringValue, eventAt: event.at)
            }
        }
        for request in pendingPermissions where request.status == "pending" {
            let card = MessagePresentation.approval(.init(request: request))
            if let index = items.firstIndex(where: { item in item.activityGroup?.activities.contains(where: { $0.id == request.callId }) == true }) {
                items.insert(card, at: index + 1)
            } else { items.append(card) }
        }
        return items
    }

    private static func latestUserIndex(for eventAt: String?, in items: [MessagePresentation]) -> Int? {
        guard let eventAt else { return items.lastIndex(where: { $0.role == "user" }) }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        guard let eventDate = withFraction.date(from: eventAt) ?? plain.date(from: eventAt) else { return nil }
        return items.indices.reversed().first { index in
            guard case .bubble(let row) = items[index], row.role == "user", let raw = row.createdAt,
                  let userDate = withFraction.date(from: raw) ?? plain.date(from: raw) else { return false }
            return userDate <= eventDate
        }
    }

    private static func presentation(from metadata: ToolActivityMetadata) -> ToolActivityPresentation {
        let displayName = metadata.displayName ?? "tool"
        return ToolActivityPresentation(id: metadata.callId,
            status: ToolActivityStatus(rawValue: metadata.status) ?? .running,
            integrationName: friendlyIntegration(metadata.integrationName, displayName: displayName),
            displayName: displayName, detail: safeDetail(metadata.detail), resultCount: metadata.resultCount,
            failureCategory: metadata.failureCategory, failureSummary: safeDetail(metadata.failureSummary), failureReason: safeDetail(metadata.failureReason))
    }

    private static func friendlyIntegration(_ raw: String?, displayName: String) -> String {
        let value = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty, value != "Integration", !looksInternal(value) {
            if value == "Tavily" { return "联网搜索" }
            return String(value.prefix(64))
        }
        let name = displayName.lowercased()
        if name.contains("browser_") { return "Playwright" }
        if name.contains("notion") { return "Notion" }
        if name.contains("web_search") { return "联网搜索" }
        if name.contains("weather") { return "Weather" }
        if name.contains("get_state") || name.contains("turn_on") || name.contains("turn_off") { return "Home Assistant" }
        return "Integration"
    }

    private static func looksInternal(_ value: String) -> Bool {
        value.lowercased().hasPrefix("mcp_") || value.contains("_") && value.range(of: #"[0-9a-f]{4,}"#, options: .regularExpression) != nil
    }

    private static func safeDetail(_ raw: String?) -> String? {
        guard var text = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        let lower = text.lowercased().replacingOccurrences(of: "_", with: "").replacingOccurrences(of: "-", with: "")
        if ["authorization", "bearer ", "cookie", "password", "apikey", "refreshtoken", "accesstoken", "secret", "[redacted]"].contains(where: lower.contains) { return nil }
        if let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let host = url.host { text = host }
        if text.hasPrefix("/Users/") || text.hasPrefix("/private/") || text.hasPrefix("~/") { text = URL(fileURLWithPath: text).lastPathComponent }
        return text.isEmpty ? nil : String(text.prefix(96))
    }

    private static func fallbackMetadata(for row: ConversationMessagesResponse.Row, knownCalls: [String: ToolActivityMetadata]) -> [ToolActivityMetadata] {
        if row.role == "assistant", let raw = row.toolCallsJson, let data = raw.data(using: .utf8),
           let calls = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            return calls.compactMap { call in
                guard let id = (call["id"] ?? call["call_id"]) as? String else { return nil }
                let function = call["function"] as? [String: Any]
                let name = (function?["name"] ?? call["name"]) as? String ?? "tool"
                return ToolActivityMetadata(callId: id, status: "running", displayName: legacyDisplayName(name))
            }
        }
        if row.role == "tool", let id = row.toolCallId, let known = knownCalls[id] {
            let failed = (row.contentText ?? "").range(of: #"\[(mcp|module) tool error\]|tool reported an error"#, options: [.regularExpression, .caseInsensitive]) != nil
            return [ToolActivityMetadata(callId: id, status: failed ? "failed" : "success", sourceType: known.sourceType,
                                         sourceId: known.sourceId, integrationName: known.integrationName,
                                         displayName: known.displayName, detail: known.detail, resultCount: known.resultCount,
                                         failureCategory: known.failureCategory, failureCode: known.failureCode,
                                         failureSummary: known.failureSummary, failureReason: known.failureReason)]
        }
        return []
    }

    private static func legacyDisplayName(_ wireName: String) -> String {
        let known = ["browser_take_screenshot", "browser_fill_form", "browser_navigate", "browser_snapshot", "browser_click", "browser_find",
                     "notion-list-private-pages", "notion-search", "notion-fetch", "web_search", "get_state", "turn_on", "turn_off"]
        return known.first(where: { wireName.lowercased().contains($0) }) ?? "tool"
    }

    private static func mergedMetadata(old: ToolActivityMetadata?, new: ToolActivityMetadata) -> ToolActivityMetadata {
        guard let old else { return new }
        let oldStatus = ToolActivityStatus(rawValue: old.status) ?? .running
        let newStatus = ToolActivityStatus(rawValue: new.status) ?? .running
        return ToolActivityMetadata(callId: new.callId, status: newStatus.rank >= oldStatus.rank ? new.status : old.status,
            sourceType: new.sourceType ?? old.sourceType, sourceId: new.sourceId ?? old.sourceId,
            integrationName: new.integrationName ?? old.integrationName, displayName: new.displayName ?? old.displayName,
            detail: new.detail ?? old.detail, resultCount: new.resultCount ?? old.resultCount,
            failureCategory: new.failureCategory ?? old.failureCategory, failureCode: new.failureCode ?? old.failureCode,
            failureSummary: new.failureSummary ?? old.failureSummary, failureReason: new.failureReason ?? old.failureReason)
    }

    private static func metadata(from event: RealtimeEvent) -> ToolActivityMetadata? {
        guard case .dictionary(let data)? = event.data else { return nil }
        let status: String = event.type.hasSuffix("failed") ? "failed" : event.type.hasSuffix("completed") ? "success" : "running"
        let activity = data["activity"]?.dictionaryValue
        let callId = data["callId"]?.stringValue ?? data["call_id"]?.stringValue ?? event.eventId ?? ""
        guard !callId.isEmpty else { return nil }
        let activityDisplayName = activity?["display_name"]?.stringValue
        let rawName = activityDisplayName ?? data["name"]?.stringValue ?? data["tool"]?.stringValue ?? "tool"
        return ToolActivityMetadata(callId: callId, status: status,
            sourceType: activity?["source_type"]?.stringValue ?? data["source"]?.stringValue,
            sourceId: activity?["source_id"]?.stringValue ?? data["integrationId"]?.stringValue ?? data["moduleId"]?.stringValue,
            integrationName: activity?["integration_name"]?.stringValue,
            displayName: activityDisplayName ?? legacyDisplayName(rawName),
            detail: activity?["detail"]?.stringValue,
            resultCount: data["result_count"]?.intValue,
            failureCategory: activity?["failure_category"]?.stringValue,
            failureCode: activity?["failure_code"]?.stringValue,
            failureSummary: activity?["failure_summary"]?.stringValue,
            failureReason: activity?["failure_reason"]?.stringValue)
    }

    private static func updateLatestSearchCount(_ count: Int, items: inout [MessagePresentation]) {
        for itemIndex in items.indices.reversed() {
            guard case .toolActivityGroup(var group) = items[itemIndex] else { break }
            if let index = group.activities.lastIndex(where: { $0.integrationName == "联网搜索" }) {
                group.activities[index].resultCount = count
                items[itemIndex] = .toolActivityGroup(group)
                return
            }
        }
    }
}
