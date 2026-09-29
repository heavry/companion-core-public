import Foundation

public enum WakeWordPhase: String, Equatable {
    case disabled, starting, listening, detected, capturing, transcribing, thinking, answering, handoff, suspended, error

    public var title: String {
        switch self {
        case .disabled: return "唤醒已关闭"
        case .starting: return "正在启动唤醒"
        case .listening: return "等待唤醒"
        case .detected: return "已唤醒"
        case .capturing: return "正在听"
        case .transcribing, .thinking, .handoff: return "正在理解"
        case .answering: return "正在回答"
        case .suspended: return "唤醒已暂停"
        case .error: return "唤醒遇到问题"
        }
    }

    public var usesMicrophone: Bool {
        switch self {
        case .listening, .detected, .capturing, .starting: return true
        default: return false
        }
    }
}

public enum WakeWordCommand: String, Equatable {
    case empty
    case startCall = "start_call"
    case disableWake = "disable_wake"
    case cancel
    case utterance
}

public struct WakeWordSettings: Equatable {
    public var enabled = false
    public var sensitivity = "normal"
    public var feedbackSound = true
    public var suspendWhileLocked = true
    public init() {}
}

public enum WakeWordPrivacy {
    public static let persistAmbientAudio = false
    public static let writesToSharedMemory = false
    public static let createsAttentionOnWake = false
    public static let defaultEnabled = false
    public static let productQualified = false
    public static let phrase = "林小糖"
    public static let preRollSeconds = 0.9
    public static let oneShotTimeoutSeconds = 5.5
    public static let ttsHoldoffSeconds = 0.45
}

public enum WakeWordLifecycle {
    public static func shouldListen(
        enabled: Bool,
        locked: Bool = false,
        sleeping: Bool = false,
        voiceCallActive: Bool = false,
        suspendWhileLocked: Bool = true
    ) -> Bool {
        guard enabled else { return false }
        if sleeping { return false }
        if locked && suspendWhileLocked { return false }
        if voiceCallActive { return false }
        return true
    }

    public static func shouldResumeMicrophone(after event: String, enabled: Bool, locked: Bool = false, sleeping: Bool = false) -> Bool {
        guard enabled else { return false }
        if event == "launch" || event == "sleep" || event == "wake" || event == "lock" { return false }
        if event == "unlock" { return !locked && !sleeping }
        if event == "end_call" || event == "playback_end" || event == "setting_on" { return !locked && !sleeping }
        return false
    }

    public static func threshold(for sensitivity: String) -> Double {
        switch sensitivity {
        case "low": return 0.35
        case "high": return 0.18
        default: return 0.25
        }
    }

    public static func strip(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = trimmed.range(of: #"^\s*林小糖[，,。.\s]*"#, options: .regularExpression) {
            return String(trimmed[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return trimmed
    }

    public static func classify(_ text: String) -> WakeWordCommand {
        let compact = strip(text).replacingOccurrences(of: #"[，,。.!！？?、\s]"#, with: "", options: .regularExpression)
        if compact.isEmpty { return .empty }
        if compact == "进入通话" || compact == "进入语音通话" || compact == "开始语音通话" || compact == "跟我聊会儿" || compact == "跟我聊会" {
            return .startCall
        }
        if compact == "先别听了" || compact == "关闭唤醒" || compact == "暂停唤醒词" { return .disableWake }
        if compact == "算了" || compact == "没事了" || compact == "取消" { return .cancel }
        return .utterance
    }

    public static func persistUserText(command: WakeWordCommand, stripped: String) -> String? {
        command == .utterance && !stripped.isEmpty ? stripped : nil
    }

    public static func menuMicCopy(enabled: Bool, phase: WakeWordPhase) -> String? {
        guard enabled, phase.usesMicrophone else { return nil }
        return "麦克风正在用于唤醒检测"
    }
}

public protocol WakeSpotter: AnyObject {
    func ingest(pcm: [Int16], sampleRate: Double) async -> Bool
}

@MainActor
public final class FakeWakeSpotter: WakeSpotter {
    public var queuedHits = 0
    public var ingestCount = 0
    public func ingest(pcm: [Int16], sampleRate: Double) async -> Bool {
        ingestCount += 1
        if queuedHits > 0 {
            queuedHits -= 1
            return true
        }
        return false
    }
}

public struct WakeOneShotSession {
    public var detector = VoiceEndpointDetector()
    public var preRoll = VoicePreRollBuffer(capacitySamples: Int(WakeWordPrivacy.preRollSeconds * 16_000))
    public var samples: [Int16] = []
    public var startedAt = Date()
    public var hasSpeech = false

    public init() {
        detector.trailingSilenceSeconds = 0.7
        detector.maximumUtteranceSeconds = 12
        detector.preRollSeconds = WakeWordPrivacy.preRollSeconds
    }

    public mutating func reset() {
        detector.reset()
        preRoll.reset()
        samples.removeAll(keepingCapacity: true)
        hasSpeech = false
        startedAt = Date()
    }
}
