import Foundation
import Combine
import AVFoundation
import AppKit

public enum VoiceCallPhase: String, Equatable {
    case idle, starting, listening, userSpeaking, transcribing, thinking, assistantSpeaking, interrupted, paused, error
    public var title: String {
        switch self {
        case .idle: return "未通话"
        case .starting: return "正在准备本地语音…"
        case .listening: return "正在听"
        case .userSpeaking, .interrupted: return "你正在说话"
        case .transcribing, .thinking: return "正在理解"
        case .assistantSpeaking: return "林小糖正在说话"
        case .paused: return "通话已暂停"
        case .error: return "语音通话遇到问题"
        }
    }
}

public struct VoiceEndpointDetector {
    public var speechThreshold: Float = 0.014
    public var minimumSpeechSeconds: Double = 0.24
    public var trailingSilenceSeconds: Double = 0.65
    public var maximumUtteranceSeconds: Double = 20
    public var shortPauseSeconds: Double = 0.28
    public var possibleEndSeconds: Double = 0.48
    public var preRollSeconds: Double = 0.28
    public var postRollSeconds: Double = 0.18
    private(set) public var speechSeconds = 0.0
    private(set) public var silenceSeconds = 0.0
    private(set) public var totalSeconds = 0.0
    public private(set) var hasSpeech = false
    public private(set) var pauseCount = 0
    public private(set) var state: VoiceEndpointState = .idle

    public var confirmedEndSeconds: Double {
        var base = speechSeconds < 1.0 ? 0.55 : speechSeconds < 3.5 ? 0.72 : 0.92
        if pauseCount >= 1 { base += 0.12 }
        return min(1.15, max(trailingSilenceSeconds - 0.17, base))
    }

    public mutating func observe(rms: Float, duration: Double) -> Bool {
        totalSeconds += duration
        if rms >= speechThreshold {
            if hasSpeech && silenceSeconds >= shortPauseSeconds { pauseCount += 1 }
            speechSeconds += duration
            silenceSeconds = 0
            if speechSeconds >= minimumSpeechSeconds { hasSpeech = true; state = .speaking }
            return hasSpeech && totalSeconds >= maximumUtteranceSeconds
        }
        guard hasSpeech else { state = .idle; return false }
        silenceSeconds += duration
        if silenceSeconds < shortPauseSeconds { state = .shortPause; return totalSeconds >= maximumUtteranceSeconds }
        if silenceSeconds < confirmedEndSeconds { state = .possibleEnd; return totalSeconds >= maximumUtteranceSeconds }
        state = .confirmedEnd
        return true
    }
    public mutating func reset() { speechSeconds = 0; silenceSeconds = 0; totalSeconds = 0; hasSpeech = false; pauseCount = 0; state = .idle }
}

public struct VoiceBargeInGate {
    public var minimumSeconds = 0.16
    public var startupGuardSeconds = 0.32
    private var candidateSeconds = 0.0
    public mutating func observe(rms: Float, assistantLevel: Float, playbackAge: Double, duration: Double) -> Bool {
        guard playbackAge >= startupGuardSeconds else { candidateSeconds = 0; return false }
        // Echo tracks playback energy; a real barge-in must clearly outrun the speaker.
        if assistantLevel >= 0.08 && rms < assistantLevel * 1.2 { candidateSeconds = 0; return false }
        let threshold = max(0.07, assistantLevel * 1.15)
        if rms >= threshold { candidateSeconds += duration } else { candidateSeconds = 0 }
        return candidateSeconds >= minimumSeconds
    }
    public mutating func reset() { candidateSeconds = 0 }
}

@MainActor
public final class VoiceCallManager: NSObject, ObservableObject, AVAudioPlayerDelegate {
    public typealias TurnHandler = @MainActor (VoiceCallTranscription, VoiceSpeechSink) async -> String?
    @Published public private(set) var phase: VoiceCallPhase = .idle
    @Published public private(set) var isActive = false
    @Published public private(set) var isMuted = false
    @Published public private(set) var transcript = ""
    @Published public private(set) var errorText: String?
    @Published public private(set) var lastSTTMilliseconds: Double?
    @Published public private(set) var lastTurnMilliseconds: Double?
    @Published public private(set) var lastMetrics: VoiceTurnMetrics?
    @Published public private(set) var bargeInCount = 0
    @Published public private(set) var callSessionId = ""
    @Published public private(set) var inputLevel: Float = 0
    @Published public private(set) var nativeEchoCancellationEnabled = false
    @Published public private(set) var captureSampleRate: Double = 16_000
    @Published public private(set) var recentTurns: [String] = []

    private let api: APIClient
    private let engine = AVAudioEngine()
    private var detector = VoiceEndpointDetector()
    private var bargeInGate = VoiceBargeInGate()
    private var noiseFloor = AdaptiveNoiseFloor()
    private var preRoll = VoicePreRollBuffer(capacitySamples: Int(0.28 * 16_000))
    private var samples: [Int16] = []
    private var sampleRate: Double = 16_000
    private var channels: UInt16 = 1
    private var echoHoldoffUntil = Date.distantPast
    private var rebuildingRoute = false
    private var handlingTurn = false
    private var handler: TurnHandler?
    private var player: AVAudioPlayer?
    private var speechQueue: [String] = []
    private var speechGeneration = UUID()
    private var speechStarted = false
    private var stabilizer = SpeechChunkStabilizer()
    private var playbackStartedAt = Date.distantPast
    private var sleepObserver: NSObjectProtocol?
    private var routeObserver: NSObjectProtocol?
    private var callStartedAt: Date?
    private var utteranceCount = 0
    private var cancellationCount = 0
    private var turnSerial = 0
    private var currentTurn = VoiceTurnMetrics()
    private var completedBargeInStops: [Double] = []
    private var speechSeconds = 0.0
    private var muteDurationSeconds = 0.0
    private var muteStartedAt: Date?
    private var deviceSwitchCount = 0
    private var falseStartCount = 0
    private var selfTriggerPreventedCount = 0
    private var selfTriggerHold = false

    public init(api: APIClient) { self.api = api; super.init() }
    deinit {
        if let sleepObserver { NSWorkspace.shared.notificationCenter.removeObserver(sleepObserver) }
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
    }

    public func start(handler: @escaping TurnHandler) async {
        guard !isActive else { return }; self.handler = handler; phase = .starting; errorText = nil
        let granted: Bool
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: granted = true
        case .notDetermined: granted = await AVCaptureDevice.requestAccess(for: .audio)
        default: granted = false
        }
        guard granted else { phase = .error; errorText = "需要在系统设置中允许 Companion 使用麦克风"; return }
        do {
            _ = try await api.voiceCallPrewarm(); try beginCapture(); isActive = true; callStartedAt = Date(); callSessionId = UUID().uuidString; utteranceCount = 0; cancellationCount = 0; turnSerial = 0; completedBargeInStops = []; speechSeconds = 0; muteDurationSeconds = 0; muteStartedAt = nil; deviceSwitchCount = 0; falseStartCount = 0; selfTriggerPreventedCount = 0; lastMetrics = nil; recentTurns = []; noiseFloor.reset(); preRoll.reset(); echoHoldoffUntil = Date.distantPast; phase = .listening
            sleepObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in await self?.interruptForSleep() } }
            routeObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in Task { @MainActor in self?.handleRouteChange() } }
        } catch { phase = .error; errorText = "本地语音服务未能启动"; stopCapture() }
    }

    public func toggleMute() {
        isMuted.toggle()
        if isMuted { muteStartedAt = Date(); samples.removeAll(keepingCapacity: true); detector.reset() }
        else if let muteStartedAt { muteDurationSeconds += Date().timeIntervalSince(muteStartedAt); self.muteStartedAt = nil }
    }
    public func interruptForText() { guard isActive else { return }; if phase == .assistantSpeaking { cancellationCount += 1 }; stopPlayback(); phase = VoiceCallLifecycle.afterStop() }
    public func stopSpeaking() { guard isActive else { return }; cancellationCount += 1; stopPlayback(); phase = VoiceCallLifecycle.afterStop() }
    public func interruptForSleep() async {
        guard isActive else { return }
        await end(finalPhase: VoiceCallLifecycle.afterSleep())
    }
    public func haltForQuit() {
        stopPlayback(); stopCapture(); isActive = false; handlingTurn = false; phase = .idle
    }

    public func end() async { await end(finalPhase: VoiceCallLifecycle.afterEnd()) }

    private func end(finalPhase: VoiceCallPhase) async {
        if isMuted, let muteStartedAt { muteDurationSeconds += Date().timeIntervalSince(muteStartedAt); self.muteStartedAt = nil }
        let duration = callStartedAt.map { Date().timeIntervalSince($0) } ?? 0
        let session = callSessionId
        stopPlayback(); stopCapture(); isActive = false; handlingTurn = false; isMuted = false; phase = finalPhase; callStartedAt = nil
        if finalPhase == .idle { transcript = ""; recentTurns = [] }
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver); self.routeObserver = nil }
        try? await api.endVoiceCall(
            duration: duration, utterances: utteranceCount, bargeIns: bargeInCount, cancellations: cancellationCount,
            muteDuration: muteDurationSeconds, deviceChanges: deviceSwitchCount, speechSeconds: speechSeconds,
            falseStarts: falseStartCount, selfTriggersPrevented: selfTriggerPreventedCount, callSessionId: session
        )
        callSessionId = ""
    }

    private func handleRouteChange() {
        guard isActive, !rebuildingRoute else { return }
        rebuildingRoute = true
        defer { rebuildingRoute = false }
        deviceSwitchCount += 1
        do {
            if engine.isRunning { engine.stop() }
            engine.inputNode.removeTap(onBus: 0)
            try beginCapture()
            errorText = nil
        } catch {
            let failed = VoiceCallLifecycle.deviceChangeAction(canRebuild: false)
            phase = .error
            errorText = failed.message
        }
    }

    private func beginCapture() throws {
        let input = engine.inputNode
        nativeEchoCancellationEnabled = Self.enableNativeVoiceProcessing(input)
        let format = input.outputFormat(forBus: 0)
        captureSampleRate = format.sampleRate > 0 ? format.sampleRate : 16_000
        sampleRate = VoiceAudioResampler.senseVoiceRate
        channels = 1
        preRoll = VoicePreRollBuffer(capacitySamples: Int(detector.preRollSeconds * sampleRate))
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let channel = buffer.floatChannelData?[0] else { return }
            let count = Int(buffer.frameLength), values = Array(UnsafeBufferPointer(start: channel, count: count))
            Task { @MainActor in self?.consume(values, sampleRate: format.sampleRate) }
        }
        engine.prepare(); try engine.start()
    }
    private func stopCapture() { if engine.isRunning { engine.stop() }; engine.inputNode.removeTap(onBus: 0); samples.removeAll(); detector.reset(); preRoll.reset(); inputLevel = 0 }

    /// Voice processing AEC exists on macOS 14+ AVAudioInputNode. It is best-effort:
    /// AirPods / format changes can throw, so software echo guards always remain on.
    nonisolated public static func enableNativeVoiceProcessing(_ input: AVAudioInputNode) -> Bool {
        if #available(macOS 14.0, *) {
            do {
                try input.setVoiceProcessingEnabled(true)
                return input.isVoiceProcessingEnabled
            } catch { return false }
        }
        return false
    }

    private func consume(_ values: [Float], sampleRate hardwareRate: Double) {
        guard isActive, !VoiceCallLifecycle.shouldSuppressSpeechTurns(isMuted: isMuted), !values.isEmpty else { return }
        if handlingTurn && phase != .assistantSpeaking { return }
        let resampled = VoiceAudioResampler.resample(values, from: hardwareRate > 0 ? hardwareRate : captureSampleRate)
        let pcm = VoiceAudioResampler.pcm16(resampled)
        let rms = VoiceAudioResampler.rms(resampled)
        let seconds = Double(resampled.count) / VoiceAudioResampler.senseVoiceRate
        inputLevel = rms
        detector.speechThreshold = noiseFloor.threshold
        if phase == .listening && Date() < echoHoldoffUntil {
            noiseFloor.observe(rms: rms, duration: seconds, isVoiced: false)
            preRoll.append(pcm)
            return
        }
        if phase == .assistantSpeaking {
            player?.updateMeters()
            let assistantLevel = player.map { pow(10, $0.averagePower(forChannel: 0) / 20) } ?? 0
            let dynamicThreshold = max(noiseFloor.threshold, assistantLevel * 0.9)
            guard bargeInGate.observe(rms: rms, assistantLevel: max(assistantLevel, dynamicThreshold), playbackAge: Date().timeIntervalSince(playbackStartedAt), duration: seconds) else {
                noiseFloor.observe(rms: rms, duration: seconds, isVoiced: false)
                if rms >= detector.speechThreshold {
                    if !selfTriggerHold { selfTriggerPreventedCount += 1; selfTriggerHold = true }
                } else { selfTriggerHold = false }
                return
            }
            selfTriggerHold = false
            currentTurn.bargeInDetected = Date(); bargeInCount += 1; stopPlayback(); currentTurn.playbackStopped = Date(); currentTurn.finalizeDurations()
            if let stop = currentTurn.bargeInStopMs { completedBargeInStops.append(stop) }
            let snapshot = currentTurn
            lastMetrics = snapshot
            Task { try? await api.recordVoiceCallTurn(snapshot) }
            phase = .interrupted; detector.reset(); samples.removeAll(keepingCapacity: true); preRoll.reset()
            beginTurnClock(); phase = .userSpeaking
        }
        let voiced = rms >= detector.speechThreshold
        if phase == .listening || (phase == .interrupted && !voiced) {
            noiseFloor.observe(rms: rms, duration: seconds, isVoiced: voiced)
        }
        if voiced, phase == .listening || phase == .interrupted {
            if currentTurn.speechStart == nil || phase != .userSpeaking { beginTurnClock() }
            phase = .userSpeaking
        }
        if detector.hasSpeech || voiced { speechSeconds += seconds }
        if voiced && samples.isEmpty { samples.append(contentsOf: preRoll.take()) }
        if voiced || detector.hasSpeech { samples.append(contentsOf: pcm) } else { preRoll.append(pcm) }
        if detector.observe(rms: rms, duration: seconds) { finishUtterance() }
        else if !detector.hasSpeech && detector.totalSeconds > 1.5 {
            if phase == .userSpeaking { falseStartCount += 1; phase = .listening }
            samples.removeAll(keepingCapacity: true); detector.reset()
        }
    }

    private func beginTurnClock() {
        turnSerial += 1
        currentTurn = VoiceTurnMetrics(callSessionId: callSessionId, turnId: "turn-\(turnSerial)")
        currentTurn.speechStart = Date()
        currentTurn.deviceSwitchCount = deviceSwitchCount
        currentTurn.selfTriggerPreventedCount = selfTriggerPreventedCount
        currentTurn.vadFalseStartCount = falseStartCount
    }

    private func finishUtterance() {
        guard detector.hasSpeech, !samples.isEmpty else { return }; handlingTurn = true; phase = .transcribing
        if currentTurn.speechStart == nil { beginTurnClock() }
        currentTurn.speechEnd = Date().addingTimeInterval(-detector.silenceSeconds)
        currentTurn.endpointDetected = Date()
        let wav = Self.wav(samples: samples, sampleRate: UInt32(sampleRate), channels: channels)
        samples.removeAll(keepingCapacity: true); detector.reset(); let started = Date()
        currentTurn.sttStart = started
        Task {
            do {
                let result = try await api.transcribeVoiceCall(wav: wav, sessionID: "chat:default")
                currentTurn.sttFinal = Date()
                utteranceCount += 1
                lastSTTMilliseconds = result.inferenceMs; transcript = result.speechContext.normalizedTranscript
                if !transcript.isEmpty { recentTurns = ([transcript] + recentTurns).prefix(3).map { $0 } }
                guard !transcript.isEmpty else { currentTurn.finalizeDurations(); await publishTurnMetrics(); handlingTurn = false; phase = .listening; return }
                phase = .thinking
                currentTurn.agentRequestStart = Date()
                speechStarted = false
                stabilizer.reset()
                let ingestGeneration = UUID()
                speechGeneration = ingestGeneration
                let sink = VoiceSpeechSink(
                    consume: { [weak self] delta in self?.ingestSpeechDelta(delta, generation: ingestGeneration) },
                    finish: { [weak self] in self?.finishSpeechStream(generation: ingestGeneration) }
                )
                if let reply = await handler?(result, sink) {
                    currentTurn.agentFinal = Date()
                    sink.finish()
                    if !speechStarted, !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                       Self.shouldSpeak(userTranscript: result.speechContext.normalizedTranscript) {
                        beginSpeech(reply)
                    } else if !speechStarted {
                        currentTurn.finalizeDurations(); await publishTurnMetrics(); handlingTurn = false; phase = .listening
                    }
                } else {
                    currentTurn.agentFinal = Date()
                    sink.finish()
                    if !speechStarted { currentTurn.finalizeDurations(); await publishTurnMetrics(); handlingTurn = false; phase = .listening }
                }
                lastTurnMilliseconds = Date().timeIntervalSince(started) * 1000
            } catch { currentTurn.sttFinal = Date(); currentTurn.finalizeDurations(); await publishTurnMetrics(); handlingTurn = false; phase = .error; errorText = "这句话没有处理成功，请再说一次" }
        }
    }

    private func ingestSpeechDelta(_ delta: String, generation: UUID) {
        guard generation == speechGeneration, isActive, Self.shouldSpeak(userTranscript: transcript) else { return }
        if currentTurn.agentFirstToken == nil, !delta.isEmpty { currentTurn.agentFirstToken = Date() }
        enqueueSpoken(stabilizer.consume(delta), generation: generation)
    }
    private func finishSpeechStream(generation: UUID) {
        guard generation == speechGeneration, isActive else { return }
        enqueueSpoken(stabilizer.finish(), generation: generation)
    }
    private func enqueueSpoken(_ chunks: [String], generation: UUID) {
        guard generation == speechGeneration, !chunks.isEmpty else { return }
        if !speechStarted {
            speechStarted = true
            speechQueue = chunks
            phase = .assistantSpeaking
            Task { await playNextSentence(generation: generation) }
        } else {
            speechQueue.append(contentsOf: chunks)
        }
    }
    private func beginSpeech(_ text: String) {
        speechGeneration = UUID(); speechStarted = true; speechQueue = Self.sentenceQueue(text); phase = .assistantSpeaking
        Task { await playNextSentence(generation: speechGeneration) }
    }
    private func playNextSentence(generation: UUID) async {
        guard generation == speechGeneration, isActive else { return }
        guard !speechQueue.isEmpty else { echoHoldoffUntil = Date().addingTimeInterval(0.22); handlingTurn = false; phase = .listening; return }
        let sentence = speechQueue.removeFirst()
        do {
            if currentTurn.ttsRequestStart == nil { currentTurn.ttsRequestStart = Date() }
            let synthesis = try await api.synthesizeVoiceCall(text: sentence, sessionID: "chat:default")
            guard generation == speechGeneration else { return }
            let data = try await api.voiceAudio(id: synthesis.id), audio = try AVAudioPlayer(data: data)
            if currentTurn.ttsFirstAudio == nil { currentTurn.ttsFirstAudio = Date() }
            player = audio; audio.delegate = self; audio.isMeteringEnabled = true; audio.prepareToPlay(); playbackStartedAt = Date(); bargeInGate.reset(); phase = .assistantSpeaking
            if currentTurn.playbackStart == nil { currentTurn.playbackStart = playbackStartedAt; currentTurn.finalizeDurations(); await publishTurnMetrics() }
            audio.play()
        } catch { handlingTurn = false; phase = .error; errorText = "语音播放失败，文字已保留" }
    }
    private func stopPlayback() {
        if player != nil, currentTurn.playbackStopped == nil { currentTurn.playbackStopped = Date() }
        speechGeneration = UUID(); speechStarted = false; stabilizer.reset(); speechQueue.removeAll(); player?.stop(); player = nil; bargeInGate.reset(); Task { try? await api.cancelVoiceSynthesis() }; handlingTurn = false
    }
    private func publishTurnMetrics() async {
        currentTurn.finalizeDurations()
        currentTurn.vadFalseStartCount = falseStartCount
        currentTurn.selfTriggerPreventedCount = selfTriggerPreventedCount
        currentTurn.deviceSwitchCount = deviceSwitchCount
        lastMetrics = currentTurn
        try? await api.recordVoiceCallTurn(currentTurn)
    }
    public var bargeInStopP50: Double? { VoiceTurnMetrics.p50(completedBargeInStops) }
    public var bargeInStopP90: Double? { VoiceTurnMetrics.p90(completedBargeInStops) }
    nonisolated public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.player = nil
            if self.speechQueue.isEmpty { self.currentTurn.playbackEnd = Date(); self.currentTurn.finalizeDurations() }
            await self.playNextSentence(generation: self.speechGeneration)
        }
    }

    nonisolated public static func sentenceQueue(_ text: String, maximumCharacters: Int = 160) -> [String] {
        let clean = text.replacingOccurrences(of: #"```[\s\S]*?```"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"https?://\S+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return [] }
        var output: [String] = []
        for raw in clean.split(whereSeparator: { "。！？!?；;\n".contains($0) }) {
            var part = String(raw).trimmingCharacters(in: .whitespacesAndNewlines)
            while part.count > maximumCharacters { let index = part.index(part.startIndex, offsetBy: maximumCharacters); output.append(String(part[..<index])); part = String(part[index...]) }
            if !part.isEmpty { output.append(part) }
        }
        return output
    }
    nonisolated public static func shouldSpeak(userTranscript: String) -> Bool {
        let compact = userTranscript.replacingOccurrences(of: " ", with: "")
        return !["打字就行", "别说话", "不要语音", "文字回复", "只打字"].contains(where: compact.contains)
    }

    nonisolated public static func wav(samples: [Int16], sampleRate: UInt32, channels: UInt16) -> Data {
        var data=Data();func ascii(_ s:String){data.append(Data(s.utf8))};func u16(_ x:UInt16){var v=x.littleEndian;withUnsafeBytes(of:&v){data.append(contentsOf:$0)}};func u32(_ x:UInt32){var v=x.littleEndian;withUnsafeBytes(of:&v){data.append(contentsOf:$0)}}
        let size=UInt32(samples.count*2);ascii("RIFF");u32(36+size);ascii("WAVEfmt ");u32(16);u16(1);u16(channels);u32(sampleRate);u32(sampleRate*UInt32(channels)*2);u16(channels*2);u16(16);ascii("data");u32(size)
        for sample in samples { var value=sample.littleEndian;withUnsafeBytes(of:&value){data.append(contentsOf:$0)} };return data
    }
}
