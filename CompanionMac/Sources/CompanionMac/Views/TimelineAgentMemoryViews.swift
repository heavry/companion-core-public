import SwiftUI
import CompanionKit

// MARK: - 动态时间线（主动消息 / 天气 / follow-up / 图片 / Agent 完成合并呈现）

struct TimelineActivityView: View {
    let events: [RealtimeEvent]
    let proactive: [RealtimeEvent]

    private var merged: [RealtimeEvent] {
        (proactive + events).sorted { ($0.at ?? "") > ($1.at ?? "") }
    }
    private var groupedByDay: [(day: String, items: [RealtimeEvent])] {
        let fmt = DateFormatter()
        fmt.dateFormat = "M月d日"
        fmt.locale = Locale(identifier: "zh_CN")
        fmt.timeZone = CompanionTime.timeZone
        var groups: [(String, [RealtimeEvent])] = []
        for e in merged {
            guard let at = e.at.flatMap(String.dateFromISO8601) else { continue }
            let key = fmt.string(from: at)
            if groups.last?.0 == key { groups[groups.count-1].1.append(e) }
            else { groups.append((key, [e])) }
        }
        return groups
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: DS.Space.xl) {
                ForEach(groupedByDay, id: \.day) { group in
                    Section {
                        VStack(spacing: DS.Space.s) {
                            ForEach(Array(group.items.enumerated()), id: \.offset) { _, e in
                                TimelineCard(e)
                            }
                        }
                    } header: {
                        Text(group.day).font(DS.Typography.secondary).foregroundStyle(DS.ColorToken.textSecondary)
                    }
                }
                if merged.isEmpty {
                    EmptyStateView(icon: "clock.arrow.circlepath",
                                   title: "暂无动态",
                                   subtitle: "主动消息、天气变化与 Agent 任务完成后会出现在这里")
                }
            }
            .padding(DS.Space.xl)
        }
        .background(DS.ColorToken.surface)
    }

    private func friendlyTitle(_ type: String) -> String {
        switch type {
        case "proactive.created": "主动关心"
        case "image.created": "图片"
        case "message.created", "message.updated": "新消息"
        case "agent.completed": "Agent 任务完成"
        case "tool.completed": "工具执行"
        default: friendlyText(type)
        }
    }
    private func friendlyIcon(_ type: String) -> (String, Color) {
        switch type {
        case "proactive.created": ("sparkles", DS.ColorToken.accent)
        case "image.created": ("photo", .teal)
        case "message.created": ("bubble.left", .blue)
        case "agent.completed": ("hammer.fill", .indigo)
        case "module.completed": ("puzzlepiece", .mint)
        default: ("circle.fill", DS.ColorToken.textTertiary)
        }
    }

    @ViewBuilder
    private func TimelineCard(_ e: RealtimeEvent) -> some View {
        let (icon, tint) = friendlyIcon(e.type)
        HStack(alignment: .top, spacing: DS.Space.m) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 24, height: 24)
                .background(tint.opacity(0.12))
                .clipShape(Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(friendlyTitle(e.type)).font(.footnote.weight(.medium))
                if let text = e.data?["preview"]?.stringValue ?? e.previewText {
                    Text(friendlyText(text)).font(DS.Typography.secondary)
                        .lineLimit(4).foregroundStyle(DS.ColorToken.textPrimary.opacity(0.85))
                }
            }
            Spacer(minLength: 0)
            if let at = e.at {
                Text(String.localTime(from: at)).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)
            }
        }
        .padding(DS.Space.m)
        .background(
            RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous)
                .fill(DS.ColorToken.bubbleCompanion)
                .shadow(color: .black.opacity(0.04), radius: 4, y: 1)
        )
    }
}

// MARK: - Agent 独立区域：普通视图=用户+最终回答；工具为紧凑时间线；developer 默认折叠

struct AgentTabView: View {
    let api: APIClient
    @Binding var developerMode: Bool
    var refreshTrigger: Int

    @State private var agentConversations: [Conversation] = []
    @State private var selectedID: String?
    @State private var messages: [ConversationMessagesResponse.Row] = []

    // 双栏布局（无自身窗口 chrome；全局 Toolbar 由 RootView 提供）
    var body: some View {
        HStack(spacing: 0) {
            List(agentConversations, selection: $selectedID) { c in
                Text(c.displayName).font(DS.Typography.secondary)
                    .tag(c.id)
            }
            .frame(minWidth: 230)
            Divider().opacity(0.6)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: DS.Space.l) {
                    ForEach(visibleMessages) { row in
                        agentRow(row)
                    }
                    if visibleMessages.isEmpty {
                        EmptyStateView(icon: "hammer",
                                       title: "选择一个 Agent 会话",
                                       subtitle: "OpenCode / Harness 的任务过程会显示在这里")
                    }
                }
                .padding(DS.Space.xl)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .task(id: refreshTrigger) { await loadConversations() }
        .onChange(of: selectedID) { id in
            Task { await load(agentConversations.first(where: { $0.id == id })) }
        }
    }

    private var visibleMessages: [ConversationMessagesResponse.Row] {
        developerMode ? messages : messages.filter { row in
            row.role == "user" || (row.role == "assistant" && row.toolCallsJson == nil && !(row.contentText ?? "").isEmpty)
        }
    }

    @ViewBuilder private func agentRow(_ row: ConversationMessagesResponse.Row) -> some View {
        VStack(alignment: .leading, spacing: DS.Space.xs) {
            HStack {
                Text(row.role == "user" ? "用户" : "Agent").font(.footnote.weight(.semibold))
                Spacer()
                if let at = row.createdAt { Text(String.localTime(from: at)).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary) }
            }
            let friendly = friendlyText(row.contentText)
            if !friendly.isEmpty {
                Text(friendly).font(DS.Typography.body).textSelection(.enabled)
            }
            if developerMode, let tools = row.toolCallsJson {
                DisclosureGroup("Tool calls") {
                    Text(tools).font(DS.Typography.mono).textSelection(.enabled)
                }.font(DS.Typography.caption)
            }
        }
        .padding(DS.Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous)
                .fill(DS.ColorToken.bubbleCompanion)
        )
    }

    private func loadConversations() async {
        guard let all = try? await api.conversations() else { return }
        agentConversations = all.filter { $0.category == "agents" }
        let first = agentConversations.first
        if selectedID == first?.id {
            await load(first)
        } else {
            selectedID = first?.id
        }
    }
    private func load(_ c: Conversation?) async {
        guard let c else { return }
        messages = (try? await api.conversationMessages(id: c.id, limit: 400))?.data ?? []
    }
}

// MARK: - Memory Center：左列表 + 右详情

struct MemoryCenterView: View {
    let api: APIClient
    @State private var query = ""
    @State private var rows: [[String: JSONValue]] = []
    @State private var selected: [String: JSONValue]?

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: DS.Space.s) {
                TextField("搜索记忆…", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await load() } }
                Button("搜索") { Task { await load() } }.frame(maxWidth: .infinity)
                List(rows.indices, id: \.self) { i in
                    let m = rows[i]
                    Button {
                        selected = m
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(m["content"]?.stringValue ?? "").lineLimit(2).font(DS.Typography.secondary)
                            HStack(spacing: DS.Space.xs) {
                                TagChip(text: m["type"]?.stringValue ?? "fact", tint: .blue)
                                if m["pinned"]?.boolValue == true { TagChip(text: "置顶", tint: .orange) }
                            }
                        }
                    }.buttonStyle(.plain)
                }
            }
            .padding(DS.Space.m)
            .frame(minWidth: 250)

            Divider().opacity(0.6)

            Group {
                if let m = selected {
                    memoryDetail(m)
                } else {
                    EmptyStateView(icon: "brain",
                                   title: "选择一条记忆查看详情",
                                   subtitle: "Shared Memory 跨会话共享，与原始聊天历史隔离")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task { await load() }
        .onDisappear { Breadcrumb.emit("memory.view.disappear") }
    }

    private func memoryDetail(_ m: [String: JSONValue]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Space.l) {
                Text(friendlyText(m["content"]?.stringValue))
                    .font(.title3)
                    .textSelection(.enabled)
                Divider()
                LabeledRow(label: "类型", value: m["type"]?.stringValue)
                LabeledRow(label: "状态", value: m["status"]?.stringValue)
                LabeledRow(label: "来源", value: m["source"]?.stringValue)
                LabeledRow(label: "重要度", value: m["importance"]?.stringValue)
                LabeledRow(label: "更新时间", value: m["updated_at"]?.stringValue)
                HStack(spacing: DS.Space.m) {
                    Button(m["pinned"]?.boolValue == true ? "取消置顶" : "置顶") {
                        Task { await patch(m["id"]?.stringValue, ["pinned": !(m["pinned"]?.boolValue ?? false)]) }
                    }
                    Button("删除", role: .destructive) {
                        Task { await remove(m["id"]?.stringValue); selected = nil }
                    }
                }
            }
            .padding(DS.Space.xxl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func load() async {
        var urlStr = (api.url(for: "/admin/memories")?.absoluteString ?? "") + "?limit=300"
        if !query.isEmpty { urlStr += "&search=" + query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)! }
        guard let url = URL(string: urlStr), let data = try? await api.getJSON(url.path + (url.query.map { "?" + $0 } ?? "")),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let arr = raw["data"] as? [[String: Any]] else { rows = []; return }
        rows = arr.compactMap { d in
            guard let d2 = try? JSONSerialization.data(withJSONObject: d),
                  let v = try? JSONDecoder().decode(JSONValue.self, from: d2) else { return nil }
            return v.dictionaryValue
        }
    }
    private func patch(_ id: String?, _ patch: [String: Any]) async {
        guard let id, let body = try? JSONSerialization.data(withJSONObject: patch) else { return }
        _ = try? await api.send("PATCH", "/admin/memories/\(id)", body: body)
        await load()
    }
    private func remove(_ id: String?) async {
        guard let id, let body = try? JSONSerialization.data(withJSONObject: ["confirm": true]) else { return }
        _ = try? await api.send("DELETE", "/admin/memories/\(id)", body: body)
        await load()
    }
}

struct LabeledRow: View {
    let label: String
    let value: String?
    var body: some View {
        HStack(alignment: .top) {
            Text(label).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textSecondary).frame(width: 80, alignment: .leading)
            Text(value ?? "—").font(DS.Typography.secondary).textSelection(.enabled)
        }
    }
}

extension JSONValue {
    var dictionaryValue: [String: JSONValue]? {
        if case .dictionary(let d) = self { return d }
        return nil
    }
}
