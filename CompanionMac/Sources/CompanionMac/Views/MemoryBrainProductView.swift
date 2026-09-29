import SwiftUI
import CompanionKit

struct MemoryBrainProductView: View {
    @StateObject private var model: MemoryBrainViewModel
    @State private var zoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var dragOrigin: CGSize = .zero
    @State private var zoomOrigin: CGFloat = 1
    @State private var showAdd = false
    @State private var showEdit = false
    @State private var confirmRetire = false
    @State private var confirmDelete = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(api: APIClient) { _model = StateObject(wrappedValue: MemoryBrainViewModel(api: api)) }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                toolbar
                GeometryReader { proxy in
                    let positions = MemoryBrainLayout.positions(nodes: model.visibleNodes, in: proxy.size)
                    ZStack {
                        MemorySpaceBackground()
                        atmosphere(in: proxy.size)
                        relationCanvas(positions: positions, size: proxy.size)
                        evidenceSatellites(positions: positions, size: proxy.size)

                        ForEach(model.visibleNodes) { node in
                            if let point = positions[node.id] {
                                MemoryNeuronView(
                                    node: node,
                                    selected: model.selectedID == node.id,
                                    searchHit: model.searchResultIDs.contains(node.id),
                                    subdued: !model.searchResultIDs.isEmpty && !model.searchResultIDs.contains(node.id),
                                    reduceMotion: reduceMotion,
                                    onSelect: { model.select(node.id) },
                                    onFocus: { model.select(node.id, focus: true) }
                                )
                                .position(transformed(point, in: proxy.size))
                            }
                        }

                        if model.visibleNodes.isEmpty { emptyState }
                        if !model.searchResultIDs.isEmpty { searchResultsOverlay }
                        canvasFooter
                    }
                    .contentShape(Rectangle())
                    .gesture(panGesture)
                    .simultaneousGesture(zoomGesture)
                    .onTapGesture(count: 2, perform: resetViewport)
                    .onChange(of: model.focusID) { id in
                        guard let id, let point = positions[id] else { return }
                        focus(point, in: proxy.size)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider().opacity(0.55)
            inspector.frame(width: 370)
        }
        .task { await model.load() }
        .sheet(isPresented: $showAdd) { MemoryManualSheet(model: model) }
        .sheet(isPresented: $showEdit) {
            if let node = model.selectedNode { MemoryEditSheet(model: model, node: node) }
        }
        .confirmationDialog("归档这段记忆？", isPresented: $confirmRetire) {
            Button("归档记忆", role: .destructive) { Task { _ = await model.setSelectedStatus("retired") } }
        } message: { Text("记忆会保留审计痕迹，但不再参与正常召回。") }
        .confirmationDialog("永久删除这段记忆？", isPresented: $confirmDelete) {
            Button("永久删除", role: .destructive) { Task { _ = await model.deleteSelected() } }
        } message: { Text("此操作无法撤销。通常建议先归档。") }
        .onExitCommand {
            if !model.query.isEmpty { model.clearSearch() }
            else { model.selectedID = nil }
        }
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "sparkle.magnifyingglass").foregroundStyle(DS.ColorToken.accent)
                TextField("搜索与召回真实记忆…", text: $model.query)
                    .textFieldStyle(.plain)
                    .onSubmit { Task { await model.search() } }
                if !model.query.isEmpty {
                    Button { model.clearSearch() } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(DS.ColorToken.textTertiary)
                }
            }
            .padding(.horizontal, 11).padding(.vertical, 8)
            .frame(minWidth: 260, maxWidth: 390)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(DS.ColorToken.glassBorder, lineWidth: 0.7))

            Button { Task { await model.search() } } label: {
                if model.isSearching { ProgressView().controlSize(.small) } else { Text("召回") }
            }
            .buttonStyle(.borderedProminent).controlSize(.small)

            Button { showAdd = true } label: { Label("添加记忆", systemImage: "plus") }
                .buttonStyle(.bordered).controlSize(.small)

            Spacer(minLength: 10)
            if let snapshot = model.snapshot {
                HStack(spacing: 7) {
                    Label("\(snapshot.nodes.count)", systemImage: "circle.hexagongrid.fill")
                    Text("·")
                    Label("\(snapshot.edges.count) 条真实关联", systemImage: "point.3.connected.trianglepath.dotted")
                }
                .font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textSecondary)
            }
            Button(action: resetViewport) { Image(systemName: "scope") }
                .buttonStyle(.borderless).help("复位记忆空间")
        }
        .padding(.horizontal, 16).padding(.vertical, 11)
        .background(DS.Surface.chrome)
        .overlay(alignment: .bottom) { Rectangle().fill(DS.ColorToken.separator).frame(height: 0.5) }
    }

    private func atmosphere(in size: CGSize) -> some View {
        Canvas { context, canvas in
            let center = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
            for index in 1...6 {
                let factor = CGFloat(index) / 6
                let rect = CGRect(x: center.x - canvas.width * 0.43 * factor,
                                  y: center.y - canvas.height * 0.42 * factor,
                                  width: canvas.width * 0.86 * factor,
                                  height: canvas.height * 0.84 * factor)
                context.stroke(Path(ellipseIn: rect), with: .color(DS.ColorToken.accent.opacity(index == 2 ? 0.12 : 0.045)), lineWidth: index == 2 ? 0.8 : 0.45)
            }
            for index in 0..<54 {
                let x = CGFloat((index * 83 + 31) % 997) / 997 * canvas.width
                let y = CGFloat((index * 47 + 19) % 991) / 991 * canvas.height
                let radius = CGFloat(index % 3 == 0 ? 1.25 : 0.7)
                context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: radius, height: radius)), with: .color(DS.ColorToken.textTertiary.opacity(index % 7 == 0 ? 0.24 : 0.12)))
            }
        }
        .accessibilityHidden(true).allowsHitTesting(false)
    }

    private func relationCanvas(positions: [String: CGPoint], size: CGSize) -> some View {
        Canvas { context, _ in
            guard let snapshot = model.snapshot else { return }
            for edge in snapshot.edges {
                guard let rawStart = positions[edge.source], let rawEnd = positions[edge.target] else { continue }
                let start = transformed(rawStart, in: size), end = transformed(rawEnd, in: size)
                let selected = model.selectedID == edge.source || model.selectedID == edge.target
                let middle = CGPoint(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - min(38, abs(start.x - end.x) * 0.08))
                var path = Path(); path.move(to: start); path.addQuadCurve(to: end, control: middle)
                let dashed = ["temporal", "contradicts", "supersedes"].contains(edge.relation ?? "")
                context.stroke(path, with: .color(DS.ColorToken.accent.opacity(selected ? 0.72 : 0.20)), style: StrokeStyle(lineWidth: selected ? 1.7 : 0.75, lineCap: .round, dash: dashed ? [4, 5] : []))
            }
        }
        .accessibilityHidden(true).allowsHitTesting(false)
    }

    @ViewBuilder private func evidenceSatellites(positions: [String: CGPoint], size: CGSize) -> some View {
        if let node = model.selectedNode, let raw = positions[node.id], !node.evidence.isEmpty {
            Canvas { context, _ in
                let center = transformed(raw, in: size)
                let orbit = MemoryBrainLayout.diameter(for: node.visualTier) * 0.72
                for index in node.evidence.indices.prefix(8) {
                    let angle = CGFloat(index) / CGFloat(max(1, node.evidence.count)) * .pi * 2 - .pi / 2
                    let point = CGPoint(x: center.x + cos(angle) * orbit, y: center.y + sin(angle) * orbit)
                    let rect = CGRect(x: point.x - 2.2, y: point.y - 2.2, width: 4.4, height: 4.4)
                    context.fill(Path(ellipseIn: rect), with: .color(DS.ColorToken.accent.opacity(0.72)))
                }
            }
            .transition(.opacity).accessibilityHidden(true).allowsHitTesting(false)
        }
    }

    private var searchResultsOverlay: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("召回结果", systemImage: "scope")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(model.searchResults.count) 项").font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)
            }
            ForEach(model.searchResults.prefix(5)) { node in
                Button { model.select(node.id, focus: true) } label: {
                    HStack(spacing: 9) {
                        Circle().fill(familyColor(node.visualFamily)).frame(width: 7, height: 7)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(node.preview).lineLimit(2).multilineTextAlignment(.leading)
                            Text("\(kindLabel(node.kind)) · \(temporalLabel(node.temporalState))")
                                .font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)
                        }
                        Spacer(); Image(systemName: "scope")
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(13).frame(width: 310)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(DS.ColorToken.accent.opacity(0.22)))
        .shadow(color: .black.opacity(0.14), radius: 18, y: 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(16)
    }

    private var canvasFooter: some View {
        HStack(spacing: 12) {
            Label("拖动平移 · 双指缩放 · 双击节点聚焦", systemImage: "hand.draw")
            Spacer()
            if model.snapshot?.edges.isEmpty == true {
                Label("0 条真实关联 · 空间光场不代表关系", systemImage: "checkmark.shield")
            }
        }
        .font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)
        .padding(.horizontal, 13).padding(.vertical, 8)
        .background(.ultraThinMaterial, in: Capsule())
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .padding(16).allowsHitTesting(false)
    }

    private var inspector: some View {
        ScrollView {
            if let node = model.selectedNode {
                VStack(alignment: .leading, spacing: 22) {
                    MemoryInspectorHero(node: node)
                    HStack(spacing: 8) {
                        TagChip(text: kindLabel(node.kind), tint: familyColor(node.visualFamily))
                        TagChip(text: temporalLabel(node.temporalState), tint: node.temporalState == "historical" ? .gray : .green)
                        TagChip(text: tierLabel(node.visualTier), tint: .indigo)
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        Text("记忆强度").font(DS.Typography.eyebrow).foregroundStyle(DS.ColorToken.textTertiary)
                        ProgressView(value: node.importance).tint(familyColor(node.visualFamily))
                        HStack {
                            Label(sourceLabel(node.source), systemImage: "arrow.down.doc")
                            Spacer()
                            Label(evidenceLabel(node.evidenceMode), systemImage: "checkmark.seal")
                        }
                        .font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textSecondary)
                    }
                    .padding(14).background(DS.ColorToken.surfaceSecondary, in: RoundedRectangle(cornerRadius: 14))

                    CompanionSectionHeader("证据", subtitle: "真实来源记录", systemImage: "sparkles")
                    ForEach(node.evidence) { evidence in
                        HStack(alignment: .top, spacing: 10) {
                            ZStack { Circle().fill(DS.ColorToken.accent.opacity(0.14)); Image(systemName: "checkmark").font(.caption2.bold()).foregroundStyle(DS.ColorToken.accent) }
                                .frame(width: 24, height: 24)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(sourceLabel(evidence.source)).font(.body.weight(.medium))
                                Text("\(evidenceLabel(evidence.mode)) · \(friendlyMemoryDate(evidence.recordedAt))")
                                    .font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)
                            }
                        }
                    }

                    CompanionSectionHeader("真实关联", subtitle: "只呈现 Memory Engine 已保存的拓扑", systemImage: "point.3.connected.trianglepath.dotted")
                    if model.relatedNodes.isEmpty {
                        HStack(spacing: 10) {
                            Image(systemName: "circle.dotted").foregroundStyle(DS.ColorToken.textTertiary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("暂无真实关联").font(.body.weight(.medium))
                                Text("画布不会猜测或生成连接线。")
                                    .font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)
                            }
                        }
                    } else {
                        ForEach(model.relatedNodes) { item in
                            Button { model.select(item.id, focus: true) } label: {
                                HStack { Text(item.title).lineLimit(2); Spacer(); Image(systemName: "arrow.up.right") }
                            }.buttonStyle(.plain)
                        }
                    }

                    recallPreview
                    management(node)
                    if let notice = model.noticeText { Label(notice, systemImage: "checkmark.circle.fill").font(DS.Typography.caption).foregroundStyle(.green) }
                    if let error = model.errorText { Label(error, systemImage: "exclamationmark.triangle").font(DS.Typography.caption).foregroundStyle(.red).lineLimit(4) }
                }
                .padding(20)
            } else {
                CompanionStateView(kind: .empty, title: "在记忆空间中选择一个核心", message: "它的安全摘要、证据、真实关联与召回解释会在这里展开。")
                    .frame(maxWidth: .infinity, minHeight: 460)
            }
        }
        .background(DS.ColorToken.inspector)
    }

    @ViewBuilder private var recallPreview: some View {
        if !model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                CompanionSectionHeader("召回解释", subtitle: "只读，不会生成新记忆", systemImage: "scope")
                ForEach(model.recallRows.prefix(5)) { row in
                    Button { model.select(row.id, focus: true) } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack { Text(row.content).font(.body.weight(.medium)).lineLimit(2); Spacer(); Text(relevanceLabel(row.finalScore)).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.accent) }
                            Text(row.reasons.map(reasonLabel).joined(separator: " · "))
                                .font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary).lineLimit(2)
                        }
                    }.buttonStyle(.plain)
                }
            }
        }
    }

    private func management(_ node: MemoryBrainResponse.Node) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            CompanionSectionHeader("管理", subtitle: "变更会通过正式 Memory API", systemImage: "slider.horizontal.3")
            HStack {
                Button("编辑") { showEdit = true }
                if node.status == "retired" {
                    Button("恢复") { Task { _ = await model.setSelectedStatus("active") } }
                } else {
                    Button("归档") { confirmRetire = true }
                }
                Spacer()
                Button("删除", role: .destructive) { confirmDelete = true }
            }.buttonStyle(.bordered).controlSize(.small)
        }
    }

    private var emptyState: some View {
        CompanionStateView(kind: model.isLoading ? .loading : .empty,
                           title: model.isLoading ? "正在整理长期记忆空间" : "这里还没有长期记忆",
                           message: model.isLoading ? "只读取真实记忆与真实关系。" : "添加第一段记忆，它会成为一个新的神经核心。",
                           actionTitle: model.isLoading ? nil : "添加记忆") { showAdd = true }
            .frame(maxWidth: 440)
    }

    private var panGesture: some Gesture {
        DragGesture().onChanged { value in offset = CGSize(width: dragOrigin.width + value.translation.width, height: dragOrigin.height + value.translation.height) }
            .onEnded { _ in dragOrigin = offset }
    }
    private var zoomGesture: some Gesture {
        MagnificationGesture().onChanged { value in zoom = min(2.6, max(0.62, zoomOrigin * value)) }
            .onEnded { _ in zoomOrigin = zoom }
    }
    private func transformed(_ point: CGPoint, in size: CGSize) -> CGPoint {
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        return CGPoint(x: center.x + (point.x - center.x) * zoom + offset.width, y: center.y + (point.y - center.y) * zoom + offset.height)
    }
    private func focus(_ point: CGPoint, in size: CGSize) {
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        withAnimation(DS.Motion.animation(.normal, reduceMotion: reduceMotion)) {
            offset = CGSize(width: (center.x - point.x) * zoom, height: (center.y - point.y) * zoom); dragOrigin = offset
        }
    }
    private func resetViewport() {
        withAnimation(DS.Motion.animation(.normal, reduceMotion: reduceMotion)) { zoom = 1; zoomOrigin = 1; offset = .zero; dragOrigin = .zero }
    }
}

private struct MemoryNeuronView: View {
    let node: MemoryBrainResponse.Node
    let selected: Bool
    let searchHit: Bool
    let subdued: Bool
    let reduceMotion: Bool
    let onSelect: () -> Void
    let onFocus: () -> Void
    @State private var hovering = false
    @FocusState private var focused: Bool

    var body: some View {
        let diameter = MemoryBrainLayout.diameter(for: node.visualTier)
        VStack(spacing: node.visualTier == "minor" ? 7 : 10) {
            Button(action: onSelect) {
                ZStack {
                    if selected || searchHit {
                        Circle().fill(familyColor(node.visualFamily).opacity(selected ? 0.24 : 0.13)).frame(width: diameter * 1.55, height: diameter * 1.55).blur(radius: selected ? 16 : 10)
                    }
                    Circle().stroke(familyColor(node.visualFamily).opacity(selected ? 0.72 : 0.20), lineWidth: selected ? 1.7 : 0.7).frame(width: diameter * 1.28, height: diameter * 1.28)
                    if node.visualTier == "major" {
                        Circle().stroke(DS.ColorToken.textSecondary.opacity(0.12), style: StrokeStyle(lineWidth: 0.6, dash: [2, 5])).frame(width: diameter * 1.48, height: diameter * 1.48)
                    }
                    Circle()
                        .fill(RadialGradient(colors: [Color.white.opacity(0.94), familyColor(node.visualFamily).opacity(0.82), familyColor(node.visualFamily).opacity(0.28)], center: .topLeading, startRadius: 0, endRadius: diameter * 0.62))
                        .overlay(Circle().stroke(Color.white.opacity(selected ? 0.82 : 0.32), lineWidth: selected ? 2.2 : 0.8))
                        .shadow(color: familyColor(node.visualFamily).opacity(selected ? 0.62 : 0.26), radius: selected ? 18 : 9)
                        .frame(width: diameter, height: diameter)
                    Image(systemName: nodeIcon(node.visualFamily)).font(.system(size: diameter * 0.28, weight: .semibold)).foregroundStyle(Color.white.opacity(0.94)).shadow(radius: 2)
                    if node.status == "retired" { Image(systemName: "clock.arrow.circlepath").font(.caption.bold()).padding(5).background(.thinMaterial, in: Circle()).offset(x: diameter * 0.35, y: -diameter * 0.35) }
                }
            }
            .buttonStyle(.plain).focused($focused)
            .onTapGesture(count: 2, perform: onFocus)

            VStack(spacing: 2) {
                Text(nodeLabel(node.title, tier: node.visualTier)).font(node.visualTier == "major" ? .subheadline.weight(.semibold) : .caption.weight(.semibold)).lineLimit(node.visualTier == "major" ? 2 : 1).multilineTextAlignment(.center)
                if node.visualTier != "minor" { Text(kindLabel(node.kind)).font(.caption2.weight(.medium)).textCase(.uppercase).tracking(0.6).foregroundStyle(DS.ColorToken.textTertiary) }
            }
            .frame(width: node.visualTier == "major" ? 154 : 124)
            .opacity(selected || hovering || node.visualTier != "minor" ? 1 : 0.66)
            .shadow(color: DS.ColorToken.windowBackground.opacity(0.85), radius: 3)
        }
        .scaleEffect(selected ? 1.07 : hovering ? 1.035 : 1)
        .opacity(node.temporalState == "historical" ? 0.48 : subdued ? 0.24 : 1)
        .animation(DS.Motion.animation(.normal, reduceMotion: reduceMotion), value: selected)
        .onHover { hovering = $0 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(kindLabel(node.kind))，\(node.title)，\(temporalLabel(node.temporalState))")
        .accessibilityValue(selected ? "已选择" : searchHit ? "搜索命中" : "")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .help(node.preview)
    }
}

private struct MemorySpaceBackground: View {
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        ZStack {
            LinearGradient(colors: colorScheme == .dark ? [Color(red: 0.025, green: 0.045, blue: 0.09), Color(red: 0.04, green: 0.035, blue: 0.09), Color(red: 0.018, green: 0.028, blue: 0.055)] : [Color(red: 0.89, green: 0.94, blue: 0.98), Color(red: 0.93, green: 0.91, blue: 0.98), Color(red: 0.86, green: 0.92, blue: 0.97)], startPoint: .topLeading, endPoint: .bottomTrailing)
            RadialGradient(colors: [Color.cyan.opacity(colorScheme == .dark ? 0.15 : 0.13), .clear], center: .center, startRadius: 20, endRadius: 430)
            RadialGradient(colors: [Color.indigo.opacity(colorScheme == .dark ? 0.17 : 0.10), .clear], center: .bottomTrailing, startRadius: 15, endRadius: 520)
            RadialGradient(colors: [.clear, Color.black.opacity(colorScheme == .dark ? 0.38 : 0.08)], center: .center, startRadius: 250, endRadius: 840)
        }.accessibilityHidden(true)
    }
}

private struct MemoryInspectorHero: View {
    let node: MemoryBrainResponse.Node
    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                ZStack { Circle().fill(familyColor(node.visualFamily).opacity(0.18)); Circle().stroke(familyColor(node.visualFamily).opacity(0.55)); Image(systemName: nodeIcon(node.visualFamily)).foregroundStyle(familyColor(node.visualFamily)) }
                    .frame(width: 42, height: 42)
                VStack(alignment: .leading, spacing: 2) { Text("MEMORY CORE").font(.caption2.weight(.bold)).tracking(1.4).foregroundStyle(DS.ColorToken.textTertiary); Text(tierLabel(node.visualTier)).font(.subheadline.weight(.semibold)) }
            }
            Text(node.content).font(.title3.weight(.medium)).lineSpacing(4).textSelection(.enabled)
        }
    }
}

private struct MemoryManualSheet: View {
    @ObservedObject var model: MemoryBrainViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ManualMemoryDraft()
    @State private var assessment: ManualMemoryAssessment?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { VStack(alignment: .leading) { Text("添加长期记忆").font(.title2.weight(.semibold)); Text("写入前会检查重复与可能冲突").foregroundStyle(DS.ColorToken.textSecondary) }; Spacer(); Button("取消") { dismiss() } }
            TextEditor(text: $draft.content).font(.body).frame(minHeight: 120).padding(8).background(DS.ColorToken.surfaceSecondary, in: RoundedRectangle(cornerRadius: 12))
            HStack {
                Picker("类型", selection: $draft.type) { ForEach(memoryKinds, id: \.0) { Text($0.1).tag($0.0) } }.frame(width: 180)
                Picker("时间状态", selection: $draft.temporalState) { ForEach(memoryTemporalStates, id: \.0) { Text($0.1).tag($0.0) } }.frame(width: 180)
            }
            VStack(alignment: .leading, spacing: 5) { Text("重要程度").font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textSecondary); Slider(value: $draft.importance, in: 0.2...1) }
            if let assessment { assessmentView(assessment) }
            if let error = model.errorText { Text(error).font(DS.Typography.caption).foregroundStyle(.red).lineLimit(3) }
            HStack { Spacer(); Button("检查并添加") { submit() }.buttonStyle(.borderedProminent).disabled(draft.content.trimmingCharacters(in: .whitespacesAndNewlines).count < 3 || model.isMutating) }
        }
        .padding(24).frame(width: 560)
    }

    @ViewBuilder private func assessmentView(_ value: ManualMemoryAssessment) -> some View {
        if let duplicate = value.duplicate {
            VStack(alignment: .leading, spacing: 6) { Label("已有相同或高度相似的记忆", systemImage: "checkmark.circle").font(.headline); Text(duplicate.content).foregroundStyle(DS.ColorToken.textSecondary); Text("不会重复创建。").font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary) }
                .padding(14).background(Color.green.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
        } else if !value.possibleConflicts.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Label("这可能会更新一条现有记忆", systemImage: "arrow.triangle.2.circlepath").font(.headline)
                ForEach(value.possibleConflicts) { match in
                    HStack { Text(match.content).lineLimit(2); Spacer(); Button("用新记忆替换") { create(replacing: match.id) }.controlSize(.small) }
                }
                Button("两条都保留") { create(keepAlongside: true) }.controlSize(.small)
            }
            .padding(14).background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private func submit() { Task { guard let result = await model.prepareManual(draft) else { return }; assessment = result; if result.disposition == "ready" { create() } } }
    private func create(replacing id: String? = nil, keepAlongside: Bool = false) { Task { if await model.createManual(draft, replacing: id, keepAlongside: keepAlongside) { dismiss() } } }
}

private struct MemoryEditSheet: View {
    @ObservedObject var model: MemoryBrainViewModel
    let node: MemoryBrainResponse.Node
    @Environment(\.dismiss) private var dismiss
    @State private var content: String
    @State private var type: String
    @State private var temporalState: String
    init(model: MemoryBrainViewModel, node: MemoryBrainResponse.Node) { self.model = model; self.node = node; _content = State(initialValue: node.content); _type = State(initialValue: node.kind); _temporalState = State(initialValue: node.temporalState) }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("编辑记忆").font(.title2.weight(.semibold))
            TextEditor(text: $content).frame(minHeight: 130).padding(8).background(DS.ColorToken.surfaceSecondary, in: RoundedRectangle(cornerRadius: 12))
            HStack { Picker("类型", selection: $type) { ForEach(memoryKinds, id: \.0) { Text($0.1).tag($0.0) } }; Picker("时间状态", selection: $temporalState) { ForEach(memoryTemporalStates, id: \.0) { Text($0.1).tag($0.0) } } }
            HStack { Spacer(); Button("取消") { dismiss() }; Button("保存") { Task { if await model.updateSelected(content: content, type: type, temporalState: temporalState) { dismiss() } } }.buttonStyle(.borderedProminent) }
        }.padding(24).frame(width: 520)
    }
}

private let memoryKinds = [("fact","事实"),("preference","偏好"),("project","项目 / 计划"),("relationship","关系"),("event","事件"),("commitment","承诺 / 意图"),("other","反思 / 其他")]
private let memoryTemporalStates = [("current","当前"),("historical","历史"),("planned","计划"),("timeless","长期")]
private func familyColor(_ value: String) -> Color { switch value { case "preference": return .pink; case "relationship": return .cyan; case "project": return .indigo; case "intent": return .orange; case "event": return .mint; case "reflection": return .purple; default: return .blue } }
private func nodeIcon(_ value: String) -> String { switch value { case "preference": return "heart.fill"; case "relationship": return "person.2.fill"; case "project": return "hammer.fill"; case "intent": return "arrow.up.forward.circle.fill"; case "event": return "sparkles"; case "reflection": return "moon.stars.fill"; default: return "circle.hexagongrid.fill" } }
private func nodeLabel(_ value: String, tier: String) -> String { let line=value.replacingOccurrences(of: "\n", with: " "); let limit=tier == "major" ? 30 : tier == "state" ? 22 : 15; return line.count > limit ? String(line.prefix(limit)) + "…" : line }
private func kindLabel(_ value: String) -> String { ["fact":"事实","preference":"偏好","project":"项目","relationship":"关系","event":"事件","commitment":"承诺","other":"反思"][value] ?? value }
private func temporalLabel(_ value: String) -> String { ["current":"当前","historical":"历史","planned":"计划","timeless":"长期"][value] ?? value }
private func tierLabel(_ value: String) -> String { ["major":"核心记忆","state":"状态记忆","minor":"片段记忆"][value] ?? value }
private func sourceLabel(_ value: String) -> String { ["manual":"手动添加","conversation":"日常对话","summary":"会话整理","legacy":"历史迁移"][value] ?? value }
private func evidenceLabel(_ value: String) -> String { ["manual":"手动证据","explicit":"明确表达","derived":"经规则提取"][value] ?? value }
private func friendlyMemoryDate(_ value: String?) -> String { guard let value else { return "时间未知" }; return CompanionTime.naturalDateTime(fromISO8601: value) }
private func relevanceLabel(_ score: Double) -> String { score >= 2.5 ? "高度相关" : score >= 1 ? "相关" : "可能相关" }
private func reasonLabel(_ value: String) -> String { ["pinned":"已固定","FTS5 match":"词义命中","embedding similarity":"语义相关","text similarity":"文本相关","high importance":"重要记忆","frequently used":"经常被召回"][value] ?? value }
