import SwiftUI
import CompanionKit
import AppKit

/// 插件页：上半区 MCP 连接（Integrations），下半区本地模块。
/// 避免两个重复管理中心：MCP 连接只在这里管理。
struct IntegrationsCenterView: View {
    let api: APIClient
    @StateObject private var integrations: IntegrationsViewModel
    @StateObject private var modules: ModulesViewModel
    @State private var showingAddSheet = false
    @State private var selectedIntegration: IntegrationsViewModel.Integration?
    @State private var runtimeControls: LocalRuntimeControlsSnapshot?

    init(api: APIClient) {
        self.api = api
        _integrations = StateObject(wrappedValue: IntegrationsViewModel(api: api))
        _modules = StateObject(wrappedValue: ModulesViewModel(api: api))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Space.xl) {
                sectionHeader("Local Agent Runtime", "Native Agent 直接使用的本机结构化能力；不创建第二个 Agent")
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 260, maximum: 420), spacing: DS.Space.l)], spacing: DS.Space.l) {
                    BuiltinRuntimeCard(title: "Terminal", symbol: "terminal", status: runtimeStatus("terminal"), detail: "结构化命令、长任务 session、输出脱敏与取消", statusColor: runtimeColor("terminal"))
                    BuiltinRuntimeCard(title: "Filesystem", symbol: "folder.badge.gearshape", status: runtimeStatus("filesystem"), detail: "授权 workspace 内读取、搜索、精确 patch 与可恢复删除", statusColor: runtimeColor("filesystem"))
                    BuiltinRuntimeCard(title: "Git", symbol: "arrow.triangle.branch", status: "Installed", detail: "结构化状态、差异、分支、提交、普通推送与检查点")
                    BuiltinRuntimeCard(title: "GitHub", symbol: "network", status: "Needs Auth", detail: "安全调用 gh 读取或管理 Issue、PR、CI 与 Release", statusColor: DS.ColorToken.warning)
                    BuiltinRuntimeCard(title: "Process", symbol: "waveform.path.ecg.rectangle", status: "Installed", detail: "启动、检查并停止当前 Agent 会话自己拥有的进程")
                    BuiltinRuntimeCard(title: "Service", symbol: "server.rack", status: "Installed", detail: "端口检查、loopback 健康探测与授权日志尾读")
                    BuiltinRuntimeCard(title: "Package Manager", symbol: "shippingbox", status: runtimeStatus("package_manager"), detail: "固定版本项目依赖、workspace .venv、已知 formula 与 SHA-256 Release binary", statusColor: runtimeColor("package_manager"))
                    BuiltinRuntimeCard(title: "Self Maintenance", symbol: "arrow.triangle.2.circlepath.circle", status: runtimeControls?.enabled["self_maintenance"] == false ? "Disabled" : "Candidate Only", detail: "事务化源码修改、完整测试、严格签名、Desktop 备份与自动回滚", statusColor: runtimeControls?.enabled["self_maintenance"] == false ? DS.ColorToken.textTertiary : DS.ColorToken.warning)
                }
                Text("Ready 状态由每个 Agent turn 的 workspace scope 决定；未授权路径不会自动开放。")
                    .font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)

                Divider().opacity(0.6)
                sectionHeader("MCP 连接", "外部 MCP Server；工具经 Capability Registry 与权限层进入模型")
                if let err = integrations.errorText {
                    Label(err, systemImage: "wifi.exclamationmark")
                        .foregroundStyle(DS.ColorToken.warning)
                }
                ForEach(integrations.integrations, id: \.id) { item in
                    IntegrationCard(item: item, vm: integrations) { selectedIntegration = $0 }
                }
                if integrations.integrations.isEmpty && !integrations.isLoading {
                    EmptyStateView(icon: "point.3.filled.connected.trianglepath.dotted",
                                   title: "还没有 MCP 连接",
                                   subtitle: "添加一个本地 stdio 或 HTTP MCP Server，工具会自动发现")
                }
                HStack {
                    Button("＋ 添加连接") { showingAddSheet = true }
                        .buttonStyle(.borderedProminent)
                    if !integrations.statusText.isEmpty {
                        Text(integrations.statusText).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textSecondary)
                    }
                }

                Divider().opacity(0.6)
                sectionHeader("本地模块", "modules/ 目录中的本地插件")
                if let err = modules.errorText {
                    Label(err, systemImage: "wifi.exclamationmark").foregroundStyle(DS.ColorToken.warning)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 320, maximum: 460), spacing: DS.Space.l)], spacing: DS.Space.l) {
                    ForEach(Array(modules.rows.enumerated()), id: \.offset) { _, m in
                        ModuleCard(m: m)
                    }
                }
                if modules.rows.isEmpty && !modules.isLoading {
                    EmptyStateView(icon: "puzzlepiece", title: "还没有安装插件", subtitle: "将模块放入 modules/ 目录后会自动出现在这里")
                }
            }
            .padding(DS.Space.xl)
        }
        .overlay { if integrations.isLoading || modules.isLoading { ProgressView().scaleEffect(1.3) } }
        .background(DS.ColorToken.surface)
        .task {
            runtimeControls = try? await api.localRuntimeControls()
            await loadIntegrationsUntilSettled()
            await modules.load()
        }
        .sheet(isPresented: $showingAddSheet) {
            AddIntegrationSheet(vm: integrations)
        }
        .sheet(item: $selectedIntegration) { item in
            IntegrationDetailSheet(item: item, vm: integrations)
        }
    }

    private func runtimeStatus(_ key: String) -> String { runtimeControls?.enabled[key] == false ? "Disabled" : "Installed" }
    private func runtimeColor(_ key: String) -> Color { runtimeControls?.enabled[key] == false ? DS.ColorToken.textTertiary : DS.ColorToken.success }

    /// Core health 会早于 MCP reconnect/tool discovery 就绪。仅在本页出现时做
    /// 有界刷新，避免 App 重启后卡片永久停留在瞬时的 0 tools 状态。
    private func loadIntegrationsUntilSettled() async {
        for attempt in 0..<5 {
            await integrations.load()
            let pending = integrations.integrations.contains { item in
                item.enabled && (["connecting", "disconnected"].contains(item.status)
                    || (item.status == "connected" && item.toolsCount == 0))
            }
            if !pending || attempt == 4 { return }
            try? await Task.sleep(nanoseconds: 750_000_000)
        }
    }

    private func sectionHeader(_ title: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(DS.Typography.pageTitle).foregroundStyle(DS.ColorToken.textPrimary)
            Text(subtitle).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)
        }
    }
}

private struct BuiltinRuntimeCard: View {
    let title: String
    let symbol: String
    let status: String
    let detail: String
    var statusColor: Color = DS.ColorToken.success
    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.s) {
            HStack {
                Image(systemName: symbol).foregroundStyle(DS.ColorToken.accent)
                Text(title).font(.headline)
                Spacer()
                Text(status).font(DS.Typography.caption).foregroundStyle(statusColor)
            }
            Text(detail).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textSecondary)
        }
        .padding(DS.Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DS.ColorToken.surfaceSecondary, in: RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous).strokeBorder(DS.ColorToken.separator.opacity(0.5)))
    }
}

/// 单张连接卡：名称 / 类型 / 状态 / 工具数 / 启用开关
struct IntegrationCard: View {
    let item: IntegrationsViewModel.Integration
    @ObservedObject var vm: IntegrationsViewModel
    var onOpen: (IntegrationsViewModel.Integration) -> Void
    @State private var busy = false
    @State private var showingDeleteConfirmation = false

    private var statusColor: Color {
        if !item.enabled { return DS.ColorToken.textTertiary }
        switch item.status {
        case "connected": return DS.ColorToken.success
        case "error": return DS.ColorToken.danger
        default: return DS.ColorToken.warning
        }
    }

    private var statusLabel: String {
        if !item.enabled { return "已停用" }
        switch item.status {
        case "connected": return "Connected"
        case "authorization_required": return "等待 OAuth"
        case "error": return "错误"
        case "disconnected": return "Disconnected"
        default: return item.status
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.m) {
            HStack(spacing: DS.Space.m) {
                Circle().fill(statusColor).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.name).font(.headline).foregroundStyle(DS.ColorToken.textPrimary)
                    Text("\(item.type == "stdio" ? "Local stdio" : "HTTP") · \(statusLabel)")
                        .font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)
                }
                Spacer()
                Text("\(item.toolsCount) tools").font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textSecondary)
                Toggle("", isOn: Binding(get: { item.enabled }, set: { newValue in
                    Task { await vm.setEnabled(item.id, newValue) }
                }))
                .toggleStyle(.switch).controlSize(.mini).labelsHidden()
                .disabled(busy)
            }
            if let err = item.lastError, !err.isEmpty {
                Text(err).font(.caption2).foregroundStyle(DS.ColorToken.danger).lineLimit(2)
            }
            HStack(spacing: DS.Space.s) {
                if item.authType == "oauth" && item.status != "connected" {
                    Button("OAuth 授权") {
                        busy = true
                        Task {
                            if let url = await vm.startOAuth(item.id) { NSWorkspace.shared.open(url) }
                            busy = false
                        }
                    }
                    .controlSize(.small)
                }
                Button("测试连接") {
                    busy = true
                    Task { _ = await vm.test(item.id); busy = false }
                }
                .controlSize(.small)
                Button("工具与权限") { onOpen(item) }
                    .controlSize(.small)
                Button("删除", role: .destructive) {
                    showingDeleteConfirmation = true
                }
                .controlSize(.small)
                Spacer()
            }
            .disabled(busy)
        }
        .padding(DS.Space.l)
        .background(DS.ColorToken.surfaceSecondary, in: RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous).strokeBorder(DS.ColorToken.separator.opacity(0.5)))
        .confirmationDialog("删除连接“\(item.name)”？", isPresented: $showingDeleteConfirmation, titleVisibility: .visible) {
            Button("删除连接和已保存凭据", role: .destructive) {
                busy = true
                Task { await vm.remove(item.id); busy = false }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("此操作会移除连接配置及其安全存储的环境变量或令牌。")
        }
    }
}

/// 添加连接：stdio（command/args/env）或 HTTP（url/auth）
struct AddIntegrationSheet: View {
    @ObservedObject var vm: IntegrationsViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var type = "stdio"
    @State private var command = ""
    @State private var argsText = ""
    @State private var envText = ""   // 每行 KEY=VALUE；发送一次后由 Core 安全存储
    @State private var url = ""
    @State private var auth = ""      // Bearer token；发送一次后由 Core 安全存储
    @State private var authType = "none"
    @State private var oauthClientId = ""
    @State private var preset = "custom"
    @State private var availableToAgent = true
    @State private var availableToChat = false

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.l) {
            Text("添加 MCP 连接").font(DS.Typography.pageTitle)
            Picker("官方预设", selection: $preset) {
                Text("自定义").tag("custom")
                Text("Playwright").tag("playwright")
                Text("Notion").tag("notion")
                Text("Home Assistant").tag("home_assistant")
            }
            .onChange(of: preset) { applyPreset($0) }
            Picker("类型", selection: $type) {
                Text("Local MCP (stdio)").tag("stdio")
                Text("HTTP MCP").tag("http")
            }.pickerStyle(.segmented)
            TextField("名称（如 GitHub MCP）", text: $name)
            if type == "stdio" {
                TextField("Command（如 node）", text: $command)
                TextField("Arguments（空格分隔）", text: $argsText)
                SecureField("环境变量（每行 KEY=VALUE，仅发送一次）", text: $envText)
                Text("Env 值由 Core 写入数据目录的安全配置（0600），不会出现在列表或日志中。")
                    .font(.caption2).foregroundStyle(.secondary)
            } else {
                TextField("URL（如 http://127.0.0.1:3000/mcp）", text: $url)
                Picker("认证", selection: $authType) {
                    Text("无").tag("none")
                    Text("OAuth（推荐）").tag("oauth")
                    Text("Bearer Token").tag("bearer")
                }.pickerStyle(.segmented)
                if authType == "bearer" {
                    SecureField("Bearer Token（仅发送一次）", text: $auth)
                } else if authType == "oauth" {
                    Text("授权会在系统浏览器中完成；Companion 不读取密码、Cookie 或浏览器 Session。")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            HStack {
                Toggle("Agent 可用", isOn: $availableToAgent)
                Toggle("Chat 可用", isOn: $availableToChat)
            }.toggleStyle(.switch).controlSize(.small)
            if !vm.statusText.isEmpty {
                Text(vm.statusText).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textSecondary)
            }
            HStack {
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("添加并测试") { Task { await add() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || !formValid)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(DS.Space.xl)
        .frame(width: 460)
    }

    private var formValid: Bool {
        type == "stdio" ? !command.trimmingCharacters(in: .whitespaces).isEmpty : !url.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func add() async {
        let args = argsText.split(whereSeparator: \.isWhitespace).map(String.init)
        let ok = await vm.addConnection(
            name: name.trimmingCharacters(in: .whitespaces),
            type: type,
            command: command.trimmingCharacters(in: .whitespaces),
            args: args,
            envText: envText,
            url: url.trimmingCharacters(in: .whitespaces),
            auth: auth.trimmingCharacters(in: .whitespaces),
            authType: authType, oauthClientId: oauthClientId,
            availableToAgent: availableToAgent, availableToChat: availableToChat
        )
        if ok { dismiss() }
    }

    private func applyPreset(_ value: String) {
        auth = ""; envText = ""; oauthClientId = ""
        switch value {
        case "playwright":
            name = "Playwright"; type = "stdio"; command = "npx"
            argsText = "-y @playwright/mcp@latest"; url = ""; authType = "none"
            availableToAgent = true; availableToChat = false
        case "notion":
            name = "Notion"; type = "http"; command = ""; argsText = ""
            url = "https://mcp.notion.com/mcp"; authType = "oauth"
            availableToAgent = true; availableToChat = true
        case "home_assistant":
            name = "Home Assistant"; type = "http"; command = ""; argsText = ""
            url = ""; authType = "oauth"
            availableToAgent = true; availableToChat = true
        default: break
        }
    }
}

/// 工具详情：名称 / 说明 / 风险 / per-tool Allow-Deny；schema 收进 Developer 折叠区
struct IntegrationDetailSheet: View {
    let item: IntegrationsViewModel.Integration
    @ObservedObject var vm: IntegrationsViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var tools: [IntegrationsViewModel.ToolInfo] = []
    @State private var showDeveloper = false
    @State private var availableToAgent: Bool
    @State private var availableToChat: Bool

    init(item: IntegrationsViewModel.Integration, vm: IntegrationsViewModel) {
        self.item = item
        self.vm = vm
        _availableToAgent = State(initialValue: item.availableToAgent)
        _availableToChat = State(initialValue: item.availableToChat)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.l) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.name).font(DS.Typography.pageTitle)
                    Text("\(item.toolsCount) tools · \(item.type == "stdio" ? item.command ?? "" : item.url ?? "")")
                        .font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)
                }
                Spacer()
                Button("完成") { dismiss() }.keyboardShortcut(.defaultAction)
            }
            if tools.isEmpty {
                HStack { ProgressView().controlSize(.small); Text("正在加载工具…").font(.caption).foregroundStyle(.secondary) }
            }
            HStack(spacing: DS.Space.l) {
                Toggle("Agent 可用", isOn: $availableToAgent)
                    .onChange(of: availableToAgent) { enabled in Task { await vm.setAvailableToAgent(item.id, enabled) } }
                Toggle("Chat 可用（显式授权）", isOn: $availableToChat)
                    .onChange(of: availableToChat) { enabled in Task { await vm.setAvailableToChat(item.id, enabled) } }
                Spacer()
            }
            .toggleStyle(.switch)
            .controlSize(.small)
            ForEach(tools, id: \.id) { tool in
                VStack(alignment: .leading, spacing: DS.Space.xs) {
                    HStack {
                        Text(tool.displayName).font(.system(.body, design: .monospaced).weight(.medium))
                        TagChip(text: riskLabel(tool.riskLevel), tint: riskColor(tool.riskLevel))
                        Spacer()
                        Toggle(tool.denied ? "Denied" : "Allowed", isOn: Binding(
                            get: { !tool.denied },
                            set: { allowed in
                                Task {
                                    await vm.setToolDenied(item.id, tool.id, denied: !allowed, current: tools)
                                    tools = await vm.tools(item.id)
                                }
                            }
                        ))
                        .toggleStyle(.switch).controlSize(.mini)
                    }
                    Text(tool.description).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textSecondary).lineLimit(2)
                    DisclosureGroup("Developer") {
                        ScrollView { Text(tool.inputSchemaJSON).font(DS.Typography.mono).textSelection(.enabled) }
                            .frame(maxHeight: 160)
                    }
                    .font(.caption2)
                }
                .padding(DS.Space.m)
                .background(DS.ColorToken.surfaceSecondary, in: RoundedRectangle(cornerRadius: DS.Radius.m))
            }
            Spacer()
        }
        .padding(DS.Space.xl)
        .frame(width: 560, height: 520)
        .task { tools = await vm.tools(item.id) }
    }

    private func riskLabel(_ risk: String) -> String {
        switch risk { case "high": return "高风险"; case "medium": return "中风险"; default: return "低风险" }
    }
    private func riskColor(_ risk: String) -> Color {
        switch risk { case "high": return DS.ColorToken.danger; case "medium": return DS.ColorToken.warning; default: return DS.ColorToken.success }
    }
}
