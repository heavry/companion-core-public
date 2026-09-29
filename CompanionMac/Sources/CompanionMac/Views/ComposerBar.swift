import SwiftUI
import AppKit
import CompanionKit

/// 浮动式 Composer：大圆角容器、多行自动增高、focus 光环、状态化发送按钮。
struct ComposerBar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let attachment: ComposerImageAttachment?
    let isUploading: Bool
    let attachmentError: String?
    @Binding var webEnabled: Bool
    let webSearchConfigured: Bool
    let webSearchProvider: String?
    let webSearchReason: String
    let permissionSnapshot: SessionPermissionSnapshot?
    let canSend: Bool
    var isRecordingVoice: Bool = false
    var voiceElapsed: TimeInterval = 0
    var voiceError: String? = nil
    var canRecordVoice: Bool = true
    let onPickImage: () -> Void
    let onRemoveImage: () -> Void
    let onSetPermissionMode: (SessionPermissionMode) -> Void
    let onChooseWorkspace: () -> Void
    let onClearWorkspace: () -> Void
    let onRevokeGrant: (SessionPermissionGrant) -> Void
    let onRevokeAllGrants: () -> Void
    var onToggleVoiceMessage: (() -> Void)? = nil
    var onCancelVoiceMessage: (() -> Void)? = nil
    let onSend: () -> Void

    @State private var hovering = false
    @State private var attachmentHovering = false
    @State private var showingPermissions = false
    private let minHeight: CGFloat = 40
    private let maxHeight: CGFloat = 132

    private var computedHeight: CGFloat {
        guard !text.isEmpty else { return minHeight }
        let lineCount = CGFloat(max(1, text.split(separator: "\n").count))
        return min(maxHeight, max(minHeight, 22 + lineCount * 22))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.s) {
            attachmentPreview
            if attachment == nil, let attachmentError {
                Label(attachmentError, systemImage: "exclamationmark.circle.fill")
                    .font(.caption2)
                    .foregroundStyle(DS.ColorToken.danger)
            }
            HStack(alignment: .bottom, spacing: DS.Space.s) {
                attachButton
                workspaceButton
                permissionButton
                voiceMessageButton
                inputArea
                sendButton
            }
            if isRecordingVoice || voiceError != nil {
                HStack(spacing: DS.Space.s) {
                    if isRecordingVoice {
                        Circle().fill(DS.ColorToken.danger).frame(width: 8, height: 8)
                        Text(String(format: "录音中 %.1fs · 点击麦克风发送", voiceElapsed))
                            .font(.caption2)
                            .foregroundStyle(DS.ColorToken.textSecondary)
                        Button("取消") { onCancelVoiceMessage?() }
                            .buttonStyle(.plain)
                            .font(.caption2)
                            .foregroundStyle(DS.ColorToken.danger)
                    } else if let voiceError {
                        Label(voiceError, systemImage: "exclamationmark.circle")
                            .font(.caption2)
                            .foregroundStyle(DS.ColorToken.danger)
                    }
                    Spacer(minLength: 0)
                }
            }
            HStack(spacing: DS.Space.s) {
                Toggle(isOn: $webEnabled) {
                    Label(webEnabled ? "联网开启" : "联网关闭", systemImage: "globe")
                        .font(DS.Typography.caption)
                }
                .toggleStyle(.switch)
                .controlSize(.mini)
                .fixedSize()
                .tint(webToggleTint)
                .help(webToggleHelp)
                Text(webStatusText)
                    .font(.caption2)
                    .foregroundStyle(webStatusColor)
                    .lineLimit(1)
                Spacer(minLength: DS.Space.s)
                Text("Return 发送 · Shift+Return 换行")
                    .font(.caption2)
                    .foregroundStyle(DS.ColorToken.textSecondary.opacity(0.78))
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, DS.Space.m)
        .padding(.vertical, DS.Space.s + 2)
        .background(
            RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous)
                        .fill(DS.ColorToken.surface.opacity(focused.wrappedValue ? 0.58 : 0.42))
                )
                .shadow(color: .black.opacity(hovering || focused.wrappedValue ? 0.10 : 0.05),
                        radius: focused.wrappedValue ? 10 : 6, y: 2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous)
                .strokeBorder(composerBorderColor,
                              lineWidth: focused.wrappedValue ? 1.5 : 1)
        )
        .padding(.horizontal, DS.Space.xl)
        .padding(.top, DS.Space.s)
        .padding(.bottom, DS.Space.m)
        .onHover { value in
            if reduceMotion {
                hovering = value
            } else {
                withAnimation(DS.Motion.fast) { hovering = value }
            }
        }
        .animation(reduceMotion ? nil : DS.Motion.fast, value: focused.wrappedValue)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("消息输入区")
    }

    private var composerBorderColor: Color {
        if focused.wrappedValue { return DS.ColorToken.accent.opacity(0.62) }
        if hovering { return DS.ColorToken.textTertiary.opacity(0.72) }
        return DS.ColorToken.separator.opacity(0.78)
    }

    private var webToggleTint: Color {
        if !webEnabled { return DS.ColorToken.textTertiary }
        return webSearchConfigured ? DS.ColorToken.accent : DS.ColorToken.warning
    }

    private var webToggleHelp: String {
        if !webEnabled { return "联网搜索已关闭" }
        return webSearchConfigured ? "允许在需要时搜索网络" : "未配置联网搜索"
    }

    private var webStatusText: String {
        if !webEnabled { return "此次对话不会使用网络" }
        if !webSearchConfigured { return webSearchReason }
        if webSearchConfigured {
            let name: String
            switch webSearchProvider {
            case "tavily": name = "Tavily"
            case "searxng": name = "SearXNG"
            case "native": name = "原生搜索"
            default: name = ""
            }
            return name.isEmpty ? "联网搜索可用" : "联网搜索 · \(name)"
        }
        return "联网搜索不可用"
    }

    private var webStatusColor: Color {
        if !webEnabled { return DS.ColorToken.textSecondary.opacity(0.78) }
        return webSearchConfigured ? DS.ColorToken.textSecondary : DS.ColorToken.warning
    }

    private var voiceMessageButton: some View {
        Button {
            NSLog("[voice-msg-ui] mic button tapped canRecord=%@ recording=%@", String(describing: canRecordVoice), String(describing: isRecordingVoice))
            onToggleVoiceMessage?()
        } label: {
            Image(systemName: isRecordingVoice ? "stop.circle.fill" : "mic.circle")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(isRecordingVoice ? DS.ColorToken.danger : DS.ColorToken.textSecondary)
                .frame(width: 28, height: 28)
                .opacity(1)
        }
        .buttonStyle(.plain)
        .disabled(!canRecordVoice && !isRecordingVoice)
        .help(isRecordingVoice ? "停止并发送语音消息" : "录制语音消息（不是通话）")
        .accessibilityLabel(isRecordingVoice ? "发送语音消息" : "录制语音消息")
        .onAppear {
            NSLog("[voice-msg-ui] mic button rendered canRecord=%d onToggle=%d", canRecordVoice ? 1 : 0, onToggleVoiceMessage != nil ? 1 : 0)
        }
    }

    private var attachButton: some View {
        Button(action: onPickImage) {
            Image(systemName: "plus")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(attachmentHovering ? DS.ColorToken.textPrimary : DS.ColorToken.textSecondary)
                .frame(width: 30, height: 30)
                .background(
                    Circle().fill(attachmentHovering ? DS.ColorToken.surfaceSecondary.opacity(0.9)
                                                     : DS.ColorToken.surfaceSecondary.opacity(0.5))
                )
        }
        .buttonStyle(.plain)
        .help("选择图片")
        .accessibilityLabel("添加图片")
        .onHover { value in
            if reduceMotion {
                attachmentHovering = value
            } else {
                withAnimation(DS.Motion.fast) { attachmentHovering = value }
            }
        }
    }

    private var permissionButton: some View {
        Button { showingPermissions.toggle() } label: {
            Image(systemName: permissionSnapshot?.mode.symbol ?? "checkmark.shield")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(DS.ColorToken.textSecondary)
                .frame(width: 30, height: 30)
                .background(Circle().fill(DS.ColorToken.surfaceSecondary.opacity(0.5)))
        }
        .buttonStyle(.plain)
        .help("当前聊天的执行批准方式")
        .accessibilityLabel("聊天权限模式，\(permissionSnapshot?.mode.title ?? "帮我批准")")
        .popover(isPresented: $showingPermissions, arrowEdge: .bottom) {
            permissionPopover
                .frame(width: 340)
                .padding(DS.Space.m)
        }
    }

    private var workspaceButton: some View {
        Menu {
            if let workspace = permissionSnapshot?.workspace {
                Text("当前：\(workspace.name)")
                Text(workspace.path)
                Divider()
            } else {
                Text("本轮未授权 workspace")
                Divider()
            }
            Button("选择工作区…", action: onChooseWorkspace)
            if permissionSnapshot?.workspace != nil { Button("清除工作区", role: .destructive, action: onClearWorkspace) }
        } label: {
            Image(systemName: permissionSnapshot?.workspace == nil ? "folder.badge.questionmark" : "folder.badge.gearshape")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(permissionSnapshot?.workspace == nil ? DS.ColorToken.textSecondary : DS.ColorToken.accent)
                .frame(width: 30, height: 30)
                .background(Circle().fill(DS.ColorToken.surfaceSecondary.opacity(0.5)))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(permissionSnapshot?.workspace.map { "当前工作区：\($0.path)" } ?? "选择工作区以启用 Terminal 与 Filesystem")
        .accessibilityLabel(permissionSnapshot?.workspace.map { "当前工作区，\($0.name)" } ?? "本轮未授权工作区")
    }

    private var permissionPopover: some View {
        VStack(alignment: .leading, spacing: DS.Space.m) {
            VStack(alignment: .leading, spacing: 3) {
                Text("当前聊天的权限").font(.headline)
                Text("这里只决定模型提出调用时如何批准；能力是否存在、启用和配置仍由 Capabilities 管理。")
                    .font(.caption).foregroundStyle(DS.ColorToken.textSecondary).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(SessionPermissionMode.allCases) { mode in
                Button { onSetPermissionMode(mode) } label: {
                    HStack(alignment: .top, spacing: DS.Space.s) {
                        Image(systemName: mode.symbol).frame(width: 18)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(mode.title).font(.subheadline.weight(.medium))
                            Text(mode.summary).font(.caption2).foregroundStyle(DS.ColorToken.textSecondary).multilineTextAlignment(.leading)
                        }
                        Spacer()
                        if permissionSnapshot?.mode == mode { Image(systemName: "checkmark").foregroundStyle(DS.ColorToken.accent) }
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel("\(mode.title)，\(mode.summary)")
            }
            if let grants = permissionSnapshot?.grants, !grants.isEmpty {
                Divider()
                HStack { Text("本会话授权").font(.subheadline.weight(.semibold)); Spacer(); Button("全部撤销", action: onRevokeAllGrants).buttonStyle(.borderless).controlSize(.small) }
                ForEach(grants) { grant in
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(grant.integrationName ?? grant.displayName ?? "Integration").font(.caption.weight(.medium))
                            Text("\(grant.displayName ?? grant.capabilityId) · \(grant.scope == "read" ? "只读" : grant.scope)").font(.caption2).foregroundStyle(DS.ColorToken.textSecondary)
                            Text("有效至 \(CompanionTime.naturalDateTime(fromISO8601: grant.expiresAt))").font(.caption2).foregroundStyle(DS.ColorToken.textTertiary)
                        }
                        Spacer()
                        Button("撤销") { onRevokeGrant(grant) }.buttonStyle(.borderless).controlSize(.small)
                    }
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 4) {
                Text("工作区范围").font(.subheadline.weight(.semibold))
                if let workspace = permissionSnapshot?.workspace {
                    Text(workspace.path).font(.caption2).foregroundStyle(DS.ColorToken.textSecondary).lineLimit(2)
                } else {
                    Text("本轮未授权 workspace；Terminal 与 Filesystem 不会暴露给模型。").font(.caption2).foregroundStyle(DS.ColorToken.textSecondary)
                }
                HStack { Button("选择…", action: onChooseWorkspace).buttonStyle(.borderless); if permissionSnapshot?.workspace != nil { Button("清除", role: .destructive, action: onClearWorkspace).buttonStyle(.borderless) } }
            }
            Text(permissionSnapshot?.mode == .fullAutonomy
                 ? "完全自主只在当前会话与已授权 scope 内生效；凭证隔离、系统安全、未知 WIP、production 与其他硬边界仍会拦截。"
                 : "授权只属于当前会话，并会自动到期；不会绕过 Action Intent 或全局安全门。")
                .font(.caption2).foregroundStyle(DS.ColorToken.textTertiary).fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var attachmentPreview: some View {
        if let attachment {
            HStack(spacing: DS.Space.s) {
                if let image = NSImage(data: attachment.pending.data) {
                    Image(nsImage: image).resizable().scaledToFill()
                        .frame(width: 48, height: 48)
                        .clipShape(RoundedRectangle(cornerRadius: DS.Radius.s, style: .continuous))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.pending.filename)
                        .font(DS.Typography.caption)
                        .foregroundStyle(DS.ColorToken.textPrimary)
                        .lineLimit(1)
                    if isUploading {
                        Label("正在上传…", systemImage: "arrow.up.circle").font(.caption2).foregroundStyle(DS.ColorToken.textSecondary)
                    } else if attachment.uploaded != nil {
                        Label("已准备", systemImage: "checkmark.circle.fill").font(.caption2).foregroundStyle(DS.ColorToken.success)
                    } else if let attachmentError {
                        Text(attachmentError).font(.caption2).foregroundStyle(DS.ColorToken.danger).lineLimit(1)
                    }
                }
                Spacer()
                Button(action: onRemoveImage) { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain)
                    .help("移除图片")
                    .accessibilityLabel("移除图片 \(attachment.pending.filename)")
            }
            .padding(DS.Space.s)
            .background(DS.ColorToken.surfaceSecondary.opacity(0.52), in: RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous)
                    .strokeBorder(DS.ColorToken.separator.opacity(0.45), lineWidth: 1)
            )
            .accessibilityElement(children: .contain)
            .accessibilityLabel("待发送图片 \(attachment.pending.filename)")
        }
    }

    private var inputArea: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text("发消息给林小糖…")
                    .font(DS.Typography.body)
                    .foregroundStyle(DS.ColorToken.textTertiary)
                    .padding(.top, 10)
                    .padding(.leading, 2)
                    .allowsHitTesting(false)
            }
            ComposerTextView(
                text: $text,
                focused: focused,
                canSend: canSend,
                onSend: onSend
            )
            .frame(height: computedHeight)
            .accessibilityLabel("发消息给林小糖")
            .accessibilityHint("按 Return 发送，按 Shift Return 换行")
        }
        .contentShape(Rectangle())
        .onTapGesture { focused.wrappedValue = true }
    }

    private var sendButton: some View {
        Button(action: onSend) {
            Image(systemName: "arrow.up")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(canSend ? Color.white : DS.ColorToken.textTertiary)
                .frame(width: 30, height: 30)
                .background(Circle().fill(canSend ? AnyShapeStyle(Color.accentColor)
                                                  : AnyShapeStyle(Color.gray.opacity(0.25))))
        }
        .buttonStyle(PressableCircleStyle())
        .disabled(!canSend)
        .animation(reduceMotion ? nil : DS.Motion.fast, value: canSend)
        .help(canSend ? "发送" : "输入消息或添加图片后发送")
        .accessibilityLabel("发送消息")
        .accessibilityValue(canSend ? "可发送" : "不可发送")
    }
}

/// 发送按钮按压反馈
struct PressableCircleStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(reduceMotion ? 1 : (configuration.isPressed ? 0.9 : 1.0))
            .opacity(configuration.isPressed ? 0.85 : 1.0)
            .animation(reduceMotion ? nil : DS.Motion.fast, value: configuration.isPressed)
    }
}
