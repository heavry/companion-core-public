import Foundation
import Combine
import AVFoundation
import AppKit

@MainActor
public final class WakeWordRuntime: NSObject, ObservableObject {
    public typealias UtteranceHandler = @MainActor (String, VoiceCallTranscription?) async -> String?
    public typealias CallHandler = @MainActor () async -> Void

    @Published public private(set) var phase: WakeWordPhase = .disabled
    @Published public private(set) var settings = WakeWordSettings()
    @Published public private(set) var overlayText = ""
    @Published public private(set) var overlayVisible = false
    @Published public private(set) var lastTranscript = ""
    @Published public private(set) var errorText: String?
    @Published public private(set) var experimental = true
    @Published public private(set) var captureSampleRate: Double = 16_000
    @Published public private(set) var lastCommand: WakeWordCommand = .empty

    public var onUtterance: UtteranceHandler?
    public var onStartCall: CallHandler?
    public var onDisabledByVoice: (() async -> Void)?

    private let api: APIClient
    private let spotter: WakeSpotter
    private let engine = AVAudioEngine()
    private var session = WakeOneShotSession()
    private var capturingEngine = false
    private var rebuildingRoute = false
    private var locked = false
    private var sleeping = false
    private var voiceCallActive = false
    private var assistantAudioPlaying = false
    private var holdoffUntil = Date.distantPast
    private var timeoutTask: Task<Void, Never>?
    private var overlayTask: Task<Void, Never>?
    private var routeObserver: NSObjectProtocol?
    private var handlingHit = false
    private var player: AVAudioPlayer?

    public init(api: APIClient, spotter: WakeSpotter? = nil) {
        self.api = api
        self.spotter = spotter ?? CoreWakeSpotter(api: api)
        super.init()
    }

    deinit {
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
    }

    public func refreshFromCore() async {
        do {
            let status = try await api.wakeWordStatus()
            applyRemote(status)
            errorText = status.lastError
            if settings.enabled {
                await startListening()
            } else {
                stopCapture()
                phase = .disabled
            }
        } catch {
            errorText = "无法读取唤醒词状态"
        }
    }

    public func setEnabled(_ enabled: Bool) async {
        settings.enabled = enabled
        _ = try? await api.updateWakeWordSettings(enabled: enabled, sensitivity: settings.sensitivity, feedbackSound: settings.feedbackSound, suspendWhileLocked: settings.suspendWhileLocked)
        if enabled { await startListening() }
        else {
            stopCapture()
            phase = .disabled
            overlayVisible = false
        }
    }

    public func setSensitivity(_ value: String) async {
        settings.sensitivity = ["low", "normal", "high"].contains(value) ? value : "normal"
        _ = try? await api.updateWakeWordSettings(enabled: settings.enabled, sensitivity: settings.sensitivity, feedbackSound: settings.feedbackSound, suspendWhileLocked: settings.suspendWhileLocked)
    }

    public func setFeedbackSound(_ enabled: Bool) async {
        settings.feedbackSound = enabled
        _ = try? await api.updateWakeWordSettings(enabled: settings.enabled, sensitivity: settings.sensitivity, feedbackSound: enabled, suspendWhileLocked: settings.suspendWhileLocked)
    }

    public func setSuspendWhileLocked(_ enabled: Bool) async {
        settings.suspendWhileLocked = enabled
        _ = try? await api.updateWakeWordSettings(enabled: settings.enabled, sensitivity: settings.sensitivity, feedbackSound: settings.feedbackSound, suspendWhileLocked: enabled)
        await syncCapture()
    }

    public func setVoiceCallActive(_ active: Bool) async {
        voiceCallActive = active
        try? await api.updateWakeWordContext(locked: locked, sleeping: sleeping, voiceCallActive: active, assistantAudioPlaying: assistantAudioPlaying)
        await syncCapture()
    }

    public func setAssistantAudioPlaying(_ playing: Bool) {
        assistantAudioPlaying = playing
        if playing { holdoffUntil = Date().addingTimeInterval(WakeWordPrivacy.ttsHoldoffSeconds) }
        else { holdoffUntil = Date().addingTimeInterval(WakeWordPrivacy.ttsHoldoffSeconds) }
        Task { try? await api.updateWakeWordContext(locked: locked, sleeping: sleeping, voiceCallActive: voiceCallActive, assistantAudioPlaying: playing, holdoffMs: Int(WakeWordPrivacy.ttsHoldoffSeconds * 1000)) }
    }

    public func handleSleep() async {
        sleeping = true
        try? await api.updateWakeWordContext(locked: locked, sleeping: true, voiceCallActive: voiceCallActive, assistantAudioPlaying: assistantAudioPlaying)
        stopCapture()
        if settings.enabled { phase = .suspended }
    }

    public func handleWakeFromSleep() async {
        sleeping = false
        try? await api.updateWakeWordContext(locked: locked, sleeping: false, voiceCallActive: voiceCallActive, assistantAudioPlaying: assistantAudioPlaying)
        // Never reopen the mic immediately after machine wake.
        if settings.enabled { phase = .suspended }
    }

    public func handleLock() async {
        locked = true
        try? await api.updateWakeWordContext(locked: true, sleeping: sleeping, voiceCallActive: voiceCallActive, assistantAudioPlaying: assistantAudioPlaying)
        if settings.suspendWhileLocked {
            stopCapture()
            if settings.enabled { phase = .suspended }
        }
    }

    public func handleUnlock() async {
        locked = false
        try? await api.updateWakeWordContext(locked: false, sleeping: sleeping, voiceCallActive: voiceCallActive, assistantAudioPlaying: assistantAudioPlaying)
        if WakeWordLifecycle.shouldResumeMicrophone(after: "unlock", enabled: settings.enabled, locked: false, sleeping: sleeping) {
            await startListening()
        }
    }

    public func startListening() async {
        guard WakeWordLifecycle.shouldListen(enabled: settings.enabled, locked: locked, sleeping: sleeping, voiceCallActive: voiceCallActive, suspendWhileLocked: settings.suspendWhileLocked) else {
            stopCapture()
            phase = settings.enabled ? .suspended : .disabled
            return
        }
        let granted: Bool
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: granted = true
        case .notDetermined: granted = await AVCaptureDevice.requestAccess(for: .audio)
        default: granted = false
        }
        guard granted else {
            phase = .error
            errorText = "需要在系统设置中允许 Companion 使用麦克风"
            return
        }
        do {
            try beginCapture()
            phase = .listening
            errorText = nil
            session.reset()
        } catch {
            phase = .error
            errorText = "唤醒麦克风未能启动"
            stopCapture()
        }
    }

    public func haltForQuit() {
        timeoutTask?.cancel()
        stopPlayback()
        stopCapture()
        phase = .disabled
    }

    public func applySettingsForTest(_ value: WakeWordSettings) {
        settings = value
        phase = value.enabled ? .listening : .disabled
        assistantAudioPlaying = false
        holdoffUntil = .distantPast
        handlingHit = false
        overlayVisible = false
        session.reset()
    }

    public func ingestTestFrame(rms: Float, duration: Double, hit: Bool = false, pcm: [Int16] = [0]) async {
        await consume(pcm: pcm, rms: rms, duration: duration, forcedHit: hit)
    }

    public func timeoutForTest() async {
        await timeoutOneShot()
    }

    public func handleTranscriptForTest(_ raw: String) -> (WakeWordCommand, String?) {
        let command = WakeWordLifecycle.classify(raw)
        lastCommand = command
        lastTranscript = WakeWordLifecycle.strip(raw)
        return (command, WakeWordLifecycle.persistUserText(command: command, stripped: lastTranscript))
    }

    private func applyRemote(_ status: WakeWordStatus) {
        settings.enabled = status.enabled
        settings.sensitivity = status.sensitivity
        settings.feedbackSound = status.feedbackSound
        settings.suspendWhileLocked = status.suspendWhileLocked
        experimental = status.experimental
    }

    private func syncCapture() async {
        if WakeWordLifecycle.shouldListen(enabled: settings.enabled, locked: locked, sleeping: sleeping, voiceCallActive: voiceCallActive, suspendWhileLocked: settings.suspendWhileLocked) {
            await startListening()
        } else {
            stopCapture()
            phase = settings.enabled ? .suspended : .disabled
            overlayVisible = false
        }
    }

    private func beginCapture() throws {
        if capturingEngine { return }
        let input = engine.inputNode
        _ = VoiceCallManager.enableNativeVoiceProcessing(input)
        let format = input.outputFormat(forBus: 0)
        captureSampleRate = format.sampleRate > 0 ? format.sampleRate : 16_000
        session.preRoll = VoicePreRollBuffer(capacitySamples: Int(WakeWordPrivacy.preRollSeconds * VoiceAudioResampler.senseVoiceRate))
        input.installTap(onBus: 0, bufferSize: 1600, format: format) { [weak self] buffer, _ in
            guard let channel = buffer.floatChannelData?[0] else { return }
            let count = Int(buffer.frameLength)
            let values = Array(UnsafeBufferPointer(start: channel, count: count))
            Task { @MainActor in self?.consumeHardware(values, sampleRate: format.sampleRate) }
        }
        engine.prepare()
        try engine.start()
        capturingEngine = true
        routeObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.handleRouteChange() }
        }
    }

    private func stopCapture() {
        timeoutTask?.cancel()
        timeoutTask = nil
        handlingHit = false
        if capturingEngine {
            if engine.isRunning { engine.stop() }
            engine.inputNode.removeTap(onBus: 0)
            capturingEngine = false
        }
        if let routeObserver { NotificationCenter.default.removeObserver(routeObserver); self.routeObserver = nil }
        session.reset()
    }

    private func handleRouteChange() {
        guard capturingEngine, !rebuildingRoute else { return }
        rebuildingRoute = true
        defer { rebuildingRoute = false }
        do {
            if engine.isRunning { engine.stop() }
            engine.inputNode.removeTap(onBus: 0)
            capturingEngine = false
            try beginCapture()
            errorText = nil
        } catch {
            phase = .error
            errorText = "音频设备已变化"
        }
    }

    private func consumeHardware(_ values: [Float], sampleRate hardwareRate: Double) {
        let resampled = VoiceAudioResampler.resample(values, from: hardwareRate > 0 ? hardwareRate : captureSampleRate)
        let pcm = VoiceAudioResampler.pcm16(resampled)
        let rms = VoiceAudioResampler.rms(resampled)
        let seconds = Double(resampled.count) / VoiceAudioResampler.senseVoiceRate
        Task { await consume(pcm: pcm, rms: rms, duration: seconds, forcedHit: false) }
    }

    private func consume(pcm: [Int16], rms: Float, duration: Double, forcedHit: Bool) async {
        guard settings.enabled, !voiceCallActive, !sleeping else { return }
        if locked && settings.suspendWhileLocked { return }
        if assistantAudioPlaying || Date() < holdoffUntil {
            session.preRoll.append(pcm)
            return
        }
        session.preRoll.append(pcm)
        if phase == .listening && !handlingHit {
            let spotted = await spotter.ingest(pcm: pcm, sampleRate: VoiceAudioResampler.senseVoiceRate)
            let hit = forcedHit || spotted
            if hit { await registerHit() }
            return
        }
        guard phase == .detected || phase == .capturing else { return }
        let voiced = rms >= session.detector.speechThreshold
        if voiced {
            if session.samples.isEmpty { session.samples.append(contentsOf: session.preRoll.take()) }
            session.samples.append(contentsOf: pcm)
            session.hasSpeech = true
            phase = .capturing
            showOverlay("正在听…")
        } else if session.hasSpeech {
            session.samples.append(contentsOf: pcm)
        }
        if session.detector.observe(rms: rms, duration: duration), session.hasSpeech {
            await finishOneShot()
            return
        }
        if !session.hasSpeech, Date().timeIntervalSince(session.startedAt) >= WakeWordPrivacy.oneShotTimeoutSeconds {
            await timeoutOneShot()
        }
    }

    private func registerHit() async {
        handlingHit = true
        phase = .detected
        session = WakeOneShotSession()
        lastTranscript = ""
        lastCommand = .empty
        try? await api.recordWakeWordEvent(kind: "wake")
        showOverlay("正在听…")
        if settings.feedbackSound {
            NSSound(named: NSSound.Name("Tink"))?.play()
        }
        timeoutTask?.cancel()
        timeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(WakeWordPrivacy.oneShotTimeoutSeconds * 1_000_000_000))
            await self?.timeoutOneShot()
        }
    }

    private func timeoutOneShot() async {
        guard phase == .detected || phase == .capturing else { return }
        if session.hasSpeech { return }
        timeoutTask?.cancel()
        handlingHit = false
        try? await api.recordWakeWordEvent(kind: "timeout")
        session.reset()
        overlayVisible = false
        phase = .listening
    }

    private func finishOneShot() async {
        timeoutTask?.cancel()
        let wav = VoiceCallManager.wav(samples: session.samples, sampleRate: UInt32(VoiceAudioResampler.senseVoiceRate), channels: 1)
        session.reset()
        phase = .transcribing
        do {
            let result = try await api.transcribeVoiceCall(wav: wav, sessionID: "chat:default")
            let resolved = try await api.resolveWakeWord(transcript: result.speechContext.rawTranscript.isEmpty ? result.transcript : result.speechContext.rawTranscript)
            let command = WakeWordCommand(rawValue: resolved.command) ?? WakeWordLifecycle.classify(resolved.raw)
            lastCommand = command
            lastTranscript = resolved.stripped
            showOverlay(resolved.stripped.isEmpty ? "正在听…" : resolved.stripped)
            await handleResolved(command: command, persist: resolved.persistUserText, speech: result)
        } catch {
            handlingHit = false
            phase = .listening
            overlayVisible = false
            errorText = "这句话没有处理成功"
        }
    }

    private func handleResolved(command: WakeWordCommand, persist: String?, speech: VoiceCallTranscription) async {
        switch command {
        case .empty:
            try? await api.recordWakeWordEvent(kind: "false_wake")
            handlingHit = false
            overlayVisible = false
            phase = .listening
        case .cancel:
            try? await api.recordWakeWordEvent(kind: "cancel")
            handlingHit = false
            overlayVisible = false
            phase = .listening
        case .disableWake:
            try? await api.recordWakeWordEvent(kind: "disable")
            phase = .answering
            await speakConfirmation("好。")
            await setEnabled(false)
            await onDisabledByVoice?()
        case .startCall:
            try? await api.recordWakeWordEvent(kind: "call")
            handlingHit = false
            overlayVisible = false
            stopCapture()
            phase = .suspended
            await onStartCall?()
        case .utterance:
            guard let persist, !persist.isEmpty else {
                try? await api.recordWakeWordEvent(kind: "false_wake")
                handlingHit = false
                overlayVisible = false
                phase = .listening
                return
            }
            phase = .thinking
            try? await api.recordWakeWordEvent(kind: "one_shot")
            let reply = await onUtterance?(persist, speech)
            if let reply, !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                phase = .answering
                await speakConfirmation(reply)
            }
            handlingHit = false
            overlayTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 1_600_000_000)
                self?.overlayVisible = false
            }
            if settings.enabled, !voiceCallActive { phase = .listening }
        }
    }

    private func speakConfirmation(_ text: String) async {
        assistantAudioPlaying = true
        setAssistantAudioPlaying(true)
        let sentences = VoiceCallManager.sentenceQueue(text)
        for sentence in sentences {
            do {
                let synthesis = try await api.synthesizeVoiceCall(text: sentence, sessionID: "chat:default")
                let data = try await api.voiceAudio(id: synthesis.id)
                let audio = try AVAudioPlayer(data: data)
                player = audio
                audio.prepareToPlay()
                audio.play()
                while audio.isPlaying { try? await Task.sleep(nanoseconds: 40_000_000) }
            } catch {
                break
            }
        }
        player = nil
        assistantAudioPlaying = false
        setAssistantAudioPlaying(false)
    }

    private func stopPlayback() {
        player?.stop()
        player = nil
    }

    private func showOverlay(_ text: String) {
        overlayText = text
        overlayVisible = true
        overlayTask?.cancel()
    }
}

public final class CoreWakeSpotter: WakeSpotter {
    private let api: APIClient
    public init(api: APIClient) { self.api = api }
    public func ingest(pcm: [Int16], sampleRate: Double) async -> Bool {
        let payload = pcm.withUnsafeBufferPointer { Data(buffer: $0) }
        do {
            let result = try await api.ingestWakeWord(pcm16: payload, sampleRate: sampleRate)
            return result.detections.contains { $0.keyword == WakeWordPrivacy.phrase }
        } catch {
            return false
        }
    }
}
