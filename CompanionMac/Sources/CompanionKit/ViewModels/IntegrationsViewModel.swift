import Foundation
import Combine

/// MCP Integrations（外部 MCP Server 连接）管理状态。
/// Secret（env 值 / auth token）只在添加时发送一次给 Core（Core 侧 0600 安全存储），
/// 本 ViewModel 与 Admin API 响应均不持有、不回显任何 secret。
@MainActor
public final class IntegrationsViewModel: ObservableObject {
    public struct Integration: Equatable, Identifiable {
        public let id: String
        public let name: String
        public let type: String
        public let enabled: Bool
        public let availableToAgent: Bool
        public let availableToChat: Bool
        public let command: String?
        public let args: [String]
        public let envKeys: [String]
        public let url: String?
        public let hasAuth: Bool
        public let authType: String
        public let oauthStatus: String
        public let status: String
        public let lastError: String?
        public let toolsCount: Int
    }

    public struct ToolInfo: Equatable {
        public let id: String
        public let wireName: String
        public let displayName: String
        public let description: String
        public let riskLevel: String
        public let sideEffect: String
        public let denied: Bool
        public let inputSchemaJSON: String
    }

    public struct TestResult: Equatable {
        public let ok: Bool
        public let status: String
        public let toolsCount: Int
        public let error: String?
    }

    @Published public private(set) var integrations: [Integration] = []
    @Published public private(set) var isLoading = false
    @Published public var errorText: String?
    @Published public var statusText: String = ""

    private let api: APIClient
    private var generation = 0

    public init(api: APIClient) { self.api = api }

    public func load() async {
        guard !isLoading else { return }
        isLoading = true
        generation += 1
        let current = generation
        defer { if generation == current { isLoading = false } }
        do {
            let data = try await api.getJSON("/admin/integrations")
            guard generation == current else { return }
            integrations = try Self.parseIntegrations(data)
            errorText = nil
        } catch {
            if generation == current { errorText = "连接列表加载失败：\(error)" }
        }
    }

    public func addConnection(name: String, type: String, command: String, args: [String], envText: String, url: String, auth: String,
                              authType: String = "none", oauthClientId: String = "",
                              availableToAgent: Bool = true, availableToChat: Bool = false) async -> Bool {
        var env: [String: String] = [:]
        for line in envText.split(whereSeparator: \.isNewline) {
            let parts = line.split(separator: "=", maxSplits: 1)
            if parts.count == 2 { env[String(parts[0]).trimmingCharacters(in: .whitespaces)] = String(parts[1]) }
        }
        let payload: [String: Any] = [
            "name": name, "type": type,
            "command": command, "args": args, "env": env,
            "url": url, "auth": auth, "authType": authType, "oauthClientId": oauthClientId,
            "availableToAgent": availableToAgent, "availableToChat": availableToChat
        ]
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return false }
        do {
            let created = try await api.send("POST", "/admin/integrations", body: body)
            guard let raw = try? JSONSerialization.jsonObject(with: created) as? [String: Any],
                  let id = raw["id"] as? String, !id.isEmpty else {
                statusText = "连接已添加，但返回内容无法解析"
                await load()
                return false
            }
            let result = await test(id)
            statusText = result?.ok == true ? "连接已添加并通过测试：发现 \(result?.toolsCount ?? 0) 个工具" : "连接已添加，但测试失败：\(result?.error ?? result?.status ?? "未知错误")"
            await load()
            return true
        } catch {
            statusText = "添加失败：\(error)"
            return false
        }
    }

    public func setEnabled(_ id: String, _ enabled: Bool) async {
        await update(id, ["enabled": enabled])
    }

    public func setAvailableToChat(_ id: String, _ enabled: Bool) async {
        await update(id, ["availableToChat": enabled])
    }

    public func setAvailableToAgent(_ id: String, _ enabled: Bool) async {
        await update(id, ["availableToAgent": enabled])
    }

    public func setToolDenied(_ integrationId: String, _ capabilityId: String, denied: Bool, current: [ToolInfo]) async {
        var policy: [String: String] = [:]
        for tool in current { policy[tool.id] = (tool.denied || tool.id == capabilityId && denied) ? "deny" : "allow" }
        if !denied { policy[capabilityId] = "allow" }
        await update(integrationId, ["toolPolicy": policy])
    }

    private func update(_ id: String, _ patch: [String: Any]) async {
        guard let body = try? JSONSerialization.data(withJSONObject: patch) else { return }
        do {
            _ = try await api.send("PUT", "/admin/integrations/\(id)", body: body)
            await load()
        } catch {
            statusText = "更新失败：\(error)"
        }
    }

    public func remove(_ id: String) async {
        do {
            _ = try await api.send("DELETE", "/admin/integrations/\(id)", body: nil)
            statusText = "连接已删除"
            await load()
        } catch {
            statusText = "删除失败：\(error)"
        }
    }

    public func test(_ id: String) async -> TestResult? {
        do {
            let data = try await api.send("POST", "/admin/integrations/\(id)/test", body: nil)
            let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let result = TestResult(
                ok: raw?["ok"] as? Bool ?? false,
                status: raw?["status"] as? String ?? "",
                toolsCount: raw?["toolsCount"] as? Int ?? raw?["tools_count"] as? Int ?? 0,
                error: raw?["error"] as? String
            )
            statusText = result.ok ? "测试成功：已连接，发现 \(result.toolsCount) 个工具" : "测试失败：\(result.error ?? result.status)"
            await load()
            return result
        } catch {
            statusText = "测试失败：\(error)"
            return nil
        }
    }

    public func startOAuth(_ id: String) async -> URL? {
        do {
            let data = try await api.send("POST", "/admin/integrations/\(id)/oauth-start", body: nil)
            let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard let value = raw?["authorizationUrl"] as? String, let url = URL(string: value) else {
                statusText = raw?["status"] as? String == "connected" ? "OAuth 已授权并连接" : "未获得 OAuth 授权地址"
                await load()
                return nil
            }
            statusText = "请在浏览器中完成授权；Companion 不会读取密码"
            await load()
            return url
        } catch {
            statusText = "OAuth 启动失败：\(error)"
            return nil
        }
    }

    public func tools(_ id: String) async -> [ToolInfo] {
        do {
            let data = try await api.getJSON("/admin/integrations/\(id)/tools")
            return try Self.parseTools(data)
        } catch { return [] }
    }

    // MARK: - 解析

    static func parseIntegrations(_ data: Data) throws -> [Integration] {
        guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let arr = raw["data"] as? [[String: Any]] else { throw APIError.decoding("integrations payload malformed") }
        return arr.map { item in
            Integration(
                id: item["id"] as? String ?? "",
                name: item["name"] as? String ?? "",
                type: item["type"] as? String ?? "",
                enabled: item["enabled"] as? Bool ?? false,
                availableToAgent: item["availableToAgent"] as? Bool ?? true,
                availableToChat: item["availableToChat"] as? Bool ?? false,
                command: item["command"] as? String,
                args: item["args"] as? [String] ?? [],
                envKeys: item["envKeys"] as? [String] ?? [],
                url: item["url"] as? String,
                hasAuth: item["hasAuth"] as? Bool ?? false,
                authType: item["authType"] as? String ?? ((item["hasAuth"] as? Bool ?? false) ? "bearer" : "none"),
                oauthStatus: item["oauthStatus"] as? String ?? "not_applicable",
                status: item["status"] as? String ?? "disconnected",
                lastError: item["lastError"] as? String,
                toolsCount: item["toolsCount"] as? Int ?? 0
            )
        }
    }

    static func parseTools(_ data: Data) throws -> [ToolInfo] {
        guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let arr = raw["data"] as? [[String: Any]] else { throw APIError.decoding("tools payload malformed") }
        return arr.map { item in
            let schemaJSON = (try? JSONSerialization.data(withJSONObject: item["inputSchema"] ?? [:], options: [.prettyPrinted]))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            return ToolInfo(
                id: item["id"] as? String ?? "",
                wireName: item["wireName"] as? String ?? "",
                displayName: item["displayName"] as? String ?? "",
                description: item["description"] as? String ?? "",
                riskLevel: item["riskLevel"] as? String ?? "low",
                sideEffect: item["sideEffect"] as? String ?? "unknown",
                denied: item["denied"] as? Bool ?? false,
                inputSchemaJSON: schemaJSON
            )
        }
    }
}
