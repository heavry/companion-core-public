import SwiftUI
import CompanionKit
import AppKit

struct ProductCard<Content: View>: View {
    let title: String
    var subtitle: String? = nil
    @ViewBuilder let content: Content
    var body: some View {
        CompanionCard(title: title, subtitle: subtitle) {
            content
        }
    }
}

struct CompactProductEmptyState: View {
    let icon: String
    let title: String
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: DS.Space.m) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(DS.ColorToken.accent)
                .frame(width: 34, height: 34)
                .background(DS.ColorToken.accentSoft, in: RoundedRectangle(cornerRadius: DS.Radius.s))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body.weight(.medium))
                Text(message).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textSecondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct WallpaperMaterialBackground: View {
    @AppStorage("companionWallpaperPath") private var wallpaperPath = ""
    @AppStorage("companionReadabilityStrength") private var readabilityStrength = "balanced"
    @State private var wallpaperImage: NSImage?
    @Environment(\.colorScheme) private var colorScheme

    private var imageOpacity: Double {
        switch readabilityStrength {
        case "soft": return colorScheme == .dark ? 0.42 : 0.34
        case "strong": return colorScheme == .dark ? 0.24 : 0.18
        default: return colorScheme == .dark ? 0.34 : 0.26
        }
    }

    private var veilOpacity: Double {
        switch readabilityStrength {
        case "soft": return colorScheme == .dark ? 0.28 : 0.36
        case "strong": return colorScheme == .dark ? 0.62 : 0.70
        default: return colorScheme == .dark ? 0.46 : 0.54
        }
    }

    var body: some View {
        ZStack {
            DS.ColorToken.windowBackground
            LinearGradient(
                colors: [Color.accentColor.opacity(0.13), Color.indigo.opacity(0.055), Color.clear],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            if let wallpaperImage {
                Image(nsImage: wallpaperImage)
                    .resizable()
                    .interpolation(.medium)
                    .scaledToFill()
                    .opacity(imageOpacity)
                    .clipped()
                Rectangle()
                    .fill(colorScheme == .dark ? Color.black.opacity(veilOpacity) : Color.white.opacity(veilOpacity))
                LinearGradient(
                    colors: [Color.black.opacity(colorScheme == .dark ? 0.18 : 0.03), Color.clear, Color.black.opacity(colorScheme == .dark ? 0.12 : 0.02)],
                    startPoint: .top,
                    endPoint: .bottom
                )
            } else {
                RadialGradient(
                    colors: [Color.accentColor.opacity(0.08), Color.clear],
                    center: .topTrailing,
                    startRadius: 20,
                    endRadius: 620
                )
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
        .onAppear(perform: reloadWallpaper)
        .onChange(of: wallpaperPath) { _ in reloadWallpaper() }
    }

    private func reloadWallpaper() {
        wallpaperImage = wallpaperPath.isEmpty ? nil : NSImage(contentsOfFile: wallpaperPath)
    }
}

struct TodayProductView: View {
    let api: APIClient
    @State private var snapshot: TodaySnapshot?
    @State private var errorText: String?
    @State private var selectedDate: String?

    var body: some View {
        ScrollView {
            if let snapshot {
                VStack(alignment: .leading, spacing: DS.Space.xl) {
                    TimelineView(.periodic(from: .now, by: CompanionTime.minuteRefreshInterval)) { context in
                        todayHero(snapshot, now: context.date)
                    }
                    diaryCard(snapshot)
                    primaryAgenda(snapshot)

                    attentionCard(snapshot.attention)
                    HStack(alignment: .top, spacing: DS.Space.l) {
                        proactiveCard(snapshot.proactive)
                        activityCard(snapshot.recentAgentActivity)
                    }

                    usageStrip(snapshot.usage)
                }
                .frame(maxWidth: 1080)
                .frame(maxWidth: .infinity)
            } else if let errorText {
                EmptyStateView(icon: "exclamationmark.triangle", title: "今天的状态暂时不可用", subtitle: errorText)
                    .frame(minHeight: 420)
            } else {
                ProgressView("正在整理今天…")
                    .frame(maxWidth: .infinity, minHeight: 420)
            }
        }
        .padding(DS.Space.xl)
        .task { await load() }
    }

    private func todayHero(_ snapshot: TodaySnapshot, now: Date) -> some View {
        ZStack(alignment: .trailing) {
            RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color.accentColor.opacity(0.22), Color.indigo.opacity(0.10), DS.ColorToken.surface.opacity(0.92)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            Image(systemName: snapshot.proactive.quietHoursNow ? "moon.stars.fill" : "sun.max.fill")
                .font(.system(size: 112, weight: .ultraLight))
                .foregroundStyle(Color.accentColor.opacity(0.10))
                .padding(.trailing, DS.Space.xxl)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: DS.Space.s) {
                Text(CompanionTime.todayHeader(now))
                    .font(DS.Typography.caption)
                    .foregroundStyle(DS.ColorToken.textSecondary)
                    .textCase(.uppercase)
                    .tracking(0.5)
                Text(CompanionTime.greeting(now))
                    .font(.system(size: 30, weight: .semibold, design: .rounded))
                HStack(spacing: DS.Space.s) {
                    Image(systemName: snapshot.proactive.allowed ? "sparkles" : "moon.zzz.fill")
                    Text(snapshot.proactive.allowed ? "林小糖今天可以主动联系你" : "林小糖正在安静陪伴")
                        .font(.headline)
                    TagChip(text: proactiveLevel(snapshot.proactive.level), tint: snapshot.proactive.allowed ? .green : .orange)
                }
                Text(proactiveReason(snapshot.proactive))
                    .font(DS.Typography.secondary)
                    .foregroundStyle(DS.ColorToken.textSecondary)
            }
            .padding(DS.Space.xxl)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: 184)
        .overlay(
            RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous)
                .strokeBorder(DS.ColorToken.separator.opacity(0.62), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func attentionCard(_ attention: TodaySnapshot.Attention?) -> some View {
        let items = attention?.items.filter { $0.status == "unread" || $0.status == "snoozed" } ?? []
        ProductCard(title: "需要关注", subtitle: items.isEmpty ? "没有未读事项" : "任务完成、提醒和重要错误") {
            if items.isEmpty {
                CompactProductEmptyState(icon: "bell.slash", title: "此刻没有需要你处理的事", message: "完成的任务和到期提醒会显示在这里。")
            } else {
                VStack(alignment: .leading, spacing: DS.Space.s) {
                    ForEach(items.prefix(5)) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title).font(.subheadline.weight(.medium))
                            Text(item.summary).font(.caption).foregroundStyle(DS.ColorToken.textSecondary).lineLimit(2)
                        }
                        .accessibilityLabel(item.title)
                    }
                }
            }
        }
    }

    private func primaryAgenda(_ snapshot: TodaySnapshot) -> some View {
        ProductCard(title: "接下来", subtitle: "重要事件与即将执行的计划") {
            let plans = Array(snapshot.plans.upcoming.prefix(3))
            let events = Array(snapshot.events.prefix(3))
            if plans.isEmpty && events.isEmpty {
                CompactProductEmptyState(
                    icon: "checkmark.circle",
                    title: "今天没有需要立刻处理的事",
                    message: "新的计划和重要事件会在这里出现。"
                )
            } else {
                HStack(alignment: .top, spacing: DS.Space.xl) {
                    agendaColumn(title: "计划", icon: "calendar", plans: plans)
                    Divider()
                    eventColumn(events)
                }
            }
        }
    }

    private func agendaColumn(title: String, icon: String, plans: [SchedulerPlan]) -> some View {
        VStack(alignment: .leading, spacing: DS.Space.m) {
            Label(title, systemImage: icon)
                .font(.headline)
                .foregroundStyle(DS.ColorToken.textSecondary)
            if plans.isEmpty {
                Text("暂无即将执行的计划")
                    .font(DS.Typography.secondary)
                    .foregroundStyle(DS.ColorToken.textTertiary)
            } else {
                ForEach(plans) { plan in
                    HStack(spacing: DS.Space.m) {
                        Image(systemName: plan.schedule.type == "once" ? "clock" : "repeat")
                            .foregroundStyle(DS.ColorToken.accent)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(plan.title).font(.body.weight(.medium)).lineLimit(1)
                            Text(plan.nextRunAt.map { "下一次 · \(String.localTime(from: $0))" } ?? "等待安排")
                                .font(DS.Typography.caption)
                                .foregroundStyle(DS.ColorToken.textTertiary)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func eventColumn(_ events: [ProductEvent]) -> some View {
        VStack(alignment: .leading, spacing: DS.Space.m) {
            Label("值得关注", systemImage: "bookmark")
                .font(.headline)
                .foregroundStyle(DS.ColorToken.textSecondary)
            if events.isEmpty {
                Text("暂无重要事件")
                    .font(DS.Typography.secondary)
                    .foregroundStyle(DS.ColorToken.textTertiary)
            } else {
                ForEach(events) { event in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(event.content).font(.body.weight(.medium)).lineLimit(2)
                        Text(String.localTime(from: event.createdAt))
                            .font(DS.Typography.caption)
                            .foregroundStyle(DS.ColorToken.textTertiary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func proactiveCard(_ value: TodaySnapshot.Proactive) -> some View {
        ProductCard(title: "主动陪伴", subtitle: "本地规则状态") {
            HStack(alignment: .firstTextBaseline) {
                Label(value.allowed ? "可以联系" : "保持安静", systemImage: value.allowed ? "message.badge.waveform" : "moon.zzz")
                    .font(.title3.weight(.semibold))
                Spacer()
                Text("\(value.messagesToday) / \(value.dailyCap)")
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .accessibilityLabel("今天已主动联系 \(value.messagesToday) 次，上限 \(value.dailyCap) 次")
            }
            Text(proactiveReason(value))
                .font(DS.Typography.secondary)
                .foregroundStyle(DS.ColorToken.textSecondary)
        }
        .frame(maxWidth: .infinity)
    }

    private func activityCard(_ activity: [TodaySnapshot.AgentActivity]) -> some View {
        ProductCard(title: "最近活动", subtitle: "只读现有 Agent 会话") {
            if activity.isEmpty {
                CompactProductEmptyState(icon: "sparkles", title: "暂时没有新活动", message: "完成的任务会以时间线显示。")
            } else {
                ForEach(Array(activity.prefix(3))) { item in
                    HStack(spacing: DS.Space.m) {
                        ZStack {
                            Circle().fill(DS.ColorToken.accent.opacity(0.12))
                            Image(systemName: "hammer.fill").font(.caption).foregroundStyle(DS.ColorToken.accent)
                        }
                        .frame(width: 28, height: 28)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.source).font(.body.weight(.medium)).lineLimit(1)
                            Text("\(item.messageCount) 条记录")
                                .font(DS.Typography.caption)
                                .foregroundStyle(DS.ColorToken.textTertiary)
                        }
                        Spacer()
                        Text(String.localTime(from: item.updatedAt))
                            .font(DS.Typography.caption)
                            .foregroundStyle(DS.ColorToken.textTertiary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func usageStrip(_ usage: TodaySnapshot.Usage) -> some View {
        HStack(spacing: DS.Space.xl) {
            Label("今日用量", systemImage: "chart.bar.xaxis")
                .font(.headline)
            Spacer()
            metricRow("请求", "\(usage.requests)")
            Divider().frame(height: 26)
            metricRow("Tokens", usage.totalTokens.map(Self.compactNumber) ?? "未知")
            if usage.unknownTokenRequests > 0 {
                Label("\(usage.unknownTokenRequests) 次未记录", systemImage: "questionmark.circle")
                    .font(DS.Typography.caption)
                    .foregroundStyle(DS.ColorToken.warning)
            }
        }
        .padding(.horizontal, DS.Space.l)
        .padding(.vertical, DS.Space.m)
        .background(DS.ColorToken.surfaceSecondary.opacity(0.58), in: RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous).strokeBorder(DS.ColorToken.separator.opacity(0.42)))
    }

    private func diaryCard(_ snapshot: TodaySnapshot) -> some View {
        let diary = snapshot.diary
        let date = diary?.selectedDate ?? selectedDate ?? ""
        return ProductCard(title: "林小糖的日记", subtitle: date.isEmpty ? "她自己对这一天的记录" : displayLocalDate(date)) {
            VStack(alignment: .leading, spacing: DS.Space.m) {
                HStack {
                    Button {
                        if let previous = diary?.previousDate { Task { await load(date: previous) } }
                    } label: {
                        Label("上一天", systemImage: "chevron.left")
                    }
                    .disabled(diary?.previousDate == nil)
                    Spacer()
                    Text(displayLocalDate(date))
                        .font(.headline)
                    Spacer()
                    Button {
                        if let next = diary?.nextDate { Task { await load(date: next) } }
                    } label: {
                        Label("下一天", systemImage: "chevron.right")
                    }
                    .disabled(diary?.nextDate == nil)
                    .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.borderless)

                if let entry = diary?.entry {
                    Text(entry.body)
                        .font(.body)
                        .lineSpacing(4)
                        .textSelection(.enabled)
                    if let message = entry.messageToUser, !message.isEmpty {
                        Text(message)
                            .font(DS.Typography.secondary)
                            .foregroundStyle(DS.ColorToken.textSecondary)
                            .padding(DS.Space.m)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(DS.ColorToken.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: DS.Radius.s, style: .continuous))
                    }
                } else {
                    CompactProductEmptyState(
                        icon: "book.closed",
                        title: "这一天还没有日记",
                        message: "到晚上她会自己写下当天的记录。没聊天的日子也会写。"
                    )
                }

                if let recent = diary?.recent, !recent.isEmpty {
                    VStack(alignment: .leading, spacing: DS.Space.s) {
                        Text("最近日记")
                            .font(DS.Typography.caption)
                            .foregroundStyle(DS.ColorToken.textSecondary)
                        ForEach(recent.prefix(6)) { item in
                            Button {
                                Task { await load(date: item.dateLocal) }
                            } label: {
                                HStack(alignment: .top, spacing: DS.Space.m) {
                                    Text(displayLocalDate(item.dateLocal))
                                        .font(.subheadline.weight(.medium))
                                        .frame(width: 72, alignment: .leading)
                                    Text(item.summary)
                                        .font(DS.Typography.secondary)
                                        .foregroundStyle(DS.ColorToken.textSecondary)
                                        .lineLimit(2)
                                    Spacer()
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    private func displayLocalDate(_ raw: String) -> String {
        let parts = raw.split(separator: "-")
        guard parts.count == 3, let month = Int(parts[1]), let day = Int(parts[2]) else { return raw }
        return "\(month)月\(day)日"
    }

    private func load(date: String? = nil) async {
        do {
            snapshot = try await api.todaySnapshot(date: date)
            selectedDate = snapshot?.diary?.selectedDate ?? date
            errorText = nil
        } catch {
            errorText = String(describing: error)
        }
    }

    private func metricRow(_ label: String, _ value: String) -> some View {
        HStack(spacing: DS.Space.s) {
            Text(label).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textSecondary)
            Text(value).font(.system(.body, design: .rounded).weight(.semibold))
        }
    }

    private static func compactNumber(_ value: Int) -> String {
        value.formatted(.number.notation(.compactName))
    }

    private func proactiveLevel(_ value: String) -> String {
        ["low": "安静", "normal": "日常", "active": "积极"][value] ?? value
    }

    private func proactiveReason(_ value: TodaySnapshot.Proactive) -> String {
        if value.allowed { return "主动消息规则目前允许；今天已发送 \(value.messagesToday)/\(value.dailyCap)。" }
        let names=["disabled":"主动消息已关闭","quiet_hours":"安静时段","no_reply_suppression":"等待你的回复","daily_cap":"今日上限已到","cooldown":"冷却中"]
        return value.reasons.compactMap { names[$0] }.joined(separator: " · ").isEmpty ? "由现有本地规则暂时抑制。" : value.reasons.compactMap { names[$0] }.joined(separator: " · ")
    }
}

struct RelationshipProductView: View {
    let api: APIClient
    @State private var snapshot: RelationshipSnapshot?
    @State private var errorText: String?

    var body: some View {
        ScrollView {
            if let snapshot {
                VStack(alignment: .leading, spacing: DS.Space.xl) {
                    if let persona = snapshot.persona {
                        identityHero(persona, memory: snapshot.memoryOverview)
                    }

                    HStack(alignment: .top, spacing: DS.Space.l) {
                        if let persona = snapshot.persona {
                            ProductCard(title: "相处方式", subtitle: "当前只读表达偏好") {
                                HStack(spacing: DS.Space.xl) {
                                    interactionMetric("语气", interactionTone(persona.speakingStyle.tone), icon: "waveform")
                                    interactionMetric("回复", verbosityLabel(persona.speakingStyle.verbosity), icon: "text.alignleft")
                                    interactionMetric("表情", emojiLabel(persona.speakingStyle.emojiFrequency), icon: "face.smiling")
                                }
                                if !persona.speakingStyle.rules.isEmpty {
                                    DisclosureGroup("查看详细相处规则") {
                                        VStack(alignment: .leading, spacing: DS.Space.s) {
                                            ForEach(persona.speakingStyle.rules, id: \.self) { rule in
                                                Label(rule, systemImage: "checkmark.circle")
                                                    .font(DS.Typography.secondary)
                                                    .foregroundStyle(DS.ColorToken.textSecondary)
                                            }
                                        }
                                        .padding(.top, DS.Space.s)
                                    }
                                    .font(DS.Typography.caption)
                                    .tint(DS.ColorToken.textSecondary)
                                }
                            }
                        }
                        memoryOverviewCard(snapshot.memoryOverview)
                    }

                    ProductCard(title: "共同上下文", subtitle: snapshot.contextUpdatedAt.map { "更新于 \(friendlyDate($0))" }) {
                        if let summary = snapshot.contextSummary, !summary.isEmpty {
                            Label {
                                Text(summary)
                                    .font(DS.Typography.body)
                                    .foregroundStyle(DS.ColorToken.textPrimary)
                                    .lineSpacing(4)
                                    .textSelection(.enabled)
                            } icon: {
                                Image(systemName: "quote.opening")
                                    .font(.title2)
                                    .foregroundStyle(DS.ColorToken.accent)
                                    .accessibilityHidden(true)
                            }
                        } else {
                            CompactProductEmptyState(icon: "text.bubble", title: "还没有会话摘要", message: "形成稳定上下文后会在这里显示。")
                        }
                    }

                    HStack(alignment: .top, spacing: DS.Space.l) {
                        ProductCard(title: "重要事件", subtitle: "真实记录") {
                            if snapshot.importantEvents.isEmpty {
                                CompactProductEmptyState(icon: "calendar.badge.checkmark", title: "暂无重要事件", message: "重要的共同经历会在这里沉淀。")
                            } else {
                                ForEach(snapshot.importantEvents.prefix(5)) { event in
                                    HStack(alignment: .top, spacing: DS.Space.m) {
                                        Image(systemName: "bookmark.fill")
                                            .foregroundStyle(DS.ColorToken.accent)
                                            .padding(.top, 2)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(event.content).lineLimit(3)
                                            Text(friendlyDate(event.createdAt))
                                                .font(DS.Typography.caption)
                                                .foregroundStyle(DS.ColorToken.textTertiary)
                                        }
                                    }
                                }
                            }
                        }
                        ProductCard(title: "日记", subtitle: "未来区域") {
                            if snapshot.journal.available && !snapshot.journal.entries.isEmpty {
                                Label("已有 \(snapshot.journal.entries.count) 条日记", systemImage: "book.pages")
                            } else {
                                CompactProductEmptyState(icon: "book.closed", title: "日记尚未启用", message: "这里不会生成或伪造任何内容。")
                            }
                        }
                    }
                }
                .frame(maxWidth: 1080)
                .frame(maxWidth: .infinity)
            } else if let errorText {
                EmptyStateView(icon: "person.2.slash", title: "关系信息暂时不可用", subtitle: errorText)
                    .frame(minHeight: 420)
            } else {
                ProgressView("正在读取相处状态…")
                    .frame(maxWidth: .infinity, minHeight: 420)
            }
        }
        .padding(DS.Space.xl)
        .task { await load() }
    }

    private func identityHero(_ persona: RelationshipSnapshot.Persona, memory: RelationshipSnapshot.MemoryOverview) -> some View {
        HStack(alignment: .center, spacing: DS.Space.xxl) {
            AvatarView(name: persona.name, size: 128)
                .shadow(color: Color.accentColor.opacity(0.18), radius: 18, y: 8)
                .accessibilityLabel("\(persona.name) 的头像")
            VStack(alignment: .leading, spacing: DS.Space.m) {
                Text("你的陪伴者")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(DS.ColorToken.accent)
                    .tracking(1.4)
                Text(persona.name)
                    .font(.system(size: 34, weight: .semibold, design: .rounded))
                Text(identitySummary(persona.coreIdentity))
                    .font(.title3)
                    .foregroundStyle(DS.ColorToken.textSecondary)
                    .lineLimit(3)
                    .lineSpacing(3)
                HStack(spacing: DS.Space.s) {
                    ForEach(Array(persona.personality.prefix(5)), id: \.self) { trait in
                        TagChip(text: trait, tint: DS.ColorToken.accent)
                    }
                }
                Label(persona.memoryEnabled ? "长期记忆已连接 · \(memory.active) 条有效记忆" : "长期记忆未启用",
                      systemImage: persona.memoryEnabled ? "brain.head.profile" : "brain.head.profile.fill")
                    .font(DS.Typography.caption)
                    .foregroundStyle(persona.memoryEnabled ? DS.ColorToken.success : DS.ColorToken.warning)
            }
            Spacer(minLength: 0)
        }
        .padding(DS.Space.xxl)
        .background(
            LinearGradient(
                colors: [Color.accentColor.opacity(0.18), Color.purple.opacity(0.08), DS.ColorToken.surface.opacity(0.9)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous)
        )
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous).strokeBorder(DS.ColorToken.separator.opacity(0.62)))
    }

    private func interactionMetric(_ title: String, _ value: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: DS.Space.xs) {
            Label(title, systemImage: icon)
                .font(DS.Typography.caption)
                .foregroundStyle(DS.ColorToken.textTertiary)
            Text(value).font(.body.weight(.medium)).lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func memoryOverviewCard(_ overview: RelationshipSnapshot.MemoryOverview) -> some View {
        ProductCard(title: "长期记忆", subtitle: "来自真实 Memory") {
            HStack(alignment: .firstTextBaseline, spacing: DS.Space.s) {
                Text("\(overview.active)")
                    .font(.system(size: 36, weight: .semibold, design: .rounded))
                Text("条正在使用")
                    .font(DS.Typography.secondary)
                    .foregroundStyle(DS.ColorToken.textSecondary)
                Spacer()
                if overview.historical > 0 {
                    TagChip(text: "\(overview.historical) 条历史", tint: .gray)
                }
            }
            if overview.recent.isEmpty {
                Text("还没有可以预览的长期记忆。")
                    .font(DS.Typography.secondary)
                    .foregroundStyle(DS.ColorToken.textSecondary)
            } else {
                ForEach(overview.recent.prefix(3)) { memory in
                    HStack(alignment: .top, spacing: DS.Space.s) {
                        Image(systemName: "circle.fill")
                            .font(.system(size: 5))
                            .foregroundStyle(DS.ColorToken.accent)
                            .padding(.top, 7)
                        Text(memory.content).font(DS.Typography.secondary).lineLimit(2)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func identitySummary(_ raw: String) -> String {
        if let range = raw.range(of: "[身份:"),
           let end = raw[range.upperBound...].firstIndex(of: "]") {
            return String(raw[range.upperBound..<end])
        }
        let first = raw.split(whereSeparator: { ".。\n".contains($0) }).first.map(String.init) ?? raw
        return String(first.prefix(180))
    }

    private func interactionTone(_ raw: String) -> String {
        let first = raw.split(whereSeparator: { ".。；;\n".contains($0) }).first.map(String.init) ?? raw
        return String(first.prefix(42))
    }

    private func verbosityLabel(_ value: String) -> String {
        ["max": "充分回应", "detailed": "详细", "concise": "简洁"][value] ?? value
    }

    private func emojiLabel(_ value: String) -> String {
        ["low": "少量", "medium": "适量", "high": "较多", "none": "不使用"][value] ?? value
    }

    private func friendlyDate(_ value: String) -> String {
        CompanionTime.naturalDateTime(fromISO8601: value)
    }

    private func load() async { do { snapshot = try await api.relationshipSnapshot(); errorText = nil } catch { errorText = String(describing: error) } }
}

struct PlansProductView: View {
    let api: APIClient
    @State private var snapshot: SchedulerSnapshot?
    @State private var errorText: String?
    @State private var showingEditor = false
    @State private var editingPlan: SchedulerPlan?
    @State private var deletingPlan: SchedulerPlan?
    @State private var busyPlanID: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Space.xl) {
                if let snapshot {
                    schedulerHero(snapshot)

                    if snapshot.plans.isEmpty {
                        CompanionGlassPanel(style: .standard) {
                            CompanionStateView(
                                kind: .empty,
                                title: "还没有计划",
                                message: "为一次提醒或固定节奏创建一个计划。Companion 会按北京时间准时执行。",
                                actionTitle: "创建第一个计划",
                                action: openNewPlan
                            )
                            .frame(maxWidth: .infinity)
                        }
                    } else {
                        let active = snapshot.plans.filter(\.enabled)
                        let paused = snapshot.plans.filter { !$0.enabled }
                        if !active.isEmpty { planSection("正在进行", subtitle: "下一次执行按时间排序", plans: active) }
                        if !paused.isEmpty { planSection("已暂停", subtitle: "保留设置，不会继续执行", plans: paused) }
                    }

                    historySection(snapshot.history)
                } else if let errorText {
                    CompanionStateView(kind: .error, title: "计划暂时不可用", message: errorText, actionTitle: "重试") { Task { await load() } }
                        .frame(maxWidth: .infinity, minHeight: 420)
                } else {
                    CompanionStateView(kind: .loading, title: "正在整理计划", message: "正在读取下一次执行时间。")
                        .frame(maxWidth: .infinity, minHeight: 420)
                }
            }
            .frame(maxWidth: 1080)
            .frame(maxWidth: .infinity)
            .padding(DS.Space.xl)
        }
        .task { await load() }
        .sheet(isPresented: $showingEditor) { PlanEditorView(api: api, plan: editingPlan) { Task { await load() } } }
        .confirmationDialog("删除“\(deletingPlan?.title ?? "")”？", isPresented: Binding(get: { deletingPlan != nil }, set: { if !$0 { deletingPlan = nil } })) {
            Button("删除计划", role: .destructive) {
                if let plan = deletingPlan {
                    Task {
                        busyPlanID = plan.id
                        do { try await api.deletePlan(id: plan.id); errorText = nil }
                        catch { errorText = String(describing: error) }
                        deletingPlan = nil
                        busyPlanID = nil
                        await load()
                    }
                }
            }
            Button("取消", role: .cancel) { deletingPlan = nil }
        } message: { Text("计划和未来执行会停止；既有历史仍保留。") }
    }

    private func schedulerHero(_ snapshot: SchedulerSnapshot) -> some View {
        HStack(spacing: DS.Space.xxl) {
            ZStack {
                RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous)
                    .fill(DS.ColorToken.accentSoft)
                Image(systemName: "calendar.badge.clock")
                    .font(.system(size: 34, weight: .medium))
                    .foregroundStyle(DS.ColorToken.accent)
            }
            .frame(width: 76, height: 76)
            VStack(alignment: .leading, spacing: DS.Space.s) {
                Text("按你的节奏安排")
                    .font(.system(size: 27, weight: .semibold, design: .rounded))
                Text(snapshot.plans.isEmpty
                     ? "一次提醒、每天、每周，或自定义时间。"
                     : "\(snapshot.plans.filter(\.enabled).count) 个计划正在进行 · \(snapshot.plans.filter { !$0.enabled }.count) 个已暂停")
                    .font(DS.Typography.secondary)
                    .foregroundStyle(DS.ColorToken.textSecondary)
            }
            Spacer()
            Button(action: openNewPlan) { Label("新建计划", systemImage: "plus") }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(DS.ColorToken.accent)
                .keyboardShortcut("n", modifiers: [.command])
        }
        .padding(DS.Space.xxl)
        .background(
            LinearGradient(colors: [Color.accentColor.opacity(0.14), DS.ColorToken.surfaceElevated.opacity(0.86)], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous)
        )
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous).strokeBorder(DS.ColorToken.glassBorder))
    }

    @ViewBuilder private func planSection(_ title: String, subtitle: String, plans: [SchedulerPlan]) -> some View {
        ProductCard(title: title, subtitle: subtitle) {
            ForEach(plans) { plan in
                planRow(plan)
                if plan.id != plans.last?.id { Divider() }
            }
        }
    }

    private func planRow(_ plan: SchedulerPlan) -> some View {
        HStack(spacing: DS.Space.l) {
            ZStack {
                RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous)
                    .fill(plan.enabled ? DS.ColorToken.accentSoft : DS.ColorToken.surfaceSecondary)
                Image(systemName: scheduleIcon(plan.schedule))
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(plan.enabled ? DS.ColorToken.accent : DS.ColorToken.textTertiary)
            }
            .frame(width: 42, height: 42)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: DS.Space.s) {
                    Text(plan.title).font(.headline).lineLimit(1)
                    Text(plan.enabled ? "进行中" : "已暂停")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(plan.enabled ? DS.ColorToken.success : DS.ColorToken.textTertiary)
                }
                Text(plan.target.content)
                    .font(DS.Typography.secondary)
                    .foregroundStyle(DS.ColorToken.textSecondary)
                    .lineLimit(1)
                HStack(spacing: DS.Space.s) {
                    Label(scheduleLabel(plan.schedule), systemImage: "repeat")
                    if let next = plan.nextRunAt {
                        Text("·")
                        Text("下一次 \(friendlyDateTime(next))")
                    }
                    Text("·")
                    Text(shortTimeZone(plan.schedule.timeZone))
                }
                .font(DS.Typography.caption)
                .foregroundStyle(DS.ColorToken.textTertiary)
            }
            Spacer(minLength: DS.Space.l)
            if busyPlanID == plan.id { ProgressView().controlSize(.small) }
            Menu {
                Button(plan.enabled ? "暂停计划" : "启用计划", systemImage: plan.enabled ? "pause" : "play") {
                    Task { await toggle(plan) }
                }
                Button("编辑", systemImage: "pencil") { editingPlan = plan; showingEditor = true }
                Divider()
                Button("删除", systemImage: "trash", role: .destructive) { deletingPlan = plan }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 17))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("计划操作")
            .accessibilityLabel("\(plan.title) 的操作")
        }
        .padding(.vertical, DS.Space.xs)
        .accessibilityElement(children: .contain)
    }

    private func historySection(_ history: [SchedulerExecution]) -> some View {
        ProductCard(title: "最近执行", subtitle: "紧凑时间线") {
            if history.isEmpty {
                CompactProductEmptyState(icon: "clock.arrow.circlepath", title: "还没有执行记录", message: "计划首次运行后会显示结果。")
            } else {
                ForEach(Array(history.prefix(12))) { item in
                    HStack(alignment: .top, spacing: DS.Space.m) {
                        Image(systemName: historyIcon(item.status))
                            .foregroundStyle(historyColor(item.status))
                            .frame(width: 20)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(item.planTitle).font(.body.weight(.medium))
                                TagChip(text: historyLabel(item.status), tint: historyColor(item.status))
                            }
                            Text(friendlyDateTime(item.scheduledFor))
                                .font(DS.Typography.caption)
                                .foregroundStyle(DS.ColorToken.textTertiary)
                            if let error = item.error, !error.isEmpty {
                                Text(error).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.warning).lineLimit(2)
                            }
                        }
                        Spacer()
                    }
                    if item.id != history.prefix(12).last?.id { Divider() }
                }
            }
        }
    }

    private func openNewPlan() { editingPlan = nil; showingEditor = true }

    private func toggle(_ plan: SchedulerPlan) async {
        busyPlanID = plan.id
        do {
            _ = try await api.setPlanEnabled(id: plan.id, enabled: !plan.enabled)
            errorText = nil
        } catch { errorText = String(describing: error) }
        busyPlanID = nil
        await load()
    }

    private func load() async { do { snapshot = try await api.schedulerSnapshot(); errorText = nil } catch { errorText = String(describing: error) } }
    private func historyIcon(_ status: String) -> String { ["completed":"checkmark.circle.fill","failed":"xmark.circle.fill","interrupted":"pause.circle.fill","skipped":"forward.circle.fill"][status] ?? "clock" }
    private func historyColor(_ status: String) -> Color { status == "completed" ? DS.ColorToken.success : status == "failed" ? DS.ColorToken.danger : DS.ColorToken.warning }
    private func historyLabel(_ status: String) -> String { ["completed":"已完成","failed":"失败","interrupted":"已中断","skipped":"已跳过","running":"执行中"][status] ?? status }

    private func scheduleIcon(_ schedule: SchedulerPlan.Schedule) -> String {
        schedule.type == "once" ? "clock" : scheduleLabel(schedule).hasPrefix("每周") ? "calendar.day.timeline.left" : "repeat"
    }

    private func scheduleLabel(_ schedule: SchedulerPlan.Schedule) -> String {
        guard schedule.type != "once" else { return "一次性" }
        let parts = (schedule.expression ?? "").split(separator: " ").map(String.init)
        guard parts.count == 5, let minute = Int(parts[0]), let hour = Int(parts[1]) else { return "自定义" }
        let time = String(format: "%02d:%02d", hour, minute)
        if parts[2] == "*", parts[3] == "*", parts[4] == "*" { return "每天 \(time)" }
        if parts[2] == "*", parts[3] == "*", let weekday = Int(parts[4]), (0..<7).contains(weekday) {
            let names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
            return "每周\(names[weekday]) \(time)"
        }
        return "自定义"
    }

    private func friendlyDateTime(_ value: String) -> String {
        CompanionTime.naturalDateTime(fromISO8601: value)
    }

    private func shortTimeZone(_ value: String) -> String {
        value == CompanionTime.timeZoneIdentifier ? "北京时间" : value
    }
}

private struct PlanEditorView: View {
    let api: APIClient
    let plan: SchedulerPlan?
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var content = ""
    @State private var mode = "once"
    @State private var date = Date().addingTimeInterval(3600)
    @State private var weekday = CompanionTime.calendar.component(.weekday, from: Date()) - 1
    @State private var customCron = "0 9 * * *"
    @State private var enabled = true
    @State private var errorText: String?
    @State private var saving = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: DS.Space.m) {
                ZStack {
                    RoundedRectangle(cornerRadius: DS.Radius.m).fill(DS.ColorToken.accentSoft)
                    Image(systemName: plan == nil ? "calendar.badge.plus" : "calendar.badge.clock")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(DS.ColorToken.accent)
                }
                .frame(width: 44, height: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(plan == nil ? "新建计划" : "编辑计划").font(.title2.weight(.semibold))
                    Text("Companion 会按北京时间准时执行")
                        .font(DS.Typography.caption)
                        .foregroundStyle(DS.ColorToken.textSecondary)
                }
                Spacer()
            }
            .padding(DS.Space.l)
            .background(DS.Surface.chrome)

            Form {
                Section("计划内容") {
                    TextField("计划名称", text: $title)
                    TextField("提醒内容", text: $content, axis: .vertical).lineLimit(3...8)
                }

                Section("时间安排") {
                    Picker("频率", selection: $mode) {
                        Text("一次性").tag("once")
                        Text("每天").tag("daily")
                        Text("每周").tag("weekly")
                        Text("自定义").tag("custom")
                    }
                    .pickerStyle(.segmented)
                    if mode == "once" {
                        DatePicker("执行时间", selection: $date, displayedComponents: [.date, .hourAndMinute])
                    }
                    if mode == "daily" {
                        DatePicker("每天", selection: $date, displayedComponents: [.hourAndMinute])
                    }
                    if mode == "weekly" {
                        Picker("星期", selection: $weekday) {
                            ForEach(0..<7) { index in Text(CompanionTime.calendar.shortWeekdaySymbols[index]).tag(index) }
                        }
                        DatePicker("时间", selection: $date, displayedComponents: [.hourAndMinute])
                    }
                    if mode == "custom" {
                        DisclosureGroup("高级自定义时间") {
                            VStack(alignment: .leading, spacing: DS.Space.s) {
                                TextField("分 时 日 月 周", text: $customCron)
                                    .font(DS.Typography.mono)
                                Text("仅在标准频率无法表达时使用。")
                                    .font(DS.Typography.caption)
                                    .foregroundStyle(DS.ColorToken.textSecondary)
                            }
                            .padding(.top, DS.Space.s)
                        }
                    }
                    LabeledContent("时区", value: CompanionTime.timeZoneDisplay)
                        .font(DS.Typography.caption)
                        .foregroundStyle(DS.ColorToken.textSecondary)
                }

                Section("状态") {
                    Toggle("启用这个计划", isOn: $enabled)
                }

                if let errorText {
                    Label(errorText, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(DS.ColorToken.danger)
                        .font(DS.Typography.caption)
                }
            }
            .formStyle(.grouped)

            HStack {
                Button("取消") { dismiss() }
                Spacer()
                if saving { ProgressView().controlSize(.small) }
                Button(plan == nil ? "创建计划" : "保存更改") { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(saving || title.trimmingCharacters(in: .whitespaces).isEmpty || content.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(DS.Space.l)
        }
        .frame(width: 560, height: 590)
        .environment(\.timeZone, CompanionTime.timeZone)
        .onAppear { populate() }
    }

    private func populate() {
        guard let plan else { return }
        title = plan.title
        content = plan.target.content
        enabled = plan.enabled
        if plan.schedule.type == "once" {
            mode = "once"
            if let at = plan.schedule.at, let parsed = String.dateFromISO8601(at) { date = parsed }
            return
        }
        customCron = plan.schedule.expression ?? customCron
        let parts = customCron.split(separator: " ").map(String.init)
        guard parts.count == 5, let minute = Int(parts[0]), let hour = Int(parts[1]) else { mode = "custom"; return }
        if parts[2] == "*", parts[3] == "*", parts[4] == "*" {
            mode = "daily"
            applyTime(hour: hour, minute: minute)
        } else if parts[2] == "*", parts[3] == "*", let parsedWeekday = Int(parts[4]), (0..<7).contains(parsedWeekday) {
            mode = "weekly"
            weekday = parsedWeekday
            applyTime(hour: hour, minute: minute)
        } else {
            mode = "custom"
        }
    }

    private func applyTime(hour: Int, minute: Int) {
        date = CompanionTime.calendar.date(bySettingHour: hour, minute: minute, second: 0, of: Date()) ?? date
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let calendar = CompanionTime.calendar, minute = calendar.component(.minute, from: date), hour = calendar.component(.hour, from: date), zone = CompanionTime.timeZoneIdentifier
        let schedule: SchedulerPlan.Schedule
        switch mode {
        case "once": schedule = .init(type: "once", at: ISO8601DateFormatter().string(from: date), timeZone: zone)
        case "daily": schedule = .init(type: "cron", expression: "\(minute) \(hour) * * *", timeZone: zone)
        case "weekly": schedule = .init(type: "cron", expression: "\(minute) \(hour) * * \(weekday)", timeZone: zone)
        default: schedule = .init(type: "cron", expression: customCron, timeZone: zone)
        }
        let draft = SchedulerPlanDraft(title: title, schedule: schedule, target: .init(type: "conversation", content: content), enabled: enabled)
        do {
            if let plan { _ = try await api.updatePlan(id: plan.id, draft: draft) }
            else { _ = try await api.createPlan(draft) }
            errorText = nil
            onSaved()
            dismiss()
        }
        catch { errorText = String(describing: error) }
    }
}

private struct LegacyMemoryBrainProductView: View {
    @StateObject private var model: MemoryBrainViewModel
    @State private var zoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var dragOrigin: CGSize = .zero
    @State private var zoomOrigin: CGFloat = 1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    init(api: APIClient) { _model = StateObject(wrappedValue: MemoryBrainViewModel(api: api)) }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                toolbar
                GeometryReader { proxy in
                    let positions = layout(in: proxy.size, nodes: model.visibleNodes)
                    ZStack {
                        MemoryAtmosphereBackground()
                        Canvas { context, _ in
                            guard let snapshot = model.snapshot else { return }
                            for edge in snapshot.edges {
                                guard let start = positions[edge.source], let end = positions[edge.target] else { continue }
                                var path = Path()
                                path.move(to: transformed(start, in: proxy.size))
                                path.addLine(to: transformed(end, in: proxy.size))
                                context.stroke(
                                    path,
                                    with: .color(DS.ColorToken.accent.opacity(0.28)),
                                    lineWidth: max(0.8, CGFloat(edge.weight ?? 1))
                                )
                            }
                        }
                        .accessibilityHidden(true)

                        ForEach(model.visibleNodes) { node in
                            if let point = positions[node.id] {
                                BrainNodeView(
                                    node: node,
                                    selected: model.selectedID == node.id,
                                    searchHighlighted: !model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                                    reduceMotion: reduceMotion
                                ) {
                                    withAnimation(DS.Motion.animation(.normal, reduceMotion: reduceMotion)) {
                                        model.selectedID = node.id
                                    }
                                }
                                    .position(transformed(point, in: proxy.size))
                            }
                        }

                        if model.visibleNodes.isEmpty {
                            CompanionStateView(
                                kind: model.isLoading ? .loading : .empty,
                                title: model.isLoading ? "正在整理记忆空间" : "没有匹配的记忆",
                                message: model.isLoading ? "只读取真实记忆与真实关联。" : "清除搜索即可查看全部真实节点。"
                            )
                        }

                        if let error = model.errorText, !model.isLoading, model.snapshot == nil {
                            CompanionGlassPanel(style: .prominent) {
                                CompanionStateView(kind: .error, title: "记忆空间暂时不可用", message: error, actionTitle: "重试") {
                                    Task { await model.load() }
                                }
                            }
                            .frame(maxWidth: 480)
                        }

                        VStack {
                            Spacer()
                            HStack {
                                Label("拖动平移 · 双指缩放", systemImage: "hand.draw")
                                Spacer()
                                if let snapshot = model.snapshot, snapshot.edges.isEmpty {
                                    Label("当前没有真实关联线", systemImage: "point.3.connected.trianglepath.dotted")
                                }
                            }
                            .font(DS.Typography.caption)
                            .foregroundStyle(DS.ColorToken.textTertiary)
                            .padding(.horizontal, DS.Space.l)
                            .padding(.vertical, DS.Space.s)
                            .background(.ultraThinMaterial, in: Capsule())
                            .padding(DS.Space.l)
                        }
                    }
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture()
                            .onChanged { value in
                                offset = CGSize(width: dragOrigin.width + value.translation.width, height: dragOrigin.height + value.translation.height)
                            }
                            .onEnded { _ in dragOrigin = offset }
                    )
                    .simultaneousGesture(
                        MagnificationGesture()
                            .onChanged { value in zoom = min(2.5, max(0.65, zoomOrigin * value)) }
                            .onEnded { _ in zoomOrigin = zoom }
                    )
                    .onTapGesture(count: 2, perform: resetViewport)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            inspector
                .frame(width: 350)
        }
        .task { await model.load() }
    }

    private var toolbar: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: DS.Space.s) {
                memorySearchControls
                Spacer(minLength: DS.Space.m)
                memoryStats
            }
            VStack(alignment: .leading, spacing: DS.Space.s) {
                memorySearchControls
                memoryStats
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.horizontal, DS.Space.l)
        .padding(.vertical, DS.Space.m)
        .background(DS.Surface.chrome)
        .overlay(alignment: .bottom) { Rectangle().fill(DS.ColorToken.separator).frame(height: 0.5) }
    }

    private var memorySearchControls: some View {
        HStack(spacing: DS.Space.s) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(DS.ColorToken.textTertiary)
                .accessibilityHidden(true)
            TextField("搜索真实记忆…", text: $model.query)
                .textFieldStyle(.plain)
                .frame(minWidth: 180, idealWidth: 260, maxWidth: 320)
                .onSubmit { Task { await model.load(); await model.previewRecall() } }
            Button("搜索") { Task { await model.load(); await model.previewRecall() } }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            Button(action: resetViewport) { Label("复位视图", systemImage: "arrow.counterclockwise") }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .help("复位缩放与位置")
        }
    }

    @ViewBuilder private var memoryStats: some View {
        if let snapshot = model.snapshot {
            HStack(spacing: DS.Space.s) {
                Label("\(snapshot.nodes.count) 段记忆", systemImage: "circle.hexagongrid")
                Text("·")
                Text("\(snapshot.edges.count) 条真实关联")
            }
            .font(DS.Typography.caption)
            .foregroundStyle(DS.ColorToken.textSecondary)
            .fixedSize(horizontal: true, vertical: false)
        }
    }

    private var inspector: some View {
        ScrollView {
            if let node = model.selectedNode {
                VStack(alignment: .leading, spacing: DS.Space.xl) {
                    VStack(alignment: .leading, spacing: DS.Space.m) {
                        Text("记忆详情")
                            .font(DS.Typography.eyebrow)
                            .foregroundStyle(DS.ColorToken.textTertiary)
                            .tracking(0.8)
                        Text(node.content)
                            .font(.title3.weight(.medium))
                            .lineSpacing(3)
                            .textSelection(.enabled)
                        HStack {
                            TagChip(text: kindLabel(node.kind), tint: .blue)
                            TagChip(text: temporalLabel(node.temporalState), tint: node.temporalState == "historical" ? .gray : .green)
                            if node.pinned { TagChip(text: "已固定", tint: .orange) }
                        }
                    }

                    CompanionGlassPanel(style: .subtle, contentPadding: DS.Space.m) {
                        VStack(spacing: DS.Space.s) {
                            inspectorRow("状态", stateLabel(node.stateFamily))
                            inspectorRow("记忆层", layerLabel(node.representationLayer))
                            inspectorRow("记录于", friendlyMemoryDate(node.createdAt))
                            inspectorRow("最近更新", friendlyMemoryDate(node.updatedAt))
                        }
                    }

                    CompanionSectionHeader("证据与来源", systemImage: "checkmark.seal")
                    ForEach(node.evidence) { evidence in
                        HStack(alignment: .top, spacing: DS.Space.s) {
                            Image(systemName: evidence.mode == "explicit" ? "checkmark.seal.fill" : "wand.and.stars")
                                .foregroundStyle(DS.ColorToken.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(evidence.source).font(.body.weight(.medium))
                                Text(friendlyMemoryDate(evidence.recordedAt))
                                    .font(DS.Typography.caption)
                                    .foregroundStyle(DS.ColorToken.textTertiary)
                            }
                        }
                    }

                    CompanionSectionHeader("相关记忆", subtitle: "只展示真实关联", systemImage: "link")
                    if model.relatedNodes.isEmpty {
                        CompactProductEmptyState(icon: "link.badge.plus", title: "尚无真实关联", message: "这不是错误，也不会为了视觉效果生成连接线。")
                    } else {
                        ForEach(model.relatedNodes) { item in
                            Button {
                                withAnimation(DS.Motion.animation(.normal, reduceMotion: reduceMotion)) { model.selectedID = item.id }
                            } label: {
                                HStack {
                                    Text(item.title).lineLimit(2)
                                    Spacer()
                                    Image(systemName: "arrow.right")
                                }
                            }
                            .buttonStyle(.plain)
                            .padding(DS.Space.s)
                            .background(DS.ColorToken.surfaceSecondary, in: RoundedRectangle(cornerRadius: DS.Radius.s))
                        }
                    }

                    recallPreview
                }
                .padding(DS.Space.l)
            } else {
                CompanionStateView(kind: .empty, title: "选择一段记忆", message: "内容、证据、来源与真实关联会显示在这里。")
                    .frame(maxWidth: .infinity, minHeight: 420)
            }
        }
        .background(DS.ColorToken.inspector)
    }

    private func layout(in size: CGSize, nodes: [MemoryBrainResponse.Node]) -> [String: CGPoint] {
        guard !nodes.isEmpty else { return [:] }
        let safeWidth = max(120, size.width - 220)
        let safeHeight = max(120, size.height - 180)
        let center = CGPoint(x: size.width / 2, y: size.height / 2)

        if nodes.count == 1 { return [nodes[0].id: center] }
        if nodes.count == 2 {
            return [
                nodes[0].id: CGPoint(x: center.x - safeWidth * 0.23, y: center.y),
                nodes[1].id: CGPoint(x: center.x + safeWidth * 0.23, y: center.y)
            ]
        }
        if nodes.count == 3 {
            let horizontalOffset = min(
                max(76, safeWidth * 0.36),
                max(60, size.width / 2 - 80)
            )
            return [
                nodes[0].id: CGPoint(x: center.x, y: center.y - safeHeight * 0.24),
                nodes[1].id: CGPoint(x: center.x - horizontalOffset, y: center.y + safeHeight * 0.20),
                nodes[2].id: CGPoint(x: center.x + horizontalOffset, y: center.y + safeHeight * 0.20)
            ]
        }

        let radius = max(90, min(safeWidth, safeHeight) * 0.42)
        return Dictionary(uniqueKeysWithValues: nodes.enumerated().map { index, node in
            let angle = Double(index) / Double(nodes.count) * Double.pi * 2 - Double.pi / 2
            let tier = CGFloat(index % 3) / 10
            let ring = radius * (0.78 + tier)
            return (node.id, CGPoint(x: center.x + cos(angle) * ring, y: center.y + sin(angle) * ring))
        })
    }

    private func transformed(_ point: CGPoint, in size: CGSize) -> CGPoint {
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        return CGPoint(
            x: center.x + (point.x - center.x) * zoom + offset.width,
            y: center.y + (point.y - center.y) * zoom + offset.height
        )
    }

    private var recallPreview: some View {
        let query = model.query.trimmingCharacters(in: .whitespacesAndNewlines)
        return Group {
            if !query.isEmpty {
                VStack(alignment: .leading, spacing: DS.Space.m) {
                    CompanionSectionHeader("测试召回", subtitle: "查询“\(query)”的只读预览", systemImage: "scope")
                    if model.recallRows.isEmpty {
                        CompactProductEmptyState(icon: "scope", title: "没有召回结果", message: "换一个关键词再次测试。")
                    } else {
                        ForEach(model.recallRows.prefix(6)) { row in
                            VStack(alignment: .leading, spacing: DS.Space.xs) {
                                HStack {
                                    Text(row.content).font(.body.weight(.medium)).lineLimit(2)
                                    Spacer()
                                    Text(row.finalScore.formatted(.number.precision(.fractionLength(2))))
                                        .font(.system(.caption, design: .rounded).weight(.semibold))
                                        .foregroundStyle(DS.ColorToken.accent)
                                }
                                if !row.reasons.isEmpty {
                                    Text(row.reasons.joined(separator: " · "))
                                        .font(DS.Typography.caption)
                                        .foregroundStyle(DS.ColorToken.textTertiary)
                                        .lineLimit(2)
                                }
                            }
                            .padding(DS.Space.s)
                            .background(DS.ColorToken.surfaceSecondary, in: RoundedRectangle(cornerRadius: DS.Radius.s))
                        }
                    }
                }
            }
        }
    }

    private func resetViewport() {
        withAnimation(DS.Motion.animation(.normal, reduceMotion: reduceMotion)) {
            zoom = 1
            zoomOrigin = 1
            offset = .zero
            dragOrigin = .zero
        }
    }

    private func inspectorRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(DS.ColorToken.textSecondary)
            Spacer()
            Text(value).multilineTextAlignment(.trailing)
        }
        .font(DS.Typography.caption)
    }

    private func kindLabel(_ value: String) -> String {
        ["fact": "事实", "preference": "偏好", "relationship": "关系", "event": "事件"][value] ?? value
    }

    private func temporalLabel(_ value: String) -> String {
        ["current": "当前", "historical": "历史", "future": "未来"][value] ?? value
    }

    private func stateLabel(_ value: String) -> String {
        ["not_applicable": "稳定", "active": "正在使用", "staging": "待确认", "historical": "历史"][value] ?? value.replacingOccurrences(of: "_", with: " ")
    }

    private func layerLabel(_ value: String) -> String {
        ["reported": "明确告诉我的", "inferred": "从上下文理解", "observed": "从互动中记录"][value] ?? value
    }

    private func friendlyMemoryDate(_ value: String?) -> String {
        guard let value else { return "时间未知" }
        return CompanionTime.naturalDateTime(fromISO8601: value)
    }
}

private struct BrainNodeView: View {
    let node: MemoryBrainResponse.Node
    let selected: Bool
    let searchHighlighted: Bool
    let reduceMotion: Bool
    let onSelect: () -> Void
    @State private var hovering = false
    @FocusState private var focused: Bool

    private var normalizedImportance: CGFloat {
        CGFloat(min(1, max(0, node.importance)))
    }

    private var nodeWidth: CGFloat {
        120 + normalizedImportance * 28
    }

    private var iconSize: CGFloat {
        22 + normalizedImportance * 5
    }

    private var iconTint: Color {
        selected || searchHighlighted ? DS.ColorToken.accent : DS.ColorToken.textSecondary
    }

    private var borderTint: Color {
        if selected || focused { return DS.ColorToken.focusRing }
        if searchHighlighted { return DS.ColorToken.accent.opacity(0.42) }
        return DS.ColorToken.glassBorder
    }

    var body: some View {
        Button(action: onSelect) {
            VStack(spacing: DS.Space.s) {
                Image(systemName: nodeIcon)
                    .font(.system(size: iconSize, weight: .medium))
                    .foregroundStyle(iconTint)
                Text(node.title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .frame(width: nodeWidth - 24)
            }
            .padding(.horizontal, DS.Space.m)
            .padding(.vertical, DS.Space.m)
            .frame(width: nodeWidth)
            .frame(minHeight: 78)
            .background(
                selected ? AnyShapeStyle(DS.ColorToken.surfaceElevated) : AnyShapeStyle(DS.Surface.glass),
                in: RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous)
                    .strokeBorder(borderTint, lineWidth: selected || focused ? 2 : 1)
            )
            .shadow(color: selected ? DS.ColorToken.accent.opacity(0.24) : .black.opacity(hovering ? 0.12 : 0.07),
                    radius: selected ? 18 : hovering ? 10 : 6,
                    y: selected ? 4 : 2)
            .scaleEffect(selected ? 1.06 : hovering ? 1.025 : 1)
            .opacity(node.temporalState == "historical" ? 0.68 : 1)
        }
        .buttonStyle(.plain)
        .focused($focused)
        .onHover { value in withAnimation(DS.Motion.animation(.fast, reduceMotion: reduceMotion)) { hovering = value } }
        .animation(DS.Motion.animation(.normal, reduceMotion: reduceMotion), value: selected)
        .accessibilityLabel("\(node.title)，\(node.kind)，\(node.temporalState)")
        .accessibilityValue(selected ? "已选择" : "未选择")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .help(node.preview)
    }

    private var nodeIcon: String {
        switch node.kind {
        case "preference": return "heart.fill"
        case "relationship": return "person.2.fill"
        case "event": return "calendar.badge.clock"
        default: return "circle.hexagongrid.fill"
        }
    }
}

private struct MemoryAtmosphereBackground: View {
    var body: some View {
        ZStack {
            DS.ColorToken.windowBackground
            RadialGradient(colors: [Color.accentColor.opacity(0.15), Color.clear], center: .topLeading, startRadius: 30, endRadius: 560)
            RadialGradient(colors: [Color.cyan.opacity(0.08), Color.clear], center: .bottomTrailing, startRadius: 40, endRadius: 520)
            Canvas { context, size in
                let color = DS.ColorToken.textTertiary.opacity(0.11)
                for x in stride(from: 20.0, through: size.width, by: 34.0) {
                    for y in stride(from: 20.0, through: size.height, by: 34.0) {
                        context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.4, height: 1.4)), with: .color(color))
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }
}

struct MemoryProductView: View {
    let api: APIClient
    @State private var section = "brain"

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $section) {
                Text("记忆空间").tag("brain")
                Text("管理 · 高级").tag("manage")
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 420)
            .padding(DS.Space.m)
            .frame(maxWidth: .infinity)
            .background(DS.Surface.chrome)
            .overlay(alignment: .bottom) { Rectangle().fill(DS.ColorToken.separator).frame(height: 0.5) }
            if section == "manage" {
                MemoryCenterView(api: api)
            } else {
                MemoryBrainProductView(api: api)
            }
        }
    }
}

struct CapabilitiesProductView: View {
    let api: APIClient
    @Binding var developerMode: Bool
    var refreshTrigger: Int
    @State private var section="overview"
    var body: some View {
        VStack(spacing: 0) {
            Picker("",selection:$section) {
                Text("能力中心").tag("overview")
                Text("连接与模块 · 高级").tag("management")
                Text("Agent 历史 · 高级").tag("agent")
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 620)
            .padding(DS.Space.m)
            .frame(maxWidth: .infinity)
            .background(DS.Surface.chrome)
            .overlay(alignment: .bottom) { Rectangle().fill(DS.ColorToken.separator).frame(height: 0.5) }
            if section=="agent" {
                AgentTabView(api:api,developerMode:$developerMode,refreshTrigger:refreshTrigger)
            } else if section=="management" {
                IntegrationsCenterView(api:api)
            } else { CapabilityRegistryProductView(api: api, refreshTrigger: refreshTrigger) }
        }
    }
}

private struct CapabilityRegistryProductView: View {
    let api: APIClient
    let refreshTrigger: Int
    @State private var snapshot: CapabilityProductSnapshot?
    @State private var errorText: String?
    @State private var installerPermission: SessionPermissionRequest?
    @State private var installerMessage: String?
    @State private var computerUseBusy = false
    @State private var macPermissions = ComputerUsePermissionService.current()
    private let categories: [(source: String, title: String, subtitle: String, icon: String, tint: Color)] = [
        ("Perception", "感知", "搜索、天气与环境信息", "eye", .blue),
        ("Action", "行动", "在得到允许后执行操作", "hand.tap", .orange),
        ("Creation", "创作", "生成图片与其他内容", "wand.and.stars", .purple),
        ("Communication", "沟通", "连接人与外部服务", "bubble.left.and.bubble.right", .green),
        ("System / Advanced", "系统", "本地运行与高级能力", "cpu", .gray)
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Space.xl) {
                if let snapshot {
                    capabilityHero(snapshot)
                    ForEach(categories, id: \.source) { category in
                        let rows = snapshot.data.filter { $0.category == category.source }
                        if !rows.isEmpty {
                            CompanionCard(title: category.title, subtitle: category.subtitle, systemImage: category.icon) {
                                ForEach(rows) { item in
                                    capabilityRow(item, tint: category.tint)
                                    if item.id != rows.last?.id { Divider() }
                                }
                            }
                        }
                    }
                    if snapshot.data.isEmpty {
                        CompanionStateView(kind: .empty, title: "还没有可用能力", message: "可在高级连接中启用模块或连接服务。")
                            .frame(maxWidth: .infinity, minHeight: 320)
                    }
                    Text("能力状态来自 Companion Capability Registry，页面不维护第二份清单。")
                        .font(DS.Typography.caption)
                        .foregroundStyle(DS.ColorToken.textTertiary)
                        .frame(maxWidth: .infinity, alignment: .center)
                } else if let errorText {
                    CompanionStateView(kind: .error, title: "能力状态暂时不可用", message: errorText, actionTitle: "重试") { Task { await load() } }
                        .frame(maxWidth: .infinity, minHeight: 420)
                } else {
                    CompanionStateView(kind: .loading, title: "正在检查 Companion 的能力", message: "读取配置、权限与连接状态。")
                        .frame(maxWidth: .infinity, minHeight: 420)
                }
            }
            .frame(maxWidth: 1080)
            .frame(maxWidth: .infinity)
            .padding(DS.Space.xl)
        }
        .task(id: refreshTrigger) { await load() }
    }

    private func capabilityHero(_ snapshot: CapabilityProductSnapshot) -> some View {
        let ready = snapshot.data.filter { $0.enabled && $0.configured }.count
        let setup = snapshot.data.filter { !$0.configured }.count
        let approval = snapshot.data.filter(\.requiresApproval).count
        return VStack(alignment: .leading, spacing: DS.Space.l) {
            HStack {
                VStack(alignment: .leading, spacing: DS.Space.s) {
                    Text("Companion 能为你做什么")
                        .font(.system(size: 27, weight: .semibold, design: .rounded))
                    Text("能力按用途组织；技术来源与权限细节按需展开。")
                        .font(DS.Typography.secondary)
                        .foregroundStyle(DS.ColorToken.textSecondary)
                }
                Spacer()
                Image(systemName: "sparkles.rectangle.stack")
                    .font(.system(size: 48, weight: .light))
                    .foregroundStyle(DS.ColorToken.accent.opacity(0.68))
                    .accessibilityHidden(true)
            }
            HStack(spacing: DS.Space.l) {
                capabilitySummary("已注册", "\(snapshot.data.count)", icon: "square.stack.3d.up")
                capabilitySummary("可用", "\(ready)", icon: "checkmark.seal.fill", tint: DS.ColorToken.success)
                capabilitySummary("需要配置", "\(setup)", icon: "slider.horizontal.3", tint: setup > 0 ? DS.ColorToken.warning : DS.ColorToken.textTertiary)
                capabilitySummary("操作前确认", "\(approval)", icon: "hand.raised.fill", tint: DS.ColorToken.warning)
            }
        }
        .padding(DS.Space.xxl)
        .background(
            LinearGradient(colors: [Color.accentColor.opacity(0.14), DS.ColorToken.surfaceElevated.opacity(0.86)], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous)
        )
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous).strokeBorder(DS.ColorToken.glassBorder))
    }

    private func capabilitySummary(_ title: String, _ value: String, icon: String, tint: Color = DS.ColorToken.accent) -> some View {
        HStack(spacing: DS.Space.s) {
            Image(systemName: icon).foregroundStyle(tint).frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(value).font(.system(.title3, design: .rounded).weight(.semibold))
                Text(title).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func capabilityRow(_ item: CapabilityProductSnapshot.Item, tint: Color) -> some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: DS.Space.s) {
                if item.id == "computer.use" { computerUseDetail(item) }
                technicalRow("能力 ID", item.name, monospaced: true)
                technicalRow("提供方", providerLabel(item.provider))
                if !item.scope.isEmpty { technicalRow("范围", item.scope.joined(separator: " · ")) }
                if !item.permission.isEmpty { technicalRow("权限", item.permission.joined(separator: " · ")) }
                technicalRow("健康状态", healthLabel(item.health))
                if let last = item.lastStatus, !last.isEmpty {
                    Text(last)
                        .font(DS.Typography.caption)
                        .foregroundStyle(DS.ColorToken.warning)
                        .lineLimit(3)
                }
            }
            .padding(.top, DS.Space.s)
            .padding(.leading, 40)
        } label: {
            HStack(alignment: .top, spacing: DS.Space.m) {
                ZStack {
                    RoundedRectangle(cornerRadius: DS.Radius.s, style: .continuous)
                        .fill(tint.opacity(0.11))
                    Image(systemName: capabilityIcon(item))
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(tint)
                }
                .frame(width: 34, height: 34)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: DS.Space.s) {
                        Text(friendlyCapabilityName(item)).font(.body.weight(.semibold))
                        capabilityStatus(item)
                        if item.requiresApproval {
                            Label("操作前确认", systemImage: "hand.raised")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(DS.ColorToken.warning)
                        }
                    }
                    Text(item.description)
                        .font(DS.Typography.secondary)
                        .foregroundStyle(DS.ColorToken.textSecondary)
                        .lineLimit(2)
                }
            }
            .padding(.vertical, DS.Space.xs)
        }
        .tint(DS.ColorToken.textTertiary)
        .accessibilityElement(children: .contain)
    }

    private func capabilityStatus(_ item: CapabilityProductSnapshot.Item) -> some View {
        let label: String
        let tint: Color
        if item.id == "computer.use" && item.installed != true { label = item.health == "error" ? "安装错误" : "未安装"; tint = item.health == "error" ? DS.ColorToken.danger : DS.ColorToken.warning }
        else if item.id == "computer.use" && !macPermissions.ready { label = "需要 macOS 权限"; tint = DS.ColorToken.warning }
        else if !item.enabled { label = "已关闭"; tint = DS.ColorToken.textTertiary }
        else if !item.configured { label = "需要配置"; tint = DS.ColorToken.warning }
        else { label = "可用"; tint = DS.ColorToken.success }
        return Label(label, systemImage: item.enabled && item.configured ? "checkmark.circle.fill" : "circle.dashed")
            .font(.caption2.weight(.medium))
            .foregroundStyle(tint)
    }

    private func technicalRow(_ label: String, _ value: String, monospaced: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(DS.ColorToken.textTertiary)
            Spacer()
            Text(value).font(monospaced ? DS.Typography.mono : DS.Typography.caption).multilineTextAlignment(.trailing)
        }
        .font(DS.Typography.caption)
    }

    private func friendlyCapabilityName(_ item: CapabilityProductSnapshot.Item) -> String {
        let names = [
            "web_search": "联网搜索", "get_current_weather": "当前天气", "get_daily_forecast": "三日天气预报",
            "get_hourly_forecast": "逐小时天气", "get_generation_status": "图片生成进度", "browser_close": "关闭网页",
            "browser_resize": "调整浏览器窗口", "browser_handle_dialog": "处理网页对话框", "browser_evaluate": "运行网页脚本",
            "browser_file_upload": "向网页上传文件", "browser_drop": "拖放网页内容", "browser_find": "查找网页内容",
            "browser_fill_form": "填写网页表单", "browser_click": "点击网页控件", "browser_navigate": "打开网页",
            "browser_snapshot": "读取网页结构", "browser_take_screenshot": "截取网页画面", "browser_press_key": "按下网页按键",
            "browser_type": "输入网页文字", "browser_go_back": "返回上一页", "browser_network_requests": "查看网页请求",
            "browser_drag": "拖动网页控件", "browser_hover": "悬停网页控件", "browser_select_option": "选择网页选项",
            "browser_tabs": "管理网页标签", "browser_wait_for": "等待网页内容", "notion_search": "搜索 Notion",
            "notion_fetch": "读取 Notion 内容", "notion_create_pages": "创建 Notion 页面", "notion_update_page": "更新 Notion 页面",
            "notion_create_database": "创建 Notion 数据库", "notion_create_comment": "添加 Notion 评论"
        ]
        if item.id == "computer.use" { return "Computer Use" }
        let normalizedName = item.name.lowercased().replacingOccurrences(of: "-", with: "_")
        if let value = names[normalizedName] { return value }
        return item.name.split(separator: "_").map { $0.capitalized }.joined(separator: " ")
    }

    private func capabilityIcon(_ item: CapabilityProductSnapshot.Item) -> String {
        if item.id == "computer.use" { return "macwindow.and.cursorarrow" }
        if item.name.hasPrefix("browser_") { return "safari" }
        if item.name.contains("weather") || item.name.contains("forecast") { return "cloud.sun" }
        if item.name.contains("search") { return "magnifyingglass" }
        if item.name.contains("generation") || item.name.contains("image") { return "photo.on.rectangle.angled" }
        return "sparkle"
    }

    private func providerLabel(_ value: String) -> String {
        if value.lowercased() == "cua" { return "Cua Driver" }
        if value.lowercased().contains("playwright") { return "浏览器自动化" }
        if value.lowercased().contains("companion") { return "Companion" }
        return value
    }

    private func healthLabel(_ value: String) -> String {
        ["ready": "正常", "installed": "已安装", "not_installed": "未安装", "error": "错误", "available": "可用", "connected": "已连接", "unconfigured": "未配置", "disabled": "已关闭"][value] ?? value
    }

    @ViewBuilder private func computerUseDetail(_ item: CapabilityProductSnapshot.Item) -> some View {
        VStack(alignment: .leading, spacing: DS.Space.m) {
            if let message = installerMessage, !message.isEmpty {
                Label(message, systemImage: computerUseBusy ? "arrow.triangle.2.circlepath" : "info.circle")
                    .font(DS.Typography.caption).foregroundStyle(computerUseBusy ? DS.ColorToken.accent : DS.ColorToken.textSecondary)
            }
            if let request = installerPermission {
                PermissionApprovalCard(request: request, maxWidth: 720,
                    onAllowOnce: { resolveInstaller(request, action: "allow_once") },
                    onAllowSession: { resolveInstaller(request, action: "allow_session") },
                    onDeny: { resolveInstaller(request, action: "deny") })
            } else if item.installed != true {
                Button { installComputerUse() } label: {
                    Label(computerUseBusy ? "正在检查…" : "安装", systemImage: "arrow.down.app")
                }.buttonStyle(.borderedProminent).disabled(computerUseBusy)
            } else {
                HStack(spacing: DS.Space.s) {
                    Button("测试") { testComputerUse() }.buttonStyle(.bordered).disabled(computerUseBusy)
                    Button(item.enabled ? "停用" : "启用") { setComputerUseEnabled(!item.enabled) }.buttonStyle(.bordered).disabled(computerUseBusy)
                    Button("卸载", role: .destructive) { uninstallComputerUse() }.buttonStyle(.bordered).disabled(computerUseBusy)
                }
                if !macPermissions.ready {
                    VStack(alignment: .leading, spacing: DS.Space.s) {
                        Label("需要 macOS 授权", systemImage: "hand.raised.fill").font(.subheadline.weight(.semibold)).foregroundStyle(DS.ColorToken.warning)
                        permissionRow("辅助功能", granted: macPermissions.accessibility, action: {
                            _ = ComputerUsePermissionService.requestAccessibility(); ComputerUsePermissionService.openAccessibilitySettings(); refreshMacPermissions()
                        })
                        permissionRow("屏幕录制", granted: macPermissions.screenRecording, action: {
                            _ = ComputerUsePermissionService.requestScreenRecording(); ComputerUsePermissionService.openScreenRecordingSettings(); refreshMacPermissions()
                        })
                        Button("重新检查") { refreshMacPermissions() }.buttonStyle(.borderless)
                    }
                    .padding(DS.Space.m)
                    .background(DS.ColorToken.warning.opacity(0.07), in: RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous))
                }
            }
            if let version = item.version { technicalRow("Backend", "Cua \(version)") }
            if let commit = item.upstreamCommit { technicalRow("Upstream commit", String(commit.prefix(12)), monospaced: true) }
            if let source = item.sourceUrl { technicalRow("Source", source) }
            if let license = item.license { technicalRow("License", license) }
            if let lastTest = item.lastTest { technicalRow("最近测试", CompanionTime.naturalDateTime(fromISO8601: lastTest)) }
        }
        .padding(.bottom, DS.Space.s)
    }

    private func permissionRow(_ title: String, granted: Bool, action: @escaping () -> Void) -> some View {
        HStack {
            Label(title, systemImage: granted ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(granted ? DS.ColorToken.success : DS.ColorToken.warning)
            Spacer()
            if !granted { Button("前往授权", action: action).buttonStyle(.bordered).controlSize(.small) }
        }.accessibilityElement(children: .combine).accessibilityLabel("\(title)，\(granted ? "已授权" : "需要授权")")
    }

    private func installComputerUse() {
        computerUseBusy = true; installerMessage = "正在检查兼容性"
        Task { do { let response = try await api.installComputerUse(); installerPermission = response.request; installerMessage = response.request == nil ? "正在安装 Computer Use" : "等待你的安装批准"; computerUseBusy = response.request == nil; if response.request == nil { await waitForComputerUseTerminal() } } catch { installerMessage = String(describing: error); computerUseBusy = false } }
    }

    private func uninstallComputerUse() {
        computerUseBusy = true; installerMessage = "正在准备卸载"
        Task { do { let response = try await api.uninstallComputerUse(); installerPermission = response.request; installerMessage = response.request == nil ? "正在卸载" : "等待你的卸载批准"; computerUseBusy = response.request == nil; if response.request == nil { await waitForComputerUseTerminal(expectInstalled: false) } } catch { installerMessage = String(describing: error); computerUseBusy = false } }
    }

    private func resolveInstaller(_ request: SessionPermissionRequest, action: String) {
        installerPermission = nil; computerUseBusy = action != "deny"; installerMessage = action == "deny" ? "已拒绝" : "已批准，正在执行受控安装事务"
        Task { do { _ = try await api.resolveSessionPermission(sessionID: request.sessionId, requestID: request.requestId, action: action); if action != "deny" { await waitForComputerUseTerminal(expectInstalled: !request.capabilityId.contains("uninstall")) } } catch { installerMessage = String(describing: error); computerUseBusy = false } }
    }

    private func waitForComputerUseTerminal(expectInstalled: Bool = true) async {
        for _ in 0..<600 {
            do {
                let current = try await api.computerUseStatus()
                if current.status.installed == expectInstalled || current.status.health == "error" {
                    installerMessage = current.status.health == "error" ? (current.status.lastError ?? "操作失败") : (expectInstalled ? "Computer Use 已安装，正在检查 macOS 权限" : "Computer Use 已卸载")
                    computerUseBusy = false; refreshMacPermissions(); await load(); return
                }
            } catch { installerMessage = String(describing: error); computerUseBusy = false; return }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if Task.isCancelled { computerUseBusy = false; return }
        }
        installerMessage = "操作仍在进行，请稍后重新检查"; computerUseBusy = false
    }

    private func testComputerUse() { computerUseBusy = true; installerMessage = "正在测试"; Task { do { _ = try await api.testComputerUse(); installerMessage = "自检通过"; refreshMacPermissions(); await load() } catch { installerMessage = String(describing: error) }; computerUseBusy = false } }
    private func setComputerUseEnabled(_ enabled: Bool) { computerUseBusy = true; Task { do { _ = try await api.setComputerUseEnabled(enabled); installerMessage = enabled ? "已启用" : "已停用"; await load() } catch { installerMessage = String(describing: error) }; computerUseBusy = false } }
    private func refreshMacPermissions() { macPermissions = ComputerUsePermissionService.current() }

    private func load() async {
        do { snapshot = try await api.capabilityProductSnapshot(); errorText = nil; refreshMacPermissions() }
        catch { errorText = String(describing: error) }
    }
}

struct UsageProductView: View {
    let api: APIClient
    @State private var snapshot: UsageLedgerSnapshot?
    @State private var errorText: String?
    @State private var showingPrice = false
    @State private var scope = "today"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Space.xl) {
                if let snapshot {
                    usageHero(snapshot)

                    HStack(alignment: .top, spacing: DS.Space.l) {
                        breakdownCard("模型", subtitle: "按请求量", rows: snapshot.models, tint: .blue)
                        breakdownCard("功能", subtitle: "请求来自哪里", rows: snapshot.features, tint: .purple)
                    }

                    recentInvocations(snapshot.recent)
                } else if let errorText {
                    CompanionStateView(kind: .error, title: "用量暂时不可用", message: errorText, actionTitle: "重试") { Task { await load() } }
                        .frame(maxWidth: .infinity, minHeight: 420)
                } else {
                    CompanionStateView(kind: .loading, title: "正在读取用量", message: "不会发起任何模型请求。")
                        .frame(maxWidth: .infinity, minHeight: 420)
                }
            }
            .frame(maxWidth: 1080)
            .frame(maxWidth: .infinity)
            .padding(DS.Space.xl)
        }
        .task { await load() }
        .sheet(isPresented:$showingPrice) { UsagePriceSheet(api:api) { Task { await load() } } }
    }

    private func usageHero(_ snapshot: UsageLedgerSnapshot) -> some View {
        let metric = scope == "today" ? snapshot.today : snapshot.month
        return VStack(alignment: .leading, spacing: DS.Space.l) {
            HStack {
                VStack(alignment: .leading, spacing: DS.Space.xs) {
                    Text("真实使用情况")
                        .font(.system(size: 27, weight: .semibold, design: .rounded))
                    Text("请求、Tokens 与已记录成本；未定价不会显示为 $0。")
                        .font(DS.Typography.secondary)
                        .foregroundStyle(DS.ColorToken.textSecondary)
                }
                Spacer()
                Picker("范围", selection: $scope) {
                    Text("今天").tag("today")
                    Text("本月").tag("month")
                }
                .pickerStyle(.segmented)
                .frame(width: 180)
                Button { showingPrice = true } label: { Label("价格配置", systemImage: "dollarsign.circle") }
                    .buttonStyle(.borderless)
                    .controlSize(.small)
                    .help("配置新的价格版本")
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: DS.Space.m), count: 5), spacing: DS.Space.m) {
                CompanionMetricTile(title: "请求", value: compact(metric.requests), subtitle: scope == "today" ? "今天" : "本月", systemImage: "arrow.up.arrow.down")
                CompanionMetricTile(title: "输入", value: token(metric.inputTokens), subtitle: cachedSubtitle(metric.cachedInputTokens), systemImage: "arrow.down.left")
                CompanionMetricTile(title: "输出", value: token(metric.outputTokens), subtitle: "Tokens", systemImage: "arrow.up.right", tint: .purple)
                CompanionMetricTile(title: "推理", value: token(metric.reasoningTokens), subtitle: "Tokens", systemImage: "brain", tint: .indigo)
                CompanionMetricTile(title: "成本", value: metricCost(metric), subtitle: costSubtitle(metric), systemImage: "dollarsign", tint: metric.unpriced > 0 || metric.unknownUsage > 0 ? DS.ColorToken.warning : DS.ColorToken.success)
            }
        }
        .padding(DS.Space.xxl)
        .background(
            LinearGradient(colors: [Color.accentColor.opacity(0.13), DS.ColorToken.surfaceElevated.opacity(0.88)], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous)
        )
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous).strokeBorder(DS.ColorToken.glassBorder))
    }

    private func breakdownCard(_ title: String, subtitle: String, rows: [UsageLedgerSnapshot.Breakdown], tint: Color) -> some View {
        let maximum = max(1, rows.map(\.requests).max() ?? 1)
        return ProductCard(title: title, subtitle: subtitle) {
            if rows.isEmpty {
                CompactProductEmptyState(icon: "chart.bar", title: "暂无拆分数据", message: "产生用量后会自动显示。")
            } else {
                ForEach(rows.prefix(8)) { row in
                    VStack(alignment: .leading, spacing: DS.Space.xs) {
                        HStack {
                            Text(friendlyBreakdown(row.key)).font(.body.weight(.medium)).lineLimit(1)
                            Spacer()
                            Text("\(row.requests) 次")
                                .font(DS.Typography.caption)
                                .foregroundStyle(DS.ColorToken.textSecondary)
                        }
                        GeometryReader { proxy in
                            ZStack(alignment: .leading) {
                                Capsule().fill(DS.ColorToken.surfaceSecondary).frame(height: 5)
                                Capsule().fill(tint.opacity(0.72)).frame(width: max(5, proxy.size.width * CGFloat(row.requests) / CGFloat(maximum)), height: 5)
                            }
                        }
                        .frame(height: 5)
                        HStack {
                            Text(breakdownTokens(row))
                            Spacer()
                            Text(breakdownCost(row))
                        }
                        .font(.caption2)
                        .foregroundStyle(DS.ColorToken.textTertiary)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func recentInvocations(_ items: [UsageLedgerSnapshot.Invocation]) -> some View {
        ProductCard(title: "最近调用", subtitle: "成本按调用当时的价格版本保存") {
            if items.isEmpty {
                CompactProductEmptyState(icon: "clock", title: "暂无调用记录", message: "使用 Chat 或 Agent 后会在这里出现。")
            } else {
                ForEach(Array(items.prefix(20))) { item in
                    HStack(alignment: .top, spacing: DS.Space.m) {
                        ZStack {
                            RoundedRectangle(cornerRadius: DS.Radius.s).fill(DS.ColorToken.accentSoft)
                            Image(systemName: featureIcon(item.feature)).foregroundStyle(DS.ColorToken.accent)
                        }
                        .frame(width: 34, height: 34)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item.publicModel.isEmpty ? item.model : item.publicModel)
                                .font(.body.weight(.semibold))
                                .lineLimit(1)
                            HStack(spacing: DS.Space.xs) {
                                Text(featureLabel(item.feature))
                                Text("·")
                                Text(friendlyDateTime(item.timestamp))
                                Text("·")
                                Text(providerLabel(item.provider))
                            }
                            .font(DS.Typography.caption)
                            .foregroundStyle(DS.ColorToken.textTertiary)
                        }
                        Spacer(minLength: DS.Space.m)
                        VStack(alignment: .trailing, spacing: 3) {
                            Text(invocationCost(item))
                                .font(.system(.body, design: .rounded).weight(.semibold))
                                .foregroundStyle(item.costUsd == nil ? DS.ColorToken.warning : DS.ColorToken.textPrimary)
                            Text("输入 \(token(item.inputTokens)) · 输出 \(token(item.outputTokens))")
                                .font(DS.Typography.caption)
                                .foregroundStyle(DS.ColorToken.textTertiary)
                        }
                    }
                    .padding(.vertical, DS.Space.xs)
                    if item.id != items.prefix(20).last?.id { Divider() }
                }
            }
        }
    }

    private func load() async { do { snapshot=try await api.usageLedgerSnapshot();errorText=nil } catch { errorText=String(describing:error) } }

    private func compact(_ value: Int) -> String { value.formatted(.number.notation(.compactName)) }
    private func token(_ value: Int?) -> String { value.map(compact) ?? "—" }
    private func cachedSubtitle(_ value: Int?) -> String { value.map { "其中缓存 \(compact($0))" } ?? "缓存未知" }

    private func metricCost(_ metric: UsageLedgerSnapshot.Metric) -> String {
        if let value = metric.costUsd { return currency(value) }
        if metric.unpriced > 0 { return "未定价" }
        if metric.unknownUsage > 0 { return "未知" }
        return metric.requests == 0 ? "$0.00" : "—"
    }

    private func costSubtitle(_ metric: UsageLedgerSnapshot.Metric) -> String {
        if metric.unpriced > 0 { return "\(metric.unpriced) 次未配置价格" }
        if metric.unknownUsage > 0 { return "\(metric.unknownUsage) 次缺少用量" }
        return "USD"
    }

    private func breakdownTokens(_ row: UsageLedgerSnapshot.Breakdown) -> String {
        "输入 \(token(row.inputTokens)) · 输出 \(token(row.outputTokens))"
    }

    private func breakdownCost(_ row: UsageLedgerSnapshot.Breakdown) -> String {
        if let value = row.costUsd { return currency(value) }
        if row.unpriced > 0 { return "未定价" }
        if row.unknownUsage > 0 { return "未知" }
        return "—"
    }

    private func invocationCost(_ item: UsageLedgerSnapshot.Invocation) -> String {
        if let value = item.costUsd { return currency(value) }
        switch item.costStatus {
        case "unpriced": return "未定价"
        case "unknown": return "未知"
        default: return "—"
        }
    }

    private func currency(_ value: Double) -> String {
        if value > 0, value < 0.01 { return String(format: "$%.4f", value) }
        return String(format: "$%.2f", value)
    }

    private func friendlyBreakdown(_ raw: String) -> String {
        if raw == "agent" { return "Agent" }
        if raw == "chat" { return "日常对话" }
        if raw == "native_agent" { return "原生 Agent" }
        let parts = raw.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        if parts.count > 1 {
            let routeNames = [
                "primary": "主要路由",
                "secondary": "备用路由",
                "unknown": "未知路由"
            ]
            let route = routeNames[parts[0].lowercased()] ?? parts[0].capitalized
            return "\(parts.dropFirst().joined(separator: ":")) · \(route)"
        }
        return raw
    }

    private func featureLabel(_ value: String) -> String { friendlyBreakdown(value) }
    private func featureIcon(_ value: String) -> String { value.contains("agent") ? "hammer" : "bubble.left.and.text.bubble.right" }
    private func providerLabel(_ value: String) -> String { value.isEmpty || value == "unknown" ? "提供方未知" : value.capitalized }
    private func friendlyDateTime(_ value: String) -> String {
        CompanionTime.naturalDateTime(fromISO8601: value)
    }
}

private struct UsagePriceSheet: View {
    let api: APIClient
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var provider = ""
    @State private var model = ""
    @State private var input = ""
    @State private var cached = ""
    @State private var output = ""
    @State private var reasoning = ""
    @State private var effective = Date()
    @State private var errorText: String?
    @State private var saving = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: DS.Space.m) {
                Image(systemName: "dollarsign.circle.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(DS.ColorToken.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("新增价格版本").font(.title2.weight(.semibold))
                    Text("只影响之后的调用，不改写既有账本。")
                        .font(DS.Typography.caption)
                        .foregroundStyle(DS.ColorToken.textSecondary)
                }
                Spacer()
            }
            .padding(DS.Space.l)
            .background(DS.Surface.chrome)

            Form {
                Section("模型") {
                    TextField("提供方", text: $provider)
                    TextField("模型", text: $model)
                }
                Section("每 100 万 Tokens（USD）") {
                    TextField("输入", text: $input)
                    TextField("缓存输入（可空）", text: $cached)
                    TextField("输出", text: $output)
                    TextField("推理（可空）", text: $reasoning)
                }
                Section("生效") {
                    DatePicker("生效时间", selection: $effective)
                    Text("新增版本不会重算或改写既有调用成本。")
                        .font(DS.Typography.caption)
                        .foregroundStyle(DS.ColorToken.textSecondary)
                }
                if let errorText {
                    Label(errorText, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(DS.ColorToken.danger)
                }
            }
            .formStyle(.grouped)

            HStack {
                Button("取消") { dismiss() }
                Spacer()
                if saving { ProgressView().controlSize(.small) }
                Button("保存价格版本") { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(saving || provider.trimmingCharacters(in: .whitespaces).isEmpty || model.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(DS.Space.l)
        }
        .frame(width: 520, height: 560)
        .environment(\.timeZone, CompanionTime.timeZone)
    }

    private func save() async {
        guard let inputValue = Double(input), let outputValue = Double(output) else {
            errorText = "输入与输出价格必须是数字"
            return
        }
        saving = true
        defer { saving = false }
        let draft = UsagePriceDraft(
            provider: provider,
            model: model,
            inputPerMillion: inputValue,
            cachedInputPerMillion: cached.isEmpty ? nil : Double(cached),
            outputPerMillion: outputValue,
            reasoningPerMillion: reasoning.isEmpty ? nil : Double(reasoning),
            effectiveFrom: ISO8601DateFormatter().string(from: effective)
        )
        do {
            try await api.addUsagePrice(draft)
            errorText = nil
            onSaved()
            dismiss()
        } catch { errorText = String(describing: error) }
    }
}

struct HonestUnavailableView: View {
    let icon:String;let title:String;let message:String
    var body: some View { EmptyStateView(icon:icon,title:title,subtitle:message).background(.thinMaterial) }
}
