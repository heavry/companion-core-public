import Foundation

/// Safe numeric timings for one Voice Call turn. No audio, transcript, emotion, or secrets.
public struct VoiceTurnMetrics: Equatable, Codable, Sendable {
    public var callSessionId: String
    public var turnId: String
    public var speechStart: Date?
    public var speechEnd: Date?
    public var endpointDetected: Date?
    public var sttStart: Date?
    public var sttFinal: Date?
    public var agentRequestStart: Date?
    public var agentFirstToken: Date?
    public var agentFinal: Date?
    public var ttsRequestStart: Date?
    public var ttsFirstAudio: Date?
    public var playbackStart: Date?
    public var playbackEnd: Date?
    public var bargeInDetected: Date?
    public var playbackStopped: Date?
    public var endpointMs: Double?
    public var sttMs: Double?
    public var agentTTFTMs: Double?
    public var agentFinalMs: Double?
    public var ttsFirstAudioMs: Double?
    public var speechEndToFirstAudioMs: Double?
    public var bargeInStopMs: Double?
    public var vadFalseStartCount: Int
    public var selfTriggerPreventedCount: Int
    public var deviceSwitchCount: Int

    public init(callSessionId: String = "", turnId: String = "") {
        self.callSessionId = callSessionId
        self.turnId = turnId
        vadFalseStartCount = 0
        selfTriggerPreventedCount = 0
        deviceSwitchCount = 0
    }

    public static func milliseconds(from: Date?, to: Date?) -> Double? {
        guard let from, let to else { return nil }
        return (to.timeIntervalSince(from) * 1000).rounded()
    }

    public mutating func finalizeDurations() {
        endpointMs = Self.milliseconds(from: speechEnd, to: endpointDetected)
        sttMs = Self.milliseconds(from: sttStart, to: sttFinal)
        agentTTFTMs = Self.milliseconds(from: agentRequestStart, to: agentFirstToken)
        agentFinalMs = Self.milliseconds(from: agentRequestStart, to: agentFinal)
        ttsFirstAudioMs = Self.milliseconds(from: ttsRequestStart, to: ttsFirstAudio)
        speechEndToFirstAudioMs = Self.milliseconds(from: speechEnd, to: playbackStart)
        bargeInStopMs = Self.milliseconds(from: bargeInDetected, to: playbackStopped)
    }

    public func diagnosticsPayload() -> [String: Any] {
        func number(_ value: Double?) -> Any { value ?? NSNull() }
        return [
            "call_session_id": callSessionId,
            "turn_id": turnId,
            "endpoint_ms": number(endpointMs),
            "stt_ms": number(sttMs),
            "agent_ttft_ms": number(agentTTFTMs),
            "agent_final_ms": number(agentFinalMs),
            "tts_first_audio_ms": number(ttsFirstAudioMs),
            "speech_end_to_first_audio_ms": number(speechEndToFirstAudioMs),
            "barge_in_stop_ms": number(bargeInStopMs),
            "vad_false_starts": vadFalseStartCount,
            "self_triggers_prevented": selfTriggerPreventedCount,
            "device_changes": deviceSwitchCount
        ]
    }

    public static func p50(_ values: [Double]) -> Double? { percentile(values, 0.50) }
    public static func p90(_ values: [Double]) -> Double? { percentile(values, 0.90) }

    public static func percentile(_ values: [Double], _ fraction: Double) -> Double? {
        let sorted = values.filter(\.isFinite).sorted()
        guard !sorted.isEmpty else { return nil }
        let clamped = min(1, max(0, fraction))
        let index = min(sorted.count - 1, max(0, Int((Double(sorted.count - 1) * clamped).rounded())))
        return sorted[index]
    }
}

public enum VoiceCallPolicy {
    /// Hands-Free is an explicit Call session. Launch, wake, and End Call never reopen the mic.
    public static let resumesMicrophoneAfterLaunch = false
    public static let resumesMicrophoneAfterWake = false
    public static let listensOutsideCall = false
}

public enum VoiceCallLifecycle {
    public static func shouldSuppressSpeechTurns(isMuted: Bool) -> Bool { isMuted }
    public static func afterStop() -> VoiceCallPhase { .listening }
    public static func afterEnd() -> VoiceCallPhase { .idle }
    public static func afterSleep() -> VoiceCallPhase { .paused }
    public static func shouldResumeMicrophone(after event: String) -> Bool {
        !(event == "launch" || event == "wake" || event == "end")
    }
    public static func deviceChangeAction(canRebuild: Bool) -> (resume: Bool, message: String?) {
        canRebuild ? (true, nil) : (false, "音频设备已变化，请继续通话")
    }
}

public enum VoiceEndpointState: String, Equatable {
    case idle, speaking, shortPause, possibleEnd, confirmedEnd
}

/// Call-start noise floor with clamped adaptive threshold. Never falls through the floor.
public struct AdaptiveNoiseFloor {
    public var minThreshold: Float = 0.006
    public var maxThreshold: Float = 0.038
    public var multiplier: Float = 3.4
    public var defaultThreshold: Float = 0.014
    public var calibrationSeconds: Double = 1.2
    public private(set) var calibrated = false
    public private(set) var noiseFloor: Float = 0.004
    public private(set) var threshold: Float = 0.014
    private var noiseSamples: [Float] = []
    private var noiseSeconds = 0.0
    private var floorEMA: Float = 0.004

    public init() {}

    public mutating func observe(rms: Float, duration: Double, isVoiced: Bool) {
        guard duration > 0, rms.isFinite, rms >= 0 else { return }
        if !calibrated {
            if !isVoiced {
                noiseSamples.append(rms)
                noiseSeconds += duration
            }
            if noiseSeconds >= calibrationSeconds { finishCalibration() }
            return
        }
        guard !isVoiced else { return }
        let alpha: Float = rms > floorEMA ? 0.08 : 0.02
        floorEMA = floorEMA * (1 - alpha) + rms * alpha
        noiseFloor = floorEMA
        threshold = min(maxThreshold, max(minThreshold, noiseFloor * multiplier))
    }

    public mutating func reset() {
        calibrated = false
        noiseSamples.removeAll(keepingCapacity: true)
        noiseSeconds = 0
        noiseFloor = 0.004
        floorEMA = 0.004
        threshold = defaultThreshold
    }

    private mutating func finishCalibration() {
        let sorted = noiseSamples.sorted()
        let index = sorted.isEmpty ? 0 : min(sorted.count - 1, Int(Double(sorted.count) * 0.8))
        let p80 = sorted.isEmpty ? defaultThreshold / multiplier : sorted[index]
        noiseFloor = max(0.0015, p80)
        floorEMA = noiseFloor
        threshold = min(maxThreshold, max(minThreshold, noiseFloor * multiplier))
        calibrated = true
        noiseSamples.removeAll(keepingCapacity: true)
    }
}

public struct VoicePreRollBuffer {
    public var capacitySamples: Int
    private var storage: [Int16] = []

    public init(capacitySamples: Int) { self.capacitySamples = max(1, capacitySamples) }

    public mutating func append(_ samples: [Int16]) {
        storage.append(contentsOf: samples)
        if storage.count > capacitySamples {
            storage.removeFirst(storage.count - capacitySamples)
        }
    }

    public func snapshot() -> [Int16] { storage }

    public mutating func take() -> [Int16] {
        let out = storage
        storage.removeAll(keepingCapacity: true)
        return out
    }

    public mutating func reset() { storage.removeAll(keepingCapacity: true) }
}

public struct SpeechChunkStabilizer {
    public var firstChunkMinimum = 2
    public var laterChunkMinimum = 8
    private var raw = ""
    private var emitted = 0

    public init() {}

    public mutating func consume(_ delta: String) -> [String] {
        raw += delta
        return drain(final: false)
    }

    public mutating func finish() -> [String] { drain(final: true) }

    public mutating func reset() { raw = ""; emitted = 0 }

    private mutating func drain(final: Bool) -> [String] {
        let pieces = VoiceCallManager.sentenceQueue(raw)
        guard !pieces.isEmpty else { return [] }
        let ready: [String]
        if final {
            ready = pieces
        } else if let last = raw.trimmingCharacters(in: .whitespacesAndNewlines).last, "。！？!?；;\n".contains(last) {
            ready = pieces
        } else {
            ready = Array(pieces.dropLast())
        }
        let fresh = Array(ready.dropFirst(emitted)).filter { !$0.isEmpty }
        emitted = ready.count
        return fresh
    }
}

public final class VoiceSpeechSink: @unchecked Sendable {
    public let consume: @MainActor (String) -> Void
    public let finish: @MainActor () -> Void
    public init(consume: @escaping @MainActor (String) -> Void, finish: @escaping @MainActor () -> Void) {
        self.consume = consume
        self.finish = finish
    }
}

public enum VoiceAudioResampler {
    public static let senseVoiceRate: Double = 16_000

    public static func resample(_ samples: [Float], from sourceRate: Double, to targetRate: Double = senseVoiceRate) -> [Float] {
        guard sourceRate > 0, targetRate > 0, !samples.isEmpty else { return samples }
        if abs(sourceRate - targetRate) < 0.75 { return samples }
        let ratio = sourceRate / targetRate
        let count = max(1, Int((Double(samples.count) / ratio).rounded(.down)))
        var out = [Float](repeating: 0, count: count)
        for i in 0..<count {
            let src = Double(i) * ratio
            let i0 = min(samples.count - 1, max(0, Int(src)))
            let i1 = min(samples.count - 1, i0 + 1)
            let frac = Float(src - Double(i0))
            out[i] = samples[i0] * (1 - frac) + samples[i1] * frac
        }
        return out
    }

    public static func pcm16(_ samples: [Float]) -> [Int16] {
        samples.map { Int16((max(-1, min(1, $0)) * Float(Int16.max)).rounded()) }
    }

    public static func rms(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        return sqrt(samples.reduce(Float.zero) { $0 + $1 * $1 } / Float(samples.count))
    }
}
