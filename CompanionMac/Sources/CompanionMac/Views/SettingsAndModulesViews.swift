import SwiftUI
import CompanionKit

struct SettingsView: View {
    @ObservedObject var settings: SettingsViewModel
    let api: APIClient
    @State private var personaText: String = ""
    @State private var serverBaseURL: String = UserDefaults.standard.string(forKey: "serverBaseURL") ?? "http://127.0.0.1:8770"
    @State private var coreMode = CoreDeploymentMode.resolve(environment: nil, stored: UserDefaults.standard.string(forKey: "coreMode"))
    @State private var apiKeyInput: String = ""

    var body: some View {
        Form {
            Section("连接") {
                Picker("运行模式", selection: $coreMode) {
                    Text("本机 Candidate").tag(CoreDeploymentMode.local)
                    Text("远端 Core").tag(CoreDeploymentMode.remote)
                }
                TextField("Core 地址", text: $serverBaseURL)
                SecureField("API Key（存入 Keychain，不落盘明文）", text: $apiKeyInput)
                Button("保存连接设置") {
                    UserDefaults.standard.set(coreMode.rawValue, forKey: "coreMode")
                    UserDefaults.standard.set(serverBaseURL, forKey: "serverBaseURL")
                    Task {
                        try? await KeychainStore().saveAsync(apiKeyInput, account: "apiKey")
                        CredentialCache.shared.replace(with: apiKeyInput)
                    }
                }
                Text("保存后重启 App 生效；remote 模式不会启动本机 Core/Sub2API。")
                    .font(.caption)
            }
            Section("主动行为（Behavior State，与 Persona 分离）") {
                behaviorForm
            }
            Section("Persona（经 Admin API 校验编辑）") {
                TextEditor(text: $personaText).frame(minHeight: 140)
                Button("从 Core 加载 Persona JSON") {
                    Task {
                        if let data = try? await api.getJSON("/admin/personas"), let str = String(data: data, encoding: .utf8) {
                            personaText = str
                        }
                    }
                }
                Button("保存 Persona（走 schema 校验）") {
                    Task {
                        if let data = personaText.data(using: .utf8),
                           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                           let id = obj["id"] as? String,
                           let body = try? JSONSerialization.data(withJSONObject: obj) {
                            _ = try? await api.send("PATCH", "/admin/personas/\(id)", body: body)
                        }
                    }
                }
                Text("Agent System Override 与日常 Persona 在 Core 内部分开注入；此处仅展示完整配置。").font(.caption).foregroundStyle(.secondary)
            }
            if let err = settings.errorText {
                Text(err).foregroundStyle(.red).font(.caption)
            }
        }
        .formStyle(.grouped)
        .task { await settings.load() }
    }

    private var behaviorForm: some View {
        Group {
            Picker("主动程度", selection: $settings.level) {
                Text("low").tag("low")
                Text("normal").tag("normal")
                Text("active").tag("active")
            }
            Toggle("主动消息", isOn: $settings.proactiveMessages)
            HStack {
                TextField("Quiet start", text: $settings.quietStart).frame(width: 90)
                Text("→")
                TextField("Quiet end", text: $settings.quietEnd).frame(width: 90)
            }
            Toggle("天气感知", isOn: $settings.weatherAwareness)
            Toggle("Follow-up", isOn: $settings.followUp)
            Toggle("主动图片", isOn: $settings.proactiveImages)
            Stepper("每日主动消息上限：\(settings.dailyCap)", value: $settings.dailyCap, in: 0...20)
            Stepper("每日主动图片上限：\(settings.dailyImageCap)", value: $settings.dailyImageCap, in: 0...10)
            Button("保存 Behavior 设置") {
                Task { await settings.save() }
            }
            if let savedAt = settings.savedAt {
                Text("已保存 \(CompanionTime.naturalDateTime(fromISO8601: ISO8601DateFormatter().string(from: savedAt)))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct ModulesView: View {
    @StateObject private var vm: ModulesViewModel

    init(api: APIClient) { _vm = StateObject(wrappedValue: ModulesViewModel(api: api)) }

    private let columns = [GridItem(.adaptive(minimum: 320, maximum: 460), spacing: DS.Space.l)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Space.l) {
                if let err = vm.errorText {
                    Label(err, systemImage: "wifi.exclamationmark")
                        .foregroundStyle(DS.ColorToken.warning)
                        .padding(DS.Space.m)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(DS.ColorToken.warning.opacity(0.10), in: RoundedRectangle(cornerRadius: DS.Radius.m))
                }
                LazyVGrid(columns: columns, spacing: DS.Space.l) {
                    ForEach(Array(vm.rows.enumerated()), id: \.offset) { _, m in
                        ModuleCard(m: m)
                    }
                }
                if vm.rows.isEmpty && !vm.isLoading {
                    EmptyStateView(icon: "puzzlepiece",
                                   title: "还没有安装插件",
                                   subtitle: "将模块放入 modules/ 目录后会自动出现在这里")
                }
            }
            .padding(DS.Space.xl)
        }
        .overlay { if vm.isLoading { ProgressView().scaleEffect(1.3) } }
        .background(DS.ColorToken.surface)
        .task {
            Breadcrumb.emit("modules.view.appear")
            await vm.load()
        }
        .onDisappear { Breadcrumb.emit("modules.view.disappear") }
    }

    private func subtitle(_ m: [String: JSONValue]) -> String {
        if m["id"]?.stringValue == "comfyui" { return "127.0.0.1:8188" }
        if m["id"]?.stringValue == "weather" { return "Open-Meteo" }
        return m["description"]?.stringValue ?? ""
    }

}

struct ModuleCard: View {
    let m: [String: JSONValue]
    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.s) {
            HStack {
                Text(m["name"]?.stringValue ?? m["id"]?.stringValue ?? "?")
                    .font(.headline).foregroundStyle(DS.ColorToken.textPrimary)
                Spacer()
                // 由父视图提供状态 pill —— 简化：此处仅显示 loaded 状态
                Text(m["enabled"]?.boolValue == true ? (m["loaded"]?.boolValue == true ? "● Enabled" : "● Error") : "○ Disabled")
                    .font(DS.Typography.caption)
                    .foregroundStyle(m["loaded"]?.boolValue == true ? DS.ColorToken.success : DS.ColorToken.textTertiary)
            }
            Text(subtitleLine)
                .font(DS.Typography.caption)
                .foregroundStyle(DS.ColorToken.textSecondary)
                .lineLimit(1)
            Divider().opacity(0.5)
            capabilityChips
            if let tools = m["tools"], case .array(let list) = tools {
                Text("工具：" + list.compactMap { t in
                    if case .dictionary(let d) = t { return d["name"]?.stringValue }
                    return nil
                }.joined(separator: " / "))
                    .font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textSecondary)
                    .lineLimit(2)
            }
            if let err = m["last_error"]?.stringValue, !err.isEmpty {
                Label(err, systemImage: "exclamationmark.triangle")
                    .font(DS.Typography.caption).foregroundStyle(DS.ColorToken.warning)
                    .lineLimit(2)
            }
        }
        .padding(DS.Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous)
                .fill(DS.ColorToken.bubbleCompanion)
                .shadow(color: .black.opacity(0.05), radius: 5, y: 2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous)
                .strokeBorder(DS.ColorToken.separator, lineWidth: 1)
        )
    }

    private var subtitleLine: String {
        let id = m["id"]?.stringValue ?? ""
        if id == "comfyui" { return "127.0.0.1:8188" }
        if id == "weather" { return "Open-Meteo" }
        return m["description"]?.stringValue ?? ""
    }

    private var capabilityChips: some View {
        let perms: [String] = {
            guard case .array(let list) = m["permissions"] else { return [] }
            return list.compactMap { p in
                guard let name = p["name"]?.stringValue, p["granted"]?.boolValue == true else { return nil }
                return name
            }
        }()
        return HStack(spacing: DS.Space.xs) {
            ForEach(perms.prefix(4), id: \.self) { TagChip(text: $0, tint: DS.ColorToken.accent) }
            if perms.count > 4 { TagChip(text: "+\(perms.count-4)", tint: DS.ColorToken.textTertiary) }
        }
    }
}

struct MemoryView: View {
    let api: APIClient
    @State private var query: String = ""
    @State private var rows: [[String: JSONValue]] = []

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                TextField("搜索 Shared Memory", text: $query).textFieldStyle(.roundedBorder)
                Button("搜索") { Task { await load() } }
            }.padding(10)
            List {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, m in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(m["content"]?.stringValue ?? "").textSelection(.enabled)
                        HStack {
                            Text(m["type"]?.stringValue ?? "").tagStyle()
                            Text(m["status"]?.stringValue ?? "").tagStyle()
                            Text("importance \((m["importance"]?.stringValue ?? ""))").foregroundStyle(.secondary)
                        }.font(.caption)
                    }.padding(.vertical, 2)
                }
                if rows.isEmpty { Text("无结果").foregroundStyle(.secondary) }
            }
        }
        .task { await load() }
    }

    func load() async {
        var comps = URLComponents(string: api.url(for: "/admin/memories")?.absoluteString ?? "")
        var items = [URLQueryItem(name: "status", value: "all")]
        if !query.isEmpty { items.append(URLQueryItem(name: "search", value: query)) }
        comps?.queryItems = items
        guard let url = comps?.url, let data = try? await api.getJSON(url.path + (url.query.map { "?" + $0 } ?? "")),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let arr = raw["data"] as? [[String: Any]] else { rows = []; return }
        rows = arr.map { dict in
            var out: [String: JSONValue] = [:]
            for (k, v) in dict {
                out[k] = (try? JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: v))) ?? .null
            }
            return out
        }
    }
}

extension Text {
    func tagStyle() -> Text {
        self.font(.caption2)
    }
}
