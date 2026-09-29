import SwiftUI
import Combine
import CompanionKit
#if canImport(ServiceManagement)
import ServiceManagement
#endif
#if canImport(UserNotifications)
import UserNotifications
#endif

// MARK: - 应用单例模型：唯一构建 APIClient / Connection / CatchUp 的地方

@MainActor
final class AppModel: ObservableObject {
    enum CredentialState {
        case restoring
        case configured
        case unavailable
    }

    let api: APIClient
    let connection = ConnectionViewModel()
    let catchUp: ProactiveCatchUpService
    let coreLauncher: CoreProcessManager
    let deploymentMode: CoreDeploymentMode
    let voiceCall: VoiceCallManager
    let wakeWord: WakeWordRuntime
    let presenceSettings = PresenceSettingsStore()
    var pendingScreenContext: ScreenContextResponse?
    @Published private(set) var coreReady = false
    @Published private(set) var credentialState: CredentialState = .restoring
    private let keychain = KeychainStore()
    private let environmentToken: String

    func ensureCore() async {
        _ = deploymentMode == .local ? await coreLauncher.ensureRunning() : await coreLauncher.validateRemoteIsolation()
    }

    func retryCore() async {
        coreReady = false
        let ready = deploymentMode == .local ? await coreLauncher.retry() : await coreLauncher.validateRemoteIsolation()
        guard ready else { return }
        await start()
    }
    @Published var behavior = BehaviorSettings(
        proactiveLevel: "normal", proactiveMessagesEnabled: true,
        quietHours: QuietHours(start: "23:00", end: "08:00"),
        weatherAwareness: true, followUpEnabled: true, proactiveImagesEnabled: true,
        dailyProactiveCap: 3, dailyProactiveImageCap: 1
    )

    /// 候选体验默认连接 candidate Core :8770（生产 8765 不受影响）
    static func serverBaseURL() -> URL {
        if let raw = UserDefaults.standard.string(forKey: "serverBaseURL"), let url = URL(string: raw) { return url }
        return URL(string: "http://127.0.0.1:8770")!
    }

    static func configuredDeploymentMode() -> CoreDeploymentMode {
        CoreDeploymentMode.resolve(
            environment: ProcessInfo.processInfo.environment["CORE_MODE"],
            stored: UserDefaults.standard.string(forKey: "coreMode")
        )
    }

    /// 当前是否指向 candidate 环境（用于 UI 徽标，避免误认为 production）
    static var isCandidateTarget: Bool { configuredDeploymentMode() == .local && serverBaseURL().port == 8770 }

    init() {
        deploymentMode = Self.configuredDeploymentMode()
        coreLauncher = CoreProcessManager(mode: deploymentMode)
        environmentToken = ProcessInfo.processInfo.environment["COMPANION_API_KEY"] ?? ""
        CredentialCache.shared.replace(with: environmentToken)
        api = APIClient(config: .init(baseURL: Self.serverBaseURL(), tokenProvider: {
            CredentialCache.shared.value
        }))
        catchUp = ProactiveCatchUpService(api: api)
        voiceCall = VoiceCallManager(api: api)
        wakeWord = WakeWordRuntime(api: api)
        connection.configure(api: api, catchUp: catchUp)
        MediaLoader.shared.apiProvider = { [weak self] in self?.api }
    }

    func start() async {
        if let modeError = deploymentMode.validate(baseURL: Self.serverBaseURL()) {
            coreReady = false
            credentialState = .unavailable
            Breadcrumb.emit("core.mode invalid: \(modeError)")
            return
        }
        let result = await CoreFirstStartupSequence.run(
            startCore: {
                // local 仅管理 Candidate :8770；remote 从不启动本机 Core/Sub2API，
                // 且本机 :8770 仍在运行时拒绝连接云端，防止双主。
                let ready = self.deploymentMode == .local
                    ? await self.coreLauncher.ensureRunning()
                    : await self.coreLauncher.validateRemoteIsolation()
                self.coreReady = ready
                return ready
            },
            restoreCredential: {
                if !self.environmentToken.isEmpty { return self.environmentToken }
                return await self.keychain.loadAsync(account: "apiKey") ?? ""
            }
        )
        let token = result.credential
        CredentialCache.shared.replace(with: token)
        credentialState = token.isEmpty ? .unavailable : .configured
        guard result.coreReady, !token.isEmpty else { return }
        await connectAfterCredentialRestore()
    }

    func useSavedCredential(_ token: String) async {
        CredentialCache.shared.replace(with: token)
        credentialState = .configured
        guard coreReady else { return }
        await connectAfterCredentialRestore()
    }

    private func connectAfterCredentialRestore() async {
        connection.connectIfNeeded()
        await catchUp.refresh()
        if let b = try? await api.behavior() { behavior = b }
        await wakeWord.refreshFromCore()
    }

    func saveBehavior(_ b: BehaviorSettings) async {
        if let updated = try? await api.updateBehavior(b) { behavior = updated }
    }
}

// MARK: - 标准 SwiftUI 生命周期

@main
struct CompanionMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var app: AppModel

    init() {
        _app = StateObject(wrappedValue: AppModel())
        Breadcrumb.emit("app init")
    }

    var body: some Scene {
        WindowGroup {
            ZStack {
                switch app.credentialState {
                case .restoring:
                    VStack(spacing: DS.Space.m) {
                        ProgressView()
                        Text("正在恢复安全连接…")
                            .foregroundStyle(DS.ColorToken.textSecondary)
                    }
                    .frame(minWidth: 480, minHeight: 360)
                case .configured:
                    RootView(app: app)
                case .unavailable:
                    ConnectionSetupView(onSaved: { token in
                        Task { await app.useSavedCredential(token) }
                    })
                }
            }
            .task {
                appDelegate.bind(app)
                await app.start()
            }
        }
        // 菜单栏改由 AppDelegate 持有的 NSStatusItem 提供（强生命周期），
        // 规避 MenuBarExtra 场景在 macOS 27 上与 LiftedPresentation 的兼容问题。
    }

    private var connectionStatus: Bool { app.connection.status == .connected }
    // RootView 直接使用 app.api
}

// MARK: - 最小 AppDelegate：菜单栏状态项（强生命周期）+ 登录启动

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    // 强持有到 applicationWillTerminate，确保 StateObject/Scene 先销毁时
    // ownership manager 仍能终止本 App 拉起的 candidate Core。
    private var appModelRef: AppModel?
    private var statusCancellable: AnyCancellable?
    private var voiceStatusCancellable: AnyCancellable?
    private var wakeStatusCancellable: AnyCancellable?
    private var wakeOverlayCancellable: AnyCancellable?
    private var callActiveCancellable: AnyCancellable?
    private let hotkey = GlobalHotkey()
    private let quickChat = QuickChatPanelController()
    private let wakeOverlay = WakeOverlayController()
    private var quickSessions: SessionsViewModel?

    /// 关闭主窗口不退出（菜单栏常驻）。Quit 才停止 owned Candidate / 语音 / 任务。
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        PresenceLifecycle.terminatesAfterLastWindowClosed
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // 比 applicationWillTerminate 更早，Scene/StateObject 尚未拆除；
        // stopIfOwned 幂等，外部启动的 :8770 不会被终止。
        appModelRef?.voiceCall.haltForQuit()
        appModelRef?.wakeWord.haltForQuit()
        appModelRef?.coreLauncher.stopIfOwned()
        if let model = appModelRef {
            Task { await model.voiceCall.end() }
        }
        return .terminateNow
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NotificationCenter.default.addObserver(forName: .companionLaunchAtLoginChanged,
                                               object: nil, queue: .main) { [weak self] note in
            Task { @MainActor in
                self?.setLaunchAtLogin((note.object as? Bool) ?? false)
            }
        }
        #if canImport(UserNotifications)
        UNUserNotificationCenter.current().delegate = self
        NotificationService.shared.registerSafeCategories()
        #endif
        NotificationService.shared.requestAuthorizationIfNeeded()
        installLifecycleObservers()
        Breadcrumb.emit("app didFinishLaunching")
    }

    private func installLifecycleObservers() {
        let workspace = NSWorkspace.shared.notificationCenter
        workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.appModelRef?.wakeWord.handleSleep() }
        }
        workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.appModelRef?.wakeWord.handleWakeFromSleep() }
        }
        let dist = DistributedNotificationCenter.default()
        dist.addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.appModelRef?.wakeWord.handleLock() }
        }
        dist.addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.appModelRef?.wakeWord.handleUnlock() }
        }
        NotificationCenter.default.addObserver(forName: .companionAssistantAudioPlaying, object: nil, queue: .main) { [weak self] note in
            let playing = (note.object as? Bool) ?? false
            Task { @MainActor in self?.appModelRef?.wakeWord.setAssistantAudioPlaying(playing) }
        }
        NotificationCenter.default.addObserver(forName: .companionWakeWordSettingsChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.appModelRef?.wakeWord.refreshFromCore() }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // 兜底：Quit 时只关闭由本 App 本次拉起的 candidate Core；外部启动的不动
        appModelRef?.coreLauncher.stopIfOwned()
    }

    func bind(_ model: AppModel) {
        appModelRef = model
        installStatusItem()
        installHotkey(model)
        quickSessions = SessionsViewModel(api: model.api, preferredSource: "chat")
        statusCancellable = model.connection.$status
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.refreshStatusTitle(self?.appModelRef) }
        voiceStatusCancellable = model.voiceCall.$phase
            .receive(on: DispatchQueue.main)
            .sink { [weak self] phase in
                self?.appModelRef?.wakeWord.setAssistantAudioPlaying(phase == .assistantSpeaking)
                self?.refreshStatusTitle(self?.appModelRef)
            }
        wakeStatusCancellable = model.wakeWord.$phase
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.refreshStatusTitle(self?.appModelRef) }
        wakeOverlayCancellable = model.wakeWord.$overlayVisible
            .receive(on: DispatchQueue.main)
            .sink { [weak self] visible in
                guard let self, let model = self.appModelRef else { return }
                if visible { self.wakeOverlay.show(wake: model.wakeWord) } else { self.wakeOverlay.hide() }
            }
        callActiveCancellable = model.voiceCall.$isActive
            .receive(on: DispatchQueue.main)
            .sink { [weak self] active in
                Task { await self?.appModelRef?.wakeWord.setVoiceCallActive(active) }
            }
        model.wakeWord.onStartCall = { [weak self] in self?.toggleVoiceCall() }
        model.wakeWord.onUtterance = { [weak self] text, speech in
            guard let self, let model = self.appModelRef else { return nil }
            let sessions = SessionsViewModel(api: model.api, preferredSource: "chat")
            let sent = await sessions.sendDaily(text, speechContext: speech)
            return sent ? (sessions.messages.last(where: { $0.role == "assistant" })?.contentText ?? " ") : nil
        }
        refreshStatusTitle(model)
    }

    private func presenceStatus(_ model: AppModel?) -> PresenceStatus {
        guard let model else { return .offline }
        return PresenceStatus.resolve(
            connected: model.connection.status == .connected,
            agentRunning: model.connection.isAgentRunning(sessionID: nil) || !model.connection.activeAgentSessionIDs.isEmpty,
            pendingApproval: model.connection.permissionRevision > 0 && false,
            voice: model.voiceCall.phase,
            wake: model.wakeWord.phase
        )
    }

    private func refreshStatusTitle(_ model: AppModel?) {
        let status = presenceStatus(model)
        statusItem?.button?.title = ""
        let micActive = model?.voiceCall.isActive == true || model?.wakeWord.phase.usesMicrophone == true
        let symbol = model?.voiceCall.isActive == true ? "mic.fill" : (model?.wakeWord.phase.usesMicrophone == true ? "mic" : "sparkle")
        statusItem?.button?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "林小糖")
        statusItem?.button?.toolTip = micActive ? "林小糖 · \(status.title)" : "林小糖 · \(status.title)"
        rebuildMenu()
    }

    private func installHotkey(_ model: AppModel) {
        guard model.presenceSettings.settings.hotkeyEnabled else { return }
        hotkey.onPressed = { [weak self] in self?.toggleQuickChat() }
        _ = hotkey.register(.optionSpace)
    }

    private func installStatusItem() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "sparkle", accessibilityDescription: "林小糖")
        item.button?.toolTip = "林小糖"
        statusItem = item
        rebuildMenu()
    }

    private func rebuildMenu() {
        guard let item = statusItem else { return }
        let model = appModelRef
        let status = presenceStatus(model)
        let menu = NSMenu()
        let header = NSMenuItem(title: "林小糖 · \(status.title)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        if model?.voiceCall.isActive == true {
            let mic = NSMenuItem(title: "麦克风已开启", action: nil, keyEquivalent: "")
            mic.isEnabled = false
            menu.addItem(mic)
        } else if model?.wakeWord.settings.enabled == true, model?.wakeWord.phase.usesMicrophone == true {
            let mic = NSMenuItem(title: "林小糖 · 等待唤醒", action: nil, keyEquivalent: "")
            mic.isEnabled = false
            menu.addItem(mic)
            let using = NSMenuItem(title: "麦克风正在用于唤醒检测", action: nil, keyEquivalent: "")
            using.isEnabled = false
            menu.addItem(using)
        }
        menu.addItem(.separator())
        let wakeEnabled = model?.wakeWord.settings.enabled == true
        let wakeToggle = NSMenuItem(title: wakeEnabled ? "唤醒词：开" : "唤醒词：关", action: #selector(toggleWakeWord), keyEquivalent: "")
        wakeToggle.target = self
        menu.addItem(wakeToggle)
        let wakePause = NSMenuItem(title: wakeEnabled ? "暂停唤醒" : "开启唤醒", action: #selector(toggleWakeWord), keyEquivalent: "")
        wakePause.target = self
        menu.addItem(wakePause)
        menu.addItem(.separator())
        add(menu, .openCompanion, #selector(openMain), "o")
        add(menu, .quickChat, #selector(toggleQuickChat), "")
        let callTitle = model?.voiceCall.isActive == true ? "结束语音通话" : PresenceAction.voiceCall.title
        let call = NSMenuItem(title: callTitle, action: #selector(toggleVoiceCall), keyEquivalent: "")
        call.target = self
        menu.addItem(call)
        add(menu, .askScreen, #selector(askCurrentScreen), "")
        add(menu, .today, #selector(openToday), "")
        add(menu, .plans, #selector(openPlans), "")
        menu.addItem(.separator())
        let stop = NSMenuItem(title: PresenceAction.stopTask.title, action: #selector(stopCurrentTask), keyEquivalent: "")
        stop.target = self
        stop.isEnabled = !(model?.connection.activeAgentSessionIDs.isEmpty ?? true) || model?.voiceCall.isActive == true
        menu.addItem(stop)
        add(menu, .pauseTasks, #selector(pauseProactive), "")
        menu.addItem(.separator())
        let quit = NSMenuItem(title: PresenceAction.quit.title, action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        item.menu = menu
    }

    private func add(_ menu: NSMenu, _ action: PresenceAction, _ selector: Selector, _ key: String) {
        let item = NSMenuItem(title: action.title, action: selector, keyEquivalent: key)
        item.target = self
        menu.addItem(item)
    }

    @objc private func openMain() {
        NSApp.activate(ignoringOtherApps: true)
        for w in NSApp.windows where w.canBecomeMain { w.makeKeyAndOrderFront(nil) }
        NotificationCenter.default.post(name: .companionOpenDestination, object: ProductDestination.chat.rawValue)
    }

    @objc private func openToday() {
        openMain()
        NotificationCenter.default.post(name: .companionOpenDestination, object: ProductDestination.today.rawValue)
    }

    @objc private func openPlans() {
        openMain()
        NotificationCenter.default.post(name: .companionOpenDestination, object: ProductDestination.plans.rawValue)
    }

    @objc func toggleQuickChat() {
        guard let model = appModelRef, let sessions = quickSessions else { return }
        quickChat.dismissOnOutsideClick = model.presenceSettings.settings.dismissQuickChatOnOutsideClick
        let root = QuickChatView(
            sessions: sessions,
            voiceCall: model.voiceCall,
            screenContext: model.pendingScreenContext,
            onOpenFullChat: { [weak self] in self?.openMain(); self?.quickChat.close() },
            onStartVoiceCall: { [weak self] in self?.toggleVoiceCall() },
            onAskScreen: { [weak self] in self?.askCurrentScreen() },
            onDismiss: { [weak self] in self?.quickChat.close() }
        )
        quickChat.toggle(root: root)
        if quickChat.isVisible {
            Task { await sessions.reload() }
        }
    }

    @objc private func toggleVoiceCall() {
        guard let model = appModelRef else { return }
        Task {
            if model.voiceCall.isActive { await model.voiceCall.end() }
            else {
                await model.voiceCall.start { result, sink in
                    let sent = await SessionsViewModel(api: model.api, preferredSource: "chat").sendDaily(
                        result.speechContext.normalizedTranscript,
                        speechContext: result,
                        onDelta: { sink.consume($0) }
                    )
                    sink.finish()
                    return sent ? " " : nil
                }
            }
            await model.wakeWord.setVoiceCallActive(model.voiceCall.isActive)
            self.refreshStatusTitle(model)
        }
    }

    @objc private func toggleWakeWord() {
        guard let model = appModelRef else { return }
        Task {
            await model.wakeWord.setEnabled(!model.wakeWord.settings.enabled)
            self.refreshStatusTitle(model)
        }
    }

    @objc private func askCurrentScreen() {
        NotificationCenter.default.post(name: .companionAskScreen, object: nil)
        Task { @MainActor in
            if let model = appModelRef, let context = try? await model.api.captureScreenContext() {
                model.pendingScreenContext = context
            }
            toggleQuickChat()
        }
    }

    @objc private func stopCurrentTask() {
        NotificationCenter.default.post(name: .companionStopCurrentTask, object: nil)
        appModelRef?.voiceCall.stopSpeaking()
        Task { try? await appModelRef?.api.cancelVoiceSynthesis() }
    }

    @objc private func pauseProactive() {
        Task { @MainActor in
            guard let model = appModelRef else { return }
            var b = model.behavior; b.proactiveMessagesEnabled = false
            await model.saveBehavior(b)
        }
    }

    @objc private func resumeProactive() {
        Task { @MainActor in
            guard let model = appModelRef else { return }
            var b = model.behavior; b.proactiveMessagesEnabled = true
            await model.saveBehavior(b)
        }
    }

    var launchAtLoginEnabled: Bool {
        #if canImport(ServiceManagement)
        if #available(macOS 13.0, *) { return SMAppService.mainApp.status == .enabled }
        #endif
        return false
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        #if canImport(ServiceManagement)
        guard #available(macOS 13.0, *) else { return }
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            Breadcrumb.emit("launchAtLogin error")
        }
        #endif
    }
}

#if canImport(UserNotifications)
extension AppDelegate: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let action = response.actionIdentifier
        if NotificationService.isUnsafeNotificationAction(action) {
            completionHandler()
            return
        }
        let info = response.notification.request.content.userInfo
        Task { @MainActor in
            if action == "SNOOZE", let id = info["attentionId"] as? String, !id.isEmpty {
                try? await self.appModelRef?.api.snoozeAttention(id: id, in: "10m")
            } else {
                self.openMain()
                let destination = info["destination"] as? String
                NotificationCenter.default.post(name: .companionOpenDestination, object: destination ?? ProductDestination.chat.rawValue)
            }
        }
        completionHandler()
    }
}
#endif
