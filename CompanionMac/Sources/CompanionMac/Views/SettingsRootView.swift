import SwiftUI
import Combine
import CompanionKit
import AppKit

/// 设置采用两级信息架构：左侧只保留稳定的产品分组，具体能力在组内切换。
/// 所有设置仍复用既有真实 API / Keychain / AppStorage，不创建第二份配置事实源。
struct SettingsRootView: View {
    let api: APIClient
    @ObservedObject var connection: ConnectionViewModel
    @State private var category: SettingsCategory = .general
    @State private var generalPage = "overview"
    @State private var connectionsPage = "web"
    @State private var agentPage = "persona"
    @State private var advancedPage = "mcp"

    var body: some View {
        HStack(spacing: 0) {
            List(SettingsCategory.allCases, selection: $category) { item in
                Label(item.title, systemImage: item.icon)
                    .tag(item)
                    .accessibilityHint(item.subtitle)
            }
            .listStyle(.sidebar)
            .frame(minWidth: 190, idealWidth: 208, maxWidth: 230)

            Divider().opacity(0.55)

            VStack(spacing: 0) {
                SettingsCategoryHeader(category: category)
                Divider().opacity(0.45)
                categoryContent
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    @ViewBuilder private var categoryContent: some View {
        switch category {
        case .general:
            SettingsSubpageContainer(selection: $generalPage, items: [
                ("overview", "概览"), ("quick", "快捷入口"), ("notifications", "通知")
            ]) {
                if generalPage == "notifications" {
                    NotificationSettingsSection(api: api, connection: connection)
                } else if generalPage == "quick" {
                    QuickAccessSettingsSection()
                } else {
                    GeneralSettingsOverview(connection: connection)
                }
            }
        case .appearance:
            AppearanceSettingsView()
        case .connections:
            SettingsSubpageContainer(selection: $connectionsPage, items: [
                ("web", "联网搜索"), ("weather", "天气"),
                ("images", "图片生成"), ("voice", "本地语音"), ("wake", "唤醒词"), ("core", "Core")
            ]) {
                switch connectionsPage {
                case "weather": WeatherSettingsSection(api: api)
                case "images": ImagesSettingsSection(api: api)
                case "voice": LocalVoiceSettingsView(api: api)
                case "wake": WakeWordSettingsView(api: api)
                case "core": ConnectionSettingsSection(api: api)
                default: WebSearchSettingsSection(api: api)
                }
            }
        case .memory:
            MemoryCenterView(api: api)
        case .agent:
            SettingsSubpageContainer(selection: $agentPage, items: [
                ("persona", "身份与表达"), ("behavior", "陪伴方式"), ("autonomy", "Autonomy")
            ]) {
                if agentPage == "autonomy" {
                    AgentAutonomySettingsView(api: api)
                } else if agentPage == "behavior" {
                    BehaviorSettingsSection(api: api)
                } else {
                    PersonaFormView(api: api)
                }
            }
        case .advanced:
            SettingsSubpageContainer(selection: $advancedPage, items: [
                ("mcp", "MCP Server"), ("developer", "诊断")
            ]) {
                if advancedPage == "developer" {
                    DeveloperSettingsSection(api: api)
                } else {
                    McpServerSettingsSection(api: api)
                }
            }
        }
    }
}

private struct AgentAutonomySettingsView: View {
    let api: APIClient
    @State private var controls: LocalRuntimeControlsSnapshot?
    @State private var busyKey: String?
    @State private var errorMessage = ""

    var body: some View {
        Form {
            Section("Autonomy") {
                LabeledContent("Current Mode", value: "按当前聊天设置")
                LabeledContent("Granted Scopes", value: "当前 workspace / 会话")
                LabeledContent("Session lifetime", value: "随会话撤销或到期")
                runtimeToggle("Terminal", key: "terminal")
                runtimeToggle("Filesystem", key: "filesystem")
                LabeledContent("Git", value: "Installed")
                LabeledContent("GitHub", value: "Needs Auth")
                LabeledContent("Process / Service", value: "Installed")
                runtimeToggle("Self Modification", key: "self_maintenance", suffix: "Candidate only")
                runtimeToggle("Package Manager", key: "package_manager")
                LabeledContent("Deploy target", value: "127.0.0.1:8770")
                LabeledContent("Hard Safety boundary", value: controls?.hardSafetyBoundary.capitalized ?? "Active")
            }
            Section("完全自主") {
                Text("在聊天输入框旁的盾牌菜单中启用。它会让 Agent 在当前授权范围内连续执行正常开发操作，不再逐步确认；系统安全、凭证隔离、未知 WIP 与 production 等硬边界仍然保留。")
                    .font(DS.Typography.secondary).foregroundStyle(DS.ColorToken.textSecondary)
                Text("关闭或切换当前聊天的权限模式会立即撤销完全自主。Terminal、Filesystem、Git 与本地服务写操作只在调用方明确提供 workspace scope 时 Ready；GitHub credential 不会进入模型上下文。")
                    .font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)
            }
            if !errorMessage.isEmpty {
                Section("状态") { Text(errorMessage).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.danger) }
            }
        }
        .formStyle(.grouped)
        .task { await reload() }
    }

    @ViewBuilder private func runtimeToggle(_ title: String, key: String, suffix: String? = nil) -> some View {
        Toggle(isOn: Binding(get: { controls?.enabled[key] ?? true }, set: { setControl(key, enabled: $0) })) {
            HStack {
                Text(title)
                if let suffix { Text(suffix).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary) }
            }
        }
        .disabled(controls == nil || busyKey != nil)
    }

    private func reload() async {
        do { controls = try await api.localRuntimeControls(); errorMessage = "" }
        catch { errorMessage = "无法读取 Core 的 Autonomy 控制：\(error)" }
    }

    private func setControl(_ key: String, enabled: Bool) {
        guard busyKey == nil else { return }
        busyKey = key
        Task {
            defer { busyKey = nil }
            do { controls = try await api.updateLocalRuntimeControls([key: enabled]); errorMessage = "" }
            catch { errorMessage = "更新失败，原状态未改变：\(error)"; await reload() }
        }
    }
}

private enum SettingsCategory: String, CaseIterable, Identifiable {
    case general, appearance, connections, memory, agent, advanced

    var id: String { rawValue }
    var title: String {
        switch self {
        case .general: "General"
        case .appearance: "Appearance"
        case .connections: "Connections"
        case .memory: "Memory"
        case .agent: "Agent"
        case .advanced: "Advanced"
        }
    }
    var subtitle: String {
        switch self {
        case .general: "版本、启动与系统通知"
        case .appearance: "主题、可读性与壁纸"
        case .connections: "联网搜索、天气、图片与 Core"
        case .memory: "查看与管理长期记忆"
        case .agent: "Companion 身份与陪伴方式"
        case .advanced: "MCP 接入与诊断工具"
        }
    }
    var icon: String {
        switch self {
        case .general: "gearshape"
        case .appearance: "paintbrush"
        case .connections: "link"
        case .memory: "brain"
        case .agent: "sparkles"
        case .advanced: "slider.horizontal.3"
        }
    }
}

private struct SettingsCategoryHeader: View {
    let category: SettingsCategory

    var body: some View {
        HStack(spacing: DS.Space.m) {
            Image(systemName: category.icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(DS.ColorToken.accent)
                .frame(width: 30, height: 30)
                .background(DS.ColorToken.accent.opacity(0.11), in: RoundedRectangle(cornerRadius: DS.Radius.s))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(category.title)
                    .font(.headline)
                    .foregroundStyle(DS.ColorToken.textPrimary)
                Text(category.subtitle)
                    .font(DS.Typography.caption)
                    .foregroundStyle(DS.ColorToken.textSecondary)
            }
            Spacer()
        }
        .padding(.horizontal, DS.Space.xl)
        .frame(height: 62)
        .accessibilityElement(children: .combine)
    }
}

private struct SettingsSubpageContainer<Content: View>: View {
    @Binding var selection: String
    let items: [(id: String, title: String)]
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            Picker("设置页面", selection: $selection) {
                ForEach(items, id: \.id) { item in
                    Text(item.title).tag(item.id)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: min(CGFloat(items.count) * 150, 620))
            .padding(.horizontal, DS.Space.xl)
            .padding(.vertical, DS.Space.m)
            .accessibilityLabel("设置页面")

            Divider().opacity(0.35)
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

private struct GeneralSettingsOverview: View {
    @ObservedObject var connection: ConnectionViewModel
    @AppStorage("launchAtLogin") private var launchAtLogin = false

    var body: some View {
        Form {
            Section("Companion") {
                LabeledContent("版本", value: "0.2.8.0")
                LabeledContent("连接状态", value: connection.status == .connected ? "已连接" : "正在恢复连接")
                LabeledContent("时区", value: CompanionTime.timeZoneDisplay)
                Toggle("登录时自动启动", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { enabled in
                        NotificationCenter.default.post(name: .companionLaunchAtLoginChanged, object: enabled)
                    }
            }
            Section("日常使用") {
                Text("关闭主窗口后，Companion 会留在菜单栏并继续接收已有事件。通知权限与提醒方式可在上方“通知”中管理。")
                    .font(DS.Typography.secondary)
                    .foregroundStyle(DS.ColorToken.textSecondary)
            }
        }
        .formStyle(.grouped)
    }
}

private struct LocalVoiceSettingsView: View {
    let api: APIClient
    @StateObject private var voice: VoicePlaybackManager
    @State private var enabled = true
    @State private var mode = "manual"
    @State private var speed = 1.0
    @State private var initialized = false
    @State private var providers: [TTSProviderCatalog.Provider] = []
    @State private var selectedProvider = "gpt_sovits"
    @State private var providerError: String?

    init(api: APIClient) { self.api = api; _voice = StateObject(wrappedValue: VoicePlaybackManager(api: api)) }

    var body: some View {
        Form {
            Section("TTS Engine") {
                if providers.isEmpty {
                    Text(providerError ?? "加载可用引擎中…")
                        .font(DS.Typography.secondary)
                        .foregroundStyle(DS.ColorToken.textSecondary)
                } else {
                    Picker("引擎", selection: $selectedProvider) {
                        ForEach(providers) { p in
                            Text(Self.providerLabel(p))
                                .tag(p.id)
                        }
                    }
                    .pickerStyle(.inline)
                    .onChange(of: selectedProvider) { newValue in
                        Task {
                            do {
                                let updated = try await api.selectTTSProvider(id: newValue)
                                selectedProvider = updated.selected
                                providers = updated.providers
                                providerError = nil
                            } catch {
                                providerError = String(describing: error)
                            }
                        }
                    }
                    if let p = providers.first(where: { $0.id == selectedProvider }) {
                        if !p.available {
                            Text("当前引擎 unavailable：\(p.detail ?? "运行时不可用")。下一条语音气泡会失败并回退为文字，不会静默换引擎。")
                                .font(DS.Typography.caption)
                                .foregroundStyle(DS.ColorToken.danger)
                        } else if p.loaded == false {
                            Text("当前引擎 available / unloaded：\(p.detail ?? "将按需启动")。下一条语音会自动拉起，无需手动启动。")
                                .font(DS.Typography.caption)
                                .foregroundStyle(DS.ColorToken.textSecondary)
                        }
                    }
                    Text("下一条新语音气泡使用所选引擎；失败不会自动切换到其它克隆声。")
                        .font(DS.Typography.secondary)
                        .foregroundStyle(DS.ColorToken.textSecondary)
                }
            }
            Section("本地语音") {
                Toggle("启用本地语音", isOn: $enabled)
                Picker("回复方式", selection: $mode) { Text("仅明确要求").tag("manual"); Text("情绪").tag("emotion"); Text("自动").tag("auto") }
                    .pickerStyle(.segmented)
                HStack { Text("语速"); Slider(value: $speed, in: 0.6...1.5, step: 0.05); Text(speed.formatted(.number.precision(.fractionLength(2)))).monospacedDigit() }
                LabeledContent("状态", value: voice.status?.ready == true ? "可用" : "按需启动")
                LabeledContent("累计请求", value: String(voice.status?.metrics.requests ?? 0))
                LabeledContent("本地费用", value: "$0")
                if let error = voice.errorText { Text(error).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.danger) }
            }
            Section("隐私") { Text("语音、参考音频与缓存都保留在本机；内部路径不会发送给聊天模型，也不会写入长期记忆。").font(DS.Typography.secondary).foregroundStyle(DS.ColorToken.textSecondary) }
        }
        .formStyle(.grouped)
        .task {
            await voice.refresh()
            syncFromStatus()
            await loadProviders()
        }
        .onChange(of: enabled) { _ in save() }
        .onChange(of: mode) { _ in save() }
        .onChange(of: speed) { _ in save() }
    }
    private func loadProviders() async {
        do {
            let catalog = try await api.ttsProviders()
            providers = catalog.providers
            selectedProvider = catalog.selected
            providerError = nil
        } catch {
            providerError = String(describing: error)
        }
    }
    private static func providerLabel(_ p: TTSProviderCatalog.Provider) -> String {
        if !p.available { return "\(p.name) · unavailable" }
        if p.loaded == false { return "\(p.name) · unloaded" }
        return p.name
    }
    private func syncFromStatus() { guard let value = voice.status else { return }; enabled = value.enabled; mode = value.mode; speed = value.speed; initialized = true }
    private func save() { guard initialized else { return }; Task { await voice.update(enabled: enabled, mode: mode, speed: speed) } }
}

private struct WakeWordSettingsView: View {
    let api: APIClient
    @State private var enabled = false
    @State private var sensitivity = "normal"
    @State private var feedbackSound = true
    @State private var suspendWhileLocked = true
    @State private var state = "disabled"
    @State private var experimental = true
    @State private var lastError: String?
    @State private var showDiagnostics = false
    @State private var initialized = false

    var body: some View {
        Form {
            Section("唤醒词") {
                Toggle("启用“林小糖”", isOn: $enabled)
                Text("开启后，Companion 会在本机持续监听唤醒词 ‘林小糖’。唤醒检测完全在本地完成。")
                    .font(DS.Typography.secondary)
                    .foregroundStyle(DS.ColorToken.textSecondary)
                Text("默认关闭。当前为实验性本地关键词检测，说话人变化时可能不稳定。")
                    .font(DS.Typography.caption)
                    .foregroundStyle(DS.ColorToken.textSecondary)
            }
            Section("灵敏度") {
                Picker("灵敏度", selection: $sensitivity) {
                    Text("低").tag("low")
                    Text("标准").tag("normal")
                    Text("高").tag("high")
                }
                .pickerStyle(.segmented)
                Text("低更不容易误唤醒；高更容易唤醒，也可能更多误触发。")
                    .font(DS.Typography.caption)
                    .foregroundStyle(DS.ColorToken.textSecondary)
            }
            Section("反馈") {
                Toggle("Wake Feedback Sound", isOn: $feedbackSound)
                Toggle("锁屏时暂停", isOn: $suspendWhileLocked)
                LabeledContent("麦克风", value: "System Default")
                LabeledContent("处理位置", value: "Local only")
            }
            if showDiagnostics {
                Section("诊断") {
                    LabeledContent("引擎", value: "sherpa-onnx KWS")
                    LabeledContent("状态", value: state)
                    LabeledContent("实验性", value: experimental ? "是" : "否")
                    if let lastError { Text(lastError).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.danger) }
                }
            } else {
                Section { Button("显示诊断") { showDiagnostics = true } }
            }
        }
        .formStyle(.grouped)
        .task { await load() }
        .onChange(of: enabled) { _ in save() }
        .onChange(of: sensitivity) { _ in save() }
        .onChange(of: feedbackSound) { _ in save() }
        .onChange(of: suspendWhileLocked) { _ in save() }
    }

    private func load() async {
        guard let status = try? await api.wakeWordStatus() else { return }
        enabled = status.enabled
        sensitivity = status.sensitivity
        feedbackSound = status.feedbackSound
        suspendWhileLocked = status.suspendWhileLocked
        state = status.state
        experimental = status.experimental
        lastError = status.lastError
        initialized = true
    }

    private func save() {
        guard initialized else { return }
        Task {
            if let status = try? await api.updateWakeWordSettings(enabled: enabled, sensitivity: sensitivity, feedbackSound: feedbackSound, suspendWhileLocked: suspendWhileLocked) {
                state = status.state
                lastError = status.lastError
                NotificationCenter.default.post(name: .companionWakeWordSettingsChanged, object: enabled)
            }
        }
    }
}

private struct AppearanceSettingsView: View {
    @AppStorage("companionAppearanceMode") private var appearanceMode = "system"
    @AppStorage("companionReadabilityStrength") private var readability = "balanced"

    var body: some View {
        Form {
            Section("外观") {
                Picker("主题", selection: $appearanceMode) {
                    Text("跟随系统").tag("system")
                    Text("浅色").tag("light")
                    Text("深色").tag("dark")
                }
                .pickerStyle(.segmented)

                Picker("内容可读性", selection: $readability) {
                    Text("柔和").tag("soft")
                    Text("平衡").tag("balanced")
                    Text("清晰").tag("strong")
                }
                .pickerStyle(.segmented)

                Text("可读性会调整壁纸上方的环境遮罩，不改变内容、记忆或模型行为。")
                    .font(DS.Typography.caption)
                    .foregroundStyle(DS.ColorToken.textSecondary)
            }
            Section("壁纸") {
                WallpaperSettingsView()
            }
        }
        .formStyle(.grouped)
        .onAppear { applyAppearance() }
        .onChange(of: appearanceMode) { _ in applyAppearance() }
    }

    private func applyAppearance() {
        switch appearanceMode {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: NSApp.appearance = nil
        }
    }
}

private struct WallpaperSettingsView: View {
    @AppStorage("companionWallpaperPath") private var wallpaperPath = ""
    @AppStorage("companionReadabilityStrength") private var readability = "balanced"
    @State private var showingImporter = false
    @State private var previewError = ""

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.m) {
            wallpaperPreview
            HStack(spacing: DS.Space.s) {
                Button(wallpaperPath.isEmpty ? "选择图片…" : "更换图片…") { showingImporter = true }
                if !wallpaperPath.isEmpty {
                    Button("恢复默认") {
                        wallpaperPath = ""
                        previewError = ""
                    }
                }
            }
            if !previewError.isEmpty {
                Text(previewError)
                    .font(DS.Typography.caption)
                    .foregroundStyle(DS.ColorToken.warning)
            }
        }
        .fileImporter(
            isPresented: $showingImporter,
            allowedContentTypes: [.image],
            allowsMultipleSelection: false
        ) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            guard NSImage(contentsOf: url) != nil else {
                previewError = "无法读取这张图片，请选择常见图片格式。"
                return
            }
            wallpaperPath = url.path
            previewError = ""
        }
    }

    @ViewBuilder private var wallpaperPreview: some View {
        if !wallpaperPath.isEmpty, let image = NSImage(contentsOfFile: wallpaperPath) {
            ZStack(alignment: .bottomLeading) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .accessibilityHidden(true)
                LinearGradient(
                    colors: [.black.opacity(readabilityOpacity * 0.35), .black.opacity(readabilityOpacity)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("壁纸预览")
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text(URL(fileURLWithPath: wallpaperPath).lastPathComponent)
                        .font(DS.Typography.caption)
                        .foregroundStyle(.white.opacity(0.82))
                        .lineLimit(1)
                }
                .padding(DS.Space.l)
            }
            .frame(height: 160)
            .frame(maxWidth: .infinity)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous)
                    .strokeBorder(DS.ColorToken.separator.opacity(0.65), lineWidth: 1)
            )
            .accessibilityElement(children: .combine)
        } else {
            HStack(spacing: DS.Space.m) {
                Image(systemName: "photo.on.rectangle.angled")
                    .font(.system(size: 24, weight: .light))
                    .foregroundStyle(DS.ColorToken.textTertiary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("使用默认环境背景")
                    Text("选择的图片只用于本机界面展示。")
                        .font(DS.Typography.caption)
                        .foregroundStyle(DS.ColorToken.textSecondary)
                }
                Spacer()
            }
            .padding(DS.Space.l)
            .background(DS.ColorToken.surfaceSecondary, in: RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous))
        }
    }

    private var readabilityOpacity: Double {
        switch readability {
        case "soft": 0.20
        case "strong": 0.58
        default: 0.38
        }
    }
}

// MARK: - Persona 结构化表单（经 Admin API 校验；Agent Override 独立展示）

struct PersonaFormView: View {
    let api: APIClient
    @State private var personaId = ""
    @State private var name = ""
    @State private var coreIdentity = ""
    @State private var tone = ""
    @State private var verbosity = ""
    @State private var emojiFrequency = ""
    @State private var personalityText = ""
    @State private var rulesText = ""
    @State private var agentOverride = ""
    @State private var raw: [String: Any]?
    @State private var statusText = ""

    var body: some View {
        Form {
            Section("身份") {
                TextField("名字", text: $name)
                TextField("核心身份", text: $coreIdentity, axis: .vertical)
                    .frame(minHeight: 60)
            }
            Section("表达风格") {
                TextField("语气", text: $tone)
                TextField("回答长度", text: $verbosity)
                TextField("表情符号频率", text: $emojiFrequency)
                TextField("性格（每行一项）", text: $personalityText, axis: .vertical).frame(minHeight: 60)
                TextField("表达规则（每行一项）", text: $rulesText, axis: .vertical).frame(minHeight: 90)
            }
            Section("Agent 模式补充说明") {
                TextField("仅在 Agent 工作时使用，不改变日常对话风格", text: $agentOverride, axis: .vertical)
                    .frame(minHeight: 70)
            }
            Button("保存身份与表达") { Task { await save() } }
            if !statusText.isEmpty { Text(statusText).font(.caption).foregroundStyle(.secondary) }
        }
        .formStyle(.grouped)
        .task { await load() }
    }

    func load() async {
        guard let data = try? await api.getJSON("/admin/personas"),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              let p = arr.first else { statusText = "无法加载 Persona"; return }
        apply(p)
    }

    func apply(_ p: [String: Any]) {
        raw = p
        personaId = p["id"] as? String ?? ""
        name = p["name"] as? String ?? ""
        coreIdentity = p["core_identity"] as? String ?? ""
        if let style = p["speaking_style"] as? [String: Any] {
            tone = style["tone"] as? String ?? ""
            verbosity = style["verbosity"] as? String ?? ""
            emojiFrequency = style["emoji_frequency"] as? String ?? ""
            personalityText = (style["personality"] as? [String])?.joined(separator: "\n") ?? ""
            rulesText = (style["rules"] as? [String])?.joined(separator: "\n") ?? ""
        }
        if let modes = p["mode_instructions"] as? [String: Any] {
            agentOverride = modes["agent"] as? String ?? ""
        }
    }

    func save() async {
        guard var p = raw else { return }
        p["name"] = name
        p["core_identity"] = coreIdentity
        var style = (p["speaking_style"] as? [String: Any]) ?? [:]
        style["tone"] = tone
        style["verbosity"] = verbosity
        style["emoji_frequency"] = emojiFrequency
        style["personality"] = personalityText.split(separator: "\n").map(String.init)
        style["rules"] = rulesText.split(separator: "\n").map(String.init)
        p["speaking_style"] = style
        if var modes = p["mode_instructions"] as? [String: Any] {
            modes["agent"] = agentOverride
            p["mode_instructions"] = modes
        }
        guard let body = try? JSONSerialization.data(withJSONObject: p), !personaId.isEmpty else { return }
        do {
            _ = try await api.send("PATCH", "/admin/personas/\(personaId)", body: body)
            statusText = "已保存 ✓"
        } catch {
            statusText = "保存失败，请稍后重试。"
        }
    }
}

// MARK: - Behavior

struct BehaviorSettingsSection: View {
    @StateObject private var settings: SettingsViewModel

    init(api: APIClient) { _settings = StateObject(wrappedValue: SettingsViewModel(api: api)) }

    var body: some View {
        Form {
            Section("主动程度") {
                Picker("主动程度", selection: $settings.level) {
                    Text("Low — 安静陪伴").tag("low")
                    Text("Normal — 日常关心").tag("normal")
                    Text("Active — 更积极").tag("active")
                }
                Stepper("每日主动消息上限：\(settings.dailyCap)", value: $settings.dailyCap, in: 0...20)
            }
            Section("勿扰时间") {
                HStack {
                    QuietField(text: $settings.quietStart, label: "开始")
                    Text("→")
                    QuietField(text: $settings.quietEnd, label: "结束")
                }
            }
            Section("能力开关") {
                Toggle("主动聊天", isOn: $settings.proactiveMessages)
                Toggle("天气关心", isOn: $settings.weatherAwareness)
                Toggle("后续提醒", isOn: $settings.followUp)
                Toggle("主动图片", isOn: $settings.proactiveImages)
                Stepper("每日主动图片上限：\(settings.dailyImageCap)", value: $settings.dailyImageCap, in: 0...10)
            }
            Button("保存") { Task { await settings.save() } }
            if let e = settings.errorText { Text(e).foregroundStyle(.red).font(.caption) }
        }
        .formStyle(.grouped)
        .task { await settings.load() }
    }
}

struct QuietField: View {
    @Binding var text: String
    let label: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            TextField("HH:mm", text: $text).frame(width: 90)
        }
    }
}

// MARK: - 联网搜索（真实 Search Provider 配置；Key 只进 Keychain / Core 安全配置）

struct WebSearchSettingsSection: View {
    let api: APIClient
    @State private var configured = false
    @State private var activeProvider = ""
    @State private var reason = ""
    @State private var selectedProvider = "none"
    @State private var hasKey = false
    @State private var keyInput = ""
    @State private var searxngURL = ""
    @State private var statusText = ""

    static func providerDisplayName(_ provider: String?) -> String {
        switch provider {
        case "tavily": return "Tavily"
        case "searxng": return "SearXNG"
        case "native": return "Provider Native"
        default: return ""
        }
    }

    var body: some View {
        Form {
            Section("状态") {
                HStack(spacing: DS.Space.s) {
                    Circle()
                        .fill(configured ? DS.ColorToken.success : DS.ColorToken.textTertiary.opacity(0.4))
                        .frame(width: 8, height: 8)
                    Text(configured ? "已配置\(activeProvider.isEmpty ? "" : " · \(Self.providerDisplayName(activeProvider))")" : "未配置")
                        .font(DS.Typography.secondary)
                }
                if !configured && !reason.isEmpty {
                    Text(reason).font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("Search Provider") {
                Picker("搜索引擎", selection: $selectedProvider) {
                    Text("关闭").tag("none")
                    Text("Tavily").tag("tavily")
                    Text("SearXNG（自建）").tag("searxng")
                }
                if selectedProvider == "tavily" {
                    SecureField(hasKey ? "已存 Keychain 的 API Key（留空保留）" : "Tavily API Key", text: $keyInput)
                    Text("Key 保存在 macOS Keychain 与 Core 数据目录的安全配置文件中（0600），绝不写入日志、数据库或代码。")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if selectedProvider == "searxng" {
                    TextField("SearXNG Base URL（如 http://127.0.0.1:8888）", text: $searxngURL)
                }
            }
            Button("保存并应用") { Task { await save() } }
            if !statusText.isEmpty { Text(statusText).font(.caption).foregroundStyle(.secondary) }
            Section("说明") {
                Text("在聊天输入框打开「联网」后，林小糖只会在需要时搜索网络；关闭时不产生任何搜索请求。网页结果按不可信外部内容处理，不会覆盖 Persona 或系统指令。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .task { await load() }
    }

    func load() async {
        do {
            let detail = try await api.webSearchDetail()
            configured = detail.configured
            activeProvider = detail.provider ?? ""
            reason = detail.reason ?? ""
            hasKey = detail.hasTavilyKey ?? false
            searxngURL = detail.searxngBaseURL ?? ""
            selectedProvider = ["tavily", "searxng"].contains(detail.provider ?? "") ? detail.provider! : "none"
            keyInput = ""
            statusText = ""
        } catch {
            statusText = "无法读取联网搜索状态"
        }
    }

    func save() async {
        let trimmedURL = searxngURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if selectedProvider == "searxng" && trimmedURL.isEmpty {
            statusText = "请填写 SearXNG 地址"; return
        }
        if !trimmedURL.isEmpty,
           let url = URL(string: trimmedURL),
           !["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            statusText = "SearXNG 地址需以 http(s) 开头"; return
        }
        // Key 只在用户输入了新 Key 时发送；留空表示保留已存 Key。
        let keyToSend: String? = (selectedProvider == "tavily" && !keyInput.trimmingCharacters(in: .whitespaces).isEmpty)
            ? keyInput.trimmingCharacters(in: .whitespaces) : nil
        if let keyToSend {
            try? await KeychainStore().saveAsync(keyToSend, account: "searchTavilyApiKey")
        }
        do {
            let result = try await api.updateWebSearch(
                provider: selectedProvider,
                tavilyAPIKey: keyToSend,
                searxngBaseURL: selectedProvider == "searxng" ? trimmedURL : nil
            )
            configured = result.configured
            activeProvider = result.provider ?? ""
            reason = result.reason ?? ""
            if keyToSend != nil { hasKey = true }
            keyInput = ""
            statusText = result.configured ? "已保存，联网搜索可用 ✓" : "已保存（当前未生效：\(result.reason ?? "")）"
        } catch {
            statusText = "保存失败：\(error)"
        }
    }
}

// MARK: - MCP Server（Companion 作为 MCP Server；token 默认遮罩）

struct McpServerSettingsSection: View {
    let api: APIClient
    @State private var info: [String: Any]?
    @State private var statusText = ""

    var body: some View {
        Form {
            Section("状态") {
                if let info {
                    LabeledContent("HTTP Transport", value: info["http_enabled"] as? Bool == true ? "运行中（POST /mcp）" : "已关闭")
                    LabeledContent("stdio Transport", value: "node src/mcp/server.js --stdio")
                    authRow(info)
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            Section("暴露的工具") {
                if let tools = info?["tools_exposed"] as? [[String: Any]] {
                    ForEach(tools.indices, id: \.self) { index in
                        VStack(alignment: .leading, spacing: 1) {
                            HStack {
                                Text(tools[index]["name"] as? String ?? "").font(.system(.caption, design: .monospaced).weight(.medium))
                                Spacer()
                            }
                            Text(tools[index]["description"] as? String ?? "")
                                .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
            }
            Section("外部客户端接入") {
                Button("复制 stdio 配置 JSON") { copyConfig() }
                Text("把上面的 JSON 加到支持 MCP 的客户端（OpenCode / Harness / Claude Desktop 等）即可调用 Companion 的安全能力。")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if !statusText.isEmpty { Text(statusText).font(.caption).foregroundStyle(.secondary) }
        }
        .formStyle(.grouped)
        .task { await load() }
    }

    @ViewBuilder private func authRow(_ info: [String: Any]) -> some View {
        let auth = info["auth"] as? [String: Any] ?? [:]
        let type = auth["type"] as? String ?? "api_key"
        let masked = auth["token_masked"] as? String ?? ""
        LabeledContent {
            Text(masked.isEmpty ? "••••••" : masked).font(DS.Typography.mono)
        } label: {
            Text("鉴权（\(type == "dedicated_token" ? "专用 MCP Token" : "复用 API Key")）")
        }
    }

    func load() async {
        if let data = try? await api.getJSON("/admin/mcp-server"),
           let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            info = raw
        }
    }

    func copyConfig() {
        let config = """
        {
          "mcpServers": {
            "companion-core": {
              "command": "node",
              "args": ["<companion-core 路径>/src/mcp/server.js", "--stdio"]
            }
          }
        }
        """
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(config, forType: .string)
        statusText = "stdio 配置已复制（不包含任何 secret）"
    }
}

// MARK: - Notifications

struct QuickAccessSettingsSection: View {
    @State private var store = PresenceSettingsStore()
    @State private var settings = PresenceSettings()
    var body: some View {
        Form {
            Section("菜单栏") {
                Toggle("显示 Menu Bar 图标", isOn: $settings.menuBarEnabled)
            }
            Section("全局快捷键") {
                LabeledContent("呼出快速聊天", value: GlobalHotkey.Chord.optionSpace.displayName)
                Toggle("启用全局快捷键", isOn: $settings.hotkeyEnabled)
                Text("默认 ⌥Space。如果系统已占用该组合，Companion 不会强行抢占。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("快速聊天") {
                Toggle("点击外部时关闭", isOn: $settings.dismissQuickChatOnOutsideClick)
            }
            Section("登录") {
                Toggle("登录时自动启动", isOn: $settings.launchAtLogin)
                    .onChange(of: settings.launchAtLogin) { enabled in
                        NotificationCenter.default.post(name: .companionLaunchAtLoginChanged, object: enabled)
                    }
                Text("默认关闭。使用系统 SMAppService，不会写 LaunchAgent。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { settings = store.settings }
        .onChange(of: settings) { store.settings = $0 }
    }
}

struct NotificationSettingsSection: View {
    let api: APIClient
    @ObservedObject var connection: ConnectionViewModel
    @State private var store = PresenceSettingsStore()
    @State private var settings = PresenceSettings()
    var body: some View {
        Form {
            Section("macOS 通知") {
                Text("使用系统通知。拒绝权限后 App 仍可工作。通知按钮只会打开、稍后提醒或忽略，不会批准高风险操作。")
                    .font(.caption).foregroundStyle(.secondary)
                LabeledContent("权限", value: permissionLabel)
                Button("请求通知权限") { NotificationService.shared.requestAuthorizationIfNeeded() }
                Button("在系统设置中打开") {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.notifications") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
            Section("预览") {
                Picker("锁屏预览", selection: $settings.notificationPreview) {
                    ForEach(NotificationPreviewMode.allCases, id: \.self) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                Toggle("允许通知", isOn: $settings.notificationsEnabled)
            }
            Section("主动联系") {
                Toggle("允许主动通知", isOn: $settings.proactiveEnabled)
                Toggle("主动通知允许语音", isOn: $settings.proactiveVoiceEnabled)
                Text("语音默认关闭。安静时间内即使打开也不会朗读。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { settings = store.settings }
        .onChange(of: settings) { store.settings = $0 }
    }

    private var permissionLabel: String {
        switch NotificationService.shared.permissionStatus {
        case .authorized: return "Allowed"
        case .denied: return "Denied"
        case .notRequested: return "Not requested"
        }
    }
}

// MARK: - Weather

struct WeatherSettingsSection: View {
    let api: APIClient
    @State private var city = ""
    @State private var lat = ""
    @State private var lon = ""
    @State private var statusText = ""

    var body: some View {
        Form {
            Section("位置（coarse，由你显式设置）") {
                TextField("城市标签（如 上海）", text: $city)
                HStack { TextField("lat", text: $lat); TextField("lon", text: $lon) }
                Button("保存并重载 Weather 模块") { Task { await save() } }
                if !statusText.isEmpty { Text(statusText).font(.caption).foregroundStyle(.secondary) }
            }
            Section("说明") {
                Text("天气检查仅在已配置位置时进行；只有显著变化（下雨、降温、高温、大雪、大风）才会进入动态与可能的主动消息，同类提醒会去重。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped)
        .task { await load() }
    }

    func load() async {
        guard let data = try? await api.getJSON("/admin/modules/weather/config"),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cfg = raw["config"] as? [String: Any],
              let loc = cfg["location"] as? [String: Any] else { return }
        city = loc["label"] as? String ?? ""
        if let l = loc["lat"] as? Double { lat = String(l) }
        if let l = loc["lon"] as? Double { lon = String(l) }
    }
    func save() async {
        guard let la = Double(lat), let lo = Double(lon) else { statusText = "lat/lon 需为数字"; return }
        let body: [String: Any] = ["baseUrl": "https://api.open-meteo.com/v1",
                                   "location": ["label": city, "lat": la, "lon": lo]]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        do {
            _ = try await api.send("PUT", "/admin/modules/weather/config", body: data)
            statusText = "已保存并重载 ✓"
        } catch { statusText = "保存失败：\(error)" }
    }
}

// MARK: - Images / ComfyUI

struct ImagesSettingsSection: View {
    let api: APIClient
    @State private var cfg: String = "{}"
    var body: some View {
        Form {
            Section("ComfyUI 连接") {
                Text("默认 http://127.0.0.1:8188；生成结果自动进入 Media Store 并以普通图片消息呈现。")
                    .font(.caption).foregroundStyle(.secondary)
                TextEditor(text: $cfg).frame(minHeight: 100)
                    .font(.system(.caption, design: .monospaced))
                HStack {
                    Button("加载当前配置") { Task { if let d = try? await api.getJSON("/admin/modules/comfyui/config"), let s = String(data: d, encoding: .utf8) { cfg = s } } }
                    Button("保存配置并重载模块") {
                        Task {
                            if let data = cfg.data(using: .utf8) {
                                _ = try? await api.send("PUT", "/admin/modules/comfyui/config", body: data)
                            }
                        }
                    }
                }
                Text("内部 workflow / node 细节仅在 Developer 视图可见。").font(.caption2).foregroundStyle(.tertiary)
            }
        }.formStyle(.grouped)
    }
}

// MARK: - Connection

struct ConnectionSettingsSection: View {
    let api: APIClient
    @State private var baseURL = UserDefaults.standard.string(forKey: "serverBaseURL") ?? "http://127.0.0.1:8770"
    @State private var coreMode = CoreDeploymentMode.resolve(environment: nil, stored: UserDefaults.standard.string(forKey: "coreMode"))
    @State private var apiKeyInput = ""

    var body: some View {
        Form {
            Section("Core 连接") {
                Picker("运行模式", selection: $coreMode) {
                    Text("本机 Candidate").tag(CoreDeploymentMode.local)
                    Text("远端 Core").tag(CoreDeploymentMode.remote)
                }
                TextField("Base URL", text: $baseURL)
                SecureField("API Key → Keychain", text: $apiKeyInput)
                Button("保存") {
                    UserDefaults.standard.set(coreMode.rawValue, forKey: "coreMode")
                    UserDefaults.standard.set(baseURL, forKey: "serverBaseURL")
                    Task {
                        try? await KeychainStore().saveAsync(apiKeyInput, account: "apiKey")
                        CredentialCache.shared.replace(with: apiKeyInput)
                    }
                }
                Text("模式或地址变更后请退出并重新打开 App。remote 模式检测到本机 :8770 时会拒绝连接。")
                    .font(.caption)
            }
        }.formStyle(.grouped)
    }
}

extension Notification.Name {
    static let companionLaunchAtLoginChanged = Notification.Name("companionLaunchAtLoginChanged")
}

// MARK: - Developer

struct DeveloperSettingsSection: View {
    let api: APIClient
    @State private var info = ""
    @State private var detailsExpanded = false

    var body: some View {
        Form {
            Section("本机诊断") {
                Text("生成一份当前运行状态，便于排查连接或能力问题。内容只显示在本机，不会自动发送。")
                    .font(DS.Typography.secondary)
                    .foregroundStyle(DS.ColorToken.textSecondary)
                Button(info.isEmpty ? "生成诊断信息" : "重新生成") {
                    Task {
                        if let data = try? await api.getJSON("/admin/status"),
                           let value = String(data: data, encoding: .utf8) {
                            info = value
                            detailsExpanded = true
                        }
                    }
                }
                if !info.isEmpty {
                    DisclosureGroup("查看技术详情", isExpanded: $detailsExpanded) {
                        ScrollView {
                            Text(info)
                                .font(DS.Typography.mono)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, DS.Space.s)
                        }
                        .frame(minHeight: 120, maxHeight: 360)
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
}
