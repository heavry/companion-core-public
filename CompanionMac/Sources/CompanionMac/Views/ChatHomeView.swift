import SwiftUI
import CompanionKit
import UniformTypeIdentifiers

private struct ChatScrollGeometry: Equatable {
    let top: CGFloat
    let bottom: CGFloat
}

private struct ChatScrollGeometryKey: PreferenceKey {
    static var defaultValue: ChatScrollGeometry? = nil
    static func reduce(value: inout ChatScrollGeometry?, nextValue: () -> ChatScrollGeometry?) {
        value = nextValue() ?? value
    }
}

/// 聊天主页：顶部 Companion 身份 + 消息流 + 浮动 Composer。
/// 主动消息/图片/follow-up 以普通消息形态自然出现（内部标签已剥离）。
struct ChatHomeView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let api: APIClient
    @ObservedObject var connection: ConnectionViewModel
    @ObservedObject var coreLauncher: CoreProcessManager
    var onRetryCore: (() -> Void)? = nil
    @StateObject private var sessions: SessionsViewModel
    @StateObject private var catchUp: ProactiveCatchUpService
    @StateObject private var attachmentDraft: AttachmentDraft
    @StateObject private var voice: VoicePlaybackManager
    @StateObject private var voiceMessageRecorder: ChatVoiceMessageRecorder
    @ObservedObject var voiceCall: VoiceCallManager
    @State private var draft = ""
    @State private var selectedConversation: Conversation?
    @State private var zoomMedia: MediaAttachment?
    @State private var zoomImage: NSImage?
    @State private var imageCache: [String: NSImage] = [:]
    @State private var showingImageImporter = false
    @State private var showingWorkspaceImporter = false
    @State private var chatListAtBottom = true
    @State private var lastChatContentTop: CGFloat?
    @State private var reloadDebounce: Task<Void, Never>? = nil
    @FocusState private var composerFocused: Bool

    init(connection: ConnectionViewModel, coreLauncher: CoreProcessManager? = nil, onRetryCore: (() -> Void)? = nil, voiceCall: VoiceCallManager) {
        self.onRetryCore = onRetryCore
        if let coreLauncher { _coreLauncher = ObservedObject(wrappedValue: coreLauncher) }
        else { _coreLauncher = ObservedObject(wrappedValue: CoreProcessManager()) }
        _connection = ObservedObject(wrappedValue: connection)
        _voiceCall = ObservedObject(wrappedValue: voiceCall)
        let api = connection.apiRef ?? APIClient(config: .init(baseURL: AppModelServerBase(), tokenProvider: { "" }))
        self.api = api
        MediaLoader.shared.apiProvider = { api }
        _sessions = StateObject(wrappedValue: SessionsViewModel(api: api, preferredSource: "chat"))
        _catchUp = StateObject(wrappedValue: ProactiveCatchUpService(api: api))
        _attachmentDraft = StateObject(wrappedValue: AttachmentDraft())
        _voice = StateObject(wrappedValue: VoicePlaybackManager(api: api))
        _voiceMessageRecorder = StateObject(wrappedValue: ChatVoiceMessageRecorder(api: api))
        NSLog("[voice-msg-ui] ChatVoiceMessageRecorder instantiated session=chat:default enabled=true canRecordFallback=always_visible")
    }

    var body: some View {
        ZStack {
            ambientVeil
            VStack(spacing: 0) {
                header
                reconnectBanner
                Divider()
                    .overlay(DS.ColorToken.separator.opacity(0.45))
                    .padding(.horizontal, DS.Space.l)
                messageList
                sendFailureBanner
                queuedGuidanceBar
                if voiceCall.isActive || voiceCall.phase == .starting || voiceCall.phase == .error || voiceCall.phase == .paused {
                    VoiceCallSurface(call: voiceCall) { Task { await voiceCall.end() } }
                }
                localPathChips
                ComposerBar(
                    text: $draft,
                    focused: $composerFocused,
                    attachment: attachmentDraft.item,
                    isUploading: attachmentDraft.isUploading,
                    attachmentError: attachmentDraft.errorText,
                    webEnabled: Binding(get: { sessions.webEnabled }, set: { sessions.setWebEnabled($0) }),
                    webSearchConfigured: sessions.webSearchConfigured,
                    webSearchProvider: sessions.webSearchProvider,
                    webSearchReason: sessions.webSearchReason,
                    permissionSnapshot: sessions.permissionSnapshot,
                    canSend: (!sessions.isSending || connection.isAgentRunning(sessionID: sessions.currentConversationID)) && !attachmentDraft.isUploading
                        && (!draft.trimmingCharacters(in: .whitespaces).isEmpty || attachmentDraft.item?.uploaded != nil),
                    isRecordingVoice: voiceMessageRecorder.phase == .recording,
                    voiceElapsed: voiceMessageRecorder.elapsed,
                    voiceError: voiceMessageRecorder.phase == .failed ? voiceMessageRecorder.errorText : nil,
                    canRecordVoice: !sessions.isSending && voiceMessageRecorder.phase != .sending && voiceMessageRecorder.phase != .stopping,
                    onPickImage: { showingImageImporter = true },
                    onRemoveImage: { attachmentDraft.remove() },
                    onSetPermissionMode: { mode in Task { await sessions.setPermissionMode(mode) } },
                    onChooseWorkspace: { showingWorkspaceImporter = true },
                    onClearWorkspace: { Task { await sessions.clearWorkspace() } },
                    onRevokeGrant: { grant in Task { await sessions.revokePermissionGrant(grant) } },
                    onRevokeAllGrants: { Task { await sessions.revokeAllPermissionGrants() } },
                    onToggleVoiceMessage: {
                        Task {
                            if voiceMessageRecorder.phase == .recording {
                                let started = Date()
                                await voiceMessageRecorder.stopAndSend()
                                NSLog("[voice-msg-ui] stopAndSend finished in %.2fs phase=%@", Date().timeIntervalSince(started), String(describing: voiceMessageRecorder.phase))
                                await sessions.reload()
                                await voice.prepare(rows: sessions.messages)
                                // STT success → send transcript as a normal chat turn so Companion can reply.
                                if let transcript = voiceMessageRecorder.lastTranscript, !transcript.isEmpty, voiceMessageRecorder.phase == .idle {
                                    NSLog("[voice-msg-ui] sending chat after voice transcript len=%d", transcript.count)
                                    _ = await sessions.sendDaily(transcript)
                                    await voice.prepare(rows: sessions.messages)
                                }
                            } else {
                                voiceMessageRecorder.start()
                            }
                        }
                    },
                    onCancelVoiceMessage: { voiceMessageRecorder.cancel() }
                ) {
            voice.noteUserTurn()
            send()
        }
            }
            .background(
                RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay(
                        RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous)
                            .fill(DS.ColorToken.surface.opacity(0.18))
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.xl, style: .continuous)
                    .strokeBorder(DS.ColorToken.separator.opacity(0.62), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.08), radius: 22, y: 8)
            .padding(.horizontal, DS.Space.l)
            .padding(.top, DS.Space.m)
            .padding(.bottom, DS.Space.l)
        }
        .task { await catchUp.refresh(); await sessions.loadCapabilities(); await sessions.reload(); await voice.prepare(rows: sessions.messages); await voice.refresh(); await reportSeenIfVisible() }
        .onChange(of: sessions.messages) { _ in Task { await reportSeenIfVisible() } }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await api.reportAttention(windowActive: true, chatVisible: true); await reportSeenIfVisible() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in
            Task { await api.reportAttention(windowActive: false, chatVisible: false) }
        }
        .onChange(of: connection.guidanceRevision) { _ in Task { await sessions.reloadGuidance() } }
        .onChange(of: connection.permissionRevision) { _ in Task { await sessions.reloadPermissions() } }
        .onChange(of: connection.voiceReadyRevision) { _ in
            if let ready = connection.lastVoiceReady {
                Task { await voice.handleVoiceReady(ready) }
            }
        }
        .onChange(of: connection.conversationRevision) { _ in
            // Coalesce rapid multi-bubble message.created into one reload.
            reloadDebounce?.cancel()
            reloadDebounce = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 180_000_000)
                guard !Task.isCancelled else { return }
                await sessions.reload()
                await voice.prepare(rows: sessions.messages, autoPlayRemotePlans: true)
                await reportSeenIfVisible()
            }
        }
        .fileImporter(isPresented: $showingImageImporter,
                      allowedContentTypes: [.png, .jpeg, .webP],
                      onCompletion: importImage)
        .fileImporter(isPresented: $showingWorkspaceImporter,
                      allowedContentTypes: [.folder],
                      allowsMultipleSelection: false,
                      onCompletion: importWorkspace)
        .overlay { zoomOverlay }
    }

    private func importWorkspace(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result, let url = urls.first else { return }
        Task { await sessions.setWorkspace(path: url.path) }
    }

    private var ambientVeil: some View {
        ZStack {
            LinearGradient(
                colors: [
                    DS.ColorToken.accent.opacity(0.08),
                    Color.clear,
                    DS.ColorToken.surface.opacity(0.12)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            RadialGradient(
                colors: [DS.ColorToken.accent.opacity(0.075), .clear],
                center: .bottomTrailing,
                startRadius: 24,
                endRadius: 520
            )
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    @ViewBuilder private var queuedGuidanceBar: some View {
        if !sessions.queuedGuidance.isEmpty {
            VStack(alignment: .leading, spacing: DS.Space.xs) {
                Label("已排队指引 · 将在下一个安全步骤应用", systemImage: "clock.arrow.circlepath")
                    .font(DS.Typography.caption)
                    .foregroundStyle(DS.ColorToken.textSecondary)
                ForEach(sessions.queuedGuidance) { item in
                    HStack(spacing: DS.Space.s) {
                        Text(item.content).font(DS.Typography.caption).lineLimit(2)
                        Spacer()
                        Button("取消") { Task { await sessions.cancelGuidance(item) } }
                            .buttonStyle(.borderless).controlSize(.small)
                            .accessibilityLabel("取消排队指引")
                    }
                }
            }
            .padding(.horizontal, DS.Space.m)
            .padding(.vertical, DS.Space.s)
            .background(
                RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous)
                    .fill(DS.ColorToken.warning.opacity(0.075))
            )
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous)
                    .strokeBorder(DS.ColorToken.warning.opacity(0.18), lineWidth: 1)
            )
            .padding(.horizontal, DS.Space.xl)
            .padding(.top, DS.Space.xs)
        }
    }

    @ViewBuilder private var sendFailureBanner: some View {
        if sessions.failedSend != nil {
            HStack(spacing: DS.Space.s) {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(DS.ColorToken.danger)
                Text(sessions.errorText ?? "消息发送失败，已保留在当前会话中。")
                    .font(DS.Typography.caption)
                    .foregroundStyle(DS.ColorToken.textSecondary)
                Spacer()
                Button("重试") { Task { await sessions.retryFailedSend() } }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(sessions.isSending)
            }
            .padding(.horizontal, DS.Space.m)
            .padding(.vertical, DS.Space.s)
            .background(
                RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous)
                    .fill(DS.ColorToken.danger.opacity(0.075))
            )
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.m, style: .continuous)
                    .strokeBorder(DS.ColorToken.danger.opacity(0.2), lineWidth: 1)
            )
            .padding(.horizontal, DS.Space.xl)
            .padding(.top, DS.Space.xs)
        }
    }

    // MARK: 头部

    private var header: some View {
        HStack(spacing: DS.Space.s) {
            AvatarView(name: "林小糖", size: 34)
            VStack(alignment: .leading, spacing: 1) {
                Text("林小糖")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(DS.ColorToken.textPrimary)
                HStack(spacing: DS.Space.xs) {
                    StatusDot(connected: connection.status == .connected)
                    Text(connection.status == .connected ? "在线" : "重连中…")
                        .font(.caption2)
                        .foregroundStyle(DS.ColorToken.textSecondary)
                }
            }
            Spacer()
            Button {
                Task {
                    if voiceCall.isActive { await voiceCall.end() }
                    else { await voiceCall.start { result, sink in
                        voice.stop()
                        let sent = await sessions.sendDaily(
                            result.speechContext.normalizedTranscript,
                            speechContext: result,
                            onDelta: { sink.consume($0) }
                        )
                        sink.finish()
                        guard sent else { return nil }
                        return sessions.messages.last(where: { $0.role == "assistant" })?.contentText
                    } }
                }
            } label: {
                Label(voiceCall.isActive ? "通话中" : "开始通话", systemImage: voiceCall.isActive ? "phone.fill" : "phone")
            }
            .buttonStyle(.bordered).controlSize(.small)
            .help(voiceCall.isActive ? "结束当前语音通话" : "开始与林小糖语音通话")
            if let conversationName = activeConversationName {
                Label(conversationName, systemImage: "bubble.left")
                    .font(.caption2)
                    .foregroundStyle(DS.ColorToken.textTertiary)
                    .lineLimit(1)
                    .padding(.horizontal, DS.Space.s)
                    .padding(.vertical, DS.Space.xs)
                    .background(DS.ColorToken.surfaceSecondary.opacity(0.62), in: Capsule())
            }
        }
        .padding(.horizontal, DS.Space.l)
        .frame(height: 54)
        .animation(reduceMotion ? nil : DS.Motion.fast, value: connection.status)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("林小糖，\(connection.status == .connected ? "在线" : "正在重新连接")")
    }

    private var activeConversationName: String? {
        let conversation = selectedConversation
            ?? sessions.conversations.first(where: { $0.id == sessions.currentConversationID })
            ?? sessions.conversations.first(where: { $0.category == "daily" })
        guard let name = conversation?.displayName.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
            return nil
        }
        return name
    }

    /// 断连轻量横幅：不打断使用，不暴露技术错误
    @ViewBuilder private var reconnectBanner: some View {
        if coreLauncher.phase.isFailed {
            VStack(spacing: DS.Space.xs) {
                Label("无法启动 Companion Core", systemImage: "exclamationmark.triangle")
                    .font(.footnote.weight(.medium)).foregroundStyle(DS.ColorToken.danger)
                Text(coreLauncher.phase.failureDetail ?? "")
                    .font(.caption2).foregroundStyle(DS.ColorToken.textSecondary)
                    .lineLimit(2)
                Button("重试") { onRetryCore?() }
                    .buttonStyle(.borderedProminent).controlSize(.small)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, DS.Space.m)
            .padding(.vertical, DS.Space.s)
            .background(DS.ColorToken.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: DS.Radius.m))
            .padding(.horizontal, DS.Space.l)
            .padding(.bottom, DS.Space.xs)
            .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
        } else if connection.status != .connected {
            HStack(spacing: DS.Space.s) {
                ProgressView().controlSize(.mini)
                Text("正在重新连接 Companion Core…")
                    .font(DS.Typography.caption)
                    .foregroundStyle(DS.ColorToken.textSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, DS.Space.s)
            .background(DS.ColorToken.warning.opacity(0.075), in: RoundedRectangle(cornerRadius: DS.Radius.m))
            .padding(.horizontal, DS.Space.l)
            .padding(.bottom, DS.Space.xs)
            .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
        }
    }

    // MARK: 消息流

    private var presentationItems: [MessagePresentation] {
        MessagePresentationBuilder.buildAssistantTurns(rows: sessions.messages,
                                         realtimeEvents: connection.activityEvents,
                                         sessionId: sessions.currentConversationID,
                                         pendingPermissions: sessions.permissionSnapshot?.pending ?? [])
    }

    private var messageList: some View {
        GeometryReader { geo in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if presentationItems.isEmpty {
                            emptyConversationState
                                .frame(minHeight: max(280, geo.size.height - DS.Space.xxl))
                        } else {
                            ForEach(Array(presentationItems.enumerated()), id: \.element.id) { index, item in
                                let previousRole = index > 0 ? presentationItems[index - 1].role : nil
                                presentationRow(item, previousRole: previousRole, width: geo.size.width)
                                .padding(.top, ChatMessageLayout.spacing(after: previousRole, before: item.role))
                                .id(item.id)
                                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
                            }
                            Color.clear.frame(height: 1).id("chat-bottom")
                        }
                    }
                    .padding(.horizontal, DS.Space.xl)
                    .padding(.top, DS.Space.l)
                    .padding(.bottom, DS.Space.xl)
                    .background(GeometryReader { content in
                        Color.clear.preference(key: ChatScrollGeometryKey.self,
                            value: ChatScrollGeometry(top: content.frame(in: .named("chat-scroll")).minY,
                                                      bottom: content.frame(in: .named("chat-scroll")).maxY))
                    })
                }
                .coordinateSpace(name: "chat-scroll")
                .onPreferenceChange(ChatScrollGeometryKey.self) { position in
                    guard let position else { return }
                    chatListAtBottom = ChatMessageLayout.followLatest(previousTop: lastChatContentTop,
                        currentTop: position.top, contentBottom: position.bottom,
                        viewportHeight: geo.size.height, wasFollowing: chatListAtBottom)
                    lastChatContentTop = position.top
                }
                .onChange(of: sessions.currentConversationID) { _ in
                    chatListAtBottom = true
                    lastChatContentTop = nil
                }
                .onChange(of: presentationItems) { items in
                    guard !items.isEmpty, chatListAtBottom else { return }
                    Task { @MainActor in
                        await Task.yield() // Wait for the new status/text height before following.
                        guard chatListAtBottom else { return }
                        if reduceMotion {
                            proxy.scrollTo("chat-bottom", anchor: .bottom)
                        } else {
                            withAnimation(DS.Motion.normal) {
                                proxy.scrollTo("chat-bottom", anchor: .bottom)
                            }
                        }
                        await reportSeenIfVisible()
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder private func presentationRow(_ item: MessagePresentation, previousRole: String?, width: CGFloat) -> some View {
        let maxWidth = ChatMessageLayout.bubbleMaxWidth(containerWidth: max(320, width - DS.Space.xl * 2), isUser: false)
        switch item {
        case .bubble(let row), .attachment(let row):
            MessageBubble(row: row, imageCache: $imageCache,
                          showsAvatar: previousRole != row.role, showsName: previousRole != row.role,
                          maxBubbleWidth: ChatMessageLayout.bubbleMaxWidth(
                            containerWidth: max(320, width - DS.Space.xl * 2), isUser: row.role == "user"),
                          onOpenMedia: { att in zoomMedia = att }, voiceState: voice.state(for: row.id),
                          onToggleVoice: { voice.toggle(messageID: $0) })
        case .toolActivityGroup(let group):
            assistantTurnRow(.init(activities: group.activities, messages: []), previousRole: previousRole, maxWidth: maxWidth)
        case .assistantTurn(let turn):
            assistantTurnRow(turn, previousRole: previousRole, maxWidth: maxWidth)
        case .approval(let approval):
            PermissionApprovalCard(request: approval.request, maxWidth: maxWidth,
                                   onAllowOnce: { Task { await sessions.resolvePermission(approval.request, action: "allow_once") } },
                                   onAllowSession: { Task { await sessions.resolvePermission(approval.request, action: "allow_session") } },
                                   onDeny: { Task { await sessions.resolvePermission(approval.request, action: "deny") } })
        }
    }

    private func assistantTurnRow(_ turn: AssistantTurnPresentation, previousRole: String?, maxWidth: CGFloat) -> some View {
        ChatAssistantTurnView(turn: turn, imageCache: $imageCache,
                              showsAvatar: previousRole != "assistant", showsName: previousRole != "assistant",
                              maxWidth: maxWidth, onOpenMedia: { zoomMedia = $0 },
                              voiceState: { voice.state(for: $0) },
                              onToggleVoice: { voice.toggle(messageID: $0) })
    }

    private var emptyConversationState: some View {
        VStack(spacing: DS.Space.m) {
            if sessions.isLoading {
                ProgressView()
                    .controlSize(.small)
                Text("正在打开你们的对话…")
                    .font(DS.Typography.caption)
                    .foregroundStyle(DS.ColorToken.textSecondary)
            } else {
                ZStack {
                    Circle()
                        .fill(DS.ColorToken.accent.opacity(0.10))
                        .frame(width: 58, height: 58)
                    Image(systemName: "sparkles")
                        .font(.system(size: 22, weight: .medium))
                        .foregroundStyle(DS.ColorToken.accent)
                }
                Text("从这里开始")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(DS.ColorToken.textPrimary)
                Text("聊聊今天、分享一张图片，或把还没理清的想法交给林小糖。")
                    .font(DS.Typography.secondary)
                    .foregroundStyle(DS.ColorToken.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
                Button {
                    draft = "今天有件事想和你聊聊。"
                    composerFocused = true
                } label: {
                    Label("聊聊今天", systemImage: "bubble.left")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityHint("把一句开场白放入输入框，不会立即发送")
            }
        }
        .padding(DS.Space.xl)
    }

    // MARK: 图片大图 overlay

    @ViewBuilder private var zoomOverlay: some View {
        if let att = zoomMedia {
            ZStack(alignment: .topTrailing) {
                Color.black.opacity(0.55).ignoresSafeArea()
                    .onTapGesture { zoomMedia = nil; Breadcrumb.emit("image preview dismiss") }
                VStack(spacing: DS.Space.m) {
                    if let img = imageCache[att.mediaId ?? ""] {
                        Image(nsImage: img).resizable().scaledToFit()
                            .frame(maxWidth: 720, maxHeight: 560)
                    } else { ProgressView() }
                    Button("关闭") { zoomMedia = nil; Breadcrumb.emit("image preview dismiss") }
                        .keyboardShortcut(.cancelAction)
                }
                .padding(DS.Space.xl)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: DS.Radius.xl))
                .padding(DS.Space.xxl)
            }
            .animation(reduceMotion ? nil : DS.Motion.fast, value: zoomMedia?.id)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("图片预览")
        }
    }

    /// Real seen only when this chat surface is on screen, app is active,
    /// and the list is at the bottom (latest messages actually visible).
    private func reportSeenIfVisible() async {
        guard NSApp.isActive, chatListAtBottom else { return }
        let ids = sessions.messages.filter { $0.role == "assistant" }.suffix(5).map(\.id)
        guard !ids.isEmpty else { return }
        await api.reportChatSeen(messageIds: ids, sessionID: sessions.currentConversationID, windowActive: true, chatVisible: true)
    }

    private func send() {
        chatListAtBottom = true
        voiceCall.interruptForText()
        voice.stop()
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let uploaded = attachmentDraft.item?.uploaded
        guard !text.isEmpty || uploaded != nil else { return }
        draft = ""
        if connection.isAgentRunning(sessionID: sessions.currentConversationID) {
            guard uploaded == nil else { sessions.errorText = "Agent 运行时的排队指引暂不支持图片。"; return }
            let sessionID = sessions.currentConversationID
            Task {
                switch await sessions.enqueueGuidanceResult(text) {
                case .queued: break
                case .noActiveTurn:
                    connection.markAgentStreamCompleted(sessionID: sessionID)
                    if !(await sessions.sendAfterCurrentTurnCompletes(text)) { draft = text }
                case .failed: draft = text
                }
            }
        } else {
            attachmentDraft.remove()
            let sessionID = sessions.currentConversationID
            Task {
                let sent = await sessions.sendDaily(text, attachments: uploaded.map { [$0] } ?? [])
                connection.markAgentStreamCompleted(sessionID: sessionID)
                if sent { await voice.prepare(rows: sessions.messages) }
            }
        }
    }

    // A chip is only a presentation of the pasted path. The backend still resolves it.
    @ViewBuilder private var localPathChips: some View {
        let paths = draft.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.hasPrefix("/Users/") || $0.hasPrefix("~/") }.prefix(8)
        if !paths.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(paths), id: \.self) { resource in
                        let ext = URL(fileURLWithPath: resource).pathExtension.lowercased()
                        Label(URL(fileURLWithPath: resource).lastPathComponent,
                              systemImage: ["png", "jpg", "jpeg", "webp", "gif"].contains(ext) ? "photo" : "doc")
                            .font(.caption).padding(.horizontal, 10).padding(.vertical, 5)
                            .background(.quaternary, in: Capsule())
                            .help("发送后读取此本机路径")
                    }
                }
            }.padding(.horizontal, DS.Space.l)
        }
    }

    private func importImage(_ result: Result<URL, Error>) {
        Task { @MainActor in
            do {
                let url = try result.get()
                let scoped = url.startAccessingSecurityScopedResource()
                let pending: PendingImageAttachment
                do { pending = try PendingImageAttachment.load(from: url) }
                catch { if scoped { url.stopAccessingSecurityScopedResource() }; throw error }
                if scoped { url.stopAccessingSecurityScopedResource() }
                attachmentDraft.select(pending)
                attachmentDraft.beginUpload()
                do {
                    let response = try await api.uploadImage(pending)
                    attachmentDraft.finishUpload(response, for: pending.id)
                } catch {
                    attachmentDraft.failUpload("图片上传失败", for: pending.id)
                }
            } catch ImageAttachmentError.tooLarge {
                attachmentDraft.failSelection("图片不能超过 10 MB")
            } catch ImageAttachmentError.unsupportedType {
                attachmentDraft.failSelection("仅支持 PNG、JPEG、WEBP")
            } catch {
                attachmentDraft.failSelection("无法读取这张图片")
            }
        }
    }
}
