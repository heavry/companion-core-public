import SwiftUI
import AppKit
import CompanionKit

/// Lightweight always-on-top Quick Chat. Sends through the existing yuna-chat / Native Agent path.
struct QuickChatView: View {
    @ObservedObject var sessions: SessionsViewModel
    @ObservedObject var voiceCall: VoiceCallManager
    var screenContext: ScreenContextResponse? = nil
    var onOpenFullChat: () -> Void
    var onStartVoiceCall: () -> Void
    var onAskScreen: () -> Void
    var onDismiss: () -> Void
    @State private var draft = ""
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.m) {
            HStack(spacing: DS.Space.m) {
                AvatarView(name: "林小糖", size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text("林小糖").font(.subheadline.weight(.semibold))
                    Text(voiceCall.isActive ? voiceCall.phase.title : (screenContext == nil ? "想问什么？" : "我看到了当前屏幕，你想问什么？"))
                        .font(.caption)
                        .foregroundStyle(DS.ColorToken.textSecondary)
                }
                Spacer()
                Button("打开完整 Chat", action: onOpenFullChat)
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
            if let last = lastAssistant, !last.isEmpty {
                Text(last)
                    .font(.callout)
                    .foregroundStyle(DS.ColorToken.textPrimary)
                    .lineLimit(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ComposerTextView(text: $draft, focused: $focused, canSend: canSend, onSend: send)
                .frame(minHeight: 72, maxHeight: 120)
                .padding(.horizontal, 6)
                .background(DS.ColorToken.surfaceSecondary, in: RoundedRectangle(cornerRadius: DS.Radius.s, style: .continuous))
            HStack {
                workspaceMenu
                Button("语音通话", action: onStartVoiceCall)
                Button("问当前屏幕", action: onAskScreen)
                Spacer()
                Button("发送", action: send).disabled(!canSend)
                Button("关闭", action: onDismiss).keyboardShortcut(.cancelAction)
            }
            .controlSize(.small)
        }
        .padding(DS.Space.l)
        .frame(width: 420)
        .background(DS.ColorToken.surface)
        .onAppear { focused = true }
        .onExitCommand(perform: onDismiss)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("林小糖快速聊天")
    }

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sessions.isSending }
    private var workspaceMenu: some View {
        Menu {
            if let workspace = sessions.permissionSnapshot?.workspace {
                Text("当前：\(workspace.name)")
                Text(workspace.path)
                Divider()
            } else {
                Text("本轮未授权 workspace")
                Divider()
            }
            Button("选择工作区…", action: chooseWorkspace)
            if sessions.permissionSnapshot?.workspace != nil { Button("清除工作区", role: .destructive) { Task { await sessions.clearWorkspace() } } }
        } label: {
            Label(sessions.permissionSnapshot?.workspace?.name ?? "工作区", systemImage: sessions.permissionSnapshot?.workspace == nil ? "folder.badge.questionmark" : "folder.badge.gearshape")
        }
        .help(sessions.permissionSnapshot?.workspace.map { "当前工作区：\($0.path)" } ?? "选择工作区以启用 Terminal 与 Filesystem")
    }
    private var lastAssistant: String? {
        sessions.messages.last(where: { $0.role == "assistant" })?.contentText
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        Task {
            _ = await sessions.sendDaily(text, screenContext: screenContext)
        }
    }

    private func chooseWorkspace() {
        let panel = NSOpenPanel();panel.canChooseDirectories = true;panel.canChooseFiles = false;panel.allowsMultipleSelection = false;panel.prompt = "授权此工作区"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await sessions.setWorkspace(path: url.path) }
    }
}

@MainActor
final class QuickChatPanelController: NSObject, NSWindowDelegate {
    private var panel: NSPanel?
    private var hosting: NSHostingView<QuickChatView>?
    private(set) var isVisible = false
    var dismissOnOutsideClick = true
    private var localMonitor: Any?

    func toggle(root: QuickChatView) {
        if isVisible { close(); return }
        show(root: root)
    }

    func show(root: QuickChatView) {
        if panel == nil {
            let panel = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 440, height: 280),
                styleMask: [.titled, .closable, .nonactivatingPanel, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            panel.isFloatingPanel = true
            panel.level = .floating
            panel.hidesOnDeactivate = false
            panel.becomesKeyOnlyIfNeeded = true
            panel.title = "林小糖"
            panel.titleVisibility = .hidden
            panel.titlebarAppearsTransparent = true
            panel.isReleasedWhenClosed = false
            panel.delegate = self
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            self.panel = panel
        }
        let view = NSHostingView(rootView: root)
        hosting = view
        panel?.contentView = view
        positionOnActiveScreen()
        panel?.makeKeyAndOrderFront(nil)
        isVisible = true
        if dismissOnOutsideClick {
            localMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
                guard let self, let panel = self.panel, self.isVisible else { return event }
                if event.window !== panel { self.close() }
                return event
            }
        }
    }

    func close() {
        panel?.orderOut(nil)
        isVisible = false
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        localMonitor = nil
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        close()
        return false
    }

    private func positionOnActiveScreen() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main
        guard let screen, let panel else { return }
        let frame = screen.visibleFrame
        let size = panel.frame.size
        let x = frame.midX - size.width / 2
        let y = frame.midY + 40
        panel.setFrameOrigin(NSPoint(x: x, y: min(y, frame.maxY - size.height - 24)))
    }
}
