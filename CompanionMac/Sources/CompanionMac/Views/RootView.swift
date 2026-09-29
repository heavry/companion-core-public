import SwiftUI
import CompanionKit

/// 唯一 Window Chrome：保留 NavigationSplitView、系统 titlebar 与 sidebar toggle。
/// 页面只提供内容；窗口身份、导航层级和页面 header 统一由这里负责。
struct RootView: View {
    @ObservedObject var app: AppModel
    @AppStorage("initialTab") private var selectedTab: String = "chat"
    @AppStorage("companionAppearanceMode") private var appearanceMode: String = "system"
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
    @State private var agentDeveloperMode = false
    @State private var agentRefreshTrigger = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let navigationGroups: [RootNavigationGroup] = [
        RootNavigationGroup(
            id: "everyday",
            title: "日常",
            items: [
                .init(id: .chat, title: "Chat", icon: "bubble.left.and.text.bubble.right", shortcut: "1"),
                .init(id: .today, title: "Today", icon: "sun.max", shortcut: "2"),
                .init(id: .plans, title: "Plans", icon: "calendar", shortcut: "3")
            ]
        ),
        RootNavigationGroup(
            id: "personal",
            title: "你与林小糖",
            items: [
                .init(id: .relationship, title: "Relationship", icon: "person.2", shortcut: "4"),
                .init(id: .memory, title: "Memory", icon: "brain", shortcut: "5")
            ]
        ),
        RootNavigationGroup(
            id: "advanced",
            title: "高级",
            items: [
                .init(id: .capabilities, title: "Capabilities", icon: "switch.2", shortcut: "6", isTechnical: true),
                .init(id: .usage, title: "Usage", icon: "chart.bar", shortcut: "7", isTechnical: true),
                .init(id: .settings, title: "Settings", icon: "gearshape", shortcut: "8", isTechnical: true)
            ]
        )
    ]

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar
                .navigationTitle("Companion")
        } detail: {
            ZStack {
                DS.ColorToken.windowBackground.ignoresSafeArea()
                WallpaperMaterialBackground()
                Group {
                    if app.coreReady {
                        VStack(spacing: 0) {
                            pageHeader
                            content
                        }
                    } else {
                        coreStartupView
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .preferredColorScheme(preferredColorScheme)
        .frame(minWidth: 1000, minHeight: 680)
        .onAppear {
            selectedTab = ProductDestination.normalized(selectedTab).rawValue
        }
        .onReceive(NotificationCenter.default.publisher(for: .companionOpenDestination)) { note in
            if let raw = note.object as? String {
                selectedTab = ProductDestination.normalized(raw).rawValue
            }
        }
    }

    private var preferredColorScheme: ColorScheme? {
        switch appearanceMode.lowercased() {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: DS.Space.xl20) {
                    brandHeader

                    ForEach(navigationGroups) { group in
                        VStack(alignment: .leading, spacing: DS.Space.xs) {
                            Text(group.title)
                                .font(DS.Typography.eyebrow)
                                .foregroundStyle(group.id == "advanced"
                                    ? DS.ColorToken.textTertiary.opacity(0.78)
                                    : DS.ColorToken.textTertiary)
                                .tracking(0.7)
                                .padding(.horizontal, DS.Space.l)
                                .accessibilityAddTraits(.isHeader)

                            ForEach(group.items) { item in
                                NavItemView(
                                    title: item.title,
                                    icon: item.icon,
                                    selected: selectedTab == item.id.rawValue,
                                    isTechnical: item.isTechnical,
                                    shortcut: item.shortcut
                                ) {
                                    select(item.id)
                                }
                            }
                        }
                    }
                }
                .padding(.top, DS.Space.m)
                .padding(.bottom, DS.Space.xl)
            }

            connectionFooter
        }
        .frame(minWidth: 212, idealWidth: 224, maxWidth: 248)
        .background(DS.Surface.chrome)
        .background(DS.ColorToken.sidebar)
    }

    private var brandHeader: some View {
        HStack(spacing: DS.Space.m) {
            AvatarView(name: "林小糖", size: 52)
            VStack(alignment: .leading, spacing: 2) {
                Text("林小糖")
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                    .foregroundStyle(DS.ColorToken.textPrimary)
                Text("你的本地 Companion")
                    .font(DS.Typography.caption)
                    .foregroundStyle(DS.ColorToken.textSecondary)
                if AppModel.isCandidateTarget {
                    Text("Candidate · 8770")
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .foregroundStyle(DS.ColorToken.textTertiary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(DS.ColorToken.warning.opacity(0.08), in: Capsule())
                        .accessibilityLabel("Candidate environment, port 8770")
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, DS.Space.l)
        .accessibilityElement(children: .contain)
    }

    private var connectionFooter: some View {
        HStack(spacing: DS.Space.s) {
            StatusDot(connected: connection.status == .connected)
            VStack(alignment: .leading, spacing: 1) {
                Text(connection.status == .connected ? "Companion 已连接" : "正在重新连接")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(DS.ColorToken.textSecondary)
                Text(connection.status == .connected ? "本地服务可用" : "你的内容仍保留在本机")
                    .font(.caption2)
                    .foregroundStyle(DS.ColorToken.textTertiary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, DS.Space.m)
        .padding(.vertical, DS.Space.s)
        .background(DS.ColorToken.surfaceSecondary.opacity(0.46), in: RoundedRectangle(cornerRadius: DS.Radius.m))
        .overlay {
            RoundedRectangle(cornerRadius: DS.Radius.m)
                .strokeBorder(DS.ColorToken.glassBorder, lineWidth: 0.5)
        }
        .padding(.horizontal, DS.Space.s)
        .padding(.bottom, DS.Space.m)
        .animation(DS.Motion.animation(.fast, reduceMotion: reduceMotion), value: connection.status)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(connection.status == .connected ? "Companion 已连接，本地服务可用" : "Companion 正在重新连接")
    }

    private func select(_ destination: ProductDestination) {
        guard selectedTab != destination.rawValue else { return }
        if reduceMotion {
            selectedTab = destination.rawValue
        } else {
            withAnimation(DS.Motion.normal) {
                selectedTab = destination.rawValue
            }
        }
        Breadcrumb.emit("nav.switch \(destination.rawValue)")
    }

    // MARK: - Page chrome

    private var coreStartupView: some View {
        CompanionGlassPanel(style: .prominent, contentPadding: 0) {
            if app.coreLauncher.phase.isFailed {
                CompanionStateView(
                    kind: .error,
                    title: "无法启动 Companion Core",
                    message: app.coreLauncher.phase.failureDetail ?? "请稍后重试。",
                    actionTitle: "重试",
                    action: { Task { await app.retryCore() } }
                )
            } else {
                CompanionStateView(
                    kind: .loading,
                    title: "正在启动 Companion",
                    message: "正在连接你的本地数据与能力。"
                )
            }
        }
        .frame(maxWidth: 520)
        .padding(DS.Space.xxl)
    }

    private var pageHeader: some View {
        let descriptor = pageDescriptor
        return HStack(alignment: .center, spacing: DS.Space.l) {
            VStack(alignment: .leading, spacing: 2) {
                Text(descriptor.title)
                    .font(DS.Typography.pageTitle)
                    .foregroundStyle(DS.ColorToken.textPrimary)
                if !descriptor.subtitle.isEmpty {
                    Text(descriptor.subtitle)
                        .font(DS.Typography.caption)
                        .foregroundStyle(DS.ColorToken.textTertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: DS.Space.l)
            trailingActions
        }
        .padding(.horizontal, DS.Space.xl20)
        .frame(minHeight: 66)
        .background(DS.Surface.chrome)
        .overlay(alignment: .bottom) {
            Rectangle().fill(DS.ColorToken.separator).frame(height: 0.5)
        }
        .accessibilityElement(children: .contain)
    }

    private var pageDescriptor: (title: String, subtitle: String) {
        switch selectedTab {
        case "chat":         return ("Chat", "与林小糖的日常对话")
        case "today":        return ("Today", "林小糖今天的日记")
        case "relationship": return ("Relationship", "你们的相处方式与长期上下文")
        case "plans":        return ("Plans", "一次性与周期计划")
        case "capabilities": return ("Capabilities", "Companion 可以为你做什么")
        case "memory":       return ("Memory", "共同积累的长期记忆与关联")
        case "usage":        return ("Usage", "调用量、Tokens 与成本")
        case "settings":     return ("Settings", "偏好、连接与高级选项")
        default:              return ("Companion", "")
        }
    }

    @ViewBuilder private var trailingActions: some View {
        if selectedTab == "capabilities" {
            HStack(spacing: DS.Space.s) {
                Toggle("Developer details", isOn: $agentDeveloperMode)
                    .toggleStyle(.checkbox)
                    .controlSize(.small)
                    .font(DS.Typography.caption)
                    .foregroundStyle(DS.ColorToken.textTertiary)
                Button {
                    agentRefreshTrigger += 1
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .help("刷新能力状态")
            }
        }
    }

    // MARK: - Content

    private var pageTransition: AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(
            insertion: .opacity.combined(with: .offset(x: 10)),
            removal: .opacity.combined(with: .offset(x: -5))
        )
    }

    private var content: some View {
        ZStack {
            selectedContent
                .id(selectedTab)
                .transition(pageTransition)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .animation(DS.Motion.animation(.normal, reduceMotion: reduceMotion), value: selectedTab)
    }

    @ViewBuilder private var selectedContent: some View {
        switch selectedTab {
        case "chat":
            ChatHomeView(
                connection: connection,
                coreLauncher: app.coreLauncher,
                onRetryCore: { Task { await app.retryCore() } },
                voiceCall: app.voiceCall
            )
        case "today":
            TodayProductView(api: app.api)
        case "relationship":
            RelationshipProductView(api: app.api)
        case "plans":
            PlansProductView(api: app.api)
        case "capabilities":
            CapabilitiesProductView(
                api: app.api,
                developerMode: $agentDeveloperMode,
                refreshTrigger: agentRefreshTrigger
            )
        case "memory":
            MemoryProductView(api: app.api)
        case "usage":
            UsageProductView(api: app.api)
        default:
            SettingsRootView(api: app.api, connection: connection)
        }
    }

    private var connection: ConnectionViewModel { app.connection }
}

// MARK: - Navigation components

private struct RootNavigationItem: Identifiable {
    let id: ProductDestination
    let title: String
    let icon: String
    let shortcut: String
    var isTechnical = false
}

private struct RootNavigationGroup: Identifiable {
    let id: String
    let title: String
    let items: [RootNavigationItem]
}

struct NavItemView: View {
    let title: String
    let icon: String
    let selected: Bool
    var isTechnical = false
    var shortcut = ""
    let action: () -> Void

    @State private var hovering = false
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: action) {
            HStack(spacing: DS.Space.m) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: selected ? .semibold : .medium))
                    .frame(width: 20)
                    .foregroundStyle(iconColor)
                Text(title)
                    .font(.system(size: 13, weight: selected ? .semibold : .regular))
                    .foregroundStyle(textColor)
                Spacer(minLength: DS.Space.s)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(DS.ColorToken.accent)
                        .accessibilityHidden(true)
                } else if hovering || focused {
                    Text("⌘\(shortcut)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(DS.ColorToken.textTertiary)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, DS.Space.m)
            .padding(.vertical, 9)
            .background {
                RoundedRectangle(cornerRadius: DS.Radius.s, style: .continuous)
                    .fill(selected ? DS.ColorToken.selectionFill
                        : (hovering ? DS.ColorToken.surfaceSecondary.opacity(0.52) : .clear))
            }
            .overlay(alignment: .leading) {
                Capsule()
                    .fill(DS.ColorToken.accent)
                    .frame(width: 3, height: selected ? 18 : 0)
                    .padding(.leading, 3)
                    .accessibilityHidden(true)
            }
            .overlay {
                RoundedRectangle(cornerRadius: DS.Radius.s, style: .continuous)
                    .strokeBorder(focused ? DS.ColorToken.focusRing : .clear, lineWidth: 1.5)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focused($focused)
        .keyboardShortcut(KeyEquivalent(Character(shortcut)), modifiers: [.command])
        .padding(.horizontal, DS.Space.s)
        .animation(DS.Motion.animation(.fast, reduceMotion: reduceMotion), value: selected)
        .animation(DS.Motion.animation(.fast, reduceMotion: reduceMotion), value: focused)
        .onHover { value in
            if reduceMotion { hovering = value }
            else { withAnimation(DS.Motion.fast) { hovering = value } }
        }
        .accessibilityLabel(title)
        .accessibilityValue(selected ? "已选择" : "")
        .accessibilityHint(selected ? "当前页面" : "切换到 \(title)，快捷键 Command \(shortcut)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var iconColor: Color {
        if selected { return DS.ColorToken.accent }
        if hovering || focused { return DS.ColorToken.textPrimary }
        return isTechnical ? DS.ColorToken.textTertiary : DS.ColorToken.textSecondary
    }

    private var textColor: Color {
        if selected || hovering || focused { return DS.ColorToken.textPrimary }
        return isTechnical ? DS.ColorToken.textSecondary.opacity(0.84) : DS.ColorToken.textSecondary
    }
}

// MARK: - Persona avatar

struct AvatarView: View {
    let name: String
    var size: CGFloat = 32

    var body: some View {
        if let image = PersonaAvatar.image {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
                .background(DS.ColorToken.surfaceElevated)
                .clipShape(RoundedRectangle(cornerRadius: max(9, size * 0.23), style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: max(9, size * 0.23), style: .continuous)
                        .strokeBorder(DS.ColorToken.glassBorder, lineWidth: 0.75)
                }
                .companionShadow(DS.Shadow.quiet)
                .accessibilityLabel("\(name)的头像")
        } else {
            ZStack {
                Circle().fill(
                    LinearGradient(
                        colors: [Color.accentColor.opacity(0.84), Color.pink.opacity(0.62)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                Text(String(name.prefix(1)))
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .frame(width: size, height: size)
            .accessibilityLabel("\(name)的头像")
        }
    }
}
