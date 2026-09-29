import SwiftUI
import CompanionKit

/// 聊天消息行：
///   Assistant → 固定左侧：[头像] 林小糖 / 内容 / 时间
///   User      → 固定右侧：内容气泡 / 时间
/// 气泡宽度按内容自然增长，上限为内容区约 62%（短消息只包住文字）。
struct MessageBubble: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let row: ConversationMessagesResponse.Row
    @Binding var imageCache: [String: NSImage]
    var showsAvatar: Bool = true
    var showsName: Bool = true
    var embeddedInTurn: Bool = false
    var maxBubbleWidth: CGFloat = 560
    var onOpenMedia: ((MediaAttachment) -> Void)? = nil
    var voiceState: VoiceMessageState? = nil
    var onToggleVoice: ((Int) -> Void)? = nil

    @State private var sourcesExpanded = false
    @State private var transcriptExpanded = false

    private var isUser: Bool { row.role == "user" }
    private var friendly: String { friendlyText(row.contentText) }

    private var voiceAssetForDisplay: VoiceAsset? {
        row.voiceAsset ?? row.voicePlan.map {
            VoiceAsset(voiceAssetID: "local:\($0.generationID)", duration: 0, state: "ready")
        }
    }

    private var displayMode: VoiceMessageDisplayMode {
        VoiceMessagePresentation.displayMode(
            role: row.role,
            text: row.contentText,
            voiceAsset: row.voiceAsset,
            voicePlan: row.voicePlan
        )
    }

    private var playbackFailed: Bool {
        if let phase = voiceState?.phase { return phase == .failed || phase == .expired }
        if let asset = row.voiceAsset {
            let state = asset.state.lowercased()
            return state == "failed" || state == "expired"
        }
        return false
    }

    /// Voice-first: assistant TTS of this message's own text. Never duplicate the text bubble.
    private var usesVoiceFirst: Bool {
        !isUser && displayMode == .voiceFirst && !playbackFailed
    }

    private var showOrdinaryTextBubble: Bool {
        if isUser { return true }
        return !usesVoiceFirst
    }

    @ViewBuilder var body: some View {
        if embeddedInTurn {
            messageColumn
                .accessibilityElement(children: .contain)
                .accessibilityLabel("林小糖的消息")
        } else {
        HStack(alignment: .top, spacing: DS.Space.m) {
            if isUser { Spacer(minLength: DS.Space.xxl) }
            if !isUser { avatarColumn }
            messageColumn
            if !isUser { Spacer(minLength: DS.Space.xxl) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(isUser ? "你的消息" : "林小糖的消息")
        }
    }

    private var messageColumn: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 3) {
            if !isUser && showsName {
                Text("林小糖")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(DS.ColorToken.textSecondary)
                    .padding(.leading, DS.Space.xs)
            }
            if usesVoiceFirst {
                voiceFirstBody
            } else {
                bubble
                if let voiceAsset = voiceAssetForDisplay, isUser {
                    voiceAttachment(voiceAsset)
                }
            }
            timestamp
            if !isUser, let sources = row.webSources, !sources.isEmpty {
                sourcesView(sources)
            }
        }
    }

    /// Voice card + collapsible transcript. Transcript is the original assistant text (never STT).
    private var voiceFirstBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let voiceAsset = voiceAssetForDisplay {
                voiceAttachment(voiceAsset)
            }
            Button {
                if reduceMotion {
                    transcriptExpanded.toggle()
                } else {
                    withAnimation(DS.Motion.fast) { transcriptExpanded.toggle() }
                }
            } label: {
                HStack(spacing: DS.Space.xs) {
                    Image(systemName: transcriptExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                    Text(transcriptExpanded ? "隐藏文字" : "查看文字")
                }
                .font(.caption2.weight(.medium))
                .foregroundStyle(DS.ColorToken.textSecondary)
                .padding(.horizontal, DS.Space.s)
                .padding(.vertical, 5)
                .background(DS.ColorToken.surfaceSecondary.opacity(0.58), in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(transcriptExpanded ? "隐藏文字" : "查看文字")
            .accessibilityValue(transcriptExpanded ? "已展开文字" : "已折叠文字")
            if transcriptExpanded {
                Text(friendly)
                    .font(DS.Typography.body)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .foregroundStyle(DS.ColorToken.textPrimary)
                    .padding(.horizontal, DS.Space.xs)
                    .frame(maxWidth: maxBubbleWidth, alignment: .leading)
                    .accessibilityLabel("语音对应文字")
                    .accessibilityValue(friendly)
            }
        }
        .frame(maxWidth: min(420, maxBubbleWidth), alignment: .leading)
    }

    private func voiceAttachment(_ asset: VoiceAsset) -> some View {
        VoiceBubbleView(state: voiceState, asset: asset, isUser: isUser, onToggle: { onToggleVoice?(row.id) })
            .frame(maxWidth: min(360, maxBubbleWidth), alignment: isUser ? .trailing : .leading)
            .padding(.leading, DS.Space.xs)
            .accessibilityLabel("语音附件")
    }

    // MARK: 头像（连续 assistant 消息仅首条显示，其余占位保持缩进）

    @ViewBuilder private var avatarColumn: some View {
        if showsAvatar {
            AvatarView(name: "林小糖", size: 36)
        } else {
            Color.clear.frame(width: 36, height: 1)
        }
    }

    // MARK: 气泡
    // 顺序关键：padding/background 只包裹 intrinsic 内容（Text 自然 hug），
    // maxWidth frame 放在最外层——它只负责换行上限与 leading/trailing 对齐，
    // 绝不能放在 background 内层（贪婪 frame 会把短消息撑到上限宽度）。
    private var bubble: some View {
        let shape = ChatBubbleShape(isUser: isUser)
        return VStack(alignment: isUser ? .trailing : .leading, spacing: DS.Space.s) {
            textContent
            attachments
        }
        .padding(.horizontal, DS.Space.m)
        .padding(.vertical, DS.Space.s + 2)
        .background(
            shape
                .fill(bubbleFill)
                .shadow(color: .black.opacity(isUser ? 0.065 : 0.08), radius: 7, y: 2)
        )
        .overlay(
            shape.stroke(isUser ? DS.ColorToken.accent.opacity(0.16)
                                : DS.ColorToken.separator.opacity(0.52), lineWidth: 1)
        )
        .frame(maxWidth: maxBubbleWidth, alignment: isUser ? .trailing : .leading)
    }

    private var bubbleFill: AnyShapeStyle {
        if isUser {
            return AnyShapeStyle(
                LinearGradient(
                    colors: [DS.ColorToken.bubbleUser, DS.ColorToken.accent.opacity(0.12)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
        }
        return AnyShapeStyle(DS.ColorToken.bubbleCompanion.opacity(0.94))
    }

    @ViewBuilder private var textContent: some View {
        // Markdown 渲染（代码块/粗体/行内代码），失败回退纯文本
        if !friendly.isEmpty,
           let attributed = try? AttributedString(
               markdown: friendly,
               options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
           ) {
            Text(attributed).font(DS.Typography.body).lineSpacing(4).textSelection(.enabled)
        } else if !friendly.isEmpty {
            Text(friendly).font(DS.Typography.body).lineSpacing(4).textSelection(.enabled)
        } else if !isUser, row.attachments?.isEmpty != false {
            HStack(spacing: DS.Space.s) {
                ProgressView().controlSize(.mini)
                Text("正在回复…")
                    .font(DS.Typography.caption)
                    .foregroundStyle(DS.ColorToken.textSecondary)
            }
            .accessibilityLabel("林小糖正在回复")
        }
    }

    @ViewBuilder private var attachments: some View {
        if let attachments = row.attachments, !attachments.isEmpty {
            // 图片跟随发送者对齐：user 行内靠右，assistant 行内靠左
            ForEach(attachments) { att in
                RemoteMediaImage(mediaId: att.mediaId ?? "", caption: "",
                                 onOpen: { onOpenMedia?(att) }, imageCache: $imageCache)
            }
        }
    }

    // MARK: 时间（弱化）

    @ViewBuilder private var timestamp: some View {
        if let value = displayTimestamp {
            Text(value)
                .font(.caption2)
                .foregroundStyle(DS.ColorToken.textTertiary)
                .padding(.horizontal, DS.Space.xs)
        }
    }

    private var displayTimestamp: String? {
        guard let raw = row.createdAt, !raw.isEmpty else { return nil }
        return CompanionTime.naturalDateTime(fromISO8601: raw)
    }

    // MARK: 联网搜索来源（轻量、默认折叠；不展示原始 JSON）

    private func sourcesView(_ sources: [WebSource]) -> some View {
        VStack(alignment: .leading, spacing: DS.Space.xs) {
            Button {
                if reduceMotion {
                    sourcesExpanded.toggle()
                } else {
                    withAnimation(DS.Motion.fast) { sourcesExpanded.toggle() }
                }
            } label: {
                HStack(spacing: DS.Space.xs) {
                    Image(systemName: "link")
                    Text("来源 · \(sources.count)")
                    Image(systemName: sourcesExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                }
                .font(.caption2.weight(.medium))
                .foregroundStyle(DS.ColorToken.textSecondary)
                .padding(.horizontal, DS.Space.s)
                .padding(.vertical, 5)
                .background(DS.ColorToken.surfaceSecondary.opacity(0.58), in: Capsule())
            }
            .buttonStyle(.plain)
            .help("本次回复引用的网页来源")
            .accessibilityLabel("网页来源")
            .accessibilityValue(sourcesExpanded ? "已展开，共 \(sources.count) 项" : "已折叠，共 \(sources.count) 项")
            if sourcesExpanded {
                ForEach(sources) { source in
                    SourceLinkRow(source: source) { openSource(source) }
                }
            }
        }
        .padding(.top, 2)
        .frame(maxWidth: maxBubbleWidth, alignment: .leading)
    }

    private func openSource(_ source: WebSource) {
        guard let url = URL(string: source.url), url.scheme == "http" || url.scheme == "https" else { return }
        NSWorkspace.shared.open(url)
    }
}

private struct VoiceBubbleView: View {
    let state: VoiceMessageState?
    let asset: VoiceAsset
    var isUser: Bool = false
    let onToggle: () -> Void

    private var phase: VoiceBubblePhase { state?.phase ?? (asset.state == "expired" ? .expired : .loading) }
    private var duration: TimeInterval { state?.duration ?? asset.duration }
    private var progress: Double { duration > 0 ? min(1, max(0, (state?.currentTime ?? 0) / duration)) : 0 }
    private var icon: String {
        switch phase {
        case .playing: return "pause.fill"
        case .failed, .expired: return "exclamationmark.triangle.fill"
        default: return "play.fill"
        }
    }
    private func clock(_ value: TimeInterval) -> String {
        let seconds = max(0, Int(value.rounded(.down)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 9) {
                if phase == .loading { ProgressView().controlSize(.mini).frame(width: 22) }
                else {
                    Image(systemName: icon)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle([.failed, .expired].contains(phase) ? DS.ColorToken.danger : DS.ColorToken.accent)
                        .frame(width: 22, height: 22)
                }
                VStack(alignment: .leading, spacing: 2) {
                    if phase == .loading { Text("正在载入语音…").font(.caption2).foregroundStyle(DS.ColorToken.textSecondary) }
                    else if phase == .failed { Text(state?.errorText ?? "语音暂不可用").font(.caption2).foregroundStyle(DS.ColorToken.danger) }
                    else if phase == .expired { Text("语音已过期").font(.caption2).foregroundStyle(DS.ColorToken.textTertiary) }
                    else { VoiceWaveform(samples: state?.waveform ?? [], progress: progress).frame(height: 17) }
                    Text(isUser ? "你 · 本地" : "林小糖 · 本地").font(.system(size: 9, weight: .medium)).foregroundStyle(DS.ColorToken.textTertiary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if ![.loading, .failed, .expired].contains(phase) {
                    Text(phase == .playing || phase == .paused ? "\(clock(state?.currentTime ?? 0)) / \(clock(duration))" : clock(duration))
                    .font(.system(size: 9.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(DS.ColorToken.textSecondary)
                    .fixedSize()
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 42)
            .background(DS.ColorToken.surfaceSecondary.opacity(0.72), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(DS.ColorToken.separator.opacity(0.5), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled([.loading, .failed, .expired].contains(phase))
        .accessibilityLabel(phase == .playing ? "暂停语音" : phase == .paused ? "继续语音" : "播放语音")
    }
}

private struct VoiceWaveform: View {
    let samples: [Double]
    let progress: Double
    var body: some View {
        GeometryReader { geo in
            let spacing: CGFloat = 2
            let width = max(1, (geo.size.width - spacing * CGFloat(max(0, samples.count - 1))) / CGFloat(max(1, samples.count)))
            HStack(alignment: .center, spacing: spacing) {
                ForEach(Array(samples.enumerated()), id: \.offset) { index, sample in
                    Capsule()
                        .fill(Double(index) / Double(max(1, samples.count - 1)) <= progress ? DS.ColorToken.accent : DS.ColorToken.textTertiary.opacity(0.42))
                        .frame(width: width, height: max(3, geo.size.height * sample))
                }
            }
            .frame(maxHeight: .infinity)
        }
        .accessibilityHidden(true)
    }
}

/// Suzu 的非对称聊天轮廓用原生 Path 重建，兼容 macOS 13。
private struct ChatBubbleShape: Shape {
    let isUser: Bool

    func path(in rect: CGRect) -> Path {
        let large = min(DS.Radius.m, min(rect.width, rect.height) / 2)
        let small = min(6, large)
        let topLeft = isUser ? large : small
        let topRight = isUser ? small : large
        let bottomRight = large
        let bottomLeft = large

        var path = Path()
        path.move(to: CGPoint(x: rect.minX + topLeft, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - topRight, y: rect.minY))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + topRight),
                          control: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - bottomRight))
        path.addQuadCurve(to: CGPoint(x: rect.maxX - bottomRight, y: rect.maxY),
                          control: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX + bottomLeft, y: rect.maxY))
        path.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - bottomLeft),
                          control: CGPoint(x: rect.minX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + topLeft))
        path.addQuadCurve(to: CGPoint(x: rect.minX + topLeft, y: rect.minY),
                          control: CGPoint(x: rect.minX, y: rect.minY))
        path.closeSubpath()
        return path
    }
}

private struct SourceLinkRow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let source: WebSource
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: DS.Space.s) {
                Image(systemName: "globe")
                    .font(.caption)
                    .foregroundStyle(DS.ColorToken.accent)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(source.title)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(DS.ColorToken.textSecondary)
                        .lineLimit(1)
                    Text(source.displayDomain)
                        .font(.caption2)
                        .foregroundStyle(DS.ColorToken.textTertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: DS.Space.m)
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(DS.ColorToken.textTertiary)
            }
            .padding(.horizontal, DS.Space.s)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: DS.Radius.s, style: .continuous)
                    .fill(hovering ? DS.ColorToken.surfaceSecondary.opacity(0.82)
                                   : DS.ColorToken.surfaceSecondary.opacity(0.48))
            )
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.s, style: .continuous)
                    .strokeBorder(DS.ColorToken.separator.opacity(hovering ? 0.7 : 0.42), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .help(source.url)
        .accessibilityLabel("\(source.title)，\(source.displayDomain)")
        .accessibilityHint("在默认浏览器中打开")
        .onHover { value in
            if reduceMotion {
                hovering = value
            } else {
                withAnimation(DS.Motion.fast) { hovering = value }
            }
        }
    }
}

/// One assistant row owns both its compact tool status and its final bubbles.
struct ChatAssistantTurnView: View {
    let turn: AssistantTurnPresentation
    @Binding var imageCache: [String: NSImage]
    var showsAvatar: Bool = true
    var showsName: Bool = true
    var maxWidth: CGFloat = 560
    var onOpenMedia: ((MediaAttachment) -> Void)? = nil
    var voiceState: ((Int) -> VoiceMessageState?)? = nil
    var onToggleVoice: ((Int) -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: DS.Space.m) {
            if showsAvatar { AvatarView(name: "林小糖", size: 36) }
            else { Color.clear.frame(width: 36, height: 1) }
            VStack(alignment: .leading, spacing: DS.Space.xs) {
                if showsName {
                    Text("林小糖")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(DS.ColorToken.textSecondary)
                        .padding(.leading, DS.Space.xs)
                }
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(turn.activities.prefix(3)) { activity in
                        HStack(spacing: 5) {
                            switch activity.status {
                            case .running: ProgressView().controlSize(.mini).frame(width: 13)
                            case .success: Image(systemName: "checkmark.circle.fill").foregroundStyle(DS.ColorToken.success)
                            case .failed: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(DS.ColorToken.danger)
                            }
                            Text(activity.compactText)
                                .lineLimit(1)
                                .foregroundStyle(activity.status == .failed ? DS.ColorToken.danger : DS.ColorToken.textSecondary)
                        }
                        .font(.caption2)
                        .accessibilityElement(children: .combine)
                    }
                    if turn.activities.count > 3 {
                        Text("另有 \(turn.activities.count - 3) 项操作")
                            .font(.caption2)
                            .foregroundStyle(DS.ColorToken.textTertiary)
                    }
                }
                .padding(.leading, DS.Space.xs)
                ForEach(turn.messages) { row in
                    MessageBubble(row: row, imageCache: $imageCache, showsAvatar: false,
                                  showsName: false, embeddedInTurn: true, maxBubbleWidth: maxWidth,
                                  onOpenMedia: onOpenMedia, voiceState: voiceState?(row.id),
                                  onToggleVoice: onToggleVoice)
                }
            }
            Spacer(minLength: DS.Space.xxl)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("林小糖的回复")
    }
}

struct PermissionApprovalCard: View {
    let request: SessionPermissionRequest
    var maxWidth: CGFloat = 560
    let onAllowOnce: () -> Void
    let onAllowSession: () -> Void
    let onDeny: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: DS.Space.m) {
            AvatarView(name: "林小糖", size: 36)
            VStack(alignment: .leading, spacing: DS.Space.s) {
                Label("\(request.integrationName) 需要你的批准", systemImage: "checkmark.shield")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(DS.ColorToken.textPrimary)
                if let preview = request.actionPreview, !preview.isEmpty {
                    Text(preview).font(.caption).textSelection(.enabled).lineLimit(12)
                }
                Text(actionText).font(DS.Typography.secondary).foregroundStyle(DS.ColorToken.textSecondary)
                Label(request.readOnly ? "这是只读操作" : "这会修改外部数据", systemImage: request.readOnly ? "eye" : "arrow.up.right.square")
                    .font(.caption).foregroundStyle(request.readOnly ? DS.ColorToken.textSecondary : DS.ColorToken.warning)
                HStack(spacing: DS.Space.s) {
                    Button("允许一次", action: onAllowOnce).buttonStyle(.borderedProminent).controlSize(.small).keyboardShortcut(.defaultAction)
                    if request.canAllowSession { Button("本会话允许", action: onAllowSession).buttonStyle(.bordered).controlSize(.small) }
                    Button("拒绝", action: onDeny).buttonStyle(.borderless).controlSize(.small).keyboardShortcut(.cancelAction)
                }
                DisclosureGroup("为什么需要批准？") {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Capability: \(request.integrationName)")
                        Text("Action: \(request.displayName)")
                        Text("Risk: \(request.readOnly ? "Read-only" : request.riskLevel)")
                        Text("Decision: Approval required")
                        Text("Reason: \(request.reason)")
                    }.font(.caption2).foregroundStyle(DS.ColorToken.textSecondary).padding(.top, 2)
                }.font(.caption2)
            }
            .padding(DS.Space.m)
            .background(DS.ColorToken.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous).strokeBorder(DS.ColorToken.accent.opacity(0.28), lineWidth: 1))
            .frame(maxWidth: maxWidth, alignment: .leading)
            Spacer(minLength: DS.Space.xxl)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(request.integrationName) 需要批准，\(actionText)，\(request.readOnly ? "只读操作" : "会修改外部数据")")
    }

    private var actionText: String {
        let name=request.displayName.lowercased()
        if name.contains("search") { return "搜索你的 \(request.integrationName) 内容" }
        if name.contains("read") || name.contains("fetch") || name.contains("snapshot") { return "读取 \(request.integrationName) 内容" }
        if name.contains("click") { return "在 \(request.integrationName) 中点击页面" }
        if name.contains("write") || name.contains("update") || name.contains("edit") { return "修改 \(request.integrationName) 内容" }
        return "执行 \(request.displayName)"
    }
}

/// 通过 /media/<id> 拉取的图片附件：loading 占位 → 缩略图 → 点击看大图 → 可导出到 Finder
struct RemoteMediaImage: View {
    let mediaId: String
    var caption: String = ""
    var onOpen: (() -> Void)? = nil
    @Binding var imageCache: [String: NSImage]
    @State private var loaded: NSImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Group {
                if let img = loaded ?? imageCache[mediaId] {
                    if onOpen != nil {
                        Button { onOpen?() } label: { mediaImage(img) }
                            .buttonStyle(.plain)
                            .help("打开图片预览")
                            .accessibilityLabel("打开图片预览")
                    } else {
                        mediaImage(img)
                    }
                } else {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("正在准备图片…").font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(width: 160, height: 90)
                    .background(DS.ColorToken.surfaceSecondary.opacity(0.58))
                    .clipShape(RoundedRectangle(cornerRadius: DS.Radius.s, style: .continuous))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("正在准备图片")
                }
            }
            if !caption.isEmpty {
                Text(caption).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .task { loaded = await MediaLoader.shared.loadAsync(mediaId: mediaId); if let l = loaded { imageCache[mediaId] = l } }
    }

    private func mediaImage(_ image: NSImage) -> some View {
        Image(nsImage: image)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: 320)
            .clipShape(RoundedRectangle(cornerRadius: DS.Radius.s, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.s, style: .continuous)
                    .strokeBorder(DS.ColorToken.separator.opacity(0.48), lineWidth: 1)
            )
    }
}
