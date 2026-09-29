import Foundation
import Combine

/// Modules 页面状态（@MainActor 隔离；UI-facing 全部在此）。
/// 失败路径显式呈现 errorText，不静默；重复 load 通过 generation 防竞争。
@MainActor
public final class ModulesViewModel: ObservableObject {
    @Published public private(set) var rows: [[String: JSONValue]] = []
    @Published public private(set) var isLoading = false
    @Published public private(set) var errorText: String?

    private let api: APIClient
    private var currentLoadGeneration = 0

    public init(api: APIClient) { self.api = api }

    public func load() async {
        guard !isLoading else { Breadcrumb.emit("modules.load.skip-busy"); return }
        isLoading = true
        errorText = nil
        currentLoadGeneration += 1
        let generation = currentLoadGeneration
        Breadcrumb.emit("modules.load.start")
        do {
            let data = try await api.getJSON("/admin/modules")
            guard generation == currentLoadGeneration else {
                Breadcrumb.emit("modules.load.stale-drop")
                return
            }
            guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let arr = raw["modules"] as? [[String: Any]] else {
                throw APIError.decoding("modules payload malformed")
            }
            rows = arr.compactMap { d in
                guard let data2 = try? JSONSerialization.data(withJSONObject: d),
                      let v = try? JSONDecoder().decode(JSONValue.self, from: data2),
                      let dict = v.dictionaryValue else { return nil }
                return dict
            }
            Breadcrumb.emit("modules.load.success")
        } catch is CancellationError {
            Breadcrumb.emit("modules.load.cancelled")
        } catch {
            // offline / core 重启窗口：显式失败态，绝不静默清空已有列表
            guard generation == currentLoadGeneration else { return }
            errorText = "模块列表加载失败：\(error)"
            Breadcrumb.emit("modules.load.failure")
        }
        if generation == currentLoadGeneration {
            isLoading = false
        }
    }

    /// Core 断连/恢复时由外部调用：进入明确的 offline 错误态
    public func markOffline() {
        errorText = "Core 连接不可用，模块状态暂时无法获取。"
        Breadcrumb.emit("modules.error.present")
    }
}
