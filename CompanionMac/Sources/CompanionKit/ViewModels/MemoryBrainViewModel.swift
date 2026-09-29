import Foundation
import Combine

@MainActor
public final class MemoryBrainViewModel: ObservableObject {
    @Published public var snapshot: MemoryBrainResponse?
    @Published public var selectedID: String?
    @Published public var query = ""
    @Published public var recallRows: [MemoryRecallPreview.Row] = []
    @Published public var searchResultIDs: [String] = []
    @Published public var focusID: String?
    @Published public var manualAssessment: ManualMemoryAssessment?
    @Published public var noticeText: String?
    @Published public var isLoading = false
    @Published public var isSearching = false
    @Published public var isMutating = false
    @Published public var errorText: String?

    private let api: APIClientProtocol
    public init(api: APIClientProtocol) { self.api = api }

    public var visibleNodes: [MemoryBrainResponse.Node] {
        snapshot?.nodes ?? []
    }

    public var searchResults: [MemoryBrainResponse.Node] {
        guard let nodes = snapshot?.nodes else { return [] }
        let map = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0) })
        return searchResultIDs.compactMap { map[$0] }
    }

    public var selectedNode: MemoryBrainResponse.Node? {
        snapshot?.nodes.first { $0.id == selectedID }
    }

    public var relatedNodes: [MemoryBrainResponse.Node] {
        guard let selected = selectedNode, let snapshot else { return [] }
        var ids = Set(selected.relatedMemoryIds)
        for edge in snapshot.edges {
            if edge.source == selected.id { ids.insert(edge.target) }
            if edge.target == selected.id { ids.insert(edge.source) }
        }
        return snapshot.nodes.filter { ids.contains($0.id) }
    }

    public func load() async {
        isLoading = true; defer { isLoading = false }
        do {
            let data = try await api.getJSON("/admin/memory/brain?limit=500")
            snapshot = try JSONDecoder().decode(MemoryBrainResponse.self, from: data)
            if selectedID == nil || selectedNode == nil { selectedID = snapshot?.nodes.first?.id }
            errorText = nil
        } catch { errorText = String(describing: error) }
    }

    public func search() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { clearSearch(); return }
        isSearching = true; defer { isSearching = false }
        do {
            let encoded = text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
            async let graphData = api.getJSON("/admin/memory/brain?limit=500&search=\(encoded)")
            let body = try JSONSerialization.data(withJSONObject: ["query": text, "limit": 12])
            async let recallData = api.send("POST", "/admin/memories/retrieval-debug", body: body)
            let (graphRaw, recallRaw) = try await (graphData, recallData)
            snapshot = try JSONDecoder().decode(MemoryBrainResponse.self, from: graphRaw)
            let recall = try JSONDecoder().decode(MemoryRecallPreview.self, from: recallRaw)
            recallRows = recall.data
            searchResultIDs = snapshot?.search.resultIds ?? recall.data.map(\.id)
            if let first = searchResultIDs.first { selectedID = first; focusID = first }
            errorText = nil
        } catch { errorText = String(describing: error) }
    }

    public func clearSearch() {
        query = ""; recallRows = []; searchResultIDs = []
        Task { await load() }
    }

    public func select(_ id: String, focus: Bool = false) {
        selectedID = id
        if focus { focusID = nil; focusID = id }
    }

    public func previewRecall() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { recallRows = []; return }
        do {
            let body = try JSONSerialization.data(withJSONObject: ["query": text, "limit": 8])
            let data = try await api.send("POST", "/admin/memories/retrieval-debug", body: body)
            recallRows = try JSONDecoder().decode(MemoryRecallPreview.self, from: data).data
            errorText = nil
        } catch { errorText = String(describing: error) }
    }

    public func prepareManual(_ draft: ManualMemoryDraft) async -> ManualMemoryAssessment? {
        isMutating = true; defer { isMutating = false }
        do {
            let data = try await api.send("POST", "/admin/memories/prepare", body: JSONEncoder().encode(draft))
            let value = try JSONDecoder().decode(ManualMemoryAssessment.self, from: data)
            manualAssessment = value; errorText = nil; return value
        } catch { errorText = String(describing: error); return nil }
    }

    @discardableResult public func createManual(_ draft: ManualMemoryDraft, replacing id: String? = nil, keepAlongside: Bool = false) async -> Bool {
        isMutating = true; defer { isMutating = false }
        do {
            var object: [String: Any] = ["mode":"manual","content":draft.content,"type":draft.type,"temporal_state":draft.temporalState,"importance":draft.importance]
            if let id { object["replaces_id"] = id }
            if keepAlongside { object["keep_alongside"] = true }
            let body = try JSONSerialization.data(withJSONObject: object)
            let data = try await api.send("POST", "/admin/memories", body: body)
            let mutation = try JSONDecoder().decode(ManualMemoryMutation.self, from: data)
            await load()
            if let id = mutation.memory?.id { selectedID = id; focusID = id }
            noticeText = mutation.outcome == "duplicate" ? "已有相同记忆，未重复添加。" : "记忆已加入长期记忆空间。"
            manualAssessment = nil; errorText = nil; return true
        } catch { errorText = String(describing: error); return false }
    }

    public func updateSelected(content: String, type: String, temporalState: String) async -> Bool {
        guard let id = selectedID else { return false }
        isMutating = true; defer { isMutating = false }
        do {
            let body = try JSONSerialization.data(withJSONObject: ["content":content,"type":type,"temporal_state":temporalState])
            _ = try await api.send("PATCH", "/admin/memories/\(id)", body: body)
            await load(); selectedID = id; noticeText = "记忆已更新。"; errorText = nil; return true
        } catch { errorText = String(describing: error); return false }
    }

    public func setSelectedStatus(_ status: String) async -> Bool {
        guard let id = selectedID else { return false }
        isMutating = true; defer { isMutating = false }
        do {
            let body = try JSONSerialization.data(withJSONObject: ["status":status])
            _ = try await api.send("PATCH", "/admin/memories/\(id)", body: body)
            await load(); selectedID = id; noticeText = status == "retired" ? "记忆已归档，可在高级管理中恢复。" : "记忆已恢复。"; errorText = nil; return true
        } catch { errorText = String(describing: error); return false }
    }

    public func deleteSelected() async -> Bool {
        guard let id = selectedID else { return false }
        isMutating = true; defer { isMutating = false }
        do {
            let body = try JSONSerialization.data(withJSONObject: ["confirm":true])
            _ = try await api.send("DELETE", "/admin/memories/\(id)", body: body)
            selectedID = nil; await load(); noticeText = "记忆已删除。"; errorText = nil; return true
        } catch { errorText = String(describing: error); return false }
    }
}
