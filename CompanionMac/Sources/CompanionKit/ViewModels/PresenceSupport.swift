import Foundation
import Carbon

/// Closing the main window must not quit runtime. Quit is the only full teardown.
public enum PresenceLifecycle {
    public static let terminatesAfterLastWindowClosed = false
    public static let stopsOwnedRuntimeOnQuit = true
    public static let keepsVoiceCallWhenMainWindowCloses = true
    public static let allowsBackgroundScreenshots = false
    public static let allowsBackgroundMicrophone = false
}

public enum PresenceStatus: String, Equatable {
    case offline, online, thinking, usingTools, speaking, voiceCall, waitingApproval
    case wakeWaiting, wakeDetected, wakeListening, wakeAnswering

    public var title: String {
        switch self {
        case .offline: return "离线"
        case .online: return "在线"
        case .thinking: return "正在思考"
        case .usingTools: return "正在执行任务"
        case .speaking: return "正在说话"
        case .voiceCall: return "语音通话中"
        case .waitingApproval: return "等待确认"
        case .wakeWaiting: return "等待唤醒"
        case .wakeDetected: return "已唤醒"
        case .wakeListening: return "正在听"
        case .wakeAnswering: return "正在回答"
        }
    }

    public static func resolve(connected: Bool, agentRunning: Bool, pendingApproval: Bool, voice: VoiceCallPhase, wake: WakeWordPhase = .disabled) -> PresenceStatus {
        if voice == .assistantSpeaking { return .speaking }
        if voice.isActiveCall { return .voiceCall }
        if pendingApproval { return .waitingApproval }
        if agentRunning { return .usingTools }
        switch wake {
        case .answering: return .wakeAnswering
        case .detected: return .wakeDetected
        case .capturing, .transcribing, .thinking, .handoff: return .wakeListening
        case .listening, .starting: return .wakeWaiting
        default: break
        }
        if connected { return .online }
        return .offline
    }
}

public extension VoiceCallPhase {
    var isActiveCall: Bool {
        switch self {
        case .idle, .paused, .error: return false
        default: return true
        }
    }
}

public enum PresenceAction: String, CaseIterable {
    case openCompanion, quickChat, voiceCall, askScreen, today, plans, stopTask, pauseTasks, quit

    public var title: String {
        switch self {
        case .openCompanion: return "打开 Companion"
        case .quickChat: return "快速聊天"
        case .voiceCall: return "开始语音通话"
        case .askScreen: return "问当前屏幕"
        case .today: return "今天"
        case .plans: return "计划"
        case .stopTask: return "停止当前任务"
        case .pauseTasks: return "暂停所有任务"
        case .quit: return "退出 Companion"
        }
    }

    public var isQuickSurface: Bool { true }
    public var usesExistingChatStore: Bool { self == .quickChat || self == .askScreen }
}

public enum ScreenContextPolicy {
    public static let requiresExplicitTrigger = true
    public static let allowsBackgroundCapture = false
    public static let writesToSharedMemory = false
    public static let persistScreenshots = false
}

public enum WorkspaceSelectionPolicy {
    public static let sharedSessionKey = "chat:default"
    public static let mainChatUsesSessionTruth = true
    public static let quickChatUsesSessionTruth = true
    public static let menuBarQuickChatUsesSessionTruth = true
    public static let defaultsToHome = false
    public static let defaultsToRoot = false
}

public enum NotificationPreviewMode: String, CaseIterable, Codable {
    case full, summary, privatePreview = "private"

    public var title: String {
        switch self {
        case .full: return "完整"
        case .summary: return "摘要"
        case .privatePreview: return "私密"
        }
    }
}

public struct PresenceSettings: Equatable {
    public var menuBarEnabled = true
    public var hotkeyEnabled = true
    public var dismissQuickChatOnOutsideClick = true
    public var notificationsEnabled = true
    public var notificationPreview: NotificationPreviewMode = .summary
    public var proactiveEnabled = true
    public var proactiveVoiceEnabled = false
    public var launchAtLogin = false

    public init() {}
}

public final class PresenceSettingsStore {
    private let defaults: UserDefaults
    private let prefix = "presence."

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public var settings: PresenceSettings {
        get {
            var value = PresenceSettings()
            if defaults.object(forKey: prefix + "menuBarEnabled") != nil {
                value.menuBarEnabled = defaults.bool(forKey: prefix + "menuBarEnabled")
            }
            if defaults.object(forKey: prefix + "hotkeyEnabled") != nil {
                value.hotkeyEnabled = defaults.bool(forKey: prefix + "hotkeyEnabled")
            }
            if defaults.object(forKey: prefix + "dismissQuickChatOnOutsideClick") != nil {
                value.dismissQuickChatOnOutsideClick = defaults.bool(forKey: prefix + "dismissQuickChatOnOutsideClick")
            }
            if defaults.object(forKey: prefix + "notificationsEnabled") != nil {
                value.notificationsEnabled = defaults.bool(forKey: prefix + "notificationsEnabled")
            }
            if let raw = defaults.string(forKey: prefix + "notificationPreview"),
               let mode = NotificationPreviewMode(rawValue: raw) {
                value.notificationPreview = mode
            }
            if defaults.object(forKey: prefix + "proactiveEnabled") != nil {
                value.proactiveEnabled = defaults.bool(forKey: prefix + "proactiveEnabled")
            }
            value.proactiveVoiceEnabled = defaults.bool(forKey: prefix + "proactiveVoiceEnabled")
            return value
        }
        set {
            defaults.set(newValue.menuBarEnabled, forKey: prefix + "menuBarEnabled")
            defaults.set(newValue.hotkeyEnabled, forKey: prefix + "hotkeyEnabled")
            defaults.set(newValue.dismissQuickChatOnOutsideClick, forKey: prefix + "dismissQuickChatOnOutsideClick")
            defaults.set(newValue.notificationsEnabled, forKey: prefix + "notificationsEnabled")
            defaults.set(newValue.notificationPreview.rawValue, forKey: prefix + "notificationPreview")
            defaults.set(newValue.proactiveEnabled, forKey: prefix + "proactiveEnabled")
            defaults.set(newValue.proactiveVoiceEnabled, forKey: prefix + "proactiveVoiceEnabled")
        }
    }
}

public final class GlobalHotkey {
    public struct Chord: Equatable {
        public var keyCode: UInt32
        public var carbonModifiers: UInt32
        public init(keyCode: UInt32, carbonModifiers: UInt32) {
            self.keyCode = keyCode
            self.carbonModifiers = carbonModifiers
        }
        /// Option+Space. Does not steal Command+Space (Spotlight).
        public static let optionSpace = Chord(keyCode: 49, carbonModifiers: UInt32(optionKey))
        public var displayName: String {
            var parts: [String] = []
            if carbonModifiers & UInt32(controlKey) != 0 { parts.append("⌃") }
            if carbonModifiers & UInt32(optionKey) != 0 { parts.append("⌥") }
            if carbonModifiers & UInt32(shiftKey) != 0 { parts.append("⇧") }
            if carbonModifiers & UInt32(cmdKey) != 0 { parts.append("⌘") }
            if keyCode == 49 { parts.append("Space") }
            else { parts.append("Key") }
            return parts.joined(separator: "")
        }
    }

    public private(set) var registered = false
    public private(set) var lastError: String?
    public var onPressed: (() -> Void)?
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?

    public init() {}

    @discardableResult
    public func register(_ chord: Chord = .optionSpace) -> Bool {
        unregister()
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let userData = Unmanaged.passUnretained(self).toOpaque()
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            guard let userData else { return noErr }
            let hotkey = Unmanaged<GlobalHotkey>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { hotkey.onPressed?() }
            return noErr
        }, 1, &spec, userData, &handlerRef)
        guard installed == noErr else {
            lastError = "hotkey handler unavailable"
            return false
        }
        let identifier = EventHotKeyID(signature: OSType(0x434D504E), id: 1)
        let status = RegisterEventHotKey(chord.keyCode, chord.carbonModifiers, identifier, GetApplicationEventTarget(), 0, &hotKeyRef)
        registered = status == noErr
        if !registered {
            lastError = "hotkey already in use"
            unregister()
        } else {
            lastError = nil
        }
        return registered
    }

    public func unregister() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
        hotKeyRef = nil
        handlerRef = nil
        registered = false
    }

    deinit { unregister() }
}

public extension Notification.Name {
    static let companionOpenDestination = Notification.Name("companionOpenDestination")
    static let companionToggleQuickChat = Notification.Name("companionToggleQuickChat")
    static let companionStartVoiceCall = Notification.Name("companionStartVoiceCall")
    static let companionAskScreen = Notification.Name("companionAskScreen")
    static let companionStopCurrentTask = Notification.Name("companionStopCurrentTask")
    static let companionAssistantAudioPlaying = Notification.Name("companionAssistantAudioPlaying")
    static let companionWakeWordSettingsChanged = Notification.Name("companionWakeWordSettingsChanged")
}
